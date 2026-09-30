# NeuLegion — red-team audit of `PLAN-round31.md` and `ARCHITECTURE-v2.md`

**Status: implementation of the operator's request (2026-09-28) — "keep working on the plan, check it
for logical/coherence issues, question every decision from different viewpoints, and document
everything."** Method: six audit cycles. Cycles 1–2 attack the two documents for internal
contradictions; cycle 3 maps **design friction and model pollution** from the actual code (not the
README narrative); cycle 4 scores **testability vs genuine upgrade need**; cycle 5 re-asks the core
decisions from five professional viewpoints; cycle 6 records the **reconciled decisions** and folds
them back into the two documents.

Nothing here is an opinion about style — every finding names the code or the measured number it rests
on. `BUGS.md`/`RUN-ANALYSIS.md` §-refs and lab `F-`/`L10-` ids are the project's own evidence.

**Bottom line.** The plan's *direction* survives all six cycles. But four of its load-bearing claims
are **over-stated or internally inconsistent** and are corrected here: (1) "power is the binding
constraint" is conditional on the 25-day window; (2) the gate can be satisfied by market beta, so a
factor-neutral hurdle is missing; (3) "the carry complex is the only measured positive result" mixes
three different objects, one of which the repo's own run corpus shows flips verdicts *inside the
estimator's noise*; and (4) the model-rebuild is the biggest engineering item on the branch the
evidence says is least likely to pay. The architecture doc also has three concrete gaps (a missing
`Sleeve` contract, an over-strict import law, and an under-specified lock model) plus an
under-specified legion re-host. All are fixed in §6 and folded back.

---

## Cycle 1 — internal coherence of `PLAN-round31.md`

### C1. "Power is the binding constraint" contradicts "the wins are a 25-day window artefact" — **HIGH**

**The two facts.** Fact 4 (plan §0): the only arms that win are `sig-momentum` **+1.0848 @600 bars**
vs **+0.110 over 53 500**. Fact 5: the binding constraint on the verdict is **power**
(`effectiveStreams` 1.73 of 8, `designEffect` 3.62–4.87). W1 makes full-history the default; W5
buys independence so "every arm's DSR rises at once."

**Why it is incoherent.** The power diagnosis is measured **on the 600-bar design**. On the full
history the arms read ≈0.11 Sharpe (a factor-exposure book), and *no* amount of design-effect
correction manufactures an edge out of a null. So W5 cannot be "the only lever that raises every
arm's DSR at once" *before* W1 has re-measured the arms on the full history. Worse, W5-as-stated
could *promote a beta book*: §18.5 is explicit that the only family-wise-significant arm in the
corpus (`sig-reversal-4`, family SPA p=0.4382, arm StepM p=0.0474) has break-even **1.5 bps**, and the demeaning experiment
(`sig-reversal-xs`, DE 0.361, 12.05 effective streams of 8) shows **"power is buyable, edge is
not."** The plan's own corpus is the counter-example to the plan's priority order.

**Resolution.** State the diagnosis as **"a window-concentrated edge + a power-limited panel"**, and
insert a **G1b gate**: W1's full-history re-measurement runs *first* and decides whether W5 is even
needed. W5 is only pursued for arms/sleeves that still have a positive full-history Sharpe. (See
§6 amendment A1.)

### C2. The gate can be satisfied by market beta — **HIGH**

Fact 3/§18: every signal arm is ~100 % market exposure (the panel is one factor; `meanPairwiseStreamCorr`
0.52); `sig-range`/`sig-agreement` have common-share 0.61/0.66. The plan's G3/G5 (effective streams,
positive Sharpe) can be met by a levered long-bias book. Nothing in the gate requires the edge to
**survive factor removal**.

**Resolution.** Add a **factor-neutral hurdle** as a first-class gate input (opt-in first,
verdict-neutral proof required): promote only if the arm/book has a positive Sharpe **after
removing the panel's first principal component** (or an explicit per-fold hedge), with raw and
neutral Sharpe both reported. `analysis/features.js` already has `crossSectionalReversal` and
`networkMomentum`; `analysis/decision.js` gets the hurdle. (A2.) Note the project already found the
*exposure* half of this — `BUGS.md` #61 (a cross-family statement must be quoted at matched
exposure) and `analysis/walkforward.js#exposureMatchedPair` — but that is a *reporting* control, not
a *promotion* hurdle, and it does not remove the common factor.

### C3. W2's acceptance ("clears the repo's own gate") is contradicted by the repo's own round-29 P4 — **HIGH**

The plan says a ported sleeve must "clear the repo's own gate at its pre-registered K." But round-29
**P4** measured the repo's funding sleeve as "an independence purchase that **does not cross the DSR
surface** (designEffect 5.226 → 5.228)", and §18.2 shows the repo's carry sleeve **flips which arm is
promoted** while moving the *paired magnitude test* too (L10-cs) — all inside **F-62**'s resolution
(a true design effect of 1 spans 0.644–1.452 at C=36).

