<!-- round29-note
id: evaluation-robustness
status: research (round 29 planning) — no code changed
grounds: [P2]
keeps: [P2]
kills: []
gates: []
conflicts: [C6, C7, C8, C9, C10]
measured: [MC1, MC2]
index: round29-README.md
last-verified: 2026-09-24
-->

# Round-29 research note — evaluation robustness: making a verdict configuration-independent

**Status: research note (round 29 planning). No code changed.** NeuLegion's
evaluation machinery is its strongest asset: a walk-forward harness with a
no-lookahead audit, a promotion gate with size and power, dependence-aware inference
(cluster jackknife, paired tests, design effect), a cost ladder, SPA/Romano–Wolf
family-wise search, PBO/CSCV, and proper forecast scores with DM/MCS. Round 28 showed
that this machinery **correctly rejects everything** — and then exposed a defect in the
*machinery's own configuration dependence* (`TODO.md` 84): the same model at the same
seed moves from Sharpe −0.1147 to +0.8978 when `testSize` goes 15 → 10, and the paired
Δ of the best candidate goes +0.2164 → +0.0289. This note records what the external
literature says about that class of problem and what a *configuration-robust* decision
looks like.

## 1. The statistic itself is a function of the sampling frequency

- **Lo**, *The Statistics of Sharpe Ratios*, Financial Analysts Journal 58(4):36–52,
  2002 (non-arXiv; cited in the project as the source of `sharpeStandardError` and
  `minimumDetectableSharpe`). Shows the Sharpe estimator's distribution depends on the
  **return measurement interval** under autocorrelation, and that annualising a
  sub-period Sharpe ignores the serial dependence. NeuLegion's cadence change is
  exactly a return-interval change *for the fold statistics*: 15-bar vs 10-bar test
  windows with more frequent retraining.
- *Connecting Sharpe ratio and Student t-statistic, and beyond*, arXiv **1808.04233**
  (2019-05-14). Gives the **exact** Sharpe distribution for i.i.d. normal returns
  (extending Lo 2002 / Mertens), and reviews the assumptions under which the
  asymptotic forms hold.
- *Asymptotic distribution of the Markowitz portfolio*, arXiv **1312.0557**
  (2020-03-06). The multivariate generalisation — relevant when the statistic is a
  portfolio Sharpe, not a single return series.

**→ what it changes for NeuLegion.** The cadence effect is not bookkeeping noise to be
argued away; it is a known property of Sharpe-type statistics under a changed sampling
interval and serial dependence. The remedy is procedural: **every cross-run level
statement must name its cadence**, and the gate must be defined so the *decision* does
not move with it (P4). This is the formal grounding for `TODO.md` 84(a)/(b).

## 2. Selection over *researcher degrees of freedom* is a first-class bias

- *Publication Bias in Asset Pricing Research*, arXiv **2209.13623** (2023-09-21).
  "Researchers are more likely to share notable findings. As a result, published
  findings tend to overstate the magnitude of real-world phenomena." Meta-studies of
  cross-sectional predictability have "settled" on a systematic overstatement —
  the field-level analogue of the DSR. (The project already cites Gelman & Loken's
  *Garden of Forking Paths* for the same idea.)
- *The Corporate Bond Factor Replication Crisis*, arXiv **2604.07880** (2026-04-09).
  A 2026 replication failure of published factors — the current state of the
  replication conversation.
- *Multi-Factor Inception: What to Do with All of These Features?*, arXiv **2307.13832**
  (2023-07-25). The "factor zoo" problem: how to *use* many candidate features once
  the search is priced in.
- *Avoiding Backtesting Overfitting by Covariance-Penalties*, arXiv **1905.05023**
  (2019-05-01). A covariance-aware penalty for the number of trials.

**→ what it changes for NeuLegion.** The correct response to configuration dependence
is *not* to pick the configuration that promotes (that is a researcher degree of
freedom). It is to (a) count the configurations in the search, and (b) require a
candidate to survive across them. This is why P4 exists and why the `K` must include
the cadence grid if the cadence is searched.

## 3. The configuration-robust protocol already exists in the 2026 literature

