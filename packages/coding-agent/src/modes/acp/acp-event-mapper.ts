import * as fs from "node:fs";
import { truncate } from "@oh-my-pi/pi-utils";
import type {
	SessionNotification,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@oh-my-pi/pi-utils/acp";
import { parseXdUrl } from "../../internal-urls/xd-protocol";
import { editTargetPaths } from "../../edit/target-paths";
import type { AdvisorNote, AdvisorSeverity } from "../../advisor";
import { isAdvisorCard } from "../../session/queued-messages";
import type { AgentSessionEvent } from "../../session/agent-session";
import { shellSourceToolCallContent } from "../../session/acp-tool-content";
import { resolveToCwd, splitPathAndSel, splitPathAndSelPreferringLiteralSync } from "../../tools/path-utils";
import type { TodoStatus } from "../../tools/todo";
import { canonicalizeMessage } from "../../utils/thinking-display";

interface MessageProgress {
	textEmitted: boolean;
	thoughtEmitted: boolean;
}

interface AcpEventMapperOptions {
	getMessageId?: (message: unknown) => string | undefined;
	getMessageProgress?: (message: unknown) => MessageProgress | undefined;
	getToolArgs?: (toolCallId: string) => unknown;
	resolveImageData?: (data: string, mimeType: string | undefined) => string;
	getFileSnapshot?: (path: string, versionId: string) => string | undefined;
	/**
	 * Content the agent published on a tool card out-of-band — today the plan
	 * Markdown attached to the `session/request_permission` that reviews
	 * `write xd://propose`. ACP `tool_call_update.content` *replaces* the
	 * card's content list, so the finalizing update has to re-send that
	 * content or the client drops it the instant the tool completes.
	 */
	getPinnedToolContent?: (toolCallId: string) => ToolCallContent[] | undefined;
	/**
	 * Session cwd. Tool call locations sent to ACP clients must be absolute
	 * (the editor host needs them to open or focus files). When provided,
	 * the mapper resolves raw `path`/`file`/etc. args against this cwd
	 * before emitting `ToolCallLocation` entries.
	 */
	cwd?: string;
}

interface ContentArrayContainer {
	content?: unknown;
}

interface DetailsContainer {
	details?: unknown;
}

interface TypedValue {
	type?: unknown;
}

interface TextLikeContent extends TypedValue {
	text?: unknown;
}

interface TerminalIdContainer {
	terminalId?: unknown;
}

interface BinaryLikeContent extends TypedValue {
	data?: unknown;
	mimeType?: unknown;
}

interface PathContainer {
	path?: unknown;
}

interface ResolvedPathContainer {
	resolvedPath?: unknown;
}

interface OldPathContainer {
	oldPath?: unknown;
}

interface NewPathContainer {
	newPath?: unknown;
}

interface CommandContainer {
	command?: unknown;
}

interface EvalCellContainer {
	cells?: unknown;
}

interface EvalCellLike {
	language?: unknown;
	title?: unknown;
	code?: unknown;
}

interface EvalSourceCell {
	language: string;
	title?: string;
	code: string;
}

interface PatternContainer {
	pattern?: unknown;
}

interface QueryContainer {
	query?: unknown;
}

/** Recorded tool arguments still carry the raw intent field on replay. */
interface IntentContainer {
	i?: unknown;
}

interface AstPatternContainer {
	pat?: unknown;
}

interface OpContainer {
	op?: unknown;
}

interface ActionContainer {
	action?: unknown;
}

interface FileContainer {
	file?: unknown;
}

interface SymbolContainer {
	symbol?: unknown;
}

interface NameContainer {
	name?: unknown;
}

interface ToContainer {
	to?: unknown;
}

interface PathsContainer {
	paths?: unknown;
}

interface TasksContainer {
	tasks?: unknown;
}

interface AgentContainer {
	agent?: unknown;
}

interface ErrorMessageContainer {
	errorMessage?: unknown;
}

interface MessageContainer {
	message?: unknown;
}

interface ResourceLinkLikeContent extends TypedValue {
	uri?: unknown;
	name?: unknown;
	title?: unknown;
	description?: unknown;
	mimeType?: unknown;
	size?: unknown;
}

interface BlobResourceLike {
	uri?: unknown;
	blob?: unknown;
	mimeType?: unknown;
}

interface TextResourceLike {
	uri?: unknown;
	text?: unknown;
	mimeType?: unknown;
}

interface EmbeddedResourceLikeContent extends TypedValue {
	resource?: unknown;
}

interface TextMessageLike {
	role?: unknown;
}

const ACP_TOOL_TITLE_MAX_CHARS = 4_000;

/**
 * Device name when the call is an `xd://` device dispatch riding the
 * read/write transport (`write xd://<tool>` executes the mounted tool,
 * `read xd://` is discovery). Returns `undefined` for plain file paths.
 */
function xdevDispatchDevice(toolName: string, args: unknown): string | undefined {
	if (toolName !== "write" && toolName !== "read") return undefined;
	const path = extractStringProperty<PathContainer>(args, "path");
	if (!path) return undefined;
	return parseXdUrl(path)?.name ?? undefined;
}

/** Whether a Hub call carries peer-to-peer coordination rather than process control. */
function isInternalHubMessageTool(toolName: string, args: unknown): boolean {
	let hubArgs = args;
	if (toolName !== "hub") {
		if (xdevDispatchDevice(toolName, args) !== "hub" || typeof args !== "object" || args === null) {
			return false;
		}
		const content = Reflect.get(args, "content");
		if (typeof content !== "string") return false;
		try {
			hubArgs = JSON.parse(content);
		} catch {
			return false;
		}
	}
	if (typeof hubArgs !== "object" || hubArgs === null) return false;
	const op = Reflect.get(hubArgs, "op");
	switch (op) {
		case "list":
		case "inbox":
			return true;
		case "send":
			return typeof Reflect.get(hubArgs, "to") === "string";
		case "wait":
			// A bare wait or an `ids` wait settles on background-job delivery,
			// whose snapshot IS the job result (hub.md) — keep those visible.
			// Only a peer-scoped wait (`from`, no jobs) is internal messaging.
			return typeof Reflect.get(hubArgs, "from") === "string" && Reflect.get(hubArgs, "ids") === undefined;
		default:
			return false;
	}
}

export function mapToolKind(toolName: string, args?: unknown): ToolKind {
	// An xd:// device write executes the mounted tool — "edit" would make ACP
	// clients render it as a file modification to a nonexistent path (and
	// auto-approve it under edit-tier policies). Reads stay "read": listing
	// devices or fetching docs is discovery.
	if (toolName === "write" && xdevDispatchDevice(toolName, args)) return "execute";
	switch (toolName) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "bash":
		case "shell":
		case "exec":
		case "eval":
			return "execute";
		case "grep":
		case "glob":
		case "ast_grep":
			return "search";
		case "web_search":
			return "fetch";
		case "todo":
			return "think";
		default:
			return "other";
	}
}

