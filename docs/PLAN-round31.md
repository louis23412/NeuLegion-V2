# PLAN — round 31: the pivot — stop predicting, start allocating

**Status: PARTIALLY IMPLEMENTED — the V2 layer (V2.0/V2.1/V2.2) has LANDED and the W1 measurement ports (R1/R2/R3, rounds 32–33) have LANDED; round 34 landed four W6 fixes (F-61/F-69/F-70/F-76) plus the W3 `analysis/portfolio.js` foundation (ledger 2768 → 2780, harness green); round 35 landed the F-71/F-74 shipped-path fixes (ledger 2780 → 2814, harness green); rounds 36–39 landed the A2 hurdle, the G2 book scorer, the sleeve composer, the L10-cs exclusion and the A18 readouts (ledger 2814, harness green); round 40 landed the driver-side sleeve composition (ledger 2814 → 2824, harness green); round 41 landed the G5 conjunction scorer (ledger 2824 → 2830, harness green); round 42 landed the carry view builder (ledger 2830 → 2834, harness green); round 43 fixed the builder's legs separation (ledger 2834 → 2836, e74 green); round 44 landed the `--sleeve` run mode (ledger 2836 → 2843, harness green, e75 green). The W4/W5 ports and the remaining W6 rows have not.** Authored from the end-to-end read of the shipped project
(`src/NeuLegion-master/NeuLegion-master`), the lab (`src/NeuLegion-lab`, 81 findings, 19 leads, 66
cycles) and the operator's 2026-09-26/27 run corpus (`src/runs`, CYCLE-065 / `RUN-ANALYSIS.md` §18).
**What has changed:** the additive V2 contract/registry layer and the three pinned sleeve plugins
are in the repo (`src/core/**`, `src/plugins/**`; `MIGRATION-V2.md`, `ARCHITECTURE-v2.md`); no legacy
module was edited and no golden moved. **What has NOT changed:** every W1/W4/W5/W6 measurement port
and the shipped-path fixes (F-61, F-69, F-70, F-71, F-74, F-76, L10-cs) — those are still TODO. The
plan deliberately proposes changing the *core scope* (`DESIGN.md`) and the *lock model*, because the
evidence says the current direction cannot produce a positive result.

**Direction in one line.** Stop spending the programme's compute on a learned model whose central
premise — that a hivemind of tiny transformers can predict the next bar — is measured false; re-scope
NeuLegion as a **portfolio of measured structural sleeves** (carry/funding dispersion, cross-sectional
positioning fade, OI-change) allocated by a **risk layer** and scored over the **full history** by the
honest gate; demote the hivemind to a **modular, default-off** research layer with a real promotion
bar, and change the locks from "bit-exact whole engine" to "interface contract per component" so
memory/ensemble styles can be swapped and tested cheaply.

> **Companion: [`ARCHITECTURE-v2.md`](ARCHITECTURE-v2.md).** The operator's V2 question (make the
> *whole system* modular; a NeuLegionV2 + Lab v2) is answered there: a full audit of which components
> are old vs cutting-edge **proved** designs, a modularity scorecard for every subsystem, the V2
> contract/registry/lock design, and the strangler-fig migration (V2.0–V2.4) that folds into this
> plan's W1–W6. Verdict: **partial accept** — contract-first extraction, not a blank-slate rewrite.
> W2/W3 = V2.2, W4 = V2.0/V2.3; W1/W6 land regardless.

---

## 0. The evidence in one page

Eight measured facts, each from the project's own tests or the operator's own runs, jointly fix the
situation. (Sources: `NL-BENCH`/`NL-MECH`/G-A, `RUN-ANALYSIS.md` §10/§13/§16/§17, `src/runs` §18,
`FINDINGS.md` F-01…F-80.)

