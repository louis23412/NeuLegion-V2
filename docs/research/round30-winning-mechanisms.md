<!-- round30-winning-mechanisms
round: 30 (planning)
kind: research pull — "what proved working"
scope: grounds the directions the acceptance batch CONFIRMED (momentum trunk, carry sleeve, decorrelation), not the search for a new edge
raw: raw/arxiv-sweep-2026-09q.json
queries: abs:"time-series momentum", abs:"cross-sectional momentum", abs:"trend following", abs:"funding rate", abs:"perpetual futures", abs:"carry" AND abs:"cryptocurrency", abs:"momentum" AND abs:"Bitcoin", abs:"regime" AND abs:"momentum" AND abs:"strategy", abs:"ensemble" AND abs:"trading" AND abs:"signals", abs:"volatility targeting", abs:"volatility scaling", abs:"diversification ratio" OR abs:"portfolio breadth", abs:"transaction costs" AND abs:"portfolio", abs:"market-neutral", abs:"backtest overfitting", abs:"momentum crashes"
method: arXiv API, sortBy=relevance, single-field phrases, ~8 hits/query, curated to the 60 papers below
plan: ../PLAN-round30.md
companion: round29-README.md (the *where-is-an-edge* round), round29-crypto-edges.md, round29-evaluation-robustness.md
last-verified: 2026-09-25
-->

# Round 30 — the "what proved working" research pull

**Purpose.** Round 29 asked *where is an edge*. This note asks the complementary question the
acceptance batch (`RUN-ANALYSIS.md` §17) now answers from the project's own data: **the momentum
family is the edge, carry is the independence lever, and the binding wall is dependence-adjusted
power.** So this pull is deliberately *narrow*: it collects what the literature says about the
things the batch showed to be real, and about the honesty machinery around them. It is not a
fishing trip for a new mechanism — `PLAN-round30.md` §8 forbids those.

**How to read the tables.** `id` is the arXiv id (openable at `arxiv.org/abs/<id>`). `grade` is
**A** = peer-reviewed / long-standing replicated result, **B** = widely-cited preprint with crypto
out-of-sample evidence, **C** = single preprint, treat as a hypothesis. The `what it means for
NeuLegion` column is the only part that is judgement; the paper summaries are paraphrases of the
abstracts in `raw/arxiv-sweep-2026-09q.json`.

**The one-line conclusion.** Every branch the project *kept* (`NL-SIG-momentum`, `NL-SIG-accel`,
the `NL-DATA-funding` sleeve) has a strong published analogue; every branch it *dropped*
(`NL-SIG-frac-momentum`, `NL-SIG-vol-regime`, `NL-SIG-autocorr`, `NL-SIG-volume`) is either
unpublished as a standalone edge or is documented as conditional/regime-dependent — which is
exactly what the A/B runs measured. The research pull therefore **corroborates the purge** rather
than opening new fronts.

---

## 1. The momentum / trend trunk (NL-SIG) — the family that survived

