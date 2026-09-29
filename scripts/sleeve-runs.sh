#!/usr/bin/env bash
#
# sleeve-runs.sh — the real-data carry-dispersion sleeve run set, turnkey.
#
# Why this exists: the sleeve CLI needs the same 8 funding files positionally
# matched to --symbols=all on every invocation, and retyping that list invites
# shell mistakes (e.g. a "<same 8, same order>" placeholder, which bash reads as
# a redirection and answers with "bash: same: No such file or directory"). This
# script defines the file list ONCE and checks every file exists before running
# (the BUGS.md #69 guard, same as scripts/round30-runs.sh), so that failure mode
# cannot recur.
#
# Usage:  bash scripts/sleeve-runs.sh [stage] [-- extra analyze args]
#   base       the flat sleeve at --cost-bps=4 (no --sleeve-sizing)
#   adaptive   + --sleeve-sizing=adaptive  (F-115/F-117 payoff mode)
#   drawdown   + --sleeve-sizing=drawdown  (F-118: adaptive target x trailing-DD governor)
#   honest     flat sleeve + --carry-marks (round 78, TODO 95: the basis-marked
#              book over the full history, not just the shipped-marks window)
#   all        base, adaptive, drawdown, honest
#
# Env:  COST_BPS (default 4), SLEEVE (default carry-dispersion).
# Any extra args after the stage (or after "--") are appended to every run, e.g.
#   bash scripts/sleeve-runs.sh drawdown -- --sleeve-sizing-window=48
#
# Every run writes state/runs/<runId>/ (report.json, run.json, run.log).

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

SLEEVE="${SLEEVE:-carry-dispersion}"
COST_BPS="${COST_BPS:-4}"
FUND="src/data/funding_btcusdt_8h.jsonl,src/data/funding_ethusdt_8h.jsonl,src/data/funding_solusdt_8h.jsonl,src/data/funding_bnbusdt_8h.jsonl,src/data/funding_xrpusdt_8h.jsonl,src/data/funding_adausdt_8h.jsonl,src/data/funding_dogeusdt_8h.jsonl,src/data/funding_linkusdt_8h.jsonl"
# Ext mark history for the `honest` stage (round 78, TODO 95): the vendored
# basis-mark series, repo-local so this script never reaches outside the repo.
# Override with a different file when needed, e.g.
#   MARKS=/path/to/other_marks.json bash scripts/sleeve-runs.sh honest
MARKS="${MARKS:-src/data/marks_8h.json}"

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

check_file() {   # check_file <var-name> <path> — the single-file #69 guard
  if [ -z "${2:-}" ]; then echo "FATAL: \$$1 is empty (BUGS.md #69)" >&2; return 1; fi
  if [ ! -f "$2" ]; then echo "FATAL: \$$1 cites a missing file: $2 (override with $1=/path/to/file)" >&2; return 1; fi
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

usage() {
  cat <<'EOF'
Usage: bash scripts/sleeve-runs.sh [stage] [-- extra analyze args]
  stages: base adaptive drawdown honest all (default: all)
    base       flat carry-dispersion sleeve at --cost-bps=4
    adaptive   + --sleeve-sizing=adaptive
    drawdown   + --sleeve-sizing=drawdown
    honest     flat sleeve + --carry-marks (basis-marked book, TODO 95)
    all        base, adaptive, drawdown, honest
Env: COST_BPS (default 4), SLEEVE (default carry-dispersion).
Extra args after the stage (or after "--") are appended to every run.
Every run writes state/runs/<runId>/. Send back each run's report.json path.
EOF
}

STAGE="${1:-all}"
if [ $# -gt 0 ]; then shift; fi
if [ "${1:-}" = "--" ]; then shift; fi
EXTRA=("$@")

check_list FUND "$FUND"

run_stage() {
  case "$1" in
    base)     run "sleeve / base (flat)" npm run analyze -- --sleeve="$SLEEVE" --symbols=all --carry-files="$FUND" --cost-bps="$COST_BPS" "${EXTRA[@]}" ;;
    adaptive) run "sleeve / adaptive sizing" npm run analyze -- --sleeve="$SLEEVE" --symbols=all --carry-files="$FUND" --cost-bps="$COST_BPS" --sleeve-sizing=adaptive "${EXTRA[@]}" ;;
    drawdown) run "sleeve / drawdown sizing (F-118)" npm run analyze -- --sleeve="$SLEEVE" --symbols=all --carry-files="$FUND" --cost-bps="$COST_BPS" --sleeve-sizing=drawdown "${EXTRA[@]}" ;;
    honest)   check_file MARKS "$MARKS"; run "sleeve / honest marks (TODO 95)" npm run analyze -- --sleeve="$SLEEVE" --symbols=all --carry-files="$FUND" --cost-bps="$COST_BPS" --carry-marks="$MARKS" "${EXTRA[@]}" ;;
    *)        usage; exit 2 ;;
  esac
}

if [ "$STAGE" = "all" ]; then
  for s in base adaptive drawdown honest; do run_stage "$s"; done
else
  run_stage "$STAGE"
fi
