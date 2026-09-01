import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { AgentSideConnection, ClientCapabilities, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { AsyncJobManager } from "../src/async/job-manager";
import type { DaemonBrokerClient } from "../src/launch/client";
import * as daemonClient from "../src/launch/client";
import type { DaemonRpcResult, DaemonSnapshot } from "../src/launch/protocol";
import { AcpBackgroundWorkBridge, clientSupportsBackgroundWork } from "../src/modes/acp/acp-background-work";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";

const SESSION_ID = "session-root";
const OWNER_ID = "Main";

function harness(capabilities: ClientCapabilities, manager?: AsyncJobManager) {
	const updates: SessionNotification[] = [];
	const abortController = new AbortController();
	const connection = {
		signal: abortController.signal,
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
	} as unknown as AgentSideConnection;
	const session = {
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getCwd: () => process.cwd(),
		},
		getAgentId: () => OWNER_ID,
	} as unknown as AgentSession;
	return {
		bridge: new AcpBackgroundWorkBridge(connection, session, capabilities, manager),
		updates,
		abortController,
	};
}

function baseToolUpdate(toolCallId: string): SessionNotification {
	return {
		sessionId: SESSION_ID,
		update: {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "completed",
			rawOutput: "backgrounded",
		},
	};
}

function asyncToolEnd(toolCallId: string, jobId: string, type: "bash" | "eval" = "bash"): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: type,
		isError: false,
		result: {
			content: [{ type: "text", text: "backgrounded" }],
			details: { async: { state: "running", jobId, type } },
		},
	};
}

