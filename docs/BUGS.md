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
round-26b review` below),
and #33 in particular changes the *reading* of every `npm run analyze` number ever
produced: the driver fed the controller the whole growing candle prefix where
production feeds it a fixed window, so the controller's trade bookkeeping saw
ancient candles and trained on mislabelled trades. Do not size or interpret a run
until #33 is fixed. If you change anything
under `src/`, run the full browser suite before and after
(**2289 checks**: `sanity` 59, `core` 42, `indicators` 75, `features` 11,
`consolidation` 48, `consolidation_worker` 18, `fetcher` 101,
`golden` 23 (bit-exactness), `modules` 51 (assembly), `legion` 57,
`candles` 95, `locks` 41, `analysis` 562, `price_precision` 29,
`multisymbol` 28, `lsh` 69, `surprise` 32, `sample_weights` 36,
`homeostasis` 30, `evolve` 36, `multiprobe` 77, `binarypc` 39,
`bitweight` 69, `querymod` 51, `walkforward` 62,
`dimensions` 185, `guards` 65 (run integrity), `observer` 76 (legion health),
`analyze` 222 (the A/B driver, controller-backed after round 23; run-integrity sections O/P/Q after round 24, R after round 24b, L2/N dependence-aware after round 25, R26-0 window-contract, R26-12 checkpoint throttle, R26-2 model/label diagnostics, R26-11 label-policy variants, R26-4 concurrency, R26-5 turnover sweep, R26-6 stream selection, R26-13 seed replication/CRN, R26-14 forecast comparison (proper scores + DM + Model Confidence Set) and R26-8 decision-grade report after round 26)) — plus `golden` on
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

## Hand-rolled indicators — audit findings

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
one config flag. The audit suite (`candles.test.js`, 95 checks) pins both the
raw invariants and the repair behaviour.

**Freshness.** `update_candles_basket.js` (`npm run fetch:all`) updates every
manifest file in one command; `docs/ci/update-candles.yml` is the scheduled
workflow source (the workspace file API forbids a literal `.github` directory,
so it must be copied into place).
