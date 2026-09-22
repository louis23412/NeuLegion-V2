# NeuLegion

An evolutionary "hivemind" of small transformer controllers that collectively
trade a candle stream. Each `HiveMind` is an ensemble of tiny transformers with
prototype memory (episodic / adaptive / semantic / core) and an LSH index; a
`HiveMindController` wraps one per (group, section, layer, tier, direction)
slot, feeds it indicator data, and emits signals. Controllers share prototypes
("hivemind" broadcast) so knowledge propagates across the ensemble, and a
"legion" layer aggregates their signals by hierarchy.

This is a Node.js project — it is **not** runnable in the Perchance preview.
The generator wrapper around it (`index.html` / `main.pjs` at the workspace
root) is unrelated scaffolding and should be ignored.

**New to the codebase?** Start with [`docs/DESIGN.md`](docs/DESIGN.md) (the
frozen core design), then [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (configuration +
commands), [`src/README.md`](src/README.md) (the per-module map),
[`docs/COMPONENTS.md`](docs/COMPONENTS.md) (how the classes are assembled from
components), [`docs/LOCKED.md`](docs/LOCKED.md) (what is proven and by what) and
[`docs/BUGS.md`](docs/BUGS.md). The research grounding for every core mechanism
lives in [`docs/research/`](docs/research/) with the bibliography in
[`docs/CITATIONS.md`](docs/CITATIONS.md); the prioritized backlog is
[`docs/TODO.md`](docs/TODO.md) and the current plan is
[`docs/ROADMAP.md`](docs/ROADMAP.md); the A/B run forensics (all three power-run
attempts), the round-24/24b run-integrity work (checkpointing, state reclamation,
a liveness heartbeat, the audit block, `--reuse-base`), the **recorded N3
verdict** (nothing promotes: all 14 candidates keep-off, SPA p = 0.5699) and the
**round-26 controller/A-B fidelity sweep** (which found that the A/B feeds the
controller the whole candle prefix where production feeds a fixed window, so its
baseline rows are not the shipped model — `BUGS.md` #33; its second pass added the
label-realism and base-rate findings #36/#37, corrected the round-25c cost claim
and measured where the A/B's per-call cost actually is — `BUGS.md`, `RUN-ANALYSIS.md`
§8.4, `OPTIMIZATION.md` "Round 26b") are in
[`docs/RUN-ANALYSIS.md`](docs/RUN-ANALYSIS.md) — the decision record itself is
[`docs/OPTIMIZATION.md`](docs/OPTIMIZATION.md). The evaluation-method decisions
(e.g. why the scored path replays each fold rather than warming a per-stream
snapshot) are in [`docs/METHOD.md`](docs/METHOD.md).

**Scope is frozen.** The intended core design is closed
([`docs/DESIGN.md`](docs/DESIGN.md)); new systems are added only when
demonstrably essential and passing its definition of done. The authoritative
local gate is `npm test`.

## Layout

```
src/
  README.md                module map: what every file owns, technique, test
  mainController.js        13-line entry -> legion/runner.js#processCandles
  worker.js                per-controller worker; builds a HiveMindController
                           and calls getSignal()
  consolidation_worker.js  offline consolidation worker (thin shell over
                           consolidation_logic.js)
  consolidation_logic.js   pure memory-lifecycle algorithms: Gaussian distance,
                           content hash, decay, pairwise merge, promotion, and
                           the prototype proximity graph
  http_server_worker.js    read-only HTTP view of legion state (config.httpPort)
  candle_fetcher.js        network-free fetch/merge/gap/dedupe JSONL library
  fetch_candles.js         CLI around candle_fetcher.js (see npm run fetch*)
  candles.jsonl            default candle stream (BTCUSDT 1h)
  data/                    per-symbol candle files (e.g. candles_ethusdt_1h)
  hivemind/
    hiveMind.js            shell: fields, constructor, public predict/train/dumpState
    hiveMindController.js  shell: fields, constructor, public getSignal
    hivemind/<domain>/*    22 component bags (kernels, memory, transformer,
                           ensemble, training, persistence, knowledge, internal)
    controller/*           5 component bags (database, accuracy, candles,
                           features, trades)
    indicatorProcessor.js  candle -> indicator feature vectors
    utils.js               numeric predicates (isValidNumber, isFiniteNumber,
                           truncateToDecimals, isValidTimestamp)
  analysis/                additive supercharges (never imported by the hot path):
                           performance.js (Sharpe/PSR/DSR/MinTRL/bootstrap),
                           splits.js (purged K-fold/walk-forward),
                           labels.js (triple-barrier/CUSUM/fractional diff),
                           uniqueness.js (sample uniqueness/sequential bootstrap),
                           backtest.js (no-lookahead backtest + pooled folds),
                           walkforward.js (walk-forward harness, no-lookahead audit,
                             promotion gate, family-wise SPA/Romano-Wolf, pooling),
                           world.js (the audited candle view the audit perturbs),
                           features.js (the 8-candidate causal signal family)
  candles_audit.js         pure candle-file integrity auditor + CANDLE_MANIFEST
  candle_quality.js        winsorize physically-impossible wicks at read time
  price_precision.js       magnitude-derived target-price decimal grid (train-time)
  update_candles_basket.js update every manifest candle file in one command
  legion/                  mainController's 16 components (state, config,
                           signals, broadcast, database, statements, workers,
                           serialization, structure, accuracy, batch, ...)
test/
  component-manifest.js    single source of truth for the component split
  browser/                 headless test suite (see below)
  node/                    plain node:test suite (see below)
docs/
  BUGS.md                  fixed bugs + known/latent issues
  COMPONENTS.md            component architecture & editing rules
  DESIGN.md                FINAL CORE DESIGN (frozen scope + definition of done)
  RUNBOOK.md               configuration, commands, expected test ledger
  OPTIMIZATION.md          CPU optimization log, method, hotspots, next win
  ROADMAP.md               consolidated next-step plan + priority rationale
  TODO.md                  full history + research backlog
  RUN-ANALYSIS.md          A/B run forensics + the plan to a citable verdict
  LOCKED.md                per-component proofs and lock status
  CITATIONS.md             bibliography for every grounded mechanism
  research/                per-domain literature notes + raw arXiv sweeps
```

`CONFIG` at the top of `src/legion/config.js` holds the tunables (population
sizes per tier, cache sizes, ATR/stop factors, broadcast/injection ratios,
ports and paths). `CONFIG.forceMin = true` ships the **compact, CPU-constrained
dimensions**; the full-size branch (`false`) is audited by `dimensions.test.js`
and is a deliberate re-freeze away. Every knob is documented in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) §4.

