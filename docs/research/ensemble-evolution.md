# Ensemble & evolution

A NeuLegion "legion" is many `HiveMindController`s organised into
(group × section × layer × tier × direction) slots. Each member is scored on
specialisation, performance, agreement and trust; the ensemble weights and each
member's learning rate adapt from those scores. This is an **evolutionary
ensemble** with an internal economy of trust.

## What NeuLegion does

| Mechanism | Method(s) | Why |
| --- | --- | --- |
| Specialisation scoring | `_computeSpecializationScores` | Reward members that are good at a niche, not just good on average. |
| Performance / agreement / trust | `_updatePerformanceScores`, `_updateAgreementScores`, `_updateTrustScores`, `_adjustPerformanceScores` | Multi-signal reputation; trust is the slowest-moving aggregate. |
| Ensemble weights | `_updateEnsembleWeights`, `_normalizeEnsembleWeights`, `_getSpecWeightMatrix` | Weighted vote over member predictions, normalised to a simplex. |
| Adaptive learning rates | `_updateAdaptiveLearningRates` | Fast learners on shifting regimes, slow learners on stable ones; rank-based, with an opt-in absolute homeostatic term. |
| Homeostatic plasticity | `ensemble/homeostasis.js` | Regulate each member's activity toward an absolute set-point, correcting common-mode drift the rank controller cannot see. Off by default. |
| Shared hive state | `_updateHiveState`, `_hiveMemorySharing`, `_computeWeightedSum` | Members exchange a compressed summary of what they learned. |
| Knowledge distillation | `_distillKnowledge` | Compress the ensemble into each member (see `training-distillation.md`). |

## Literature

- **Deep ensembles.** Lakshminarayanan, Pritzel & Blundell, *Simple and Scalable
  Predictive Uncertainty Estimation using Deep Ensembles* (arXiv 1612.01474) —
  diversity, not just accuracy, is what buys calibrated uncertainty. Grounds the
  specialisation/agreement split.
- **Diversity collapse is real.** *Breaking diversity collapse in spiking
  pseudo-ensembles for efficient OOD detection* (arXiv 2608.01090) — ensembles
  collapse to one mode without an explicit diversity pressure. NeuLegion's
  specialisation score is that pressure; the paper supports making it explicit.
- **Deep-ensemble uncertainty reliability** (arXiv 2608.13223) — a controlled
  study of when deep-ensemble uncertainty can be trusted; relevant to how much
  the legion should defer to disagreement.
- **Evolution strategies at scale.** *EGGROLL, unrolled: understanding and
  improving low-rank evolution strategies at scale* (arXiv 2609.10980) — a
  low-rank parameterisation makes ES affordable (no full-gradient requirement).
  This is the cleanest route to evolving larger members on CPU. **Implemented**
  as the additive `legion/evolve.js` (see below); not wired into the trainers yet.
- **Low-rank ES for spiking networks** (arXiv 2605.30361) — applying a low-rank
  parameterisation to evolve spiking/cheap networks without full gradients;
  independent confirmation that the low-rank subspace restriction keeps ES
  affordable at small population sizes on CPU-only hardware.
- **ES for reasoning.** *Understanding evolution strategies for LLM reasoning*
  (arXiv 2608.27351) — ES explores broader solution modes than GRPO; *integer
  NES* (arXiv 2608.23714) gives a discrete/integer variant.
- **Classic base:** Salimans et al., *Evolution Strategies as a Scalable
  Alternative to Reinforcement Learning* (arXiv 1703.03864); Hansen's CMA-ES;
  ensemble-selection via exponential weights (Hedge / multiplicative weights).

## Test evidence

- `core.test.js` — ensemble weights always non-negative and sum to 1;
  performance/agreement/trust stay in range; specialisation scores are finite.
- `golden.test.js` — `ctl:finalSignal`, `ctl:signalTrajectory`, `ctl:signalCount`
  pin the exact aggregated signal, so any change to the weighting economy is a
  visible re-freeze.
- `legion.test.js` (57 checks) — many controllers at once: signal aggregation,
  hierarchical voting, shared-vault behaviour, no NaN under the full roster.
- `homeostasis.test.js` (30 checks) — the opt-in homeostatic controller wrapped
  around `_updateAdaptiveLearningRates`: bounded/monotone multiplier with an exact
  set-point fixed point, closed-loop convergence to `target/k`, and a bit-exact
  off switch (`gain=0`), so the locked ensemble trajectory is unchanged.
- `evolve.test.js` (36 checks) — the additive `legion/evolve.js`: the antithetic
  estimate is exactly `S·Hθ` for a quadratic, `S` is PSD so the estimate is always
  a descent direction, full-rank estimates recover the true gradient, low-rank
  estimates are unbiased for the projected gradient, and a backtracking line
  search gives **monotone fitness** to the optimum on a toy convex quadratic.

## Open questions / supercharges

- ~~**Low-rank ES mutation** (2609.10980) — an additive `legion/evolve.js` that
  mutates members in a low-rank subspace, provable with a monotone-fitness test
  on a toy objective before it is allowed near the trainers.~~ **DONE** (Round 2):
  `legion/evolve.js` + `evolve.test.js` (36 checks) prove the quadratic identity,
  the PSD descent-direction guarantee, and monotone fitness on a toy convex
  quadratic. Still to do before it touches the trainers: monotone fitness on a
  member's real objective and a flag-gated A/B.
- **Explicit diversity pressure** (2608.01090) — a penalty term that provably
  raises pairwise member divergence in a unit test.
