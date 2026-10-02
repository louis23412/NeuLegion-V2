# Next-step plan (post-round-109) — what to do, in what order, and what kills what

**Status: PLAN ONLY — no code, no runs, no gates moved.** Written 2026-10-02
from the tree as it stands: native gate green 132/132 (R109 + S1/S5 + S7),
sleeves landed as UNTESTED V2.2 plugins and verified bit-for-bit lab-side
(F-81) but never scored on real data through the repo gate, model direction
dead (TODO 111 measured-complete), L19 the lab's only open mechanism.

The single sentence: **everything lab-side is banked; everything repo-side is
unproven — so the next work is almost entirely native scoring runs, in an
order where each run unlocks (or kills) the runs below it.**

## 0. Where things stand (the three facts that order everything)

1. **The lab is done measuring what it can.** Every sleeve has a pinned spec,
   a falsifier survived, a capacity distribution, and a port artefact
   (`prototypes/port.js`). The only open mechanism (L19, OI-change) is a
   standalone micro-sleeve that does NOT add to R8 — a shelve-or-size
   decision, not a research programme. L10 is charter-ongoing.
2. **The repo has the machinery but no promoted result.** `--sleeve` mode,
   the carry view builder, the G5 conjunction scorer, the demean tool, the
   V2.3 learner slots all landed. What has never happened: a sleeve scored
   on real data through the repo's own gate (G2), and a portfolio passing G5
   beyond the flat-book claim (F-119).
3. **The binding constraints are operator machine time and fresh data.**
   Sixteen-symbol panels, sleeve runs, and the unseen year all need the
   native driver. AI-side work cannot substitute for any of them — it can
   only prepare exact commands and pre-registered reads so no operator run
   is wasted.

## Phase A — Operator breadth reads (unlocks everything; TODO 116 → 118 → 117)

Do these first, in this order. Each has a pre-registered interest so the
read is a decision, not a look.

**A1 — 116: native midcap port + 16-panel `gh`.** Copy the 8 vendored midcap
series to the repo candle convention, register in `CANDLE_MANIFEST`,
`bash scripts/test.sh quick`, then the K=5 `gh` roster natively on 16 symbols.
Pre-registered interest: effStreams ≥ 2.3 (lab 2.35) with vol adjDSR moving
up from 0.9173. **This is the G3 answer** (≥ 2.5 of 9 was the gate; 2.3 on a
16-panel with the vol arm rising is a pass with a note, below 2.0 is a fail).
Cost: ~17 MB + one ~45-min run. Upload `state/runs/<runId>/report.json`.

**A2 — 118: stacked-16 carry read (QUEUED behind 116).** Score
`carry-dispersion` natively on the 8-midcap panel, then the stacked-16 book
with cap 0.125 + band ~0.01 (the e135/e136 holdout-certified recipe:
trailing pick 0.01 at 8/8 splits, frozen + fixed beat daily 8/8).
Turnkey since round 110: `bash scripts/sleeve-runs.sh band`
(`--sleeve-cap`/`--sleeve-band` overrides, CAP/BAND env-overridable,
defaults 0.125/0.01; pinned spec unmoved, effective spec echoes in run.json
and the report risk line).
Pre-registered interest: available:true with break-even in the 30–50 bps band
on midcaps; stacked-16 window-matched read vs the majors baseline. Sleeve-only
cost (minutes). Kills or confirms the carry-breadth leg.

**A3 — 117: wave-2 breadth (ONLY if 116 confirms).** Same recipe for the 8
wave-2 series, one K=5 `gh` on the 24-panel. Bar: effStreams ≥ the stacked-16
read with sublinear scaling tolerated (lab measured +34% then +12% — a third
lab wave is pre-refused regardless). If 116 fails, park the whole
symbol-breadth leg with a note, no further waves.

