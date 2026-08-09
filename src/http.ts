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

export async function jsonRequest(url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(url, {
			method: body === undefined ? "GET" : "POST",
			headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}
