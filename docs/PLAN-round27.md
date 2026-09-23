# NeuLegion — Round 27 plan (make a candidate prove it ran, make the labeler reachable, then run the two experiments)

Status: **IMPLEMENTED AND RUN (round 27).** R27-1…R27-6, R27-8 and R27-9 are in the tree and `npm test` is green; **R27-7's four runs are done** (see the deviations below and `RUN-ANALYSIS.md` §13) (R27-8's note is written from the corrected run's dependence panel — `METHOD.md` §5). See `BUGS.md` #43–#52 and `RUNBOOK.md` §6 for the dispositions. Implementation deviations from this plan: (a) `restateReportAtCost` needed a single-stream fix first (`BUGS.md` #51); (b) controller-level cross-run determinism is not testable in the harness (two controller streams in one worker share model module state), so R27-6.1 pins determinism on a bare `HiveMind` — identical predictions *and* identical `Math.random()` draw counts; (c) R27-2's behavioural tests are the broadcast-flag bit-identity check through the model harness plus the `_getGlobalLSHCandidates` on/off difference already in `lsh.test.js` §I — neither flag is forwarded to the controller's inner mind, so `not-applicable` is proved by construction; (d) field names as shipped: `trialsInactive` (this plan says `trialsInert`), the model block's `sampleWeights` (this plan says `sampleWeightStats`), and `trainingStepsDistribution` (this plan says `trainingSteps {min,median,max}` — renamed to avoid colliding with the pooled scalar); (e) R27-1's test (f) ("the shipped controller roster has at least one *live* mechanism") is not asserted as worded: the corrected run's own evidence is that several stock mechanisms are legitimately byte-identical to the baseline, so the guard is the synthetic-variant liveness block (§M2) plus `controller_invariants` §D (a mechanism that *can* express an effect — the causal-window weight under overlapping labels — really does vary), which is the property that must hold; (f) the controller's predict guard also requires `>= 0` (not just finite), so a negative value can never be written to the NOT NULL `confidence` column. **R27-7's runs are now DONE** — all four complete; forensics in `RUN-ANALYSIS.md` §13, with three deviations from the plan's expected readouts: (g) §6 Step 1 expected `pca-hash` **live**, but on the 2-stream run it is `inert` (18/18) with the generic "never reaches the model path" reason — which the round-26 8×600 run's 6/288-fold result falsifies, so the certificate is run-dependent and the variant needs its own `inertReason` (`BUGS.md` #53); (h) §3.8 said "if `ess ≈ n`, close TODO #5 permanently" — instead `ess/n = 0.8248` (live) and it *hurts*, but the emitted weights average 2.6112 because only the newest window span is trained, so Step 3 ran at ≈2.6× the effective learning rate and the verdict is confounded (`BUGS.md` #54; re-run with normalised emitted weights before closing item 5); (i) Step 2's summary positive is `label:conservative` (paired ΔSharpe +0.2164, p 0.0597, stability 1.0/36, break-even +2.24 bps) and Step 4 promotes `sig-accel` at `costBps 0` only (it fails at 2 bps); the signal variants are exactly seed-free, so `--seeds` is vacuous for them. Follow-ups are items 74–78 of `TODO.md` and `PLAN-round28.md`. Original plan: written after the `20260922T204248-seed1`
round-26 power run, a controller/A-B code sweep, and a second, deeper sweep
(code + journal) that produced two decisive findings — **#49** (the holding-period
/ vertical-barrier defect) and **#50** (a wrong variant id in this plan's own run
command) — plus an *exact offline K-sensitivity restatement* of the round-26
journal. Findings are in [`BUGS.md`](BUGS.md) #43/#44 (sharpened) and
**#46/#47/#48/#49 (new)**; the K-sensitivity evidence is `RUN-ANALYSIS.md` §10.10.

