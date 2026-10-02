#!/usr/bin/env bash
#
# s6f-oi-harvest.sh — S6f midcap-OI harvest: download + verify (director GO, CYCLE-190).
#
# Fetches Binance Vision daily futures-metrics zips for the 8 midcaps, unpacks
# them, and prints the paste-back (per-symbol counts + one CSV header). The
# aggregation into oi_midcap_8h.json happens next cycle against the pasted
# header — columns are never assumed.
#
# Usage:  bash scripts/s6f-oi-harvest.sh [stage]
#   fetch    download monthly zips 2021-01 → 2026-09 into $OUT_DIR (default /tmp/oi_mid)
#   sample   per-symbol zip counts + missing log + one CSV header (the paste-back)
#   all      fetch then sample (default)
#
# Reads: nothing in-repo (network only). Writes: $OUT_DIR only (never the repo).
# Paste back: the full `sample` output. No `npm test` needed (repo untouched).

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

SYMS="ARBUSDT AVAXUSDT INJUSDT NEARUSDT OPUSDT SEIUSDT SUIUSDT TIAUSDT"
OUT_DIR="${OUT_DIR:-/tmp/oi_mid}"
BASE="https://data.binance.vision/data/futures/um/daily/metrics"

do_fetch() {
  mkdir -p "$OUT_DIR"
  : > "$OUT_DIR/missing.log"
  for S in $SYMS; do
    mkdir -p "$OUT_DIR/$S"
    for Y in 2021 2022 2023 2024 2025 2026; do for M in 01 02 03 04 05 06 07 08 09 10 11 12; do
      if [ "$Y" = "2026" ] && [ "$M" \> "09" ]; then continue; fi
      F="$S-metrics-$Y-$M.zip"
      if [ ! -f "$OUT_DIR/$S/$F" ]; then
        curl -sf -o "$OUT_DIR/$S/$F" "$BASE/$S/$F" \
          || echo "missing $S $Y-$M" >> "$OUT_DIR/missing.log"
      fi
    done; done
  done
  echo "fetch done -> $OUT_DIR"
}

do_sample() {
  echo "== per-symbol zip counts =="
  for S in $SYMS; do
    n=$(ls "$OUT_DIR/$S"/*.zip 2>/dev/null | wc -l || true)
    echo "$S: $n zips"
  done
  echo "== missing log =="
  if [ -f "$OUT_DIR/missing.log" ]; then
    wc -l < "$OUT_DIR/missing.log"
    tail -5 "$OUT_DIR/missing.log"
  else
    echo "no missing.log (fetch not run?)"
  fi
  echo "== CSV header (first symbol with a zip) =="
  for S in $SYMS; do
    Z=$(ls "$OUT_DIR/$S"/*.zip 2>/dev/null | head -1 || true)
    if [ -n "${Z:-}" ]; then
      echo "-- $Z"
      unzip -p "$Z" | head -2 || true
      break
    fi
  done
}

case "${1:-all}" in
  fetch)  do_fetch ;;
  sample) do_sample ;;
  all)    do_fetch; echo ""; do_sample ;;
  *)      echo "usage: bash scripts/s6f-oi-harvest.sh [fetch|sample|all]" >&2; exit 2 ;;
esac
