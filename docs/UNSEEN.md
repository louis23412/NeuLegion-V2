# Unseen-data protocol (TODO 106)

The G5 `unseen` knob is a human attestation by design: scored on data the frozen
spec did not select on. Statistics cannot substitute for the construction
guardrail — sweep `2026-09u`'s 2608.27734 shows a deliberately leaky oracle at
Sharpe 35 surviving DSR and PBO testing completely. This document defines what
counts as unseen, so the attestation is signable rather than vibes.

## 1. What "unseen" means here

Data is unseen for a spec iff **every byte of it arrived after the spec froze**
and **no number read off it fed back into the spec**. Concretely:

- The spec freeze = the lab pin (`FOLD-BACK.md` R8: `ewma 0.02 + cap 12.5 %`) at
  its freeze date, plus the repo composition that ports it (`sleeve_score.js`
  driver, `scoreBookReturns` arithmetic). Anything tuned after seeing a number
  off a dataset disqualifies that dataset — including "we only picked the
  window", "we only chose the fee", "we only fixed a bug the data exposed".
- The shipped files (`src/data/funding_*_8h.jsonl`, `src/data/candles_*_1h.jsonl`)
  are **seen**: the spec was selected with knowledge of this history (F-31/F-36
  decay notes, the λ walk-forward). No re-run over these files can ever sign the
  `unseen` knob, however it is sliced (halves, blocks, years — all seen).

## 2. The only signing procedure

1. **Freeze**: record the spec id, the repo commit (or file hashes — no git here,
   so the `report.json` `inputs` + a dated note), and the freeze timestamp.
2. **Wait**: fetch fresh data *after* the freeze (`npm run fetch:all`; the
   fetcher appends bars it never saw at freeze time). The fresh window must
   cover ≥ 1 year of 8h buckets (≈1095 bars) to be worth scoring.
3. **Pre-register**: write the exact command (`bash scripts/sleeve-runs.sh base`
   plus the cost level) and the pass criterion (G5 without the `unseen` knob)
   *before* running it — a dated line in `RUN-ANALYSIS.md` is enough.
4. **Run once**: a single run on the fresh window. No re-tuning, no second seed
   hunt, no window shopping. If it fails, the outcome is recorded as a full
   result (a failed unseen run is information, not an invitation to re-freeze).
5. **Sign**: the operator records the run id, the fresh window's date range, and
   the pre-registration pointer in `RUN-ANALYSIS.md`. Only then does `unseen`
   flip to true for that run.

## 3. What the report must contain for a signature

- `run.json`: the freeze timestamp + pre-registration pointer (added by hand at
  run time — the CLI does not know the freeze).
- `report.json`: the standard sleeve artifact (the G5 block must pass every
  machine knob; an unseen run that fails `level`/`blocks`/`dsr`/`neutral`
  signs nothing).
- The fresh window's provenance: fetcher log range (first/last bar timestamps)
  proving every bar post-dates the freeze.

## 4. Status

**OPEN — no unseen run has happened.** Rounds 75/76 scored only shipped (seen)
data. The `decay` attestation has machine evidence beside it (`stressHalves`,
`worstBlock`, round-76 `yearly`); the `unseen` attestation has none by
construction, until §2 is executed.