**Resolution.** The plan conflates **three different objects**; separate them explicitly:
1. the lab's **dispersion/fade books** (R7/R8; the Sharpe 1–7 numbers) — *not in the repo*;
2. the repo's **plain funding stream** (`carryPanelStream`, the P4 object) — a *stream*, not a book;
3. the **ported sleeve book** (W2's real deliverable) — a full positioning/capacity construction.

W2 is object 3; it is **not** the P4 object and must be measured as a book. State that **W2 + W3 +
W5 + A2 are jointly necessary** and that W2-alone-failing is the *expected* result. (A3.)

### C4. The lab's positive numbers have no pre-registered falsifier at the port — **HIGH**

The lab's carry dispersion `net@4 +6.86` is an extraordinarily high Sharpe for a real, capacity-bound
book. The lab itself scoped it hard (F-48/F-49/F-50: the walk-forward rule "bought *slowness*"; F-51:
"R8's spec is a pinned book, no walk-forward"; F-55: the safe window is ≥ ~2.3 y). The plan says
"reproduce to display precision" but does not pre-register the test that would prove the *lab* number
is not an artefact of its own loader/spec/window.

**Resolution.** Before the port, pre-register: (i) the **exact frozen spec** (λ, cap, band) taken from
the lab's ≥2.3 y rule; (ii) a **held-out span** the spec never saw (or the lab's growing-window
protocol); (iii) a **data-identity check** — run the *lab's* loader and the *repo's* loader on the same
files and assert byte-equal returns *before* porting (F-61 proves the repo's carry function has a 3.03×
mis-scale that flatters); (iv) a **decay/crowding** test; (v) a **capacity-realisation** test. Any of
these failing is a *result* (the lab artefact is closed) — record it, don't re-tune. (A4.)

### C5. The biggest engineering item (rebuild the model core) sits on the lowest-EV branch — **MEDIUM**

W4a is labelled "enabling, low direct EV"; `ARCHITECTURE-v2` §0 says "only the model core is genuinely
rebuilt." But `NL-MECH` (four mechanisms ≈ baseline), `NL-BENCH`/G-A (§18.6: `bench-linear` beats the
controller) and the corpus's 600× runtime penalty for the controller all say the model is not the
path to a result.

**Resolution.** Re-frame in both documents: the **product** is the sleeve book + the gate; the
**model rebuild is a research deliverable** whose justification is (a) removing the whole-engine lock
and (b) giving the learner a *winnable* target (vol/regime/sizing). It is explicitly **off the
critical path to G5**. (A5.)

### C6. "The model's only defensible new target is vol" is a hypothesis, not a measurement — **MEDIUM**

W4b asserts a learned vol/regime/sizing model is the one winnable job. The support cited (L09/F-16) is
that a *causal EWMA* is the forecaster to use — i.e. the zero-parameter baseline. No learned vol
forecaster has been measured here, and EWMA/HAR-RV are very strong vol baselines.

**Resolution.** Make W4b a **pre-registered hypothesis with a falsifier**: "a learned forecaster beats
a causal EWMA on next-period realised vol, out of sample, at matched exposure, on this data." If not,
W4b closes negative and the model becomes a pure research object. (A6.)

### C7. "Stop predicting, start allocating" is over-strong — **LOW**

Allocation itself requires predicting vol, cost and capacity (W3 has a vol target and an OI schedule).
The honest statement is "stop predicting **direction**."

**Resolution.** Reframe the headline. (A7.)

### C8. G5 "bankable positive result" is under-specified — **HIGH**

G5 = positive full-history net-of-cost Sharpe + ≥4/6 positive blocks. It omits: the DSR hurdle, factor
neutrality (C2), capacity (the sleeves are $10–22 M), decay/crowding, execution model, and whether the
result is *out-of-sample of the port*.

**Resolution.** G5 becomes a conjunction: positive full-history Sharpe at a **maker-aware** cost;
≥4/6 blocks; `dsrAdjusted ≥ 0.95` at the pre-registered K; **factor-neutral** (A2); within the
**OI/capacity bound with the clipped-trailing-median schedule**; and a documented **decay** check —
all on data the frozen spec did not select on. (A8.)

### C9. No fallback if every sleeve fails the repo gate (the most likely outcome) — **MEDIUM**

The risk register mentions the DSR rejecting the portfolio but gives no branch. Given P4 and §18.2,
"sleeves fail the gate" is a *plausible* outcome, not an edge case.

**Resolution.** Pre-commit to the fallback: (i) record the negative as a result; (ii) the harness +
the sleeves + the capacity/decay measurements stand as the deliverables; (iii) the reversal family
stays PARK pending a maker/queue model; (iv) **do not** respond by re-opening the model search
(anti-re-tread). (A9.)

### C10. Full-history feasibility for the controller is handled, but not stated — **LOW**

§18.8: signal arms ~3–5 s/variant, the controller ~3000 s for 600 bars. W1 applies the long-sample
scorer to **signal-only arms** (the plan says so in passing). Full history for the controller would be
~74 h/variant.

**Resolution.** State the cost arithmetic explicitly and the rule: full-history scoring is
signal/sleeve-only; the model keeps `--bars`. (A10.)

### C11. Data/venue identity between lab and repo is assumed, not tested — **MEDIUM**

F-61 names "the shipped SOLUSDT FTX window" — the lab's funding data may predate/ differ from the
repo's Binance basket. A port that "reproduces the lab" on different data proves nothing.

**Resolution.** Folded into C4(iii): the data-identity check is the *first* step of W2, with a stop
gate. (A4.)

### C12. W5.1 ("carry + positioning as panel streams") re-creates the §18.2 coupling bug — **HIGH**

W5.1 attaches the carry sleeve as a panel stream. §18.2 shows that as plumbed, the sleeve enters the
**paired cluster test** (`clustersOf` reads `report.streamReturns`, which `poolReports` extends with
the extra streams), which flips the promoted arm. L10-cs is exactly this. So W5.1 without the L10-cs
fix will keep producing estimator-noise verdicts.

