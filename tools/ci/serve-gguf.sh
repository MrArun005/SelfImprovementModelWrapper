#!/usr/bin/env bash
# Serve a quantized GGUF under $SERVED_MODEL exactly like the stock model $BASE: the stock model's Modelfile minus its
# weights gives the same chat template, stop tokens and parameters. Proves the model answers.
#   env: OLLAMA_HOST BASE SERVED_MODEL WARMUP_TIMEOUT WARMUP_TOKENS    usage: serve-gguf.sh <file.gguf>
set -euo pipefail
gguf="$1"
ollama="$HOME/.sic-ollama/bin/ollama"
{ echo "FROM $gguf"; "$ollama" show --modelfile "$BASE" | grep -v '^FROM '; } > "$RUNNER_TEMP/Modelfile"
"$ollama" create "$SERVED_MODEL" -f "$RUNNER_TEMP/Modelfile"
rm -f "$gguf"
"$ollama" show "$SERVED_MODEL"
body=$(printf '{"model":"%s","prompt":"Reply OK","stream":false,"options":{"num_predict":%s}}' "$SERVED_MODEL" "$WARMUP_TOKENS")
curl -fsS --max-time "$WARMUP_TIMEOUT" "http://$OLLAMA_HOST/api/generate" -d "$body" -o /dev/null ||
  { echo "::error::model $SERVED_MODEL did not answer"; tail -n 50 "$RUNNER_TEMP/ollama.log" || true; exit 1; }
echo "$SERVED_MODEL ready"
