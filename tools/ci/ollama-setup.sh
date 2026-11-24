#!/usr/bin/env bash
# Install (or reuse the cached) Ollama, start it, pull $MODEL with retries and prove it answers.
# env: OLLAMA_URL OLLAMA_HOST MODEL READY_TIMEOUT RETRIES RETRY_DELAY WARMUP_TIMEOUT WARMUP_TOKENS [OLLAMA_CONTEXT_LENGTH]
set -euo pipefail
# retry CMD...: up to $RETRIES tries, waiting RETRY_DELAY x attempt seconds between them
retry() {
  local n=1
  until "$@"; do
    if [ "$n" -ge "$RETRIES" ]; then return 1; fi
    echo "attempt $n failed, retrying in $((RETRY_DELAY * n))s: $1"
    sleep $((RETRY_DELAY * n))
    n=$((n + 1))
  done
}
download() {
  curl -fsSL "$OLLAMA_URL" -o "$RUNNER_TEMP/ollama.tar.zst" &&
    zstd -dc "$RUNNER_TEMP/ollama.tar.zst" | tar -x -C "$HOME/.sic-ollama"
}
fail() {
  echo "::error::$1"
  tail -n 50 "$RUNNER_TEMP/ollama.log" || true
  exit 1
}
if [ ! -x "$HOME/.sic-ollama/bin/ollama" ]; then
  mkdir -p "$HOME/.sic-ollama"
  retry download || fail "could not download Ollama from $OLLAMA_URL"
fi
nohup "$HOME/.sic-ollama/bin/ollama" serve > "$RUNNER_TEMP/ollama.log" 2>&1 &
ready=0
for _ in $(seq "$READY_TIMEOUT"); do
  if curl -fsS "http://$OLLAMA_HOST/api/version" > /dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || fail "Ollama did not start within ${READY_TIMEOUT}s"
retry "$HOME/.sic-ollama/bin/ollama" pull "$MODEL" || fail "could not pull model $MODEL"
# Warm-up: load the weights and prove the model answers before the cycle spends its budget.
body=$(printf '{"model":"%s","prompt":"Reply OK","stream":false,"options":{"num_predict":%s}}' "$MODEL" "$WARMUP_TOKENS")
retry curl -fsS --max-time "$WARMUP_TIMEOUT" "http://$OLLAMA_HOST/api/generate" -d "$body" -o /dev/null ||
  fail "model $MODEL did not answer a warm-up request"
echo "Ollama ready, $MODEL answers"
