# Memory & retrieval

NeuLegion keeps its long-horizon state in **prototype banks** rather than in
back-propagated weights: an incoming input is embedded, scored against stored
prototypes, and the winner is reinforced, decayed, or spawned. This is the
"external/associative memory" family, and each design decision below has a line
of literature behind it.

## What NeuLegion does

| Mechanism | Method(s) | Why |
| --- | --- | --- |
| Three-tier banks (episodic → adaptive → semantic) | `_updateMemoryBanks`, `_createNewProto`, `_finalizeSemanticProto` | Separate fast, medium and slow timescales so short-term noise does not overwrite consolidated structure. |
| Utility-scored retrieval | `_computeProtoUtility`, `_computeMemberAffinity`, `_retrieveTopRelevantProtos` | Prefer prototypes that are both *used* and *distinctive*; demote redundant ones. |
| Kernel similarity + top-k | `_kernelSimilarity` | A soft neighbourhood vote instead of a hard nearest-neighbour. |
| Decay + pruning | `_decayProtos`, `_pruneMemory`, `_sortByUtilityDescInPlace` | Bound memory, forget stale evidence, keep a fixed budget. |
| Consolidation | `_consolidateSemanticProtos`, `_computeMemoryScoreFromProtos` | Merge coherent clusters into a stable semantic prototype. |
| Generative replay | `_replayOldMemory`, `_generativeReplay`, `_poolMultiPrototype` | Rehearse condensed past signal to combat drift without storing raw history. |
| Surprise-gated writes (off by default) | `surpriseGate`, `surpriseGateFromSimilarity`, `_updateSemanticProtos` | Write hardest the inputs the bank cannot already predict, per Titans. Ships disabled (`floor=1`, an exact no-op) pending a walk-forward backtest. |

## Literature

- **Titans — learning to memorize at test time.** Behrouz et al., *Titans:
  Learning to Memorize at Test Time* (arXiv 2501.00663) and the follow-up
  *Titans Revisited* (arXiv 2510.09551) motivate a neural long-term memory that
  is updated at inference and decays with surprise. NeuLegion's episodic/adaptive
  split and surprise-weighted reinforcement mirror this.
- **Hippocampus for linear attention — exact recall of what the recurrent state
  forgets.** arXiv 2607.02303. Argues that a fixed-size recurrent state has an
  information floor, and that an explicit addressed store is needed for exact
  recall. Justifies keeping an explicit prototype bank alongside the transformer.
- **Eviction as estimation — "measuring beats accumulating".** arXiv 2607.24667.
  Frames memory eviction as a fixed-lag smoothing problem: when the cost of
  measuring exceeds the benefit of accumulating, *evict and re-measure*. This is
  the theoretical basis for `_decayProtos` + utility pruning rather than
  unbounded accumulation.
- **Memory consolidation on a transformation hypothesis.** *Mela* (arXiv
  2605.10537) consolidates test-time memory by transforming short-term traces
  into stable representations. Grounds `_consolidateSemanticProtos`.
- **Associative recall in fixed-state recurrences.** arXiv 2609.16183 gives a
  matched-state decomposition and an *interference wall* — a context length past
  which fixed-state recall degrades faster than linearly. Practical implication:
  keep the working window bounded and let the bank carry the long tail.
- **Classic base:** Hopfield networks / modern continuous Hopfield (Ramsauer et
  al., arXiv 2008.02217) for energy-based associative retrieval; Kanerva,
  *Sparse Distributed Memory* (1988) for the address-by-content principle.

## Test evidence

- `core.test.js` — bank updates, reinforce/decay/prune invariants, retrieval
  ordering, consolidation determinism.
- `golden.test.js` — `hm:diagnostics`, `hm:predictions`, `hm:memberCounts` pin
  the exact trajectory of bank state under a seeded workload.
- `candles.test.js` — the memory pipeline runs end-to-end over **567,684 real
  hourly candles** (8 symbols) without NaN/Inf or non-finite retrieval scores.
- `surprise.test.js` — the surprise gate itself: exact reference vectors and
  bounds; monotone in surprise; `floor=1` collapses the wired write path to a
  **bit-identical no-op** (two identically-seeded banks fingerprint equally, so
  all 11 golden values are unmoved); when enabled, the measured gated/ungated
  semantic write-size ratio equals `surpriseGate(1 - measuredSimilarity)` and a
  novel candidate is written >2× more strongly than a predictable one.

## Open questions / supercharges

- **Surprise-gated writes — implemented, awaiting a backtest before shipping on.**
  The backtest is the round-23 controller-backed A/B (`ROADMAP.md` N0-N3): it is
  the gate that would promote this and the other five default-off features.
  `src/hivemind/memory/surprise.js` now implements Titans' write-proportional-to-
  surprise rule and `banks.js#_updateSemanticProtos` applies it (default: off).
  The math and the off-switch are proven (`surprise.test.js`, 32 checks). The one
  thing still missing before it can be promoted to on-by-default is a walk-forward
  evaluation showing the gated write policy improves PSR/DSR over the ungated
  baseline on the shipped candles — that is a `backtest.js` job, not a new
  mechanism.
- **Interference budget.** Use 2609.16183's decomposition to *predict* when the
  bank should evict; testable as a pure function over bank statistics.
- **Temporal-co-occurrence retrieval** (Predictive Associative Memory, arXiv
  2602.11322). The bank retrieves by projection cosine — *similar* states. PAM's
  claim is that biological memory retrieves by **temporal co-occurrence**: the
  useful memory is the state that *followed* a similar situation, not the one that
  merely looks alike. For a trading hivemind this is a genuinely different
  retrieval criterion (a "what happened next" pointer over the episodic bank) and
  a worthwhile research direction; it is not a pure-function proof, because it
  needs a trained predictor to navigate the associative structure, so it is
  recorded as a lead rather than an additive module.
- **Dense holographic associative memories** (arXiv 2606.18492) and **Sinkhorn
  spherical Hellinger–Kantorovich recall** (arXiv 2606.28300) — heavier recall
  operators (capacity/denoising theory; an optimal-transport energy) than the
  cosine kernel; recorded for a future retrieval-operator comparison.
- **Fuzzy online de-duplication** (FOLD, arXiv 2606.03001): suppress
  near-duplicate writes by an ANN similarity floor instead of the exact content
  hash — see the sibling lead in `lsh-ann.md`.


## Consolidation logic is a locked, proven module

The memory lifecycle's numeric core (Gaussian distance, content hash, decay,
pairwise merge, promotion, and the prototype proximity graph) lives in the pure
`src/consolidation_logic.js`, extracted verbatim from `consolidation_worker.js`.
`consolidation.test.js` (48 checks) proves the algorithms — including a
differential test against the original inline copies (300 randomized trials ×
{decay, merge, promote, hierarchy}, all `Object.is`-identical) — and
`consolidation_worker.test.js` (18 checks) proves the worker wiring.
Two deliberate behaviours are documented rather than "fixed": mutually-nearest
prototypes emit the same directed edge up to 4× (safe, because the insert is
`ON CONFLICT … DO NOTHING`, so `proto_edges` stays a set), and the pairwise
merge is inherently O(n²·d) and order-dependent (that is the algorithm, not
waste). Registered `LOCKED-invariant` with the Mela/Titans citations.
