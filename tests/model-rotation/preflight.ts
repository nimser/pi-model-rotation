import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const root = mkdtempSync(join(tmpdir(), "model-rotation-preflight-"));
const workdir = join(root, "work");
mkdirSync(join(workdir, ".pi"), { recursive: true });

const stats = { limited: 0, healthy: 0 };
const server = createServer((request, response) => {
	request.resume();
	request.on("end", () => {
		if (request.url?.startsWith("/limited")) {
			stats.limited += 1;
			response.writeHead(429, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "rate limit exceeded (fake)", type: "rate_limit_error" } }));
			return;
		}
		if (request.url?.startsWith("/healthy")) {
			stats.healthy += 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "fake-preflight", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "gpt-5.6-sol" };
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "PREFLIGHT_OK" }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404).end();
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fake provider did not bind a port");

const modelDefaults = {
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
writeFileSync(join(workdir, "providers.ts"), `
export default function providers(pi) {
  const defaults = ${JSON.stringify(modelDefaults)};
  pi.registerProvider("fake-limited", {
    baseUrl: "http://127.0.0.1:${address.port}/limited/v1", apiKey: "test", api: "openai-completions",
    models: [{ id: "always-429", name: "always-429", ...defaults }],
  });
  pi.registerProvider("openai-codex", {
    baseUrl: "http://127.0.0.1:${address.port}/healthy/v1", apiKey: "test", api: "openai-completions",
    models: [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol", ...defaults }],
  });
}
`);
writeFileSync(join(workdir, ".pi", "model-rotation.json"), JSON.stringify({
	modes: { frontier: { ladder: "off", chain: [
		{ provider: "fake-limited", model: "always-429" },
		{ provider: "openai-codex", model: "gpt-5.6-sol" },
	] } },
}));
const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
const quotaPath = join(root, "quota.json");
writeFileSync(quotaPath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), entries: [{
	provider: "openai-codex",
	account: "openai-test",
	reachable: true,
	active: true,
	usedPercent: 1,
	remainingPercent: 99,
	resetsAt,
	fetchedAt: new Date().toISOString(),
	burnPercentPerHour: 0,
	windows: { primary: { usedPercent: 1, resetsAt } },
}] }));

function runPi(): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", [
			"-p", "-ne", "--provider", "fake-limited", "--model", "always-429", "--no-tools", "--no-session",
			"-e", join(REPO, "extension", "index.ts"), "-e", join(workdir, "providers.ts"),
			"Reply with the single word PREFLIGHT_OK.",
		], { cwd: workdir, env: { ...process.env, MODEL_ROTATION_QUOTA_CACHE: quotaPath }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => (output += String(chunk)));
		child.stderr.on("data", (chunk) => (output += String(chunk)));
		const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, output });
		});
	});
}

try {
	const result = await runPi();
	if (result.code !== 0 || !result.output.includes("PREFLIGHT_OK")) throw new Error(`preflight run failed (${result.code}):\n${result.output}`);
	if (stats.limited !== 0 || stats.healthy !== 1) throw new Error(`model changed after the request started: ${JSON.stringify(stats)}\n${result.output}`);
	console.log("PASS: quota preflight selects the provider before the first request");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
}
