# NeuLegion — Round 29 plan: stop tuning the game, find the edge (measurement-first pivot)

Status: **FINAL (round 29) — coherence-checked 2026-09-24, implementation-ready for round 30.**
Documentation + research only: no code has been changed and no run has been scheduled. The
go/no-go gates are §5.2; the first work unit is §5.3; the focus points (gotchas) are §1.9. This plan is written from the round-28 run readout
(`RUN-ANALYSIS.md` §15, `BUGS.md` #60/#61/#62) plus a fresh round-29 external research
sweep (2026-09-24; notes under `docs/research/round29-*.md`) and two new *measured*
coherence checks over the retained runs/journals (§1.3, §1.8). Every priority states its
evidence (a run id and a number, or a file + line), its change, its acceptance criterion,
the test that pins it, and — explicitly — **what it can and cannot prove**.

> **Read this with [`docs/research/round29-README.md`](research/round29-README.md)** — the
> consolidated index (note registry, the decision table, the **conflict register**, the
> measured checks and the bottleneck evidence card) with a machine-readable mirror
> [`research/round29-registry.json`](research/round29-registry.json). §1.5 below was
> **corrected this round** by §1.8's measurement (the adjusted-DSR hurdle is a *surface*,
> not a Sharpe band); if you only remember one thing from round 29, remember §1.8.

This round makes **no claim to a promotion** and schedules **no code change in this
document**; it fixes the *target* so the next implementation round is not another
within-noise variant.

---

## 0. One paragraph: where round 29 starts

Round 28's three operator runs did their job: the corrected weighting experiment is
**live and mildly positive** but far below the DSR floor (arm A +0.0521 vs baseline
−0.1147, paired p 0.0759); the label-policy confirmation **bought the hurdle and lost
the effect** (Δ +0.2164 → +0.0289) while the whole book's *level* moved −0.1147 →
+0.8978 on the **retrain cadence alone**; and the signal family's one promotion
(`sig-accel` at 0 bps) was shown to be a **roster-size/multiplicity artefact**
(adjusted DSR 0.97420 at `K = 3` → **0.86080 at `K = 12`**, same journal). The
market-neutral overlay was measured and **~100 % of every positive-Sharpe arm's gross is
net-exposure × market**, with an ≈0 cross-sectional residual. So round 28's honest
conclusion is not "we are close"; it is that **the bot has no demonstrated residual
edge, and every mechanism, label and weighting variant has been a within-noise
re-arrangement of a bet that is the market**. Round 29 therefore stops optimising the
current game and asks the only questions that can change the outcome: *is the
*forecaster* the problem or the *target* (P1)? Is the *verdict* even stable across
evaluation configurations (P2)? And where is a real edge documented to live — a
shorter-horizon **reversal** (P3) or a structurally independent **carry** stream (P4)
— with continuous adaptation instead of schedule-bound retraining (P5)?*

**The round-29 thesis.** *NeuLegion's edge does not live in the controller's 1h trend
game. Re-source it from a shorter-horizon reversal signal and/or a funding/basis carry
stream — the only structurally independent returns available on the venue — forecast by
a model class the literature recommends (a linear/MLP model, or a small pretrained
time-series foundation model with continuous test-time adaptation), and judged by a
gate that is robust to the evaluation configuration and matches exposure across
families.*

**Refined by this round's measurement (§1.8).** The best arms are not "no edge": they are
**cluster-stable and effect-size-positive, and rejected by exactly one hurdle — the
dependence-adjusted DSR** — because ~79 % of the return covariance is one factor. So the
thesis sharpens to: *the bot has no **independent** edge, and the design target is a
measured reduction in the design effect* (which is what P4 buys and P2 gates). The core
hivemind design also gets one bounded, pre-registered question about itself — does the
controller's ensemble **size** matter? (P7) — because the user's hypothesis is a capacity
one and it is cheap to settle either way. **The implementation traps — the gotchas that
have cost time before — are collected in §1.9; read them before writing any code.**

---

## 1. The diagnosis (all numbers are measured, from retained runs or this round's check)

### 1.1 The forecaster has negative skill

Round-28 Step 2 baseline (`20260924T045601-seed1`, `RUN-ANALYSIS.md` §15.3): pooled
net Sharpe **−0.1147**, `brierSkill` **−0.07382**, `accuracySkill` **−0.13007**, the
report's own `status: 'base-rate'`. A model whose directional forecast is *worse than
the constant base rate* is the headline fact of the whole programme, and it is exactly
what the model-class literature predicts for a tiny, from-scratch, permutation-invariant
transformer on ~60 training bars (`round29-model-class.md` §1).

### 1.2 The positive-Sharpe arms are the market, not alpha

The P6 overlay (`RUN-ANALYSIS.md` §15.5b) measured the P&L decomposition of every arm:

| arm | gross P&L | common-factor | cross-section | common share |
| --- | ---: | ---: | ---: | ---: |
| Step-2 baseline | +0.07793 | +0.07852 | −0.00059 | **+1.00757** |
| `label:conservative` | +0.08245 | +0.08224 | +0.00021 | **+0.99750** |
| `sig:momentum` | +1.18654 | +1.13699 | +0.04958 | **+0.95824** |
| `sig:acceleration` | +0.99586 | +1.02479 | −0.02893 | **+1.02905** |

Everything that "worked" was long the market in a rising sample. The cross-sectional
residual is ≈0 (slightly negative for accel).

### 1.3 New this round: at 1h the residual is real but unpredictable, and there is no tradeable reversal (measured)

Read-only coherence check over the round-28 Step-1 baseline journal
(`src/20260923T211549-seed1/folds.jsonl`; 8 streams × 540 test bars at 1h). Every row is
**recomputed this round** from the journal with the definition in the middle column, so
each is reproducible from the file:

| quantity (definition) | measured | reading |
| --- | ---: | --- |
| top eigenvalue share of the 8×8 bar-return covariance | **0.794** | one common factor dominates |
| factor loadings on the cross-sectional mean (OLS β of each stream on `mean_s r`) | mean 1.00, **sd 0.28**, range 0.61–1.37 | not a homogeneous β≈1 basket |
| residual variance share, **naive demean** (`r_s − mean_s r`; Σresid² / Σr²) | **25.9 %** | ~a quarter of the variance is *not* the equal-weight market |
| residual variance share, **1-factor OLS** (`r_s − α_s − β_s·mkt`) | **20.8 %** | a *proper* factor model leaves **less** (20.8 % < 25.9 %), but still ~a fifth |
| pooled lag-1 autocorrelation (per-stream demeaned) | raw **−0.013** (naive-resid −0.027, factor-resid −0.024) | 1h reversal is negligible |
| cross-sectional next-bar **rank IC** (mean over bars of Spearman(r_t, r_{t+1})) | raw **−0.050** (factor-resid **−0.035**) | a ~3–5 % reversal IC — not tradeable |
| 1h symmetric demeaned-rank book (long prior-bar losers / short winners, 1-bar hold) | Sharpe **−0.05**, turnover **6.10**/bar, break-even **−0.04 bps** | 50–250× short of a 2–10 bps cost |

