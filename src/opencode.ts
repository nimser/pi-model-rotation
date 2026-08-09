/** OpenCode console credentials: device-code login, token refresh, Go meter read. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, envPath, jsonRequest } from "./http.ts";

const CLIENT_ID = "console";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface TokenStore {
	access: string;
	refresh: string;
	expires: number;
	org?: string;
}

export interface DeviceCode {
	userCode: string;
	verificationUrl: string;
	expiresAt: number;
	intervalMs: number;
	deviceCode: string;
}

export function consoleUrl(): string {
	return (process.env.MODEL_ROTATION_OPENCODE_CONSOLE_URL ?? "https://console.opencode.ai").replace(/\/+$/, "");
}

export function opencodeAuthPath(): string {
	return envPath("MODEL_ROTATION_OPENCODE_AUTH", join(agentDir(), "model-rotation-opencode.json"));
}

function writeStore(value: TokenStore): TokenStore {
	const path = opencodeAuthPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	return value;
}

function readStore(): TokenStore {
	const value = JSON.parse(readFileSync(opencodeAuthPath(), "utf8")) as TokenStore;
	if (typeof value?.refresh !== "string" || !value.refresh) throw new Error("opencode console credential is unusable");
	return value;
}

function fromTokenResponse(token: { access_token: string; refresh_token: string; expires_in: number }, org?: string): TokenStore {
	return { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000, ...(org ? { org } : {}) };
}

async function session(): Promise<TokenStore> {
	const current = readStore();
	if (typeof current.access === "string" && current.access && current.expires - 60_000 > Date.now()) return current;
	const token = await jsonRequest(`${consoleUrl()}/auth/device/token`, {}, { grant_type: "refresh_token", refresh_token: current.refresh, client_id: CLIENT_ID });
	if (typeof token?.access_token !== "string") throw new Error("opencode console refused the refresh token");
	return writeStore(fromTokenResponse(token, current.org));
}

/** Every console read is org-scoped; the id is stable, so it is stored with the tokens. */
async function orgId(current: TokenStore): Promise<string> {
	const configured = process.env.MODEL_ROTATION_OPENCODE_ORG ?? current.org;
	if (configured) return configured;
	const orgs = await jsonRequest(`${consoleUrl()}/api/orgs`, { Authorization: `Bearer ${current.access}` });
	const id = (Array.isArray(orgs) ? orgs : []).map((org) => org?.id).find((value) => typeof value === "string" && value);
	if (!id) throw new Error("opencode console account belongs to no organization");
	writeStore({ ...current, org: id });
	return id;
}

/** Raw `GET /api/go/status`: subscription state plus one meter per usage window. */
export async function fetchGoStatus(): Promise<any> {
	const current = await session();
	return await jsonRequest(`${consoleUrl()}/api/go/status`, { Authorization: `Bearer ${current.access}`, "x-org-id": await orgId(current) });
}

export async function requestDeviceCode(): Promise<DeviceCode> {
	const body = await jsonRequest(`${consoleUrl()}/auth/device/code`, {}, { client_id: CLIENT_ID });
	const complete = String(body?.verification_uri_complete ?? body?.verification_uri ?? "");
	if (typeof body?.device_code !== "string" || !complete) throw new Error("opencode console refused the device code request");
	return {
		deviceCode: body.device_code,
		userCode: String(body.user_code ?? ""),
		verificationUrl: complete.startsWith("http") ? complete : `${consoleUrl()}${complete}`,
		expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
		intervalMs: Math.max(1, Number(body.interval ?? 5)) * 1000,
	};
}

/** Polls until the user approves the code in a browser, then stores the tokens. */
export async function awaitDeviceApproval(code: DeviceCode): Promise<void> {
	while (Date.now() < code.expiresAt) {
		await new Promise((resolve) => setTimeout(resolve, code.intervalMs));
		try {
			const token = await jsonRequest(`${consoleUrl()}/auth/device/token`, {}, { grant_type: DEVICE_GRANT, device_code: code.deviceCode, client_id: CLIENT_ID });
			if (typeof token?.access_token === "string") {
				writeStore(fromTokenResponse(token));
				return;
			}
		} catch {
			/* authorization_pending answers with a 4xx until the user approves */
		}
	}
	throw new Error("opencode console device code expired before approval");
}