function backgroundJobInfo(notification: SessionNotification): Record<string, unknown> | undefined {
	const update = notification.update;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined;
	const value = update._meta?.background_job_info;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function backgroundProcessInfo(notification: SessionNotification): Record<string, unknown> | undefined {
	const update = notification.update;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined;
	const value = update._meta?.background_process_info;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

async function waitForUpdates(updates: SessionNotification[], count: number): Promise<void> {
	for (let pass = 0; pass < 100; pass++) {
		if (updates.length >= count) return;
		await scheduler.yield();
	}
	throw new Error(`Timed out waiting for ${count} ACP updates`);
}

const daemon: DaemonSnapshot = {
	name: "web",
	id: "daemon-1",
	state: "ready",
	createdAt: 1,
	startedAt: 2,
	readyAt: 3,
	restartCount: 0,
	outputBytes: 5,
	owner: SESSION_ID,
	persist: false,
	detached: false,
};

function broker(capable: boolean): DaemonBrokerClient {
	return {
		projectDir: process.cwd(),
		onCompletion: () => () => {},
		request: async operation => {
			let result: DaemonRpcResult;
			switch (operation.op) {
				case "ping":
					result = {
						op: "ping",
						projectDir: process.cwd(),
						...(capable ? { capabilities: { processIdentityCompare: true as const } } : {}),
					};
					break;
				case "logs":
					result = {
						op: "logs",
						name: daemon.name,
						text: "ready\n",
						cursor: daemon.outputBytes,
						timedOut: false,
						state: daemon.state,
					};
					break;
				case "list":
					result = { op: "list", daemons: [daemon] };
					break;
				default:
					throw new Error(`Unexpected broker operation ${operation.op}`);
			}
			return result;
		},
		close() {},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("ACP background work bridge", () => {
	it("coalesces owner-scoped job tails and emits terminal metadata without reopening the tool call", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const progress = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const progressReported = Promise.withResolvers<void>();
		manager.register(
			"bash",
			"bun run build",
			async ({ reportProgress }) => {
				await progress.promise;
				await reportProgress("old tail");
				await reportProgress("z".repeat(4_500));
				progressReported.resolve();
				return finish.promise;
			},
			{ id: "bg-1", ownerId: OWNER_ID },
		);
		manager.register("bash", "other owner", async () => "private", { id: "bg-other", ownerId: "Other" });
		const { bridge, updates } = harness({ _meta: { background_job_info: true } }, manager);

		const decorated = await bridge.decorateLiveToolUpdate(asyncToolEnd("tool-1", "bg-1"), baseToolUpdate("tool-1"));
		await bridge.deliver(decorated);
		expect(decorated.update).toMatchObject({ status: "completed" });
		expect(backgroundJobInfo(decorated)).toMatchObject({
			job_id: "bg-1",
			job_type: "bash",
			status: "running",
			label: "bun run build",
		});

		progress.resolve();
		await progressReported.promise;
		vi.advanceTimersByTime(100);
		await waitForUpdates(updates, 2);
		expect(updates).toHaveLength(2);
		const progressUpdate = updates[1]!.update;
		expect(progressUpdate).not.toHaveProperty("status");
		if (progressUpdate.sessionUpdate !== "tool_call_update" || typeof progressUpdate.rawOutput !== "string") {
			throw new Error("expected background progress tool update");
		}
		expect(progressUpdate.rawOutput).toHaveLength(4_000);
		expect(progressUpdate.rawOutput.endsWith("…")).toBe(true);
		expect(updates.some(update => backgroundJobInfo(update)?.job_id === "bg-other")).toBe(false);

		finish.resolve("final output");
		await manager.waitForAll();
		await waitForUpdates(updates, 3);
		expect(backgroundJobInfo(updates[2]!)).toMatchObject({ status: "completed" });
		expect(updates[2]!.update).toMatchObject({ rawOutput: "final output" });
		await bridge.dispose();
		await manager.dispose();
	});

	it("buffers replay-time live updates until the base tool card is delivered", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const run = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const progressReported = Promise.withResolvers<void>();
		manager.register(
			"eval",
			"analysis cell",
			async ({ reportProgress }) => {
				await run.promise;
				await reportProgress("live during replay");
				progressReported.resolve();
				return finish.promise;
			},
			{ id: "eval-1", ownerId: OWNER_ID },
		);
		const { bridge, updates } = harness({ _meta: { background_job_info: true } }, manager);
		bridge.beginReplay();
		const decorated = await bridge.decorateReplayedToolUpdate(
			{
				toolCallId: "tool-replay",
				toolName: "eval",
				details: { async: { state: "running", jobId: "eval-1", type: "eval" } },
			},
			baseToolUpdate("tool-replay"),
		);
		await bridge.deliver(decorated);
		run.resolve();
		await progressReported.promise;
		vi.advanceTimersByTime(100);
		await scheduler.yield();
		expect(updates).toHaveLength(1);
		await bridge.finishReplay(true);
		expect(updates).toHaveLength(2);
		expect(updates[1]!.update).toMatchObject({ rawOutput: "live during replay" });

		finish.resolve("done");
		await manager.waitForAll();
		await bridge.dispose();
		await manager.dispose();
	});

	it("settles unmatched historical running jobs as cancelled after replay", async () => {
		const { bridge, updates } = harness({ _meta: { background_job_info: true } });
		bridge.beginReplay();
		const decorated = await bridge.decorateReplayedToolUpdate(
			{
				toolCallId: "tool-old",
				toolName: "bash",
				details: { async: { state: "running", jobId: "missing", type: "bash" } },
			},
			baseToolUpdate("tool-old"),
		);
		await bridge.deliver(decorated);
		await bridge.finishReplay(true);
		expect(backgroundJobInfo(updates.at(-1)!)).toMatchObject({ job_id: "missing", status: "cancelled" });
		await bridge.dispose();
	});

	it("starts a fresh replay tracker when a later tool call reuses a job id", async () => {
		const { bridge, updates } = harness({ _meta: { background_job_info: true } });
		bridge.beginReplay();
		const oldDecorated = await bridge.decorateReplayedToolUpdate(
			{
				toolCallId: "tool-old",
				toolName: "eval",
				details: { async: { state: "running", jobId: "bg-reused", type: "eval" } },
			},
			baseToolUpdate("tool-old"),
		);
		await bridge.deliver(oldDecorated);
		bridge.recordReplayedAsyncResult({
			jobs: [
				{
					jobId: "bg-reused",
					status: "completed",
					startedAt: 100,
					durationMs: 250,
					resultPreview: "old result",
				},
			],
		});

		const newDecorated = await bridge.decorateReplayedToolUpdate(
			{
				toolCallId: "tool-new",
				toolName: "bash",
				details: { async: { state: "running", jobId: "bg-reused", type: "bash" } },
			},
			baseToolUpdate("tool-new"),
		);
		const info = backgroundJobInfo(newDecorated);
		expect(info).toMatchObject({
			job_id: "bg-reused",
			job_type: "bash",
			status: "running",
			label: "bash",
		});
		expect(info?.started_at).toBeUndefined();
		expect(info?.duration_ms).toBeUndefined();

		await bridge.finishReplay(true);
		const oldTerminal = updates.find(
			update =>
				update.update.sessionUpdate === "tool_call_update" &&
				update.update.toolCallId === "tool-old" &&
				backgroundJobInfo(update)?.status === "completed",
		);
		expect(oldTerminal?.update).toMatchObject({ rawOutput: "old result" });
		expect(backgroundJobInfo(oldTerminal!)).toMatchObject({ job_type: "eval", status: "completed" });
		const newTerminal = updates.find(
			update =>
				update.update.sessionUpdate === "tool_call_update" &&
				update.update.toolCallId === "tool-new" &&
				backgroundJobInfo(update)?.status === "cancelled",
		);
		expect(backgroundJobInfo(newTerminal!)).toMatchObject({ job_type: "bash", status: "cancelled" });
		await bridge.dispose();
	});

	it("gates job and process metadata independently and keeps legacy brokers generic", async () => {
		expect(clientSupportsBackgroundWork(undefined)).toBe(false);
		expect(clientSupportsBackgroundWork({ _meta: { background_job_info: "true" } })).toBe(false);
		const manager = new AsyncJobManager({});
		manager.register("bash", "job", async () => "done", { id: "job-1", ownerId: OWNER_ID });

		const jobOnly = harness({ _meta: { background_job_info: true } }, manager);
		const jobDecorated = await jobOnly.bridge.decorateLiveToolUpdate(
			asyncToolEnd("job-tool", "job-1"),
			baseToolUpdate("job-tool"),
		);
		expect(backgroundJobInfo(jobDecorated)).toBeDefined();
		const taskDecorated = await jobOnly.bridge.decorateLiveToolUpdate(
			{
				type: "tool_execution_end",
				toolCallId: "task-tool",
				toolName: "task",
				isError: false,
				result: { content: [], details: { async: { state: "running", jobId: "task-1", type: "task" } } },
			},
			baseToolUpdate("task-tool"),
		);
		expect(backgroundJobInfo(taskDecorated)).toBeUndefined();
		const processEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "process-tool",
			toolName: "hub",
			isError: false,
			result: { content: [], details: { op: "start", daemon } },
		};
		const jobOnlyProcess = await jobOnly.bridge.decorateLiveToolUpdate(processEvent, baseToolUpdate("process-tool"));
		expect(backgroundProcessInfo(jobOnlyProcess)).toBeUndefined();
		await jobOnly.bridge.dispose();

		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker(false));
		const legacy = harness({ _meta: { background_process_info: true } });
		const legacyDecorated = await legacy.bridge.decorateLiveToolUpdate(processEvent, baseToolUpdate("process-tool"));
		expect(backgroundProcessInfo(legacyDecorated)).toBeUndefined();
		await legacy.bridge.dispose();

		vi.restoreAllMocks();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker(true));
		const processOnly = harness({ _meta: { background_process_info: true } });
		const processDecorated = await processOnly.bridge.decorateLiveToolUpdate(
			processEvent,
			baseToolUpdate("process-tool"),
		);
		expect(backgroundProcessInfo(processDecorated)).toEqual({
			process_id: daemon.id,
			name: daemon.name,
			state: "ready",
			started_at: daemon.startedAt,
			ready_at: daemon.readyAt,
			exited_at: null,
			exit_code: null,
			exit_reason: null,
			restart_count: 0,
			persist: false,
			detached: false,
		});
		expect(processDecorated.update).toMatchObject({ status: "completed", rawOutput: "ready\n" });
		processOnly.bridge.beginReplay();
		const replayedProcess = await processOnly.bridge.decorateReplayedToolUpdate(
			{ toolCallId: "process-tool", toolName: "hub", details: { op: "start", daemon } },
			baseToolUpdate("process-tool"),
		);
		await processOnly.bridge.deliver(replayedProcess);
		processOnly.bridge.recordReplayedLaunchCompletion({
			daemons: [{ ...daemon, state: "exited", exitedAt: 4 }],
			outcomes: { [daemon.id]: "stopped" },
		});
		await processOnly.bridge.finishReplay(true);
		expect(backgroundProcessInfo(processOnly.updates.at(-1)!)).toMatchObject({
			process_id: daemon.id,
			state: "cancelled",
			exited_at: 4,
		});
		await processOnly.bridge.dispose();
		await manager.dispose();
	});
});
