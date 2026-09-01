import { prompt } from "@oh-my-pi/pi-utils";
import type { DaemonSnapshot } from "../launch/protocol";
import launchCompletionTemplate from "../prompts/session/launch-completion.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/** Yield-queue kind for broker-owned supervised process completions. */
export const LAUNCH_COMPLETION_MESSAGE_TYPE = "launch-completion";

/** One supervised-process completion awaiting injection into its owning session. */
export interface LaunchCompletionEntry {
	owner: string;
	daemon: DaemonSnapshot;
	outcome: "completed" | "stopped";
}

export interface LaunchCompletionDetails {
	daemons: DaemonSnapshot[];
	outcomes?: Record<string, "completed" | "stopped">;
}

/** Whether a broker completion belongs to the primary session or its advisor. */
export function isLaunchCompletionOwner(owner: string, sessionId: string): boolean {
	return owner === sessionId || owner === `${sessionId}-advisor`;
}

/** Build one model-visible notification per terminal supervised process exit. */
export function buildLaunchCompletionBatchMessage(
	entries: LaunchCompletionEntry[],
): CustomMessage<LaunchCompletionDetails> {
	return {
		role: "custom",
		customType: LAUNCH_COMPLETION_MESSAGE_TYPE,
		content: entries
			.map(({ daemon, outcome }) =>
				prompt.render(launchCompletionTemplate, {
					name: daemon.name,
					state: daemon.state,
					stopped: outcome === "stopped",
					exitCode: daemon.exitCode,
					hasExitCode: daemon.exitCode !== undefined,
				}),
			)
			.join("\n"),
		display: true,
		attribution: "agent",
		details: {
			daemons: entries.map(entry => entry.daemon),
			outcomes: Object.fromEntries(entries.map(entry => [entry.daemon.id, entry.outcome])),
		},
		timestamp: Date.now(),
	};
}
