#!/usr/bin/env node
/** Exhaustion prose seen in the wild must rotate; prompt-shaped failures must not. */
import { isRateLimitMessage, retryAfterSecondsFromMessage } from "../../src/limits.ts";

const rotates = [
	"Codex error: The usage limit has been reached",
	"You have hit your ChatGPT usage limit (pro plan). Try again in ~14 min.",
	"You have hit your ChatGPT usage limit (plus plan).",
	"usage_limit_reached",
	"usage_not_included",
	"rate limit exceeded (fake)",
	"HTTP 429 Too Many Requests",
	"Request rate_limit_exceeded for model",
	"Your credit balance is too low to access the Anthropic API",
	"insufficient_quota: You exceeded your current quota, please check your plan and billing details",
	"You are out of credits. Upgrade your plan to continue.",
	"Overloaded",
	"You've reached your weekly limit for this model",
];

const ignores = [
	"prompt is too long: 290000 tokens > 272000 maximum",
	"Input is too long for requested model context window",
	"context length exceeded: maximum context is 200000 tokens",
	"tool call failed: ENOENT",
	"stream disconnected before completion",
	"invalid api key",
	undefined,
	"",
];

let failures = 0;
for (const message of rotates) {
	if (!isRateLimitMessage(message)) {
		console.error(`FAIL: should rotate on ${JSON.stringify(message)}`);
		failures += 1;
	}
}
for (const message of ignores) {
	if (isRateLimitMessage(message)) {
		console.error(`FAIL: should ignore ${JSON.stringify(message)}`);
		failures += 1;
	}
}

const waits: [string, number | undefined][] = [
	["You have hit your ChatGPT usage limit (pro plan). Try again in ~14 min.", 840],
	["Rate limited; try again in 30 seconds", 30],
	["quota exhausted, resets in 2 hours", 7200],
	["Codex error: The usage limit has been reached", undefined],
];
for (const [message, expected] of waits) {
	const actual = retryAfterSecondsFromMessage(message);
	if (actual !== expected) {
		console.error(`FAIL: ${JSON.stringify(message)} → ${actual}, expected ${expected}`);
		failures += 1;
	}
}

if (failures) process.exit(1);
console.log(`PASS: ${rotates.length + ignores.length + waits.length} limit-message cases`);
