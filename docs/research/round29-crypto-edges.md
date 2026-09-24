<!-- round29-note
id: crypto-edges
status: research (round 29 planning) — no code changed
grounds: [P3, P4]
keeps: [P3, P4]
kills: [R3, R4]
gates: []
conflicts: [C1, C2]
measured: [B3]
re-verified: 2026-09-24 (residual/IC/rank-book re-derived with explicit definitions)
index: round29-README.md
last-verified: 2026-09-24
-->

# Round-29 research note — where a real crypto edge is documented to live (and what the project's own data says)

**Status: research note (round 29 planning). No code changed.** The round-28 readout
and the P6 overlay established that NeuLegion's positive-Sharpe arms are ~100 %
net-exposure × market and that the cross-sectional residual is ≈0 in *those* arms.
This note asks the prior question: **where is a genuine, documented, out-of-sample
crypto edge, and does NeuLegion's current game (1h OHLCV, trend-like causal features,
per-stream positions) contain it?** Short answer: the documented edge at short
horizons is **reversal**, and this note records a direct measurement showing it is
**absent at 1h** in the shipped basket.

## 1. The strongest open-source lead: short-horizon reversal is pervasive in crypto

- *Short-horizon mean reversion in cryptocurrency markets: a matched cross-market
  measurement*, arXiv **2608.21888** (2026-08-22). Headline result: **at 15-minute
  horizons, directional mean reversion is far stronger and more pervasive in
  cryptocurrency markets than in US equities** — under *one matched, strictly
  out-of-sample protocol*, **90 % of 183 Binance pairs carry significant directional
  reversal**, against **2.7 % of 187 US stocks and ETFs**, "in every focal coin-year
  since 2021". Two further details matter for design: the signal **"lives in signs,
  not magnitudes"** (lag-one return autocorrelation is near zero on the majority of
  pairs — the edge is in the *direction* of the next move, not its size).

This is a large-sample, matched, out-of-sample measurement on the *same venue* as
NeuLegion's data (Binance). It is the single best external reason to believe a
genuine edge exists in this universe — and it says the edge is at **15 minutes and
shorter**, and it is **reversal**, not the trend/momentum family NeuLegion trades.

## 2. Where the project's own data agrees and disagrees (measured this round)

Coherence check, read-only over a retained journal (round-28 Step 1 baseline,
`src/20260923T211549-seed1/folds.jsonl`; 8 streams × 540 test bars, 1h). Every row was
**re-derived this round** from the journal with the definition given in the row, so each
is reproducible from the file:

| quantity | measured | reading |
| --- | ---: | --- |
| top eigenvalue share of the 8×8 per-bar return covariance | **0.794** | one common factor dominates |
| per-stream factor loadings (regression on the cross-sectional mean) | mean 1.00, **sd 0.28**, range **0.61–1.37** | streams are *not* a homogeneous β≈1 basket |
| residual variance share, **naive demean** (`r_s − mean_s r`; Σresid²/Σr²) | **25.9 %** | a quarter of the variance is *not* the equal-weight market |
| residual variance share, **1-factor OLS** (`r_s − α_s − β_s·mkt`) | **20.8 %** | a *proper* factor model leaves **less** (20.8 % < 25.9 %), but still ~a fifth |
| lag-1 autocorrelation, pooled | raw **−0.013**, naive-resid **−0.027**, factor-resid **−0.024** | 1h reversal is economically negligible |
| cross-sectional next-bar rank IC (Spearman(r_t, r_{t+1})) | raw **−0.050**, factor-resid **−0.035** | a ~3–5 % reversal IC at 1h — not tradeable |
| 1h symmetric demeaned-rank book (long prior-bar losers / short winners, 1-bar hold) | Sharpe **−0.05**, turnover **6.10**/bar, break-even **−0.042 bps** | the extreme 1-vs-1 variant is **−0.29**: the sign is not stable across constructions |

Two conclusions, and they are the round's sharpest coherence results:

