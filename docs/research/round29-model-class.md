<!-- round29-note
id: model-class
status: research (round 29 planning) — no code changed
grounds: [P1]
keeps: [P1]
kills: []
gates: [P6]
conflicts: [C3]
index: round29-README.md
last-verified: 2026-09-24
-->

# Round-29 research note — the model class (is a from-scratch tiny transformer the right forecaster?)

**Status: research note (round 29 planning). No code changed.** This note exists to
answer one question with external evidence: *given that NeuLegion's controller has
**negative** forecast skill (`brierSkill −0.0738`, `accuracySkill −0.1301`, the run's
own `status: 'base-rate'`, `RUN-ANALYSIS.md` §15.3), is that a bug in the controller,
or the expected outcome of the model class it belongs to?* It is the expected
outcome. Every decision-relevant claim below is cited with an arXiv id and date, and
each section ends with **→ what it changes for NeuLegion**.

> **Method.** Sweep run 2026-09-24 via the arXiv Atom API; the relevant hits are
> checked into [`raw/arxiv-sweep-2026-09o.json`](raw/arxiv-sweep-2026-09o.json) (the
> `raw/README.md` convention). Papers are the real open-source record returned by the
> API, not the project's earlier citations.

## 1. From-scratch transformers are dominated by embarrassingly simple models

- **Zeng, Arik, Jenq, Huang, Steiner, Zohar**, *Are Transformers Effective for Time
  Series Forecasting?* arXiv **2205.13504** (2022-08-17; AAAI 2023). Introduces
  **DLinear** — a one-layer linear model over the look-back — and shows it beats the
  transformer LTSF family across benchmarks. The stated mechanism is decisive for
  NeuLegion: self-attention is **permutation-invariant**, so "using tokens to embed
  sub-series … inevitably results in temporal information loss" relative to an
  explicitly ordered model.
- **Elsayed, Thyssens, Rashed, Jomaa, Schmidt-Thieme**, *Do We Really Need Deep
  Learning Models for Time Series Forecasting?* arXiv **2101.02118** (2021-10-20). A
  plain **gradient-boosted regression tree** is competitive with, and often better
  than, the deep models on the standard benchmarks — the deep model's complexity buys
  no accuracy.
- **Chen et al.**, *TSMixer: An All-MLP Architecture for Time Series Forecasting*,
  arXiv **2303.06053** (2023-09-11). Mixing along time **and** feature axes with
  stacked MLPs matches the specialised SOTA ("the simple-to-implement TSMixer is
  comparable to specialized state-of-the-art models").
- **Ekambaram et al.**, *TSMixer: Lightweight MLP-Mixer Model for Multivariate Time
  Series Forecasting*, arXiv **2306.09364** (2023-12-11). The IBM production variant
  — a small MLP-mixer running in a fraction of the cost.
- **Das, Kong, Leach, Mathur, Sen, Yu**, *Long-term Forecasting with TiDE:
  Time-series Dense Encoder*, arXiv **2304.08424** (2024-04-04). A **dense
  encoder/decoder with residual MLP**, no attention, competitive with transformers.
- **Oreshkin, Carpov, Chapados, Bengio**, *N-BEATS: Neural basis expansion analysis
  for interpretable time series forecasting*, arXiv **1905.10437** (2020-02-20). An
  **MLP residual stack** with an interpretable trend/seasonality decomposition.
- **A Temporal Linear Network for Time Series Forecasting**, arXiv **2410.21448**
  (2024-10-28). The linear-model line continued: a purely temporal *linear* network.

**→ what it changes for NeuLegion.** The controller is a tiny transformer trained
from scratch per fold on ~60 training bars (`--train=60`) with 10 indicator inputs.
The literature it belongs to says this is the weakest available model class for the
task, and that a **linear or MLP forecast on the same features is the correct
baseline**. A `brierSkill < 0` transformer is not a mystery to be debugged by another
mechanism variant — it is what a permutation-invariant, under-trained attention model
does on noisy returns. The first thing round 29 must do is *measure* the model class
(P1), not add to it.

## 2. Small *pretrained* time-series foundation models beat training from scratch

- **Ekambaram, Jati, Nguyen, Sinthong, Kalagnanam**, *Tiny Time Mixers (TTMs): Fast
  Pre-trained Models for Enhanced Zero/Few-Shot Forecasting of Multivariate Time
  Series*, arXiv **2401.03955** (2024-11-07). "A compact model (starting from **1M
  parameters**)" built on TSMixer, pretrained on public TS corpora, with adaptive
  patching — explicitly positioned against "slow … high computational demands" large
  TS models.
- **Tiny-TSM**, arXiv **2511.19272** (2025-11-24). **23M parameters**, trained on a
  single GPU in under a week with a synthetic-data pipeline (`SynthTS`), "achieves
  state-of-the-art performance" **"without any neural architecture search,
  hyperparameter tuning, or scaling up model size"**.
