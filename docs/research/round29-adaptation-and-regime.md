<!-- round29-note
id: adaptation
status: research (round 29 planning) — no code changed
grounds: [P5]
keeps: [P5]
kills: []
gates: []
conflicts: [C5, C8]
index: round29-README.md
last-verified: 2026-09-24
-->

# Round-29 research note — adaptation, regime, and the cadence nuisance

**Status: research note (round 29 planning). No code changed.** The round-28 runs
exposed an *evaluation-configuration nuisance* (`TODO.md` 84): the **same model, seed,
data and CRN** measured Sharpe **−0.1147 at `testSize 15`** and **+0.8978 at
`testSize 10`** (ΔSharpe **1.01244**, se 0.47504, p 0.02008; per-bar position
correlation **0.187**), and the paired Δ of the best candidate collapsed
**+0.2164 → +0.0289** with the same change. A *fixed* position series re-scored under
a different fold grid moves Sharpe only ~0.08 (baseline) to ~0.24 (`sig-momentum`) — an
order of magnitude below the 1.01 swing — so the effect is the **model's
trajectory under more frequent retraining**, not bookkeeping. This note asks: what
does the open-source literature say the *right* adaptation mechanism is when a
non-stationary process is retrained on a schedule, and how does a decision become
robust to that schedule?

## 1. Continuous test-time adaptation instead of schedule-bound retraining

- *Test-Time Adaptation for Non-stationary Time Series: From Synthetic Regime Shifts
  to Financial Markets*, arXiv **2602.00073** (2026-01-20). Small-footprint TTA:
  **the backbone is frozen and only normalization affine parameters are updated using
  recent unlabeled windows**. Explicitly targets causal time-series forecasting and
  direction classification, and moves from synthetic regime shifts to financial
  markets. This is the direct antidote to the cadence nuisance: adaptation is
  **continuous**, so there is no fold-boundary step for the verdict to depend on.
- *Accurate Parameter-Efficient Test-Time Adaptation for Time Series Forecasting*
  (**PETSA**), arXiv **2506.23424** (2025-06-29). Low-rank adapters + dynamic gating
  on the input/output, with a robust + frequency + patch-structural loss. The
  parameter-efficient, non-full-fine-tune TTA recipe.
- *Towards Principled Test-Time Adaptation for Time Series Forecasting*, arXiv
  **2605.17250** (2026-05-17). The theory/design-principles framing.
- *Battling the Non-stationarity in Time Series Forecasting via Test-time Adaptation*,
  arXiv **2501.04970** (2025-01-09).
- *DeePM: Regime-Robust Deep Learning for Systematic Macro Portfolio Management*,
  arXiv **2601.05975** (2026-01-09). Beyond plain TTA, it names the **"ragged
  filtration"** problem — data arrive asynchronously — and answers it with a
  **Directed Delay (Causal Sieve)** that prioritises causal impulse-response learning
  over information freshness, trained end-to-end to a robust risk-adjusted utility.
  NeuLegion's per-fold replay + fixed-window features is the *opposite* of an explicit
  causal-sieve design, and this is the sharper, finance-native version of the idea.
- *Adaptive Financial Transformer with Regime-Gated Attention for Stock Return
  Prediction*, arXiv **2606.29347** (2026-06-28). Regime-gated attention inside the
  forecaster.
- *Adaptive and Regime-Aware RL for Portfolio Optimization*, arXiv **2509.14385**
  (2025-09-17).

**→ what it changes for NeuLegion.** The cadence dependence is a *symptom of
retraining on a schedule*; the modern answer is continuous, small-footprint adaptation
(freeze the backbone, adapt normalisation/low-rank parameters on recent windows). This
becomes round-29 P3: an A/B of fold-replay vs continuous TTA on the same harness, with
the pre-registered test being *"does the measured level stop depending on `testSize`?"*
— the cadence nuisance becomes the acceptance criterion.

## 2. Regime detection / changepoints as an explicit online mechanism

- **Adams & MacKay**, *Bayesian Online Changepoint Detection*, arXiv **0710.3742**
  (2007-10-19). The canonical online Bayesian changepoint recursion — the right
  primitive for "has the process changed *now*", available without a refit.
- *Robust and Scalable Bayesian Online Changepoint Detection*, arXiv **2302.04759**
  (2023-05-12). A **provably robust**, conjugate-posterior, scalable generalised-Bayes
  BOCPD — the practical upgrade (robust to outliers, which financial ticks are).
- *Exploring the Predictability of Cryptocurrencies via Bayesian Hidden Markov Models*,
  arXiv **2011.03741** (2020-12-07). Crypto-specific: a **four-state non-homogeneous
  HMM** distinguishes bull/bear/calm regimes and beats a single-regime random walk in
  one-step-ahead forecast densities. Direct evidence that a *regime-switching* model
  is the right reference class for this data.
- *Expectile hidden Markov regression models for analyzing cryptocurrency returns*,
  arXiv **2301.09722** (2024-01-18) and the quantile/expectile copula HMM variant,
  arXiv **2307.06400** (2023-07-12). Heavier-tailed, dependence-aware regime models for
  crypto returns.
