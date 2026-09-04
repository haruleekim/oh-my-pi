import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";

const arkSessionNotification = type({
	sessionId: "string",
	update: {
		sessionUpdate:
			"'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | 'tool_call_update' | 'plan' | 'plan_update' | 'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update' | 'usage_update'",
	},
});

import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import {
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { expectAcpStructure, expectAcpStructureRejects } from "./helpers/acp-schema";

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function getChunkMessageId(event: { update: object }): string | undefined {
	const update = event.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(arkSessionNotification, update);
	}
}

function shellResourceContent(toolCallId: string, command: string) {
	return {
		type: "content" as const,
		content: {
			type: "resource" as const,
			resource: {
				uri: `omp-shell://tool/${toolCallId}/command.sh`,
				text: command,
				mimeType: "text/x-shellscript",
			},
		},
	};
}

function outputResourceContent(toolCallId: string, index: number, text: string) {
	return {
		type: "content" as const,
		content: {
			type: "resource" as const,
			resource: {
				uri: `omp-output://tool/${toolCallId}/output-${index}.txt`,
				text,
				mimeType: "text/plain",
			},
		},
	};
}

const TEST_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

class ReplayTestSession {
	sessionManager: SessionManager;
	sessionId: string;
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	skills: [] = [];
	extensionRunner = undefined;
	settings = { get: (_key: string) => false };

	constructor(cwd: string, sessionDir?: string) {
		this.sessionManager = SessionManager.create(cwd, sessionDir);
		this.sessionId = this.sessionManager.getSessionId();
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return [];
	}

	getPlanModeState(): undefined {
		return undefined;
	}

	setClientBridge(_bridge: unknown): void {}

	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => {};
	}

	async refreshMCPTools(_tools: unknown): Promise<void> {}
}