| # | fact | the number | consequence |
| --- | --- | --- | --- |
| 1 | **No model class predicts the target.** | base-rate, linear, MLP and the controller all have Brier skill ≤ 0 on the shared causal features | the learned layer is a passenger, not a forecaster |
| 2 | **No memory/ensemble mechanism moves the score.** | 4 tested (surprise, homeostasis, pca-hash, broadcast) ≈ baseline | the architecture is not the constraint; the *target* is |
| 3 | **The shipped controller is negative-skill and negative-return.** | baseline net Sharpe **−0.1147**, brierSkill **−0.0751**, break-even −2.58 bps; the corpus's 7 runs repeat it | the current `baseline` is worse than flat |
| 4 | **The only arms that "win" are a window artefact.** | `sig-momentum` **+1.0848 / 14.6 bps at 600 bars** vs **+0.110 over 53 500** (F-01/F-13); the runs confirm it | the verdict is read off 25 days; the deflation never points at time |
| 5 | **The binding constraint on the project's own verdict is power, not edge or cost.** | effective streams **1.73 of 8**, design effect **3.62–4.87** | fix the panel / buy independence before anything else |
| 6 | **A real, independent, tradable return source exists — and is not in the repo.** | carry dispersion book: net@4 **+6.86 OOS**, break-even ~25 bps, corr **0.003** with the price basket, ~**$11–20 M** OI-bound; toptrader fade net@4 **+1.14**, ~$12–22 M | the lab has the sleeves; the repo has no sleeve, no book, no portfolio |
| 7 | **The evaluation harness is best-in-class.** | dependence-adjusted DSR/jackknife, SPA/StepM, subsampling, no-lookahead audit, PBO, cost ladder, decision report — all exact | the harness is the durable asset; keep and extend it |
| 8 | **The shipped path still carries arithmetic/reading defects.** | F-61 (`carryOnBarGrid` sub-8h mis-scale, **3.03×** on SOL, flatters), F-69 (ridge anchored at 0.5), F-70 (`hitRate`), F-71 (L10-bs/bu/bv), F-76 (cost-blind sweep), F-74 (`panelFor` vacuity), L10-cs (sleeve in the paired test) | fix before any new number is believed |

The honest summary: **a large, beautifully engineered, inert model wrapped around a world-class
measurement harness, pointed at a 25-day window.** The edge that exists is *structural* (carry,
positioning, cross-section) and the machinery to hold it — a portfolio — is not built.

---

## 0.5 Audit amendments (2026-09-28)

A six-cycle red-team audit of this plan and of `ARCHITECTURE-v2.md` — logical/coherence checks, a
code-grounded friction/pollution map, and five professional viewpoints — is in
[`AUDIT-round31-v2.md`](AUDIT-round31-v2.md). Its reconciled decisions are folded in here. The
direction is unchanged; four load-bearing claims are corrected.