The single most replicated result in the literature, and the family the batch found significant.
The trunk is `momentum`; `accel` is its derivative branch; the published *upgrades* below are the
candidates for `NL-SIG-*@r30` (`PLAN-round30.md` §3.3, gate **G-H**).

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **1404.3274** | *Two centuries of trend following* | A | Anomalous trend-following excess returns across commodities/FX/indices/bonds over ~200y — the effect is not a sample artefact. | The prior that `sig-momentum` is real, not fitted. Its long history is why a *pure signal* (no model) can carry the edge and why `NL-MECH` cannot. |
| **2009.12155** | *A Decade of Evidence of Trend Following Investing in Cryptocurrencies* | B | Decade of BTC-era evidence; crypto markets share the structural features of 20th-c. commodities that made them trend-friendly. | The **closest published analogue** to `sig-momentum` on this basket. Grounds treating crypto TSMOM as an established effect, not a lucky run. |
| **1402.3030** | *Information ratio analysis of momentum strategies* | A | Closed-form IR of a momentum strategy; useful for sizing the expected IR from horizon/vol. | A diagnostic to compare the measured `sig-momentum` IR (Sharpe 1.08) against the theoretical band — a sanity envelope, not a new signal. |
| **1904.00890** | *Momentum and liquidity in cryptocurrencies* | B | Strong momentum in the **most liquid** crypto subset; momentum-liquidity bivariate sorts. | Directly relevant: the 8-symbol basket is the liquid subset. Predicts the effect should be *stronger* here — consistent with +1.08. |
| **2105.13727** | *Slow Momentum with Fast Reversion* (changepoint detection) | B | Blends a slow momentum model with a fast mean-reversion model **gated on detected changepoints**. | The canonical **regime-gate** design (`C-REGIME`): detect the regime, switch/fade momentum across it. A pre-registered `NL-SIG-*@r30` candidate. |
| **2604.09060** | *Taming the Black Swan: Momentum-Gated Hierarchical Optimisation* | C | Gates momentum on crash risk to avoid the "winner's curse" of clustered-vol drawdowns. | The **crash-gate** counterpart to `2105.13727`. Note the `NL-SIG-vol-regime` *drop*: a naive regime filter failed here — the lesson is the gate must be *causal and pre-registered*, not a vol bucket. |
| **2308.11294** | *Network Momentum across Asset Classes* | B | Momentum **spillover** across economically linked assets — a lead-lag graph, distinct from own-asset TSMOM. | The candidate that adds *cross-sectional* content (the one axis where the current arms are ~100 % market). Needs a lead-lag graph over the basket → `C-SIGUP`. |
| **2302.10175** | *Spatio-Temporal Momentum* | C | Unifies time-series and cross-sectional momentum by trading on cross-sectional features over time. | A design template for a single arm that carries both TSMOM and XSMOM content — a decorrelation source for `C-BREADTH`. |
| **2112.08534** | *Trading with the Momentum Transformer* | B | An interpretable attention architecture over multi-scale momentum; attention recovers the momentum timescales. | Evidence the **multi-horizon** structure matters. But `NL-BENCH` (G-A) already said architecture is not the constraint here — read this as *"use multiple horizons in the feature"*, not *"build a transformer"*. |
| **2406.08742** | *DeepUnifiedMom* (multi-task, mixture-of-experts) | C | Learns multiple momentum horizons jointly with a gate. | Same multi-horizon lesson; heavier machinery (anti-re-tread: don't adopt the machinery). |
| **2607.00475** | *End-to-End Parametric Portfolio Policies: When Do AI Models Beat Simple Rules?* | C | Directly asks when AI beats simple timing rules on cross-asset futures. | The project's own result (G-A, `bench-linear` MCS win at zero skill) is an instance of "simple rules are hard to beat on this vector". Cite as external corroboration of the negative branch. |
| **1904.04912** | *Enhancing TSMOM with Deep Neural Networks* | B | DNN on the same TSMOM features improves it *when combined with volatility scaling*. | Ties §1 to §5: the published TSMOM upgrade is **vol-scaling first**. |
| **2012.07149** | *Building Cross-Sectional Systematic Strategies By Learning to Rank* | B | XSMOM as a learning-to-rank problem often beats regression. | A construction idea for a cross-sectional sleeve (`C-BREADTH`); not a sign change. |
| **2106.08420** | *Trend-Following Strategies via Dynamic Momentum Learning* | C | Momentum parameters adapt through time. | Confirms the "dynamic/regime" direction — but any *adaptive* parameter is a new `@rNN` version and needs the golden discipline (`LINEAGE.md` §8). |
| **1702.07374**, **1707.05552** | TSMOM/CSM in Chinese equities (contrarian *and* momentum) | B | Both momentum and contrarian effects appear, horizon- and market-dependent. | The documented reason `NL-SIG-autocorr`'s regime flip is *expected*: sign is not horizon-robust. Supports the drop. |

**Read.** The trunk is right, the published upgrades are *vol-scaling, multi-horizon, network
(cross-sectional), and a causal regime gate* — and every one of those is a **feature change inside
`NL-SIG`**, not a controller mechanism. This is the entire justification for closing `NL-MECH`
(`PLAN-round30.md` §8) and for the `C-SIGUP`/`C-REGIME` modules.

---

## 2. Carry / funding / basis (NL-DATA) — the measured independence lever

The batch's one real breadth purchase: `NL-DATA-funding` correlates **+0.003** with the price
basket (equicorrelation design effect 0.769 → 0.604). The literature says *why* a funding sleeve is
mechanically different from price momentum.

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **2212.06888** | *Fundamentals of Perpetual Futures* | B | The definitive treatment of funding: the perp–spot gap is pinned by the funding cash-flow; funding is a *carry* yield, mechanically distinct from price. | The theoretical basis for the +0.003 correlation: funding is a different state variable, so it can be an independent stream at 8h. |
| **2209.03307** | *A primer on perpetuals* | B | Continuous-time no-arbitrage model of perps; funding = the price of leverage. | The sign convention for `carryOnBarGrid`/`carry` (per `BUGS.md` #66) traces to this model. |
| **2506.08573** | *Designing funding rates for perpetual futures* | B | Funding-rate mechanics and perp–value alignment; issuer design. | The mechanism can *decouple* from spot on the margin — so carry is informative precisely when price momentum is not (the independence claim). |
| **1912.03270** | *BitMEX Funding Correlation with Bitcoin* | B | Funding is **heteroskedastic** and causally related to the BTC rate. | Both the independence (different variance process) and the reason a *raw* carry stream needs vol-normalising before it is a stream. |
| **2601.06084** | *Who sets the range? Funding mechanics and 4h context* | C | Funding + the 4h timeframe define an equilibrium range. | Supports the **funding at 8h, mapped onto a 4h/1h grid** design used by `carryOnBarGrid`. |
| **2405.15461** | *Optimal market-neutral currency trading on the cryptocurrency platform* | C | A market-neutral basket anchored to crypto; selective pair formation. | A template for using carry **market-neutrally** — i.e. as a hedged stream, which is what buys the low correlation. |
| **2310.11771**, **2501.09404**, **2602.15182**, **2512.01112**, **2502.06028** | Perp pricing / ABM / autodeleveraging / demand-lending | C | The surrounding literature (liquidation, ADL, lending). | Not signal-bearing, but the reason to treat perp funding as a **risk-managed** stream: tail/liquidation events contaminate unhedged carry. |

**Read.** Carry is a genuine independent stream *because* it is a different state variable, but it
must be vol-normalised and ideally market-neutral (`2405.15461`). Gate **G-J** measures the
increment; nothing here changes the pre-registered acceptance bar (`adjDSR ≥ 0.95` at the
pre-registered `K`).

---

## 3. Decorrelation / breadth — the binding constraint

This is the section the *project's own arithmetic* makes load-bearing: design effect 3.62–4.87,
effective streams 1.73 of 8. The literature on *how to measure and buy* diversification is the
direct input to `C-BREADTH`.

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **2303.01657** | *An Optimization Study of Diversification Return Portfolios* | B | Diversification *return* (Booth–Fama) can be **optimised**, not just measured. | The formal target for `C-BREADTH`: maximise the rebalancing/diversification return of the sleeve, which is the return counterpart of the design-effect reduction. |
| **2506.20385** | *Empirical estimator of diversification quotient* | C | A practical estimator of the Diversification Quotient. | A second reporting metric next to `designEffect`/`effectiveStreams` — cheap to add to the report. |
| **2411.06080** | *The lexical ratio: new perspective on portfolio diversification* | C | Diversification via **non-numerical** asset relationships, not only correlations. | The motivation for wanting *different-venue / different-asset-class* streams (the "broader basket" lever) rather than more correlated crypto bars. |
| **1904.04912**, **2308.11294** | (see §1) | B | Both pair the edge with a **volatility-scaling** overlay. | Vol-scaling is not only an edge upgrade (§5) — it also equalises stream risk, which *is* a design-effect intervention. |
| **2004.12400** | *A dynamic conditional approach to portfolio weights forecasting* | B | DCC-style dynamic weights for combination. | A method for `C-BREADTH` when stream correlations are time-varying (they are: `meanPairwiseStreamCorr` 0.52 is an average). |

**Read.** The literature agrees with the batch: the lever is **portfolio construction over weakly
correlated sleeves**, and the honest metric is a dependence-aware one (`designEffect` /
effective streams / DQ), not a raw correlation. No paper claims more correlated crypto bars help —
which is why `PLAN-round30.md` §8 forbids buying them.

---

## 4. Cost & turnover honesty

`sig-momentum` trades **810/bar**; the reversal family's break-even (0.34 bps) died against a 5–10
bps taker cost. Cost modelling is therefore *load-bearing for every future verdict*, not a
footnote (`C-COST`, `TODO.md` 94).

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **1904.08925** | *Impact of proportional transaction costs on systematically generated portfolios* | A | Proportional costs materially change which systematic portfolios survive. | The generic justification for the break-even framing already in the report. |
| **2412.11575** | *Cost-aware Portfolios in a Large Universe* | B | Integrates costs **inside** the optimisation, not as post-hoc drag. | The design target for `C-COST`: cost-aware position policy, not a cost *tax* applied after. |
| **2312.05169** | *Onflow: online allocation robust to transaction fees* | B | Model-free online allocation with fees; softmax over weights. | A concrete cheap algorithm shape for `C-COST` (online, fee-aware). |
| **1709.06296** | *Large-Scale Portfolio Allocation Under Transaction Costs and Model Uncertainty* | A | Joint cost + model-uncertainty allocation. | Ties cost to the estimation-error problem — the honest reason not to over-fit a cost schedule. |
| **2001.01612**, **2305.16152** | Quadratic costs / Wiener-chaos dynamic allocation | B | Closed forms for cost-aware dynamic weights. | Reference math if `C-COST` moves beyond a proportional model. |

**Read.** Any future promotion has to survive a **maker/taker-aware** cost curve. This is the
pre-registered reason the reversal family is **PARK** (not DROPPED): only a maker model changes its
maths.

---

## 5. Volatility targeting / scaling

Both published TSMOM references (`1904.04912`, `2308.11294`) pair momentum with inverse-vol
scaling. In this project vol-scaling is simultaneously (a) an **edge** upgrade and (b) a
**design-effect** intervention (equalising stream risk). Two birds, one pre-registered candidate.

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **2603.01298** | *Single-Asset Adaptive Leveraged Volatility Control* | C | Open-loop inverse-variance vol targeting is sub-optimal; adaptive control fixes the target directly. | The warning that the naive "divide by realised vol" is not the end state — pre-register the *simple* version first (`NL-SIG-*@r30`) and only then consider adaptive control. |
| **2511.08571** | *Forecast-to-Fill: Benchmark-Neutral Alpha and Capacity* | B | Simple interpretable **trend + momentum** state variables give durable OOS alpha on a highly liquid asset, walk-forward. | Strong support for "simple, interpretable, walk-forward" over machinery — and the **capacity** framing (bps) matches the project's break-even metric. |
| **2503.16878** | CLT / limiting distribution of a vol-target index | C | Theory for vol-targeted index distributions. | Useful for sizing the *distributional* effect of a vol-target overlay on the gate's PSR. |
| **2204.02757** | Risk-budget portfolios with convex NMF | C | Risk-budgeting combined with dimensionality reduction. | An alternative combination scheme for `C-BREADTH`. |

**Read.** Vol-scaling is the first `NL-SIG@r30` candidate: cheap, published, doubles as a
decorrelation lever, and testable at matched exposure (`G-H`).

---

## 6. Market-neutral construction

The batch's problem is that all arms are ~one factor. The market-neutral literature is about
*removing* that factor, which mechanically raises the design-effect-adjusted value.

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **1608.08268** | *On the Market-Neutrality of Optimal Pairs-Trading Strategies* | A | Conditions under which pairs trading is genuinely market-neutral. | The formal check that a "neutral" sleeve actually removes the factor — a test to add if `C-BREADTH` claims neutrality. |
| **2607.18001** | *AlphaZeroBeta: DRL for Market-Neutral Portfolios* | C | DRL beats factor/convex methods across regime shifts. | Directional support; heavy machinery (anti-re-tread) — take the *neutrality constraint*, not the DRL. |
| **2412.12350** | *A multi-factor market-neutral strategy for NYSE equities* | B | Concrete multi-factor neutral construction. | A construction recipe if the basket is widened beyond crypto. |
| **1911.00919** | *The Reactive Beta Model* | B | Time-varying hedge ratio for neutral books. | The hedging method for a carry sleeve (`2405.15461`) that wants to be neutral. |
| **2412.12555** | *Parameters Optimization of Pair Trading* | C | Pair-selection/parameter sensitivity. | The overfitting warning for any pair-based sleeve — pre-register it. |

**Read.** Neutrality is the *mechanism* by which a return stream buys independence. If `C-BREADTH`
builds a market-neutral sleeve, `1608.08268`'s conditions are the acceptance test for the word
"neutral".

---

## 7. Evaluation robustness & determinism (NL-EVAL)

The project's gate is its most valuable asset. The literature's backtest-overfitting work is the
independent check on it.

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **2605.23955** | *From Accuracy to Auditability: A Survey of Determinism in Financial AI* | C | Reproducibility/auditability is a first-class failure mode in financial ML. | External grounding for the project's own determinism findings (`BUGS.md` #68 closed; 3d ≡ 3e byte-identical). Cite in the `METHOD.md` audit section. |
| **2209.05559** | *DRL for Cryptocurrency Trading: Addressing Backtest Overfitting* | B | Crypto backtests systematically over-report; needs explicit overfit control. | Grounds the **DSR/SPA floor** as non-negotiable and the §3.1 honesty rule (no post-hoc `K`). |
| **1408.1159** | *Determining Optimal Trading Rules without Backtesting* | B | An alternative to pure backtest search. | An escape hatch if the *search* itself is later judged the problem — but not needed while the gate holds. |
| **1905.05023** | *Avoiding Backtesting Overfitting by Covariance-Penalties* | B | Covariance penalties shrink the overfit. | A possible refinement of the deflation; only if a future review finds the current deflation mis-sized. |
| **2008.09481** | *Learning low-frequency temporal patterns for quant trading* | C | Low-frequency structure is where stable signal lives. | Supports the multi-horizon / slow-momentum direction (§1). |
| **2607.12455** | *EVOQUANT: Self-Evolving Verifier-Guided Strategy Optimization* | C | Verifier-guided search reduces overfit. | Watch-list for `NL-LEGION` (currently UNTESTED); do **not** schedule (`PLAN-round30.md` §8). |

**Read.** Determinism and dependence-adjustment are the two things the project already does *better*
than most published work. The research pull finds no reason to weaken the gate; if anything it
argues to document it more (§5 of the plan, the `dsrAdjusted` finding).

---

## 8. Ensemble / model-class (NL-MECH, NL-BENCH) — why the negative branch stands

Carried over from `round29-ensemble-size.md` / `round29-model-class.md` (not re-fetched): the
ensemble-size literature's central result is **decorrelation is not complementarity**, and the
benchmark result (G-A) says features/labels, not architecture, are the constraint.

| id | paper | grade | finding | what it means for NeuLegion |
| --- | --- | --- | --- | --- |
| **2608.16190** | *Decorrelation Is Not Complementarity: Skill, Not Lineage, Governs Trusted-Monitor Ensembles* | C | More-diverse members do not help unless they are *individually skilful*. | The external reason `NL-MECH` is closed: adding mechanisms/ensemble diversity without skill does nothing. Mirrors the batch (mechanisms ≈ baseline). |
| **2607.08493** | Learns ensemble composition **and size** | C | Size/composition should be learned, not fixed. | Supports leaving `es` as a gated probe (`P7`), never a default bump. |
| **2609.01397** | Ensemble margin / prediction variability | C | A way to *measure* multiplicity. | A candidate metric to explain why `effectiveStreams` is 1.73 (the streams are not "multiplicity"). |
| **2607.28248**, **1612.01474** | Deep-ensemble UQ and diminishes-in-M | B | Diminishing returns in ensemble size; calibrated UQ. | Same: size is not the lever here. |
| **1802.03708** / **2108.11921** | Time-varying networks for cryptocurrencies | B | Crypto co-movement is a *network*, time-varying. | The data-side counterpart of `2308.11294`: crypto's one factor is a network, so market-neutrality/network momentum is the way to add content. |

**Read.** `NL-BENCH-mlp`'s dismissal and `NL-MECH`'s closure are both corroborated. The only
"model-class" statement that survives is the negative one: *on this feature vector, a simple rule
beats learned models* — cited via `2607.00475`.

---

## 9. The project's own winners (the evidence this note is anchored to)

From `RUN-ANALYSIS.md` §17 (8×600 acceptance batch), the facts the research must be consistent
with:

| arm | net Sharpe | break-even | adjDSR | only failing hurdle | published analogue |
| --- | ---: | ---: | ---: | --- | --- |
| `baseline` (`NL-CTRL-hivemind`) | −0.1147 | −2.58 bps | 0.03 | — | — (the model has no skill; corroborated by G-A) |
| `sig-momentum` (`NL-SIG-momentum@r23`) | **+1.0848** | **14.64 bps** | 0.7736 | DSR-adj | `2009.12155`, `1904.00890`, `1404.3274` |
| `sig-accel` (`NL-SIG-accel@r27`) | **+1.0194** | **11.57 bps** | 0.8608 | DSR-adj | `2112.08534`, `2406.08742` (multi-horizon) |
| `sig-range` / `sig-agreement` (PARK) | +0.449 / +0.391 | 5.57 / 3.71 bps | 0.26 / 0.21 | DSR-adj | `2012.07149` (rank/XS) |
| funding sleeve (NL-DATA) | — | — | corr +0.003 | design effect only | `2212.06888`, `2506.08573` |

The gate is **`minDsrAdjusted ≥ 0.95`** at the pre-registered `K`; nothing else is binding.

---

## 10. What this changes for round 30

1. **It corroborates the purge, it does not reopen it.** Every surviving branch has a strong
   published analogue; every dropped branch is either unpublished as a standalone edge or
   documented regime-dependent (§1, §8). `DROPPED.md` stands.
2. **It fixes the upgrade list for `G-H`** (pre-registered, in this order): **vol-scaled
   momentum** (`1904.04912`, `2308.11294`), **multi-horizon blended momentum**
   (`2112.08534`), **network/cross-sectional momentum** (`2308.11294`, `2302.10175`), **a causal
   regime/crash gate** (`2105.13727`, `2604.09060`).
3. **It confirms the two levers in `PLAN-round30.md` §3**: a smaller pre-registered `K` (the
   DSR/search-bias literature, §7) and more *independent* streams (§3 breadth, §2 carry) —
   **not** more correlated bars (§3, §8).
4. **It makes cost-awareness a prerequisite** for any `G-H` arm (`sig-momentum` already trades
   810/bar; §4).
5. **It supplies two cheap report metrics** to add with `C-BREADTH`: a Diversification Quotient
   estimator (`2506.20385`) and a dynamic-correlation weight scheme (`2004.12400`).
6. **It changes no number.** This note is evidence *for* the plan's direction, not a new run. The
   next scored result comes from the corrected P3/P4 re-runs and the pruned verdict run
   (`PLAN-round30.md` §6.3, §7).
