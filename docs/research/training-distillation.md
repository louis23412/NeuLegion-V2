# Training & distillation

Training in NeuLegion is **batch feed-forward + captured gradients + explicit
apply/rollback**, plus a periodic distillation step that compresses the hive's
knowledge back into each member. The gradient capture/rollback split is what
makes the "rollback if the step was bad" logic exact and testable.

## What NeuLegion does

| Mechanism | Method(s) | Why |
| --- | --- | --- |
| Batched forward | `_feedForwardBatch`, `_processTransformer` | Amortise per-step overhead; CPU-cache friendly. |
| Gradient accumulation | `_scaleGradientMatrix`, `_scaleGradients`, `_accumulateGradients` | Separate *compute* from *apply* so a step can be vetoed. |
| Per-sample loss weight | `train(inputs, target, sampleWeight)`, `training/sample_weights.js` | Weight the loss by sample uniqueness so overlapping labels do not over-count (LdP ch. 4). Off by default (`sampleWeight = 1`, a bit-exact no-op). |
| Apply / rollback | `_applyGradients`, `_rollbackGradients` | Exact undo — the safety valve for a rejected step. |
| Distillation | `_distillKnowledge` | Members learn from the ensemble's consensus, not only from raw error. |
| Transfer / sharing | `broadcastMemory`, `translateMemory` | Cross-member knowledge transfer with a translation step. |

## Literature

- **Knowledge distillation.** Hinton, Vinyals & Dean, *Distilling the Knowledge
  in a Neural Network* (arXiv 1503.02531) — soft targets carry more information
  than hard labels. This is the basis of `_distillKnowledge`.
- **Multi-teacher distillation** (arXiv 2609.18686) — aggregating several
  teachers beats a single one when teachers are diverse; matches the ensemble
  consensus the legion distils from.
- **Teacher-prediction refinement** (arXiv 2609.19964) — clean/noisy teacher
  targets matter; supports NeuLegion's trust-weighted consensus.
- **Self-distillation / label-guided distillation** (arXiv 2609.13024) — the
  student's own labels regularise the objective; relevant to `train`'s loss.
- **Distillation for anomaly detection** (arXiv 2609.15295) — a normalising-flow
  student distilled from itself; a reminder that distillation is useful even in
  unsupervised settings, which is NeuLegion's case (no ground-truth labels).
- **Infinite-parameter models** (arXiv 2609.18842) — generating weights from
  live data; the far-future version of `translateMemory` / `broadcastMemory`.
- **Prefix-cache-friendly ordering** generalises to any repeated-context
  teacher: identical context first, append-only middle, task-specific last.

## Test evidence

- `core.test.js` — a rollback after a capture restores weights **bit-exactly**
  (compare serialized state), and accumulate→apply is order-stable.
- `golden.test.js` — `hm:predictions`, `hm:diagnostics` pin the post-training
  weights under the seeded workload.
- `features.test.js` — distillation keeps outputs finite and does not blow up
  weight norms.
- `sample_weights.test.js` — `train(inputs, target, w)` is exactly linear in the
  sample weight (accumulated-gradient energy ratio `w²` for `w = 0.5`, `2`; zero
  for `w = 0`), and `w = 1` / non-finite `w` give a bit-identical trajectory to
  the default path.

## Open questions / supercharges

- **Confidence-anchored negatives** for distillation (arXiv 2609.15307) — use
  high-confidence *wrong* predictions as anchored negatives.
- **Rollback-based reflection** (arXiv 2609.18304) — reuse the existing exact
  rollback to run counterfactual "what if we had not applied this step" probes;
  cheap because rollback is already proven.
