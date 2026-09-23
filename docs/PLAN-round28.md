# NeuLegion — Round 28 plan (reading coherence, the weighting confound, then the label-policy decision)

Status: **IMPLEMENTED (round 28) — P1a–P1f and P2 landed with the full browser suite green and
no golden moved; P1b/P1c/P3-code landed (the two control arms and `--sample-weight-horizon`);
the decision records (P4/P5) and P6's bound are written.** What remains is *operator-run*: the
two runs in §3 (Step 1 the corrected weighting A/B, Step 2 the `--test=10` label-policy
confirmation), and the two offline restatements that need a *retained journal* — the round-27
journals are no longer in the tree, so `RUN-ANALYSIS.md` §14.8 records the bound that can still
be stated and the exact re-run recipe; **0.5(b) (the market-neutral overlay) is unblocked by
either new run's `folds.jsonl`** (both are `--symbols=all` and default to `--fold-log=all`),
while 0.5(c) (the `sig-accel` sweep) additionally needs a signal-family run because neither
scheduled run journals a `sig:*` candidate. The implementation record (what landed, the recomputed sizing table,
the verdict-neutrality proof, and the P2 retrieval-liveness measurement) is `RUN-ANALYSIS.md`
§14.7–§14.8; the bugs are `BUGS.md` #53–#58 (**Fixed**) plus #59 (**reported, not fixed** — the
scored reader's duplicate multiplicity). This plan was written from
the round-27 runs (`RUN-ANALYSIS.md` §13, `BUGS.md` #53/#54/#55, `TODO.md` 74–78) and then
**expanded by a full coherence re-read** of the four run reports against the shipped code,
the recorded method decisions (`METHOD.md` §4/§5, `DESIGN.md` §6.1) and the round-26/27
documents. That re-read is `RUN-ANALYSIS.md` **§14**; it found **three new reading defects**
(`BUGS.md` **#56/#57/#58**), **two recorded decisions the code or its documentation does not
implement** (#57's raw fold hurdles versus `DESIGN.md` §6.1; #58's "labels do not overlap"
premise in `METHOD.md` §4 and the shipped `inertReason`), and — most importantly — it
**corrected the round's own sizing arithmetic**, which changes what the label-policy decision
(P4) actually is.

Nothing in this round changes the default-path arithmetic of the frozen core, so **no golden
fingerprint may move** (the round-24–27 acceptance criterion). Every priority states its
evidence (a run id and a number, or a file + line), its change, its acceptance criterion, the
test that pins it, and **what it can and cannot prove**.

---

## 0. One paragraph: where round 28 starts

Round 27 built the honesty layer and then ran it. The machinery worked (per-candidate liveness
with a measured certificate, the reduced-`K` restatement, the now-reachable `triple` vertical
barrier, the per-kind forecast, two cross-process bit-reproductions, zero runtime warnings) and
the science split three ways: `label:conservative` is a real but **small** improvement over a
**negative-edge** baseline, the sample-uniqueness weighting is **live-but-harmful under
`triple`** (confounded), and `sig-accel` **promotes at 0 bps only**. Three reading defects
survived (#53/#54/#55). Round 28's coherence re-read then established the two facts that
re-order the round:

1. **The label-policy decision is not a power purchase.** `label:conservative`'s pooled Sharpe
   is **0.1017**; the DSR floor at this design is crossed at a Sharpe of ≈ **1.02–1.08**
   (`sig-accel` 1.0194 → adjusted DSR 0.9742 clears it; `sig:momentum` 1.0848 → 0.9488 misses
   it by 0.0012). The candidate is therefore **≈10× short on the magnitude the absolute-edge
   floor requires**, and `barsToDetectObserved` **93,576** is the same statement in bar units.
   **No affordable sample closes a 10× Sharpe gap**: buying the whole dependence panel
   (design effect 5.12 → 1) would buy back at most ≈√5.12 ≈ 2.3× on the SE. Hurdle (b) is a
   *magnitude* gate, not a sample-size one, and it is behaving correctly.
2. **The one hurdle that *is* affordable is the paired test, and the sizing block mis-states
   it.** The reported `neededForObserved` **55** clusters uses a **two-sided** z
   (`1.959964`) while the test it sizes is **one-sided** (`pairedClusterTest.significant ⇔
   pOneSided ≤ alpha`, `dependence.js:235`). Recomputed with the test's own reference
   (`t(35) = 1.68957`, one-sided 5%): the required paired difference at 36 clusters is
   **0.22900** against the observed **0.21640** — the candidate is at **94.5 % of the required
   t** — and **41 clusters** (not 55) would make it significant; **89 clusters** would give it
   ≈80 % power (the plan's `81` was the normal approximation — see the status header and
   `RUN-ANALYSIS.md` §14.7a). In bar terms that is 675 / 1275 bars at `testSize 15`, or **54 clusters from
   `--test=10` on the existing 600 bars** (a ~1.5× fit increase). The same block's
   `cheapestFlip` quotes a **×4.95 magnitude requirement** that is an artefact: it multiplies
   the *pooled level's* cluster SE (0.54654) by 1.96 and compares that to the *paired
   difference*, mixing a single-series quantity with a paired one (the paired difference's own
   SE is 0.13554, so the true one-sided magnitude factor is **×1.06**).

So the round is: **fix the reading layer (including its own sizing arithmetic), settle the
weighting confound with a properly designed experiment, and replace "buy power for the
labeller" with "ship the labeller as an opt-in labeller and measure the one affordable
hurdle" — while the *signal* family, whose binding lever is cost, gets the cheap offline
turnover attack.**

---

## 1. The round-28 coherence re-read (new findings; full arithmetic in `RUN-ANALYSIS.md` §14)

Everything below is a *reading* defect or a recorded-decision drift: no scored number is
wrong, but the reports say things about themselves that are not true, and the sizing block
mis-directs the next run. All are off the default path; none may move a golden.

### C1 — `BUGS.md` **#56**: the sizing block mixes *paired* and *single-series* quantities

`decision.nextRun` puts two different scales side by side without saying so:

| field | what it sizes | scale |
| --- | --- | --- |
| `mde95`, `mde95Dependent`, `designEffect`, `barsToDetectObserved`, `dependence.seCluster` | a **single series** (the candidate's own Sharpe level) | SE 0.54654 (Step 2) |
| `pairedUnits.se` ← `promotionTest.sharpeDifference.se` | the **paired difference** vs the baseline | SE 0.13554 (Step 2) |
| `cheapestFlip` (kind `magnitude`) | **claimed** to size the paired test, but reads `dependence.seCluster` | mixes the two |

Measured consequences on Step 2 (`20260923T111159-seed1`):

- `cheapestFlip.requiredSharpeDifference` = **1.07120** = `1.959964 × 0.54654` =
  `mde95Dependent` exactly; `factor` = **4.95005**. The genuine paired requirement is
  `1.959964 × 0.13554 = 0.26560` (two-sided) or `1.68957 × 0.13554 = 0.22900` (one-sided,
  the test that actually runs) → factor **1.23** / **1.06**. The plan's and `RUN-ANALYSIS`
  §13.3's "magnitude ×4.95" is therefore ~4–5× overstated and points at the wrong lever.
- `pairedUnits.neededForObserved` = **55** (two-sided z) vs the one-sided requirement
  **41**; `pairedUnits.needed.mde95Dependent` = **3** is meaningless — it sizes a *paired*
  comparison at a *single-series* MDE target (`target = 1.07120` with `se = 0.13554`).
  Step 4 shows the same shape (`needed.mde95Dependent` = 112 from a single-series MDE).

**Fix (P1d):** make the block self-consistent — the pairing/magnitude hints read the **paired
SE** and the test's **one-sided** reference, the single-series fields keep their own labels,
and the reader names the scale of each. `pairedUnits` loses the cross-scale `mde95Dependent`
target (or gains a *paired* MDE target `z × pairedSe`).

### C2 — `BUGS.md` **#57**: the always-on fold-win *majority* hurdle contradicts the recorded decision

`DESIGN.md` §6.1 records the round-25 decision: *"The round-23/24 gate required
`foldWinFraction >= 0.5` and `positiveFraction >= baseline`. … The round-25 gate instead asks
(a) … and (b) … **The raw fraction is still reported, as a statistic.**"* But the shipped
`promoteDecision` still carries `minFoldWinFraction = 0.5` (and `minPositiveFoldDelta = 0`)
as **always-on reasons** (`walkforward.js:800–812`), computed by `foldWinFraction` over **all
288 folds**, i.e. over comparisons the project's own dependence analysis says are not
independent (8 streams per window, `streamCorr` 0.35–0.52). The round-27 runs make it bind:

| candidate (run) | `foldWinFraction` (288 folds) | cluster sign test (36 windows) | other binding reasons |
| --- | --- | --- | --- |
| `label-conservative` (Step 2) | **0.20139** ❌ | **0.500** (17/17/2) | unadj. DSR, adj. DSR, paired p 0.0597 |
| `sig:momentum` (Step 4, 0 bps) | **0.49306** ❌ | **0.52778** (19/17) | adj. DSR 0.9487614 |
| `sig-accel` (Step 4, 0 bps) | 0.53472 ✅ | 0.66667 | — (promotes) |

So at the fold level the best arm "loses badly" (0.20) while the error-controlled
window-level sign test says it is **exactly at the majority** (0.50); and the two near-misses
disagree in the same direction. `DESIGN.md` §6.1 already observed this pattern on the round-25b
signal run ("at the fold level the fractions said 'loses'; at the cluster level the tests said
'no significant magnitude'") — the code simply never dropped the raw hurdles.

**Fix (P1e):** make the code match the recorded decision — the raw fold fraction (and the
positive-fold fraction) become **reported statistics**, and the gate's breadth statement is the
error-controlled cluster tests that already exist (`requireSharpeDiff` magnitude +
`requireClusterStability` + the reported `breadth`). **This is verdict-neutral on all four
round-27 runs** — the adjacency table shows every candidate that fails the raw hurdle *also*
fails the DSR floor or the paired test — so it changes no verdict and manufactures no
promotion; verify that formally (P1e's acceptance) before landing it. Because a gate change is
a decision-procedure change (`DESIGN.md` §6.1), it gets a rationale + size note in
`METHOD.md` §8 and a `DESIGN.md` §6.1 addendum.

### C3 — `BUGS.md` **#58**: the sample-weight inertness on `optimistic` is a *config* artefact, not a label property

This is the deepest finding of the re-read, and it invalidates the stated basis of the round-27
decision D1 (`sample-weights` is inert on the shipped labeller *because labels do not overlap*).

- The `sample-weights` variant's `configure` sets the causal ring's span horizon to
  `ctl._labelHorizonBars > 1 ? floor(...) : 1` (`analyze.js:151–158`) — **1 on any
  `optimistic` run** (`optimistic` has no vertical barrier, so `_labelHorizonBars` is 1). Every
  assumed span is therefore one bar; `overlapUniqueness` returns all ones; the reported
  `sampleWeights {min 1, max 1, mean 1, ess = n = 43.825, effectiveFraction 1}` (Step 1) is
  exactly what that configuration must produce.
- But the *observed* labels are **not** one bar long: the #49-fixed `heldBars` diagnostic
  reports **`{count 4369, max 54, mean 8.301}`** on Step 1's `optimistic` baseline and
  **`{count 185937, max 72, mean 7.8245, cap 119}`** on Step 2's. Labels held ~8 bars
  **overlap**; AFML average uniqueness is therefore ≈ 1/8, not 1.
- The inert *reason text* (`analyze.js:145`, shipped into the certificate as
  `"the shipped (optimistic) labeller emits one-bar labels, so no two label spans overlap"`)
  and `METHOD.md` §4's decisive premise (`"the shipped labeler produces non-overlapping
  1-bar labels: the round-26 journal records heldBars {count=sum=185937, max=1}"`) both rest
  on the **pre-#49 diagnostic** — the false certificate #49 was raised to remove. `heldBars
  ≡ 1` was *the bug*, not evidence that labels are one bar.

**So** the all-ones vector on `optimistic` is a property of the estimator's *assumed horizon*,
not of the labels, and the mechanism has **never actually been tested** on the shipped labeller.
**Fix (P1a′ + P3):** the inert reason becomes the measured statement (the span horizon was
configured to 1 while the run's realized holding period is 8.30 bars — the all-ones vector is a
configuration artefact); and P3 gives the ring a **causally estimated span** (an EMA of past
realized holding periods, or an explicit `--sample-weight-horizon`, never the realized span of
the label being weighted) so the mechanism is live on `optimistic` too. `TODO.md` #5's
`optimistic` closure is re-opened pending that run.

### C4 — `pca-hash`'s certificate is a false *measured* reason too (`BUGS.md` #53, sharpened)

`pca-hash` is `appliesTo: 'model'` and carries **no** `inertReason`, so on Step 1 (18/18
identical) it inherits the generic string *"the mechanism never reaches the model path"* — a
structural claim the round-26 run's 6/288-fold difference falsifies. This is #53 as filed.
What the re-read adds is that the class is **not** limited to `pca-hash` (C3 is the same class),
and that liveness for `pca-hash` is further confounded: `_retrieveTopRelevantProtos` draws
`Math.random()` a **bucket-content-dependent number of times** (`retrieval.js:268/294/295/300/342`),
so a hash change shifts the whole trajectory *by the draw count*, and "positions differ" is not
by itself evidence the *retrieved prototype set* changed. **Fix (P1a + P2):** a measured
per-run reason for `pca-hash`, and a *retrieval-liveness* measurement (does the aligned basis
change the retrieved prototype ids?) rather than a position difference.

### C5 — `#55` as filed, with the exact fields

- `decision.training.labelPolicy` = `"optimistic"` in Step 2 (featured row
  `label:conservative`) and in Step 4 (featured row a pure signal) because it names the
  run-level flag, not the referent.
- `familyCorrelation.maxPair` carries **indices** (`{a: 0, b: 1, rho: −0.059446}`) into the
  *active* list the matrix was built from (Step 1: `K = 2`, `surprise ~ homeostasis`), but
  `formatAnalysis` resolves them against the *full* candidate list, so the summary prints
  `maxPair=sample-weights~multiprobe`. The number is right; the label is wrong.
- Neither run surfaces the knife-edge margins (`sig:momentum`'s adjusted DSR 0.9487614 vs 0.95
  = 0.00124 short; fold-win 0.4930556 vs 0.5 = 0.00694 short).

### C6 — good news that must stay true

- The #49 fix is visible in production: `optimistic` `heldBars mean 7.82 / max 72` (Step 2),
  `triple` `mean 6.77 / max 20 = horizon` with `resolvedTimeBarrier 16244` (Step 2/3) — the
  vertical barrier fires and the holding period varies.
- The K-restatement, the single-candidate `familyCorrelation {available: false}`, the
  per-kind forecast and the config echo all behaved as documented (`RUN-ANALYSIS.md` §13.6).
- The DSR floor is genuinely discriminating: it separates `sig-accel` (1.0194 → 0.9742) from
  `sig:momentum` (1.0848 → **0.9487614**) on the *dependence-adjusted* sample — i.e. it is
  reading the design effect, not peak Sharpe.

---

## 2. Priorities

Each priority: **goal · evidence · change · acceptance · test · cost · cannot prove**. `P1*`
are reading-only and cheap; `P2` is a harness experiment; `P3` is the one designed A/B that
settles a scientific question; `P4`/`P5` are decisions the corrected numbers force; `P6` is
gated; `P7` keeps the docs current.

### P1 — Make the reading layer tell the truth (cheap; no arithmetic; no golden may move)

Closes `BUGS.md` #53/#54/#55/#56/#57/#58 and `TODO.md` 74–83.

| sub | goal | change | evidence | acceptance / test |
| --- | --- | --- | --- | --- |
| **P1a** | a liveness reason must be a *measured per-run* statement | `pca-hash` gains an `inertReason` stating the measured cause ("the hyperplane refresh runs on the scored mind but changes no emitted position on this run's prototype pool / probe budget"); the generic fallback (`analyze.js:1042`) may not assert a structural unreachability for an `appliesTo: 'model'`/`'controller'` variant; soften `BUGS.md` #44's "live" to "reachable, and live at some budgets (6/288 at 8×600), inert at others (0/18 at 2×200)" | §C4; `RUN-ANALYSIS.md` §13.2; `TODO.md` 74 | a liveness row for a `model`-scoped variant can never carry the structural wording; `analyze.test.js` pins it; both certificates reproduce from their journals |
| **P1a′** | the `sample-weights` inert reason must be the real cause | replace "the shipped labeller emits one-bar labels" with the measured cause ("the causal ring's span horizon was configured to `runLabelHorizonBars = 1` on this run, so every assumed span is one bar and every weight is exactly 1, **although** the run's realized holding period is mean 8.30 / max 54 bars"); keep it as a variant-specific `inertReason` | §C3; Step 1 `heldBars {mean 8.301, max 54}` + `sampleWeights {min=max=mean 1}` | the reason text names the configuration and the measured holding period; a `sample_weights`/`analyze` test pins the wording; `METHOD.md` §4's premise is corrected in the same commit |
| **P1b** | the emitted weight stream must have mean 1 **over what is trained** | renormalise the **emitted** causal-window weight by a running mean of emitted weights (not the window's mean); keep the raw value reported as `meanUnnormalised`; the `null`-config path stays **bit-identical** | §C3, #54; Step 3 `sampleWeights.mean 2.61121` | `sample_weights.test.js` gains "the emitted stream's running mean is 1 at every prefix" (overlapping spans) and "raw is unchanged at horizon 1"; goldens byte-identical; the *batch* mean is the target (`_gradientResetFrequency` drains per accumulation batch) |
| **P1c** | the span must be *measured*, not assumed 1 | the ring's span horizon is either an explicit `--sample-weight-horizon=<n>` or a **causal** EMA of the realized holding periods of the trades drained so far (never the span of the label being weighted — that would be lookahead, which the audit exists to catch); `optimistic` then yields overlapping spans and non-trivial weights | §C3 | a unit test: at `optimistic` and a measured horizon ≈ 8, `ess/n < 1` and `min < 1 < max`; a causality test: perturbing the future does not change the emitted weight of an earlier label; the #49 audit stays clean |
| **P1d** | the sizing block must be self-consistent | `cheapestFlip`'s `magnitude` branch reads `promotionTest.sharpeDifference.se` (the paired SE) and the test's **one-sided** reference; `pairedUnitsNeeded` takes the side (`zOneSided`) and drops the cross-scale `mde95Dependent` target (or replaces it with a *paired* MDE `z × pairedSe`); each field's reader names its scale | §C1 | on a Step-2-shaped fixture the reported factor is ≈1.06 and `neededForObserved` ≈41 (t-based); a fixture where the two SEs are equal proves the old code could not tell them apart |
| **P1e** | the gate must implement the recorded decision (or the record must be amended) | drop `minFoldWinFraction`/`minPositiveFoldDelta` from the **always-on** reasons; keep the raw fractions as reported statistics; the gate's breadth statement is the error-controlled cluster tests; record the rationale + size note in `METHOD.md` §8 and a `DESIGN.md` §6.1 addendum. **Verify verdict-neutrality first** (see acceptance) | §C2; `DESIGN.md` §6.1 | re-run `promoteDecision` on all four reports' candidate rows with the raw hurdles off and show every `promote` unchanged (they are: each failing candidate also fails the DSR floor and/or the paired test); pin with an `analysis.test.js` fixture where the raw majority fails and the cluster sign test passes |
| **P1f** | report the knife-edge margins and the referent | each `reasons` hurdle carries `{hurdle, value, threshold, margin, direction}`; `decision.training.labelPolicy` → the referent's policy (or rename `runLabelPolicy`); `familyPairLabel` resolves `maxPair` against the **active** list the matrix used | §C5; #55 | `analyze.test.js` pins the field name, the active-arm label (a case where the full list would name an inactive arm), and a knife-edge reason string |

**Cost:** negligible (no run). **Cannot prove:** anything about the mechanisms themselves —
this is description.

### P2 — Can the PCA-aligned basis *ever* change what is retrieved? (harness experiment, minutes)

**Goal.** Separate "the mechanism is dead" from "the mechanism ran but no *retrieved set*
changed at this pool/probe budget", and find the budget (if any) at which it changes.

**Evidence.** Step 1 `pca-hash` inert 18/18 with a false reason (§C4); round-26 live on 6/288;
`_retrieveTopRelevantProtos` consumes a bucket-content-dependent `Math.random()` count, so a
position difference is confounded.

**Design (no full A/B needed).** A focused harness probe over the retrieval layer itself:
vary (a) the prototype-pool size / bar count and (b) the multi-probe budget (`budget`,
`maxFlips`, and the `adaptiveMultiProbeConfig` toggle), and at each point record
`hash of the retrieved prototype-id set` **and** the `Math.random()` draw count, with and
without `_pcaHashConfig`. Three outcomes are all informative: never differs (the honest status
is "reachable but behaviourally inert on the shipped A/B" → leave the roster and say so);
differs only below some budget (record the threshold, and whether it is the default); differs
only via the draw count (then the *positions* difference is not attributable to the basis, and
the certificate must say that — this is the second, subtler half of #53).

**Change.** If the experiment shows the retrieval *set* can change, add a
`retrievalLiveness` diagnostic to the report (does the variant change the retrieved set? the
RNG draw count?) beside the position-based `liveness`. If it cannot, keep the position-based
certificate and say "reachable, retrieval-inert at every tested budget".

**Acceptance.** A written threshold table in `RUN-ANALYSIS.md` §14 and a
`lsh`/`analyze` test pinning the chosen diagnostic. **Cannot prove:** that the basis helps —
only whether it acts.

### P3 — The weighting experiment, done properly (the round's designed A/B; ~2–4 h)

**Goal.** Decide whether causal-window uniqueness weighting helps, hurts, or is inert on the
**shipped** labeller, with the two confounds (span horizon = 1; mean 2.6× scale) removed.

**Evidence.** Step 1: all-ones weights, caused by `horizonBars = 1` (§C3). Step 3: live
(`ess/n 0.8248`) but harmful (paired −0.2276, 0/36 windows, break-even −4.51 bps) **at
≈2.6× the effective LR** (#54), where the model is plain SGD (`_applyGradients` subtracts
`Σ grad · lr / steps`, no momentum/Adam) so a per-sample weight scales the step directly,
modulo the norm-percentile `_scaleGradients` (a nonlinearity — hence the control arm below).

**Arms** (all on one `--symbols=all --bars=600 --test=15 --audit-probes=1 --reuse-base
--concurrency=4 --cost-ladder=0,2,5,10` run, with `sample-weights` + the baseline; the
**span** comes from P1c's causal estimator, so `optimistic` is now a legitimate setting):

| arm | span | normalisation | isolates |
| --- | --- | --- | --- |
| **A** (corrected mechanism) | measured (~8 bars) | emitted mean 1 | dispersion at matched LR |
| **B** (raw, optional) | measured | raw (`mean ≈ 2.6`) | scale + dispersion (reproduces Step 3 with a real span) |
| **C** (scale control) | measured | constant = the run's raw mean | scale alone, no dispersion |

A vs baseline = the mechanism's honest effect; C vs baseline = the pure LR effect; B − C =
the dispersion effect. Three model variants ≈ Step 3's cost ×1.5 (~2–3 h at `--concurrency=4`).

**Acceptance.** The run reports `sampleWeights {mean ≈ 1, min < 1 < max, ess < n}` for arm A
(and `meanUnnormalised` visible); the verdict is stated **per arm** against the same baseline;
`TODO.md` 5 is closed with the correct sign, or re-opened with the corrected evidence.
**Cannot prove:** that uniqueness weighting helps on *other* label policies/data — only this
one.

### P4 — The label-policy decision: ship the labeller, measure the affordable hurdle (no power purchase)

**Goal.** Record what the round-27 evidence actually supports, and stop treating
`label:conservative` as a near-miss awaiting more bars.

**Evidence (corrected, §0/§C1).** Sharpe 0.10171; DSR 0.33272; adjusted DSR 0.25213;
break-even **+2.24 bps** (the baseline's is **−2.58 bps** → the labeller moves a *losing* model
to ≈break-even); stability 1.0 (36/36 leave-one-window-out differences positive, worst
+0.10471); cluster sign test **0.500** (17/17/2); paired Δ 0.21640, se 0.13554, t 1.59663,
p 0.05967 → **94.5 % of the t required**; **41 clusters** would make it significant,
**89** would give 80 % power (t-based; the plan's `81` is the normal approximation —
`RUN-ANALYSIS.md` §14.7a); the DSR floor needs a Sharpe ≈ **1.02–1.08** (i.e. ≈10× more),
equivalently **93,576** i.i.d. bars.

**Decision (recorded in `METHOD.md` §7).** *Do not buy power for the DSR floor — it is
unreachable at this effect size.* Instead:

1. **Record `label:conservative` as the programme's best labeller and make it the
   *documented* opt-in choice** — it is already selectable (`--label-policy=conservative`), and
   it must **stay behind the flag**: making it the run-level default would change every
   training set and move all 11 golden fingerprints, which is a deliberate re-freeze the
   evidence does not justify. Record it as "a labeller that improves a negative-edge baseline
   to ≈break-even — arm-level, not a promotion".
2. **Buy the one affordable hurdle.** Run the *same* design at **`--test=10`** (54 clusters
   > the 41 needed) to convert the paired statement from p 0.0597 to a decision. Cost ≈1.5×
   Step 2 (~3–4 h at `--concurrency=4`). This is *diagnostic* — it completes the statistical
   description of the labeller effect; it cannot clear the DSR floor.
3. **Treat "a larger effect" as the real lever**, and note it is a *new candidate family*
   (harsher conservative tie-breaks / a different horizon / meta-labelling — AFML ch. 3), not a
   sample-size purchase. Do not schedule it in round 28.

**Acceptance.** `METHOD.md` §7 records the decision; the `--test=10` run's readout is
"`neededForObserved` (one-sided) ≈ 41 ≤ 54 observed" and the paired p is the headline; no
promotion is claimed. **Cannot prove:** that the improvement survives a different basket /
cost / horizon.

### P5 — `sig-accel`: arm-level, and the lever is cost, not power (cheap offline + optional run)

**Goal.** Dispose of the round's only promotion honestly, and test the lever the evidence
points at.

**Evidence.** `sig-accel` promotes at **0 bps** (adjusted DSR 0.9742, paired p 0.04930,
stability 1.0, audit 288/288, breadth 24/12 p 0.03262) and fails at **2 bps** (adjusted DSR
0.92230, paired p 0.06284); its gross break-even is **11.57 bps** — so it is *economically*
viable up to ~11 bps and the 2-bps failure is the **knife-edge DSR floor**, not a loss. It
correlates **0.6972** with `sig:momentum` (`effectiveTrials` 1.178 of 2); its twin
`sig:momentum` fails only the raw fold-majority (0.49306, see #57) and the DSR floor
(0.9487614). Signals are model-free and ~600× cheaper than the baseline (4.57 s vs
2 716 s).

**Change/experiment (offline, minutes; no refit).** `restateReportAtPolicy` + `turnoverSweep`
are pure over the retained journal (R26-3/R26-5), so sweep a **no-trade region / minimum hold**
on `sig-accel`'s journaled raw confidence and re-read the cost ladder: does a holding rule keep
Sharpe ≈ 1.0 while lifting the adjusted DSR at 2 bps back above 0.95? Grounding: Constantinides
1986 / Davis & Norman 1990 / Gârleanu & Pedersen 2013 (the no-trade region), arXiv 2502.04284
(alpha decay ⇒ past signal values matter). If it works, it is a *new candidate* (its own A/B);
if it does not, record it as "the signal family is cost-fragile, and the fold-majority hurdle
must be re-examined first".

**Acceptance.** A `RUN-ANALYSIS.md` §14 table: for each policy in the sweep, the cost ladder's
`sig-accel` adjusted DSR and paired p at 0/2/5/10 bps. **Cannot prove:** that a holding rule
generalises beyond this window (the window-dependence caveat).

### P6 — Buy independence, not bars — and *measure* it before building it (gated on P4)

**Goal.** Attack the design effect (the binding constraint: `effectiveStreams` 2.05/2.30/2.47/
1.89 of 8; inflation 5.12× on Step 2) with the cheapest available lever.

**Cheapest measurement (offline, minutes, do this first).** A **market-neutral overlay**
applied as pure post-processing to a candidate's retained `streamReturns`
(`r_s(t) − mean_s r(t)` per bar) recomputes the dependence panel without any new code or run:
how much of the 5.12× design effect is the common market factor? This is the decisive
feasibility number for a cross-sectional candidate, and it costs one scratch script.

**Then, if it pays, the candidate (a *new* family, gated).** A cross-sectional / market-neutral
signal — rank the 8 streams by a causal feature at bar `t`, long the leaders / short the
laggards, net exposure ≈ 0 — which cancels the common factor *by construction* and therefore
has far less cross-stream return correlation than the same feature applied per stream.
Grounding: Moskowitz & Grinblatt 1999; Asness, Moskowitz & Pedersen 2013; and the 2022–2026
cross-sectional literature (arXiv 2302.10175 spatio-temporal momentum, arXiv 2012.07149
learning-to-rank, arXiv 2208.09968 transfer ranking; market-neutral construction arXiv
1908.02164, 1901.09309). **Caveat to state up front:** the current signal interface is
per-stream (`fn(series, t, params)`), so a cross-sectional candidate needs a cross-stream
view at bar `t` and its own causality proof (perturbing one stream's future must not move any
stream's position at `t`). It is a `DESIGN.md` §6 decision + its own A/B, **not** a round-28
deliverable.

**Also record (do not schedule):** more bars is *not* useless for the *paired* question —
675 bars at `test 15` gives the 41 clusters — but it is the wrong lever for the DSR floor
(93,576 bars i.i.d.; independence buys ≈2.3× on the SE), and METHOD.md §5's blanket "more bars
is the worst-value lever" should be qualified to say exactly that.

### P7 — Doc, method and README sync

`RUN-ANALYSIS.md` §14 (the coherence re-read + the corrected sizing table; and a correction
banner on §13.3's "magnitude ×4.95" and §13.8 item 5's wording), `METHOD.md` §4 (the C3
premise correction) + **new §7** (paired vs single-series sizing; the one-sided reference) +
**new §8** (the fold-majority hurdle) + **new §9** (the span must be measured), `DESIGN.md`
§6.1 (the round-28 addendum), `BUGS.md` #56/#57/#58 + the header OPEN list, `TODO.md` 74–78
pointers + new 79–83, `ROADMAP.md` (a round-28 section + the coherency-audit line that claims
the fold-consistency hurdle was replaced), `CITATIONS.md` + `research/financial-validation.md`
(the new cross-sectional / sizing citations), `RUNBOOK.md` §6/§7 and `src/README.md`. When a
defect lands, move it to **Fixed** with the test that pins it.

---

## 3. Runs (exact commands; the operator runs exactly these)

Assumes P1*, P2 and the P3/P5 code have landed and `npm test` is green (the golden suite
unmoved). All runs write their directory under `src/` like the round-26/27 runs.

**Step 0 — the gate.**
```
npm test
```

**Step 0.5 — offline restatements (no model; minutes).** From a retained journal:
(a) the P4 sizing table (one-sided t; the 41/89-cluster requirements — the plan's `81` is the
normal approximation, §0 and `RUN-ANALYSIS.md` §14.7a); (b) the *market-neutral*
dependence measurement (P6); (c) the `sig-accel` no-trade-region cost ladder (P5). All three
are pure post-processing of `folds.jsonl` / `report.json`, exactly as round 27's §1.3
reconstruction was. **The round-27 journals are gone, but `folds.jsonl` carries the panel (b)
and (c) need** — per line: `stream`, `fold`, `test`, `returns`, `signals` — so **(b) is
available from Step 1's or Step 2's journal** (both are `--symbols=all`, `--fold-log=all` is the
default), while **(c) needs a signal-family run** (neither Step journals a `sig:*` candidate).

**Step 1 — the corrected weighting experiment (P3; ~2–3 h).**
```
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --seed=1 \
  --audit-probes=1 --reuse-base --concurrency=4 \
  --variants=sample-weights,sample-weights-scale-control \
  --cost-ladder=0,2,5,10
```
Expected: arm A `sampleWeights {mean ≈ 1, min < 1 < max, ess < n}`; arm B/C as tabled; a
per-arm verdict against the same baseline. *(The two control arms are the same mechanism with
a different normalisation — one opt-in variant id each, off by default.)*

**Step 2 — the label-policy paired-power confirmation (P4; ~3–4 h).**
```
npm run analyze -- --symbols=all --bars=600 --train=60 --test=10 --seed=1 \
  --audit-probes=1 --reuse-base --concurrency=4 \
  --variants=label-conservative --label-horizon=20 --cost-ladder=0,2,5,10
```
Expected: 54 clusters; `neededForObserved` (one-sided) ≈ 41 ≤ 54; the paired p is the
headline; the DSR floor still binds (state why: Sharpe 0.10 vs the ~1.05 the floor needs).

**Step 3 (optional) — the P2 retrieval probe.** Harness only; no full A/B.

Nothing else is run. Specifically **not**: more bars for the DSR floor; a `multi-probe`/
`query-mod` controller run (proved unreachable); a promotion of `sig-accel` at 0 bps; a
`label-triple` without `--label-horizon`; any golden re-freeze.

## 4. Decisions (the agent has technical authority per `PLAN-round27.md` §3.5; recorded, not asked)

| # | decision | evidence |
| --- | --- | --- |
| D1 | **The DSR floor is a magnitude gate, not a power gate.** Do not buy sample for `label:conservative`. | Sharpe 0.1017 vs the ≈1.02–1.08 the floor needs; `barsToDetectObserved` 93,576; §0 |
| D2 | **Record `conservative` as the programme's best labeller and the documented *opt-in* choice** (it stays behind `--label-policy`; making it the default would move every golden), recorded as arm-level. | Step 2 table; `METHOD.md` §7 |
| D3 | **Buy the paired hurdle instead:** `--test=10` (54 clusters ≥ 41). | §C1 arithmetic |
| D4 | **Fix the sizing block's scale mixing** (#56) — it currently mis-directs the next run by ~5×. | §C1 |
| D5 | **Make the gate match the recorded decision** (#57): the raw fold fractions become statistics; verdict-neutral on all four runs. | §C2 |
| D6 | **The weighting mechanism was never correctly tested**: the span horizon was 1 while labels are held ~8 bars, and the emitted weights ran at 2.6× the LR. Re-test with both fixed, plus a scale control arm. | §C3, #54 |
| D7 | **Measure the market-neutral overlay offline before building any cross-sectional candidate.** | P6; `effectiveStreams` 2.05–2.47/8 |
| D8 | **`sig-accel` stays arm-level; its lever is cost/turnover, tested offline first.** | Step 4 cost ladder; break-even 11.57 bps |

## 5. Files to change (implementation map)

| file | change |
| --- | --- |
| `src/analyze.js` | `pca-hash` `inertReason`; the `sample-weights` inert reason (P1a′); the generic fallback may not claim structural unreachability for `model`/`controller` variants; two opt-in control variants for P3; optional `--sample-weight-horizon`; `retrievalLiveness` diagnostic (P2, if the probe supports it) |
| `src/hivemind/training/sample_weights.js` | emitted-stream renormalisation (P1b); a **causal** span estimator (P1c) beside `causalWindowWeight`, no change to existing exports |
| `src/hivemind/controller/trades.js` | feed the measured span into the ring; report `meanUnnormalised` |
| `src/analysis/decision.js` | `cheapestFlip` reads the paired SE + the one-sided reference; `pairedUnitsNeeded` takes the side / drops the cross-scale target; per-field scale in the readers |
| `src/analysis/walkforward.js` | drop the raw fold hurdles from the always-on reasons (P1e); keep them reported; `reasons` carry margins |
| `test/browser/entries/*` + `test/node/*` | the P1 tests; an `analysis.test.js` fixture where the raw majority and the cluster sign test disagree; a `sample_weights` emitted-mean test; a `decision` scale fixture |
| docs (P7) | `RUN-ANALYSIS.md` §14, `METHOD.md` §4/§7/§8/§9, `DESIGN.md` §6.1, `BUGS.md`, `TODO.md`, `ROADMAP.md`, `CITATIONS.md`, `research/financial-validation.md`, `RUNBOOK.md`, `src/README.md` |

## 6. Risk and rollback

| item | risk | mitigation / rollback |
| --- | --- | --- |
| P1b/P1c (weights) | a running-mean normaliser is a new dynamical element; a sign/off-by-one silently changes training | exact reference vectors; `null`-config bit-identity; the weights are reported so an error is visible; the scale-control arm makes a wrong normaliser detectable rather than confounded |
| P1e (gate) | removing a conservative hurdle could raise the false-promotion rate | the replacement is error-controlled (paired magnitude + stability + DSR floor); verdict-neutrality is proved on all four reports before landing; `METHOD.md` §8 records the size reasoning; rollback is a one-line default |
| P1d (sizing) | a changed `requiredSharpeDifference` moves the "cheapest flip" hint | report both scales explicitly; the fixture proves the old code conflated them |
| P2 (retrieval probe) | the RNG draw count makes the measurement noisy | compare the *retrieved id set* (deterministic) with the seed fixed; report the draw count beside it |
| P4 (`--test=10`) | shorter test windows make each fold noisier, so the paired SE may not fall as 1/√n | the run reports the realised SE; if the SE does not fall, the honest conclusion is "the paired hurdle is not affordable via `testSize`" and P4 falls back to statement (2) |
| P6 (cross-sectional) | new candidate family with a new interface | gated on the offline overlay measurement; `DESIGN.md` §6 decision + its own A/B before wiring |

## 7. What each step can and cannot prove

| step | can prove | cannot prove |
| --- | --- | --- |
| §0.5 offline | the corrected sizing; the market-neutral dependence reduction; `sig-accel`'s cost/policy surface | anything about a new mechanism |
| Step 1 (P3) | whether uniqueness weighting helps/hurts/inerts when its span and scale are correct | whether it transfers to other labels/data |
| Step 2 (P4) | whether the labeller's paired effect is significant at 54 clusters | a promotion (the DSR floor binds) |
| P2 probe | whether the aligned basis can change the retrieved set, and at what budget | whether it helps |

## 8. Definition of done for round 28

1. `BUGS.md` #53–#58 are **Fixed** with the test that pins each; no golden fingerprint moved
   (`golden.test.js` 23/0).
2. The sizing block's two scales are distinguishable by unit test; `neededForObserved` matches
   the test's one-sided reference.
3. The gate implements `DESIGN.md` §6.1 (or §6.1 is explicitly amended), with the
   verdict-neutrality proof recorded.
4. `TODO.md` #5 is closed with the corrected evidence (span + scale fixed), and 74–83 are in.
5. The three offline restatements and (if scheduled) Steps 1/2 are filed under `src/`, and
   `RUN-ANALYSIS.md` §14 carries their readouts.
6. `npm test` green (browser + native), ledger counts re-synced and recorded.
7. No default path changed except through an explicit, documented decision.

## 9. Order of work

1. **P1** (reading + sizing + gate coherence) — cheap; unblocks every number quoted afterwards.
2. **P2** (retrieval probe) — small; closes #53's open question.
3. **P3** (weighting, corrected) — the designed A/B.
4. **P4/P5** — the two decisions; their offline halves first.
5. **P6** measurement (gated build).
6. **P7** — keep the docs current as each item lands.