**Falsifier for the phase:** if A1 reads effStreams < 2.0 natively, W5-symbol
is closed as a gate strategy (breadth without independence is F-01's face) and
phases B–C proceed on the 8-major panel only.

## Phase B — The promotion decision (G2, then G5; the pivot's payoff)

This is the highest-EV work in the programme: every sleeve is ported,
pinned, and bit-verified — none is promoted. Run them through the repo gate
on real data, one sleeve at a time, through `--sleeve` mode.

**B1 — G2 per sleeve (R8, then R7, then OI-standalone).** Each book must
reproduce its lab number to display precision through the repo path
(R8 cap 6.18/10×, R8 cap+band 6.31/7×, R7 cap 1.07/8×, OI band 0.92/198× —
the e52 set) and then clear the repo gate on real marks. Promote, keep
UNTESTED, or drop — per sleeve, on the record, with the falsifier named in
FOLD-BACK. Order matters: R8 first (the +6.86 OOS book carries the phase;
if R8 fails natively, R7's +1.14 alone does not justify a portfolio).

**B2 — G5 portfolio conjunction.** The scorer landed (round 41); the claim
has not. Run the conjunction on the flat book (defend the F-119 claim
natively: positive full-history net-of-cost Sharpe, ≥ 4/6 positive blocks,
factor-neutral, within the OI bound, decay check documented), then extend to
the stacked book only if B1 promoted R8. **G5 is the milestone the pivot
exists to reach — B2 is the run that reaches it or refutes it.**

**B3 — L19 shelve-or-size.** The OI sleeve is independent (corr +0.01) but
adds +0.04 Sharpe at 0.10 risk-weight and churns 129.6×/yr in a joint
schedule. Decision: size it standalone on its own clipped schedule
(~$6–28 M thin-alt bound, eps ≈ 0.03 band) or shelve it as characterised.
No more research either way — the construction is final (50/50 + band).

## Phase C — If B promotes (sized, scheduled, joint)

Only opens on a B1 promotion. Do not start early — every item here assumes a
promoted flat/stacked claim.

**C1 — Sized-leg G5 (TODO 104).** `sleeveDsr` on the sized series is
diagnostics until a sized book gets its own G5 pass: capacity + factor-neutral
on the sized series, with a DSR that respects the vol-target limit law
(2503.16878) and closed-loop sizing only (2603.01298 — open-loop
inverse-variance is what explodes turnover, e126's mechanism).

**C2 — Joint OI schedule.** R7+R8 bind on the same thin alts (LINK/DOGE/ADA).
Size a portfolio to the fixed-split joint bound (F-43), clip the joint target
in two dimensions (F-42), never deploy the LP-optimal schedule (F-44:
48.5×/yr for net@4 0.62). If B3 shelved L19, the joint is two sleeves.

**C3 — Decay attestation.** The honest book reads "no decay" since the
round-79 flip; re-attest on the promoted claim with the block-trend read
(F-46's +0.67-slope form), not a fresh fit.

## Phase D — AI-side background (no operator, no gate)

Do these between operator runs; none unblocks anything, all prevent rot.

**D1 — Config robustness (84/85/87).** Scope the evaluation-configuration
nuisance dimension and land the exposure-matched verdict. Pure analysis code,
default-identical.
**D2 — L10 single-source proposals (L10-cv/cw).** The dual-formula
`sharpeStandardError` and twice-defined weight tools need the owner's gate
(importers verified correct — this is hygiene, not a bug fix).
**D3 — Research sweeps continue thin.** Convergence confirms only; a new note
must earn its file (the 10a–10n bar: task-form for an open TODO or it stays
a convergence).
**D4 — Untested surfaces (14).** Fetcher CLIs, vault capacity/prune, ledger
floors, SQLite reload idempotency — background, batch it.

## Parked (do not touch until their unblock arrives)

* **111 execution uses + 1h-horizon ideas** — data-blocked (venue L2 + trade
  prints). The model track is otherwise measured-complete: directional
  CLOSED three ways, HAR-residual CLOSED, V2.3 slots stay UNTESTED/off-roster
  behind a positive residual test that never came. G4 verdict: the model
  stays default-off; no further model work is planned.
* **106 unseen protocol** — waits on ≥ ~1 fresh post-freeze year (procedure
  written in `docs/UNSEEN.md`).
* **90 / 96 (P5 adaptation)** — gate G-D open, nothing measured; needs its
  own design before any work.
* **55 gated leads, 62 entry-age, 89 remainder, 95 borrow/margin** — idea
  store / remainder legs, explicitly queued behind a sized win or new data.

## Anti-re-tread (still in force, extended)

* Do not add another controller/memory mechanism against direction (NL-MECH).
* Do not search model classes for direction (G-A); do not re-open
  meta-labelling without a new feature family (F-35); do not re-open the
  meta question even with e115's +0.0246 — magnitude skill is not a
  tradeable primary (111 measured-complete).
* Do not buy more correlated 1h bars; do not run a third lab breadth wave
  (sublinear scaling measured twice).
* Do not chase reversal to a taker pass (F-32/F-34); do not deploy the
  LP-optimal joint schedule (F-44).
* Do not read a decision off the most recent window (F-01) — every phase
  above names its full-history read.
* Do not start Phase C on lab numbers — the repo gate is the promotion, the
  lab number is the application.

## Sequencing

```
A1 (116) ──pass──▶ A2 (118) ──any──▶ B1 (G2 R8→R7→OI) ──promote──▶ B2 (G5) ──pass──▶ C1→C2→C3
   │                  │
   fail               └── A3 (117) only if A1 confirms
   ▼
W5-symbol closed, B–C on 8 majors
```

D runs anytime (AI-side). Parked items wait on data/time, not on phases.
Operator cost of the whole plan: three panel runs (A1, A2-sleeve minutes,
A3) + three sleeve scorings (B1) + one conjunction (B2) — six native jobs,
each with a pre-registered read, each a decision.
