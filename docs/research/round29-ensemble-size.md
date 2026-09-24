<!-- round29-note
id: ensemble-size
status: research (round 29 planning) — no code changed
grounds: [P7, P7b]
keeps: [P7 (gated capacity probe), P7b (learn/dimension-drive es)]
kills: [es-as-a-default-increase, es-as-a-memory-play, fixed-es]
gates: [P1]
conflicts: [C4]
last-verified: 2026-09-24
-->

# Round-29 research note — ensemble size (`es`): is more members worth testing?

**Status: research note (round 29 planning). No code changed.** This note answers one
question that the core hivemind/legion design raises naturally: *should the controller's
per-controller ensemble size `es` be larger (8, 16, …) rather than fixed at 4 — because a
larger ensemble holds more memory, and because a bigger member pool gives more diversity
for knowledge sharing?* It is written to be **falsifiable**, not to endorse the idea:
§2 is what the code actually is, §3 is what the external record says, §4 lists the
**tensions that need a test**, and §5 is the verdict (a gated probe, plus the principled
alternative). Every claim carries a file+line or an arXiv id.

> **Method.** A focused sweep (2026-09-24) was run against the arXiv Atom API for
> `"ensemble size"`, `"deep ensembles"`, `"ensemble pruning"`, `"ensemble diversity"`,
> `"ensemble" AND "scaling"`, `"ensemble" AND "distillation"`, `"mixture of experts" AND
> "scaling"`, plus an `id_list` fetch of the classic deep-ensemble / efficient-ensemble
> papers. Relevant hits only are checked into
> [`raw/arxiv-sweep-2026-09p.json`](raw/arxiv-sweep-2026-09p.json) (the `raw/README.md`
> convention). Note the *pruning* and *MoE-scaling* sweeps returned no transferable
> result for a 4-member CPU ensemble; the load-bearing evidence is the size-theory,
> cost/efficiency and diversity fronts.

## 1. The hypothesis, stated so it can be tested

Three separable claims hide inside "larger `es`":

- **H1 (capacity).** More members → more stored prototypes/knowledge → better forecasts.
- **H2 (diversity).** More members → a more diverse pool → better aggregation and
  knowledge sharing.
- **H3 (cost).** Whatever the benefit, it is affordable at this scale.

H1 and H2 are *mechanism* claims that the code can refute structurally (§2) and a run can
refute empirically (§5). H3 is measurable today from the retained reports (§2.3). The
point of this note is that H1/H2 are **not** obviously true here, and that the literature
does **not** support them as general laws.

## 2. What the code actually is (so the test is well-posed)

### 2.1 The operating point is `es = 4`, forced-minimum dimensions

- `CONTROLLER_MODEL = Object.freeze({ cacheSize: 120, ensembleSize: 4, tier: 1, warmup: 40 })`
  — `src/analyze.js:454`.
- `runAnalysis` uses the controller factory by default: `useController = model !== 'bare'`
  (`src/analyze.js:2118`), and that factory constructs the controller with
  `ensembleSize = CONTROLLER_MODEL.ensembleSize` (`src/analyze.js:846`, constructions at
  `:927`/`:945`) → **the
  round-28 runs, and every A/B report in `RUN-ANALYSIS.md` §15, ran at `es = 4`**.
  (The legacy bare path `makeHiveMindModelFactory` hard-codes `3` — `src/analyze.js:506`,
  the literal at `:547`
  — and is reachable only via the CLI; it is *not* what the reports used.)
- `forceMin = true` on both factories, so **every per-member dimension is a constant**
  (`src/hivemind/persistence/dimensions.js:10-181`): `_numLayers 2`, `_numHeads 2`,
  `_headDim 4`, `_hiddenSize 8`, `_feedForwardSize 32`, `_contextWindow 50`, `_lowDim 4`,
  `_numProjections 6`, `_semanticMaxProtos 75`, `_maxRetrievedProtos 16`,
  `_numRetrievalCandidates 32`. **Consequence: total forward cost is (near-)linear in
  `es`**, exactly the "cost increases linearly with the number of networks" that
  `2002.06715` calls untenable at scale.

