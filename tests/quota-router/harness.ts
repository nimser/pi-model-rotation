import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelRotation from "../../extension/index.ts";
import { chooseRoute, type QuotaEntry } from "../../src/quota.ts";

const REPO = join(import.meta.dirname, "..", "..");
const requested = process.argv.slice(2).map((arg) => arg.replace(/^--/, ""));

function hashTree(root: string): string {
	const hash = createHash("sha256");
	for (const name of readdirSync(root).sort()) hash.update(name).update(readFileSync(join(root, name)));
	return hash.digest("hex");
}

function runQuota(env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(REPO, "bin", "quota.ts"), "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.once("exit", (code) => resolve({ status: code ?? -1, stdout, stderr }));
	});
}

async function cacheCase(): Promise<string[]> {
	const failures: string[] = [];
	const root = mkdtempSync(join(tmpdir(), "quota-router-"));
	const home = join(root, "home");
	const credentials = join(home, ".local", "share", "claude-swap", "credentials");
	mkdirSync(credentials, { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const oauth = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 86_400_000 } });
	writeFileSync(join(credentials, ".creds-1-one.enc"), Buffer.from(oauth("anthropic-one")).toString("base64"));
	writeFileSync(join(credentials, ".creds-2-two.enc"), Buffer.from(oauth("anthropic-two")).toString("base64"));
	writeFileSync(join(home, ".claude", ".credentials.json"), oauth("anthropic-one"));
	writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ "openai-codex": { access: "openai-one", accountId: "account-1" } }));
	const before = hashTree(credentials);
	let requests = 0;
	const reset = new Date(Date.now() + 3_600_000).toISOString();
	const server = createServer((request, response) => {
		requests++;
		response.setHeader("content-type", "application/json");
		if (request.url === "/anthropic") {
			const used = request.headers.authorization?.includes("anthropic-one") ? 80 : 20;
			response.end(JSON.stringify({ five_hour: { utilization: used, resets_at: reset }, seven_day: { utilization: 10, resets_at: reset } }));
			return;
		}
		if (request.url === "/openai") {
			response.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: 30, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }));
			return;
		}

		response.statusCode = 404;
		response.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no fake quota port");
	const env = {
		...process.env,
		HOME: home,
		MODEL_ROTATION_QUOTA_CACHE: join(root, "quota.json"),
		MODEL_ROTATION_CSWAP_DIR: join(home, ".local", "share", "claude-swap"),
		MODEL_ROTATION_PI_AUTH: join(home, ".pi", "agent", "auth.json"),
		MODEL_ROTATION_IGNORE_CSWAP_USAGE: "1",
		MODEL_ROTATION_ANTHROPIC_USAGE_URL: `http://127.0.0.1:${address.port}/anthropic`,
		MODEL_ROTATION_OPENAI_USAGE_URL: `http://127.0.0.1:${address.port}/openai`,
	};
	try {
		const [first, concurrent] = await Promise.all([runQuota(env), runQuota(env)]);
		if (first.status !== 0 || concurrent.status !== 0) return [`concurrent poll failed: ${first.stderr} ${concurrent.stderr}`];
		const entries = JSON.parse(first.stdout) as QuotaEntry[];
		if (entries.length !== 4) failures.push(`expected four subscriptions, got ${entries.length}`);
		if (!entries.filter((entry) => entry.reachable).every((entry) => typeof entry.usedPercent === "number" && typeof entry.resetsAt === "string")) failures.push("reachable entries lack percent/reset");
		if (!entries.some((entry) => entry.account === "anthropic-1" && entry.active) || entries.some((entry) => entry.account === "anthropic-2" && entry.active)) failures.push("active Anthropic account was not identified safely");
		const go = entries.find((entry) => entry.provider === "opencode-go");
		if (go?.reachable || !go?.reason) failures.push(`go should report as a last resort with no usage API: ${JSON.stringify(go)}`);
		const afterFirst = requests;
		const second = await runQuota(env);
		if (second.status !== 0 || requests !== afterFirst || afterFirst !== 3) failures.push(`cache/lock did not bound polling: first=${afterFirst}, after=${requests}`);

		const usageDir = join(home, ".local", "share", "claude-swap", "cache");
		mkdirSync(usageDir, { recursive: true });
		const epoch = Date.now() / 1000;
		const lastGood = { five_hour: { pct: 40, resets_at: reset }, seven_day: { pct: 10, resets_at: reset } };
		writeFileSync(join(usageDir, "usage.json"), JSON.stringify({ accounts: { 1: { lastGood, fetchedAt: epoch, nextPollAt: epoch + 600 }, 2: { lastGood, fetchedAt: epoch, nextPollAt: epoch + 600 } } }));
		rmSync(join(root, "quota.json"), { force: true });
		const cacheOwnedEnv = { ...env };
		delete cacheOwnedEnv.MODEL_ROTATION_IGNORE_CSWAP_USAGE;
		const beforeOwned = requests;
		const cacheOwned = await runQuota(cacheOwnedEnv);
		if (cacheOwned.status !== 0 || requests - beforeOwned !== 1) failures.push(`cswap-owned cadence was duplicated (${requests - beforeOwned} network requests)`);
		if (hashTree(credentials) !== before) failures.push("claude-swap credential store changed");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
	return failures;
}

