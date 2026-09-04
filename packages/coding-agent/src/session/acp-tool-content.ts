import type { ToolCallContent } from "@oh-my-pi/pi-utils/acp";

export function shellSourceToolCallContent(toolCallId: string, command: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "resource",
			resource: {
				uri: `omp-shell://tool/${encodeURIComponent(toolCallId)}/command.sh`,
				text: command,
				mimeType: "text/x-shellscript",
			},
		},
	};
}

/**
 * Console output as a verbatim, preformatted resource.
 *
 * A client renders a bare text block as Markdown, which eats the punctuation
 * build logs and REPL output are made of: `*` becomes emphasis, `#` a heading,
 * `|` a table, and a proportional font destroys column alignment. `text/plain`
 * makes the client fence the bytes instead, so what ran is shown as it was
 * printed.
 */
export function consoleOutputToolCallContent(toolCallId: string, index: number, text: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "resource",
			resource: {
				uri: `omp-output://tool/${encodeURIComponent(toolCallId)}/output-${index}.txt`,
				text,
				mimeType: "text/plain",
			},
		},
	};
}

export function planMarkdownToolCallContent(toolCallId: string, planContent: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "resource",
			resource: {
				uri: `omp-plan://tool/${encodeURIComponent(toolCallId)}/plan.md`,
				text: planContent,
				mimeType: "text/markdown",
			},
		},
	};
}
