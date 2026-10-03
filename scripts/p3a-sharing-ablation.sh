#!/usr/bin/env bash
#
# p3a-sharing-ablation.sh — P3 sharing-off A/B, native confirmation (director GO, CYCLE-247; standalone rewrite CYCLE-250).
#
# AI-side verdict (harness, CYCLE-247): SHARING-DEAD — |ON-OFF| <= 0.0107 on
# both metrics at all 3 seeds (bar 0.02). This script re-runs the SAME probe
# natively to rule out a harness artefact before any delete decision.
# Standalone: the recipe is vendored in scripts/p3a-sharing.mjs (zero lab
# dependency — the repo ships standalone; no repo script may reference
# src/NeuLegion-lab/). Read-only on production code (probe-only no-op
# override on the instance inside the script); state DBs land in mkdtemp
# dirs and are removed after (no repo writes).
#
# Usage:  bash scripts/p3a-sharing-ablation.sh
#
# Requires: node >= 22, installed deps (better-sqlite3 loads at import).
#   If the import fails: npm install   (then re-run)
# Paste back: the full stdout. No `npm test` needed (nothing edited).
#
# RULE (pre-registered, BODY-VARIANTS.md P3): native |ON-OFF| < 0.02 both
# metrics all seeds -> SHARING-DEAD confirmed, R-SHARING deletion executes.
# Else SHARING-MATTERS (keep + characterize).

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${OUT_DIR:-/tmp/p3a}"

mkdir -p "$OUT_DIR"
node --version
node scripts/p3a-sharing.mjs --out "$OUT_DIR/p3a.json"