**Resolution.** W5.1 must land **together with** the L10-cs fix (paired test on the price-only panel;
the sleeve feeds only `dependence`/`dsrAdjusted`), and the sleeve should preferably enter as a
**sleeve book** (a `Sleeve` plugin) rather than as a raw panel stream. (A3.)

---

## Cycle 2 — internal coherence of `ARCHITECTURE-v2.md`

### D1. Missing `Sleeve` (and `Book`) contract — **HIGH**

`ARCHITECTURE-v2` §4.2 lists `DataSource/Feature/Labeler/Learner/MemoryBank/RiskPolicy/Evaluator`.
The highest-EV work (W2/W3 — the sleeves) has **no contract**: a sleeve produces a position/weight
series from features + data, and a book composes sleeves. Add **`Sleeve {id, capability, signal(view) →
weightSeries}`** and **`Book`** (composition + constraints), and make `RiskPolicy` operate on a book.
(A11.)

### D2. `MemoryBank.read(query, k)` cannot express the shipped retrieval — **HIGH**

The live retrieval (`_retrieveTopRelevantProtos`) is **global**: it builds a size-weighted query from
`currentProtos`, mixes the **episodic** and **adaptive** banks, scores entries, applies an
`explorationRate`, and **draws `Math.random()` a bucket-content-dependent number of times**. That is a
*retrieval policy over several banks*, not a method of one bank. As specified, the contract cannot
express it, so the four banks could not be swapped without changing the retriever.

**Resolution.** Split the contract: `MemoryBank {write, decay, merge, consolidate, stats}` (per-bank,
pure) **+** `Retriever {read(banks, query, k)}` (the policy — one implementation is today's
`_retrieveTopRelevantProtos`). This also makes the "which bank?" question testable in isolation.
(A12.)

### D3. The import law is over-strict and the shared primitives have no home — **MEDIUM**

"Plugins import only `core/contracts`" breaks for genuinely shared pure math (`clipWeights`,
`bandWeights`, `cleanBook`, `causalZScore`, `clampPosition`). If each sleeve re-implements them, the
port stops being *one* module.

**Resolution.** Add **`core/primitives/`** (pure, contract-free math: the port.js functions, the
z-score/clamp pipeline, the label helpers) that `plugins/` may import. The law becomes: contracts ← 0
deps; primitives ← contracts only; plugins ← contracts + primitives; lab ← all; **no plugin imports
another plugin**; the lab never imports engine internals. (A13.)

### D4. The lock model is under-specified in one place — **MEDIUM**

"Each plugin gets its own fingerprint; the engine's fingerprint is the compose of the active stack."
Then adding a **default** plugin *does* move the engine fingerprint. The doc's claim "adding a
non-default plugin moves no existing fingerprint" is only about the non-default case, but §6's V2.2/V2.3
*change the default stack*.

**Resolution.** Two lock classes, stated explicitly: **model plugins** (memory/learner/ensemble) →
per-plugin **fingerprint**; **analytic plugins** (features/labels/sleeves/risk/evaluators) →
**reference-vector tests** (the existing `analysis.test.js` style), plus one **engine compose
fingerprint over the frozen default roster**. Changing the default roster is a deliberate, documented
re-freeze — never a side effect. (A14.)

### D5. The legion re-host is hand-waved — **MEDIUM**

The doc drops `legion/` from the layout and says "re-host behind the engine, lighter." The legion owns
the SQLite vault, the hierarchy aggregation, the worker pool and the HTTP/SSE monitor, and
`legion/database.js` opens its DBs **at module-eval time**. That is real systems work.

**Resolution.** Either (a) keep it as `core/runtime/legion` (with the module-eval side effect removed),
or (b) replace it with a thin run harness. State which, and add the work to V2.1. (A15.)

### D6. The V2 does not close the evaluation/production view divergence — **MEDIUM**

`BUGS.md` #33 was exactly this (the A/B streamed `candles.slice(0,i)` while production streams
`state.cache.slice(-cacheSize)`). A V2 `Evaluator` that builds its own view re-creates it.

**Resolution.** **One-view rule**: the runtime produces a `view` object; the evaluator consumes the
*same* view the runtime used (already the direction of `analysis/world.js`). Pin it with a test.
(A16.)

### D7. The registry/lock-registry duplication risk — **LOW**

Already flagged in the doc; add the anti-drift test (registry ids ⊆ lock-registry entries, both
directions).

---

## Cycle 3 — design friction & model pollution (from the code)

This cycle is the operator's specific ask: *which designs work together, which cause friction, and
which pollute the model with rubbish.* Every item below is read from the shipped code, not inferred
from the README.

### 3.1 Pollution sources (rubbish in)

