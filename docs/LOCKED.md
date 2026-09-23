# NeuLegion — what is LOCKED

This is the human-readable companion to the machine-readable registry
[`../test/lock-registry.js`](../test/lock-registry.js). The registry is the
source of truth; `test/browser/entries/locks.test.js` fails if this document and
the registry disagree on a component's status, and if any component in
[`../test/component-manifest.js`](../test/component-manifest.js) is unclassified.
The frozen set of design components these locks cover is [`DESIGN.md`](DESIGN.md);
the local promotion gate is [`RUNBOOK.md`](RUNBOOK.md) §6.

**Why "lock":** the user asked us to stop re-litigating components that are
already proven. Once a component is LOCKED, changing its arithmetic (for the
bit-exact tier) requires an *intentional re-freeze* of the golden fingerprints,
documented with a reason. The lock is enforced by tests, not by convention.

## Status levels

| Status | Meaning | Requirements |
| --- | --- | --- |
| `LOCKED-bit-exact` | Behaviour pinned by a golden fingerprint; the exact float trajectory is locked. | ≥1 proving test + ≥1 citation + ≥1 golden fingerprint |
| `LOCKED-invariant` | A mathematical property is pinned by a dedicated check (not the exact trajectory). | ≥1 proving test |
| `LOCKED-structural` | Wiring/shape is pinned by `modules.test.js`; no math claim. | ≥1 proving test |
| `NEEDS-LOCAL-RUN` | Cited and plausible, but only provable with Node + better-sqlite3 (`npm test`). | a `localScript` |
| `EXPERIMENTAL` | Additive candidate, not yet proven; must not be imported by locked paths. | ≥1 citation |

## Coverage

Every component bag in the manifest is classified. There are **no EXPERIMENTAL
entries in the core** — additives live in separate modules (`src/analysis/`) and
are only promoted into the registry once a test proves them.

