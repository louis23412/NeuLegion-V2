<!-- round29-index
round: 29
status: EXECUTED (round 29 -> 30: P1-P4 measured, P5 designed + deferred, P6/P7 closed by G-A; code shipped and pinned)
outcomes: G-A negative, G-B negative, G-C not crossed, G-D open (P5 deferred), G-E closed with P7
plan: ../PLAN-round29.md
notes: [round29-model-class.md, round29-crypto-edges.md, round29-adaptation-and-regime.md, round29-evaluation-robustness.md, round29-ensemble-size.md]
registry: round29-registry.json
raw: [raw/arxiv-sweep-2026-09o.json, raw/arxiv-sweep-2026-09p.json]
dir-ids: P1..P7b, R1..R11, G1..G2
decisions: D1..D11 (PLAN §6)
focus-points: FG1..FG14
gates: G-A..G-E (PLAN §5.2)
verdicts: {keep: [P1,P2,P3,P4,P5,P7,P7b], gated: [P6,P7(second stage)], reject: [R1..R11], not-scheduled: [G1], deferred: [G2]}
coherence-check: 2026-09-24
last-verified: 2026-09-24
-->

# Round 29 — the consolidated index (agent-optimised)

**This file is the single entry point for round 29.** It exists so a future agent can
decide *what to do next* without re-reading five notes and three runs. Everything here is
a pointer or a number with a source; the long-form reasoning lives in the notes. If you
read one file in `docs/research/` about round 29, read this one, then open only the note a
row cites.

