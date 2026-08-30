import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Session members `runSubprocess` touches unconditionally as soon as
 * `createAgentSession` resolves: the session-init journal append, the child
 * session identity snapshot (`getSessionId`/`getSessionFile`), and the
 * subagent readiness-handler installation. Spread the result into a mock
 * `AgentSession` literal. When the executor grows another unconditional
 * post-creation surface, extend this helper so every executor fixture picks
 * it up in one place.
 */
export function mockSubagentSessionSurface(): {
	sessionManager: SessionManager;
	installSubagentSessionReadyHandler: () => void;
} {
	return {
		sessionManager: {
			appendSessionInit: () => {},
			getSessionId: () => "mock-session",
			getSessionFile: () => null,
		} as unknown as SessionManager,
		installSubagentSessionReadyHandler: () => {},
	};
}
