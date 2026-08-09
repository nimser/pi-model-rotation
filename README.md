# pi-model-rotation

Private global pi package for quota-aware model rotation across the shared host and every devpod.

## Modes

| mode | chain | last resort |
|------|-------|-------------|
| `frontier` | `anthropic/claude-opus-5` → `openai-codex/gpt-5.6-sol` | `opencode-go/kimi-k3` |
| `casual` | `openai-codex/gpt-5.6-luna` | `opencode-go/gpt-5.6-luna` |

Switch with `/rotation frontier` or `/rotation casual`; the footer shows the
active mode. opencode-go is the last resort of its mode and is picked only once
every other hop is out of quota or cooling down from a 429. A 429 on Go while
the OpenAI plan is also spent drops casual back to frontier — nothing ever
promotes frontier to casual.

The extension paces weekly quotas toward their reset before comparing projected
headroom, while short windows remain capacity guards only. The first 429 is a
backstop. OpenRouter is never a rotation target.

`/rotation-toggle` disables or re-enables rotation for the current session;
the footer then shows `rotation: off`. `/rotation` with no argument shows quota
details and routing counters.

## Effort

Effort travels as one ladder held on the Anthropic scale, because gpt-5.6-sol
runs one notch above claude-opus-5:

| ladder | claude-opus-5 | gpt-5.6-sol |
|--------|---------------|-------------|
| medium | medium | high |
| high | high | xhigh |
| xhigh | xhigh | max |

Entering frontier sets the ladder to `medium`, entering casual sets it to
`xhigh`, and a manual change is read back before every switch, so rotating
inside a mode carries the level you last chose. `kimi-k3` always runs at `max`
and never moves the ladder.

## Install

```bash
pi install git:git@github.com:nimser/pi-model-rotation.git@v0.5.0
```

Pi stores the checkout and global package setting under the shared `~/.pi/agent/`, so host and devpods load the same pinned tag.

## Configuration

Optional global config: `~/.pi/agent/model-rotation.json`.
Optional project override: `.pi/model-rotation.json`.

```json
{
  "goPeriodStart": "2026-08-15T21:00:00Z",
  "modes": { "casual": { "ladder": "xhigh", "chain": [] } },
  "cooldownMs": { "anthropic": 300000, "default": 900000 },
  "maxResumesPerSession": 5,
  "autoResume": true
}
```

Environment overrides:

- `MODEL_ROTATION_TASK_MINUTES`
- `MODEL_ROTATION_QUOTA_CACHE`
- `MODEL_ROTATION_CSWAP_DIR`
- `MODEL_ROTATION_IGNORE_CSWAP_USAGE`
- `MODEL_ROTATION_ANTHROPIC_USAGE_URL`
- `MODEL_ROTATION_OPENAI_USAGE_URL`
- `MODEL_ROTATION_PI_AUTH`
- `MODEL_ROTATION_GO_DOCS_URL`
- `MODEL_ROTATION_GO_LEDGER`
- `MODEL_ROTATION_GO_PRICING`
- `MODEL_ROTATION_GO_PERIOD_START`

The default cache is shared at `~/.pi/agent/cache/model-rotation/quota.json`.

## OpenCode Go quota

Anthropic and OpenAI report usage over their own APIs. Go does not: the key buys
inference only, responses carry no rate-limit header, and the workspace page
that shows the meters needs a browser session. What Go publishes instead is
enough to compute them.

Each model carries a monthly allowance — $15 or $60 — and the rolling five-hour
and calendar-week windows are 20 % and 50 % of it. So a served request consumes
`cost / allowance` of the subscription, whichever model answered, and each
window is that share against its own fraction. Prices and allowances come from
the Go docs table, refreshed weekly into
`~/.pi/agent/cache/model-rotation/go-pricing.json`; every served response is
appended to `go-ledger.jsonl` beside it with raw token counts, so a price
correction applies to history.

The ledger only knows the traffic this shared agent home serves, and a window
that opened before the ledger did is reported as incomplete rather than as
fact. Go figures are therefore marked with `~`, and the routing rules never let
an estimate promote Go above a plan that reports its own numbers.

Set `goPeriodStart` to the subscription's renewal instant; without it the paid
period is approximated by the calendar month.

## Development

```bash
pi -ne -e ./extension/index.ts
npm test
```

## Contributing

This repository is a mirror of a private one. It publishes the paths its allowlist names, so it may be a
subset of the project, and its history is regenerated from the source: tags are absent and commits can be
replaced. Pull requests cannot land here.
