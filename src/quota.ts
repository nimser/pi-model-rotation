/** Cached subscription quota polling and predictive route selection. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentDir, envPath, jsonRequest, safeReason } from "./http.ts";

export interface QuotaEntry {
	provider: string;
	account: string;
	reachable: boolean;
	usedPercent?: number;
	remainingPercent?: number;
	resetsAt?: string;
	fetchedAt?: string;
	active?: boolean;
	burnPercentPerHour?: number;
	forecastExhaustsAt?: string;
	reason?: string;
	windows?: Record<string, UsageWindow>;
}

interface UsageWindow {
	usedPercent: number;
	resetsAt?: string;
	/** Declared window length; pacing needs it to tell a short window from the long one. */
	seconds?: number;
}

interface QuotaCache {
	version: 1;
	fetchedAt: string;
	entries: QuotaEntry[];
}

export interface RouteChoice {
	provider: string;
	account: string;
	projectedRemainingPercent: number;
	reason: string;
}

const CACHE_MS = 180_000;
const FIVE_HOUR_SECONDS = 18_000;
const SEVEN_DAY_SECONDS = 604_800;
/** Below a day a window is an immediate throttle, not a quota that expires unused. */
const WEEKLY_MIN_SECONDS = 86_400;
const RESERVE_PERCENT = 10;
const HYSTERESIS_PERCENT = 10;
const WEEKLY_PRESSURE_HYSTERESIS = 0.1;

function cachePath(): string {
	return envPath("MODEL_ROTATION_QUOTA_CACHE", join(agentDir(), "cache", "model-rotation", "quota.json"));
}