export function mapAgentSessionEventToAcpSessionUpdates(
	event: AgentSessionEvent,
	sessionId: string,
	options: AcpEventMapperOptions = {},
): SessionNotification[] {
	switch (event.type) {
		case "message_update":
			return mapAssistantMessageUpdate(event, sessionId, options);
		case "message_end":
			// An advisor card is not the assistant speaking: it is a second
			// voice that interrupted the turn. Map it to its own card instead
			// of letting the assistant-text path drop it.
			if (isAdvisorCard(event.message)) {
				return buildAdvisorCardNotifications(sessionId, event.message.details);
			}
			return mapAssistantMessageEnd(event, sessionId, options);
		case "tool_execution_start": {
			if (isInternalHubMessageTool(event.toolName, event.args)) return [];
			const update = buildToolCallStartUpdate({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
				cwd: options.cwd,
			});
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_update": {
			if (isInternalHubMessageTool(event.toolName, event.args)) return [];
			const content = mergeToolUpdateContent(
				buildToolStartContent(event.toolCallId, event.toolName, event.args, options),
				extractToolCallContent(event.partialResult, options),
			);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			if (content.length > 0) {
				update.content = content;
			}
			const locations = extractToolLocations(event.args, options.cwd, event.toolName);
			if (locations.length > 0) {
				update.locations = locations;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_end": {
			const args = getToolExecutionEndArgs(event, options);
			if (isInternalHubMessageTool(event.toolName, args)) return [];
			const diffContent = extractDiffToolCallContent(event.result, options);
			const fileMutation = isFileMutationToolName(event.toolName);
			const hasCompleteMutationDiff =
				!event.isError &&
				fileMutation &&
				diffContent.entryCount > 0 &&
				diffContent.blocks.length === diffContent.entryCount;
			const usesStructuredMutationPresentation =
				!event.isError && fileMutation && (hasCompleteMutationDiff || diffContent.fallbacks.length > 0);
			const fallbackContent =
				usesStructuredMutationPresentation && diffContent.fallbacks.length > 0
					? [textToolCallContent(formatDiffFallbacks(diffContent.fallbacks))]
					: hasCompleteMutationDiff
						? []
						: extractToolCallContent(event.result, options);
			const noticeContent = usesStructuredMutationPresentation
				? extractMutationNotices(event.result).map(textToolCallContent)
				: [];
			const resultContent = [...diffContent.blocks, ...fallbackContent, ...noticeContent];
			const content = mergeToolUpdateContent(
				buildToolStartContent(event.toolCallId, event.toolName, args, options),
				resultContent,
			);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: event.isError ? "failed" : "completed",
				rawOutput: event.result,
			};
			if (content.length > 0) {
				update.content = content;
			}
			const locations = extractToolLocationsFromResult(event.result, options.cwd);
			if (locations.length > 0) {
				update.locations = locations;
			}
			const notifications = [toSessionNotification(sessionId, update)];
			const planUpdate = mapTodoResultToPlanUpdate(event);
			if (planUpdate) {
				notifications.push(toSessionNotification(sessionId, planUpdate));
			}
			return notifications;
		}
		case "todo_reminder": {
			const entries = event.todos.map(todo => ({
				content: todo.content,
				priority: "medium" as const,
				status: mapTodoStatus(todo.status),
			}));
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries })];
		}
		case "todo_auto_clear":
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries: [] })];
		default:
			return [];
	}
}

function mapAssistantMessageUpdate(
	event: Extract<AgentSessionEvent, { type: "message_update" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}

	let sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
	let text: string;
	const progress = options.getMessageProgress?.(event.message);
	switch (event.assistantMessageEvent.type) {
		case "image_end":
			return [
				toSessionNotification(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: event.assistantMessageEvent.content,
					messageId: options.getMessageId?.(event.message),
				}),
			];
		case "text_delta":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.delta;
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		case "thinking_delta": {
			const block = event.assistantMessageEvent.partial?.content?.[event.assistantMessageEvent.contentIndex];
			if (block?.type === "thinking" && !canonicalizeMessage(block.thinking)) return [];
			sessionUpdate = "agent_thought_chunk";
			text = event.assistantMessageEvent.delta;
			if (text.length > 0 && progress) {
				progress.thoughtEmitted = true;
			}
			break;
		}
		case "done":
			if (progress?.textEmitted) {
				return [];
			}
			sessionUpdate = "agent_message_chunk";
			text = extractAssistantMessageText(event.assistantMessageEvent.message);
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		case "error":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.error.errorMessage ?? "Unknown error";
			// The surfaced error is the message's visible text: keeps the
			// message_end / agent_end fallbacks from emitting again.
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		default:
			return [];
	}
	if (text.length === 0) {
		return [];
	}

	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate,
			content: { type: "text", text },
			messageId,
		}),
	];
}

