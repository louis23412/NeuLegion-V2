#!/usr/bin/env bash
#
# round30-runs.sh — the round-30 operator run set, turnkey.
#
# Why this exists: the 2026-09-24/25 acceptance batch ran 3c/3d with $CANDLES_15M / $FUND unset,
# so --files= / --carry-files= expanded empty and analyze.js silently fell back to the default
# dataset / no sleeve (BUGS.md #69). This script defines the file lists here and *checks every file
# exists* before running, so that failure mode cannot recur.
#
# Provenance: PLAN-round30.md §6.2 (gates G-F…G-K) + §6.3 (immediate operator runs),
# round29-TESTING.md §3/§5 (the corrected commands), RUN-ANALYSIS.md §16–§17 (the readouts).
#
# Usage:  bash scripts/round30-runs.sh <stage>
#   p1       §3b  P1 model-class benchmark (--model=bare, required for a §16.2 comparison)
#   p3       §3c  P3 short-horizon reversal on the 15m basket  (gate G-K)
#   p4       §3d  P4 funding/carry sleeve (+ P2 chain)         (gate G-J)
#   verdict  §3e  the pruned verdict run (K=3 at the shipped default roster)
#   seeds    G-F  the same verdict under 5 master seeds with CRN (pairedVarianceRatio)
#   breadth  G-G  the pruned verdict + the funding sleeve as a 9th panel stream
#   gh       G-H  the pre-registered round-30 momentum upgrades vs baseline+sig-momentum
#   all      p1, p3, p4, verdict, seeds, breadth, gh
#
# Every run writes state/runs/<runId>/. See round29-TESTING.md §4 for what to send back.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

CANDLES_15M="src/data/candles_btcusdt_15m.jsonl,src/data/candles_ethusdt_15m.jsonl,src/data/candles_solusdt_15m.jsonl,src/data/candles_bnbusdt_15m.jsonl,src/data/candles_xrpusdt_15m.jsonl,src/data/candles_adausdt_15m.jsonl,src/data/candles_dogeusdt_15m.jsonl,src/data/candles_linkusdt_15m.jsonl"
FUND="src/data/funding_btcusdt_8h.jsonl,src/data/funding_ethusdt_8h.jsonl,src/data/funding_solusdt_8h.jsonl,src/data/funding_bnbusdt_8h.jsonl,src/data/funding_xrpusdt_8h.jsonl,src/data/funding_adausdt_8h.jsonl,src/data/funding_dogeusdt_8h.jsonl,src/data/funding_linkusdt_8h.jsonl"

# the #69 guard: a present-but-empty (or file-less) list is the bug we are avoiding
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

run() {          # run <label> <command...>
  local label="$1"; shift
  echo ""
  echo "================================================================================"
  echo "== $label"
  echo "== \$ $*"
  echo "================================================================================"
  "$@"
}

usage() {
  cat <<'EOF'
Usage: bash scripts/round30-runs.sh <stage>
  stages: p1 p3 p4 verdict seeds breadth gh all
    p1       §3b  P1 model-class benchmark (--model=bare, required for a 16.2 comparison)
    p3       §3c  P3 short-horizon reversal on the 15m basket  (gate G-K)
    p4       §3d  P4 funding/carry sleeve (+ P2 chain)         (gate G-J)
    verdict  §3e  the pruned verdict run (K=3 at the shipped default roster)
    seeds    G-F  the same verdict under 5 master seeds with CRN (pairedVarianceRatio)
    breadth  G-G  the pruned verdict + the funding sleeve as a 9th panel stream
    gh       G-H  the round-30 momentum upgrades vs baseline+sig-momentum
    all      p1, p3, p4, verdict, seeds, breadth, gh
Every run writes state/runs/<runId>/. See docs/round29-TESTING.md §3-§5.
EOF
}

run_stage() {
  case "$1" in
    p1)      run "3b / P1 model-class benchmark (bare)" npm run analyze -- --model=bare --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --variants=bench-base-rate,bench-linear,bench-mlp --cost-ladder=0,2,5,10 ;;
    p3)      check_list CANDLES_15M "$CANDLES_15M"
             run "3c / P3 reversal on the 15m basket (G-K)" npm run analyze -- --files="$CANDLES_15M" --bars=2000 --train=60 --test=15 --audit-probes=1 --reuse-base --variants=sig-reversal,sig-reversal-4,sig-reversal-vol,sig-reversal-xs --cost-ladder=0,2,5,10 ;;
    p4)      check_list FUND "$FUND"
             run "3d / P4 funding-carry sleeve + P2 chain (G-J)" npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --carry-files="$FUND" --cadences=10,15,30 --cost-ladder=0,2,5,10 ;;
    verdict) run "3e / pruned verdict run (K=3)" npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --concurrency=4 --cost-ladder=0,2,5,10 ;;
    seeds)   run "G-F / seed replication (5 seeds, CRN)" npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --concurrency=4 --seeds=1,2,3,4,5 --cost-ladder=0,2,5,10 ;;
    breadth) check_list FUND "$FUND"
             run "G-G / pruned verdict + funding sleeve (9th panel stream)" npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --concurrency=4 --carry-files="$FUND" --cost-ladder=0,2,5,10 ;;
    gh)      run "G-H / round-30 momentum upgrades vs baseline+sig-momentum (K=6)" npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --concurrency=4 --variants=baseline,sig-momentum,sig-vol-momentum,sig-blend-momentum,sig-network-momentum,sig-regime-momentum --cost-ladder=0,2,5,10 ;;
    *)       usage; exit 2 ;;
  esac
}

if [ "${1:-}" = "all" ]; then
  for s in p1 p3 p4 verdict seeds breadth gh; do run_stage "$s"; done
else
  run_stage "${1:-}"
fi
