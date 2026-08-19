import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelRotation from "../../extension/index.ts";
import { chooseRoute, providerCapacity, type QuotaEntry } from "../../src/quota.ts";

const REPO = join(import.meta.dirname, "..", "..");
const requested = process.argv.slice(2).map((arg) => arg.replace(/^--/, ""));

function hashTree(root: string): string {
	const hash = createHash("sha256");
	for (const name of readdirSync(root).sort()) hash.update(name).update(readFileSync(join(root, name)));
	return hash.digest("hex");
}

function runQuota(env: NodeJS.ProcessEnv, args = ["--json"]): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(REPO, "bin", "quota.ts"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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
	writeFileSync(join(home, ".local", "share", "claude-swap", "sequence.json"), JSON.stringify({ activeAccountNumber: 1 }));
	writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ "openai-codex": { access: "openai-one", accountId: "account-1" } }));
	const before = hashTree(credentials);
	let requests = 0;
	const reset = new Date(Date.now() + 3_600_000).toISOString();
	const server = createServer((request, response) => {
		requests++;
		response.setHeader("content-type", "application/json");
		if (request.url === "/anthropic") {
			const authorization = request.headers.authorization ?? "";
			const used = authorization.includes("anthropic-refreshed") ? 0.05 : authorization.includes("anthropic-one") ? 0.8 : 0.2;
			const fiveHour = authorization.includes("anthropic-two") ? { utilization: used } : { utilization: used, resets_at: reset };
			response.end(JSON.stringify({ five_hour: fiveHour, seven_day: { utilization: 0.1, resets_at: reset } }));
			return;
		}
		if (request.url === "/openai") {
			response.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }));
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
		const account1 = entries.find((entry) => entry.account === "anthropic-1");
		const account2 = entries.find((entry) => entry.account === "anthropic-2");
		const openai = entries.find((entry) => entry.provider === "openai-codex");
		if (account1?.usedPercent !== 80 || account2?.usedPercent !== 20) failures.push(`Anthropic utilization was not parsed as a ratio: ${JSON.stringify([account1, account2])}`);
		if (!account2?.reachable || account2.windows?.five_hour.resetsAt !== undefined || account2.resetsAt !== reset) failures.push(`missing per-window reset made account 2 unknown: ${JSON.stringify(account2)}`);
		if (openai?.usedPercent !== 1 || openai.remainingPercent !== 99) failures.push(`OpenAI's 1% was not parsed as one percent: ${JSON.stringify(openai)}`);
		const go = entries.find((entry) => entry.provider === "opencode-go");
		if (go?.reachable || !go?.reason) failures.push(`go should report as a last resort with no usage API: ${JSON.stringify(go)}`);
		const afterFirst = requests;
		const second = await runQuota(env);
		if (second.status !== 0 || requests !== afterFirst || afterFirst !== 3) failures.push(`cache/lock did not bound polling: first=${afterFirst}, after=${requests}`);

		const usageDir = join(home, ".local", "share", "claude-swap", "cache");
		mkdirSync(usageDir, { recursive: true });
		const epoch = Date.now() / 1000;
		const lastGood = { five_hour: { pct: 40, resets_at: reset }, seven_day: { pct: 10, resets_at: reset } };
		const account2LastGood = { five_hour: { pct: 1 }, seven_day: { pct: 10, resets_at: reset } };
		writeFileSync(join(usageDir, "usage.json"), JSON.stringify({ accounts: { 1: { lastGood, fetchedAt: epoch, nextPollAt: epoch + 600 }, 2: { lastGood: account2LastGood, fetchedAt: epoch, nextPollAt: epoch + 600 } } }));
		rmSync(join(root, "quota.json"), { force: true });
		const cacheOwnedEnv = { ...env };
		delete cacheOwnedEnv.MODEL_ROTATION_IGNORE_CSWAP_USAGE;
		const beforeOwned = requests;
		const cacheOwned = await runQuota(cacheOwnedEnv);
		const cachedEntries = JSON.parse(cacheOwned.stdout) as QuotaEntry[];
		const cachedAccount2 = cachedEntries.find((entry) => entry.account === "anthropic-2");
		if (cacheOwned.status !== 0 || requests - beforeOwned !== 1 || !cachedAccount2?.reachable || cachedAccount2.usedPercent !== 10 || cachedAccount2.windows?.five_hour.usedPercent !== 1 || cachedAccount2.resetsAt !== reset) failures.push(`cswap cache did not preserve percentage units or tolerate missing reset: ${requests - beforeOwned} requests, ${JSON.stringify(cachedAccount2)}`);

		writeFileSync(join(home, ".claude", ".credentials.json"), oauth("anthropic-refreshed"));
		const beforeRefresh = requests;
		const refreshed = await runQuota(cacheOwnedEnv, ["--json", "--refresh"]);
		const refreshedEntries = JSON.parse(refreshed.stdout) as QuotaEntry[];
		const refreshedActive = refreshedEntries.find((entry) => entry.account === "anthropic-1");
		if (refreshed.status !== 0 || requests - beforeRefresh !== 3 || refreshedActive?.windows?.five_hour.usedPercent !== 5) {
			failures.push(`forced refresh ignored the re-login (${requests - beforeRefresh} requests, ${JSON.stringify(refreshedActive)})`);
		}
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

	const exhaustedShortWindow = entry("anthropic", "a1", 0, { burnPercentPerHour: 110, windows: {
		five_hour: { usedPercent: 100, resetsAt },
		seven_day: { usedPercent: 41, resetsAt: new Date(now + 36 * 3_600_000).toISOString() },
	} });
	const openaiHeadroom = entry("openai-codex", "o1", 98, { windows: {
		primary: { usedPercent: 2, resetsAt: new Date(now + 6 * 24 * 3_600_000).toISOString() },
	} });
	const capacityGuard = chooseRoute([exhaustedShortWindow, openaiHeadroom], { currentProvider: "openai-codex" });
	if (capacityGuard?.provider !== "openai-codex") failures.push(`weekly pressure bypassed exhausted immediate capacity: ${JSON.stringify(capacityGuard)}`);
	if (providerCapacity([exhaustedShortWindow], "anthropic") !== false) failures.push("an exhausted current window was not proven spent");
	if (chooseRoute([exhaustedShortWindow]) !== undefined) failures.push("an exhausted provider remained routable without another hop");

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
	if (source.includes('pi.on("turn_start"') || !source.includes('pi.on("before_agent_start"')) failures.push("quota routing still changes the model after the agent run starts");

	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const statuses: string[] = [];
	const notices: string[] = [];
	const widgets: unknown[] = [];
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
		model: { provider: "anthropic", id: "claude-opus-5" },
		ui: {
			setStatus(_key: string, value: string) { statuses.push(value); },
			setWidget(_key: string, value: unknown) { widgets.push(value); },
			theme: { bold(value: string) { return value; } },
			notify(value: string) { notices.push(value); },
		},
		sessionManager: {
			getBranch: () => [],
			getLeafId: () => "leaf",
		},
	} as any;
	modelRotation(togglePi);
	handlers.get("session_start")?.({}, ctx);
	const commandNames = ["mru", "mrt", "mrc", "mrf"];
	if (!commandNames.every((name) => commands.has(name)) || ["rotation", "rotation-toggle"].some((name) => commands.has(name))) failures.push(`command names are wrong: ${JSON.stringify([...commands.keys()])}`);
	await commands.get("mrt")?.handler("", ctx);
	await handlers.get("after_provider_response")?.({ status: 429, headers: {} }, ctx);
	await commands.get("mrt")?.handler("", ctx);
	await commands.get("mru")?.handler("hide", ctx);
	if (widgets.at(-1) !== undefined) failures.push("usage widget did not hide");
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