function mapAssistantMessageEnd(
	event: Extract<AgentSessionEvent, { type: "message_end" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}
	const progress = options.getMessageProgress?.(event.message);
	if (!progress || progress.textEmitted) {
		return [];
	}
	const text = extractAssistantMessageText(event.message);
	if (text.length === 0) {
		return [];
	}
	progress.textEmitted = true;
	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
			messageId,
		}),
	];
}

const ADVISOR_SEVERITIES: ReadonlySet<string> = new Set(["nit", "concern", "blocker"] satisfies AdvisorSeverity[]);

function isAdvisorSeverity(value: string | undefined): value is AdvisorSeverity {
	return value !== undefined && ADVISOR_SEVERITIES.has(value);
}

/**
 * Notes off an `advisor` custom message. Read defensively: on replay these
 * arrive as persisted JSON, so a note is only kept when it actually carries
 * text, and `severity`/`advisor` only when they carry the values the advisor
 * tool records. The implicit single advisor stamps no name — matching the TUI
 * card, an explicit `"default"` is treated as unnamed too.
 */
function extractAdvisorNotes(details: unknown): AdvisorNote[] {
	if (typeof details !== "object" || details === null) return [];
	const raw = (details as { notes?: unknown }).notes;
	if (!Array.isArray(raw)) return [];
	const notes: AdvisorNote[] = [];
	for (const entry of raw) {
		const note = extractStringProperty<AdvisorNote>(entry, "note")?.trim();
		if (!note) continue;
		const severity = extractStringProperty<AdvisorNote>(entry, "severity");
		const advisor = extractStringProperty<AdvisorNote>(entry, "advisor")?.trim();
		notes.push({
			note,
			...(isAdvisorSeverity(severity) ? { severity } : {}),
			...(advisor && advisor !== "default" ? { advisor } : {}),
		});
	}
	return notes;
}

/** Severity of a single note, or the batch size — whichever the collapsed card can act on. */
function advisorCardTitle(notes: readonly AdvisorNote[]): string {
	const first = notes[0];
	if (notes.length === 1 && first) return `Advisor · ${first.severity ?? "note"}`;
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const title = `Advisor · ${notes.length} notes`;
	return blockers > 0 ? `${title} · ${blockers} blocker${blockers === 1 ? "" : "s"}` : title;
}

/** One note as a blockquote: the client analogue of the TUI card's severity rail. */
function advisorNoteMarkdown(note: AdvisorNote): string {
	const who = note.advisor ? ` _(${note.advisor})_` : "";
	return `**${note.severity ?? "note"}**${who} — ${note.note}`
		.split("\n")
		.map(line => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * An advisor intervention as a client-visible card.
 *
 * Advisors are a second voice in the session: they interrupt the primary
 * agent mid-turn, so a client that cannot see them shows direction changes
 * with no stated cause. The agent-facing bytes are an `<advisory>` XML block
 * addressed to the model, so the card is rebuilt from the structured notes
 * instead. `_meta.advisor_notes` carries those notes verbatim for clients
 * that render advisories with their own chrome; the Markdown body is what
 * every other client falls back to.
 *
 * Emitted `completed`: the note already happened, and nothing updates the
 * card afterwards.
 */
export function buildAdvisorCardNotifications(sessionId: string, details: unknown): SessionNotification[] {
	const notes = extractAdvisorNotes(details);
	if (notes.length === 0) return [];
	return [
		toSessionNotification(sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: `advisor-${crypto.randomUUID()}`,
			title: advisorCardTitle(notes),
			kind: "think",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: notes.map(advisorNoteMarkdown).join("\n\n") } }],
			_meta: { advisor_notes: notes },
		}),
	];
}

function toSessionNotification(sessionId: string, update: SessionUpdate): SessionNotification {
	return { sessionId, update };
}

const todoStatusMap: Record<TodoStatus, "pending" | "in_progress" | "completed"> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
	abandoned: "completed",
	blocked: "pending",
};

function mapTodoStatus(status: TodoStatus): "pending" | "in_progress" | "completed" {
	return todoStatusMap[status];
}

function mapTodoResultToPlanUpdate(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
): SessionUpdate | undefined {
	if (event.toolName !== "todo" || event.isError) {
		return undefined;
	}
	const phases = extractTodoPhases(event.result);
	if (!Array.isArray(phases)) {
		return undefined;
	}
	return {
		sessionUpdate: "plan",
		entries: extractTodoEntries(phases).map(todo => ({
			content: todo.content,
			priority: "medium" as const,
			status: mapTodoStatus(todo.status),
		})),
	};
}

function extractTodoPhases(result: unknown): unknown {
	if (typeof result !== "object" || result === null || !("details" in result)) {
		return undefined;
	}
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null || !("phases" in details)) {
		return undefined;
	}
	return (details as { phases?: unknown }).phases;
}

function extractTodoEntries(phases: unknown[]): Array<{ content: string; status: TodoStatus }> {
	const entries: Array<{ content: string; status: TodoStatus }> = [];
	for (const phase of phases) {
		if (typeof phase !== "object" || phase === null || !("tasks" in phase)) {
			continue;
		}
		const tasks = (phase as { tasks?: unknown }).tasks;
		if (!Array.isArray(tasks)) {
			continue;
		}
		for (const task of tasks) {
			if (typeof task !== "object" || task === null || !("content" in task)) {
				continue;
			}
			const content = (task as { content?: unknown }).content;
			if (typeof content !== "string" || content.length === 0) {
				continue;
			}
			const status = (task as { status?: TodoStatus }).status;
			entries.push({ content, status: isTodoStatus(status) ? status : "pending" });
		}
	}
	return entries;
}

