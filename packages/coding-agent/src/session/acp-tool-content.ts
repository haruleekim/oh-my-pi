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
