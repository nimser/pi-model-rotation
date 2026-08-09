/**
 * model-rotation — keep an unattended run alive across rate limits.
 *
 * Default chain:
 *   anthropic/claude-opus-5 (high)  →  openai-codex/gpt-5.6-sol (high)
 *                                   →  opencode-go/kimi-k3 (max)
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
 *   { "chain": [{ "provider": "...", "model": "...", "thinking": "high" }],
 *     "cooldownMs": { "anthropic": 300000, "default": 900000 },
 *     "maxResumesPerSession": 5, "autoResume": true }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseRoute, readQuotas } from "../src/quota.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ChainEntry {
	provider: string;
	model: string;
	thinking?: ThinkingLevel;
}

interface RotationConfig {
	chain: ChainEntry[];
	cooldownMs: Record<string, number>;
	maxResumesPerSession: number;
	autoResume: boolean;
	rotateOnStatus: number[];
}

const FORBIDDEN_PROVIDERS = ["openrouter"];

const DEFAULT_CONFIG: RotationConfig = {
	chain: [
		{ provider: "anthropic", model: "claude-opus-5", thinking: "high" },
		{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
		{ provider: "opencode-go", model: "kimi-k3", thinking: "max" },
	],
	cooldownMs: { anthropic: 5 * 60_000, default: 15 * 60_000 },
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
			return {
				...DEFAULT_CONFIG,
				...parsed,
				cooldownMs: { ...DEFAULT_CONFIG.cooldownMs, ...(parsed.cooldownMs ?? {}) },
				chain: parsed.chain?.length ? parsed.chain : DEFAULT_CONFIG.chain,
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

const installed = ((globalThis as any).__nimserModelRotation ??= new WeakSet<object>()) as WeakSet<object>;

export default function modelRotation(pi: ExtensionAPI) {
	if (installed.has(pi as object)) return;
	installed.add(pi as object);
	let config = DEFAULT_CONFIG;
	let chain: ChainEntry[] = DEFAULT_CONFIG.chain;
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
		if (ctx.hasUI) ctx.ui.setStatus("model-rotation", `rotation: ${enabled ? "on" : "off"}`);
	}

	function restoreEnabled(ctx: ExtensionContext): void {
		enabled = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "model-rotation-state") continue;
			const value = (entry.data as { enabled?: unknown } | undefined)?.enabled;
			if (typeof value === "boolean") enabled = value;
		}
	}

	function cooldownFor(provider: string, retryAfterSeconds?: number): number {
		if (retryAfterSeconds && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
			return Math.min(retryAfterSeconds * 1000, 60 * 60_000);
		}
		return config.cooldownMs[provider] ?? config.cooldownMs.default ?? 15 * 60_000;
	}

	function indexOfCurrent(ctx: ExtensionContext): number {
		const current = ctx.model;
		if (!current) return -1;
		return chain.findIndex((entry) => entry.provider === current.provider && entry.model === current.id);
	}

	function available(entry: ChainEntry, now: number): boolean {
		const until = cooldownUntil.get(key(entry.provider, entry.model)) ?? 0;
		return until <= now;
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
		if (entry.thinking) pi.setThinkingLevel(entry.thinking);
		lastRotationAt = Date.now();
		pi.appendEntry("model-rotation", {
			to: key(entry.provider, entry.model),
			thinking: entry.thinking ?? null,
			reason,
			at: new Date().toISOString(),
		});
		if (ctx.hasUI) ctx.ui.notify(`model-rotation → ${key(entry.provider, entry.model)} (${reason})`, "warning");
		console.error(`[model-rotation] → ${key(entry.provider, entry.model)} (${reason})`);
		return true;
	}

	/** Mark the active model as limited and move to the next usable hop. */
	async function rotate(ctx: ExtensionContext, reason: string, retryAfterSeconds?: number): Promise<boolean> {
		const now = Date.now();
		// Debounce: several handlers can observe the same 429.
		if (now - lastRotationAt < 2000) return false;

		const current = ctx.model;
		const currentIndex = indexOfCurrent(ctx);
		if (current) {
			cooldownUntil.set(key(current.provider, current.id), now + cooldownFor(current.provider, retryAfterSeconds));
			blockedAfter[current.provider] = now;
		}

		const order = currentIndex >= 0 ? [...chain.slice(currentIndex + 1), ...chain.slice(0, currentIndex)] : chain;
		for (const entry of order) {
			if (!available(entry, now)) continue;
			if (current && entry.provider === current.provider && entry.model === current.id) continue;
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
		restoreEnabled(ctx);
		chain = config.chain.filter((entry) => {
			if (FORBIDDEN_PROVIDERS.includes(entry.provider)) {
				console.error(`[model-rotation] dropping forbidden provider from chain: ${entry.provider}`);
				return false;
			}
			return true;
		});
		if (chain.length < 2) console.error("[model-rotation] chain has fewer than 2 usable hops");
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
		if (!enabled) return;
		const message = event.message as { role: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant" || message.stopReason !== "error") return;
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
			const choice = chooseRoute(quotas, {
				currentProvider: ctx.model?.provider,
				taskMinutes: Number(process.env.MODEL_ROTATION_TASK_MINUTES ?? process.env.METAGROWTH_BUDGET_MINUTES ?? 60),
				blockedAfter,
			});
			if (!choice || choice.provider === ctx.model?.provider) return;
			const target = chain.find((entry) => entry.provider === choice.provider);
			if (target) await switchTo(target, ctx, choice.reason);
		} catch (error) {
			console.error(`[model-rotation] quota preflight unavailable: ${(error as Error).message}`);
		}
	});

	pi.registerCommand("rotation-toggle", {
		description: "Enable or disable model rotation for this session",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			pendingResume = undefined;
			pi.appendEntry("model-rotation-state", { enabled });
			updateStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(`model rotation ${enabled ? "enabled" : "disabled"}`, enabled ? "info" : "warning");
			else console.error(`[model-rotation] ${enabled ? "enabled" : "disabled"}`);
		},
	});

	pi.registerCommand("rotation", {
		description: "Show subscription quota and routing state",
		handler: async (_args, ctx) => {
			const quotas = await readQuotas();
			const lines = quotas.map((entry) => {
				const active = entry.active ? "→" : " ";
				const quota = entry.reachable
					? `${entry.remainingPercent?.toFixed(1)}% left · reset ${entry.resetsAt} · burn ${entry.burnPercentPerHour ?? 0}%/h`
					: `unknown · ${entry.reason}`;
				const line = `${active} ${entry.provider}/${entry.account} · ${quota}`;
				return entry.active && ctx.hasUI ? ctx.ui.theme.bold(line) : line;
			});
			lines.push(`state: ${enabled ? "on" : "off"} · rotations: ${rotations} · resumes: ${resumes}/${config.maxResumesPerSession}`);
			if (ctx.hasUI) ctx.ui.setWidget("model-rotation", lines);
			else console.error(lines.join("\n"));
		},
	});

	pi.on("session_shutdown", () => installed.delete(pi as object));
}
