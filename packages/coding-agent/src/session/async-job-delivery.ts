/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id.
 * Active runs enqueue formatted entries on the yield queue; hosts that defer
 * agent-initiated turns persist idle completions as context for the next
 * client-owned turn. Owner routing prevents one session's completion from
 * entering another session.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { StructuredSubagentOutput } from "../task/types";
import type { CustomMessage } from "./messages";
import { truncateMiddle } from "./streaming-output";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

export type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	status?: AsyncJob["status"];
	startedAt?: number;
	durationMs?: number;
	/** Full structured payload (source/mode/status/data/error), when the job used an output schema. */
	schema?: StructuredSubagentOutput;
	resultPreview?: string;
	details?: Record<string, unknown>;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

/**
 * Compact, size-capped JSON block for the delivery text, used only for
 * schema-invalid/error results (valid results point to `agent://<jobId>`
 * instead, since the sidecar's `<output>` block already carries the full
 * JSON — no need to duplicate it here).
 */
export function renderStructuredJson(structured: StructuredSubagentOutput): string | undefined {
	if (!Object.hasOwn(structured, "data")) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(structured.data, null, 2) ?? "null";
	} catch {
		return undefined;
	}
	return truncateMiddle(serialized, { maxBytes: ASYNC_PREVIEW_MAX_CHARS }).content;
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		const structured = entry.job?.structured;
		const hasStructuredData = structured ? Object.hasOwn(structured, "data") : false;
		const structuredJson = structured && structured.status !== "valid" ? renderStructuredJson(structured) : undefined;
		return {
			jobId: entry.jobId,
			// The job manager disambiguates a requested job id when it collides
			// with another live job (e.g. a task job reusing a vibe turn's job
			// id), suffixing `jobId` — but the task's artifacts are still
			// written under its own agent id (`AsyncJob.agentId`). Build the
			// advertised `agent://` URL from that, or the delivery would point
			// at an id with no backing `<id>.md`/`.json` on disk.
			agentUrlId: entry.job?.agentId ?? entry.jobId,
			result: entry.result,
			type: entry.job?.type,
			label: entry.job?.label,
			status: entry.job?.status,
			startedAt: entry.job?.startTime,
			durationMs: entry.durationMs,
			resultPreview: entry.result.slice(0, ASYNC_PREVIEW_MAX_CHARS),
			details: entry.job?.latestDetails,
			cancelled: entry.job?.status === "cancelled",
			structured,
			structuredJson,
			hasStructuredData,
			schemaStatus: structured?.status,
			schemaError: structured?.error,
			schemaValid: structured?.status === "valid",
		};
	});
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			status: job.status,
			startedAt: job.startedAt,
			durationMs: job.durationMs,
			...(job.structured ? { schema: job.structured } : {}),
			resultPreview: job.resultPreview,
			details: job.details,
		})),
	};
	const text = prompt.render(asyncResultTemplate, {
		multiple: jobs.length > 1,
		jobs,
	});
	const images = entries.flatMap(entry => entry.job?.latestDetails?.images ?? []);
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
