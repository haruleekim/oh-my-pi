import { AsyncDrain, isRecord, logger } from "@oh-my-pi/pi-utils";
import type {
	AgentSideConnection,
	ClientCapabilities,
	SessionNotification,
	SessionUpdate,
} from "@oh-my-pi/pi-utils/acp";
import type { AsyncJob, AsyncJobManager } from "../../async";
import type { EvalToolDetails } from "../../eval/types";
import { type DaemonBrokerClient, DaemonBrokerRejectedError, daemonClientForProject } from "../../launch/client";
import {
	type DaemonRpcResult,
	type DaemonSnapshot,
	type DaemonState,
	parseDaemonSnapshot,
} from "../../launch/protocol";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { BashToolDetails } from "../../tools/bash";
import { isLaunchToolDetails } from "../../tools/hub/launch";
import { limitAcpText } from "./acp-event-mapper";

const JOB_PROGRESS_COALESCE_MS = 100;
const PROCESS_FOLLOW_TIMEOUT_MS = 30_000;
const PROCESS_LOG_LINES = 100;

export const BACKGROUND_JOB_CANCEL_METHOD = "_omp/jobs/cancel";
export const BACKGROUND_PROCESS_STOP_METHOD = "_omp/processes/stop";

export interface BackgroundJobInfo {
	job_id: string;
	job_type: "bash" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	started_at?: number;
	duration_ms?: number;
}

export interface BackgroundProcessInfo {
	process_id: string;
	name: string;
	state: DaemonState | "cancelled";
	started_at: number;
	ready_at: number | null;
	exited_at: number | null;
	exit_code: number | null;
	exit_reason: string | null;
	restart_count: number;
	persist: boolean;
	detached: boolean;
}

export type BackgroundWorkResult = {
	outcome: "cancelled" | "already_terminal";
};

export interface AcpReplayToolResult {
	toolCallId: string;
	toolName: string;
	details?: unknown;
	content?: unknown;
	isError?: boolean;
}

interface JobTracker {
	jobId: string;
	toolCallId: string;
	jobType: "bash" | "eval";
	label: string;
	status: BackgroundJobInfo["status"];
	startedAt?: number;
	durationMs?: number;
	baseDelivered: boolean;
}

interface ProcessTracker {
	processId: string;
	name: string;
	toolCallId: string;
	snapshot: DaemonSnapshot;
	state: BackgroundProcessInfo["state"];
	client: DaemonBrokerClient;
	cursor: number;
	baseDelivered: boolean;
	following: boolean;
	cancelled: boolean;
	abortController: AbortController;
}

interface JobEvent {
	tracker: JobTracker;
	job: Readonly<AsyncJob>;
	text?: string;
}

function clientSupportsJobInfo(capabilities: ClientCapabilities | undefined): boolean {
	return capabilities?._meta?.background_job_info === true;
}

function clientSupportsProcessInfo(capabilities: ClientCapabilities | undefined): boolean {
	return capabilities?._meta?.background_process_info === true;
}

export function clientSupportsBackgroundWork(capabilities: ClientCapabilities | undefined): boolean {
	return clientSupportsJobInfo(capabilities) || clientSupportsProcessInfo(capabilities);
}

function toolResultDetails(result: unknown): unknown {
	return isRecord(result) ? result.details : undefined;
}

function asyncDetails(details: unknown): BashToolDetails["async"] | EvalToolDetails["async"] | undefined {
	if (!isRecord(details) || !isRecord(details.async)) return undefined;
	const state = details.async.state;
	const jobId = details.async.jobId;
	const type = details.async.type;
	if (state !== "running" && state !== "completed" && state !== "failed") return undefined;
	if (typeof jobId !== "string" || (type !== "bash" && type !== "eval")) return undefined;
	return { state, jobId, type } as BashToolDetails["async"] | EvalToolDetails["async"];
}

