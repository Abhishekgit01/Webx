#!/usr/bin/env bash
# One-command Webx demo. Opens Mission Control in your default browser.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -x .venv/bin/python ]]; then
  PYTHON=.venv/bin/python
else
  PYTHON=${PYTHON:-python3}
fi

if ! "$PYTHON" -c "import playwright, fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing Python dependencies…"
  "$PYTHON" -m pip install -q -r requirements.txt
fi

if ! "$PYTHON" -c "import playwright, fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Dependencies are still missing. Run: $PYTHON -m pip install -r requirements.txt" >&2
  exit 1
fi

exec "$PYTHON" -m webx serve "$@"