function isTodoStatus(status: unknown): status is TodoStatus {
	return (
		status === "pending" ||
		status === "in_progress" ||
		status === "completed" ||
		status === "abandoned" ||
		status === "blocked"
	);
}
export function buildToolCallStartUpdate(input: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	cwd?: string;
	status?: "pending" | "completed";
}): SessionUpdate {
	const update: ToolCall & { sessionUpdate: "tool_call" } = {
		sessionUpdate: "tool_call",
		toolCallId: input.toolCallId,
		title: buildToolTitle(input.toolName, input.args, input.intent),
		kind: mapToolKind(input.toolName, input.args),
		status: input.status ?? "pending",
		rawInput: input.args,
	};
	const content = buildToolStartContent(input.toolCallId, input.toolName, input.args);
	if (content.length > 0) {
		update.content = content;
	}
	const locations = extractToolLocations(input.args, input.cwd, input.toolName);
	if (locations.length > 0) {
		update.locations = locations;
	}
	return update;
}

export function normalizeReplayToolArguments(value: unknown): { args: unknown } {
	if (typeof value !== "string") {
		return { args: value ?? {} };
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return { args: parsed };
	} catch {
		return { args: value };
	}
}

function getToolExecutionEndArgs(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	options: AcpEventMapperOptions,
): unknown {
	if ("args" in event) {
		return (event as { args?: unknown }).args;
	}
	return options.getToolArgs?.(event.toolCallId);
}

/**
 * Card content that must survive every later `tool_call_update` for this tool
 * call. `options` is omitted on the `tool_call` start path: a pin is created
 * while the tool runs (e.g. plan permission), so there is nothing to restore
 * yet when the card is first announced.
 */
function buildToolStartContent(
	toolCallId: string,
	toolName: string,
	args: unknown,
	options?: AcpEventMapperOptions,
): ToolCallContent[] {
	const startContent = isCommandToolName(toolName)
		? buildCommandStartContent(toolCallId, args)
		: toolName === "eval"
			? buildEvalStartContent(toolCallId, args)
			: [];
	const pinned = options?.getPinnedToolContent?.(toolCallId);
	return pinned && pinned.length > 0 ? [...pinned, ...startContent] : startContent;
}

/** Shell metacharacters and quoting end the label: past them a token is data, not a name. */
const COMMAND_LABEL_STOP = /["'`$(){}[\]|&;<>]|^--?$/;
const COMMAND_LABEL_MAX_TOKENS = 3;
const COMMAND_LABEL_MAX_TOKEN_CHARS = 24;
/** Cap for the no-recognizable-head fallback: the full command is in the source block. */
const COMMAND_LABEL_FALLBACK_MAX_CHARS = 64;

/**
 * Name a shell call by its invocation head — `bun -e`, `npm test`,
 * `git commit` — instead of pasting the whole command into the card title.
 *
 * The client already renders the full command as syntax-highlighted source
 * right below the title, so repeating it there wastes the one line a card has
 * for saying *what* ran. Leading `VAR=value` assignments are skipped (they
 * describe the environment, not the program), and the label stops at the first
 * quoted or metacharacter-bearing token, which is where arguments begin.
 */
function summarizeCommandLabel(command: string): string | undefined {
	const tokens = command.trim().split(/\s+/);
	const label: string[] = [];
	for (const token of tokens) {
		if (label.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		if (COMMAND_LABEL_STOP.test(token) || token.length > COMMAND_LABEL_MAX_TOKEN_CHARS) break;
		label.push(token);
		if (label.length === COMMAND_LABEL_MAX_TOKENS) break;
	}
	// A flag right after the program names the mode (`bun -e`, `sed -n`) and
	// stays; one trailing a subcommand is a cut-off option whose value we just
	// dropped (`git commit -m`, `cargo test -p`), so it reads better without it.
	if (label.length === COMMAND_LABEL_MAX_TOKENS && label[label.length - 1]?.startsWith("-")) label.pop();
	if (label.length > 0) return label.join(" ");
	// No recognizable head (a one-liner that opens with a quote or a subshell,
	// or one giant token): name it with a short prefix rather than a wall of
	// text, since the untruncated command rides along as source.
	const trimmed = command.trim();
	return trimmed ? truncate(trimmed, COMMAND_LABEL_FALLBACK_MAX_CHARS) : undefined;
}

function buildCommandTitle(args: unknown): string | undefined {
	const command = extractStringProperty<CommandContainer>(args, "command");
	return command ? summarizeCommandLabel(command) : undefined;
}

function buildCommandStartContent(toolCallId: string, args: unknown): ToolCallContent[] {
	const command = extractStringProperty<CommandContainer>(args, "command");
	return command ? [shellSourceToolCallContent(toolCallId, command)] : [];
}

function extractEvalCells(args: unknown): EvalSourceCell[] {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return [];
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const candidates = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	const cells: EvalSourceCell[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
			continue;
		}
		const code = extractStringProperty<EvalCellLike>(candidate, "code");
		if (!code) {
			continue;
		}
		const language = extractStringProperty<EvalCellLike>(candidate, "language") ?? "?";
		const title = extractStringProperty<EvalCellLike>(candidate, "title");
		cells.push(title ? { language, title, code } : { language, code });
	}
	return cells;
}

/**
 * Name an eval call by the labels its cells carry.
 *
 * The language is deliberately absent: it already rides along on every source
 * resource as a mime type, which lets a client name the runtime in the card's
 * own chrome (a Python glyph beats a `[py]` prefix eating the title line).
 * Untitled cells contribute nothing rather than a bare language tag, so the
 * title falls through to the next candidate.
 */
function buildEvalTitle(args: unknown): string | undefined {
	const labels = extractEvalCells(args)
		.map(cell => cell.title?.trim())
		.filter((label): label is string => label !== undefined && label.length > 0);
	return labels.length > 0 ? labels.join(" · ") : undefined;
}

function buildEvalStartContent(toolCallId: string, args: unknown): ToolCallContent[] {
	return extractEvalCells(args).map((cell, index) => {
		const { mimeType, extension } = evalResourceMetadata(cell.language);
		return {
			type: "content",
			content: {
				type: "resource",
				resource: {
					uri: `omp-eval://tool/${encodeURIComponent(toolCallId)}/cell-${index}.${extension}`,
					text: cell.code,
					mimeType,
				},
			},
		};
	});
}

function evalResourceMetadata(language: string): { mimeType: string; extension: string } {
	switch (language) {
		case "py":
			return { mimeType: "text/x-python", extension: "py" };
		case "js":
			return { mimeType: "text/javascript", extension: "js" };
		case "rb":
			return { mimeType: "text/x-ruby", extension: "rb" };
		case "jl":
			return { mimeType: "text/x-julia", extension: "jl" };
		default:
			return { mimeType: "text/plain", extension: "txt" };
	}
}

function mergeToolUpdateContent(startContent: ToolCallContent[], resultContent: ToolCallContent[]): ToolCallContent[] {
	if (startContent.length === 0) {
		return resultContent;
	}
	const merged = [...startContent];
	for (const item of resultContent) {
		if (
			item.type === "content" &&
			item.content.type === "text" &&
			hasEquivalentTextContent(merged, item.content.text)
		) {
			continue;
		}
		merged.push(item);
	}
	return merged;
}

function isCommandToolName(toolName: string): boolean {
	return toolName === "bash" || toolName === "shell" || toolName === "exec";
}

function isFileMutationToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "write";
}