- **Chronos: Learning the Language of Time Series**, arXiv **2403.07815** (2024-11-04);
  **Chronos-2**, arXiv **2510.15821** (2025-10-17). Scaling+quantisation tokenisation
  of values, a T5 backbone, cross-entropy pretraining; zero-shot forecasts on 42
  datasets. **Moirai** arXiv **2402.02592** (2024-05-22) and **Moirai 2.0** — decoder-only,
  arXiv **2511.11698** (2026-02-03); **TiRex** arXiv **2505.23719** (2025-11-02).
- **In-Context Fine-Tuning for Time-Series Foundation Models**, arXiv **2410.24087**
  (2024-10-31). Prompt a pretrained TSFM with *multiple example series* at inference
  time instead of fitting parameters — the few-shot route.
- **Scaling Transformers for Time Series Forecasting: Do Pretrained Large Models
  Outperform Small-Scale Alternatives?** arXiv **2507.02907** (2025-06-24). A direct
  audit of the "pretrained large vs small" question — the exact comparison round 29
  should run cheaply on NeuLegion's own data.
- **Forecasting Realized Volatility with Time Series Foundation Models: A Comparison
  with Econometric Benchmarks**, arXiv **2607.05291** (2026-07-06). Nine zero-shot
  TSFMs vs eight econometric specs (HAR family) on 50 assets — the *domain-scoped*
  reality check: TSFMs are tested against the econometric benchmark, not crowned.
- **Wood, Giegerich, Roberts, Zohren**, *Trading with the Momentum Transformer*,
  arXiv **2112.08534** (2022-11-22). The attention-LSTM hybrid that beats TS
  momentum benchmarks **net of transaction costs** and "naturally adapts to new
  market regimes" — the optimistic financial case for attention, and note its design:
  it is *not* trained from scratch per 60-bar fold; it learns a trend+sizing policy
  over a long history.
- **Supervised Autoencoder MLP for Financial Time Series Forecasting**, arXiv
  **2404.01866** (2024-06-18) — a small MLP with representation learning on financial
  data. **Red Queen's Trap** (below) is the counterweight.

**→ what it changes for NeuLegion.** The modern, cheap, open-source answer to "small
model, short training window, need a forecast" is **a small pretrained TSFM used
zero/few-shot**, or an MLP, not a from-scratch tiny transformer. Round 29's P1 should
include a zero-shot TSFM (TTM-class) and an MLP in the same benchmark as the
controller, scored on the same per-bar journal. If a 1M-parameter zero-shot model
beats NeuLegion's controller on NeuLegion's own candles, that is an unambiguous,
citable finding and it re-scopes the whole controller programme.

## 3. The "deep + evolutionary holy grail" is measured not to work

- **The Red Queen's Trap: Limits of Deep Evolution in High-Frequency Trading**, arXiv
  **2512.15732** (2025-12-05). A "rigorous post-mortem" of a hybrid system coupling
  LSTM/Transformer perception with a **genetic survival mechanism** — i.e. almost
  exactly NeuLegion's `legion/evolve.js` + transformer-controller architecture. The
  paper's framing ("frequently hypothesized to be the 'Holy Grail' … promising systems
  that adapt autonomously to non-stationary market regimes") and its negative result
  are the closest external test of this project's central bet.

**→ what it changes for NeuLegion.** The evolutionary layer is currently a
`LOCKED-invariant` module that **nothing imports** (`TODO.md` item 13). This is the
external justification for *not* wiring it, and for explicitly refusing "evolve
harder / bigger population" as a round-29 direction. Any future re-proposal of the ES
layer must first answer `2512.15732`.

## 4. What this note does **not** say

- It does **not** say attention is useless in finance — `2112.08534` is real evidence
  for an attention model net of costs, *with a very different training regime* (long
  history, a learned sizing policy). It says the *specific* regime here (tiny,
  from-scratch, 60-bar folds, 10 hand-rolled indicators) is the one the literature
  ranks last.
- It does **not** say the answer is a bigger model. `2511.19272`'s point is that a
  small model **plus the right pretraining corpus and augmentation** wins; the corpus,
  not the parameter count, is the lever.

## Open questions / leads (deferred, not scheduled)

- Does a zero-shot TTM/Chronos on the shipped basket carry **any** directional skill
  (Brier skill vs the base rate)? → round-29 P1.
- Does the controller's failure persist if the label horizon and feature set are held
  fixed and only the architecture changes? (the clean ablation P1 should run)
- Would a **linear** forecast on the 10 shipped indicators already have positive
  skill? (the cheapest possible test, and the one that most cleanly separates
  "features/labels are the problem" from "the transformer is the problem")
