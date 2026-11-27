#!/usr/bin/env bash
# One self-improvement round inside a Kaggle GPU job (2x T4): the same code and the same steps as the GitHub
# workflow (.github/workflows/rsi.yml), run in one place. Started by the job's run.py from a clean clone of this repo at
# a fixed commit; every value comes from config/default.json with SIC_PROFILE applied.
#   env: SIC_PROFILE (e.g. rsi-7b), PREV_MODEL_DIR (Kaggle input holding the previous round's model.gguf; empty in round 1)
# Writes /kaggle/working/out: search/*.jsonl, exam/*.jsonl, train/{manifest,train-metrics}.json, plan.txt and
# model.gguf (this round's model; the next round's job mounts it). Model-written code only runs in src/judge's sandbox.
set -euo pipefail
OUT=/kaggle/working/out
T=/tmp/sic
mkdir -p "$OUT/search" "$OUT/exam" "$OUT/train" "$OUT/logs" "$T"
# on any failure, show the end of every step log (they are also kept in the job output)
trap 'rc=$?; [ $rc -ne 0 ] && for f in "$OUT"/logs/*.log; do echo "--- $f"; tail -n 25 "$f"; done; exit $rc' EXIT
cd "$(dirname "$0")/../.."
cfgv() { python3 -c "import json,sys; c=json.load(open('config/default.json')); print(c['kaggle'][sys.argv[1]])" "$1"; }
stamp() { echo "== $(date -u +%H:%M:%S) $*"; }

stamp "node"
curl -fsSL "$(cfgv nodeUrl)" -o "$T/node.tar.xz"
mkdir -p "$T/node" && tar -xJf "$T/node.tar.xz" -C "$T/node" --strip-components=1
export PATH="$T/node/bin:$PATH"
npm ci --ignore-scripts --no-audit --no-fund > /dev/null
read -ra PY_PKGS <<< "$(python3 -c "import json; print(' '.join(json.load(open('config/default.json'))['kaggle']['pythonPackages']))")"
pip install -q "${PY_PKGS[@]}"

# every key=value from the config and the round plan, as shell variables C_<key> and P_<key>
load() { while IFS= read -r line; do printf -v "$1${line%%=*}" '%s' "${line#*=}"; done; }
node src/dataset/fetch.js   # once, before parallel steps (they would race writing the same cache file)
load C_ < <(node src/ci/config-out.js)
load P_ < <(node src/rsi/cli.js plan)
node src/rsi/cli.js plan > "$OUT/plan.txt"
if [ -n "$P_stop" ]; then stamp "plan says stop: $P_stop"; exit 0; fi
ROUND="$P_round"
read -ra PORTS <<< "$(python3 -c "import json; print(' '.join(map(str, json.load(open('config/default.json'))['kaggle']['ollamaPorts'])))")"
PAR="$(cfgv parallelPerServer)"
stamp "round $ROUND (profile $SIC_PROFILE), search model $P_search_model"

stamp "ollama"
mkdir -p "$T/ollama"
curl -fsSL "$C_ollama_url" -o "$T/ollama.tar.zst"
python3 -c "import zstandard,sys; zstandard.ZstdDecompressor().copy_stream(open(sys.argv[1],'rb'), open(sys.argv[2],'wb'))" "$T/ollama.tar.zst" "$T/ollama.tar"
tar -xf "$T/ollama.tar" -C "$T/ollama"
OLLAMA="$T/ollama/bin/ollama"
servers_up() { # one server per GPU, same model store
  local i=0
  for port in "${PORTS[@]}"; do
    CUDA_VISIBLE_DEVICES=$i OLLAMA_HOST="127.0.0.1:$port" OLLAMA_NUM_PARALLEL="$PAR" OLLAMA_CONTEXT_LENGTH="$C_ollama_context_length" \
      nohup "$OLLAMA" serve > "$OUT/logs/ollama-$port.log" 2>&1 &
    i=$((i + 1))
  done
  for port in "${PORTS[@]}"; do
    for _ in $(seq 90); do curl -fs "127.0.0.1:$port/api/version" > /dev/null && break; sleep 2; done
  done
}
servers_down() { pkill -f "ollama serve" || true; pkill -f "ollama runner" || true; sleep 5; }
serve_gguf() { # <gguf> <name>: same template and parameters as the stock model
  { echo "FROM $1"; OLLAMA_HOST="127.0.0.1:${PORTS[0]}" "$OLLAMA" show --modelfile "$C_model" | grep -v '^FROM '; } > "$T/Modelfile"
  OLLAMA_HOST="127.0.0.1:${PORTS[0]}" "$OLLAMA" create "$2" -f "$T/Modelfile"
}
endpoint() { echo "http://127.0.0.1:$1/v1/chat/completions"; }
servers_up
OLLAMA_HOST="127.0.0.1:${PORTS[0]}" "$OLLAMA" pull "$C_model" > "$OUT/logs/pull.log" 2>&1