**Consequences (corrected this round).**
(a) The residual is **about a fifth** of the variance, not ~1 % — the earlier
`1.3 % / 1.04 %` rows were an arithmetic slip and are fixed here (a top-eig share of 0.794
cannot leave a 1 % residual; the correct values are 25.9 % naive-demean and 20.8 %
1-factor). So the cross-sectional sleeve is rejected because the residual is
**unpredictable**, not because it is *absent*: its next-bar rank IC is only −0.035, and a
symmetric rank book turns over 6.1×/bar for a break-even of −0.04 bps. The static OLS
factor model does still remove *more* than the naive demean (20.8 % < 25.9 %), so the
argument "a better factor model leaves less to trade" survives — on a *larger* base than
previously stated. (A *conditional/time-varying* factor model on a **wide** coin universe
is a separate, still-open question — `round29-crypto-edges.md` §3/§5, conflict C1 — and
is now *mildly* better motivated, since there is a fifth of the variance to explain; it
stays unscheduled.)
(b) The documented crypto reversal edge (`2608.21888`: 90 % of 183 Binance pairs at
**15m**) is a **shorter-horizon** phenomenon; at 1h it is not tradeable, which is also
why the shipped `sig:autocorr` failed (net Sharpe −0.0996, `dsrAdjusted` 0.0306).
(c) The 1h cross-sectional sign is **not even stable across constructions** — the rank
IC is weakly reversal (−0.05) while the extreme 1-vs-1 long-losers/short-winners book is
−0.29 (momentum at the extremes). A reading that depends on the construction is not an
edge; this closes R3/R4 more firmly than the variance argument alone.

### 1.4 The verdict is configuration-dependent

Same model, seed, data, CRN: Sharpe **−0.1147** at `testSize 15` → **+0.8978** at
`testSize 10` (Δ **1.01244**, se 0.47504, p **0.02008**, per-bar position correlation
**0.187**); a **fixed** position series re-scored under a different fold grid moves Sharpe only
~0.08 (baseline) to ~0.24 (`sig-momentum`), an order of magnitude below the 1.01
trajectory swing, so it is the model's trajectory under more frequent retraining. The paired
Δ of the best candidate collapses **+0.2164 → +0.0289** with the same change, and the
new requirement is **2197 clusters** (5017 at 80 % power). `TODO.md` 84.

### 1.5 The multiplicity floor is real, the roster matters, and the hurdle is a *surface*

`sig-accel`'s adjusted DSR is **0.97420 at `K = 3`** but **0.86080 at `K = 12`** —
the round-27 promotion was a roster-size artefact. `RUN-ANALYSIS.md` §15.4.

**Where the corrected claim came from.** The "Sharpe ≈1.02–1.08 band" and the "best
labeller at 0.10" both originate in `RUN-ANALYSIS.md` §14.2, which read the **round-27**
Step-4 journal at `K = 3` and design effect 5.12 (`sig-accel` 0.97420, `sig:momentum`
0.9487614, and the round-27 `label:conservative` at Sharpe 0.1017). §1.5 as written
generalised that one run's numbers into a design law.

**Corrected this round (see §1.8 MC1).** The dependence-adjusted DSR floor (≈0.95) is
**not** crossed at a fixed Sharpe band. On the round-28 retained runs the two arms *inside*
the old band both **fail** (`sig-accel` Sharpe 1.0194 → adjDSR 0.8608; `sig-momentum`
1.0848 → 0.7736) while the Step-2 **baseline passes at Sharpe 0.8978** (K=2, design effect
2.611). The hurdle is a surface in `(Sharpe, designEffect, moment shape, K)`; for the two
best candidates the **binding term is the design effect** — they clear the *unadjusted* DSR
(≥0.9966) and fail on **exactly one** hurdle, the dependence-adjusted one. The "best
labeller at 0.10" was the round-27 labeller, not the retained one: the retained Step-2
labeller's adjDSR is **0.9637** and it fails on the *paired* difference and stability. So
"the labeller is 10× short" is a cadence/roster-specific statement, which is itself the
point of P2.

### 1.6 The confidence scale is not comparable across families

Controller `|confidence|` max **0.2555** (frac > 0.2: **0.93 %**) vs signals saturating
at **1.0** (frac > 0.2: **83.08 %**), so at the shipped `deadZone 0.05` the baseline is
in the market **0.508** of bars and `sig-momentum` **0.892**; the P5 promoting row
compared an ~80 %-invested book with one holding **16 of 4 320** bars. `BUGS.md` #61,
`TODO.md` 85.

### 1.7 The diagnosis, in one line

**The binding constraint is the absence of an independent, residual, cost-survivable
edge — not the gate, not the power, not the number of mechanisms, not the dead zone.**
The evidence for "not the gate" is that the gate correctly rejected a promotion that
was a multiplicity artefact; the evidence for "not the mechanisms" is six mechanism
candidates across three rounds, none of which ever promoted; the evidence for "not the
dead zone" is that the dead-zone variant is a *new candidate* whose own DSR floor is
untouched (adjDSR 0.294/0.319 ≪ 0.95).

### 1.8 Measured coherence checks this round (the retained runs, read directly)

These are read straight from the three retained runs' `report.json` / `folds.jsonl` and
from the code — **no new run**. They are the authority for anything the plan says about
the gate, and they are mirrored in the [round-29 index](research/round29-README.md) §2
and [`round29-registry.json`](research/round29-registry.json) as `MC1`–`MC4`.

**MC1 — the adjusted-DSR hurdle is a surface, not a Sharpe band (this corrects §1.5).**
All three runs: `bars = 4320`, `costBps = 0`.

| run (config) | arm | K | net Sharpe | design effect | effBars | `dsr` (n=4320) | `dsrAdjusted` | promote | its **only** failing reason |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Step 1 (`testSize 15`) | baseline | 3 | −0.1147 | 4.866 | 888 | 0.0922 | 0.1428 | (base) | — |
| Step 1 | `sample-weights` | 3 | +0.0521 | 5.595 | 772 | 0.2618 | 0.2229 | false | mean-fold, DSR, DSR-adj, paired |
| Step 2 (`testSize 10`) | baseline | 2 | **+0.8978** | 2.611 | 1654 | 0.9991 | **0.9584** | (base) | — (crosses 0.95) |
| Step 2 | `label-conservative` | 2 | +0.9267 | 2.663 | 1622 | 0.9994 | **0.9637** | false | fold-mean Sharpe 0.5146 < 0.7005, paired (p 0.399), stability |
| Step 3 (`testSize 15`) | `sig-momentum` | 12 | **+1.0848** | 3.624 | 1192 | 0.9989 | **0.7736** | false | **only** DSR-adj |
| Step 3 | `sig-accel` | 12 | **+1.0194** | 2.465 | 1753 | 0.9966 | **0.8608** | false | **only** DSR-adj |

