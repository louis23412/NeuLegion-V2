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
| [`financial-validation.md`](financial-validation.md) | indicator maths, honest evaluation: purged CV, PSR/DSR, PBO/CSCV, triple-barrier labels, sample uniqueness (measuring *and* applying), walk-forward protocol + no-lookahead audit + promotion gate + **dependence-aware inference** (design effect, cluster jackknife, paired cluster/sign tests, cost ladder) | `analysis/*` (supercharges), `indicatorProcessor.js`, `training/sample_weights.js` |

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
