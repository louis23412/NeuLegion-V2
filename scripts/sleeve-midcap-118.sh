#!/usr/bin/env bash
#
# sleeve-midcap-118.sh — TODO 118 turnkey: midcap + stacked-16 honest sleeve runs.
#
# The midcap honesty gate is cleared: repo-local `src/data/marks_midcap_8h.json`
# (8/8 symbols, t0 2024-06-01T00:00, 2467 8h slots, 3 nulls each — harvested
# CYCLE-174 from Binance Vision markPriceKlines) and the merged
# `src/data/marks_stacked16_8h.json` (majors + midcaps, per-symbol maps).
# Standing rule: everything ships in the repo; this script never reads
# outside it (same #69 guards as scripts/sleeve-runs.sh).
#
# Usage:  bash scripts/sleeve-midcap-118.sh [stage]
#   mid          8-midcap honest flat sleeve (carry-marks, cost 4)
#   midband      8-midcap honest + cap 0.125 / band 0.01 (the e135 lane)
#   sixteen      stacked-16 honest flat sleeve (merged marks, cost 4)
#   sixteenband  stacked-16 honest + cap 0.125 / band 0.01 (Round-107 update)
#   all          all four in order (default; minutes total, sleeve-only)
#
# Dependency: the 116 manifest entries. If missing, the script applies the
# 116 port stage itself (loudly) instead of failing — ordering traps are the
# script's problem, not the operator's.
#
# Reads: availability + pooled net/turnover/BE vs the majors honest baseline
# (6.25 net, BE 42.9); pre-registered interest: available:true, BE 30-50 bps.
# Every run writes state/runs/<runId>/ — send back each report.json path.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

SLEEVE="${SLEEVE:-carry-dispersion}"
COST_BPS="${COST_BPS:-4}"
MID_SYMS="ARBUSDT,AVAXUSDT,INJUSDT,NEARUSDT,OPUSDT,SEIUSDT,SUIUSDT,TIAUSDT"
MID_FUND="src/data/funding_arbusdt_8h.jsonl,src/data/funding_avaxusdt_8h.jsonl,src/data/funding_injusdt_8h.jsonl,src/data/funding_nearusdt_8h.jsonl,src/data/funding_opusdt_8h.jsonl,src/data/funding_seiusdt_8h.jsonl,src/data/funding_suiusdt_8h.jsonl,src/data/funding_tiausdt_8h.jsonl"
FUND16="src/data/funding_btcusdt_8h.jsonl,src/data/funding_ethusdt_8h.jsonl,src/data/funding_solusdt_8h.jsonl,src/data/funding_bnbusdt_8h.jsonl,src/data/funding_xrpusdt_8h.jsonl,src/data/funding_adausdt_8h.jsonl,src/data/funding_dogeusdt_8h.jsonl,src/data/funding_linkusdt_8h.jsonl,src/data/funding_arbusdt_8h.jsonl,src/data/funding_avaxusdt_8h.jsonl,src/data/funding_injusdt_8h.jsonl,src/data/funding_nearusdt_8h.jsonl,src/data/funding_opusdt_8h.jsonl,src/data/funding_seiusdt_8h.jsonl,src/data/funding_suiusdt_8h.jsonl,src/data/funding_tiausdt_8h.jsonl"
MARKS_MID="src/data/marks_midcap_8h.json"
MARKS_16="src/data/marks_stacked16_8h.json"

check_list() {   # check_list <var-name> <comma-list>
  local name="$1" list="$2" f n=0
  local IFS=','
  if [ -z "$list" ]; then echo "FATAL: \$$name is empty (BUGS.md #69)" >&2; return 1; fi
  for f in $list; do
    if [ ! -f "$f" ]; then echo "FATAL: \$$name cites a missing file: $f" >&2; return 1; fi
    n=$((n + 1))
  done
  echo "ok: \$$name -> $n files present"
}

check_file() {   # check_file <var-name> <path>
  if [ -z "${2:-}" ]; then echo "FATAL: \$$1 is empty (BUGS.md #69)" >&2; return 1; fi
  if [ ! -f "$2" ]; then echo "FATAL: \$$1 cites a missing file: $2" >&2; return 1; fi
  echo "ok: \$$1 -> $2 present"
}

run() {          # run <label> <command...>
  local label="$1"; shift
  echo ""
  echo "================================================================================"
  echo "== $label"
  echo "== \$ $*"
  echo "================================================================================"
  "$@"
}

if ! grep -q "'ARBUSDT'" src/candles_audit.js; then
  echo "== manifest lacks the midcap entries — applying the 116 port stage first =="
  bash scripts/round93-midcap-116.sh port
fi

do_mid()         { check_list MID_FUND "$MID_FUND"; check_file MARKS_MID "$MARKS_MID"; run "sleeve / midcap-8 honest flat (TODO 118)" npm run analyze -- --sleeve="$SLEEVE" --symbols="$MID_SYMS" --carry-files="$MID_FUND" --cost-bps="$COST_BPS" --carry-marks="$MARKS_MID"; }
do_midband()     { check_list MID_FUND "$MID_FUND"; check_file MARKS_MID "$MARKS_MID"; run "sleeve / midcap-8 honest + cap/band (e135 lane)" npm run analyze -- --sleeve="$SLEEVE" --symbols="$MID_SYMS" --carry-files="$MID_FUND" --cost-bps="$COST_BPS" --carry-marks="$MARKS_MID" --sleeve-cap="${CAP:-0.125}" --sleeve-band="${BAND:-0.01}"; }
do_sixteen()     { check_list FUND16 "$FUND16"; check_file MARKS_16 "$MARKS_16"; run "sleeve / stacked-16 honest flat (TODO 118)" npm run analyze -- --sleeve="$SLEEVE" --symbols=all --carry-files="$FUND16" --cost-bps="$COST_BPS" --carry-marks="$MARKS_16"; }
do_sixteenband() { check_list FUND16 "$FUND16"; check_file MARKS_16 "$MARKS_16"; run "sleeve / stacked-16 honest + cap/band (Round-107)" npm run analyze -- --sleeve="$SLEEVE" --symbols=all --carry-files="$FUND16" --cost-bps="$COST_BPS" --carry-marks="$MARKS_16" --sleeve-cap="${CAP:-0.125}" --sleeve-band="${BAND:-0.01}"; }

case "${1:-all}" in
    mid)         do_mid ;;
    midband)     do_midband ;;
    sixteen)     do_sixteen ;;
    sixteenband) do_sixteenband ;;
    all)         do_mid; do_midband; do_sixteen; do_sixteenband; echo ""; echo "== newest run reports =="; ls -t state/runs/*/report.json 2>/dev/null | head -4 ;;
    *)           echo "usage: bash scripts/sleeve-midcap-118.sh [mid|midband|sixteen|sixteenband|all]" >&2; exit 2 ;;
esac
