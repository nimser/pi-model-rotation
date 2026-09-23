# pi-model-rotation

A pi extension that spreads one agent session across every AI subscription you
already pay for: each request goes to the plan that can best afford it, and a
plan that runs out is left behind without stopping the run.

## Why

Frontier plans meter themselves in their own windows — Anthropic on five hours
and seven days, ChatGPT on a rolling five hours and a week, OpenCode Go on a
month. A session pinned to one model wastes that:

- it stalls at a limit while the other subscriptions sit untouched;
- the weekly allowance you paid for expires unused, because nothing spends it
  before the reset;
- an unattended run dies at the first 429 and waits for a human to swap the
  model and retype the request.

The goal is to keep every subscription near full use and every run alive:
predict which plan has headroom before the request leaves, rotate on the first
exhaustion signal, and continue the interrupted turn on the new model. Quotas
expire used, not unused.

It is not a spend-more router. OpenRouter and other pay-per-token gateways are
never rotation targets, and only models already authenticated in pi are used.

## Requirements

- pi 0.84.2 or newer, for `ctx.getContextUsage()`
- Node 26 or newer
- credentials in pi for every provider in your chains; a hop pi cannot
  authenticate is skipped and cooled down
- optional: [claude-swap](https://github.com/realiti4/claude-swap) for reading
  several Anthropic accounts' quota

## Install

```bash
pi install git:github.com/nimser/pi-model-rotation
```

Pi stores the checkout and the global package setting under `~/.pi/agent/`, so
a shared home directory — host plus devpods — loads the same revision. Pin a
commit with `@<sha>` to stop `pi update` from moving it.


## Default behaviour

Two modes, each a chain of hops in preference order:

| mode | chain | last resort |
|------|-------|-------------|
| `frontier` | `anthropic/claude-opus-5` → `openai-codex/gpt-6-astra` | `opencode-go/kimi-k3` |
| `casual` | `openai-codex/gpt-6-luna` | `opencode-go/gpt-6-luna` |

The current model selects the mode at session start and whenever the model
changes. A model in neither chain disables rotation. The last resort is entered
only once every other hop of the mode is out of quota or cooling down from a
429. A 429 on the last resort while the normal hops are also spent drops casual
back to frontier; nothing ever promotes frontier to casual.

| command | effect |
|---------|--------|
| `/mrf` | frontier mode, from the head of its chain |
| `/mrc` | casual mode, from the head of its chain |
| `/mrt` | turn rotation off, or back on, for this session |
| `/mru` | refresh and show quota, mode, effort and counters; `hide` clears the widget, `toggle` shows or hides it |

Asking for a mode also turns rotation on, because a disabled router has no mode
to be in. The footer shows the active mode. The quota router moves the model
again before the next request is sent.

## Turning it off

- **this session**: `/mrt`, or switch to a model that is in neither chain —
  rotation reports the model as unsupported and stands down.
- **this project**: put a chain of one hop in `.pi/model-rotation.json`; the
  session is then pinned to that model with rotation active but nowhere to go.
- **no automatic continuation, keep the routing**: `"autoResume": false`.
- **everywhere**: `pi config` to disable the extension, or `pi remove` with the
  source you installed to uninstall.

## Configuration

`.pi/model-rotation.json` in the project is read first, then
`~/.pi/agent/model-rotation.json`; the first readable file wins and unset keys
keep their defaults.

```json
{
  "modes": {
    "frontier": {
      "ladder": "high",
      "chain": [
        { "provider": "anthropic", "model": "claude-opus-5" },
        { "provider": "openai-codex", "model": "gpt-6-astra", "effortOffset": -1, "maxContextTokens": 272000 },
        { "provider": "opencode-go", "model": "kimi-k3", "fixedThinking": "max", "lastResort": true }
      ]
    }
  },
  "cooldownMs": { "anthropic": 300000, "opencode-go": 18000000, "default": 900000 },
  "maxResumesPerSession": 5,
  "autoResume": true,
  "rotateOnStatus": [429]
}
```

| key | meaning |
|-----|---------|
| `modes.<mode>.chain` | hops in preference order; an empty chain keeps the built-in one |
| `modes.<mode>.ladder` | effort the mode starts at, on the Anthropic scale |
| `cooldownMs.<provider>` | how long a provider is avoided after an exhaustion signal that names no reset; `default` covers the rest |
| `maxResumesPerSession` | how many times a session may continue itself after a rotation |
| `autoResume` | continue the interrupted turn on the new model |
| `rotateOnStatus` | HTTP statuses treated as exhaustion |

Chain entries take `provider` and `model`, plus:

| field | meaning |
|-------|---------|
| `effortOffset` | notches away from the ladder for this hop |
| `fixedThinking` | one effort level, ignoring the ladder |
| `lastResort` | reachable only when every other hop of the mode is unusable |
| `maxContextTokens` | the hop's context window: preferred while the conversation fits it, dropped once it does not |

Mode names are fixed: only `frontier` and `casual` exist.

| variable | effect |
|----------|--------|
| `MODEL_ROTATION_TASK_MINUTES` | expected task length used to project headroom (default 60) |
| `MODEL_ROTATION_QUOTA_CACHE` | quota cache path (default `~/.pi/agent/cache/model-rotation/quota.json`) |
| `MODEL_ROTATION_CSWAP_DIR` | claude-swap directory (default `~/.local/share/claude-swap`) |
| `MODEL_ROTATION_IGNORE_CSWAP_USAGE` | `1` polls Anthropic directly instead of reading claude-swap's cache |
| `MODEL_ROTATION_ANTHROPIC_USAGE_URL` | override the Anthropic usage endpoint |
| `MODEL_ROTATION_OPENAI_USAGE_URL` | override the ChatGPT usage endpoint |
| `MODEL_ROTATION_PI_AUTH` | pi credential file to read the Codex token from |

## Routing

The extension paces weekly quotas toward their reset before comparing projected
headroom, so a plan whose week is ahead of schedule yields to one that is
behind. Pacing reads the longest window a plan declares: a window shorter than
a day is a rolling throttle whose unused share never expires, so it cannot
drive the weekly trigger. Anthropic publishes a five-hour and a seven-day
window; OpenAI publishes the same pair as `primary_window` and
`secondary_window`, and both are read. A 429 is a backstop, never the primary
signal, and no fixed cooldown proves recovery — only a newer quota sample does.

A hop that declares `maxContextTokens` is preferred while the active
conversation fits inside it, and leaves both proactive and reactive routing
once it does not — a narrow model is worth using until the conversation
outgrows it, and is worthless afterwards. A missing estimate, which is what pi
reports right after compaction, counts as fitting. The preference outranks the
quota ranking but never bypasses a cooldown, a 429 newer than the quota sample,
or proven immediate-window exhaustion; a hop that declares no window carries
any context.

By default only `openai-codex/gpt-6-astra` declares one, at its 272,000-token
window, so frontier runs on Codex until the conversation crosses it and on
Anthropic afterwards, with Go still the last resort. Casual mode declares no
window and is unchanged by conversation size.

Anthropic's live `utilization` fields are ratios; claude-swap's cached `pct`
and OpenAI's `used_percent` are percentages. An OpenAI value of `1` therefore
means 1% used, not 100% used.

## Exhaustion signals

A spent plan does not always answer 429. ChatGPT out of credit replies HTTP 200
and puts the verdict in the stream — `Codex error: The usage limit has been
reached` — which reaches the extension as an assistant message with stop reason
`error`. Rotation therefore reads the error text as well as the status: usage,
plan, billing and credit exhaustion all rotate, while a full context window
does not, because that is a prompt problem and blocking the plan would be
wrong. When an error names its own wait ("Try again in ~14 min"), that wait
becomes the cooldown; otherwise the provider's published reset does, falling
back to the configured cooldown.

Pi retries a 429 itself once the model has changed, but it does not retry a
stream error, so those runs continue through the queued continuation. Print
mode (`pi -p`) never delivers extension follow-ups, so unattended continuation
after a stream error exists only in an interactive session.

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

The one consequence that is handled: Go's shortest window is five rolling
hours, so its cooldown after a 429 is five hours rather than the fifteen-minute
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