function testQuota(provider: string, remainingPercent: number, extra: Partial<QuotaEntry> = {}): QuotaEntry {
	const resetsAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
	return {
		provider,
		account: `${provider}-test`,
		reachable: true,
		active: true,
		usedPercent: 100 - remainingPercent,
		remainingPercent,
		resetsAt,
		fetchedAt: new Date().toISOString(),
		burnPercentPerHour: 0,
		windows: provider === "anthropic"
			? { five_hour: { usedPercent: 100 - remainingPercent, resetsAt }, seven_day: { usedPercent: 20, resetsAt: new Date(Date.now() + 6 * 24 * 3_600_000).toISOString() } }
			: { primary: { usedPercent: 100 - remainingPercent, resetsAt } },
		...extra,
	};
}

function testQuotaCache() {
	const root = mkdtempSync(join(tmpdir(), "model-rotation-modes-"));
	const path = join(root, "quota.json");
	const previous = process.env.MODEL_ROTATION_QUOTA_CACHE;
	process.env.MODEL_ROTATION_QUOTA_CACHE = path;
	return {
		write(entries: QuotaEntry[]) {
			writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), entries }));
		},
		close() {
			if (previous === undefined) delete process.env.MODEL_ROTATION_QUOTA_CACHE;
			else process.env.MODEL_ROTATION_QUOTA_CACHE = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A fake session that records what rotation does to the model and its effort. */
function fakeSession(
	initialModel = { provider: "anthropic", id: "claude-opus-5" },
	branch: unknown[] = [],
	contextTokens: number | null = 0,
) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
	const statuses: string[] = [];
	const notices: string[] = [];
	const appended: Array<{ type: string; data: any }> = [];
	let setModelCalls = 0;
	const ctx: any = {
		cwd: join(REPO, "tests"),
		hasUI: true,
		model: initialModel,
		thinkingLevel: undefined,
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: { getBranch: () => branch, getLeafId: () => "leaf" },
		getContextUsage: () => ({ tokens: contextTokens }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			setStatus: (_k: string, value: string) => statuses.push(value),
			setWidget: () => {},
			theme: { bold: (value: string) => value },
			notify: (value: string) => notices.push(value),
		},
	};
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (type: string, data: any) => appended.push({ type, data }),
		setModel: async (model: any) => {
			setModelCalls++;
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
		await handlers.get("after_provider_response")?.({ status: 429, headers: {} }, ctx);
	};
	const persistedState = () => [...appended].reverse().find((entry) => entry.type === "model-rotation-state")?.data;
	return {
		ctx,
		commands,
		handlers,
		statuses,
		notices,
		at,
		limit,
		persistedState,
		setContextTokens: (tokens: number | null) => (contextTokens = tokens),
		setModelCalls: () => setModelCalls,
	};
}

