#!/usr/bin/env bash
# P0.1 DoD: a spent primary continues the same task on the next model, unattended and visibly.
# Case 1 is the openai-completions path, case 2 the anthropic-messages path, case 3 a spent
# plan that answers HTTP 200 and names the limit in the stream; every hop is local.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
port="${FAKE_PROVIDER_PORT:-8899}"
export FAKE_PROVIDER_PORT="$port"

node "$here/fake-provider.mjs" "$port" &
server_pid=$!
workdirs=()
cleanup() {
	kill "$server_pid" 2>/dev/null || true
	for d in "${workdirs[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done
}
trap cleanup EXIT

for _ in $(seq 1 50); do
	curl -sf "http://127.0.0.1:$port/_stats" >/dev/null && break
	sleep 0.1
done

fail=0

# expect: "answer" when pi retries the request itself, "resume" when only the queued
# continuation can carry the task — print mode never delivers extension follow-ups.
run_case() {
	local name="$1" provider="$2" model="$3" thinking="$4" extra_ext="$5" expect="${6:-answer}"
	local workdir out before after
	workdir="$(mktemp -d)"
	workdirs+=("$workdir")
	mkdir -p "$workdir/.pi"
	cat >"$workdir/.pi/model-rotation.json" <<JSON
{
  "modes": {
    "frontier": {
      "ladder": "$thinking",
      "chain": [
        { "provider": "$provider", "model": "$model" },
        { "provider": "fake-healthy", "model": "always-ok" }
      ]
    }
  },
  "cooldownMs": { "default": 600000 },
  "maxResumesPerSession": 2,
  "autoResume": true,
  "resumePrompt": "continue"
}
JSON
	out="$workdir/out.txt"
	before="$(curl -s "http://127.0.0.1:$port/_stats" | jq -r .healthy)"

	local -a cmd=(pi -p -ne --provider "$provider" --model "$model" --no-tools --no-session
		-e "$repo/extension/index.ts" -e "$here/fake-providers.ts")
	[ -n "$extra_ext" ] && cmd+=(-e "$extra_ext")
	cmd+=("Reply with the single word ROTATION_OK.")

	set +e
	(cd "$workdir" && PI_CODING_AGENT_DIR="$workdir/agent" PI_OFFLINE=1 timeout 180 "${cmd[@]}" >"$out" 2>&1)
	local status=$?
	set -e

	after="$(curl -s "http://127.0.0.1:$port/_stats" | jq -r .healthy)"
	echo "=== case: $name (exit $status) ==="
	cat "$out"

	grep -q "model-rotation. → fake-healthy/always-ok" "$out" || { echo "FAIL[$name]: rotation not logged"; fail=1; }
	if [ "$expect" = "resume" ]; then
		grep -q "resuming on fake-healthy/always-ok" "$out" || { echo "FAIL[$name]: no continuation queued on the new hop"; fail=1; }
		return
	fi
	grep -q "ROTATION_OK" "$out" || { echo "FAIL[$name]: no answer from the healthy hop"; fail=1; }
	[ "$after" -gt "$before" ] || { echo "FAIL[$name]: healthy hop never called"; fail=1; }
}

# Case 2 redirects the real anthropic provider at the always-429 endpoint.
cat >"/tmp/model-rotation-anthropic-429.$$.ts" <<'TS'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.registerProvider("anthropic", {
		baseUrl: `http://127.0.0.1:${process.env.FAKE_PROVIDER_PORT ?? 8899}/limited`,
		apiKey: "test-key",
		api: "anthropic-messages",
		models: [{
			id: "claude-haiku-4-5",
			name: "claude-haiku-4-5",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
TS
trap 'cleanup; rm -f "/tmp/model-rotation-anthropic-429.$$.ts"' EXIT

run_case "openai-completions path" fake-limited always-429 off ""
run_case "anthropic-messages path" anthropic claude-haiku-4-5 off "/tmp/model-rotation-anthropic-429.$$.ts"
run_case "spent plan inside a 200 stream" fake-spent always-spent off "" resume

if [ "$fail" -eq 0 ]; then
	echo "PASS: a 429 continues on the next hop; a spent-plan stream error rotates and queues the continuation"
else
	exit 1
fi
