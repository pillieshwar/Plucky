#!/usr/bin/env bash
# Download one model (MODEL_NAME / MODEL_REPO / MODEL_FILE), serve it with the
# bundled llama-server and score it with the watch_eval example. Results go
# to the job summary and to two notices on the run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="$(ls "$ROOT"/src-tauri/binaries/llama-server-* | head -n 1)"
EVAL="$ROOT/target/release/examples/watch_eval"
CASES="$ROOT/scripts/eval/watch-cases.json"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
DIR="${RUNNER_TEMP:-/tmp}/eval-model"
mkdir -p "$DIR"
path="$DIR/$MODEL_FILE"

echo "Downloading $MODEL_REPO/$MODEL_FILE"
curl -fsSL --retry 3 -o "$path" "https://huggingface.co/$MODEL_REPO/resolve/main/$MODEL_FILE"

PORT=18080
KEY="eval-$RANDOM$RANDOM"
THREADS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
"$SERVER" -m "$path" --host 127.0.0.1 --port "$PORT" --api-key "$KEY" -c 2048 -t "$THREADS" \
  >"$DIR/server.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 180); do
  if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  tail -n 20 "$DIR/server.log"
  echo "::error title=$MODEL_NAME::llama-server did not start"
  exit 1
fi

out="$DIR/eval.txt"
"$EVAL" "http://127.0.0.1:$PORT" "$KEY" "$CASES" "$MODEL_NAME" | tee "$out"
python3 "$ROOT/scripts/eval/row.py" "$out" "$SUMMARY"