Every item below is either a *reading* fix (the run's numbers are already
reproducible; the run's *description of itself* is wrong), a *reachability* fix
(a feature that cannot fire), or the wiring that makes an already-planned
experiment testable. No item changes the model's arithmetic on the shipped,
default path, so **no golden fingerprint may move** — that is an acceptance
criterion, not a hope.

Round 26's order was correctness → throughput → economics → decision quality →
family search. Round 27's order is **liveness → reachability → honesty → the
unrun experiments → power**, because the round-26 run proved the reading layer can
present an untested candidate as tested, and because the sweep proved the
`triple` label policy and the sample-uniqueness mechanism are *structurally
unable to express their effect* until #49 is fixed.

---

## 0. What this round is NOT

- Not a new model, not a new feature, not a new dataset fetch. The frozen core
  ([`DESIGN.md`](DESIGN.md)) is untouched.
- Not a re-run of round 26's design for its own sake. §6 names exactly how many
  runs there are, and says what each one can and cannot answer.
- Not a claim that the near-miss signals are real. It is a claim that the *gate*
  was applied to a roster that was 3/7 fabricated, that the `triple`-label
  candidate could never have differed from `conservative`, and that no cost or
  "no edge" conclusion may be read off a design whose effective sample is 888 of
  4,320 bars.
- **Not the agent asking the operator to choose the technical path.** The
  operator has stated (verbatim, §3.5) that the agent has full authority over what
  is implemented, provided the choice is backed by research and by the runs'
  evidence. §3.5 therefore *records decisions*, not open questions. The operator's
  understanding of the codebase is limited, so the technical calls are the agent's;
  every call below cites its evidence.

---

## 1. What round 26 established, and what this session's re-read added

From `RUN-ANALYSIS.md` §10 (all re-derived offline from `folds.jsonl`; the
reconstruction is now proven exact — see §1.3):

| quantity | value | why it matters here |
| --- | --- | --- |
| baseline Sharpe / DSR / adjusted DSR | −0.1147 / 0.0124 / 0.0235 | a *trained* model with **negative** skill (`brierSkill −0.0751`), so the "no edge vs never trained" ambiguity resolves as **no edge** |
| baseline label base rate | 0.3784 (64,197 TP / 169,644 resolved) | the chance-corrected reference |
| dependence panel | streamCorr 0.3535, `effectiveStreams` **2.30 of 8**, design inflation **4.87×** | the basket is ~2.3 independent streams, not 8 |
| power | MDE95 ±0.4734 i.i.d. vs **±1.0442** dependence-adjusted, `effectiveBars` 887.9 of 4,320 | the run is `UNDERPOWERED` on the statistic the gate uses |
| gate | all 14 keep-off, SPA p = 0.4731, K = 15, `effectiveTrials` 6.10 of 14 | K is inflated by untested arms |
| near-miss 1 | `sig:acceleration` (id `sig-accel`) Sharpe 1.0194, adj. DSR **0.8343**, paired p 0.0493, stability perfect, breadth 24/36 | fails *only* `minDsrAdjusted 0.95` |
| near-miss 2 | `sig:momentum` Sharpe 1.0848, fold-win **0.4931**, adj. DSR 0.7375, break-even 14.64 bps | one fold short of the 0.5 fold-win hurdle |
| cost verdict | ladder promotes `[none]` at 0/2/5/10 bps; momentum break-even 0.48 bps @2,200 bars vs **14.64 bps @600** | the economic ceiling is **window-dependent** and must always be stated with its window |
| cost | 7.90 h, **concurrency 1**, `reuseBase: true`, `auditProbesPerFold: 1`; 7 mechanism variants ≈ 3.9–4.2 M ms each, 8 signal variants ≈ 50–162 ms each | a mechanism variant costs ~4,050 s; a signal variant is free |

### 1.1 Correction to the previous plan's cost framing

The round-26 run **already used `--reuse-base` and `--audit-probes=1`** (both are
in `report.json`/`run.json`). The previous draft implied it paid the `2`-probe
default. It did not. The R27-9 default changes are therefore still worth baking in
(they protect an operator who types no flags) but they are **not** what makes the
round-27 runs cheap; the planned commands already pass them explicitly.

### 1.2 Two structural consequences

1. **Independent information, not bars, is the binding constraint.** Design
   inflation 4.87× at 4,320 bars; `effectiveStreams` 2.30. More bars of the same
   basket raises the i.i.d. sample and barely moves the dependence-adjusted MDE.
2. **A signal candidate is free to test; a model candidate is not.** 0.06 s vs
   4,050 s. So the only model-scoped experiments worth buying are the ones that
   have never run at power (label policy, sample weighting) — and, per §2.7,
   the second of those is only *expressible* after #49 is fixed.

### 1.3 The journal is a complete, exact witness (new)

This session reconstructed every round-26 pooled metric from `folds.jsonl` alone
(raw per-fold `returns` + `signals` → `strategyReturns` → pooled series →
`sharpeRatio`/`skewness`/`kurtosis` → `deflatedSharpeRatio`), using the shipped
`analysis/backtest.js` / `analysis/performance.js`. It reproduces the report's
`perPeriodNetSharpe` to `~1e-9` and every `dsr` to the printed 6 dp, for all 15
variants (e.g. baseline `recon −0.007224877` vs report `−0.00722487666`;
`sig-accel` `recon dsr 0.995306` vs report `0.995306`). **Consequence:** a
trials/K restatement, a cost restatement and a policy restatement are all
purifiable post-processing of the uploaded journal — they do **not** need a model
re-run. §6 Step 0.5 uses this.

---

## 2. The findings this plan fixes (with the exact code path and the proof)

### 2.1 #43 sharpened — sample weighting is a mathematical no-op, in production too

The previous diagnosis was "`configure: null`, so `_sampleWeightConfig` is never
set". True, but not the whole defect. `HiveMindController._processClosedTrades(processCount)`
reads `LIMIT processCount` rows and calls `_sampleWeightsForBatch(trades)` on that
batch. The A/B calls `getSignal(candles, 1)` and **production calls it with
`CONFIG.baseProcessCount = 1`** (`legion/config.js:32`, threaded through
`legion/workers.js:90`). So the batch is always a *single* label, and

```
spanWeightsFromEntries([k], cfg) === [1]   for normalization none | mean1 | sum1
```

(measured; ten consecutive entries at `horizonBars 20` give 0.825–1.355 with
effective sample size 9.64 of 10). So a `configure` alone would still be a no-op.
**§2.7 then shows the deeper truth: even a batch would not overlap, because the
shipped labeler produces 1-bar labels.**

### 2.2 #44 sharpened — `multi-probe`/`query-mod` are off the model path; `pca-hash` is live only via an undocumented reader

Statically provable:

- `_getGlobalLSHCandidates` has exactly **one** caller: `transfer.js:74`, inside
  `broadcastMemory`.
- `broadcastMemory` is **read-only on the model** — the prototype methods it calls
  are pure reads, and its result is returned as data.
- Its consumer is `hiveMindController.getSignal`: `this._memoryBroadcast = …` feeds
  the *signal payload only*; `translateMemory(sharedMemories=[])` early-returns
  without mutating.
- The *live* retrieval path is a **different** reader: `retrieval.js:251`/`:303`
  probe `this._semanticLSHBuckets` directly and consult **neither** flag.
- `pca-hash` is live because `_refreshLshHyperplanes` mutates `_lshHyperplanes`,
  `_lshAlignedRank` and `_semanticLSHBuckets`, all of which
  `_retrieveTopRelevantProtos` reads (`retrieval.js:224`). Two consequences:
  (a) its *documented* consumer is the dead one; (b) `_retrieveTopRelevantProtos`
  draws `Math.random()` a *bucket-content-dependent* number of times
  (`retrieval.js:268/294/295/300/342`), so changing the hash basis changes the RNG
  draw count and the whole trajectory — "differs from baseline" is not by itself
  evidence the *intended* mechanism did the work.

Measured: `multi-probe`/`query-mod` byte-identical on 288/288 folds; `pca-hash`
differs on 6/288, `surprise` 99/288, `homeostasis` 246/288.

### 2.3 #46 (new) — a degraded prediction is read as a maximal short, and a rejected training row corrupts the step counter

- `HiveMind.predict` returns **`0`** on invalid input (`hiveMind.js:129`).
  `isValidNumber(0)` is `true`, so the controller keeps `prob = 0`;
  `confidenceFromProb(0) = −1`; and with `POSITION_POLICY { deadZone: 0.05 }` that
  is a **full short**, not an abstention. (The `makeControllerModelFactory.predict`
  guard `s.prob >= 0` cannot catch it: `0` is a legal-looking extreme.)
- `HiveMind.train` bare-`return`s `undefined` on invalid input (`hiveMind.js:136`),
  while the success path returns `this._trainingStepCount`. `_processClosedTrades`
  assigns it straight into `globalAccuracy.trainingSteps`
  (`trades.js:273`), so the counter can become `undefined`; `_saveGlobalAccuracy`
  then binds `undefined` into `NOT NULL`, and `finalScore`/`ready` read false.

Both are latent on validated input today — which is why they are cheap to make
impossible rather than merely unobserved.

### 2.4 #47 (new) — `undertrainedFolds` is a false certificate

`makeControllerModelFactory` computes `undertrained = !(testStart >= warmup)` with
`warmup = 40`; the default split's first test bar is `≥ trainSize = 60`. So
`undertrainedFolds` is **always 0**, printed beside real diagnostics. Same class
as #35.

### 2.5 #48 (new, minor) — `skipped` is reported but not enforced; the stats schema lies

- `evaluateAB`/`evaluateABAsync` compute `skipped = !!variant.controllerScoped &&
  model !== 'controller'`, record it, but still evaluate the variant and still pass
  it to `walkForwardSearch`, so a `--model=bare --variants=sample-weights` run would
  count it in K and fabricate keep-off reasons.
- `controller/database.js:40` declares `global_stats.value INTEGER NOT NULL` while
  `brier_sum` is a float. SQLite's INTEGER affinity stores the float losslessly, so
  numbers are correct, but the schema claims a type the data does not have.

### 2.6 #45 — the decision block's training answer describes only the winning row

`decisionReport({ model: featuredRow.model })` is built from the **featured
(winner)** row; the round-26 winner is `sig:momentum` (a pure signal, no model
block), so `decision.training.model` renders *"no model diagnostics were collected
for this run (a pure-signal or bare run)"* — false: seven controllers trained
170,004 steps each. Pinned by a signal-wins fixture.

### 2.7 #49 (new, decisive) — `heldBars` is structurally exactly 1, and the vertical barrier can never fire

This is the finding that reshapes the round.

`getSignal` calls `this._updateOpenTrades(recentCandles)`, and `recentCandles`
is only the bars that were **newly inserted** this call
(`candles.js`: `INSERT OR IGNORE` + `result.changes > 0`). Both the A/B
(`getSignal(window, 1)`, window advancing by one bar) and production
(`workers.js:39` passes `state.cache.slice(-cacheSize)`, of which exactly one bar
is new per call) therefore hand `_updateOpenTrades` **exactly one candle per
call** in steady state.

Inside `_updateOpenTrades`, `barsAfterEntry` is a loop counter over the `candles`
argument (the one new bar), so whenever a trade closes, `barsAfterEntry === 1`.
Measured in the round-26 journal: `heldBars { count: 185937, sum: 185937,
max: 1, mean: 1 }` — a "holding-period distribution" with **zero variance**.

Consequences, all present in the shipped code:

1. `heldBars` is a **false diagnostic**: it is not the holding period; it is "the
   position of the close inside this call's new-bar list", which is always 1. The
   R26-2 label-lifecycle readout (`heldBars`, and the plan's idea of deriving a
   uniqueness horizon from it) rests on a quantity that cannot vary.
2. `resolvedTimeBarrier` can never fire.
3. **The `triple` label policy's vertical barrier is unreachable for
   `horizonBars > 1`** (`trades.js:115`: `barsAfterEntry >= horizonBars`). Under
   `--label-policy=triple` without `--label-horizon`, `_labelHorizonBars` is `null`
   and the policy **degrades to `conservative`**; with `--label-horizon=H>1` it
   *still* degrades to `conservative`, silently. So the R26-11 `triple` candidate
   has never been testable and, as written, cannot be.
4. A trade that never hits a horizontal barrier never closes and is never trained;
   with a working vertical barrier it would be labelled at `H` bars.

**Fix (R27-4b, §3):** compute `barsAfterEntry` from the **cached window** (which
`getSignal` already builds as `fullCandles`), not from the new-bar list, and pass
that window into `_updateOpenTrades`. The barrier *fill* loop stays over the new
bars (so the optimistic/conservative arithmetic and the golden fingerprints are
untouched); only the *elapsed-bar count* — the diagnostic and the vertical-barrier
test — becomes true. The cache is bounded (`cacheSize`), so the count is capped at
`cacheSize − 1`; that cap is recorded. A regression test pins (a) optimistic and
conservative positions byte-identical before/after, (b) `heldBars` varying when
labels are held, (c) a `triple` fold at `H > 1` producing `resolvedTimeBarrier > 0`.

### 2.8 #50 (new, plan-internal) — the previous draft's optional run command used a non-existent variant id

`SIGNAL_CANDIDATES` ids are `sig-momentum, sig-frac-momentum, sig-vol-regime,
sig-agreement, sig-range, sig-volume, sig-autocorr, sig-accel`. `--variants=…`
resolves ids via `resolveVariant`, which **throws** on an unknown id. The previous
draft's Step 3 said `--variants=sig-momentum,sig-acceleration`; `sig-acceleration`
does not exist (it is the *label* `sig:acceleration`), so that command would abort
immediately. Corrected to `sig-accel` in §6. Recorded here so the record shows the
plan was checked against the code, not transcribed.

Also corrected in this revision: the previous draft invented a `--list-variants`
flag; the taxonomy readout must be added as a **new** CLI flag (R27-2), and the
**report/journal leak the operator's absolute filesystem paths** — every round-26
`folds.jsonl` row carries `streamLabel: "/home/gingerninja/Desktop/projects/…"`
(R27-5 normalises it to the symbol name).

### 2.9 Controller sweep — the rest of the hot path is clean

Checked and **correct**; each worth a regression lock rather than a fix:

| checked | verdict |
| --- | --- |
| `_getRecentCandles` window/trim/`INSERT OR IGNORE` | correct; `recentCandles` = newly inserted bars only; trim is `cacheSize`-bounded and the A/B's sliding window matches production's shape |
| timestamp ordering | **verified on real data**: 79,554 BTCUSDT 1h rows, 24-char ISO-8601, strictly increasing, 0 duplicates, so `ORDER BY timestamp`/`NOT IN` (TEXT) are sound |
| `_updateOpenTrades` entry-time guard | correct: the trade opened at bar `i−1` can only be closed by bars `> i−1`, so no same-bar fill, no lookahead |
| feature extraction | `_trainingCandleSize × _trainingIndicators = 5 × 6 = 30 = _inputSize`; `_robustNormalize` is causal and clamped to `[0,1]` with a `0.5` fallback |
| audit causality | probe re-fits a fresh model from the same seeded stream; the training prefix is `≤ testStart ≤ t` from the unperturbed region; `viewFor` makes the view the model reads |
| dedup | `trained_features` hashes `features.join(',')|outcome`; duplicates are counted in `total`/Brier but not trained — intended, but the base rate is quoted over a superset of the trained rows and should say so |
| determinism | every `getSignal` path is wrapped in `withSeed`; the retrieval `Math.random()` draws are inside that seed, so a fold is reproducible — but the draw *count* depends on bucket contents (§2.2b) |
| open-trade book / drain lag | one trade per bar in, one out (`processCount = 1`); TODO #62 (entry→training age) is a *staleness* issue, not corruption |

---

## 3. Round 27 items

Each item states: the defect it closes, the change, the acceptance criterion, and
the test that pins it. R27-1 … R27-6 change only off-path or off-by-default code.

### R27-1 — A liveness certificate for every candidate (closes #43/#44/#48/#50-class)

**Change.** After the folds are scored, `evaluateAB`/`evaluateABAsync` compare each
candidate's per-fold position series with the baseline's (same stream, same fold,
same test indices) and attach:

```
liveness: { status: 'live' | 'inert' | 'skipped' | 'not-applicable' | 'duplicate-of:<id>',
            identicalFolds, totalFolds, maxAbsDiff, firstDifferingFold }
```

The comparison is **pure post-processing of data already journaled** (`onEvent`
fold records carry `signals`; `evaluateAB` accumulates a `(variantId, stream, fold)
→ signals` map from the wrapper it already installs), so no locked module is
touched and no scored number moves.

**Gate behaviour.**

- `inert`/`skipped`/`not-applicable`/`duplicate-of` gets **one** explanatory reason
  (e.g. `inert: identical to the baseline on all 288 folds (mechanism never reaches
  the model path)`), instead of the fabricated hurdle list.
- It is **excluded from `trials`/K and from the family-wise search**, with
  `trialsRoster` and `trialsInactive` recorded beside `trials` so a reader can
  reconstruct the decision.
- **Duplicate detection** (new): if a candidate is byte-identical to an *earlier
  live candidate* (the `label-triple`-without-horizon case, §2.7), report
  `duplicate-of:<id>` and exclude it too. This generalises #43/#44 from
  "identical to the baseline" to "identical to anything already tested".

**The K restatement (the part the previous draft left implied).** Excluding a
candidate from K changes every DSR. The mechanism is concrete and already exists:
`analysis/walkforward.js#restateReportAtCost(report, costBps, { trials })`
re-pools a report from its retained `foldInputs` at a new `trials`, and
`poolFolds`/`deflatedSharpeRatio` are the only trials-dependent arithmetic. So
`finalizeAB`:

1. computes `liveness` and the active set (baseline + live, non-duplicate
   candidates);
2. `trialsActive = 1 + activeCandidates.length`;
3. for the baseline and every active candidate, replaces the report's
   `pooledMetrics` with the `restateReportAtCost(..., { trials: trialsActive })`
   result and sets `trials = trialsActive` (the report object is kept; only
   `pooledMetrics`/`trials` are swapped, so `model`, `audit`, `foldInputs`
   survive);
4. re-runs `promoteDecision` and `walkForwardSearch` over the active set;
5. records `pooledMetricsRoster`/`trialsRoster` beside the active values.

**Faithfulness invariant (a strong test, and already empirically supported):**
`restateReportAtCost(report, cost, { trials: report.trials }).pooledMetrics` must
deep-equal `report.pooledMetrics`. §1.3's offline reconstruction reproduced every
round-26 metric exactly, so this identity is expected to hold; if it does not, the
restatement is unsound and R27-1 must stop.

**Offline check that de-risks the K change (done this session, `RUN-ANALYSIS.md`
§10.10).** Restating the round-26 journal at K = 12 (excluding the three
structurally inert arms) moves:

| candidate | dsrAdjusted @K=15 | @K=12 | @K=8 | promotes? |
| --- | ---: | ---: | ---: | --- |
| `sig-accel` | 0.8343 | **0.8608** | 0.9036 | no (needs K ≲ 2) |
| `sig:momentum` | 0.7375 | **0.7736** | 0.8350 | no |
| `surprise` | 0.0344 | 0.0433 | 0.0658 | no |

So the K correction **cannot manufacture a promotion** for the near-misses; it is
a reading fix, not a verdict flip. That is exactly the property R27-1 must have,
and it is now measured rather than hoped.

**Acceptance.** A run in which 3 of 15 candidates are inert reports `trials: 12`,
`trialsRoster: 15`, `trialsInactive: 3`, lists the three, and the three carry exactly
one reason each; the active candidates' `dsr`/`dsrAdjusted` reflect K = 12;
`traialsRoster = trials + trialsInactive`.

**Tests** (`analyze.test.js`, extended): (a) an injected candidate identical to the
baseline is `inert`, contributes no keep-off reasons, is outside K, absent from the
search; (b) a candidate identical to an earlier *live* candidate is
`duplicate-of:<id>`; (c) a candidate differing on one fold is `live` with
`maxAbsDiff > 0`; (d) `trialsRoster = trials + trialsInactive`; (e) the equal-trials
restatement identity (above); (f) the shipped controller roster (small synthetic
stream) has **at least one** `live` mechanism candidate — the contract test that
stops this class recurring.

**Grounding.** Adebayo et al. 2018 (a mechanism that cannot change the output
cannot be tested by it) + the non-vacuity rule already shipped for the audit
(`BUGS.md` #22, `world.js`).

### R27-2 — Candidate taxonomy and roster honesty (closes #44)

**Change.** Each roster entry gains `appliesTo: 'controller' | 'broadcast' |
'agnostic'`. `multi-probe`/`query-mod` become `appliesTo: 'broadcast'` and are
`not-applicable` under `--model=controller`; `pca-hash` stays on the controller
roster and its note is corrected to name `_retrieveTopRelevantProtos`. Add a
`--list-variants` CLI flag that prints `id | label | kind | appliesTo | status
(applicable here?)` **before** a run, so the roster is auditable from the terminal.

**Acceptance.** `--variants=multiprobe` on the controller reports
`not-applicable` naming `broadcastMemory`; not in K, not in the search, no keep-off
reasons. The `pca-hash` note names `_retrieveTopRelevantProtos`. `--list-variants`
prints the taxonomy.

**Tests.** (a) `broadcastMemory` with `_multiProbeConfig` set returns a *different*
memory set than without it (with the RNG held fixed — if the returned set is
draw-dependent, compare on a fixed seed or compare `_getGlobalLSHCandidates`
directly); (b) `getSignal` positions are identical with the flag on/off across a
stream; (c) `_refreshLshHyperplanes` changes the positions — together they pin the
whole claim. Plus a "no recorded candidate lacks a taxonomy" contract.

### R27-3 — Sample weighting: make it real **where it is expressible**, and record why it is inert where it is not (closes #43; resolves TODO #5)

**The evidence changed the answer.** The previous draft chose "make sample
weighting live via a causal streaming window". §2.7 then killed that: the shipped
labeler produces **1-bar labels** (`heldBars ≡ 1`), so AFML ch.4 average
uniqueness is exactly 1 for every label (no two label spans overlap), and a
streaming ring cannot change that. A causal ring over 1-bar spans is *still* an
all-ones weight vector — it would be reported `inert` by R27-1, and TODO #5 would
remain unanswerable.

**Decision (R27-3, revised).**

- **Close TODO #5 as `not-applicable` for the stock (`optimistic`) labeler**, with
  the measured reason: labels do not overlap, so there is no uniqueness to weight.
  Keep `spanWeightsFromEntries`/`sampleWeights` (they are correct, tested
  primitives) but **remove `sample-weights` from the controller default roster** —
  it cannot express an effect there. It stays **resolvable** (move it to an opt-in
  list like `LABEL_VARIANTS`) so an explicit `--variants=sample-weights` still works
  and Step 1 can demonstrate the `inert` report on real candles.
- **Make it expressible only where overlap exists**: after R27-4b makes the
  `triple` vertical barrier reachable, a label that expires at `H > 1` bars spans
  `H` bars and overlaps its `H−1` neighbours. So implement the causal streaming
  ring **as a modifier of a long-horizon label policy**, not as a standalone
  controller flag:
  - `_sampleWeightConfig` gains `{ mode: 'causal-window', windowBars, horizonBars }`
    with `horizonBars` **explicit** (no derivation from `heldBars` — that was the
    previous draft's error, now impossible);
  - the ring holds the last `windowBars` observed entry bars; a new label's weight
    is `overlapUniqueness` of its span `[entry, entry + horizonBars − 1]` against
    the ring **including itself**, `clampWeights` → `mean1` over the ring, so the
    mean weight stays 1 and the effective learning rate is unchanged;
  - the run reports the model's `sampleWeights { count, min, max, mean, ess, n,
    effectiveFraction }`; an all-ones vector is therefore visible, and R27-1 reports
    it `inert` with a variant-specific reason (`variant.inertReason`: the one-bar
    `optimistic` labels do not overlap), not the generic "never reaches the model
    path";
  - the `null`-config path stays **bit-identical** (golden fingerprints untouched).
- **Attribution is by run baseline, not by candidate.** The gate compares each
  candidate to the run's baseline, so "the weighting helped *given* triple" must be
  measured against a **`triple` baseline**: a run with
  `--label-policy=triple --label-horizon=H` and only `sample-weights` as the
  candidate. The optimistic run separately tests the label policies. (§6.)

**Acceptance.** On a synthetic stream of overlapping labels the weights are in
`(0, 2)` with `mean ≈ 1` and `ess < n`; a single isolated label weights exactly 1;
`null` config is bit-identical; on the shipped `optimistic` stream the mechanism is
reported `inert` (and the reason cites non-overlap) — a true statement. On the
`triple` baseline it is `live` with a non-trivial ESS.

**Tests.** Exact reference vectors for the causal estimator (overlapping, disjoint,
nested spans, a span older than the window, an evicted span); `mean1` keeps the mean
at 1; off-state bit-identity; the R27-1 `inert` contract on `optimistic`.

**Grounding.** López de Prado 2018 ch. 4 (average uniqueness over a label set);
AFML ch. 3 for the triple barrier that makes the spans overlap. The design note
records that the *causal window* is a streaming adaptation, not the batch formula
verbatim.

### R27-4 — Make the controller's input path unable to corrupt a reading (closes #46, #48b)

- `HiveMind.predict`: invalid input returns **`NaN`** (not `0`), so the controller
  takes its documented `−1` abstention route.
- `HiveMind.train`: invalid input returns the current `_trainingStepCount` and
  increments a `rejectedTrainRows` counter (never bare `undefined`), so
  `trainingSteps` is monotone non-decreasing by construction.
- The controller's predict guard is restated explicitly: `prob` is used only when
  finite **and** `>= 0`; otherwise the bar abstains.
- `global_stats.value` is declared `NUMERIC` (or the Brier sum stored in integer
  micro-units) so the schema and the data agree.

**Acceptance.** A fold driven with a poisoned feature vector produces **no**
position of magnitude 1 from a poisoned bar; `trainingSteps` is monotone and finite
after every call; no non-finite ever reaches `global_stats`; the golden suite is
unchanged.

**Tests.** poison one input → non-finite predict → abstain; a bad training row
leaves `trainingSteps` unchanged and increments the rejection counter; a 100-call
stream asserts monotone/finite; `resolved.total = takeProfit + stopLoss` and
`heldBars.count = closes` over a real fold.

### R27-4b — Make the holding period and the vertical barrier reachable (closes #49; the enabling fix)

- `getSignal` passes the cached window (`fullCandles`, already computed) into
  `_updateOpenTrades` alongside `recentCandles`.
- `barsAfterEntry` is computed from the **window** (bars strictly after the entry
  timestamp), not from the new-bar list; capped at `cacheSize − 1` (recorded).
- The horizontal-barrier *fill* loop is unchanged (still over the new bars), so
  optimistic/conservative positions and every golden fingerprint are untouched.
- The `triple` vertical barrier (`barsAfterEntry >= horizonBars`) now fires for
  `horizonBars > 1`.
- `heldBars` is now the true holding length (within the cache); `resolvedTimeBarrier`
  can be non-zero.

**Acceptance.** On a synthetic stream: optimistic and conservative position series
are byte-identical before/after the change; `heldBars.max > 1` when trades are held;
a `triple` fold at `H = 5` reports `resolvedTimeBarrier > 0`; the golden suite is
unchanged.

**Tests.** `core.test.js` (the entry-timestamp-guard section) gains the
before/after byte-identity and the reachable-vertical-barrier cases; a
`controller_invariants` case asserts `heldBars ≤ cacheSize − 1` and `≥ 1`.

**Risk/rollback.** If the fix cannot preserve the optimistic positions bit-exactly,
revert to diagnostic-only (report the defect, do not fix) and drop `label-triple`
from the runs; `label-conservative` remains testable.

### R27-5 — Diagnostic and report honesty (closes #47, #45, #48b, #66, #67, + hygiene)

- `undertrainedFolds` (always 0) is replaced by:
  - `shallowHistoryFolds` — the `testStart < warmup` count, under its true name,
    with `warmup`/`trainSize`/`minTestStart` printed beside it so a reader sees why
    it is 0; and
  - `underTrainedFolds` — folds with `0 < trainingSteps < minTrainingSteps`, where
    `minTrainingSteps` is an explicit run-level floor (default 1). It is distinct
    from `notTrainedFolds` (`trainingSteps == 0`), can fire, and names its floor.
  Plus a `trainingStepsDistribution { min, median, max }` distribution so the floor can be set
  from evidence rather than guessed.
- `decision.training.model` gets an explicit `referent`: it reports the
  **baseline's** model diagnostics when the featured row is a signal, with the
  reason reworded ("the featured row is a pure signal; the referent is the baseline
  controller, which trained on N rows"), and `labelDistribution` follows the same
  referent. Pinned by a signal-wins fixture.
- `nextRun.pairedUnits.required.observed` → `neededForObserved` (it is a
  requirement — 37 clusters — not an observation; the run has 36).
- `partial-report.json` carries the config echo (gate/gateOptions/trials/saveInterval/
  labelPolicy/labelHorizonBars/concurrency/intervalBars/commonRandomNumbers/
  streamSelection/turnoverSweep/policyRoundTrip) in the first checkpoint;
  `run.log` variant checkpoints carry `kind` and `elapsedMs`.
- The forecast/MCS block groups by `kind` (or maps a signal's score through the
  unified position policy before scoring) and states which it did; recorded in
  `METHOD.md`.
- **Journal/report hygiene:** `streamLabel` is normalised to the symbol name (the
  round-26 journal embeds absolute local paths); a `--symbols=all` run's labels
  should read `BTCUSDT`, not `/home/<operator>/…`.
- **`heldBars` is labelled as cache-bounded** (from R27-4b) and reports its cap.

**Tests.** Signal-wins referent fixture; a kill-and-recover test reading
`partial-report.json`; a rename test for `neededForObserved`; a group-by-kind
assertion; a streamLabel-normalisation test; an `underTrainedFolds` test that
*can* fire.

### R27-6 — Determinism and invariant locks (the "sanity" layer)

Add `test/node/controller_invariants.test.js` **and** its browser entry
`test/browser/entries/controller_invariants.test.js` (a node mirror with no browser
entry is rejected by `mirrors.test.js`, which pins 31 browser entries / 43 node
mirrors in `RUNBOOK.md` §6). The ledger, `lock-registry.js#KNOWN_TESTS`, the
`LOCKED-invariant` registry entry and the total check count (now **2347**)
are updated **deliberately and recorded**. Assertions, over a real synthetic fold:

1. **determinism**: two runs of the same fold under the same seed produce identical
   positions *and* identical `Math.random()` draw counts (pins §2.2b);
2. **open-book invariants**: `heldBars ≥ 1` and `≤ cacheSize − 1`, `resolved.total =
   takeProfit + stopLoss`, `heldBars.count = closed trades`, `trainingSteps`
   monotone, `brierSum` finite, `openTradeWriteErrors = 0` on a clean stream;
3. **timestamp invariant**: the shipped candle files are strictly increasing,
   24-char ISO, no duplicates (locks the `ORDER BY timestamp` assumption);
4. **liveness contract** (R27-1) and **off-state bit-identity** for every new config
   (`_sampleWeightConfig = null`, liveness off);
5. **audit non-vacuity**: a stubbed view that cannot differ yields `vacuous`, never
   `clean` (#22's rule, re-asserted after the candidate-level change).

### R27-7 — The runs (see §6)

**R27-7a — the liveness validation run** (minutes, 2 streams). Proves R27-1/R27-2/
R27-4b on real candles and that `sample-weights` is `inert` on the stock labeler.

**R27-7b — the label-policy run** (optimistic baseline; `label-conservative`,
`label-triple`). Tests the two label policies against the stock labeler, now that
the vertical barrier is reachable.

**R27-7c — the weighting run** (`--label-policy=triple --label-horizon=H`; baseline
+ `sample-weights`). Tests sample-uniqueness *conditional on* overlapping labels —
the only setting where it is expressible. Two model variants.

**R27-7d (optional) — the near-miss seed replication.** `--seeds=1,2,3` on
`sig-momentum,sig-accel` (a signal is ~0.06 s; cost = 3 baselines). A seed
*distribution* for the near-misses. Does not feed the gate. **Id corrected
(§2.8).**

### R27-8 — Design note: buy independence, not bars (no code)

`METHOD.md`/`RUN-ANALYSIS.md`: the next *power* purchase is cluster/stream
independence; `power.seDependent`/`pairedUnits.neededForObserved` are the sizing
inputs. Name the three levers and their trade-offs — more streams (the basket is
Binance-only, so a genuinely independent stream needs a new source), more
fold-window clusters (smaller `testSize`), a second interval (highly correlated
with its parent) — and state explicitly that **more bars of the same
2.3-effective-stream basket is the worst-value lever**, and that any "costs kill
the signals" claim must name its window.

### R27-9 — Bake the flags in (so the operator runs commands, not decisions)

| knob | today | round 27 | why |
| --- | --- | --- | --- |
| `runAnalysis.requireReachable` | `false` (`--reachable` opts in) | **`true`** (`--reachable=0` opts out) | a structurally reachable but behaviourally unreachable audit must never certify a promotion; the corrected run measured 229/288 baseline reachability |
| CLI `--audit-probes` default | `2` | **`1`** | 288 probes over 288 folds is ample; the audit is the dominant per-fold cost (the round-26 run already passed `1` explicitly) |
| candidate `liveness` block, inert/duplicate exclusion from K/search, taxonomy, mechanism counters | absent | **always on** | reading honesty must not be opt-in |
| `sampleWeights` roster entry | `configure: null` | **removed from the controller default roster** (resolvable/opt-in; R27-3) | it cannot express an effect on the stock labeler |

`--label-policies` stays opt-in (a label change is a training-set change) and the
runs name it explicitly; `--keep-models` stays off.

---

## 3.5 Decisions (resolved — this section replaces the previous draft's "open decision points")

The operator wrote:

> "You do not need my call, you have full access to research, as long as your plans
> are beneficial to the project and you have high confidence it's the best thing to
> do or you need it for information, then add it to your plan. You may add to notes
> that the operator's understanding of the codebase is limited, so you have full
> control of what gets implemented and what not, and what is next in the plan, as
> long as it's backed by research and in the evidence from runs so far."

**Recorded:** the operator's understanding of the codebase is limited; the agent
holds technical authority over the implementation roster and the next steps,
exercised only where backed by research and run evidence. The decisions below are
therefore *made*, not offered:

| # | decision | evidence | consequence |
| --- | --- | --- | --- |
| D1 | **Sample weighting is re-scoped, not made live on the stock labeler.** It is inert because labels do not overlap (`heldBars ≡ 1`). Its roster entry is removed; TODO #5 is closed `not-applicable` for `optimistic`; the causal-window mechanism is implemented as a modifier of the (now reachable) `triple` label. | §2.1, §2.7; measured `heldBars {count=sum=185937, max=1}` | the previous draft's "make it live" is withdrawn — it was based on the assumption that labels overlap, which the journal falsifies |
| D2 | **Fix #49 (R27-4b) — the holding-period/vertical-barrier defect — in this round.** Without it, `triple` cannot be tested and D1 is moot. | §2.7 | the label-policy run gains a real second policy |
| D3 | **`requireReachable: true` by default.** | 229/288 baseline reachability on the corrected run; R27-9 | an unreachable audit becomes a hard failure rather than a reported flag — intended |
| D4 | **`--audit-probes` default 1.** | R27-9 | halves the audit cost; `--audit-probes=2` still available |
| D5 | **Run order: liveness validation → label policy → weighting (conditional on D2) → optional seed replication.** | the experiments are cheap compared to a power run and are *new information*; the power run is blocked by D2's outcome and by R27-8 | the round is sequenced by dependency, not by preference |
| D6 | **K exclusion is required, and is safe.** | R27-1's offline restatement (`RUN-ANALYSIS.md` §10.10): K 15→12 moves `sig-accel` 0.8343→0.8608 and `sig:momentum` 0.7375→0.7736 — neither promotes | the correction fixes a reading, it cannot manufacture a verdict |
| D7 | **Do not drop the near-miss signals.** They remain untested by round-27's candidate rosters (which test label/weight), and are the subject of the optional seed replication only. | round-26 is the only evidence about them | no new claim about the near-misses is made this round without the replication run |

---

## 3.6 Sequencing and dependency graph

```
R27-4  (fail-closed inputs)  ─┐
R27-4b (#49 holding/barrier) ─┼─► R27-3 (weighting modifier needs reachable triple)
R27-1  (liveness + K)        ─┼─► R27-2 (taxonomy feeds liveness statuses)
R27-5  (report honesty)      ─┘
                                   │
                                   ▼
              R27-6 (tests)  ──►  §6 runs   ──►  R27-8 (design note from the results)
```

R27-1/R27-2/R27-4/R27-4b/R27-5 are independent; R27-3 depends on R27-4b. No run
starts until `npm test` is green.

---

## 3.7 Risk and rollback, per item

| item | risk | mitigation / rollback |
| --- | --- | --- |
| R27-1 K restatement | the restated DSR is unfaithful, or a promotion appears only because K shrank | the equal-trials restatement identity test; `trialsRoster`/`trialsInactive` recorded; the offline check shows no near-miss flips; if the identity fails, do not restate (report liveness only) |
| R27-1 liveness memory | holding every fold's signals for 15 variants × 4,320 folds is large | accumulate per-candidate streaming comparison (compare each candidate against the baseline as it finishes) rather than storing all series; the baseline's series is the only one that must be retained |
| R27-2 test (a) | `broadcastMemory` output may be RNG-dependent, making the on/off comparison flaky | fix the seed and compare on identical state; if it remains draw-dependent, compare `_getGlobalLSHCandidates` directly |
| R27-3 | the causal-window estimator is a new design; a sign/off-by-one error silently changes training | exact reference vectors (isolated/overlapping/nested/evicted spans); `null`-config bit-identity; `mean1` mean test; weights are reported so an error is visible |
| R27-4b | the fix could move the optimistic position series | before/after byte-identity test on the shipped candles; if it moves, revert to diagnostic-only |
| R27-5 | report reshapes break readers/tests | the new fields are additive; renames are pinned by tests; `report.json` schema stays `nl.analyze.v1` with additive keys |
| R27-7 runs | `--concurrency=4` is proven byte-identical only at test scale, unproven at 7.9 h | keep `--concurrency=1` as the fallback; a run that trips a worker error is isolated per fold (P0-1) |

---

## 3.8 What each run can and cannot prove

| run | can prove | cannot prove |
| --- | --- | --- |
| Step 0.5 (offline K restatement) | the exact K-sensitivity of the round-26 verdict from the existing journal | anything about a *new* candidate |
| R27-7a (liveness validation) | the fixed roster reports each status correctly; `sample-weights` is inert on `optimistic` | anything at power |
| R27-7b (label policy) | whether `conservative`/`triple` change the base rate, skill and pooled metrics vs `optimistic` | whether sample weighting helps (it is a different run) |
| R27-7c (weighting under triple) | whether causal-window uniqueness weighting changes the pooled metrics *given* overlapping labels | whether the effect transfers to the stock labeler (it cannot — there is no overlap there) |
| R27-7d (seed replication) | a seed distribution for the near-misses | a gate decision (it is diagnostic) |

**What would falsify R27-3:** if, under `triple` with `horizonBars = H`, the
reported `ess / n` is ≈ 1 (all weights ≈ 1), then even a long-horizon label does not
overlap in the drained stream, and sample weighting is not applicable to this
architecture at all — close TODO #5 permanently. That is a clean falsification and
the run is designed to produce it.

---

## 4. The controller double-check, answered directly

The operator asked: *"Double check controller logic, just to be 100% sure a faulty
or brittle controller does not mess up or corrupt any readings."*

- **Does a faulty controller corrupt a reading today?** The three reading defects
  (#43/#44/#45) are roster/report wiring; #46's input-path traps do not fire on
  validated input; and #49 corrupts a *diagnostic* (`heldBars`) and an *off-by-
  default feature* (`triple`), not the stock position series. The run's arithmetic
  is reproducible end-to-end (§1.3: every pooled metric reproduced from the journal).
- **Is the controller brittle in a way that could corrupt a reading later?** Yes, in
  the two places R27-4 makes fail-closed, in #49 (now fixed), and in one place that
  remains *documented rather than fixed*: `_retrieveTopRelevantProtos` consumes
  `Math.random()` a bucket-content-dependent number of times, so a hash change moves
  the whole trajectory by an amount that is not a clean measure of the hash change.
  Deterministic under `withSeed` (pinned by R27-6.1), but it means `pca-hash`'s
  effect is "the run differs", not "the mechanism helps".
- **Is anything un-audited?** Two known, tracked gaps: the entry→training age
  (TODO #62) and the base rate/skill being quoted over a superset of the trained
  rows (dedup). Neither is a corruption; both are labelling statements that should
  say what sample they use.

---

## 5. Dedicated bug + sanity checks (ranked by the damage a silent failure does)

1. **A candidate that never ran is reported as tested** → R27-1 (inert + duplicate +
   K exclusion + the "at least one live mechanism" contract test).
2. **A mechanism on a path the fold never reaches** → R27-2 (taxonomy + the
   three-part transfer/retrieval test).
3. **A feature that cannot fire at all** (`triple`'s vertical barrier; `heldBars`;
   `undertrainedFolds`) → R27-4b, R27-5.
4. **An experiment that cannot express its effect** (weights always 1 because
   labels do not overlap) → R27-3 (re-scoped, with the falsification test).
5. **A degraded input mapped to a legal extreme** → R27-4.
6. **Nondeterminism through the retrieval path** → R27-6.1.
7. **A schema that lies about a type** (`global_stats.value`) → R27-4.

---

## 6. The runs (exact commands; the operator runs exactly these)

Assumes R27-1 … R27-6 have landed and `npm test` is green (the existing 127/127
native blocks plus the new ones; the golden fingerprints unchanged).

**Step 0 — the gate (must be green before any run).**

```
npm test
```

**Step 0.5 — the offline K-sensitivity restatement (minutes, optional but
recommended).** Pure post-processing of the existing round-26 journal: reconstruct
each variant's pooled net returns from `folds.jsonl`
(`strategyReturns({ returns, signals, costBps: 0 })` per fold, concatenated), then
`deflatedSharpeRatio` at K = 15, 12, 8. Expected (already measured):
`sig-accel` 0.8343 → 0.8608 → 0.9036, `sig:momentum` 0.7375 → 0.7736 → 0.8350; no
promotion at any K ≥ 8. This is the de-risking check for R27-1's K exclusion and
requires no model.

**Step 1 — the liveness validation run (minutes; 2 streams).**

```
npm run analyze -- --symbols=BTCUSDT,ETHUSDT --bars=200 --train=60 --test=15 \
  --audit-probes=1 --reuse-base \
  --variants=sample-weights,multiprobe,querymod,pca-hash,surprise,homeostasis
```

Expected readout: `sample-weights` **inert** (reason names the non-overlap);
`multi-probe`/`query-mod` **not-applicable** (naming `broadcastMemory`), outside K,
one reason each; `pca-hash`/`surprise`/`homeostasis` **live** (`maxAbsDiff > 0`);
`trialsRoster = trials + trialsInactive`.

**Step 2 — the label-policy run (optimistic baseline).** ~3 model variants
(baseline + 2) ≈ 2 h at `--concurrency=1`, or ≈ 40–70 min at `--concurrency=4`.

```
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --seed=1 \
  --audit-probes=1 --reuse-base --concurrency=4 \
  --variants=label-conservative,label-triple \
  --label-horizon=20 --cost-ladder=0,2,5,10
```

Expected readout: a liveness table; `label-triple` now **live** (vertical barrier
reachable, `resolvedTimeBarrier > 0`); the `resolved`/`heldBars` split for each
policy (does `triple` change the base rate and the skill?); the cost ladder and the
dependence-adjusted DSR for each. If `label-triple` is *duplicate-of:
label-conservative*, R27-4b did not land or the horizon was not applied — the run
says so.

**Step 3 — the weighting run (triple baseline).** ~2 model variants ≈ 1.4 h at
`--concurrency=1`.

```
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --seed=1 \
  --audit-probes=1 --reuse-base --concurrency=4 \
  --label-policy=triple --label-horizon=20 \
  --variants=sample-weights --cost-ladder=0,2,5,10
```

Expected readout: `sample-weights` live with `model.sampleWeights.ess < model.sampleWeights.n`
(the mechanism moved); whether the weighted objective changes PSR/DSR/fold-win vs
the **triple** baseline. This is the only setting in which TODO #5's question is
answerable. If `ess ≈ n`, close TODO #5 permanently (§3.8).

**Step 4 (optional) — the near-miss seed replication (~3.3 h; id corrected).**

```
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 \
  --audit-probes=1 --reuse-base --concurrency=4 \
  --variants=sig-momentum,sig-accel --seeds=1,2,3
```

Expected: `replication.json` with the IQM, stratified-bootstrap CI and seed/fold
variance split. A near-miss whose IQM stays above the pooled baseline and whose seed
stratum variance is small is worth a *power* run; one that vanishes across seeds is
a single-seed artefact. Neither outcome changes the gate.

**What the round does NOT run, and why.** No more bars of the same basket (R27-8);
no re-run of `multi-probe`/`query-mod` on the controller (R27-2 proves they cannot
act there); no new fetch; no golden re-freeze; **no `label-triple` without
`--label-horizon`** (it would be a duplicate candidate, §2.7).

---

## 7. Files to change (implementation map)

| file | change |
| --- | --- |
| `src/analyze.js` | roster metadata (`appliesTo`, `kind`, remove `sample-weights` from the controller default), liveness accumulation + certificate + duplicate detection, K restatement via `restateReportAtCost`, `--list-variants`, `neededForObserved`, partial config echo, decision referent, `requireReachable`/`auditProbes` defaults, `sampleWeights`, `shallowHistoryFolds`/`underTrainedFolds`, `minTrainingSteps`, streamLabel normalisation |
| `src/hivemind/hiveMind.js` | `predict` invalid → `NaN`; `train` invalid → current count + `rejectedTrainRows` |
| `src/hivemind/hiveMindController.js` | `_sampleWeightConfig` doc/type; `_sampleWeightRing`; predict guard restated; `_sampleWeightStats`; pass `fullCandles` to `_updateOpenTrades` |
| `src/hivemind/controller/trades.js` | true `barsAfterEntry` from the cached window (#49); causal streaming uniqueness ring (off by default); `trainingSteps` assignment guarded |
| `src/hivemind/controller/database.js` | `global_stats.value` type |
| `src/hivemind/training/sample_weights.js` | a pure causal-window helper beside `spanWeightsFromEntries` (no behaviour change to existing exports) |
| `src/analysis/decision.js` | referent + `neededForObserved` |
| `src/analysis/forecast.js` | group by `kind` (or map by policy); recorded in `METHOD.md` |
| `src/hivemind/memory/lsh.js`, `memory/retrieval.js` | doc only (which reader is live) |
| `test/browser/entries/controller_invariants.test.js` + `test/node/controller_invariants.test.js` | new pair (R27-6) + ledger/registry updates |
| `test/node/analyze.test.js`, `analysis.test.js`, `sample_weights.test.js`, `core.test.js` (+ their browser entries) | the tests in R27-1 … R27-6 |
| `test/lock-registry.js`, `docs/RUNBOOK.md` §6 | the ledger bump (30→31 entries, 42→43 mirrors, 2289 → new total) |
| `docs/BUGS.md`, `ROADMAP.md`, `TODO.md`, `METHOD.md`, `RUNBOOK.md`, `RUN-ANALYSIS.md`, `CITATIONS.md` | the record |

## 8. Round 27 acceptance criteria (the definition of done)

1. `npm test` green; golden fingerprints unchanged; the browser suite green with the
   new count recorded (no silent drift).
2. Every candidate carries a `liveness` status; `inert`/`skipped`/`not-applicable`/
   `duplicate-of` candidates are outside K and the search and carry exactly one
   reason; `trialsRoster = trials + trialsInactive`; the equal-trials restatement
   identity holds.
3. `sample-weights` is `inert` on the `optimistic` roster with a reason naming
   non-overlap; its `null`-config path is bit-identical to today; on the `triple`
   baseline it is `live` with a reported ESS.
4. R27-4b: optimistic/conservative positions byte-identical before/after;
   `heldBars` varies; `triple` at `H = 20` reports `resolvedTimeBarrier > 0`.
5. A poisoned prediction abstains; `trainingSteps` is monotone and finite; no
   non-finite reaches `global_stats`.
6. The decision block names its model referent; no always-zero diagnostic remains;
   `streamLabel` is normalised.
7. Step 1's liveness readout matches §6; Steps 2–3 run and their reports are
   recorded; `RUN-ANALYSIS.md` gains the Step-0.5/Step-2/Step-3 forensics;
   `BUGS.md` #43/#44/#45/#46/#47/#48/#49 are marked fixed or explicitly
   closed-as-designed with a reason.

## 9. Findings this revision added or corrected

| id | finding | where |
| --- | --- | --- |
| #49 | `heldBars` ≡ 1 and the `triple` vertical barrier is unreachable (`barsAfterEntry` counts only the new-bar list) | §2.7 |
| #50 | the previous draft's Step-3 command used the non-existent id `sig-acceleration` (`resolveVariant` throws) | §2.8 |
| corr. | round 26 ran `reuseBase: true`, `auditProbesPerFold: 1`, `concurrency: 1` (not 2 probes) | §1.1 |
| corr. | the journal embeds the operator's absolute filesystem paths in `streamLabel` | §2.8, R27-5 |
| evid. | the round-26 journal is an exact offline witness; the K-sensitivity of the near-misses is measured (no promotion at K ≥ 8) | §1.3, §2.8/K |
| dec. | sample weighting re-scoped to the `triple` label (it is inert on `optimistic`) | R27-3, D1 |
