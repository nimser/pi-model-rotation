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
	windows?: Record<string, { usedPercent: number; resetsAt: string }>;
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
	if (!Number.isFinite(number)) throw new Error("usage response omitted utilization");
	return Math.max(0, Math.min(100, number <= 1 ? number * 100 : number));
}

function iso(value: unknown): string {
	const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : String(value));
	if (!Number.isFinite(date.getTime())) throw new Error("usage response omitted reset instant");
	return date.toISOString();
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function activeAnthropicHash(): string | undefined {
	try {
		const file = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
		const token = file?.claudeAiOauth?.accessToken;
		return typeof token === "string" ? tokenHash(token) : undefined;
	} catch {
		return undefined;
	}
}

function cswapRoot(): string {
	return envPath("MODEL_ROTATION_CSWAP_DIR", join(homedir(), ".local", "share", "claude-swap"));
}

function anthropicCredentials(): { account: string; token: string; active: boolean }[] {
	const directory = join(cswapRoot(), "credentials");
	const active = activeAnthropicHash();
	const credentials: { account: string; token: string; active: boolean }[] = [];
	for (const name of readdirSync(directory).sort()) {
		const match = /^\.creds-(\d+)-.+\.enc$/.exec(name);
		if (!match) continue;
		try {
			const decoded = Buffer.from(readFileSync(join(directory, name), "utf8").trim(), "base64").toString("utf8");
			const file = JSON.parse(decoded);
			const token = file?.claudeAiOauth?.accessToken;
			if (typeof token === "string" && token) credentials.push({ account: `anthropic-${match[1]}`, token, active: tokenHash(token) === active });
		} catch {
			credentials.push({ account: `anthropic-${match[1]}`, token: "", active: false });
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
				five_hour: { usedPercent: percentage(good?.five_hour?.pct), resetsAt: iso(good?.five_hour?.resets_at) },
				seven_day: { usedPercent: percentage(good?.seven_day?.pct), resetsAt: iso(good?.seven_day?.resets_at) },
			};
			const limiting = Object.values(windows).sort((a, b) => b.usedPercent - a.usedPercent)[0];
			return [{
				provider: "anthropic",
				account: credential.account,
				reachable: true,
				active: credential.active,
				usedPercent: limiting.usedPercent,
				remainingPercent: 100 - limiting.usedPercent,
				resetsAt: limiting.resetsAt,
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
			five_hour: { usedPercent: percentage(body?.five_hour?.utilization), resetsAt: iso(body?.five_hour?.resets_at) },
			seven_day: { usedPercent: percentage(body?.seven_day?.utilization), resetsAt: iso(body?.seven_day?.resets_at) },
		};
		const limiting = Object.values(windows).sort((a, b) => b.usedPercent - a.usedPercent)[0];
		return {
			provider: "anthropic",
			account: credential.account,
			reachable: true,
			active: credential.active,
			usedPercent: limiting.usedPercent,
			remainingPercent: 100 - limiting.usedPercent,
			resetsAt: limiting.resetsAt,
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
		const window = body?.rate_limit?.primary_window;
		const usedPercent = percentage(window?.used_percent);
		const resetsAt = iso(window?.reset_at);
		return {
			provider: "openai-codex",
			account: "openai-codex-1",
			reachable: true,
			active: true,
			usedPercent,
			remainingPercent: 100 - usedPercent,
			resetsAt,
			fetchedAt: new Date().toISOString(),
			windows: { primary: { usedPercent, resetsAt } },
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
		const cached = cachedAnthropic(anthropic);
		const cachedAccounts = new Set(cached.map((entry) => entry.account));
		const raw = await Promise.all([
			...cached,
			...anthropic.filter((credential) => !cachedAccounts.has(credential.account)).map(pollAnthropic),
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

function weeklyWindow(entry: QuotaEntry): { usedPercent: number; resetsAt: string } | undefined {
	if (entry.provider === "anthropic") return entry.windows?.seven_day;
	if (entry.provider === "openai-codex") return entry.windows?.primary;
	return undefined;
}

export function chooseRoute(entries: QuotaEntry[], options: { currentProvider?: string; taskMinutes?: number; blockedAfter?: Record<string, number> } = {}): RouteChoice | undefined {
	const hours = Math.max(0, options.taskMinutes ?? 60) / 60;
	const now = Date.now();
	const candidates = entries
		.filter((entry) => entry.reachable && entry.active !== false && entry.remainingPercent !== undefined && entry.fetchedAt)
		.filter((entry) => Date.parse(entry.resetsAt ?? "") > now)
		.filter((entry) => Date.parse(entry.fetchedAt as string) > (options.blockedAfter?.[entry.provider] ?? 0))
		.map((entry) => {
			const projected = (entry.remainingPercent as number) - (entry.burnPercentPerHour ?? 0) * hours * 1.2;
			const weekly = weeklyWindow(entry);
			const hoursToWeeklyReset = weekly ? (Date.parse(weekly.resetsAt) - now) / 3_600_000 : 0;
			const weeklyPressure = weekly && hoursToWeeklyReset > 0 ? (100 - weekly.usedPercent) / hoursToWeeklyReset : 0;
			return { entry, projected, weeklyPressure };
		})
		.filter(({ projected, weeklyPressure }) => projected > 0 || weeklyPressure > 0);
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


