# NeuLegion — Bug log

Status as of this revision. Everything in **Fixed** was verified with the
browser test suite (`test/browser/entries/`) or with the A/B golden harness
described in `OPTIMIZATION.md`; see `../test/browser/entries/sanity.test.js`
for the regression checks that now guard the first two entries.

The codebase is largely hand-rolled numerical code, so most of the defects
below are silent-wrong-answer bugs rather than crashes. **The five entries under
`## Found by the attempt-3 power run` (#26-#30) are all fixed in round 25** —
#26/#27 were report-honesty defects found by forensics, #28/#29 were arithmetic and
gate-logic defects found by the round-25 tests, and #30 was a silent-output wiring
defect found in the post-implementation review. If you change anything
under `src/`, run the full browser suite before and after
(**2070 checks**: `sanity` 59, `core` 20, `indicators` 75, `features` 11,
`consolidation` 48, `consolidation_worker` 18, `fetcher` 101,
`golden` 23 (bit-exactness), `modules` 50 (assembly), `legion` 57,
`candles` 95, `locks` 41, `analysis` 437, `price_precision` 29,
`multisymbol` 28, `lsh` 69, `surprise` 32, `sample_weights` 36,
`homeostasis` 30, `evolve` 36, `multiprobe` 77, `binarypc` 39,
`bitweight` 69, `querymod` 51, `walkforward` 62,
`dimensions` 185, `guards` 58 (run integrity), `observer` 76 (legion health),
`analyze` 158 (the A/B driver, controller-backed after round 23; run-integrity sections O/P/Q after round 24, R after round 24b, L2/N dependence-aware after round 25)) — plus `golden` on
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
   never-deleted state directory (`src/analyze.js:191` for the bare factory, `:254` for the controller one). Measured
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

## Found by the attempt-3 power run — fixed in round 25 (#26, #27), plus defects found while fixing them (#28, #29) and in review (#30)

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
returned `gate` as `applied` | `skipped-no-panel` | `not-needed` | `off`. The
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
indicator-processor audit content had lost its section heading (restored as
`## Hand-rolled indicators — audit findings`).

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
