/**
 * model-rotation — keep an unattended run alive across rate limits.
 *
 * Two modes, switched by hand and never by the router:
 *   frontier  anthropic/claude-opus-5 → openai-codex/gpt-5.6-sol → opencode-go/kimi-k3
 *   casual    openai-codex/gpt-5.6-luna → opencode-go/gpt-5.6-luna
 *
 * opencode-go is the last resort of its mode: it is picked only once every other
 * hop is out of quota or cooling down from a 429. A 429 on Go while the OpenAI
 * plan is also spent drops casual back to frontier; nothing ever promotes
 * frontier to casual.
 *
 * Effort travels as one ladder held on the Anthropic scale. gpt-5.6-sol runs one
 * notch above claude-opus-5, so opus medium ≡ sol high, opus high ≡ sol xhigh,
 * opus xhigh ≡ sol max, and a manual change is read back before every switch.
 * Entering a mode resets the ladder to that mode's default; rotating inside a
 * mode carries it.
 *
 * Rules baked in by decision:
 *   - cached quota forecasts choose the route before a provider request
 *   - rotate on the FIRST 429 as a backstop, no N-in-a-window threshold
 *   - a fixed cooldown never proves recovery; only a newer quota sample does
 *   - openrouter is never a rotation target, for any model
 *
 * Three layers, because a 429 can surface in three places:
 *   1. after_provider_response  → HTTP 429 seen before the stream is consumed
 *      VERIFIED on pi 0.83.0: this hook does NOT fire for non-2xx responses
 *      (neither openai-completions nor anthropic-messages). Kept because it is
 *      free and the docs advertise it; layers 2+3 are what actually fire.
 *   2. message_end              → assistant message with stopReason "error"
 *                                 and a rate-limit-ish errorMessage
 *   3. agent_settled            → the run died on an error; trigger one hidden,
 *                                 entry-bound extension continuation
 *
 * Config (optional): ~/.pi/agent/model-rotation.json or <cwd>/.pi/model-rotation.json
 *   { "modes": { "casual": { "chain": [...] } },
 *     "cooldownMs": { "anthropic": 300000, "default": 900000 },
 *     "maxResumesPerSession": 5, "autoResume": true }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseRoute, readQuotas } from "../src/quota.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Mode = "frontier" | "casual";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface ChainEntry {
	provider: string;
	model: string;
	/** Notches above the ladder, which is held on the Anthropic scale. */
	effortOffset?: number;
	/** Set when the hop ignores the ladder and always runs at one level. */
	fixedThinking?: ThinkingLevel;
	/** Picked only when every other hop of the mode is exhausted. */
	lastResort?: boolean;
}

interface ModeConfig {
	ladder: ThinkingLevel;
	chain: ChainEntry[];
}

interface RotationConfig {
	modes: Record<Mode, ModeConfig>;
	cooldownMs: Record<string, number>;
	maxResumesPerSession: number;
	autoResume: boolean;
	rotateOnStatus: number[];
}

const FORBIDDEN_PROVIDERS = ["openrouter"];

const DEFAULT_CONFIG: RotationConfig = {
	modes: {
		frontier: {
			ladder: "medium",
			chain: [
				{ provider: "anthropic", model: "claude-opus-5" },
				{ provider: "openai-codex", model: "gpt-5.6-sol", effortOffset: 1 },
				{ provider: "opencode-go", model: "kimi-k3", fixedThinking: "max", lastResort: true },
			],
		},
		casual: {
			ladder: "xhigh",
			chain: [
				{ provider: "openai-codex", model: "gpt-5.6-luna" },
				{ provider: "opencode-go", model: "gpt-5.6-luna", lastResort: true },
			],
		},
	},
	// Go's shortest window is five rolling hours, so a minute-scale retry only buys another 429.
	cooldownMs: { anthropic: 5 * 60_000, "opencode-go": 5 * 3_600_000, default: 15 * 60_000 },
	maxResumesPerSession: 5,
	autoResume: true,
	rotateOnStatus: [429],
};

const RATE_LIMIT_RE = /rate.?limit|quota|429|too many requests|overloaded|insufficient.?(credit|quota|balance)/i;

