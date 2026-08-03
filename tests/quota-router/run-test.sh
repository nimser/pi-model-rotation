#!/usr/bin/env bash
# Quota poll/cache and predictive routing checks; all endpoints are local fakes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/harness.ts" "$@"