- *Regimes in the Order Flow*, arXiv **2609.07989** (2026-09-07) — regime structure in
  order flow (short-horizon microstructure).
- *Machine Learning and the Yield Curve: Tree-Based Macroeconomic Regime Switching*,
  arXiv **2408.12863** (2025-05-06) — the tree/regime-switching analogue elsewhere.

**→ what it changes for NeuLegion.** NeuLegion already ships an observer with
EWMA/CUSUM drift (`observer/*`), but the *scored model* has no explicit changepoint
state: it retrains on a fixed schedule and its measured level moves with that schedule.
A causal online changepoint/regime estimate is both (a) a candidate feature, and (b) a
principled trigger for *when* to adapt — replacing the fixed fold step with an
event-driven one. This is the mechanism that would make the `testSize` choice stop
being a free parameter.

## 3. No-regret / universal algorithms: a benchmark with a guarantee

- *Online Portfolio Selection: A Survey*, arXiv **1212.2129** (2013-05-19). The
  taxonomy (Follow-the-Winner / Follow-the-Loser / Pattern-Matching / Meta-Learning)
  and the relation to the capital-growth framework.
- *An Introduction To Regret Minimization In Algorithmic Trading: A Survey of
  Universal Portfolio Techniques*, arXiv **2105.13126** (2021-05-26). Universal
  portfolios guarantee performance relative to a baseline **with no statistical
  assumptions about future market data**.
- *Efficient and Near-Optimal Online Portfolio Selection*, arXiv **2209.13932**
  (2025-03-09); *Damped Online Newton Step for Portfolio Selection*, arXiv
  **2202.07574** (2022-02-15); *High order universal portfolios*, arXiv **2311.13564**
  (2025-08-16); *Noise-proofing Universal Portfolio Shrinkage*, arXiv **2511.10478**
  (2025-11-13); *Universal portfolios in stochastic portfolio theory*, arXiv
  **1510.02808** (2016-12-12); *Meta-Learning the Optimal Mixture of Strategies for
  Online Portfolio Selection*, arXiv **2505.03659** (2025-05-10).
- *Model-free Online Learning for the Kalman Filter: Forgetting Factor and Logarithmic
  Regret*, arXiv **2505.08982** (2025-05-13) — a forgetting-factor online state
  estimator with regret guarantees: the principled version of "forget old data".

**→ what it changes for NeuLegion.** These give a *baseline that cannot be beaten by
luck*: a no-regret / universal portfolio has a worst-case guarantee relative to
buy-and-hold, computed with no model. Round 29 should carry one such benchmark
cheaply, because if the adaptive learner **cannot beat a no-regret universal baseline
out-of-sample**, the whole model programme is spending compute to lose to a
parameter-free rule. It is the finance-native form of the model-class benchmark (P1).

## 4. Turnover has a closed form — the position policy is a decision, not a knob

- *Optimal Turnover, Liquidity, and Autocorrelation*, arXiv **2110.03810**
  (2022-01-20). In a Gaussian-process model, **steady-state turnover is computable
  explicitly and obeys a clear relation to asset liquidity and to the autocorrelation
  of the alpha forecast signals**. This is the missing theory behind the round-28
  turnover/dead-zone sweeps: the optimal turnover is a *function of the alpha's decay*,
  which is measurable from the journal (`confidencePersistence` already reports the
  confidence half-life).

**→ what it changes for NeuLegion.** The dead-zone/holding sweeps (P5, item 5) have
been empirical grids. `2110.03810` says the right object is the **steady-state turnover
implied by the measured alpha autocorrelation and liquidity** — i.e. the sweep should
be *aimed* by a closed-form target, and `breakEvenCostBps` compared to it. This
sharpens the existing cost work rather than adding a mechanism.

## 5. What this note rejects

| candidate | verdict | the reason |
| --- | --- | --- |
| "change `testSize` to buy the paired hurdle" as a *fix* | **reject** | the level moves with the grid (Δ 1.01, p 0.02); the paired Δ collapsed → it is a nuisance, not alpha |
| periodic full retraining as the adaptation mechanism | **reject as optimal** | `2602.00073`/`2601.05975`: continuous, small-footprint adaptation dominates, and removes the cadence step |
| a bigger/more-evolved hivemind | **reject** | `2512.15732` (see `round29-model-class.md` §3) |
| treating the dead zone as a tuning knob | **deprioritise** | `2110.03810` gives the closed-form target; the residual issue is exposition (#61/exposure matching) |

## Open questions / leads (deferred, not scheduled)

- Does a continuous-TTA arm's measured level stop depending on `testSize`? (round-29
  P3 acceptance)
- Can an online changepoint trigger replace the fixed fold step and recover the
  testSize-15 level at testSize-10 cost? (P3 follow-on)
- Does a universal-portfolio baseline beat the controller out-of-sample? (P1 benchmark)
- Is the measured confidence half-life consistent with `2110.03810`'s implied optimal
  turnover? (cost work)
