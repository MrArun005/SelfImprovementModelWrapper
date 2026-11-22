#!/usr/bin/env bash
# Download the pinned base model files. Each file is tried from every mirror in turn (resumable retries, a time
# limit per attempt) and accepted only if its SHA-256 matches the pinned value, so any mirror serves the same bytes.
# env: DEST (default ~/.sic-hf/$BASE_REVISION), FILES ("name:sha256 ..."), MIRRORS ("https://.../{file} ..."), RETRIES, MAX_SECONDS
set -euo pipefail
DEST="${DEST:-$HOME/.sic-hf/$BASE_REVISION}"
mkdir -p "$DEST"
read -ra files <<< "$FILES"
read -ra mirrors <<< "$MIRRORS"
for entry in "${files[@]}"; do
  name="${entry%%:*}"
  sha="${entry#*:}"
  f="$DEST/$name"
  if [ -s "$f" ] && echo "$sha  $f" | sha256sum -c --status; then echo "cached: $name"; continue; fi
  rm -f "$f"
  ok=0
  for m in "${mirrors[@]}"; do
    url="${m//\{file\}/$name}"
    echo "downloading $name from $(echo "$url" | cut -d/ -f3)"
    rm -f "$f.part"
    for i in $(seq "$RETRIES"); do
      if curl -fL -C - --max-time "$MAX_SECONDS" -sS -o "$f.part" "$url"; then break; fi
      echo "  attempt $i interrupted"
      sleep $((i * 5))
    done
    if [ -s "$f.part" ] && echo "$sha  $f.part" | sha256sum -c --status; then mv "$f.part" "$f"; ok=1; break; fi
    echo "  $name from this mirror is missing or does not match the pinned SHA-256; trying the next mirror"
  done
  [ "$ok" = 1 ] || { echo "::error::could not download $name with the pinned SHA-256 from any mirror"; exit 1; }
done
ls -la "$DEST"
