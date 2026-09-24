# NeuLegion — research grounding

This directory maps every core NeuLegion mechanism to the literature it is
grounded in, and records **what we can prove with tests** versus what can only be
proven in a native environment (Node + better-sqlite3). It exists so that:

- a future agent can re-derive why a design choice was made;
- a component can only be marked **LOCKED** when a test proves it *and* a
  citation grounds it (see [`../LOCKED.md`](../LOCKED.md));
- the literature sweep can be refreshed without re-discovering it.

> **Scope freeze.** The intended design is frozen (see
> [`../DESIGN.md`](../DESIGN.md)). Everything in these notes is either the
> grounding for a **locked** system or a **deferred lead** (§ "Open questions /
> supercharges" in each note) — a catalogue, not a schedule. A new mechanism is
> only implemented when it is demonstrably essential and passes the definition of
> done in `DESIGN.md` §6.

## How to refresh the sweep

The sweep uses the arXiv Atom API (HTTPS only — `http://` is rejected):

```
https://export.arxiv.org/api/query?search_query=all:%22quoted+phrase%22
    &sortBy=submittedDate&sortOrder=descending&max_results=15
```

Quoted phrases must be percent-encoded (`%22…%22`); an unquoted multi-word query
is treated as an OR and returns noise. Raw XML from the last sweep is checked
into `docs/research/raw/` (small, text-only) so diffs are reviewable.

## Domain notes

| Note | Covers | Key NeuLegion components |
| --- | --- | --- |
| [`memory-retrieval.md`](memory-retrieval.md) | prototype memory, episodic/adaptive/semantic banks, retrieval scoring, decay, consolidation, generative replay | `_updateMemoryBanks`, `_retrieveTopRelevantProtos`, `_consolidateSemanticProtos`, `_replayOldMemory`, `_generativeReplay`, `_decayProtos` |
| [`lsh-ann.md`](lsh-ann.md) | content hashing, hyperplane LSH, bit masks, candidate retrieval, margin-ordered multi-probe, PCA-aligned (data-aware) hashing, bit-reliability theory, query-adaptive probe budgeting, dynamic query modification, ANN indexes | `_computeContentHash`, `_computeLSHHashesLow`, `_insertProtoToLSH`, `_getGlobalLSHCandidates`, `_refreshLshHyperplanes`, `memory/multiprobe.js`, `memory/binarypc.js`, `memory/bitweight.js`, `memory/querymod.js` |
| [`attention-kernels.md`](attention-kernels.md) | multi-head attention, RoPE, RMSNorm, SiLU/GLU, attention weighting, cosine/kernel similarity, structure scaling (width/depth) | `_multiHeadAttention`, `_applyRoPE`, `_rmsNorm`, `_silu`, `_kernelSimilarity`, `_scaleAndSetDimensions` |
| [`ensemble-evolution.md`](ensemble-evolution.md) | specialization, trust/agreement/performance scores, ensemble weighting, population evolution, low-rank ES, homeostatic learning-rate regulation | `_computeSpecializationScores`, `_updateTrustScores`, `_updateEnsembleWeights`, `_updateAdaptiveLearningRates`, `ensemble/homeostasis.js`, `legion/evolve.js` |
| [`training-distillation.md`](training-distillation.md) | batch training, gradient capture/rollback, per-sample loss weights, knowledge distillation, teacher selection | `_feedForwardBatch`, `train`, `_distillKnowledge`, `_accumulateGradients`, `_rollbackGradients`, `training/sample_weights.js` |
| [`continual-learning.md`](continual-learning.md) | stability/plasticity, catastrophic forgetting, staleness, sudden-drop detection, stagnation, homeostatic plasticity | `_detectSuddenDrop`, `_isStagnating`, `_decayProtos`, `_pruneMemory`, `ensemble/homeostasis.js` |
| [`financial-validation.md`](financial-validation.md) | indicator maths, honest evaluation: purged CV, PSR/DSR, PBO/CSCV, triple-barrier labels, sample uniqueness (measuring *and* applying), walk-forward protocol + no-lookahead audit + promotion gate + **dependence-aware inference** (design effect, cluster jackknife, paired cluster/sign tests, cost ladder), and **family search** (seed replication + common random numbers, Diebold–Mariano + Model Confidence Set, label realism, racing) | `analysis/*` (supercharges), `indicatorProcessor.js`, `training/sample_weights.js` |
| [`round29-model-class.md`](round29-model-class.md) | round-29 sweep: from-scratch transformers vs linear/MLP (DLinear/TSMixer/TiDE/N-BEATS), small **pretrained** TSFMs (TTM/Tiny-TSM/Chronos/Moirai), and the deep+evolutionary failure post-mortem | round-29 P1; controller architecture question |
| [`round29-crypto-edges.md`](round29-crypto-edges.md) | round-29 sweep **+ a new 1h coherence measurement**: short-horizon (15m) reversal, crypto factor models, funding/basis carry; measured 1-factor residual 20.8 % (rank IC −0.050), top-eig 0.794, 1h AC −0.013 | round-29 P3/P4; the cross-sectional reject |
| [`round29-adaptation-and-regime.md`](round29-adaptation-and-regime.md) | test-time adaptation, online changepoint/regime, universal-portfolio/no-regret baselines, closed-form turnover vs alpha autocorrelation | round-29 P5; the cadence nuisance |
| [`round29-evaluation-robustness.md`](round29-evaluation-robustness.md) | Sharpe vs sampling frequency (Lo 2002), publication/selection bias, configuration-robust protocols (majority pass + catastrophic veto), exposure matching, **the measured adjusted-DSR surface (MC1)** | round-29 P2; `TODO.md` 84/85 |
| [`round29-ensemble-size.md`](round29-ensemble-size.md) | Is a larger per-controller ensemble (`es = 8, 16, …`) worth testing? The actual `es`/`forceMin` structure, cost (linear in `es`), diversity-vs-skill (`2608.16190`), shared-weight members, learned cardinality | round-29 **P7/P7b**; `CONTROLLER_MODEL.ensembleSize` |
| [`round29-README.md`](round29-README.md) | **Round-29 index**: note registry, the decision table (P/R/G ids), the **conflict register** C1–C10, the measured checks MC1–MC4, the **focus points** FG1–FG14, the **go/no-go gates** G-A…G-E, and the bottleneck evidence card. Machine-readable mirror: [`round29-registry.json`](round29-registry.json) | round-29 navigation (read this first) |

## Round-29 planning notes (a *plan*, not a new subsystem)

**Start at [`round29-README.md`](round29-README.md)** — the consolidated, agent-oriented
index (note registry, decision table, **conflict register** C1–C10, measured coherence
checks MC1–MC4, bottleneck evidence card) with a machine-readable mirror
[`round29-registry.json`](round29-registry.json). Each `round29-*.md` note also opens with
a greppable front-matter block (`<!-- round29-note id: … keeps: … kills: … conflicts: … -->`),
so a future agent can locate the note that grounds a claim without reading them all.

The **four** `round29-*.md` notes (model-class, crypto-edges, adaptation-and-regime,
evaluation-robustness) were produced by the round-29 sweep (2026-09-24; raw snapshot
[`raw/arxiv-sweep-2026-09o.json`](raw/arxiv-sweep-2026-09o.json)) to answer one question:
**given that the controller has negative forecast skill and every positive-Sharpe arm is
~100 % market exposure, where does a real edge live?** A **fifth** note
([`round29-ensemble-size.md`](round29-ensemble-size.md); raw snapshot
[`raw/arxiv-sweep-2026-09p.json`](raw/arxiv-sweep-2026-09p.json)) was added in the same
planning cycle to answer the design's own question — *is a larger per-controller ensemble
(`es = 8, 16, …`) worth testing?* They support
[`../PLAN-round29.md`](../PLAN-round29.md), whose thesis is that the bot must change the
*game* (shorter-horizon reversal, funding/basis carry) rather than optimise the current
one, and whose P2 makes the verdict configuration-robust. The plan is **FINAL** (coherence-checked
2026-09-24): §1.9 is the focus-point/gotcha list, §5.2 is the go/no-go branch tree, and §5.3
is the first work unit for the implementation round.

Two **direct measurements over the retained runs** anchor the notes. (a)
`round29-crypto-edges.md` §2: one common factor = 79.4 % of the 8-stream covariance, a
proper 1-factor residual of 20.8 % of variance (whose next-bar rank IC is only −0.050 and
whose rank book breaks even at −0.042 bps), 1h lag-1 autocorrelation −0.013 — closing
the 1h cross-sectional/reversal routes with a number. (b)
`round29-evaluation-robustness.md` §6 (= `PLAN-round29.md` §1.8 MC1): the
dependence-adjusted DSR hurdle is a **surface** in `(Sharpe, designEffect, moments, K)`,
not a Sharpe band — the two highest-Sharpe arms fail on **exactly one** hurdle (the
design-effect-adjusted DSR) while the Step-2 baseline passes at Sharpe 0.8978. This
**corrected** `PLAN-round29.md` §1.5. These notes are *grounding for a decision*, not
components.

**Implementation verdicts (round 29 → 30).** The plan has since been implemented and measured; the
readout is [`round29-README.md`](round29-README.md) **§8 "Implementation verdicts"** (with the
per-arm detail in [`../RUN-ANALYSIS.md`](../RUN-ANALYSIS.md) §16 and the execution log in
[`../round29-IMPLEMENTATION.md`](../round29-IMPLEMENTATION.md)). In one line: **P1** → G-A negative
(no model class beats the base-rate prior; features/labels are the constraint ⇒ P6/P7 closed),
**P2** → the configuration-robust + exposure-matched gate (verdict-neutral on the retained runs;
kills the §15.5(c) `sig-accel` exposure artefact), **P3** → the 15m reversal is real and
economically inaccessible (break-even 0.32–0.56 bps vs 5–10 bps taker), **P4** → the carry sleeve is
a genuine independence purchase by correlation/effective-streams (+0.003 correlation; 1.25 → 1.54 of
9) but does not cross the DSR surface (designEffect 5.226 → 5.228), **P5** deferred with G-D open.
The machine mirror's `implementation` block lives in
[`round29-registry.json`](round29-registry.json). The next-round levers are `../TODO.md`
items 94–97.

## Status semantics

- **LOCKED-bit-exact** — behaviour pinned by a golden fingerprint; any change
  requires an intentional re-freeze.
- **LOCKED-structural** — wiring/shape pinned by `modules.test.js`.
- **LOCKED-invariant** — a mathematical property pinned by a dedicated test
  (e.g. "softmax rows sum to 1 within float tolerance").
- **NEEDS-LOCAL-RUN** — plausible and cited, needing `npm test` on Node +
  better-sqlite3. **None remain**: the native gate is green and the three
  controller DB bags that were the only such entries are promoted
  (`../BUGS.md` #18).
- **EXPERIMENTAL** — additive supercharge not yet trusted by a train/backtest.

The machine-readable registry is [`../../test/lock-registry.js`](../../test/lock-registry.js);
the human summary is [`../LOCKED.md`](../LOCKED.md). `locks.test.js` fails if the
two drift apart or if a component in `component-manifest.js` is unclassified.
