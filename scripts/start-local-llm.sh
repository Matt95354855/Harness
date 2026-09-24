#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PATH="${HARNESS_MODEL_PATH:-$ROOT_DIR/models/Qwen3.5-0.8B-Q8_0.gguf}"

if ! command -v llama-server >/dev/null 2>&1; then
  echo "llama-server est introuvable. Installez llama.cpp avec : brew install llama.cpp" >&2
  exit 1
fi

if [[ ! -f "$MODEL_PATH" ]]; then
  echo "Modèle introuvable : $MODEL_PATH" >&2
  echo "Consultez docs/local-model.md pour l'installation." >&2
  exit 1
fi

exec llama-server \
  --model "$MODEL_PATH" \
  --alias "qwen3.5-0.8b-local" \
  --host 127.0.0.1 \
  --port "${HARNESS_LLM_PORT:-8080}" \
  --parallel 1 \
  --ctx-size 4096 \
  --threads "${HARNESS_LLM_THREADS:-8}" \
  --threads-batch "${HARNESS_LLM_BATCH_THREADS:-8}" \
  --n-gpu-layers 0 \
  --reasoning off