1. **The P6 rejection is strengthened — by unpredictability, not by an absent residual.**
   The residual is **20.8 %** of the variance (naive demean 25.9 %), so the project's
   earlier `1 %` reading was an arithmetic slip; the cross-section is *not* degenerate.
   The sleeve is rejected because the residual is **unpredictable**: its next-bar rank IC
   is only **−0.035**, and a symmetric rank book breaks even at **−0.042 bps** at turnover
   6.10/bar. A **regression (1-factor) model** — the first step of the construction the
   academic literature uses (`2106.04028`, below) — does still remove **more** of the
   common variation (20.8 % < 25.9 %), so "a better factor model leaves less to trade"
   survives, on a larger base. **Do not build a cross-sectional sleeve on the existing
   1h data.** (A *conditional/time-varying* factor model on a **wide** coin universe is a
   different, still-open question — §3/§5 — and is now *mildly* better motivated, since
   there is a fifth of the variance to explain.)
2. **The reversal edge is a shorter-horizon phenomenon.** 1h lag-1 autocorrelation is
   −0.013 and the cross-sectional reversal IC is −0.03, while `2608.21888` measures
   pervasive reversal at **15m**. This is also consistent with the shipped
   `sig:autocorr` candidate failing (net Sharpe **−0.0996**, `dsrAdjusted` 0.0306,
   round-28 Step 3). **A reversal test at 1h is the wrong test; a reversal test needs
   shorter bars (a genuinely new stream/data).**
3. **A 1h cross-sectional book is uneconomic, and its sign is unstable.** Trading the
   symmetric demeaned-rank cross-section (long the prior-bar losers / short the winners,
   1-bar hold) on the same panel gives **Sharpe −0.05 at turnover 6.10 per bar** and a
   **break-even of −0.042 bps**; the momentum mirror is +0.05 / +0.04 bps. The *extreme*
   1-vs-1 variant (one loser vs one winner) is Sharpe **−0.29** — the opposite sign to the
   rank IC (−0.05), so the 1h cross-section is not even sign-stable across constructions.
   Against a 2–10 bps taker cost the required edge is **50–250× larger**. The rejection is
   therefore not only "no predictable residual" (conclusion 1) but "no tradeable signal at
   the rebalancing rate the cross-section implies".

## 3. The cross-sectional / factor literature (and why it needs conditional factors)

- *Cryptoasset Factor Models*, arXiv **1811.07860** (2019-02-27). Factor models for
  the cross-section of daily crypto returns, **with source code** for data downloads,
  factor construction and **out-of-sample backtesting**. Explicitly builds factors
  from a wide universe of coins/tokens.
- *A Time-Varying Network for Cryptocurrencies*, arXiv **1802.03708** (2022-11-17).
  **Return cross-predictability and technological similarity** drive a time-varying
  latent-community network — returns are cross-predictable across coins, and the
  structure is time-varying (a natural regime/changepoint axis).
- *Deep Learning Statistical Arbitrage*, arXiv **2106.04028** (2022-10-07). The
  canonical construction: build arbitrage portfolios as **residual portfolios from
  conditional latent asset-pricing factors**, then extract time-series signals from
  the residuals. The point is that the residual must be taken against a *conditional
  factor model*, not a constant mean.
- *Quantifying Cryptocurrency Unpredictability: A Comprehensive Study of Complexity
  and Forecasting*, arXiv **2502.09079** (2025-02-13). Complexity measures vs model
  forecasts across BTC/ETH/LTC/BNB/XRP — a humility check on how much of the series
  is predictable at all.
- *Review of deep learning models for crypto price prediction:
  implementation and evaluation*, arXiv **2405.11431** (2024-06-02) — the survey
  baseline for what actually replicates.
- *Dynamic Multi-Pair Trading Strategy in Cryptocurrency Markets with Deep
  Reinforcement Learning*, arXiv **2606.04574** (2026-06-25) — pair trading in crypto,
  with DRL as an *execution overlay* (rigidity/divergence risk of classical pairs).