async function routingCase(): Promise<string[]> {
	const now = Date.now();
	const fetchedAt = new Date(now).toISOString();
	const resetsAt = new Date(now + 3_600_000).toISOString();
	const entry = (provider: string, account: string, remainingPercent: number, extra: Partial<QuotaEntry> = {}): QuotaEntry => ({
		provider,
		account,
		reachable: true,
		active: true,
		usedPercent: 100 - remainingPercent,
		remainingPercent,
		resetsAt,
		fetchedAt,
		burnPercentPerHour: 0,
		...extra,
	});
	const failures: string[] = [];
	const routed = chooseRoute([entry("anthropic", "a1", 20), entry("openai-codex", "o1", 70)], { currentProvider: "anthropic", taskMinutes: 60 });
	if (routed?.provider !== "openai-codex") failures.push(`did not prefer headroom: ${JSON.stringify(routed)}`);
	const sticky = chooseRoute([entry("anthropic", "a1", 65), entry("openai-codex", "o1", 70)], { currentProvider: "anthropic", taskMinutes: 60 });
	if (sticky?.provider !== "anthropic") failures.push("hysteresis did not retain a near-equal current route");
	const forecast = chooseRoute([entry("anthropic", "a1", 70, { burnPercentPerHour: 60 }), entry("openai-codex", "o1", 55)], { currentProvider: "anthropic", taskMinutes: 60 });
	if (forecast?.provider !== "openai-codex") failures.push("forecast did not anticipate exhaustion before task end");
	const blocked = chooseRoute([entry("anthropic", "a1", 90), entry("openai-codex", "o1", 50)], { blockedAfter: { anthropic: now + 1 } });
	if (blocked?.provider !== "openai-codex") failures.push("a 429-blocked provider returned without a newer quota sample");
	const inactive = chooseRoute([entry("anthropic", "a2", 99, { active: false }), entry("openai-codex", "o1", 40)]);
	if (inactive?.provider !== "openai-codex") failures.push("router selected an account it cannot activate");

	const expiry = chooseRoute([
		entry("anthropic", "a1", 9, { burnPercentPerHour: 20, windows: {
			five_hour: { usedPercent: 20, resetsAt: new Date(now + 4 * 3_600_000).toISOString() },
			seven_day: { usedPercent: 91, resetsAt: new Date(now + 3_600_000).toISOString() },
		} }),
		entry("openai-codex", "o1", 100, { windows: {
			primary: { usedPercent: 0, resetsAt: new Date(now + 6 * 24 * 3_600_000).toISOString() },
		} }),
	], { currentProvider: "openai-codex" });
	if (expiry?.provider !== "anthropic" || expiry.reason !== "weekly expiry") failures.push(`weekly quota would expire unused: ${JSON.stringify(expiry)}`);

	const shortWindow = chooseRoute([
		entry("anthropic", "a1", 50, { windows: {
			five_hour: { usedPercent: 50, resetsAt: new Date(now + 5 * 60_000).toISOString() },
			seven_day: { usedPercent: 50, resetsAt: new Date(now + 6 * 24 * 3_600_000).toISOString() },
		} }),
		entry("openai-codex", "o1", 50, { windows: {
			primary: { usedPercent: 50, resetsAt: new Date(now + 6 * 24 * 3_600_000).toISOString() },
		} }),
	], { currentProvider: "openai-codex" });
	if (shortWindow?.provider !== "openai-codex") failures.push("five-hour expiry incorrectly drove weekly routing");

	let registrations = 0;
	const fakePi = {
		on() { registrations++; },
		registerCommand() { registrations++; },
	} as any;
	modelRotation(fakePi);
	const once = registrations;
	modelRotation(fakePi);
	if (registrations !== once) failures.push("loading model-rotation twice registered duplicate handlers");
	const source = readFileSync(join(REPO, "extension", "index.ts"), "utf8");
	if (source.includes("sendUserMessage") || source.includes("cooldown expired")) failures.push("fake-user resume or time-only switchback remains in model-rotation");

	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const statuses: string[] = [];
	const notices: string[] = [];
	let setModelCalls = 0;
	const togglePi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => Promise<void> }) { commands.set(name, command); },
		appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
		async setModel() { setModelCalls++; return true; },
		setThinkingLevel() {},
		sendMessage() {},
	} as any;
	const ctx = {
		cwd: REPO,
		hasUI: true,
		ui: {
			setStatus(_key: string, value: string) { statuses.push(value); },
			notify(value: string) { notices.push(value); },
		},
		sessionManager: {
			getBranch: () => [],
			getLeafId: () => "leaf",
		},
	} as any;
	modelRotation(togglePi);
	handlers.get("session_start")?.({}, ctx);
	await commands.get("rotation-toggle")?.handler("", ctx);
	await handlers.get("after_provider_response")?.({ status: 429, headers: {} }, ctx);
	await commands.get("rotation-toggle")?.handler("", ctx);
	if (setModelCalls !== 0) failures.push("disabled rotation still reacted to a 429");
	if (JSON.stringify(statuses) !== JSON.stringify(["rotation: frontier", "rotation: off", "rotation: frontier"])) failures.push(`toggle status feedback is wrong: ${JSON.stringify(statuses)}`);
	if (!notices.includes("model rotation disabled") || !notices.includes("model rotation enabled")) failures.push("toggle notifications do not show both states");
	if (appended.length !== 2 || (appended[0]?.data as any)?.enabled !== false || (appended[1]?.data as any)?.enabled !== true) failures.push("toggle state was not persisted in the session");
	ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "model-rotation-state", data: { enabled: false } }];
	handlers.get("session_start")?.({}, ctx);
	await handlers.get("after_provider_response")?.({ status: 429, headers: {} }, ctx);
	if (statuses.at(-1) !== "rotation: off" || setModelCalls !== 0) failures.push("disabled state did not survive session restoration");
	return failures;
}

