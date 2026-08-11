#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/quota-router/run-test.sh"
bash "$here/quota-router/run-test.sh" --routing
bash "$here/quota-router/run-test.sh" --modes
node "$here/model-rotation/preflight.ts"
bash "$here/model-rotation/run-test.sh"