`es` is the number of transformer **members** inside one controller (`_transformers`,
`_ensembleWeights`, per-member banks), so "es = 8" means 8 transformers per controller —
**not** more controllers. This is distinct from the *legion* population (`CONFIG.basePop`,
`basePairs`, `structure.js`), which the round-29 plan does **not** propose touching.

### 2.2 What scales with `es` and what *divides* by `es`

| effect of raising `es` | where | direction |
| --- | --- | --- |
| per-member memory banks, LSH buckets, priority indices | `dimensions.js:136-170` | **multiplies** (total capacity ∝ `es`) |
| live retrieval: `_retrieveTopRelevantProtos(transformerIdx, …)` runs **per member** | `transformer/attention.js:190-192` | **multiplies** (aggregate retrieved ∝ `es`, each capped at `_maxRetrievedProtos = 16`) |
| inter-member hive sharing: `numShare`, broadcast cadence | `ensemble/hiveState.js:48-60` | grows with `es` |
| **broadcast candidate budget** — `targetPerEnsemble = ceil(maxCandidates / es)` | `memory/lsh.js:200` | **divides by `es`** |
| **broadcast candidate base** — `max(12, ceil(target·5.5 / es))` | `knowledge/transfer.js:43` | **divides by `es`** |
| **per-member injection** — `personalPerMember = round(maxInjectTotal·0.6 / es)` | `knowledge/transfer.js:245` | **divides by `es`** |
| specialisation percentile index `floor(es·0.05)` | `ensemble/scores.js:159` | changes (0 until `es ≥ 20`) |
| indicator preference flips on parity — `preferMoreIndicators = (es % 2 === 0)` | `controller/features.js:202` | **discontinuous at odd `es`** |

**This is the first coherence tension (C4a).** H1 ("more members → more memory *reach*") is
*granted* on the live retrieval path (per-member retrieval) but *denied* on the
broadcast/injection path (the global budgets are divided by `es`). So an `es` sweep tests
two opposing structural effects at once and **must report per-member bank occupancy and
the aggregate retrieved/proto counts**, not just skill, or a null result is uninterpretable.

### 2.3 Cost at this scale (measured, from the retained reports)

`report.json.candidates[*].elapsedMs` (same data — 8 streams × 36 folds = 4 320 bars):

| family | wall time | note |
| --- | ---: | --- |
| controller arms (`es = 4`, `forceMin`) | **2.57 M – 4.13 M ms** (43–69 min) | `sample-weights` 2.77 M, `label-conservative` 4.13 M |
| signal arms (pure functions) | **4.27 k – 4.60 k ms** (≈4.5 s) | `sig-*` |
| ratio | **≈ 560–970×** (median ≈600×) | controller ≈ 3 orders of magnitude the signal family |

`decision.nextRun.measuredPerFoldMs` is 19 117 – 54 902 ms/fold at `es = 4`. **An `es`
sweep to 16 is therefore ≥ 4× the 43–69 min of one controller arm, per arm, per seed** —
which is exactly why P7 below is specified as a *short-window, few-arm, 1-seed*
pre-registered probe rather than a full A/B.

### 2.4 The control problem: an `es` change is not a single-factor change

`BUGS.md` #44 records the mechanism (for `pca-hash`) that the **live retrieval reader
draws `Math.random()` a bucket-content-dependent number of times** (up to `maxCandidateCap`, per member). Raising
`es` changes the number of members, hence the number of retrieval calls, hence the
**RNG draw count and the whole downstream trajectory**. So "the run differs" is *not*
evidence that capacity/diversity caused the difference — the identical caveat the
project already documents for `pca-hash`. Any `es` sweep must therefore be
**seed-replicated** (≥3 seeds) and state its verdicts as *paired across seeds at fixed
seed*, never as a single-run contrast.