function loadConfig(cwd: string): RotationConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const candidates = [join(cwd, ".pi", "model-rotation.json"), join(agentDir, "model-rotation.json")];
	for (const path of candidates) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RotationConfig>;
			const modes = { ...DEFAULT_CONFIG.modes };
			for (const name of Object.keys(modes) as Mode[]) {
				const override = parsed.modes?.[name];
				if (override) modes[name] = { ladder: override.ladder ?? modes[name].ladder, chain: override.chain?.length ? override.chain : modes[name].chain };
			}
			return {
				...DEFAULT_CONFIG,
				...parsed,
				modes,
				cooldownMs: { ...DEFAULT_CONFIG.cooldownMs, ...(parsed.cooldownMs ?? {}) },
			};
		} catch {
			// missing or unreadable config: try the next candidate
		}
	}
	return DEFAULT_CONFIG;
}

function key(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function shift(level: ThinkingLevel, notches: number): ThinkingLevel {
	return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + notches))];
}

const installed = ((globalThis as any).__nimserModelRotation ??= new WeakSet<object>()) as WeakSet<object>;

export default function modelRotation(pi: ExtensionAPI) {
	if (installed.has(pi as object)) return;
	installed.add(pi as object);
	let config = DEFAULT_CONFIG;
	let mode: Mode = "frontier";
	let chain: ChainEntry[] = DEFAULT_CONFIG.modes.frontier.chain;
	/** Effort on the Anthropic scale; each hop renders it through its own offset. */
	let ladder: ThinkingLevel = DEFAULT_CONFIG.modes.frontier.ladder;
	let enabled = true;
	/** key -> epoch ms until which the entry is considered rate limited */
	const cooldownUntil = new Map<string, number>();
	let rotations = 0;
	let resumes = 0;
	/** Bound to the exact post-rotation leaf so a later successful turn cancels it. */
	let pendingResume: { leaf: string | undefined; to: string } | undefined;
	let lastRotationAt = 0;
	const blockedAfter: Record<string, number> = {};

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus("model-rotation", `rotation: ${enabled ? mode : "off"}`);
	}

	function restoreState(ctx: ExtensionContext): void {
		enabled = true;
		mode = "frontier";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "model-rotation-state") continue;
			const data = entry.data as { enabled?: unknown; mode?: unknown } | undefined;
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
			if (data?.mode === "frontier" || data?.mode === "casual") mode = data.mode;
		}
		chain = usableChain(mode);
		ladder = config.modes[mode].ladder;
	}

	function usableChain(name: Mode): ChainEntry[] {
		const usable = config.modes[name].chain.filter((entry) => {
			if (FORBIDDEN_PROVIDERS.includes(entry.provider)) {
				console.error(`[model-rotation] dropping forbidden provider from chain: ${entry.provider}`);
				return false;
			}
			return true;
		});
		if (usable.length < 2) console.error(`[model-rotation] ${name} chain has fewer than 2 usable hops`);
		return usable;
	}

	function thinkingFor(entry: ChainEntry): ThinkingLevel {
		return entry.fixedThinking ?? shift(ladder, entry.effortOffset ?? 0);
	}

	/** Reads a manual effort change back onto the ladder before it is carried to another hop. */
	function syncLadder(ctx: ExtensionContext): void {
		const current = chain.find((entry) => entry.provider === ctx.model?.provider && entry.model === ctx.model?.id);
		const level = ctx.thinkingLevel as ThinkingLevel | undefined;
		if (!current || current.fixedThinking || !level || !LEVELS.includes(level)) return;
		ladder = shift(level, -(current.effortOffset ?? 0));
	}

	function cooldownFor(provider: string, retryAfterSeconds?: number): number {
		// A plan that names its own reset is believed, up to a day; anything longer is a bug, not a window.
		if (retryAfterSeconds && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
			return Math.min(retryAfterSeconds * 1000, 24 * 3_600_000);
		}
		return config.cooldownMs[provider] ?? config.cooldownMs.default ?? 15 * 60_000;
	}

	function indexOfCurrent(ctx: ExtensionContext): number {
		const current = ctx.model;
		if (!current) return -1;
		return chain.findIndex((entry) => entry.provider === current.provider && entry.model === current.id);
	}

	/** A 429 is a plan verdict, not a model verdict: the whole provider cools down with the hop. */
	function block(provider: string, model: string, until: number): void {
		cooldownUntil.set(key(provider, model), until);
		cooldownUntil.set(key(provider, "*"), until);
	}

	function available(entry: ChainEntry, now: number): boolean {
		return (cooldownUntil.get(key(entry.provider, entry.model)) ?? 0) <= now && (cooldownUntil.get(key(entry.provider, "*")) ?? 0) <= now;
	}

	async function switchTo(entry: ChainEntry, ctx: ExtensionContext, reason: string): Promise<boolean> {
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) {
			console.error(`[model-rotation] ${key(entry.provider, entry.model)} not in registry`);
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			console.error(`[model-rotation] no credentials for ${key(entry.provider, entry.model)}`);
			cooldownUntil.set(key(entry.provider, entry.model), Date.now() + cooldownFor(entry.provider));
			return false;
		}
		const thinking = thinkingFor(entry);
		pi.setThinkingLevel(thinking);
		lastRotationAt = Date.now();
		pi.appendEntry("model-rotation", {
			to: key(entry.provider, entry.model),
			thinking,
			mode,
			reason,
			at: new Date().toISOString(),
		});
		if (ctx.hasUI) ctx.ui.notify(`model-rotation → ${key(entry.provider, entry.model)}:${thinking} (${reason})`, "warning");
		console.error(`[model-rotation] → ${key(entry.provider, entry.model)}:${thinking} (${reason})`);
		return true;
	}

	function setMode(next: Mode, ctx: ExtensionContext): void {
		if (next !== mode) ladder = config.modes[next].ladder;
		mode = next;
		chain = usableChain(next);
		pi.appendEntry("model-rotation-state", { enabled, mode });
		updateStatus(ctx);
	}

	/** Hops of the mode in preference order: the last resort trails everything else. */
	function hops(now: number, skip?: ChainEntry): { normal: ChainEntry[]; lastResort: ChainEntry[] } {
		const usable = chain.filter((entry) => entry !== skip && available(entry, now));
		return { normal: usable.filter((entry) => !entry.lastResort), lastResort: usable.filter((entry) => entry.lastResort) };
	}

	/** Mark the active model as limited and move to the next usable hop. */
	async function rotate(ctx: ExtensionContext, reason: string, retryAfterSeconds?: number): Promise<boolean> {
		const now = Date.now();
		// Debounce: several handlers can observe the same 429.
		if (now - lastRotationAt < 2000) return false;
		syncLadder(ctx);

		const current = ctx.model;
		const currentEntry = chain[indexOfCurrent(ctx)];
		if (current) {
			block(current.provider, current.id, now + cooldownFor(current.provider, retryAfterSeconds));
			blockedAfter[current.provider] = now;
		}

		// Casual is a loan: spending its last resort while OpenAI is also out returns the session to frontier.
		if (mode === "casual" && currentEntry?.lastResort && !hops(now).normal.length) {
			setMode("frontier", ctx);
			console.error("[model-rotation] casual exhausted → frontier");
			if (ctx.hasUI) ctx.ui.notify("model-rotation: casual exhausted → frontier", "warning");
		}

		const { normal, lastResort } = hops(now, currentEntry);
		for (const entry of [...normal, ...lastResort]) {
			if (await switchTo(entry, ctx, reason)) {
				rotations += 1;
				pendingResume = config.autoResume ? { leaf: ctx.sessionManager.getLeafId(), to: key(entry.provider, entry.model) } : undefined;
				return true;
			}
		}
		console.error("[model-rotation] every hop in the chain is cooling down or unusable");
		if (ctx.hasUI) ctx.ui.notify("model-rotation: no usable model left in the chain", "error");
		return false;
	}

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		restoreState(ctx);
		updateStatus(ctx);
	});

	// Layer 1: the HTTP status, seen before pi consumes the stream.
	pi.on("after_provider_response", async (event, ctx) => {
		if (!enabled || !config.rotateOnStatus.includes(event.status)) return;
		const retryAfter = Number(event.headers?.["retry-after"] ?? event.headers?.["Retry-After"]);
		await rotate(ctx, "rate limited", Number.isFinite(retryAfter) ? retryAfter : undefined);
	});

	// Layer 2: the error surfaced as a finished assistant message.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role: string; stopReason?: string; errorMessage?: string };
		if (!enabled || message.role !== "assistant" || message.stopReason !== "error") return;
		if (!RATE_LIMIT_RE.test(message.errorMessage ?? "")) return;
		await rotate(ctx, "rate limited");
	});

	// Layer 3: the run stopped; resume it on the new model.
	pi.on("input", (event) => {
		if (event.source !== "extension") pendingResume = undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled) {
			pendingResume = undefined;
			return;
		}
		const resume = pendingResume;
		pendingResume = undefined;
		if (!resume || !config.autoResume) return;
		if (ctx.sessionManager.getLeafId() !== resume.leaf) {
			console.error("[model-rotation] stale resume cancelled because the session advanced");
			return;
		}
		if (resumes >= config.maxResumesPerSession) {
			console.error(`[model-rotation] resume budget exhausted (${resumes})`);
			if (ctx.hasUI) ctx.ui.notify("model-rotation: resume budget exhausted", "error");
			return;
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		resumes += 1;
		console.error(`[model-rotation] resuming on ${resume.to} (resume ${resumes})`);
		pi.sendMessage(
			{ customType: "model-rotation-resume", content: `Resume the interrupted task on ${resume.to} from the existing session state.`, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!enabled || indexOfCurrent(ctx) < 0) return;
		try {
			const quotas = await readQuotas();
			const now = Date.now();
			const { normal, lastResort } = hops(now);
			const options = {
				currentProvider: ctx.model?.provider,
				taskMinutes: Number(process.env.MODEL_ROTATION_TASK_MINUTES ?? process.env.METAGROWTH_BUDGET_MINUTES ?? 60),
				blockedAfter,
			};
			const normalProviders = new Set(normal.map((entry) => entry.provider));
			let choice = chooseRoute(quotas.filter((entry) => normalProviders.has(entry.provider)), options);
			let target = choice && normal.find((entry) => entry.provider === choice?.provider);
			// The last resort waits for proof, not for silence: every other hop must answer and be spent.
			if (!target && lastResort.length) {
				const spent = chain
					.filter((entry) => !entry.lastResort)
					.every((entry) => !available(entry, now) || quotas.some((quota) => quota.provider === entry.provider && quota.reachable));
				if (spent) {
					target = lastResort[0];
					choice = { provider: target.provider, account: "", projectedRemainingPercent: 0, reason: "last resort" };
				}
			}
			if (!target || !choice || (target.provider === ctx.model?.provider && target.model === ctx.model?.id)) return;
			syncLadder(ctx);
			await switchTo(target, ctx, choice.reason);
		} catch (error) {
			console.error(`[model-rotation] quota preflight unavailable: ${(error as Error).message}`);
		}
	});

	pi.registerCommand("rotation-toggle", {
		description: "Enable or disable model rotation for this session",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			pendingResume = undefined;
			pi.appendEntry("model-rotation-state", { enabled, mode });
			updateStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(`model rotation ${enabled ? "enabled" : "disabled"}`, enabled ? "info" : "warning");
			else console.error(`[model-rotation] ${enabled ? "enabled" : "disabled"}`);
		},
	});

	pi.registerCommand("rotation", {
		description: "Show quota and routing state, or switch mode: /rotation [frontier|casual]",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested === "frontier" || requested === "casual") {
				setMode(requested as Mode, ctx);
				const now = Date.now();
				const { normal, lastResort } = hops(now);
				const target = [...normal, ...lastResort][0];
				if (target) await switchTo(target, ctx, `${requested} mode`);
				return;
			}
			if (requested) {
				const message = `unknown mode "${requested}"; use frontier or casual`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else console.error(message);
				return;
			}
			const quotas = await readQuotas();
			const lines = quotas.map((entry) => {
				const active = entry.active ? "→" : " ";
				const quota = entry.reachable
					? `${entry.remainingPercent?.toFixed(1)}% left · reset ${entry.resetsAt} · burn ${entry.burnPercentPerHour ?? 0}%/h`
					: `unknown · ${entry.reason}`;
				const line = `${active} ${entry.provider}/${entry.account} · ${quota}`;
				return entry.active && ctx.hasUI ? ctx.ui.theme.bold(line) : line;
			});
			lines.push(`mode: ${mode} · effort: ${ladder} · state: ${enabled ? "on" : "off"} · rotations: ${rotations} · resumes: ${resumes}/${config.maxResumesPerSession}`);
			if (ctx.hasUI) ctx.ui.setWidget("model-rotation", lines);
			else console.error(lines.join("\n"));
		},
	});

	pi.on("session_shutdown", () => installed.delete(pi as object));
}