There are also **no `NEEDS-LOCAL-RUN` entries left**. The native `npm test`
suite is green (**127/127 blocks across 43 files** at round 27, `docs/BUGS.md` #20/#21/#42/#52), so the
three controller DB
bags (`controllerDatabase`, `controllerAccuracy`, `controllerTrade`) were
promoted to `LOCKED-invariant` exactly as `RUNBOOK.md` §6.1 prescribes. The
registry now stands at **60 entries — 17 bit-exact, 43 invariant, 0
needs-local-run, 0 experimental** (round 22 added the run-integrity, observer and
A/B-driver support modules: `sanitize.js`, `rng.js`, `legion_metrics.js`,
`alerts.js`, `analyze.js`; round 26 added the analysis layer's `decision.js`,
`race.js`, `replication.js`, `forecast.js`, `holding.js`, `streams.js` and
`reality_check.js`).

### HiveMind

| Component bag | Methods | Status | Domain | Research |
| --- | --- | --- | --- | --- |
| `activations` | SiLU/Sigmoid/Softmax | LOCKED-bit-exact | attention | GLU/Swish |
| `linalg` | dot/norm/cosine/kernel | LOCKED-bit-exact | attention | SimHash, attention |
| `normalization` | RMSNorm, RoPE, semantic norm | LOCKED-bit-exact | attention | RMSNorm, RoPE |
| `sampling` | RNG, Dirichlet, projections, LSH hyperplanes | LOCKED-bit-exact | attention | SimHash |
| `statistics` | variance/EMA/percentile/stagnation | LOCKED-invariant | continual | EWC, homeostasis |
| `loadState` / `saveState` | persistence | LOCKED-invariant | memory | SDM |
| `dimensions` | structure scaling | LOCKED-invariant | attention | scaling laws, μP, deep ensembles |
| `lsh` | content hash, hyperplanes, bit masks, index | LOCKED-bit-exact | lsh | SimHash, BinaryPC, DQM, multi-probe |
| `protos` | prototype lifecycle | LOCKED-bit-exact | memory | Titans, SDM |
| `replay` | generative replay, pooling | LOCKED-bit-exact | memory | generative replay |
| `retrieval` | kernel similarity, top-k | LOCKED-bit-exact | memory | Hopfield, SDM |
| `consolidation` | semantic merge, memory score | LOCKED-bit-exact | memory | Mela |
| `banks` | bank update, prune | LOCKED-bit-exact | memory | Titans, eviction |
| `attention` | multi-head, context-aware | LOCKED-bit-exact | attention | Transformer, RoPE |
| `forward` | FFN batch, process transformer | LOCKED-bit-exact | attention | Transformer, hybrids |
| `hiveState` | shared state, weighted sum | LOCKED-bit-exact | ensemble | deep ensembles |
| `scores` | specialisation/trust/weights | LOCKED-bit-exact | ensemble | deep ensembles, diversity |
| `gradients` | capture/scale/apply/rollback | LOCKED-bit-exact | training | large-minibatch SGD |
| `distillation` | knowledge distillation | LOCKED-bit-exact | training | Hinton KD |
| `transfer` | broadcast/translate memory | LOCKED-bit-exact | training | Hinton KD |
| `diagnostics` | read-only observation | LOCKED-invariant | ensemble | (observer) |

### HiveMindController

| Component bag | Methods | Status | Domain | Why |
| --- | --- | --- | --- | --- |
| `controllerDatabase` | `_initDatabase` | LOCKED-invariant | memory | per-controller SQLite; driven on the real driver by the `core`/`golden` mirrors, with the reload gap pinned `< 1e-4` and the reloaded structure asserted (`golden.test.js`) |
| `controllerAccuracy` | load/save global accuracy | LOCKED-invariant | ensemble | live DB; `ctl:accuracyTotals` / `ctl:signalTrajectory` pin the accumulated counters end-to-end on the native driver |
| `controllerCandle` | `_getRecentCandles` | LOCKED-invariant | finance | window + entryPrice==close |
| `controllerFeature` | normalise/quality/interleave/extract | LOCKED-invariant | attention | exact feature sequence |
| `controllerTrade` | open/closed trade bookkeeping | LOCKED-invariant | finance | live DB; direction invariants in core + across all 8 symbols (`multisymbol.test.js`), the per-bar bookkeeping via `ctl:*`, and the R27-4b holding-period/vertical-barrier invariants (`controller_invariants.test.js`), all on the native driver; target grid owned by `price_precision.js` |

### Analysis supercharges (`src/analysis/`)

Registered separately (they are not bags of either class). All `LOCKED-invariant`,
proven by `analysis.test.js` (566 checks) with exact reference vectors (the harness additionally
has a real-candle end-to-end run in `walkforward.test.js`, 63 checks, whose
section K is the round-23 audit-vacuity guard, while `analysis.test.js` §AC pins
the world and signal-family arithmetic). They never import from
the locked hot path, so they cannot move a golden fingerprint.

| Module | Status | Domain | What proves it |
| --- | --- | --- | --- |
| `performance.js` | LOCKED-invariant | finance | PSR/DSR/MinTRL closed forms (`normalCdf(0)=0.5`, `kurtosis([1..5])=1.7`, `MinTRL(SR=0.5,95%)=13.174945`, `DSR<=PSR`) |
| `splits.js` | LOCKED-invariant | finance | train/test disjoint, zero label-window leakage, train after embargo; combinatorial purged CV yields `C(k,m)` folds with each observation tested exactly `C(k-1,m-1)` times (the backtest-path count). Hardened (`BUGS.md` #12/#13): `walkForwardSplit` rejects a non-positive/non-finite `step` (a zero step used to hang), and an oversized `C(k,m)` is rejected instead of enumerated |
| `labels.js` | LOCKED-invariant | finance | triple-barrier first-touch indices; FD weights `d=1=[1,-1,0]`, `d=0.5=[1,-0.5,-0.125]` |
| `uniqueness.js` | LOCKED-invariant | finance | uniqueness of `[[0,2],[1,3]]=2/3`; ESS of point labels `= n` |
| `backtest.js` | LOCKED-invariant | finance | exact costs/drawdown; **does not bless noise** (foresight PSR>0.99, anti-signal PSR<0.01, zero-skill DSR<0.95); pooled metrics are the strategy's real per-fold aggregates (turnover/cost are sums, gross Sharpe ≠ net under costs); round 24b adds `grossPnl` and the assumption-free `breakEvenCostBps` (the per-unit-turnover cost at which the gross edge is exactly consumed, `null` at zero turnover) |
| `walkforward.js` | LOCKED-invariant | finance | causal-fold enforcement (throws on train≥test); the **no-lookahead audit** flags a `t+1` signal and a full-sample-mean signal while a causal one is clean; the promotion gate has **~3.5% size at full power** (absolute `DSR≥0.95` floor); `walkforward.test.js`  Round 8 adds `familywiseSearch`/`walkForwardSearch` (subsampling SPA + Romano-Wolf step-down over the pooled out-of-sample return streams, segment-aware `groups`, fold-start trimming), opt-in `maxSearchP`/`requireSearchReject` hurdles on `promoteDecision`, and the `formatReport` search line; on the real-candle A/B the family-wise rule agrees with the DSR floor on all five candidates and catches an oracle control (step p-values `[1,1,0.333,1,0]`). **Round 23 (N0/N2):** `auditNoLookahead` takes an optional `viewFor(returns, perturb)` hook so the perturbation reaches a candle-driven model's actual input, returns `{clean, violations, probes, viewDiffers, reachable, vacuous}` (a `viewFor` whose views do not differ is `vacuous`, never `clean` — `BUGS.md` #22), and gives a non-finite position its own reason; `walkForwardEvaluate` forwards `viewFor` to both the scoring view and the audit and returns a Lo (2002) power summary; `sharpeStandardError`/`minimumDetectableSharpe` are exact closed forms; `poolReports` merges one report per stream with the single-stream `poolFolds` arithmetic and ANDs the audits (one report is the identity). **Round 24b:** `barsToDetect`/`UNDERPOWERED_MDE` give the pooled sample a Sharpe needs and the underpowered flag (`power.underpowered`/`barsToDetect1`); `formatReport` prints the audit's reachability inline (`reachable=F/F probes=N`); `auditNoLookahead` can reuse the scored pass as the base pass (`baseSignals`/`reuseBase`, counted as `baseReused`) — verdict-identical, one fewer refit per fold. **Round 26 (R26-7):** the shipped dependence gate becomes magnitude + stability — `requireSharpeDiff` (the paired cluster Sharpe effect-size floor) together with `requireClusterStability` (the leave-one-cluster-out stability of that difference, `minStableFraction` default 1), while the exact sign test (`promotionTest.breadth`) is demoted to REPORTED; `pairedPromotionTest` reciprocally returns `stability`, and both new gate options default off so the classic gate path is bit-identical. |
| `world.js` | LOCKED-invariant | finance | **the audited evaluation world** (round 23, N0): `shockFactor` is exactly 1 at and before `after` and inside `[1, 1+2·probe]` after it; `shockCandles` is deterministic, non-mutating, and leaves bars `<= after` untouched; `makeCandleViewFor` returns the real candles on the base pass and a self-consistent `{candles, closes, volumes, returns}` on a probe pass (`returns` re-derived from the shocked closes); `worldFromCandles` aligns the arrays and honours `maxBars`. The load-bearing proof is the vacuity trap (`walkforward.test.js` §K): a `t+1` candle leak is invisible without `viewFor` and **caught** with it, an honest candle signal stays clean, and an ignore-the-perturbation `viewFor` is flagged `vacuous`/not-clean. **Round 24b:** `volumeShockFactor` is 1 at and before the probe and bounded after it; `shockCandles` now scales volume too, so a volume-driven candidate is auditable (the pre-fix run had `sig:volume` reachable 0/16) |
| `features.js` | LOCKED-invariant | finance | **the causal signal family** (round 23, N1): exact reference vectors for all eight features — `momentum` (trailing sum), `fracDiffAt`/`fracMomentum` (`d=1` reduces to the log first/second difference), `volRegime` (0 on equal-length windows, -1 on a flat short window), `momentumAgreement` (±1 when every lens agrees), `rangeLocation` (±0.5 at the range edges), `volumeImbalance` (exact short/long mean ratio), `autocorr1` (-1 on a zero-mean alternating series), `acceleration` — plus the exact `(raw-mean)/σ` z-score, the `minObs`/zero-variance abstain, `clampPosition` bounds/oddness, and a causality invariance check (a position at `t` is unchanged when every value after `t` is altered). `SIGNAL_CANDIDATES` is frozen, uniquely idd, and every `signal(view, test)` returns `|test|` positions in `[-1, 1]`, abstaining on a returns-only/empty view |
| `dependence.js` | LOCKED-invariant | finance | Pearson correlation and the Kish (1965) equicorrelation design effect match exact hand values (`equicorrelationDesignEffect({0.5}, 8) = 4.5`); the delete-one-cluster jackknife reproduces the closed-form equicorrelation SE on a deterministic Monte-Carlo panel (`seCluster/seIid` = 0.988 / 1.653 / 2.124 / 2.512 at rho = 0 / .25 / .5 / .75 vs `sqrt(1+7rho)` = 1 / 1.658 / 2.121 / 2.500); `designEffect <= 1` reports `adjustmentNeeded:false` and leaves the adjusted DSR `null` (never invents a correction); `studentTPValue` returns p=0 / p=1 for `t = +Inf / -Inf` and is exact against table values (t(35)=2.030108 two-sided 0.05); the exact sign test matches the binomial tail and its floor `2^-n`; **round 26 (R26-7)** adds `clusterStability` — the pooled Sharpe difference must stay positive on every leave-one-cluster-out panel (hand-checked stable / fragile / unavailable, and the magnitude companion to the sign test that is now the shipped stability gate) | `analysis.test.js` (§AD, §AJ), `walkforward.test.js` (§9) |
| `overfitting.js` | LOCKED-invariant | finance | **PBO via CSCV** (Bailey et al. 2016; AFML ch. 12): `cscvBlocks`/`cscvSplit` produce the `C(S,S/2)` symmetric splits (disjoint cover, each block in exactly `C(S-1,S/2-1)` in-sample sets, closed under complement); `relativeRank` maps rank to `omega=rank/(N+1) ∈ (0,1)` with average tie ranks; `oosOnIsRegression` exact. Calibrated: iid noise `PBO≈0.46`, persistent edge `PBO=0` (positive slope), planted regime flip `PBO=1`, all-flat `PBO=1`; four malformed inputs throw |
| `reality_check.js` | LOCKED-invariant | finance | **White's Reality Check + Hansen's SPA** (White 2000; Hansen 2005): `benchmarkSeries`/`relativePerformance` handle scalar/series/null benchmarks exactly (means `[0,3]` for benchmark 2); `stationaryBlockIndices` is the Politis-Romano resampler, exactly i.i.d. at `blockLength=1`, default `floor(T^(1/3))`; RC's statistic is exactly `sqrt(T)·max_k mean(f_k)` (0 when the best candidate equals the benchmark); SPA's is exactly `max(0, mean_k/SE_k)` with a bootstrap standard error. Calibrated: under iid noise (150 reps, K=5, T=100) SPA size **0.06** / RC size **0.04** with mean p ≈0.47/0.48 (~Uniform); a strong edge gives `p<0.02` for both; and on one real edge among nine poor high-variance candidates **SPA p=0.078 vs RC p=0.762** (Hansen's less-conservative result). Invalid inputs throw. Section V adds Hansen's **consistent** recentring (`consistentRecentring`/`hansenSpaConsistent`, exact bound `A_k = ω_k·√(2 ln ln T)`) and the **Romano–Wolf step-down max-t** (`romanoWolfStepM`): consistent SPA is bit-identical to upper SPA when every candidate is valid and strictly less conservative on poor ones (`p` 0.058 vs 0.078 vs RC 0.762); StepM's first step is provably the single-step SPA p-value, its step p-values are monotone, and its 5% FWER is 0.075 (default block) / 0.065 (`blockLength=1`) with 0.89 power on a planted edge. Section W adds automatic block-length selection (Politis & White 2004; Patton, Politis & White 2009): `politisWhiteBlockLength` reproduces `arch`'s published oracle vectors exactly (stationary 13.635665130318229 / circular 15.608940081363109 at T=10100, m=6 / optM=3 / Kn=5), is monotone along a dependence ladder (0.651 -> 8.429 as phi: 0 -> 0.8), and the opt-in `blockLength:'auto'` restores the i.i.d. size (**0.047** vs 0.087 for a fixed block-4) and beats `b=1` under AR(0.8) (0.413 vs 0.74). The residual AR(0.8) liberal-ness is a bootstrap-SE *scale* bias, not the block length. Section X fixes that with **variance-consistent subsampling** (Politis & Romano 1994; Politis, Romano & Wolf 1999): `neweyWestSE` is the exact Bartlett HAC standard error, and `subsamplingSpa`/`subsamplingStepM` build the reference distribution from every overlapping window of the same series (deterministic, no rng; one bandwidth shared by the window and full scales, so the studentization is approximately pivotal). The 5% size is nominal at EVERY persistence — 0.0533 / 0.0533 / 0.0567 / 0.0433 for phi = 0 / 0.2 / 0.5 / 0.8 at T=100 — versus the block bootstrap's 0.20 and 0.4067 at phi=0.5/0.8 (a ~9x distortion cut), while keeping power 0.72–0.80  Round 8 adds segment-aware resampling: `subsamplingSpa`/`subsamplingStepM` accept `groups` (positive segment lengths tiling T) and compute every sub-window and the full-scale long-run variance within a segment (`sqrt(sum_g (len_g*seNW_g)^2)/T`), so `groups=[T]` is bit-identical to the ungrouped path while grouped folds no longer let a pre-split jump inflate the LRV; grounded in arXiv 2603.17226 (LRV estimation for mean-shift series). Round 9 adds the generalised error rates on the same window grid: `subsamplingKfwer` is the single-step **k-FWER** procedure (Romano & Wolf 2007) — reject candidate `i` iff its k-th-largest window statistic `p_i^(k) <= alpha`, with the reference over the FULL family, so `P(k or more false rejections) <= alpha` (its `k=1` p-value is exactly the single-step SPA/StepM p-value); `subsamplingFdp` is the corrected Romano–Wolf / Delattre–Roquain **step-down FDP** heuristic with the growing reference `k_l = min(floor(fdpTarget*l)+1, K)` and `estimatedFdp = (kHat-1)/nRejected`, shipped **EXPERIMENTAL** (not rigorously FDP-controlling in finite samples). Pinned global-null calibration (K=4, 200 reps): FWER(k=1)/2-FWER(k=2) **0.07/0.075** at T=200 and **0.04/0.055** at T=80; the FDP estimator rejects nothing beyond the first step in ~95% of reps. A naive "k-th largest of the survivor set" step-down was measured to fail (2-FWER 0.085 at T=80, 0.145 at T=200) and is documented in the module as REJECTED. Round 10 adds the **mixture-family validation** (section AA): k=2 k-FWER is strictly more powerful than k=1 on a weak 2-edge family (0.155 -> 0.4975) while FWER/2-FWER stay <= alpha, and the FDP step-down on a 20-candidate mixed family rejects monotonically more as the target loosens (6.833 < 9.05 < 9.783 of 20, kHat 1.2/2.6/3.7) with realised FDP below target there (0.0098/0.0257/0.0528) — but it slightly OVER-runs a tight target on a sparse family (0.1014 > 0.10 with an estimated FDP of 0), the measured finite-sample non-control that keeps `subsamplingFdp` EXPERIMENTAL. |
| `holding.js` | LOCKED-invariant | finance | **the turnover attack** (round 26, R26-5): a frozen dead-zone × entry/exit-hysteresis × minimum-holding grid restated as *pure post-processing* of the journaled pre-policy confidence (no model) — each policy's turnover / gross pnl / break-even cost / pooled Sharpe and its full promotion decision. `walkforward.js#positionSeriesFromConfidence` is the one holding-aware confidence→position map (byte-identical to the pointwise map with no holding rule, so the R26-3 round trip is unchanged). Proved (section AF): the byte-identical default, the enter/exit band (`[1,1,1,1,1,-1,0]`), the minimum holding period (`[1,1,1,0,0,0]`), the frozen grid, and `turnoverSweep` availability/sort/participation/target | `analysis.test.js` (§AF) |
| `streams.js` | LOCKED-invariant | finance | **effective independence of the stream basket** (round 26, R26-6): Grinold (1989) breadth / Kish (1965) design effect. Proved (section AG): `resampleCandles` exact OHLCV aggregation (open first, close last, high max, low min, volume sum, timestamp first), shallow copy at factor 1, partial-group drop, input non-mutation and factor validation; `designEffectOfStreams` reports K=1 as the trivial panel, two identical streams as one bet (rbar=1, DE=2, effectiveStreams=1), the exact 1+(K-1)·rbar law for K=3, and flags a perfectly hedging pair (DE<=0) and a <3-bar window as unavailable; `selectStreams` keeps the diversifying stream over a redundant copy, stops after one stream on a fully redundant pool, honours maxStreams and is deterministic | `analysis.test.js` (§AG) |
| `replication.js` | LOCKED-invariant | finance | **seed replication + common random numbers** (round 26, R26-13): a single-seed ordering is not a ranking (Bouthillier et al. 2019; Henderson et al. 2018), so the level is the interquartile mean (Agarwal et al. 2021), the interval is a **stratified bootstrap** that resamples within each seed stratum, and the spread is split into seed/fold/residual fractions; `pairedVarianceRatio` is the CRN criterion (Glasserman & Yao 1992). Proved (section AH): IQM drops the best/worst quarter exactly and falls back to the mean below four values; the bootstrap is deterministic for a fixed seed and resamples *within* strata (constant unequal strata give a zero-width CI); `varianceComponents` is hand-computed exact on four crafted panels with the fractions summing to 1; `seedDistribution` reports the exact flat mean/IQM + CI + split; `pairedVarianceRatio` shows a variance reduction and reports unavailable on degenerate input; `formatSeedReplication` states unavailability rather than NaN | `analysis.test.js` (§AH) |

| `forecast.js` | LOCKED-invariant | finance | **forecast comparison** (round 26, R26-14): the family scored as *forecasters* — proper scores (Brier + Murphy reliability/resolution/uncertainty, log score; Gneiting & Raftery 2007), the block-bootstrapped Diebold–Mariano test on per-bar Brier-loss differentials (Diebold & Mariano 1995), and the Hansen–Lunde–Nason Model Confidence Set at 90/95% (the set of families indistinguishable from the best, not the sample-best). Proved (section AI): `forecastPairs` maps confidence -> probability + next-bar sign and drops each fold's last bar; exact Brier/logScore/brierLosses; `brierDecomposition` reproduces REL/RES/UNC and the identity `BS_binned = REL - RES + UNC`; `bootstrapMeans` deterministic; the DM test rejects a constant positive differential (p=0) and does not reject a zero one, deterministic with a finite SE; the MCS eliminates a uniformly worse model, keeps an identical pair, is deterministic and nested in the confidence level; `forecastComparison` scores every variant, keeps a perfect forecaster, and refuses a mismatched window | `analysis.test.js` (§AI) |
| `decision.js` | LOCKED-invariant | finance | **the decision-grade report** (round 26, R26-8), the composition half of the honest-evaluation battery: `foldConcentration` (top-K share of gross PnL, signed fold sums, the pooled Sharpe on each leave-one-fold-out panel and each fold marginal contribution to it, restated from the retained `foldInputs` with the scored `strategyReturns` arithmetic), `confidencePersistence` (lag-1 autocorrelation of the journaled raw confidence within folds + its exponential half-life, the alpha-decay input), `nextRunPlan` (effective bars and MDE i.i.d. and dependence-corrected, bars-to-detect at the measured design effect, turnover break-even vs 0/2/5/10 bps, the measured per-fold wall time, the paired clusters/seeds a comparison would need for a target difference (`pairedUnits`), the cheapest single flip) and `decisionReport`/`formatDecision` (the six questions, every field a value or an explicit `{available:false, reason}`) | `analysis.test.js` (§AK), `analyze.test.js` |
| `race.js` | LOCKED-invariant | finance | **the successive-halving family-search engine** (round 26, R26-15) — ENGINE ONLY; the `--race` driver is not shipped because the gate is closed (`docs/METHOD.md` §2): `halvingRounds`/`halvingSchedule` exact (eta=3 and eta=2), `successiveHalving({arms, evaluate, maxBudget, eta, maximize})` deterministic and evaluator-agnostic, with a non-finite evaluation eliminated rather than ranked, the full per-rung scored table, and both the evaluation count and the budget-weighted `spentBudget` vs `gridBudget`; `formatRace` renders it. Validated against the brute-force full-grid oracle (the race winner equals the grid winner, so a racing budget does not change the decided set) | `analysis.test.js` (§AM) |
### Dependence-aware inference (`analysis/dependence.js`, Round 25)

**Proven invariants.** (1) The jackknife is the *estimator* of the pooled Sharpe SE
from the panel — on a correlated-stream fixture it matches the closed-form
equicorrelation SE to three decimals, whereas the i.i.d. Lo (2002) SE is low by the
design-effect factor. (2) A correction is only *applied* when the measured design
effect exceeds 1; a diversifying panel yields `dsrAdjusted = null` and the gate
records `not-needed`, so a report can never claim a deflation it did not perform.
(3) The gate states are exhaustive and honest: `applied | skipped-no-panel |
not-needed | off`, with `skipped-no-panel` on a single-stream run (where the
round-23/24 decision path is recovered byte-for-byte). (4) `trials` stays K for the
DSR / family-wise path — `familyCorrelation` is a diagnostic only (arXiv
1612.04535: effective-number-of-tests corrections do not control FWER). (5) Every
verdict is restated across the cost ladder, so `promote` cannot be read without its
cost sensitivity; `restateReportAtCost(report, 0)` is byte-identical to `report`.

### Support modules (`src/*.js`, on the hot path)

Registered separately. These are pure helpers. Most **are** imported by locked
code (the controller imports `price_precision.js`, the consolidation worker
imports `consolidation_logic.js`, the legion runner imports `candle_quality.js`),
so their behaviour is pinned
by exact vectors **and** the golden fingerprints prove the hot-path integration
is unchanged; `evolve.js` is the remaining additive exception — nothing imports
it yet, so it is pinned by its own entry alone — while `multiprobe.js`,
`binarypc.js` and `bitweight.js` are imported by the
locked `lsh` bag behind the default-off flags `_multiProbeConfig` and
`_pcaHashConfig` respectively, so each is pinned by its own entry *and* the
golden no-op (like `surprise.js` / `sample_weights.js`); `querymod.js` joins
them behind the default-off `_queryModConfig`.

| Module | Status | Domain | What proves it |
| --- | --- | --- | --- |
| `price_precision.js` | LOCKED-invariant | finance | exact vectors (DOGE `$0.001329`→7 dp, ADA `$0.02`→6, XRP `$0.12`→5, BTC `$3946`→2); prices ≥ $40 keep 2 dp (golden unchanged); rounding a target by the minimum movement never crosses the entry price; `multisymbol.test.js` replays all 8 symbols with zero direction inversions |
| `hivemind/memory/surprise.js` | LOCKED-invariant | memory | exact gate vectors + bounds/monotonicity; `floor=1` collapses `surpriseGate` to exactly 1 so the wired write path is a **bit-identical no-op** (two identically-seeded banks fingerprint equally, all 11 goldens unchanged); when enabled the measured gated/ungated write ratio equals `surpriseGate(1 - measuredSimilarity)` and novel inputs are written >2× more strongly than predictable ones (`surprise.test.js`, Titans arXiv 2501.00663) |
| `hivemind/training/sample_weights.js` | LOCKED-invariant | finance | exact average uniqueness on fixed label intervals, bit-for-bit equal to `analysis/uniqueness.js`; mean-1 normalisation has mean exactly 1, `sum1` sums to exactly 1; Kish ESS of uniform weights is exactly `n`; `train(inputs, target, w)` scales the accumulated gradient by exactly `w` (energy ratio `w²`), and `w = 1` / non-finite `w` are bit-exact no-ops (`sample_weights.test.js`, Lopez de Prado AFML ch. 4) |
| `hivemind/ensemble/homeostasis.js` | LOCKED-invariant | ensemble | the activity multiplier is bounded, monotone non-increasing, and exactly 1 at the set-point; EMA activity signal and RMS/deviation-energy helpers are exact; `isStableConfig` matches the proven contraction condition `0 < gain·target < 2`; on the toy system `activity = k·lr` the closed loop converges to `target/k` across a `k`-sweep; enabled-with-`gain=0` is a **bit-exact no-op** against the default path, so all 11 goldens are unchanged (`homeostasis.test.js`, Turrigiano synaptic scaling + arXiv 2609.13771) |
| `legion/evolve.js` | LOCKED-invariant | ensemble | additive low-rank ES (EGGROLL arXiv 2609.10980; antithetic estimator arXiv 1703.03864). For a quadratic `f = ½θᵀHθ` the antithetic estimate is **exactly** `ĝ = S·Hθ` with `S = (1/P)Σ εᵢεᵢᵀ` (checked to `1e-9`); `S` is PSD so `ĝᵀ∇f = (Hθ)ᵀS(Hθ) ≥ 0` (always a descent direction); full-rank estimates align with the true gradient; low-rank estimates lie in their subspace and are unbiased for the projected gradient; a backtracking line search makes fitness **monotone non-increasing** to the optimum on a toy convex quadratic (`evolve.test.js`) |
| `hivemind/memory/multiprobe.js` | LOCKED-invariant | lsh | margin-ordered multi-probe LSH (Lv et al., VLDB 2007; Charikar STOC 2002), wired into the locked `_getGlobalLSHCandidates` behind the default-off `_multiProbeConfig` (`golden.test.js` proves the off-state no-op). Proved: `marginOrder` is a total ascending permutation by `|query·hyperplane|` and `rankPerturbations` emits distinct non-empty ≤`maxFlips`-bit perturbations, each costed at exactly the sum of its margins and sorted by `(cost, flips, margin-rank)`; the **flip lemma** (`bit b flips ⇔ |δ_b| > |q_b|` and opposing sides ⇒ the lowest-margin cover is complete, zero violations in 300 trials); `P(flip)` monotone decreasing in margin (0.48→0.04 octiles); margin order dominates the historical prefix probe at **every** budget and beats all 12 sampled random orders; exact ≤1-bit/≤2-bit completeness identities; and on a real 107-bit index a self-recall lift from **0.03 → 0.30** at σ=0.25 where the prefix probe collapses; and with the flag on the real lean-helper self-recall rises **0.167 → 0.517** at σ=0.25 with no loss at σ=0.1; and (Round 16) a **query-adaptive probe budget** (`adaptiveMultiProbeConfig`, NeuRoute arXiv 2608.15438 / adaptive bucket probing arXiv 2604.04603, off by default and byte-identical when off) that reads the probe depth per query from the exact recovery coverage, is exhaustive over the probed bits (so the recovery probability is met exactly), and on a calibrated real index needs no probing for many queries at low noise while beating the fixed 8-probe budget at high noise (`multiprobe.test.js`, 77 checks) |
| `hivemind/memory/binarypc.js` | LOCKED-invariant | lsh | data-aware binary principal components (BinaryPC arXiv 2608.04405; the training-free alternative to Charikar random-hyperplane SimHash 2002), wired into the locked `lsh` bag behind the default-off `_pcaHashConfig` (`_refreshLshHyperplanes`; `golden.test.js` proves the off-state is byte-identical). Optimality grounding: Andoni, Indyk & Laarhoven arXiv 1501.01062 (data-dependent hashing beats the best data-independent LSH for every `c>1`), plus Density Sensitive Hashing 1205.2930 and weighted-Hamming 2009.08591. Proved: power iteration recovers a dominant eigenpair deterministically; on a diagonal covariance the eigenvalues are the exact diagonal (ordered descending), the components are exactly orthonormal, and the eigenvalues sum to the total variance (the trace); the top component recovers a planted direction (`|cos|>0.999`); the flagship **Eckart–Young** claim — the PCA-aligned `B`-subspace beats **every** one of 20 random `B`-subspaces on reconstruction error (>2× margin on planted data), with error non-increasing in the bit count; `pcaHashTables` tables are orthonormal, all lie inside the top-bits PC subspace, and are seed-deterministic; `alignedHashTables` extends that to an oversubscribed budget (`bits>dim`) by aligning only `min(bits,dim,nrows-1,maxRank)` directions and drawing the surplus from random **unit** vectors, and (Round 15) reports each direction's exact data variance (`tableVariances`, verified against a brute-force recompute) and takes a data-driven `rankPolicy` (`above-mean` = keep only PCs above the random-direction baseline `trace/dim`, capped by `maxRank`, deterministic); `bits>dim` and zero-variance data throw; `resolveBinaryPCConfig` clamps (`binarypc.test.js`, 39 checks) |
| `hivemind/memory/bitweight.js` | LOCKED-invariant | lsh | bit-reliability theory for the LSH hash bits, imported by the locked `lsh` bag through `binarypc.js`'s `rankPolicy` behind the default-off `_pcaHashConfig` (`golden.test.js` proves the off-state is byte-identical). Grounding: Charikar STOC 2002, Lv et al. VLDB 2007, Cover & Thomas *Elements of Information Theory* 2006 (the binary symmetric channel), weighted Hamming 2009.08591 and Density Sensitive Hashing 1205.2930. Proved: the **exact bit-flip law** for a direction with data variance `λ` under isotropic noise `σ²` — `P(flip) = arccos(√(λ/(λ+σ²)))/π`, i.e. Charikar's `θ/π` with `θ` the signal/noise angle — with `P(1,1)=1/4` exactly, the limits (`0` variance ⇒ `1/2`, noiseless ⇒ `0`), strict monotonicity in both arguments and bounds `[0,1/2]`; `reliabilityWeight = 1−2P` (`0` for a pure-noise bit, →`1` for a stable one) and `bitInformation = 1−H₂(P)` (`0` bits at a pure-noise bit, ⊤`1` noiseless); the closed form matches **Monte Carlo** at four `(λ,σ)` pairs to `≤0.00055` over 2e5 draws, and equals the average of the margin law `Φ(−|margin|/σ)`, which is monotone in `|margin|` so ascending-`|margin|` order **is** descending flip-probability order (the rigorous reason margin probing is optimal); the sub-mean/min/median-tail spectral noise estimator; `selectReliableRank` above-mean/noise; exact per-bit `reliabilityWeights` (uniform variances collapse to Hamming); `weightedHamming`/`weightedKeyDistance`/`unpackWord` exact and equal to plain Hamming at unit weights, checked against a brute-force unpacked recompute on 32-bit **and** BigInt 40-bit words; and the **live-index validation** — the law predicts a real PCA-aligned index's measured bit-flip rate to within 0.012 (0.1390 measured vs 0.1267 predicted at σ=0.5). Recorded negative (section I): reliability-weighted candidate ranking does **not** beat plain Hamming on the rotation-based index (the rotation already equalises per-direction variance, and the pool is re-scored by the exact projection cosine downstream), so it is deliberately left unwired; and (Round 16) the **query-adaptive budget** primitives — the exact Poisson-binomial flip count and its quantile, the monotone containment coverage (`marginContainmentCoverage`/`marginContainmentDepth`), the exact recovery coverage `probeRecoveryCoverage` (containment factor × P(inside count ≤ maxFlips), no union bound), the single-pass O(n²) `recoveryDepth` proven equal to a brute-force forward scan over 120 random spectra, and `calibrateNoiseFromFlips` (predicts a real 107-bit index's mean Hamming distance to 1e-6) — all checked exactly and against Monte Carlo (`bitweight.test.js`, 69 checks) |
| `hivemind/memory/querymod.js` | LOCKED-invariant | lsh | dynamic query modification for binary LSH (Claydon, Connor & Dearle, arXiv 2605.23807) — the query-side companion to data-aware hashing, wired into the locked `_getGlobalLSHCandidates` behind the default-off `_queryModConfig` (`golden.test.js` proves the off-state is byte-identical). Proved: **Theorem 1** (`<c>` maximises `Σ x·u`, and `Σ(<c>·x) = ‖Σx‖ = k‖mean‖` exactly); **Theorem 2** (first-order ACP `½ + Σ x·u/(kπ)` maximised at `<c>`, which also beats the average random direction on the exact Charikar ACP); **Appendix C.1** (`averageCovariance = const − ((Σ x·u)/k)²`, minimised at `±<c>`); **Section 6.4** (the centroid collides with a member of `S` on every direction — zero failures in 200 — while a raw query can collide with none; exact singleton witness plus a non-degenerate majority-failure witness); Charikar's law matched by 4e4 random hyperplanes to `<0.01`; the **denoising law** (the 40-view centroid at σ=0.3 cuts the per-bit error rate several-fold and shrinks with the view count); and the **synthetic regime sweep** (pool recall `0.540→0.789` at 6 bits, gain decaying monotonically to `0.001` at 24 bits). Integration (lsh.test.js section J): the pool is mechanically a **superset** (recall can never fall) and the branch is **live** on the narrow 6-bit index (pool grows for most queries) but a **measured no-op** on the production 107-bit index (`differ=0` — the empty-consensus-bucket regime) |
| `consolidation_logic.js` | LOCKED-invariant | memory | the pure memory-lifecycle algorithms extracted verbatim from `consolidation_worker.js` (Gaussian distance, content hash, decay, pairwise merge, promotion, proximity graph). `consolidation.test.js` (48 checks) pins them, including a differential test against the original inline copies (300 randomized trials × {decay, merge, promote, hierarchy}, all `Object.is`-identical), and documents two deliberate behaviours: mutually-nearest prototypes emit the same directed edge up to 4× (safe — the insert is `ON CONFLICT … DO NOTHING`, so the edge table is a set), and the pairwise merge is inherently O(n²·d) and order-dependent (the algorithm, not waste). `consolidation_worker.test.js` (18 checks) pins the real worker wiring against an isolated state dir |
| `candle_quality.js` | LOCKED-invariant | finance | read-time winsorizer for physically-impossible wicks. `candles.test.js` (95 checks) proves it exact on the real LINKUSDT 2020-03-12T10:00 flash print (`low 0.0001` on a ~3.0 bar), idempotent, OHLC-invariant-preserving, and leaving genuine extremes (ADA/LINK 2025-10-10 crash, listing spikes) untouched at the default 0.9 body-fraction threshold, without ever touching open/close/volume/timestamp. Wired into `legion/runner.js` behind `CONFIG.candleWickRepair` |

## Golden fingerprints (the bit-exact contract)

These 11 values in `golden.test.js` are the frozen trajectory. A `LOCKED-bit-exact`
component lists the ones that pin it:

`hm:diagnostics`, `hm:predictions`, `hm:memberCounts`, `hm:broadcast`,
`hm:translate`, `hm:postReloadPrediction`, `ctl:finalSignal`,
`ctl:signalTrajectory`, `ctl:signalCount`, `ctl:lastTrainingStep`,
`ctl:accuracyTotals`.

## Proven invariants (selected)

These are the strongest claims the suite currently proves — a component may be
"locked" only because one of these holds.

### Hyperplane LSH recall (`lsh.test.js`, 69 checks)

Domain `lsh`, citations Charikar 2002 + Lv 2007, in addition to the bit-exact
fingerprints.

- Projections are unit norm, so `_projSimilarity` is a true average cosine in
  `[-1, 1]` and self-similarity is exactly 1. The historical `1/sqrt(lowDim)`
  rescale is reproduced in-test and shown to push a self-match below the 0.35
  semantic filter — i.e. the regression that silently disabled semantic recall
  can never return unnoticed.
- A hash word equals the sign pattern of the projected vector against the set's
  hyperplanes, bit-for-bit (`0/480` mismatches against a brute-force recompute).
- The bucket index is a leak-free mirror of `_semanticProtos`: insert →
  `sets × tables` references, remove → zero references with empty buckets pruned,
  update → only the new hashes.
- Exact-match queries recall **100%** of an 80-prototype bank, in the min config
  and in the production-width config.
- The measured bit-flip rate matches the Charikar rounding law `Pr[differ] = θ/π`
  to `≤ 0.03` over σ ∈ [0.05, 1.0], and is monotone in noise.
- End-to-end: `_retrieveTopRelevantProtos` recalls the query prototype in 8/8
  (min) and 4/4 (production-width) trials at projSim > 0.9.
- Section J: `_getGlobalLSHCandidates` runs dynamic query modification rounds
  (`memory/querymod.js`, arXiv 2605.23807) when the default-off `_queryModConfig`
  is set. The flag-null path is byte-identical; the modified pool is a mechanical
  **superset** of the baseline (so recall can never fall); the branch is **live**
  on the narrow 6-bit index and a **measured no-op** at the production 107-bit
  width. See the dedicated section below and `querymod.test.js`.

Known, documented limit: at production width (107-bit words) the *lean*
`_getGlobalLSHCandidates` helper — used only as a supplementary pool in
`broadcastMemory` — recalls exact matches but not noisy ones; the
recall-critical retrieval path probes every bit plus random multi-bit words and
does not have this limit. See `docs/research/lsh-ann.md`.

### Surprise-gated memory writes (`surprise.test.js`, 32 checks)

Domain `memory`, citation Titans (arXiv 2501.00663). The semantic write path
(`banks.js#_updateSemanticProtos`) can scale every merge/reinforcement term by
`surpriseGate(1 - bestSim)`, where `surpriseGate(s) = floor + (1-floor) · s^sharpness`
(momentum smoothing optional, off at the default weight of 0).

- The gate is a pure function with exact reference values; it is bounded to
  `[floor, 1]`, non-decreasing in surprise, and `floor=1` makes it identically 1.
- The shipped default is **off** (`_surpriseGateEnabled = false`), and the test
  proves there is no residual difference: two banks built under the same RNG seed
  with the gate on-at-floor-1 versus never-wired produce the same fingerprint, so
  the 11 golden values are unaffected — the feature is additive, not a re-freeze.
- With a non-trivial floor the *measured* gated/ungated semantic write-size ratio
  equals `surpriseGate(1 - bestSim)` (not merely correlated), and a genuinely
  novel candidate is written more than 2× more strongly than a predictable one.

### Sample-uniqueness loss weighting (`sample_weights.test.js`, 45 checks)

Domain `finance`, citation Lopez de Prado, *Advances in Financial Machine
Learning*, ch. 4. Overlapping labels share information; weighting each
observation by its average uniqueness makes the weighted objective's effective
sample size match the labels' independent information.

- The average-uniqueness formula is pinned on hand-computed fixed intervals
  (two 3-bar labels offset by one → 2/3 each; partial overlap `[[0,0],[0,1]]` →
  1/2, 3/4) and is proved **bit-for-bit equal** to `analysis/uniqueness.js`
  `sampleUniqueness` on shared fixtures, so the two implementations can never
  silently diverge.
- Normalisation is exact: `mean1` gives mean exactly 1 (and sum exactly `n`, so
  the average gradient magnitude is preserved), `sum1` sums to exactly 1, and
  clamping is exact. Kish effective sample size of uniform weights is exactly
  `n`; an overlap-skewed set is strictly below `n`.
- `spanWeightsFromEntries` (the controller's feed) turns entry bars plus a
  horizon into the same overlap structure: entries closer than the horizon
  overlap (a 4-trade, 3-bar batch yields the exact `11/18, 7/18, 7/18, 11/18`
  pattern carrying exactly 2 independent observations), while entries spaced
  beyond it are independent.
- `HiveMind.train(inputs, target, w)` is **exactly linear** in `w`: the
  accumulated-gradient energy ratio equals `w²` for `w = 0.5` and `w = 2`, and
  `w = 0` yields an exactly zero gradient. `w = 1`, `NaN` and `Infinity` fall
  back to the default and produce bit-identical trajectories (fingerprint-equal),
  so the default-off feature cannot move a golden fingerprint.

### Homeostatic plasticity (`homeostasis.test.js`, 30 checks)

Domain `ensemble`, citation arXiv 2609.13771 (homeostatic continual learning)
plus Turrigiano's synaptic-scaling framing. `_updateAdaptiveLearningRates` is a
*rank-based* controller: it compares each member's composite score against a
percentile of the ensemble. That makes it blind to common-mode shifts (scale
every member up equally and the ranking — hence the control signal — is
unchanged). `ensemble/homeostasis.js` adds an *absolute* error-driven controller
that regulates each member's activity toward a set-point.

- The multiplier `homeostaticScale(a) = clamp(1 + gain·(target − a))` is bounded
  to `[minScale, maxScale]`, monotone non-increasing in activity, and exactly
  `1` when `a == target` (a true fixed point, not an approximation). A
  non-finite activity falls back to the set-point, so it can never inject `NaN`.
- The closed loop is proven to *stabilise*: for the toy system `activity = k·lr`,
  iterating `lr ← lr·homeostaticScale(k·lr)` converges to `target/k` across a
  sweep of `k`, the set-point error decreases every step, the local contraction
  factor is the predicted `|1 − gain·target| = 0.5`, and two different initial
  rates reach the same set-point. `isStableConfig` returns `true` exactly on the
  analytic stability region `0 < gain·target < 2`.
- Off by default (`_homeostasisEnabled = false`). The test proves enabled-with-
  `gain=0` produces fingerprint-equal trajectories to the disabled path, so the
  11 golden values are unaffected; a non-trivial gain *does* change the
  trajectory, so the feature is live rather than dead code.

### Low-rank evolution strategies (`evolve.test.js`, 36 checks)

Domain `ensemble`, citations EGGROLL (arXiv 2609.10980) and the antithetic ES
estimator (Salimans et al., arXiv 1703.03864). `src/legion/evolve.js` is
**additive** — nothing imports it yet — and is the prerequisite from
`docs/TODO.md` item 3 (monotone fitness on a toy convex objective) before the
trainers are allowed to use ES.

- **Exact quadratic identity.** For `f(θ) = ½θᵀHθ` mirroring the perturbations
  gives `f(θ+σε) − f(θ−σε) = 2σ·(εᵀHθ)`, so the antithetic estimate is exactly
  `ĝ = S·Hθ` with `S = (1/P)Σ εᵢεᵢᵀ`, verified to `1e-9` against an independently
  computed `S`. `S` is a sum of outer products, hence symmetric PSD, so
  `ĝᵀ∇f = (Hθ)ᵀS(Hθ) ≥ 0`: **the estimate is always a descent direction**.
- Full-rank perturbations with a large population recover the true gradient
  (`cos > 0.99`); low-rank perturbations stay exactly inside their random
  subspace and are unbiased for the projected gradient `UUᵀ∇f`.
- A backtracking line search converts the descent guarantee into **strictly
  monotone fitness decrease** every generation, on a convex quadratic, for both
  the full-rank and the rank-3 search, ending at the optimum; from the optimum
  the gradient vanishes and the step is an exact no-op. An explicit seed makes
  the whole trajectory deterministic.

### Margin-ordered multi-probe LSH (`multiprobe.test.js`, 77 checks)

Domain `lsh`, citations Lv et al. *Multi-Probe LSH* (VLDB 2007) and Charikar
(STOC 2002). `src/hivemind/memory/multiprobe.js` is wired into the locked
`_getGlobalLSHCandidates` behind a default-off flag (`hiveMind._multiProbeConfig`),
so the default path is bit-identical (`golden.test.js` proves the no-op) while the
engine is the prerequisite from `docs/TODO.md` item 2: the lean
`_getGlobalLSHCandidates` probe only flips the first four hash bits, so at
production width (100+ bits) its recall collapses past σ≈0.1.

- **The flip lemma.** For a neighbour `n = q + δ` in the pre-normalisation
  projection space, hash bit `b` flips exactly when `|δ_b| > |q_b|` **and** the
  perturbation opposes the query's side. Hence every flipped bit has margin
  `|q_b| < max_b'|δ_b'|`, so probing the **lowest-margin** bits first is a
  complete cover — the reason margin order is the right order. Checked exactly
  (zero violations, 300 trials), together with the closed form.
- **Ordering and cost.** `marginOrder` is a total ascending permutation of the
  bit indices by `|query·hyperplane|`; `rankPerturbations` returns distinct,
  non-empty, ≤`maxFlips`-bit perturbations, each costed at exactly the sum of its
  flipped margins, sorted by `(cost, flips, margin-rank)`.
- **Empirical law.** `P(bit flips)` decreases monotonically with the bit's
  margin (0.484 → 0.039 across octiles), the statistical foundation of the
  multi-probe score.
- **Recall dominance.** At every budget from 1 to 32, margin multi-probe
  (maxFlips 2) ≥ margin single-bit ≥ the historical prefix baseline; margin
  single-bit beats the prefix at budget 4 (0.0475 vs 0.0088) and beats all 12
  sampled random orders; recall is monotone in the budget; and all-pairs /
  single-bit probing are complete **exactly** on ≤2-bit / ≤1-bit neighbours.
- **Real-index gain.** On a real 107-bit HiveMind bank, margin probing lifts
  self-recall under noise from **0.033 → 0.30** at σ=0.25 (and remains 1.0 at
  σ=0.1), exactly where the prefix probe collapses.
- **Wired proof.** With `_multiProbeConfig` set, the real
  `_getGlobalLSHCandidates` pool self-recall at σ=0.25 rises from **0.167 → 0.517**
  (~3.1×) and is unchanged (1.0) at σ=0.1; with the flag unset the pool is
  byte-identical to the pre-existing prefix probe, so `golden.test.js` stays green.

- **Query-adaptive budget (Round 16).** Lv's probe order is fixed-count; the
  reliability model makes the *budget* query-dependent. Two independent lines of
  2026 work ask for exactly this: NeuRoute (arXiv 2608.15438) uses the query's own
  logits as an uncertainty signal and perturbs only the bits it is least sure of,
  and *Cardinality Estimation … with Adaptive Bucket Probing* (arXiv 2604.04603)
  explores neighbouring buckets with a budget adapted to the query/distance
  threshold (query-adaptive hash-code ranking, arXiv 1904.08623, is the sibling
  idea for ranking). `adaptiveMultiProbeConfig` is **off by default** and
  byte-identical to `resolveMultiProbeConfig` when off (`golden.test.js`
  unchanged). When on, per query: `q_b = Φ(−|margin_b|/σ)`, the total flip count
  `K` is Poisson-binomial (`poissonBinomialPmf`/`poissonBinomialQuantile`), and
  `depth` is the smallest number of smallest-margin bits whose **exhaustive**
  subset enumeration reaches the requested recovery coverage — i.e.
  `P(recover) = [∏_{b ∉ top-depth}(1 − q_b)] · P(K_inside ≤ maxFlips)` ≥ `coverage`
  — with `depth` capped so `budget = #{subsets of the top-depth bits of size ≤
  maxFlips}` fits `budgetCap`. Because the enumeration is exhaustive over exactly
  those bits, no cost-ordering truncation can drop a required subset, so the
  budget meets the stated probability **exactly** (no union bound). Proved
  (section G of `multiprobe.test.js`): the config clamps, is idempotent
  (recomputing from its own output is identical — a check that caught a real
  round-trip bug where the caps were dropped), the depth reaches the target or
  saturates at the cap, `budget` is exactly the subset count, the enumeration is
  exhaustive (every subset present exactly once), a confident query gets depth 0
  (probe set = the exact key) and an ambiguous one a deep set, and the noiseless
  limit collapses to the exact key. Monte Carlo confirms the probe set recovers
  the neighbour at the EXACT predicted rate. On the real 107-bit index with σ
  calibrated from the measured Hamming distance, the query-adaptive budget
  dominates the historical prefix-4 probe at every noise level, needs **no
  probing** for many queries at low noise (below the fixed budget of 8), and
  beats the fixed 8-probe budget at high noise. The honest caveat: at low noise a
  broad fixed budget can out-recall the adaptive depth because it enumerates more
  multi-bit subsets than the query-adaptive depth needs — recorded, not hidden.

### Data-aware binary principal components + bit-reliability theory (`binarypc.test.js`, 39 checks; `bitweight.test.js`, 69 checks; `lsh.test.js` section I)

Domain `lsh`, citations BinaryPC (arXiv 2608.04405), Charikar (STOC 2002),
Andoni–Indyk–Laarhoven (arXiv 1501.01062), Density Sensitive Hashing
(arXiv 1205.2930), weighted Hamming (arXiv 2009.08591), Lv et al. (VLDB 2007) and
Cover & Thomas (*Elements of Information Theory*, the binary symmetric channel).
`src/hivemind/memory/binarypc.js` is the training-free, data-aware alternative to
the random hyperplanes the locked `lsh` bag uses: instead of `w ~ N(0, I)`, hash
along the data's principal components. It is wired into the locked `lsh` bag
behind the default-off `_pcaHashConfig` (`_refreshLshHyperplanes`) — the
`docs/TODO.md` item-2 "PCA-aligned hyperplanes" step, on top of the
already-wired margin multi-probe — so the default path stays byte-identical
(`golden.test.js` proves it).

- **Power iteration.** The top eigenpair of a symmetric PSD covariance is found
  by power iteration from a seeded start; convergence is measured on the
  eigenvector movement (the Rayleigh quotient converges quadratically and would
  stop the iterate while it is still ~1e-5 off), and a zero matrix returns the
  zero vector with eigenvalue 0.
- **Exact PCA on a diagonal covariance.** For rows with covariance exactly
  `diag(3, 4/3, 1/3)` the eigenvalues are that diagonal in descending order, the
  components are **exactly orthonormal** (a final Gram-Schmidt pass plus a
  Rayleigh re-read against the original covariance), and the eigenvalues sum to
  the trace (`14/3`); `explainedVariance` is non-increasing and sums to 1.
- **Recovery.** On 8-dimensional data with a planted dominant direction the top
  component recovers it to `|cos| > 0.999`.
- **Eckart–Young dominance (the flagship).** On that data the PCA-aligned
  3-subspace has lower reconstruction error than **every** one of 20 random
  3-subspaces, with a >2× mean margin, and the error is non-increasing in the
  number of bits — the precise sense in which data-aware hashing dominates random
  hashing for a fixed budget.
- **Tables.** `pcaHashTables` returns the requested number of orthonormal tables,
  every direction lies inside the top-`bits` principal subspace, distinct tables
  are genuinely different rotations, and the whole thing is deterministic under a
  seed; `bits > dim` and zero-variance data throw; `resolveBinaryPCConfig`
  clamps `bits`/`numTables`/`iters` to ≥ 1.
- **Oversubscribed budgets (`alignedHashTables`).** The live index hashes with
  more bits than the projection has dimensions, so the wiring needs a variant
  that tolerates `bits > dim`: it aligns only
  `rank = min(bits, dim, nrows − 1, maxRank)` directions and draws the surplus
  from random **unit** vectors. Proved: with `bits ≤ dim` (and enough rows) it is
  byte-identical to `pcaHashTables`; the aligned prefix is orthonormal and inside
  the PC subspace while the surplus is unit-norm; a rank-deficient row set caps
  `rank` at `nrows − 1`; `maxRank` caps the aligned rank and leaves the rest
  random; empty rows, a single row and zero-variance data all throw. Every table
  also reports its exact per-direction data variance (`tableVariances`, checked
  against a brute-force recompute; the aligned prefix carries above-baseline
  variance and the random surplus sits at exactly `trace/dim`), and a data-driven
  `rankPolicy` (`above-mean` | `noise`, from `memory/bitweight.js`) can set the
  rank from the spectrum — deterministic, capped by `maxRank`, never below 1.
- **Wired refresh (`lsh.test.js` section I).** `_refreshLshHyperplanes` is a
  no-op with the flag off (returns `false`, hyperplanes reference-identical),
  and with it on: replaces every set's hyperplanes with finite, `lowDim`-sized
  unit vectors, rebuilds the bucket index into an exact leak-free mirror of
  `_semanticProtos` (no empty buckets), is bit-deterministic under a seed, falls
  back (no-op) below its `minRows` data floor, and **survives a SQLite
  round-trip** (the persisted hyperplanes reload bit-identically and the loader
  rebuilds the buckets under them, so the reloaded instance needs no re-refresh).
  On a **real 107-bit /
  `lowDim`-71 index** with a planted anisotropic bank the paired sweep measures
  (self-recall under noise, 200 queries, margin multi-probe on):
  random `0.68` → aligned `0.775` at σ=0.25 and `0.01` → `0.04` at σ=0.5, with
  **no** loss at σ=0.1 (`1.0` everywhere) and the prefix probe also lifted
  (`0.315` → `0.395`). The measured caveat: aligning **every** direction is a
  no-gain config (`0.655`, *below* random) because it dedicates bits to the
  low-variance noise tail — the optimum is a broad plateau around `dim/4`, which
  is the wiring default. This is the honest analogue of the Density-Sensitive /
  weighted-Hamming literature: not every direction deserves a bit.
  **Round 15** replaces that constant with a data-driven rank: with
  `_pcaHashConfig.rankPolicy = 'above-mean'` the rank is read off the spectrum
  (`selectReliableRank`: keep only PCs above the random-direction baseline
  `trace/dim`, since a random unit direction captures that much variance in
  expectation) and the paired sweep picks ranks **22–23** on the same index,
  reaching **0.75** at σ=0.25 (vs `0.68` random and `0.655` full alignment) —
  inside the winning plateau with no hand-tuned constant. `_lshAlignedRank`
  records the rank each set used; with the flags null nothing changes, so all 11
  goldens stay byte-identical.
- **Bit-reliability law (`bitweight.test.js`, 69 checks).** `memory/bitweight.js`
  answers *how much a single hash bit tells us about a noisy neighbour*. Exact
  law: for a direction with data variance `λ` under isotropic noise `σ²`, a stored
  bit flips with `P = arccos(√(λ/(λ+σ²)))/π` — Charikar's `θ/π` with `θ` the
  signal/noise angle — so `P → 1/2` as `λ → 0` (a pure-noise bit) and `P → 0` as
  `λ → ∞`. Proved to be **exact** (`P(1,1) = 1/4`), monotone in both arguments
  with the stated limits and bounds but verified against **Monte Carlo** (max
  deviation `0.00055` over 2e5 draws at four `(λ, σ)` pairs); the bit is a binary
  symmetric channel, so its information is `1 − H₂(P)` (`reliabilityWeight = 1−2P`,
  `bitInformation`), zero for a noise-dominated direction; the **margin** flip
  law `Φ(−|margin|/σ)` is monotone in `|margin|`, which *proves* that ascending
  margin order (Lv's multi-probe) probes the most-likely-flipped bits first; the
  spectral noise estimator, the reliable-rank rule, and the weighted-Hamming
  metric (`weightedHamming`, `weightedKeyDistance`) are exact and verified against
  a brute-force unpacked recompute on 32-bit **and** BigInt words. Finally the
  law is validated on a **real index**: it predicts the measured bit-flip rate of
  a PCA-aligned hash to within `0.012` (0.1390 measured vs 0.1267 predicted at
  σ=0.5). The recorded **negative** result: reliability-weighted candidate
  ranking does *not* beat plain Hamming on the rotation-based index (the rotation
  already equalises per-direction variance, and the random surplus bits get
  down-weighted for nothing), so it is deliberately left unwired — the candidate
  pool is re-scored downstream by the exact projection cosine anyway.
- **Query-adaptive probe budget primitives (`bitweight.test.js`, 69 checks,
  Round 16).** The per-bit flip probabilities of a query are `q_b =
  Φ(−|margin_b|/σ)` (`bitFlipProbabilities`); the number of simultaneously
  flipped bits is Poisson-binomial, with the pmf built by an exact O(n²) DP
  (`poissonBinomialPmf`) and inverted for the coverage quantile
  (`poissonBinomialQuantile`); the probability that the WHOLE flipped set lies in
  the `k` smallest-margin bits is the exact product
  `∏_{b ∉ top-k}(1 − q_b)` (`marginContainmentCoverage`) — provably monotone, so
  `marginContainmentDepth` bisects exactly — and the recovery probability
  (`probeRecoveryCoverage`) multiplies that factor by `P(K_inside ≤ maxFlips)`.
  `recoveryDepth` finds the smallest depth reaching a target in ONE incremental
  O(n²) pass and is proven equal to a brute-force forward scan over 120 random
  spectra. `calibrateNoiseFromFlips` inverts the expected flip count for σ and
  round-trips it to 1e-6. Exact hand values: the Poisson-binomial pmf on four 1/2
  coins is `(1,4,6,4,1)/16` and the quantile is exact `(1/2→2, 0.6875→2,
  0.6876→3)`; containment is exactly `2^k/16`; recovery at `maxFlips = 1` is
  exactly `(d+1)/16` on four zero-margin bits. Monte Carlo matches the exact
  containment and recovery coverages to <0.02, and the depth is query-adaptive
  (0 for a confident query, deep for an ambiguous one) and monotone in the target.

### Dynamic query modification (`querymod.test.js`, 51 checks, Round 17)

`src/hivemind/memory/querymod.js` is the **query-side** companion to the
index-side recall fixes above (`multiprobe.js`, `binarypc.js`, `bitweight.js`).
Binary SimHash hashes a query to a sign word; two distinct things limit recall —
the word can sit in a sparse bucket (multi-probe attacks that), or the query can
be a *poor representative of its own neighbourhood* (this module attacks that:
every bit is a margin sign, and a query the neighbourhood does not agree with on
any direction hashes to a bucket containing none of it). The fix replaces the
query with the l2-normalised centroid `<c>` of the neighbours found so far and
continues the search — Rocchio-style pseudo-relevance feedback for binary codes.
Wired into the locked `_getGlobalLSHCandidates` behind the default-off
`_queryModConfig`; with the flag null nothing here runs, so all 11 goldens stay
byte-identical.

Four exact results, all proved:

- **Theorem 1 (maximality).** For a unit-vector set `S` no unit direction beats
  `<c>` on `Σ_{x∈S} x·u`, and `Σ_{x∈S} <c>·x` equals `‖Σ_{x∈S} x‖` equals
  `k‖mean‖` exactly (Cauchy-Schwarz; checked to `1e-9`, margin non-negative
  across random sets). `dotProductSum` is the objective, exactly maximised.
- **Theorem 2 (average collision probability).** Charikar's law gives
  `ACP(u,S) = 1 − mean_x arccos(x·u)/π`; to first order this is exactly
  `½ + Σ x·u/(kπ)`, so Theorem 1 says `<c>` maximises it — no random direction
  beats `<c>`, and `<c>` also beats the *average* random direction on the exact
  (not just first-order) ACP.
- **Appendix C.1 (minimal average residual covariance).** `averageCovariance` is
  exactly `const − ((Σ x·u)/k)²`, so it is minimised at `±<c>` — no random
  direction beats the centroid.
- **Section 6.4 (hash-failure elimination).** Because `<c>` is parallel to
  `Σ_{x∈S} x`, its bit on any direction is `sign(Σ_x x·w)`, which some member
  must share: the centroid collides with a member on **every** direction (zero
  failures over 200). A raw query has no such guarantee — an exact singleton
  witness `q = −x` fails `200/200`, and an opposing query fails the majority on
  a non-degenerate tight set.

Two empirical laws pinned with margin: **Charikar's collision law**
`1 − arccos(a·b)/π` is matched by 4e4 random hyperplanes to `<0.01`; and the
**denoising law** — the centroid of the noisy views of a point has a lower
per-bit error rate than a single view, shrinking with the view count (the 40-view
centroid at σ=0.3 cuts the error rate several-fold). The **synthetic regime
sweep** maps *when* the modification pays: on a random-hyperplane index it
strictly raises pool recall while the word is informative (6..12 bits, e.g.
`0.540 → 0.789` at 6 bits), and the gain decays **monotonically** to zero as the
hash narrows (`0.001` at 24 bits) — the empty-consensus-bucket regime.

Integration (`lsh.test.js` section J, default-off flag): toggling the flag back
is byte-identical; because the round only *unions* buckets, the returned pool is
mechanically a **superset** of the baseline, so recall can never fall. On the
narrow `forceMin` 6-bit / lowDim-4 index the branch is demonstrably **live** (it
enlarges the pool for the large majority of queries); on the **production
107-bit index it adds nothing** (`differ = 0`, because the exact buckets hold
`~0.1–1` prototypes so each set's found set is empty or a single already-probed
candidate). That is an honest, measured **negative**, and it matches the
synthetic crossover exactly — the mechanism is correct, the operating regime is
just past the crossover.

### Walk-forward evaluation harness (`walkforward.test.js`, 63 checks; `analysis.test.js` section S)

Domain `finance`, citations Pardo 2008 (walk-forward analysis), López de Prado
AFML (purged CV, DSR) and decision-time leakage (arXiv 2605.23959).
`src/analysis/walkforward.js` sits on top of `backtest.js` and turns an *online*
model into an honest out-of-sample report.

- **Causal protocol.** `walkForwardEvaluate` requires every fold's training
  indices to strictly precede its test block (`isCausalFold`) and throws
  otherwise — a purged-K-fold split is rejected for an online model, because it
  may train on the future side of a test block.
- **The audit *tests* no-lookahead.** `auditNoLookahead` bumps every return after
  a test bar and re-runs `signalForFold`; if that bar's signal moves, it is
  lookahead. Proved exactly: a `t+1`-peeking signal is flagged at all 17 in-range
  test bars (of 18) and a full-sample-mean signal is flagged, while a strictly
  causal signal is clean.
- **Promotion with size control.** `promoteDecision` requires pooled DSR ≥ 0.95
  (an *absolute* edge floor), a mean-fold-Sharpe improvement, a majority of fold
  wins, a non-worse positive-fold fraction, and clean audits. Measured over 300
  driftless-walk seeds: the relative-only rule (no absolute floor) false-promotes
  ~37–41% of the time ("which of two noise signals is better" is a coin flip),
  versus **~3.5%** with the floor, at full power on an AR(1) momentum feature
  (Sharpe 5.5 vs baseline −1.6). This is the calibration discipline of
  `BUGS.md` #10 applied to a *decision rule*.
- **Real-candle integration.** `walkforward.test.js` parses a shipped symbol,
  trains a fresh `HiveMind` on each fold's training slice (frozen afterwards), and
  evaluates it: the live causal model passes the audit, a `t+1` feature is caught,
  an always-long signal reproduces per-fold buy-and-hold exactly, a flat signal is
  exactly inert, and repeated runs are bit-identical.
- **The default-off features A/B through the same harness (section G).** The
  surprise gate at `floor=1`, homeostasis at `gain=0` and (as a control) the live
  settings of surprise/homeostasis/multi-probe are each run as a *candidate*
  against the same baseline; the two inert settings are **bit-identical to off
  end-to-end**, and at least one live setting changes the trajectory — so a
  future promotion decision changes exactly one thing and is measurable with
  `promoteDecision`.

### Structure scaling (`dimensions.test.js`, 185 checks)

Domain `attention`, citations Kaplan et al. (arXiv 2001.08361), Yang et al.
(arXiv 2203.03466, μP) and Lakshminarayanan et al. (arXiv 1612.01474). This is
the audit `docs/BUGS.md` recorded as missing (`CONFIG.forceMin = true` means
production runs the compact branch, which the goldens pin, while the full-size
branch was untested). It promotes the `dimensions` bag from `LOCKED-structural`
to `LOCKED-invariant`.

- **The compact branch is frozen.** Every `forceMin` override (hidden 8, heads 2,
  headDim 4, lowDim 4, 6 projections, 2 LSH sets/tables, 6 hash bits, kernel
  gamma 32, …) is asserted as an exact constant, so an accidental edit to the
  production branch fails the suite immediately.
- **Tensor shapes match declared counts.** Across the `es × is` grid (es ∈
  {2,…,1000}, is ∈ {4,12,32}) hidden size is divisible by the head count,
  `headDim = hiddenSize/numHeads`, `lowDim` lies in `[max(4, 0.18·hidden),
  0.78·hidden]`, `numLshSets = floor(numProjections/3)`, and the projection /
  hyperplane / bucket / transformer tensors all have the declared extents.
- **Width-scaling law.** Layers, heads and hidden size are monotone
  non-increasing in ensemble size, while the learning rate is monotone
  non-decreasing; every normalized-derived dimension is identical for any
  `es ≥ 1000` (because `log10(es)/3` saturates at 1); and the only dimension that
  depends on `inputSize` is the learning rate. (This is the μP/Kaplan
  width-scaling idea: smaller members learn faster.)
- **It runs.** Every config trains 6 steps with finite, bounded predictions;
  heavy churn on full-size instances leaves the LSH index consistent (zero dead,
  zero missing) with exact bucket multiplicity, finite weights/gradients, and
  unit-norm projections whose self-similarity is ~1; boundary configs (`es=1`,
  `is=1`) construct consistently.

### Probability of backtest overfitting (`analysis.test.js` section T, 20 checks)

Domain `finance`, citations Bailey, Borwein, López de Prado & Zhu (2016) and AFML
ch. 12. `src/analysis/overfitting.js` is the **non-parametric** counterpart of
the deflated Sharpe: instead of modelling the selection bias, it measures it by
cross-validation.

- **Exact combinatorics.** `cscvBlocks` partitions `n` observations into `S`
  equal-as-possible contiguous blocks (remainder on the first blocks).
  `cscvSplit` enumerates the `C(S, S/2)` symmetric splits: each in-sample set is
  a union of `S/2` whole blocks, its out-of-sample complement is the other `S/2`,
  the two are disjoint and together cover every observation, each block appears
  in exactly `C(S-1, S/2-1)` in-sample sets, and the split set is closed under
  complement.
- **Exact ranking.** `relativeRank` maps a value's rank among `N` to
  `omega = rank/(N+1) ∈ (0,1)`, with average ranks for ties; the observed
  in-sample winner's `omega` gives the split logit `ln(omega/(1-omega))`, and
  `PBO` is the fraction of splits with `logit ≤ 0`. `oosOnIsRegression` is the
  OLS of out-of-sample on in-sample performance (exact on identity/reflection).
- **Calibrated.** Over 20 iid-noise strategies (T=500, S=10, 252 splits) the
  measured `PBO` is **0.464** (~1/2, the "which noise signal is best" coin flip)
  with a ~0 degradation slope; a genuine persistent edge gives `PBO = 0` and a
  positive slope; a planted regime flip gives `PBO = 1`; an all-flat matrix gives
  `PBO = 1` under the documented tie convention; and invalid inputs (too few
  strategies, ragged matrix, odd block count, too few bars) all throw. An
  oversized `C(S,S/2)` (e.g. `blocks = 60`) is rejected up front rather than
  enumerated (`BUGS.md` #13).

### White's Reality Check & Hansen's SPA (`analysis.test.js` section U, 31 checks)

Domain `finance`, citations White (2000), Hansen (2005), Politis & Romano (1994)
and AFML. `src/analysis/reality_check.js` answers the question DSR and PBO do
not: *given that we searched over `K` candidates, is the best of them actually
better than a benchmark?* Both tests bootstrap the **max** relative performance
over the **same** resampled timeline for every candidate — which preserves the
cross-sectional dependence that `K` naive per-strategy p-values ignore — using
the stationary bootstrap shared with `performance.js`.

- **Exact inputs & statistics.** `benchmarkSeries`/`relativePerformance` accept
  a scalar, a full series, or `null` and subtract elementwise (means `[0, 3]`
  for benchmark `2`). RC's statistic is exactly `sqrt(T)·max_k mean(f_k)` (`2`
  for a `0.2` mean over `T = 100`), is `0` when every candidate equals the
  benchmark, and shifts by `-sqrt(T)·b` for a constant benchmark `b`. SPA's
  statistic is exactly `max(0, mean_k/SE_k)` with bootstrap standard errors; a
  zero-variance positive candidate gives an infinite t-stat with `p = 0`.
- **The block resampler.** `stationaryBlockIndices` has length `T`, in-range
  indices, is deterministic given its rng stream, defaults to
  `blockLength = floor(T^(1/3))`, and at `blockLength = 1` is **exactly** i.i.d.
  sampling with replacement (verified against a hand-drawn draw sequence, so the
  degenerate limit is not merely "random-looking").
- **Calibration & conservativeness.** Under a pure i.i.d.-noise null (150
  replications, `K = 5`, `T = 100`, `nBoot = 199`) both tests keep their size at
  ~5% (SPA **0.06**, RC **0.04**) with mean p-values ≈0.47/0.48, i.e.
  approximately Uniform; a strong persistent edge is rejected at `p < 0.02` by
  both. The flagship is Hansen's conservativeness result: on a design with one
  genuine edge among nine poor, high-variance candidates, **SPA p = 0.078 while
  RC p = 0.762** — RC's un-studentized null is inflated by the noisy losers,
  which studentization removes. This is the same SPA that the 2026
  **MinervaScore** production study (arXiv 2608.23808) composes with DSR, PBO and
  MinTRL.
- Invalid matrices, benchmarks, `n`/`blockLength` and `nBoot` all throw.

### Consistent SPA & Romano–Wolf StepM (`analysis.test.js` section V, 25 checks)

Domain `finance`, citations Hansen (2005), Romano & Wolf (2005), Politis & Romano
(1994). Section U's SPA is Hansen's *upper* bound: every candidate is recentred at
its own mean, which is robust but still pays for poor, noisy candidates — their
noise inflates the bootstrap maximum. Hansen's *consistent* variant removes that,
and Romano–Wolf turns the same bootstrap into a step-down procedure that names
**which** candidates beat the benchmark.

- **The consistent recentring is exact.** `consistentRecentring` recentres a
  candidate to zero iff its mean is more than `A_k = ω_k·√(2 ln ln T)` below the
  benchmark (verified inclusively at the threshold); the bound is pinned to
  `√(2 ln ln T)` (`1.74767…` at `T = 100`, `1.76975…` at `T = 120`) and is
  sub-linear in `T`. `T < 3` and mismatched `fbar`/`omega` throw.
- **Consistent vs upper SPA.** When every candidate is above the bound the two
  are **bit-identical** (all candidates are "valid", so the recentring equals
  `fbar`); when candidates are far below it, the consistent recentring removes
  their noise and the p-value falls: on the section-U flagship (one genuine edge
  among nine poor high-variance candidates) the ladder is **consistent 0.058 <
  upper 0.078 < RC 0.762**. The statistic stays `max(0, mean_best/SE_best)`, and
  exactly the three hopeless candidates are the ones recentred to zero.
- **The step-down.** `romanoWolfStepM` orders candidates by observed `t`,
  rejects the largest, drops it, and recomputes the bootstrap maximum over the
  remaining set. Proved: the ordering is descending; **the first step's p-value
  *is* the single-step consistent SPA p-value**; later step p-values never fall
  below earlier ones; at `α = 0.05` the flagship's genuine edge (`p = 0.058`) is
  *not* rejected, while at `α = 0.10` exactly that one candidate is; `α` outside
  `(0,1)` throws.
- **The degenerate guard.** A candidate whose observed `t ≤ 0` cannot be
  "superior" and ends the step-down, so a deterministic positive candidate is
  rejected (`p = 0`, `t = ∞`) while one **exactly equal to the benchmark**
  (`ω = 0`, `t = 0`) is never rejected — the case a naive `>` comparison gets
  wrong.
- **Size and power.** Because a family can be rejected only at its first step,
  the step-down's FWER *equals* the single-step SPA size — the test proves this
  structurally (it holds on all 200 null replications). Measured 5% FWER over
  200 reps: **0.075** with the default block bootstrap and **0.065** with
  `blockLength = 1`. The ~0.075 is the documented finite-sample price of block
  resampling on *i.i.d.* noise — at `blockLength = 1` the size is essentially
  exact, so the studentization and max logic are correct and the residual
  liberal-ness is the block bootstrap, not the test. Power on a planted edge is
  **0.89** (0.94 mean rejections per strong-edge run).

### Automatic block-length selection (`analysis.test.js` section W, 30 checks)

Domain `finance`, citations Politis & White (2004), Patton, Politis & White
(2009). Section V isolated the residual liberal-ness of the RC/SPA/StepM
bootstrap to the block *resampling* on i.i.d. noise. Section W adds the
data-driven cure: the Politis–White flat-top-lag-window block-length selector,
faithful to `arch.bootstrap.optimal_block_length`.

- **Exact oracle reproduction.** `politisWhiteBlockLength` returns
  **13.635665130318229** for the stationary bootstrap and **15.608940081363109**
  for the circular one on the paper's own benchmark (`numpy.random.RandomState(0)`,
  `standard_normal(10100)`, `y[i] = 0.3·y[i-1] + e[i]`, 100 burn-in) — the exact
  values `arch` asserts (`13.635665` / `15.60894`) — with `m = 6`, `optM = 3`,
  `Kn = 5`, `mMax = 105`, `bMax = 300`, `cv = 0.04`, and `circular/stationary`
  equal to `(3/2)^(1/3)` to 1e-11. The NumPy `RandomState(0)` generator is
  reproduced in-test and self-validated against its published first draws
  (`rand() = 0.5488135039273248`, `standard_normal() = 1.764052345967664`), so
  the match is a genuine re-derivation rather than a fitted constant.
- **Monotone under dependence.** On a pooled AR(1) ladder (40 series of `T = 120`
  per rung) the selected length rises monotonically with persistence:
  **0.651331 → 2.2728 → 2.856409 → 4.375896 → 8.42925** for φ = 0 → 0.2 → 0.3 →
  0.5 → 0.8. `autoBlockLength` reduces a matrix to a single length via
  `mean`/`median`/`min`/`max`, and `b = max(1, raw)` keeps it ≥ 1.
- **Calibration.** Opt-in `blockLength: 'auto'` restores nominal size on i.i.d.
  noise (**auto 0.04667** vs fixed-block-4 **0.08667**, picking a mean block of
  1.00968) and under AR(0.8) out-performs a fixed `blockLength = 1` (**auto
  0.41333** vs **0.74**, mean block 7.99756). The default is untouched (`null` →
  `floor(T^(1/3))`), so every locked p-value is bit-identical.
- **Measured limitation (pinned, deliberately not "fixed").** At φ = 0.8,
  `T = 120` the bootstrap standard error of the mean is biased low —
  `bootSE/trueSE` = **0.3265 (b=1), 0.6143 (b=4), 0.7074 (b=9), 0.7211 (b=15),
  0.6956 (b=25)** — so SPA/StepM over-reject (size 0.41–0.55) *regardless of* the
  block length (the effective sample size is only `T(1-φ)/(1+φ) = 13`).
  Newey–West Bartlett and quadratic-spectral omegas fail the same way here.
  Pinning the bootstrap scale to the true variance makes the size nominal
  (0.084 / 0.064 / 0.052 at φ = 0 / 0.5 / 0.8), so the residual is purely a
  *scale* problem; the variance-consistent resampling fix (Politis–Romano
  subsampling / Romano–Wolf "Siegfried") is tracked in `docs/TODO.md` item 7.

### Variance-consistent subsampling (`analysis.test.js` section X, 28 checks)

Domain `finance`, citations Politis & Romano (1994), Politis, Romano & Wolf
(1999). Section W pinned the block bootstrap's defect — its variance of the mean
is biased low under strong persistence, which no block length can fix. Section X
proves the subsampling cure: the reference distribution is estimated from
overlapping windows of the same series, so its scale is the data's own and no
long-run-variance estimate is needed.

- **The Bartlett standard error is exact.** `neweyWestSE(series, from, length, m)`
  is the usual Newey–West (Bartlett) HAC standard error of the mean: at `m = 0`
  it equals the i.i.d. `sqrt(mean squared deviation / n)` exactly (pinned
  `2.439672109116305` on `[1,2,4,8,16]`), and with the exact taper
  `2(1 - j/(m+1))` it is pinned at `m = 1` (`2.7825168463101893`) and `m = 2`
  (`2.8049480090250043`). A sub-window is the same estimator on that slice
  (`1.4229164972072996`), a constant window returns exactly `0`, and an
  out-of-range window/bandwidth, a length `< 2` window and a non-finite series
  all throw.
- **Structure and determinism.** `subsamplingSpa` defaults to `b = round(T/3)`
  and one bandwidth `m = round(b/6)`; it uses every overlapping window
  (`nWindows = T - b + 1`); every window statistic is exactly
  `(window mean - recentring)/shrink/neweyWestSE(window, m)` with
  `shrink = sqrt(1 - b/T)` (the covariance of an overlapping window with its own
  sample); the statistic is `max(0, max_k fbar_k/se_k)`; and the whole procedure
  is **deterministic** (no rng), so the calibration below is exactly
  reproducible. Using ONE bandwidth at both scales is what makes the comparison
  pivotal: the estimator's finite-sample bias depends on the bandwidth and the
  persistence, not on the sample length, so it cancels.
- **The flagship: nominal size at every persistence.** Over the same 300 fixed
  reps as section W (K=5, T=100), the 5% size is **0.0533 (i.i.d.), 0.0533
  (φ=0.2), 0.0567 (φ=0.5), 0.0433 (φ=0.8)** — where the block bootstrap gives
  **0.20 (φ=0.5)** and **0.4067 (φ=0.8)**. That is a ~9× cut in the φ=0.8 size
  distortion (gap ≥ 0.30). At T=120, φ=0.8: **0.0567 vs 0.3867**. Power on a
  planted edge survives: **0.7167** at φ=0, T=100 and **0.80** at T=120, and
  φ=0.8 still rejects above its size.
- **The step-down.** `subsamplingStepM` is the Romano–Wolf step-down on the same
  windows: its first step IS the single-step consistent subsampling SPA p-value
  (pinned `0.666667`), step p-values are monotone in the descending-`t` order, it
  always uses Hansen's consistent recentring, and it never rejects a candidate
  exactly at the benchmark (`omega = 0`, `t = 0` guard).
- **Step-down calibration.** FWER at φ=0.8 is **0.0533** (≤ 0.08; the family is
  rejected iff its first step is — on all 300 reps), and power at φ=0 is **0.72**
  with `< 1.3` mean rejections.

### Family-wise search on the honest-evaluation path (`analysis.test.js` section Y, 25 checks; `walkforward.test.js` sections H + I, 5 + 6 checks)

Domain `finance`, citations Politis & Romano (1994), Romano & Wolf (2005), and
arXiv 2603.17226 (mean-shift long-run variance) / 2608.23808 (search luck vs
persistent edge). Sections X/W built a correctly-sized instrument; section Y/H
consume it: `walkForwardSearch` maps a walk-forward report set onto the
subsampling SPA + Romano–Wolf step-down, `promoteDecision` can require it as an
opt-in hurdle, and `formatReport` renders the search-corrected line.

- **Segment-aware (`groups`) resampling.** `subsamplingSpa` / `subsamplingStepM`
  accept `groups` = contiguous segment lengths tiling `T`. Every window and the
  full-scale long-run variance are then computed **within** one segment: the
  pooled OOS mean is a length-weighted sum of segment means, so its variance is
  `sqrt(Σ_g (len_g · seNW_g)²)/T` with no cross-segment covariance. Proved exact
  against a manual recomputation (`40x40x40`, `b=20`, `m=3`, 63 windows); the
  default window becomes half the shortest segment; `groups=[T]` is
  **bit-identical** to the ungrouped estimator, so every section-X value is
  unchanged. Empty / mis-summed / non-integer / `<2` groups and a window longer
  than the shortest segment all throw (5 cases).
- **`familywiseSearch`.** A faithful, deterministic (no rng) view of the pair:
  `spaPValue` equals `subsamplingSpa(...).pValue` on the same window grid,
  `candidates[k].pValue/rejected` equal `subsamplingStepM(...).stepPValues[k] /
  .rejected[k]`, `rejectedIndices` matches `nRejected`, and the best candidate
  carries the single-step SPA p-value. Empty / missing strategy lists throw.
- **`walkForwardSearch`.** `[baseline, ...candidates]` becomes the family
  (index 0 = benchmark) over the pooled OOS returns `walkForwardEvaluate` now
  exposes (`pooledReturns`, `pooledGross`, `foldLengths`); fold lengths go in as
  `groups` and each fold's no-exposure first bar is trimmed (`T = Σ(len-1)`,
  `groups = len-1`). A planted-edge candidate is rejected at `p < 0.01` while
  i.i.d. noise candidates are not; a report without `pooledReturns`, an empty
  candidate list and unequal series lengths all throw.
- **The gate and the report are additive.** The opt-in `maxSearchP` /
  `requireSearchReject` hurdles leave the default gate **bit-identical** (no
  search attachment ⇒ same `promote` and same empty `reasons`), name their hurdle
  when they fire, and add no reason when satisfied. `formatReport` stays 4 lines
  without a search object and adds exactly one `search:` line when given one
  (whole-family or single-candidate, read from the argument or `report.search`).
- **Real-candle A/B.** Over the shipped ADA candles (three walk-forward folds of
  10, pooled 27 bars after trimming, `b=4 m=1`, 18 windows, family
  `[baseline, surprise, homeostasis, multiprobe, oracle(ctrl)]`), the DSR-floor
  promotion set and the family-wise step-down rejection set **agree on all five
  candidates**: the oracle control is caught by both and no real feature is
  promoted by either — i.e. the wiring detects a genuine edge and does not
  promote search luck (per-candidate step p-values `[1, 1, 0.333, 1, 0]`).
- **Wider real-candle grid (section I, 6 checks).** Section H's gate runs over 90
  bars / 3 folds / 18 subsampling windows — correctly sized but weakly powered.
  Section I repeats it on the full 150-bar slice with 6 folds of 15 test bars, so
  the SAME `familywiseSearch`/`walkForwardSearch` path runs over **48 windows**
  (groups `14^6`, `b=7`, `m=1`). The wider grid is well-formed, reports finite
  per-candidate statistics, still catches the oracle control and promotes no real
  feature, and the DSR floor and the family-wise step-down still **agree on every
  candidate** — i.e. the gate scales with the available windows without changing
  its verdicts.

### Generalised error rates on the family-wise path (`analysis.test.js` section Z, 33 checks)

Domain `finance`, citations Romano & Wolf (2007, arXiv 0710.2258) and Delattre &
Roquain (2014, arXiv 1311.4030). Section Y/H built a correctly-sized *single*
family-wise decision (FWER); section Z generalises it to "how many false
rejections" — k-FWER and FDP — on the SAME deterministic subsampling-window grid.
A new private `subsamplingReference` helper (window order statistics over the
full family) backs all three procedures, and `subsamplingStepM` remains max-t
(`k=1`) only — its arithmetic is **bit-identical**, so every section-X/Y pin and
golden fingerprint is unchanged.

- **Single-step k-FWER.** `subsamplingKfwer` rejects candidate `i` iff its
  k-th-largest window statistic is at least as extreme as the family reference,
  i.e. `p_i^(k) = #{windows : kthLargestWindowStat > t_i}/nWindows <= alpha`,
  with the reference kept over the FULL family. This bounds
  `P(k or more false rejections) <= alpha`. The `k=1` p-value is **exactly** the
  first `subsamplingStepM` p-value and the
  `subsamplingSpa({consistent:true}).pValue` (pinned equality); p-values are
  non-increasing and the rejection set non-decreasing in `k`; `k > K` clamps to
  the number of windows with `kClamped`/`requestedK` reported, and an invalid `k`
  throws.
- **Step-down FDP (EXPERIMENTAL).** `subsamplingFdp` walks the candidates down in
  descending-`t` order and at step `l` applies the k-FWER reference with the
  GROWING `k_l = min(floor(fdpTarget*l)+1, K)` (Delattre & Roquain §1.3/§1.5),
  estimating `estimatedFdp = (kHat-1)/nRejected` (null when nothing is rejected).
  Its rejection set is always a prefix of the step-down order, `perK` counts
  equal the single-step `subsamplingKfwer` counts at that fixed `k` (pinned), and
  it is flagged **EXPERIMENTAL** because it is not rigorously FDP-controlling in
  finite samples.
- **Calibration (deterministic given seeds).** Global null, K=4, 200 reps:
  FWER(k=1) **0.07** / 2-FWER(k=2) **0.075** at T=200, and **0.04** / **0.055**
  at T=80; `estimatedFdp` rejects nothing beyond the first step in ~95% of reps.
  A planted edge is recovered by both procedures.
- **Rejected design (honest negative).** The "k-th largest of the surviving set
  at each step" generalisation was measured to *worsen* with data (2-FWER 0.085
  at T=80, 0.145 at T=200) and is documented in the module as REJECTED — a
  non-extreme order statistic of a small survivor set is cleared far too easily;
  the reference must stay full-family with `k` growing only with the step index.
- **Wiring is additive.** `familywiseSearch`/`walkForwardSearch` take opt-in
  `kfwer`/`fdpTarget` (surfaced as the `kfwer`/`fdp` search fields), and
  `promoteDecision` keeps its additive `maxFdp` hurdle; with none supplied the
  report is **byte-identical** to the default 5-line form.
- **Edge cases and invariants (section AB, 8 checks).** The degenerate families
  are pinned: a single-candidate family **throws** (K >= 2 is required), an
  all-zero family rejects nothing through the `t = 0` guard, exactly tied
  candidates share a statistic / p-value / decision, a series benchmark zeroes
  the candidate equal to it, `groups=[T]` is **bit-identical** to the ungrouped
  path for both procedures, a tiny `fdpTarget` keeps `kHat = 1`, a near-zero
  alpha never rejects more than the 5% level, and a missing / empty / too-short
  matrix throws for both procedures.

### Mixture-family power / FDP validation (`analysis.test.js` section AA, 11 checks)

Domain `finance`, citations Romano & Wolf (2007, arXiv 0710.2258), Delattre &
Roquain (2014, arXiv 1311.4030), and the closed-testing admissibility result
(arXiv 1901.04885). Section Z proves SIZE under the global null; section AA
proves the **power / FDP trade-off** on a deterministic mixture family — a
planted fraction of candidates carries a real mean edge, the rest are AR noise —
on the same window grid. Every number is pinned from the seeded generator.

- **The k-FWER trade-off is real.** On a weak 2-edge family (K=6, T=200, phi=0.5,
  T=200, 200 reps) k=1 power is **0.155** and k=2 power is **0.4975** — the lower
  order statistic buys power — while FWER (**0.035**) and 2-FWER (**0.025**) stay
  at or below alpha. A denser 4-edge family (K=12) is recovered at power
  **0.915** (k=1) / **0.9975** (k=2), again size-controlled (0.05/0.05).
- **The FDP step-down gains power with its target.** On a 20-candidate family
  with 10 planted edges it rejects **6.833 / 9.05 / 9.783** candidates at targets
  0.1 / 0.2 / 0.3 (reported `kHat` **1.2 / 2.6 / 3.7**); at the loosest target it
  recovers more planted edges than the strict max-t step-down (9.783 vs 7.0).
  Realised FDP is **0.0098 / 0.0257 / 0.0528**, below each target, and on the
  global null the procedure degenerates to the max-t step (0.017 rejections).
- **And the honest non-control.** On a sparse 2-edge family with a tight target
  the realised FDP slightly **exceeds** the target (**0.1014 > 0.10**, with an
  estimated FDP of 0) — the finite-sample override that Delattre & Roquain and the
  closed-testing admissibility result (arXiv 1901.04885) predict. That measured
  over-run, together with the rejected survivor-order-statistic design, is why
  `subsamplingFdp` ships **EXPERIMENTAL**, not LOCKED-exact.

## Running the locks

- Browser: `test/browser/entries/locks.test.js` (part of the standard suite).
- Local (Node + better-sqlite3): `npm test` — includes `test/node/locks.test.js`
  and every mirror, on the real driver. Green as of the run recorded in
  `docs/BUGS.md` #21, re-confirmed at round 27 (**127/127 blocks across 43 files**, #42/#52).

## Promoting a component

1. Add an additive module under `src/` (never edit a locked path directly).
2. Write a test with **exact reference vectors** (not just "it runs").
3. Add the citation to `docs/CITATIONS.md` and a key to `CITATIONS` in the registry.
4. Move the entry to a `LOCKED-*` status, or add the new module as its own bag +
   manifest entry if it is a first-class component.
5. Re-run the full suite; a golden fingerprint change means an intentional
   re-freeze — record the reason in `docs/OPTIMIZATION.md`.