/** `"a.ts"` → `a.ts`; `["a.ts","b.ts"]` → `a.ts (+1 more)`. */
function formatSubjectList(values: readonly string[]): string | undefined {
	const [first, ...rest] = values;
	if (!first) return undefined;
	return rest.length > 0 ? `${first} (+${rest.length} more)` : first;
}

function extractStringList(args: unknown, key: "paths"): string[] {
	if (typeof args !== "object" || args === null) return [];
	const value = (args as PathsContainer)[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function extractTaskNames(args: unknown): string[] {
	if (typeof args !== "object" || args === null) return [];
	const tasks = (args as TasksContainer).tasks;
	if (!Array.isArray(tasks)) return [];
	const names: string[] = [];
	for (const task of tasks) {
		const name =
			extractStringProperty<NameContainer>(task, "name") ?? extractStringProperty<AgentContainer>(task, "agent");
		if (name) names.push(name);
	}
	return names;
}

/**
 * The thing a tool call acts on, for tools whose target is not a plain `path`
 * argument. Without this a card reads as the bare tool name (`edit`, `hub`,
 * `lsp`) and the operator cannot tell which file or operation it was — the
 * fallback matters because `i` intent injection is optional and off in plenty
 * of sessions.
 */
function buildToolSubject(toolName: string, args: unknown): string | undefined {
	switch (toolName) {
		case "edit":
			// Hashline/apply_patch/sloppy bury their targets in the payload.
			return formatSubjectList(editTargetPaths(args));
		case "ast_edit":
			return formatSubjectList(extractStringList(args, "paths"));
		case "ast_grep":
			return extractStringProperty<AstPatternContainer>(args, "pat");
		case "lsp": {
			const action = extractStringProperty<ActionContainer>(args, "action");
			const target =
				extractStringProperty<SymbolContainer>(args, "symbol") ??
				extractStringProperty<FileContainer>(args, "file") ??
				extractStringProperty<QueryContainer>(args, "query");
			if (!action) return target;
			return target ? `${action} ${target}` : action;
		}
		case "hub": {
			const op = extractStringProperty<OpContainer>(args, "op");
			const target =
				extractStringProperty<ToContainer>(args, "to") ?? extractStringProperty<NameContainer>(args, "name");
			if (!op) return target;
			return target ? `${op} ${target}` : op;
		}
		case "todo":
			return extractStringProperty<OpContainer>(args, "op");
		case "task":
			return formatSubjectList(extractTaskNames(args));
		default:
			return undefined;
	}
}

function buildToolTitle(toolName: string, args: unknown, intent: string | undefined): string {
	// `eval` cells carry hand-written labels ("imports", "load config") that
	// name the step more precisely than a generic intent phrase, so they stay
	// ahead of `i`.
	let title = toolName === "eval" ? buildEvalTitle(args) : undefined;
	// Otherwise the model's own `i` is the best one-line name a card can carry:
	// intent tracing is on by default and the system prompt shapes it into a
	// short present-participle phrase. Pasting the command over it wasted the
	// line on source the client already renders below.
	//
	// Live events carry it as `event.intent` (the harness strips `i` from args
	// before execution). Replayed tool calls are rebuilt from the persisted
	// assistant message, whose recorded `arguments` still hold the raw `i`, so
	// reading it there keeps a reopened session's titles identical to the live
	// ones instead of dropping to the derived label.
	title ??= intent?.trim() || extractStringProperty<IntentContainer>(args, "i")?.trim() || undefined;
	// Derived label only fills in when `i` is absent (tracing off, or a model
	// that skipped it).
	if (!title && isCommandToolName(toolName)) {
		title = buildCommandTitle(args);
	}

	if (!title) {
		const subject =
			buildToolSubject(toolName, args) ??
			extractStringProperty<PathContainer>(args, "path") ??
			extractStringProperty<CommandContainer>(args, "command") ??
			extractStringProperty<PatternContainer>(args, "pattern") ??
			extractStringProperty<QueryContainer>(args, "query");
		if (subject) {
			// Internal URLs (xd://github, skill://react, …) name their target fully;
			// prefixing the transport tool reads as a file write to a fake path.
			title = INTERNAL_URL_SUBJECT.test(subject) ? subject : `${toolName}: ${subject}`;
		}
	}

	return truncate(title ?? toolName, ACP_TOOL_TITLE_MAX_CHARS);
}

/**
 * Resolve a single raw path against cwd for an ACP location. When `cwd` is
 * omitted we pass the value through unchanged (callers without session
 * context, e.g. some legacy entry points and tests); the ACP-side caller
 * always supplies cwd so notifications carry absolute paths.
 */
function toAcpLocationPath(value: string, cwd?: string): string {
	if (!cwd) return value;
	try {
		return resolveToCwd(value, cwd);
	} catch {
		return value;
	}
}

/**
 * Scheme-qualified subjects (`xd://`, `skill://`, `agent://`, `https://`, …)
 * are not local files: resolving them against cwd fabricates paths like
 * `/repo/xd:/github` and makes editors focus nonexistent files.
 */
const INTERNAL_URL_SUBJECT = /^[a-z][a-z0-9+.-]*:\/\//i;

function existingFileLocationPath(raw: string | undefined, cwd?: string): string | undefined {
	if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return undefined;
	const resolved = toAcpLocationPath(raw, cwd);
	try {
		return fs.statSync(resolved).isFile() ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Return the single existing file represented by a `read` argument.
 *
 * ACP locations are editor navigation targets, not tool inputs. Read inputs may
 * name selectors, delimited paths, globs, directories, archive members, or
 * internal resources, so only a path that resolves to a regular file is safe
 * to publish. Literal selector-shaped filenames retain read-tool precedence.
 */
function readLocationBasePath(
	raw: string | undefined,
	cwd: string | undefined,
	toolName: string | undefined,
): string | undefined {
	if (raw === undefined || toolName !== "read") return raw;
	if (!cwd || INTERNAL_URL_SUBJECT.test(raw)) return undefined;

	const candidate = splitPathAndSelPreferringLiteralSync(raw, cwd).path;
	return existingFileLocationPath(candidate, cwd);
}

function extractToolLocations(args: unknown, cwd?: string, toolName?: string): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const seen = new Set<string>();
	const pushPath = (raw: string | undefined) => {
		if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return;
		const path = toAcpLocationPath(raw, cwd);
		if (seen.has(path)) return;
		seen.add(path);
		locations.push({ path });
	};

	pushPath(readLocationBasePath(extractStringProperty<PathContainer>(args, "path"), cwd, toolName));
	pushPath(extractStringProperty<OldPathContainer>(args, "oldPath"));
	pushPath(extractStringProperty<NewPathContainer>(args, "newPath"));
	// `edit`/`ast_edit` name their targets inside the payload, so without this
	// the card carries no location until the result lands and the editor cannot
	// open the file being changed while it streams.
	if (toolName === "edit") {
		for (const path of editTargetPaths(args)) pushPath(path);
	} else if (toolName === "ast_edit") {
		for (const path of extractStringList(args, "paths")) pushPath(path);
	}

	return locations;
}

/** Pull locations from a tool result's details (e.g. EditToolDetails.perFileResults[].path). */
function extractToolLocationsFromResult(result: unknown, cwd?: string): ToolCallLocation[] {
	if (typeof result !== "object" || result === null) return [];
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return [];
	const direct = extractToolLocations(details, cwd);
	const resolvedFile = existingFileLocationPath(
		extractStringProperty<ResolvedPathContainer>(details, "resolvedPath"),
		cwd,
	);
	if (resolvedFile && !direct.some(location => location.path === resolvedFile)) {
		direct.push({ path: resolvedFile });
	}
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	if (!Array.isArray(perFile)) {
		return direct;
	}
	const seen = new Set(direct.map(loc => loc.path));
	const locations = [...direct];
	for (const entry of perFile) {
		const raw = extractStringProperty<PathContainer>(entry, "path");
		if (!raw) continue;
		const path = toAcpLocationPath(raw, cwd);
		if (seen.has(path)) continue;
		seen.add(path);
		locations.push({ path });
	}
	return locations;
}

function extractMutationNotices(result: unknown): string[] {
	if (typeof result !== "object" || result === null || !("details" in result)) return [];
	const details = result.details;
	if (typeof details !== "object" || details === null || !("notices" in details)) return [];
	const notices = details.notices;
	return Array.isArray(notices)
		? notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0)
		: [];
}
interface DiffFallback {
	path: string;
	reason: string;
}

function extractDiffFallback(entry: unknown): DiffFallback | undefined {
	if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string") {
		return undefined;
	}
	const explicit = "snapshotFallback" in entry ? entry.snapshotFallback : undefined;
	if (typeof explicit === "string") return { path: entry.path, reason: explicit };
	if ("oldSnapshotRef" in entry || "newSnapshotRef" in entry) {
		return { path: entry.path, reason: "evicted" };
	}
	if ("snapshotsPruned" in entry && entry.snapshotsPruned === true) {
		return { path: entry.path, reason: "unavailable" };
	}
	if ("isError" in entry && entry.isError === true) {
		return { path: entry.path, reason: "edit-error" };
	}
	return undefined;
}

function formatDiffFallbacks(fallbacks: readonly DiffFallback[]): string {
	return `Diff preview unavailable:\n${fallbacks.map(item => `- ${item.path}: ${item.reason}`).join("\n")}`;
}

/** Emit `diff` ToolCallContent plus coverage and fallback metadata. */
function extractDiffToolCallContent(
	result: unknown,
	options: AcpEventMapperOptions,
): { blocks: ToolCallContent[]; entryCount: number; fallbacks: DiffFallback[] } {
	if (typeof result !== "object" || result === null || !("details" in result)) {
		return { blocks: [], entryCount: 0, fallbacks: [] };
	}
	const details = result.details;
	if (typeof details !== "object" || details === null) {
		return { blocks: [], entryCount: 0, fallbacks: [] };
	}
	const blocks: ToolCallContent[] = [];
	const fallbacks: DiffFallback[] = [];
	const perFile = "perFileResults" in details ? details.perFileResults : undefined;
	const entries: unknown[] = Array.isArray(perFile) ? perFile : [details];
	for (const entry of entries) {
		const block = buildDiffContent(entry, options);
		if (block) {
			blocks.push(block);
		} else {
			const fallback = extractDiffFallback(entry);
			if (fallback) fallbacks.push(fallback);
		}
	}
	return { blocks, entryCount: entries.length, fallbacks };
}

function resolveDiffSide(
	inlineText: unknown,
	ref: unknown,
	options: AcpEventMapperOptions,
): { present: false } | { present: true; text: string } | { present: true; unavailable: true } {
	if (typeof inlineText === "string") return { present: true, text: inlineText };
	if (ref === undefined) return { present: false };
	if (typeof ref !== "object" || ref === null || !("path" in ref) || !("versionId" in ref)) {
		return { present: true, unavailable: true };
	}
	const path = ref.path;
	const versionId = ref.versionId;
	if (typeof path !== "string" || typeof versionId !== "string") {
		return { present: true, unavailable: true };
	}
	const text = options.getFileSnapshot?.(path, versionId);
	return text === undefined ? { present: true, unavailable: true } : { present: true, text };
}

function buildDiffContent(entry: unknown, options: AcpEventMapperOptions): ToolCallContent | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const isError = "isError" in entry ? entry.isError : undefined;
	if (isError === true) return undefined;
	const pathValue = "path" in entry ? entry.path : undefined;
	const path = typeof pathValue === "string" && pathValue.length > 0 ? pathValue : undefined;
	if (!path) return undefined;
	const oldSide = resolveDiffSide(
		"oldText" in entry ? entry.oldText : undefined,
		"oldSnapshotRef" in entry ? entry.oldSnapshotRef : undefined,
		options,
	);
	const newSide = resolveDiffSide(
		"newText" in entry ? entry.newText : undefined,
		"newSnapshotRef" in entry ? entry.newSnapshotRef : undefined,
		options,
	);
	if (
		(oldSide.present && "unavailable" in oldSide) ||
		(newSide.present && "unavailable" in newSide) ||
		(!oldSide.present && !newSide.present)
	) {
		return undefined;
	}
	return {
		type: "diff",
		path,
		oldText: oldSide.present ? oldSide.text : null,
		newText: newSide.present ? newSide.text : "",
	};
}