*Proves:* (a) the §1.5 Sharpe band is false as written (its origin is `RUN-ANALYSIS.md`
§14.2's **round-27** Step-4 journal at `K = 3`, design effect 5.12 — §1.5 generalised one
run too far) — the arms in it fail on the round-28 retained runs while a 0.8978 baseline
passes; (b) the **binding term is the design effect**, not `K` and not effect
size — the two highest-Sharpe arms clear every other hurdle and fail only the
dependence-adjusted DSR, with unadjusted DSR ≥ 0.9966; (c) the "best labeller at 0.10" is
the round-27 labeller (Sharpe 0.1017), not the retained one (0.9637): the claim was
cadence/roster-specific. *Actionable for P4:* the lever is a
less-correlated return series, and the anchors bracket the required design effect for a
Sharpe-≈1.0 arm in **(1.0, 2.5)** (at `effBars = 4320` sig-accel's adjusted DSR would equal
its 0.9966 unadjusted; at 1753 it is 0.8608) — so P4's acceptance bar is "move the best
arm's `dsrAdjusted` across 0.95", not "correlation below some number". *Cannot prove:* the
exact required `effBars` (the deflation hurdle is itself `n`-dependent — no interpolation
is quoted).

**MC2 — pooled Sharpe and mean fold Sharpe disagree on the same arm.** Step 2's
`label-conservative` is *better* on pooled Sharpe (0.9267 vs 0.8978) and clears the DSR
floor (0.9637), but *worse* on mean fold Sharpe (0.5146 vs 0.7005) and not a significant
paired improvement (Δ 0.0289, p 0.399). Any verdict must be reported across all three
aggregations (this is the concrete instance behind conflict **C8**; `BUGS.md` #60).

**MC3 — cost.** `report.json.candidates[*].elapsedMs`: controller arms **2.57–4.13 M ms**
(43–69 min) vs signal arms **4.27–4.60 k ms** (≈4.5 s) → **≈560–970×** (median ≈600×);
`decision.nextRun.measuredPerFoldMs` 19 117–54 902 ms/fold at `es = 4`. This bounds P7.

**MC4 — the `es` structure** (for P7): the operating point is `es = 4` (`analyze.js:415`,
`useController` at `:2009`); per-member dimensions are **constants** under `forceMin`
(`hivemind/persistence/dimensions.js:10-181`); per-member retrieval multiplies with `es`
(`hivemind/transformer/attention.js:190-192`)
while the broadcast/injection budgets **divide by `es`** (`lsh.js:200`, `transfer.js:43,245`);
an `es` change is **RNG-confounded** — the live retrieval reader draws `Math.random()` a
bucket-content-dependent number of times, so more members means more draws (`BUGS.md` #44
documents the same mechanism for `pca-hash`). Detail:
[`research/round29-ensemble-size.md`](research/round29-ensemble-size.md) §2.

**What §1.8 changes in the plan's reading.** The diagnosis (§1.7) is sharpened, not
weakened: the best arms carry an effect that is **cluster-stable** and effect-size-positive,
and the **dependence adjustment is the statistic that (correctly) rejects it** because
~79 % of the covariance is one factor (§1.3). "No demonstrated residual edge" therefore
means "**no independent effect**" — which is exactly what P4 and P2 address.

### 1.9 Focus points (gotchas) that constrain any implementation

Fourteen traps that have cost this project time before, and that any round-30
implementation must route around. Each is a file+line or a measured number; none is a
matter of taste.

| id | gotcha | why it bites | the rule |
| --- | --- | --- | --- |
| FG1 | `forceMin = true` is the production branch | every per-member dimension is a **constant** (`dimensions.js:20-97`), so total forward cost is linear in `es` and the full-size branch is unaudited at this scale | any `es` result is a statement about the *compact* branch — say so |
| FG2 | two controller constructors | `analyze.js:761/:842` use `CONTROLLER_MODEL.ensembleSize = 4`; the legacy bare path `analyze.js:508` hard-codes **3** | know which path produced a journal before comparing member counts |
| FG3 | an `es` change is RNG-confounded | the live retrieval reader draws `Math.random()` a bucket-content-dependent number of times (`BUGS.md` #44, documented for `pca-hash`) | ≥3 seeds, paired within-seed; never read a single-run `es` diff as capacity |
| FG4 | `costBps = 0` in every retained run, and the shipped dead zone is family-relative | break-even is the *cost axis*; at `deadZone 0.05` the baseline is invested 0.508 of bars vs 0.892 for `sig-momentum` (`BUGS.md` #61) | cross-family numbers only at matched exposure (P2); always quote the cost in bps |
| FG5 | the DSR hurdle is a *surface* and `n`-dependent | no interpolation of the required `effBars` (the deflation hurdle depends on `n`) | use MC1's per-arm anchors; state `(Sharpe, designEffect, K)` together |
| FG6 | three aggregations disagree on one arm | pooled 0.9267 > 0.8978 but mean-fold 0.5146 < 0.7005 and paired p 0.399 (`BUGS.md` #60/MC2) | report pooled, mean-fold and paired; `meanSharpeDelta` is a *fold-level* gated hurdle |
| FG7 | absolute vs relative hurdles | `minDsr`/`minDsrAdjusted` are absolute (0.95); `dsrDelta`/`meanSharpeDelta`/`pairedSharpeDifference` are relative to the baseline | name which when a verdict is quoted |
| FG8 | the raw fold fractions are reported but not gated | `foldWinFraction`/`positiveFoldFraction` are `gated:false` (`DESIGN.md` §6.1); `requireSharpeDiff`/`requireClusterStability` are on | do not resurrect the fractions as gate inputs |
| FG9 | `--label-horizon` is not a label-horizon knob on non-`triple` runs | it silently sets the causal sample-weight span (`BUGS.md` #62) | set the span explicitly; check `labelHorizonBars` in the report |
| FG10 | the goldens pin a *bare* `HiveMind` | `golden.test.js:214` at `es = 3`, `controller_invariants.test.js:113` at `H_ES = 2` | an *analysis-level* `es` change moves no golden — do not cite the goldens as blocking P7, and do not assume they cover the analysis path |
| FG11 | `modelRetention: 'discard'`, `reuseBase: true`, CRN on | the base is reused across variants, so a candidate's `elapsedMs` is not an additive cost | read `timings`/`measuredPerFoldMs`, not a single arm's total |
| FG12 | **one seed everywhere** (`--seed=1`) | C8's "cadence is a nuisance" is a one-seed claim, and the level swing is a single trajectory (B5) | no cross-seed claim until ≥3 seeds; always report the seed |
| FG13 | the P6 overlay ran on **selected** arms | C10: "~100 % of positive-Sharpe arms is the market" is scoped to those four rows | restate the overlay on the Step-3 journal for every positive-Sharpe arm before quoting it as universal |
| FG14 | `barsToDetectObserved` (93 576) is a **single-series** number | the decision's lever is the *paired* cluster requirement (2197), a different quantity (`BUGS.md` #56) | never compare the two scales |

---

## 2. The literature verdict (round-29 sweep; full notes in `docs/research/round29-*.md`)

| question | the open-source answer | ref |
| --- | --- | --- |
| Is a from-scratch tiny transformer the right forecaster here? | No — linear/MLP models dominate it on TS (DLinear, TSMixer, TiDE, N-BEATS, a GBRT baseline), and small **pretrained** TSFMs (TTM 1M params, Tiny-TSM 23M) beat training from scratch. | `2205.13504`, `2101.02118`, `2303.06053`, `2304.08424`, `1905.10437`, `2401.03955`, `2511.19272` |
| Does the deep+evolutionary "holy grail" work? | No — a rigorous 2026 post-mortem of a genetic-survival + transformer trading system documents its failure. | `2512.15732` |
| Where is a genuine crypto edge documented? | **15-minute reversal, pervasive**: 90 % of 183 Binance pairs vs 2.7 % of US equities, matched out-of-sample. | `2608.21888` |
| How do you trade a crypto cross-section? | With **conditional latent factor** residualisation on a **wide** coin universe, not naive demeaning of 8 majors. | `2106.04028`, `1811.07860`, `1802.03708` |
| What is a structurally independent return on the venue? | Perpetual **funding/basis** — Granger-causal with price, heteroskedastic, a carry return. | `1912.03270`, `2506.08573`, `2605.06405` |
| How should a non-stationary model adapt? | Continuously and cheaply — freeze the backbone, adapt normalisation/low-rank params on recent windows; a causal "sieve" for ragged data. | `2602.00073`, `2506.23424`, `2601.05975`, `2605.17250` |
| How do you make a verdict configuration-robust? | Treat configuration as a **parameter region**: stable regions, **majority pass + catastrophic veto**, parameters locked OOS. | `2603.09219`, `2602.10785`, `2512.12924`, `2209.13623` |
| What sets the optimal turnover? | A closed form in the alpha's **autocorrelation** and liquidity. | `2110.03810` |
| Is there a no-assumption baseline that cannot be beaten by luck? | Universal / no-regret portfolios with worst-case guarantees. | `1212.2129`, `2105.13126`, `2209.13932`, `2202.07574` |
| Should the ensemble be **bigger** (more members per controller)? | Size should follow the **effective dimension**, not "bigger is better" — and **skill, not decorrelation, governs** whether a member pool helps; many members are affordable mainly by **sharing weights**. | `2609.13954`, `2609.23927`, `2608.16190`, `2002.06715`, `2609.24782`, `2203.05482`, `2607.08493` |
| Does the *dependence* of the return series or the *multiplicity* of the search bind the verdict? | Measured here (§1.8): the **design effect** binds, not `K` — the best arms pass everything but the dependence-adjusted DSR. | this round; `performance.js` |

---

## 3. Priorities

`P1` is the decisive cheap measurement; `P2` fixes the verdict; `P3`/`P4` are the two
**new-data** candidate *games*; `P5` is the adaptation mechanism; `P6` is gated on P1;
`P7` is the **capacity probe** (ensemble size) — the one place the round lets the core
hivemind design ask a question about itself, bounded and pre-registered.

**Priority table (the implementation order; the gates are in §5.2).**

| order | id | step | gating | cost | acceptance | unlocks / stops if |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | — | reading-layer fixes: the §1.5/MC1 correction (**done**) and **C10** (restate the P6 overlay on the Step-3 journal for *every* positive-Sharpe arm) | none | offline | a `RUN-ANALYSIS.md` note | makes §1.2 quotable |
| 1 | **P1** | model-class benchmark | none | hours, offline | a P1 table + a signed branch | target vs architecture (**G-A**) |
| 2 | **P2** | configuration-robust promotion + exposure matching | none | cheap | verdict-neutral on the 3 retained runs + `sig-accel`'s 0-bps promotion killed + 2 fixtures | makes later verdicts citable |
| 3 | **P3** | 15m reversal on new bars | step-0 data audit | data fetch + a cheap run | clears break-even + adjDSR + SPA at > half the cadences | new sleeve (**G-B**) |
| 4 | **P4** | funding/basis carry | step-0 fetch/audit; measure-first | data fetch + a measurement | moves the best arm's `dsrAdjusted` across 0.95 | new sleeve (**G-C**) |
| 5 | **P5** | continuous TTA (frozen backbone) | after P2 | ~1 round, off by default | level ≈invariant across `testSize`; goldens unmoved | retires the cadence step (**G-D**) |
| 6 | **P7** | `es ∈ {2,4,8,16}` capacity probe | **GATED on P1** | short run, ≥3 seeds | the `es` × {skill, diversity, capacity, wall-ms} table | reopen architecture (**G-E**) or close `es` |
| 7 | **P6** | meta-labeling | **GATED on P1 positive skill** | a run | meta-filter improves net Sharpe at an unchanged DSR floor | only if G-A finds skill |
| 8 | **P7b** | design rule: learned/dimension-sized `es`, or shared-weight members | follows P7 | reading | — (a rule, not a run) | — |
| 9 | — | docs sync (§5.4) | continuous | — | lockstep index + registry | keeps the record honest |

### P1 — The model-class benchmark: is the forecaster the problem, or the target? (cheap; decisive)

**Goal.** Decide, on NeuLegion's own candles and the frozen harness, whether the
negative forecast skill is a property of the **architecture** or of the
**features/labels**.

**Evidence.** §1.1 (negative skill, `status: 'base-rate'`); `round29-model-class.md`
§1/§2 (linear/MLP and pretrained TSFMs dominate from-scratch transformers); the
project already ships the **proper-score / DM / MCS** layer (R26-14) and the per-bar
journal (R26-3), so this is nearly free.

**Change (experiment, not a new mechanism).** Score the *same* walk-forward, on the
same pooled OOS bars, for a pre-registered set of forecasters:
1. **base rate** (the null the project already computes),
2. **linear** — ridge / last-value on the same 10 indicator features,
3. **MLP-mixer** — a TSMixer/N-BEATS-class small MLP on the same inputs,
4. **zero-shot TSFM** — a TTM/Chronos-class pretrained model on the same series,
5. **the controller** (already journaled).

Metric: per-bar Brier loss and **Brier skill vs the base rate**, plus the DM test vs
the baseline and a **Model Confidence Set** over the set — all things the project can
already compute. Signals/linear/TSFM are ~600× cheaper than the controller.

**Acceptance (pre-registered decision rule).**
- If **no** forecaster — including the linear and the pretrained model — has positive
  Brier skill vs the base rate, then the **features and labels**, not the architecture,
  are the constraint → P3/P4 (new targets) are the only levers, and the controller
  architecture is out of scope.
- If a linear/MLP/TSFM forecaster **beats the controller** on the same features, the
  **architecture** is the constraint → the controller is re-scoped to that model class.
Either outcome is a decision, and each branches the round.

**Test.** `analyze.test.js` pins the benchmark runner and the MCS grouping
(controller vs linear vs TSFM kinds); the readout is a `RUN-ANALYSIS.md` section.

**Can prove:** whether the model class is the constraint, on this data.
**Cannot prove:** that any of them has a *tradeable* edge (that is P3/P4).

### P2 — Make the verdict configuration-robust and exposure-matched (decision procedure; cheap)

**Goal.** A promotion decision that does not move with the evaluation configuration,
and cross-family statements that are exposure-matched.

**Evidence.** §1.4 (cadence moves the level by Δ 1.01, p 0.02, and kills the paired
Δ); §1.6 / `BUGS.md` #61 (0.51 vs 0.89 vs 0.0037 nonzero fraction); `TODO.md` 84/85;
`round29-evaluation-robustness.md` §§1–4 (`2603.09219`'s majority-pass + catastrophic
veto is the ready-made template; Lo 2002 says the statistic depends on the interval).

**Change.**
1. **Named cadence everywhere.** Every cross-run level statement and every
   `decision.nextRun` field carries its `testSize`/cadence; a level comparison across
   cadences is invalid by construction.
2. **Configuration-robust promotion.** The gate is evaluated across a small cadence
   grid; a candidate is promotable only on a **majority-pass with a catastrophic
   veto** (AlgoXpert) — i.e. it must promote at more than half the cadences and must
   not fail catastrophically at any. The grid is added to the reported `trials` if the
   cadence is searched.
3. **Exposure matching.** Cross-family comparisons (controller vs signal) are quoted at
   matched exposure — per-family empirical quantiles of `|confidence|`, or matched
   `nonZeroFraction` — and the dead zone is applied in the family-consistent space.
4. This is a `DESIGN.md` §6 decision-procedure change with a `METHOD.md` rationale and
   a `DESIGN.md` §6.1 addendum.

**Acceptance.** (a) a retrospective on the three retained runs showing the rule is
verdict-neutral where it must be and **kills `sig-accel`'s 0-bps promotion**; (b) an
`analysis.test.js` fixture where a candidate promotes at one cadence only and the rule
rejects it; (c) a fixture where the raw dead zone manufactures a spurious exposure gap
and the matched rule removes it.

**Test.** `analysis.test.js` (§ config-robust gate + exposure matching); `METHOD.md` §10.

**Can prove:** the decision is invariant to the configuration, and cross-family claims
are exposure-honest.
**Cannot prove:** that any candidate is real — it only removes a way to be fooled.

### P3 — The new game, part 1: short-horizon reversal (new data; the strongest lead)

**Goal.** Test the one documented, matched, out-of-sample crypto edge on this platform:
**15-minute directional reversal**.

**Evidence.** `2608.21888`: 90 % of 183 Binance pairs carry significant directional
reversal at 15m vs 2.7 % of US equities, in every coin-year since 2021, and the signal
lives in **signs, not magnitudes**. The project's own 1h data has lag-1 AC **−0.013**, a
rank book breaking even at **−0.04 bps** (turnover 6.11/bar), and `sig:autocorr` failed
(§1.3) — so the test **must** be at shorter bars, and 15m bars are also a **genuinely
new stream** (the only real independence lever per `METHOD.md` §5).

**Change / experiment.** (0) Fetch and audit 15m (and optionally 5m) bars for the
shipped basket; this is a new candle file set through the existing
`candle_fetcher`/`candles_audit` path (no new mechanism). (1) A reversal signal family
— sign reversal, cross-sectional reversal, volatility-scaled reversal — under the
**existing** gate with the `0,2,5,10` cost ladder and the P2 configuration-robust rule.
Report **directional hit rate** and sign-based accuracy, not only Sharpe, because the
paper says the edge is in signs.

**Acceptance.** The reversal candidate clears its `breakEvenCostBps` at a realistic
15m taker cost **and** passes the dependence-adjusted DSR floor **and** is not
rejected by SPA — at **more than half** the cadences (P2). Non-acceptance is a full
result: it would say the documented reversal does not survive this cost model.

**Test.** `analyze.test.js`/`walkforward` fixtures for a short-horizon reversal signal;
a `RUN-ANALYSIS.md` readout with the cost ladder.

**Can prove:** whether the documented reversal edge is accessible here, net of cost,
under the honest gate.
**Cannot prove:** that it generalises past the sample (the window-dependence caveat in
`research/financial-validation.md` still applies).

### P4 — The new game, part 2: funding/basis carry (new data; the independence lead)

**Goal.** Add a **structurally independent** return stream to a basket whose
`effectiveStreams` is ≈**2.3–2.42 of 8** (design effect **2.43–7.00×** across the retained
arms).

**Evidence.** §1.3 (one factor = 79.4 % of the covariance); `METHOD.md` §5 ("a
genuinely independent stream needs a new data source — the basket is Binance-only");
`round29-crypto-edges.md` §4: funding is Granger-causal with price and heteroskedastic
(`1912.03270`), is a carry return (`2506.08573`), and is a first-class perpetual-market
driver (`2605.06405`).

**Change / experiment.** (0) Fetch historical **funding rate + mark/index** for the
basket (same venue, through the existing fetcher/audit path). (1) Construct the
**carry stream** (e.g. perp-short / spot-long or its sign-flipped variant) and
**measure first**: its standalone cost-adjusted return, and its correlation with the
price basket. (2) Only if it buys independence, add it as a stream/candidate under the
existing gate.

**Acceptance.** Its measured correlation with the price basket is **materially below**
the current cross-stream 0.29–0.52 (baselines 0.33–0.35) (i.e. it actually reduces the design effect), and it
has a defensible cost-adjusted standalone return. If it does not reduce the design
effect, it is rejected as a breadth purchase and recorded as such.

**Test.** A `fetcher`/`candles` test for the new data path; an `analysis` test for the
carry-stream construction; `RUN-ANALYSIS.md` readout.

**Can prove:** whether carry is an independent sleeve on this venue.
**Cannot prove:** the funding series' historical availability/quality until fetched
and audited (step 0 is a real gate).

### P5 — Continuous test-time adaptation instead of schedule-bound retraining (harness experiment)

**Goal.** Remove the cadence step as a free parameter by adapting continuously.

**Evidence.** §1.4 (the level is a function of the retraining schedule);
`round29-adaptation-and-regime.md` §1 (`2602.00073`: frozen backbone + only
normalization affine params updated on recent windows; `2601.05975`: DeePM's causal
sieve for ragged data; `2506.23424` PETSA low-rank adapters).

**Change.** Freeze the backbone and adapt only normalisation / low-rank parameters on
recent unlabeled windows, with an optional causal online changepoint trigger
(`0710.3742`/`2302.04759`) replacing the fixed fold step. Off by default, bit-identical
when off.

**Acceptance.** The TTA arm's measured level is (approximately) **invariant across
`testSize ∈ {10,15}`** — the cadence nuisance becomes the acceptance test — while the
goldens are unmoved when the flag is off.

**Test.** `controller_invariants`/`walkforward` fixtures; a `RUN-ANALYSIS.md` A/B
(fold-replay vs TTA).

**Can prove:** that a continuous adaptation removes the configuration dependence.
**Cannot prove:** that adaptation creates edge — it can only remove a nuisance
(and, at best, track a non-stationary process better).

### P6 — Meta-labeling (gated on P1 finding a positive-skill primary)

**Goal.** If P1 finds *any* primary with positive Brier skill, use a secondary model to
**size/filter** it (AFML ch. 3 meta-labeling).

**Evidence.** `round29-*`; the project cites AFML ch. 3 already. The coherence check is
decisive: **a meta-model cannot rescue a negative-skill primary**, so this is gated on
P1 and is explicitly *not* a round-29 deliverable unless P1 returns positive skill.
Related label-side evidence: `2107.11972` (iterative refinement labeling),
`2306.09862` (DoubleAdapt for incremental stock trend).

**Acceptance (if reached).** The meta-filter improves the primary's net-of-cost Sharpe
with the DSR floor unchanged — i.e. the **primary carries the skill**, the meta-model
sizes it.

**Can prove:** whether sizing/filtering adds to an existing positive skill.
**Cannot prove:** anything if the primary has no skill — the gate is the point.

### P7 — The capacity probe: does the controller's ensemble *size* matter? (gated on P1; short run)

**Goal.** Test, in a bounded and pre-registered way, the one question the core
hivemind design raises about itself: does **more members per controller** (`es = 4 → 8,
16`) buy capacity/diversity/skill — or is the member count not the constraint?

**Evidence.** §1.8 (the binding term is the *dependence* of the returns, and the
controller is 560–970× the signal family, so any `es` sweep must be small);
`round29-ensemble-size.md` §2 (per-member retrieval ∝ `es` but the broadcast/injection
budgets **÷ `es`**; `forceMin` makes cost linear in `es`; `BUGS.md` #44 makes an `es`
change RNG-confounded) and §3 (`2608.16190`: **skill, not decorrelation, governs**;
`2609.13954`/`2609.23927`: size follows the effective dimension; `2002.06715`: cost
linear; `2609.24782`/`2203.05482`: many members are affordable by *sharing weights*;
`2607.08493`: learn the cardinality).

**Change (experiment only — no default change).** A pre-registered sweep
`es ∈ {2, 4, 8, 16}` at `forceMin`, everything else frozen, on a **short** window sized to
≈1 controller arm's cost of a normal run, **≥3 seeds**, one table: `es` × {per-bar Brier
skill vs the base rate, net Sharpe **at matched exposure** (P2), `meanPairwiseKappa`,
`effectiveVoters`/entropy, per-member bank occupancy, aggregate retrieved/injected proto
counts, wall ms}.

**Acceptance (pre-registered).** If **no** `es` improves Brier skill vs the base rate
beyond the seed spread, then **capacity/member count is not the constraint** → the bot's
problem is the target/dependence (§1.7/§1.8) and `es` is closed with a number. If some
`es` does, record the curve and re-open the architecture question (couples to P1's
branch). Either outcome is decisive.

**P7b (the default-level answer, not a run).** Do **not** hard-code a bigger default `es`.
The record says size should be *learned/sized* (`2607.08493`, `2609.13954`, `2609.23927`),
and that the cheap way to many members is **shared weights** (`2609.24782`, `2002.06715`;
`transfer.js` already shares *memory* between members but not parameters).

**Test.** `dimensions.test.js`/`sanity.test.js` already pin the compact dimensions across
`es`; the probe adds a **benchmark harness** (an `es`-sweep runner) whose output is a
table in `RUN-ANALYSIS.md`. Goldens are unmoved (they pin a bare `HiveMind` at `es = 3`).

**Can prove:** whether member count moves skill/diversity/effective capacity on this data,
and at what cost.
**Cannot prove:** that any `es` makes a *tradeable* edge (P1/P3/P4), and it cannot cleanly
separate capacity from diversity (both move together — `round29-ensemble-size.md` C4a/C4b).

---

## 4. What we are NOT doing, and why (the anti-re-tread list)

| rejected direction | reason (evidence) |
| --- | --- |
| More mechanism variants (a 7th/8th default-off feature) | six mechanisms across three rounds, **zero** promotions; §1.7 |
| Buying bars/power for the DSR floor | 93,576 i.i.d. bars needed; independence buys ≈2.3× on the SE; `METHOD.md` §5/§7 |
| A cross-sectional sleeve on the **existing 1h basket** | §1.3: the static 1-factor residual is **20.8 %** (not ~1 %) but its rank IC is only **−0.050** and the symmetric rank book breaks even at **−0.042 bps** at turnover **6.10**/bar (the reversal reading is sign-unstable: the 1-vs-1 variant is −0.29) |
| A 1h reversal signal family | §1.3: 1h AC −0.013; `sig:autocorr` net Sharpe −0.0996 |
| Changing `testSize` as a *fix* | §1.4: it is a nuisance, not alpha; the paired Δ collapsed |
| Tuning the dead zone as a fix | item 5 closed as a small positive below the floor; the real issue is exposure matching (#61/P2) |
| A bigger / more-evolved hivemind | `2512.15732` (Red Queen's Trap); the ES module is already deliberately unimported (`TODO.md` 13) |
| Relaxing `K` or the DSR floor to get a promotion | the floor is what makes the gate's size ~3.5 %; `1612.04535` and Harvey–Liu–Zhu 2016 settle `K = trials` |
| Cross-family Sharpe claims at the shipped dead zone | #61: 0.51 vs 0.89 vs 0.0037 nonzero fraction |
| `es` as a **default increase** (8/16 baked in) | no ensemble-size→skill evidence anywhere; cost is linear in `es` (§1.8 MC3); an unfalsified bet (`round29-ensemble-size.md` §5). P7 may still *test* it — but the default does not move. |
| `es` as a **memory play** ("a bigger ensemble holds more data") | the global broadcast/injection budgets **divide by `es`** (`lsh.js:200`, `transfer.js:43,245`), so memory *reach* does not scale with `es`; the live per-member retrieval does, so the net effect is the thing P7 must measure (C4a). |

**Not rejected, but explicitly *not scheduled* this round:** a cross-sectional sleeve on
a **wide** coin universe (hundreds of coins) with a **conditional/time-varying** factor
model (`1811.07860`, `1802.03708`, `2106.04028`). It needs new data and a new
cross-stream interface, and the round-28 overlay measurement removed the *evidence*
that justified building it (the residual was ≈0 on the current signals). It re-enters
only if P3/P4 produce a reason to search a **larger** family (`METHOD.md` §2's racing
gate) or a measured residual edge.

**Also recorded, not scheduled:** the **shared-weight virtual-member** route
(`2609.24782`, `2002.06715`) — the only way to a genuinely large member count at fixed
parameter cost — is a *deferred lead* that depends on P7 showing member count matters;
and a cheap **rolling/conditional-factor residual** restatement on the existing 8×540
journal would settle whether C1 (the static-vs-conditional factor question) can be
reopened at all without new data.

---

## 5. Order of work, gates and cost

### 5.1 Order

1. **P1** (model-class benchmark) — mostly offline; hours. **Decisive; do first.**
2. **P2** (configuration-robust gate + exposure matching) — reading/decision-procedure
   work; no long run; cheap. Unblocks every statement that follows.
3. **P3** (15m reversal) — a data fetch + audits + a signal-family run. The signal
   family is ~600× cheaper than the controller, so this is cheap *provided* the data
   fetch is clean (step 0 is a hard gate).
4. **P4** (funding/basis) — a data fetch + a measurement *before* any wiring (the
   measure-first discipline of P6 in round 28).
5. **P5** (TTA) — a harness experiment/A-B; ~1 round of work, off by default.
6. **P7** (capacity probe) — **gated on P1**; a short, seed-replicated `es` sweep with a
   pre-registered rule. Not scheduled before P1.
7. **P6** (meta-labeling) — **gated on P1**; not scheduled otherwise.
8. **Docs sync** — §5.4, as each item lands.

### 5.2 Go/no-go gates (what each outcome means)

- **G-A (after P1).** *If* a linear/MLP/TSFM forecaster has **positive Brier skill vs the
  base rate** on the same features → the **architecture** is the constraint: run P6 and
  P7 with the new primary. *If* **nothing** beats the base rate (including the pretrained
  model) → the **features/labels** are the constraint: skip all controller-side work
  (P6, P7) and put the round into P3/P4. Both branches are recorded in `RUN-ANALYSIS.md`.
- **G-B (after P3).** *If* the 15m reversal clears break-even, the adjusted DSR floor and
  SPA at a **majority of cadences** → it becomes the new candidate sleeve (and P4's
  independence test is re-scoped around it). *Else* → the documented reversal does not
  survive this cost model at 15m; record it and shift the round's weight to P4.
- **G-C (after P4).** *If* the carry stream moves the best arm's `dsrAdjusted` across
  0.95 (the MC1 bar) → carry is a real independence purchase. *Else* → rejected as a
  breadth purchase, recorded with the measured correlation.
- **G-D (after P5).** *If* the TTA arm's level is ≈invariant across `testSize ∈ {10,15}`
  with the goldens unmoved when off → the cadence step is retired as a free parameter.
  *Else* → TTA does not remove the configuration dependence; record it.
- **G-E (after P7).** *If* some `es` improves Brier skill vs the base rate beyond the
  seed spread → record the `es`-skill curve and re-open the architecture question
  (couples to G-A). *Else* → capacity/member count is **not** the constraint; `es` is
  closed with a number and the default stays 4.

### 5.3 Round-30 kickoff (the first work unit)

Start with **unit 0** (the C10 overlay restatement — offline, hours) and **P1**:
`src/analyze.js` gains a benchmark kind that scores the *same* walk-forward, on the same
pooled OOS bars, for base rate / ridge / an MLP-mixer / a small pretrained TSFM / the
controller; `src/analysis/forecast.js` extends the score kind; `analysis.test.js` pins
the runner and the MCS grouping. The acceptance artifact is a `RUN-ANALYSIS.md` P1
section with the pre-registered branch (G-A) **and** a two-line note in the round-29
index/registry. Then P2 as unit 2.

**What round 30 must not do:** start P7/P6 before P1's branch is recorded (both gated);
let P3's *verdict* precede P2's rule (the data fetch may run in parallel); or change any
default (`es`, `deadZone`, the gate) to chase a number.

### 5.4 Docs-sync checklist (as each item lands)

`RUN-ANALYSIS.md`, `METHOD.md` §10 (configuration), `DESIGN.md` §6.1, `BUGS.md`,
`TODO.md`, `ROADMAP.md`, `CITATIONS.md`, `research/README.md`,
`research/round29-README.md` + `round29-registry.json` (keep the index and the
machine-readable mirror in lockstep), `src/README.md`.

## 6. Decisions (recorded; the agent has technical authority per `PLAN-round27.md` §3.5)

| # | decision | evidence |
| --- | --- | --- |
| D1 | **The bottleneck is the absence of a residual edge, not the gate/power/mechanisms.** Stop adding mechanisms; change the target. | §1.7 |
| D2 | **The forecaster must be benchmarked against linear/MLP/pretrained before any further controller work.** | §1.1; `round29-model-class.md` |
| D3 | **1h cross-sectional/reversal is closed** (AC −0.013; the residual is 20.8 % but its rank IC is only −0.050 and the rank book breaks even at −0.042 bps, with a sign that flips across constructions). Reversal must be tested at 15m; a cross-section needs a wide universe + conditional factors. | §1.3; `round29-crypto-edges.md` |
| D4 | **Buy independence from a new data source** — 15m bars (P3) and/or funding/basis (P4) — not from more bars of the same eight. | §1.3; `METHOD.md` §5 |
| D5 | **A verdict must be configuration-robust and exposure-matched** before any cross-family claim. | §1.4/§1.6; `TODO.md` 84/85 |
| D6 | **Replace schedule-bound retraining with continuous, small-footprint adaptation** as the non-stationarity answer, with the cadence-invariance as its acceptance test. | §1.4; `round29-adaptation-and-regime.md` |
| D7 | **Meta-labeling is gated on P1** (it cannot rescue a negative-skill primary). | P6 |
| D8 | **The adjusted-DSR hurdle is a surface in `(Sharpe, designEffect, moments, K)`, and the binding term for the best arms is the design effect** — so the lever is an *independent* return series, not a bigger Sharpe. The plan's §1.5 Sharpe band is corrected. | §1.8 MC1; §1.5 |
| D9 | **Ensemble size is a gated, pre-registered probe (P7), not a default change**; the principled default is a *learned/dimension-sized* `es` (P7b), and any future "more members" work must answer the cost (`2002.06715`) and skill-governs-diversity (`2608.16190`) evidence. | `round29-ensemble-size.md` §3/§5 |
| D10 | **The 1h cross-sectional close rests on unpredictability and sign-instability, not on a small residual** — the residual is **20.8 %**, but its next-bar rank IC is −0.035 and the reversal reading flips sign across constructions (−0.05 weighted vs −0.29 extreme). A conditional-factor sleeve on a wide universe (G1/C1) is *mildly* better motivated and still unscheduled. | §1.3 (re-verified this round) |
| D11 | **Id namespace:** the plan's *decisions* are `D1–D11` (this table); the index/registry identify *directions* by their priority id (`P1…P7b`) plus `R#`/`G#`/`C#`/`MC#`/`B#`/`FG#`. No `D#` id labels a direction. | coherence fix, round 29 |

---

## 7. Files to change (implementation map — for the *next* round; nothing here is changed now)

| file | change (planned) |
| --- | --- |
| `src/analyze.js` | the P1 model-class benchmark runner and its kind grouping; the P2 cadence-grid restatement; the P2 exposure-matched dead zone; the P5 TTA flag |
| `src/analysis/forecast.js` (R26-14) | extend the score kind to `linear`/`mlp`/`tsfm`; MCS over the mixed set |
| `src/analysis/decision.js` | `promotionAcrossCadences` (majority pass + catastrophic veto); every level field carries its cadence |
| `src/analysis/walkforward.js` | the config-robust gate hook; exposure-matched cross-family comparison |
| `src/analysis/features.js` | the P3 reversal family; the P4 carry-stream feature path |
| `src/hivemind/...` | (P5 only) the opt-in continuous-adaptation path, off by default, goldens unmoved |
| `src/analyze.js` (P7) | the `es`-sweep runner: `ensembleSize` threaded through the existing factory (it already is), a short-window profile, and a table emitter. **No default change** — `CONTROLLER_MODEL.ensembleSize` stays 4 |
| `src/analyze.js` (C10) | restate the P6 market-neutral overlay on the **Step-3** journal for every positive-Sharpe arm (offline; unit 0 of §5.3) |
| `src/analyze.js` / `src/analysis/backtest.js` (C9/MC1) | nothing to change: the surface is already computed; the *reading* layer (`report`/`RUN-ANALYSIS.md`) must state the hurdle as a surface and quote per-arm anchors |
| `src/candle_fetcher.js` / `src/fetch_candles.js` / `candles_audit.js` | (P3/P4) 15m bars and funding/mark series through the existing fetch/audit path |
| tests | `analysis.test.js` (config-robust gate, exposure matching, reversal), `analyze.test.js` (benchmark runner), `walkforward.test.js`, a `fetcher`/`candles` test for the new data |
| docs | `RUN-ANALYSIS.md`, `METHOD.md` §10, `DESIGN.md` §6.1, `BUGS.md`, `TODO.md`, `ROADMAP.md`, `CITATIONS.md`, `research/README.md`, `src/README.md` |

---

## 8. Risks and rollback

| item | risk | mitigation / rollback |
| --- | --- | --- |
| P1 benchmark | a TSFM/eval adds a heavy dependency | prefer a small local linear/MLP first; the TSFM is one arm, offline, and droppable |
| P2 gate change | a new procedure could raise the false-promotion rate | verdict-neutrality on the retained runs is proved first; the rule is *stricter* (cross-configuration), never looser; `METHOD.md` records it |
| P3 data fetch | 15m history/quality | step 0 is the audit; a failed audit stops the experiment before any run |
| P4 funding data | availability/staleness | measure-before-build; rejection recorded |
| P5 TTA | a new dynamical element in training | off by default; bit-identical when off; `null`-config golden guard |
| P7 probe | cost (linear in `es`) and an RNG-confounded contrast | a *short* window, ≥3 seeds, paired within-seed contrasts, and a pre-registered rule; the default `es` is untouched and the goldens pin `es = 3` |
| C9 reading layer | a stale "Sharpe band" statement propagating into new docs | §1.8 MC1 is the single authority; the index + registry carry it; a consistency check (`round29-registry.json` ↔ `round29-README.md` ↔ `PLAN-round29.md`) is part of the docs sync |
| any | scope creep back to mechanism variants | §4 is the explicit no-go list, driven by §1 |

---

## 9. What each step can and cannot prove

| step | can prove | cannot prove |
| --- | --- | --- |
| P1 | which model class the constraint is | that any forecast is tradeable |
| P2 | the decision is configuration-invariant and exposure-honest | that a candidate is real |
| P3 | whether 15m reversal survives cost + the honest gate | out-of-sample generalisation past the sample |
| P4 | whether carry is an independent sleeve | future funding availability/quality |
| P5 | that continuous adaptation removes the cadence step | that adaptation creates edge |
| P6 | whether sizing adds to a positive skill | anything, if the primary has no skill |
| P7 | whether member count moves skill/diversity/effective capacity (and at what cost) | that any `es` is tradeable; it cannot separate capacity from diversity |

---

## 10. Definition of done for round 29

1. The P1 benchmark table exists with a signed conclusion and a branch recorded in
   `RUN-ANALYSIS.md`.
2. The P2 configuration-robust gate and exposure matching are implemented, pinned, and
   **verdict-neutral on the retained runs** (with `sig-accel`'s 0-bps promotion killed
   by the rule).
3. P3 and/or P4 have a **measured** verdict (including a documented rejection), with
   the new data audited through the existing path.
4. If P5 is built, its cadence-invariance is measured and the goldens are unmoved.
5. If P7 is run, the `es` sweep table exists with a pre-registered verdict; the default
   `es` is **unchanged**, and no golden fingerprint moved.
6. The §1.5 correction (§1.8 MC1) is reflected wherever the hurdle is stated
   (`RUN-ANALYSIS.md`, the index, the registry), and the index and the machine-readable
   registry are in lockstep.
7. `METHOD.md` §10 (configuration) and `DESIGN.md` §6.1 (the round-29 addendum) record
   the decision-procedure changes; `CITATIONS.md` + `research/round29-*.md` carry the
   bibliography.
8. No golden fingerprint moved (unless an explicit, documented, test-pinned re-freeze).
9. The round-29 coherence corrections are in place: §1.3's residual / rank-IC /
   rank-book numbers, MC3's cost range, MC4's citations, the §1.5 provenance, and the
   index + registry in lockstep (the `round29-*` validation passes).

---

## 11. Research bibliography for this plan

- [`docs/research/round29-README.md`](research/round29-README.md) — **the consolidated
  index**: the decision table, the **conflict register** (C1–C10), the measured coherence
  checks (MC1–MC4) and the bottleneck evidence card. Machine-readable mirror:
  [`round29-registry.json`](research/round29-registry.json).
- `docs/research/round29-model-class.md` — forecasting architectures (linear/MLP >
  from-scratch transformers; small pretrained TSFMs; the Red Queen's Trap).
- `docs/research/round29-crypto-edges.md` — short-horizon reversal, crypto factor
  models, funding/basis, **and this round's 1h coherence measurement**.
- `docs/research/round29-adaptation-and-regime.md` — test-time adaptation, online
  changepoint/regime, universal-portfolio baselines, turnover theory.
- `docs/research/round29-evaluation-robustness.md` — Sharpe vs sampling frequency,
  publication/selection bias, configuration-robust protocols, exposure matching, **and
  the measured adjusted-DSR surface (§6 there = MC1)**.
- `docs/research/round29-ensemble-size.md` — **whether `es ∈ {8,16,…}` is worth testing**:
  the code's actual `es`/`forceMin` structure, the cost/diversity/skill evidence
  (`2002.06715`, `2608.16190`, `2609.13954`, `2609.23927`, `2609.24782`, `2203.05482`,
  `2607.08493`), and the gated P7 verdict.
- `docs/research/financial-validation.md` — the project's existing evaluation
  grounding (DSR/PBO/SPA/Romano–Wolf/subsampling/dependence), unchanged.
