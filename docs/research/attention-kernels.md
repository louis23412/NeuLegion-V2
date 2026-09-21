# Attention, kernels & normalisation

The transformer half of each HiveMind member is deliberately small and
CPU-friendly. Every operation below is pinned by the golden fingerprints, so the
research here is about *why these primitives* and *what a safe upgrade looks
like*, not about changing arithmetic casually.

## What NeuLegion does

| Mechanism | Method(s) | Why |
| --- | --- | --- |
| Multi-head attention | `_multiHeadAttention`, `_contextAwareAttention` | Standard scaled dot-product; heads give the ensemble member multiple subspaces. |
| Attention-weight caching | `_computeAttentionWeights`, `_cacheAverageWeights` | Diagnostics + reuse; avoids recomputing mean weights per step. |
| Rotary positions | `_applyRoPE` | Relative-position signal without learned position embeddings. |
| RMS normalisation | `_rmsNorm` | Cheap, scale-invariant normalisation — no mean subtraction, no bias. |
| Gated activations | `_silu`, `_siluDerivative`, `_sigmoid`, `_softmax` | SiLU/Swish gating is the modern FFN default. |
| Similarity kernels | `_fastVectorDot`, `_cosineSimilarity`, `_kernelSimilarity`, `_projSimilarity`, `_maxPairwiseKernel` | Similarity is the currency of memory and of ensemble agreement. |

## Literature

- **RoPE.** Su et al., *RoFormer: Enhanced Transformer with Rotary Position
  Embedding* (arXiv 2104.09864). *Disentangling the expressivity of RoPE*
  (arXiv 2608.11909) and the survey *Position encoding in transformers…*
  (arXiv 2608.10021) are the current reference points; **ATFlash —
  per-RoPE-wavelength attention windows** (arXiv 2608.02947) is a
  compute-efficient variant relevant to long context. **Higher-dimensional RoPE**
  (arXiv 2608.29715), **MeRoTune** (arXiv 2609.07971) and **RoLA**
  (arXiv 2609.06712) are the 2026-09 refresh hits on scaling/merging the rotation.
- **RMSNorm.** Zhang & Sennrich, *Root Mean Square Layer Normalization* (arXiv
  1910.07467) — normalise by RMS only; cheaper and as stable in practice.
- **SiLU / gated linear units.** Shazeer, *GLU Variants Improve Transformer*
  (arXiv 2002.05202); Ramachandran et al., *Searching for Activation Functions*
  (arXiv 1710.05941, Swish).
- **Linear attention & hybrids.** *Modern transformers are implicit hybrids*
  (arXiv 2609.02986) argues many architectures are already attention/recurrence
  mixtures; **Gated DeltaNet** variants (arXiv 2609.14320 SpectralShift, arXiv
  2609.04098 quantisation) show a gated linear-attention recurrence can replace
  part of the attention stack at constant memory. *Consensus dynamics in
  selective SSMs* (arXiv 2609.17997) and *RunningTensor* (arXiv 2609.12814)
  extend the recurrence family.
- **Content-based addressing for long context** (arXiv 2609.07314) — a
  retrieval-shaped attention that is the natural bridge between this module and
  the prototype bank.

## Structure scaling (`persistence/dimensions.js`)

`_scaleAndSetDimensions` is the single place a member's width/depth is chosen. It
has two branches: the compact `forceMin` overrides that production runs
(`CONFIG.forceMin = true`, and every golden) and a full-size branch that scales
with ensemble size. `dimensions.test.js` (185 checks) audits **both** — this is
the audit `docs/BUGS.md` recorded as missing, and it is what promotes the
`dimensions` bag from `LOCKED-structural` to `LOCKED-invariant`.

- The compact overrides are frozen as exact constants, so an accidental edit to
  the production branch fails the suite.
- The full branch is structurally consistent across the `es × is` grid: hidden
  size is divisible by the head count, `headDim = hiddenSize / numHeads`,
  `lowDim` lies in its declared `[max(4, 0.18·hidden), 0.78·hidden]` band, and
  `numLshSets = floor(numProjections/3)`; every allocated tensor matches its
  declared count.
- It follows a **width-scaling law**: as the ensemble grows, layers, heads and
  hidden size are monotone non-increasing while the learning rate is monotone
  non-decreasing; every normalized-derived dimension saturates once
  `log10(es)/3 ≥ 1`; and the *only* dimension that depends on `inputSize` is the
  learning rate.
- End-to-end churn keeps the LSH index consistent (exact bucket multiplicity),
  weights/gradients finite, and each LSH projection unit-norm (self-similarity 1).

Grounding:

- **Kaplan et al.**, *Scaling Laws for Neural Language Models* (arXiv 2001.08361)
  — loss is a power law in width/depth/params, so a width-dependent learning rate
  is the norm rather than a hack.
- **Yang et al.**, *Tensor Programs V* (arXiv 2203.03466, μP) — width-scaled
  hyperparameters with zero-shot transfer; the `hiddenSize^-0.18` size scale in
  `_learningRate` is the same idea in a milder form.
- 2026-09 refreshes of the exponent debate: *Coupled Scaling: A Representational
  Accessibility Framework* (arXiv 2609.03533), *Skaling: Chinchilla's Exponents
  Meet Kaplan's Coupling* (arXiv 2608.07222), and *Neural Scaling Universality*
  (arXiv 2606.25008) — relevant if the exponents here are ever retuned.
- **Lakshminarayanan et al.**, *Deep Ensembles* (arXiv 1612.01474) — distributing
  a fixed budget across many small members instead of one wide model, which is the
  design the full branch implements.

## Test evidence

- `core.test.js` — attention output shapes, softmax row-sum≈1, RoPE
  orthogonality (rotation preserves norm), RMSNorm scale invariance.
- `modules.test.js` — every activation/normalisation/linalg method is installed
  exactly once with the manifest's function reference.
- `golden.test.js` — `hm:predictions`, `hm:translate` pin the exact float
  trajectory of the forward pass. **Do not reorder multiply-adds in this
  module**: it is chaotic under float32 and any change is a re-freeze.
- `dimensions.test.js` — the structure-scaling contract (see the section above):
  frozen compact overrides, full-branch shape consistency, and the width-scaling
  monotonicity law.

## Open questions / supercharges

- **Wavelength-scoped attention windows** (2608.02947) and **content-based
  addressing** (2609.07314) are the two additions worth prototyping, each behind
  a flag with a golden re-freeze only if they win a benchmark.