function extractTerminalId(value: unknown): string | undefined {
	const direct = extractStringProperty<TerminalIdContainer>(value, "terminalId");
	if (direct) return direct;
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	return extractStringProperty<TerminalIdContainer>(details, "terminalId");
}

function terminalToolCallContent(terminalId: string): ToolCallContent {
	return { type: "terminal", terminalId };
}

function extractToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent[] {
	const richContent = extractStructuredToolCallContent(value, options);
	const detailsImageContent = extractDetailsImageToolCallContent(value, options, richContent);
	const combinedContent = [...richContent, ...detailsImageContent];
	const terminalId = extractTerminalId(value);
	const content =
		terminalId && !hasTerminalContent(combinedContent, terminalId)
			? [...combinedContent, terminalToolCallContent(terminalId)]
			: combinedContent;
	const fallbackText = extractReadableText(value);
	if (!fallbackText) {
		return content;
	}
	if (hasEquivalentTextContent(content, fallbackText)) {
		return content;
	}
	return [...content, textToolCallContent(fallbackText)];
}

function extractStructuredToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent[] {
	const blocks = getContentBlocks(value);
	if (!blocks) {
		return [];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const toolCallContent = toToolCallContent(block, options);
		if (toolCallContent) {
			content.push(toolCallContent);
		}
	}
	return content;
}