describe("ACP event mapper", () => {
	it("attaches a stable messageId to live assistant chunks", () => {
		const assistantMessage = makeAssistantMessage("chunk");
		const getMessageId = (message: unknown): string | undefined =>
			message === assistantMessage ? "a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a" : undefined;

		const textUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "chunk" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);
		const thoughtUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);

		expect(textUpdates).toHaveLength(1);
		expect(thoughtUpdates).toHaveLength(1);
		expectAcpNotifications([...textUpdates, ...thoughtUpdates]);
		expect(textUpdates[0] ? getChunkMessageId(textUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
		expect(thoughtUpdates[0] ? getChunkMessageId(thoughtUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
	});

	it("maps an advisor intervention to its own card instead of dropping it", () => {
		// The `content` bytes are the agent-facing `<advisory>` XML; the card is
		// rebuilt from the structured notes so the client shows prose, and the
		// notes ride `_meta` for clients that render advisories themselves.
		const advisorCard = {
			role: "custom" as const,
			customType: "advisor",
			display: true,
			attribution: "agent" as const,
			content:
				'<advisory severity="concern" guidance="weigh, don\'t blindly obey">\nUse bun run test:rs\n</advisory>',
			details: { notes: [{ note: "Use `bun run test:rs`", severity: "concern" }] },
		};

		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "message_end", message: advisorCard } as unknown as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			toolCallId: string;
			title: string;
			kind: string;
			status: string;
			content: Array<{ type: string; content: { type: string; text: string } }>;
			_meta: { advisor_notes: unknown };
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.toolCallId.startsWith("advisor-")).toBe(true);
		expect(update.title).toBe("Advisor · concern");
		expect(update.kind).toBe("think");
		expect(update.status).toBe("completed");
		expect(update.content).toEqual([
			{ type: "content", content: { type: "text", text: "> **concern** — Use `bun run test:rs`" } },
		]);
		expect(update._meta.advisor_notes).toEqual([{ note: "Use `bun run test:rs`", severity: "concern" }]);

		// Clients upsert tool cards by id, so a shared id would make each note
		// overwrite the previous card in place — one visible advisory for a
		// whole turn's worth of notes, and no error anywhere.
		const repeat = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "message_end", message: advisorCard } as unknown as AgentSessionEvent,
			"session-1",
		);
		const repeatUpdate = repeat[0]!.update as { toolCallId: string };
		expect(repeatUpdate.toolCallId).not.toBe(update.toolCallId);
	});

	it("names a batched advisory by its size and attributes each note to its advisor", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: "advisor",
					content: "ignored",
					details: {
						notes: [
							{ note: "first\n\nsecond line", severity: "blocker", advisor: "reviewer" },
							{ note: "  ", severity: "nit" },
							{ note: "unnamed", advisor: "default" },
						],
					},
				},
			} as unknown as AgentSessionEvent,
			"session-1",
		);

		const update = updates[0]!.update as {
			title: string;
			content: Array<{ content: { text: string } }>;
		};
		// The blank note is dropped, so the count reflects what the card shows.
		expect(update.title).toBe("Advisor · 2 notes · 1 blocker");
		expect(update.content[0]!.content.text).toBe(
			"> **blocker** _(reviewer)_ — first\n>\n> second line\n\n> **note** — unnamed",
		);
	});

	it("emits nothing for an advisory with no usable notes or a non-advisor custom message", () => {
		for (const message of [
			{ role: "custom", customType: "advisor", content: "x", details: { notes: [{ note: "" }] } },
			{ role: "custom", customType: "advisor", content: "x", details: undefined },
			{ role: "custom", customType: "skill-prompt", content: "x", details: { notes: [{ note: "hi" }] } },
		]) {
			expect(
				mapAgentSessionEventToAcpSessionUpdates(
					{ type: "message_end", message } as unknown as AgentSessionEvent,
					"session-1",
				),
			).toEqual([]);
		}
	});

	it("emits final assistant text losslessly when no text deltas were observed", () => {
		const marker = "MESSAGE-END-MARKER";
		const text = `${"f".repeat(4_001 - marker.length)}${marker}`;
		const assistantMessage = makeAssistantMessage(text);
		const progress = { textEmitted: false, thoughtEmitted: false };

		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			{ getMessageProgress: message => (message === assistantMessage ? progress : undefined) },
		);

		expect(updates).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text },
					messageId: undefined,
				},
			},
		]);
		expectAcpNotifications(updates);
		expect(progress.textEmitted).toBe(true);
	});

	it("emits completed assistant text losslessly when no text delta arrived", () => {
		const marker = "DONE-END-MARKER";
		const text = `${"d".repeat(4_001 - marker.length)}${marker}`;
		const assistantMessage = makeAssistantMessage(text);
		const progress = { textEmitted: false, thoughtEmitted: false };

		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "done", message: assistantMessage },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageProgress: message => (message === assistantMessage ? progress : undefined) },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		expect(updates[0]?.update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
		});
		expect(progress.textEmitted).toBe(true);
	});

	it("does not duplicate final assistant text after streaming deltas", () => {
		const assistantMessage = makeAssistantMessage("streamed response");
		const progress = { textEmitted: false, thoughtEmitted: false };
		const options = {
			getMessageProgress: (message: unknown) => (message === assistantMessage ? progress : undefined),
		};

		const deltaUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "streamed response" },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const doneUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			options,
		);

		expect(deltaUpdates).toHaveLength(1);
		expectAcpNotifications(deltaUpdates);
		expect(doneUpdates).toEqual([]);
	});

	it("preserves command text when a new command tool is started", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-command-start",
				toolName: "bash",
				args: { command: "npm run check" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.content).toContainEqual(shellResourceContent("tc-command-start", "npm run check"));
	});

	it("keeps internal Hub traffic off the ACP session stream", () => {
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				args: { op: "send", to: "Scout", message: "Private coordination" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				args: { op: "send", to: "Scout", message: "Private coordination" },
				partialResult: { content: [{ type: "text", text: "delivering" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				isError: false,
				result: { content: [{ type: "text", text: "delivered" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				getToolArgs: () => ({ op: "send", to: "Scout", message: "Private coordination" }),
			}),
		);

		expect(updates).toEqual([]);
	});

	it("keeps xd-routed Hub traffic off the ACP session stream", () => {
		const args = {
			path: "xd://hub",
			content: JSON.stringify({ op: "inbox", from: "Scout" }),
		};
		const events = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-xd-hub-inbox",
				toolName: "write",
				args,
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-xd-hub-inbox",
				toolName: "write",
				isError: false,
				result: { content: [{ type: "text", text: "Private reply" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				getToolArgs: () => args,
			}),
		);

		expect(updates).toEqual([]);
	});

	it("keeps Hub process control visible over ACP", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-process-send",
				toolName: "hub",
				args: { op: "send", name: "server", text: "ping" },
			},
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.update).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				rawInput: { op: "send", name: "server", text: "ping" },
			}),
		);
	});

	it("keeps background job-wait results visible over ACP", () => {
		const events = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-job-wait",
				toolName: "hub",
				args: { op: "wait", ids: ["bash_a1b2c3"] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-job-wait",
				toolName: "hub",
				isError: false,
				result: { content: [{ type: "text", text: "job output" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				getToolArgs: () => ({ op: "wait", ids: ["bash_a1b2c3"] }),
			}),
		);

		expect(updates.map(update => update.update.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
	});

	it("keeps a bare Hub wait visible so job deliveries reach ACP", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-bare-wait",
				toolName: "hub",
				args: { op: "wait" },
			},
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.update.sessionUpdate).toBe("tool_call");
	});

	it("hides a peer-scoped Hub wait from ACP", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-peer-wait",
				toolName: "hub",
				args: { op: "wait", from: "Scout" },
			},
			"session-1",
		);

		expect(updates).toEqual([]);
	});

	it("prefers the model's intent over the command for a command tool", () => {
		// `i` is required by default and the system prompt shapes it into a short
		// present-participle phrase, so it is a better card name than the source
		// the client already renders below.
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-command-start-intent",
				toolName: "bash",
				args: { command: "echo hi" },
				intent: "Checking greeting output",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			title: string;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.title).toBe("Checking greeting output");
		// The command is still shipped once, as highlighted source.
		expect(update.content).toContainEqual(shellResourceContent("tc-command-start-intent", "echo hi"));
	});

	it("names a shell call by its invocation head, not the whole command", () => {
		// The full command rides along as highlighted source, so the title's one
		// line should say what ran — an inline script pasted verbatim used to
		// wrap over the entire card.
		const cases: Array<{ command: string; title: string }> = [
			{ command: 'bun -e "console.log(JSON.stringify({ a: 1 }))"', title: "bun -e" },
			{ command: "npm test", title: "npm test" },
			{ command: 'git commit -m "msg"', title: "git commit" },
			{ command: "NODE_ENV=production bun run build", title: "bun run build" },
			{ command: "for i in $(seq 1 5); do echo $i; done", title: "for i in" },
			{ command: "ls", title: "ls" },
		];
		for (const { command, title } of cases) {
			const update = buildToolCallStartUpdate({
				toolCallId: "tc-command-label",
				toolName: "bash",
				args: { command },
				cwd: path.resolve("/repo"),
			});
			expect(update).toMatchObject({ title });
		}
	});

	it("emits language-tagged resources for eval sources", () => {
		const cases = [
			["py", "text/x-python", "py", "print(1)"],
			["js", "text/javascript", "js", "return 1 + 1;"],
			["rb", "text/x-ruby", "rb", "puts 1"],
			["jl", "text/x-julia", "jl", "println(1)"],
		] as const;

		for (const [language, mimeType, extension, source] of cases) {
			const toolCallId = `tc-eval-${language}`;
			const args = { language, title: "source", code: source };
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId,
					toolName: "eval",
					args,
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				sessionUpdate: string;
				title: string;
				kind?: string;
				status?: string;
				rawInput?: unknown;
				content?: Array<{
					type: string;
					content?: {
						type: string;
						resource?: { uri: string; text: string; mimeType?: string };
					};
				}>;
			};
			expect(update.sessionUpdate).toBe("tool_call");
			expect(update.title).toBe("source");
			expect(update.kind).toBe("execute");
			expect(update.status).toBe("pending");
			expect(update.rawInput).toEqual(args);
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "resource",
						resource: {
							uri: `omp-eval://tool/${toolCallId}/cell-0.${extension}`,
							text: source,
							mimeType,
						},
					},
				},
			]);
		}
	});

	it("builds eval resource content from valid cells only", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-eval-mixed-cells",
				toolName: "eval",
				args: {
					cells: [null, {}, { code: "" }, { code: "x" }, { language: "py", code: "y" }],
				},
				intent: "evaluating",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			title: string;
			content?: Array<{
				type: string;
				content?: {
					type: string;
					resource?: { uri: string; text: string; mimeType?: string };
				};
			}>;
		};
		// No cell carries a label, so the title falls through to the model's
		// intent instead of naming the languages.
		expect(update.title).toBe("evaluating");
		expect(update.content).toEqual([
			{
				type: "content",
				content: {
					type: "resource",
					resource: {
						uri: "omp-eval://tool/tc-eval-mixed-cells/cell-0.txt",
						text: "x",
						mimeType: "text/plain",
					},
				},
			},
			{
				type: "content",
				content: {
					type: "resource",
					resource: {
						uri: "omp-eval://tool/tc-eval-mixed-cells/cell-1.py",
						text: "y",
						mimeType: "text/x-python",
					},
				},
			},
		]);
	});

	it("names eval cells by their labels without tagging the language", () => {
		// The language reaches the client on each resource's mime type, so the
		// title line is spent on what the cells do, not on repeating `[py]`.
		const update = buildToolCallStartUpdate({
			toolCallId: "tc-eval-labels",
			toolName: "eval",
			args: {
				cells: [
					{ language: "py", title: "imports", code: "import json" },
					{ language: "py", title: " load config ", code: "json.loads(x)" },
				],
			},
		}) as { title: string };
		expect(update.title).toBe("imports · load config");
	});

	it("caps eval titles without truncating resource source", () => {
		for (const [titleLength, titleEndsWithEllipsis] of [
			[4_000, false],
			[4_001, true],
		] as const) {
			const title = "t".repeat(titleLength);
			const source = `${"x".repeat(4_500)}EVAL-SOURCE-END`;
			const toolCallId = `tc-eval-long-title-${titleLength}`;
			const args = { language: "js", title, code: source };
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId,
					toolName: "eval",
					args,
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				title: string;
				content?: Array<{
					type: string;
					content?: {
						type: string;
						resource?: { uri: string; text: string; mimeType?: string };
					};
				}>;
				rawInput?: unknown;
			};
			expect(update.title).toHaveLength(4_000);
			expect(update.title.endsWith("…")).toBe(titleEndsWithEllipsis);
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "resource",
						resource: {
							uri: `omp-eval://tool/${toolCallId}/cell-0.js`,
							text: source,
							mimeType: "text/javascript",
						},
					},
				},
			]);
			expect(update.rawInput).toEqual(args);
		}
	});

	it("keeps an unnameable command's title short while the shell resource stays whole", () => {
		// One giant token has no invocation head to name; the title must not
		// become a wall of text, and the source block must still carry every byte.
		const command = "c".repeat(3_998);
		const toolCallId = "tc-command-title-long";
		const update = buildToolCallStartUpdate({
			toolCallId,
			toolName: "bash",
			args: { command },
		}) as {
			title: string;
			content?: Array<{
				type: string;
				content?: {
					type: string;
					resource?: { uri: string; text: string; mimeType?: string };
				};
			}>;
		};

		expect(update.title.length).toBeLessThanOrEqual(64);
		expect(update.title.endsWith("…")).toBe(true);
		expect(update.content).toEqual([
			{
				type: "content",
				content: {
					type: "resource",
					resource: {
						uri: `omp-shell://tool/${toolCallId}/command.sh`,
						text: command,
						mimeType: "text/x-shellscript",
					},
				},
			},
		]);
	});

	it("emits a diff ToolCallContent for each per-file edit result", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						diff: "--- a/foo\n+++ b/foo\n",
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before\n", newText: "after\n" },
							{ path: "bar.ts", diff: "...", oldText: undefined, newText: "created\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([
			{ type: "diff", path: "foo.ts", oldText: "before\n", newText: "after\n" },
			{ type: "diff", path: "bar.ts", oldText: null, newText: "created\n" },
		]);
		expect(update.locations).toEqual([{ path: "foo.ts" }, { path: "bar.ts" }, { path: "skipped.ts" }]);
	});

	it("emits a diff ToolCallContent for single-file edit details", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-single",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						path: "single.ts",
						diff: "--- a/single.ts\n+++ b/single.ts\n",
						oldText: "before\n",
						newText: "after\n",
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content?.filter(block => block.type === "diff")).toEqual([
			{ type: "diff", path: "single.ts", oldText: "before\n", newText: "after\n" },
		]);
		expect(update.locations).toEqual([{ path: "single.ts" }]);
	});

	it("does not emit a half diff when one referenced snapshot is unavailable", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-missing-snapshot",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "[large.ts#ABCD]\n1:after" }],
					details: {
						path: "large.ts",
						oldSnapshotRef: { path: "large.ts", versionId: "missing" },
						newText: "after",
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ getFileSnapshot: () => undefined },
		);

		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.content?.filter(block => block.type === "diff")).toEqual([]);
		const fallback = update.content?.find(block => block.type === "content")?.content?.text;
		expect(fallback).toContain("large.ts");
		expect(fallback).toContain("evicted");
	});

	it("omits model-facing hashline text when every mutation has a native diff", () => {
		const result = {
			content: [{ type: "text", text: "[small.ts#ABCD]\n1:after" }],
			details: {
				path: "small.ts",
				oldText: "before",
				newText: "after",
			},
		};
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-complete-diff",
				toolName: "edit",
				isError: false,
				result,
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates[0]!.update).toMatchObject({
			content: [{ type: "diff", path: "small.ts", oldText: "before", newText: "after" }],
			rawOutput: result,
		});
	});

	it("renders structured mutation notices without restoring the hashline preview", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-diff-notice",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "[small.ts#ABCD]\n1:after\n\nWarnings:\nParser warning" }],
					details: {
						path: "small.ts",
						oldText: "before",
						newText: "after",
						notices: ["Parser warning"],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates[0]!.update).toMatchObject({
			content: [
				{ type: "diff", path: "small.ts", oldText: "before", newText: "after" },
				{ type: "content", content: { type: "text", text: "Parser warning" } },
			],
		});
	});

	it("keeps successful diffs and names entries that require text fallback", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-partial-diff",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "raw preview for both files" }],
					details: {
						perFileResults: [
							{ path: "small.ts", oldText: "before", newText: "after" },
							{
								path: "huge.ts",
								snapshotsPruned: true,
								snapshotFallback: "file-limit",
							},
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		const content = (
			updates[0]!.update as {
				content?: Array<{
					type: string;
					path?: string;
					oldText?: string | null;
					newText?: string;
					content?: { type: string; text?: string };
				}>;
			}
		).content;
		expect(content?.filter(block => block.type === "diff")).toEqual([
			{ type: "diff", path: "small.ts", oldText: "before", newText: "after" },
		]);
		const fallback = content?.find(block => block.type === "content")?.content?.text;
		expect(fallback).toContain("huge.ts");
		expect(fallback).toContain("file-limit");
		expect(fallback).not.toContain("raw preview for both files");
	});

	it("resolves live image blob refs for ACP content without expanding rawOutput", () => {
		const blobRef = "blob:sha256:77467fcfe2bbdc034e0eabb4778c9d7de521c0d7c3e0d0a62566468e4d7da3a5";
		const resolvedImageData = "resolved-webp-base64";
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_update",
				toolCallId: "tc-image-update",
				toolName: "generate_image",
				args: {},
				partialResult: {
					content: [{ type: "image", data: blobRef, mimeType: "image/webp" }],
					details: { images: [{ data: blobRef, mimeType: "image/webp" }] },
				},
			} as AgentSessionEvent,
			{
				type: "tool_execution_end",
				toolCallId: "tc-image-end",
				toolName: "generate_image",
				isError: false,
				result: {
					content: [{ type: "text", text: "Generated image saved." }],
					details: { images: [{ data: blobRef, mimeType: "image/webp" }] },
				},
			} as AgentSessionEvent,
		];

		for (const event of events) {
			const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				resolveImageData: data => (data === blobRef ? resolvedImageData : data),
			});
			const update = updates[0]!.update as {
				content?: Array<{
					type: string;
					content?: { type: string; data?: string; mimeType?: string; text?: string };
				}>;
				rawOutput?: unknown;
			};
			const images = update.content?.filter(item => item.type === "content" && item.content?.type === "image") ?? [];

			expect(images).toEqual([
				{ type: "content", content: { type: "image", data: resolvedImageData, mimeType: "image/webp" } },
			]);
			expect(JSON.stringify(update.content)).not.toContain("blob:sha256:");
			expect(JSON.stringify(update.rawOutput)).toContain(blobRef);
		}
	});

	it("emits locations on tool_execution_update from args", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "edit",
				args: { path: "src/foo.ts" },
				partialResult: { content: [{ type: "text", text: "in progress" }] },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.locations).toEqual([{ path: "src/foo.ts" }]);
	});

	it("preserves command text when a command tool update replaces content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-3",
				toolName: "bash",
				args: { command: "npm run check" },
				partialResult: { details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual(shellResourceContent("tc-3", "npm run check"));
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(update.content).not.toContainEqual({
			type: "content",
			content: { type: "text", text: '{"details":{"terminalId":"term-1"}}' },
		});
	});

	it("preserves command text when tool update details accompany empty content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-empty-content",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [], details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual(shellResourceContent("tc-terminal-empty-content", "echo hi"));
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(update.content).not.toContainEqual({
			type: "content",
			content: { type: "text", text: '{"content":[],"details":{"terminalId":"term-1"}}' },
		});
	});

	it("does not serialize a hub wait progress envelope into content text", () => {
		const partialResult = {
			content: [{ type: "text", text: "" }],
			details: {
				op: "wait",
				jobs: [
					{ id: "bash_1", state: "running" },
					{ id: "bash_2", state: "running" },
				],
			},
		};
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-hub-wait",
				toolName: "hub",
				args: { op: "wait", i: "waiting for jobs" },
				partialResult,
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: unknown;
			rawOutput?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		// The job details already ride the frame as structured rawOutput.
		expect(update.rawOutput).toEqual(partialResult);
		// An empty-text envelope must not be dumped as a JSON blob display row.
		expect(update.content).toBeUndefined();
		expect(JSON.stringify(update.content ?? [])).not.toContain('"op":"wait"');
	});

	it("keeps terminal content alongside readable text", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-update-text",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: {
					content: [{ type: "text", text: "running" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual(outputResourceContent("tc-terminal-update-text", 0, "running"));
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("keeps terminal content alongside readable end text", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-end",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual(outputResourceContent("tc-terminal-end", 0, "done"));
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("preserves command text when a command tool final update replaces content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-final-command",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
			{
				getToolArgs: toolCallId =>
					toolCallId === "tc-terminal-final-command" ? { command: "npm run check" } : undefined,
			},
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual(shellResourceContent("tc-terminal-final-command", "npm run check"));
		expect(update.content).toContainEqual(outputResourceContent("tc-terminal-final-command", 0, "done"));
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("keeps terminal content alongside readable error and message fields", () => {
		const errorUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-error",
				toolName: "bash",
				isError: true,
				result: { errorMessage: "command failed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);
		const messageUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-message",
				toolName: "bash",
				isError: false,
				result: { message: "command completed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(errorUpdates).toHaveLength(1);
		expect(messageUpdates).toHaveLength(1);
		expectAcpNotifications([...errorUpdates, ...messageUpdates]);
		const errorUpdate = errorUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		const messageUpdate = messageUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};

		expect(errorUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(errorUpdate.content).toContainEqual(outputResourceContent("tc-terminal-error", 0, "command failed"));
		expect(messageUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(messageUpdate.content).toContainEqual(
			outputResourceContent("tc-terminal-message", 0, "command completed"),
		);
	});

	it("sends console output as a preformatted resource so Markdown cannot eat it", () => {
		// Every character here means something in Markdown and nothing in a build
		// log: `*` emphasis, `#` heading, `|` table, and leading spaces a code
		// block. A client must show the bytes as printed.
		const output = "| ok | 3 |\n*not emphasis*  # not a heading\n    indented\n`literal`";
		for (const [toolName, args] of [
			["bash", { command: "make" }],
			["eval", { language: "py", code: "print(1)" }],
			["hub", { op: "logs", name: "web" }],
		] as const) {
			const toolCallId = `tc-console-${toolName}`;
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_end",
					toolCallId,
					toolName,
					args,
					isError: false,
					result: { content: [{ type: "text", text: output }] },
				} as AgentSessionEvent,
				"session-1",
			);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as { content?: unknown };
			expect(update.content).toContainEqual(outputResourceContent(toolCallId, 0, output));
		}

		// `hub` mixes voices. `jobs` writes its own Markdown — headings and a
		// fenced excerpt of job output — so fencing it again would show `##` and
		// stray backticks instead of a rendered report.
		const authored = "## Completed (1)\n\n### bg_1 [bash] — completed\n```\ndone\n```";
		const jobs = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-jobs",
				toolName: "hub",
				args: { op: "jobs" },
				isError: false,
				result: { content: [{ type: "text", text: authored }] },
			} as AgentSessionEvent,
			"session-1",
		);
		const jobsUpdate = jobs[0]!.update as { content?: unknown };
		expect(jobsUpdate.content).toEqual([{ type: "content", content: { type: "text", text: authored } }]);

		// Several text blocks stay separate resources: one uri each, or a client
		// that keys content by uri would collapse them into one.
		const multi = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-console-multi",
				toolName: "bash",
				isError: false,
				result: {
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				},
			} as AgentSessionEvent,
			"session-1",
		);
		const multiUpdate = multi[0]!.update as { content?: unknown };
		expect(multiUpdate.content).toEqual([
			outputResourceContent("tc-console-multi", 0, "first"),
			outputResourceContent("tc-console-multi", 1, "second"),
		]);

		// A tool whose result is prose keeps its text block — there the Markdown
		// is the point.
		const prose = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-prose",
				toolName: "web_search",
				isError: false,
				result: { content: [{ type: "text", text: output }] },
			} as AgentSessionEvent,
			"session-1",
		);
		const proseUpdate = prose[0]!.update as { content?: unknown };
		expect(proseUpdate.content).toEqual([{ type: "content", content: { type: "text", text: output } }]);
	});

	it("keeps plain command output visible without terminal details", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-plain-output",
				toolName: "bash",
				isError: false,
				result: "hello from stdout",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};

		expect(update.content).toEqual([outputResourceContent("tc-plain-output", 0, "hello from stdout")]);
	});

	it("keeps long readable tool output intact across result shapes", () => {
		const marker = "TOOL-OUTPUT-END";
		const text = `${"o".repeat(4_001 - marker.length)}${marker}`;
		const jsonResult = { payload: text };
		const cases: Array<{ name: string; result: unknown; expected: string }> = [
			{ name: "plain", result: text, expected: text },
			{ name: "structured", result: { content: [{ type: "text", text }] }, expected: text },
			{ name: "message", result: { message: text }, expected: text },
			{ name: "json", result: jsonResult, expected: JSON.stringify(jsonResult) },
		];

		for (const testCase of cases) {
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_end",
					toolCallId: `tc-long-${testCase.name}`,
					toolName: "custom",
					isError: false,
					result: testCase.result,
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				content?: Array<{ type: string; content?: { type: string; text?: string } }>;
				rawOutput?: unknown;
			};
			expect(update.rawOutput).toEqual(testCase.result);
			expect(update.content).toEqual([{ type: "content", content: { type: "text", text: testCase.expected } }]);
		}
	});

	it("embeds only terminal content from direct terminalId", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-direct-terminal",
				toolName: "bash",
				isError: false,
				result: { terminalId: "term-1" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("does not duplicate existing terminal content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-dedup",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "terminal", terminalId: "term-1" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content?.filter(item => item.type === "terminal" && item.terminalId === "term-1")).toHaveLength(1);
	});
	it("shows bash commands in visible tool call content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_bash_1",
				toolName: "bash",
				args: { command: "npm run check", cwd: "/repo" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			toolCallId?: string;
			title?: string;
			kind?: string;
			status?: string;
			rawInput?: unknown;
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.toolCallId).toBe("toolu_bash_1");
		expect(update.title).toBe("npm run check");
		expect(update.kind).toBe("execute");
		expect(update.status).toBe("pending");
		expect(update.rawInput).toEqual({ command: "npm run check", cwd: "/repo" });
		expect(update.content).toEqual([shellResourceContent("toolu_bash_1", "npm run check")]);
	});

	it("maps shell and exec tool starts as execute", () => {
		for (const toolName of ["shell", "exec"] as const) {
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId: `toolu_${toolName}_1`,
					toolName,
					args: { command: "echo hi" },
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				sessionUpdate: string;
				title?: string;
				kind?: string;
				content?: unknown;
			};
			expect(update.sessionUpdate).toBe("tool_call");
			expect(update.title).toBe("echo hi");
			expect(update.kind).toBe("execute");
			expect(update.content).toEqual([shellResourceContent(`toolu_${toolName}_1`, "echo hi")]);
		}
	});

	it("replays assistant tool_use input through the ACP dispatcher without wrapping", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-replay-contract-"));
		const cwd = path.join(root, "cwd");
		const sessionDir = path.join(root, "sessions");
		const initialSessionDir = path.join(root, "initial-session");
		const updates: SessionNotification[] = [];
		const sessions: ReplayTestSession[] = [];
		const abortController = new AbortController();
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			const connection = {
				sessionUpdate: async (notification: SessionNotification) => {
					updates.push(notification);
				},
				signal: abortController.signal,
				closed: Promise.resolve(),
			} as unknown as AgentSideConnection;
			const agent = new AcpAgent(
				connection,
				async (sessionCwd: string) => {
					const session = new ReplayTestSession(sessionCwd, sessionDir);
					sessions.push(session);
					return session as unknown as AgentSession;
				},
				new ReplayTestSession(cwd, initialSessionDir) as unknown as AgentSession,
			);
			const created = await agent.newSession({ cwd, mcpServers: [] });
			const session = sessions[0]!;
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_replay_input",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "toolu_replay_input",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				details: { terminalId: "term-replay" },
				isError: false,
				timestamp: Date.now(),
			});

			updates.length = 0;
			await agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });

			expectAcpNotifications(updates);
			const toolCall = updates.find(update => update.update.sessionUpdate === "tool_call")?.update as
				| { rawInput?: unknown; content?: unknown }
				| undefined;
			const finalUpdate = updates.find(update => update.update.sessionUpdate === "tool_call_update")?.update as
				| { content?: unknown }
				| undefined;

			expect(toolCall?.rawInput).toEqual({ command: "echo hi" });
			expect(toolCall?.rawInput).not.toEqual({ input: { command: "echo hi" } });
			expect(toolCall?.content).toEqual([shellResourceContent("toolu_replay_input", "echo hi")]);
			expect(finalUpdate?.content).toContainEqual(shellResourceContent("toolu_replay_input", "echo hi"));
			// Replay routes through the same mapper, so a reopened session shows
			// the same preformatted output the live turn did.
			expect(finalUpdate?.content).toContainEqual(outputResourceContent("toolu_replay_input", 0, "done"));
			expect(finalUpdate?.content).toContainEqual({ type: "terminal", terminalId: "term-replay" });
		} finally {
			abortController.abort();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("builds replayed bash tool calls from JSON string arguments", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ command: "npm test", cwd: "/repo" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_1",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_1",
			title: "npm test",
			kind: "execute",
			status: "completed",
			rawInput: { command: "npm test", cwd: "/repo" },
			content: [shellResourceContent("toolu_replay_1", "npm test")],
		});
	});

	it("builds replayed read tool-call locations against the replay cwd", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-replay-read-"));
		fs.writeFileSync(path.join(dir, "foo.ts"), "data\n");
		try {
			const replayArgs = normalizeReplayToolArguments(JSON.stringify({ path: "foo.ts" }));
			const update = buildToolCallStartUpdate({
				toolCallId: "toolu_replay_read",
				toolName: "read",
				args: replayArgs.args,
				cwd: dir,
				status: "completed",
			});

			expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
			expect(update).toMatchObject({
				sessionUpdate: "tool_call",
				toolCallId: "toolu_replay_read",
				title: "read: foo.ts",
				kind: "read",
				status: "completed",
				rawInput: { path: "foo.ts" },
				locations: [{ path: path.join(dir, "foo.ts") }],
			});
			expect("content" in update).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps malformed replay arguments as raw input without command content", () => {
		const replayArgs = normalizeReplayToolArguments("{not json");
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_bad",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_bad",
			title: "bash",
			kind: "execute",
			status: "completed",
			rawInput: "{not json",
		});
		expect("content" in update).toBe(false);
	});

	it("keeps object replay arguments unchanged and builds command content", () => {
		const rawArgs = { command: "bun test", cwd: "/repo" };
		const replayArgs = normalizeReplayToolArguments(rawArgs);
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_object",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expect(replayArgs.args).toBe(rawArgs);
		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			title: "bun test",
			status: "completed",
			rawInput: rawArgs,
			content: [shellResourceContent("toolu_replay_object", "bun test")],
		});
	});

	it("recovers the recorded intent when replaying a tool call", () => {
		// A live call carries `i` as `event.intent` because the harness strips it
		// from args before execution, but a replayed call is rebuilt from the
		// persisted assistant message whose `arguments` still hold the raw `i`.
		// Without reading it there, reopening a session silently renamed every
		// card from the model's phrase to the derived label.
		const rawArgs = { i: "Verifying split edits", command: "bun -e 'x'", cwd: "/repo" };
		const replayed = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_intent",
			toolName: "bash",
			args: normalizeReplayToolArguments(rawArgs).args,
			status: "completed",
		});
		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update: replayed });
		expect(replayed).toMatchObject({ title: "Verifying split edits" });

		// Live delivery still wins with the event's own intent, and args without
		// `i` keep falling back to the derived label.
		const live = buildToolCallStartUpdate({
			toolCallId: "toolu_live_intent",
			toolName: "bash",
			args: { command: "bun -e 'x'" },
			intent: "Checking greeting output",
		});
		expect(live).toMatchObject({ title: "Checking greeting output" });
		const unnamed = buildToolCallStartUpdate({
			toolCallId: "toolu_no_intent",
			toolName: "bash",
			args: { command: "bun -e 'x'" },
		});
		expect(unnamed).toMatchObject({ title: "bun -e" });
	});
	it("does not add command text content to non-command tool starts", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_1",
				toolName: "read",
				args: { path: "README.md" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			title?: string;
			kind?: string;
			rawInput?: unknown;
			locations?: { path: string }[];
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.title).toBe("read: README.md");
		expect(update.kind).toBe("read");
		expect(update.rawInput).toEqual({ path: "README.md" });
		expect("locations" in update).toBe(false);
		expect("content" in update).toBe(false);
	});
	it("resolves tool_execution_start locations against mapper cwd", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-read-cwd-"));
		fs.writeFileSync(path.join(dir, "file.ts"), "data\n");
		try {
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId: "toolu_read_cwd",
					toolName: "read",
					args: { path: "file.ts" },
				} as AgentSessionEvent,
				"session-1",
				{ cwd: dir },
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				sessionUpdate: string;
				locations?: { path: string }[];
				content?: unknown;
			};
			expect(update.sessionUpdate).toBe("tool_call");
			expect(update.locations).toEqual([{ path: path.join(dir, "file.ts") }]);
			expect("content" in update).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("strips read selectors from the ACP location while preserving rawInput", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-read-selector-"));
		fs.writeFileSync(path.join(dir, "file.ts"), "data\n");
		const cases = ["file.ts:1-20", "file.ts:raw", "file.ts:1-20:raw", "file.ts:raw:1-20", "file.ts:5-16,960-973"];
		try {
			for (const readPath of cases) {
				const updates = mapAgentSessionEventToAcpSessionUpdates(
					{
						type: "tool_execution_start",
						toolCallId: `toolu_read_sel_${readPath}`,
						toolName: "read",
						args: { path: readPath },
					} as AgentSessionEvent,
					"session-1",
					{ cwd: dir },
				);
				expectAcpNotifications(updates);
				const update = updates[0]!.update as { locations?: { path: string }[]; rawInput?: unknown };
				expect(update.locations).toEqual([{ path: path.join(dir, "file.ts") }]);
				expect(update.rawInput).toEqual({ path: readPath });
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("omits read locations that are not single existing files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-read-non-file-"));
		fs.mkdirSync(path.join(dir, "docs"));
		fs.writeFileSync(path.join(dir, "file.ts"), "data\n");
		fs.writeFileSync(path.join(dir, "archive.rar"), "data\n");
		const cases = ["src/**/*.ts", "file.ts:1-20; docs", "docs", "archive.rar:inner/SKILL.md"];
		try {
			for (const readPath of cases) {
				const updates = mapAgentSessionEventToAcpSessionUpdates(
					{
						type: "tool_execution_start",
						toolCallId: `toolu_read_non_file_${readPath}`,
						toolName: "read",
						args: { path: readPath },
					} as AgentSessionEvent,
					"session-1",
					{ cwd: dir },
				);
				expectAcpNotifications(updates);
				expect("locations" in updates[0]!.update).toBe(false);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("publishes the resolved file location when a read completes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-read-result-"));
		const file = path.join(dir, "file.ts");
		fs.writeFileSync(file, "data\n");
		try {
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_end",
					toolCallId: "toolu_read_result",
					toolName: "read",
					isError: false,
					result: { content: [{ type: "text", text: "data" }], details: { resolvedPath: file } },
				} as AgentSessionEvent,
				"session-1",
				{ cwd: dir },
			);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as { locations?: { path: string }[] };
			expect(update.locations).toEqual([{ path: file }]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps a real file literally named like a selector as the read location", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-read-literal-"));
		const literalName = "report:1-20";
		fs.writeFileSync(path.join(dir, literalName), "data\n");
		try {
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId: "toolu_read_literal",
					toolName: "read",
					args: { path: literalName },
				} as AgentSessionEvent,
				"session-1",
				{ cwd: dir },
			);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as { locations?: { path: string }[] };
			expect(update.locations).toEqual([{ path: path.join(dir, literalName) }]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("does not strip selector-looking suffixes from non-read tool paths", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-write-colon",
				toolName: "write",
				args: { path: "src/report:1-20", content: "x" },
			} as AgentSessionEvent,
			"session-1",
			{ cwd: "/repo" },
		);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { locations?: { path: string }[] };
		expect(update.locations).toEqual([{ path: path.resolve("/repo", "src/report:1-20") }]);
	});
	it("emits distinct locations for move-style path arguments", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-move",
				toolName: "move",
				args: { path: "src/current.ts", oldPath: "src/old.ts", newPath: "src/new.ts" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: "src/current.ts" }, { path: "src/old.ts" }, { path: "src/new.ts" }]);
	});

	it("maps xd:// device writes to an execute call with no fabricated file location", () => {
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_xd_write",
			toolName: "write",
			args: { path: "xd://github", content: '{"op":"repo_view"}' },
			cwd: path.resolve("/repo"),
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			title: "xd://github",
			kind: "execute",
		});
		expect("locations" in update).toBe(false);
	});

	it("keeps xd:// discovery reads as read kind and plain file writes as edit", () => {
		const discovery = buildToolCallStartUpdate({
			toolCallId: "toolu_xd_read",
			toolName: "read",
			args: { path: "xd://lsp" },
		});
		expect(discovery).toMatchObject({ title: "xd://lsp", kind: "read" });
		expect("locations" in discovery).toBe(false);

		const fileWrite = buildToolCallStartUpdate({
			toolCallId: "toolu_file_write",
			toolName: "write",
			args: { path: "src/foo.ts", content: "x" },
			cwd: path.resolve("/repo"),
		});
		expect(fileWrite).toMatchObject({
			title: "write: src/foo.ts",
			kind: "edit",
			locations: [{ path: path.resolve("/repo", "src/foo.ts") }],
		});
	});

	it("names the files an edit targets instead of the bare tool name", () => {
		// Hashline buries its targets in `[path#TAG]` section headers, so a card
		// with no injected `i` intent used to read as just "edit" — and carried
		// no location until the result landed.
		const single = buildToolCallStartUpdate({
			toolCallId: "toolu_edit_one",
			toolName: "edit",
			args: { input: "[src/app.ts#4EC2]\nPUT 1.=1:\n+const a = 1;\n" },
			cwd: path.resolve("/repo"),
		});
		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update: single });
		expect(single).toMatchObject({
			title: "edit: src/app.ts",
			kind: "edit",
			locations: [{ path: path.resolve("/repo", "src/app.ts") }],
		});

		const multi = buildToolCallStartUpdate({
			toolCallId: "toolu_edit_many",
			toolName: "edit",
			args: {
				input: "[src/app.ts#4EC2]\nPUT 1.=1:\n+a\n[src/util.ts#1A2B]\nPUT 2.=2:\n+b\n",
			},
			cwd: path.resolve("/repo"),
		});
		expect(multi).toMatchObject({
			title: "edit: src/app.ts (+1 more)",
			locations: [{ path: path.resolve("/repo", "src/app.ts") }, { path: path.resolve("/repo", "src/util.ts") }],
		});
	});

	it("names the target for tools whose subject is not a path argument", () => {
		const cases: Array<{ toolName: string; args: unknown; title: string }> = [
			{
				toolName: "ast_edit",
				args: { ops: [{ pat: "a", out: "b" }], paths: ["src/app.ts", "src/util.ts"] },
				title: "ast_edit: src/app.ts (+1 more)",
			},
			{ toolName: "ast_grep", args: { pat: "foo($$$A)", path: "src" }, title: "ast_grep: foo($$$A)" },
			{
				toolName: "lsp",
				args: { action: "references", symbol: "alpha", file: "src/app.ts" },
				title: "lsp: references alpha",
			},
			{ toolName: "hub", args: { op: "send", to: "Scout" }, title: "hub: send Scout" },
			{ toolName: "todo", args: { op: "done", task: "ship it" }, title: "todo: done" },
			{ toolName: "task", args: { tasks: [{ name: "Alpha" }, { name: "Beta" }] }, title: "task: Alpha (+1 more)" },
		];
		for (const { toolName, args, title } of cases) {
			const update = buildToolCallStartUpdate({
				toolCallId: `toolu_${toolName}`,
				toolName,
				args,
				cwd: path.resolve("/repo"),
			});
			expect(update).toMatchObject({ title });
		}
	});

	it("keeps the model's own intent as the card title when it is present", () => {
		// The target only fills the gap left by an absent `i`; an intent the
		// model wrote is a better one-line summary and must still win.
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_edit_intent",
			toolName: "edit",
			args: { input: "[src/app.ts#4EC2]\nPUT 1.=1:\n+const a = 1;\n" },
			intent: "Renaming the helper",
			cwd: path.resolve("/repo"),
		});
		expect(update).toMatchObject({
			title: "Renaming the helper",
			locations: [{ path: path.resolve("/repo", "src/app.ts") }],
		});
	});

	it("rejects mutated ACP notification discriminators", () => {
		const [notification] = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-schema",
				toolName: "read",
				args: { path: "package.json" },
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpStructure(arkSessionNotification, notification);
		expectAcpStructureRejects(arkSessionNotification, {
			...notification,
			update: { ...notification!.update, sessionUpdate: "tool_call_updates" },
		});
		expectAcpStructureRejects(arkSessionNotification, { ...notification, sessionId: 42 });
	});
});
