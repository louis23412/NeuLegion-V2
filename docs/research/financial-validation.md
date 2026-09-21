# Financial validation & indicator maths

NeuLegion consumes OHLCV candles and emits directional signals. The
**backtest/evaluation layer is where most quantitative projects fool
themselves**, so this note records the honest-evaluation machinery we adopt and
why. These are the additive supercharges under `src/analysis/` — they never
touch the locked hot path; they score and label its output.

## The problem

Naive backtests leak the future in at least five ways:

1. **Overlapping labels** — a label computed over a horizon shares observations
   with its neighbours, so the effective sample size is far below the nominal
   one, and cross-validation folds leak across time.
2. **Selection bias** — trying N strategies and reporting the best Sharpe
   overstates the true edge; the maximum of N noisy Sharpes is biased upward.
3. **Non-normal returns** — Sharpe's standard error assumes i.i.d. normal
   returns; returns are skewed, fat-tailed and autocorrelated.
4. **Event labels** — fixed-horizon returns ignore path: a position can be
   stopped out long before the horizon ends.
5. **Regime non-stationarity** — a single train/test split is one sample of a
   non-stationary process.

## Adopted machinery (López de Prado, *Advances in Financial Machine Learning*)

| Tool | Module | Fixes |
| --- | --- | --- |
| **Purged K-fold CV with embargo** | `analysis/splits.js` | Leakage from overlapping labels; embargo removes serial-correlation bleed. |
| **Combinatorial purged CV** | `analysis/splits.js` | A single split is one sample of a non-stationary process. `C(k,m)` purged folds give `C(k-1,m-1)` backtest *paths*, i.e. a distribution of out-of-sample Sharpe (AFML ch. 12). |
| **Triple-barrier labels** | `analysis/labels.js` | Path-dependence; labels by profit-take / stop-loss / time barrier. |
| **CUSUM event filter** | `analysis/labels.js` | Sample only on meaningful price moves, not every bar. |
| **Fractional differentiation** | `analysis/labels.js` | Make a series stationary while preserving memory (López de Prado ch. 5). |
| **Sample uniqueness / average uniqueness** | `analysis/uniqueness.js` | Correct the effective sample size for label overlap. |
| **Probabilistic Sharpe Ratio (PSR)** | `analysis/performance.js` | Skew/kurtosis-adjusted confidence that SR > 0. |
| **Deflated Sharpe Ratio (DSR)** | `analysis/performance.js` | Multiple-testing (selection) bias over N trials. |
| **Minimum Track Record Length (MinTRL)** | `analysis/performance.js` | How much data is needed for a claimed SR to be significant. |
| **No-lookahead backtest** | `analysis/backtest.js` | Lookahead (positions must lag signals), and costs charged on turnover. |
| **Sample-uniqueness loss weights** | `hivemind/training/sample_weights.js` | Overfitting the duplicated information in overlapping labels — weight each observation by its average uniqueness so the weighted objective's effective sample size matches the labels' independent information. |
| **Walk-forward evaluation + no-lookahead audit** | `analysis/walkforward.js` | Assuming (rather than testing) that an online model has no lookahead, and promoting a feature on one lucky fold. |
| **Stationary bootstrap p-value** | `analysis/performance.js` | Sharpe significance without the i.i.d.-normal assumption (geometric blocks absorb serial correlation). Null-calibrated: see below. |
| **Probability of Backtest Overfitting (PBO / CSCV)** | `analysis/overfitting.js` | The *non-parametric* counterpart of the DSR: across `C(S,S/2)` symmetric in-sample/complement splits, how often does the in-sample winner land below the out-of-sample median? No Normality or independence assumption. |
| **White's Reality Check (RC) & Hansen's SPA** | `analysis/reality_check.js` | The **data-snooping** counterpart of the DSR: does the *best* of K strategies beat a benchmark once K-search selection is accounted for? A single stationary-block bootstrap of the relative-performance matrix gives a dependence-aware null for both the (non-studentized) RC statistic and the (studentized, recentred) SPA statistic. No Normality assumption; preserves cross-sectional dependence. |
| **Consistent SPA (SPA_c) & Romano–Wolf step-down** | `analysis/reality_check.js` | Which candidates win, and by how much? Hansen's *consistent* recentring (recentre to zero any candidate more than `A_k = ω_k·√(2 ln ln T)` below the benchmark) removes the power loss from poor losers; the Romano–Wolf step-down then names the individual winners with family-wise error control. |

## Literature

- **Bailey, Borwein, López de Prado & Zhu**, *The Probability of Backtest
  Overfitting* (Journal of Computational Finance, 2016) — **CSCV**: partition the
  timeline into `S` blocks, enumerate the `C(S, S/2)` symmetric
  in-sample/complement splits, and measure how often the in-sample winner lands
  below the out-of-sample median. `analysis/overfitting.js` implements it as the
  rank-based companion to the DSR; it uses the same combinatorics as
  `combinatorialPurgedSplit` but asks a different question (overfitting, not fold
  geometry), and it assumes neither Normality nor independence between trials —
  which the DSR does assume. Measured here: 20 iid-noise strategies give
  `PBO ≈ 0.46`, a genuine persistent edge drives it to 0, and a planted regime
  flip drives it to 1.
- **López de Prado**, *Advances in Financial Machine Learning* (Wiley 2018) and
  *Machine Learning for Asset Managers* (2020) — purged CV, embargo, uniqueness,
  triple-barrier, fractional differentiation.
- **Bailey & López de Prado**, *The Deflated Sharpe Ratio: Correcting for
  Selection Bias, Backtest Overfitting and Non-Normality* (2014) — the DSR.