## Running

```
npm install
npm run train          # node ./src/mainController.js  (reads ./src/candles.jsonl)
```

The HTTP state view listens on `CONFIG.httpPort` (default 3000).

### Candles

The stream is kept fresh with `src/fetch_candles.js` (network-free logic in
`src/candle_fetcher.js`):

```
npm run fetch          # incremental update of src/candles.jsonl
npm run fetch:full     # backfill from the earliest available bar
npm run fetch:check    # report only (no network, no write)
npm run fetch:all      # incremental update of EVERY manifest symbol
npm run fetch:all:full # backfill every symbol
```

`src/candles_audit.js` is the manifest of shipped candle files (8 Binance 1h
symbols, ~567k rows / ~63 MB); the audit is run by `candles.test.js`. A scheduled
workflow source lives at `docs/ci/update-candles.yml` (copy it to
`.github/workflows/` — the workspace file API forbids a literal `.github` dir).

All options (`--symbol`, `--interval`, `--source`, `--out`, `--mode`, `--limit`,
`--since`, ...) are documented at the top of `src/fetch_candles.js`. Binance's
`api.binance.com` is geo-blocked in some networks; the fetcher defaults to
`data-api.binance.vision` and falls through Bybit/Coinbase.

## Tests

Two suites. **Run the full browser suite after every change to `src/`** — it
exercises the real code paths headlessly and is what guarded the bug fixes in
`docs/BUGS.md`.

### Browser suite (works anywhere, no Node needed)

`test/browser/harness.js` bundles the project with esbuild-wasm, aliasing Node
built-ins (`better-sqlite3` -> `sql.js`, `fs`, `path`, `crypto`, ...) to the
shims in `test/browser/shims/`, producing a Blob-URL ESM module that runs in a
Web Worker. Entries are `test/browser/entries/*.test.js`, each exporting
`async function run()` that returns `{ total, failed, failures, checks }`.