async function modeCase(): Promise<string[]> {
	const failures: string[] = [];
	const cache = testQuotaCache();
	cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 80)]);

	const frontier = fakeSession({ provider: "anthropic", id: "claude-opus-5" });
	if (frontier.statuses[0] !== "rotation: frontier") failures.push(`frontier model did not select frontier mode: ${frontier.statuses[0]}`);
	await frontier.commands.get("mrf")?.handler("", frontier.ctx);
	if (frontier.at() !== "anthropic/claude-opus-5:medium") failures.push(`frontier did not start on opus at medium: ${frontier.at()}`);
	frontier.ctx.thinkingLevel = "high"; // a manual bump the ladder must read back
	await frontier.limit();
	if (frontier.at() !== "openai-codex/gpt-5.6-sol:xhigh") failures.push(`opus high did not translate to sol xhigh: ${frontier.at()}`);
	await frontier.limit();
	if (frontier.at() !== "opencode-go/kimi-k3:max") failures.push(`go was not the frontier last resort: ${frontier.at()}`);
	if (frontier.statuses.includes("rotation: casual")) failures.push("rotation promoted itself to casual");

	const casual = fakeSession({ provider: "openai-codex", id: "gpt-5.6-luna" });
	if (casual.statuses[0] !== "rotation: casual") failures.push(`casual model did not select casual mode: ${casual.statuses[0]}`);
	await casual.commands.get("mrc")?.handler("", casual.ctx);
	if (casual.at() !== "openai-codex/gpt-5.6-luna:xhigh") failures.push(`casual did not overwrite effort to xhigh: ${casual.at()}`);
	casual.ctx.thinkingLevel = "high"; // inside casual the level travels untouched
	await casual.limit();
	if (casual.at() !== "opencode-go/gpt-5.6-luna:high") failures.push(`casual pair did not keep its effort: ${casual.at()}`);
	await casual.limit();
	if (casual.at() !== "anthropic/claude-opus-5:medium") failures.push(`spent casual did not fall back to frontier: ${casual.at()}`);
	if (casual.statuses.at(-1) !== "rotation: frontier") failures.push(`mode was not reported as frontier: ${casual.statuses.at(-1)}`);

	const restored = fakeSession(
		{ provider: "anthropic", id: "claude-opus-5" },
		[{ type: "custom", customType: "model-rotation-state", data: { enabled: true, mode: "casual" } }],
	);
	if (restored.statuses[0] !== "rotation: frontier") failures.push(`persisted casual mode overrode the frontier model: ${restored.statuses[0]}`);

	const unsupported = fakeSession({ provider: "openai-codex", id: "unsupported-model" });
	if (unsupported.statuses[0] !== "rotation: off") failures.push(`unsupported model did not disable rotation: ${unsupported.statuses[0]}`);
	await unsupported.handlers.get("after_provider_response")?.({ status: 429, headers: {} }, unsupported.ctx);
	if (unsupported.setModelCalls() !== 0) failures.push("unsupported model still rotated after a 429");

	// A mode is a rotation policy: asking for one while rotation is off must turn it back on.
	const reenabled = fakeSession({ provider: "anthropic", id: "claude-opus-5" });
	await reenabled.commands.get("mrt")?.handler("", reenabled.ctx);
	if (reenabled.statuses.at(-1) !== "rotation: off") failures.push(`toggle did not disable rotation: ${reenabled.statuses.at(-1)}`);
	await reenabled.commands.get("mrf")?.handler("", reenabled.ctx);
	if (reenabled.statuses.at(-1) !== "rotation: frontier") failures.push(`a mode command left the footer disabled: ${reenabled.statuses.at(-1)}`);
	if (reenabled.persistedState()?.enabled !== true) failures.push(`a mode command persisted rotation as disabled: ${JSON.stringify(reenabled.persistedState())}`);
	await reenabled.limit();
	if (reenabled.at() !== "openai-codex/gpt-5.6-sol:high") failures.push(`rotation stayed disabled after a mode command: ${reenabled.at()}`);

	const reenabledCasual = fakeSession({ provider: "openai-codex", id: "gpt-5.6-luna" });
	await reenabledCasual.commands.get("mrt")?.handler("", reenabledCasual.ctx);
	await reenabledCasual.commands.get("mrc")?.handler("", reenabledCasual.ctx);
	if (reenabledCasual.statuses.at(-1) !== "rotation: casual" || reenabledCasual.persistedState()?.enabled !== true) failures.push(`casual mode did not re-enable rotation: ${reenabledCasual.statuses.at(-1)}`);

	cache.write([testQuota("anthropic", 0), testQuota("openai-codex", 98)]);
	const proactive = fakeSession({ provider: "anthropic", id: "claude-opus-5" });
	await proactive.handlers.get("before_agent_start")?.({}, proactive.ctx);
	if (proactive.at() !== "openai-codex/gpt-5.6-sol:high") failures.push(`pre-agent quota routing did not avoid exhausted Anthropic: ${proactive.at()}`);

	cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 0)]);
	const directLastResort = fakeSession({ provider: "anthropic", id: "claude-opus-5" });
	await directLastResort.limit();
	if (directLastResort.at() !== "opencode-go/kimi-k3:max") failures.push(`proven exhaustion did not select Go directly: ${directLastResort.at()}`);

	cache.write([testQuota("anthropic", 80), { provider: "openai-codex", account: "openai-test", reachable: false, active: true, reason: "unavailable" }]);
	const unknownNormal = fakeSession({ provider: "anthropic", id: "claude-opus-5" });
	await unknownNormal.limit();
	if (unknownNormal.at() !== "openai-codex/gpt-5.6-sol:high") failures.push(`unknown OpenAI quota was skipped for Go without exhaustion proof: ${unknownNormal.at()}`);

	const changing = fakeSession({ provider: "anthropic", id: "claude-opus-5" });
	const casualModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
	changing.ctx.model = casualModel;
	await changing.handlers.get("model_select")?.({ model: casualModel }, changing.ctx);
	if (changing.statuses.at(-1) !== "rotation: casual") failures.push(`model selection did not switch to casual: ${changing.statuses.at(-1)}`);
	const unsupportedModel = { provider: "openai-codex", id: "unsupported-model" };
	changing.ctx.model = unsupportedModel;
	await changing.handlers.get("model_select")?.({ model: unsupportedModel }, changing.ctx);
	if (changing.statuses.at(-1) !== "rotation: off") failures.push(`model selection did not disable unsupported rotation: ${changing.statuses.at(-1)}`);
	cache.close();
	return failures;
}