| id | correction |
| --- | --- |
| **A1** | The diagnosis is **"window-concentrated edge + power-limited panel"**, not "power is the binding constraint". New gate **G1b**: W1's full-history re-measurement runs **first** and decides whether W5 is needed at all. |
| **A2** | New **factor-neutral hurdle**: a promotion requires a positive Sharpe **after removing the panel's first principal component**, with raw and neutral Sharpe both reported. Without it the gate can promote market beta. |
| **A3** | The three carry objects are separated: the lab's **R7/R8 books**, the repo's **plain funding stream** (the P4 object), and the **ported sleeve book** (W2's deliverable). **W2 + W3 + W5 + A2 are jointly necessary**; W2-alone-failing is expected. W5.1 requires the **L10-cs** fix, and the sleeve enters as a **book**, not a raw panel stream. |
| **A4** | The sleeve port pre-registers a **frozen spec + a held-out span + a data-identity check + a decay test + a capacity-realisation test**. A failure is a *result*, not a re-tune. |
| **A5** | The **product is the sleeve book + the gate**; the **model rebuild is a research deliverable, off the critical path** to G5. |
| **A6** | W4b is a **pre-registered hypothesis with a falsifier** ("a learned forecaster beats a causal EWMA on next-period realised vol, OOS, at matched exposure"), not a promise. |
| **A7** | Headline: *stop predicting **direction**; predict only what is predictable.* |
| **A8** | **G5 tightened** to a conjunction: positive full-history net Sharpe at a **maker-aware** cost, ≥4/6 positive blocks, `dsrAdjusted ≥ 0.95` at the pre-registered K, **factor-neutral**, within the **OI/capacity bound** on the clipped-trailing-median schedule, and a documented **decay** check — all on data the frozen spec did not select on. |
| **A9** | Fallback branch: if every sleeve fails the gate, the negative is recorded, the harness + sleeves stand, the reversal family stays PARK, and the model search is **not** re-opened. |
| **A10** | Full-history scoring is **signal/sleeve-only** (the model keeps `--bars`; the controller is ~600× the cost per variant). |
| **A17** | Retire or explicitly validate the noise mechanisms — sample weights (inert), homeostasis (negative), the broadcast (off-path), and the specialization/trust/adaptive-LR stack (the audit's P3/P4/P6). Plain optimizer first, then re-baseline. |
| **A18** | Every sleeve acceptance adds a **crowding/decay and regime/tail stress** requirement. |
| **A19** | **No full-history laundering**: an arm with a data-selected parameter is excluded from the full-history score (or scored under the same expanding-window rule that selected it). |
| **A21** | State the prior: G5 passing on the first port is ≈⅓; the floor deliverable is the harness + the sleeves + the negative result. |
| **A22** | The **legion survives as a V2 runtime/scheduler** (many learner slots, the vault, the observer) — not the product's alpha source. |
| **A23** | **`SIGUP_CANDIDATES` → PARK/DROPPED** (`DROPPED.md`): the run corpus measured all five at K=6 and none promotes; `sig-network-momentum` is VACUOUS. |
| **A24** | **Wire-or-drop the LSH upgrades** (`multiprobe`/`querymod`/`binarypc`/`bitweight`): route the scored read through `_getGlobalLSHCandidates`, or mark them PARK and stop investing (`BUGS.md` #44). |

**The single most important correction:** do not sell W5 as the fix before W1 has re-measured the arms
on the full history — and require factor-neutrality before anything is called an edge.

---

## 1. The weakest spots (ranked by leverage)

Ranked by *how much the project's decision changes* if fixed, not by elegance. `J`-ids are
`THEORY.md` §2's joints; `W`-ids are the workstreams in §3 that fix them.

| rank | weak spot | why it is the weakest | fix |
| --- | --- | --- | --- |
| 1 | **J1 the verdict is read off 25 days**, and **J2 no window-robustness statistic** | the project's own DSR punishes "best of K variants" but never "best of N windows"; every promotion in the corpus is this artefact | **W1** |
| 2 | **J5 there is no portfolio or risk layer** | the project cannot hold its only measured positive result; positions are a fixed ±1 clamp on a z-score, no book, no vol target, no sleeve combination | **W2 + W3** |
| 3 | **J6 the model has no job description** | it is asked to predict the sign of the next bar — the least predictable target available — and fails; the memory/ensemble layers amplify a void | **W4** |
| 4 | **J3 the panel is one factor** | ~79 % of the 8-stream covariance is one factor, so the design effect is ~4× and the gate rejects every arm | **W5** |
| 5 | **J4 cost/execution is a run option, not a first-class input** | every headline number is gross-at-zero-cost; the reversal edge (1.5 bps) dies silently and the momentum arms die at 2 bps | **W1 + W3** |
| 6 | **the decision gate is knife-edge near its own resolution** (F-62) | a single design effect at C=36 spans **0.644–1.452**, so a verdict inside ~±0.25 of the `>1` gate is not resolvable; the runs show verdicts flipping on a sleeve | **W1 + W5** |
| 7 | **shipped-path arithmetic/reading defects** | F-61 flatters the carry sleeve; F-69 makes the benchmark partly an output-map comparison; F-70/F-71/F-74/F-76/L10-cs misreport | **W6** |
| 8 | **the lock model freezes the whole engine** | 11 golden fingerprints across 17 bit-exact bags mean any memory/transformer experiment is a whole-engine re-freeze, so the very research the design exists for is economically forbidden | **W4** |

The single most important sentence: **spots 1–3 are not bugs — they are the design.** `DESIGN.md` is
frozen around the assumption that the learned model is the product. The evidence says the product is
the harness + the sleeves. Round 31 changes the scope.

---

## 2. The pivot: the new core scope

`DESIGN.md` is "frozen scope". This plan proposes an explicit, documented **re-scope** (the user owns
the locks, so this is a decision, not a violation). Nothing is deleted; the model is demoted from
"the product" to "an optional layer behind a gate".

| | current design | round-31 design |
| --- | --- | --- |
| **the product** | a learned controller that emits a directional signal | a **portfolio** of structural sleeves + the honest gate |
| **the default model** | `controller` (tiny-transformer ensemble) is the baseline candidate | the baseline is the **best zero-parameter reference** (carry + fade + OI mix, or buy-and-hold where appropriate); the controller is **default-off** |
| **the model's job** | predict `P(next bar up)` | (a) volatility / regime / sizing *if it beats EWMA* (L09/F-16), else (b) a gated research layer; **never directional alpha as the premise** |
| **memory** | 4 fixed banks + LSH, bit-exact | a **`MemoryBank` plugin interface** with the 4 banks as the first plugins; golden per-plugin, not per-engine |
| **decision** | 600-bar walk-forward at a single cost | full-history model-free scoring + a block-Sharpe ladder + a cost block, by default |
| **breadth** | 8 correlated Binance majors | the basket **plus** the carry sleeve, the positioning metrics and (new) other venues / frequencies |
| **the asset** | the model | the **harness** and the **sleeves** |

The new pipeline:

```
data (OHLCV + funding + positioning, many venues/freqs)
  ├─► SLEEVE LAYER (structural, pinned, measured)          ← the edge lives here
  │     carry-flat (basis-marked)   carry-dispersion (rank)
  │     toptrader fade              OI-change blend
  ├─► RISK / PORTFOLIO LAYER                                ← new (analysis/portfolio.js)
  │     per-symbol cap 1/k, no-trade band, inverse-vol, OI schedule,
  │     fixed-split joint sizing, block-Sharpe ladder
  ├─► MODEL LAYER (optional, default-off)                   ← demoted
  │     MemoryBank plugins + ensemble + evolution; job = vol / regime / size
  └─► HONEST GATE (keep — the asset)                        ← extended
        full-history scorer, dependence-adjusted DSR, SPA/StepM,
        no-lookahead audit, cost ladder, decision report
```

---

## 3. Workstreams

### W1 — Make the decision sound. *(R1/R2/R3; no promotion needed; highest EV)*

The lab's `FOLD-BACK` R1–R3, ported as one small round:

1. **A model-free long-sample scorer.** `--history=full` (or `--bars=full`) bypasses `readCandles`'
   tail slice for **signal-only** arms (they are pure and cheap; the model keeps `--bars`). A
   contiguous scorer is equivalent to the walk-forward path for a parameter-free signal (F-13), and
   the dominant cost is `poolReports`' dependence estimate (~155 s at 3 562 folds, F-14), so bound
   the cluster count or keep the long-sample path dependence-free.
   **Status (round 33): PORTED.** `analysis/walkforward.js#scoreSignalFullHistory` + `poolSignalFullHistory`
   + `buildFullHistoryBlock`, wired as the opt-in `--history=full` driver mode (`analyze.js` records
   `history` in `run.json`/`report.json` and renders `full-history` lines; default reports are
   byte-identical). The pooled row carries no raw series; the long-sample path is deliberately
   dependence-free (the F-14 cost); model arms land `{available:false}` per audit A10.
   `walkforward` 74 → 83, `analyze` 280 → 286, ledger 2753 → 2768.
2. **`blockStability`** — split the scored series into k disjoint windows, report each window's
   Sharpe, the positive fraction and the min/max; add it to `pooledMetrics`/the decision block and
   make it a gate input. This is the cheap statistic that catches J1 at the source.
   **Status (round 32): PORTED.** `analysis/walkforward.js#blockStability` (from the lab's
   `e2_arm_sweep.js`, same layout/k=6), wired into all three report builders over the price-only
   panel, rendered as the `blocks:` line, and available as the default-off `minBlockPositiveFraction`
   gate hurdle (`walkforward` 63 → 74 checks, ledger 2741 → 2753 with the R3 line below). R1 is ported in round 33 (see item 1 above).
3. **The cost block by default** — full-history break-even and `netSharpe` at 5 and 10 bps, not only
   the ladder at the run's single `costBps`.
   **Status (round 32): reporting half PORTED.** The ladder already restated every candidate at
   [0, 2, 5, 10] bps; the rendered lines now name each candidate's net Sharpe (`analyze` 279 → 280).
   The full-history half belongs to R1 below.
4. **Gate fragility (F-62).** Report the subsampling/block CIs (the repo already ships
   `subsamplingSpa`/`subsamplingStepM`, `neweyWestSE`, `politisWhiteBlockLength`) beside the
   jackknife, and require the verdict to be stable across the block ladder. A verdict inside the
   estimator's own resolution is not a verdict.

**Falsifier:** if the full-history readout agrees with the 600-bar readout, F-01 is wrong and W1 is
unnecessary.

### W2 — Port the structural sleeves as first-class citizens. *(the only measured positive results)*

The lab's `prototypes/port.js` already is one pure, validated module (`clipWeights`, `bandWeights`,
`cleanBook`, `SLEEVE_SPECS`, `MIN_TRAIN_PERIODS = 2555`), reproduced 5/5 across three sleeves (F-60).
**Port it, do not re-derive it.**

| sleeve | spec (pinned) | measured | size |
| --- | --- | --- | --- |
| **R4 carry-flat** | basis-marked (`spotRet − perpRet + funding`), inverse-vol across symbols | Sharpe **4.54–4.65**, DD 7.96 %, r 0.09 | OI-limited (~$7–69 M); essentially free to trade |
| **R7 toptrader fade** | EWMA(0.05) weights, strict 12.5 % cap, **no band** | net@4 **+1.14**, break-even 109 bps | ~$12–22 M (min-of-ratio, clipped schedule) |
| **R8 carry dispersion** | rank funding, EWMA λ frozen on ≥2.3 y (**0.02**), cap `1/k`, **+ no-trade band** | net@4 **+6.86 OOS**, fee-robust to 10 bps | ~$11–20 M (OI-bound, clipped trailing-median) |
| **L19 OI-change** *(optional)* | fixed 50/50 λ blend + band eps≈0.03 | net@4 ~0.9, positive every year 22–26 | standalone only; does **not** add to R8 |

Code surface:
- `analysis/carry.js`: add `carryBookReturns(rows, spotLookup)` (basis-marked) and **fix
  `carryOnBarGrid`** (W6 / F-61).
- `analysis/portfolio.js` (the round-30 `C-BREADTH` slot): the sleeve/portfolio layer.
- `data/`: fetch the `futures/um` metrics (OI + toptrader ratio) into a `POSITIONING_MANIFEST`,
  alongside the existing candle + funding manifests.
- `analyze.js`: a **sleeve run mode** (sleeves are not `controller` candidates; they are books scored
  by the same metrics), reported with turnover, break-even, block ladder and the joint capacity.

**Acceptance:** each ported book reproduces the lab's stored numbers to display precision
(`e52_port_artefact.js` is the reference), then clears the repo's own gate at its pre-registered K.

### W3 — Give the risk layer a home. *(J5)*

`analysis/portfolio.js` owns the shared book post-processing and the risk layer:
- `clipWeights` (cap-and-hold, no renorm), `bandWeights` (per-symbol no-trade band), `cleanBook`
  (cap then band) — from `port.js`;
- inverse-vol / risk-parity weighting, vol targeting (L09/F-16: an EWMA is the forecaster; the level
  is not banked), and the **cost-controlled** objective (F-37: a gross-blind selector dies on churn);
- the **OI schedule** (F-42): target the trailing median, hard-clip at `f·min_j OI_j(t)/|w_j(t)|`;
  never a fixed number, never a smoothed target;
- the **joint** size (F-43/F-44): size a portfolio to the *fixed-split* joint bound; never deploy the
  LP-optimal schedule (it churns 48.5× gross/yr for net@4 0.62).

**Acceptance:** the portfolio reports per-sleeve and joint `netSharpe`, turnover, break-even, the
block ladder, and effective streams — and its `adjDSR` is reported at the pre-registered K.

### W4 — Demote the model, and make memory a plugin. *(J6; the unlock the user asked about)*

**The honest premise.** `NL-MECH` (4 mechanisms ≈ baseline) and `NL-BENCH`/G-A (no class beats the
base rate) mean that **a memory-style tournament is only worth running against a target that is
actually predictable, or against a job the model can win.** So W4 has two branches, and the second
is the one that can pay.

**W4a — the modular `MemoryBank` interface (enabling, low direct EV).** Change the lock model from
"whole engine bit-exact" to "interface contract per component". Spec:

```js
// src/hivemind/memory/contract.js  (new) — a SKETCH of the plugin contract
export const MemoryBankContract = Object.freeze({
  id: 'string',            // e.g. 'episodic', 'adaptive', 'semantic', 'core', 'ringbuf', ...
  version: 'string',
  write(entry) { },        // store a {mean, variance, size, key, meta} prototype
  read(query, k) { },      // return candidate prototypes (may consult the index)
  decay() { },             // age/forget
  merge(a, b) { },         // combine two prototypes
  consolidate() { },       // promote/evict between tiers
  stats() { },             // diagnostics (counts, variance, LSH consistency)
});
```

- The 4 existing banks become the first four plugins (their current numerics unchanged → each keeps
  its own golden, so enabling/disabling a plugin cannot move another's fingerprint).
- A **registry** (`hivemind/memory/registry.js`) with `registerBank(impl)`; `CONFIG.memoryStack`
  selects the active stack. Default stack = today's behaviour, bit-exact.
- A **memory-style tournament harness**: a small, pre-registered experiment that swaps a bank and
  scores it on a target, with the same gate discipline as the signal family.

**W4b — give the learner a winnable job (the branch that can pay).** The one documented
predictability in returns is **volatility**, and F-16/L09 already showed a causal EWMA is the
forecaster to use. So the model's only defensible new target is **auxiliary**: next-period realised
vol, regime/change-point, and **position sizing** on the sleeves. **The model must beat EWMA/the
zero-parameter sizer out of sample at matched exposure, else it stays out of the default path.**
(Meta-labelling — `P(the rule's trade pays)` — is closed negative by F-35; do not re-open it without
a genuinely new feature family.)

**Do not** run a memory-style tournament against the directional target. That is the exact
re-tread the last four mechanisms already falsified. It is legitimate as *research the user wants*
(§4 gives the harness), but it is **not** on the path to a positive result, and the plan should say so.

**Acceptance:** the default run's `baseline` is a zero-parameter book (or the model is default-off);
the locks registry is re-built on the plugin contract (per-plugin golden, no whole-engine freeze);
and a promotion requires the model to beat the reference OOS at matched exposure.

### W5 — Buy independence. *(J3; the only lever that raises every arm's DSR at once)*

Cheapest first:
1. **The carry + positioning sleeves as panel streams** (already measured: carry corr **0.003**; fade
   corr with carry **−0.001**). The runs show the production face of this and its one bug (L10-cs: the
   funding sleeve enters the *paired* test — fix it in the same change).
2. **Cross-sectional demeaning as a construction flag (R5).** F-03: design effect **4.92 → 0.39–0.60**,
   effective streams **1.47 → 14–19**. It buys *power*; hold it ready for the sleeves that have an edge.
3. **Broader basket / other venues / other asset classes.** The wall is cross-stream correlation, not
   bar count. New fetch required (Bybit/OKX/Binance USDT-M beyond the 8 majors).
4. **Multi-frequency panel** (1h + 4h + 15m): may decorrelate the *serial* component the jackknife is
   dominated by.

**Acceptance (G3):** effective streams ≥ 2.5 of 9 and design effect ≤ 3 → the portfolio's `adjDSR ≥
0.95` at the pre-registered K. Track the four numbers (`designEffect`, `effectiveBars`,
`effectiveStreams`, `meanPairwiseStreamCorr`) every run.

### W6 — Fix the shipped-path arithmetic and reading defects first.

These are preconditions for believing any new number (all are lab rows with synthetic-ground-truth
witnesses; fix the **shipped-path** ones first):

- **F-61** `analysis/carry.js#carryOnBarGrid` — bucket rows or divide by the observed interval; the
  sub-8h mis-scale flatters the sleeve 3.03× and `auditFundingProblems` is blind (L10-ab/ac).
- **F-69** `analysis/benchmark.js` — restore `ybar` in `predictRidge`; unbounded output map for a
  model-class comparison (L10-bl/bm/bo).
- **F-70** `analysis/backtest.js#hitRate`/`scoreFold` (L10-bq/br).
- **F-71** `analysis/features.js` — L10-bs (zero-dispersion guard), L10-bu (network self-skip),
  L10-bv (regime gate window).
- **F-76** `analysis/holding.js` — thread `costBps`; make `requireCleanAudit` applicable (L10-cg/ch/ci).
- **F-74** `analysis/world.js#panelFor` (L10-cc) and **L10-cs** (`walkforward.js#clustersOf`) — the
  audit must perturb the price-only series while the DSR uses the extended panel.
- **L10-cj/ck** `analysis/replication.js`; **F-78/L10-cl/cm** `analysis/dependence.js`;
  **L10-ca/cb** `analysis/streams.js`; **F-75** `analysis/parallel.js`; **F-80** `hivemind/kernels/*`.

**Discipline (adopt the lab's rule):** a claim in a comment is auditable code — pin the guard the
comment promises with a **synthetic ground truth a real dataset may not contain**. Every re-freeze is
deliberate and documented.

---

## 4. The `MemoryBank` unlock — interface + test protocol

(Concrete, because the user asked for it. EV caveat: W4a is *enabling*, not a path to PnL, unless it
is pointed at W4b's aux target.)

**Interface.** One contract (`write/read/decay/merge/consolidate/stats`) + a registry + a
`CONFIG.memoryStack` list. Replacing a bank is a config change, not an engine edit.

**Golden strategy (the key change).** Today `golden.test.js` pins 11 fingerprints over the whole
engine. New rule:
- each plugin gets its **own** fingerprint; the engine's fingerprint is the **compose of the active
  stack's**;
- adding/removing a non-default plugin therefore moves **no** existing fingerprint (default stack
  unchanged);
- `locks.test.js` asserts the contract for every registered bank and that the default stack
  reproduces today's goldens.

**Tournament protocol (pre-registered, gate'd).**
1. Targets, in order of evidence: (a) next-period realised vol, (b) regime label, (c) sleeve
   position P&L (**gated** on F-35 being re-opened only by a new feature family).
2. Each memory plugin runs under the same purged/expanding protocol and the same metrics
   (Brier skill vs the causal base rate, DM, MCS) as `benchmark.js`.
3. A plugin "promotes" only if it beats the **best zero-parameter reference** out of sample, at
   matched exposure, with a positive skill score. Otherwise it is recorded and parked.

**Do-not:** do not test memory plugins against `P(next bar up)`. That target is falsified and
re-testing it is the re-tread the anti-list forbids.

---

## 5. Roadmap & phases

| phase | round | content | gate that closes it |
| --- | --- | --- | --- |
| **P0** | **R31** | W1 (long-sample scorer, block ladder, cost block, gate resolution) + W6 (shipped defects) + W4a **design only** (the contract + registry, default stack bit-identical) | **G1** decision soundness: verdict-neutral on the retained runs; block ladder in every report |
| **P1** | **R32** | W2 (port R4/R7/R8; fix `carryOnBarGrid`) + W3 (`analysis/portfolio.js`: cap/band/vol/OI-schedule) + W5.1–2 (sleeves as streams; demean flag) | **G2** each book reproduces the lab to display precision and clears the repo gate; **G3** effective streams ≥ 2.5 of 9 |
| **P2** | **R33** | W4a **implementation** (plugins + per-plugin goldens) + W4b (the model vs EWMA on vol/sizing) + W5.3–4 (broader/other-venue/multi-frequency basket) | **G4** model beats the reference OOS at matched exposure, else default-off; **G5** the decisive portfolio run |
| **P3** | ≥R34 | iterate the **portfolio** (new sleeves, allocation, capacity), not the model | a bankable positive result |

**Gates.**
- **G1 (decision).** `blockStability` + the full-history column + the cost block land; verdict-neutral
  on the four retained runs; the gate's verdict is stable across the block ladder.
- **G2 (sleeves).** Each ported book matches `e52_port_artefact.js` to display precision; the sleeve
  run is a first-class `analyze` mode.
- **G3 (independence).** Effective streams ≥ 2.5 of 9 (from 1.73) and design effect ≤ 3 (from 3.62–4.87).
- **G4 (model).** The controller/plugin beats the zero-parameter reference OOS at matched exposure,
  with a positive Brier skill vs the causal base rate — or it stays default-off.
- **G5 (positive result).** A portfolio with a **positive full-history net-of-cost Sharpe** and
  **≥ 4/6 positive blocks** — the first result the project can bank. This is the milestone the pivot
  exists to reach.

---

## 6. Where the positive results will come from (the chase, ranked)

1. **The carry complex (W2), because it is the only measured, independent, fee-clearing return source
   the programme has.** Carry dispersion net@4 **+6.86 OOS** at ~25 bps break-even; flat carry
   Sharpe 4.5 at 0.2×/yr turnover; the fade net@4 **+1.14**. Everything else measured here reads ≈0.
2. **The portfolio + risk layer (W3), because the sleeves are OI-bound and correlated in the thin
   alts** — the value is a *joint, scheduled, capped* book, not three separate ones (F-42/F-43/F-44).
3. **Independence (W5), because it is the binding constraint on the project's own gate** — the arms
   already have a Sharpe the gate would accept if the panel were not one factor.
4. **The decision fix (W1), because without it nothing else is credible** — and it is cheap and
   needs no promotion.
5. **The model demotion + plugin unlock (W4), because it removes the whole-engine freeze** and lets
   the hivemind be the research object it was built to be — *without pretending it is the alpha*.
6. **The shipped-path fixes (W6), because they are prerequisites** for believing any of the above.

---

## 7. Anti-re-tread (do NOT do these in round 31)

- **Do not** add another controller/memory mechanism against the directional target (NL-MECH, closed).
- **Do not** search for a better model class for direction (NL-BENCH/G-A, closed).
- **Do not** re-open meta-labelling without a new feature family (F-35, closed).
- **Do not** buy more correlated 1h bars (the design effect grows with n).
- **Do not** chase the reversal family to a taker-cost pass (F-32/F-34: break-even 0.3–1.3 bps; a
  maker fill *removes* the edge — only L2/queue data could decide, and that is a data requirement).
- **Do not** read a decision off the most recent window and call it a result (F-01 — the anti-pattern
  that motivates this whole plan).
- **Do not** deploy the LP-optimal joint schedule (F-44: 48.5× gross/yr for net@4 0.62).

## 8. Risks & decision log

| risk | mitigation |
| --- | --- |
| the pivot is read as abandoning the research the project exists for | the model is **demoted, not deleted** — W4a keeps it a first-class, modular research object with its own tests |
| the sleeves are small ($11–22 M) so "positive result" disappoints | state it up front: the whole carry complex is a **~$5–70 M strategy** (F-28/F-41); the win is a *bankable, uncorrelated* return, not size |
| the re-scope moves a golden | W4a's default stack is bit-identical; every re-freeze is deliberate (`W6` + `docs/OPTIMIZATION.md` precedent) |
| the DSR still rejects the portfolio | that is what G3 exists to answer; if the portfolio's adjDSR < 0.95 after W5, the honest conclusion is the edge is not family-wise significant — record it |
| a new venue/frequency introduces a data-integrity defect | extend `candles_audit.js`'s manifest + auditor before any run (the round-29 discipline) |

**Decision record.** This plan supersedes nothing; it *re-scopes* `DESIGN.md`'s frozen set by
demoting the learned layer and promoting the sleeve/portfolio layer. `RUN-ANALYSIS.md` §19 is the
readout for round 31; `MILESTONES.md` M10 is its milestone; the lab's `FOLD-BACK.md` queue (R1–R3,
then R4/R7/R8) is its port source.