| entry | checks | what it pins |
| --- | ---: | --- |
| `sanity.test.js` | 59 | internal invariants: probability bounds, finite weights/gradients, **LSH index consistency**, determinism under a seeded PRNG, save/load fidelity, predicate edge cases, extreme inputs |
| `core.test.js` | 42 | end-to-end controller contract (signal shape, directional invariants, persistence, broadcast/translate) |
| `indicators.test.js` | 75 | the hand-rolled indicator processor: guard/error contract, junk-row filtering, output-length contract, ranges, flat-series closed forms, end-alignment, causality, determinism, non-mutation |
| `features.test.js` | 11 | the controller's feature extraction: tier>1 child-memory path (`_computeProtoQuality` / `_robustNormalize` / `_interleave`, read back from `open_trades.features`), plain-array vs TypedArray equivalence, empty-child padding, tier-1 path |
| `consolidation.test.js` | 48 | pure memory-lifecycle algorithms in `consolidation_logic.js` |
| `consolidation_worker.test.js` | 18 | end-to-end `consolidation_worker.js` wiring (real worker, sql.js `memory_vault.db`, posted `delta`) |
| `fetcher.test.js` | 101 | `candle_fetcher.js`: interval/source mapping, URL build/parse, pagination, merge/dedupe/gaps, JSONL round-trip |
| `golden.test.js` | 23 | **bit-exactness**: FNV-1a fingerprints of a seeded, deterministic training + controller trajectory; the guard for any refactor |
| `modules.test.js` | 51 | **assembly**: every component method installed exactly once, manifest/prototype agreement, `installMethods` guard rails |
| `legion.test.js` | 57 | the `mainController.js` -> `legion/` split: module graph, statements, signals, broadcast, serialization |
| `candles.test.js` | 95 | candle-file integrity: per-file OHLCV/grid/gap audit, cross-file timestamp-grid equality, wick-repair behaviour, row/size budget |
| `analysis.test.js` | 562 | the analysis supercharges: exact reference vectors for PSR/DSR/MinTRL/purged CV/triple-barrier/fractional diff/uniqueness, plus the order-preserving concurrent fold scheduler, a no-lookahead backtest that provably does not bless noise, a **calibrated** stationary-bootstrap p-value (5.8% false positives at the 5% level; 17.5% before the `BUGS.md` #10 block-restart fix), a full-pipeline random-walk control (CUSUM -> labels -> uniqueness -> purged CV), combinatorial purged CV (`C(k,m)` folds, each observation tested exactly `C(k-1,m-1)` times), pooled strategy aggregates that are per-fold sums (`BUGS.md` #11), the walk-forward harness (section S: causal-fold enforcement, the exact no-lookahead audit, the promotion gate's size + power, and the `step`-validation fix from `BUGS.md` #12), the dependence-aware inference layer (section AD: Pearson + Kish design effect, the delete-one-cluster jackknife against the closed-form equicorrelation SE, the exact sign test, the four gate states, the cost ladder and `familyCorrelation`), the probability of backtest overfitting (section T: exact `C(S,S/2)` CSCV structure, the rank/logit mapping, calibration on noise / a planted edge / a planted regime flip, and the enumeration cap from `BUGS.md` #13), White's Reality Check + Hansen's SPA (section U: exact benchmark handling and `sqrt(T)·max mean` / `max(0, mean/SE)` statistics, Politis-Romano block indices that are exactly i.i.d. at `blockLength=1`, ~5% null size with ~Uniform p-values, a strong-edge rejection, and SPA beaten only by RC on conservativeness — p=0.078 vs 0.762 — on one real edge among nine poor candidates), and consistent SPA + Romano-Wolf StepM (section V: the exact recentring bound `A_k = omega_k·sqrt(2 log log T)`, the consistent<upper<RC ladder 0.058<0.078<0.762, the first StepM step provably equal to single-step SPA, monotone step p-values, a degenerate guard, and measured 5% FWER 0.075/0.065 with 0.89 power), and automatic block-length selection (section W: `politisWhiteBlockLength` reproduces `arch`'s published oracle vectors exactly — stationary 13.63566513 / circular 15.60894008 on `RandomState(0)`+`standard_normal(10100)` AR(0.3) — rises monotonically along a dependence ladder 0.651 -> 8.429 as phi: 0 -> 0.8, and the opt-in `blockLength: 'auto'` restores i.i.d. size 0.047 vs 0.087 fixed while beating b=1 under AR(0.8) 0.413 vs 0.74; the residual AR(0.8) liberal-ness is pinned to a bootstrap-SE scale bias, not the block length), and variance-consistent subsampling inference (section X: `neweyWestSE` is the exact Bartlett SE, `subsamplingSpa` builds the reference from every overlapping window of the same series — deterministic, no rng, one bandwidth shared by the window and full scales so the studentization is pivotal — and `subsamplingStepM` is the Romano-Wolf step-down on the same windows; the 5% size is nominal at EVERY persistence: 0.0533/0.0533/0.0567/0.0433 at phi=0/0.2/0.5/0.8, T=100, versus the block bootstrap's 0.20/0.4067 at phi=0.5/0.8 — a ~9x distortion cut — while keeping power 0.72-0.80), and the segment-aware family-wise search (section Y: the opt-in `groups` argument estimates the long-run variance within a segment — `groups=[T]` bit-identical to ungrouped, grounded in the mean-shift LRV case arXiv 2603.17226 — and `familywiseSearch`/`walkForwardSearch` drive subsampling SPA + Romano-Wolf step-down over the pooled out-of-sample returns, with `promoteDecision`'s opt-in `maxSearchP`/`requireSearchReject` hurdles and the `formatReport` search line), and single-step **k-FWER** + step-down **FDP** (section Z: `subsamplingKfwer` controls `P(k or more false rejections) <= alpha` on the same deterministic window grid — the `k=1` p-value exactly equals the SPA/StepM first p-value — while the EXPERIMENTAL `subsamplingFdp` steps down with the growing reference `k_l = floor(fdpTarget*l)+1`; measured global-null FWER/2-FWER is 0.07/0.075 at T=200 and 0.04/0.055 at T=80, the FDP estimator rejects nothing beyond the first step in ~95% of reps, and the naive survivor-order-statistic variant is documented as REJECTED: 0.085 at T=80 / 0.145 at T=200), and the mixture-family power/FDP validation (section AA: k=2 k-FWER is strictly more powerful than k=1 on a weak 2-edge family — 0.155 -> 0.4975 — while FWER/2-FWER stay <= alpha; the FDP step-down rejects monotonically more as the target loosens on a 20-candidate mixed family, 6.833 < 9.05 < 9.783, with realised FDP below target there but slightly OVER-running a tight target on a sparse family (0.1014 > 0.10) — the measured finite-sample non-control that keeps `subsamplingFdp` EXPERIMENTAL), and edge-case/invariant hardening of the generalised rates (section AB: a single-candidate family throws K>=2, an all-zero family rejects nothing under the t=0 guard, exactly tied candidates share a statistic/p-value/decision, a series benchmark zeroes the candidate equal to it, `groups=[T]` is bit-identical to ungrouped, a tiny target keeps kHat=1, and a near-zero alpha never rejects more) Round 23 adds section AC (the causal signal family + reported pooling): exact reference vectors for all eight `analysis/features.js` features (momentum, fractional-diff momentum, realized-vol regime, momentum agreement, range location, volume imbalance, autocorr1, acceleration), a causality invariance check (a position at `t` is unchanged when every value after `t` is altered), the exact causal z-score / clamp pipeline, `poolReports`/`poolFolds` merge semantics (one report is the identity; the merge concatenates folds/returns and ANDs the audits), the Lo (2002) Sharpe SE / MDE closed forms, the `world.js` shock (bounded, deterministic, non-mutating, real candles on the base pass) and `worldFromCandles` alignment. Round 26 adds section AF (the turnover attack, R26-5): `positionSeriesFromConfidence` is byte-identical to the pointwise confidence→position map with no holding rule, holds a position through the whole enter/exit band and honours a minimum holding period, and `turnoverSweep` enumerates the frozen dead-zone × hysteresis × holding grid, sorting rows by break-even cost (a wide dead zone abstains at least as much as a narrow one). Section AG adds the effective-independence primitives (R26-6): the exact OHLCV resampler, the Kish design effect `1+(K-1)·rbar` (identical streams are one bet; a perfectly hedging pair and a <3-bar window are flagged unavailable) the greedy stream selection, and (R26-6) `formatStreamSelection`. Section AH adds the seed-replication / CRN statistics (R26-13): the interquartile mean, a stratified bootstrap that resamples within each seed stratum (a zero-width CI on constant unequal strata), the hand-computed seed/fold/residual variance split, the `pairedVarianceRatio` CRN criterion, and (R26-13) `formatSeedReplication`. Section AI adds the forecast layer (R26-14): proper scores (Brier + reliability/resolution/uncertainty, log score), the Diebold–Mariano test on per-bar Brier-loss differentials, and the Hansen–Lunde–Nason Model Confidence Set. Section AJ adds the gate-discriminating stability layer (R26-7): `clusterStability` is exact on hand-computed stable/fragile/unavailable panels, and the gate fixtures show a tiny edge failing the magnitude floor while a broad-but-thin edge fails stability and a real spread edge passes. Section AK adds the decision-grade report (R26-8): `foldConcentration` (top-K share of gross, signed sums, the leave-one-fold-out Sharpe range and the per-fold marginal contribution), `confidencePersistence` (lag-1 and half-life of the journaled confidence), `nextRunPlan` (effective bars/MDE, bars-to-detect at the measured design effect, break-even vs 0/2/5/10 bps, the cheapest flip) and the six-question `decisionReport` composition. Section AL documents the correlated-fold null (R26-9): the exact sign test over 40 independent windows rejects at ~4%, but ~31-36% when the windows share a common component — the evidence behind keeping the per-fold replay (`docs/METHOD.md` §1). Section AM validates the successive-halving engine (R26-15): the race winner equals the brute-force full-grid oracle while spending less budget, so a racing budget cannot change the decided set (`docs/METHOD.md` §2). |
| `price_precision.test.js` | 29 | `price_precision.js`: exact target-grid vectors, clamps/invalid input, and the invariant that rounding a take-profit/stop-loss by the minimum movement never crosses the entry price |
| `multisymbol.test.js` | 28 | replays all eight shipped symbols through the real controller at each one's lowest-price window; asserts zero direction inversions and finite signals for both polarities (regression guard for the sub-cent bug, `BUGS.md` #9) |
| `lsh.test.js` | 69 | **LSH recall-preservation**: unit-norm projection metric (and the reproduced `1/sqrt(lowDim)` regression), bit-exact hash words, leak-free bucket index, 100% exact-match recall at both config widths, the `Pr[flip]=θ/π` rounding law to ≤0.03, and end-to-end `_retrieveTopRelevantProtos` recall; section I additionally pins the **data-aware hyperplane refresh** (`_refreshLshHyperplanes`, default-off `_pcaHashConfig`) — off-state no-op, unit-norm hyperplanes, leak-free bucket rebuild, seeded bit-determinism, `minRows` fallback, and a save/load round-trip — and measures it on a real 107-bit index: self-recall under noise 0.68 → 0.775 at σ=0.25 (prefix 0.315 → 0.395) with no loss at σ=0.1, plus the noise-tail caveat that aligning **every** direction is a no-gain config (0.655); and the Round-15 data-driven rank (`rankPolicy: 'above-mean'`, from `memory/bitweight.js`) reads ranks 22-23 off the spectrum and reaches 0.75 at σ=0.25 without the `dim/4` constant; section J pins **dynamic query modification** (`memory/querymod.js`, default-off `_queryModConfig`): byte-identical when toggled back, pool a mechanical **superset** so recall cannot fall, **live** on the narrow 6-bit index and a **measured no-op** on the production 107-bit index (the empty-consensus-bucket regime) |
| `surprise.test.js` | 32 | **surprise-gated memory writes** (`memory/surprise.js`, Titans arXiv 2501.00663): exact gate vectors, bounds + monotonicity, `floor=1` collapses the gate to a bit-identical no-op (two identically-seeded banks fingerprint equally), and the measured gated/ungated write-size ratio equals `surpriseGate(1 - measuredSimilarity)` |
| `sample_weights.test.js` | 36 | **sample-uniqueness loss weighting** (`training/sample_weights.js`, Lopez de Prado AFML ch. 4): exact average uniqueness on fixed label intervals (bit-for-bit vs `analysis/uniqueness.js`), mean-1 / sum-1 normalisation, Kish ESS, `spanWeightsFromEntries` overlap semantics, and `train(inputs, target, w)` being exactly linear in `w` (energy ratio `w²`) with `w=1`/non-finite `w` a bit-exact no-op |
| `homeostasis.test.js` | 30 | **homeostatic plasticity** (`ensemble/homeostasis.js`, Turrigiano synaptic scaling; arXiv 2609.13771): bounded/monotone multiplier with an exact set-point fixed point, EMA activity signal, RMS + deviation energy, the proven contraction condition `0 < gain·target < 2`, closed-loop convergence to `target/k` across a `k`-sweep, and enabled-with-`gain=0` a bit-exact no-op against the default path |
| `evolve.test.js` | 36 | **low-rank ES** (`legion/evolve.js`, EGGROLL arXiv 2609.10980; antithetic estimator arXiv 1703.03864): the quadratic identity `ĝ = S·Hθ` verified exactly to `1e-9`, the PSD second-moment descent-direction guarantee, full-rank alignment with the true gradient, low-rank unbiasedness for the projected gradient, and **monotone fitness** to the optimum on a toy convex quadratic (full-rank and rank-3) |
| `multiprobe.test.js` | 77 | **margin-ordered multi-probe LSH** (`memory/multiprobe.js`, Lv et al. VLDB 2007; wired into the locked `_getGlobalLSHCandidates` behind the default-off `_multiProbeConfig`): `marginOrder`/`rankPerturbations` exact structure+cost ordering, the **flip lemma** (`bit b flips ⇔ \|δ_b\| > \|q_b\|` and opposing sides, so the lowest-margin cover is complete), P(flip) monotone decreasing in margin (0.48→0.04 across octiles), margin order dominating the historical prefix probe at every budget and every sampled random order, exact ≤1-bit/≤2-bit completeness identities, and a real wide-hash index where margin probing lifts self-recall under noise from **0.03 → 0.30** at σ=0.25, and the wired-but-default-off lean helper's own pool self-recall rises **0.167 → 0.517** at σ=0.25; and the **query-adaptive probe budget** (Round 16, NeuRoute arXiv 2608.15438 / adaptive bucket probing arXiv 2604.04603) — `adaptiveMultiProbeConfig`, off by default and byte-identical when off — reads the probe depth per query from the exact recovery coverage, is proven exhaustive over the probed bits, and on a calibrated real index needs **no probing at all** for many queries at low noise (spending fewer probes than a fixed budget) while beating the fixed 8-probe budget at high noise |
| `binarypc.test.js` | 39 | **data-aware binary principal components** (`memory/binarypc.js`, BinaryPC arXiv 2608.04405; the training-free alternative to random-hyperplane SimHash, wired into the locked `lsh` bag behind the default-off `_pcaHashConfig`): exact means/covariance/dot, power iteration recovers a dominant eigenpair deterministically, exact eigenvalues + orthonormal components on a diagonal covariance (with the trace decomposition), the top component recovers a planted direction (`\|cos\|>0.999`), and the flagship **Eckart–Young** claim — the PCA-aligned subspace beats **every** one of 20 random subspaces on reconstruction error (>2× margin) with error non-increasing in bits; `pcaHashTables` tables are orthonormal, all lie inside the PC subspace, and are seed-deterministic; `alignedHashTables` handles oversubscribed budgets (`bits>dim`) — aligning `min(bits,dim,nrows-1,maxRank)` directions and drawing the surplus from random **unit** vectors, with the aligned prefix orthonormal and in-subspace, `maxRank`/rank-deficiency caps, and thrown degenerate inputs; `bits>dim` and zero-variance data throw; section H pins the per-direction `tableVariances` (equal to a brute-force variance, with the aligned prefix above the `trace/dim` random-direction baseline and the surplus sitting at it exactly) and the data-driven `rankPolicy` (`above-mean`/`noise`, deterministic, `maxRank`-capped) |
| `bitweight.test.js` | 69 | **bit-reliability theory** (`memory/bitweight.js`; fuels `binarypc.js`'s `rankPolicy` behind the default-off `_pcaHashConfig`): the exact bit-flip law `P = arccos(sqrt(λ/(λ+σ²)))/π` with exact values/limits/monotonicity and **Monte-Carlo** agreement (max dev 0.00055 over 2e5 draws), the binary-symmetric-channel reading (`reliabilityWeight = 1−2P`, `bitInformation = 1−H₂(P)`), the margin law `Φ(−\|margin\|/σ)` (ascending-margin order IS descending flip-probability order — why Lv probes the right bits), the spectral noise estimator + `selectReliableRank`, exact `reliabilityWeights`, `weightedHamming`/`weightedKeyDistance` verified against a brute-force recompute on 32-bit **and** BigInt words, the **live-index validation** (predicts a real aligned index's flip rate to within 0.012), and the recorded negative result that reliability-weighted candidate ranking does not beat plain Hamming on the rotation-based index; and (Round 16) the **query-adaptive budget** primitives — the exact Poisson-binomial count/quantile, the monotone containment coverage and the exact recovery coverage (`probeRecoveryCoverage`), the single-pass `recoveryDepth` proven equal to a brute-force scan, and `calibrateNoiseFromFlips` predicting a real index's mean Hamming distance to 1e-6 |
| `querymod.test.js` | 51 | **dynamic query modification** (`memory/querymod.js`, arXiv 2605.23807; wired into the locked `_getGlobalLSHCandidates` behind the default-off `_queryModConfig`): the four paper results proved exactly — Theorem 1 (`<c>` maximises `Σ x·u`, and `Σ(<c>·x) = ‖Σx‖ = k‖mean‖`), Theorem 2 (first-order ACP `½ + Σ x·u/(kπ)` maximised at `<c>`, which also beats the average random direction on the exact Charikar ACP), Appendix C.1 (`averageCovariance = const − ((Σ x·u)/k)²`, minimised at `±<c>`), and §6.4 (the centroid collides with a member on every direction — 0 failures in 200 — while the exact singleton witness `q = −x` fails 200/200); the Charikar law matched by 4e4 random hyperplanes to <0.01; the **denoising law** (the 40-view centroid at σ=0.3 cuts the per-bit error rate several-fold); and the **synthetic regime sweep** (recall 0.540 → 0.789 at 6 bits, gain decaying monotonically to 0.001 at 24 bits) |
| `analyze.test.js` | 222 | the **A/B driver** (`npm run analyze`): the variant table + `applyVariant` flags, the causal `featureVector`, the deterministic fake model factory, `evaluateAB`'s audit-driven promotion / zero-skill rejection, the family-wise statistics, the `formatAnalysis`/`readCandles` paths, and the round-24/24b run-integrity sections (per-fit state reclamation, the per-pass event stream, run checkpointing + the failed-run post-mortem, the volume-shocked audit, the assumption-free break-even cost, the offline-readable journal and `--reuse-base`); round 25 adds the dependence-aware gate, the cost ladder, the family diagnostic and the paired promotion test; round 26 adds the R26-0 window contract, R26-12 checkpoint throttle, R26-2 model/label diagnostics, R26-11 label-policy variants, R26-4 concurrency, R26-5 turnover sweep, R26-6 stream selection, R26-13 CRN/seed replication (the per-fold net-Sharpe series on every row plus `replicateAnalysis`/`--seeds`) and R26-14 forecast comparison (the default-on `forecast` block + MCS, `--forecast=0` to disable) and R26-8 the decision-grade report (the default-on six-question `decision` block + the summary lines, `--decision=0` to disable) |
| `walkforward.test.js` | 62 | the **walk-forward harness on real shipped candles**: a live `HiveMind` re-fit per fold (frozen afterwards) with a clean no-lookahead audit, the audit catching a `t+1` feature, an always-long == per-fold buy-and-hold closed form, a flat signal exactly inert, bit-identical determinism, an honest promotion-gate decision, and the default-off features (surprise/homeostasis/multi-probe) A/B'd through the harness — their inert settings bit-identical to off, plus the family-wise search on the real-candle walk-forward (section H: the step-down p-values `[1,1,0.333,1,0]` agree with the DSR floor on all five candidates, both catching the oracle control; section I repeats it on the full 150-bar / 6-fold slice, widening the grid from 18 to 48 windows with the same verdict) Section K is the round-23 vacuity regression guard: the candle-driven `t+1` leak that used to pass clean because a returns-only perturbation could not reach a candle model is now **caught** via the `viewFor` hook (with `viewDiffers`/`reachable` true), an honest candle signal stays clean, and a `viewFor` that ignores the perturbation is flagged `vacuous`; the section also pins `sharpeStandardError`/`minimumDetectableSharpe`, `worldFromCandles`, and that `walkForwardEvaluate` forwards `viewFor` to both the scoring view and the audit. |
| `dimensions.test.js` | 185 | the **structure-scaling contract** (`persistence/dimensions.js`): the compact `forceMin` overrides frozen as exact constants, and the full-size branch swept over an `es × is` grid — tensor shapes match their declared counts, layers/heads/hidden are monotone non-increasing in ensemble size while the learning rate is monotone non-decreasing, only the learning rate depends on `inputSize`, end-to-end churn keeps the LSH index consistent with unit-norm projections, and boundary configs (`es=1`, `is=1`) construct cleanly |
| `locks.test.js` | 41 | the lock registry: every component classified + grounded, statuses valid, research notes + citations exist, the frozen-design docs (`DESIGN.md`, `RUNBOOK.md`) exist, support modules exported, LSH recall invariant registered, surprise gate + uniqueness weighting + homeostasis + low-rank ES + multi-probe + data-aware binary-PC + dynamic query modification registered |
| `bench.test.js` | — | not pass/fail: construct / predict / train / broadcast timings and per-step call counters |

`golden.test.js` is the one to run after **any** edit under `src/hivemind/`: if a
fingerprint changes, either you changed the math (re-freeze the constants in
the same commit and say why) or you broke it.

To run them from the Perchance agent workspace, use `execute_js` (one worker per
entry; see `test-harness limitations` in `docs/BUGS.md`):

```js
globalThis.__fs = globalThis.fs;
const h = await import(URL.createObjectURL(new Blob(
  [await fs.readTextFile('src/NeuLegion-master/NeuLegion-master/test/browser/harness.js')],
  { type: 'text/javascript' })));
const m = await h.importBundled('src/NeuLegion-master/NeuLegion-master/test/browser/entries/sanity.test.js');
return await m.mod.run();   // { total, failed, failures, checks }
```

`HiveMind` also exposes a read-only `diagnostics()` method returning weight and
gradient statistics, per-member memory counts, and LSH consistency — that is
what `sanity.test.js` asserts against, and it is handy when debugging a live
instance.

### Node suite

`test/node/` uses the built-in `node:test` runner and a real `better-sqlite3`
(**Node ≥ 22**; run natively, not in the Perchance sandbox):

```
npm test               # = node --test "test/node/*.test.js"
```

The glob is deliberate: Node ≤ 21 accepted a bare directory
(`node --test test/node/`) and searched it recursively, but Node ≥ 22 resolves
the positional argument as a glob pattern and tries to load a directory as a
module, so the old form dies with `Cannot find module '.../test/node'` before
running a single file (see `docs/BUGS.md` #14 and `docs/RUNBOOK.md` §7). The
focused scripts (`npm run test:locks`, `test:candles`, `test:analysis`) pass a
file path, which is a valid glob in both regimes.

It mirrors the browser checks with a shared `helpers.js`, in **two styles**: 21
files import the browser entry's `run()` and assert `failed === 0` **and**
`total ===` that entry's count in the `RUNBOOK.md` §6 ledger (so a silently
skipped section cannot pass), and 8 re-declare the same contracts directly with
`node:test` against the real driver (`sanity`, `core`, `features`, `indicators`,
`fetcher`, `consolidation`, `consolidation_worker`, `legion`). The remaining
thirteen are Node-only suites the browser harness cannot provide: `mirrors.test.js`
checks the mirror layout itself (ledger counts, no orphan or stub mirrors, the
`engines.node` floor, and that the `test` script is a runner-compatible glob);
`engine_portability.test.js` runs one golden pass under a simulated last-ulp
`Math.exp` drift and asserts all 23 checks still hold; and the rest are native-driver
suites (`worker_pool`, `runner_smoke`, `dryrun`, `preflight`, `http_view`,
`report_lifecycle`, `shutdown`, `config_env`, `checkpoint_throttle`,
`parallel_folds`, `analyze_cli`). `golden` runs
here too — the bit-exactness lock on the
**native** driver, not just on the sql.js shim — and its live-prediction
fingerprint is compared at 6 significant digits because it is over raw float64
`predict()` output (the other nine hashes are literal; `hm:postReloadPrediction`
is the second rounded one, per P2-3). `bench` is the only
browser entry with no mirror (it prints timings and has no pass/fail contract),
so a run reports **123 `test()` blocks, not 2289 individual checks**, and takes a few minutes
(the `dimensions` sweep dominates). Mirror-injected options must respect the
entries' contracts: `stateDir` is pure in its label (use `labelledStateDir`) and
the sql.js shim may only be imported lazily — see `docs/BUGS.md` #15–#17, which
record the first two local runs, the three mirror defects they exposed, the
coverage gaps closed since, and the engine-portability fix to the golden lock.

The consolidation mirror is special: `consolidation_logic.js` is pure, so it
imports the exact module the worker uses, and `consolidation_worker.test.js`
spawns the real worker on a real `worker_threads` Worker against a temp
better-sqlite3 database (the worker accepts an optional `stateFolder` override
for this). The development sandbox has no Node, so the mirrors are written —
never executed — here; a local `npm test` is the gate. **It is now green** (115
tests, 115 pass, 0 fail, ~5.9 min; `docs/BUGS.md` #20/#21), which is what promoted
the three controller DB bags out of `NEEDS-LOCAL-RUN`.

## Conventions

- Everything is ESM (`"type": "module"`).
- All numeric predicates go through `utils.js` (`isValidNumber` /
  `isFiniteNumber` are exact twins for numbers; use `Number.isFinite` only in
  hot loops where the input is provably a number).
- Large classes are split into a **thin shell + component bags** installed by
  `hivemind/internal/mixins.js#installMethods`, with the manifest in
  `test/component-manifest.js` as the source of truth. See
  `docs/COMPONENTS.md` for the editing rules (one home per method, bags need
  commas, each bag imports its own dependencies).
- Keep the hot math in `hiveMind.js` / `hivemind/*` bit-exact unless you have an
  accuracy benchmark for the change — see `docs/OPTIMIZATION.md` for the A/B
  method and the one large, deliberately-unexploited win.
