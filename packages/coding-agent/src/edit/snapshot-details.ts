/**
 * Bound the size of the `oldText` / `newText` snapshots that file-mutation
 * tool results carry in `details`. These fields hold the full pre/post file
 * content; for large files they balloon the per-turn JSONL line and the
 * session file (300 KB+ each on the cases reported in #3786) without paying
 * for any LLM context (provider serializers send only `content`, never
 * `details`).
 *
 * The ACP event mapper consumes the raw snapshots to build `diff`
 * ToolCallContent for ACP clients. When snapshots are pruned, text content
 * still flows and diff visualization degrades gracefully.
 *
 * The edit tool's own snapshots are pruned by the native engine, which also
 * caps a multi-file batch against a shared budget; what remains here is for
 * the TypeScript-side writers (`write`) that build a details payload
 * themselves.
 */

/**
 * Combined `oldText` + `newText` character budget for a single file-mutation
 * result.
 *
 * Picked so typical code-file writes keep ACP diff visualization while
 * pathological cases (large generated files, full-file rewrites) drop the raw
 * snapshots before they hit the session JSONL.
 */
export const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

export interface SnapshotDetails {
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
}

export function pruneOversizedSnapshot<T extends SnapshotDetails>(details: T): T {
	if ((details.oldText?.length ?? 0) + (details.newText?.length ?? 0) <= MAX_EDIT_SNAPSHOT_TEXT_CHARS) {
		return details;
	}
	const { oldText: _old, newText: _new, ...rest } = details;
	return { ...rest, snapshotsPruned: true } as T;
}
