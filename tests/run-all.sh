#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/quota-router/run-test.sh"
bash "$here/quota-router/run-test.sh" --routing
bash "$here/quota-router/run-test.sh" --modes
bash "$here/quota-router/run-test.sh" --frontier-context-below
bash "$here/quota-router/run-test.sh" --frontier-context-boundary
bash "$here/quota-router/run-test.sh" --frontier-context-fallback
bash "$here/quota-router/run-test.sh" --frontier-context-unknown
bash "$here/quota-router/run-test.sh" --casual-context-regression
bash "$here/quota-router/run-test.sh" --configured-context-window
node "$here/limit-messages/run-test.ts"
node "$here/model-rotation/preflight.ts"
bash "$here/model-rotation/run-test.sh"
