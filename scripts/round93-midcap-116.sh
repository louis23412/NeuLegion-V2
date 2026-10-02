#!/usr/bin/env bash
#
# round93-midcap-116.sh — TODO 116 turnkey: verify the ported series, manifest, gate, run.
#
# The 8 midcap series ship IN this repo (src/data/candles_*usdt_1h.jsonl,
# ported CYCLE-170). Standing rule: the repo is standalone and never reads
# from src/NeuLegion-lab — data a run needs is ported into src/data/ first.
# This script does every step, refuses to proceed on mismatch, and prints
# the report.json paths at the end.
#
# Provenance: PLAN docs TODO 116 (Round-93, operator-owned) + RUN-ANALYSIS.md
# §83 (the verified recipe: 8/8 series at 19,728 rows, 2024-06-01..2026-08-31,
# zero gaps) + lab CYCLE-167/CYCLE-168.
#
# Usage:  bash scripts/round93-midcap-116.sh [stage]
#   port       verify the 8 midcap series in src/data/ + append the 8 manifest
#              entries (idempotent) + verify
#   gate       bash scripts/test.sh quick (structural gate incl. §J2 manifest-map checks)
#   runs       the three runs: gh (K=5, 16-panel) + cadenced/exposure restatement + --test=10 leg
#   all        port, gate, runs in order (default; ~2h wall, mostly the two gh runs)
#
# Reads, in order: (1) effStreams >= 2.3 on 16 + vol adjDSR up from 0.9340 (the
# 116 gate); (2) verdict-neutrality under --cadences/--exposure-match (the 87
# acceptance); (3) level-shift at --test=10 reproducing the §15 shape (the 84 record).

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

SYMS="arb avax inj near op sei sui tia"
MANIFEST="src/candles_audit.js"

do_port() {
    echo "== 116/port: checking the 8 midcap series in src/data/ =="
    for s in $SYMS; do
        f="src/data/candles_${s}usdt_1h.jsonl"
        [ -f "$f" ] || { echo "FATAL: missing $f" >&2; return 1; }
        n=$(wc -l < "$f")
        [ "$n" -eq 19728 ] || { echo "FATAL: $f has $n lines, want 19728" >&2; return 1; }
    done
    n=$(ls src/data/candles_*usdt_1h.jsonl | wc -l)
    [ "$n" -eq 15 ] || { echo "FATAL: src/data/ holds $n candle files, want 15 (7 majors + 8 midcap; BTC is src/candles.jsonl)" >&2; return 1; }
    echo "ok: 8/8 midcap series in src/data/ at 19,728 rows (15 candle files total)"

    echo "== 116/port: manifest entries =="
    if grep -q "'ARBUSDT'" "$MANIFEST"; then
        echo "ok: manifest already carries the midcap entries (skipped)"
    else
        node --input-type=module <<'NODE_EOF'
import fs from 'node:fs';
const p = 'src/candles_audit.js';
const t = fs.readFileSync(p, 'utf8');
const anchor = "    { symbol: 'LINKUSDT', interval: '1h', file: 'src/data/candles_linkusdt_1h.jsonl', minRows: 65_000, group: 'binance-1h' },\n";
if (!t.includes(anchor)) { console.error('FATAL: manifest anchor line not found'); process.exit(1); }
const add = [
    'ARB', 'AVAX', 'INJ', 'NEAR', 'OP', 'SEI', 'SUI', 'TIA',
].map((s) => `    { symbol: '${s}USDT', interval: '1h', file: 'src/data/candles_${s.toLowerCase()}usdt_1h.jsonl', minRows: 19_000, group: 'binance-1h' },\n`).join('');
fs.writeFileSync(p, t.replace(anchor, anchor + add));
NODE_EOF
        grep -c "group: 'binance-1h'" "$MANIFEST" | grep -q '^16$' || { echo "FATAL: manifest should hold 16 binance-1h entries now" >&2; return 1; }
        echo "ok: 8 midcap entries appended (16 binance-1h total)"
    fi
}

do_gate() {
    echo "== 116/gate =="
    bash scripts/test.sh quick
}

GH_FLAGS="--symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --concurrency=4 --variants=baseline,sig-momentum,sig-vol-momentum,sig-blend-momentum,sig-network-momentum --cost-ladder=0,2,5,10"

do_runs() {
    echo "== 116/runs: gh on the 16-panel =="
    # shellcheck disable=SC2086
    bash scripts/round30-runs.sh gh
    echo "== 116/runs: cadenced + exposure-matched restatement =="
    # shellcheck disable=SC2086
    npm run analyze -- $GH_FLAGS --cadences=10,15,20 --exposure-match
    echo "== 116/runs: --test=10 level-shift leg =="
    npm run analyze -- --symbols=all --bars=600 --train=60 --test=10 --audit-probes=1 --reuse-base --concurrency=4 --variants=baseline,sig-momentum,sig-vol-momentum,sig-blend-momentum,sig-network-momentum --cost-ladder=0,2,5,10
    echo ""
    echo "== newest run reports =="
    ls -t state/runs/*/report.json 2>/dev/null | head -3 || echo "(no state/runs/*/report.json found — check the run output above)"
}

case "${1:-all}" in
    port) do_port ;;
    gate) do_gate ;;
    runs) do_runs ;;
    all) do_port; do_gate; do_runs ;;
    *) echo "usage: bash scripts/round93-midcap-116.sh [port|gate|runs|all]" >&2; exit 2 ;;
esac