function metaRecord(update: SessionUpdate): Record<string, unknown> {
	return isRecord(update._meta) ? update._meta : {};
}

function withBackgroundMeta(
	notification: SessionNotification,
	key: "background_job_info" | "background_process_info",
	value: BackgroundJobInfo | BackgroundProcessInfo,
	rawOutput?: string,
): SessionNotification {
	const update = notification.update;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return notification;
	return {
		...notification,
		update: {
			...update,
			...(rawOutput ? { rawOutput } : {}),
			_meta: { ...metaRecord(update), [key]: value },
		},
	};
}

function jobInfo(tracker: JobTracker): BackgroundJobInfo {
	return {
		job_id: tracker.jobId,
		job_type: tracker.jobType,
		status: tracker.status,
		label: tracker.label,
		started_at: tracker.startedAt,
		duration_ms: tracker.durationMs,
	};
}

function processInfo(tracker: ProcessTracker): BackgroundProcessInfo {
	const snapshot = tracker.snapshot;
	return {
		process_id: tracker.processId,
		name: tracker.name,
		state: tracker.state,
		started_at: snapshot.startedAt,
		ready_at: snapshot.readyAt ?? null,
		exited_at: snapshot.exitedAt ?? null,
		exit_code: snapshot.exitCode ?? null,
		exit_reason: snapshot.exitReason ?? null,
		restart_count: snapshot.restartCount,
		persist: snapshot.persist,
		detached: snapshot.detached,
	};
}

function isTerminalProcessState(state: BackgroundProcessInfo["state"]): boolean {
	return state === "exited" || state === "failed" || state === "cancelled";
}

function toolCallId(notification: SessionNotification): string | undefined {
	const update = notification.update;
	return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
		? update.toolCallId
		: undefined;
}

export class AcpBackgroundWorkBridge {
	readonly #connection: AgentSideConnection;
	readonly #sessionId: string;
	readonly #ownerId: string | undefined;
	readonly #cwd: string;
	readonly #manager: AsyncJobManager | undefined;
	readonly #jobEnabled: boolean;
	readonly #processEnabled: boolean;
	readonly #jobs = new Map<string, JobTracker>();
	readonly #jobToolCallsById = new Map<string, string>();
	readonly #replayJobEvents = new Map<string, { job: Readonly<AsyncJob>; text?: string }>();
	readonly #processes = new Map<string, ProcessTracker>();
	readonly #buffered = new Map<string, SessionNotification>();
	readonly #deliveryChains = new Map<string, Promise<void>>();
	readonly #jobDrain = new AsyncDrain<JobEvent>(JOB_PROGRESS_COALESCE_MS);
	#processClient: Promise<DaemonBrokerClient | undefined> | undefined;
	#unsubscribeJobs: (() => void) | undefined;
	#replaying = false;
	#disposed = false;

