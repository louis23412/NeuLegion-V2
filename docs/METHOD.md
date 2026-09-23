# METHOD.md — evaluation-method decisions (round 26, R26-9)

This file records decisions about *how* the walk-forward evaluation is computed when
the choice changes the statistics the verdict rests on. It is a decision record, not
a feature: each entry states the question, the options, the re-derivation, the
evidence, and the decision. It is linked from `ROADMAP.md` round 26 (Part E) and
`src/README.md`.

## 1. Per-fold replay vs per-stream warm snapshot (R26-9)

**Question.** The walk-forward currently re-fits the model from scratch on each
fold's training prefix (a full replay, O(n²) per stream in bars). The cheap
alternative is to warm one controller per stream and *snapshot* its fitted state at
each fold boundary, so each fold starts from the previous fold's state instead of a
fresh fit (O(n)). Does the cheaper path preserve the properties the inference layer
assumes?

**Why this is a statistical decision, not an optimisation.** Round 25's dependence
layer treats the **fold window as the sample's natural independent unit**: the
promotion gate's magnitude test is a delete-one-cluster jackknife over fold-window
clusters, and its stability half requires the paired Sharpe difference to survive
deleting any single window. Both read the per-fold statistics as if the clusters
were approximately exchangeable draws of the same process. A warm snapshot breaks
that: consecutive folds share the same fitted state, so their outcomes carry a
common component that a fresh replay does not have. The reported SE, the sign test
and the stability verdict would all be computed on a sample that is *not* the one
the method assumes.

**Re-derivation under the correlated-fold null.** Model each fold window's
outcome as a binary win with probability ½ under the null, with a common latent
component. If the pairwise correlation between window outcomes is ρ, the win count
over C windows has variance

```
Var(wins) = C·¼·(1 + (C-1)·ρ)
```

i.e. the **equicorrelation design effect** `1 + (C-1)·ρ` (`dependence.js`,
`equicorrelationDesignEffect`). The i.i.d. analysis (the exact sign test, and the
delete-one-cluster SE) assumes ρ = 0. At C = 40:
- ρ = 0.25 → design effect 10.75; ρ = 0.5 → design effect 20.5.
- The nominal α = 0.05 sign test becomes anti-conservative by a factor that grows
  with the design effect; the delete-one-cluster SE understates the true SE by
  ≈ √design-effect.

**Evidence (fixture).** `analysis.test.js` §AL simulates the null exactly — a
deterministic LCG, C = 40 windows, 400 replications — and records the sign test's
rejection rate:

| regime | pairwise ρ | 5 % rejection rate |
| --- | ---: | ---: |
| fresh replay (independent folds) | 0 | ≈ 0.043 |
| warm snapshot, mild | 0.25 | ≈ 0.31 |
| warm snapshot, strong | 0.5 | ≈ 0.36 |

A calibrated 5 % test rejects at ~5 % only for the independent (fresh-replay)
windows. The same fixture checks that the null variance matches the design-effect
formula `1 + (C-1)·ρ` exactly.

**Decision.**
1. **The scored walk-forward keeps the per-fold full replay.** It is what makes the
   fold windows the independent unit the dependence layer claims, and the
   simulation shows the alternative is not merely noisier — it invalidates the
   gate's size.
2. A snapshot implementation is **not shipped**. If it is ever added as a cost
   lever, it must be a *separate, explicitly labelled* report; carry the measured
   inter-fold correlation; re-derive the SE with the fold-correlation design
   effect rather than the i.i.d. one; and never feed the promotion gate or the
   `decision` block. The gate's contract (`DEPENDENCE_GATE_READER`) is written
   against independent fold-window clusters, and a snapshot path would need its
   own reader justifying the changed unit.
3. The honest cost lever that *is* shipped is different: the audit can reuse the
   scored pass as its base pass (`--reuse-base`, verdict-identical), and the fold
   loop can run at bounded concurrency (`--concurrency=N`, byte-identical). Neither
   changes the sample the inference reads.