function modelKey(session: ReturnType<typeof fakeSession>): string {
	return `${session.ctx.model?.provider}/${session.ctx.model?.id}`;
}

function pressuredAnthropicQuota(): QuotaEntry {
	const now = Date.now();
	return testQuota("anthropic", 9, {
		windows: {
			five_hour: { usedPercent: 20, resetsAt: new Date(now + 4 * 3_600_000).toISOString() },
			seven_day: { usedPercent: 91, resetsAt: new Date(now + 3_600_000).toISOString() },
		},
	});
}

// --frontier-context-below
async function frontierContextBelowCase(): Promise<string[]> {
	const failures: string[] = [];
	const cache = testQuotaCache();
	try {
		cache.write([pressuredAnthropicQuota(), testQuota("openai-codex", 100)]);
		const preferred = fakeSession({ provider: "anthropic", id: "claude-opus-5" }, [], 271_999);
		await preferred.handlers.get("before_agent_start")?.({}, preferred.ctx);
		if (modelKey(preferred) !== "openai-codex/gpt-5.6-sol") failures.push(`271999 tokens did not override Anthropic weekly pressure: ${modelKey(preferred)}`);

		cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 0)]);
		const exhausted = fakeSession({ provider: "openai-codex", id: "gpt-5.6-sol" }, [], 271_999);
		await exhausted.handlers.get("before_agent_start")?.({}, exhausted.ctx);
		if (modelKey(exhausted) !== "anthropic/claude-opus-5") failures.push(`context preference bypassed proven OpenAI exhaustion: ${modelKey(exhausted)}`);

		cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 100)]);
		const cooling = fakeSession({ provider: "openai-codex", id: "gpt-5.6-sol" }, [], 271_999);
		await cooling.limit();
		if (modelKey(cooling) !== "anthropic/claude-opus-5") failures.push(`context preference bypassed an OpenAI cooldown: ${modelKey(cooling)}`);
	} finally {
		cache.close();
	}
	return failures;
}

