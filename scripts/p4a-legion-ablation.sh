#!/usr/bin/env bash
#
# p4a-legion-ablation.sh — P4 legion-aggregation ablation on the real repo stack (director GO, CYCLE-244).
#
# Compares full S6 constant-stack (weights x Dijkstra-style propagation) vs
# uniform vs score-only aggregation, arms differing ONLY in finalWeight.
# Zero edits to locked modules, no golden moves, no repo writes (state DBs go
# to tmp via NEULEGION_STATE; resolveConsensus called directly, read-only).
#
# Usage:  bash scripts/p4a-legion-ablation.sh [stage]
#   gate    smoke: 100 bars x 3 seeds (~1 min)
#   runs    full:  500 bars x 3 seeds (several minutes)
#   all     gate then runs (default)
#
# Requires: node >= 22, installed deps (better-sqlite3 loads at import).
#   If the import fails: npm install   (then re-run)
# Paste back: the full stdout of each stage. No `npm test` needed
# (repo untouched — additive scripts only).
#
# Post-collapse firewall (R-LEGION executed CYCLE-250): the shipped path IS the
# score-only arm, so production≡score-only (|diff| == 0) on BOTH frames ->
# COLLAPSED-OK. Else DIVERGED (the collapse changed more than propagation).

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${OUT_DIR:-/tmp/p4a}"

do_gate() {
  mkdir -p "$OUT_DIR"
  node --version
  node scripts/p4a-legion.mjs --bars 100 --out "$OUT_DIR/p4a-gate.json"
}

do_runs() {
  mkdir -p "$OUT_DIR"
  node --version
  node scripts/p4a-legion.mjs --bars 500 --out "$OUT_DIR/p4a-runs.json"
}

case "${1:-all}" in
  gate) do_gate ;;
  runs) do_runs ;;
  all)  do_gate; echo ""; do_runs ;;
  *)    echo "usage: bash scripts/p4a-legion-ablation.sh [gate|runs|all]" >&2; exit 2 ;;
esac