| # | source | evidence (code) | effect | sev |
| --- | --- | --- | --- | --- |
| **P1** | **Self-referential inputs (tier > 1).** For `_tier > 1`, `_extractFeatures` builds the input vector out of **memory prototypes** (`normMean` + `normVariance` interleaved, quality-sorted, sliced, zero-padded to 0.5) — not market data | `controller/features.js#_extractFeatures` (tier-1 vs else branch) | the higher tiers predict from their own compressed past → a feedback loop with no external information | HIGH |
| **P2** | **Feature set chosen by arithmetic, not meaning.** `_chooseDimension` picks `inputSize`/`trainingCandleSize`/`trainingIndicators` by a divisibility rule that maximises `min(ind, cand)` and ties-break on `preferMoreIndicators = (ensembleSize % 2 === 0)` | `controller/features.js#_chooseDimension` | the **ensemble-size parity changes the feature set**; different slots see different indicator subsets chosen by arithmetic | HIGH |
| **P3** | **"Specialization" rewards dissent, and the weights then amplify it.** `_computeSpecializationScores` = `sigmoid(|z|)·(0.5+0.5·perf)` where `z` is the member logit's z-score across members; `_getSpecWeightMatrix` scales every projection by `clamp(1 + specScore·W, 0.5, 1.5)` | `ensemble/scores.js#_computeSpecializationScores`, `ensemble/hiveState.js#_getSpecWeightMatrix` | a noisy member that *disagrees* is scored as "specialized" and its weights are **amplified** — the literature's exact failure mode ("decorrelation is not complementarity", 2608.16190) | HIGH |
| **P4** | **Performance scores don't discriminate.** `performance = 1 − Brier(sigmoid(logit), target)`; on a ~50/50 target with ~0.5 outputs a *random* member scores ≈ 0.75; the 0.9/0.1 EMA then makes all members ≈ equal | `ensemble/scores.js#_updatePerformanceScores` | ensemble weights, trust, donor/receiver split and LR ranking are ~uniform → the "evolutionary layer" is a no-op (consistent with `NL-MECH` ≈ baseline) | HIGH |
| **P5** | **The hivemind broadcast injects noise.** `_hiveMemorySharing` copies protos donor→receiver with additive Gaussian noise (`noiseScale 0.04 + 0.08·(1−perf) + 0.04·(1−agree)`) and scaled importance | `ensemble/hiveState.js#_hiveMemorySharing` | with the donor ranking ~random (P4) this is a noise pump; it is also `appliesTo:'broadcast'` — the scored path never reads it (`BUGS.md` #44) | HIGH |
| **P6** | **Adaptive learning rates are anti-correlated.** Members *above* the 25th-percentile composite get their LR **decreased**; below get it **increased** | `ensemble/scores.js#_updateAdaptiveLearningRates` | combined with P4, a random walk on the LR | MEDIUM |
| **P7** | **Gradient scaling is heuristic soup.** `_scaleGradients` composes fractal dimension, NTK stability, kernel rate, dual EMA, trust/loss variance, spectral norms, dynamic percentiles and sparse thresholds through ~20 hand-set coefficients to scale every gradient matrix | `training/gradients.js#_scaleGradients` (≈150 lines) | the largest **un-validated** feedback loop in the system: training statistics control the learning rate through a formula nobody has ablated | HIGH |
| **P8** | **Label/evaluator target mismatch.** Training labels are **trade outcomes** (TP/SL via `_processClosedTrades`), only *closed* trades train, and the holding horizon varies (`heldBars` mean 8.3, max 54) — while the model is scored as a directional forecaster | `controller/trades.js`, `BUGS.md` #33 lineage | selection bias + path-dependence + horizon mixing: the learner is optimising a different object than the one being graded | HIGH |
| **P9** | **Un-validated memory-bank operators.** `_updateSemanticProtos` uses a `dynamicThreshold` mixing capacity overload, performance, agreement and stagnation; a **repulsion** term that pushes near-miss candidates away (`strength·sqrt(maxVariance·0.08)`); variance inflation; and importance updates | `memory/banks.js#_updateSemanticProtos` | many interacting, un-ablated structural operators between the data and the memory content | MEDIUM |
| **P10** | **`train()` is an apply→distill→rollback→apply dance.** On the reset cadence it applies gradients, runs a "fresh" forward, distills teacher→student, **rolls the gradients back**, re-applies, runs another forward, then shares memory | `hiveMind.js#train` | an unusual, uncited two-pass optimizer that couples training to the ensemble readout | MEDIUM |
| **P11** | **Cross-sectional content was audited through a probe that could not reach it.** `networkMomentum`'s self-skip needs `panel.streamIndex`; the audit perturbed only the own stream, which the arm never reads. The scored wire itself was correct (e63: the driver always sets `streamIndex`) | `analysis/features.js#networkMomentum`, `analysis/world.js#panelFor`; §18.4; L10-bu/L10-cc | the only non-beta arm (`sig-network-momentum`, pooled Sharpe **1.3005**) was **VACUOUS with 8 look-ahead violations** — unmeasurable. **Round-86 update (lab F-130):** sibling-shock probe reaches 288/288 with 0 violations; the fix is production in `world.js` (R40, `analysis` 850 → 856). Downgrade to MEDIUM pending the native gate + re-measurement | HIGH |
| **P12** | **The LSH index is off the product path — and the live read is partly random.** The scored reader (`_retrieveTopRelevantProtos`) probes `_semanticLSHBuckets` directly and "draws `Math.random()` a bucket-content-dependent number of times"; `_getGlobalLSHCandidates` (the only caller of multi-probe/query-mod) is reached only by `broadcastMemory`, a **discard** path | `memory/retrieval.js#_retrieveTopRelevantProtos`, `BUGS.md` #44 | (a) all the index R&D cannot move the score; (b) the read injects **Math.random()** variance unless `legion/rng.js#installSeededRandom` is on (default off) | HIGH |

### 3.2 Friction pairs (designs that clash)

| # | friction | why it is friction | sev |
| --- | --- | --- | --- |
| **F1** | **Time-series features vs cross-sectional evaluation** | the only non-beta content is cross-sectional, but its probe is vacuous (P11), so the panel arms are untestable | HIGH |
| **F2** | **Banks vs index vs retriever** | three mechanisms share the memory read/write path with no clean owner; the retriever mixes episodic+adaptive+semantic, the index projects, the bank decays | HIGH |
| **F3** | **Ensemble weighting vs specialization vs adaptive LR** | three re-weightings of the same members, driven by three weak/near-constant signals (P3/P4/P6); they compound rather than compose | HIGH |
| **F4** | **Homeostasis vs adaptive LR** | two controllers on the *same* variable (per-member LR); redundant, and homeostasis was measured negative | MEDIUM |
| **F5** | **Sample weights vs one-bar labels** | mathematically inert on the shipped labeller (every uniqueness weight = 1) yet wired as if live | MEDIUM |
| **F6** | **The design-effect estimator vs its own threshold** | F-62: a single reading at C=36 spans 0.644–1.452, so any verdict within ~±0.25 of the `>1` gate is unresolvable — and §18.2's funding-sleeve flip is exactly there | HIGH |
| **F7** | **A/B view vs production view** | `analyze.js` built its own candle window (`BUGS.md` #33); the pattern recurs whenever a new evaluator is added | MEDIUM |
| **F8** | **Legion's per-cluster SQLite vault vs the research need** | heavy I/O in-loop, DB opened at module-eval (side effect), a shared vault the scored path may not read | MEDIUM |
| **F9** | **Whole-engine bit-exact lock vs the research need** | any mechanism experiment is a whole-engine re-freeze (the modularity blocker) | HIGH |
| **F10** | **"Deflation is monotone in K" vs "the roster is the only choice"** | K=3 promotes `sig-accel`; K=6 promotes nothing (§18.3). The verdict is a pure function of the *search* choice, so any roster chosen after seeing the data is a post-hoc K | HIGH |

### 3.3 Synergies (designs that work together)

| # | synergy | evidence |
| --- | --- | --- |
| **S1** | sleeves + risk layer + full-history scorer + dependence-adjusted gate | plan W2/W3/W1 |
| **S2** | `clipWeights` + `bandWeights` + `cleanBook` + OI schedule + fixed-split joint sizing | lab F-52/F-53/F-58/F-59, F-42/F-43/F-44; `port.js` reproduces 5/5 books |
| **S3** | causal z-score → clamp → turnover policy | `analysis/features.js`, `analysis/holding.js` |
| **S4** | memory-support math + a *single* index read path | `memory/{surprise,multiprobe,binarypc,bitweight,querymod}.js` are pure and config-resolved |
| **S5** | 15m reversal + a maker/queue model | `sig-reversal-4` family SPA p=0.4382 (arm StepM p=0.0474), break-even 1.5 bps; the edge is real, the cost kills it |
| **S6** | cross-sectional demeaning + genuinely-neutral sleeves | `sig-reversal-xs` DE 0.361 / 12.05 effective streams — power is buyable for a neutral edge |
| **S7** | the gate's own pieces | DSR/PBO/SPA/StepM/jackknife/deff compose cleanly; independently re-validated |

### 3.4 The pollution thesis in one sentence

**The model is fed (P1/P2) a self-referential, arithmetically-chosen feature vector; its memory is
written by un-validated operators (P9); its ensemble rewarding dissent (P3) on a near-constant score
(P4) and pumping noise (P5); its gradients scaled by heuristic soup (P7); its labels measuring a
different object than its evaluation (P8); and its one non-beta input path broken (P11) — which is
precisely why the measured result is "the architecture is not the constraint; the target is."** The
plan's "demote the model" is therefore not a retreat — it is the correct response to a system whose
inputs are polluted and whose target is unlearnable.

### 3.5 Numerical verification of the two strongest pollution claims

Run as a standalone simulation of `ensemble/scores.js`'s exact arithmetic (not asserted from a
read):

| check | result | confirms |
| --- | --- | --- |
| a member that **always emits logit 0** (p = 0.5), scored for 200 balanced bars through `_updatePerformanceScores`' `0.9·s + 0.1·(1−Brier)` | `performance → 0.7500` — a *useless* member saturates at 0.75 | **P4**: scores do not discriminate; the donor/receiver split and LR ranking are ~uniform |
| `_computeSpecializationScores` on four members at the ensemble mean and one outlier (`|z| ≈ 2.23`), with the same `perf` | mean members `0.5447`, outlier `0.7707` → **×1.415**; and `|z|` is sign-blind (`sigmoid(2)` uses the same magnitude for a right and a wrong outlier) | **P3**: the ensemble **rewards dissent regardless of correctness** and then amplifies that member's weights via `_getSpecWeightMatrix` |

These two numbers are why the four mechanism experiments all read ≈ baseline: the "evolutionary
layer" is a near-constant noise-amplifier, so a *better* memory/transformer has no way to earn
ensemble weight.

---

## Cycle 4 — testability vs genuine upgrade need

`T` = testable **now** on repo data at ~zero compute · `D` = needs **new data** · `U` = needs an
**upgrade** before it is scoreable · `?` = needs a **decision**, not a test.

| subsystem | testable? | what is missing | verdict |
| --- | --- | --- | --- |
| kernels / transformer | T (goldens) | nothing — but irrelevant to the target (G-A) | **keep as research object** (`?`) |
| memory banks | T (contracts) | P9 + a **read-path wire** (P12) + the plugin contract | **U, then ?** |
| ensemble | T | P3/P4/P5/P6 — the mechanisms reward noise | **U or retire** |
| controller features | T | P1/P2 — the feature vector is arbitrary | **U, but G-A says features are the constraint → a redesign is a new family, not a fix** |
| gradient scaling | T | P7 — no ablation proves any coefficient helps | **retire to a plain optimizer, then re-baseline** |
| labels | T | P8 — target ≠ evaluated metric | **U (align the target)** |
| signal family | T | nothing; pure and causal | **ready** |
| carry sleeve (repo, plain) | T | enters as a *stream*, coupling the paired test (C12) | **U (book, not stream)** |
| sleeves (lab books) | T (needs the port) | data-identity + a held-out spec test (C4) | **port, with a falsifier** |
| risk / portfolio | — | **does not exist** | **BUILD (highest EV)** |
| execution / cost | D | maker fill / L2 queue data | **data-gated (S5)** |
| positioning / OI / toptrader | D | the `futures/um` metrics | **data-gated** |
| other venues / frequencies | D | Bybit/OKX fetches | **data-gated** |
| gate | T | C2 (factor hurdle), C12 (paired coupling), F6 (resolution) | **U, then stronger than most published work** |
| observer | T | the V2 event seam | **ready** |
| legion | T | P8/F8 — heavy, module-eval DB | **U (re-host or replace)** |
| whole model stack | ? | — | **DECIDE: research object vs product** |

**Reading.** Almost everything *measurable* is already measurable; almost nothing that is *coupled*
is scoreable without an upgrade. The genuine build list is short and does **not** include retraining a
transformer: **(1) the risk/portfolio layer, (2) the sleeve port + the factor-neutral hurdle, (3) the
paired-test/one-view fixes, (4) the read-path/liveness wires, (5) the data (positioning, venues,
execution).** The model redesign is last and optional.

---

## Cycle 5 — five viewpoints

### 5.1 The portfolio manager: *"Does it make money at a size I can deploy, and will it still work next year?"*
The plan over-indexes on statistical significance and under-indexes on **capacity, decay and
execution**. The sleeves are the only thing that answers the question; the model is irrelevant to it.
→ **Action:** the capacity/decay/execution gates (C8) and the joint-capacity constraint (S2) are
first-class, not footnotes. State the book size up front ($10–22 M; the whole complex $5–70 M).

### 5.2 The ML researcher: *"Is the failure informative, and what is the interesting object?"*
The failure is **highly** informative — it is a clean reproduction of two recent results
("decorrelation is not complementarity" 2608.16190; "simple rules beat learned models on this
feature vector" 2607.00475) plus the project's own mechanism-null. A researcher would say: **the
harness and the negative results are the contribution**; keep them, and only rebuild the model with a
*new target*. → **Action:** W4b's target must change, not the architecture alone.

### 5.3 The systems engineer: *"Can I run it, change it, debug it?"*
The pain is the whole-engine lock (F9), the 200 KB `analyze.js`, the 138 KB `lock-registry.js`, and
the legion's module-eval DB (F8). The V2 contract layer fixes F9; the registry/analysis split fixes
the first two; the legion needs an explicit decision. → **Action:** D5, A14, and a size budget for
`analyze.js`/registry.

### 5.4 The risk officer: *"Where does this blow up?"*
Crowded carry with **negative skew**; funding-regime flips (mean funding has been negative for whole
quarters); exchange/ADL/liquidation risk on the perp leg; capacity $10–22 M; and — in the *model* —
the **random retrieval path** (P12) and the heuristic gradient scaling (P7), which are untestable
failure surfaces. → **Action:** add tail/regime/ADL stress tests to the sleeve acceptance; make the
read path deterministic.

### 5.5 The statistician: *"Is the inference sound?"*
The gate is excellent, but four things are unresolved: the **25-day window** (J1), the **K
multiplicity** (F10 — the verdict is a function of the search), the **paired-test coupling** (C12),
and the **factor exposure** (C2). F-62 says a near-threshold verdict is unresolvable. → **Action:**
full-history + factor-neutral + pre-registered roster, and treat any near-threshold verdict as
*unresolved*, not as a decision.

### 5.6 The market-microstructure economist: *"Is this edge, or a risk premium being harvested?"*
Carry is a **risk premium** (paid to hold the crowded side); dispersion is **liquidity provision**;
the fade is a **positioning contrarian**. Each has a decay mechanism (crowding, competition, regime
change). → **Action:** every sleeve acceptance must include a **crowding/decay** test, and the plan
must not treat an in-sample premium as durable.

---

## Cycle 6 — reconciled decisions (amendments)

These fold back into `PLAN-round31.md` (§0.5) and `ARCHITECTURE-v2.md` (§4 amendments). `[S]` =
supersedes a line in the original.

| id | decision | changes | reason |
| --- | --- | --- | --- |
| **A1** | reframe the diagnosis as **"window-concentrated edge + power-limited panel"**; add **G1b** = the full-history re-measurement that *decides whether W5 is needed* | plan §0/§5, W1/W5 ordering | C1 |
| **A2** | add a **factor-neutral hurdle** to the gate (raw + neutral Sharpe reported) | plan §3/W1, `analysis/decision.js`; gate DoD | C2 |
| **A3** | separate the three carry objects; **W2 = the sleeve book**; state that **W2+W3+W5+A2 are jointly necessary**; the sleeve enters as a book, not a raw panel stream; **W5.1 requires the L10-cs fix** | plan §3/W2/W5, §5 | C3, C12 |
| **A4** | pre-register the sleeve port: **frozen spec + held-out span + data-identity check + decay + capacity realisation**; a failure is a result, not a re-tune | plan §3/W2 | C4, C11 |
| **A5** | re-frame: **product = sleeve book + gate**; **model rebuild = research deliverable, off the critical path** | plan §2/§3/W4, arch §0 | C5 |
| **A6** | **W4b is a pre-registered hypothesis with a falsifier** (beat causal EWMA on vol, OOS, matched exposure) | plan §3/W4 | C6 |
| **A7** | headline → "stop predicting **direction**; predict only what is predictable" | both docs | C7 |
| **A8** | tighten **G5** to a conjunction (full-history net Sharpe at maker-aware cost + ≥4/6 blocks + `dsrAdjusted ≥ 0.95` + factor-neutral + within the OI/capacity bound + documented decay, on data the spec did not select on) | plan §5 | C8 |
| **A9** | add the **fallback branch** (record the negative; the harness + sleeves stand; no model re-search) | plan §8 | C9 |
| **A10** | state the cost rule: full-history scoring is **signal/sleeve-only**; the model keeps `--bars` | plan §3/W1 | C10 |
| **A11** | add **`Sleeve` and `Book` contracts** | arch §4.1/§4.2 | D1 |
| **A12** | split `MemoryBank` (per-bank, pure) from **`Retriever`** (the policy over banks) | arch §4.1/§4.2 | D2 |
| **A13** | add **`core/primitives/`**; state the full import law (no plugin→plugin; lab never imports engine internals) | arch §4.1 | D3, D7 |
| **A14** | two lock classes: **model → fingerprint**, **analytic → reference-vector**, plus one **engine compose fingerprint** over the frozen default roster | arch §4.4 | D4 |
| **A15** | decide the legion: keep as `core/runtime/legion` (drop the module-eval DB) **or** replace with a thin runner; put it in V2.1 | arch §4.1/§6 | D5 |
| **A16** | **one-view rule** + test (runtime and evaluator consume the same view) | arch §4.2/§6 | D6 |
| **A17** | retire or explicitly validate the noise mechanisms: **sample weights (inert), homeostasis (negative), the broadcast (off-path), the specialization/trust/LR stack (P3/P4/P6)**; plain optimizer first, then re-baseline | plan anti-re-tread, arch plugins | P3–P7, F3–F5 |
| **A18** | add a **crowding/decay + regime/tail stress** requirement to every sleeve acceptance | plan §3/W2/W3 | 5.4, 5.6 |
| **A19** | **no full-history laundering**: any arm with a data-selected parameter is excluded from the full-history score (or scored under the same expanding-window rule that selected it) | plan §3/W1 | V4 |
| **A20** | the **`Retriever` contract takes an injected RNG**; the default stream is seeded; two same-seed runs are byte-identical | arch §4.1/§4.5 | V6, P12 |
| **A21** | **state the prior**: G5 passing on the first port is ≈⅓; the floor deliverable is the harness + the sleeves + the negative | plan §5/§8 | V8 |
| **A22** | the **legion survives as a V2 runtime/scheduler** (many learner slots, the vault, the observer) — not the product's alpha source | both docs | V9 |
| **A23** | **`SIGUP_CANDIDATES` → PARK/DROPPED** (the corpus measured all five; none promotes; `sig-network-momentum` is VACUOUS) | `LINEAGE.md` / `DROPPED.md` / plan §7 | V11 |
| **A24** | **wire-or-drop the LSH upgrades**: route the scored read through `_getGlobalLSHCandidates`, or mark `multiprobe`/`querymod`/`binarypc`/`bitweight` PARK explicitly and stop investing | plan §7, arch plugins | V11, P12 |

---

## Cycle 7 — adversarial verification of the reconciled plan

The audit's own amendments were then attacked, to check they do not introduce new holes and that the
plan is not quietly re-chasing failed features.

### V1. The factor-neutral hurdle (A2) has two loopholes — **fixed**
Removing the panel's **first** PC removes the common crypto factor but not other exposures (size,
vol, momentum), and a full-sample PC is look-ahead. Also, a book can have a *negative gross* Sharpe
that turns positive only through a hedge. → **A2 refinement:** report raw *and* neutral; require
**neutral > 0 AND raw ≥ 0**; estimate the PC **causally** (expanding window); add the hurdle to the
**pre-registered** set so it does not change `K` (it is a hurdle applied to all arms, not a search).

### V2. "Held-out span" vs the lab's decay finding — **reconciled**
The lab found R8's value is concentrated in the first ~2 years (F-49). A late hold-out can fail
because the edge **decayed** (crowding), not because the spec is wrong. → The held-out test reports
**per-block Sharpes** (W1's `blockStability`), and a decay is distinguished from a spec failure by
the block pattern. This is a second, independent reason W1 must land first.

### V3. Full history *is* the power fix — **strengthened**
The 8×1h runs are underpowered (MDE95 0.473 i.i.d. / 1.04 clustered, §18). MDE scales as
`1/√T`: 600 → 53 500 bars is a **√89 ≈ 9.4×** variance reduction, i.e. **MDE95 ≈ 0.05**. So W1
makes the verdict powered *without* W5 — which is the quantitative form of amendment A1. W5 is only
for the **residual** dependence of a genuine edge.

### V4. A data-tuned arm must not be scored at full history — **new guard**
A parameter-free signal (`sig-momentum`) is valid at full history. An arm whose parameters were
selected on the data (`SIGUP_CANDIDATES`' vol window / blend horizons) is **not** — full-history
scoring would launder the selection. → **A19:** any arm with a data-selected parameter is excluded
from the full-history score (or scored under the same expanding-window rule that selected it).

### V5. The new hurdles must not become new researcher degrees of freedom — **guarded**
`G1b`, the factor hurdle and the tightened G5 add decision *knobs*. The project's rule (`trials = K`;
pre-registration) must extend to them: they are applied uniformly and recorded in the run manifest.
→ folded into A2/A8 with an explicit "these are hurdles, not searches" note.

### V6. The random read path breaks determinism — **new**
P12's `Math.random()` in `_retrieveTopRelevantProtos` means the scored model is stochastic unless
`installSeededRandom` is on. → **A20:** the `Retriever` contract takes an injected RNG; the default
stream is seeded; a test asserts two runs with the same seed are byte-identical.

### V7. The position/turnover policy has no owner in the contract set — **fixed**
`RiskPolicy` (weights) does not cover the dead-zone/band/holding map (`analysis/holding.js`,
`confidenceToPosition`). → **A11 refinement:** `RiskPolicy` owns the **weighting *and* the
position/turnover policy**, or a separate `PositionPolicy` is added; the two are distinct knobs and
must not be conflated.

### V8. The plan does not state the probability it is chasing — **added**
Given P4 (the repo's carry does not cross the DSR surface) and F-62 (verdicts near the threshold are
unresolvable), the honest prior that G5 passes **on the first port** is moderate, not high (≈⅓).
→ **A21:** state it; frame G5 as the *objective*, with the harness + sleeves + the negative as the
floor.

### V9. "The legion" has no defined V2 role — **fixed**
The project's identity is a **legion** of controllers. The plan demotes the *controller*, but never
says what happens to the *legion* (many slots/learners across tiers). → **A22:** the legion survives
as a **runtime/scheduler** (many learner slots, the vault, the observer) — a first-class V2 runtime,
not the product's alpha source. This preserves the operator's concept.

### V10. "Chasing new designs" — the plan's genuine new-design inventory — **stated**
To be sure the plan is not re-arranging failed features, the *new design content* is:
1. **new data** — funding (already fetched), positioning/OI (toptrader), other venues/frequencies;
2. **a new decision procedure** — full-history + block-stability + factor-neutral + dependence-adjusted,
   with the estimator's resolution respected;
3. **a new layer** — sleeves + portfolio/risk/capacity (nothing in the repo today);
4. **a new architecture** — contracts/registry/per-plugin goldens.
The plan explicitly does **not** chase a new model architecture, a new memory mechanism, a new
index tier, or a new label policy — all of which the project (or the literature, 2608.16190 /
2607.00475) has already closed.

### V11. Failed features still carried by the plan — **resolved**
| still carried | status | action |
| --- | --- | --- |
| `SIGUP_CANDIDATES` (vol/blend/network/regime momentum) | registered `UNTESTED`, but the corpus measured all five at K=6 — **none promotes** (§18.3); `sig-network-momentum` is VACUOUS | **A23**: mark them PARK/DROPPED in `LINEAGE.md` + `DROPPED.md`; do not carry them into round 31 |
| LSH upgrades (`multiprobe`, `querymod`, `binarypc`, `bitweight`) | off the scored path (`BUGS.md` #44) | **A24**: **wire-or-drop** — either route the scored read through `_getGlobalLSHCandidates`, or stop investing and mark them PARK explicitly |
| surprise, sample-weights, homeostasis, broadcast | measured inert/negative | **A17** (retire/validate) |
| meta-labelling, reversal-to-taker-pass, model-class search, direction prediction | closed | anti-re-tread (unchanged) |

### V12. The highest-Sharpe arm is unmeasurable — **already covered, re-emphasised**
`sig-network-momentum` (pooled Sharpe **1.3005**, the corpus's best) is VACUOUS with 8 look-ahead
violations because the cross-sectional wire is broken (P11). → Fix the own-stream-slot wiring (W6 /
L10-bu/L10-cc) **before** citing any panel arm; until then the corpus contains **no** measured
version of its strongest candidate.

### Cycle 7 verdict
The reconciled plan holds. The amendments add three guards that were genuinely missing — **A19**
(no full-history laundering of a data-tuned arm), **A20** (deterministic retrieval), **A22** (the
legion's V2 role) — plus two resolutions (**A23** SIGUP → PARK, **A24** index wire-or-drop) that
close the remaining "failed features still carried" gap.

---

## What this changes about the plan's *shape*

Nothing structural: W1–W6 and V2.0–V2.4 survive. What changes is **priority and honesty**:

```
W1 (+W6)  decision soundness + shipped defects      UNCONDITIONAL, FIRST
   └─ G1b: full-history re-measurement  ──► decides whether W5 is even needed
W2/W3/W5 + A2   sleeves + risk + independence + factor-neutrality   JOINTLY NECESSARY (the EV)
   └─ G2 data-identity + frozen spec + held-out + decay + capacity
W4b (gated)  the model vs EWMA on a winnable target  HYPOTHESIS, off the critical path
V2.0/V2.1  contracts + port the pure layers          process unlock (parallel, cheap)
V2.3 model plugins                                   research only, last
```

The single most important correction: **do not sell W5 as the fix before W1 has re-measured the arms
— and require factor-neutrality before anything is called an edge.**

---

## Applied to the documents

- `PLAN-round31.md` — new **§0.5 "Audit amendments"** folding in A1–A10, A17–A19, A21–A24; the affected
  §0/§3/§5 lines marked `[amended]`.
- `ARCHITECTURE-v2.md` — new **§4.5 "Audit amendments"** folding in A11–A17, A20, A22, A24; the §0
  framing and §4.1/§4.2/§4.4 lines marked `[amended]`.
- `DROPPED.md` — new **§2b**: the `SIGUP` family dropped with the corpus's K=6 measurement (A23).
- `MILESTONES.md` — M10/M11 notes updated with G1b and the tightened G5.
- `NeuLegion-lab/INDEX.md` — this audit registered.
- **Open, awaiting the operator:** A22 (the legion's V2 runtime role) and A24 (wire-or-drop the LSH
  upgrades) are decisions the audit recommends but does not take unilaterally.