// --frontier-context-boundary
async function frontierContextBoundaryCase(): Promise<string[]> {
	const failures: string[] = [];
	const cache = testQuotaCache();
	try {
		cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 100)]);
		const proactive = fakeSession({ provider: "openai-codex", id: "gpt-5.6-sol" }, [], 272_000);
		await proactive.handlers.get("before_agent_start")?.({}, proactive.ctx);
		if (modelKey(proactive) !== "anthropic/claude-opus-5") failures.push(`272000-token request remained on OpenAI: ${modelKey(proactive)}`);

		const above = fakeSession({ provider: "openai-codex", id: "gpt-5.6-sol" }, [], 400_000);
		await above.handlers.get("before_agent_start")?.({}, above.ctx);
		if (modelKey(above) !== "anthropic/claude-opus-5") failures.push(`above-boundary request remained on OpenAI: ${modelKey(above)}`);

		const reactive = fakeSession({ provider: "anthropic", id: "claude-opus-5" }, [], 272_000);
		await reactive.limit();
		if (modelKey(reactive) !== "opencode-go/kimi-k3") failures.push(`boundary 429 rotated to OpenAI: ${modelKey(reactive)}`);
	} finally {
		cache.close();
	}
	return failures;
}

// --frontier-context-fallback
async function frontierContextFallbackCase(): Promise<string[]> {
	const failures: string[] = [];
	const cache = testQuotaCache();
	try {
		cache.write([testQuota("anthropic", 0), testQuota("openai-codex", 100)]);
		const exhausted = fakeSession({ provider: "openai-codex", id: "gpt-5.6-sol" }, [], 272_000);
		await exhausted.handlers.get("before_agent_start")?.({}, exhausted.ctx);
		if (modelKey(exhausted) !== "opencode-go/kimi-k3") failures.push(`Anthropic exhaustion did not reach Go at the boundary: ${modelKey(exhausted)}`);

		cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 100)]);
		const available = fakeSession({ provider: "openai-codex", id: "gpt-5.6-sol" }, [], 272_000);
		await available.handlers.get("before_agent_start")?.({}, available.ctx);
		if (modelKey(available) !== "anthropic/claude-opus-5") failures.push(`Go preceded usable Anthropic at the boundary: ${modelKey(available)}`);
	} finally {
		cache.close();
	}
	return failures;
}