**Grounding.** López de Prado (2018) — purging/embargo and the independence
assumptions of walk-forward evaluation; Pardo (2008) — walk-forward efficiency
under refitting regimes; Cawley & Talbot (2010) — the selection bias of reusing one
fitted model across folds; arXiv 2412.10545 — retraining as the response to drift,
which is the argument *for* replaying rather than carrying a stale fitted state
forward. The design-effect form is Kish (1965), already used by the dependence
layer.

## 2. Whether to search the family by racing (R26-15) — gate currently CLOSED

**Question.** Once a fold is cheap (R26-12 `saveInterval`, R26-13 paired seeds) and
the comparison is paired, the expensive part of "find the best family" stops being a
fold and becomes the number of arms (variants × seeds × policy configurations).
Successive halving / Hyperband is the standard answer: score every arm at a small
budget, eliminate the arms statistically out of contention, and reallocate the freed
budget to the survivors.

**Decision (round 26).** The **engine is built and validated; the driver is not
shipped, because the gate is closed.**
- `src/analysis/race.js` (registered `LOCKED-invariant`) implements
  `halvingRounds`/`halvingSchedule`/`successiveHalving`/`formatRace`. It is
  evaluator-agnostic, deterministic, and reports both the evaluation count and the
  budget-weighted cost (`spentBudget` vs `gridBudget`).