/** A fake session that records what rotation does to the model and its effort. */
function fakeSession() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
	const statuses: string[] = [];
	const notices: string[] = [];
	const ctx: any = {
		cwd: join(REPO, "tests"),
		hasUI: true,
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: { getBranch: () => [], getLeafId: () => "leaf" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { setStatus: (_k: string, value: string) => statuses.push(value), notify: (value: string) => notices.push(value) },
	};
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: () => {},
		setModel: async (model: any) => {
			ctx.model = model;
			return true;
		},
		setThinkingLevel: (level: string) => (ctx.thinkingLevel = level),
		sendMessage: () => {},
	};
	modelRotation(pi);
	handlers.get("session_start")?.({}, ctx);
	const at = () => `${ctx.model?.provider}/${ctx.model?.id}:${ctx.thinkingLevel}`;
	const limit = async () => {
		await new Promise((resolve) => setTimeout(resolve, 2100)); // the rotate debounce coalesces one 429
		await handlers.get("after_provider_response")?.({ status: 429, headers: {} }, ctx);
	};
	return { ctx, commands, handlers, statuses, notices, at, limit };
}

async function modeCase(): Promise<string[]> {
	const failures: string[] = [];

	const frontier = fakeSession();
	await frontier.commands.get("rotation")?.handler("frontier", frontier.ctx);
	if (frontier.at() !== "anthropic/claude-opus-5:medium") failures.push(`frontier did not start on opus at medium: ${frontier.at()}`);
	frontier.ctx.thinkingLevel = "high"; // a manual bump the ladder must read back
	await frontier.limit();
	if (frontier.at() !== "openai-codex/gpt-5.6-sol:xhigh") failures.push(`opus high did not translate to sol xhigh: ${frontier.at()}`);
	await frontier.limit();
	if (frontier.at() !== "opencode-go/kimi-k3:max") failures.push(`go was not the frontier last resort: ${frontier.at()}`);
	if (frontier.statuses.includes("rotation: casual")) failures.push("rotation promoted itself to casual");

	const casual = fakeSession();
	await casual.commands.get("rotation")?.handler("casual", casual.ctx);
	if (casual.at() !== "openai-codex/gpt-5.6-luna:xhigh") failures.push(`casual did not overwrite effort to xhigh: ${casual.at()}`);
	casual.ctx.thinkingLevel = "high"; // inside casual the level travels untouched
	await casual.limit();
	if (casual.at() !== "opencode-go/gpt-5.6-luna:high") failures.push(`casual pair did not keep its effort: ${casual.at()}`);
	await casual.limit();
	if (casual.at() !== "anthropic/claude-opus-5:medium") failures.push(`spent casual did not fall back to frontier: ${casual.at()}`);
	if (casual.statuses.at(-1) !== "rotation: frontier") failures.push(`mode was not reported as frontier: ${casual.statuses.at(-1)}`);
	return failures;
}

const cases: Record<string, () => Promise<string[]>> = { routing: routingCase, modes: modeCase };
const selected = requested.find((name) => name in cases);
const failures = selected ? await cases[selected]() : await cacheCase();
if (failures.length) {
	for (const failure of failures) console.log(`FAIL: ${failure}`);
	process.exit(1);
}
console.log("PASS");