// --frontier-context-unknown
async function frontierContextUnknownCase(): Promise<string[]> {
	const failures: string[] = [];
	const cache = testQuotaCache();
	try {
		cache.write([pressuredAnthropicQuota(), testQuota("openai-codex", 100)]);
		const compacted = fakeSession({ provider: "anthropic", id: "claude-opus-5" }, [], null);
		compacted.ctx.sessionManager.getSessionStats = () => ({ tokens: { total: 900_000 } });
		await compacted.handlers.get("before_agent_start")?.({}, compacted.ctx);
		if (modelKey(compacted) !== "openai-codex/gpt-5.6-sol") failures.push(`missing context usage did not follow below-boundary policy: ${modelKey(compacted)}`);
	} finally {
		cache.close();
	}
	return failures;
}

// --casual-context-regression
async function casualContextRegressionCase(): Promise<string[]> {
	const failures: string[] = [];
	const cache = testQuotaCache();
	try {
		cache.write([testQuota("anthropic", 80), testQuota("openai-codex", 100)]);
		for (const tokens of [271_999, 272_000]) {
			const casual = fakeSession({ provider: "openai-codex", id: "gpt-5.6-luna" }, [], tokens);
			await casual.handlers.get("before_agent_start")?.({}, casual.ctx);
			if (modelKey(casual) !== "openai-codex/gpt-5.6-luna") failures.push(`casual normal route changed at ${tokens} tokens: ${modelKey(casual)}`);
			await casual.limit();
			if (modelKey(casual) !== "opencode-go/gpt-5.6-luna") failures.push(`casual last resort changed at ${tokens} tokens: ${modelKey(casual)}`);
		}
	} finally {
		cache.close();
	}
	return failures;
}

const cases: Record<string, () => Promise<string[]>> = {
	routing: routingCase,
	modes: modeCase,
	"frontier-context-below": frontierContextBelowCase,
	"frontier-context-boundary": frontierContextBoundaryCase,
	"frontier-context-fallback": frontierContextFallbackCase,
	"frontier-context-unknown": frontierContextUnknownCase,
	"casual-context-regression": casualContextRegressionCase,
};
const selected = requested.find((name) => name in cases);
const failures = selected ? await cases[selected]() : await cacheCase();
if (failures.length) {
	for (const failure of failures) console.log(`FAIL: ${failure}`);
	process.exit(1);
}
console.log("PASS");
