/**
 * Contracts: task tool spawn routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; job completion delivers a
 *    result carrying the irc follow-up / `history://<id>` hint.
 * 2. The session-scoped spawn semaphore (task.maxConcurrency) serializes job
 *    bodies: with concurrency 1 the second body does not start until the
 *    first releases.
 *
 * Param validation (missing agent / missing task) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type {
	AgentSession,
	AgentSessionEvent,
	PromptOptions,
	SubagentSessionReadyHandler,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type AgentProgress,
	type SingleResult,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	type TaskParams,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

interface MutableSessionIdentity {
	sessionId: string;
	sessionFile: string;
}

interface ExecutorSessionOptions {
	agentId: string;
	identity: MutableSessionIdentity;
	order?: string[];
	promptLabel?: string;
	onPrompt?: (identity: MutableSessionIdentity) => void | Promise<void>;
}

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createExecutorModelRegistry(): ModelRegistry {
	return {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
	} as unknown as ModelRegistry;
}

function createExecutorSession(options: ExecutorSessionOptions): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	let readyHandler: SubagentSessionReadyHandler | undefined;
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		"task.maxRecursionDepth": 4,
		"task.softRequestBudget": 0,
	});
	const modelRegistry = createExecutorModelRegistry();
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		modelRegistry,
		enableLsp: false,
		enableIrc: false,
		state: { messages },
		agent: { state: { systemPrompt: [taskAgent.systemPrompt] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
			getSessionId: () => options.identity.sessionId,
			getSessionFile: () => options.identity.sessionFile,
		},
		getSessionFile: () => null,
		getSessionId: () => options.identity.sessionId,
		getArtifactsDir: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => options.agentId,
		getActiveToolNames: () => ["task", "yield"],
		getEnabledToolNames: () => ["task", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _promptOptions?: PromptOptions) => {
			options.order?.push(`prompt:${options.promptLabel ?? options.agentId}`);
			await options.onPrompt?.(options.identity);
			messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: `yield-${options.agentId}`,
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
		installSubagentSessionReadyHandler: (handler: SubagentSessionReadyHandler | undefined) => {
			readyHandler = handler;
		},
		getSubagentSessionReadyHandler: () => readyHandler,
	} as unknown as AgentSession;
}

function createExecutorSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function createExecutorOptions(id: string, overrides: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd: "/tmp",
		agent: taskAgent,
		task: "Do the thing.",
		assignment: "Do the thing.",
		description: id,
		invocationKind: "task",
		index: 0,
		id,
		settings: Settings.isolated({ "task.softRequestBudget": 0 }),
		modelRegistry: createExecutorModelRegistry(),
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
		keepAlive: false,
		...overrides,
	};
}

describe("task spawn routing", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns immediately on spawn and delivers the follow-up hint when the job completes", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...taskAgent, model: ["anthropic/claude-sonnet-4"] }],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?", {
				sessionId: "child-session",
				sessionFile: "/tmp/child-session.jsonl",
				isIsolated: false,
			});
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "task.agentModelOverrides": { task: "openai/gpt-4.1-mini" } } }),
		);

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			name: "Spawnling",
			task: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(result.details?.results).toEqual([]);
		expect(text).toContain(`job \`${jobId}\``);
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain("Spawnling is now idle");
		expect(job!.resultText).toContain("message it via `hub` to follow up");
		expect(job!.resultText).toContain("history://Spawnling");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual(["openai/gpt-4.1-mini"]);
		const settledDetails = job!.latestDetails;
		expect(settledDetails?.results).toEqual([
			expect.objectContaining({
				id: "Spawnling",
				sessionId: "child-session",
				sessionFile: "/tmp/child-session.jsonl",
				isIsolated: false,
			}),
		]);
	});

	it("retains failed child metadata in the settled async details", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", {
				sessionId: "failed-session",
				sessionFile: "/tmp/failed-session.jsonl",
				isIsolated: false,
				exitCode: 1,
				error: "child failed",
				aborted: true,
				abortReason: "cancelled by child",
			}),
		);

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const result = await tool.execute("tc-failed-details", {
			agent: "task",
			name: "FailedChild",
			task: "Fail with metadata.",
		} as TaskParams);
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;

		expect(job.status).toBe("failed");
		expect(job.latestDetails?.results).toEqual([
			expect.objectContaining({
				id: "FailedChild",
				sessionId: "failed-session",
				sessionFile: "/tmp/failed-session.jsonl",
				isIsolated: false,
				error: "child failed",
				aborted: true,
				abortReason: "cancelled by child",
			}),
		]);
	});

	it("retains the temporary artifacts directory for a completed async spawn (in-memory session)", async () => {
		// Regression: with no session file (in-memory session), leaseArtifacts()
		// allocates a temporary directory that runStructuredSubagent() deletes
		// on completion unless retainArtifacts is requested. Detached (async)
		// spawns advertise `agent://<id>` handles in the eventual async-result
		// delivery, so the directory must survive past this call returning
		// (PR #10625 review).
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		let capturedArtifactsDir: string | undefined;
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedArtifactsDir = options.artifactsDir;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-retain", {
			agent: "task",
			name: "Retainling",
			task: "Do the thing.",
		} as TaskParams);

		const jobId = result.details?.async?.jobId;
		const job = manager.getJob(jobId!);
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(capturedArtifactsDir).toBeTruthy();
		await expect(fs.stat(capturedArtifactsDir!)).resolves.toBeDefined();
		await fs.rm(capturedArtifactsDir!, { recursive: true, force: true });
	});

	it("cleans up the retained artifacts directory once the job is evicted", async () => {
		// Regression: retainArtifacts kept the temp directory alive past
		// completion, but nothing ever deleted it afterward — a long-running
		// SDK process accumulated every detached task's transcript forever.
		// Cleanup must run once the job actually leaves the manager (eviction
		// or disposal), not never (PR #10625 review).
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		let capturedArtifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedArtifactsDir = options.artifactsDir;
			return makeResult(options.id ?? "?");
		});

		// Cleanup runs fire-and-forget off the job's own settle chain; spy on
		// the real `fs.rm` call to await its actual completion instead of
		// guessing a wait duration.
		const rmCalled = deferred();
		const realRm = fs.rm.bind(fs);
		vi.spyOn(fs, "rm").mockImplementation(async (target, opts) => {
			const outcome = await realRm(target as Parameters<typeof fs.rm>[0], opts as Parameters<typeof fs.rm>[1]);
			if (capturedArtifactsDir && target === capturedArtifactsDir) rmCalled.resolve();
			return outcome;
		});

		// retentionMs: 0 evicts synchronously once the job settles so the
		// test does not have to wait out the real 5-minute default
		// retention window.
		const manager = new AsyncJobManager({
			onJobComplete: () => {},
			retentionMs: 0,
			retainedArtifactsCleanupGraceMs: 0,
		});
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-evict", {
			agent: "task",
			name: "Evictling",
			task: "Do the thing.",
		} as TaskParams);

		const jobId = result.details?.async?.jobId;
		const job = manager.getJob(jobId!);
		await job!.promise;

		expect(capturedArtifactsDir).toBeTruthy();
		expect(manager.getJob(jobId!)).toBeUndefined();
		await rmCalled.promise;
		await expect(fs.stat(capturedArtifactsDir!)).rejects.toThrow();
	});

	it("attaches retained-artifacts cleanup to the collision-suffixed job, not the pre-existing row", async () => {
		// Regression: `AsyncJobManager.register()` suffixes the requested job
		// id when it collides with another live job (e.g. a task id reusing a
		// vibe turn's job id). The cleanup wiring looked the job back up by
		// the *requested* id, which — after a collision — resolves to the
		// unrelated pre-existing row instead of the newly registered task, so
		// cleanup attached to (and could later delete artifacts alongside)
		// the wrong job (PR #10625 review).
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		let capturedArtifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedArtifactsDir = options.artifactsDir;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		// Placeholder job occupying "Foo", the id the fresh task would
		// otherwise be allocated — its own agent output id is unique per
		// AgentOutputManager, independent of the job manager's id map, so
		// this simulates the collision without needing a second spawn.
		const placeholderGate = deferred();
		manager.register(
			"bash",
			"placeholder",
			async () => {
				await placeholderGate.promise;
				return "placeholder done";
			},
			{ id: "Foo" },
		);

		const tool = await TaskTool.create(createSession({ manager }));
		const result = await tool.execute("tc-collide", {
			agent: "task",
			name: "Foo",
			task: "Do the thing.",
		} as TaskParams);

		const jobId = result.details?.async?.jobId;
		expect(jobId).toBe("Foo-2");
		const job = manager.getJob(jobId!);
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.retainedArtifactsCleanup).toBeDefined();
		const placeholder = manager.getJob("Foo");
		expect(placeholder!.retainedArtifactsCleanup).toBeUndefined();

		placeholderGate.resolve();
		if (capturedArtifactsDir) await fs.rm(capturedArtifactsDir, { recursive: true, force: true });
	});

	it("bounds concurrent job bodies with the session spawn semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First job body reaches the executor; second stays parked at the
		// semaphore — still flagged queued because markRunning never ran.
		await pollUntil(() => started.length >= 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing the first body lets the second one start.
		gates.get(started[0]!)!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("settles a cancelled spawn while it is queued behind the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await pollUntil(() => started.length === 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		const queuedResult = await Promise.race([
			secondJob.promise.then(() => "settled" as const),
			Bun.sleep(75).then(() => "timeout" as const),
		]);

		gates.get("First")!.resolve();
		await firstJob.promise;
		await secondJob.promise;

		expect(queuedResult).toBe("settled");
		expect(started).toEqual(["First"]);
		expect(secondJob.status).toBe("cancelled");
	});

	it("keeps the concurrency cap intact when a queued spawn is cancelled (no permit leak)", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		// A holds the only permit, gated inside the executor.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		// B parks at the semaphore, then is cancelled while queued. Its
		// teardown must NOT release a permit it never acquired.
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);
		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;
		expect(secondJob.status).toBe("cancelled");

		// C must stay parked while A still holds the cap. A phantom release
		// from B's cancellation would admit C here, running 2 bodies at cap 1.
		const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First"]);
		expect(thirdJob.queued).toBe(true);

		// A finishing admits C — the cap still cycles normally.
		gates.get("First")!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Third"]);

		// D queued behind running C stays serialized: if B's teardown had
		// double-released, two permits would be free and D would start now.
		const fourth = await tool.execute("tc-4", { agent: "task", name: "Fourth", task: "Work D." } as TaskParams);
		const fourthJob = manager.getJob(fourth.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First", "Third"]);
		expect(fourthJob.queued).toBe(true);

		gates.get("Third")!.resolve();
		await thirdJob.promise;
		await pollUntil(() => started.length === 3);
		gates.get("Fourth")!.resolve();
		await fourthJob.promise;

		expect(started).toEqual(["First", "Third", "Fourth"]);
		expect(firstJob.status).toBe("completed");
		expect(thirdJob.status).toBe("completed");
		expect(fourthJob.status).toBe("completed");
	});

	for (const maxConcurrency of [0, 0.5]) {
		it(`runs spawn job bodies unbounded when task.maxConcurrency is ${maxConcurrency}`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
			const started: string[] = [];
			const gates = new Map<string, Deferred>();
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const id = options.id ?? "?";
				started.push(id);
				const gate = deferred();
				gates.set(id, gate);
				await gate.promise;
				return makeResult(id);
			});

			const manager = createManager();
			const tool = await TaskTool.create(
				createSession({ manager, settings: { "task.maxConcurrency": maxConcurrency } }),
			);

			const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
			const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
			const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);

			// All three job bodies clear the spawn semaphore in parallel — none stays queued.
			await pollUntil(() => started.length === 3);
			expect(started.sort()).toEqual(["First", "Second", "Third"]);

			for (const id of ["First", "Second", "Third"]) gates.get(id)!.resolve();
			await Promise.all([
				manager.getJob(first.details!.async!.jobId)!.promise,
				manager.getJob(second.details!.async!.jobId)!.promise,
				manager.getJob(third.details!.async!.jobId)!.promise,
			]);
		});
	}

	it("re-reads task.maxConcurrency on each spawn so a mid-session change applies on the next acquire", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		// Prime the semaphore at the initial high cap.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		// Tighten the cap mid-session. The next spawn MUST see the new ceiling.
		settings.override("task.maxConcurrency", 1);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First is still running (and holding the only slot under the new cap),
		// so Second is parked at the semaphore — queued, not running.
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing First admits Second.
		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
	});

	it("applies a lowered maxConcurrency to work already queued in the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const jobs: AsyncJob[] = [];
		for (const id of ["First", "Second", "Third", "Fourth", "Fifth"]) {
			const result = await tool.execute(`tc-${id}`, { agent: "task", name: id, task: `Work ${id}.` } as TaskParams);
			jobs.push(manager.getJob(result.details!.async!.jobId)!);
		}
		const fifthJob = jobs[4]!;

		await pollUntil(() => started.length === 4);
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		settings.override("task.maxConcurrency", 1);
		gates.get("First")!.resolve();
		await jobs[0]!.promise;
		await Promise.resolve();
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		for (const id of ["Second", "Third", "Fourth"]) gates.get(id)!.resolve();
		await pollUntil(() => started.length === 5);
		expect([...started].sort()).toEqual(["Fifth", "First", "Fourth", "Second", "Third"]);

		gates.get("Fifth")!.resolve();
		await Promise.all(jobs.map(job => job.promise));
	});
});

describe("subagent session readiness", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("blocks the first prompt until readiness and preserves the created session identifiers", async () => {
		const order: string[] = [];
		const identity: MutableSessionIdentity = {
			sessionId: "persisted-session",
			sessionFile: "/tmp/persisted-session.jsonl",
		};
		const session = createExecutorSession({
			agentId: "ReadyChild",
			identity,
			order,
			promptLabel: "child",
			onPrompt: current => {
				current.sessionId = "mutated-session";
				current.sessionFile = "/tmp/mutated-session.jsonl";
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createExecutorSessionResult(session));

		const readinessEntered = deferred();
		const readinessReleased = deferred();
		const progress: AgentProgress[] = [];
		const lifecycle: SubagentLifecyclePayload[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			lifecycle.push(payload as SubagentLifecyclePayload);
		});
		let readyAgentId: string | undefined;
		let readyParentAgentId: string | undefined;
		let readyParentToolCallId: string | undefined;
		const run = executorModule.runSubprocess(
			createExecutorOptions("ReadyChild", {
				parentAgentId: "Main",
				parentToolCallId: "tool-parent",
				eventBus,
				onProgress: current => progress.push(current),
				onSubagentSessionReady: async context => {
					readyAgentId = context.agentId;
					readyParentAgentId = context.parentAgentId;
					readyParentToolCallId = context.parentToolCallId;
					order.push("ready");
					readinessEntered.resolve();
					await readinessReleased.promise;
				},
			}),
		);

		await readinessEntered.promise;
		await Promise.resolve();
		expect(order).toEqual(["ready"]);
		expect(readyAgentId).toBe("ReadyChild");
		expect(readyParentAgentId).toBe("Main");
		expect(readyParentToolCallId).toBe("tool-parent");

		readinessReleased.resolve();
		const result = await run;

		expect(order).toEqual(["ready", "prompt:child"]);
		expect(result.sessionId).toBe("persisted-session");
		expect(result.sessionFile).toBe("/tmp/persisted-session.jsonl");
		expect(progress.at(-1)?.sessionId).toBe("persisted-session");
		expect(lifecycle.map(payload => payload.status)).toEqual(["started", "completed"]);
		expect(lifecycle.every(payload => payload.sessionId === "persisted-session")).toBe(true);
		expect(lifecycle.every(payload => payload.sessionFile === "/tmp/persisted-session.jsonl")).toBe(true);
	});

	it("delegates a readiness handler installed after the SDK task tool is constructed", async () => {
		using tempDir = TempDir.createSync("@pi-task-sdk-readiness-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session: parentSession, subagentEventBus } = await sdkModule.createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"task.isolation.enabled": false,
				"task.maxRecursionDepth": 4,
				"task.softRequestBudget": 0,
			}),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["task"],
			restrictToolNames: true,
			agentId: "Main",
		});

		try {
			const taskTool = parentSession.getToolByName("task");
			if (!taskTool) throw new Error("Expected SDK-created task tool");

			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
			const order: string[] = [];
			const identity: MutableSessionIdentity = {
				sessionId: "sdk-child-session",
				sessionFile: "/tmp/sdk-child-session.jsonl",
			};
			const promptEntered = deferred();
			const promptReleased = deferred();
			const childSession = createExecutorSession({
				agentId: "ReadyChild",
				identity,
				order,
				promptLabel: "child",
				onPrompt: async current => {
					current.sessionId = "mutated-child-session";
					current.sessionFile = "/tmp/mutated-child-session.jsonl";
					promptEntered.resolve();
					await promptReleased.promise;
				},
			});
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createExecutorSessionResult(childSession));
			if (!subagentEventBus) throw new Error("Expected SDK subagent event bus");
			const lifecycleStatuses: string[] = [];
			const lifecycleSessionIds: Array<string | undefined> = [];
			const lifecycleSessionFiles: Array<string | undefined> = [];
			subagentEventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
				if (typeof payload !== "object" || payload === null) return;
				const status = Reflect.get(payload, "status");
				if (typeof status !== "string") return;
				const sessionId = Reflect.get(payload, "sessionId");
				const sessionFile = Reflect.get(payload, "sessionFile");
				lifecycleStatuses.push(status);
				lifecycleSessionIds.push(typeof sessionId === "string" ? sessionId : undefined);
				lifecycleSessionFiles.push(typeof sessionFile === "string" ? sessionFile : undefined);
			});
			const emittedProgress: AgentProgress[] = [];

			const readinessEntered = deferred();
			const readinessReleased = deferred();
			let readySessionId: string | undefined;
			let readySession: AgentSession | undefined;
			let readyParentToolCallId: string | undefined;
			let cancelChild: (() => void) | undefined;
			parentSession.installSubagentSessionReadyHandler(async context => {
				readySessionId = context.session.sessionManager.getSessionId();
				readySession = context.session;
				readyParentToolCallId = context.parentToolCallId;
				cancelChild = context.cancel;
				order.push("ready");
				readinessEntered.resolve();
				await readinessReleased.promise;
			});

			const execution = taskTool.execute(
				"sdk-parent-tool-call",
				{
					agent: "task",
					name: "ReadyChild",
					task: "Do the thing.",
					isolated: false,
				} satisfies TaskParams,
				undefined,
				update => {
					const current = update.details?.progress?.[0];
					if (current) emittedProgress.push(current);
				},
			);

			let executionSettled = false;
			try {
				const firstBoundary = await Promise.race([
					readinessEntered.promise.then(() => "ready" as const),
					promptEntered.promise.then(() => "prompt" as const),
				]);
				expect(firstBoundary).toBe("ready");
				expect(order).toEqual(["ready"]);
				expect(readySessionId).toBe("sdk-child-session");
				expect(readySession).toBe(childSession);
				expect(readyParentToolCallId).toBe("sdk-parent-tool-call");

				readinessReleased.resolve();
				await promptEntered.promise;
				expect(order).toEqual(["ready", "prompt:child"]);
				expect(identity.sessionId).toBe("mutated-child-session");
				expect(readySessionId).toBe("sdk-child-session");

				if (!cancelChild) throw new Error("Expected executor-owned child cancel callback");
				cancelChild();
				promptReleased.resolve();
				const toolResult = await execution;
				executionSettled = true;
				const childResult = toolResult.details?.results[0];
				expect(childResult?.aborted).toBe(true);
				expect(childResult?.abortReason).toBe("Cancelled by caller");
				expect(childResult?.sessionId).toBe("sdk-child-session");
				expect(childResult?.sessionFile).toBe("/tmp/sdk-child-session.jsonl");
				expect(emittedProgress.at(-1)?.status).toBe("aborted");
				expect(emittedProgress.at(-1)?.sessionId).toBe("sdk-child-session");
				expect(lifecycleStatuses).toEqual(["started", "aborted"]);
				expect(lifecycleSessionIds).toEqual(["sdk-child-session", "sdk-child-session"]);
				expect(lifecycleSessionFiles).toEqual(["/tmp/sdk-child-session.jsonl", "/tmp/sdk-child-session.jsonl"]);
			} finally {
				readinessReleased.resolve();
				promptReleased.resolve();
				if (!executionSettled) await execution.catch(() => undefined);
			}
		} finally {
			await parentSession.dispose();
			authStorage.close();
		}
	});

	it("inherits the readiness handler for a nested task dispatch", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const order: string[] = [];
		const outerSession = createExecutorSession({
			agentId: "Outer",
			identity: { sessionId: "outer-session", sessionFile: "/tmp/outer-session.jsonl" },
			order,
			promptLabel: "outer",
		});
		const nestedSession = createExecutorSession({
			agentId: "Nested",
			identity: { sessionId: "nested-session", sessionFile: "/tmp/nested-session.jsonl" },
			order,
			promptLabel: "nested",
		});
		const sessions = [outerSession, nestedSession];
		let createdCount = 0;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			const next = sessions[createdCount++];
			if (!next) throw new Error("Unexpected child session creation");
			return createExecutorSessionResult(next);
		});

		let nestedResult: SingleResult | undefined;
		const handler: SubagentSessionReadyHandler = async context => {
			order.push(`ready:${context.parentAgentId}->${context.agentId}`);
			if (context.agentId !== "Outer") return;
			const nestedTool = await TaskTool.create(context.session as unknown as ToolSession);
			const toolResult = await nestedTool.execute("nested-tool-call", {
				agent: "task",
				name: "Nested",
				task: "Do the thing.",
			} as TaskParams);
			nestedResult = toolResult.details?.results[0];
		};

		await executorModule.runSubprocess(
			createExecutorOptions("Outer", {
				parentAgentId: "Main",
				parentToolCallId: "outer-tool-call",
				onSubagentSessionReady: handler,
			}),
		);

		expect(order).toEqual(["ready:Main->Outer", "ready:Outer->Nested", "prompt:nested", "prompt:outer"]);
		expect(nestedResult?.sessionId).toBe("nested-session");
		expect(nestedResult?.sessionFile).toBe("/tmp/nested-session.jsonl");
	});

	for (const scenario of [
		{ name: "eval one-shot", invocationKind: "eval" as const, worktree: undefined },
		{ name: "isolated task", invocationKind: "task" as const, worktree: "/tmp/isolated-child" },
	]) {
		it(`bypasses readiness for an ${scenario.name}`, async () => {
			const order: string[] = [];
			const identity: MutableSessionIdentity = {
				sessionId: `${scenario.invocationKind}-session`,
				sessionFile: `/tmp/${scenario.invocationKind}-session.jsonl`,
			};
			const session = createExecutorSession({
				agentId: "BypassChild",
				identity,
				order,
				promptLabel: scenario.name,
			});
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createExecutorSessionResult(session));
			let readinessCalls = 0;

			const result = await executorModule.runSubprocess(
				createExecutorOptions("BypassChild", {
					invocationKind: scenario.invocationKind,
					worktree: scenario.worktree,
					onSubagentSessionReady: () => {
						readinessCalls += 1;
					},
				}),
			);

			expect(readinessCalls).toBe(0);
			expect(order).toEqual([`prompt:${scenario.name}`]);
			expect(result.sessionId).toBe(identity.sessionId);
			expect(result.sessionFile).toBe(identity.sessionFile);
		});
	}
});
