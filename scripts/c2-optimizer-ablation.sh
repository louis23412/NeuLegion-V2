#!/usr/bin/env bash
#
# c2-optimizer-ablation.sh — C2 optimizer retire-test on the real repo trainer (director GO, CYCLE-198).
#
# Compares stock scaler stack vs global-clip-only vs script-side AdamW on
# frozen expanding folds (marks_8h.json 8h returns, forceMin HiveMind).
# Monkey-patches instances only: zero edits to locked modules, no golden
# moves, no repo writes (state DBs go to tmp; dumpState never called).
#
# Usage:  bash scripts/c2-optimizer-ablation.sh [stage]
#   gate    smoke: 1 block, 300 train / 150 test (~1-3 min)
#   runs    full:  2 blocks, 1200 train / 400 test (several minutes)
#   all     gate then runs (default)
#
# Requires: node >= 22, installed deps (better-sqlite3 loads at import).
#   If the import fails: npm install   (then re-run)
# Paste back: the full stdout of each stage. No `npm test` needed
# (repo untouched — additive scripts only).
#
# RULE (pre-registered): plain~=stock (DM ns) -> DELETE the stack.
# adamw>stock (DM p<0.05) -> ADOPT AdamW. Neither -> keep stock, close C2.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${OUT_DIR:-/tmp/c2}"

do_gate() {
  mkdir -p "$OUT_DIR"
  node --version
  node scripts/c2-ablation.mjs --train 300 --test 150 --blocks 1 --out "$OUT_DIR/c2-gate.json"
}

do_runs() {
  mkdir -p "$OUT_DIR"
  node --version
  node scripts/c2-ablation.mjs --train 1200 --test 400 --blocks 2 --out "$OUT_DIR/c2-runs.json"
}

case "${1:-all}" in
  gate) do_gate ;;
  runs) do_runs ;;
  all)  do_gate; echo ""; do_runs ;;
  *)    echo "usage: bash scripts/c2-optimizer-ablation.sh [gate|runs|all]" >&2; exit 2 ;;
esac
