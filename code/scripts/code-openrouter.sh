#!/usr/bin/env bash
set -euo pipefail

# Wrapper to run Code (codex) via OpenRouter using the built‑in OpenAI provider.
# Loads .env from repo root if present. Requires OPENROUTER_API_KEY.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  # shellcheck disable=SC2046
  set -a
  # shellcheck disable=SC1090
  source "${REPO_ROOT}/.env"
  set +a
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is not set. Add it to ${REPO_ROOT}/.env or export it and retry." >&2
  echo "Example: export OPENROUTER_API_KEY=sk-or-..." >&2
  exit 2
fi

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://openrouter.ai/api/v1}"
export OPENAI_WIRE_API="chat"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"

# Default model; override with OPENROUTER_MODEL
MODEL="${OPENROUTER_MODEL:-openai/gpt-oss-120b}"

exec npx -y @just-every/code \
  -c model_provider=openai \
  -c model="${MODEL}" \
  "$@"
