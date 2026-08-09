/**
 * OpenCode Go usage, read from the workspace page that serves it.
 *
 * The Zen/Go API key buys inference and nothing else: no usage route answers it.
 * The subscription's own numbers ride in the hydration payload of
 * `/workspace/<id>/go`, which needs the browser session cookie of a signed-in
 * account. Server-function ids are content hashes that change on every deploy,
 * so the page itself is the stable surface.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, envPath, textRequest } from "./http.ts";

interface Session {
	cookie: string;
	workspace?: string;
}

export interface GoWindow {
	usedPercent: number;
	resetsInSeconds: number;
}

export function opencodeUrl(): string {
	return (process.env.MODEL_ROTATION_OPENCODE_URL ?? "https://opencode.ai").replace(/\/+$/, "");
}

export function opencodeAuthPath(): string {
	return envPath("MODEL_ROTATION_OPENCODE_AUTH", join(agentDir(), "model-rotation-opencode.json"));
}

function writeSession(value: Session): Session {
	const path = opencodeAuthPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	return value;
}

function readSession(): Session {
	const value = JSON.parse(readFileSync(opencodeAuthPath(), "utf8")) as Session;
	if (typeof value?.cookie !== "string" || !value.cookie) throw new Error("opencode session cookie is unusable");
	return value;
}

/** Stores the `auth` cookie of a signed-in opencode.ai browser session. */
export function saveSession(cookie: string): string {
	const trimmed = cookie.trim().replace(/^auth=/, "");
	if (!trimmed) throw new Error("no cookie value given");
	writeSession({ cookie: trimmed });
	return opencodeAuthPath();
}

async function page(path: string, cookie: string): Promise<string> {
	return await textRequest(`${opencodeUrl()}${path}`, { Cookie: `auth=${cookie}` });
}

/** Any signed-in page carries the workspace id; it is stable, so it is stored. */
async function workspaceId(session: Session): Promise<string> {
	const configured = process.env.MODEL_ROTATION_OPENCODE_WORKSPACE ?? session.workspace;
	if (configured) return configured;
	const id = /wrk_[A-Z0-9]+/.exec(await page("/go/", session.cookie))?.[0];
	if (!id) throw new Error("opencode session is signed out or has no workspace");
	writeSession({ ...session, workspace: id });
	return id;
}

const WINDOWS = { rolling: "rollingUsage", weekly: "weeklyUsage", monthly: "monthlyUsage" } as const;

/** Reads the three Go meters; `monthlyUsage` also names a billing field, so parse from the rolling anchor on. */
export async function fetchGoUsage(): Promise<Partial<Record<keyof typeof WINDOWS, GoWindow>>> {
	const session = readSession();
	const html = await page(`/workspace/${await workspaceId(session)}/go`, session.cookie);
	const anchor = html.indexOf(`${WINDOWS.rolling}:`);
	if (anchor < 0) throw new Error("opencode workspace page carried no Go meters");
	const block = html.slice(anchor, anchor + 800);
	const windows: Partial<Record<keyof typeof WINDOWS, GoWindow>> = {};
	for (const [name, field] of Object.entries(WINDOWS) as [keyof typeof WINDOWS, string][]) {
		const match = new RegExp(`${field}:[^{]*\\{status:"(\\w+)",resetInSec:(\\d+),usagePercent:(\\d+)`).exec(block);
		if (match?.[1] === "ok") windows[name] = { usedPercent: Number(match[3]), resetsInSeconds: Number(match[2]) };
	}
	return windows;
}
