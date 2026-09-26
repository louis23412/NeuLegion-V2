# PLAN — round 30: prune the search, buy independence, version the designs

**Status: plan frozen; execution underway (M1–M3, M7 implemented).** This document freezes the
direction, the purge list, the lineage register, the new-code/test/experiment map, and
the acceptance gates for the round. It was written *before* any implementation; the round-30
execution has since landed **M1–M3** (the pruned roster + register contract in `src/lineage.js`, the
`analyze.test.js` §A2b checks, and the `BUGS.md` #69/#70 fixes) and **M7** (the four pre-registered
momentum upgrades) — see `MILESTONES.md` **M8** and the
§7 checklist below for per-item status. The rest of the document is unchanged, so a future agent (or
the author after a context loss) can execute the remainder without re-deriving anything.

Companion docs (all created/updated in this planning phase):

| doc | role |
| --- | --- |
| [`MILESTONES.md`](MILESTONES.md) | the milestone checklist — where the project stands and what this milestone certifies |
| [`LINEAGE.md`](LINEAGE.md) + [`lineage.json`](lineage.json) | the family-tree register (ids, versions, states) |
| [`DROPPED.md`](DROPPED.md) | every rejected hypothesis, with the measurement that killed it |
| [`research/round30-winning-mechanisms.md`](research/round30-winning-mechanisms.md) + `research/raw/arxiv-sweep-2026-09q.json` | the research pull on what proved working |
| [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §17 | the acceptance-batch readout this plan is built from |
| [`round29-IMPLEMENTATION.md`](round29-IMPLEMENTATION.md) §8, [`round29-TESTING.md`](round29-TESTING.md) §5 | the execution log and the corrected operator commands |

---

## 1. Frozen facts (the evidence base)

From the five operator runs (`RUN-ANALYSIS.md` §17) and the fresh end-to-end suite this planning
phase ran:

1. **The pipeline is deterministic and reproducible.** `--cadences` is pure post-processing (the
   concurrency-1 run *with* it is byte-identical to the concurrency-4 run *without* it on every
   scored number) and parallel dispatch is deterministic (`BUGS.md` #68 closed).
2. **The controller is not the edge.** Baseline net Sharpe **−0.1147**, break-even −2.58 bps;
   forecast `brierSkill` ≈ −0.009, `status 'base-rate'`; the controller family is an MCS tie with
   no skill.
3. **The signal family is the edge.** `sig-momentum` **+1.0848 / 14.64 bps break-even** and
   `sig-accel` **+1.0194 / 11.57 bps**, both significant on the paired cluster test (p 0.029 /
   0.049) and leave-one-cluster-out stable, and both survive **equal-exposure matching** (+1.66
   matched Sharpe at the 200-bar window).
4. **The binding constraint is dependence-adjusted power, not the edge or its cost.** Effectively
   there are **1.73 independent streams of 8** (variance inflation **4.87×**), so the
   dependence-adjusted DSR floor (`minDsrAdjusted ≥ 0.95`) is the **only** gating hurdle left for
   both keepers. SPA p 0.47; nothing promotes. The full roster fails at every cadence and every
   cost level.
5. **Test suite (this phase, end-to-end):** **2558 checks / 30 assert entries + `bench` (timings) =
   31 entries, 0 failures**, `golden` 23/0, `locks` 41/0 — matching the certified ledger
   (`scratch/checks/SUITE.json` is the raw run log; the certified count is in `RUNBOOK.md` §6).
   The node-only suites (real `worker_threads`/SQLite/HTTP) cannot run in the browser harness and
   are unchanged by this plan.

**Direction in one line:** stop searching for a better *model*, stop adding *mechanisms*; shrink the
searched roster to the arms that can plausibly clear the gate, and buy **decorrelated data**
(effective bars) — the two levers the arithmetic below says actually move the verdict.

---

## 2. Workstream A — purge the dead branches (P0)

**Deliverable:** the default A/B roster shrinks to the keepers; every drop is documented with its
measurement; a regression pin stops a silent re-add.

Full register: [`DROPPED.md`](DROPPED.md). Summary of the roster change:

| roster (current, `ALL_VARIANTS`) | state → round-30 default roster |
| --- | --- |
| `baseline` | **keep — LIVE** |
| `surprise`, `homeostasis` | **DROPPED** (≈/worse than baseline) |
| `multiprobe`, `querymod` | **PARK** (broadcast-only; never in the roster) |
| `pca-hash` | **DROPPED** (inert / economically nil) |
| `sig-momentum`, `sig-accel` | **keep — KEEP** |
| `sig-range`, `sig-agreement` | **PARK** (positive, cross-sectional content; opt-in research) |
| `sig-volume`, `sig-autocorr`, `sig-vol-regime`, `sig-frac-momentum` | **DROPPED** |

Resulting **default roster: `baseline` + `sig-momentum` + `sig-accel` → `K = 3`** (pre-registered,
see §3.1 for why this is legitimate and its limits). The parked/dropped branches remain resolvable
by id for reproducibility.

**Code surface (implemented):**
- `src/analyze.js`: `ALL_VARIANTS` = the register's `DEFAULT_ROSTER_IDS` filtered from the mechanism +
  signal families; the rest stay in `RESOLVABLE_VARIANTS` (now the explicit full list, so every
  dropped/parked branch is still resolvable by id). Added `rosterSnapshot()` (ids + count + a stable
  FNV-1a content hash) and `rosterRegistration()` (the register contract: `uncovered`,
  `missingVariant`, `droppedInRoster`) for the pin, plus `emptyListFlagError()` for #69.
- `src/lineage.js` (new): the register as a **code contract** — `LINEAGE_FAMILIES`,
  `LINEAGE_BRANCHES`, `DEFAULT_ROSTER_IDS`, and the lookup helpers. `docs/lineage.json` remains the
  human/machine doc mirror.
- `test/browser/entries/analyze.test.js`: the roster pin, the snapshot-hash check, the register
  contract, the #69 guard and the #70 panel taxonomy (pure + end-to-end) — see `PLAN-round30.md` §7
  M1's note on why these live here rather than in a separate `lineage.test.js` entry.
- `test/node/analyze_cli.test.js`: a spawned-CLI refusal for a present-but-empty `--files` /
  `--carry-files` (node-only; the audit pass extended the guard to every other list flag —
  `--symbols` / `--variants` / `--seeds`).
- `src/README.md`: the round-30 section marks the dropped modules *hypothesis dropped, code retained*.

**Guardrail:** the purge must move **no golden** (`golden.test.js` 23/0) and no scored formula. It
is roster/configuration only. If a golden moves, the purge touched something it must not have.

---

## 3. Workstream B — the decisive levers (P0/P1), with the arithmetic

### 3.1 Lever 1: pre-register a smaller `K` (the cheapest DSR lever)

The deflated Sharpe's hurdle is the expected maximum Sharpe over the **searched roster size `K`**.
Re-running the repo's own `deflatedSharpeRatio` on `sig-momentum`'s acceptance-batch inputs
(`netSharpe 1.0848`, `effectiveBars 1192`, Gaussian `skew 0 / kurt 3`) — an approximation that
reproduces the report (baseline K=12 → 0.0301 vs the reported 0.0301) — gives:

| `K` | `sig-momentum` adjDSR (approx) | `sig-accel` adjDSR (approx) |
| ---: | ---: | ---: |
| 12 (current) | 0.755 | 0.709 |
| 9 | 0.798 | — |
| 6 | 0.854 | 0.820 |
| **4** | **0.904** | — |
| **3** (the plan's roster) | **0.934** | 0.913 |
| 2 | 0.967 | — |
| 1 | 0.991 | 0.987 |

Equivalent **target Sharpe** to clear 0.95 at the current effective sample: **1.53 (K=12) → 1.36
(K=6) → 1.24 (K=4) → 1.15 (K=3) → 1.00 (K=2)**. Equivalent **effective bars** at the current
Sharpe: **2353 (K=12) → 1863 (K=6) → 1563 (K=4) → 1007 (K=2)** (current 1192).

**Read:** pruning 12 → 3 moves `sig-momentum` from 0.755 to ≈0.934 — *close*, but still short. It
is a real lever and it is free, but pruning alone does not promote. Pruning **plus** a ~30 %
effective-bars gain (1563 effective bars at K=4, or a little less at K=3) would clear 0.95.

> **The honesty rule (do not violate).** A smaller `K` is legitimate only **ex ante**: the roster
> for the *next* run is pre-registered smaller (justified by the round-29/acceptance evidence that
> the dropped arms are dead) and its `adjDSR` is computed at that `K`. You may **not** re-report an
> old run at a smaller `K` — that is exactly the selection bias the DSR exists to catch. The
> `LINEAGE.md` §8.5 rule and the roster snapshot pin encode this.

### 3.2 Lever 2: buy effective bars (independence), not more correlated bars

The design effect is **3.62–4.87** because the 8 crypto streams are ~one factor
(`meanPairwiseStreamCorr` 0.52; `effectiveStreams` 1.73). Design-effect reduction is the only lever
that raises every arm's `adjDSR` at once. Candidate sources, cheapest first:

1. **NL-DATA funding sleeve** — already measured: correlation **+0.003** with the price basket,
   equicorrelation design effect 0.769 → 0.604, effective streams 1.25 → 1.54 of 9. Fails G-C only
   because the *jackknife* design effect is serial-dominated; its **cross-sectional** independence
   is real. **Use it as a panel stream in the verdict run** (P4 acceptance), and as a standalone
   return sleeve.
2. **Broader basket** — more symbols and, crucially, **different asset classes / venues** (the
   cross-stream correlation, not the bar count, is the wall). New data fetch required.
3. **Different frequencies** — the 15m basket has a different autocorrelation structure; a
   multi-frequency panel may decorrelate the *serial* component the jackknife is dominated by.
4. **Portfolio of signals** (`NL-SIG` range/agreement seed a decorrelated sleeve) — see WS-D.

**Quantified target (acceptance for this lever):** raise the panel's **effective streams** and lower
the **design effect** enough that, at the pre-registered `K`, `sig-momentum` reaches
`adjDSR ≥ 0.95`. Track `designEffect`, `effectiveBars`, `effectiveStreams` and
`meanPairwiseStreamCorr` as the four numbers.

### 3.3 Lever 3: raise the edge (grounded in the research)

The research note (`research/round30-winning-mechanisms.md`) says the momentum *trunk* is the right
place to iterate, and the literature's proven upgrades are:
- **volatility scaling** (size the momentum signal by inverse realised vol) — the TSMOM standard;
- **multi-horizon / blended momentum** (fast + slow) and **acceleration** (already the second-best
  branch);
- **network / cross-sectional momentum** (a lead-lag graph across the basket) — `2308.11294`;
- **regime gating** (change-point / momentum-crash gates) — `2105.13727`, `2604.09060`.

These are **new signal branches** (`NL-SIG-*@r30`), each pre-registered, each measured on the
existing gate, each with the same acceptance bar. Cost-aware construction (`WS-F`) must accompany
them because the momentum trunk already trades 810/bar.

---

## 4. Workstream C — lineage + version tracking (P0)

Done in this planning phase: [`LINEAGE.md`](LINEAGE.md) + [`lineage.json`](lineage.json) define the
ten families, the id scheme `NL-<LINEAGE>-<branch>@<version>`, the state taxonomy
(LIVE/KEEP/PARK/DROPPED/FROZEN/UNTESTED), and a version-discipline rule set (§8). Every current
resolvable variant is mapped.

**Implemented (round 30):** the register is now **[`src/lineage.js`](../src/lineage.js)** — the
code contract, with [`docs/lineage.json`](lineage.json) its human-readable mirror. It exports
`LINEAGE_SCHEMA`, `LINEAGE_FAMILIES`, `LINEAGE_BRANCHES`, `LINEAGE_IDS`, `DEFAULT_ROSTER_IDS`
(`['baseline','sig-momentum','sig-accel']`), `uncoveredVariantIds`, `DROPPED_VARIANT_IDS`, and
`lineageForVariant`/`lineageIdForVariant`. The checks live in `analyze.test.js` **§A2b** rather than
a separate `lineage.test.js` entry (folded in to avoid the mirror/ledger churn): (a) every
`RESOLVABLE_VARIANTS` id appears in the register, (b) the `uncovered` set is empty, (c) the default
roster snapshot hash is pinned and matches `DEFAULT_ROSTER_IDS`, and (d) every DROPPED branch is
absent from the roster yet still `resolvable`. This makes the register a *contract*, not a wiki page.

---

## 5. Workstream D — coherency + bug checks on the critical mechanics (P0)

**Run in this planning phase (results recorded):**

| check | method | result |
| --- | --- | --- |
| full suite, end-to-end | repo browser harness, 31 entries | **2558 / 0** (30 assert entries + `bench` timings) |
| lock registry | `locks.test.js` | 41/0 |
| golden fingerprints | `golden.test.js` | 23/0 (no fingerprint moved) |
| report self-consistency (5 runs) | 70 checks: ladder@0 == pooled metrics; ladder excludes exactly the inactive roster; `trials == active + baseline`; `familywise.K == trials`; `nextRun.cadence.folds == folds`; promote ⇔ no failed gated hurdle (active arms); tightest hurdle is a failed gated one; `effectiveBars`/`dsrAdjusted` integrity; break-even sign | **all 70 pass** (re-run with the corrected invariant set — the earlier run's only non-ok checks were my own invalid invariant `adjsr ≤ dsr`, see the finding below) |
| dead-module scan | every `src/**/*.js` referenced from another file | **no orphan modules** |

**Finding (record it — the docs never stated it):** the dependence adjustment is **not** a
monotone shrink of the DSR toward 0.5. `dsrAdjusted` re-runs the *whole* deflated formula on
`effectiveBars`, so **both** the `sqrt(n)` scaling *and* the deflation hurdle (via
`defaultTrialVariance`) change. Consequence: for a **positive-Sharpe but sub-hurdle** arm the
adjusted DSR can sit *below* the unadjusted one (more conservative); for a **negative-Sharpe** arm
it moves *toward* 0.5. Neither is a bug, but it is counter-intuitive and should be stated in
`METHOD.md`/`performance.js`'s reader (see WS-E). **Done:** `METHOD.md` §11 + the `effectiveBars` reader note in `analysis/backtest.js`. (The invalid invariant `adjsr ≤ dsr` that
initially "failed" on 4 of the 5 runs was a symptom of exactly this — the corrected check set
asserts the *mechanical* property, `effectiveBars`/`dsrAdjusted` integrity, and passes 70/70.)

**Critical-mechanics audit backlog (implementation):**
- **`NL-EVAL` math** — re-derive PSR/DSR/MinTRL/SPA/stepdown against their papers on a fixture
  (largely covered by `analysis.test.js`; add the "adjusted DSR direction" property test) — **done** (`analysis.test.js` §AD).
- **Gate logic** — a property test: `promote` ⇒ zero failed gated hurdles, at random fixtures. **Done** (`analysis.test.js` §AD, 24 random fixtures; `gated:false` statistics exempt).
- **Label/trade resolution** — `heldBars`, barrier resolution, `resolvedTimeBarrier` (covered;
  re-verify the `optimistic` path after any label change).
- **Position policy** — `probToPosition`, dead zone, exposure matching (covered; add the
  `matchedWithinTolerance` feasibility report from `BUGS.md` #63).
- **Carry projection** — `carryOnBarGrid` ISO/ms coercion + degeneracy guard (covered, #66).
- **Audit** — `auditNoLookahead` vacuity/reachability (covered).

**Open defects to fix (from the acceptance batch):** `BUGS.md` **#69** (an empty `--files=` /
`--carry-files=` falls back silently instead of erroring) and **#70** (a panel-requiring signal on a
panel-less run is degenerate yet labelled `live` / selected `familywise.best`); plus the §16.2
controller-baseline forecast-row **reconciliation** (`TODO.md` 101).

---

## 6. Workstream E — new code / tests / experiments map

### 6.1 New code (each a module + a test)

| id | module (planned) | what it does | test |
| --- | --- | --- | --- |
| `C-ROSTER` | `analyze.js` `ALL_VARIANTS` + `rosterSnapshot()` | pruned default roster + a content-hashed snapshot | `analyze.test.js` roster pin (`§A2b`) — **done** |
| `C-LINEAGE` | `src/lineage.js` (mirror `docs/lineage.json`) | the register as a contract | `analyze.test.js` `§A2b` (folded in) — **done** |
| `C-SIGUP` | `analysis/features.js` new branches | vol-scaled momentum, multi-horizon blended momentum, network (lead-lag) momentum | `features.test.js` — **done** (`analysis.test.js` §G-H) |
| `C-REGIME` | `analysis/features.js` regime gate | change-point / crash gate around momentum (`2105.13727`, `2604.09060`) | `features.test.js` — **done** (`analysis.test.js` §G-H) |
| `C-BREADTH` | `analysis/portfolio.js` (new) | equal-risk / inverse-vol / max-decorrelation combination of a signal sleeve; reports the panel's effective streams | `analysis.test.js` |
| `C-CARRY` | `analysis/carry.js` extension | basis / mark-spread sleeve + spot-leg cost; carry as a panel stream at 600 bars | `analysis.test.js` |
| `C-COST` | `analysis/walkforward.js` position policy | turnover-aware / maker-fee cost model (`TODO.md` 94) | `walkforward.test.js` |
| `C-FIX69` | `analyze.js` arg parse | error/warn on a present-but-empty data/list flag (`--file`/`--files`/`--carry-files`; the audit pass extended it to `--symbols`/`--variants`/`--seeds`) | `analyze.test.js` |
| `C-FIX70` | `analyze.js` variant taxonomy | mark a panel-requiring variant `not-applicable` without a panel; exclude a constant arm from `familywise.best` | `analyze.test.js` |
| `C-REPL` | `analysis/replication.js` (exists) | multi-seed aggregation is already there; add the run driver path | `analysis.test.js` |

### 6.2 Experiments / gates (pre-registered)

| gate | question | design | pass condition |
| --- | --- | --- | --- |
| **G-F (seed)** | is the edge above seed noise? | 5 seeds × `{baseline, sig-momentum, sig-accel}`, 8×600, same gate | the candidate's Sharpe distribution is above the baseline's across seeds; `pairedVarianceRatio` (CRN) < 1 |
| **G-G (breadth)** | does independence buy the verdict? | the 8×600 run + the funding sleeve as a 9th panel stream; then + broader/non-crypto symbols if fetched | `effectiveStreams`↑ and `designEffect`↓ enough that at the pre-registered `K`, `adjDSR ≥ 0.95` |
| **G-H (signal upgrade)** | does the momentum upgrade raise the edge? | the new `C-SIGUP`/`C-REGIME` branches on the same gate, pre-registered | any branch beats `sig-momentum@r23` at matched exposure and clears the gate at the pre-registered `K` |
| **G-I (sleeve)** | does a portfolio beat the best single arm? | `C-BREADTH` over the signal sleeve | the sleeve's `adjDSR ≥ 0.95` at the pre-registered `K`, or a documented negative |
| **G-J (carry)** | is carry a real breadth purchase (P4 acceptance)? | the corrected 3d command (`FUND` set) | `carry.panelStreams == 1`, `dependence.streams == 9`, `panelStreams == 1` at every cadence |
| **G-K (P3)** | is the 15m reversal non-acceptance confirmed? | the corrected 3c command (`CANDLES_15M` set) | the 8×15m run reproduces §16.4's 0/3 non-acceptance |

### 6.3 Immediate operator runs (corrected, from `round29-TESTING.md` §5)

1. **Re-run 3c** with `CANDLES_15M` verified non-empty (`echo "${CANDLES_15M:?}"`) → P3 acceptance.
2. **Re-run 3d** with `FUND` verified non-empty → P4 acceptance.
3. Then the round-30 verdict run at the **pruned roster** + the **funding panel stream**.

All seven stages (P1, P3, P4, verdict, the G-F seed replication, the G-G breadth run, the G-H
momentum-upgrade run) are scripted in
[`../scripts/round30-runs.sh`](../scripts/round30-runs.sh), which defines the file lists *and checks
every file exists* before running, so the empty-list fallback that invalidated 3c/3d (`BUGS.md` #69,
§5 above) cannot recur. `bash scripts/round30-runs.sh all`, or one stage per invocation.

---

## 7. Milestone checklist (DoD for round 30)

- [x] **M1** — default roster pruned to `{baseline, sig-momentum, sig-accel}`; every drop recorded
      in `DROPPED.md`; roster-snapshot + lineage-registry contract tests green.
      *Implemented:* `ALL_VARIANTS` filtered by `lineage.js#DEFAULT_ROSTER_IDS`; `rosterSnapshot()` +
      `rosterRegistration()` in `analyze.js`; the register is `src/lineage.js` (the code contract,
      `docs/lineage.json` its human mirror) and the checks live in `analyze.test.js` §A2b (the roster
      pin, the snapshot hash, and the `uncovered`/`missingVariant`/`droppedInRoster` contract) rather
      than a separate `lineage.test.js` entry — folded in to avoid the mirror/ledger churn; revisit
      if a dedicated entry is ever wanted.
- [x] **M2** — `golden.test.js` 23/0 and the full suite re-verified after the purge (a doc/roster
      change must move no golden). *Result:* **2583 / 0** (30 assert entries + `bench`), `golden`
      23/0, `locks` 41/0; `analyze` 269 → 279 (the new roster/register/#69/#70 checks) and
      `analysis` 621 → 636 (the M7 momentum-upgrade section) are the two entries that moved, total
      2558 → 2583. The 2558 in §1/§5 was the pre-prune certified count; a later audit pass added the two §5 critical-mechanics property tests, so the current certified ledger is `analysis` 638 / total 2585 (`RUNBOOK.md` §6).
- [x] **M3** — `BUGS.md` #69/#70 fixed with tests; §16.2 baseline row reconciled. *Implemented:*
      #69 = the `emptyListFlagError` CLI guard (+ pure and spawned-CLI pins); #70 =
      `notApplicableReason(..., { streamCount })` (+ pure and end-to-end `evaluateAB` pins); the
      §16.2 row reconciled as a **model-path mismatch** (`--model=bare` vs default `controller`, §17.3),
      with the corrected 3b command recorded in `round29-TESTING.md` §3.
- [ ] **M4** — P3 (3c) and P4 (3d) acceptance re-run on the corrected commands; results recorded in
      `RUN-ANALYSIS.md`.
- [ ] **M5** — multi-seed replication (G-F) executed; seed distribution + variance decomposition
      recorded.
- [ ] **M6** — the breadth experiment (G-G) run; effectiveStreams/designEffect/adjDSR recorded.
- [x] **M7** — at least one `NL-SIG` upgrade (G-H) **implemented and tested** (its *measurement* is
      the G-H operator run, `scripts/round30-runs.sh gh`; outcome may be
      negative — a full result). *Implemented (all four pre-registered, awaiting the G-H run):*
      `analysis/features.js#SIGUP_CANDIDATES` (`sig-vol-momentum`, `sig-blend-momentum`,
      `sig-network-momentum`, `sig-regime-momentum`), exposed as the opt-in
      `analyze.js#SIGUP_VARIANTS` and resolved only by id (`--variants=sig-vol-momentum,...`) so the
      default roster, `K` and every golden are untouched. Registered `UNTESTED` in
      `src/lineage.js` / `docs/lineage.json` / `docs/LINEAGE.md` §3; checks in `analysis.test.js`
      §G-H (exact reference vectors, the strict-lag/panel contract, family-wide causality) and the
      resolvability/taxonomy check in `analyze.test.js`. **Not yet measured** — the four branches run
      under gate G-H via `bash scripts/round30-runs.sh gh` (`--variants=baseline,sig-momentum,` + the
      four upgrades; `sig-network-momentum` needs the ≥2-stream panel of the 8-symbol basket).
- [ ] **M8** — the round-30 verdict run executed at the pre-registered roster; a promotion or a
      documented, powered keep-off.
- [ ] **M9** — `RUN-ANALYSIS.md` §18 (the round-30 readout) written; `MILESTONES.md` updated.

---

## 8. Anti-re-tread (do NOT do these in round 30)

- **Do not** add another controller/memory mechanism. Four were tested (surprise, homeostasis,
  pca-hash, and the broadcast pair); none moves the score. `NL-MECH` is closed for new hypotheses
  until a model-class result changes the premise.
- **Do not** buy more correlated bars. More 1h crypto bars raise `n` and `designEffect` together;
  the net `effectiveBars` gain is ~zero (the 200→600-bar jump grew the design effect from 1.67 to
  4.87).
- **Do not** tune the model architecture. `NL-BENCH` (G-A) says features/labels, not architecture,
  are the constraint — and the linear model that wins the MCS still has no skill.
- **Do not** chase the reversal family to a taker-cost pass. It is ~9–30× short; only a maker model
  changes the maths, and that is `TODO.md` 94, not a roster change.
- **Do not** re-report any historical run at a smaller `K` (§3.1).
- **Do not** treat a "best of the tier" (e.g. `bench-linear` winning the MCS) as an edge — the MCS
  is a *tie-breaker among mediocrities*, not a significance test.

## 9. Risks

| risk | mitigation |
| --- | --- |
| K-pruning used dishonestly (looks like a promotion) | pre-registency rule + roster snapshot pin + the §3.1 table left in the record |
| a "signal upgrade" is just a re-parameterisation that overfits | pre-register the branch list; require matched-exposure survival + leave-one-cluster-out stability, not just in-sample Sharpe |
| decorrelation is claimed from the wrong metric | track the **jackknife** design effect *and* the correlation/effective-streams pair; the acceptance bar is `adjDSR ≥ 0.95`, not a correlation target |
| the node-only suites hide a break | run `npm test` on a native driver before the verdict run (`round29-TESTING.md` §1); nothing in this plan changes the node path |
| a negative round-30 result is read as failure | a documented, powered keep-off is a full result (project rule); `MILESTONES.md` records it |