- **Bailey, Borwein, López de Prado & Zhu**, *Pseudo-Mathematics and Financial
  Charlatanism* (2014) — minimum backtest length; why the best of many trials is
  not significant.
- **Politis & Romano** (1994) — stationary bootstrap, used for a block-resampled
  Sharpe p-value.
- **Hopfield networks for asset allocation** (arXiv 2407.17645) — a modern
  energy-based allocator; recorded as a bridge to the memory module.
- **Conditional independence testing in time series** (arXiv 2609.20772) — a
  rigorous way to test whether a signal adds information beyond a baseline.
- **SPEAR NeXT causal latent forecasting across horizons** (arXiv 2609.16871) —
  multi-horizon causal forecasting; aligns with the legion's multi-tier
  prediction structure.
- **Decision-time leakage** (arXiv 2605.23959) — a one-switch benchmark showing
  how easily a backtest is silently leaked; motivates the no-lookahead backtest
  and purged/embargoed splits.
- **Spurious predictability in financial ML** (arXiv 2604.15531) — an empirical
  catalogue of the ways a financial model reports an edge that is not there.
- **MinervaScore** (arXiv 2608.23808) — a statistical robustness grade for
  equity-strategy backtests; composes **DSR + PBO + SPA + MinTRL** over 359,062
  production backtests. It is an independent 2026 validation of this project's
  whole honest-evaluation battery — the four tests it grades with are exactly
  the four this note adopts.
- **White**, *A Reality Check for Data Snooping* (Econometrica 48(5):1097–1126,
  2000) — the bootstrap Reality Check: the distribution of the *maximum* of K
  relative-performance statistics, so a search over K strategies is priced in.
  `analysis/reality_check.js` implements it as `sqrt(T)·max_k mean(f_k)`.
- **Hansen**, *A Test for Superior Predictive Ability* (Journal of Business &
  Economic Statistics 23(4):365–380, 2005) — the studentized, recentred
  improvement on White's RC: each candidate is scaled by its own standard error
  and poor candidates are recentred out, which restores power when many
  candidates are far below the benchmark. Implemented as `max(0, mean_k/SE_k)`.
- **A caution on the Diebold–Mariano test** (arXiv 2409.12662) — DM power
  collapses under serial correlation, which is why the SPA statistic here is
  **studentized by a bootstrap standard error** rather than an i.i.d. formula.
- **Romano & Wolf**, *Stepwise Multiple Testing as Formalized Data Snooping*
  (Econometrica 73(4):1237–1282, 2005) — the step-down max-t that, given a family
  of K hypotheses, rejects the largest statistic, removes it, and recomputes the
  joint null over the survivors, so individual winners are named with the
  family-wise error rate controlled. `romanoWolfStepM` is this procedure on the
  consistently recentred studentized statistics.
- **Politis & Romano** (1994) — the stationary bootstrap that supplies the shared
  block-resampled timeline for both RC and SPA (`stationaryBlockIndices`), so the
  dependence structure is identical across the K candidates.
- **Volatility-aware extreme-event detection** (arXiv 2607.17555) — high-frequency
  regime detection relevant to where the labels sit in volatility space.
- **Triple-barrier labelling in practice** (arXiv 2504.02249 Korean markets; arXiv
  2411.12753 fractionally-differentiated features) — external validation of the
  `labels.js` machinery.
- **Stationary bootstrap** (Politis & Romano, 1994) — the calibrated null
  distribution for the Sharpe p-value (see `docs/BUGS.md` #10).
- **Pardo**, *The Evaluation and Optimization of Trading Strategies* (Wiley 2008)
  — walk-forward analysis: evaluate a model on data it has never seen, in
  deployment order, instead of trusting one split. The `walkforward.js` protocol
  (train strictly before test, freeze before predicting) is this discipline made
  checkable.
- **Decision-time leakage** (arXiv 2605.23959) — a one-switch benchmark showing
  how silently a backtest leaks; the reason `auditNoLookahead` *tests* rather than
  assumes.
- **What survives honest evaluation?** (arXiv 2608.27734) — the strongest
  justification for the audit. A deliberately leaky oracle posting **Sharpe 35
  survives Deflated Sharpe and probability-of-backtest-overfitting** testing:
  statistical correction is *not* a substitute for a structural look-ahead
  guardrail. Hence `walkforward.js` audits causality directly and the promotion
  gate requires a clean audit, rather than trusting the DSR alone.
- **AlgoXpert IS/WFA/OOS protocol** (arXiv 2603.09219) — an independent 2026
  framing of in-sample / walk-forward-analysis / out-of-sample as the overfitting
  control, matching the causal-fold protocol here.
- **GT-Score** (arXiv 2602.00080) and **regime-conditional strategy comparison**
  (arXiv 2606.31251) — candidate promotion objectives beyond pooled Sharpe/DSR
  (robustness-weighted score; per-regime fold conditioning).

## Test evidence

- `analysis.test.js` (browser) + `analysis.test.js` (node mirror) — every
  formula is checked against **exact reference vectors** (hand-computed /
  closed-form values), not just "runs without error". Properties tested:
  PSR/DSR monotone in SR and in N-trials; DSR ≤ PSR; uniqueness ∈ (0,1];
  purged CV train/test index sets are non-overlapping with the embargo gap;
  triple-barrier labels hit exactly one of `{1, -1, 0}`; CUSUM is monotone in
  threshold; fractional-differentiation weights preserve a linear series. Section
  S covers the walk-forward harness: exact `barReturns`/`aggregateFolds`, the
  audit flagging a `t+1` and a full-sample-mean signal while a causal signal is
  clean, `walkForwardEvaluate` rejecting non-causal folds, and the promotion
  gate's **size** (~3.5% false promotions) and **power** (an AR(1) momentum edge
  is promoted).