function getContentBlocks(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return undefined;
	}
	const content = (value as ContentArrayContainer).content;
	return Array.isArray(content) ? content : undefined;
}

function toToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent | undefined {
	const type = getContentType(value);
	if (!type) {
		return undefined;
	}

	switch (type) {
		case "text": {
			const text = extractStringProperty<TextLikeContent>(value, "text");
			return text ? textToolCallContent(text) : undefined;
		}
		case "image":
		case "audio":
			return binaryToolCallContent(type, value, options);
		case "resource_link": {
			const uri = extractStringProperty<ResourceLinkLikeContent>(value, "uri");
			const name = extractStringProperty<ResourceLinkLikeContent>(value, "name");
			if (!uri || !name) {
				return undefined;
			}
			const resourceLinkContent: {
				type: "resource_link";
				uri: string;
				name: string;
				title?: string;
				description?: string;
				mimeType?: string;
				size?: number;
			} = {
				type: "resource_link",
				uri,
				name,
			};
			const title = extractStringProperty<ResourceLinkLikeContent>(value, "title");
			if (title) {
				resourceLinkContent.title = title;
			}
			const description = extractStringProperty<ResourceLinkLikeContent>(value, "description");
			if (description) {
				resourceLinkContent.description = description;
			}
			const mimeType = extractStringProperty<ResourceLinkLikeContent>(value, "mimeType");
			if (mimeType) {
				resourceLinkContent.mimeType = mimeType;
			}
			const size = extractNumberProperty<ResourceLinkLikeContent>(value, "size");
			if (size !== undefined) {
				resourceLinkContent.size = size;
			}
			return {
				type: "content",
				content: resourceLinkContent,
			};
		}
		case "resource": {
			const resource = extractEmbeddedResource(value);
			return resource
				? {
						type: "content",
						content: {
							type: "resource",
							resource,
						},
					}
				: undefined;
		}
		default:
			return undefined;
	}
}

