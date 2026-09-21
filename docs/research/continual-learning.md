# Continual learning, forgetting & plasticity

A trading hivemind never stops seeing new data, and market regimes shift. The
core tension is the **stability/plasticity dilemma**: adapt fast enough to track
a regime change, but not so fast that consolidated structure is destroyed.

## What NeuLegion does

| Mechanism | Method(s) | Why |
| --- | --- | --- |
| Sudden-drop detection | `_detectSuddenDrop` | Trigger a strong update when performance collapses (regime break). |
| Stagnation detection | `_isStagnating` | Trigger exploration when the hive stops improving. |
| Prototype decay | `_decayProtos` | Slow forgetting of stale evidence. |
| Pruning | `_pruneMemory` | Hard bound on memory; keeps the utility frontier. |
| Replay | `_replayOldMemory`, `_generativeReplay` | Rehearsal against drift without raw history. |
| Adaptive learning rates | `_updateAdaptiveLearningRates` | Per-member plasticity control (rank-based, plus an opt-in absolute homeostatic term). |
| Homeostatic plasticity | `ensemble/homeostasis.js` | Absolute activity set-point control; corrects common-mode drift the rank-based controller cannot see. Off by default. |

## Literature

- **Catastrophic forgetting — the canonical problem.** McCloskey & Cohen
  (1989); French (1999). The whole "replay / regularise / isolate" taxonomy.
- **Elastic weight consolidation.** Kirkpatrick et al., *Overcoming catastrophic
  forgetting in neural networks* (PNAS 2017, arXiv 1612.00796) — regularise
  parameter movement by Fisher importance. A candidate supercharge if members
  grow.
- **Experience replay.** Mnih et al. (2015) and the continual-learning replay
  literature; **generative replay** (Shin et al., arXiv 1705.08690) for stored
  generative traces instead of raw data.
- **JANUS post-hoc rectification** (arXiv 2609.19985) — explicitly targets the
  stability/plasticity dilemma with a post-hoc correction that restores past
  behaviour without blocking new learning. Directly relevant to
  `_detectSuddenDrop`'s update magnitude.
- **Homeostatic continual learning** (arXiv 2609.13771) — homeostatic control as
  a principled plasticity regulator. **Implemented** as the opt-in
  `ensemble/homeostasis.js` multiplier wrapped around `_updateAdaptiveLearningRates`:
  the rank-based rule cannot see a common-mode shift (scale every member up
  equally → unchanged ranking → no correction), whereas the absolute
  error-driven term `1 + gain·(target − activity)` regulates each member toward a
  set-point. Turrigiano's synaptic scaling is the biological precedent. Proven by
  `homeostasis.test.js` (bounded/monotone multiplier, exact fixed point,
  closed-loop convergence to `target/k`); ships off by default, so the locked
  trajectory is unchanged.
- **Synaptic scaling in spiking networks** (arXiv 2601.11261) — a concrete
  demonstration that multiplicative synaptic scaling stabilises activity in a
  spiking net without destroying learned structure; the mechanistic counterpart
  to the homeostatic multiplier, and evidence that a *multiplicative* (rather
  than additive) regulator is the right form.
- **Uncertainty-aware continual learning under evolving labels** (arXiv
  2609.17866) — use predictive uncertainty to decide *when* to adapt; the
  formal version of "stagnating ⇒ explore".
- **Class-incremental sparsity** (arXiv 2609.17026) and **parameter isolation
  with domain experts** (arXiv 2609.14730) — isolation as the third leg of the
  taxonomy; NeuLegion already isolates in per-slot members.
- **Where should a document live: context, representations, or parameters?**
  (arXiv 2609.17346) — a useful decision framework for whether a piece of
  knowledge belongs in the bank, the embedding, or the weights.
- **Investigating catastrophic forgetting in sound event classification** (arXiv
  2609.11447) — an empirical sanity check on how bad forgetting gets in a
  streaming setting.

## Test evidence

- `core.test.js` — detect-sudden-drop fires on an injected collapse and *does
  not* fire on a gradual decline; stagnation detector is monotone in its input.
- `consolidation.test.js` / `consolidation_worker.test.js` — consolidation is
  deterministic and idempotent under repeated application.
- `golden.test.js` — the 11 fingerprints pin the exact decay/prune trajectory.
- `homeostasis.test.js` — the homeostatic multiplier is bounded/monotone with an
  exact set-point fixed point, and the closed loop converges to `target/k` on the
  toy system `activity = k·lr`; enabled-with-`gain=0` is a bit-exact no-op.

## Known limits (documented in `../BUGS.md`)

- `_computeVariance` is an MAD-style robust spread, not the classical variance —
  the name is misleading but the behaviour is intentional and pinned.
- `_computePercentile` maps to `[0,1]` with the documented 0→1.0 edge case.
- `_isStagnating` is trigger-happy on short windows; tuning it is a research
  task, not a bug fix — it participates in the locked trajectory.