- *AlgoXpert Alpha Research Framework: A Rigorous IS/WFA/OOS Protocol for Mitigating
  Overfitting in Quantitative Strategies*, arXiv **2603.09219** (2026-03-10), already
  cited by the project. Its design is *precisely* the robustness rule this round needs:
  in-sample stage favours **stable parameter regions instead of single optima**; WFA
  uses **rolling windows and purge gaps** with **majority-pass and catastrophic-veto
  rules**; OOS holds parameters locked. "Defense in depth" (cliff veto, execution
  controls, …).
- *Interpretable Hypothesis-Driven Trading: A Rigorous Walk-Forward Validation
  Framework for Market Microstructure Signals*, arXiv **2512.12924** (2025-12-15).
  A hypothesis-first walk-forward protocol for microstructure signals.
- *The GT-Score: A Robust Objective Function for Reducing Overfitting in Data-Driven
  Trading Strategies*, arXiv **2602.00080** (2026-01-22), already cited. Composes
  performance + significance + consistency + downside risk into one objective, and is
  the project's existing "promotion objective beyond pooled Sharpe" reference.
- *A Novel Approach to Trading Strategy Parameter Optimization Using Double
  Out-of-Sample Data and Walk-Forward Techniques*, arXiv **2602.10785** (already cited)
  — **walk-forward window-length sensitivity** is the named problem.

**→ what it changes for NeuLegion.** The project has the *ingredients* (`costLadder`
already restates the gate at several costs; `clusterStability` is a leave-one-window-out
robustness test) but not the **configuration** dimension. `2603.09219` supplies the
exact template: treat `testSize`/cadence as a **parameter region**, and promote on a
**majority-pass + catastrophic-veto** rule across it. That is round-29 P4, and it is a
`DESIGN.md` §6 decision-procedure change with a `METHOD.md` rationale, not a new
mechanism.

## 4. Cross-family statements must be exposure-matched (the confidence-scale defect)

The round-28 runs also found (`BUGS.md` #61, `TODO.md` 85) that the shared confidence
space is **dimensionally shared but not distributionally comparable**: the controller's
`|confidence|` never exceeds **0.2555** (fraction > 0.2: **0.93 %**) while a signal's
saturates at **1.0** (fraction > 0.2: **83.08 %**). With the shipped `deadZone 0.05`
the baseline is in the market on **0.508** of bars and `sig-momentum` on **0.892**; the
P5 sweep's promoting row compared an ~80 %-invested book with one holding a position on
**16 of 4 320 bars** (`nonZeroFraction 0.0037`, `tradeCount 2`). The relevant external
anchors are the project's already-cited **proper-scoring** requirement (Gneiting &
Raftery 2007: a score must be proper so a model cannot earn its way up by hedging) and
the **exposure/benchmark** discipline of the cost literature (Frazzini, Israel &
Moskowitz 2018, already cited). The new 2026 anchor is *What Survives Honest
Evaluation?* (arXiv 2608.27734, already cited): a leaky oracle survives DSR/PBO, so
structural exposure controls are not optional.

**→ what it changes for NeuLegion.** Cross-family comparisons (a controller vs a
signal) are only meaningful at **matched exposure**, and the gate's dead zone must be
applied in a family-consistent space (e.g. per-family empirical quantiles of
`|confidence|`, or matched nonzero fraction). This is `TODO.md` 85 and a
`DESIGN.md` §6 decision-procedure change, and it must land *before* any cross-family
claim (including any new reversal-signal-vs-controller comparison in P2).

## 5. What this note rejects

| candidate | verdict | the reason |
| --- | --- | --- |
| reporting the best-cadence verdict | **reject** | `2209.13623`: picking the configuration that wins is the bias, not a fix |
| treating `testSize` as a free knob | **reject** | `2110.03810`/Lo 2002: the statistic depends on the interval; it is a searched parameter |
| a cross-family Sharpe comparison at the shipped dead zone | **reject until exposure-matched** | #61: 0.51 vs 0.89 vs 0.0037 nonzero fraction |
| relaxing the DSR floor / `K` to get a promotion | **reject** | the floor is what makes the gate's size ~3.5 %; `1612.04535`/`1911...` already settle `K = trials` |

## 6. Measured this round: the adjusted-DSR hurdle is a **surface**, not a Sharpe band (MC1)

`PLAN-round29.md` §1.5 asserts that "the dependence-adjusted DSR floor (≈0.95) is crossed
at a Sharpe of **≈1.02–1.08** on this design, while the best labeller is at **0.10**". The
three retained round-28 reports **contradict both halves**, and the correction matters
because it changes what the plan must ask for. Read straight from
`report.json` (`pooledMetrics`, `dependence`, `familywise.K`); **all three runs have
`bars = 4320`**:

| run (config) | arm | K | net Sharpe | design effect | effBars | `dsr` (n=4320) | `dsrAdjusted` | promote |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Step 1 (`testSize 15`) | baseline | 3 | −0.1147 | 4.866 | 888 | 0.0922 | 0.1428 | (base) |
| Step 1 | `sample-weights` | 3 | +0.0521 | 5.595 | 772 | 0.2618 | 0.2229 | false |
| Step 2 (`testSize 10`) | baseline | 2 | **+0.8978** | 2.611 | 1654 | 0.9991 | **0.9584** | (base) |
| Step 2 | `label-conservative` | 2 | +0.9267 | 2.663 | 1622 | 0.9994 | **0.9637** | false |
| Step 3 (`testSize 15`) | `sig-momentum` | 12 | **+1.0848** | 3.624 | 1192 | 0.9989 | **0.7736** | false |
| Step 3 | `sig-accel` | 12 | **+1.0194** | 2.465 | 1753 | 0.9966 | **0.8608** | false |

1. **The "Sharpe band" is wrong.** Both arms inside the stated 1.02–1.08 band **fail**
   (`sig-accel` 1.0194 → 0.8608; `sig-momentum` 1.0848 → 0.7736), while the Step-2
   **baseline passes at Sharpe 0.8978** (K=2, design effect 2.611 → 0.9584). The hurdle is
   a surface in `(Sharpe, designEffect, moment shape, K)` — exactly the Lo-2002 /
   selection-bias structure §1–§3 of this note describes.
2. **"The best labeller is at 0.10" is unsupported.** The retained Step-2 labeller's
   `dsrAdjusted` is **0.9637** (it *clears* the floor). Its three failing hurdles are the
   fold-mean Sharpe hurdle (`BUGS.md` #60), the **paired** cluster difference
   (Δ 0.0289, p 0.3987) and cluster stability — i.e. it fails on *aggregation and
   significance*, not on the floor. (This is also the pooled-vs-fold-mean disagreement
   recorded as MC2: pooled 0.9267 > baseline 0.8978, mean fold 0.5146 < baseline 0.7005.)
3. **The binding term is the design effect, not `K` and not effect size.** The two
   highest-Sharpe candidates clear the *unadjusted* DSR (0.9966 / 0.9989 ≥ 0.95) and pass
   the paired-difference and cluster-stability hurdles; each fails on **exactly one**
   reason, the dependence-adjusted DSR. With independent bars they would pass.
4. **Actionable bracket for P4.** The lever is a less-correlated return series. Anchors:
   at `effBars = 4320` (design effect 1) `sig-accel`'s adjusted DSR would equal its
   unadjusted **0.9966** (a pass); at 1753 (design effect 2.465) it is **0.8608** (a
   fail). So the required design effect for a Sharpe-≈1.0 arm lies in **(1.0, 2.5)** — far
   below the current 2.5–5.6, i.e. the effective stream count must rise well above
   ≈2.3/8. (No single interpolated `effBars` is quoted: the deflation hurdle is itself
   `n`-dependent — `performance.js#deflatedSharpeRatio` defaults `trialsVariance` to
   `(1+SR²/2)/(n−1)` — so a two-point bracket is used deliberately.)

**→ what it changes for NeuLegion.** `PLAN-round29.md` §1.5 is corrected by this section
(conflict **C9**, `RESOLVED`). The plan's *diagnosis* is sharpened rather than weakened:
the bot's best arms carry an effect that is cluster-**stable** and effect-size-positive,
and the **dependence adjustment is precisely the statistic that rejects it** because
~79 % of the covariance is one factor (B3). "No demonstrated residual edge" therefore
means "**no independent effect**", and the design target is a measured design-effect
reduction, not a bigger Sharpe.

## Open questions / leads (deferred, not scheduled)

- Do any of the three retained round-28 runs' candidates survive a **majority-pass
  across a cadence grid**? (P4 retrospective; `sig-accel` is the expected casualty)
- Which exposure-matching rule (per-family quantiles vs matched nonzero fraction)
  leaves the controller/signal comparison intact without manufacturing a tie? (item 85)
- Is the measured confidence half-life consistent with the implied optimal turnover
  from `2110.03810`? (links to the cost work)