- Section I2 covers **combinatorial purged CV**: `C(k,m)` folds, each test set a
  union of whole groups, each observation tested exactly `C(k-1,m-1)` times (the
  path count), disjoint train/test, zero label-window leakage, and embargo
  monotonically shrinking the training set.
- Section T covers **PBO/CSCV**: `cscvBlocks` partitions exactly (remainder on
  the first blocks); `cscvSplit` yields the `C(S,S/2)` symmetric splits, each a
  disjoint cover, with each block in exactly `C(S-1,S/2-1)` in-sample sets and the
  set closed under complement; `relativeRank` maps rank to `omega = rank/(N+1)`
  with average ranks for ties (best `N/(N+1)`, worst `1/(N+1)`, full tie `1/2`);
  `oosOnIsRegression` is exact. Calibration: **20 iid-noise strategies over
  T=500 with S=10 give `PBO = 0.464`** (the coin-flip baseline) with a ~0
  degradation slope; a persistent edge gives `PBO = 0` and a positive OOS-on-IS
  slope; a planted regime flip gives `PBO = 1`; an all-flat matrix gives `PBO = 1`
  under the documented tie convention; four malformed inputs all throw; and an
  oversized `C(S,S/2)` is rejected by the split cap (`BUGS.md` #13). Section S
  also pins the `walkForwardSplit` step guard (`BUGS.md` #12: a zero step used to
  hang the fold loop).
- Section U covers **White's Reality Check and Hansen's SPA**: exact benchmark
  handling (a candidate identical to the benchmark gives statistic 0), the
  closed-form statistic on a constant-relative-mean matrix (T=100, mean 0.2 →
  statistic exactly 2), a zero-variance positive candidate giving `SPA = ∞, p = 0`,
  and the identity that the shared `stationaryBlockIndices` resampler is exactly
  i.i.d. at `blockLength = 1` with the default `floor(T^(1/3))` (= 4 at T=100).
  Calibration over 150 reps (K=5, T=100, nBoot=199): **null size ≈ 0.06 (SPA) /
  0.04 (RC)** with near-Uniform p-values (mean p ≈ 0.47/0.48), `p < 0.02` on a
  strong edge for both, and the discriminating case — one genuine edge among nine
  poor high-variance candidates gives **SPA p = 0.078 vs RC p = 0.762** — the
  reason SPA is the default recommendation. Every input guard (matrix shape,
  benchmark length, blockLength, nBoot) throws.
- Section V covers **consistent SPA and the Romano–Wolf step-down**: the exact
  recentring bound `√(2 ln ln T)` (inclusive at the threshold; sub-linear in `T`;
  `T < 3` rejected), bit-identical agreement with upper SPA when all candidates
  are valid, the strict ladder consistent 0.058 < upper 0.078 < RC 0.762 on the
  flagship, and exactly the poor candidates zeroed. `romanoWolfStepM`'s ordering
  is descending; its **first step equals the single-step consistent SPA
  p-value**; step p-values are monotone; at `α = 0.05` the `p = 0.058` edge is
  *not* rejected while at `α = 0.10` exactly it is; `α ∉ (0,1)` throws. The
  degenerate guard is proved (a deterministic positive candidate is rejected with
  `p = 0, t = ∞`; one exactly equal to the benchmark is never rejected). Size
  and power over 200 replications: 5% FWER **0.075** (default block) / **0.065**
  (`blockLength = 1`), with the family-rejected-iff-first-step-rejected identity
  holding on every rep; a planted edge is rejected in **0.89** of runs (0.94 mean
  rejections).
- `walkforward.test.js` — the real-candle end-to-end run: a live `HiveMind`
  re-fit per fold on a shipped symbol (frozen afterwards, seeded `Math.random`
  like the goldens) passes the lookahead audit, a `t+1` feature is caught, an
  always-long signal reproduces per-fold buy-and-hold exactly, a flat signal is
  exactly inert, repeated runs are bit-identical, and the default-off features
  A/B through the harness with their inert settings bit-identical to off
  end-to-end.
- These modules are **pure** (no I/O, no RNG unless seeded) so the reference
  vectors are stable.

## How this interacts with the locked core

The analysis modules *read* signals and candles; they are never imported by
`hivemind/` or by the hot `legion/runner.js` loop. So they cannot change a
golden fingerprint. They are the measuring instrument, not the engine.

## Walk-forward evaluation and the no-lookahead audit

`analysis/backtest.js` proves a *fixed* signal can be scored without lookahead.
An *online* model (the HiveMind learns as it goes) needs more: the evaluation must
train strictly before it tests, and each test bar's position must use only data
available at that bar. `analysis/walkforward.js` provides that protocol and makes
both conditions checkable.

- **Causal folds are mandatory.** For an online model, `walkForwardEvaluate`
  requires `train < test` in every fold and throws on a purged-K-fold split
  (which may train on the future side of a test block). Purging protects a *metric*
  from overlapping labels; it does not make an online-model evaluation honest.
- **The audit tests no-lookahead, it does not assume it.** `auditNoLookahead`
  adds a large constant to *every return after a test bar* and re-runs the signal
  function; if that bar's emitted signal moves, the signal used the future. This
  catches the two accidental leaks that inspection misses: a signal that peeks at
  `t+1`, and a signal standardised by a full-sample mean (arXiv 2605.23959).
- **Promotion is a calibrated decision, not a ranking.** `promoteDecision`
  promotes a candidate feature only if pooled DSR ≥ 0.95 (an absolute edge floor),
  mean fold Sharpe improves, it wins a majority of folds, the positive-fold
  fraction does not drop, and both audits are clean. The absolute floor is what
  fixes the gate's **size**: without it, "candidate beats baseline" between two
  zero-skill signals is a coin flip (~37–41% false promotions measured over 300
  driftless walks); with it the false-promotion rate is **~3.5%** at full power on
  an AR(1) momentum edge. This is the same size/power discipline as the bootstrap
  calibration below, applied to a *decision rule*.

### The stationary bootstrap must re-draw its block starts

A block-resampled p-value is only as good as its null distribution. The
stationary bootstrap (Politis & Romano 1994) draws *independent* blocks: at each
step a new block begins with probability `p = 1/blockLength` and takes a
**freshly drawn uniform start index**; otherwise the block continues at the next
index. If the start is drawn once and merely advanced from there, the resample is
a single contiguous rotation of the series — and a rotation preserves the sample
Sharpe, so the null distribution collapses to a point. The p-value then becomes
anti-conservative: measured at **17.5%** false positives for a nominal 5% test on
pure noise (`BUGS.md` #10). Re-drawing the start per block restores the
calibrated rate (**5.8%** measured, 7/120) while keeping full power (`p = 0` on a
strong edge).

The general lesson, which is why `analysis.test.js` section G2 exists: a
significance test must be validated by its **size** (false-positive rate under a
known null) and its **power**, not just by its output range. A range/determinism
check cannot see a degenerate null.
- `analysis.test.js` section G2 — the stationary bootstrap's **null
  calibration** (≈5% rejection on 120 pure-noise series; mean p ≈ 0.5), its
  **power** (p ≤ 0.01 on a strong edge), and monotonicity in drift. This is the
  regression guard for `BUGS.md` #10.

## Data-snooping: White's Reality Check and Hansen's SPA

DSR and PBO correct for *selection over trials* under a (DSR) Normal/independence
assumption or a (PBO) rank-based one. Neither prices in the fact that the K
strategies were chosen by searching; and neither is a *test against a benchmark*.
The data-snooping family fixes exactly that, and `analysis/reality_check.js`
implements its two canonical members.

- **The relative-performance matrix is the primitive.** Given K candidate return
  series and one benchmark, `relativePerformance` returns `f_{t,k} = r_{t,k} −
  r_{t,benchmark}` — the per-period *edge over the benchmark*. `benchmarkSeries`
  can build the benchmark from a candidate index (a buy-and-hold reference) or
  add an explicit constant. Everything is decided from `f`.
- **One shared bootstrap, two statistics.** `stationaryBlockIndices` draws a
  single Politis-Romano block timeline (`p = 1/blockLength`, fresh uniform start
  per block — the same rule the Sharpe p-value uses, and the same fix for
  `BUGS.md` #10). `bootstrapRelativeMeans` resamples `f` along that timeline to
  get `fbar` (observed mean per candidate) and the `B×K` matrix `fbarBoot`.
  Because both statistics reuse the *same* draws, their comparison is
  apples-to-apples and the cross-sectional dependence between candidates is
  preserved. At `blockLength = 1` the resampler is exactly i.i.d. (proven in
  section U).
- **White's Reality Check** is non-studentized: `RC = sqrt(T)·max_k mean(f_k)`,
  with the null p-value the share of bootstrapped `max_k (fbarBoot − fbar)` that
  reach it. It is robust but *conservative* when the K candidates include many
  poor, high-variance series — their noise inflates the bootstrap maximum.
- **Hansen's SPA** studentizes: `SPA = max(0, max_k mean_k/SE_k)` where `SE_k` is
  the bootstrap standard error of candidate k's mean, and the null is recentred
  so that candidates below a threshold contribute only their negative part. This
  is **less conservative than RC** and is the default recommendation. The
  studentization is not cosmetic: arXiv 2409.12662 shows the analogous
  Diebold–Mariano statistic loses its power under serial correlation, which is
  exactly what a bootstrap standard error corrects.
- **Why it matters here.** The legion *searches* — evolution, multi-tier
  prediction, a growing population of controllers. The honest question is
  therefore never "does the best member have a positive Sharpe" but "does the
  best member beat buy-and-hold once we account for the search over the
  population". `whiteRealityCheck`/`hansenSpa` answer that question directly, and
  section U's flagship calibration (SPA p = 0.078 vs RC p = 0.762 on one real
  edge among nine poor candidates) shows the two are not interchangeable.
- **Pure and off the hot path.** Like every module under `src/analysis/`, it only
  reads signals; it is never imported by `hivemind/`, so it cannot move a golden
  fingerprint. It is registered `LOCKED-invariant` purely as a correctness
  contract (citations White 2000, Hansen 2005, Romano & Wolf 2005, Politis &
  Romano 1994).
- **The consistent recentring (SPA_c).** The upper bound above recentres every
  candidate at its own mean, so a poor candidate's noise still enters the
  bootstrap maximum. Hansen's consistent variant recentres a candidate to zero
  iff its mean is more than `A_k = ω_k·√(2 ln ln T)` below the benchmark — "too
  poor to be asymptotically relevant". The log-log bound is what makes the test
  *consistent*: it vanishes as `T` grows (a genuinely bad candidate is eventually
  recentred out, so power is not lost) yet shrinks slower than the sampling error
  (a real local alternative keeps its edge). On the flagship design the ladder is
  **consistent 0.058 < upper 0.078 < RC 0.762**; when *every* candidate is valid
  the two are bit-identical.
- **Romano–Wolf names the winners.** SPA/RC answer "is the *best* candidate
  significant?" but do not say *which* others are. `romanoWolfStepM` orders
  candidates by their studentized, consistently recentred statistic, rejects the
  largest, drops it, and recomputes the bootstrap maximum over the survivors —
  the step-down max-t of Romano & Wolf (2005), with family-wise error control.
  The first step is *exactly* the single-step consistent SPA p-value, and the
  step p-values are monotone, so the procedure is a strict power upgrade over the
  one-shot test rather than a different statistic.
- **Calibration caveat (measured).** Because a family can be rejected only at its
  first step, the step-down's FWER equals the single-step SPA's size. Measured at
  the 5% level over 200 replications of `K = 5`, `T = 100` i.i.d. noise: **0.075**
  with the default block bootstrap and **0.065** with `blockLength = 1`. At
  `blockLength = 1` the size is essentially exact, which isolates the residual
  liberal-ness to the block *resampling* (the documented price of robustness to
  autocorrelation) rather than the studentization or the max logic. Substituting
  a Newey–West HAC `ω` for the bootstrap standard error moves the default-block
  size only from ~0.088 to ~0.078, confirming the block bootstrap — not the
  variance estimator — is the driver. Automatic block-length selection (Politis &
  White 2004) is implemented in section W below, which reproduces `arch`'s oracle
  vectors exactly; it fixes the i.i.d. case and shows the residual AR(0.8)
  liberal-ness is a *scale* problem (the bootstrap SE of the mean is biased low),
  left as a documented limit.
- Section W covers **automatic block-length selection** (Politis & White 2004;
  Patton, Politis & White 2009). `politisWhiteBlockLength` reproduces `arch`'s
  published oracle exactly — on the paper's benchmark (`RandomState(0)`,
  `standard_normal(10100)`, AR(0.3), 100 burn-in) it returns the stationary
  length **13.635665130318229** (arch asserts 13.635665) and the circular
  **15.608940081363109** (arch asserts 15.60894), with `m = 6`, `optM = 3`,
  `Kn = 5`, `mMax = 105`, `bMax = 300`, `cv = 0.04`, and
  `circular/stationary = (3/2)^(1/3)` to 1e-11. The NumPy `RandomState(0)`
  stream is reproduced in-test (anchors `rand() = 0.5488135039273248`,
  `standard_normal() = 1.764052345967664`). The selector is monotone along a
  dependence ladder (pooled over 40 series of `T = 120` per rung:
  **0.651331 → 2.2728 → 2.856409 → 4.375896 → 8.42925** as φ: 0 → 0.2 → 0.3 →
  0.5 → 0.8). `autoBlockLength` reduces a matrix to one length. The opt-in
  `blockLength: 'auto'` on the SPA/StepM path restores i.i.d. size
  (**auto 0.04667** vs fixed-4 **0.08667**, mean block 1.00968) and beats a fixed
  `blockLength = 1` under AR(0.8) (**auto 0.41333** vs **0.74**, mean block
  7.99756). The default is unchanged (`null` → `floor(T^(1/3))`), so every locked
  p-value is bit-identical.
- **Measured limit (left documented, not fixed).** At φ = 0.8, `T = 120` the
  stationary-bootstrap SE of the mean is biased low — `bootSE/trueSE` =
  **0.3265 (b=1), 0.6143 (b=4), 0.7074 (b=9), 0.7211 (b=15), 0.6956 (b=25)** — so
  SPA/StepM over-reject (size 0.41–0.55) *regardless of block length*; the
  effective sample size is only `T(1-φ)/(1+φ) = 13`. Newey–West Bartlett and
  quadratic-spectral omegas fail the same way at this T/φ. Pinning the bootstrap
  scale to the true variance makes the size nominal (0.084 / 0.064 / 0.052 at
  φ = 0 / 0.5 / 0.8), so the failure is purely a *scale* problem; the fix is a
  variance-consistent resampling scheme (Politis–Romano subsampling /
  Romano–Wolf "Siegfried"); section X below implements it.
- Section X implements and proves **variance-consistent subsampling** (Politis &
  Romano 1994; Politis, Romano & Wolf 1999). `neweyWestSE` is the exact
  Newey–West (Bartlett) HAC standard error of the mean — at `m = 0` it is exactly
  the i.i.d. standard error (`2.439672109116305` on `[1,2,4,8,16]`), with the
  `m = 1` and `m = 2` tapers pinned, a constant window returning exactly `0`.
  `subsamplingSpa` estimates the statistic's whole sampling distribution from
  every overlapping window of the same series (`nWindows = T - b + 1`, default
  `b = round(T/3)`), studentized at both the window and the full scale by the
  SAME bandwidth `m = round(b/6)`. Sharing the estimator is what makes the
  comparison pivotal: its finite-sample bias is a function of the bandwidth and
  the persistence, not of the sample length, so it cancels — this is why the
  reference scale is the data's own and the result needs no long-run-variance
  estimate. The `sqrt(1 - b/T)` factor is the exact covariance of an overlapping
  window with its own sample. Because all windows are used the procedure is
  **deterministic** (no rng), so the calibration is exactly reproducible.
  `subsamplingStepM` is the Romano–Wolf step-down on the same windows (its first
  step IS the single-step consistent subsampling SPA p-value, pinned `0.666667`;
  it always uses Hansen's consistent recentring).
- **The calibration, i.e. the payoff.** Over the same 300 fixed reps as section W
  (K=5, T=100) the subsampling 5% size is **0.0533 / 0.0533 / 0.0567 / 0.0433**
  for φ = 0 / 0.2 / 0.5 / 0.8, against the block bootstrap's **0.20 (φ=0.5)** and
  **0.4067 (φ=0.8)** — a **~9×** cut in the φ=0.8 size distortion, with the gap
  ≥ 0.30. At `T = 120`, φ = 0.8: **0.0567 vs 0.3867**. Power is retained:
  **0.7167** at φ=0, T=100 and **0.80** at T=120, and φ=0.8 still rejects above
  its size. `subsamplingStepM` holds FWER **0.0533** at φ=0.8 (the family is
  rejected iff its first step is, on every rep) with power **0.72** at φ=0 and
  `< 1.3` mean rejections. This closes the section-W limitation: the honest
  SPA/StepM battery is now correctly sized under strong persistence *and* under
  i.i.d. noise.
- Section Y (25 checks) extends subsection X from a single stationary series to
  **segmented (pooled) folds**, and wires the family-wise test into the
  walk-forward report. `subsamplingSpa`/`subsamplingStepM` accept an opt-in
  `groups` argument — positive integer segment lengths that tile `T`. Every
  sub-window and the full-scale long-run variance are then estimated *within a
  segment*, and the full-scale SE is the segment-aware aggregate
  `sqrt(Σ_g (len_g·seNW_g)²)/T`; a single group (`groups=[T]`) reduces exactly to
  the ungrouped estimator, so the section-X reference values are unchanged. The
  grouped default window becomes half the shortest segment (`b = max(2,
  floor(minLen/2))`), and windows are restricted to lie inside one segment so a
  pre-split regime jump cannot inflate the LRV (the mean-shift case of arXiv
  2603.17226). Section X's grounding papers extend here: Politis & Romano 1994 /
  Romano & Wolf 2005 (subsampling and step-down), arXiv 2603.17226 (LRV for
  mean-shift series).
- Section H (5 checks) closes the loop on the **honest-evaluation path**:
  `walkForwardSearch` feeds a walk-forward family (`[baseline, ...candidates]`,
  index 0 = benchmark) into `familywiseSearch`, which runs subsampling SPA and
  the Romano–Wolf step-down over the **pooled out-of-sample return streams** with
  the folds' lengths as `groups` and each fold's no-exposure first bar trimmed.
  `familywiseSearch` exposes every candidate's family-wise p-value/rejection flag
  and the whole-family SPA p-value; `walkForwardSearch` maps these back to the
  candidate labels. `promoteDecision` gains opt-in `maxSearchP` /
  `requireSearchReject` hurdles and `formatReport` appends one search line. On the
  real-candle walk-forward (live HiveMind, 3 folds, family
  `[baseline, surprise, homeostasis, multiprobe, oracle(ctrl)]`) the measured
  step-down p-values are `[1, 1, 0.3333333333333333, 1, 0]` and
  `dsrPromotes = [false, false, false, true]` agrees with
  `fwRejects = [false, false, false, true]`: **neither rule promotes a real
  feature, and both catch the injected oracle control** — the two independent
  significance batteries agree on the honest-evaluation path. Section I then
  repeats the gate on the full 150-bar slice with 6 folds of 15 test bars,
  widening the subsampling grid from 18 to **48 windows** (groups `14^6`,
  `b=7`, `m=1`); the wider grid is well-formed and the verdict is unchanged —
  oracle caught, no real feature promoted, DSR and family-wise still agree on
  every candidate (the power lever item 10 asks for, exercised on real candles).
- Section Z (33 checks) generalises the family-wise decision from "did *any*
  candidate beat the benchmark" (FWER) to "how many false rejections". On the
  same deterministic subsampling-window grid as sections X/Y, `subsamplingKfwer`
  is the single-step **k-FWER** procedure (Romano & Wolf 2007, arXiv 0710.2258):
  candidate `i` is rejected iff its k-th-largest window statistic clears the
  family reference, so `P(k or more false rejections) <= alpha`; its `k=1`
  p-value is *exactly* the single-step SPA/StepM p-value (pinned). The
  `k=1`-consistency and full-family reference are what make k-FWER a strict
  generalisation of the section-X/Y FWER control.
- Section Z also implements the corrected Romano–Wolf / **Delattre–Roquain FDP
  step-down** (arXiv 1311.4030 §1.3/§1.5): `subsamplingFdp` steps candidates down
  in descending-`t` order and at step `l` applies the k-FWER reference with the
  *growing* `k_l = min(floor(fdpTarget*l)+1, K)`, reporting
  `estimatedFdp = (kHat-1)/nRejected`. It is pinned against the single-step
  counts and by a prefix property, but shipped **EXPERIMENTAL** — it is not
  rigorously FDP-controlling in finite samples. Measured on the global null (K=4,
  200 reps) the FWER/2-FWER is **0.07/0.075** at T=200 and **0.04/0.055** at
  T=80, and the FDP estimator rejects nothing beyond the first step in ~95% of
  reps.
- The design space has a measurable trap, recorded honestly: the naive
  "k-th largest of the *surviving* set at each step" step-down **worsens with
  data** (2-FWER 0.085 at T=80, 0.145 at T=200) because a non-extreme order
  statistic of a small survivor set is cleared too easily; it is documented in
  the module as REJECTED, and the reference is kept full-family with `k` growing
  only with the step index. Grounding: Romano & Wolf 2007 (k-FWER), Delattre &
  Roquain 2014 (step-down FDP).
- Section AA (11 checks) closes the power question on a **mixture family**: a
  planted fraction of candidates carries a real mean edge and the rest are AR
  noise, on the same deterministic window grid. The k-FWER trade-off is real —
  on a weak 2-edge family k=2 power is **0.4975** vs k=1's **0.155** while
  FWER/2-FWER stay at 0.035/0.025 — and the FDP step-down on a 20-candidate,
  10-edge family rejects **6.833 / 9.05 / 9.783** candidates at targets
  0.1 / 0.2 / 0.3 (reported `kHat` 1.2 / 2.6 / 3.7), beating the strict max-t
  step-down (9.783 vs 7.0) at the loosest target. Realised FDP there is
  **0.0098 / 0.0257 / 0.0528** (below target). But on a sparse 2-edge family with
  a tight target the realised FDP slightly **over-runs** it (**0.1014 > 0.10**,
  with an estimated FDP of 0) — the predicted finite-sample non-control
  (Delattre & Roquain 2014; the closed-testing admissibility result, arXiv
  1901.04885) that keeps `subsamplingFdp` EXPERIMENTAL.
- The generalised rates are also hardened against the degenerate families
  (section AB, 8 checks): a single-candidate family throws (K >= 2 required), an
  all-zero family rejects nothing (`t = 0` guard), tied candidates share a
  statistic/p-value/decision, a series benchmark zeroes the candidate equal to
  it, `groups=[T]` is bit-identical to ungrouped for both procedures, a tiny
  target keeps `kHat = 1`, and a near-zero alpha never rejects more than the 5%
  level. Grounding: as above.

## Measuring uniqueness vs. *applying* it

`analysis/uniqueness.js` (additive, off the hot path) *measures* uniqueness and
effective sample size — it is the reporting instrument. Applying the same idea
to training is a hot-path concern, because it scales the loss the model actually
descends, so it lives in `hivemind/training/sample_weights.js` (a hot-path
support module, `LOCKED-invariant`).

- **Two implementations, one formula, cross-checked.** The hot path must never
  import `src/analysis/`, so the average-uniqueness formula is re-implemented in
  its training-weight form. `sample_weights.test.js` asserts it is **bit-for-bit
  equal** to `sampleUniqueness` on shared fixtures, so the duplicate can never
  silently diverge.
- **Weighting, not just counting.** Average uniqueness ∈ (0, 1] is used directly
  as the loss weight; `normalizeWeights(..., 'mean1')` rescales it to mean
  exactly 1 so the average gradient magnitude — and therefore the effective
  learning rate — is unchanged, while credit is redistributed toward the least
  redundant observations. `sum1` gives a convex combination instead.
- **The controller feed.** `HiveMind.train(inputs, target, sampleWeight)`
  multiplies the logit gradient by the weight (linear in it, proven by the
  gradient-energy ratio `w²`). `HiveMindController._sampleWeightsForBatch`
  derives entry bars from trade timestamps and calls
  `spanWeightsFromEntries(entries, { horizonBars })`; it returns `null` (weight
  1) unless `_sampleWeightConfig` is set, so shipping it **off by default** keeps
  every golden fingerprint bit-identical.
- **Not yet promoted.** The math is proven; the open question is empirical — does
  the uniqueness-weighted loss improve walk-forward PSR/DSR over the unweighted
  baseline on the shipped candles, and which normalisation/horizon is best. That
  is now a `walkforward.js` A/B (`walkForwardEvaluate` + `promoteDecision`), not a
  new mechanism.


## Dependence-aware inference for the pooled evaluation

The walk-forward A/B does not evaluate one time series: it evaluates a
*rectangular grid* of streams × folds (round 23, N2 — one walk-forward per
symbol, pooled). Every statistic the gate reads — the pooled Sharpe, the DSR, the
mean fold Sharpe, the win fraction — is computed by pretending the pooled bars are
an independent sample. On the real 8-symbol basket they are not: per-fold Sharpe
series correlate **0.41–0.52** across symbols, and the same calendar window
repeats across streams, so the grid of 288 folds carries far less than 288
independent observations. Treating it as i.i.d. understates the standard error,
inflates the DSR, and lets the gate read search noise as an edge.

**The diagnostic: an equicorrelation design effect.** With the mean pairwise
correlation `rhoBar` of the per-stream per-fold Sharpe series and `m` streams,
the Kish (1965) design effect is `deff = 1 + (m - 1) * rhoBar` and the effective
information is `effectiveBars = bars / deff`. The same quantity appears in the
effective-sample-size literature (Ledoit & Wolf 2008, *Robust performance
hypothesis testing with the Sharpe ratio*), and it is the reason the naive
"4,300 pooled bars" is really ≈ 4,300 / 2.1 ≈ 2,050 independent bars, so the
honest MDE95 is ≈ ±0.98 rather than the i.i.d. ±0.47. `equicorrelationDesignEffect`
and `equicorrelationEffectiveSize` compute exactly this; it is a *measured*
diagnostic, not an assumption.

**The estimator: a delete-one-cluster jackknife, not the scaling.** Scaling the
i.i.d. SE by `sqrt(deff)` is only correct when every pair is equally correlated.
Because we have the whole panel, it is strictly better to *estimate* the variance
of the pooled statistic from the panel directly, by deleting one fold-window
cluster at a time and forming the delete-one jackknife (Efron 1979; the
block/cluster version is the moving-block jackknife of Künsch 1989). Treating a
**fold window as the cluster** is the same dependency unit the block bootstrap
and HAC standard errors use (Cameron & Miller 2015, *A practitioner's guide to
cluster-robust inference*; the cluster jackknife for staggered designs is
developed in arXiv 2602.12043, "Improved Inference for CSDID Using the Cluster
Jackknife"). `clusterJackknife` → `seCluster`; the ratio `seCluster / seIid` is
the realised design effect and it is what decides whether any correction is owed
(`adjustmentNeeded`).

Calibration (deterministic Monte Carlo, 8 streams, fixed equicorrelation `rho`):
the jackknife's `seCluster / seIid` measured **0.988 / 1.653 / 2.124 / 2.512** at
`rho = 0 / 0.25 / 0.5 / 0.75`, against the closed-form `sqrt(1 + 7*rho) = 1 /
1.658 / 2.121 / 2.500` — agreement to three decimals, so the estimator reproduces
the dependence structure rather than assuming it. When `seCluster <= seIid` the
panel is *diversifying*, there is no over-confidence to deflate, and
`dsrAdjusted` is left `null` — a report never invents a correction (this is the
`not-needed` gate state, distinct from `skipped-no-panel`).

**The hurdles: paired tests, so a fold fraction becomes a significance
statement.** The round-23 gate compared a mean fold Sharpe and a win fraction with
a fixed threshold and no reference distribution. Round 25 replaces that with

- `pairedClusterTest` — the paired difference of pooled Sharpe between candidate
  and baseline, with the SE from the same fold-window clusters and a `t(C-1)`
  reference (Cameron & Miller 2015). This answers "is the improvement larger than
  its own sampling error?", and is the Sharpe-difference test of Ledoit & Wolf
  (2008).
- `pairedClusterSignTest` — the exact sign test over fold-window clusters (the
  sign test is the distribution-free test of Demšar 2006, *Statistical comparisons
  of classifiers over multiple data sets*), the error-controlled version of the
  `>= 0.5` win-fraction hurdle.

Each hurdle records one of four states — `applied`, `skipped-no-panel`,
`not-needed`, `off` — so a report can never claim a gate it did not run. On a
single-stream run there is no panel, so the dependence hurdles are skipped and the
round-23/24 decision path is recovered byte-for-byte (`--gate=classic` makes that
explicit).

**Why the DSR / family-wise count stays K, not "effective trials".** The
effective-number-of-tests idea tempts one to deflate by `effectiveTrials`
instead of `K = 15`. That is the wrong direction for a *family-wise error rate*:
FWER is a statement about the number of hypotheses tested, and the
effective-number-of-tests corrections do not control it (arXiv 1612.04535, "Is
the familywise error rate in genomics controlled by methods based on the effective
number of independent tests?"). Harvey, Liu & Zhu (2016), *...and the
cross-section of expected returns*, make the matching case for finance: when a
search has been run, count the searches. So `trials` stays `K`, and the
`familyCorrelation` block (per-fold excess-Sharpe correlation matrix,
`meanPairwiseExcessCorr`, `effectiveTrials`) is emitted as a **diagnostic only**
— it tells the reader that `sig:momentum ~ sig:acceleration = 0.863`, i.e. the
"three DSR-significant candidates" of attempt 3 are closer to one idea than three,
without changing any verdict.

**The verdict carries its cost sensitivity.** A promotion decision at zero cost is
not a decision. `costLadder` restates the whole gate at a set of bps-of-turnover
levels (`--cost-ladder=0,2,5,10`), rooted in the real taker fee schedule (Binance
spot taker 0.1%/side ⇒ 20 bps round-trip on 1.0 turnover; the ladder starts at the
0/2/5/10 bps a limit-order or maker-rebate execution would realise) and in the
trading-cost literature (Frazzini, Israel & Moskowitz 2018, *Trading costs*).
`breakEvenCostBps` is the per-unit-turnover cost at which the gross edge is
exactly consumed, so a high-turnover signal can be compared with a low-turnover
mechanism on the same axis. Attempt 3's ladder is the demonstration: at 0 bps
nothing promotes, at 2 bps `sig:acceleration` promotes with zero reasons, and at
5–10 bps `querymod` and `momentum` take over — the ranking is a function of the
cost, so a single-cost verdict would be an artefact of the cost choice.

**Measured facts (attempt 3, 8 streams / 288 folds / 4,320 pooled bars).**
Baseline Sharpe 0.4387, PSR 0.9643, DSR 0.5179, break-even 12.42 bps; i.i.d. SE
0.2416 / MDE95 ±0.4735 (`underpowered: false`), cross-stream `rhoBar` ≈ 0.452 ⇒
`deff` ≈ 2.1 ⇒ honest MDE95 ≈ ±0.98 (`underpowered: true`). All 14 candidates
keep-off under the DSR floor; SPA p = 0.5699, best = `sig:momentum`,
Rejects = [none]. This is the run that showed the i.i.d. power line was lying, and
it is why the pooled SE is now built from the panel.

## Candle data quality (structural audit vs. economic plausibility)

Indicators are only as honest as their inputs. Two complementary layers guard the
stream: `candles_audit.js` (structural invariants — OHLC consistency, monotone
timestamps, gaps, duplicates) and `candle_quality.js` (a *winsorizer* for wicks
that are structurally valid but economically impossible). The motivating defect
is real: LINKUSDT 1h `2020-03-12T10:00Z` records `low 0.0001` on a ~3.0 bar,
which passes every structural check yet poisons ATR/range features for the
following `period` bars. The repair collapses an implausible wick to the bar-body
extreme (never inventing a price level), is idempotent, preserves every OHLC
invariant, and leaves genuine extremes (the ADA/LINK 2025-10-10 crash) untouched
at the default 0.9 body-fraction threshold. It runs at read time behind
`CONFIG.candleWickRepair`, so the raw JSONL stays the exact venue record.
`candles.test.js` (95 checks) pins both layers; `candle_quality.js` is
registered `LOCKED-invariant`.
