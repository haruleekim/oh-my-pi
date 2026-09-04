import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type ReadToolDetails, ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatBytes } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as ToolSession;
}

describe("read :raw binary disclosure", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-raw-binary-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("warns that binary bytes are decoded lossily while preserving the requested decoded content", async () => {
		const filePath = path.join(tmpDir, "binary.dat");
		const bytes = new Uint8Array(1024);
		for (let index = 0; index < bytes.length; index++) bytes[index] = index % 2 === 0 ? 0 : 0xff;
		await Bun.write(filePath, bytes);

		const output = textOutput(
			await new ReadTool(createSession(tmpDir)).execute("binary", { path: `${filePath}:raw` }),
		);

		expect(output).toContain("Binary");
		expect(output).toContain("lossy");
		expect(output).toContain(formatBytes(bytes.byteLength));
		expect(output).toContain("xxd");
		expect(output).toContain("\0");
		expect(output).toContain("\uFFFD");
	});

	it("returns ordinary UTF-8 text byte-for-byte without a decode notice", async () => {
		const filePath = path.join(tmpDir, "plain.txt");
		const text = "plain UTF-8 text\nsecond line\n";
		await Bun.write(filePath, text);

		const output = textOutput(
			await new ReadTool(createSession(tmpDir)).execute("plain", { path: `${filePath}:raw` }),
		);

		expect(output).toBe(text);
	});

	it("does not mistake a valid UTF-8 replacement character for decoder loss", async () => {
		const filePath = path.join(tmpDir, "replacement.txt");
		const text = "This U+FFFD is intentional: \uFFFD\n";
		await Bun.write(filePath, text);

		const output = textOutput(
			await new ReadTool(createSession(tmpDir)).execute("replacement", { path: `${filePath}:raw` }),
		);

		expect(output).toBe(text);
	});
});
