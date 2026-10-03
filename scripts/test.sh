#!/usr/bin/env bash
#
# test.sh — run only the tests you need (nothing more).
#
# The full gate is `npm test` (node --test "test/node/*.test.js", 131 blocks,
# ~6 min on the operator's machine). Most edits touch one area, so use:
#
#   bash scripts/test.sh quick               # structural gate (ledger pins) — seconds
#   bash scripts/test.sh <name> [...]        # one file each: analysis contracts ...
#   bash scripts/test.sh quick analysis      # groups + files compose
#   bash scripts/test.sh full                # identical to npm test
#   bash scripts/test.sh                     # list every name (same as --help)
#
# Which to run after an edit:
#   docs/ledger/lock-registry/mirrors .... quick
#   src/analysis/* ...................... analysis (+ walkforward if the fold path moved)
#   src/analyze/* ....................... analyze
#   src/core + plugins .................. contracts (+ analyze — the driver asserts them)
#   hivemind/* .......................... the matching suite (core, lsh, guards, ...) + golden
#   hot path, goldens, or a release ..... full
#
# Every run prints its exact node command first, so a failure is re-runnable
# by copy-paste. See docs/RUNBOOK.md §6 for the ledger these counts pin.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

QUICK="mirrors locks modules contracts guards"

ALL="analysis analyze analyze_cli binarypc bitweight candles checkpoint_throttle
  config_env consolidation consolidation_worker contracts controller_invariants core
  dimensions dryrun engine_portability evolve features fetcher golden guards homeostasis
  http_view indicators legacy_hivemind legion locks lsh mirrors modules multiprobe
  multisymbol observer parallel_folds preflight price_precision querymod
  report_lifecycle runner_smoke sample_weights sanity shutdown surprise walkforward
  worker_pool"

usage() {
  cat <<'EOF'
Usage: bash scripts/test.sh [quick] [full] [<name> ...]
  quick   mirrors locks modules contracts guards (the structural gate)
  full    identical to npm test (all 131 blocks, ~6 min)
  <name>  one test/node file by stem, with or without .test.js;
          repeatable: bash scripts/test.sh core guards locks
Names:
EOF
  # shellcheck disable=SC2086
  echo "  $ALL" | tr -s ' \n' ' \n'
}

FILES=()
for arg in "$@"; do
  case "$arg" in
    full) exec npm test ;;
    quick)
      # shellcheck disable=SC2086
      for q in $QUICK; do FILES+=("test/node/$q.test.js"); done
      ;;
    -h|--help|help) usage; exit 0 ;;
    *)
      stem="${arg%.test.js}"
      f="test/node/$stem.test.js"
      if [ ! -f "$f" ]; then echo "FATAL: unknown test '$arg' ($f not found)" >&2; usage >&2; exit 2; fi
      FILES+=("$f")
      ;;
  esac
done

if [ "${#FILES[@]}" -eq 0 ]; then usage; exit 2; fi

DEDUPED=()
for f in "${FILES[@]}"; do
  skip=0
  for d in "${DEDUPED[@]}"; do if [ "$d" = "$f" ]; then skip=1; break; fi; done
  if [ "$skip" -eq 0 ]; then DEDUPED+=("$f"); fi
done

echo "== node --test ${DEDUPED[*]}"
node --test "${DEDUPED[@]}"
