# NeuLegion — dropped register (what failed, and why it is not coming back)

**Established: round 30 planning.** Every candidate hypothesis this project has tested and
rejected, with the measurement that killed it. A drop is a *result*, not a failure of the project:
the point of the A/B harness is to produce these cheaply. This file exists so that a future agent
(or a future version of the author) does not re-run a dead branch, and so that "the bot has no
edge" is never an unexamined claim.

The states are defined in [`LINEAGE.md`](LINEAGE.md) §1. **`DROPPED`** = removed from the default
roster *and* from future searches. **`PARK`** = an open question, resolvable by id but out of the
default roster (it is in `LINEAGE.md`, not here). Only `DROPPED` branches appear in this file.

> **What is NOT being deleted.** A dropped *hypothesis* removes a candidate from the A/B roster; it
> does **not** delete the underlying code. The memory subsystem (`lsh`, `replay`, `consolidation`,
> `banks`, `protos`, `surprise`, `multiprobe`, `querymod`, `pca-hash`/`binarypc`/`bitweight`), the
> controller, the ensemble machinery and the labels are all **core hivemind code**, golden-pinned
> and exercised by `lsh.test.js` (75), `core.test.js` (46), `controller_invariants.test.js` (23),
> `multiprobe.test.js` (77), `querymod.test.js` (51), `golden.test.js` (23) and others. Removing
> that code would (a) change the controller's behaviour, (b) move golden fingerprints, and (c)
> destroy the sample-weighting / liveness machinery the gate depends on. The purge is therefore a
> **roster + document** purge, plus a dead-export audit (see `PLAN-round30.md` §2), not a code
> demolition.

## 1. Dropped mechanism hypotheses (NL-MECH)

| branch | lineage id | the hypothesis | the measurement that killed it | source |
| --- | --- | --- | --- | --- |
| `surprise` | `NL-MECH-surprise@r2` | surprise-gated memory writes (Titans) improve the controller | net Sharpe **+0.098** @200 bars → **−0.028** @600; never significant, never in the top tier; forecast `brierSkill` ≈ −0.0075 | `RUN-ANALYSIS.md` §17.6 |
| `homeostasis` | `NL-MECH-homeostasis@r2` | homeostatic per-member learning rates improve the ensemble | net Sharpe **−0.163** @600 (−0.225 @200); fails `dsrDelta` (worse than baseline) | §17.6 |
| `pca-hash` | `NL-MECH-pca-hash@r13` | data-aware (PCA-aligned) LSH hyperplanes change the retrieved set and the score | **behaviourally inert**: 72/72 folds identical to baseline at 200 bars; 6/288 folds differ at 600 but economically nil — paired ΔSharpe **0.0043**, p **0.19**, foldWinFraction **0.01** (`RUN-ANALYSIS.md` §13.2, `BUGS.md` #53) | §17.6 |

## 2. Dropped signal hypotheses (NL-SIG)

All measured on the 8×600 acceptance run (`RUN-ANALYSIS.md` §17.6) and the 8×200 sanity run (§17.2).

| branch | lineage id | net Sharpe @600 | why dropped |
| --- | --- | --- | --- |
| `sig-frac-momentum` | `NL-SIG-frac-momentum@r23` | **−0.4185** | worst arm on every axis; turnover **2092/bar** (vs momentum's 810) makes it structurally cost-fragile; the saturating re-parameterisation of momentum adds nothing |
| `sig-vol-regime` | `NL-SIG-vol-regime@r23` | **−0.3135** | negative; fails the `dsrDelta` hurdle (worse than the baseline it was meant to improve) |
| `sig-autocorr` | `NL-SIG-autocorr@r23` | **−0.0996** | **not robust to the window**: +1.79 @200 bars but −0.10 @600 — a regime-dependent artefact, not an edge |
| `sig-volume` | `NL-SIG-volume@r23` | **−0.0008** | exactly flat (break-even −0.01 bps): no edge to reject on cost, no edge to keep |

## 3. Dropped benchmark (NL-BENCH)

| branch | lineage id | why dropped |
| --- | --- | --- |
| `bench-mlp` | `NL-BENCH-mlp@r29` | decisively the **worst forecaster**: Brier **0.27431** vs base-rate 0.25296, `brierSkill −0.0972`, eliminated from the MCS at p 0.001. The MLP adds variance without skill on this feature vector; keeping it in a roster only inflates `K`. |

## 4. What is explicitly NOT dropped (and why) — the "parked" set

Recorded here so a reader does not mistake PARK for DROPPED:

- **`multiprobe`, `querymod`** — `appliesTo:'broadcast'`: they act on the memory broadcast path the
  scored model never reads back (R27-2). They are **not proven bad**; they are **not scoreable on
  this harness**. Parked (kept resolvable, never in the default roster).
- **`sig-range`, `sig-agreement`** — *positive* Sharpe arms with a **real cross-sectional
  component** (`RUN-ANALYSIS.md` §16.1: common-share 0.61 / 0.66). They fail the gate, but they are
  the only arms that are not ~100 % market exposure, so they are the natural seed of a
  decorrelated/breadth sleeve. Parked as research arms.
- **The reversal family (`NL-REV-*`)** — real effect (6/8 symbols, 51.9 % accuracy on 640k bars) but
  a **taker-cost** rejection. Parked pending a maker-fee/queue model (`TODO.md` 94).
- **`bench-linear`, `bench-base-rate`** — the model-class benchmark results that *grounded* the
  negative branch (G-A). Parked as references; the base rate is the bar any future forecaster must
  beat.
- **`sample-weights` (+ scale control), `label-conservative`, `label-triple`** — opt-in, confounded
  or untested in the last batch. Parked.
- **The `NL-CTRL` controller, `sig-momentum`, `sig-accel`** — the keepers (`LINEAGE.md` §3).

## 5. Purge checklist (what "dropping" actually changes)

- [x] Remove the DROPPED branches from the **default A/B roster** (`analyze.js#ALL_VARIANTS`), so
      `K` shrinks and the report no longer scores them. They stay in `RESOLVABLE_VARIANTS` (by-id
      opt-in) so the measurement is reproducible and citable. **Done (round 30):** `ALL_VARIANTS`
      is now filtered by `lineage.js#DEFAULT_ROSTER_IDS`; `RESOLVABLE_VARIANTS` is unchanged.
- [x] Mark each DROPPED branch in `src/README.md`'s module narrative and in `LINEAGE.md`. **Done.**
- [x] Add a **regression pin** on the default roster (a snapshot of the roster ids + count) so a
      future edit that silently re-adds a dropped branch fails a test. **Done:** `analyze.test.js`
      `§A2b` pins `rosterSnapshot().hash` and asserts every dropped id is absent-yet-resolvable.
- [x] Do **not** delete the memory/controller/label code (see the box at the top). **Done:** the
      modules ship, golden-pinned; the branches are dropped from the *roster*, not the codebase.
- [x] Re-run the full suite; the roster change touches no golden (roster is opt-in configuration,
      not a scored formula) — verify with `golden.test.js` 23/0 and a full `2558/0`. **Done:**
      `golden` 23/0, `locks` 41/0, full suite **2585/0** (the 2558 in §1/§5 of `PLAN-round30.md`
      was the pre-prune count; `analyze` 269 → 279 is the roster/register/#69/#70 work and
      `analysis` 621 → 638 is the M7 momentum-upgrade section plus the two §5 property tests).
