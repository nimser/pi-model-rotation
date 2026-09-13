# pi-model-rotation

Private global pi package for quota-aware model rotation across the shared host and every devpod.

## Modes

| mode | chain | last resort |
|------|-------|-------------|
| `frontier` | `anthropic/claude-opus-5` → `openai-codex/gpt-6-astra` | `opencode-go/kimi-k3` |
| `casual` | `openai-codex/gpt-5.6-luna` | `opencode-go/gpt-5.6-luna` |

The current model selects the mode at session start and whenever the model
changes. A model in neither chain disables rotation. Use `/mrf` for frontier
mode or `/mrc` for casual mode; the footer shows the active mode. Asking for a
mode also turns rotation on, because a disabled router has no mode to be in. The
command starts at the head of its chain and the quota router moves it before the
next request is sent. opencode-go
is the last resort of its mode and is picked only once every other hop is out of
quota or cooling down from a 429. A 429 on Go while
the OpenAI plan is also spent drops casual back to frontier — nothing ever
promotes frontier to casual.

Automatic frontier routing prefers `openai-codex/gpt-6-astra` while the active
conversation context is below 272,000 tokens. A missing estimate after compaction
also follows that below-boundary policy. At 272,000 tokens and above, OpenAI is
removed from proactive and reactive frontier routing, so Anthropic is the normal
route and Go remains the last resort. Casual mode is unchanged; its Codex Luna
and Go Luna routes are not filtered by the frontier boundary.

The extension paces weekly quotas toward their reset before comparing projected
headroom. Frontier's below-boundary OpenAI preference outranks that quota
ranking, but it never bypasses a cooldown, a 429 newer than the quota sample, or
proven immediate-window exhaustion. Pacing reads the longest window a plan
declares — a window shorter than a day is a rolling throttle whose unused share
never expires, so it cannot drive the weekly trigger. Anthropic publishes a
five-hour and a seven-day window; OpenAI publishes the same pair as
`primary_window` and `secondary_window`, and both are read. The first 429 is a
backstop, and Go is selected only when every eligible normal hop is cooling down
from a 429 or has a fresh zero-capacity sample. OpenRouter is never a rotation
target.

## Exhaustion signals

A spent plan does not always answer 429. ChatGPT out of credit replies HTTP 200
and puts the verdict in the stream — `Codex error: The usage limit has been
reached` — which reaches the extension as an assistant message with stop reason
`error`. Rotation therefore reads the error text as well as the status: usage,
plan, billing and credit exhaustion all rotate, while a full context window does
not, because that is a prompt problem and blocking the plan would be wrong. When
an error names its own wait ("Try again in ~14 min"), that wait becomes the
cooldown; otherwise the provider's published reset does, falling back to the
configured cooldown.

pi retries a 429 itself once the model has changed, but it does not retry a
stream error, so those runs continue through the queued continuation. Print mode
(`pi -p`) never delivers extension follow-ups, so unattended continuation after a
stream error exists only in an interactive session.

Anthropic's live `utilization` fields are ratios; claude-swap's cached `pct` and
OpenAI's `used_percent` are percentages. An OpenAI value of `1` therefore means
1% used, not 100% used.

`/mrt` disables or re-enables rotation for the current session; `/mrf` and
`/mrc` re-enable it as well. `/mru` refreshes
and shows quota details and routing counters; `/mru hide` clears the usage
widget, and `/mru toggle` shows or hides it without changing quota state.

## Effort

Effort travels as one ladder held on the Anthropic scale, because `gpt-6-astra`
reasons harder and costs more per token than `claude-opus-5` and so runs one
notch below it:

| ladder | claude-opus-5 | gpt-6-astra |
|--------|---------------|-------------|
| medium | medium | low |
| high | high | medium |
| xhigh | xhigh | high |

Entering frontier sets the ladder to `high`, entering casual sets it to
`xhigh`, and a manual change is read back before every switch, so rotating
inside a mode carries the level you last chose. `kimi-k3` always runs at `max`
and never moves the ladder.

## Install

```bash
pi install git:git@github.com:nimser/pi-model-rotation.git@v0.8.7
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

Provider tests use a temporary `PI_CODING_AGENT_DIR`; fake model changes never
rewrite the operator's global settings.

## Contributing

This repository is a mirror of a private one. It publishes the paths its allowlist names, so it may be a
subset of the project, and its history is regenerated from the source: tags are absent and commits can be
replaced. Pull requests cannot land here.
