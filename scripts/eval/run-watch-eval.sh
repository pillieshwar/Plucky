#!/usr/bin/env bash
# Download each candidate model, serve it with the bundled llama-server and
# score it with the watch_eval example. Prints a Markdown table.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="$(ls "$ROOT"/src-tauri/binaries/llama-server-* | head -n 1)"
EVAL="$ROOT/target/release/examples/watch_eval"
CASES="$ROOT/scripts/eval/watch-cases.json"
MODELS_DIR="${RUNNER_TEMP:-/tmp}/eval-models"
mkdir -p "$MODELS_DIR"

# name | repo | file
MODELS=(
  "Llama 3.2 3B (current)|bartowski/Llama-3.2-3B-Instruct-GGUF|Llama-3.2-3B-Instruct-Q4_K_M.gguf"
  "Gemma 4 E4B|unsloth/gemma-4-E4B-it-GGUF|gemma-4-E4B-it-Q4_K_M.gguf"
  "Gemma 4 E2B|unsloth/gemma-4-E2B-it-GGUF|gemma-4-E2B-it-Q4_K_M.gguf"
  "Qwen3.5 4B|bartowski/Qwen_Qwen3.5-4B-GGUF|Qwen_Qwen3.5-4B-Q4_K_M.gguf"
  "Qwen3 4B Instruct|unsloth/Qwen3-4B-Instruct-2507-GGUF|Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
)

echo "## Watch-mode model eval"
echo
echo "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$CASES") cases. Accuracy = right answers (finding the to-do, or correctly finding none)."
echo
echo "| Model | Accuracy | False alarms | Missed | Wrong task | Errors | Avg time |"
echo "|---|---|---|---|---|---|---|"

PORT=18080
KEY="eval-$RANDOM$RANDOM"
for entry in "${MODELS[@]}"; do
  IFS='|' read -r name repo file <<<"$entry"
  path="$MODELS_DIR/$file"
  if ! curl -fsSL --retry 3 -o "$path" "https://huggingface.co/$repo/resolve/main/$file" 2>/dev/null; then
    echo "| $name | download failed | | | | | |"
    continue
  fi
  "$SERVER" -m "$path" --host 127.0.0.1 --port "$PORT" --api-key "$KEY" -c 4096 >/dev/null 2>&1 &
  pid=$!
  ready=0
  for _ in $(seq 1 180); do
    if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" = 1 ]; then
    out="$("$EVAL" "http://127.0.0.1:$PORT" "$KEY" "$CASES" "$name" 2>&1 || true)"
    echo "$out" | sed 's/^/    /' >&2
    echo "$out" | tail -n 1 | python3 "$ROOT/scripts/eval/row.py"
  else
    echo "| $name | server did not start | | | | | |"
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$path"
  PORT=$((PORT + 1))
done