### 2.5 The goldens are not actually in the way

`golden.test.js` pins a **bare `HiveMind` at `es = 3`** (`test/browser/entries/golden.test.js:214`)
and `controller_invariants.test.js` at `H_ES = 2` (`:113`); the compact `forceMin`
dimension constants are pinned by `dimensions.test.js` (185 checks, including a `forceMin = false`
grid over `es × is`). So **changing the analysis default `es` moves no golden
fingerprint** — the real costs are the RNG trajectory (§2.4), the wall clock (§2.3), and
re-baselining the retained comparisons. (This corrects an over-cautious reading: an `es`
sweep is *safer* for the locked core than a mechanism change.)

## 3. What the external record says (and does not say)

| claim | the record | ref |
| --- | --- | --- |
| Ensemble size is set by the **effective dimension**, not by "bigger is better". | Regret/exploration guarantees need `Θ(d log T)` members with an intrinsic `Ω(d)` barrier, and **smaller** ensembles are shown to retain the guarantee; a second, independent result proves the required size for a Kalman ensemble depends on the **effective rank** of the covariance and the unstable-subspace dimension, not the ambient dimension. | `2609.13954`, `2609.23927` |
| **Skill, not diversity, governs** whether a member pool helps. | Over 24 monitors across 9 lineages and a 29× skill range, *minimising pairwise correlation is not complementarity*; member **skill** is what governs the ensemble's value. | `2608.16190` |
| Member count should be **learned/searched**, not fixed. | Ensemble composition **and size** are learned end-to-end with an explicit signed diversity regularizer tuned on validation. | `2607.08493` |
| More members cost **linearly**, and the cost is the binding constraint at scale. | "An ensemble's cost for training and testing increases linearly with the number of networks, which quickly becomes untenable." | `2002.06715` |
| Member count and parameter count are **separable** — you can have hundreds of members cheaply. | Weight sharing across virtual models at constant parameter count; per-member rank-1 modulation of a shared backbone; weight-space merging at single-model inference cost; diversity condensed into one network; an ensemble teacher distilled to a single-step student. | `2609.24782`, `2002.06715`, `2203.05482`, `2205.13104`, `2604.04038`, `2608.27728` |
| Ensembles buy **calibrated uncertainty**, with **diminishing returns** in `M`. | The canonical deep-ensembles result (typical `M ≈ 5`) — already the project's grounding. | `1612.01474` |
| **(Absent)** No paper found claims "more members → more trading skill". | The crypto/asset-pricing sweeps (`raw/arxiv-sweep-2026-09o.json`) return **no** ensemble-size→skill result; the project's own `2512.15732` is a **failure** post-mortem for the deep+evolutionary route. | — |

**Reading.** The record supports *making `es` a dimension-driven / learned quantity* and
*getting many members cheaply by weight sharing* — and it explicitly undercuts "add
members until skill appears". It does **not** forbid the probe; it tells us what the probe
must measure (per-member skill, not pairwise decorrelation) and what the default should
be (learned/sized, not a fixed 8 or 16).

## 4. The coherence tensions this creates (what needs a test)

