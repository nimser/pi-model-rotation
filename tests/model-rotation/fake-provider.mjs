#!/usr/bin/env node
/**
 * Two fake OpenAI-completions endpoints used to prove model-rotation works
 * without burning real quota:
 *   /limited/v1/chat/completions → always HTTP 429 (retry-after: 1)
 *   /healthy/v1/chat/completions → valid SSE answer containing ROTATION_OK
 *
 * Usage: node fake-provider.mjs [port]   (default 8899)
 * Hit counts are readable at GET /_stats.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8899);
const stats = { limited: 0, healthy: 0 };

const server = createServer((req, res) => {
	if (req.url === "/_stats") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(stats));
		return;
	}

	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		if (req.url.startsWith("/limited")) {
			stats.limited += 1;
			res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
			res.end(JSON.stringify({ error: { message: "rate limit exceeded (fake)", type: "rate_limit_error" } }));
			return;
		}

		if (req.url.startsWith("/healthy")) {
			stats.healthy += 1;
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const base = { id: "fake-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "always-ok" };
			const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ROTATION_OK" }, finish_reason: null }] });
			send({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			});
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}

		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `no route for ${req.url}` } }));
	});
});

server.listen(port, "127.0.0.1", () => {
	console.error(`[fake-provider] listening on http://127.0.0.1:${port}`);
});
