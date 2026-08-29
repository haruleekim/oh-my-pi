import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, ClientCapabilities, SessionUpdate, ToolCallStatus } from "@oh-my-pi/pi-utils/acp";
import { AgentRegistry } from "../../registry/agent-registry";
import type {
	AgentSession,
	AgentSessionEvent,
	SubagentSessionReadyContext,
	SubagentSessionReadyHandler,
} from "../../session/agent-session";
import { BlobStore, resolveImageDataSync } from "../../session/blob-store";
import { SessionManager } from "../../session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../task/types";
import type { EventBus } from "../../utils/event-bus";
import { createAcpClientBridge } from "./acp-client-bridge";
import { mapAgentSessionEventToAcpSessionUpdates } from "./acp-event-mapper";

export const ACP_SUBAGENT_ATTACH_TIMEOUT_MS = 5_000;

interface SubagentSessionMetadata {
	session_id: string;
	message_start_index: number;
	message_end_index?: number;
}

interface SubagentCard {
	agentId: string;
	childSessionId: string;
	parentSessionId: string;
	toolCallId: string;
	title: string;
	status: ToolCallStatus;
	rawOutput?: string;
}

interface ReadySignal {
	promise: Promise<void>;
	resolve: () => void;
}

interface LiveChild extends SubagentCard {
	session: AgentSession;
	sessionFile?: string;
	fallbackSessionId: string;
	cancel: () => void;
	attached: boolean;
	forwardingState: ForwardingState | undefined;
	ready: ReadySignal;
	readinessSettled: boolean;
	unsubscribe: (() => void) | undefined;
}

interface ColdChild {
	sessionId: string;
	sessionFile: string;
}

interface ForwardingState {
	messageId: string | undefined;
	messageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	toolArgsById: Map<string, unknown>;
	replaying: boolean;
	bufferedEvents: AgentSessionEvent[];
	deliveryTail: Promise<void>;
}

interface ResultLike {
	id?: unknown;
	agent?: unknown;
	description?: unknown;
	sessionId?: unknown;
	sessionFile?: unknown;
	exitCode?: unknown;
	error?: unknown;
	aborted?: unknown;
	abortReason?: unknown;
	stderr?: unknown;
	isIsolated?: unknown;
}

export interface AcpBorrowedSubagent {
	sessionId: string;
	session: AgentSession;
	replayMessages: readonly unknown[];
}

export interface AcpColdSubagent {
	sessionId: string;
	sessionFile: string;
}

function isLifecyclePayload(value: unknown): value is SubagentLifecyclePayload {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.agent === "string" &&
		typeof value.index === "number" &&
		(value.status === "started" ||
			value.status === "completed" ||
			value.status === "failed" ||
			value.status === "aborted")
	);
}

