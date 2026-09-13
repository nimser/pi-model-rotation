/**
 * Provider error messages that mean "this plan is spent", and the wait they sometimes name.
 *
 * Plans announce exhaustion in prose, not in status codes: a ChatGPT plan out of
 * credit arrives as an SSE error inside a 200 response ("Codex error: The usage
 * limit has been reached"), never as a 429.
 */

/** A full context window is a prompt problem; rotating on it would block a healthy plan. */
const CONTEXT_RE = /context (window|length|limit)|maximum context|prompt is too long|input (is )?too long|too many tokens|maximum.{0,20}tokens/i;

const EXHAUSTED_RE = new RegExp(
	[
		"rate.?limit",
		"rate_limit_exceeded",
		"quota",
		"\\b429\\b",
		"too many requests",
		"overloaded",
		"usage.?limit",
		"usage_limit_reached",
		"usage_not_included",
		"insufficient.?(credit|quota|balance|funds)",
		"(out of|no|not enough|zero).{0,12}(credit|balance|token budget)",
		"credit balance",
		"(usage|plan|billing|spend|spending|account|monthly|weekly|daily|hourly)[^.]{0,40}limit",
		"limit (has been |been |was )?(reached|exceeded|hit)",
		"limit reached",
		"reached your .{0,40}limit",
		"exceeded your current",
		"upgrade (your plan|to)",
	].join("|"),
	"i",
);

export function isRateLimitMessage(message: string | undefined): boolean {
	if (!message) return false;
	if (CONTEXT_RE.test(message)) return false;
	return EXHAUSTED_RE.test(message);
}

const UNIT_SECONDS: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600 };

/** The wait a provider names in prose ("Try again in ~14 min"), in seconds. */
export function retryAfterSecondsFromMessage(message: string | undefined): number | undefined {
	if (!message) return undefined;
	const match = /(?:try again|retry|resets?|available again)[^0-9]{0,20}~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh])\b/i.exec(message);
	if (!match) return undefined;
	const seconds = Number(match[1]) * (UNIT_SECONDS[match[2].toLowerCase()] ?? 0);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