| id | tension | status | the test that settles it |
| --- | --- | --- | --- |
| **C4a** | H1 "more members → more memory" is true on the live retrieval path and **false** on the broadcast/injection budgets (`/es`) | **needs test** | P7 must report per-member bank occupancy + aggregate retrieved/injected counts vs `es`; a null skill result with *flat* aggregate retrieval answers it. |
| **C4b** | H2 "more members → more diversity → more skill" vs `2608.16190` (skill, not decorrelation, governs) | **needs test** | P7 reports **per-member Brier skill** and the observer's `meanPairwiseKappa`/`effectiveVoters`/entropy **separately**; if kappa falls while skill stays flat, H2 is refuted empirically. |
| **C4c** | An `es` change is confounded with the RNG draw count (`BUGS.md` #44, the `pca-hash` mechanism) | **known** | ≥3 seeds, paired within-seed contrasts; state the residual confound explicitly (the project's existing standard). |
| **C4d** | Cost is linear in `es` (§2.3) while the controller is already 560–970× the signal family | **known, and the reason P7 is bounded** | A **short** run (small `testSize`, few folds, `sig`-free) at `es ∈ {2,4,8,16}`; report wall time per arm. |
| **C4e** | The literature's "many members cheaply" route is **weight sharing** (`2609.24782`, `2002.06715`), which NeuLegion does not have — its members are independent parameter sets | **open design question** | Not in P7. Recorded as a *deferred* lead: if P7 shows member count helps, the cheap way to buy more is shared-weight virtual members, not more independent ones. |
| **C7 (carried)** | H2 also interacts with the confidence-scale/exposure issue (`BUGS.md` #61): a bigger member pool changes the `|confidence|` distribution, so a cross-`es` Sharpe comparison needs the P2 exposure matching | **needs test** | P7 quotes skill at matched exposure (P2), not raw Sharpe. |

## 5. Verdict

**Include it — as a gated, off-by-default *capacity probe* (P7), plus a principled
default-level change that is *not* "make `es` bigger" (P7b).**

- **P7 (capacity probe, scheduled after P1).** A pre-registered sweep
  `es ∈ {2, 4, 8, 16}` at `forceMin`, everything else frozen, on a **short** window
  (one stream count / small `testSize`, few folds — sized to ≈1 controller arm's cost of
  a normal run), **≥3 seeds**, producing one table: `es` × {per-bar Brier skill vs base
  rate, net Sharpe **at matched exposure**, `meanPairwiseKappa`, `effectiveVoters`/entropy,
  per-member bank occupancy, aggregate retrieved/injected proto counts, wall ms}.
  **Pre-registered decision rule:** if no `es` improves **Brier skill vs the base rate**
  (P1's metric) beyond the seed spread, then **capacity/member count is not the
  constraint** → the plan's §1.7 diagnosis stands and `es` is closed with a number;
  if some `es` does, record the `es`-skill curve and re-open the architecture question
  (which couples to P1's branch). Either outcome is decisive and cheap.
- **P7b (the principled default).** Do **not** hard-code a larger default. The record
  says size should be learned/sized (`2607.08493`, `2609.13954`, `2609.23927`), and the
  module already ships the readouts — so the *design* answer is to let `es` be selected
  (e.g. by validation skill / effective dimension) or to adopt the **shared-weight
  virtual-member** route (`2609.24782`, `2002.06715`) if P7 shows member count matters.
- **Rejected:** `es` as a **default increase** (no evidence, linear cost, an unfalsified
  bet); `es` as a **memory play** (the broadcast/injection budgets divide by `es`, §2.2);
  `es` as a **substitute for the edge** (the round-28 evidence says the target, not
  capacity, is the constraint — §1 of the plan).

**Can prove (P7):** whether member count moves forecast skill / diversity / effective
capacity *on this data*, and at what cost — the exact curve the design question needs.
**Cannot prove:** that any `es` makes a *tradeable* edge (that is P1/P3/P4), and it
cannot cleanly separate capacity from diversity (both move together; C4a/C4b).

## 6. Open leads (deferred, not scheduled)

- **Shared-weight virtual members** (`2609.24782`, `2002.06715`; the project's own
  `transfer.js` already shares *memory* between members but not parameters) — the only
  route to a genuinely large member count at fixed cost.
- **Learned cardinality** (`2607.08493`) — make `es` (or the ensemble weight support) a
  validation-selected quantity instead of a constant.
- **Member pruning / condensation** (`2604.04038`, `2608.27728`) — if most members are
  redundant, the correct move is *fewer* members (or one condensed member), not more.
  Note the *pruning* sweep returned nothing transferable at this scale; recorded as a
  null result, not a lead.