- *Optimal market-neutral currency trading on the cryptocurrency platform*, arXiv
  **2405.15461** (2024-08-09) — a multivariate pair-trading bucket with a
  bi-objective (profit vs risk) convex formulation; market-neutral by construction.

**→ what it changes for NeuLegion.** The cross-sectional route is real in the
literature, but it needs (a) a **conditional** factor model, (b) a **much wider
universe** than 8 majors (the factor literature uses hundreds of coins), and (c)
shorter-horizon data. This aligns exactly with the "buy *independent* breadth"
conclusion in `METHOD.md` §5: 8 highly-correlated majors is not a cross-section.

## 4. Funding / basis / perpetuals: the genuinely independent, structurally different stream

The round-27/28 diagnosis is `effectiveStreams ≈ 2.3 of 8` and "the basket is
Binance-only" (`METHOD.md` §5). The cheapest *structurally independent* stream
available on the same venue is the **perpetual-futures funding rate / basis**.

- *BitMEX Funding Correlation with Bitcoin Exchange Rate*, arXiv **1912.03270**
  (2019-11-26). Establishes a **Granger-causal** relationship between the funding
  rate and the inverse perpetual price, and documents the **heteroskedastic** nature
  of funding — i.e. funding is both predictable and a distinct information channel.
- *Designing funding rates for perpetual futures in cryptocurrency markets*, arXiv
  **2506.08573** (2025-06-10). Models funding ↔ price alignment with path-dependent
  BSDEs and replicating portfolios — the structural mechanics that make funding a
  *carry* return, not a price forecast.
- *Funding-Aware Optimal Market Making for Perpetual DEXs*, arXiv **2605.06405**
  (2026-05-07), and *Optimal Adaptive Market Making: A High-Yield Liquidity Provision
  Framework in Perpetual Futures Markets*, arXiv **2607.11888** (2026-04-05). Funding
  as a first-class driver of return in perpetual markets.

**→ what it changes for NeuLegion.** Funding/basis is a **carry** return —
structurally near-zero net exposure to the market factor (long spot / short perp, or
vice versa), i.e. exactly the independent, low-correlation sleeve the design effect
demands, and computable from the same venue. It is a *different data source*, not
another feature on the same candles, and it should be evaluated as its own stream
under the existing gate. This is the concrete answer to "buy independence, not bars".

## 5. What this note rejects (with the number)

| candidate | verdict | the number |
| --- | --- | --- |
| cross-sectional sleeve on the existing 1h basket | **reject** | 1-factor residual 20.8 % but rank IC −0.050, top-eig 0.794, rank-book break-even −0.042 bps |
| 1h reversal signal family | **reject at 1h** | pooled lag-1 AC −0.013; rank IC −0.050; 1h rank book Sharpe −0.05; `sig:autocorr` net Sharpe −0.0996 |
| trend/momentum on 1h majors as a *residual* bet | **reject** | P6: ~100 % common-factor gross, ≈0 residual |
| reversal at 15m (new bars) | **keep — the lead** | `2608.21888`: 90 % of 183 Binance pairs |
| funding/basis carry (new data) | **keep — the independence lead** | `1912.03270`, `2506.08573`, `2605.06405` |
| cross-sectional factors on a **wide** coin universe | **keep, gated** | `1811.07860`, `1802.03708` (needs data + conditional model) |

## Open questions / leads (deferred, not scheduled)

- Can the 15m reversal edge be reproduced on NeuLegion's own cost model, and does it
  survive the dependence-adjusted DSR floor? (round-29 P2)
- Is funding/basis retrievable historically from the same venue, and is its stream
  return genuinely low-correlation with the price basket? (measure before building)
- Given `2106.04028`, does a conditional (network/regime) factor model expose residual
  structure that the static 1-factor model does not? (only worth it on a wide universe
  at short horizons)
