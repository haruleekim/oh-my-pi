/**
 * Finalize full-file pre/post snapshots for tool-result details.
 *
 * Small snapshots stay inline for persistence and replay. Larger text snapshots
 * move to the session-bound in-memory store and leave opaque references in the
 * result, so live ACP clients can render native diffs without ballooning the
 * session JSONL. Binary, over-limit, or otherwise unavailable snapshots lose
 * both sides atomically and carry a structured fallback reason.
 */

import type { EditStore } from "@oh-my-pi/pi-natives";
import type { FileMutationSnapshotFallback, FileMutationSnapshotRef } from "./renderer";

/**
 * Upper bound on a snapshot the store will hold. A version tag is a content
 * hash of the whole file, so minting one means keeping the full text in
 * memory; past this cap the result reports a fallback reason instead. Matches
 * the native store's own file-read limit.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Combined inline `oldText` + `newText` character budget for one tool result.
 * Multi-file entries share the budget; entries beyond it use session snapshot
 * references rather than losing live diff visualization.
 */
export const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

export interface SnapshotDetails {
	path?: string;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	oldSnapshotRef?: FileMutationSnapshotRef;
	newSnapshotRef?: FileMutationSnapshotRef;
	snapshotFallback?: FileMutationSnapshotFallback;
}

function stripSnapshotPayload<T extends SnapshotDetails>(
	details: T,
): Omit<T, "oldText" | "newText" | "snapshotsPruned" | "oldSnapshotRef" | "newSnapshotRef" | "snapshotFallback"> {
	const {
		oldText: _oldText,
		newText: _newText,
		snapshotsPruned: _snapshotsPruned,
		oldSnapshotRef: _oldSnapshotRef,
		newSnapshotRef: _newSnapshotRef,
		snapshotFallback: _snapshotFallback,
		...rest
	} = details;
	return rest;
}

function snapshotRef(store: EditStore, path: string, text: string): FileMutationSnapshotRef {
	return { path, versionId: store.recordSnapshot(path, text) };
}

function finalizeSnapshotEntry<T extends SnapshotDetails>(
	details: T,
	store: EditStore,
	inlineBudget: { remaining: number },
): T {
	const oldText = details.oldText;
	const newText = details.newText;
	if (oldText === undefined && newText === undefined) return details;

	const inlineSize = (oldText?.length ?? 0) + (newText?.length ?? 0);
	const base = stripSnapshotPayload(details);
	if (inlineSize <= inlineBudget.remaining) {
		inlineBudget.remaining -= inlineSize;
		return {
			...base,
			...(oldText === undefined ? {} : { oldText }),
			...(newText === undefined ? {} : { newText }),
		} as T;
	}

	const path = details.path;
	if (!path) {
		return { ...base, snapshotsPruned: true, snapshotFallback: "unavailable" } as T;
	}
	if (
		(oldText !== undefined && Buffer.byteLength(oldText) > SNAPSHOT_MAX_BYTES) ||
		(newText !== undefined && Buffer.byteLength(newText) > SNAPSHOT_MAX_BYTES)
	) {
		return { ...base, snapshotsPruned: true, snapshotFallback: "file-limit" } as T;
	}

	return {
		...base,
		...(oldText === undefined ? {} : { oldSnapshotRef: snapshotRef(store, path, oldText) }),
		...(newText === undefined ? {} : { newSnapshotRef: snapshotRef(store, path, newText) }),
	} as T;
}

function isSnapshotDetails(value: unknown): value is SnapshotDetails {
	return typeof value === "object" && value !== null;
}

export function finalizeFileMutationSnapshots<T extends SnapshotDetails>(details: T, store: EditStore): T {
	const inlineBudget = { remaining: MAX_EDIT_SNAPSHOT_TEXT_CHARS };
	if ("perFileResults" in details) {
		const perFileResults = details.perFileResults;
		if (Array.isArray(perFileResults) && perFileResults.every(isSnapshotDetails)) {
			const base = stripSnapshotPayload(details);
			return {
				...base,
				perFileResults: perFileResults.map(entry => finalizeSnapshotEntry(entry, store, inlineBudget)),
			} as T;
		}
	}
	return finalizeSnapshotEntry(details, store, inlineBudget);
}
