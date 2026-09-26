# NeuLegion — Bug log

Status as of this revision. Everything in **Fixed** was verified with the
browser test suite (`test/browser/entries/`) or with the A/B golden harness
described in `OPTIMIZATION.md`; see `../test/browser/entries/sanity.test.js`
for the regression checks that now guard the first two entries.

The codebase is largely hand-rolled numerical code, so most of the defects
below are silent-wrong-answer bugs rather than crashes. **The seven entries under
`## Found by the attempt-3 power run` (#26-#32) are all fixed in round 25** —
#26/#27 were report-honesty defects found by forensics, #28/#29 were arithmetic and
gate-logic defects found by the round-25 tests, #30 was a silent-output wiring
defect found in the post-implementation review, and #31/#32 were a JSON-provenance
defect and a structurally wrong cost model, both found by auditing the
`20260921T062511-seed1` signal-family run. **#33, #34, #35, #36 and #37 are all
FIXED** — found by the
round-26 controller/A-B fidelity sweep (`## Found by the round-26 controller /
A-B fidelity sweep` below); **#38, #39, #40 and #41** were found by the round-26b
implementation review and are also FIXED (`## Found by the round-26b
implementation review` below), and **#42** was found by the first native `npm test`
after that review and is FIXED (`## Found by the native npm test after the
round-26b review` below). **#43/#44/#45** were found by the first full-size run made
*with* the round-26 corrections (`20260922T204248-seed1`; `RUN-ANALYSIS.md` §10) and
are now **FIXED in round 27** — report/roster wiring defects with no arithmetic impact
(`## Found by the 20260922T204248-seed1 round-26 power run` below). The **round-27
planning sweep** (`PLAN-round27.md`) re-derived #43/#44 from the code and both are
stronger than the first reading — #43 is a mathematical no-op in the *shipped*
pipeline (every drain is a single label, so the uniqueness weight is exactly 1), and
#44's flags *cannot* act on the controller path (their only reader feeds a discarded
result) — and added **#46** (a degraded prediction read as a full short; a rejected
training row corrupts `trainingSteps`), **#47** (`undertrainedFolds` can never fire)
and **#48** (`skipped` reported but not enforced; a stats schema type lie). A
second round-27 sweep (code + the round-26 journal, `PLAN-round27.md` §2) then added
**#49** (`heldBars` is structurally exactly 1, so the `triple` label policy's
vertical barrier can never fire) — the finding that re-scoped the sample-weighting
item. **All seven (#43–#49) are now FIXED by the round-27 implementation** (the
status paragraph at the end of the `## Found by the 20260922T204248-seed1 round-26
power run` section below names the fix and the test that pins each); only #44's
`pca-hash` sub-claim was subsequently qualified by the round-27 runs (#53). (The
plan's own run-command typo, `sig-acceleration` for the real id `sig-accel`, is
recorded in `PLAN-round27.md` §2.8 as a plan-internal correction, not a code bug.) The
native `npm test` after the round-27 implementation then exposed **#52** (a
recurrence of #15.3 — a node mirror whose static import graph reached a
browser-only CDN module, so it died during linking before any check ran) —
**FIXED** at the source and structurally, with a new guard in
`mirrors.test.js`. The four **round-27 runs** (R27-7a–d; `RUN-ANALYSIS.md` §13) then
exercised the reading layer in production and exposed three more reading defects, all
**FIXED in round 28** (`## Found by the round-27 runs` below names the fix and the test
that pins each): **#53** (`pca-hash`'s liveness
certificate is run-dependent, yet its generic inert reason claims the mechanism "never
reaches the model path" — falsified by the round-26 6/288-fold result), **#54** (the
causal-window sample weights are mean-1 over the *window*, not over the *trained
stream*, so Step 3 ran at ≈2.6× the effective learning rate — the Step-3 "weighting
hurts" verdict is confounded), and **#55** (the decision block's `labelPolicy` names
the run, not the referent; the `familyCorrelation` summary mislabels its max pair).
The **round-28 coherence re-read** (`RUN-ANALYSIS.md` §14, `PLAN-round28.md`) then
re-read all four round-27 reports against the code and the recorded decisions and added
three more, **FIXED in round 28** too: **#56** (`decision.nextRun`'s `cheapestFlip` compares a
*single-series* cluster SE to the *paired* difference, overstating the required
magnitude ×4.95 instead of ×1.06, and `pairedUnits.needed.mde95Dependent` mixes the two
scales), **#57** (the always-on `minFoldWinFraction = 0.5` raw-majority hurdle
contradicts the round-25/26 recorded decision in `DESIGN.md` §6.1 — the raw fraction is
supposed to be a reported statistic — and is decisive on `label-conservative` 0.2014 vs
the cluster sign test 0.50, and on `sig:momentum` 0.4931 vs 0.5278), and **#58** (the
`sample-weights` inert reason and `METHOD.md` §4's premise claim the `optimistic`
labeller emits one-bar labels, resting on the **#49** false diagnostic — the fixed
`heldBars` is mean 7.82 / max 72, so the labels overlap and the all-ones weights come
from the ring's span horizon being configured to 1). The **P2 retrieval-liveness
probe** (round 28, `lsh.test.js` §K) then added one more finding, **#59** — the scored
reader can return the same prototype several times (its fallback fillers guard with
`semCandidates.has` but never add to that Set) — recorded as **reported, not fixed**,
because it is on the scored default path and de-duplicating it would move every golden
fingerprint (see the entry below). The **three round-28 operator runs** (`RUN-ANALYSIS.md` §15) then
added three more, all **reported, not fixed** because each is a reading-layer or
comparison-fairness finding that wants its own decision/proof rather than a rushed edit:
**#60** (the always-on `meanSharpeDelta` hurdle is a *third* fold-level point comparison over the
same correlated folds — the class #57 addressed for the two raw fractions only; verdict-neutral on
all 21 candidate rows of the three runs), **#61** (the unified confidence space is dimensionally
shared but not *distributionally* comparable across families, so the shipped absolute `deadZone`
and every `--turnover-sweep` threshold are family-relative — measured: the controller's
`|confidence|` never exceeds 0.27 while a signal's saturates at 1, and at the sweep's promoting
policy the restated baseline holds a position on 16 of 4 320 bars), and **#62**
(`--label-horizon` silently sets the *sample-weight span* on a non-`triple` run — the #58
configuration confound reachable through a flag documented as the triple barrier's horizon — and
is otherwise a silent no-op). None of the three changes a verdict this round; nothing promoted.
And #33 in
particular changes the *reading* of every `npm run analyze` number ever
produced: the driver fed the controller the whole growing candle prefix where
production feeds it a fixed window, so the controller's trade bookkeeping saw
ancient candles and trained on mislabelled trades. Do not size or interpret a run
until #33 is fixed. If you change anything
under `src/`, run the full browser suite before and after
(**2585 checks**: `sanity` 60, `core` 46, `indicators` 75, `features` 11,
`consolidation` 48, `consolidation_worker` 18, `fetcher` 111,
`golden` 23 (bit-exactness), `modules` 51 (assembly), `legion` 57,
`candles` 192, `locks` 41, `analysis` 638, `price_precision` 29,
`multisymbol` 28, `lsh` 75 (the round-28 section K retrieval-liveness checks), `surprise` 32, `sample_weights` 57,
`homeostasis` 30, `evolve` 36, `multiprobe` 77, `binarypc` 39,
`bitweight` 69, `querymod` 51, `walkforward` 63,
`dimensions` 185, `guards` 65 (run integrity), `observer` 76 (legion health),
`controller_invariants` 23 (R27-4b controller contracts, plus the R28 measured-span /
emitted-stream checks in §D),
`analyze` 279 (the A/B driver, controller-backed after round 23; run-integrity sections O/P/Q after round 24, R after round 24b, L2/N dependence-aware after round 25, R26-0 window-contract, R26-12 checkpoint throttle, R26-2 model/label diagnostics, R26-11 label-policy variants, R26-4 concurrency, R26-5 turnover sweep, R26-6 stream selection, R26-13 seed replication/CRN, R26-14 forecast comparison (proper scores + DM + Model Confidence Set) and R26-8 decision-grade report after round 26, R27-1 liveness / R27-2 broadcast-liveness / R27-5 forecast-kind grouping / variant taxonomy after round 27, the round-28 weighting-configuration / measured-gate / inert-reason / active-pair checks, and the round-29 P1 benchmark runner / `--carry-files` / `extraPanelStreams` wiring, plus the round-4 P2 driver wiring and the round-5 fold-dispatch contract checks, and the round-30 pruned-roster / register-contract / #69 / #70 panel-taxonomy / momentum-upgrade checks)) — plus `golden` on
its own after any `hivemind/` edit, `multisymbol` after any change to the
controller's trade/target arithmetic, `lsh` after any change to the memory index,
`surprise` after any change to the memory write path, `sample_weights` after
any change to the training step, `homeostasis` after any change to the
adaptive learning-rate path, `multiprobe` after any change to the LSH
probe order, `querymod` after any change to the LSH query-modification path,
and `walkforward` after any change to the evaluation/promotion
harness. The
node mirrors under `test/node/` (run with `npm test`) ran **green** locally at
round 21 (89/89 blocks — see #18) and again at round 22 (**115/115 blocks across
39 files**, ~5.9 min — see #21). The round-22 run exposed exactly one real defect
in the new P0-P3 tooling (#20, a false-negative `preflight` gate); it is fixed and
the run is green. Re-run after any change to the hot path or the mirrors.

Method names below use the original `#private` spelling where they were fixed
before the component split; they now live as `_`-prefixed methods in the
modules listed in `../src/README.md` (the class shells and the component
modules are behaviourally identical — see `COMPONENTS.md`).

---

## Fixed

### 1. LSH index leaked dead prototype references
`#semanticProtos` is capacity-bounded, but the `#semanticLSHBuckets` adjacency
index was not kept in lockstep with it. Prototypes that were dropped from a
semantic bank (prune, capacity trim, merge, overflow drop, or a
normalisation/noise step that rewrote a mean) could remain in the bucket sets.
Consequences: unbounded memory growth on long runs, and every retrieval probing
buckets full of expired prototypes — some of which could even be surfaced as
live candidates.
Fix: every path that removes or mutates a prototype now unregisters it
(`#removeProtoFromLSH` / `#updateProtoInLSH`), and `#finalizeSemanticProto`
registers newly stored prototypes.
Regression guard: `sanity.test.js` case C asserts, after heavy churn, that every
indexed proto is live (`deadInBuckets === 0`), every live proto is indexed
(`missingFromBuckets === 0`), and each proto occupies exactly
`numLshSets * lshNumTables` bucket slots.

### 2. Capacity-overflow drop did not unregister prototypes
When a semantic bank exceeded `effectiveSemanticMax * tempOverloadFactor`, the
overflow tail was spliced out of the array but not removed from the LSH buckets
or the priority list. Fix: the trim loop calls `#removeProtoFromLSH` for every
dropped prototype (see `#updateSemanticProtos` and `#consolidateSemanticProtos`).

### 3. Attention entropy was computed over raw scores, not probabilities
`#computeMemoryScoreFromProtos` computed the "attention sharpness" term from
`attentionScores`, which are raw `Q·K/√headSize` values (negative, not summing
to 1). Entropy over those values was a function of the row's L1 norm and count
of positive entries, not of attention concentration.
Fix: entropy is now taken over the softmax of each row, in the numerically
stable log-sum-exp form `H = log(S) − Σ p·(z−m)`, matching
`#contextAwareAttention`. The softmax is never materialised.

### 4. `#computeProjNorms` carried a spurious `1/√lowDim` factor
Each low-dim projection was divided by `√lowDim` after being made unit-norm, so
`#projSimilarity` returned an average in `[-1/lowDim, 1/lowDim]` (roughly
`[-0.25, 0.25]` for `lowDim = 4`). Every cosine-calibrated threshold (the 0.35
retrieval filter, the ~0.7 merge threshold, diversity thresholds) was therefore
unreachable and semantic recall was silently disabled.
Fix: projections are unit-normalised only. LSH uses only the sign of the dot
product, and consolidation uses projection scores only for ranking, so both are
invariant to this positive rescaling; `#projSimilarity` is now a true average
cosine in `[-1, 1]`.

### 5. `#computeKernelRate` indexed outside its window
The median was taken at `Math.floor(history.length / 2)` but applied to a
`history.slice(-10)` window. Once `history.length > 19` the index fell out of
bounds, `|| 0` forced the median to 0, the normalised values blew up, and the
adaptive EMA betas were pinned at their maximum.
Fix: index the 10-element window (`#computeKernelRate`).

### 6. `#computeNTKStability` / `#computeKernelRate` short-slice indexing
Both consume `arr.slice(-10)` but originally derived their median index from the
full-history length, the same class of out-of-range defect as #5. Both now index
the slice they actually read.

### 7. Instrumentation trap: injected probe lost a method-closing brace
When timing/hash probes were injected between methods, an insertion anchored on
the first `    }` line could land on a nested block and drop a method's real
closing brace, silently corrupting the class. If you build instrumented copies
(e.g. `scratch/profcur*.js`), brace-balance the injected string and re-run
`syntaxErrors`/a smoke test before trusting timings.

---

### 8. Controller feature extraction silently zeroed TypedArray prototype vectors
`#robustNormalize` and `#computeProtoQuality` in `hiveMindController.js` guarded
their inputs with a bare `Array.isArray(...)`. Prototype means/variances are
`Float32Array` internally, and `broadcastMemory` happens to convert them with
`Array.from` before they reach the tier>1 feature path — so production happened
to work, but any future caller (or a dropped `Array.from`) would have made
`#robustNormalize` return an all-zero vector and `#computeProtoQuality` score
every prototype's mean/variance as 0, **silently** (no error, just wrong
features and therefore wrong predictions).
Fix: both now accept plain arrays **and** TypedArrays (`ArrayBuffer.isView`),
converting the latter with `Array.from` once. Plain-array behaviour is
bit-identical (this changes no production result, since the real call sites pass
plain arrays).
Regression guard: `features.test.js` asserts the tier>1 vector is not all-zero
and that a `Float32Array` memory produces exactly the same features as the
equivalent plain-array memory — a direct check caught this during the audit.

---

### 9. Sub-cent symbols inverted every trade direction (hardcoded 2-dp target grid)

The controller built its take-profit / stop-loss prices as
`truncateToDecimals(entryPrice ± distance, 2)` — a hardcoded 2-decimal grid. That
is safe while the stream is BTCUSDT (prices in the thousands), but the shipped
dataset now spans eight Binance 1h symbols and three of them trade below $1.
Truncating to 2 dp moves a target *across the entry price* when the grid is
coarser than the price itself:

- DOGEUSDT (min close `$0.001329`): every target truncated to `0`. A `'positive'`
  controller therefore emitted `sellPrice = stopLoss = 0`, and `_updateOpenTrades`
  reads `sellPrice > entryPrice` as `false`, so **all 25/25 signals were treated
  as shorts** whose stop (`high >= 0`) is hit on the very next bar. Every trade
  closed immediately as a loss and the model trained on pure noise.
- ADAUSDT (min close `$0.02009`, entry `$0.02552`): `sellPrice = stopLoss = 0.02`,
  so **23/25** signals inverted the same way.
- XRPUSDT (min close `$0.11942`): **8/25** inverted (the 0.01 grid is coarser than
  the 0.25% minimum movement).

Fix: `src/price_precision.js#priceDecimals` derives the grid from the price
magnitude and the configured minimum relative movement, keeping it at least 10×
finer than `price * minPriceMovement` (clamped to `[2, 8]` dp). Prices ≥ $40 keep
the historical 2 dp, so the controller's golden trajectory is **byte-for-byte
unchanged** (`golden.test.js` fingerprints identical) while sub-dollar symbols
now get 5–7 dp. Grounding: exchange prices are quoted on a tick grid
(`PRICE_FILTER.tickSize`), so the target precision is an instrument property, not
a constant.

Regression guards: `price_precision.test.js` (29 checks — exact vectors, clamps,
invalid input, monotonicity, and the direction-preservation property) and
`multisymbol.test.js` (28 checks — replays all eight symbols at each one's
lowest-price window and asserts zero direction inversions for both polarities).
The module is registered `LOCKED-invariant` in `test/lock-registry.js`
(status `SUPPORT_REGISTRY`).

### 10. Stationary bootstrap never re-drew its block start (p-values were anti-conservative)
`analysis/performance.js#stationaryBootstrapSharpe` is the bypass-the-Normality-
assumption significance test: it resamples the return series in geometric blocks
("stationary bootstrap", Politis & Romano, JASA 1994) and reports the fraction of
resamples whose Sharpe is no better than the benchmark. The block start index was
drawn **once** before the loop and thereafter only ever advanced
(`if (t > 0 && rnd() >= p) i = (i + 1) % n;`) — it was never re-drawn. So every
resample was a single contiguous rotation of the series (with random repeats
where the walk stalled), not a sequence of independent blocks. Because a rotation
preserves the sample Sharpe almost exactly, the bootstrap null distribution was
far too narrow, which makes the p-value anti-conservative.

Measured on 120 independent pure-noise series (iid zero-mean, n=500, 400
samples): the 5% test rejected **21/120 = 17.5%** of series (expected ~6). The
null p-values were still centered near 0.5 (mean 0.496), so the defect was purely
one of spread — exactly the failure mode the calibration check is designed to
catch. It was invisible to the old section-G checks, which only asserted
range/determinism/finiteness.

Fix: a new block begins with a freshly drawn uniform start with probability
`p = 1/blockLength`, otherwise the block continues at the next index (Politis &
Romano 1994, Algorithm 1). The lower-tail p-value semantics are unchanged.
After the fix the measured false-positive rate is **7/120 = 5.8%**, mean p 0.502,
and the test retains full power (p = 0 on a strong edge; p is monotone
non-increasing in drift). Grounding: Politis & Romano, *The Stationary
Bootstrap*, JASA 1994.

Regression guards: `analysis.test.js` section G2 (4 checks — null calibration
≤ 10% at the 5% level, null p-values centered at 0.5, power on a strong edge,
monotonicity in drift).

### 11. `purgedCVBacktest` pooled metrics described an all-long overlay, not the strategy
`analysis/backtest.js#purgedCVBacktest` pools the per-fold net returns and then
scores that pooled series with `backtestMetrics({ signals: pooled.map(() => 1) })`.
That is correct for the metrics that read the return series (Sharpe, PSR, DSR,
drawdown, hit rate, final equity) but wrong for the position-based ones: the
synthetic all-long overlay has one entry and one trade, so the pooled report
claimed `turnover === 1` and `tradeCount === 1` regardless of how many trades the
strategy actually made, `totalCost === 0` (costs were charged per fold but the
overlay re-charged none), and `grossSharpe === netSharpe` even when costs were
nonzero — the overlay scored net returns as gross.

This surfaced while building the walk-forward harness, whose `formatReport`
prints the pooled turnover/cost from `purgedCVBacktest`; a strategy with dozens of
round-trips reported `turnover=1`.

Fix: after the base pooled report, override those four fields with the strategy's
real aggregates — `turnover` / `tradeCount` / `totalCost` as the sums over the
folds, and `grossSharpe` from the concatenated per-fold **gross** returns. The
series-reading metrics are unchanged, so `promoteDecision` (which uses pooled
Sharpe/DSR) is unaffected.

Regression guards: `analysis.test.js` section Q (3 checks — pooled turnover and
cost equal the per-fold sums, and gross Sharpe exceeds net Sharpe under costs).

### 12. `walkForwardSplit` hung forever on a non-positive `step`

`analysis/splits.js#walkForwardSplit` advanced the fold cursor with
`trainEnd += stride`, where `stride = step != null ? step : testSize`. The only
validation was on `n` / `trainSize` / `testSize` being positive; `step` was used
verbatim. A caller computing the step from data (e.g. a fraction of a fold size
that rounds to 0), or simply passing `0`/a negative/`NaN`/`Infinity`, made
`trainEnd` never advance (or jump to `NaN`), and
`while (trainEnd + testSize <= n)` **never terminated** — a synchronous infinite
loop that freezes the thread, not a thrown error. This is the worst class of
defect for a library: a legal-looking argument takes the process down.

Fix: reject `step` unless it is a positive finite number (`step <= 0`,
`NaN`, `Infinity` all throw with a clear message). A positive step behaves
exactly as before, so no existing fold geometry changes.

Regression guard: `analysis.test.js` section S — `{0, -1, NaN, Infinity}` all
throw, and `step: 2` still yields the exact fold count.

### 13. Combinatorial splitters could attempt an astronomical enumeration

`combinatorialPurgedSplit({n, k, testGroups})` materialises `C(k, testGroups)`
fold objects, and `overfitting.js#cscvSplit` materialises `C(S, S/2)` split
objects — but neither bounded that count. `C(40, 20) ≈ 1.4e11` and
`C(60, 30) ≈ 1.2e17`: a plausible-looking `blocks`/`k` (the argument is only
required to be even and `≤ n`) makes the module attempt to build an
astronomically large array, hanging or exhausting memory instead of reporting a
usable error.

Fix: compute the binomial count directly (no enumeration) and reject the call
before materialising anything when it exceeds a cap — `MAX_COMBINATORIAL_FOLDS =
100000` in `splits.js`, `MAX_CSCV_SPLITS = 200000` in `overfitting.js`. Every
configuration the tests (and real use) exercise is far below both caps, so the
behaviour of valid inputs is unchanged.

Regression guard: `analysis.test.js` section T — `cscvSplit({n:200, blocks:60})`
and `combinatorialPurgedSplit({n:200, k:40, testGroups:20})` both throw.

### 14. `npm test` crashed before running a single test on modern Node

This one is a **tooling** defect, not numerical: it was found by running the
suite (not by the browser harness, which it cannot affect), so it is recorded
separately from the algorithmic fixes above.

`package.json` ran `"test": "node --test test/node/"` — a bare **directory** as
the runner's positional argument. Node's test runner used to accept that: the
v20 docs explicitly document `node --test custom_test_dir/` as "recursively
search the directory for test files". In Node ≥ 22 the positional arguments are
resolved as **glob(7) patterns** instead, and the directory case is gone — the
runner hands the path to the module loader, which cannot load a directory:

```
Error: Cannot find module '/.../NeuLegion-master/test/node'
  code: 'MODULE_NOT_FOUND', requireStack: []
ℹ tests 1   ℹ pass 0   ℹ fail 1
```

So a perfectly healthy repo reported a failing suite having executed **zero**
test files, on Node **v25.9.0** (the version this was reproduced and fixed on).
The `npm install` step is unrelated (it completes cleanly).

Fix: pass an explicit glob, quoted so the shell does not pre-expand it (Node
then resolves it):

```json
"test": "node --test \"test/node/*.test.js\""
```

`test/node/` is flat, so `*.test.js` matches every mirror and excludes the
non-test `helpers.js`. The focused scripts (`test:candles`, `test:analysis`,
`test:locks`) pass a file path, which is a valid glob in both regimes and was
never broken. Consequence for users: the Node suite now requires **Node ≥ 22**
(glob support landed in Node 21; Node 20 is EOL). `docs/RUNBOOK.md` §1 and §7
record the requirement and the failure signature, and §3 records the exact
script; `README.md` § Tests explains why the glob is deliberate. Only a local
run can catch a defect of this shape — which is why the Node suite is the
authoritative local gate (`docs/DESIGN.md`).

### 15. First local run of the Node mirrors: three test-harness defects (product code clean)

With #14 fixed the suite finally ran: **25 mirror files, 82 `test()` blocks, 76
passed, 6 failed.** All six traced to the *mirror harness*; every block that
actually executed passed against the **real** native driver.

1. **Wrong relative import depth (4 failures, `test/node/legion.test.js`).** The
   mirror's dynamic imports used `'../src/legion/*.js'` from `test/node/`, which
   resolves to `<repo>/test/src/legion/*.js` — one level short, so each of the
   four tests died with
   `ERR_MODULE_NOT_FOUND: .../test/src/legion/config.js`. The browser entry uses
   `'../../../src/legion/*.js'` from `test/browser/entries/`, which is correct.
   Fix: all 14 dynamic imports are now `'../../src/legion/*.js'`. (This is a
   node-only file that the browser harness never loads, so it could not be
   caught until a local run.)

2. **`stateDir(label)` was not label-pure (1 failure, `test/node/lsh.test.js`,
   `1/69` checks).** Every browser entry treats the injected state dir as a
   **pure function of the label** (`state/<suite>-<label>`): section I of the LSH
   suite saves with `stateDir('I')`, then reloads with `stateDir('I')` and
   expects those hyperplanes/prototypes back. The mirrors instead passed
   `(label) => tempStateDir(label)`, and `tempStateDir` mints a **new** directory
   on every *call*, so the reload opened an empty database:
   `roundTrip=false reloadRefsOk=false protos=0/200`. Reproduced and fixed in the
   browser harness (same code path): per-call dirs give `bank 144 / reloaded 0`,
   per-label memoisation gives `144/144`. Fix: `labelledStateDir(label)` in
   `test/node/helpers.js`, used by all **seven** mirrors that inject a `stateDir`
   (lsh, dimensions, surprise, sample_weights, homeostasis, multiprobe,
   walkforward — the other six were latently broken and only survived because
   they happen not to reuse a label across a reload).

3. **A static CDN import leaked into Node (1 failure,
   `test/node/multisymbol.test.js`).**
   `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'https:'`: the mirror
   imports the browser entry, which statically imported the sql.js shim, whose
   first import is an `https://cdn.jsdelivr.net/...` module. Every other entry
   loads the shim **lazily** behind the `{ ensureSql }` option; `multisymbol` was
   the one that didn't. Fix: the shim is imported lazily inside `run()`, and the
   node mirror passes `ensureSql: async () => {}` (real driver, nothing to init).
   *(This fix was per-entry and did not hold: the same shape recurred in R27-6 and
   is now fixed at the source — the shim's own CDN import is lazy — and guarded
   structurally in `mirrors.test.js`. `BUGS.md` #52.)*

Why the browser harness could not see any of this: it injects a label-pure state
dir, resolves modules itself, and bundles the shim from the CDN, so it never
exercises Node's ESM loader or Node's directory semantics.

**What the run does confirm:** everything except the three defects above ran green
on the real driver — `sanity` (all 9 blocks, incl. the persistence round-trip and
the `Object.is`-level determinism checks), `core`, `features`, `indicators` (75),
`consolidation` (48), `consolidation_worker` (18), `fetcher` (101), `modules`
(50), `candles` (95), `analysis` (354), `price_precision` (29), `locks` (41),
`lsh` (68 of 69 — the 69th is defect 2), `surprise` (32), `sample_weights` (36),
`homeostasis` (30), `evolve` (36), `multiprobe` (77), `binarypc` (39),
`bitweight` (69), `querymod` (51), `walkforward` (31, on the shipped candles) and
`dimensions` (185, both `forceMin` branches). So the hot path is bit-stable on
native SQLite, not just on the sql.js shim.

### 16. Coverage gaps closed after the first local run: the golden lock had no node mirror, and the mirror count floors were loose

Two weaknesses in the local gate itself, both found while auditing #15:

1. **The bit-exactness lock never ran on the real driver.** `golden.test.js` is
   the suite every `BIT_EXACT` status in `test/lock-registry.js` rests on, and it
   had no `test/node/` mirror — so all 11 fingerprints (and therefore every
   "golden fingerprints unchanged" claim in these docs) had only ever been
   verified through the **sql.js shim**. It is now mirrored as
   `test/node/golden.test.js`, and the entry was made injectable
   (`{ ensureSql, stateDir }`, shim imported lazily) the same way as the others;
   its default `stateDir` reproduces the historical `state/golden-<label>` paths
   byte-for-byte, so the browser fingerprints are untouched (re-verified: 23/23,
   all 11 hashes unchanged). The mirror was expected to reproduce every hash
   exactly, for structural reasons rather than luck: the prototype loader uses a
   full `ORDER BY idx[, window|entry_idx], proto_idx` and places protos by index
   (`persistence/load.js`), so driver row order cannot leak into the arrays;
   matrices and proto statistics are raw float32/float64 BLOBs that round-trip
   byte-exact; and `diagnostics()` — the bulk of the fingerprinted payload —
   contains no path-, clock- or driver-derived field (verified by running the
   entry with an **injected different state directory**: all 11 hashes are
   unchanged).

   **The first real native run partly falsified that claim:** 22/23 checks were
   bit-identical and only `hm:predictions` differed (`a2ce390b` expected,
   `c0d32aad` observed, identical canonical payload length). That is not a
   driver-dependence defect — it is a fingerprint that was never engine-portable
   in the first place, because it hashed raw float64 `predict()` output. See
   **#17**. Every other hash remains a finding-if-different, not a flake.

2. **The wrap-style mirrors' count floors were too loose to detect a truncated
   run.** They asserted `total >= 12..150` against entries that actually produce
   up to 354 checks (`analysis` asserted `>= 30`; `modules` asserted `> 0`), so a
   section that returned early — e.g. an entry's "no reader available" skip
   branch, which pushes a *passing* check — could drop hundreds of checks while
   `failed === 0` still held. Every floor now asserts the entry's documented
   count from the `RUNBOOK.md` §6 ledger (`analysis` 354, `dimensions` 185,
   `walkforward` 31, …), so the ledger is mechanically verified on each run.

Also added: `test/node/mirrors.test.js`, a Node-only structural test that pins
the layout — every pass/fail browser entry has a node mirror (the exact gap that
let item 1 happen), no orphan mirrors, no stub mirror files (every mirror must
declare at least one `test()` case), the ledger counts pinned (27 browser
entries, 28 node mirrors), `engines.node` must keep its `>= 22` floor, and the
`npm test` script passes a `*.test.js` glob rather than a directory (the
`BUGS.md` #14 regression).

### 17. The golden lock's live-prediction fingerprint was JS-engine-sensitive — and only that one

The second local run was **86 tests, 85 pass, 1 fail**, the lone failure being
the golden mirror: `1/23 golden checks failed`, `hm:predictions`,
`expected a2ce390b, got c0d32aad (len 176)`. All ten other fingerprints matched
exactly — including all five controller hashes and the post-reload prediction —
and the payload **length** was identical, i.e. the same values were hashed with a
last-digit difference, not a different retrieval set.

This looked like a driver-dependence finding (the exact thing #16 was built to
catch), but it is not one: the golden workload does **no** database work until
its final `dumpState()` (`_loadState` is called only from the constructor and
only runs `fs.existsSync`; a fresh state dir takes the "started with new state"
branch in both environments, and `_saveState` only runs from `dumpState()`). So
the divergence is pure JS. `hm:predictions` was the **only** fingerprint hashing
raw, unrounded float64 values; every other one is an integer count, a
float32-quantised value (prototype means/variances live in `Float32Array`, as
does `_cachedUtilityScores`), or a rounded output (the controller's prices and
scores). A systematic last-ulp difference in a transcendental between two JS
engines is therefore erased everywhere *except* there.

**Reproduced and measured in the browser harness** (same code path, no local run
needed):

- Bumping **every** `Math.exp` result by exactly +1 ulp (bit-pattern bump) moves
  `hm:predictions` (`a2ce390b` → `81f63c94`) and **nothing else**: the same
  signature as the native run — 1/23 checks failed, the other ten hashes
  unchanged.
- The 9 raw probabilities then move by **1–3 ulps** (≤ ~1e-16 relative): e.g.
  `0.4438680240782835` → `0.4438680240782836`.
- A single-ulp bump of one `exp` call changes nothing at all: the trajectory is
  damped, not chaotic, so the perturbation has to be *systematic* — which is
  precisely what an engine difference is and what a one-off numerical
  coincidence is not.

Fix: `hm:predictions` is now hashed as `values.map(p => Number(p.toPrecision(6)))`
— 6 significant digits — i.e. ~10 orders of magnitude looser than the measured
engine-class noise (~1e-16) and ~4 orders tighter than any behavioural change (a
real change in retrieval, training or ensembling moves a probability by ≫1e-6).
The `run()` result still returns the **raw** array, so a failure report shows the
unrounded values. `EXPECTED['hm:predictions']` was re-frozen once,
`a2ce390b` → `b6ca75d6`; the change is confined to that one constant, and the
rerun gives 23/23 with all ten other hashes literally unchanged. (One of those ten
was rounded the same way later, in #19; at this point it was still literal.) The browser
entry's default `stateDir` (`state/golden-<label>`) is untouched, so browser
fingerprints are byte-identical to before.

Institutionalised as `test/node/engine_portability.test.js`: it runs the golden
entry **once** with a systematic +1-ulp `Math.exp` drift in force and asserts
that all 23 checks still pass (pre-fix, this exact setup failed 1/23 —
`hm:predictions` moved while every other hash held), then re-derives the
discriminating power straight from the returned raw values: a 1-ulp move in them
changes the *raw* fingerprint but not the rounded one the lock uses. A future
fingerprint that hashes raw live float64 state will fail it immediately. (It runs
one golden pass per process on purpose: the browser harness cannot run an entry
twice in one Worker — see "Test-harness limitations" — and keeping it to a single
pass means it does not depend on any cross-run process state.)

The general rule this leaves behind: prefer observables that are counts, rounded
outputs, or float32-quantised values; a fingerprint over **raw, unrounded float64
output of a transcendental-heavy path** is a lock on the JS engine, not on the
model. `hm:predictions` was the one that measurement put in that regime — it is
the only one that moved. The controller fingerprints also hash some raw floats
(its `entryPrice` is the candle close), but they survived the same global +1-ulp
`Math.exp` drift on both the native driver and the harness, because the
controller quantises its `prob`/accuracy/score to 3 decimals and truncates its
prices, so those hashes are empirically engine-portable and stay literal.

Every one of the ten literal fingerprints was re-checked under the drift: all ten
held, on both a clean native run and the drifted harness run, which is why only
`hm:predictions` needed the rounding.

### 18. The native gate is green: local `npm test` 89/89 (no product defect — the promotion trigger)

The third local run (Node v25.9.0, real `better-sqlite3` + real
`worker_threads`) reported **89 tests, 89 pass, 0 fail, 0 skipped, ~5.6 min**
(338.7 s wall, the `dimensions` sweep dominating as usual). No product defect was
found; this is recorded because the project's process makes a green local run the
trigger to promote the last `NEEDS-LOCAL-RUN` components (`RUNBOOK.md` §6.1) and
because it is the first run of the *complete* mirror set including the two new
Node-only guards from #16/#17.

What the run establishes on the **native** driver (not the sql.js shim):

- **The golden lock is bit-exact on native SQLite.** `golden.test.js` passed
  23/23 with 10 of its 11 fingerprints literal and `hm:predictions` compared at 6
  significant digits (#17); `engine_portability.test.js` passed under a simulated
  +1-ulp `Math.exp` drift.
- **Every browser entry was reproduced through its mirror**: `analysis` (354),
  `dimensions` (185), `lsh` (69), `multiprobe` (77), `bitweight` (69),
  `candles` (95), `walkforward` (31), `multisymbol` (28) etc. all `failed === 0`
  *and* `total >=` their `RUNBOOK.md` §6 ledger floors.
- **The structural guards hold**: no missing/orphan/stub mirrors, the registry
  knows every browser entry, and the `test` script is a Node ≥ 22 glob.
- **The native-only components work end-to-end**: the controller DB
  (`controllerDatabase`), its accuracy persistence (`controllerAccuracy`) and its
  trade bookkeeping (`controllerTrade`) — the three bags that were the only
  `NEEDS-LOCAL-RUN` entries.

**Action taken on the strength of this run (process, not a fix):** the three
controller DB bags were moved `NEEDS-LOCAL-RUN -> LOCKED-invariant` in
`test/lock-registry.js`, with `proves` grounded in the tests that actually drive
them on the native driver (`core.test.js`, `golden.test.js`, `multisymbol.test.js`),
and recorded in `docs/LOCKED.md`. At that run the registry stood at **46 entries
— 17 bit-exact, 29 invariant, 0 needs-local-run, 0 experimental** (it has since
grown to 51 — see #19), and `locks.test.js` stays green. There is no remaining local-run blocker; the next gate is the
walk-forward A/B (`TODO.md` P0-1).

---

### 19. Round 22: run integrity, observability and the A/B driver (P0-P3) — one deliberate golden re-freeze

Round 22 delivered ROADMAP P0-P3. Nothing here is a *product* defect; the entry is
recorded because it changed the golden fingerprint set once (intentionally) and
because the run-integrity work closed several *latent* abort/corruption modes the
round-21 audit named but had not yet fixed.

**P0-1 fault isolation.** `legion/batch.js` no longer `process.exit(1)`s on a
worker reject: a failed controller is isolated (it keeps its previous
`lastSignal`), counted, and the batch continues; only a breach of
`CONFIG.controllerFailureBudget` (10%/batch of the pool by default) stops the
run, with code `CONTROLLER_FAILURE_BUDGET`. `legion/workers.js` wraps every
dispatch in a settle-once watchdog that terminates and rejects with a typed error
(`WORKER_TIMEOUT`/`WORKER_ERROR`/`WORKER_EXIT`/`WORKER_MESSAGE`), so a hung
worker can no longer suspend `Promise.all` forever. `HiveMindController`'s
constructor now validates its arguments (`assertControllerArgs`) and *throws*
instead of `process.exit`; corrupt `features` cells are quarantined rather than
thrown. `legion/sanitize.js` is the value-safe chokepoint (`finiteOr`,
`safeParseJSON`, `sanitizeSignal`, `sanitizeConsensus`) at every DB/broadcast
boundary.

**P0-2 determinism & durability.** `NEULEGION_STATE`/`NEULEGION_FILE`/
`NEULEGION_HTTP*`/`NEULEGION_SEED`/`NEULEGION_MAX_BATCHES` overrides land
before the DBs open; `state/main/state_meta.json` carries a structure/config
fingerprint so an incompatible resume warns (or refuses, with
`refuseOnConfigChange`); the runner counts malformed candle lines and returns a
structured summary; `mainController` writes a run directory (`run.json`,
`snapshots.jsonl`, `run.log`) and checkpoints on SIGINT/SIGTERM.

**P0-3 harness. P1-1 dashboard. P1-2 observer. P2-1 A/B driver.** See the round-22
section in `ROADMAP.md`; each has a dedicated entry (`preflight`, `dryrun`,
`http_view`, `observer`, `analyze`).

**The deliberate re-freeze (P2-3).** `hm:postReloadPrediction` hashed a raw
float64 (the reloaded prediction) — the same class of engine-sensitive observable
as `hm:predictions` (#16/#17). It now hashes the value **rounded to 6 significant
digits**, exactly like `hm:predictions`. Its constant moved `f9cef898 ->
5f703135`; the other ten fingerprints are byte-identical, and `engine_portability`
therefore now covers every fingerprint that could depend on last-ulp
transcendental behaviour. This is the ONLY golden change in round 22, and it is
recorded here, in `ROADMAP.md` and in `OPTIMIZATION.md`.

**Acceptance.** `golden.test.js` is 23/23 on the browser harness with the other
ten hashes unchanged, and every guard/observer/analyze check passes — i.e. the
hardening is exception-path-only, as required.

---

### 20. `preflight` counted the sampled window's truncated tail line as malformed (so the gate failed on a *healthy* checkout)

`preflight.test.js` failed on the first local run of round 22:

```
✖ preflight passes on a healthy checkout
  AssertionError: preflight did not report "candle stream sample"
```

`checkCandles()` (`src/preflight.js`) reads the first **262144 bytes** of
`CONFIG.file` and requires **zero** malformed lines in that window. But the
window is a *byte* window, not a *line* window: `262144` never lands exactly on a
line boundary in the shipped `src/candles.jsonl` (byte `262143` is the `:` inside
`{"timestamp":"…`), so the final element of `text.split('\n')` is always a
**truncated** JSON object and `JSON.parse` rejects it. `malformed` was therefore
always `1`, and the check returned the failure name
`bad('candle stream parseable', '1 malformed line(s) in sample')` instead of the
success name `ok('candle stream sample', …)`. The file itself is clean
(2243 lines parsed in the window, monotonic, OHLC-valid), so this was a **false
negative**: `npm run preflight` refused to pass on any checkout, and the test —
which hard-codes the passing name — reported it as the far less useful
`"candle stream sample"` is `undefined`.

**Fix (`src/preflight.js`).** When the window stopped short of EOF
(`read < size`), trim the sample back to the last complete newline before
splitting; if the window contains no newline at all, report that explicitly
(`no complete JSON line in first N bytes`) rather than blaming the data. When the
whole file fits in the window there is no partial tail, so nothing is trimmed.

**Fix (`test/node/preflight.test.js`).** The test matched the candle check by its
literal *passing* name, so a failure surfaced as `undefined` and — because it
asserted inside a loop — hid every check after it. It now locates the candle
check by the `candle stream` prefix, asserts `.ok` with the real `.detail` in the
message, and collects **all** problems (missing or red checks) into a single
`deepEqual` so one run names every failure, not just the first.

**Regression guard.** Verified against the shipped stream: the sample now parses
2243 lines with `malformed === 0` and yields `ok('candle stream sample', …)`,
while a genuinely malformed line, a non-monotonic window, an OHLC violation and a
newline-free oversized window each still fail with their own name.

---

### 21. The native gate is green again: round-22 `npm test` 115/115 (no product defect)

With #20 fixed, the user's local run reports the whole round-22 suite green on the
real drivers (Node + `better-sqlite3` + real `worker_threads`):

```
ℹ tests 115   ℹ pass 115   ℹ fail 0   ℹ skipped 0   ℹ duration_ms 353562
```

i.e. **115/115 `test()` blocks across 39 files, ~5.9 min**. Nothing in the locked
math changed: the 11 golden fingerprints are the same (9 literal + the 2 rounded
raw-float observables of #17/#19), and `engine_portability.test.js` still passes
under a simulated last-ulp `Math.exp` drift. The run confirms the four things
round 22 was built to establish:

- **The real end-to-end path is exercised, not just the components.** `dryrun`,
  `runner_smoke`, `worker_pool`, `http_view`, `report_lifecycle` and `shutdown`
  all pass on the native driver, so `mainController → runner → batch → worker →
  HiveMindController.getSignal` is now proven end-to-end *before* a long run
  rather than only inside the browser harness's sql.js shim.
- **Fault isolation works as specified.** `runner_smoke` logs the two expected
  `[isolated] controller … failed (WORKER_ERROR)` lines and then
  `2/2 controller(s) failed and were isolated`, and the batch completes — the
  deliberate budget-breach case stops the run with `CONTROLLER_FAILURE_BUDGET`.
  The lines are expected output, not failures.
- **`preflight` passes on a healthy checkout** (287 ms) after #20.
- **The new tooling has no native-only surprises.** `config_env`, `preflight`,
  `dryrun`, `http_view`, `report_lifecycle` and `shutdown` were added to
  `mirrors.test.js`'s `NODE_ONLY` set precisely because the browser harness cannot
  provide real `worker_threads`/sockets; all six pass natively.

Notable wall-clock (unchanged in shape from round 21): `dimensions` ~353 s and
`lsh` ~177 s dominate, `walkforward` ~83 s, `analysis` ~15 s, `multiprobe` ~15 s,
`multisymbol` ~19 s — the suite is dominated by two exhaustive sweeps, not by the
new tooling (every P0-P3 test is sub-second except the dry-run laps).

---

### 22. The look-ahead audit passes **vacuously** for a model whose features come from candles, not returns (latent — found while planning round 23)

`analysis/walkforward.js#auditNoLookahead` is the honesty gate behind
`promoteDecision`'s `requireCleanAudit`: it perturbs `returns[t+1..]`, re-runs
`signalForFold`, and requires the position at `t` not to move. Its contract is
explicit — *"signalForFold must read `view.returns`"* — but **nothing enforces
it**, and a model whose features come from a **candle series** never reads
`view.returns` at all.

Measured repro (real shipped module, 60-bar synthetic series,
`walkForwardSplit({n:60, trainSize:30, testSize:10})`, 30 probes):

| `signalForFold` | result |
| --- | --- |
| leaky over `view.returns` (position `t` = sign of `returns[t+1]`) | `clean: false`, **15 violations** ✅ caught |
| **identical** leak over a pre-loaded **candle** array | `clean: true`, **0 violations** ❌ **vacuous** |

So a candidate whose input is candles can carry a blatant `t+1` leak and still
satisfy `requireCleanAudit`, because perturbing `returns` cannot reach its input.
This is harmless today — every current `signalForFold` is returns-driven — but it
is **load-bearing for round 23**: a controller-backed factory (ROADMAP N0)
naturally reads candles, so "audit clean" on that path would become a rubber stamp
on the one artefact the project most needs to trust.

**Fix (N0):** let the audit perturb the model's *actual* input — pass the candle
series the factory consumes as `view.candles` (derived causally from the same bars
the audit perturbs), or add an optional `perturbView(t, probe)` hook. The default
path must stay returns-only and **byte-identical**, so every existing test, report
and golden is unchanged; the regression guard is that the candle-driven leak in
the table above must be **caught** and an honest candle-driven signal must stay
clean.

**Secondary nit (same probe).** `auditNoLookahead` compares with
`alt[j] !== base[j]`, and `NaN !== NaN`, so a `NaN` position (e.g. a signal that
reads one bar past the series end) is reported as a "position changed" *leak* on
every probe. A non-finite position should be its own explicit reason — a
mislabelled diagnostic is exactly what erodes trust in a gate.

**Fixed (round 23, N0).** `auditNoLookahead` now takes an optional
`viewFor(returns, perturb)` hook and perturbs the view the model actually reads
(`analysis/world.js` derives `{candles, closes, volumes, returns}` from the same
bars, re-deriving `returns` from the shocked closes so no unshocked copy of the
future survives in the state object), returns
`{clean, violations, probes, viewDiffers, reachable, vacuous}`, and gained an
explicit non-finite-position reason plus a `requireReachable` flag. A `viewFor`
whose base and probe views are structurally identical is reported
`vacuous: true, clean: false` (a green audit can no longer be bought with an
input the perturbation cannot reach). The default (no `viewFor`) path is
returns-only and byte-identical, so every existing report/golden is unchanged.
`walkforward.test.js` section K is the regression guard: the candle-driven `t+1`
leak from the table above is now **caught** with `viewFor`, an honest
candle-driven signal stays clean, and the ignore-the-perturbation `viewFor` is
flagged vacuous. Implementation recorded in `lock-registry.js` (`world.js`).

---

### 23. `Number(null) === 0` — a missing close silently became a price of 0 in the new candle reader (found by the round-23 tests; fixed before shipping)

`analyze.js#readCandles` (new in round 23 — the A/B's world needs full OHLCV, not
just closes) originally coerced every field with `Number(c.field)` and kept a row
when `Number.isFinite(close)`. But `Number(null) === 0` **and** `Number('') === 0`,
so a row with `"close": null` (or a truncated write, or an empty string) passed
the finiteness guard and entered the world as a **price of 0** — which then makes
`barReturns` produce a `-100%` return and poisons every downstream metric. The
bug was caught by the entry's own malformed-row check, not by review.

**Fix:** a local `numOr(v, fallback)` that accepts only a finite `number`, or a
non-empty numeric `string`, and treats `null` / `''` / booleans / `NaN` /
`Infinity` as absent; a row without a finite close is skipped, and `open` /
`high` / `low` / `volume` fall back to the close (or to 1 for volume) instead of
to 0. Pinned by `analyze.test.js` (a `close: null` row is dropped, a close-only
row back-fills `open = high = low = close` and `volume = 1`).

**Same-family latent footgun (documented, not changed).**
`hivemind/memory/multiprobe.js` and `hivemind/memory/querymod.js` both resolve
numeric config via `Number.isFinite(Number(v)) ? Number(v) : d`, so an explicit
`null` (as opposed to `undefined`, which coerces to `NaN`) yields `0` rather than
the documented default. Unreachable from the shipped config path (a missing key
is `undefined`, never `null`) and these are locked modules whose behaviour is
pinned, so they are recorded rather than changed. `sanitize.js#finiteOr` is the
correct pattern (`isValidNumber` rejects `null` before coercing).

---

### 24. An interrupted `npm run analyze` loses *all* science and leaves ~0.71 MiB of unreclaimed SQLite state per fit (found by forensics on the interrupted round-23 N3 attempt)

Round 23's power run (`npm run analyze -- --symbols=all --bars=600`) was supplied
as an "analyze report"; forensics (`docs/RUN-ANALYSIS.md` §1) showed it was a
**partial run directory** with no report at all. Two defects, both in the run
path rather than the mathematics:

1. **All-or-nothing reporting.** `report.json` and `run.log` are written only
   after every variant has been evaluated (`src/analyze.js:648-649`), so a crash
   at any earlier point discards *every* candidate's pooled metrics, decisions
   and family-wise p-values — the run's own progress log can only be
   reconstructed from the model-state directory names. Measured: the artifact
   held 1,862 of ~17,280 fits (10.8 %), and `report.json`/`run.log` were absent.
2. **Unreclaimed per-fit state.** Each fold runs four fits (the scored pass plus
   the audit's base pass plus `auditProbesPerFold` probes — see `RUN-ANALYSIS.md`
   §1.4) and `make{Controller,HiveMind}ModelFactory` gives *each* one a fresh,
   never-deleted state directory (`src/analyze.js:238` for the bare factory, `:452` for the controller one). Measured
   footprint: **1,381,600,976 B for 1,862 fits = 0.708 MiB/fit**, i.e. **~11.9 GiB
   for one full 15-variant run**, multiplied by the 20 retained run directories
   (`CONFIG` retention). `src/analyze.js` contains no `rmSync`/`unlink` and never
   calls `pruneRunDirectories` (which `src/mainController.js` does), so nothing
   is ever reclaimed.

The crash also left the final fit's SQLite handle uncheckpointed
(`models/surprise-1861/hivemind_controller-positive-AN-surprise.dbwal`, 4.16 MB,
plus a `-shm`) — evidence of an abrupt process end, and the reason the argument
`--keep-models` should exist rather than be the only behaviour.

**Fixed (round 24).** As-built and proven by `analyze.test.js` §O/§P/§Q:

1. **Checkpointed reporting.** `runAnalysis` rewrites `partial-report.json`
   after EVERY variant with an atomic (tmp+rename) write, appends a per-variant
   `progress` line to `run.log`, and on an exception writes a `status:'failed'`
   checkpoint that keeps every finished variant, its decision, and every completed
   pass (`report.json` is still the canonical end-of-run file, written only on
   success). §Q proves the artifact set, the roster-scaled event budget in
   `progress.json`, the `folds.jsonl` journal and the failed-run post-mortem.
2. **Reclaimed state.** `modelRetention: 'discard' | 'keep'` (factory default
   `keep`, CLI default `discard`, `--keep-models` opts out);
   `makeSignalForVariant` disposes the model in a `finally`; `dispose()` closes
   the fit's `_db` handle and `rmSync`s its state directory, and is idempotent.
   §O proves the emitted positions are byte-identical to the `keep` run and that
   `models/` is removed once every fit is discarded.
3. **The audit's teeth.** The report carries the machine-readable
   `audit` block (`clean`/`vacuous`/`reachable`/`reachableFolds`/`viewDiffers`/
   `probes`/`violations`) and `--reachable` enforces behavioural non-vacuity. §P
   proves the base pass reproduces the scored pass exactly and that
   `reachableFolds` is bounded by the fold count.

None of the three touches the arithmetic, so no golden fingerprint moves.

**Verified straight after this was written**, so it can be quoted as fact: the
audit's *base* pass is bit-identical to the *scored* pass on **464/464**
fold-passes (every complete audit group of both `baseline` and `surprise` — the
model is reproducible on real candles), and `quarantined_rows` was 0 across all
1,862 fits.

---

### 25. The first COMPLETE `npm run analyze` exposed five defects in the audit, the journal and the report (found by forensics on the attempt-2 smoke run)

Round 24's **smoke** run finished (2,342,845 ms, 960 passes, `report.json`
present, 15/15 variants) and gave an honest, underpowered null verdict
(`docs/RUN-ANALYSIS.md` §3). Reading the run directory against the contract found
five defects, all off the arithmetic path (no golden fingerprint moves):

1. **The audit could not reach a volume-driven strategy.** `shockCandles`
   (`src/analysis/world.js`) scaled the OHLC but never the **volume**, so the
   probe left a volume-reading candidate's input unchanged. Measured on the real
   run: `sig:volume` was reachable in **0/16** folds while every other candidate
   was 11-16/16. The audit was blind to the entire volume channel, and a
   future-volume leak would have gone undetected. **Fixed (round 24b):**
   `volumeShockFactor` (phase-shifted, bounded by the same `probe`) scales volume
   on a probe pass; `DEFAULT_SHOCK.volumePhase` names the offset. §R proves the
   volume shock is bounded, reaches the view, and that a volume-only signal is
   audited reachable.
2. **The journal was not readable offline.** `foldRecord` (`src/analyze.js`)
   emitted the probe bar (`probeAt`) but not its **index** in the fold test array,
   and the reachability comparison is `k > probeIndex`. Recomputing reachability
   from `folds.jsonl` required recovering `test.indexOf(probeAt)` by hand.
   **Fixed:** each pass record carries `probeIndex` and `reused`. §Q pins both.
3. **The liveness cursor froze during every audit.** `onEvent` set
   `state.foldIndex` only for scored folds, so the stdout/heartbeat line sat on
   `fold 16/16` for the whole audit (visible for ~40 s per variant in the real
   run). **Fixed:** pass events advance `foldIndex`/`foldTotal`. §P pins it.
4. **Transaction costs were always zero and unfalsifiable.** `costBps` defaulted
   to 0 *and* `--cost-bps` was ignored by the CLI, so a 125×-turnover signal was
   compared to a 1.7×-turnover mechanism with no penalty — the real run's apparent
   signal edges (10-15 bps break-even) are inside a realistic taker cost.
   **Fixed:** `backtestMetrics`/`poolFolds` carry `grossPnl` and an
   assumption-free `breakEvenCostBps` (`1e4·grossPnl/turnover`, `null` at zero
   turnover), `formatReport` prints a `cost:` line, and `--cost-bps` is threaded
   to the scoring. §R proves the exact value, the `null` case, and that
   `--cost-bps` separates net from gross.
5. **A null verdict could not say it was underpowered.** Every report carried the
   Sharpe MDE (round 23), but nothing stated that a run whose MDE95 exceeds 1.0
   cannot distinguish "no edge" from "an edge it could not see". **Fixed:**
   `powerSummary` adds `underpowered` (MDE95 > `UNDERPOWERED_MDE` = 1.0) and
   `barsToDetect1` from the pure helper `barsToDetect`; `formatReport` marks an
   underpowered power line and `formatAnalysis` states the run-level verdict.
   The real smoke run reports MDE95 = ±2.0086 over 240 bars with 969 bars needed
   for Sharpe ±1.0 (`RUN-ANALYSIS.md` §3.3).

Round 24b also adds **`--reuse-base`**, an opt-in optimization: the scored pass
*is* the audit base pass (same fold, same unperturbed view), so
`auditNoLookahead({baseSignals})` can reuse it instead of refitting. The verdict
is provably unchanged (identical promote/keep-off set and audit with
`baseReused == folds` vs `0`) and the power run drops from 4 to 3 passes per fold
(2 with `--audit-probes=1`), i.e. ~12 h → ~6 h. Recorded in the report as
`baseReused`.

Proved by `analyze.test.js` §R (8 checks) plus the power-honesty checks in
`analyze`/`walkforward`/`analysis`; `analyze` 129 → 143, `walkforward` 48 → 49.

## Found by the attempt-3 power run — fixed in round 25 (#26, #27), plus defects found while fixing them (#28, #29) and in review (#30-#32)

The first four entries below were found by forensics on the **attempt-3 power run**
(`20260920T144633-seed1`), by recomputing its decision offline from the journal, or
by the round-25 tests written to pin the fixes. All four are now **fixed and
test-guarded** (`analysis.test.js` §AD, `walkforward.test.js` §9,
`analyze.test.js` §L2/§N). #26 and #27 were report-honesty defects — the verdict
itself did not change (nothing promotes either way), but what the report *claimed
about itself* did; #28 and #29 were real arithmetic/logic defects in the new code,
caught by the tests rather than by inspection. The round-25 items are 31-37 in
[`TODO.md`](TODO.md).

### 26. The power readout ignores cross-stream correlation, so `underpowered: false` was optimistic (found by forensics on the attempt-3 power run)

Round 23 added `power.se` (`sharpeStandardError`, Lo 2002) and round 24b added
`power.underpowered = mdeSharpe > 1.0`. Both treat the pooled bars as **i.i.d.**
The attempt-3 power run pools one walk-forward per symbol, and the 8 symbols are
not independent: recomputed from `folds.jsonl` (`RUN-ANALYSIS.md` §5.6), the mean
pairwise correlation of the per-fold Sharpe series between the 8 streams is
**0.452** (baseline), 0.414 (`querymod`), 0.524 (`sig:momentum`), 0.471
(`sig:accel`). Under an equicorrelation model with r ≈ 0.47 the pooled SE is
understated by √(1 + 7r) ≈ **2.1**, so the honest MDE95 is **≈ ±0.98** — right at
`UNDERPOWERED_MDE` — while the report printed **±0.4735** with
`underpowered: false`. The run is *marginal*, and the baseline's Sharpe 0.4387 is
not distinguishable from zero at the corrected MDE. Same correction applies to
`barsToDetect1` (969 → ≈ 4,300 pooled bars with a design effect of 2.1).

**Fix (round 25):** `powerSummary` gains a cross-stream correlation /
design-effect term — the mean pairwise correlation of the per-stream per-fold
Sharpe series, an `effectiveStreams` estimate, and a corrected SE/MDE that
`underpowered` is computed from (both the raw and the corrected value recorded).
Not a hot-path change; a report-honesty change. This is the same class of defect
as #25.5 ("a null verdict must say it is underpowered") one level deeper: the
power readout must not be able to say "powered" when the pooled bars are
correlated.

**Fixed in round 25.** `dependenceSummary` measures the delete-one-cluster jackknife
SE of the pooled Sharpe over fold-window clusters (Cameron & Miller 2015 §IV;
Künsch 1989 for the delete-block jackknife on stationary data; arXiv 2602.12043 for
the same remedy with few/unequal clusters) and reports `seCluster`, `seIid`,
`designEffect = (seCluster/seIid)^2`, `effectiveBars = bars/designEffect`, and the
Kish (1965) equicorrelation reading. `powerSummary` now carries the honest numbers
**alongside** the i.i.d. ones (`seDependent`, `mdeSharpeDependent`,
`underpoweredDependent`, `varianceInflation`) rather than replacing them, so a
reader can always see how much of the "power" was the i.i.d. assumption;
`formatReport` prints both (`power:` and `power*:`) and `formatAnalysis` too.
`poolFolds`/`backtestMetrics` take `effectiveBars` and emit
`psrAdjusted`/`dsrAdjusted`. Planned as the mean-pairwise-correlation scaling
originally; the tests showed the jackknife is exact where the scaling is only
approximate (measured inflation ratio 1.653/2.124/2.512 at ρ = 0.25/0.5/0.75 vs
predicted 1.658/2.121/2.500), so the jackknife shipped.

### 27. The `costBps: 0` verdict is knife-edge and not cost-robust — the gate flips at 2 bps (found by recomputing the attempt-3 decision at several cost levels)

`promoteDecision` compares a candidate's `foldWinFraction >= 0.5` and its
`positiveFraction >= baseline's`, both of which are **cost-sensitive and
baseline-relative**. The power run scored at `costBps: 0` (documented as the
"scientific" comparison), so the record reads as an absolute verdict. It is not:
recomputing the whole decision from the journal (`RUN-ANALYSIS.md` §5.6(a), pure
metrics on the stored returns/signals) gives

```
cost   baseline Sharpe/DSR    querymod        sig:momentum    sig:accel       promotes
0 bps  0.4387 / 0.5179        1.0025/0.9992   1.1059/0.9988   1.0502/0.9968   none
2 bps  0.3680 / 0.4028        0.9437/0.9975   0.9590/0.9909   0.8745/0.9741   sig:accel (0 reasons)
5 bps  0.2619 / 0.2469        0.8553/0.9887   0.7382/0.9130   0.6108/0.7841   none
```

at 2 bps `sig:acceleration` passes every hurdle (fold-win 0.5104 ≥ 0.5,
positive-fold 0.6007 ≥ baseline 0.4236) and promotes with **zero reasons**. Two of
the three candidate verdicts are therefore decided by (a) an unstated cost
assumption and (b) a 0.4896-vs-0.5000 margin on one statistic over 288
*correlated* folds. Note the promotion gate does not consult the family-wise test
(`maxSearchP`/`requireSearchReject` are unset), so a candidate the SPA does not
support can still promote.

**Fix (round 25):** (1) emit a `costLadder` block — pooled metrics +
`promoteDecision` recomputed at a small set of bps levels (O(T) per level, seconds
at this scale) so the verdict carries its own sensitivity; (2) state the cost
assumption in the summary header; (3) replace the raw `foldWinFraction >= 0.5`
hurdle with a paired significance statement against the baseline that accounts for
the effective (correlation-corrected) number of folds, instead of a fixed fraction.

**Fixed in round 25.** The report now carries a `costLadder` block by default
(`--cost-ladder=` overrides the levels), the summary states the levels, and the
gate's fold-consistency hurdle is a significance statement:
`pairedPromotionTest` is a paired delete-one-cluster Sharpe-difference t-test
referenced to t(C−1) plus the **exact** sign test over the same fold-window
clusters (Demsar 2006; Ledoit & Wolf 2008), and `promoteDecision` gains
`requireSharpeDiff`/`requireBreadth`/`minDsrAdjusted` — each recorded in the
returned `gate` as `applied` | `skipped-no-panel` | `not-needed` | `off`. **Round 26 (R26-7)** then replaced the breadth half of that gate: the exact sign test is still computed and reported (`promotionTest.breadth`) but is no longer a hurdle, and the shipped dependence gate is the magnitude floor (`requireSharpeDiff`) plus a **cluster-stability** requirement (`requireClusterStability`) — the paired Sharpe difference must stay positive when any single fold-window cluster is deleted. The
search concentration that made the 0.5 threshold unreadable is now a named
diagnostic (`familyCorrelation`: mean pairwise excess correlation, the strongest
pair, an effective trial count) — a diagnostic ONLY, because substituting an
effective number of independent tests for the number of tests actually run does
not control the FWER (arXiv 1612.04535) and correlated tests are still tests that
were run (Harvey, Liu & Zhu 2016), so the deflated Sharpe keeps `trials = K`.
`restateReportAtCost` makes the ladder exact rather than approximate: it re-scores
the retained per-fold `(returns, signals)` with the scored pass's own arithmetic
(verified byte-identical at cost 0) and defaults `trials` to the report's recorded
deflation count, so a restatement cannot silently re-deflate.

Also found in the same pass (minor, report-integrity): `minTrackRecordLength`
serialises `Infinity` to `null` (5 candidates), which is indistinguishable from
"not computed"; and the 15 per-variant checkpoints in `run.log` for the 8 signal
variants all land within 0.66 s because mechanism variants cost ~10.7 s/fit while
signal variants are pure array math — a correct log that reads like a bug
(`RUN-ANALYSIS.md` §5.4; round 25 adds per-variant elapsed + `kind` to the
checkpoint line).

### 28. `studentTPValue` swallowed its own infinite cases, turning a dominant candidate into `not significant` (found by the new round-25 tests)

The new Student-t tail-probability function in `analysis/dependence.js` guards its inputs with
`if (!Number.isFinite(df) || df <= 0 || !Number.isFinite(t)) return NaN;` and only
*then* handles `t === ±Infinity`. The guard runs first, so `Number.isFinite(Infinity)`
is false and the two `Infinity` branches were **dead code**: the function returned
`NaN` for an infinite t. This matters because `pairedClusterTest` deliberately
produces `t = ±Infinity` when the delete-one-cluster differences are degenerate
(zero jackknife SE with a non-zero difference) — and `NaN` propagates to
`p = NaN`, hence `significant: false`. A candidate that dominates the baseline on
**every** fold window would therefore fail the new Sharpe-difference hurdle, with a
p-value that reads as "not computed". The test that caught it compares the function
against a closed form at `t = Infinity`.

**Fixed:** the infinite cases are handled before the finite guard, so
`t = +Infinity` gives p = 0 (and `t = -Infinity` gives p = 1 one-sided). Pinned by
`analysis.test.js` §AD: a degenerate three-cluster panel yields `se === 0`,
`t === Infinity`, `pOneSided === 0`, `significant === true`.

Documentation note (same review pass): the function is a tail *probability*, not a
cumulative distribution value, yet it is also exported as the alias `studentTCdf`
(the lock registry pins that name). `studentTCdf(-Infinity)` is 1, not 0. The alias
is kept for naming stability, and the source comment now states the distinction
explicitly so the name cannot mislead a future caller.

### 29. A *diversifying* cross-stream panel was reported as `skipped-no-panel` (found by the new round-25 tests)

`dependenceSummary` reports `effectiveBars = bars/designEffect`, which **exceeds**
the bar count when the streams are diversifying (designEffect < 1 — the variance
really is smaller than i.i.d.). `backtestMetrics` deliberately declines to *inflate*
confidence beyond the raw sample, so `dsrAdjusted` is `null` in that case — correct
— but `promoteDecision`'s `minDsrAdjusted` hurdle treated "`dsrAdjusted` is null"
as "no cross-stream panel exists" and reported `skipped-no-panel`. The two states
are different: one means the adjustment *could not* be computed, the other means it
was *not needed*. A reader (or an agent) auditing the gate would have concluded the
run had no panel when it had one that simply needed no correction.

**Fixed:** the gate now distinguishes `not-needed` (a panel exists whose design
effect is ≤ 1, so the unadjusted floor was already honest) from
`skipped-no-panel`, and `dependenceSummary` exposes `adjustmentNeeded`
(`designEffect > 1`) as the machine-readable form of the same statement. Pinned by
`analysis.test.js` §AD and `walkforward.test.js` §9.

### 30. The new `paired:` report line was never wired to its value, so it could not print (found in the post-implementation review)

`formatReport` (round 25) renders a `paired:` line from `report.promotionTest`,
but the paired cluster test is produced by `promoteDecision` when a candidate is
judged against a baseline — it is not a property of the report, and nothing
attached it. Only the tests set `promotionTest` by hand, so the suite was green
while a real run's summary could never show the line: the evidence behind the two
new hurdles was silently absent from exactly the artifact a human reads.

**Fixed:** `formatReport` now takes `promotionTest` as an explicit option
(defaulting to a `report.promotionTest` field if present), and the driver passes
the candidate's `decision.promotionTest`. A single-stream run now renders
`paired: n/a (reason)` rather than omitting the hurdle. Pinned by
`analyze.test.js` §N (the summary must contain `paired: n/a (`) and
`walkforward.test.js` §9 (the attached-test and no-panel cases).

Also caught in the same review pass (documentation/test hygiene, no product
behaviour): the new round-25 test section was labelled §AB, which round 12 already
used, so it is now §AD with every reference updated; three Node-mirror failure
messages still cited the pre-round-25 check counts (49/143/390) while asserting the
new ones (62/158/437), contradicting the RUNBOOK §6 ledger; the `dependence.js`
row had silently failed to insert into `docs/LOCKED.md`; and this file's
indicator-processor audit content had lost its section heading (restored below).

### 31. `evaluateAB`'s candidate projection dropped `elapsedMs`/`streams`, so `report.json` always carried a null per-candidate wall time

`evaluateAB` computes `elapsedMs` for every variant (round 25's observability fix)
and the report's `timings` block carries it, but the returned `candidates` were
rebuilt as `{variant, report, skipped, decision, search}` — **dropping
`elapsedMs`**. `candidateRow` then read `entry.elapsedMs ?? null`, so every
`report.json` `candidates[].elapsedMs` was null while `timings[].elapsedMs` held
the real value: the two views of the same quantity silently disagreed. The trial
count K that every DSR was deflated by was also never surfaced in `report.json`
(top level or per candidate), so a reader could not see the trial count the verdict
assumed without inferring it from `familywise.K` or `costLadder.trials`.

Found by auditing `20260921T062511-seed1/report.json`: `candidates[0].elapsedMs`
was `null` beside `timings[0].elapsedMs === 96890845`.

**Fixed:** the projection carries `elapsedMs` and `streams`; `candidateRow` gains
`streams` and `trials`; the report and the partial-report checkpoints gain a
top-level `trials`. Pinned by `analyze.test.js` §N (the timings/trials check).

### 32. The documented and emitted cost model was linear in bars; the runner is O(n²) per stream (a ~27-hour run was planned at ~7)

Round 25 recorded the controller cost as "10.5-10.7 s per controller fit,
**independent of the stream length**" — in `docs/RUN-ANALYSIS.md` §4,
`docs/RUNBOOK.md`, `docs/ROADMAP.md`, `docs/TODO.md`, `docs/OPTIMIZATION.md`, the
`test/lock-registry.js` note, and the `report.json`/`partial-report.json`
`reader` strings. The `--bars=2200` signal run falsified it: the same runner took
**42.6 s per fold-pass at 142 folds/stream** versus 10.7 s at 36, so the run cost
26.9 h where the documented linear model (and the sizing advice built on it) said
≈7.

Cause: the model fit warms an online controller by replaying all history —
`for (i = 1..testStart) getSignal(candles.slice(0, i))` in `analyze.js` `fit()` —
so the number of warm-up calls per fold grows with the fold index, and a run is
**O(n²) per stream**, not linear in bars. The two power-scale runs pin the law:
`time ≈ 0.035 s × Σ_f(testStart_f) × streams × passes × mechanismVariants`
(33.2 ms per warm-up call at 36 folds/stream, 38.2 ms at 142).

**Fixed (documentation):** §4 of `RUN-ANALYSIS.md` now carries the corrected law
and its planning consequences (cost ∝ `pooledBars × folds-per-stream`, so many
short streams are far cheaper than a few long ones); `OPTIMIZATION.md` "Round 25b"
quantifies the parallelisation opportunity; the inline comments and both `reader`
strings were corrected. **Deliberately not "fixed":** the O(n²) itself — replaying
history *is* the online training, so removing it would change the model. The
enabling change is parallelism, which is semantics-preserving.

## Found by the round-26 controller / A-B fidelity sweep (#33-#37 all fixed)

Round 25b explained the `20260921T062511-seed1` run's 26.9 h wall clock with the
O(n²) cost law and concluded that the ceiling was economic, not statistical. The
round-26 plan then proposed to attack turnover and buy diverse streams. Before
planning more compute, the sweep below re-audited the *caller* side of the
controller — what the A/B actually feeds `getSignal` — against what production
feeds it (`legion/runner.js` → `legion/workers.js#runWorker`). It found that the
A/B does **not** reproduce the production input shape, so the controller's trade
bookkeeping and training labels in every `npm run analyze` run to date are not the
shipped model's.

A **second pass** (round 26b, the user's re-run of the same request) then re-ran
the sweep against the plan's own assumptions. It added #36 and #37, and it
**corrected #33's cost claim by measuring the control** (a production-shaped window
costs the same per call as the prefix, so the re-insert churn is *not* the large
term round 25c said it was). The corrected numbers and the two new defects are in
the entries below; the plan itself is `ROADMAP.md` round 26, "Revision 2".

### 33. The A/B streams the whole growing candle prefix into the controller, so its trade bookkeeping sees ancient bars and trains on corrupted labels

**Production feeds a fixed window.** `legion/runner.js:90-95` pushes one candle at
a time, keeps `state.cache` at `maxCache`, and dispatches once it is full;
`legion/workers.js:39` then passes `state.cache.slice(-cacheSize)` — i.e. the
**last `cacheSize` candles** — to `getSignal`. The controller's own candle table
is trimmed to `cacheSize` by `_getRecentCandles`, so on a production call the
candles it has not seen are exactly the newly-arrived one(s), and the
`recentCandles` list it hands to `_updateOpenTrades` is one candle long.

**The A/B feeds the entire prefix.** `analyze.js` `makeControllerModelFactory`:

```js
for (let i = 1; i <= testStart; i++) ctl.getSignal(candles.slice(0, i), 1);   // fit
... ctl.getSignal(candles.slice(0, t + 1), 1)                                 // predict
```

Every call passes the whole prefix. `_getRecentCandles` inserts the input with
`INSERT OR IGNORE`, but the cleanup immediately before it deleted every candle
older than the `cacheSize` newest — so the next call **re-inserts the entire
trimmed history**, and those re-inserted candles become `recentCandles`:

```sql
DELETE FROM candles WHERE timestamp NOT IN (
    SELECT timestamp FROM candles ORDER BY timestamp DESC LIMIT ${cacheSize})
```

Measured in the browser harness (`hiveMindController`, `cacheSize = 120`, 260
synthetic bars), instrumenting `_getRecentCandles`:

| call | `recentCandles.length` (prefix, current) | (production window) |
| ---: | ---: | ---: |
| 1 | 1 | 1 |
| 130 | 10 | 1 |
| 200 | 80 | 1 |
| 260 | 140 | 1 |

`_updateOpenTrades(candles)` (`hivemind/controller/trades.js:14`) checks **every
open trade against every candle in the list** and closes it on the first candle
whose high/low crosses its take-profit or stop-loss — with no timestamp guard. So
in the A/B a trade opened at bar `t` is immediately tested against bars
`0 … t-121`, whose price levels are unrelated to the trade's entry: for a long,
an old low is almost always below a stop set from the *current* price, so the
trade is closed as a loss within a call or two.

**This is not a timing artefact — it changes the labels.** Same seed, same 260
candles, same controller, only the input window differing:

| | `recentCandles` max | wins | losses | `trainingSteps` | open trades at end |
| --- | ---: | ---: | ---: | ---: | ---: |
| prefix (current A/B) | 140 | **78** | **144** | 233 | 1 |
| window (production-shaped) | 1 | **156** | **64** | 231 | 10 |

The win/loss split inverts (36 % → 71 % wins), i.e. the A/B's controller was
trained on a systematically mislabelled trade stream. On a 600-bar replay the
probability stream also differs (`fracOutsideDeadZone` 0.328 prefix vs 0.224
window; `probStd` 2.55 vs 2.27), which is exactly the quantity every reported
Sharpe, DSR and break-even is built from. So **every number in
`RUN-ANALYSIS.md` §7 that involves the `baseline` row must be re-derived**; the
signal-family rows are unaffected (they are pure array math on the view and never
reach the controller), which is why the section-7 verdict — "no signal promotes,
and the economics kill them anyway" — survives, while its *baseline* comparison
("the controller is a no-op") does not.

**Fix (driver, semantics-restoring).** Pass the same window production passes:

```js
const from = Math.max(0, i - cacheSize);
ctl.getSignal(candles.slice(from, i), 1);   // fit: i = 1..testStart
ctl.getSignal(candles.slice(Math.max(0, t + 1 - cacheSize), t + 1), 1);  // predict
```

The controller's features are computed from its cached window either way, so this
does not change what the model *reads*; it changes only the `recentCandles`
increment, which is the intended production semantics. **Secondary payoff: not
measured.** Round 25c claimed the re-insert churn was a large part of the per-call
cost; the second sweep pass measured the control and found a production-shaped
window costs **the same** per call as the prefix in the shim (56.6 vs 55.4 ms/call
at calls 150-200, and equal in every earlier block — the ramp both show is
early-run warm-up, not the churn). The churn term is real but ≤ 8 % over a 600-bar
run (600 bars: 51.2 vs 55.1 ms/call). So the fix is a *correctness* fix, its speed
benefit is unmeasured, and the native constant must be re-measured after it lands
before it sizes anything. See `OPTIMIZATION.md` "Round 26b".
Residual churn that the fix does *not* remove: a window that reaches **older** than
the cached set still mass-re-inserts (measured `recentCandles = 80` when a
back-in-time window is supplied) and is then deleted again by the same
transaction's cleanup — pure churn. The driver's window advances, so production
never does this, but it is now an explicit sweep invariant (R26-1 suspect 16): the
A/B's per-call input must be the *contiguous, advancing* production window. One residual
difference remains and is recorded as a sweep item, not fixed here: production's
*first* dispatch already carries a full `cacheSize` window (the runner waits for
`maxCache` before processing), whereas a fold's `i = 1..cacheSize` calls carry
1..120 bars. So an early fold's controller is colder than production's would be at
the same bar; whether that should be reconciled (e.g. require `testStart >=
cacheSize`, or warm from bar 0 with a full first window) is a deliberate decision
for R26-1, not an accident of the fix.

**Hardening (component, defence in depth).** `_updateOpenTrades` should ignore any
candle whose timestamp is not strictly after the open trade's timestamp, so an
out-of-order or over-wide window can never close a trade before its entry. This is
a no-op for production input (one new candle per call) and must not move a golden
fingerprint. Related, latent: `insertTradeStmt.run` is not wrapped, and
`open_trades.timestamp` is a PRIMARY KEY, so a duplicate-timestamp window would
throw out of `getSignal` instead of degrading.

**Why no test caught it.** There was no test of the A/B's *input contract*: the
existing `analyze.test.js` controller sections assert a finite position series,
the audit's teeth and the determinism of two identical runs — all of which hold
whether the window is right or wrong. The regression guard is the first item in
`ROADMAP.md` round 26 (`test/…/analyze.test.js`: assert `recentCandles.length <= 1`
and an input length `<= cacheSize` on a multi-hundred-bar fold).

**Status: FIXED in round 26 (R26-0).** What landed, and one deviation from the
plan worth recording:

- `analyze.js` `makeControllerModelFactory` now feeds
  `candles.slice(max(0, i - cacheSize), i)` in `fit()` and
  `candles.slice(max(0, t + 1 - cacheSize), t + 1)` in `predict()` — the same shape
  `legion/workers.js` passes. `analyze.test.js` gained two contract checks with a
  recording controller: every input is `<= cacheSize` candles, and each input is
  exactly the contiguous, advancing production window (which also pins suspect 16 —
  no back-in-time window).
- `_updateOpenTrades` gained the entry-timestamp guard (a trade is only closed by a
  bar strictly **after** its entry; a timestamp that cannot be ordered falls back to
  the old scan rather than freezing the book). `core.test.js` gained three guard
  checks (before-entry, entry-bar, later-closes), two window-churn checks
  (`recentCandles <= 1` for the window, `> 1` for the prefix — so the guard test is
  not vacuous), and one duplicate-open-trade check.
- The open-trade insert in `getSignal` is wrapped: a duplicate timestamp (or any
  write failure) is counted in `_globalAccuracy.openTradeWriteErrors` and warned,
  never thrown out of `getSignal`. `core.test.js` proves it by forcing a collision.
- **Deviation — three controller fingerprints were deliberately re-frozen.**
  `golden.test.js`'s controller block was fed the whole growing candle prefix (the
  #33 input shape itself). The guard makes that shape behave exactly like the window
  (verified: prefix-with-guard and window produce *identical* `ctl:*` hashes), so
  the block was switched to the production window and `ctl:finalSignal`,
  `ctl:signalTrajectory` and `ctl:accuracyTotals` were re-frozen
  (`224a8b19/17d78ef3/a0ece37d` → `a7b13a39/5d341253/09d8fb5a`). `ctl:signalCount`
  and `ctl:lastTrainingStep` are unchanged and all six `hm:*` fingerprints are
  untouched. The old values pinned the mislabelled stream, so re-freezing is the
  correct outcome; the plan had assumed the guard would be a no-op on every input,
  which this measurement disproved. Recorded in `RUNBOOK.md` §6.

### 34. The two candidate families are mapped to positions by two incomparable policies, so turnover/participation comparisons confound the mapping with the signal

The controller path emits `probToPosition(prob, { deadZone: 0.05, scale: 1 })`
(`walkforward.js:88`) — a dead zone that abstains below ±5 % confidence and a
linear rescale above it. The signal family emits `clampPosition(z, { saturation:
2 })` (`analysis/features.js`) — `z/2`, clamped, with **no dead zone**. Neither
`--position-policy` nor `positionPolicy` reaches the signals (`makeSignalForVariant`
returns `variant.signal(view, test)` directly). Consequences: the reported
`nonZeroFraction` / `meanAbsPosition` / `turnover` / `breakEvenCostBps` of a signal
and of the controller are measured under different mappings, so §7.4's "signals
trade 17-64× the baseline" is partly the policy difference rather than the signal,
and §7.5's "meanAbsPos 0.0375" is the dead zone plus a low-confidence model. Any
turnover experiment must first put both families through one documented
confidence→position pipeline. **Not fixed**; it is round-26 item R26-3.

**Status: FIXED in round 26 (R26-3).** There is now ONE pipeline: signals emit a
clamped causal z-score as a *signed confidence* in [-1, 1], the controller emits
`(prob−50)/50`, and both go through the SAME
`confidenceToPosition(confidence, policy)` (`analysis/walkforward.js`) with a single
run-level `POSITION_POLICY = {deadZone: 0.05, scale: 1}`. `probToPosition` is
re-expressed through it (byte-identical on the whole controller domain, pinned).
The raw pre-policy confidence is journaled beside the emitted positions in
`folds.jsonl`, every run records a `policyRoundTrip` certificate, and
`restateReportAtPolicy(report, policy)` lets a dead-zone/scale/holding sweep be pure
post-processing (pinned: the scored policy reproduces the emitted positions and the
pooled Sharpe exactly). Proved by `analysis.test.js` (the exact pipeline, the
prob-domain equivalence, the round-trip detector) and `analyze.test.js` (the
journaled confidence, the certificate, a wider dead zone abstaining more).

### 35. The A/B 'controller' rows never say whether the model trained, whether it abstained, or whether the warm-up threw

`makeControllerModelFactory` computes `warmErrors`, `folds`, `undertrained`,
`trainingSteps` and `quarantinedRows` in `stats()`, and nothing reads it: the
report has no model diagnostics. So "the baseline has no edge" cannot be
distinguished from "the baseline never trained" (or "every warm-up call threw",
which #33 makes a live possibility) from the artifact alone — the exact gap
§7.5 flagged. The `undertrained` guard is also `testStart >= warmup` (40) rather
than the model's own readiness signal (`trainingSteps > 0`), so with the default
`trainSize = 60` it can never fire. **Not fixed**; round-26 item R26-2.

**Status: FIXED in round 26 (R26-2).** The readiness gate is now
`trainingSteps > 0` (a fold whose controller never trained abstains); `warmup` is
kept as a *reported* statistic (`stats().undertrained`) rather than a gate.
`stats()` also reports the label base rate, the resolved-barrier split, a proper
Brier skill score against the base-rate forecast, a chance-corrected accuracy, the
quarantined-row and dropped-candle counts, and a three-state `status`;
`makeSignalForVariant` hands each fold's stats to the driver, which pools them
into a per-variant `model` block in `report.json` (null for a pure signal
candidate) and a `models:` summary line in the run summary. Proved by
`core.test.js` section I (label counters + SQLite round-trip + dropped-candle
diagnostic) and the `analyze.test.js` R26-2 checks (base-rate vs skilful vs
not-trained, the readiness abstention, and the report/summary block).

### 36. The two-barrier trade labeler resolves an unresolvable bar to the take-profit, fills a gapped stop at the stop price, and never labels a trade that does not trigger a barrier

`hivemind/controller/trades.js#_updateOpenTrades` decides a trade's label from the
first candle that crosses either barrier:

```js
const hitTakeProfit = isLong ? candle.high >= trade.sellPrice : candle.low  <= trade.sellPrice;
const hitStopLoss   = isLong ? candle.low  <= trade.stopLoss  : candle.high >= trade.stopLoss;
if (hitTakeProfit || hitStopLoss) {
    const exitPrice = hitTakeProfit ? trade.sellPrice : trade.stopLoss;
    const outcome   = hitTakeProfit ? 1 : 0;
```

Three consequences, all one-sided:

1. **A bar that spans both barriers is booked as a win.** The take-profit is tested
   first, so a candle whose range contains both the TP and the SL is labelled
   `outcome = 1` — but with TP = `atrFactor`·ATR and SL = `stopFactor`·ATR and the
   shipped factors (`legion/config.js`: `baseAtr: 2`, `baseStop: 1`) the stop is
   *half as far*, so the stop is the likelier intrabar touch. The OHLC bar cannot
   resolve the order, and the code resolves it optimistically. Measured on the 7
   audited 1h symbol files (ATR14, entry at the previous close): **0.028 % of bars
   (1 in ~3,600)** have both `entry + 2·ATR` and `entry − 1·ATR` inside their range,
   and **1.0 %** span ≥ 3·ATR. Small, but strictly a mislabel of the same class as
   #33, and it grows with volatility clustering.
2. **A gapped stop is filled at the stop price.** `exitPrice = trade.stopLoss`
   assumes a stop order fills exactly at its trigger, so every loser is recorded
   at −`stopFactor`·ATR even when the bar opened or traded far through it. That is
   the classic optimistic-backtest fill assumption; it biases the *labels* (not the
   scored PnL — positions are scored on bar returns, so the barrier prices never
   enter a reported Sharpe) toward under-stating losses.
3. **A trade that never touches either barrier is never closed and never labelled.**
   `_updateOpenTrades` only closes on a trigger, and `_processClosedTrades` only
   trains on rows in `closed_trades`, so an untriggered trade is an open row that
   trains nothing, forever. `open_trades` therefore has no cap (measured 7-20 rows
   warm on 600 synthetic bars; a long production run accumulates them), and each
   `getSignal` runs two full-table `SELECT`s (`open_trades`, `closed_trades`) plus a
   per-open-trade scan. The standard remedy is a **time barrier** — the third
   barrier of the triple-barrier label (López de Prado 2018, ch. 3; the project
   already cites the triple-barrier label literature): close at the horizon's
   expiry and label from its return.

**Status: FIXED in round 26 (R26-11).** The labeler is now policy-aware
(`_labelPolicy` ∈ {`optimistic`, `conservative`, `triple`} plus the run-level
`_labelHorizonBars`) and each policy addresses one consequence above:

1. **`optimistic`** is the shipped two-barrier rule, unchanged and still the
   default, so every golden fingerprint is untouched (the round-26 invariant: a
   default-behaviour change is forbidden);
2. **`conservative`** resolves a both-barrier bar to the STOP (stop-first tie-break)
   and fills a gapped stop at the bar's worst traded price
   (`isLong ? Math.min(stopLoss, open) : Math.max(stopLoss, open)`) instead of the
   trigger price;
3. **`triple`** is `conservative` plus a time barrier at `_labelHorizonBars`: an
   untriggered trade closes at the horizon bar's close and is labelled from its
   return (the third barrier of the triple-barrier label, López de Prado 2018, ch. 3),
   so an untriggered trade is no longer an open row that trains nothing forever.

Because a label change is a *training-set* change, the two non-default policies ship
as opt-in A/B **variants** (`label-conservative`, `label-triple`; `kind: 'label'`,
controller-scoped), never in the default 15-candidate roster: `--label-policies`
appends exactly them, `--label-policy=<name>` sets the run default, and
`--label-horizon=<bars>` sets the time barrier. The shipped labeler, the default
roster and all 11 golden fingerprints are unchanged. The trade's holding period and
time-barrier resolution are counted (`heldBarsSum`/`heldBarsCount`/`heldBarsMax`,
`resolvedTimeBarrier`) and persisted, so the label *lifecycle* is observable (see
#37/R26-2). Pinned by `core.test.js` section J (browser + native SQLite) and
`analyze.test.js` (the variant rostering, the controller-level policy override, the
recorded `labelPolicy`/`labelHorizonBars`, and the named error on an unknown
policy).

### 37. The A/B never reports the label base rate, so a model's 'accuracy' has no reference point

With the shipped factors the take-profit is twice as far as the stop, so the stop
triggers first far more often: over 600 synthetic bars, same seed and data, the
production-shaped window gives **155 wins / 411 losses** (base rate ≈ 27 % TP),
and the prefix gives 322/248 — the base rate itself is a function of the #33
window. `getSignal` computes `tradeAcc = wins/total` and `trueAcc =
realPoints/totalPoints` into every signal, but the A/B neither carries them into
`report.json` nor gives them a reference, so "the baseline's accuracy is 71 %"
cannot be read as skill or as the base rate. (The bookkeeping arithmetic is
correct — `realPoints` accumulates exactly `y·conf + (1−y)·(100−conf)`, the linear
proper scoring rule `1 − |y − p|` — it is the missing *baseline* that makes it
uninformative.) This is #35's sibling: #35 is "we cannot tell whether it trained",
#37 is "we cannot tell whether what it learned is better than the majority class".
Fixed with R26-2/R26-8: the per-fold label counts and the base rate, a **skill
score** against the base-rate forecast (Brier skill score; Heidke-style
chance-correction), and the calibration reading, all reported beside the accuracy.

**Status: FIXED in round 26 (R26-2).** Every scored closed trade now contributes
to `resolvedTakeProfit`/`resolvedStopLoss` and to the Brier components
(`brierSum`/`brierCount`), persisted with the existing accuracy counters. The A/B
computes, per fold and pooled across folds, the **label base rate**, the Brier
skill score against the base-rate forecast (`1 − BS/BS_base`, a *proper* score, so
hedging to the majority class cannot earn skill) and a chance-corrected accuracy,
with a three-state `status` (`not-trained` | `base-rate` | `skilful`). The
`analyze.test.js` R26-2 checks pin all three states and the base-rate reference
directly; `core.test.js` section I pins the underlying counters and their SQLite
round-trip.

### Checked clean by the sweep (recorded, not defects)

- **`wins`/`losses`/`realPoints`** are a correct linear proper scoring rule, as
  decomposed above (verified by reading; the `confidence < 0` untrained rows are
  excluded from the accuracy counters but still trained, which is the documented
  intent).
- **`insertTradeStmt`'s duplicate-timestamp PRIMARY KEY** on `open_trades` is not
  reachable through the driver contract: a trade is only opened when a candle was
  newly inserted, and a repeated window re-inserts nothing, so no second trade with
  the same timestamp is written. A probe calling `getSignal` twice with an
  identical window threw nothing (the second call's `recentCandles` was empty). It
  remains reachable only via the back-in-time window the driver forbids (suspect
  16), so it stays a hardening item under R26-0 rather than a live defect.
- **`_updateOpenTrades` closes nothing before its entry** under the production
  window: measured 0 pre-entry closes over 600 window-shaped calls (the counter
  only moves under the prefix shape or a back-in-time window).
- **Only the `positive` polarity is exercised by the A/B**, while production
  selects over `positive` and `negative` (verified by reading: the factory
  hard-codes `'positive'`). Recorded as a coverage limitation and a sweep
  invariant, not a defect.

## Found by the round-26b implementation review (#38, #39, #40, #41 — all fixed)

The final review of the round-26 code read the *shape* of every value flowing
between the new layers, rather than only the numbers the tests pinned, and found
four defects that no existing check could see because every fixture was too easy
(each passed a shape the product never produces). #38/#39/#40 are value defects;
#41 is a structurally-unreachable field whose reader promised the opposite.

### 38. The decision-grade magnitude readout read the paired difference as a scalar, so its cheapest-flip branch was dead in production

`nextRunPlan`'s `cheapestFlip` (R26-8) offers a *magnitude* hint when the binding
hurdle is the paired cluster Sharpe difference: "the test needs roughly
`1.96 × seCluster`, your difference is `d`". It gated that branch on
`isNum(check.sharpeDifference)` — but `pairedPromotionTest` returns
`sharpeDifference` as the whole `pairedClusterTest` block
(`{ available, value, se, t, df, ... }`), not a scalar. `isNum(<object>)` is
always false, so on every real report the branch never fired and the fallback
("the binding hurdle is: …") was returned instead. The `analysis.test.js` fixture
had passed `sharpeDifference: 0.05` (a number), so the test exercised a shape the
product never produces. **Fixed:** `cheapestFlip` reads `.value` (still accepting
a bare number), and the fixture now carries the real object
(`{ value, se, nClusters }`) so the branch is proved on the production shape. A new
`analyze.test.js` check also drives a real **2-stream** `runAnalysis` and asserts the
decision block's `nextRunPlan.pairedUnits` (and the journal decay and the
leave-one-fold range) are genuinely populated end-to-end — the integration shape
this defect hid behind.

### 39. `pairedClusterSignTest` compared `all-but-cluster-c`, so the "breadth" sign test was a leave-one-out stability test, not the per-window test it documents

The breadth statistic replaced the raw `>= 0.5` win-fraction hurdle and its own
comment/reader say "**on each cluster**, did the candidate's statistic beat the
baseline's?". The implementation copied `pairedClusterTest`'s leave-one-out call
`statistic(concatClusters(clusters, c))` — which is "every cluster EXCEPT c", the
jackknife input — so it computed a sign test over leave-one-out panels. That is
the *stability* question (now `clusterStability`, R26-7), not the win-count
question, and it would not have changed a promotion (round 26 moved
`requireBreadth` out of the shipped gate), but it corrupted every reported
`promotionTest.breadth` number and the "passed 8/8, hit its 2⁻ⁿ floor" reading of
the round-25 runs. The `analysis.test.js` fixture was a degenerate all-A=1 vs
all-B=0 panel, for which the per-window and leave-one-out forms give the same
5/5, so it could not see the defect. **Fixed:** `pairedClusterSignTest` compares
`statistic(clustersA[c])` to `statistic(clustersB[c])` (ties dropped), and the
fixture is now discriminating — 4 wins / 1 loss / 1 tie on a panel where the
leave-one-out form reads 6/6. The breadth numbers recorded in `RUN-ANALYSIS.md`
§7 were produced by the old form and are superseded.

### 40. `decisionReport`'s `training.labelDistribution` read a field the model summary never produces, so it was always null

The training block (R26-8 clause 1) carries `labelDistribution` to state the label
base rate, the resolved-barrier split and the holding distribution. It read
`candidate.model.labelDistribution` — but `summarizeModelStats`/`labelDiagnostics`
expose those as `baseRate`, `resolved {takeProfit, stopLoss, total}`, `heldBars
{count, sum, max, mean}` and `status`; nothing in the codebase ever sets a
`labelDistribution` field, so the value was a silent `null` on every report (exactly
the "a null a reader could mistake for a healthy zero" failure the module exists to
prevent — and the same shape-mismatch class as #38). The data was still available
inside `training.model`, so no verdict moved, but the field was dead. **Fixed:**
`training.labelDistribution` is now derived from the model diagnostics
(`status`, `baseRate`, `resolved`, `heldBars`) and remains an explicit `null` only
for a pure-signal candidate that has no model block at all; pinned by a new
`analysis.test.js` §AK check.

### 41. The decision report's `family` seed fields read a `replication` shape no producer supplies, so they were unreachable and their readers promised the opposite

The `family` block (R26-8 question 5) carries `seedDistribution`,
`varianceComponents` and `pairedVarianceRatio` — the R26-13 cross-seed summary —
reading `replication.seedDistribution` / `.varianceComponents` /
`.pairedVarianceRatio`. But the only caller (`analyze.js:runAnalysis`) hard-codes
`replication: null`, and the actual producer, `replicateAnalysis`, returns
`{ seeds, variants, byVariant, commonRandomNumbers, reader }` — keyed `byVariant`,
with the variance decomposition **nested** as `seedDistribution(...).components`
and no aggregate `pairedVarianceRatio` at all. So even had the aggregate been
threaded into a report, the reads would still have missed, and every real report
showed all three as `na('a single-seed run has no seed distribution (use
--seeds=a,b,c)')` — a reason that tells the user a `--seeds` run *populates the
report's field*, which it does not (the aggregate is written to a separate
`replication.json`). Same shape-mismatch class as #38/#40, and the same dead-field
pattern; no information is lost (`replication.json` genuinely carries the
aggregate), but the report's reader lied about where to find it. **Fixed:** the
three `na` reasons and the block's `reader` now say the cross-seed distribution is
aggregated into `replication.json` by a multi-seed run (not into the per-seed
report), the module header no longer claims "the `family` block prints the seed
distribution when a multi-seed run supplied one", and the §AK check now feeds the
**real** `byVariant` producer shape and asserts it does not silently populate the
fields (plus that each reason points at `replication.json`).

### Note (not a defect): the `netSharpe || -Infinity` ranking in `analyze.js`

The decision block's featured-row selection ranked by
`b.pooledMetrics.netSharpe || -Infinity`. A candidate whose pooled net Sharpe is
exactly `0` is falsy, so it was ranked as `-Infinity` and could lose to a
negative-Sharpe candidate. The value is almost never exactly zero (and the
featured row is normally the promoted candidate), so this never bit a real run,
but it is now `Number.isFinite(x) ? x : -Infinity`.

### Documented gap (not a defect): the entry-to-training age is not yet measured

R26-11's spec asks the label lifecycle to surface the **entry-to-training age**
distribution — the gap between a trade's entry bar and the bar at which
`_processClosedTrades` actually consumes (labels) it — because that is what makes
the drain's `processCount = 1` FIFO lag visible. What landed and is reported is the
**entry-to-close holding period** (`heldBarsSum`/`heldBarsCount`/`heldBarsMax` in
`trades.js#_updateOpenTrades`, persisted with the accuracy bag in
`hiveMindController.js`), which is the labeller's own horizon — a *related but
different* quantity. The training-age metric needs the current candle timestamp
threaded into `_processClosedTrades`' hot path (a state-affecting change to a locked
module), so it was **not** implemented blind; it is tracked as `TODO.md` #62. The
`decision.js` `training.reader` string, `ROADMAP.md` (R26-11 spec + *Landed*) and
`TODO.md` item 56 now say so explicitly. No metric or verdict moves.

## Found by the native `npm test` after the round-26b review (#42 — fixed)

### 42. The concurrent A/B dropped the in-process signal function, so any `concurrency > 1` run with the audit on (the default) crashed

`evaluateABAsync` (R26-4) lets the SCORED fold-pass run in a worker
(`foldExecutorFor`), and to avoid the serial path it nulled `signalForFold`
whenever an executor existed (`signalForFold: executor ? null : foldFor`). But
`walkForwardEvaluateAsync`'s look-ahead audit always runs **in-process**, because
it re-fits the signal on PERTURBED views and a fold executor has no view channel.
So `auditNoLookahead` called `signalForFold(...)` on `null` and threw
`TypeError: signalForFold is not a function` — every `npm run analyze` with
`--concurrency > 1` (and `audit` on, which is the default) died at the first fold.
The native acceptance test `test/node/parallel_folds.test.js` caught it (it is the
only test that runs a real worker-backed `runAnalysis` with the audit on); the
browser suite missed it because its `evaluateABAsync` fixture used `audit: false`
and its `walkForwardEvaluateAsync` fixture passed a `signalForFold` alongside the
executor. **Fixed:** `evaluateABAsync` now always builds the folded signal function
(`signalForVariant(variant)` — a cheap closure over the shared factory) and passes
it as `signalForFold`; the executor still owns the scored pass, and only the audit
calls the in-process function. `walkForwardEvaluateAsync` also now throws a **named**
error when `audit` is requested with only a `foldExecutor` (instead of a bare
`TypeError` mid-audit). The browser R26-4 concurrency check was strengthened to run
the audit ON as well as off (folded into the existing check), so the path is now
covered without a `node` run. No count moved (`analysis` 562, `analyze` 222,
ledger 2289).

## Found by the `20260922T204248-seed1` round-26 power run (#43, #44, #45) — sharpened by the round-27 plan; plus #46/#47/#48 found by the round-27 sweep, #49 by the second sweep, #51 while implementing R27-1, and #52 by the native gate

The first full-size run made *with* the round-26 corrections (8 streams × 600 bars,
288 folds, 4,320 pooled bars, 15 variants; `RUN-ANALYSIS.md` §10) exposed three
defects of the *reading* kind rather than the arithmetic kind: the run's own numbers
are reproducible end to end (§10.6), but three of the seven mechanism candidates turn
out to be untested duplicates of the baseline, and the decision block's training
answer describes only the winning row. All three are report/roster wiring; none
moves a scored number.

The **round-27 planning sweep** (`PLAN-round27.md` §2) then re-derived #43 and #44
from the code and found both to be stronger — and *provable* — versions of the
original diagnosis, and added **#46/#47/#48**, all in the same class (a controller or
a report that can misdescribe itself). A **second sweep** (the code read against the
round-26 journal) then added **#49**: the holding period is structurally always 1
(`heldBars {count=sum=185937, max=1}`), because `_updateOpenTrades` counts bars only
within the one newly-inserted candle it is handed per call — so `heldBars` is a false
diagnostic, `resolvedTimeBarrier` can never fire, and the `triple` label policy's
vertical barrier is unreachable for `horizonBars > 1`. #49 is what makes sample
weighting inert even if wired: 1-bar labels do not overlap, so AFML ch.4 uniqueness is
exactly 1.

- **#43 is not a wiring gap, it is a mathematical no-op.** Sample weighting is inert
  in the **shipped pipeline** as well as the A/B, because every drain is a batch of
  one label and `spanWeightsFromEntries([k], cfg) === [1]` for every normalization
  (measured). No `configure` can fix it; the mechanism has to be redefined for a
  streaming trainer.
- **#44 is not "the path is not reached", it is "the path cannot act".** The only
  reader of `_getGlobalLSHCandidates` feeds `broadcastMemory`, whose returned memory
  set is *discarded* (it is the signal payload, and `translateMemory` receives `[]`),
  while the live retrieval path (`_retrieveTopRelevantProtos`) reads the buckets
  directly and consults neither flag. And `pca-hash` is live only via that
  *undocumented* reader, partly through a data-dependent `Math.random()` draw count.

### 43. `sample-weights` is inert by construction — in the shipped pipeline, not just the A/B

The `VARIANTS` roster entry for `sample-weights` carries `controllerScoped: true`
and **`configure: null`**, so nothing ever sets the controller's
`_sampleWeightConfig`. That was the original finding. The round-27 sweep shows a
**`configure` alone would still be a no-op**:

- `_processClosedTrades(processCount)` reads `LIMIT processCount` closed trades and
  calls `_sampleWeightsForBatch(trades)` on *that batch*; the weight for
  `rowIdx` comes from `spanWeightsFromEntries(entries, cfg)`.
- The A/B calls `getSignal(candles, 1)` and production calls it with
  **`CONFIG.baseProcessCount = 1`** (`legion/config.js:32`, threaded through
  `legion/workers.js:90`). So the batch is always exactly one label.
- Measured on the pure module: `spanWeightsFromEntries([k], { horizonBars: h })`
  returns `[1]` for `normalization: 'none' | 'mean1' | 'sum1'` and for every `h` —
  `mean1` renormalises a one-element vector to exactly 1. (Contrast: ten
  consecutive entries at `horizonBars: 20` give 0.825–1.355 with effective sample
  size 9.64 of 10, so the estimator itself is fine — it is the *batch* that is
  degenerate.)

Therefore **sample-uniqueness weighting is dead code in the shipped pipeline**, and
TODO #5's experiment ("a run showing which normalisation/floor improves PSR/DSR") is
unanswerable by *any* run: the weights are always 1, so the weighted objective is
the unweighted objective. What was measured on the run is the consequence:
**position series byte-identical to the baseline on 288/288 folds** (max abs diff 0),
pooled Sharpe identical to 16 significant digits (`-0.11469136136703602`), identical
turnover/tradeCount/DSR — while the report printed **5 reasons**
(`pooled DSR … < 0.95`, `fold win fraction 0 < 0.5`, `paired cluster Sharpe
difference … dSharpe=0 se=0 t=0 df=35 p=0.5`, `cluster stability 0 of 36`), every
one an artefact of comparing a series with itself. That inflates `K` (the DSR
deflation and the family-wise search) by one and manufactures evidence against a
mechanism that never ran.

The wiring *is* exercised, but only by a synthetic variant inside `analyze.test.js`
(`configure: (c) => { c._sampleWeightConfig = { on: true }; }`), so the suite was
green while the shipped candidate was inert — the "the test pins a shape the product
never produces" pattern of #38/#39/#40.

**Fix (round 27, `PLAN-round27.md` R27-3):** define the streaming analogue properly —
a bounded ring of recent label spans, each new label weighted by its **causal**
average uniqueness against the spans already observed, `mean1`-renormalised so the
effective learning rate is unchanged; the run reports the weight distribution and
its effective sample size, so a weight vector that is all 1 is *visible*; and R27-1's
liveness certificate reports the candidate `inert` automatically if it ever happens
again. The `null`-config path stays bit-identical (golden fingerprints unchanged).

### 44. `multi-probe`/`query-mod` *cannot* reach the controller path; `pca-hash` is live only via an undocumented reader (and a data-dependent RNG draw count)

`multi-probe` (`_multiProbeConfig`) and `query-mod` (`_queryModConfig`) *do* set
their flags (on the controller and on the pre-created `_hivemind`), and their flags
*are* read — inside `_getGlobalLSHCandidates`. The round-27 sweep traced every
reader; the claim is static, not statistical:

- `_getGlobalLSHCandidates` has exactly **one** caller in the tree: `transfer.js:74`,
  inside `broadcastMemory`.
- `broadcastMemory` is **read-only on the model**: the prototype methods it calls
  (`_computeProtoUtility`, `_kernelSimilarity`, `_projSimilarity`,
  `_computeMemberAffinity`, `_sortedByUtilityDesc`, `_sortByUtilityDescInPlace`)
  only read; its result is returned as data.
- Its only consumer, `hiveMindController.getSignal`, assigns
  `this._memoryBroadcast = …` — used for the **signal payload** — and adds
  `totalBroadcast` to the `memoriesSent` counter. Nothing is injected, because
  `translateMemory(sharedMemories, …)` is called with `sharedMemories = []` (the A/B
  never passes shared memories) and early-returns `{ memoriesInjected: 0, … }`
  without mutating any state.
- The **live** retrieval path is a *different* reader: `retrieval.js:251`/`:303`
  probe `this._semanticLSHBuckets` directly, with their own flip loop and their own
  random multi-bit probes, and consult **neither** `_multiProbeConfig` nor
  `_queryModConfig`.

So on a single-controller fold those two flags **cannot** change a position — they
are not "inert in this regime", they are off the model path. Measured on the run:
**both byte-identical to the baseline on 288/288 folds** (max abs diff 0), with
identical pooled metrics and model diagnostics.

`pca-hash` is the opposite case and the finding is subtler: it is live **only**
because `_refreshLshHyperplanes` mutates `_lshHyperplanes`, `_lshAlignedRank` and
`_semanticLSHBuckets`, which `_retrieveTopRelevantProtos` reads — i.e. via the
*undocumented* reader, not the one the module's own docs name. Worse, that reader's
random multi-bit probe draws `Math.random()` a **bucket-content-dependent** number of
times (up to `maxCandidateCap`), so replacing the hash basis changes the RNG draw
count and therefore the whole downstream trajectory. That makes `pca-hash` a
legitimate live candidate *and* means "the run differs" is not by itself evidence
that the intended mechanism caused the difference.

Measured on the run: `pca-hash` differs on **6/288** folds, `surprise-gate` on
99/288, `homeostasis` on 246/288. So **3 of the 7 mechanism candidates**
(`multi-probe`, `query-mod`, `sample-weights`) contribute 15 fabricated keep-off
reasons between them and make `K = 15` count three untested arms. Independent
corroboration: `familyCorrelation.effectiveTrials = 6.10 of 14`.

**Fix (round 27, `PLAN-round27.md` R27-1/R27-2):** a `liveness` certificate computed
as pure post-processing of the already-journaled fold signals (no locked module
touched); an `appliesTo: 'controller' | 'broadcast' | 'agnostic'` taxonomy, with
`multi-probe`/`query-mod` marked `not-applicable` on the controller roster and one
explanatory reason instead of fabricated hurdles; exclusion of
`inert`/`skipped`/`not-applicable` candidates from `K` and the family-wise search
(with `trialsRoster`/`trialsInactive` recorded); the `pca-hash` note corrected to name
`_retrieveTopRelevantProtos`; and three tests that pin the whole claim (the flag
changes `broadcastMemory`'s returned set; the flag does **not** change `getSignal`
positions; the hash refresh **does** change them).

**Round-27 run update (see #53).** The "`pca-hash` ... 6/288 folds" measurement above
was taken on the round-26 8-stream × 600-bar run. On the round-27 Step-1 liveness run
(2 streams × 200 bars, 18 folds) the same variant is certified **inert (18/18)** —
so its liveness is **budget-dependent**, not constant. "Reachable via
`_retrieveTopRelevantProtos`" (the R27-2 taxonomy claim, which the tests pin) remains
true; "live on the shipped roster" does not hold at every scale, and the fallback
inert-reason text must stop implying it is structurally unreachable.

### 45. The decision block's training answer describes only the winning row, so it asserts something false about the run

`report.decision.training.model` is `{ available: false, reason: "no model
diagnostics were collected for this run (a pure-signal or bare run)" }`. The reason
is false about the *run*: seven variants are trained controllers with full
diagnostics (170,004 training steps each, `warmErrors 0`, base rates and skill
scores). The block is built from the **featured (winning) row** only —
`decisionReport({ model: featuredRow ? featuredRow.model : null })` — and this run's
winner is `sig:momentum`, a pure signal with no model block, so the winner's `null`
is rendered with a reason that generalises to the whole run ("this run"), exactly the
"a null a reader could mistake for a conclusion" failure `decision.js` exists to
prevent (same class as #37). `training.labelDistribution` is consequently `null` too
(correct for a signal, unhelpful here). No verdict moves. **Fix (R27-5):** when the
featured row has no model but the *baseline* (or any family row) does, report the
baseline's diagnostics under an explicit referent (e.g. `model: {…, referent:
"baseline"}`) and change the `na` reason to name what is actually missing ("the
*featured* candidate is a pure signal; the baseline's diagnostics are in
`report.baseline.model`"), pinned by an `analysis.test.js` check on a signal-wins
fixture — the run's real shape.

### 46. A degraded prediction is read as a maximal short, and a rejected training row corrupts the step counter

Two fail-open branches on the controller's input path:

- `HiveMind.predict(inputs)` returns **`0`** for an invalid input
  (`hiveMind.js:129`). The controller tests `isValidNumber(predictionVal)` — true for
  `0` — so `prob = 0`, `confidenceFromProb(0) = (0 − 50)/50 = −1`, and with the
  shipped `POSITION_POLICY { deadZone: 0.05, scale: 1 }` that is a **full short
  (−1)**, not an abstention. A model that cannot read its input should abstain; today
  it takes the most extreme legal position.
- `HiveMind.train(inputs, target, w)` uses a **bare `return`** for an invalid input
  (`hiveMind.js:136`) — i.e. `undefined`. `_processClosedTrades` assigns it straight
  into `this._globalAccuracy.trainingSteps = result`, so the counter becomes
  `undefined`; `_saveGlobalAccuracy` then binds `undefined` into a `NOT NULL` column
  **inside a transaction**, and `getSignal`'s `finalScore` test (`trainingSteps > 0`)
  silently reads false, and the readiness gate (`ready = trainingSteps > 0`) would
  abstain forever.

Both are latent on today's data path — the feature vector is validated numbers with a
`0.5` fallback — which is precisely why they are worth removing rather than merely
never observing: they are the "a faulty controller silently corrupts a reading" class
the round-27 request asked to rule out. **Fix (R27-4):** `predict` invalid → `NaN`
(the controller's documented `−1` abstention route); `train` invalid → the current
step count plus a `rejectedTrainRows` counter; the controller's predict guard
restated as "finite **and** `>= 0`, else abstain"; plus a `rejectedTrainRows` /
monotone-`trainingSteps` test.

### 47. `undertrainedFolds` is a counter that can never fire

`makeControllerModelFactory` computes `undertrained = !(testStart >= warmup)` with
`warmup = 40`, while the default split's first test bar is `≥ trainSize = 60`. So
`undertrainedFolds` is **always 0**, and the run prints it in the model block beside
real diagnostics (`folds`, `notTrainedFolds`, `warmError`s, base rate, skill) where a
reader takes it as evidence the model was adequately warmed. This is the same class
as #35 (the readiness gate that could never fire); #35 replaced the *gate* with
`ready = trainingSteps > 0` but left the misleading *counter* behind. **Fix
(R27-5):** report `shallowHistoryFolds` (the `testStart < warmup` count, under its
true name) and a real `underTrainedFolds` derived from the fold's `trainingSteps`
against its available history; delete the ambiguous field.

### 48. `skipped` is reported but not enforced, and the stats schema lies about a type

- `evaluateAB` computes `skipped = !!variant.controllerScoped && model !== 'controller'`
  and records it — but still evaluates the variant and still passes it to
  `walkForwardSearch`, so on `--model=bare --variants=sample-weights` the row would be
  counted in `K` and carry five fabricated keep-off reasons. It does not bite the
  *default* bare roster (controller-scoped variants are filtered out of it), which is
  why this is minor rather than a second #43.
- `global_stats.value` is declared `INTEGER NOT NULL` while `brier_sum` is stored as
  a `REAL`. SQLite's INTEGER affinity converts only lossless values, so the float
  survives and every number is correct — but the schema claims a type the data does
  not have, and a future `CAST`/tooling assumption could silently truncate the Brier
  sum.

**Fix (R27-1/R27-4):** a `skipped`/`not-applicable` candidate is excluded from `K`
and the search and carries exactly one reason; `global_stats.value` is declared
`NUMERIC` (or the Brier sum is stored in integer micro-units).

### 49. `heldBars` is structurally exactly 1, and the `triple` label policy's vertical barrier can never fire

Found by the second round-27 sweep, reading the round-26 journal against the code
(`PLAN-round27.md` §2.7). `getSignal` calls
`this._updateOpenTrades(recentCandles)`, and `recentCandles` is **only the bars that
were newly inserted this call** (`src/hivemind/controller/candles.js`:
`INSERT OR IGNORE` + `result.changes > 0`). Both the A/B (`getSignal(window, 1)`,
window advancing one bar) and production (`legion/workers.js:39` passes
`state.cache.slice(-cacheSize)`, of which exactly one bar is new per call) therefore
hand `_updateOpenTrades` **one candle per call** in steady state. Inside it,
`barsAfterEntry` is a loop counter over that one-candle list, so whenever a trade
closes `barsAfterEntry === 1`.

Measured in `20260922T204248-seed1/report.json`:
`heldBars { count: 185937, sum: 185937, max: 1, mean: 1 }` — a "holding-period
distribution" with zero variance, over 185,937 closed trades. Consequences:

1. `heldBars` (R26-2's label-lifecycle diagnostic, and the quantity the round-27
   draft proposed to derive a uniqueness horizon from) is **false**: it is the
   position of the close within the current call's new-bar list, not the holding
   length.
2. `resolvedTimeBarrier` can never fire.
3. **The `triple` label policy's vertical barrier is unreachable for
   `horizonBars > 1`** (`src/hivemind/controller/trades.js:115`:
   `barsAfterEntry >= horizonBars`). With no `--label-horizon` the policy degrades
   to `conservative` as designed, but *even with* `--label-horizon=H>1` it still
   degrades to `conservative`, silently. So the R26-11 `triple` candidate is
   untestable as shipped.
4. A trade that never hits a horizontal barrier never closes and is never trained;
   with a working vertical barrier it would be labelled at `H` bars.

This is the enabling defect behind the sample-weighting question: the shipped
labeler produces 1-bar labels (`heldBars ≡ 1`), so AFML ch.4 average uniqueness is
exactly 1 (no two label spans overlap) and no wiring can make sample weighting
non-trivial on the `optimistic` labeler. **Fix (R27-4b):** pass the cached window
(`fullCandles`, already computed by `getSignal`) into `_updateOpenTrades` and compute
`barsAfterEntry` from it (bars strictly after the entry timestamp), leaving the
horizontal-barrier *fill* loop over the new bars so the optimistic/conservative
position series — and every golden fingerprint — are byte-identical. The count is
cache-bounded (`cacheSize − 1`), which is recorded. See `PLAN-round27.md` R27-3/R27-4b.

### Note (not a defect): `nextRun.pairedUnits.required.observed` is a requirement, not an observation

The console's `pairedClusters(obs)=37` and `nextRun.pairedUnits.required.observed = 37`
read like "37 clusters were observed", but the field is the *number of clusters a
paired test would need* to resolve the observed difference at 95 %
(`nClusters × (1.96·se/target)²` = 36 × (1.96 × 0.6136 / 1.1995)² = 36.19 → 37). The
run has 36 clusters. The reader string says this correctly; the field name does not.
Renaming it (`neededForObserved`) is cosmetic and bundled with #45's report work. **Fixed in round 27 (R27-5):** the field is now `neededForObserved` (with the generic `needed.observed` map kept alongside), pinned by `analysis.test.js` and the `analyze.test.js` consumer check.

### Note (not a defect): `partial-report.json` is less self-describing than `report.json`

The crash-recovery checkpoint is written after every variant and carries the
`baseline`/`candidates`/`familywise`/`costLadder`/`decision` blocks, but it lacks the
`forecast` block and the config-echo fields (`trials`, `gateOptions`, `saveInterval`,
`labelPolicy`, `labelHorizonBars`, `concurrency`, `intervalBars`, `commonRandomNumbers`,
`turnoverSweep`, `streamSelection`, `policyRoundTrip`). Every number it *does* carry is
correct, but a user recovering an interrupted run cannot read the gate semantics, the
searched-roster size the DSRs were deflated by, or the forecast panel from the partial
alone. **Fixed in round 27 (R27-5):** the config echo is now written into the
checkpoint from the first write (and asserted in `analyze.test.js`); only the
`forecast` block remains final-only, and `RUNBOOK.md` still lists the file as
"diagnostics".

**Round-27 implementation status (all four fixes landed; the round-27 tests are the acceptance criteria).** #43 is closed **not-applicable** for the stock `optimistic` labeller with the measured reason (labels do not overlap, so every AFML uniqueness weight is 1): `sample-weights` is removed from the default roster but stays resolvable as an opt-in, its causal-window estimator is the pure `causalWindowWeight` helper with reference-vector tests (`sample_weights.test.js`), and the A/B's `liveness` certificate reports it `inert` automatically if it is ever scored, with a reason citing the non-overlap (`analyze.test.js`, `controller_invariants.test.js`). #44 is fixed by R27-2: `multi-probe`/`query-mod` are `appliesTo: 'broadcast'` and `not-applicable` on the controller (one reason, outside K and the search), `pca-hash`'s note names `_retrieveTopRelevantProtos`, the taxonomy is printed by `--list-variants`, a broadcast-only flag is proved bit-identical through the model harness (`walkforward.test.js`), and a candidate identical to an earlier *live* one is certified `duplicate-of:<id>`. #45 is fixed by the baseline `modelReferent` (`analysis.test.js` signal-wins fixture). #46 is fixed by `predict` → `NaN` and `train` → the current step count plus `_rejectedTrainRows` (`sanity.test.js` browser + node, 60 checks). #47 is fixed by `shallowHistoryFolds` plus a fireable `underTrainedFolds` with an explicit `minTrainingSteps` floor and a per-fold training-step distribution (`analyze.test.js`). #48 is fixed by the `not-applicable` exclusion from K/search and the `global_stats.value` `NUMERIC` declaration. #49 is fixed by the window-derived `barsAfterEntry` (R27-4b): optimistic/conservative positions byte-identical, `heldBars` varying and capped at `cacheSize − 1`, and the `triple` vertical barrier reachable for `H > 1` (`core.test.js` browser + node, `controller_invariants.test.js`). The `restateReportAtCost` single-stream defect found while wiring R27-1 is recorded as #51.

### 51. `restateReportAtCost` fabricated a dependence panel for a single-stream report

Found while implementing R27-1's active-K restatement. `poolReports` returns a
single-stream report untouched (no `streamFoldLengths`), but `restateReportAtCost`
rebuilt the per-stream panel unconditionally, so restating a single-stream report
invented a bogus `dependence` block (a one-stream design effect) instead of carrying
the `null` the scored report had. **Fix:** `const hasPanel = Array.isArray(report.streamFoldLengths)
&& report.streamFoldLengths.length > 0`; the panel is rebuilt only when `hasPanel`,
otherwise the original `dependence`/`streamReturns` are carried through. The analyze
single-stream contract (`dependence === null`, `analyze.test.js` R26-7) is the
regression guard, and the equal-trials identity
`restateReportAtCost(r, cost, { trials: r.trials }).pooledMetrics === r.pooledMetrics`
now holds for single- **and** multi-stream reports.

### 52. A static CDN import leaked into Node again — the R27-6 node mirror died at link time

**This is a recurrence of #15.3**, which had been "fixed" per entry. Found by the
native `npm test` immediately after the round-27 implementation: the whole suite
was green except `test/node/controller_invariants.test.js`, which failed in 65 ms
with

> `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file and data
> are supported by the default ESM loader. Received protocol 'https:'`
> — `at getSourceSync (node:internal/modules/esm/load:46:11)`

The new node mirror re-exports its browser entry, the entry imported the sql.js
shim (`test/browser/shims/better-sqlite3.js`) *statically*, and the shim
statically imported its CDN runtime
(`import initSqlJs from "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js/+esm"`).
Node's default ESM loader resolves the entire static import graph while *linking*,
before any test body runs, and refuses any scheme other than `file:`/`data:` (plus
the built-in `node:`), so the mirror died during linking. The report showed only
`✖ test/node/controller_invariants.test.js … 'test failed'` — the mirror's own 16
checks never ran, so a reader could not tell which invariant had broken. The native
driver never *needs* the CDN (every mirror injects its own `ensureSql` — the real
`better-sqlite3`), but a static import is evaluated whether or not its binding is
used.

**Why #15.3's fix did not hold.** It made the one offending *entry* load the shim
lazily. Six other entries still import the shim statically — `bench`, `core`,
`features`, `legion`, `sanity`, `consolidation_worker` — harmless only because none
of them happened to have a node mirror re-exporting them yet. Any of them gaining a
mirror would have reproduced this exactly, and `controller_invariants` (R27-6) is
the one that did.

**Fix, in three layers.**
1. **Root cause — the shim itself.** `better-sqlite3.js` now imports its CDN module
   **lazily**, inside `__ensureSql()`, so the shim — and therefore *any* entry that
   imports it, statically or not — is loadable by Node. The browser harness is
   unaffected (it calls `__ensureSql()`, which now does the dynamic import). This
   removes the class of defect rather than one instance of it.
2. **Convention — the entry.** `test/browser/entries/controller_invariants.test.js`
   does not statically import the shim: `run()` lazily imports it and calls
   `shim.__ensureSql()` in the `else` branch of the `{ ensureSql }` option, exactly
   as `golden.test.js`/`homeostasis.test.js`/`lsh.test.js`/`sample_weights.test.js`
   do. Both layers are kept deliberately: the convention keeps the mirror's static
   graph free of browser-only modules (the thing #15.3 asked for), and the shim fix
   means a future entry that forgets the convention still cannot break the native
   gate.
3. **Guard — `test/node/mirrors.test.js`.** A new block (`staticImportsOf()`) walks
   the **static** (`import`/`export … from`) graph of each of the 43 node mirrors and
   fails if any specifier uses a scheme the default loader rejects. A dynamic
   `import()` inside a function body is deliberately *not* followed — it executes
   only on the browser path. Walking the whole graph (144 files reachable, including
   `src/`) rather than just the mirrors' own imports is what catches the
   shim-behind-an-entry shape that #15.3 and #52 both took; the pre-fix tree fails
   the guard, the current tree passes it.

No browser check count moved *at that point* (still **2347**;
`controller_invariants` still reported its 16); the node-only block ledger went
126 → **127**. (The round-28 implementation then moved five counts — `sample_weights`
45 → 57, `analysis` 566 → 586, `analyze` 245 → 255, `controller_invariants` 16 → 23,
and `lsh` 69 → 75 for the P2 retrieval-liveness section K — for a ledger of **2402**;
see `RUNBOOK.md` §6.)

## Found by the round-27 runs (R27-7a–d; `RUN-ANALYSIS.md` §13) and their round-28 coherence re-read (§14) — #53–#58, all FIXED in round 28, plus #59 (reported, not fixed)

The four operator runs were built to *exercise* the round-27 reading layer, and they
did: the liveness taxonomy, the reduced-K restatement, the reachable vertical barrier
and the per-kind forecast all behaved as documented, with no runtime warning in any
run and two cross-process bit-reproductions. Three reading defects survived, though,
and they are exactly the kind a real run (not a unit test) is needed to find. The
round-28 coherence re-read then added three more.

**Status (round 28 implementation): all six FIXED**, every one off the default path
(no golden fingerprint moved — `golden` 23/23), each with the test that pins it:

| # | fix | pinning test |
| --- | --- | --- |
| 53 | `pca-hash` and `sample-weights` carry **measured** `inertReason`s; the generic fallback no longer asserts structural unreachability (it names the scored path and the fold count) | `analyze.test.js` "a MODEL-scoped variant's inert reason can never be a structural claim", `R27-1/R28` inert-reason check |
| 54 | the emitted sample-weight stream is **mean-1** via `emittedWeightNormalizer` (a causal EMA of the raw weights), with `meanUnnormalised` reported beside it and a `scale` control arm; the controller summary's `min/max/mean` are the EMITTED stream | `sample_weights.test.js` §E, `controller_invariants.test.js` §D |
| 55 | `training.labelPolicy` = the **referent** model's policy, `runLabelPolicy` = the run flag; `familyCorrelation` carries `labels` and `familyPairLabel` resolves `maxPair` against the ACTIVE list; every hurdle carries its margin | `analysis.test.js` §AM, `analyze.test.js` "the summary maxPair names the ACTIVE arms" |
| 56 | `cheapestFlip`'s magnitude branch reads the **paired** SE and the **one-sided** cluster-t; `pairedUnitsNeeded` drops the cross-scale target and adds `neededForObservedPower80`; `nextRunPlan.scales` names each field's scale | `analysis.test.js` §AM (Step-2 shape: factor 1.058, 41 clusters; scale-separation fixture) |
| 57 | the raw fold-win / positive-fold fractions are **reported statistics** (`gated:false`); the shipped gate passes `rawFoldHurdles: false` and relies on the error-controlled cluster tests | `analysis.test.js` §AM (raw majority 1/3 fails, cluster sign test 6/6 passes), `analyze.test.js` gate check |
| 58 | the `sample-weights` reason names the ASSUMED span horizon and the measured holding period; the ring's span is a **causal** EMA of drained holding periods (or `--sample-weight-horizon`) | `analyze.test.js` R28 reason checks, `sample_weights.test.js` §E, `controller_invariants.test.js` §D causality check |

`METHOD.md` §4's premise is corrected in the same commit, and the recorded decisions
land in `METHOD.md` §7/§8/§9 and `DESIGN.md` §6.1.

### 53. `pca-hash`'s liveness certificate is run-dependent, and its generic reason asserts a structural cause the data falsifies

Step 1 (2 streams × 200 bars, 18 folds; `20260923T105845-seed1`) certifies `pca-hash`
**inert**, `identicalFolds 18/18`, `maxAbsDiff 0`, with the **generic** reason text

> `inert: identical to the baseline on all 18 folds (the mechanism never reaches the model path)`

That reason is wrong on its face. `pca-hash` is `appliesTo: 'model'`; `BUGS.md` #44
documents — and the R27-2 tests pin — that it *is* live via the undocumented reader
`_retrieveTopRelevantProtos`, and the round-26 `20260922T204248-seed1` run (8 streams
× 600 bars) **measured it differing on 6/288 folds**. So the same variant is live at
one budget and inert at another: a liveness certificate is a property of *a run*, but
the fallback reason string (`analyze.js:1042`) makes a **structural** claim
("never reaches the model path") whenever the variant carries no `inertReason`.

The `inertReason` hook already exists and is used correctly by `sample-weights`
(`analyze.js:147`, R27-3); `pca-hash` has none, so it falls through to the generic
text. Instrumentation of the real pipeline (a browser-harness probe of `runAnalysis`,
a `HiveMind._refreshLshHyperplanes` wrapper and a logging controller subclass) shows
the mechanism **does execute on the scored mind** — the refresh returns `true` and
replaces the hyperplanes — while **no emitted position changes at this run's
prototype-pool / probe budget**. So "inert on this run" is true; "never reaches the
model path" is false.

**Fix (planned, `PLAN-round28.md` P1):** give `pca-hash` an `inertReason` that states
the *measured*, per-run cause (the refresh runs but changes no emitted position at this
pool/probe budget), soften #44's "live" to "reachable, and live at some budgets", and
make the certificate's reason a per-run statement rather than a structural one. The
open question — *can* the basis ever change the selected prototype set at a smaller
probe budget or a larger pool? — is a designed experiment (`PLAN-round28.md` P2), and
the round-28 P2 probe answered it: at production width the retrieved **set** is
invariant to the basis at every tested pool (80/200/600), while the returned list's
duplicate **multiplicity** can differ — with *equal* `Math.random()` draw counts, so the
difference is attributable to the basis and not to stream desync (`lsh.test.js` §K;
`RUN-ANALYSIS.md` §14.7; the multiplicity itself is `BUGS.md` #59). Guarded by a new
`analyze.test.js` check that a `model`-scoped variant never carries the structural
fallback wording.

**Fixed (round 28, `analyze.js` `pca-hash.inertReason` + `inertReasonFor`).** The
reason is now a function of the measured run context, naming the fold count, the
reachability and the P2 measurements: *"the PCA-aligned hyperplane refresh ran
on the scored mind but changed no emitted position on all 18 folds at this run's
prototype pool and probe budget — the mechanism is REACHABLE and reaches the scored
reader (it changes the returned list's duplicate multiplicity at production width with
equal RNG draw counts; 6/288 folds differed on the round-26 8×600 run; the retrieved
prototype SET is invariant at every tested budget), so
this is a measured behavioural inertness at this budget, not structural unreachability
(BUGS.md #53; lsh.test.js §K)"*. `inertReasonFor` is the single entry point; its generic fallback
states what was measured — *"the mechanism reached the scored `<model>` path but
changed no emitted position at this run's configuration over all `<N>` folds (measured;
the variant supplies no specific reason)"* — and can never emit the structural wording.
The R27-1 test that asserted the OLD wording was updated in the same commit (it was
pinning the defect). Pinned by `analyze.test.js`: "R28 (BUGS.md #53): a MODEL-scoped
variant's inert reason can never be a structural claim" (`/REACHABLE/`, both budget
figures, and no `never reaches the model path`) plus the updated `R27-1/R28` inert check.

### 54. The causal-window sample weights are mean-1 over the *window*, not over the *trained stream* — so the Step-3 A/B ran at ≈2.6× the effective learning rate

Step 3 (`20260923T133315-seed1`) is the run that answers TODO #5, and its headline is
that causal-window uniqueness weighting **hurts** (paired ΔSharpe −0.2276, 0/36
stability windows positive, break-even −4.51 bps vs the baseline's +0.42). But the
comparison is confounded. `causalWindowWeight` normalises the window vector to mean 1
(`sample_weights.js`, `normalization: 'mean1'`), and the controller's doc says that
"keeps the effective learning rate unchanged". **It does not**, because only the newest
span of the window is ever trained: each closed-trade drain trains one label
(`CONFIG.baseProcessCount = 1`), and the ring's older spans were already learned. The
*emitted* weights are therefore not a mean-1 sample — the run reports
`sampleWeights {mean 2.6112, ess 48.06, n 58.27, effectiveFraction 0.8248}` — and
`HiveMind.train` feeds the weight straight into the gradient
(`dL_dLogit = (probability − target) * sampleWeight`, `training/gradients.js`), so the
weighted arm's gradient step is ≈2.6× the baseline's.

The pure module reproduces the run's readout from realistic spans (horizon 20, one-bar
entry spacing: mean emitted weight 2.65, `effectiveFraction` 0.813, against the run's
2.6112 / 0.8248), so this is measured, not inferred. Consequence: Step 3 conflates
(a) redistributing training credit by uniqueness with (b) a learning-rate / objective-
scale change, and its "weighting hurts" verdict cannot be attributed to (a) alone.

**Fix (planned, `PLAN-round28.md` P1/P3):** renormalise the **emitted** stream so the
trained weights have mean 1 (e.g. divide by a running mean of emitted weights, or carry
raw uniqueness and normalise the drained sequence) — a semantics-only change off the
default path — and re-run Step 3 before TODO #5 is closed. The R27-3 conclusion that
weighting is inert on the `optimistic` labeller is untouched (it is a property of
non-overlapping one-bar labels).

**Fixed (round 28).** `sample_weights.js` gains `emittedWeightNormalizer({mode})`:
`'mean1'` (default) divides each raw window weight by a **causal EMA (α = 0.1) of the
raw weights already emitted**, `'scale'` emits that EMA itself (the P3 arm-C
learning-rate control) and `'none'` the raw stream (arm B). It is exact (`1` for an
all-ones raw stream, so the horizon-1 path stays a bit-exact no-op) and causal (an
emitted prefix never depends on later raws). `trades.js` applies it and now reports the
EMITTED `min/max/mean` with `meanUnnormalised` (the raw scale) beside them — the old
code fed the raw weight into `sum`, so `mean` and `meanUnnormalised` printed the same
number. Measured on the overlap fixtures: tightly-packed horizon-8 labels emit a raw
stream at **2.4536×** and a normalised stream at **1.0000×**; irregular packing keeps
real dispersion (`min 0.758 < 1 < max 1.139`, mean 1.001) while the control arm emits
`1.140 ± 0.018` (no dispersion). Pinned by `sample_weights.test.js` §E and
`controller_invariants.test.js` §D.

### 55. Two reading defects the runs exposed: the decision block's `labelPolicy` names the run, not the referent; and the `familyCorrelation` summary mislabels its max pair

Both are report-only (no arithmetic impact) and both can mislead an operator:

- **`decision.training.labelPolicy` is the run-level flag, not the featured model's.**
  It reads `meta.labelPolicy` (`decision.js`), i.e. the `--label-policy` the run
  started from. In Step 2 the featured candidate is `label:conservative` but the block
  reads `labelPolicy: "optimistic"` (the candidate applies its own policy through
  `configure`). The training *numbers* are the referent's own and `modelReferent` names
  it, and the block's `reader` does list "the label policy" among the run-level meta —
  so this is a naming/placement ambiguity rather than a false statement, but it is
  exactly the ambiguity the block was created to remove (#45). Rename to
  `runLabelPolicy`, or report the referent's own policy beside it.
- **The `familyCorrelation` matrix is built from the active arms, but the summary's
  `maxPair` label is resolved against the *full* candidate list.** `analyze.js` computes
  `familyCorrelation({ candidates: activeCandidates.map(c => c.report) })` (correct:
  `trials = K`), but `formatAnalysis` prints the pair with
  `familyPairLabel(fc.maxPair, result)`, and `familyPairLabel` indexes
  `result.candidates[i]` — the *unfiltered* array. On Step 1 (only `surprise` and
  `homeostasis` active of 6 candidates) the summary therefore prints
  `family: excessCorr=-0.0594 effectiveTrials=2.1264 of 2 | maxPair=sample-weights~multiprobe`,
  naming two `inert`/`not-applicable` arms that were **not** correlated; the actual
  matrix (2×2, `rho = -0.0594`) is `surprise ~ homeostasis`. The number is right, the
  label is wrong. Fix: resolve the pair against the same active list the matrix used
  (or carry the ids in `maxPair`).

**Note (not a defect):** the Step-4 near-misses fail on *knife-edge* floors
(`foldWinFraction 0.4931 < 0.5`; adjusted DSR `0.9487614 < 0.95`) whose margins the
report does not surface. Surfacing the margin beside each hurdle (a `reasons` entry
already carries the numbers, but not the distance to the threshold) is a readability
improvement bundled with P6.

**Fixed (round 28).** `decisionReport`'s `training` block now carries both
`labelPolicy` (the POLICY THE REFERENT MODEL RAN UNDER) and `runLabelPolicy` (the
run-level flag), and the featured row's own variant policy is threaded in as the
referent (`analyze.js` passes `labelPolicy: featuredPolicy`,
`runLabelPolicy: labelPolicy`); `formatDecision` prints
`label policy: referent=<p>[ run=<q>]` and omits the redundant run echo when they
agree. `familyCorrelation` returns `labels` (the ACTIVE arms the matrix was built from,
sliced to `K`) and `familyPairLabel` prefers them, so the summary prints
`live-diff~flip-one` where the full-roster indexing would have printed
`baseline~live-diff`. Every evaluated hurdle now carries `{value, threshold, direction,
margin, failed, gated}` (`verdict.hurdles`/`verdict.tightestHurdle` ride through from
`promoteDecision`), and `formatDecision` prints
`margin: tightest hurdle <h> value=… threshold=… margin=…` — so the 0.00124
adjusted-DSR shortfall is legible. Pinned by `analysis.test.js` §AM (the margin and
policy lines, the knife-edge margin `-0.0012386`) and `analyze.test.js` "the summary
maxPair names the ACTIVE arms, not the same indices of the full roster".

### 56. `decision.nextRun` mixes a *paired* quantity with a *single-series* one, so its "cheapest flip" mis-states the required magnitude by ~5×

Found by the round-28 coherence re-read (`RUN-ANALYSIS.md` §14; `PLAN-round28.md` §C1). The
`cheapestFlip` `magnitude` branch reads `dependence.seCluster` — the **pooled level's**
delete-one-cluster SE — and compares `1.959964 × seCluster` to the **paired difference**
(`promotionTest.sharpeDifference.value`). On Step 2 (`20260923T111159-seed1`) that produces
`requiredSharpeDifference = 1.0711991163075398` (which is exactly `mde95Dependent`) and
`factor = 4.95005`, i.e. "you need a ×4.95 larger edge". The paired difference's own SE is
`0.1355363582`, so the genuine requirement is `1.959964 × 0.1355363582 = 0.26560`
(two-sided) or, since `pairedClusterTest.significant ⇔ pOneSided ≤ alpha`
(`analysis/dependence.js:235`), the **one-sided** `1.68957 × 0.1355363582 = 0.228998` →
**factor 1.058**. The same block's `pairedUnits.needed.mde95Dependent` = **3** is meaningless
for the same reason (it sizes a *paired* comparison at a *single-series* MDE target). Step 4
shows the same shape (`needed.mde95Dependent` = 112).

Nothing scored is wrong; the *hint* is, and it points at the wrong lever ("a larger edge") when
the truth is "a 6 % larger difference, or 41 rather than 36 clusters". **Fix (`PLAN-round28.md`
P1d):** the magnitude branch reads the paired SE and the test's one-sided reference;
`pairedUnitsNeeded` takes the side and drops the cross-scale target; each field's reader names
its scale. Test: a Step-2-shaped fixture where the two SEs differ (the old code could not tell
them apart) and a fixture where they are equal.

**Fixed (round 28, `analysis/decision.js`).** `cheapestFlip`'s `magnitude` branch now
reads `promotionTest.sharpeDifference.se` (the PAIRED delete-one-cluster SE) and the
**one-sided** reference the test actually uses — the exact `studentTCritical(df, α)`
when a df is known, else the one-sided normal quantile, never the two-sided `1.959964`
— and returns `{scale, se, alpha, df, reference, requiredSharpeDifference, factor}`.
`pairedUnitsNeeded` is a bisection for the smallest `n` with
`t(n−1, α) · se · √(C/n) ≤ target` and reports `reference{kind, df, α, side, critical,
pairedMde95}`, `neededForObserved` and `neededForObservedPower80`, **dropping** the
cross-scale `neededForMde95Dependent`. `nextRunPlan` adds a top-level `scales` block
naming which fields are single-series and which are paired, and the reader says so. On
the round-27 Step-2 shape this moves `factor` 4.95005 → **1.05825** and
`neededForObserved` 55 → **41** (t-based; **89** for 80 % power — the plan's ≈81 was a
normal approximation, and the t-based number is the honest one), and on the plan's own
equal-SE fixture 615 → 435. A new `studentTCritical(df, {alpha, twoSided})` in
`analysis/dependence.js` is the exact one-sided t quantile (bisection inverse of
`studentTPValue`), since no correct closed form existed for `pairedUnitsNeeded` to
reference. Pinned by `analysis.test.js` §AM plus the two updated round-26 fixtures
(which had pinned the old two-sided arithmetic) and a scale-separation fixture where a
5× larger single-series SE does not move the paired factor.

### 57. The always-on fold-win *majority* hurdle contradicts the recorded round-25/26 decision, and it is decisive

Found by the round-28 coherence re-read (`RUN-ANALYSIS.md` §14; `PLAN-round28.md` §C2).
`DESIGN.md` §6.1 records that the round-25 gate replaced the raw fold hurdles
(`foldWinFraction >= 0.5`, `positiveFraction >= baseline`) with the paired cluster Sharpe test
plus the leave-one-window stability requirement, and that "the raw fraction is still reported,
as a statistic". But `promoteDecision` still carries `minFoldWinFraction = 0.5` (and
`minPositiveFoldDelta = 0`) as **always-on reasons** (`analysis/walkforward.js:800–812`), with
`foldWinFraction` computed over **all 288 folds** — comparisons the project's own dependence
analysis says are not independent. On the round-27 runs the raw hurdle is decisive and
disagrees with the error-controlled cluster statistic:

| candidate (run) | `foldWinFraction` (288 folds) | cluster sign test (36 windows) |
| --- | --- | --- |
| `label-conservative` (Step 2) | **0.2013888** ❌ | **0.5000** (17/17/2) |
| `sig:momentum` (Step 4 @0 bps) | **0.4930555** ❌ | **0.5277778** (19/17) |

`DESIGN.md` §6.1's round-25b observation already described exactly this pattern ("at the fold
level the fractions said 'loses'; at the cluster level the tests said '…'"); the code simply
never dropped the raw hurdles. **Verdict-neutral today:** every candidate that fails the raw
hurdle also fails the DSR floor and/or the paired test (see the `reasons` arrays in
`RUN-ANALYSIS.md` §13.3/§13.5), so removing it neither promotes nor rejects anything.
**Fix (`PLAN-round28.md` P1e):** make the code implement the recorded decision (raw fractions
reported, not gated), record the rationale + size note in `METHOD.md` §8 and a `DESIGN.md`
§6.1 addendum, and prove verdict-neutrality on all four reports before landing. Test: a
fixture where the raw majority fails and the cluster sign test passes.

**Fixed (round 28, `analysis/walkforward.js` + `analyze.js`).** `promoteDecision` gains
`rawFoldHurdles` (default `true`, preserving the round-23/24 classic gate and its
published size/power calibration). With `false` the two raw fractions are **recorded
but not gated** — `hurdles[].gated === false`, while `failed` and `margin` remain the
honest evaluation of the stated rule, and `tightestHurdle` skips them. The driver's
dependence gate now passes `rawFoldHurdles: false`, so the shipped gate's breadth
statement is the error-controlled clustered pair. **Verdict-neutrality is
established**: every candidate on all four round-27 reports that fails a raw fraction
also fails the adjusted-DSR floor and/or the paired cluster test, so no `promote`
changes (the `reasons` arrays in `RUN-ANALYSIS.md` §13.3/§13.5). Pinned by
`analysis.test.js` §AM with a 3-stream × 6-window fixture whose candidate wins
**1/3 of the folds** and **6/6 window clusters** (raw off → promotes with zero reasons;
raw on → blocked by the raw majority alone), and by `analyze.test.js` asserting the
shipped `gateOptions.rawFoldHurdles === false` and that no row's `reasons` names a fold
fraction. Rationale + size note in `METHOD.md` §8 with the `DESIGN.md` §6.1 addendum.

### 58. `sample-weights`' inertness on `optimistic` is a *configuration* artefact, not a label property — and the inert reason says the opposite

Found by the round-28 coherence re-read (`RUN-ANALYSIS.md` §14; `PLAN-round28.md` §C3). The
`sample-weights` variant's `configure` sets the causal ring's span horizon to
`ctl._labelHorizonBars > 1 ? floor(...) : 1` (`analyze.js:151–158`) — **1 on any `optimistic`
run** — so every assumed span is one bar, `overlapUniqueness` returns all ones, and Step 1
reports `sampleWeights {min 1, max 1, mean 1, ess = n = 43.825, effectiveFraction 1}`. The
shipped `inertReason` (`analyze.js:145`) and `METHOD.md` §4's decisive premise attribute that
to the labeller: *"the shipped (optimistic) labeller emits one-bar labels, so no two label
spans overlap"*, quoting the round-26 journal's `heldBars {count=sum=185937, max=1}`. But
`heldBars ≡ 1` was the **#49 defect** — a false diagnostic, not evidence. With #49 fixed, the
same runs report **`heldBars {count 4369, max 54, mean 8.301}`** (Step 1) and
**`{count 185937, max 72, mean 7.8245, cap 119}`** (Step 2) on the `optimistic` baseline: the
labels are held ~8 bars and **do overlap**, so average uniqueness is ≈ 1/8, not 1. The
all-ones vector is therefore produced by the span *parameter*, not by the labels, and the
uniqueness mechanism has **never actually been tested on the shipped labeller**.
**Fix (`PLAN-round28.md` P1a′/P1b/P1c):** state the measured reason (span horizon configured
to 1 while the realized holding period is 8.30 bars); give the ring a **causal** span estimate
(EMA of past realized holding periods, or an explicit `--sample-weight-horizon`) plus the
emitted-stream mean-1 renormalisation (#54); re-open `TODO.md` 5's `optimistic` closure pending
that run. Test: at `optimistic` with a measured horizon, `min < 1 < max` and `ess < n`; and a
causality test that a label's emitted weight does not move when later bars are perturbed.

**Fixed (round 28).** Three changes: (1) the inert reason is a function of the measured
run context and names **both** the assumed horizon and the realized holding period —
*"the causal ring assumed a FIXED span horizon of 1 bar and every emitted weight was
exactly 1 over N label(s), although this run's REALIZED holding period is mean 8.30 /
max 54 bars — so the all-ones vector is a property of the ASSUMED horizon, not of the
labeller (BUGS.md #58)"*; a MEASURED horizon that still yields all-ones says *that*
instead; (2) `configure` resolves the span as explicit `--sample-weight-horizon` → a
label horizon `> 1` → **null = MEASURED**, so an `optimistic` run (label horizon 1) is
no longer silently pinned to a one-bar span; (3) `trades.js` keeps an in-memory bridge
of each closed trade's realized `heldBars` and maintains a causal EMA (α = 0.1) of the
holding periods drained **before** each label, so the span is measured without
lookahead (`--sample-weight-horizon=<n>` overrides it, and it is echoed in `run.json`
and the report). `METHOD.md` §4's premise is corrected in the same commit and
`TODO.md` #5's `optimistic` closure is re-opened. Pinned by `analyze.test.js` (the
reason texts, the horizon resolution, the `''` no-block degrade) and
`controller_invariants.test.js` §D (the measured span: `heldBarsEma 8`,
`measureHorizon true`, `min < 1 < max`, `ess < n`; a later trade's `heldBars` cannot
move an earlier label's weight; `emittedNormalization: 'none'` reproduces the raw
stream) plus `sample_weights.test.js` §E (the drift and the dispersion).

### 59. `_retrieveTopRelevantProtos` can return the same prototype several times (duplicate multiplicity)

**REPORTED, NOT FIXED in round 28 — deliberately, because it is on the scored default path.**

Found by the round-28 P2 retrieval-liveness probe (`RUN-ANALYSIS.md` §14.7;
`PLAN-round28.md` P2). The scored reader's candidate list is assembled from a `Set`
(`semCandidates`, unique), but every *fallback* filler guards with `semCandidates.has(proto)`
and **never adds to that Set** — `retrieval.js`: the `< desiredSem * 0.3` projection fill, the
`< desiredSem * 0.2` low-access fill, the `while (length < targetTotal)` random fill, and the
`isCore`/priority pushes. A prototype admitted by a fallback therefore stays "not in
`semCandidates`" and can be pushed again by a later fallback, so `semCandProtos` (and hence
`candProtos`, and hence the returned list) can contain the same prototype more than once.

Measured (`lsh.test.js` §K, production width, 107-bit index): on an **80-prototype** anisotropic
bank *every* query's returned list contains at least one repeated id (`hasDup true`); on a
**600-prototype** bank it does not (`hasDup false`). The round-28 probe also showed that the
PCA-aligned basis changes the *duplicate multiplicity* of the returned list on some seeded
queries with **equal** `Math.random()` draw counts (attributable, not stream desync) while the
retrieved prototype **set** is invariant — which is why the `pca-hash` certificate quotes the
set, and why the multiplicity difference is recorded here rather than celebrated as liveness.

**Effect.** The returned list is what the scored model reads, so a duplicated prototype is
weighted by its multiplicity in that read; the unique retrieved set is unaffected. **Why not
fixed now:** the reader is on the scored default path, so de-duplicating it would move every
golden fingerprint — a deliberate re-freeze the round's evidence does not justify
(`PLAN-round28.md` §8.1). Recorded so a future re-freeze can address it deliberately. Pinned
by `lsh.test.js` §K, whose paired assertions (set invariant, list differs) will make a future
de-duplication show up as a test change rather than a silent numeric drift.

## Found by the round-28 operator runs (`RUN-ANALYSIS.md` §15) — #60/#61/#62, all REPORTED, not fixed

The three Steps of `PLAN-round28.md` §3 ran (`20260923T211549-seed1`, `20260924T045601-seed1`,
`20260924T071546-seed1`) and their readout is `RUN-ANALYSIS.md` §15. All three ran clean
(`policyRoundTrip` ok/0 mismatch, `warmErrors 0`, `quarantinedRows 0`, zero warn/error log lines,
audits clean) and **nothing promoted**. Reading them added the three entries below. Each is
reported rather than fixed because each needs a decision or proof of its own, and none of them
changes a verdict: #60 and #62 are latent/reading-layer, and #61's effect is on the fairness of
cross-family comparisons (nothing promoted this round in any case).

### 60. `meanSharpeDelta` — a third fold-level point comparison that the #57 fix missed

**REPORTED, NOT FIXED in round 28.**

Found by reading the three round-28 run reports (`RUN-ANALYSIS.md` §15.2/§15.3). The #57 fix
removed the two raw fold **fractions** (`foldWinFraction`, `positiveFoldFraction`) from the
always-on reasons, per `DESIGN.md` §6.1's recorded round-25 decision ("the raw fraction is still
reported, as a statistic"). `promoteDecision` carries a **third** fold-level statistic as an
always-on, `gated: true` hurdle the fix did not touch: `meanSharpeDelta`, which compares the
candidate's mean per-fold Sharpe (`aggregate.mean`) against the baseline's with
`minSharpeDelta = 0`. Its reference is the baseline's mean over all 288 folds, computed over the
same ~0.29–0.52 cross-stream-correlated folds the dependence panel exists to account for.

Measured in the shipped reports (`hurdles` entries, `gated: true`):

| run | candidate | value (candidate mean fold Sharpe) | threshold (baseline mean fold Sharpe) | other gated hurdles also failed |
| --- | --- | ---: | ---: | --- |
| Step 1 | `sample-weights` | −0.10646 | −0.04413 | minDsr, minDsrAdjusted, pairedSharpeDifference |
| Step 1 | `sample-weights-scale-control` | −0.11588 | −0.04413 | minDsr, minDsrAdjusted, paired, stability |
| Step 2 | `label-conservative` | +0.51465 | +0.70051 | paired, stability |
| Step 3 | `surprise` / `sig-frac-momentum` / `sig-agreement` / `sig-range` / `sig-autocorr` | +0.58 … −0.51 | −0.04413 | minDsr, minDsrAdjusted, paired, … |

Note the threshold is the **mean of fold Sharpes** (Step 1: −0.04413) while the panel's pooled
Sharpe is −0.11469 — the two are different statistics, and the reason string prints only the
mean-fold pair, so a reader cannot see that the hurdle is fold-level.

**Verdict-neutrality, proved on all three runs (21 candidate rows).** No candidate anywhere fails
*only* this hurdle: every row that fails `meanSharpeDelta` also fails at least one error-controlled
gated hurdle (`minDsr`, `minDsrAdjusted`, `pairedSharpeDifference` or `clusterStability`) — and
five candidates (`homeostasis`, `pca-hash`, `sig-momentum`, `sig-vol-regime`, `sig-volume`,
`sig-accel`) pass it while still failing the floor. So reporting it as `gated: false` (as #57 did
for the two fractions) would move no verdict. Filed rather than fixed because `DESIGN.md` §6.1's
recorded decision names only the raw fractions, so whether a mean-fold reason was *intended* to
survive is a decision-procedure question (`DESIGN.md` §6) that this round's evidence cannot
settle, and a fix must carry its own neutrality proof.

### 61. The "one confidence space" is dimensionally shared but not distributionally comparable across families

**REPORTED, NOT FIXED in round 28.**

Found by the P5 sweep's fairness audit (`RUN-ANALYSIS.md` §15.4/§15.5c). R26-3 unified the
position policy so every candidate's `confidence` is thresholded by the same absolute
`deadZone`/`enter`/`exit`. That is dimensionally consistent — every family emits a number on
[−1, 1] — but the *distributions* are not comparable, so the same absolute threshold is a
different economic filter for each family. Measured from the Step-3 journal (all 4 320 bars,
`|confidence|`):

| arm | p50 | p75 | p90 | p95 | max | fraction > 0.2 | fraction > 0.3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline (controller) | 0.0557 | 0.0960 | 0.1514 | 0.1680 | **0.2555** | **0.93 %** | **0 %** |
| Step-2 baseline | 0.0634 | 0.1075 | 0.1524 | 0.1754 | 0.2670 | 2.29 % | 0 % |
| `sig-momentum` | 0.5259 | 0.7785 | 1.0000 | 1.0000 | **1.0000** | **83.08 %** | 72.71 % |
| `sig-accel` | 0.4849 | 0.7501 | 1.0000 | 1.0000 | 1.0000 | 77.85 % | 67.41 % |
| `sig-range` | 0.4900 | 0.7803 | 1.0000 | 1.0000 | 1.0000 | 82.06 % | 71.97 % |

The controller's confidence never exceeds 0.27 (so `enter 0.2` is a ~4σ event for it, and `0.3`
is impossible), while a signal's is saturated at 1 for its top decile.

**Consequences, both measured.**

1. **The shipped dead zone is family-relative.** At `deadZone 0.05` the baseline is in the market
   on `nonZeroFraction` 0.5081 of bars, `sig-momentum` on 0.8917 and `sig-accel` on 0.8785; at
   `deadZone 0` all three sit at 0.9333. So a `netSharpe` comparison across families at one
   policy mixes an exposure difference into a performance difference (turnover 31.1 vs 810 vs 861
   at the shipped policy).
2. **The sweep can promote against an abstaining baseline.** At Step 3's promoting policy
   `{deadZone 0.02, enter 0.2, exit 0.05}` the *restated baseline* holds a position on **16 of
   4 320 bars** (`nonZeroFraction 0.0037`, `tradeCount 2`, `turnover 2`, Sharpe −0.1395) while the
   candidate trades 844 — the verdict compares an ~80 %-invested book with a flat one. Only the
   *absolute* DSR floor stops the analogous `sig-momentum` row: at the same policy it reaches the
   highest Sharpe of all arms (1.21430) but `effBars` 1180 (vs accel's 1948) gives adjDSR 0.84432,
   a fail.

No arithmetic is wrong — the reported numbers are what the code computed. The defect is
*comparison fairness*, and it is on the report/decision layer, not the scored path. A fix needs a
`DESIGN.md` §6 decision (family-normalised thresholds, e.g. quantile- or scale-matched, or
cross-family statements quoted only at matched exposure) with its own re-run/proof, so it is
reported, not fixed. It does not affect any promotion this round: nothing promoted.

### 62. `--label-horizon` silently sets the sample-weight span — and is otherwise a no-op on a non-`triple` run

**REPORTED, NOT FIXED in round 28.**

Found by reading `analyze.js` against `PLAN-round28.md` §3's Step-2 command
(`RUN-ANALYSIS.md` §15.3). Both opt-in weighting arms' `configure()` set the causal ring's span as

```
horizonBars: explicit != null ? explicit : labelHorizon
```

where `explicit` is `--sample-weight-horizon` and `labelHorizon = _labelHorizonBars > 1 ?
floor(_labelHorizonBars) : null`. The comment directly above states the intent — the fallback is
*"the run's label horizon when the labeller has a real vertical barrier (`triple` + label-horizon
> 1) — there the label span IS that horizon"* — but **the code does not test the label policy**:
`_labelHorizonBars > 1` is the entire condition.

Two consequences, both measured on the retained runs:

- **It can silently re-introduce the #58 confound.** A run that is *not* `triple`
  (`optimistic`/`conservative`) but passes `--label-horizon=<n>` *and* includes a weighting arm
  runs arm A with a **FIXED** span of `n` bars and `measureHorizon: false` — precisely the
  "assumed horizon" configuration artefact the round set out to remove, reached through a flag
  documented as the triple barrier's horizon. Step 1 escaped it (no `--label-horizon`); Step 2
  escaped it only because it carried no weighting arm.
- **Otherwise it is a silent no-op.** On Step 2 (`--test=10 --label-horizon=20`) nothing read it:
  `trades.js:168` gates the vertical barrier on `triple && horizonBars != null`, and the report
  shows `resolvedTimeBarrier 0` with `heldBars {max 73, mean 7.88093}` in **both** arms (a max of
  73 ≫ 20, and the two arms' `heldBars` are identical). So the flag appears in `run.json` and in
  the report's `labelHorizonBars` while having had no effect — and the only clue is the
  `sampleWeightHorizon: null` echoed beside it.

The class is flag-semantics/latent-confusion, not arithmetic. Reported, not fixed: no retained run
is affected, and the repair (test `_labelPolicy === 'triple'` in the fallback, or drop the
`labelHorizon` fallback now that the measured span is the default) is a one-line change in the
scored training path that wants its own `analyze.test.js`/`sample_weights.test.js` pin.

## Found by the round-29 implementation (`RUN-ANALYSIS.md` §16) — #63–#67, all FIXED

The round's new machinery is mostly decision/post-processing code, but four wiring defects were
caught by writing the correctness tests *before* trusting the runs. Three of them are the same
class as #31/#51: a producer computes the right number and the consumer silently reads a different
quantity (or nothing at all), so the report stays green while claiming something untrue. The fourth
is a units/encoding mismatch that produced an all-zero input rather than an error.

### 63. `exposureMatchedPair` read the base policy's exposure off a `pooledMetrics` field a journaled report does not carry

**FIXED in round 29 (P2).** Found by the P2 implementation while checking the matched comparison
against the retained runs. Exposure matching has to know each arm's *scored* in-market share to
pick the common target (the less-invested arm's share). The first version read it from
`baseline.pooledMetrics.nonZeroFraction` — a field a report built from a journal (the retired-run
retrospective path, and every report `restateReportAtCost`/`restateReportAtPolicy` produces) may
not carry. A missing field made `targetNonZeroFraction` resolve to **0**, i.e. a "match" where both
arms sit flat: `exposureDeadZone(confidences, 0)` returns `deadZone: 0.999` for every family, so
both arms trade nothing, the paired difference is 0 and the matched row silently reports a null
comparison instead of an error.

The fix measures the raw share from the restatement itself
(`restateReportAtPolicy(base, basePolicy).pooledMetrics.nonZeroFraction`), which is definitionally
the share the scored policy emits, and the matched row's reachability is now reported explicitly
(`matchedWithinTolerance`, `tolerance`) so an unreachable target can never look like a clean match.
Requirement: a matched pair's `raw.baselineNonZeroFraction`/`candidateNonZeroFraction` must equal
the restated shares — `analysis.test.js` pins it.

### 64. A funding/carry sleeve was compared against the *concatenated* panel length, so it was excluded from every real run

**FIXED in round 29 (P4).** `poolReports` appends independent return streams (the funding/carry
sleeve) to the dependence panel so the deflated Sharpe's design-effect adjustment can count them. A
stream in that panel is a **per-stream** series — the test bars of one symbol, folds concatenated —
so an extra stream must match *one stream's* length. The first version compared it against
`pooled.length`, which is the concatenation of **every** stream's bars (8× bigger on the shipped
8-symbol basket). The check therefore failed on every real run and the sleeve was dropped with
`panelMismatch: true` — i.e. the P4 acceptance measurement would have reported "no effect" for a
sleeve that never entered the panel. The unit tests had been written against the corrected
semantics (a per-stream-length sleeve), which is what exposed the mismatch. Fixed by comparing
against `priceStreamReturns[0].length`; a genuine mismatch is still reported
(`panelMismatch`/`panelMismatchReason`), never silently averaged in.

### 65. The restatements double-appended the sleeve (and dropped its panel bookkeeping), so a cost- or policy-restated panel disagreed with the scored one

**FIXED in round 29 (P4).** `restateReportAtCost`/`restateReportAtPolicy` rebuild a report's panel
from the journal and then re-append the extra streams, because a restatement must not lose an
independent stream the scored block counted. Both passed the report's *already-extended*
`streamFoldLengths` into the re-append helper, which appended the extras a second time: the
restated report carried `streamReturns` of length K+1 beside `streamFoldLengths` of length K+2, so
the sleeve was counted twice in the design effect (and the ladder's dependence block disagreed with
the scored row for a reason unrelated to cost). Both call sites now pass the **price-only** fold
lengths (rebuilt during the restatement, which is also where the extras' own lengths come from),
and the restated report carries the panel bookkeeping forward (`extraPanelStreams`,
`panelStreams`, `panelMismatch`, `panelMismatchReason`) plus a `dependenceWithoutExtras`
recomputed **at the same cost/policy** — otherwise `analyze.js`'s restatement wrapper would pair a
restated `dependence` with a scored `dependenceWithoutExtras`. `analysis.test.js` pins the chained
restatement and the cost-ladder agreement.

### 66. `carryOnBarGrid` compared epoch-ms funding timestamps against the ISO strings the candle files store, producing an all-zero sleeve

**FIXED in round 29 (P4).** The shipped candle JSONL stores ISO timestamp strings
(`"2026-09-24T08:00:00.000Z"`), and `analyze.js#readCandles` passes that field through unchanged
(only `candle_fetcher.js#parseCandlesJsonl` normalizes it to epoch ms, which the *tests* use).
`carryOnBarGrid` therefore evaluated `fundingRow.timestamp <= "ISO"` — a number/string comparison
that is `false` for every bar — so the whole sleeve was `0`. The pipeline's guard rails did not
catch it either: the length check passed (a zero array of the right length is still the right
length), the correlation came back `NaN` (→ `null` in JSON), and the dependence block simply
reported "with sleeve" numbers for a constant stream. Found by the end-to-end wiring probe (the
sleeve's pooled mean rate was exactly 0 where the funding files' own mean was 1.06e-4/period).
Fixed by normalizing **both** sides to epoch ms at the comparison site (`toMs`), and — because the
source of the bug is a silent-degradation class, not a crash — by adding a **degeneracy guard**:
`poolReports` excludes a constant extra stream (`panelMismatchReason: 'degenerate'`) and
`analyze.js` declines to append a zero-variance sleeve (recording the reason in `carry.unavailable`)
rather than diluting the panel with a stream that carries no information. `analysis.test.js` pins
both the ISO/number coercion and the degeneracy exclusion; `candles.test.js` pins that the funding
files' own serialization round-trips byte-for-byte.

**Related convention fix in the same edit:** `auditFundingSeries` initially reused the *candle*
"still-forming bar" rule (`timestamp + interval > now`) and so flagged the newest funding period of
all eight symbols as `unclosed`. A funding row is realized **at** its own timestamp (the exchange
charges the rate then) — there is no `[t, t+interval)` bar — so a still-forming period is a row
dated in the *future*. Fixed to `timestamp > now`; this is why the funding-basket audit reports 0
problems rather than 8.

### 67. `restateReportAtCadence` under-sized the default training window by one `testSize` (latent — every shipped caller passed `trainSize`)

**FIXED in round 29 (P2 coherence audit).** Found by the full coherence/sanity pass over the
round-29 additions. `walkForwardSplit({n, trainSize, testSize})` builds non-expanding folds whose
first training window is `[0, testStart)`, so fold 0's `testStart` **is** the training length. The
first version of the cadence restatement defaulted `trainSize` to
`testStart − (testEnd − testStart + 1)` — i.e. `trainSize − testSize` — so a caller that omitted
`trainSize` silently re-partitioned with a training window one test size too short (on the
`trainSize = testSize = 10` fixture the default was **0**). No *measured* number was affected: the
P2 cadence readout and every test pass `trainSize` explicitly, so the defect was latent. Fixed to
derive the length from fold 0's grid position (`folds[0].testStart`, falling back to `testSize`
when a report carries no folds), and `analysis.test.js`'s P2 restatement check now pins the default
against `folds[0].testStart` (a discriminating assertion, since the old expression failed it).
Restatements are pure post-processing and the shipped `analyze.js` driver does not call this
function, so no golden fingerprint or scored number moves.

## Found by the round-5 final cleanup — #68, FIXED

### 68. The parallel fold worker invoked the pre-built model as a factory (and the driver dropped `sampleWeightHorizon`)

**FIXED in round 5 (final cleanup).** Caught by `npm test` on a real native Node driver — invisible
to the browser harness, whose concurrency checks inject their own inline fold fake instead of loading
the real worker. `makeSignalForVariant(factory, …)` takes a **function of the variant** and calls it
once per fold (`const model = factory(variant)`). The serial driver passes the right shape
(`selectFactory = (variant) => (variant.benchmark ? benchmarkFactory(variant) : factory(variant))`),
but `analysis/fold_worker.js` evaluated it early —
`const selectFactory = variant && variant.benchmark ? benchmarkFactory(variant) : factory(variant)` —
and handed the resulting **model object** to `makeSignalForVariant`, which then invoked that object as
a function. Every fold dispatch rejected with
`WORKER_ERROR: [fold:<variant>#<stream>.<fold>] factory is not a function`, so the node-only
`parallel_folds.test.js` (real `worker_threads`, the R26-4 acceptance criterion) failed and no
`--concurrency > 1` run could complete. Fixed by making the worker's `selectFactory` a function of
the variant, exactly like the serial driver's.

The same probe found a **second, quieter divergence**: the driver's fold-dispatch request omitted
`sampleWeightHorizon`, so with `--sample-weight-horizon=<n>` the worker configured the causal span
to `null` (MEASURED) while the serial folds used `n` — a serial/parallel disagreement that would not
have thrown (`folds.jsonl` byte-identity would have broken silently). The field is now threaded
through both the request (`analyze.js`) and the worker factory (`fold_worker.js`).

Because the bug class is "the driver forgot to send a field the worker reads", the fix ships with a
**contract check**, not just the one instance: two new `analyze.test.js` checks (runnable in the
browser harness) assert that every fold-dispatch request carries the full set of keys the worker
reads — so a future factory option that is not threaded here fails loudly. `analyze` 267 → 269,
ledger 2556 → 2558.

## Found by the round-29 operator acceptance batch (`RUN-ANALYSIS.md` §17) — #69/#70, FIXED (round 30)

Five fresh acceptance runs came back (§17); two of them (3c P3, 3d P4) exercised the new data paths
and exposed two report/CLI robustness defects. Neither touches the scored arithmetic and neither
manufactured a promotion (the gate refused the degenerate candidate). **Both are now FIXED in round
30** (PLAN-round30.md Workstream E, `C-FIX69`/`C-FIX70`): the CLI refusal plus an
`analyze.test.js`/`analyze_cli.test.js` pin for #69, and a `notApplicableReason` taxonomy extension
plus an end-to-end `evaluateAB` pin for #70. The golden suite is unmoved (23/0) and the browser
ledger moved by the new checks (`analyze` 269 → 279 for #69/#70 + the roster-register pins;
`analysis` 621 → 638 for the round-30 momentum-upgrade section and the two §5 property tests; total 2558 → 2585).

### 69. An empty `--files=` (or `--carry-files=`) silently falls back to the default dataset (or drops the sleeve) instead of erroring

**FIXED (round 30).** `analyze.js` now refuses a present-but-empty list flag.

The `round29-TESTING.md` §3 commands set `CANDLES_15M` / `FUND` from shell variables. On the batch
those variables were **unset in the shell that ran 3c/3d**, so the arguments expanded to `--files=`
and `--carry-files=` (empty values). `analyze.js`'s parser treats an empty value as "not supplied":

- **3c** fell back to `CONFIG.file` (`src/candles.jsonl`) and ran a **single stream at 1h** — 3c's
  `run.json` records `"streams": 1`, `"candles": 2000`, `"files": ["…/src/candles.jsonl"]` where the
  guide expects `8` streams and ≈8×2000 candles. The whole P3 acceptance (8-symbol 15m basket) was
  therefore measured on the wrong dataset while looking like a normal completed run.
- **3d** ran with `report.carry === null`, `dependence.streams === 8` and `panelStreams: 0` in every
  cadence evaluation, where the guide's checklist requires `panelStreams === 1` /
  `dependence.streams === 9`. The sleeve's presence and absence are individually explicit (which is
  how this was caught), but the *command* silently did nothing for P4.

The class is "an explicitly-passed flag with an empty value is indistinguishable from an absent
flag", so a mistyped/empty shell variable produces a plausible-looking but off-spec run.

**Fix (round 30).** The CLI parse gains a `flagGiven(name)` helper that matches both `--name` and
`--name=…`, and a pure `emptyListFlagError(name, given, raw, consequence)` guard: a present-but-empty
`--files=` / `--carry-files=` (including a bare `--files`, or `--files=,,`) now throws
`analyze: --files= was provided but names no files — refusing to silently fall back to …` and the run
exits non-zero, before any data is read. A non-empty list is unaffected. Pinned two ways: the pure
guard in `analyze.test.js` (browser) and a spawned-CLI refusal in `analyze_cli.test.js` (node-only,
`BUGS.md #69` message match + a non-empty control run). The operator guide still carries the
`:?unset` guard warning (`round29-TESTING.md` §3/§5).

**Same class, closed too (round 30, audit pass).** The guard also covers the singular `--file=` and
every other list flag whose empty form has no documented meaning — `--symbols=`, `--variants=` and
`--seeds=` — since a mistyped/empty shell variable there was the same silent-fallback footgun (an
empty `--file=`/`--symbols=` scored the default single-file dataset; an empty `--variants=` ran the
default roster; an empty `--seeds=` ran a single seed, each while reading as the intended
experiment). The enumerated-mode flags (`--model=`, `--gate=`, `--label-policy=`) keep their
documented "empty = default" semantics, as do `--cost-ladder=` and `--cadences=`, whose empty form
means "off". The `analyze.test.js` §A2c check and the spawned-CLI cases are extended to pin them.

### 70. A panel-requiring signal on a panel-less run is degenerate yet labelled `live` and can be selected as `familywise.best`

**FIXED (round 30).** `notApplicableReason` now marks a cross-sectional arm `not-applicable` when
the run has fewer than two aligned streams, which also removes it from `K` and the search.

The cross-sectional reversal arm (`features.js#crossSectionalReversal`) reads `view.panel`, the
per-stream cross-section the driver attaches only when >1 stream is scored. On 3c's **single-stream**
run there is no panel, so the primitive abstains (`NaN` → 0) and the arm's position series is
identically zero. Three report fields then misdescribe it:

- **`liveness`** compares emitted positions against the baseline's and reports `status: "live"`
  (it differs on 101 of 129 folds) — technically true, but the arm is **degenerate** (constant 0),
  not live. The `inert`/`duplicate`/`not-applicable` taxonomy has no "degenerate/constant" bucket.
- **`familywise.best`** is `"sig:reversal-xs"`: a zero-variance arm's SPA statistic (0) exceeds every
  *negative* arm's, so the search names the arm that trades nothing as the family's best.
- **the forecast MCS** keeps it as the survivor — an all-zero forecast has the lowest Brier loss.

The look-ahead **vacuity audit** does catch it (`vacuous: true`, `reachable: false`, 1 violation) and
`promoteDecision`'s `candidateAudit` hurdle **fails** it, so the verifier refuses the arm and no
promotion is manufactured. But the report's *narrative* fields (`liveness`, `familywise.best`, the
MCS membership) still point at it, and a reader skimming those would draw the wrong conclusion. The
natural fix is to mark a panel-requiring variant `not-applicable` (the same taxonomy
`multiprobe`/`querymod` use) when the run has no panel — which would also drop it out of `K` and the
search — and/or to exclude a constant (zero-variance) arm from `familywise.best`/MCS.

**Fix (round 30).** `notApplicableReason(variant, model, ctx)` gains a panel arm: when
`variant.crossSectional === true` and `ctx.streamCount < 2` it returns
`not-applicable: reads the cross-section (view.panel) but this run has N stream(s) — the
cross-sectional position is identically 0 without ≥2 aligned streams (BUGS.md #70)`. The driver
passes the scored stream count at every call site (the per-variant evaluation and both liveness
paths), so the arm is certified `not-applicable`, `active:false`, `search:null`, and drops out of
`K`, the family-wise search and `familywise.best`. With ≥2 streams the arm is evaluable again. Pinned
in `analyze.test.js`: the pure taxonomy case (1 stream → not-applicable; 2 streams → applicable) and
an end-to-end `evaluateAB` case (single stream: not-applicable/out-of-`K`/out-of-search; two streams:
in `K`). The `analysis.test.js` panel-less abstain-not-throw check is unchanged; #70 was about the
*status* the abstention reports, not the abstention itself.

`indicatorProcessor.js` is ten independent hand-rolled indicator
implementations with no shared recurrence helper. A dedicated suite
(`test/browser/entries/indicators.test.js`, 75 checks; node mirror at
`test/node/indicators.test.js`) now pins the guard/length/range contract, the
flat-series closed forms, end-alignment (against hand-written recurrences),
causality (appending a candle leaves earlier outputs untouched), determinism and
non-mutation. Length contract for `N` valid candles (`compute()` needs ≥ 11):

| series | length | series | length |
|--------|-------:|--------|-------:|
| `rsi` | N−14 | `obv` | N |
| `atr` | N−14 | `adx` | N−14 |
| `macdDiff` | N−17 | `cci` | N−19 |
| `ema100` | N | `bollingerPercentB` | N−19 |
| `stochasticDiff` | N−15 | `williamsR` | N−13 |

The audit surfaced four behaviour quirks that are **not** being changed, because
they feed the feature vector and any change retrains the whole model:

1. **RSI double-applies one delta.** The seed loop sums deltas for
   `i = 1..period`, then the smoothing loop starts at `i = period` and folds
   `values[period] − values[period−1]` in *again*. The net effect is that
   `rsi[k]` equals a textbook Wilder RSI one bar later (`rsi_std[k+1]`); the
   discrepancy decays geometrically, so the tail is effectively converged.
2. **MACD legs are index-misaligned.** `macdLine[j] = fastEMA[i] −
   slowEMA[i − (slow−fast)]`, i.e. the slow leg is lagged by 13 bars (and the
   slow EMA's leading zeros briefly make the early outputs equal to `fastEMA`
   alone); the output then pairs `macdLine[4+j]` with `signalLine[j]` — a
   further 4-bar offset. Standard MACD pairs both legs at equal indices. Left
   as-is (the resulting `macdDiff` is still a usable momentum feature).
3. **MACD's guard is stricter than its arithmetic needs.** The guard requires
   `slowPeriod + signalPeriod = 26` candles, but the recurrences become
   meaningful at 22. For the guarded range it returns an error array of length
   `max(0, N − 25)` (i.e. 0 for every guarded `N`) which also does not match the
   success-path contract `N − 17`. Unreachable in normal operation (controllers
   feed far more than 26 candles) — a guard/length inconsistency, not a live
   defect.
4. **`bollingerPercentB` is not clamped to [0, 1].** It uses *population*
   standard deviation and `compute()` does not clamp the ratio, so a close
   outside the ±2σ band gives `%B` outside the unit interval (observed ≈ 1.047
   in tests; the mathematical bound for a 20-sample population is
   `0.5 ± √19/4` ≈ [−0.590, 1.590]). Whether this is intended is unclear; it is
   now at least documented and asserted.

Also **latent (defensive only):** every indicator's error branch builds
`new Array(...values.length...)` *before* it has proved `values` is an array, so
a non-array / `undefined` argument would throw `RangeError: Invalid array
length` instead of taking the graceful path. `compute()` always passes arrays,
so this is unreachable today; it is a hardening target if any of these methods
is ever exposed.

---

## Hand-rolled consolidation — audit findings

The memory lifecycle (decay, pairwise merge, core promotion, prototype
proximity graph) lived entirely inside `consolidation_worker.js`, which runs
top-level code behind a worker + database connection and was therefore
**untested** (no test registered the `node:worker_threads` shim's
`__workerFactory`). Its pure algorithms were extracted **verbatim** into
`src/consolidation_logic.js`; the worker is now a thin loader that decodes rows,
calls the module, and posts the same `delta`. Extraction was verified
bit-exactly against the original inline copies (300 randomized trials ×
{decay, merge, promote, hierarchy}, all `Object.is`-identical). Coverage:
`consolidation.test.js` (48 checks, pure algorithms) and
`consolidation_worker.test.js` (18 checks, real worker wiring — row decode,
config field names, output shape), with node mirrors.

Findings (none are live defects; all are now pinned by tests):

1. **Mutually-nearest prototypes emit the same directed edge twice.**
   `buildHierarchy` pushes both `parent→child` and `child→parent` for every
   chosen neighbour pair, without de-duplicating against a pair already emitted
   from the other side. As a result a mutual nearest-neighbour pair produces the
   same `(parent, child)` row up to 4 times. This is safe because the production
   insert is `ON CONFLICT(source, polarity, parent_proto, child_proto) DO
   NOTHING`, so `proto_edges` stays a set. Pinned explicitly (test asserts the
   duplicate count) so that a future schema change (e.g. adding a column to the
   primary key) does not silently turn these into errors.

2. **The pairwise merge is inherently O(n²·d).** Greedy and order-dependent
   (each surviving prototype absorbs every later one within the distance
   threshold, and the target's mean is updated between comparisons), over up to
   `volatileConsolidationLimit = 1000` / `coreConsolidationLimit = 750`
   prototypes. This is the algorithm, not waste — reducing it would change
   *which* prototypes merge. The `mems.splice(j, 1)` in the inner loop adds an
   O(n) shift per merge, but that is dominated by the O(d) Gaussian-distance
   arithmetic (and runs inside a worker, off the main thread), so it was left
   as-is. (`OPTIMIZATION.md` Round 5 covers the one genuinely quadratic loop
   that *was* worth fixing: the controller's `#interleave`.)

3. **`blobToVector` assumes 8-byte-aligned BLOBs.** It builds
   `new Float64Array(blob.buffer, blob.byteOffset, len/8)` directly over the
   stored bytes. `better-sqlite3` Buffers satisfy this, and the sql.js shim does
   too for these sizes (verified end-to-end), but a pooled/unaligned buffer
   source would throw `RangeError`. Documented as a hardening target, not
   changed — the production path is fine and realigning would copy every vector.

4. **The worker's state directory is now overridable.** Production passes no
   `stateFolder` in `workerData`, so the path is unchanged
   (`<src>/../state/main/memory_vault.db`); tests pass one to run against an
   isolated temp/`__vfs` directory.

---

## Test-harness limitations

These are limitations of the **browser** test harness
(`test/browser/harness.js` + `test/browser/shims/`), not of the shipped code;
they are recorded so a future run does not chase them as product bugs.

1. **The same entry cannot run twice in one Worker.** The `better-sqlite3`
   shim keeps a shared `registry` of open sql.js databases while the shim's
   virtual filesystem is keyed off `globalThis.__vfs`; evaluating the same
   entry a second time in one Worker ends with a
   `process.exit(0) called`-style failure. Run each entry in a fresh Worker
   (or use distinct DB directories), and keep `__ensureSql()`, `HiveMind`,
   `HiveMindController` and the shims in the **same** bundle.
2. **DB-opening modules must be imported dynamically.** `legion/database.js`
   (and the original top-level controller DB setup) open SQLite at
   *module-eval* time, so a test must `await __ensureSql()` and only then
   `import()`/bundle the module graph — a static import evaluates too early and
   fails with `sql.js not initialized`.
3. **`os.networkInterfaces()` is stubbed** to a single internal interface, so
   `getLocalIP()` returns `undefined` in the harness. Expected.

4. **`stateDir(label)` must be pure in `label`.** An entry may save and then
   reload through the same label (`stateDir('I')` before `dumpState()`, then
   `stateDir('I')` again for the reload), which is exactly what the browser
   default (`state/<suite>-<label>`) provides. Any caller that maps each *call*
   to a fresh directory makes the reload read an empty database and fails the
   round-trip with a `protos=0/<n>` detail (fixed bug #15, item 2). Node mirrors
   must use `labelledStateDir` from `test/node/helpers.js`.

5. **A replaced (seeded) `Math.random` can alias two sql.js databases, defeating
   the shim's path isolation.** sql.js names every in-memory database after
   `Math.random()` — `this.filename = "dbfile_" + (4294967295 * Math.random() >>> 0)`
   (sql.js 1.11.0) — so when a test substitutes a seeded stream (as
   `withSeed`-style helpers do) two `new Database()` calls can draw the same name,
   land on the same MEMFS file, and share one underlying database even though the
   shim's `registry` holds two distinct paths. **Observed directly** while
   proving R26-12: with `Math.random` reset to the same seed before each
   construction, a `HiveMindController` built in a *fresh* directory came up with
   `_globalAccuracy.trainingSteps = 78` and its `candles` table already holding
   the earlier controller's 60 bars (the first controller was clean at `0/0`);
   the digest is exactly the earlier controller's state. Resetting to a *different*
   seed, or not resetting at all, stayed clean — i.e. the collision is
   seed-specific and silent. Consequences and rules:
   - **Do not compare two controllers in one Worker while `Math.random` is
     seeded.** Prove a throttle/flag/interval hypothesis with a deterministic
     model *stand-in* (no RNG) instead — that is what `core.test.js` section H
     (R26-12) does — or add a node-only suite (`test/node/checkpoint_throttle.test.js`).
   - **`golden.test.js`'s controller block is verified NOT affected**: its two
     databases carry distinct sql.js filenames, and its fingerprints are unchanged
     by the isolation experiment below.
   - **A fix exists but must not be applied blindly.** Forcing each sql.js
     construction to a unique, counter-based filename (still consuming one draw
     from the app's stream, so the seeded position is preserved) removed the
     aliasing — but it also **moved five `golden` `ctl:*` fingerprints**. Why a
     change that only renames an internal MEMFS file moves the numeric trajectory
     is not yet understood, so the patch was reverted. Anyone re-attempting it must
     first obtain a native golden re-freeze (the node mirror is the authority) and
     record the re-freeze in `RUNBOOK.md` §6.

---

## Run-integrity audit — failure modes not covered by any test (round 21)

Found while re-evaluating the plan against the "small issues must not corrupt a
run or its data" requirement. These are **not fixed yet**; they are scheduled as
ROADMAP P0-1/P0-3. The shipped path `mainController.js → legion/runner.js →
batch.js → worker.js → HiveMindController.getSignal` is exercised by **no test**
(`legion.test.js` checks structure and drives `state` directly; it never streams a
file), which is why they survived the green local gate. Each item names how it
should be *confirmed* (all confirmations are node-only, since they need real
`worker_threads`/`better-sqlite3`), and none of the fixes may change a clean-path
trajectory (the 11 goldens stay literal).

- **A single worker rejection aborts the entire run.** `legion/batch.js`
  `await Promise.all(promises)` is wrapped in `try/catch` that calls
  **`process.exit(1)`**. Every rejection path feeds it: a `msg.error` from
  `worker.js`, `worker.on('error')`, a non-zero `exit` code, and the controller
  constructor's own `process.exit(1)`-on-mkdir-failure. So one bad controller, one
  transient SQLite error, or one bad path kills a multi-hour run *and* exits
  before the next checkpoint. **Confirmed by reading** (no test needed); fix =
  per-controller isolation + a failure budget (ROADMAP P0-1).
- **No worker timeout.** `runWorker`/`runConsolidationWorker` settle only on
  `message`/`error`/`exit`; a hung worker stalls `Promise.all` forever.
  **Confirm**: `test/node/worker_pool.test.js` with a worker that never posts.
- **Unvalidated constructor/config inputs.** `priceObj`
  (`atrFactor`/`stopFactor`/`minPriceMovement`/`maxPriceMovement`), `ensembleSize`,
  `cacheSize`, `tier`, `type` are used without finiteness/range checks, so a bad
  config produces silent `NaN` targets rather than an error. **Confirm**:
  malformed-config test asserting a clear throw.
- **Non-finite values at the SQLite boundary.** `getSignal`'s `prediction` can be
  `NaN`; the legion consensus divides by a possibly-zero `entryPrice`;
  `saveLegionState` can `JSON.stringify(undefined)`. A `NaN`/`undefined` bound to
  a `NOT NULL REAL` column throws, and on a nullable column it can silently store
  NULL. **Confirm** (sql.js shim / native): bind `NaN` to a `NOT NULL REAL` and
  assert the failure, then pin the sanitizer's rejection.
- **Corrupt-row intolerance.** `_updateOpenTrades`/`_processClosedTrades`
  `JSON.parse` the stored `features` TEXT column; a corrupt cell throws inside the
  worker → (see item 1) kills the run. **Confirm**: write a garbage `features`
  row, call `getSignal`, assert it is quarantined and skipped.
- **The runner loop cannot return.** `processCandles` ends with
  `await new Promise(() => {})` and binds `CONFIG.httpPort` (fixed), so it can
  neither be driven to completion nor run in parallel in a test. Fix =
  behaviour-preserving extraction with `maxBatches`/`onBatch` + an ephemeral port
  (ROADMAP P0-3).
- **No `getSignal` never-throws property test.** The four existing controller
  suites (`core`, `features`, `golden`, `multisymbol`) are happy-path/invariant;
  nothing fuzzes malformed candles or a partially-corrupt DB.

## Known / latent (not fixed — documented tradeoffs)

- **State is not bit-idempotent through SQLite — reload ≠ in-memory (two
  independent causes).** A `_saveState` → `_loadState` round-trip does not
  reproduce the live instance bit-for-bit. Measured directly (probe on the
  golden workload, ES=3, IS=12, forceMin), after training, dumping and
  reloading:

  - **Cause 1 — float32 BLOBs vs float64 memory.** `_saveState`
    (`hivemind/persistence/save.js`) writes the transformer weights,
    specialization weights and gradients as `Float32Array` BLOBs, while the
    in-memory matrices produced by `_dynamicInit` are plain JS number arrays
    (float64). Every reload therefore quantises those matrices. (Projection
    matrices, LSH hyperplanes and prototype means/variances are `Float32Array`
    in memory already, so *their* float32 blobs are lossless.) This is a
    deliberate storage-size tradeoff: fixing it by writing float64 BLOBs is
    arithmetic-neutral at save time but **doubles** the matrix storage.
  - **Cause 2 — derived state is recomputed, not restored.** Even with lossless
    matrix storage, a probe shows the reload still diverges because:
    - `_priorityIndices` is *not persisted*; the loader rebuilds it with
      `slice(0, this._priorityMax)` (`persistence/load.js`), but the runtime
      builds it with `slice(0, Math.round(priorityMax * tempOverloadFactor))`
      (`memory/banks.js`, `memory/consolidation.js`). On the golden config that
      is **16 loaded vs 40 live** candidates — a different retrieval set.
    - `projNorms` and `_cachedAvgVariance` are recomputed from the (identical)
      protos on load, while the live instance can hold stale cached values
      (e.g. `projNorms` that were not refreshed after an in-place mean
      mutation). The probe measured reload-vs-live deltas of ~1.6e-7 on
      `projNorms` and ~6e-10 on `_cachedAvgVariance`.

  Consequence: `golden.test.js`'s `hm:postReloadPrediction` is only
  *numerically* equal to the live prediction (guarded `< 1e-4` in golden,
  `< 5e-3` prediction drift and `< 1e-4` weight-fingerprint relative gap in
  `sanity.test.js` case F; two instances loaded from the **same** snapshot are
  bit-identical). A naive "just store float64 blobs" change was implemented and
  measured during the component-split work and then **reverted**: it did not
  reach bit-idempotency (Cause 2 dominates after Cause 1 is removed) and it
  changed the controller's trajectory (the controller reloads its `HiveMind`
  every step, so removing the per-step quantisation shifts every subsequent
  fingerprint). Reaching `Object.is` requires fixing Cause 2 first: persist
  `_priorityIndices` (or rebuild with the runtime's exact formula) and make the
  derived caches coherent between save and reload, *then* widen the blobs. Only
  then should the golden reload guard be tightened to `Object.is()`.

  Storage note: on the target low-end devices, float64 blobs double the size of
  the state DB for the matrix columns, so this is a real tradeoff to weigh
  against the precision gain.

- **`#computePercentile` coerces a real 0 to 1.0.** It returns
  `sortedNorms[index] || 1.0`, so a legitimate percentile value of exactly `0`
  (or an empty/NaN entry) becomes `1.0`. Only used for gradient-scaling
  thresholds where this over-scales rather than under-scales, so it is benign
  today, but it is a footgun.

- **`#computeVariance` is not a variance.** It returns a mean-absolute-deviation
  around the median, clamped to `min(mad, 10)`, and for even-length inputs picks
  the *upper*-middle element as the median. Callers treat it as a dispersion
  proxy; several thresholds are calibrated to that proxy, so do not "fix" it
  without re-tuning them.

- **`#isStagnating` is trigger-happy.** `noProgress = trend < noProgressThreshold`
  where `noProgressThreshold` is a small *positive* constant
  (`0.005 + 0.01·(1−protoCapacityFactor)`), so the no-progress branch fires
  whenever the recent trend is below a positive bar — which is most of the time.
  Stagnation also fires on low variance / low prototype variance, so the method
  effectively ORs three loose conditions. It is deliberate exploration pressure,
  not a bug, but it means "stagnating" rarely means what its name suggests.

- **`#projCache` (WeakMap) is correct.** Keyed by mean buffer identity and
  invalidated via `#invalidateProjCache` on every mean mutation; entries are
  collected with their buffers, so it does not leak.

- **`mainController.js` dimension selection is now audited.** `CONFIG.forceMin`
  is `true` in `src/legion/config.js`, so production runs the compact-dimension
  branch of `#scaleAndSetDimensions`, and every test also constructs `HiveMind`
  with `forceMin = true` (the constructor's default is `false`). The full-size
  (`forceMin = false`) branch is now exercised by `dimensions.test.js` (185
  checks) — an `es × is` sweep that freezes the compact overrides, checks the
  full branch's tensor shapes against its declared counts, proves the
  width-scaling monotonicity law, and runs end-to-end churn through the LSH
  index. **Result: no defect.** Flipping `CONFIG.forceMin` is therefore no longer
  a blind change — it is a deliberate switch between two now-tested branches, and
  (because production would then take a *different* arithmetic path) it remains
  an intentional golden re-freeze rather than a safe flip.

## Candle data: audit + quality layer (2026-09)

The legion's only data input is the shipped JSONL candle stream, so it now has a
dedicated verification layer and a larger, fresher dataset.

**Dataset.** Expanded from 3 → 8 symbols, full 1h history, all Binance
(`data-api.binance.vision`): BTCUSDT (~79.5k), ETHUSDT, SOLUSDT, BNBUSDT,
XRPUSDT, ADAUSDT, DOGEUSDT, LINKUSDT — **567,684 rows / ~63 MB** total. All
files pass the auditor: 0 non-finite/non-positive rows, 0 OHLC violations, 0
non-monotonic timestamps, 0 duplicates, <1% historical gaps, and the Binance-1h
group (all files) shares an identical timestamp grid.

**Finding — impossible wick in LINKUSDT.** The real venue print at
`2020-03-12T10:00Z` has `open 3.0634, high 3.0765, low 0.0001, close 2.4693`: a
0.0001 wick on a ~3.0 bar (the March-2020 crash). It is structurally valid (the
auditor does not reject it) but economically impossible, and it poisons any
indicator derived from `low` (ATR, lower-band, range features). It is the one
seed of the quality layer.

**Fix — winsorize physically-impossible wicks at read time.** New pure module
`candle_quality.js` (`isImplausibleCandle` / `repairCandle` / `repairSeries`)
clamps a wick to the bar body extreme when it exceeds
`candleMaxWickFraction` (default `0.9`) of the total bar range. Wired into
`legion/runner.js` (guarded, allocation-free on clean data) via
`CONFIG.candleWickRepair`; each repair is logged and counted in
`state.candleRepairs`. Genuine extremes (ADA/LINK 2025-10-10 crash, XRP/DOGE
listing spikes, BNB's first 2017 bar) are deliberately untouched — the
threshold only catches the ~100%-of-range pathological wick.

**Why not edit the file instead?** Rewriting the JSONL would destroy the raw
venue record and make the fix invisible; repairing at read time keeps the
source-of-truth exact, is testable in isolation, and is reversible by flipping
one config flag. The audit suite (`candles.test.js`, 192 checks) pins both the
raw invariants and the repair behaviour.

**Freshness.** `update_candles_basket.js` (`npm run fetch:all`) updates every
manifest file in one command; `docs/ci/update-candles.yml` is the scheduled
workflow source (the workspace file API forbids a literal `.github` directory,
so it must be copied into place).