function readCache(): QuotaCache | undefined {
	try {
		const value = JSON.parse(readFileSync(cachePath(), "utf8")) as QuotaCache;
		return value.version === 1 && Array.isArray(value.entries) ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeCache(cache: QuotaCache): void {
	const path = cachePath();
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

function percentage(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error("usage response omitted percentage");
	return Math.max(0, Math.min(100, number));
}

function utilizationPercentage(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error("usage response omitted utilization");
	return percentage(number <= 1 ? number * 100 : number);
}

function iso(value: unknown): string {
	const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : String(value));
	if (!Number.isFinite(date.getTime())) throw new Error("usage response omitted reset instant");
	return date.toISOString();
}

function optionalIso(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return iso(value);
}

function usageWindow(used: unknown, reset: unknown, seconds: number): UsageWindow {
	const resetsAt = optionalIso(reset);
	return { usedPercent: percentage(used), ...(resetsAt ? { resetsAt } : {}), seconds };
}

function utilizationWindow(used: unknown, reset: unknown, seconds: number): UsageWindow {
	const resetsAt = optionalIso(reset);
	return { usedPercent: utilizationPercentage(used), ...(resetsAt ? { resetsAt } : {}), seconds };
}

/** Names a window after its length, so an added plan window cannot occupy another one's slot. */
function windowName(seconds: number): string {
	if (seconds === FIVE_HOUR_SECONDS) return "five_hour";
	if (seconds === SEVEN_DAY_SECONDS) return "seven_day";
	return seconds < 86_400 ? `${Math.round(seconds / 3_600)}_hour` : `${Math.round(seconds / 86_400)}_day`;
}

function limitingWindow(windows: Record<string, UsageWindow>): UsageWindow {
	return Object.values(windows).sort((a, b) => b.usedPercent - a.usedPercent)[0]!;
}

function summaryReset(windows: Record<string, UsageWindow>): string | undefined {
	return limitingWindow(windows).resetsAt ?? Object.values(windows).find((window) => window.resetsAt)?.resetsAt;
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

interface ActiveAnthropicCredential {
	token: string;
	hash: string;
	account?: string;
}

function cswapRoot(): string {
	return envPath("MODEL_ROTATION_CSWAP_DIR", join(homedir(), ".local", "share", "claude-swap"));
}

function activeAnthropicCredential(): ActiveAnthropicCredential | undefined {
	try {
		const file = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
		const token = file?.claudeAiOauth?.accessToken;
		if (typeof token !== "string" || !token) return undefined;
		let account: string | undefined;
		try {
			const sequence = JSON.parse(readFileSync(join(cswapRoot(), "sequence.json"), "utf8"));
			const number = sequence?.activeAccountNumber;
			if ((typeof number === "number" && Number.isInteger(number) && number > 0) || (typeof number === "string" && /^\d+$/.test(number))) {
				account = `anthropic-${Number(number)}`;
			}
		} catch {
			// The token hash still identifies the active account when cswap metadata is unavailable.
		}
		return { token, hash: tokenHash(token), account };
	} catch {
		return undefined;
	}
}

function anthropicCredentials(): { account: string; token: string; active: boolean }[] {
	const directory = join(cswapRoot(), "credentials");
	const active = activeAnthropicCredential();
	const credentials: { account: string; token: string; active: boolean }[] = [];
	for (const name of readdirSync(directory).sort()) {
		const match = /^\.creds-(\d+)-.+\.enc$/.exec(name);
		if (!match) continue;
		const account = `anthropic-${Number(match[1])}`;
		try {
			const decoded = Buffer.from(readFileSync(join(directory, name), "utf8").trim(), "base64").toString("utf8");
			const file = JSON.parse(decoded);
			const storedToken = file?.claudeAiOauth?.accessToken;
			if (typeof storedToken === "string" && storedToken) {
				const activeAccount = tokenHash(storedToken) === active?.hash || account === active?.account;
				credentials.push({ account, token: activeAccount && active ? active.token : storedToken, active: activeAccount });
			}
		} catch {
			credentials.push({ account, token: account === active?.account && active ? active.token : "", active: account === active?.account });
		}
	}
	return credentials;
}

function cachedAnthropic(credentials: { account: string; token: string; active: boolean }[]): QuotaEntry[] {
	if (process.env.MODEL_ROTATION_IGNORE_CSWAP_USAGE === "1") return [];
	try {
		const usage = JSON.parse(readFileSync(join(cswapRoot(), "cache", "usage.json"), "utf8"));
		const now = Date.now();
		return credentials.flatMap((credential) => {
			const number = credential.account.split("-").at(-1) as string;
			const account = usage?.accounts?.[number];
			const good = account?.lastGood;
			const fetchedAt = Number(account?.fetchedAt) * 1000;
			const ownedUntil = Math.max(Number(account?.nextPollAt) * 1000, fetchedAt + CACHE_MS) + 30_000;
			if (!good || !Number.isFinite(fetchedAt) || now > ownedUntil) return [];
			const windows = {
				five_hour: usageWindow(good?.five_hour?.pct, good?.five_hour?.resets_at, FIVE_HOUR_SECONDS),
				seven_day: usageWindow(good?.seven_day?.pct, good?.seven_day?.resets_at, SEVEN_DAY_SECONDS),
			};
			const limiting = limitingWindow(windows);
			return [{
				provider: "anthropic",
				account: credential.account,
				reachable: true,
				active: credential.active,
				usedPercent: limiting.usedPercent,
				remainingPercent: 100 - limiting.usedPercent,
				resetsAt: summaryReset(windows),
				fetchedAt: new Date(fetchedAt).toISOString(),
				windows,
			}];
		});
	} catch {
		return [];
	}
}

async function pollAnthropic(credential: { account: string; token: string; active: boolean }): Promise<QuotaEntry> {
	if (!credential.token) return { provider: "anthropic", account: credential.account, reachable: false, active: credential.active, reason: "stored credential is unreadable" };
	try {
		const body = await jsonRequest(process.env.MODEL_ROTATION_ANTHROPIC_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage", {
			Authorization: `Bearer ${credential.token}`,
			"anthropic-beta": "oauth-2025-04-20",
		});
		const windows = {
			five_hour: utilizationWindow(body?.five_hour?.utilization, body?.five_hour?.resets_at, FIVE_HOUR_SECONDS),
			seven_day: utilizationWindow(body?.seven_day?.utilization, body?.seven_day?.resets_at, SEVEN_DAY_SECONDS),
		};
		const limiting = limitingWindow(windows);
		return {
			provider: "anthropic",
			account: credential.account,
			reachable: true,
			active: credential.active,
			usedPercent: limiting.usedPercent,
			remainingPercent: 100 - limiting.usedPercent,
			resetsAt: summaryReset(windows),
			fetchedAt: new Date().toISOString(),
			windows,
		};
	} catch (error) {
		return { provider: "anthropic", account: credential.account, reachable: false, active: credential.active, reason: safeReason(error) };
	}
}

async function pollOpenAI(): Promise<QuotaEntry> {
	const authPath = envPath("MODEL_ROTATION_PI_AUTH", join(agentDir(), "auth.json"));
	try {
		const auth = JSON.parse(readFileSync(authPath, "utf8"))?.["openai-codex"];
		if (typeof auth?.access !== "string") throw new Error("openai-codex OAuth credential is unavailable");
		const headers: Record<string, string> = { Authorization: `Bearer ${auth.access}` };
		if (typeof auth.accountId === "string" && auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
		const body = await jsonRequest(process.env.MODEL_ROTATION_OPENAI_USAGE_URL ?? "https://chatgpt.com/backend-api/wham/usage", headers);
		// The plan throttles on a rolling five hours and meters the week; only the second one can expire unused.
		const declared: [unknown, number][] = [
			[body?.rate_limit?.primary_window, FIVE_HOUR_SECONDS],
			[body?.rate_limit?.secondary_window, SEVEN_DAY_SECONDS],
		];
		const windows: Record<string, UsageWindow> = {};
		for (const [raw, fallbackSeconds] of declared) {
			const window = raw as { used_percent?: unknown; reset_at?: unknown; limit_window_seconds?: unknown } | undefined;
			if (!window) continue;
			const declaredSeconds = Number(window.limit_window_seconds);
			const seconds = Number.isFinite(declaredSeconds) && declaredSeconds > 0 ? declaredSeconds : fallbackSeconds;
			windows[windowName(seconds)] = usageWindow(window.used_percent, window.reset_at, seconds);
		}
		if (!Object.keys(windows).length) throw new Error("usage response omitted every rate limit window");
		const limiting = limitingWindow(windows);
		return {
			provider: "openai-codex",
			account: "openai-codex-1",
			reachable: true,
			active: true,
			usedPercent: limiting.usedPercent,
			remainingPercent: 100 - limiting.usedPercent,
			resetsAt: summaryReset(windows),
			fetchedAt: new Date().toISOString(),
			windows,
		};
	} catch (error) {
		return { provider: "openai-codex", account: "openai-codex-1", reachable: false, active: true, reason: safeReason(error) };
	}
}

function addForecast(entry: QuotaEntry, previous?: QuotaEntry): QuotaEntry {
	if (!entry.reachable || entry.usedPercent === undefined || !entry.fetchedAt) return entry;
	let burnPercentPerHour = 0;
	if (previous?.reachable && previous.usedPercent !== undefined && previous.fetchedAt) {
		const hours = (Date.parse(entry.fetchedAt) - Date.parse(previous.fetchedAt)) / 3_600_000;
		if (hours > 0) burnPercentPerHour = Math.max(0, (entry.usedPercent - previous.usedPercent) / hours);
	}
	const remaining = 100 - entry.usedPercent;
	const forecast = burnPercentPerHour > 0 ? new Date(Date.parse(entry.fetchedAt) + (remaining / burnPercentPerHour) * 3_600_000).toISOString() : undefined;
	return { ...entry, burnPercentPerHour: Number(burnPercentPerHour.toFixed(3)), ...(forecast ? { forecastExhaustsAt: forecast } : {}) };
}

export async function readQuotas(options: { refresh?: boolean } = {}): Promise<QuotaEntry[]> {
	let prior = readCache();
	if (!options.refresh && prior && Date.now() - Date.parse(prior.fetchedAt) < CACHE_MS) return prior.entries;
	const lock = `${cachePath()}.lock`;
	mkdirSync(dirname(lock), { recursive: true });
	let ownsLock = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			ownsLock = true;
			break;
		} catch {
			const fresh = readCache();
			if (!options.refresh && fresh && Date.now() - Date.parse(fresh.fetchedAt) < CACHE_MS) return fresh.entries;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
			} catch {
				/* another poller owns or just released the lock */
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	if (!ownsLock) throw new Error("quota poll lock timed out");
	try {
		prior = readCache();
		if (!options.refresh && prior && Date.now() - Date.parse(prior.fetchedAt) < CACHE_MS) return prior.entries;
		let anthropic: { account: string; token: string; active: boolean }[] = [];
		try {
			anthropic = anthropicCredentials();
		} catch {
			anthropic = [];
		}
		const cached = options.refresh ? [] : cachedAnthropic(anthropic);
		const cachedAccounts = new Set(cached.map((entry) => entry.account));
		const raw = await Promise.all([
			...cached,
			...anthropic.filter((credential) => options.refresh || !cachedAccounts.has(credential.account)).map(pollAnthropic),
			pollOpenAI(),
		]);
		if (!anthropic.length) raw.unshift({ provider: "anthropic", account: "anthropic-store", reachable: false, reason: "no readable claude-swap accounts" });
		// Go publishes no usage API; it is the last resort of its mode and the 429 is its only signal.
		raw.push({ provider: "opencode-go", account: "opencode-go-1", reachable: false, active: true, reason: "last resort; no usage API" });
		const entries = raw.map((entry) => addForecast(entry, prior?.entries.find((old) => old.provider === entry.provider && old.account === entry.account)));
		writeCache({ version: 1, fetchedAt: new Date().toISOString(), entries });
		return entries;
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** The longest declared window of a plan: the only quota whose leftover expires instead of refilling. */
function weeklyWindow(entry: QuotaEntry): UsageWindow | undefined {
	return Object.values(entry.windows ?? {})
		.filter((window) => (window.seconds ?? 0) >= WEEKLY_MIN_SECONDS)
		.sort((a, b) => (b.seconds as number) - (a.seconds as number))[0];
}

export function immediateCapacity(entry: QuotaEntry, now = Date.now()): boolean | undefined {
	if (!entry.reachable || entry.active === false || entry.remainingPercent === undefined || !entry.fetchedAt) return undefined;
	if (Date.parse(entry.resetsAt ?? "") <= now) return undefined;
	return entry.remainingPercent > 0;
}

export function providerCapacity(entries: QuotaEntry[], provider: string, blockedAt = 0, now = Date.now()): boolean | undefined {
	const observed = entries
		.filter((entry) => entry.provider === provider && entry.active !== false)
		.filter((entry) => Date.parse(entry.fetchedAt ?? "") > blockedAt)
		.map((entry) => immediateCapacity(entry, now));
	if (observed.includes(true)) return true;
	if (observed.length && observed.every((capacity) => capacity === false)) return false;
	return undefined;
}

export function chooseRoute(entries: QuotaEntry[], options: { currentProvider?: string; taskMinutes?: number; blockedAfter?: Record<string, number> } = {}): RouteChoice | undefined {
	const hours = Math.max(0, options.taskMinutes ?? 60) / 60;
	const now = Date.now();
	const candidates = entries
		.filter((entry) => immediateCapacity(entry, now) === true)
		.filter((entry) => Date.parse(entry.fetchedAt as string) > (options.blockedAfter?.[entry.provider] ?? 0))
		.map((entry) => {
			const projected = (entry.remainingPercent as number) - (entry.burnPercentPerHour ?? 0) * hours * 1.2;
			const weekly = weeklyWindow(entry);
			const hoursToWeeklyReset = weekly?.resetsAt ? (Date.parse(weekly.resetsAt) - now) / 3_600_000 : 0;
			const weeklyPressure = weekly && hoursToWeeklyReset > 0 ? (100 - weekly.usedPercent) / hoursToWeeklyReset : 0;
			return { entry, projected, weeklyPressure };
		});
	if (!candidates.length) return undefined;

	const maxWeeklyPressure = Math.max(...candidates.map(({ weeklyPressure }) => weeklyPressure));
	const pressureFloor = maxWeeklyPressure * (1 - WEEKLY_PRESSURE_HYSTERESIS);
	const paced = maxWeeklyPressure > 0 ? candidates.filter(({ weeklyPressure }) => weeklyPressure >= pressureFloor) : candidates;
	const reserved = paced.filter(({ projected }) => projected >= RESERVE_PERCENT);
	const headroomPool = reserved.length ? reserved : paced;
	const best = [...headroomPool].sort((a, b) => b.projected - a.projected)[0];
	const current = headroomPool.find(({ entry }) => entry.provider === options.currentProvider);
	const selected = current && best.projected - current.projected < HYSTERESIS_PERCENT ? current : best;
	const currentCandidate = candidates.find(({ entry }) => entry.provider === options.currentProvider);
	const expiryDriven = !currentCandidate
		? selected.weeklyPressure > 0 && paced.length < candidates.length
		: selected.entry.provider !== currentCandidate.entry.provider && selected.weeklyPressure > currentCandidate.weeklyPressure * (1 + WEEKLY_PRESSURE_HYSTERESIS);
	return {
		provider: selected.entry.provider,
		account: selected.entry.account,
		projectedRemainingPercent: Number(selected.projected.toFixed(2)),
		reason: expiryDriven ? "weekly expiry" : "quota headroom",
	};
}