stamp "search"
if [ "$P_search_served" = "true" ]; then
  prev="$(find "${PREV_MODEL_DIR:?previous round model dir required}" -name "$C_ft_model_gguf" | head -1)"
  [ -n "$prev" ] || { echo "previous round's $C_ft_model_gguf not found under $PREV_MODEL_DIR"; exit 1; }
  serve_gguf "$prev" "$P_search_model"
fi
pids=()
for shard in $(python3 -c "import json,sys; print(' '.join(map(str, json.loads(sys.argv[1]))))" "$P_search_matrix"); do
  port="${PORTS[$((shard % ${#PORTS[@]}))]}"
  SIC_LLM__ENDPOINT="$(endpoint "$port")" node src/rsi/cli.js search "--round=$ROUND" "--shard=$shard" "--model=$P_search_model" \
    "--out=$OUT/search/search-$shard.jsonl" > "$OUT/logs/search-$shard.log" 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
tail -q -n 1 "$OUT"/logs/search-*.log
servers_down

stamp "base model files"
DEST="$T/hf/$C_ft_base_revision" BASE_REVISION="$C_ft_base_revision" FILES="$C_ft_base_files" MIRRORS="$C_ft_base_mirrors" \
  RETRIES="$C_ft_download_retries" MAX_SECONDS="$C_ft_download_max_seconds" bash tools/finetune/fetch-base.sh

stamp "training set + LoRA training (GPU)"
node src/rsi/cli.js prepare "--round=$ROUND" "--search-dir=$OUT/search" "--out=$T/ft" "--base-dir=$T/hf/$C_ft_base_revision"
python3 tools/finetune/train.py --settings "$T/ft/$C_ft_settings_file" 2>&1 | grep -v -i 'warn'
cp "$T/ft/$C_ft_manifest_file" "$T/ft/$C_ft_metrics_file" "$OUT/train/"
stamp "merge (CPU)"
CUDA_VISIBLE_DEVICES="" python3 tools/finetune/merge.py --settings "$T/ft/$C_ft_settings_file" 2>&1 | grep -v -i 'warn'

stamp "converter + quantizer (pinned commit)"
L="$T/llama"
git init -q "$L/src" && git -C "$L/src" remote add origin "$C_ft_llama_repo"
git -C "$L/src" fetch -q --depth=1 origin "$C_ft_llama_commit" && git -C "$L/src" checkout -q FETCH_HEAD
command -v cmake > /dev/null || pip install -q cmake
cmake -S "$L/src" -B "$L/build" -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF > /dev/null
cmake --build "$L/build" --target "$C_ft_quantize_tool" -j "$(nproc)" > /dev/null
build() { # <hf dir> <out gguf>
  PYTHONPATH="$L/src/gguf-py" python3 "$L/src/convert_hf_to_gguf.py" --outtype "$C_ft_out_type" --outfile "$2.full" "$1"
  "$L/build/bin/$C_ft_quantize_tool" "$2.full" "$2" "$C_ft_quantize"
  rm -f "$2.full"
}
build "$T/ft/$C_ft_merged_dir" "$OUT/$C_ft_model_gguf"
rm -rf "$T/ft/$C_ft_merged_dir"
if [ "$P_build_base" = "true" ]; then build "$T/hf/$C_ft_base_revision" "$T/base.gguf"; fi

stamp "exam"
servers_up
for job in $(python3 -c "import json,sys; print(' '.join(sorted({str(j['model'])+':'+j['name'] for j in json.loads(sys.argv[1])})))" "$P_eval_matrix"); do
  m="${job%%:*}"; name="${job#*:}"
  if [ "$m" = "0" ]; then serve_gguf "$T/base.gguf" "$name"; else serve_gguf "$OUT/$C_ft_model_gguf" "$name"; fi
  pids=()
  for shard in $(python3 -c "import json,sys; print(' '.join(str(j['shard']) for j in json.loads(sys.argv[1]) if j['model']==int(sys.argv[2])))" "$P_eval_matrix" "$m"); do
    port="${PORTS[$((shard % ${#PORTS[@]}))]}"
    SIC_LLM__ENDPOINT="$(endpoint "$port")" node src/rsi/cli.js exam "--model-round=$m" "--shard=$shard" "--model=$name" \
      "--out=$OUT/exam/exam-$m-$shard.jsonl" > "$OUT/logs/exam-$m-$shard.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  tail -q -n 1 "$OUT"/logs/exam-"$m"-*.log
  for port in "${PORTS[@]}"; do OLLAMA_HOST="127.0.0.1:$port" "$OLLAMA" stop "$name" || true; done
done
servers_down
stamp "done: round $ROUND"
ls -la "$OUT" "$OUT"/*
