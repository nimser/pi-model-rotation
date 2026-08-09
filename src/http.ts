/** Shared path resolution and redacted JSON fetching. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function envPath(name: string, fallback: string): string {
	return resolve(process.env[name] ?? fallback);
}

export function agentDir(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}

export function safeReason(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 240);
}

async function request(url: string, headers: Record<string, string>): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		return response;
	} finally {
		clearTimeout(timer);
	}
}

export async function jsonRequest(url: string, headers: Record<string, string>): Promise<any> {
	return await (await request(url, headers)).json();
}

/** Page bodies carry account details, so callers must never surface them in an error. */
export async function textRequest(url: string, headers: Record<string, string>): Promise<string> {
	return await (await request(url, headers)).text();
}
