/**
 * OpenCode Go usage, accounted locally.
 *
 * Go publishes limits but no usage API, and the numbers the workspace page shows
 * need a browser session. What it does publish is enough to compute them: each
 * model carries a monthly allowance ($15 or $60), and the rolling five-hour and
 * calendar-week windows are 20 % and 50 % of it — verified against the request
 * estimates in the Go docs, which reproduce exactly.
 *
 * So a request consumes `cost / allowance` of the subscription, whichever model
 * served it, and every window is that share against its own fraction. The ledger
 * is only as complete as the traffic this shared agent home sees; a window that
 * began before the ledger did is reported as incomplete rather than as fact.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, envPath, textRequest } from "./http.ts";

const FIVE_HOURS_MS = 5 * 3_600_000;
const PRICING_TTL_MS = 7 * 24 * 3_600_000;
const KEEP_MS = 45 * 24 * 3_600_000;
const WINDOW_FRACTION = { rolling: 0.2, weekly: 0.5, period: 1 } as const;

export interface GoWindow {
	usedPercent: number;
	resetsAt: string;
	/** False when the window opened before the ledger did, so its start is unaccounted. */
	complete: boolean;
}

interface Price {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	allowance: number;
}

interface Sample {
	at: number;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function docsUrl(): string {
	return process.env.MODEL_ROTATION_GO_DOCS_URL ?? "https://opencode.ai/docs/go";
}

function ledgerPath(): string {
	return envPath("MODEL_ROTATION_GO_LEDGER", join(agentDir(), "cache", "model-rotation", "go-ledger.jsonl"));
}

function pricingPath(): string {
	return envPath("MODEL_ROTATION_GO_PRICING", join(agentDir(), "cache", "model-rotation", "go-pricing.json"));
}

function cells(row: string, tag: "td" | "th"): string[] {
	return [...row.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map(([, cell]) =>
		cell.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim(),
	);
}

function money(value: string): number {
	const parsed = Number(value.replace(/[$,]/g, ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

/** The docs carry the model ids in one table and prices plus allowance in another, joined by display name. */
export function parsePricing(html: string): Record<string, Price> {
	const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
	const ids: Record<string, string> = {};
	const prices: Record<string, Price> = {};
	for (const table of tables) {
		const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
		const header = cells(rows[0] ?? "", "th").map((cell) => cell.toLowerCase());
		for (const row of rows.slice(1)) {
			const cell = cells(row, "td");
			if (cell.length < header.length) continue;
			const name = cell[0].replace(/\s*\(.*$/, "");
			if (header[1] === "model id") ids[name] = cell[1];
			if (header.at(-1) === "usage" && !(name in prices)) {
				prices[name] = { input: money(cell[1]), output: money(cell[2]), cacheRead: money(cell[3]), cacheWrite: money(cell[4]), allowance: money(cell[5]) };
			}
		}
	}
	const table: Record<string, Price> = {};
	for (const [name, price] of Object.entries(prices)) if (ids[name] && price.allowance > 0) table[ids[name]] = price;
	return table;
}

async function pricing(): Promise<Record<string, Price>> {
	const path = pricingPath();
	try {
		const cached = JSON.parse(readFileSync(path, "utf8"));
		if (Date.now() - Date.parse(cached.fetchedAt) < PRICING_TTL_MS && Object.keys(cached.models ?? {}).length) return cached.models;
	} catch {
		/* no usable cache: fetch below */
	}
	let models: Record<string, Price> = {};
	try {
		models = parsePricing(await textRequest(docsUrl(), {}));
	} catch {
		models = {};
	}
	if (!Object.keys(models).length) {
		const stale = JSON.parse(readFileSync(path, "utf8")).models;
		if (!Object.keys(stale ?? {}).length) throw new Error("go pricing table is unavailable");
		return stale;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), models }, null, 2)}\n`, { mode: 0o600 });
	return models;
}

/** Appends one served request; token counts are stored raw so a price correction applies to history. */
export function recordGoUsage(model: string, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void {
	const sample: Sample = {
		at: Date.now(),
		model,
		input: Number(usage.input ?? 0),
		output: Number(usage.output ?? 0),
		cacheRead: Number(usage.cacheRead ?? 0),
		cacheWrite: Number(usage.cacheWrite ?? 0),
	};
	const path = ledgerPath();
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
}

function readSamples(): { samples: Sample[]; since: number } {
	const path = ledgerPath();
	let lines: string[] = [];
	let since = Date.now();
	try {
		lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		since = statSync(path).birthtimeMs || statSync(path).mtimeMs;
	} catch {
		return { samples: [], since };
	}
	const cutoff = Date.now() - KEEP_MS;
	const samples: Sample[] = [];
	let pruned = false;
	for (const line of lines) {
		try {
			const sample = JSON.parse(line) as Sample;
			if (!Number.isFinite(sample?.at)) continue;
			if (sample.at < cutoff) {
				pruned = true;
				continue;
			}
			samples.push(sample);
		} catch {
			pruned = true;
		}
	}
	if (pruned) {
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, samples.map((sample) => `${JSON.stringify(sample)}\n`).join(""), { mode: 0o600 });
		renameSync(temporary, path);
	}
	return { samples: samples.sort((a, b) => a.at - b.at), since: Math.min(since, samples[0]?.at ?? since) };
}

function share(sample: Sample, table: Record<string, Price>): number {
	const price = table[sample.model];
	if (!price) throw new Error(`go pricing is unknown for ${sample.model}`);
	const cost =
		(sample.input / 1e6) * price.input +
		(sample.output / 1e6) * price.output +
		(sample.cacheRead / 1e6) * price.cacheRead +
		(sample.cacheWrite / 1e6) * price.cacheWrite;
	return cost / price.allowance;
}

function weekStart(now: number): number {
	const date = new Date(now);
	const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - ((date.getUTCDay() + 6) % 7) * 86_400_000;
	return monday;
}

/** Renewal day of the subscription, from `goPeriodStart` in the rotation config. */
function configuredPeriodStart(): string | undefined {
	for (const path of [join(agentDir(), "model-rotation.json"), join(process.cwd(), ".pi", "model-rotation.json")]) {
		try {
			const value = JSON.parse(readFileSync(path, "utf8"))?.goPeriodStart;
			if (typeof value === "string" && value) return value;
		} catch {
			/* no config here: try the next candidate */
		}
	}
	return undefined;
}

/** The paid period runs from the subscription's renewal day, not the calendar month. */
function periodBounds(now: number): { start: number; end: number } {
	const configured = process.env.MODEL_ROTATION_GO_PERIOD_START ?? configuredPeriodStart();
	const anchor = configured ? Date.parse(configured) : Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
	if (!Number.isFinite(anchor)) throw new Error("go period start is not a date");
	const date = new Date(anchor);
	let start = anchor;
	let end = anchor;
	while (end <= now) {
		start = end;
		date.setUTCMonth(date.getUTCMonth() + 1);
		end = date.getTime();
	}
	return { start, end };
}

/** The rolling window opens on the first request after the previous one closed. */
function rollingBounds(samples: Sample[], now: number): { start: number; end: number } | undefined {
	let start: number | undefined;
	for (const sample of samples) {
		if (start === undefined || sample.at >= start + FIVE_HOURS_MS) start = sample.at;
	}
	return start !== undefined && now < start + FIVE_HOURS_MS ? { start, end: start + FIVE_HOURS_MS } : undefined;
}

export async function readGoWindows(): Promise<Record<keyof typeof WINDOW_FRACTION, GoWindow>> {
	const table = await pricing();
	const { samples, since } = readSamples();
	const now = Date.now();
	const rolling = rollingBounds(samples, now);
	const week = weekStart(now);
	const period = periodBounds(now);
	const bounds = {
		rolling: rolling ?? { start: now, end: now + FIVE_HOURS_MS },
		weekly: { start: week, end: week + 7 * 86_400_000 },
		period,
	};
	const windows = {} as Record<keyof typeof WINDOW_FRACTION, GoWindow>;
	for (const [name, fraction] of Object.entries(WINDOW_FRACTION) as [keyof typeof WINDOW_FRACTION, number][]) {
		const { start, end } = bounds[name];
		const used = samples.filter((sample) => sample.at >= start).reduce((total, sample) => total + share(sample, table), 0);
		windows[name] = {
			usedPercent: Math.max(0, Math.min(100, (used / fraction) * 100)),
			resetsAt: new Date(end).toISOString(),
			complete: since <= start,
		};
	}
	return windows;
}