- `analysis.test.js` §AM **validates it against the full-grid oracle**: on a fixture
  the race's winner equals the brute-force winner at the top budget, which is the
  precondition the plan attached to trusting it ("a racing budget may not change the
  *decided* set"). This is a test, not a promise.
- The `--race` **driver is deliberately absent from `analyze`**. The gate named in
  `ROADMAP.md` is *an economics win (R26-5) or a diversity win (R26-6) giving a
  reason to search a **larger** family*. `RUN-ANALYSIS.md` §7 measured neither: every
  signal is cost-dead (break-even 0.09–3.47 bps against a 5–10 bps taker cost), so a
  wider search would spend compute to rank candidates that all lose money. Racing is
  a tool for spending a budget on the candidates that matter, not a substitute for
  having candidates worth testing.
  **Update (the `20260922T204248-seed1` round-26 run, `RUN-ANALYSIS.md` §10).** The
  cost half of that justification turns out to be **window-dependent**, not a property
  of the strategy: on the 600-bar design `sig:momentum`'s break-even is **14.64 bps**
  and `sig:acceleration`'s **11.57 bps** — both *clearing* a 5–10 bps taker cost —
  while the 2,200-bar run §7 quotes puts momentum at 0.48 bps at essentially the same
  per-bar turnover. The two runs differ in sample, not method: the momentum edge is
  concentrated in the most recent ~600 bars and is absent over the longer window
  (which is why the 2,200-bar family's best was `sig:volume`). So condition (a) is
  **sample-dependent and cannot be checked off from one run**. The gate therefore
  **stays closed**, on the sharper reason that a ranking has an economic point only
  if the edge is stationary — and the one statistic that agreed across both windows,
  the dependence-adjusted DSR, **failed both candidates in both runs**
  (0.7375 / 0.8343 < 0.95). Open the gate when a candidate both clears its break-even
  cost *and* passes the shipped DSR floor on more than one window.

**Conditions to open the gate.** Wire `--race` only when either (a) a candidate
clears its break-even cost at a realistic taker fee (so ranking the family has an
economic point), or (b) a measured diversity win (R26-6 stream selection / interval)
gives the family a reason to grow; and only after (c) a full-grid validation on one
small real run confirms the race's decided set matches the grid at the top budget.
Until then the engine stays a tested primitive, and the full-grid search stays the
path.

**Grounding.** Jamieson & Talwalkar (2016, arXiv 1502.07943); Li et al. (2018, arXiv
1603.06560).

## 3. Whether a candidate that never differed from the baseline may be reported as tested (round 27) — NO

**Decision: a candidate must prove it ran.** `RUN-ANALYSIS.md` §10 measured three of
fifteen candidates emitting byte-identical positions to the baseline on 288/288 folds,
and the report printed 15 keep-off "reasons" for them while counting all three in
`K = 15`. The round-27 sweep then proved *why*: `sample-weights` is a mathematical
no-op (every drain is one label, so the weight is exactly 1 — `BUGS.md` #43),
`multi-probe`/`query-mod` steer a path whose only reader's result is discarded
(`BUGS.md` #44), and `pca-hash` is *reachable* only through an undocumented reader
(and, as the round-27 runs showed, live at some budgets and inert at others — #53).
So:

- every candidate carries a **`liveness` certificate** (`live` / `inert` / `skipped`
  / `not-applicable` / `duplicate-of:<id>`) computed as pure post-processing of the
  already-journaled fold signals — never a hot-path change;
- an untested candidate (including one byte-identical to an *earlier live* candidate)
  contributes **exactly one** explanatory reason, is **excluded from `K`** and from
  the family-wise search, and is listed with the roster size the DSRs were actually
  deflated by (`trialsRoster` = `trials` + `trialsInactive`); the DSRs are re-deflated
  at the reduced `K` with the existing `restateReportAtCost` (the equal-trials
  restatement identity is a test);
- a contract test requires at least one **live** mechanism candidate on the shipped
  controller roster.

This is the same non-vacuity rule already shipped for the look-ahead audit
(`BUGS.md` #22: a probe whose view cannot differ is `vacuous`, never `clean`),
applied one level up — to candidates. Rationale: a `K` that includes untested arms is
not a conservative multiple-testing correction, it is a *mis-statement of the search
that was run* (Gelman & Loken 2013), and a mechanism that cannot change the output
cannot be tested by it (Adebayo et al. 2018; Fisher, Rudin & Dominici 2019).
**Implementing: `PLAN-round27.md` R27-1/R27-2.**

## 4. Sample-uniqueness weighting for a *streaming* trainer (round 27) — inert where labels do not overlap, a causal window where they do

**Decision (revised by the second sweep): the shipped labeler's labels do not
overlap, so average uniqueness is exactly 1 and sample weighting is mathematically
inert on it — close the item `not-applicable` but keep the mechanism where it is
expressible.** López de Prado 2018 ch. 4 weights each label by its average uniqueness
over the *training set*. Two facts kill the batch formula here, and the second is
decisive:

- this model trains **one** label per `getSignal` call
  (`CONFIG.baseProcessCount = 1`), so the batch is degenerate: measured,
  `spanWeightsFromEntries([k], cfg) === [1]` for every normalization
  (`BUGS.md` #43);
- the shipped labeler produces **non-overlapping 1-bar labels**: the round-26 journal
  records `heldBars { count: 185937, sum: 185937, max: 1, mean: 1 }` because
  `_updateOpenTrades` counts bars only within the single newly-inserted candle it is
  handed per call, and the horizontal barriers are hit on the first bar after entry
  (`BUGS.md` #49). Average uniqueness over non-overlapping spans is 1, so **no
  wiring — batch, ring or configure — can make the mechanism non-trivial on the
  `optimistic` labeler.**

The streaming definition adopted (implemented as a modifier of a *long-horizon*
label, not as a standalone controller flag): the controller keeps a bounded ring of
recent label spans `[entryBar, entryBar + horizonBars − 1]` with `horizonBars`
explicit; a new label's weight is the average of `1/concurrency` over its span
against the spans **already observed** — a **causal** estimator, because a weight
that reads a not-yet-observed label is a leak the walk-forward audit exists to catch
— then clamped and `mean1`-renormalised over the retained window so the mean weight
(and hence the effective learning rate) is unchanged. The run reports the weight
distribution and its effective sample size, so a weight vector that is uniformly 1
is visible rather than assumed away; under `triple` with a reachable vertical barrier
(`BUGS.md` #49, R27-4b) labels span `H` bars and overlap, so the estimator can move.
The `_sampleWeightConfig = null` path is bit-identical (golden fingerprints
unchanged). **Falsification:** if `ess / n ≈ 1` under `triple`, close the item
permanently. **Implementing: `PLAN-round27.md` R27-3 (with R27-4b as its enabling
fix).**

**Round-27 run result (`RUN-ANALYSIS.md` §13.4).** The falsification did **not**
trigger: under the `triple` baseline the mechanism is live (`ess/n = 0.8248`, only
50/288 folds byte-identical to the baseline) but it **hurts** (paired ΔSharpe
−0.2276, adjusted DSR 0.1674 vs 0.3148, 0/36 stability windows positive, break-even
−4.51 bps). **Two corrections to this decision, both required before the item is
closed.** (1) The `mean1`-over-the-window normalisation does **not** keep the
effective learning rate unchanged, because only the newest span is trained: the
emitted weights' mean was **2.6112**, so the arm ran at ≈2.6× the baseline's effective
LR (`BUGS.md` #54). The verdict must be re-confirmed with the *emitted* stream
renormalised to mean 1 (`PLAN-round28.md` P3). (2) The conclusion for the `optimistic`
labeller — inert because one-bar labels do not overlap — is unaffected and remains
proven by the Step-1 certificate (`sampleWeights {min 1, max 1, mean 1, ess = n}`).

**Correction (round 28, `BUGS.md` #58).** The second bullet above is **wrong as stated**, and
it is the basis of the whole decision. The `sample-weights` variant's `configure` sets the
causal ring's span horizon to `_labelHorizonBars > 1 ? floor(…) : 1` (`analyze.js:151–158`),
which is **1 on every `optimistic` run**; the all-ones weight vector is therefore produced by
the *span parameter*, not by the labels. The evidence quoted for "one-bar labels" —
`heldBars {count=sum=185937, max=1}` — was the **#49 false diagnostic**. With #49 fixed, the
same runs report `heldBars {count 4369, max 54, mean 8.301}` (Step 1) and
`{count 185937, max 72, mean 7.8245}` (Step 2) on the `optimistic` baseline: labels are held
~8 bars and **do overlap**, so average uniqueness is ≈ 1/8, not 1. The decision's first half
(close the item for `optimistic`) is therefore **withdrawn pending `PLAN-round28.md` P1a′/P1b/
P1c** — a causal span estimate (EMA of past realized holding periods, or an explicit
`--sample-weight-horizon`), the emitted-stream mean-1 renormalisation, and a re-run. What
survives unchanged: the batch formula is degenerate here (one label per drain,
`CONFIG.baseProcessCount = 1`), so the *streaming* estimator is the only expressible form.

## 5. What the next *power* purchase should buy (round 27) — independence, not bars

**Decision: buy independent information, and name the window of any cost claim.** The
corrected run's own dependence panel says the basket is ~2.3 independent streams
(`effectiveStreams` 2.30 of 8, `streamCorr` 0.3535), the design inflation is 4.87×,
and the dependence-adjusted MDE95 is ±1.0442 against ±0.4734 i.i.d. (`effectiveBars`
888 of 4,320). More bars of the same correlated basket therefore raise the *nominal*
sample and barely move the statistic the gate uses (`power.seDependent`,
`pairedUnits.neededForObserved`). The available levers, with their trade-offs, are:
more streams (a genuinely independent stream needs a new data source — the basket is
Binance-only); more fold-window clusters (a smaller `testSize` trades per-fold signal
for cluster count); and a second bar interval (`--interval`, a different horizon but
highly correlated with its parent). Related: the economic ceiling must always be
quoted with its sample — `sig:momentum`'s break-even is 0.48 bps over 2,200 bars and
14.64 bps over 600 at essentially the same per-bar turnover. **`PLAN-round27.md`
R27-8; `RUN-ANALYSIS.md` §10.9/§11.** **Confirmed by the round-27 runs
(`RUN-ANALYSIS.md` §13):** the label-policy run's own `nextRun` says the observed
paired effect needs **41** fold-window clusters for one-sided significance (89 at 80 %
power; the round-27 report's `55` used a two-sided z in a one-sided test — §14.7a) and it
has 36; `barsToDetectObserved`
is **93 577 bars** at design effect 5.12; the four runs' `effectiveStreams` are 2.30
(Step 2), 2.47 (Step 3) and 1.89 (Step 4) out of 8 — so the binding constraint is the
number of independent streams, not the bar count. The Step-4 signal candidates are
also ~600× cheaper to evaluate than the model-backed baseline (4.57 s vs 2 716 s of
total fit time per run), which makes an *independence* purchase affordable and a
*signal-family* sweep nearly free.

**Qualification (round 28, `BUGS.md` #56; `PLAN-round28.md` P6).** "More bars is the
wrong lever" is a statement about the **level** (the DSR floor at Sharpe ≈1.02–1.08),
not about every question the round asks. More bars *of the same basket* do buy
fold-window clusters (`clusters = floor((bars − train)/testSize)`), which is exactly what
the **paired** hurdle needs — 675 bars at `testSize 15` gives the 41 clusters, and
`--test=10` on the existing 600 bars gives 54 — so "more bars" is the wrong purchase for
the absolute-edge floor and the right one for the paired decision, provided the *cost* of
the extra fits and the window-dependence caveat are stated. The genuinely independent
lever remains new streams (the basket is Binance-only). `TODO.md` 82.

## 6. Scoring the forecast/MCS panel across `kind` (round 27) — group by kind

**Decision: score within a kind; do not mix a probability with a z-score.** R26-14's
panel feeds each variant's journaled `confidence` through the affine map
`(confidence + 1)/2` and treats the result as a probability. That is exact for the
controller family — its confidence is `confidenceFromProb(prob) = prob/50 − 1`, so the
map recovers `prob/100` — but a *signal* candidate's confidence is
`clamp(z/saturation, −1, 1)`, a normalised z-score that is neither a probability nor
on any shared scale with one. Mixing them lets all eight signals be eliminated from the
MCS "for not being probabilities" rather than for worse forecasts (`sig:momentum` brier
0.3394, `sig:range` 0.3492 — worse than a constant, because the map is meaningless for
them). `forecastComparison` therefore groups by a forecast kind (`forecastKindOf`:
`controller` for the baseline/mechanism/label family, `signal` for the signal family):
each kind gets its own Model Confidence Set, and the Diebold–Mariano test against the
run's baseline is defined **only** inside the baseline's kind (a cross-kind candidate
carries `dm: { available: false, reason }`). The block records `kind`, `kinds[]`,
`byKind[kind].mcs` and states the choice in its `reader`; the summary appends
`groups: controller(n) signal(m)`. The alternative the plan allowed — mapping a
signal's score through the unified position policy before scoring — was rejected
because the policy is a decision transform (dead zone + scale), not a calibration, so
it would still not yield a probability. **Pinning:** `analysis.test.js` (the unit
grouping + within-kind DM), `analyze.test.js` (the run's grouped block).
`PLAN-round27.md` R27-5.

## 7. Sizing a *paired* decision (round 28) — never mix the paired difference's scale with the level's

**Decision: every sizing hint names its scale, and a paired comparison is sized from the paired
SE with the *same* reference the test uses.** The round-28 coherence re-read
(`RUN-ANALYSIS.md` §14, `BUGS.md` #56) found `decision.nextRun` mixing two scales:

- the **single-series** scale — the candidate's own Sharpe level: `mde95`, `mde95Dependent`,
  `designEffect`, `barsToDetectObserved`, `dependence.seCluster` (0.54654 on Step 2);
- the **paired** scale — candidate-vs-baseline: `promotionTest.sharpeDifference.se` (0.13554).

`cheapestFlip`'s `magnitude` branch read `1.959964 × dependence.seCluster` and compared it to
the paired difference, reporting `required 1.0711991` (which *is* `mde95Dependent`) and
`factor 4.95005`. The honest requirement at the observed 36 clusters is
`t(35, 0.05 one-sided) × 0.1355364 = 0.228998` against the observed 0.2164017 — **factor
1.058**, i.e. the candidate is at 94.5 % of the required t. With 41 clusters (one-sided) it
is significant; **89** clusters give ≈80 % power (t-based — the plan's `81` is the normal
approximation; `RUN-ANALYSIS.md` §14.7a). `barsToDetectObserved` = 93,576 is
the *single-series* statement in bar units — it is not the lever for a paired decision. The
same re-read also established the discriminator the gate actually uses: the DSR floor at this
design is crossed at a Sharpe of **≈1.02–1.08** (`sig-accel` 1.0194 → adjusted DSR 0.9742
clears; `sig:momentum` 1.0848 → 0.9487614 misses), so a candidate at Sharpe 0.1017 is ≈10×
short and *no* affordable sample closes that gap (buying the design effect from 5.12 → 1 buys
≈2.3× on the SE). **Consequence recorded in `PLAN-round28.md`: the labeller decision is not a
power purchase.** Tests: `decision`/`analysis.test.js` fixtures with two different SEs and with
equal SEs.

## 8. The fold-majority hurdle (round 28) — a reported statistic, not a gate

**Decision: the gate implements the round-25/26 recorded decision; the raw fold fractions are
reported, not gated.** `DESIGN.md` §6.1 states that the round-25 gate replaced
`foldWinFraction >= 0.5` and `positiveFraction >= baseline` with the paired cluster Sharpe test
and the leave-one-window cluster-stability requirement, and that "the raw fraction is still
reported, as a statistic". `promoteDecision` nevertheless still carries `minFoldWinFraction =
0.5` and `minPositiveFoldDelta = 0` as always-on reasons (`analysis/walkforward.js:800–812`),
computed over **all 288 folds** — comparisons the project's own dependence panel says are not
independent (8 streams per window). On the round-27 runs the raw hurdle is decisive and
disagrees with the error-controlled cluster statistic: `label-conservative` 0.2013888 (raw) vs
0.5000 (cluster sign test, 17/17/2); `sig:momentum` 0.4930556 vs 0.5277778 (19/17). The change
is **verdict-neutral on all four round-27 runs** — every candidate that fails the raw hurdle
also fails the DSR floor and/or the paired test — and that neutrality must be *proved* before
landing (re-run `promoteDecision` over the four reports' rows with the raw hurdles off).
Grounding unchanged: Demšar 2006 (the sign test), Cameron & Miller 2015 (clustered inference),
Ledoit & Wolf 2008 (Sharpe differences). `PLAN-round28.md` P1e; `BUGS.md` #57.

## 9. Sample-uniqueness weighting on a streaming trainer: the span must be *measured* (round 28)

**Decision: the causal ring's span horizon is a measured quantity (a causal estimate of the
realized holding period, or an explicit `--sample-weight-horizon`), never the run-level
`_labelHorizonBars` default of 1, and the *emitted* weight stream is renormalised to mean 1.**
Round 27 shipped `horizonBars = _labelHorizonBars > 1 ? floor(…) : 1`, i.e. 1 on every
`optimistic` run, so Step 1's `sampleWeights {min=max=mean 1}` was a configuration artefact
(`BUGS.md` #58) — the same runs' fixed `heldBars` is mean 8.30 / max 54, so labels overlap.
Separately, the `mean1` normalisation was applied to the *window*, while only the newest span
is ever trained, so the emitted stream's mean was 2.6112 and the arm ran at ≈2.6× the effective
learning rate (`BUGS.md` #54) — the model is plain SGD (`_applyGradients` subtracts
`Σ grad · lr / steps`), so a per-sample weight scales the step directly (modulo the
norm-percentile `_scaleGradients`, a nonlinearity the control arm exists to expose). The
re-test design (arms A/B/C) and the causality requirement (a label's weight may not use a
span that ends in the future — the walk-forward audit's rule) are in `PLAN-round28.md` P1a′/
P1b/P1c/P3.