	constructor(
		connection: AgentSideConnection,
		session: AgentSession,
		clientCapabilities: ClientCapabilities | undefined,
		manager: AsyncJobManager | undefined,
	) {
		this.#connection = connection;
		this.#sessionId = session.sessionManager.getSessionId();
		this.#ownerId = session.getAgentId();
		this.#cwd = session.sessionManager.getCwd();
		this.#manager = manager;
		this.#jobEnabled = clientSupportsJobInfo(clientCapabilities);
		this.#processEnabled = clientSupportsProcessInfo(clientCapabilities);
		if (this.#jobEnabled && manager && this.#ownerId) {
			this.#unsubscribeJobs = manager.subscribe({ ownerId: this.#ownerId }, (job, text) => {
				if (job.type !== "bash" && job.type !== "eval") return;
				if (this.#replaying) {
					this.#replayJobEvents.set(job.id, { job, text });
					return;
				}
				const id = this.#jobToolCallsById.get(job.id);
				const tracker = id ? this.#jobs.get(id) : undefined;
				if (!tracker) return;
				this.#queueJobEvent({ tracker, job, text });
			});
		}
	}

	beginReplay(): void {
		this.#replaying = true;
		this.#buffered.clear();
		this.#replayJobEvents.clear();
	}

	async finishReplay(success: boolean): Promise<void> {
		if (!this.#replaying) return;
		if (!success) {
			this.#replaying = false;
			this.#buffered.clear();
			this.#replayJobEvents.clear();
			return;
		}
		for (const tracker of this.#jobs.values()) {
			if (tracker.status !== "running") continue;
			const isCurrent = this.#jobToolCallsById.get(tracker.jobId) === tracker.toolCallId;
			const live = isCurrent ? this.#ownedJob(tracker.jobId) : undefined;
			if (live) {
				this.#syncTrackerWithJob(tracker, live);
				const pending = this.#replayJobEvents.get(tracker.jobId);
				await this.#emitJob(tracker, pending?.text ?? this.#terminalJobText(live));
				continue;
			}
			tracker.status = "cancelled";
			await this.#emitJob(tracker);
		}
		this.#replaying = false;
		const pending = [...this.#buffered.values()];
		this.#buffered.clear();
		for (const notification of pending) await this.deliver(notification);
		for (const tracker of this.#processes.values()) this.#startFollower(tracker);
		this.#replayJobEvents.clear();
	}

	async decorateLiveToolUpdate(
		event: AgentSessionEvent,
		notification: SessionNotification,
	): Promise<SessionNotification> {
		if (event.type !== "tool_execution_end") return notification;
		return this.#decorateToolResult(
			{
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				details: toolResultDetails(event.result),
			},
			notification,
			false,
		);
	}

	async decorateReplayedToolUpdate(
		message: AcpReplayToolResult,
		notification: SessionNotification,
	): Promise<SessionNotification> {
		return this.#decorateToolResult(message, notification, true);
	}

	async #decorateToolResult(
		message: AcpReplayToolResult,
		notification: SessionNotification,
		replayed: boolean,
	): Promise<SessionNotification> {
		const async = this.#jobEnabled ? asyncDetails(message.details) : undefined;
		if (async?.state === "running") {
			const live = replayed ? undefined : this.#ownedJob(async.jobId);
			const existing = this.#jobs.get(message.toolCallId);
			if (
				existing &&
				existing.jobId !== async.jobId &&
				this.#jobToolCallsById.get(existing.jobId) === message.toolCallId
			) {
				this.#jobToolCallsById.delete(existing.jobId);
			}
			const tracker = existing ?? {
				jobId: async.jobId,
				toolCallId: message.toolCallId,
				jobType: async.type,
				label: live?.label ?? message.toolName,
				status: "running",
				startedAt: undefined,
				durationMs: undefined,
				baseDelivered: false,
			};
			tracker.jobId = async.jobId;
			tracker.toolCallId = message.toolCallId;
			tracker.jobType = async.type;
			tracker.label = live?.label ?? message.toolName;
			tracker.status = "running";
			tracker.startedAt = undefined;
			tracker.durationMs = undefined;
			if (live) this.#syncTrackerWithJob(tracker, live);
			this.#jobs.set(message.toolCallId, tracker);
			this.#jobToolCallsById.set(async.jobId, message.toolCallId);
			const terminalText = live ? this.#terminalJobText(live) : undefined;
			return withBackgroundMeta(
				notification,
				"background_job_info",
				jobInfo(tracker),
				terminalText ? limitAcpText(terminalText) : undefined,
			);
		}

		if (
			this.#processEnabled &&
			message.toolName === "hub" &&
			isLaunchToolDetails(message.details) &&
			message.details.op === "start" &&
			message.details.daemon
		) {
			return this.#decorateProcess(message.toolCallId, message.details.daemon, notification);
		}
		return notification;
	}

	async #decorateProcess(
		toolCallIdValue: string,
		daemon: DaemonSnapshot,
		notification: SessionNotification,
	): Promise<SessionNotification> {
		const client = await this.#capableProcessClient();
		if (!client) return notification;
		let logText: string | undefined;
		let cursor = daemon.outputBytes;
		let state = daemon.state;
		try {
			const result = await client.request({
				op: "logs",
				name: daemon.name,
				processId: daemon.id,
				lines: PROCESS_LOG_LINES,
				head: false,
				follow: false,
				timeoutMs: 0,
			});
			if (result.op !== "logs") return notification;
			cursor = result.cursor;
			state = result.state;
			if (result.text) logText = limitAcpText(result.text);
		} catch (error) {
			if (error instanceof DaemonBrokerRejectedError) return notification;
			logger.debug("ACP background process probe failed", { processId: daemon.id, error });
			return notification;
		}
		const tracker = this.#processes.get(daemon.id) ?? {
			processId: daemon.id,
			name: daemon.name,
			toolCallId: toolCallIdValue,
			snapshot: { ...daemon, state },
			state,
			client,
			cursor,
			baseDelivered: false,
			following: false,
			cancelled: false,
			abortController: new AbortController(),
		};
		tracker.toolCallId = toolCallIdValue;
		tracker.snapshot = { ...tracker.snapshot, ...daemon, state };
		tracker.state = state;
		tracker.cursor = cursor;
		this.#processes.set(daemon.id, tracker);
		return withBackgroundMeta(notification, "background_process_info", processInfo(tracker), logText);
	}

	async deliver(notification: SessionNotification): Promise<void> {
		const id = toolCallId(notification);
		if (!id) {
			await this.#connection.sessionUpdate(notification);
			return;
		}
		const prior = this.#deliveryChains.get(id) ?? Promise.resolve();
		const delivery = prior.then(() => this.#connection.sessionUpdate(notification));
		this.#deliveryChains.set(id, delivery);
		try {
			await delivery;
		} finally {
			if (this.#deliveryChains.get(id) === delivery) this.#deliveryChains.delete(id);
		}
		for (const tracker of this.#jobs.values()) {
			if (tracker.toolCallId !== id || tracker.baseDelivered) continue;
			tracker.baseDelivered = true;
			await this.#flushBuffered(id);
		}
		for (const tracker of this.#processes.values()) {
			if (tracker.toolCallId !== id || tracker.baseDelivered) continue;
			tracker.baseDelivered = true;
			await this.#flushBuffered(id);
			if (!this.#replaying) this.#startFollower(tracker);
		}
	}

	recordReplayedAsyncResult(details: unknown): void {
		if (!isRecord(details) || !Array.isArray(details.jobs)) return;
		for (const value of details.jobs) {
			if (!isRecord(value) || typeof value.jobId !== "string") continue;
			const toolCallIdValue = this.#jobToolCallsById.get(value.jobId);
			const tracker = toolCallIdValue ? this.#jobs.get(toolCallIdValue) : undefined;
			if (!tracker) continue;
			const status = this.#persistedJobStatus(value);
			tracker.status = status;
			if (typeof value.startedAt === "number") tracker.startedAt = value.startedAt;
			if (typeof value.durationMs === "number") tracker.durationMs = value.durationMs;
			const preview = typeof value.resultPreview === "string" ? limitAcpText(value.resultPreview) : undefined;
			void this.#emitJob(tracker, preview).catch(error => {
				logger.warn("Failed to replay ACP background job state", { jobId: tracker.jobId, error });
			});
		}
	}

	recordReplayedLaunchCompletion(details: unknown): void {
		if (!isRecord(details) || !Array.isArray(details.daemons)) return;
		const outcomes = isRecord(details.outcomes) ? details.outcomes : undefined;
		for (const value of details.daemons) {
			let daemon: DaemonSnapshot;
			try {
				daemon = parseDaemonSnapshot(value);
			} catch {
				continue;
			}
			const tracker = this.#processes.get(daemon.id);
			if (!tracker) continue;
			tracker.snapshot = daemon;
			tracker.state = outcomes?.[daemon.id] === "stopped" ? "cancelled" : daemon.state;
			if (tracker.state === "cancelled") {
				tracker.cancelled = true;
				tracker.abortController.abort();
			}
			void this.#emitProcess(tracker).catch(error => {
				logger.warn("Failed to replay ACP background process state", { processId: tracker.processId, error });
			});
		}
	}

	async markProcessCancelled(processId: string, daemon: DaemonSnapshot): Promise<void> {
		const tracker = this.#processes.get(processId);
		if (!tracker) return;
		tracker.cancelled = true;
		tracker.abortController.abort();
		tracker.snapshot = daemon;
		tracker.state = "cancelled";
		await this.#emitProcess(tracker);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeJobs?.();
		this.#unsubscribeJobs = undefined;
		for (const tracker of this.#processes.values()) tracker.abortController.abort();
		for (const tracker of this.#jobs.values()) {
			if (this.#jobToolCallsById.get(tracker.jobId) !== tracker.toolCallId) continue;
			const job = this.#ownedJob(tracker.jobId);
			if (!job || job.status === "running") continue;
			this.#syncTrackerWithJob(tracker, job);
			await this.#emitJob(tracker, this.#terminalJobText(job));
		}
		await this.#jobDrain.flush();
		for (const delivery of this.#deliveryChains.values()) await delivery.catch(() => undefined);
		this.#buffered.clear();
		this.#jobs.clear();
		this.#jobToolCallsById.clear();
		this.#replayJobEvents.clear();
		this.#processes.clear();
	}

	#ownedJob(jobId: string): AsyncJob | undefined {
		const job = this.#manager?.getJob(jobId);
		return job && this.#ownerId && job.ownerId === this.#ownerId ? job : undefined;
	}

	#syncTrackerWithJob(tracker: JobTracker, job: Readonly<AsyncJob>): void {
		if (job.type === "bash" || job.type === "eval") tracker.jobType = job.type;
		tracker.label = job.label;
		tracker.status = job.status;
		tracker.startedAt = job.startTime;
		tracker.durationMs = job.status === "running" ? undefined : Math.max(0, Date.now() - job.startTime);
	}

	#terminalJobText(job: Readonly<AsyncJob>): string | undefined {
		return job.status === "completed" ? job.resultText : job.status === "failed" ? job.errorText : undefined;
	}

	#persistedJobStatus(value: Record<string, unknown>): BackgroundJobInfo["status"] {
		if (
			value.status === "running" ||
			value.status === "completed" ||
			value.status === "failed" ||
			value.status === "cancelled"
		) {
			return value.status;
		}
		const nested = isRecord(value.details) ? asyncDetails(value.details) : undefined;
		return nested?.state ?? "completed";
	}

	#queueJobEvent(event: JobEvent): void {
		const pending = this.#jobDrain.push(event, async events => {
			const latest = new Map<string, JobEvent>();
			for (const item of events) latest.set(item.tracker.toolCallId, item);
			for (const item of latest.values()) {
				this.#syncTrackerWithJob(item.tracker, item.job);
				await this.#emitJob(item.tracker, item.text);
			}
		});
		void pending.catch(error => logger.warn("Failed to emit ACP background job update", { error }));
		if (event.job.status !== "running") {
			void this.#jobDrain
				.flush()
				.catch(error => logger.warn("Failed to flush ACP background job update", { error }));
		}
	}

	async #emitJob(tracker: JobTracker, text?: string): Promise<void> {
		const notification: SessionNotification = {
			sessionId: this.#sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: tracker.toolCallId,
				...(text ? { rawOutput: limitAcpText(text) } : {}),
				_meta: { background_job_info: jobInfo(tracker) },
			},
		};
		await this.#emitOrBuffer(tracker.toolCallId, tracker.baseDelivered, notification);
	}

	async #emitProcess(tracker: ProcessTracker, text?: string): Promise<void> {
		if (tracker.cancelled && tracker.state !== "cancelled") return;
		const notification: SessionNotification = {
			sessionId: this.#sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: tracker.toolCallId,
				...(text ? { rawOutput: limitAcpText(text) } : {}),
				_meta: { background_process_info: processInfo(tracker) },
			},
		};
		await this.#emitOrBuffer(tracker.toolCallId, tracker.baseDelivered, notification);
	}

	async #emitOrBuffer(id: string, baseDelivered: boolean, notification: SessionNotification): Promise<void> {
		if (this.#replaying || !baseDelivered) {
			this.#buffered.set(id, notification);
			return;
		}
		await this.deliver(notification);
	}

	async #flushBuffered(id: string): Promise<void> {
		if (this.#replaying) return;
		const notification = this.#buffered.get(id);
		if (!notification) return;
		this.#buffered.delete(id);
		await this.deliver(notification);
	}

	async #capableProcessClient(): Promise<DaemonBrokerClient | undefined> {
		if (!this.#processEnabled || this.#disposed || this.#connection.signal.aborted) return undefined;
		this.#processClient ??= (async () => {
			try {
				const client = await daemonClientForProject(this.#cwd);
				const ping = await client.request({ op: "ping" }, this.#connection.signal);
				return ping.op === "ping" && ping.capabilities?.processIdentityCompare === true ? client : undefined;
			} catch (error) {
				logger.debug("ACP background process capability probe failed", { cwd: this.#cwd, error });
				return undefined;
			}
		})();
		return this.#processClient;
	}

	#startFollower(tracker: ProcessTracker): void {
		if (tracker.following || tracker.cancelled || isTerminalProcessState(tracker.state) || this.#disposed) return;
		tracker.following = true;
		void this.#followProcess(tracker).finally(() => {
			tracker.following = false;
		});
	}

	async #followProcess(tracker: ProcessTracker): Promise<void> {
		while (!this.#disposed && !tracker.cancelled && !isTerminalProcessState(tracker.state)) {
			let result: DaemonRpcResult;
			try {
				result = await tracker.client.request(
					{
						op: "logs",
						name: tracker.name,
						processId: tracker.processId,
						lines: PROCESS_LOG_LINES,
						head: false,
						follow: true,
						cursor: tracker.cursor,
						timeoutMs: PROCESS_FOLLOW_TIMEOUT_MS,
					},
					tracker.abortController.signal,
				);
			} catch (error) {
				if (tracker.cancelled || this.#disposed || tracker.abortController.signal.aborted) return;
				if (error instanceof DaemonBrokerRejectedError) {
					tracker.state = "exited";
					await this.#emitProcess(tracker);
					return;
				}
				logger.debug("ACP background process follow failed", { processId: tracker.processId, error });
				return;
			}
			if (tracker.cancelled || this.#disposed || result.op !== "logs") return;
			const previousState = tracker.state;
			tracker.cursor = result.cursor;
			if (result.state !== previousState) {
				const snapshot = await this.#currentProcessSnapshot(tracker);
				if (!snapshot) {
					tracker.state = "exited";
					await this.#emitProcess(tracker);
					return;
				}
				tracker.snapshot = snapshot;
				tracker.state = snapshot.state;
			} else {
				tracker.state = result.state;
				tracker.snapshot = { ...tracker.snapshot, state: result.state };
			}
			const text = result.text ? limitAcpText(result.text) : undefined;
			if (text || tracker.state !== previousState) await this.#emitProcess(tracker, text);
		}
	}

	async #currentProcessSnapshot(tracker: ProcessTracker): Promise<DaemonSnapshot | undefined> {
		try {
			const result = await tracker.client.request({ op: "list" }, tracker.abortController.signal);
			return result.op === "list" ? result.daemons.find(daemon => daemon.id === tracker.processId) : undefined;
		} catch {
			return undefined;
		}
	}
}
