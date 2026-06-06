#!/usr/bin/env bash
# Record the PR video proof for an issue: runs scripts/demo.sh inside an
# asciinema session, renders to GIF (agg), then to MP4 (ffmpeg).
#
# Usage:  bash platform/scripts/record-demo.sh <issue-slug>
# Output: platform/docs/demos/<issue-slug>.mp4   (commit this to the PR)
#
# Requires: asciinema, agg, ffmpeg (all present in CI image and local dev).
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:-demo}"
OUT_DIR="docs/demos"
CAST="$(mktemp -t "${SLUG}.XXXXXX").cast"
GIF="$(mktemp -t "${SLUG}.XXXXXX").gif"
mkdir -p "$OUT_DIR"

echo ">> recording demo for '$SLUG'..." >&2
asciinema rec --overwrite --command "bash scripts/demo.sh" "$CAST"

echo ">> rendering GIF..." >&2
agg --theme monokai "$CAST" "$GIF"

echo ">> encoding MP4 -> $OUT_DIR/$SLUG.mp4" >&2
ffmpeg -y -loglevel error -i "$GIF" \
  -movflags +faststart -pix_fmt yuv420p \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  "$OUT_DIR/$SLUG.mp4"

rm -f "$CAST" "$GIF"
echo ">> done: $OUT_DIR/$SLUG.mp4" >&2
