# pi-model-rotation

Private global pi package for quota-aware model rotation across the shared host and every devpod.

Default chain:

```
anthropic/claude-opus-5:high -> openai-codex/gpt-5.6-sol:high -> opencode-go/kimi-k3:max
```

The extension paces weekly quotas toward their reset before comparing projected headroom, while short windows remain capacity guards only. The first 429 is a backstop. OpenRouter is never a rotation target.

Use `/rotation-toggle` to disable or re-enable rotation for the current session. The footer always shows `rotation: on` or `rotation: off`. `/rotation` shows quota details and routing counters.

## Install

```bash
pi install git:git@github.com:nimser/pi-model-rotation.git@v0.3.0
```

Pi stores the checkout and global package setting under the shared `~/.pi/agent/`, so host and devpods load the same pinned tag.

## Configuration

Optional global config: `~/.pi/agent/model-rotation.json`.
Optional project override: `.pi/model-rotation.json`.

Environment overrides:

- `MODEL_ROTATION_TASK_MINUTES`
- `MODEL_ROTATION_QUOTA_CACHE`
- `MODEL_ROTATION_CSWAP_DIR`
- `MODEL_ROTATION_IGNORE_CSWAP_USAGE`
- `MODEL_ROTATION_ANTHROPIC_USAGE_URL`
- `MODEL_ROTATION_OPENAI_USAGE_URL`
- `MODEL_ROTATION_OPENCODE_CONSOLE_URL`
- `MODEL_ROTATION_OPENCODE_AUTH`
- `MODEL_ROTATION_PI_AUTH`

The default cache is shared at `~/.pi/agent/cache/model-rotation/quota.json`.

## OpenCode Go quota

The Zen API key buys inference, not usage figures. Go meters (5-hour, calendar
week, product period — dollar budgets, not token counts) come from the console
API, which needs its own device-code authorization, done once per shared
`~/.pi/agent`:

```bash
node bin/opencode-login.ts   # or /rotation-login-opencode inside a session
```

Approve the printed code in a browser signed in to the OpenCode account. Tokens
land in `~/.pi/agent/model-rotation-opencode.json` (mode 0600) and refresh
themselves; until then opencode-go reports as unreachable and never routes.

## Development

```bash
pi -ne -e ./extension/index.ts
npm test
```

## Contributing

This repository is a mirror of a private one. It publishes the paths its allowlist names, so it may be a
subset of the project, and its history is regenerated from the source: tags are absent and commits can be
replaced. Pull requests cannot land here.