Schema: **stable ids** (`P#` priority/direction, `R#` rejected, `G#` not-scheduled/deferred,
`C#` conflict, `MC#` measured check, `B#` bottleneck number, `FG#` focus-point/gotcha; the
plan's *decisions* are `D1–D11`, [PLAN](../PLAN-round29.md) §6), tables with fixed columns,
and a machine-readable mirror
[`round29-registry.json`](round29-registry.json) with the same ids.

---

## 1. THE decision table (direction → evidence → verdict → test → cost)

**Ids here are the priority ids** (`P1…P7b`) plus `R#`/`G#`. The plan's *recorded
decisions* are `D1–D11` in [`PLAN-round29.md`](../PLAN-round29.md) §6 (the older `D#`
direction labels were a colliding namespace and are retired — PLAN D11).

| id | direction | evidence (number / file) | verdict | settling test (acceptance bar) | cost |
| --- | --- | --- | --- | --- | --- |
| **P1** | **Model-class benchmark**: base rate / linear / MLP / zero-shot TSFM / controller on the same walk-forward | controller `brierSkill −0.0738`, `status 'base-rate'`; `2205.13504`,`2101.02118`,`2303.06053`,`2401.03955`,`2511.19272` | **KEEP** (first) | pre-registered: if nothing beats the base rate → features/labels are the constraint; if linear/TSFM beats the controller → architecture is | hours, offline |
| **P2** | **Configuration-robust + exposure-matched gate** (majority pass + catastrophic veto across a cadence grid; cross-family at matched exposure) | Δ Sharpe 1.01244 (p 0.02008) on `testSize`; `BUGS.md` #61 (0.51 vs 0.89 vs 0.004 nonzero frac); `2603.09219` | **KEEP** | verdict-neutral on the 3 retained runs **and** kills `sig-accel`'s 0-bps promotion; fixtures for the cadence-only promotion and the manufactured exposure gap | cheap (reading + fixtures) |
| **P3** | **15-minute reversal** (sign / cross-sectional / vol-scaled) on new bars | `2608.21888` (90 % of 183 Binance pairs at 15m, signs not magnitudes); 1h is empty (rank IC −0.050, rank book break-even −0.042 bps, AC −0.013) | **KEEP** | step-0 data audit is a hard gate; then break-even ≥ the 15m taker cost **and** adjDSR ≥ 0.95 **and** SPA not rejecting, at a majority of cadences | data fetch + ~600× cheaper than the controller |
| **P4** | **Funding/basis carry** as an independent stream | `effectiveStreams ≈ 2.30–2.42 / 8`; one factor = 79.4 % of covariance (residual 20.8 %); `1912.03270`,`2506.08573`,`2605.06405` | **KEEP** | measure-before-build: its increment to `effectiveStreams` must make the best arm's adjDSR clear 0.95 (MC1 bar), else rejected as a breadth purchase | data fetch + a measurement |
| **P5** | **Continuous test-time adaptation** (frozen backbone; normalisation/low-rank params on recent windows) | the level is a function of the retrain cadence (`testSize 15 → 10` moves it 1.01244); `2602.00073`,`2506.23424`,`2601.05975` | **KEEP** | the TTA arm's level is ≈invariant across `testSize ∈ {10,15}`; goldens unmoved with the flag off | ~1 round, off by default |
| **P6** | **Meta-labeling** (size/filter a primary) | AFML ch. 3; `2107.11972`,`2306.09862` | **GATED on P1** | only if P1 finds positive primary skill; then the meta-filter improves net Sharpe at an unchanged DSR floor | not scheduled otherwise |
| **P7** | **`es` capacity probe**: pre-registered sweep `es ∈ {2,4,8,16}` at `forceMin` | `2608.16190` (skill, not decorrelation, governs); `2002.06715` (cost linear in N); `2609.13954`/`2609.23927` (size ∝ effective dimension); live retrieval ∝ `es` but broadcast budgets **÷ `es`** | **GATED on P1 → then KEEP** | if no `es` improves **Brier skill vs the base rate** beyond the seed spread, capacity is not the constraint (closed with a number); ≥3 seeds; report skill **at matched exposure** | short window, ≥4× a controller arm |
| **P7b** | **Size `es` by learning / dimension, or buy members cheaply by weight sharing** | `2607.08493` (learn composition **and size**); `2609.24782`,`2002.06715`,`2203.05482` (many members at ~constant parameters) | **KEEP (design direction)** | — (a design rule, not a run: do **not** hard-code a bigger default) | — |
| R1 | More mechanism variants (a 7th/8th default-off feature) | 6 mechanisms / 3 rounds, **zero** promotions | **REJECT** | — | — |
| R2 | Buy bars/power for the DSR floor | 93 576 i.i.d. bars (single-series, Sharpe 0.1017); independence buys ≈2.3× | **REJECT** | — | — |
| R3 | Cross-sectional sleeve on the **existing 1h basket** | static 1-factor residual **20.8 %** but rank IC **−0.050**, top-eig 0.794, rank-book break-even **−0.042 bps** at turnover 6.10/bar (reversal sign unstable: 1-vs-1 variant −0.29) | **REJECT** | (cheap reopen test: C1) | — |
| R4 | 1h reversal family | AC −0.013; `sig:autocorr` net Sharpe −0.0996; 1h rank book −0.05 Sharpe | **REJECT** | — | — |
| R5 | Change `testSize` as a *fix* | it is a nuisance, not alpha; paired Δ collapsed +0.2164 → +0.0289; a fixed position series re-scored moves Sharpe only ~0.08–0.24 across grids | **REJECT** | (but C8 asks: is "nuisance" itself tested? → ≥3 seeds) | — |
| R6 | Tune the dead zone as a fix | item 5 closed; the real issue is exposure matching (#61 / P2) | **REJECT** | — | — |
| R7 | A bigger / more-evolved **hivemind** (ES population, `legion/evolve.js`) | `2512.15732` (Red Queen's Trap); ES deliberately unimported (`TODO.md` 13) | **REJECT** | (distinct from P7/P7b: member **count** inside a controller, not the ES layer) | — |
| R8 | Relax `K` / the DSR floor to get a promotion | `1612.04535`; Harvey–Liu–Zhu 2016; the floor gives the gate size ≈3.5 % | **REJECT** | — | — |
| R9 | Cross-family Sharpe claims at the shipped dead zone | 0.51 vs 0.89 vs 0.004 nonzero fraction (#61) | **REJECT** | — | — |
| R10 | `es` as a **default increase** | no ensemble-size→skill evidence; cost linear in `es`; `round29-ensemble-size.md` §2 | **REJECT** | (P7 may still *test* it) | — |
| R11 | `es` as a **memory play** ("bigger ensemble holds more data") | the broadcast/injection budgets **divide by `es`** (`lsh.js:200`, `transfer.js:43,245`) | **REJECT** | (P7 measures the net of the × and ÷ effects → C4a) | — |
| G1 | Cross-sectional sleeve on a **wide** coin universe with **conditional/time-varying** factors | `1811.07860`,`1802.03708`,`2106.04028` | **NOT SCHEDULED** | re-enters if P3/P4 produce a reason to search a larger family, or C1's cheap test reopens it | new data + a new interface |
| G2 | **Shared-weight virtual members** (many members at fixed parameters) | `2609.24782`,`2002.06715`; `transfer.js` shares memory but not parameters | **DEFERRED LEAD** | only if P7 shows member count helps | design work |


---

## 2. Measured coherence checks (the "valid data" this round produced)

These are read *directly* from the retained runs / the code — no new run. Each is a
conflict the plan text must respect. **All three runs have `bars = 4320` pooled bars (8
streams: 36 folds × 15 bars in Steps 1/3, 54 folds × 10 in Step 2) and `costBps = 0`.**

### MC1 — the adjusted-DSR hurdle is a **surface**, not a Sharpe band (corrects PLAN §1.5)

Source: `report.json` of the three retained runs (`pooledMetrics`, `dependence`, `familywise.K`).

| run (config) | arm | K | net Sharpe | design effect | effBars | `dsr` (n=4320) | `dsrAdjusted` | promote | its **only** failing reason |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Step 1 (`testSize 15`) | baseline | 3 | −0.1147 | 4.866 | 888 | 0.0922 | 0.1428 | (base) | — |
| Step 1 | `sample-weights` | 3 | +0.0521 | 5.595 | 772 | 0.2618 | 0.2229 | false | mean-fold, DSR, DSR-adj, paired |
| Step 2 (`testSize 10`) | baseline | 2 | **+0.8978** | 2.611 | 1654 | 0.9991 | **0.9584** | (base) | — (crosses 0.95) |
| Step 2 | `label-conservative` | 2 | +0.9267 | 2.663 | 1622 | 0.9994 | **0.9637** | false | **mean-fold Sharpe 0.5146 < 0.7005**, paired (p 0.399), stability |
| Step 3 (`testSize 15`) | `sig-momentum` | 12 | **+1.0848** | 3.624 | 1192 | 0.9989 | **0.7736** | false | **only** DSR-adj |
| Step 3 | `sig-accel` | 12 | **+1.0194** | 2.465 | 1753 | 0.9966 | **0.8608** | false | **only** DSR-adj |

**What this proves.**
1. §1.5's claim that "the dependence-adjusted DSR floor (≈0.95) is crossed at a Sharpe of
   ≈1.02–1.08 on this design" is **false as written** — and its origin is
   `RUN-ANALYSIS.md` §14.2's **round-27** Step-4 journal (`K = 3`, design effect 5.12), which
   §1.5 generalised too far. On the round-28 retained runs both arms inside that band **fail**
   (`sig-accel` 1.0194, `sig-momentum` 1.0848), while the Step-2 **baseline passes at
   0.8978** (K=2, design effect 2.61). The hurdle depends on `(Sharpe, designEffect,
   moment shape, K)` — it is a surface.
2. The **binding term is the design effect**, not multiplicity and not effect size: the
   two highest-Sharpe candidates clear the *unadjusted* DSR (0.9966 / 0.9989 ≥ 0.95) and
   pass the paired-difference and cluster-stability hurdles — they fail **only** the
   design-effect-adjusted DSR. With independent bars they would pass.
3. §1.5's "the best labeller is at 0.10" was the **round-27** labeller (Sharpe 0.1017); the
   retained Step-2 labeller's `dsrAdjusted` is **0.9637** (it fails on the *paired* difference
   and cluster stability, and on the fold-mean hurdle `BUGS.md` #60 — not on the DSR floor).
   The claim was cadence/roster-specific, which is exactly what P2 fixes.
4. Practical consequence for **P4**: the lever is a **less correlated return series**, and
   the acceptance bar is now expressible as *"the new stream must move the best arm's
   `dsrAdjusted` across 0.95"* — anchored by: at `effBars = 4320` (design effect 1)
   `sig-accel`'s `dsrAdjusted` would equal its unadjusted 0.9966 (a pass); at 1753 (design
   effect 2.46) it is 0.8608 (a fail). So the required design effect lies in **(1.0, 2.5)**
   — an *effective stream count* well above the current ≈2.3/8. (The exact required
   `effBars` is not stated here because the deflation hurdle is itself `n`-dependent — see
   `20260924T071546-seed1` and `performance.js#deflatedSharpeRatio`; a two-point bracket
   is used deliberately rather than a fabricated interpolation.)

> **This is the round's most important coherence finding: it *reframes* the diagnosis.**
> The bot's best arms have a **cluster-stable, effect-size-positive** signal that the
> **dependence adjustment** correctly rejects because the return series is ~79 % one
> common factor. The problem is therefore not "no effect"; it is "**no independent
> effect**" — which is exactly what P4 (and the P2 gate) address, and which makes the
> §1.7 one-line diagnosis ("no residual edge") *more* precise, not less.

### MC2 — the pooled-vs-fold-mean disagreement (`BUGS.md` #60) is decision-relevant here

Step 2: `label-conservative` is **better on pooled Sharpe** (0.9267 vs baseline 0.8978)
and **clears the DSR floor** (0.9637), yet is **worse on mean fold Sharpe** (0.5146 vs
0.7005) and is not a significant paired improvement (Δ 0.0289, p 0.399). Two legitimate
aggregations therefore disagree on the same arm. This is the concrete instance behind
conflict **C8** (is the cadence-level effect a nuisance or real?) and behind P2's
configuration-robust rule: a verdict that flips between *pooled Sharpe*, *mean fold
Sharpe* and *paired cluster difference* must be reported across all three, not one.

### MC3 — cost (measured), so the plan's scope is honest

`report.json.candidates[*].elapsedMs`: controller arms **2.57–4.13 M ms** (43–69 min) vs
signal arms **4.27–4.60 k ms** (≈4.5 s) → **≈560–970×** (median ≈600×). `decision.nextRun.measuredPerFoldMs`
19 117–54 902 ms/fold at `es = 4`. An `es = 16` arm is ≥4× that per arm per seed.

### MC4 — structural facts about `es` (code, for C4)

`es = 4` is the operating point (`analyze.js:454`; `useController` default at `:2118` — the plan cites the pre-implementation lines `:415`/`:2009`; see the registry's `coherence_corrections`);
per-member dims are **constants** under `forceMin` (`dimensions.js:10-181`); per-member
retrieval multiplies with `es` (`hivemind/transformer/attention.js:190-192`) but the
broadcast/injection budgets **divide by `es`** (`lsh.js:200`, `transfer.js:43,245`); and an
`es` change is **RNG-confounded** — the live retrieval reader draws `Math.random()` a
bucket-content-dependent number of times (`BUGS.md` #44, the `pca-hash` mechanism). See
`round29-ensemble-size.md` §2.

---

## 3. Conflict register (research ↔ project evidence ↔ status ↔ the test that settles it)

| id | research claim | project evidence / counter | status | settling test & acceptance bar |
| --- | --- | --- | --- | --- |
| **C1** | A cross-section needs **conditional/time-varying** factors on a **wide** universe (`2106.04028`, `1811.07860`, `1802.03708`) | the measured residual is a **static** 1-factor residual of **20.8 %** of variance (not ~1 %), but its next-bar rank IC is only **−0.050** and a rank book breaks even at −0.042 bps; top-eig 0.794 | **OPEN, not scheduled** | **cheap reopen test:** rolling/conditional-factor residual on the same 8×540; reopen only if a rolling/conditional factor model's residual rank IC (or the rank-book break-even at its own 6.10/bar turnover) clears a realistic taker cost |
| **C2** | 15m reversal is pervasive (`2608.21888`) | at 1h there is none (AC −0.013; rank book break-even −0.04 bps) | **GATED (P3 data)** | P3 step-0 audit, then the reversal family; bar: break-even ≥ 15m cost **and** adjDSR ≥ 0.95 **and** SPA not rejecting, at > half the cadences |
| **C3** | linear/MLP/pretrained beat from-scratch transformers (`2205.13504` … ) | the controller is negative-skill and untested against them **here** | **NEEDS TEST (P1)** | the pre-registered P1 rule (two outcomes, both decisive) |
| **C4** | a bigger member pool → more capacity/diversity → more skill | live retrieval ∝ `es` but broadcast budgets ÷ `es`; `2608.16190` says **skill** governs; cost linear in `es` | **GATED (P7 → C4a–C4e in the es note)** | the P7 sweep's table; bar: if no `es` beats the base-rate Brier skill beyond the seed spread, close capacity |
| **C5** | continuous TTA removes the schedule dependence (`2602.00073`) | the level is currently a cadence function (Δ 1.01244, p 0.02008) | **NEEDS TEST (P5)** | A/B fold-replay vs TTA; bar: level ≈invariant across `testSize ∈ {10,15}`, goldens unmoved when off |
| **C6** | a verdict must be configuration-robust (`2603.09219`) | every verdict this programme has made is single-cadence | **NEEDS TEST (P2)** | retrospective on the 3 retained runs (verdict-neutral) **and** `sig-accel`'s 0-bps promotion killed; two fixtures |
| **C7** | exposure matching is required for cross-family claims | `BUGS.md` #61: 0.51 vs 0.89 vs 0.004 nonzero fraction | **NEEDS TEST (P2)** | fixture: the raw dead zone manufactures a spurious exposure gap, the matched rule removes it, verdict-neutral on retained data |
| **C8** | the cadence level-shift is a **nuisance**, not signal | measured at **one seed**; and pooled-vs-fold-mean disagree (MC2) | **NEEDS TEST (new data)** | re-run `testSize 10` at **≥3 seeds**; bar: the level and the sign of Δ reproduce; if not, cadence is noise and the "nuisance" reading is wrong |
| **C9** | the DSR hurdle is a Sharpe level | MC1: it is a surface; the two highest-Sharpe arms fail while a 0.8978 baseline passes; the "best labeller at 0.10" was the round-27 labeller (cadence-specific) | **RESOLVED (doc corrected)** | §1.5 rewritten to state the surface + the per-arm anchors; no run needed |
| **C10** | "~100 % of positive-Sharpe arms is the market" | the P6 overlay ran on **selected** arms, not all | **NEEDS TEST (cheap offline)** | restate the overlay on the **Step-3** journal for every positive-Sharpe arm; bar: common-share ≥ 0.95 for each, else §1.2 is scoped to the arms measured |

---

## 4. The bottleneck evidence card (do not re-derive)

| # | quantity | value | source |
| --- | --- | --- | --- |
| B1 | controller forecast skill vs the base rate | `brierSkill −0.07382`, `accuracySkill −0.13007`, `status 'base-rate'` | `20260924T045601-seed1` |
| B2 | share of positive-Sharpe arms' gross that is net-exposure × market | **~100 %** (common-share 0.958–1.030; cross-section ≈0) | P6 overlay, `RUN-ANALYSIS.md` §15.5b |
| B3 | concentration: top eigenvalue / 1-factor residual / 1h AC / CS rank IC | **0.794 / 20.8 % / −0.013 / −0.050** | round-29 check, `round29-crypto-edges.md` §2 |
| B4 | effective streams / design effect | **≈2.30–2.42 of 8** (design effect 2.43–7.00 across arms) | `report.json.dependence` |
| B5 | the level's sensitivity to the retrain cadence | Sharpe **−0.1147 → +0.8978** (Δ 1.01244, se 0.47504, p 0.02008), one seed | `20260923…` vs `20260924T045601…` |
| B6 | the project's power anchor | `barsToDetectObserved` 93 576 (single-series i.i.d. for Sharpe 0.1017 — **not** the decision's paired lever); required paired clusters 2197 | report `power`/`decision.nextRun` |
| B7 | the binding hurdle for the best arms | the **design-effect-adjusted DSR** only (MC1) | this round |
| B8 | cost ratio controller : signal family | **≈560–970×** | `report.json.candidates[*].elapsedMs` |

---

## 5. Notes registry (id → file → what it grounds)

| id | file | topic | grounds | conflicts |
| --- | --- | --- | --- | --- |
| model-class | [`round29-model-class.md`](round29-model-class.md) | linear/MLP/pretrained TSFMs beat from-scratch transformers; the Red Queen's Trap | P1 | C3 |
| crypto-edges | [`round29-crypto-edges.md`](round29-crypto-edges.md) | 15m reversal, crypto factor models, funding/basis; **the 1h coherence measurement** | P3, P4 | C1, C2 |
| adaptation | [`round29-adaptation-and-regime.md`](round29-adaptation-and-regime.md) | test-time adaptation, online changepoint, universal portfolios, turnover theory | P5 | C5 |
| evaluation-robustness | [`round29-evaluation-robustness.md`](round29-evaluation-robustness.md) | Sharpe vs sampling frequency; publication bias; **majority-pass + catastrophic veto**; exposure matching; **the DSR surface (MC1)** | P2, C9 | C6, C7, C9 |
| ensemble-size | [`round29-ensemble-size.md`](round29-ensemble-size.md) | whether `es ∈ {8,16,…}` is worth testing; capacity vs diversity vs cost; learned/sized `es` | P7, P7b | C4 |

Raw snapshots: [`raw/arxiv-sweep-2026-09o.json`](raw/arxiv-sweep-2026-09o.json) (the
target sweep), [`raw/arxiv-sweep-2026-09p.json`](raw/arxiv-sweep-2026-09p.json) (the
ensemble-size sweep).

---

## 6. How to use / how to refresh

1. **Deciding what to do next** → §1 (the decision table). Every row has a status and a
   settling test; nothing in round 29 is scheduled without one.
2. **Before writing a verdict** → §3 (the conflict register). If a claim you are about to
   make maps to a `NEEDS TEST` conflict, run that test or mark the claim as untested.
3. **Before quoting a number** → §4 (the evidence card) has the canonical value and its
   source; do not re-derive. MC1 in §2 is the authority for anything about the DSR hurdle.
4. **Refreshing the research** → re-run the arXiv sweep (`raw/README.md`) and diff against
   `raw/*.json`; add hits as rows in the relevant note, then update this index + the
   machine-readable [`round29-registry.json`](round29-registry.json) together (they must
   not drift).
5. **Round 29 changes nothing in the code.** The implementation map is `PLAN-round29.md` §7;
   the priorities are §3; the definition of done is §10.

---

## 7. Focus points (gotchas) — the traps that bite an implementer

Mirrors [`PLAN-round29.md`](../PLAN-round29.md) §1.9. Nothing here is a matter of taste;
each is a file+line or a measured number. The go/no-go gates are PLAN §5.2 (`G-A…G-E`).

| id | gotcha | the rule |
| --- | --- | --- |
| FG1 | `forceMin = true` is the production branch — per-member dimensions are constants (`dimensions.js:20-97`) | any `es` result is about the *compact* branch |
| FG2 | two controller constructors: the controller factory (`analyze.js:846`, constructions at `:927`/`:945`) uses `CONTROLLER_MODEL.ensembleSize = 4` (`:454`); the legacy bare path `makeHiveMindModelFactory` (`analyze.js:506`) hard-codes **3** (`:547`) | know which path produced a journal |
| FG3 | an `es` change is **RNG-confounded** (bucket-content-dependent draws, `BUGS.md` #44) | ≥3 seeds, paired within-seed |
| FG4 | `costBps = 0` everywhere and the dead zone is family-relative (#61) | cross-family numbers only at matched exposure; always quote bps |
| FG5 | the DSR hurdle is a surface and `n`-dependent | use MC1 anchors; state `(Sharpe, designEffect, K)` together |
| FG6 | pooled vs mean-fold vs paired disagree on one arm (#60/MC2) | report all three; `meanSharpeDelta` is fold-level |
| FG7 | absolute (`minDsr`,`minDsrAdjusted`) vs relative (`dsrDelta`,`meanSharpeDelta`,`pairedSharpeDifference`) hurdles | name which |
| FG8 | `foldWinFraction`/`positiveFoldFraction` are reported but `gated:false` | do not resurrect them |
| FG9 | `--label-horizon` sets the sample-weight span on non-`triple` runs (#62) | set the span explicitly |
| FG10 | goldens pin a *bare* `HiveMind` at `es = 3` (`golden.test.js:214`), `H_ES = 2` (`controller_invariants.test.js:113`) | an analysis-level `es` change moves no golden — but the goldens do not cover the analysis path |
| FG11 | `modelRetention: 'discard'`, `reuseBase: true`, CRN on | read `timings`/`measuredPerFoldMs`, not an arm's total |
| FG12 | one seed everywhere (`--seed=1`) | no cross-seed claim until ≥3 seeds |
| FG13 | the P6 overlay ran on **selected** arms (C10) | restate it on the Step-3 journal before quoting "~100 % market" as universal |
| FG14 | `barsToDetectObserved` 93 576 is **single-series**; the decision uses the paired clusters (`BUGS.md` #56) | never compare the two scales |

### 7.1 Go/no-go gates (PLAN §5.2)

| gate | after | if | then | else |
| --- | --- | --- | --- | --- |
| **G-A** | P1 | a linear/MLP/TSFM forecaster has positive Brier skill vs the base rate | architecture is the constraint → run P6 and P7 with the new primary | features/labels are the constraint → skip P6/P7, put the round into P3/P4 |
| **G-B** | P3 | the 15m reversal clears break-even + adjDSR + SPA at a majority of cadences | new candidate sleeve; re-scope P4 around it | record the rejection; shift the weight to P4 |
| **G-C** | P4 | the carry stream moves the best arm's `dsrAdjusted` across 0.95 | carry is a real independence purchase | rejected as a breadth purchase, recorded with the measured correlation |
| **G-D** | P5 | the TTA arm's level is ≈invariant across `testSize ∈ {10,15}`, goldens unmoved | the cadence step is retired as a free parameter | record that TTA does not remove the configuration dependence |
| **G-E** | P7 | some `es` improves Brier skill vs the base rate beyond the seed spread | record the `es`-skill curve and re-open the architecture question (couples to G-A) | capacity is not the constraint; close `es` with a number, default stays 4 |

---

## 8. Implementation verdicts (round 29 → 30) — the plan is EXECUTED

**This index was the planning artefact; this section is the outcome**, kept here so the index,
the registry and the plan stay in lockstep. Authority for every number: `RUN-ANALYSIS.md` §16;
the execution log (ledger, decisions, per-item outcome) is
[`../round29-IMPLEMENTATION.md`](../round29-IMPLEMENTATION.md).

| id | verdict | measured outcome | artifact |
| --- | --- | --- | --- |
| **U0** | **DONE** | the market-neutral overlay, restated on the Step-3 journal for every positive-Sharpe arm: `sig-momentum` common-share 0.9582, `sig-accel` 1.0291 — but `sig-range` 0.6095 / `sig-agreement` 0.6570 keep real cross-sectional content, so the plan's *universal* claim is false as stated (it holds for the two arms that carry the level) | §16.1 |
| **P1** | **NEGATIVE BRANCH (G-A)** | no class has material positive Brier skill vs the base rate (ridge best, skill ≈ 0 / −0.0008; MLP decisively worse; the TSFM arm not run — I3) ⇒ **features/labels are the constraint** ⇒ **P6 and P7 are CLOSED** | §16.2 |
| **P2** | **KEEP, shipped + wired** | exposure matching is verdict-neutral on every retained run; the pipeline's only manufactured promotion (§15.5c `sig-accel`) dies at matched exposure (adjDSR 0.9584 → 0.7925); four net-positive arms fail **0/3** on the `{10,15,30}` cadence grid; and the gate is now wired into the driver as opt-in `--cadences` / `--exposure-match` passes (`report.configurationRobust` / `report.exposureMatched`), default-off and pure post-processing | §16.3 |
| **P3** | **NON-ACCEPTANCE** | the documented 15m reversal is **real** (lag-1 AC significantly negative in 6/8 symbols; directional accuracy 0.5191 on 639 992 bars; momentum control mirrors it) and **economically inaccessible**: break-even **0.32–0.56 bps** vs 5–10 bps taker; interval-correct net Sharpe @5 bps **−15.9**; every arm promotes 0/3 at real cadences | §16.4 |
| **P4** | **ACCEPTANCE (its own criterion) / G-C does not cross** | 57 939 funding rows, **0 audit problems**; pooled delta-neutral carry **9.78 %/yr at 0.84 % vol** (Sharpe 11.6, maxDD −3.3 %); correlation with the price basket **+0.003** (the bar was 0.29–0.52) and effective streams **1.25 → 1.54 of 9** — but the jackknife `designEffect` is serial-dominated (5.226 → 5.228), so no arm's `dsrAdjusted` crosses 0.95. Both readings recorded | §16.5 |
| **P5** | **DEFERRED — gate G-D stays OPEN** | nothing measured. Survey found the shipped controller already adapts continuously *within* a fold; the change belongs in the golden-pinned `gradients.js`, so the freeze-by-construction design + acceptance test + the measured cost wall (a controller A/B is 9.1 s at 1 stream/100 bars/4 folds/2 arms) are recorded for a later round | §16.6 |
| **P6 / P7** | **CLOSED by G-A** | not run (the gate is the point) | §16.2 |
| tests | **GREEN** | all **31** browser entries, **0 failures**, ~2 558 assertions; `golden.test.js` 23/0 (no fingerprint moved); `analysis` 621, `analyze` 269, `candles` 192, `fetcher` 111 | tracker §3 |

**Gate outcomes:** G-A → ELSE branch (measured). G-B → ELSE branch (measured, full
non-acceptance). G-C → ELSE branch (measured: breadth purchase by DSR, independence
purchase by correlation/effective streams). G-D → **OPEN, not measured** (P5 deferred).
G-E → not run (closed by G-A).

**Index/registry lockstep.** `round29-registry.json` carries the same verdicts:
`status` now reads *implemented*, every gate has an `outcome`, every P1–P5 direction has an
`outcome` + artifact, and an `implementation` block mirrors this table. **Doc-numbering note:**
the plan's §5.4 checklist asks for `METHOD.md §10 (configuration)`; that document's own numbering
made the configuration decision **§10** (its §8/§9 were the round-28 entries) — the mapping is
recorded here and in the registry's
`implementation.methodDocNote`.

**Bugs found while implementing + auditing (all fixed, `BUGS.md` #63–#68):** the exposure-match target read
off a field a journaled report does not carry (#63); the carry sleeve compared against the
*concatenated* panel length and so excluded from every real run (#64); the restatements
double-appending the sleeve and losing the price-only dependence (#65); the epoch-ms/ISO-string
timestamp mismatch that made the sleeve identically zero, plus the funding audit's candle-style
"still-forming period" rule (#66); and (found by the round-5 final cleanup on a native driver) the fold worker invoking the pre-built model as a factory plus the driver dropping `sampleWeightHorizon` from the dispatch request, so every `--concurrency > 1` run failed and a `--sample-weight-horizon` run would have desynced silently (#68).

**Post-implementation audit (rounds 1–4; `../round29-IMPLEMENTATION.md` §7).** Four independent
coherence/sanity/bug passes were run after the round landed. Round 4 added the one substantive
integration fix: the P2 decision primitives were *tested but not reachable from a run*, so they were
wired into `analyze.js` as opt-in, default-off passes (`--cadences` → `report.configurationRobust`,
`--exposure-match` → `report.exposureMatched`), which delivers `PLAN-round29.md` §7's `src/analyze.js`
rows and makes `METHOD.md` §10's "shipped decision procedure" wording literally true; the same pass
fixed three stale counts in the `test/lock-registry.js` notes (`guards` 58→65, `observer` 75→76,
`analyze` 245→269) and moved the ledger total 2547 → **2558** (analyze 258 → 269) across every
authority file. All 30 browser entries are green at **2558 / 0**, with `golden.test.js` 23/0
(DoD item 8).