function binaryToolCallContent(
	type: "image" | "audio",
	value: unknown,
	options: AcpEventMapperOptions,
): ToolCallContent | undefined {
	const data = extractStringProperty<BinaryLikeContent>(value, "data");
	const mimeType = extractStringProperty<BinaryLikeContent>(value, "mimeType");
	if (!data || !mimeType) {
		return undefined;
	}
	return {
		type: "content",
		content: {
			type,
			data: type === "image" ? (options.resolveImageData?.(data, mimeType) ?? data) : data,
			mimeType,
		},
	};
}

function extractDetailsImageToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	existing: ToolCallContent[],
): ToolCallContent[] {
	const images = extractDetailsImages(value);
	if (!images) {
		return [];
	}
	const seen = new Set(existing.map(imageContentKey).filter((key): key is string => key !== undefined));
	const content: ToolCallContent[] = [];
	for (const image of images) {
		const toolCallContent = binaryToolCallContent("image", image, options);
		const key = imageContentKey(toolCallContent);
		if (!toolCallContent || !key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		content.push(toolCallContent);
	}
	return content;
}

function extractDetailsImages(value: unknown): unknown[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	if (typeof details !== "object" || details === null) return undefined;
	const images = (details as { images?: unknown }).images;
	return Array.isArray(images) && images.length > 0 ? images : undefined;
}

function imageContentKey(value: ToolCallContent | undefined): string | undefined {
	if (value?.type !== "content" || value.content.type !== "image") {
		return undefined;
	}
	return `${value.content.mimeType}\u0000${value.content.data}`;
}

function extractEmbeddedResource(
	value: unknown,
): { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } | undefined {
	if (typeof value !== "object" || value === null || !("resource" in value)) {
		return undefined;
	}

	const resource = (value as EmbeddedResourceLikeContent).resource;
	if (typeof resource !== "object" || resource === null) {
		return undefined;
	}

	const uri = extractStringProperty<TextResourceLike>(resource, "uri");
	if (!uri) {
		return undefined;
	}

	const text = extractStringProperty<TextResourceLike>(resource, "text");
	if (text) {
		const mimeType = extractStringProperty<TextResourceLike>(resource, "mimeType");
		return mimeType ? { uri, text, mimeType } : { uri, text };
	}

	const blob = extractStringProperty<BlobResourceLike>(resource, "blob");
	if (!blob) {
		return undefined;
	}
	const mimeType = extractStringProperty<BlobResourceLike>(resource, "mimeType");
	return mimeType ? { uri, blob, mimeType } : { uri, blob };
}

function textToolCallContent(text: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "text",
			text,
		},
	};
}

function hasEquivalentTextContent(content: ToolCallContent[], text: string): boolean {
	return content.some(item => item.type === "content" && item.content.type === "text" && item.content.text === text);
}

function hasTerminalContent(content: ToolCallContent[], terminalId: string): boolean {
	return content.some(item => item.type === "terminal" && item.terminalId === terminalId);
}

function extractReadableText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return normalizeText(value);
	}
	if (value instanceof Error) {
		return normalizeText(value.message);
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const directText =
		extractStringProperty<TextLikeContent>(value, "text") ??
		extractStringProperty<ErrorMessageContainer>(value, "errorMessage") ??
		extractStringProperty<MessageContainer>(value, "message");
	if (directText) {
		return normalizeText(directText);
	}

	const contentBlocks = getContentBlocks(value);
	if (contentBlocks) {
		const text = contentBlocks
			.map(block => extractStringProperty<TextLikeContent>(block, "text"))
			.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
			.join("\n");
		if (text.length > 0) {
			return normalizeText(text);
		}
		// A structured result envelope (`{ content: [...] }`) whose blocks carry no
		// plain text has nothing readable to surface, and its data already rides the
		// ACP frame as `rawOutput`. Serializing the whole envelope to JSON would just
		// render a raw blob as the tool row (e.g. hub wait progress, issue #9511), so
		// stop here instead of falling through to the JSON fallback.
		return undefined;
	}
	if (extractDetailsImages(value)) {
		return undefined;
	}
	if (isTerminalOnlyDetails(value)) {
		return undefined;
	}
	const serialized = safeJsonStringify(value);
	return normalizeText(serialized);
}

function isTerminalOnlyDetails(value: unknown): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	if (extractTerminalId(value) === undefined) {
		return false;
	}
	const content = (value as ContentArrayContainer).content;
	return content === undefined || (Array.isArray(content) && content.length === 0);
}

export function extractAssistantMessageText(value: unknown): string {
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return "";
	}
	const content = (value as ContentArrayContainer).content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map(block => extractStringProperty<TextLikeContent>(block, "text"))
		.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
		.join("\n");
}

function getContentType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return undefined;
	}
	const type = (value as TypedValue).type;
	return typeof type === "string" ? type : undefined;
}

function extractStringProperty<T extends object>(value: unknown, key: keyof T): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

function extractNumberProperty<T extends object>(value: unknown, key: keyof T): number | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function isAssistantMessage(value: unknown): boolean {
	return (
		typeof value === "object" && value !== null && "role" in value && (value as TextMessageLike).role === "assistant"
	);
}

function normalizeText(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}
