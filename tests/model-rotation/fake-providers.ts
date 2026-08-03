/**
 * Registers the two fake providers served by fake-provider.mjs so the
 * model-rotation test never touches a real API.
 *
 * Port comes from FAKE_PROVIDER_PORT (default 8899).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const port = process.env.FAKE_PROVIDER_PORT ?? "8899";

const modelDefaults = {
	reasoning: false,
	input: ["text"] as const,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

export default function fakeProviders(pi: ExtensionAPI) {
	pi.registerProvider("fake-limited", {
		name: "Fake (always 429)",
		baseUrl: `http://127.0.0.1:${port}/limited/v1`,
		apiKey: "test-key",
		api: "openai-completions",
		models: [{ id: "always-429", name: "always-429", ...modelDefaults }],
	});

	pi.registerProvider("fake-healthy", {
		name: "Fake (healthy)",
		baseUrl: `http://127.0.0.1:${port}/healthy/v1`,
		apiKey: "test-key",
		api: "openai-completions",
		models: [{ id: "always-ok", name: "always-ok", ...modelDefaults }],
	});
}