function resultList(value: unknown): ResultLike[] {
	if (!isRecord(value)) return [];
	const container = isRecord(value.details) ? value.details : value;
	if (!Array.isArray(container.results)) return [];
	return container.results.filter((result): result is ResultLike => isRecord(result));
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resultStatus(result: ResultLike): ToolCallStatus {
	const failedExit = typeof result.exitCode === "number" && result.exitCode !== 0;
	return result.aborted === true || result.error !== undefined || failedExit ? "failed" : "completed";
}

function resultFailure(result: ResultLike): string | undefined {
	return (
		stringField(result.abortReason) ??
		stringField(result.error) ??
		(result.exitCode !== 0 ? stringField(result.stderr) : undefined)
	);
}

function metadata(sessionId: string): { subagent_session_info: SubagentSessionMetadata } {
	return {
		subagent_session_info: {
			session_id: sessionId,
			message_start_index: 0,
		},
	};
}

export class AcpSubagentBridge {
	readonly #connection: AgentSideConnection;
	readonly #clientCapabilities: ClientCapabilities | undefined;
	readonly #rootSessionId: string;
	readonly #rootAgentId: string;
	readonly #agentRoutes = new Map<string, string>();
	readonly #cardsBySession = new Map<string, SubagentCard>();
	readonly #liveBySession = new Map<string, LiveChild>();
	readonly #liveByAgent = new Map<string, LiveChild>();
	readonly #attachTimeoutMs: number;
	readonly #coldBySession = new Map<string, ColdChild>();
	readonly #blobs = new BlobStore(getBlobsDir());
	readonly #unsubscribeLifecycle: () => void;
	#disposed = false;

	readonly prepareChild: SubagentSessionReadyHandler = async context => {
		await this.#prepareChild(context);
	};

	constructor(
		connection: AgentSideConnection,
		clientCapabilities: ClientCapabilities | undefined,
		rootSessionId: string,
		rootAgentId: string,
		subagentEventBus: EventBus,
		attachTimeoutMs: number = ACP_SUBAGENT_ATTACH_TIMEOUT_MS,
	) {
		this.#connection = connection;
		this.#clientCapabilities = clientCapabilities;
		this.#rootSessionId = rootSessionId;
		this.#rootAgentId = rootAgentId;
		this.#attachTimeoutMs = attachTimeoutMs;
		this.#agentRoutes.set(rootAgentId, rootSessionId);
		this.#unsubscribeLifecycle = subagentEventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			if (!isLifecyclePayload(payload)) return;
			return this.#handleLifecycle(payload);
		});
	}
	getColdChild(sessionId: string): AcpColdSubagent | undefined {
		const child = this.#coldBySession.get(sessionId);
		return child ? { sessionId, sessionFile: child.sessionFile } : undefined;
	}

	isSubagentSession(sessionId: string): boolean {
		return this.#liveBySession.has(sessionId) || this.#coldBySession.has(sessionId);
	}

	beginBorrowedAttach(sessionId: string): AcpBorrowedSubagent | undefined {
		const child = this.#liveBySession.get(sessionId);
		if (!child) return undefined;
		const replayMessages = child.session.sessionManager.buildSessionContext().messages;
		const state: ForwardingState = {
			messageId: undefined,
			messageProgress: undefined,
			toolArgsById: new Map(),
			replaying: true,
			bufferedEvents: [],
			deliveryTail: Promise.resolve(),
		};
		child.forwardingState = state;
		child.session.setClientBridge(
			createAcpClientBridge(this.#connection, sessionId, this.#clientCapabilities, {
				deferAgentInitiatedTurns: false,
			}),
		);
		this.#agentRoutes.set(child.agentId, sessionId);
		child.unsubscribe = this.#installForwarder(child, state);
		return { sessionId, session: child.session, replayMessages };
	}

	async completeBorrowedAttach(sessionId: string): Promise<void> {
		const child = this.#liveBySession.get(sessionId);
		if (!child) return;
		const state = child.forwardingState;
		if (state) {
			state.replaying = false;
			for (const event of state.bufferedEvents.splice(0)) {
				this.#enqueueForwardEvent(child, state, event);
			}
			await state.deliveryTail;
		}
		child.attached = true;
		child.readinessSettled = true;
		child.ready.resolve();
	}

	failBorrowedAttach(sessionId: string): void {
		const child = this.#liveBySession.get(sessionId);
		if (!child) return;
		child.unsubscribe?.();
		child.unsubscribe = undefined;
		child.forwardingState = undefined;
		child.attached = false;
		this.#agentRoutes.set(child.agentId, child.fallbackSessionId);
		child.session.setClientBridge(
			createAcpClientBridge(this.#connection, child.fallbackSessionId, this.#clientCapabilities, {
				deferAgentInitiatedTurns: false,
			}),
		);
	}

	detachBorrowed(sessionId: string): void {
		const child = this.#liveBySession.get(sessionId);
		if (!child) return;
		child.unsubscribe?.();
		child.unsubscribe = undefined;
		child.forwardingState = undefined;
		child.attached = false;
		this.#agentRoutes.set(child.agentId, child.fallbackSessionId);
		child.session.setClientBridge(undefined);
	}

	cancelBorrowed(sessionId: string): boolean {
		const child = this.#liveBySession.get(sessionId);
		if (!child) return false;
		child.cancel();
		return true;
	}

	async recordTaskResults(parentSession: AgentSession, parentSessionId: string, details: unknown): Promise<void> {
		for (const result of resultList(details)) {
			if (result.isIsolated === true) continue;
			const childSessionId = stringField(result.sessionId);
			const childSessionFile = stringField(result.sessionFile);
			if (!childSessionId || !childSessionFile) continue;

			const existing = this.#cardsBySession.get(childSessionId);
			const title =
				stringField(result.description) ?? stringField(result.agent) ?? stringField(result.id) ?? childSessionId;
			const status = resultStatus(result);
			const rawOutput = resultFailure(result);
			if (existing) {
				existing.title = title;
				existing.status = status;
				existing.rawOutput = rawOutput;
				await this.#emitCard(existing, true);
				continue;
			}

			if (!(await this.#registerColdChild(parentSession, childSessionId, childSessionFile))) continue;
			const card: SubagentCard = {
				agentId: stringField(result.id) ?? childSessionId,
				childSessionId,
				parentSessionId,
				toolCallId: `omp-subagent:${childSessionId}`,
				title,
				status,
				rawOutput,
			};
			this.#cardsBySession.set(childSessionId, card);
			await this.#emitCard(card, false);
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeLifecycle();
		for (const child of this.#liveBySession.values()) {
			child.unsubscribe?.();
			child.unsubscribe = undefined;
			child.session.setClientBridge(undefined);
			if (!child.readinessSettled) child.cancel();
			child.ready.resolve();
		}
		this.#liveBySession.clear();
		this.#liveByAgent.clear();
		this.#coldBySession.clear();
		this.#cardsBySession.clear();
	}

	async #prepareChild(context: SubagentSessionReadyContext): Promise<void> {
		if (this.#disposed || context.invocationKind !== "task" || context.isolated) return;
		const childSessionId = context.session.sessionManager.getSessionId();
		const childSessionFile = context.session.sessionManager.getSessionFile() ?? undefined;
		const existing = this.#liveBySession.get(childSessionId);
		if (existing) {
			await this.#awaitAttach(existing);
			return;
		}

		const parentAgentId = AgentRegistry.global().get(context.agentId)?.parentId ?? context.parentAgentId;
		const parentSessionId = this.#nearestLoadedAncestor(parentAgentId);
		const ready = Promise.withResolvers<void>();
		const child: LiveChild = {
			agentId: context.agentId,
			childSessionId,
			parentSessionId,
			toolCallId: `omp-subagent:${childSessionId}`,
			title: AgentRegistry.global().get(context.agentId)?.displayName ?? context.agentId,
			status: "in_progress",
			session: context.session,
			sessionFile: childSessionFile,
			fallbackSessionId: parentSessionId,
			cancel: context.cancel,
			readinessSettled: false,
			attached: false,
			forwardingState: undefined,
			ready,
			unsubscribe: undefined,
		};
		this.#liveBySession.set(childSessionId, child);
		this.#liveByAgent.set(context.agentId, child);
		this.#cardsBySession.set(childSessionId, child);
		this.#agentRoutes.set(context.agentId, parentSessionId);
		context.session.installSubagentSessionReadyHandler(this.prepareChild);
		await this.#emitCard(child, false);
		await this.#awaitAttach(child);
	}

	async #awaitAttach(child: LiveChild): Promise<void> {
		if (child.attached || this.#disposed) return;
		const timeout = Promise.withResolvers<false>();
		const timeoutId = setTimeout(() => timeout.resolve(false), this.#attachTimeoutMs);
		timeoutId.unref();
		const attached = await Promise.race([child.ready.promise.then(() => true as const), timeout.promise]);
		child.readinessSettled = true;
		clearTimeout(timeoutId);
		if (attached || child.attached || this.#disposed) return;
		child.session.setClientBridge(
			createAcpClientBridge(this.#connection, child.fallbackSessionId, this.#clientCapabilities, {
				deferAgentInitiatedTurns: false,
			}),
		);
		this.#agentRoutes.set(child.agentId, child.fallbackSessionId);
		logger.warn("ACP subagent attach timed out; routing through the nearest loaded ancestor", {
			childSessionId: child.childSessionId,
			ancestorSessionId: child.fallbackSessionId,
		});
	}

	#nearestLoadedAncestor(agentId: string): string {
		let current: string | undefined = agentId;
		const visited = new Set<string>();
		while (current && !visited.has(current)) {
			visited.add(current);
			const route = this.#agentRoutes.get(current);
			if (route) return route;
			current = AgentRegistry.global().get(current)?.parentId;
		}
		return this.#agentRoutes.get(this.#rootAgentId) ?? this.#rootSessionId;
	}

	async #handleLifecycle(payload: SubagentLifecyclePayload): Promise<void> {
		if (payload.status === "started") return;
		const child =
			(payload.sessionId ? this.#liveBySession.get(payload.sessionId) : undefined) ??
			this.#liveByAgent.get(payload.id);
		if (!child) return;
		child.title = payload.description ?? payload.agent;
		child.status = payload.status === "completed" ? "completed" : "failed";
		child.rawOutput = payload.abortReason ?? payload.error;
		await this.#emitCard(child, true);
	}

	async #emitCard(card: SubagentCard, update: boolean): Promise<void> {
		if (this.#disposed || this.#connection.signal.aborted) return;
		const sessionUpdate: SessionUpdate = update
			? {
					sessionUpdate: "tool_call_update",
					toolCallId: card.toolCallId,
					title: card.title,
					kind: "think",
					status: card.status,
					...(card.rawOutput ? { rawOutput: card.rawOutput } : {}),
					_meta: metadata(card.childSessionId),
				}
			: {
					sessionUpdate: "tool_call",
					toolCallId: card.toolCallId,
					title: card.title,
					kind: "think",
					status: card.status,
					...(card.rawOutput ? { rawOutput: card.rawOutput } : {}),
					_meta: metadata(card.childSessionId),
				};
		try {
			await this.#connection.sessionUpdate({ sessionId: card.parentSessionId, update: sessionUpdate });
		} catch (error) {
			if (!this.#connection.signal.aborted) {
				logger.warn("Failed to emit ACP subagent card", { childSessionId: card.childSessionId, error });
			}
		}
	}

	#installForwarder(child: LiveChild, state: ForwardingState): () => void {
		return child.session.subscribe(event => {
			if (state.replaying) {
				state.bufferedEvents.push(event);
				return;
			}
			this.#enqueueForwardEvent(child, state, event);
		});
	}

	#enqueueForwardEvent(child: LiveChild, state: ForwardingState, event: AgentSessionEvent): void {
		state.deliveryTail = state.deliveryTail
			.then(() => this.#forwardEvent(child, state, event))
			.catch(error => {
				if (!this.#connection.signal.aborted) {
					logger.warn("ACP borrowed subagent event forwarding failed", {
						childSessionId: child.childSessionId,
						error,
					});
				}
			});
	}

	async #forwardEvent(child: LiveChild, state: ForwardingState, event: AgentSessionEvent): Promise<void> {
		if (child.forwardingState !== state || this.#disposed) return;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			state.toolArgsById.set(event.toolCallId, event.args);
		}
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			(event.type === "message_start" || !state.messageId || !state.messageProgress)
		) {
			state.messageId = crypto.randomUUID();
			state.messageProgress = { textEmitted: false, thoughtEmitted: false };
		}
		for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, child.childSessionId, {
			getMessageId: message => {
				if (typeof message !== "object" || message === null) return undefined;
				if (!state.messageId) state.messageId = crypto.randomUUID();
				return state.messageId;
			},
			getMessageProgress: message => {
				if (typeof message !== "object" || message === null) return undefined;
				if (!state.messageProgress) {
					state.messageProgress = { textEmitted: false, thoughtEmitted: false };
				}
				return state.messageProgress;
			},
			getToolArgs: toolCallId => state.toolArgsById.get(toolCallId),
			cwd: child.session.sessionManager.getCwd(),
			resolveImageData: (data, _mimeType) => resolveImageDataSync(this.#blobs, data),
		})) {
			await this.#connection.sessionUpdate(notification);
		}
		if (event.type === "tool_execution_end") {
			state.toolArgsById.delete(event.toolCallId);
			if (event.toolName === "task") {
				await this.recordTaskResults(child.session, child.childSessionId, event.result);
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			state.messageId = undefined;
			state.messageProgress = undefined;
		}
		if (event.type === "agent_end") {
			await this.#emitChildEndUpdates(child);
		}
	}

	async #emitChildEndUpdates(child: LiveChild): Promise<void> {
		const contextUsage = child.session.getContextUsage();
		if (contextUsage) {
			const usage = child.session.sessionManager.getUsageStatistics();
			await this.#connection.sessionUpdate({
				sessionId: child.childSessionId,
				update: {
					sessionUpdate: "usage_update",
					size: contextUsage.contextWindow,
					used: contextUsage.tokens ?? 0,
					cost: usage.cost > 0 ? { amount: usage.cost, currency: "USD" } : undefined,
				},
			});
		}
		await this.#connection.sessionUpdate({
			sessionId: child.childSessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: child.session.sessionName,
				updatedAt: new Date().toISOString(),
			},
		});
	}

	async #registerColdChild(parentSession: AgentSession, sessionId: string, sessionFile: string): Promise<boolean> {
		const parentSessionFile = parentSession.sessionManager.getSessionFile();
		if (!parentSessionFile) return false;
		const artifactsDir = parentSessionFile.endsWith(".jsonl")
			? parentSessionFile.slice(0, -".jsonl".length)
			: `${parentSessionFile}.artifacts`;
		let realArtifactsDir: string;
		let realSessionFile: string;
		try {
			[realArtifactsDir, realSessionFile] = await Promise.all([fs.realpath(artifactsDir), fs.realpath(sessionFile)]);
		} catch {
			return false;
		}
		const relative = path.relative(realArtifactsDir, realSessionFile);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return false;
		}

		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(realSessionFile, undefined, undefined, { suppressBreadcrumb: true });
			if (manager.getSessionId() !== sessionId) return false;
		} catch {
			return false;
		} finally {
			await manager?.close();
		}
		this.#coldBySession.set(sessionId, { sessionId, sessionFile: realSessionFile });
		return true;
	}
}
