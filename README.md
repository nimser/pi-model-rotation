# pi-model-rotation

Private global pi package for quota-aware model rotation across the shared host and every devpod.

## Modes

| mode | chain | last resort |
|------|-------|-------------|
| `frontier` | `anthropic/claude-opus-5` → `openai-codex/gpt-5.6-sol` | `opencode-go/kimi-k3` |
| `casual` | `openai-codex/gpt-5.6-luna` | `opencode-go/gpt-5.6-luna` |

The current model selects the mode at session start and whenever the model
changes. A model in neither chain disables rotation. Use `/mrf` for frontier
mode or `/mrc` for casual mode; the footer shows the active mode. opencode-go
is the last resort of its mode and is picked only once every other hop is out of
quota or cooling down from a 429. A 429 on Go while
the OpenAI plan is also spent drops casual back to frontier — nothing ever
promotes frontier to casual.

The extension paces weekly quotas toward their reset before comparing projected
headroom, while short windows remain capacity guards only. The first 429 is a
backstop. OpenRouter is never a rotation target.

`/mrt` disables or re-enables rotation for the current session. `/mru` refreshes
and shows quota details and routing counters; `/mru hide` clears the usage
widget, and `/mru toggle` shows or hides it without changing quota state.

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
pi install git:git@github.com:nimser/pi-model-rotation.git@v0.8.1
```

Pi stores the checkout and global package setting under the shared `~/.pi/agent/`, so host and devpods load the same pinned tag.

## Configuration

Optional global config: `~/.pi/agent/model-rotation.json`.
Optional project override: `.pi/model-rotation.json`.

```json
{
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

The default cache is shared at `~/.pi/agent/cache/model-rotation/quota.json`.

## OpenCode Go quota

There is none, by design. The key buys inference only, responses carry no
rate-limit header, and the workspace page that shows the meters needs a browser
session, which is not a durable credential.

Go usage can be computed from what the subscription publishes — each model
carries a monthly allowance of $15 or $60, and the rolling five-hour and
calendar-week windows are 20 % and 50 % of it — but no routing decision depends
on the answer: Go is the last resort of its mode, entered when everything else
is spent and left on a 429 or when a plan recovers. A number that changes
nothing is not worth a weekly parse of somebody else's docs, so `/mru` prints
`last resort; no usage API` instead of a figure it cannot check.

The one consequence that is handled: Go's shortest window is five rolling hours,
so its cooldown after a 429 is five hours rather than the fifteen-minute
default, and a `Retry-After` is believed up to a day.

## Development

```bash
pi -ne -e ./extension/index.ts
npm test
```

## Contributing

This repository is a mirror of a private one. It publishes the paths its allowlist names, so it may be a
subset of the project, and its history is regenerated from the source: tags are absent and commits can be
replaced. Pull requests cannot land here.
