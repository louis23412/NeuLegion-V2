# Locality-sensitive hashing & approximate nearest neighbours

To keep retrieval sub-linear the prototypes are indexed by **hyperplane LSH**:
each prototype is hashed to a set of bits, and candidate retrieval requires a
bit-overlap rather than an exhaustive scan.

## What NeuLegion does

| Mechanism | Method(s) | Why |
| --- | --- | --- |
| Content hash for de-duplication | `_computeContentHash` | Exact-key suppression before the expensive path. |
| Random hyperplane projection | `_generateLshHyperplanesLow`, `_computeLSHHashesLow` | SimHash-family hashing: `sign(w·x)` per hyperplane. |
| Bit masks per hash | `_getLshBitMasks` | Precomputed masks; candidate test is a popcount/AND. |
| Incremental index maintenance | `_insertProtoToLSH`, `_removeProtoFromLSH`, `_updateProtoInLSH` | The index must track bank mutations exactly or retrieval drifts. |
| Global candidate set | `_getGlobalLSHCandidates` | Union over banks before scoring (supplementary pool; see the width note below). |
| Projection cache | `_computeProjNorms`, `_invalidateProjCache` | Cache the per-prototype projection norms; invalidate on dimension change. |
| Multi-probe candidate expansion | `_retrieveTopRelevantProtos` (single-bit + random multi-bit probes) | Recall-critical path: probes every bit of the query word, then perturbs several bits at once, then falls back to a projection scan. |
| Margin-ordered probing (additive) | `memory/multiprobe.js` (`marginOrder`, `rankPerturbations`, `multiProbeKeys`) | The proven, Lv-2007-correct probe order — smallest `\|query·hyperplane\|` first — measured to lift self-recall from 0.03 to 0.30 where the lean prefix probe collapses. Wired into `_getGlobalLSHCandidates` behind the default-off `_multiProbeConfig` (the disabled branch is byte-identical, so the goldens are unmoved). |
| PCA-aligned hashing | `memory/binarypc.js` (`pcaHashTables`, `alignedHashTables`, `principalComponents`), `lsh.js#_refreshLshHyperplanes` | Data-aware alternative to the random hyperplanes: hash along the top principal components (BinaryPC arXiv 2608.04405). Proven to dominate random subspaces on reconstruction error (Eckart–Young) **and** measured to lift real-index recall (0.68→0.775 at σ=0.25 with multi-probe on). Wired behind the default-off `_pcaHashConfig`; the disabled branch never runs, so the goldens are unmoved. Each table also reports the exact per-direction data variance (`tableVariances`) and `rankPolicy` can read the aligned rank off the spectrum. |
| Bit-reliability theory | `memory/bitweight.js` (`flipProbability`, `reliabilityWeight`, `bitInformation`, `flipProbabilityFromMargin`, `estimateNoiseVariance`, `selectReliableRank`, `reliabilityWeights`, `weightedHamming`) | The exact bit-flip law `P = arccos(√(λ/(λ+σ²)))/π` (Charikar's θ/π with θ the signal/noise angle): a bit is a binary symmetric channel about the neighbourhood, so its information is `1 − H₂(P)` and a low-variance tail direction is worth nothing. Grounds the data-driven aligned rank (`above-mean` = keep only PCs above the random-direction baseline `trace/dim`, since a random unit direction captures that much variance in expectation) and the margin-probe order (P(flip) = Φ(−\|margin\|/σ) is monotone in \|margin\|, so Lv's order *is* the flip-probability order). |
| Query-adaptive probe budget | `memory/bitweight.js` (`probeRecoveryCoverage`, `recoveryDepth`, `poissonBinomialQuantile`, `calibrateNoiseFromFlips`), `memory/multiprobe.js` (`adaptiveMultiProbeConfig`, `adaptiveSingleBitBudget`, `adaptiveSingleBitKeys`) | Lv's order with a budget that follows the query's own uncertainty (NeuRoute arXiv 2608.15438; adaptive bucket probing arXiv 2604.04603). The exact recovery probability `[∏_{b∉top-depth}(1−q_b)]·P(K_inside ≤ maxFlips)` picks the depth, the exhaustive enumeration over that depth meets it exactly, and on a calibrated real index the budget drops to **zero probes** for confident queries while beating a fixed budget under noise. Off by default. |
| Dynamic query modification (additive) | `memory/querymod.js` (`normalizedCentroid`, `modifiedQuery`, `dotProductSum`, `averageCovariance`, `centroidCollidesWithSet`) | The query-side companion: replace the query with the l2-normalised centroid `<c>` of the neighbours found so far and continue (arXiv 2605.23807). The paper's four results are proved exactly — Theorem 1 (`<c>` maximises `Σ x·u`, and `Σ(<c>·x) = ‖Σx‖ = k‖mean‖`), Theorem 2 (first-order ACP `½ + Σ x·u/(kπ)` maximised at `<c>`), Appendix C.1 (`averageCovariance = const − ((Σ x·u)/k)²`, minimised at `±<c>`), and §6.4 (the centroid collides with a member on every direction, a raw query need not). Wired behind the default-off `_queryModConfig`; the pool is a **superset** so recall cannot fall — **live** at narrow widths, a measured no-op at the production 107-bit width (the empty-consensus-bucket regime). |

## Literature

- **Charikar (2002), *Similarity estimation techniques from rounding
  algorithms*** — the canonical random-hyperplane SimHash: `Pr[bit differs] =
  θ/π` where `θ` is the angle between vectors. This is the correctness argument
  for `_computeLSHHashesLow`.
- **Lv et al. (2007), *Multi-Probe LSH*, VLDB** — probing buckets in order of
  *increasing perturbation likelihood* (flip the hyperplanes with the smallest
  signed margin first) recovers far more true neighbours than probing arbitrary
  bits. This is the grounded fix for the production-width recall gap documented
  below. **MP-RW-LSH** (arXiv 2103.05864) is the L1 analogue, and **adaptive
  multi-probe cardinality estimation** (arXiv 2604.04603) is a 2026 treatment of
  sizing the probe set to the query — both recorded as further probe-order
  refinements.
- **Training-free hashing-based attention via binary principal components**
  (arXiv 2608.04405) — shows hashing need not be random: PCA-aligned
  hyperplanes preserve more of the attention geometry at the same bit budget.
  **Built, proven and wired** (Rounds 13–15): `src/hivemind/memory/binarypc.js`
  + `binarypc.test.js` (39 checks) — power-iteration PCA with an exact orthonormal
  basis, the Eckart–Young dominance result (the PCA-aligned subspace beats every
  random subspace on reconstruction error at the same bit budget),
  `alignedHashTables` for the oversubscribed budget the live index actually uses,
  the per-direction `tableVariances`, and the data-driven `rankPolicy`.
  Wired behind the default-off `_pcaHashConfig` (`lsh.js#_refreshLshHyperplanes`)
  with the off-state byte-identical; `lsh.test.js` section I measures the real-index
  gain (below). The optimality grounding for the whole direction is
  **Andoni, Indyk & Laarhoven, *Optimal Data-Dependent Hashing*, arXiv 1501.01062**
  (a data-dependent scheme beats the best data-independent LSH for every
  approximation factor `c > 1`).
- **Density Sensitive Hashing** (arXiv 1205.2930) and **weighted Hamming distance**
  (arXiv 2009.08591) — the two pieces that explain the Round-14 caveat: hash
  directions should follow where the *data (and its density)* is, and a bit's
  reliability differs, so aligning to the low-variance tail (where noise
  dominates) is a no-gain config. **Resolved in Round 15**: the exact bit-flip law
  below turns "reliability" into a computable BSC weight, and the data-driven
  `above-mean` rank policy (keep only PCs above the random-direction baseline
  `trace/dim`) is what replaces the magic `dim/4` constant. The rotation-based
  aligned index already equalises per-direction variance, so reliability-weighted
  *candidate ranking* was measured NOT to beat plain Hamming (recorded negative,
  `bitweight.test.js` section I) — the pool is re-scored downstream by the exact
  projection cosine anyway.
- **The bit-flip law and its information reading** — for a hash direction whose
  data variance is `λ` under isotropic noise variance `σ²`, a stored bit flips
  with `P = arccos(√(λ/(λ+σ²)))/π`, i.e. Charikar's `θ/π` with `θ` the angle
  between the signal and the noisy signal. Each bit is then a **binary symmetric
  channel** about the neighbourhood with crossover `P`, so its information is
  `1 − H₂(P)` (Cover & Thomas, *Elements of Information Theory*) — zero for a
  noise-dominated tail direction. The same model gives the query-side flip
  probability `Φ(−|margin|/σ)`, which is monotone in `|margin|` and therefore
  *proves* that margin-ordered multi-probe (Lv et al. 2007) probes the
  most-likely-flipped bits first. **NeuRoute** (arXiv 2608.15438) is the 2026
  systems-side relative: its query-time encoder logits give an uncertainty signal
  that prioritises perturbing the bits the query is least sure of — the
  reliability-weighted probe order, learned rather than from the spectrum.
- **Dynamic query modification for binary LSH** (arXiv 2605.23807) — replace the
  query with the l2-normalised centroid `<c>` of the neighbours found so far and
  continue the search from it (Rocchio / pseudo-relevance feedback for binary
  codes). The paper's guarantees of `<c>`: **Theorem 1** — it maximises
  `Σ_{x∈S} x·u`; **Theorem 2** — it maximises the first-order average collision
  probability `½ + Σ x·u/(kπ)`; **Appendix C.1** — it minimises the average
  residual covariance `const − ((Σ x·u)/k)²`; and **§6.4** — the centroid always
  shares its bit with at least one neighbour on every hyperplane (hash-failure
  elimination), which a raw query need not. **DONE** (Round 17) in
  `memory/querymod.js` + `querymod.test.js`, wired behind the default-off
  `_queryModConfig`.
- **Spectral-LSH** (arXiv 2607.19368) — Krylov-projected LSH as a cheaper
  alternative to random projection for high-dimensional inputs.
- **MESS: multi-graph HNSW** (arXiv 2607.28999) and **learning partition trees
  for NN search** (arXiv 2607.09909) — graph/learned indexes that beat flat LSH
  in recall-per-byte at large N. Out of scope for the current memory budget but
  recorded as the next index tier if the bank grows past ~10^5 prototypes.
- **FOLD: fuzzy online dedup via ANN** (arXiv 2606.03001) — online
  de-duplication is exactly `_computeContentHash` + candidate probe; FOLD's
  fuzzy variant suggests a similarity floor rather than exact-hash equality.

## Test evidence

- `lsh.test.js` (75 checks) — the recall-preservation suite. Proves, in tiers:
  - *theory*: projections are unit norm so `_projSimilarity` is a true average
    cosine (self-score exactly 1; the historical `1/sqrt(lowDim)` rescale — which
    compressed every score into `[-1/lowDim, 1/lowDim]` and made the 0.35 filter
    unreachable — is reproduced and shown to fail); a hash word is exactly the
    sign pattern of the projected vector against the set's hyperplanes,
    bit-for-bit; identical vectors hash identically; the bucket index is a
    leak-free mirror of `_semanticProtos` (insert → `sets*tables` refs, remove →
    zero refs + pruned empty buckets, update → only the new hashes);
  - *the rounding law*: the measured bit-flip rate matches `acos(cos)/π` to
    `≤ 0.03` at noise levels 0.05–1.0, and is monotone in noise — the defining
    correctness property of the index;
  - *recall*: exact-match queries recall **100%** of an 80-prototype bank in both
    the min and the production-width config; near-duplicate recall is 1.0 at
    noise ≤ 0.25 (min config) and ≥ 0.9 at noise 0.1 (wide config); and the
    end-to-end path `_retrieveTopRelevantProtos` recalls the query prototype in
    8/8 (min) and 4/4 (wide) trials;
  - *the data-aware refresh (section I)*: `_refreshLshHyperplanes` is a no-op
    with `_pcaHashConfig` null (returns `false`, hyperplanes reference-identical),
    and with it on replaces every set's hyperplanes with finite `lowDim`-sized
    **unit** vectors, rebuilds the bucket index into an exact leak-free mirror of
    `_semanticProtos` (no empty buckets), is bit-deterministic under a seed, and
    falls back (no-op) below its `minRows` floor, and the refreshed hyperplanes
    survive a SQLite round-trip (reloaded bit-identically, buckets rebuilt under
    them). On a real 107-bit / `lowDim`-71
    index with a planted anisotropic bank (200 paired noisy queries, margin
    multi-probe on) the aligned hyperplanes lift self-recall under noise from
    **0.68 → 0.775** at σ=0.25 (prefix probe **0.315 → 0.395**) and **0.01 → 0.04**
    at σ=0.5, with no loss at σ=0.1 (1.0). The measured caveat: aligning **every**
    direction is a no-gain config (**0.655**, below the random baseline) because
    it dedicates bits to the low-variance noise tail; the optimum is a broad
    plateau near `dim/4`, the wiring default. **Round 15** replaces that constant
    with a data-driven rank: `rankPolicy: 'above-mean'` reads the rank off the
    spectrum (`selectReliableRank`, keep only PCs above the random-direction
    baseline `trace/dim`) and picks ranks **22–23** on the same index, reaching
    **0.75** self-recall at σ=0.25 (vs **0.68** random and **0.655** full
    alignment) — inside the plateau with no hand-tuned constant, the chosen rank
    recorded in `_lshAlignedRank`.
- `querymod.test.js` (51 checks) — the query-side recall fix (arXiv 2605.23807).
  Exact: the centroid algebra (`normalizedCentroid` values, scale/permutation
  invariance, null on antipodal/empty sets); **Theorem 1** (no random direction
  beats `<c>` on `Σ x·u`, and `Σ(<c>·x) = ‖Σx‖ = k‖mean‖` exactly); **Theorem 2**
  (the exact `½ + Σ x·u/(kπ)` form, no direction beats `<c>`, and `<c>` beats the
  average random direction on the *exact* Charikar ACP); **Appendix C.1**
  (`averageCovariance` minimised at `<c>`, and the exact
  `const − ((Σ x·u)/k)²` identity); **§6.4** (the centroid collides with a member
  on **every** direction — 0 failures in 200 — while the exact singleton witness
  `q = −x` fails `200/200`, and an opposing query fails the majority on a
  non-degenerate tight set). Monte Carlo: Charikar's law `1 − arccos(a·b)/π`
  matched by 4e4 random hyperplanes to `<0.01`; the **denoising law** (the 40-view
  centroid at σ=0.3 cuts the per-bit error rate several-fold and shrinks with the
  view count). The **synthetic regime sweep** maps the operating regime: on a
  random-hyperplane index query modification strictly raises pool recall while the
  word is informative (6..12 bits, e.g. `0.540 → 0.789` at 6 bits) and the gain
  decays **monotonically** to `0.001` at 24 bits. `lsh.test.js` section J adds the
  integration: flag-null by default, byte-identical when toggled back, pool a
  mechanical **superset**, **live** on the narrow 6-bit index, a **measured no-op**
  on the production 107-bit index.
- `binarypc.test.js` (39 checks) — the data-aware hashing engine. Proves the pure
  linear algebra (exact means/covariance/dot), power iteration (dominant eigenpair,
  zero-matrix guard, seeded determinism), exact PCA on a diagonal covariance
  (descending eigenvalues, exactly orthonormal components, trace decomposition),
  recovery of a planted direction (`|cos| > 0.999`), the flagship Eckart–Young
  dominance, the `pcaHashTables` orthonormality/subspace/seed properties, the
  `alignedHashTables` oversubscribed-budget behaviour (`min(bits,dim,nrows-1,
  maxRank)` aligned directions + random **unit** surplus; `maxRank` and
  rank-deficiency caps; degenerate-input throws), and (section H) that the
  reported `tableVariances` equal the brute-force data variance along each
  direction, that the aligned prefix carries above-baseline variance while the
  random surplus sits at exactly `trace/dim`, and that `rankPolicy`
  (`above-mean` / `noise`) is deterministic, capped by `maxRank`, and produces
  unit-norm tables.
- `bitweight.test.js` (69 checks) — the bit-reliability theory plus (Round 16) the
  query-adaptive budget primitives: the exact Poisson-binomial pmf/quantile, the
  monotone containment coverage and the exact recovery coverage (no union bound),
  the single-pass `recoveryDepth` proven equal to a brute-force scan, and
  `calibrateNoiseFromFlips` (round-trips the expected flip count to 1e-6, and
  predicts a real index's mean Hamming distance exactly). Exact hand values and
  Monte-Carlo agreement to <0.02. Proves the exact
  flip law and its limits, monotonicity and bounds, the BSC weight/information
  endpoints, **Monte-Carlo agreement** of the closed form (max diff 0.00055 over
  2e5 draws at four `(λ, σ)` pairs) and the identity that the flip law is the
  average of the margin law; the margin law `Φ(−|margin|/σ)` and that ascending
  `|margin|` order is descending flip-probability order; the spectral noise
  estimator; `selectReliableRank`; exact reliability weights; `weightedHamming` /
  `weightedKeyDistance` (verified against a brute-force unpacked recompute on
  32-bit **and** BigInt words); and the **live-index validation** — the law
  predicts a real PCA-aligned index's measured bit-flip rate to within 0.012
  (measured 0.1390 vs predicted 0.1267 at σ=0.5). Section I records the negative
  result that reliability-weighted candidate ranking does not beat plain Hamming
  on the rotation-based index.
- `sanity.test.js` case C — index consistency under training churn: no dead
  protos in buckets, no live protos missing, bucket multiplicity exact.
- `multiprobe.test.js` (77 checks) — the margin-ordered multi-probe engine
  (`memory/multiprobe.js`, additive). Proves: `marginOrder` is a total ascending
  permutation by `|query·hyperplane|`; `rankPerturbations` emits distinct
  non-empty ≤`maxFlips`-bit perturbations costed at exactly the sum of their
  margins and sorted by `(cost, flips, margin-rank)`; the **flip lemma** (bit `b`
  flips ⇔ `|δ_b| > |q_b|` and opposing sides, so the lowest-margin cover is
  complete — zero violations in 300 trials); `P(flip)` decreases monotonically
  with margin (0.484 → 0.039 octiles); margin order dominates the historical
  prefix probe at **every** budget 1–32 and beats all 12 sampled random orders;
  all-pairs / single-bit probing are complete **exactly** on ≤2-bit / ≤1-bit
  neighbours; and on a real 107-bit HiveMind bank margin probing lifts self-recall
  under noise from **0.033 → 0.30** at σ=0.25 (still 1.0 at σ=0.1) where the
  prefix probe collapses. Section G (Round 16) adds the query-adaptive budget:
  the config is idempotent and byte-identical when off, the depth reaches the
  requested recovery coverage exactly (or saturates at the cap), the budget is
  exactly the number of subsets of the top-`depth` bits, the enumeration is
  exhaustive and the probe set a superset for confident queries (depth 0 = the
  exact key), Monte Carlo matches the exact predicted coverage, and on the real
  index (σ calibrated from the measured Hamming distance) the adaptive budget
  dominates the prefix-4 probe at every noise level, needs no probes at all for
  many queries at low noise, and beats the fixed 8-probe budget at high noise.
- `golden.test.js` — `hm:memberCounts`, `hm:broadcast` pin the hashed candidate
  sets under the seeded workload. **The index is part of the locked trajectory.**

### Measured recall vs noise (min config: lowDim 4, 2 sets × 2 tables × 6 bits)

| noise σ | self-recall | brute-force top-1 covered | bit-flip rate (measured / θ/π) |
| ---: | ---: | ---: | ---: |
| 0.05 | 1.000 | 1.000 | 0.0198 / 0.0162 |
| 0.10 | 1.000 | 1.000 | 0.0333 / 0.0321 |
| 0.25 | 1.000 | 1.000 | 0.0880 / 0.0787 |
| 0.50 | 0.950 | 0.975 | 0.1620 / 0.1485 |
| 1.00 | 0.825 | — | 0.2651 / 0.2621 |

### Width note (why the lean helper degrades)

At production dimensions (`es=2, is=12, forceMin=false` → `hiddenSize=112`,
`lowDim=71`, 4 sets × 72 tables × **107 bits**) a 107-bit word means any
non-trivial query lands in a different bucket in every table. `_getGlobalLSHCandidates`
probes only the exact bucket plus 4 single-bit flips, so its recall collapses
beyond σ≈0.1 (measured: 100% at σ=0.1, 0% at σ=0.5). That is acceptable because
it is only a *supplementary* pool inside `broadcastMemory` (which already
drains priority indices, core protos and a uniform sample) — the recall-critical
consumer, `_retrieveTopRelevantProtos`, probes every bit plus random multi-bit
words and still recalls the near neighbour at σ=0.25. The principled fix, when
the recall-per-probe budget matters, is margin-ordered multi-probe — now built and
proven: `memory/multiprobe.js` recovers **0.30** of the bank at σ=0.25 on the same
107-bit index where the prefix probe recovers **0.033** (a ~9× gain), at
`multiprobe.test.js` (77 checks). It is now wired behind a default-off flag
(`_multiProbeConfig`; with it on the real lean helper's pool self-recall rises
0.167 → 0.517 at σ=0.25), leaving only the intentional `hm:broadcast` re-freeze.

## Open questions / supercharges

- **PCA-aligned hyperplanes** (2608.04405): **DONE, wired and measured** (Rounds
  13–15). `memory/binarypc.js` + `binarypc.test.js` (39 checks) prove the
  power-iteration PCA, the exact orthonormal basis, the **Eckart–Young** case, the
  `alignedHashTables` oversubscribed-budget variant, the per-direction
  `tableVariances`, and the data-driven `rankPolicy`; `lsh.js#_refreshLshHyperplanes`
  wires it behind the default-off `_pcaHashConfig`, and `lsh.test.js` section I
  measures the real-index gain (0.68 → 0.775 at σ=0.25 with multi-probe, no loss
  at σ=0.1, no gain from full-rank alignment; the `above-mean` policy picks ranks
  22–23 off the spectrum and reaches 0.75, replacing the `dim/4` constant).
  Remaining: an intentional re-freeze of `hm:broadcast` to switch it on by
  default. **Dynamic query modification** (2605.23807) — the query-side
  companion, also a pure function over the projection/hash — is now **DONE**
  (Round 17): `memory/querymod.js` + `querymod.test.js` prove Theorems 1–2,
  Appendix C.1 and §6.4 exactly and the denoising/synthetic laws empirically, and
  `lsh.test.js` section J wires it behind the default-off `_queryModConfig`
  (superset pool; live at narrow widths, a measured no-op at 107 bits).
- **Weight or drop the low-variance tail bits** (weighted Hamming, arXiv
  2009.08591; density-sensitive hashing, 1205.2930): **DONE** (Round 15). The
  reliability of a bit is now a computable quantity — the exact flip law
  `P = arccos(√(λ/(λ+σ²)))/π` and its binary-symmetric-channel information
  `1 − H₂(P)` (`memory/bitweight.js`, 69 checks, Monte-Carlo + live-index
  validated). Two outcomes: (a) the **data-driven rank** `above-mean` replaces the
  magic `dim/4` constant and lands in the winning plateau; (b) the honest
  **negative result** — reliability-weighted *candidate ranking* does not beat
  plain Hamming on the rotation-based aligned index (the rotation already
  equalises per-direction variance, and the random surplus bits get down-weighted
  for nothing), so the pool is left in bucket order and re-scored downstream by
  the exact projection cosine. The **query-side** use of the reliability is now
  **DONE** (Round 16): `adaptiveMultiProbeConfig` (NeuRoute arXiv 2608.15438;
  adaptive bucket probing arXiv 2604.04603) derives the probe depth per query from
  the exact recovery coverage `[∏_{b∉top-depth}(1−q_b)]·P(K_inside ≤ maxFlips)`,
  enumerates that depth exhaustively so the guarantee is exact, and is off by
  default. On a calibrated real index it drops to zero probes for confident
  queries and beats a fixed budget under noise. Remaining: switching it on by
  default behind an intentional `hm:broadcast` re-freeze (the sibling **dynamic
  query modification** 2605.23807 is **DONE** — Round 17).
- **Margin-ordered multi-probe** (Lv et al. 2007): replace the 4 arbitrary
  single-bit flips in `_getGlobalLSHCandidates` with a sequence ordered by each
  hyperplane's signed margin `|w·proj|`. **DONE at the engine level** (Round 2):
  `memory/multiprobe.js` + `multiprobe.test.js` (77 checks) prove the flip lemma
  and measure a 0.033 → 0.30 self-recall gain at σ=0.25 on a real 107-bit index.
  Done: wired behind a default-off flag (goldens stay bit-identical; with the flag
  on the lean pool self-recall rises 0.167 → 0.517 at σ=0.25). Remaining: an
  intentional re-freeze of `hm:broadcast` for the on-by-default flip.
- **Locality-Sensitive Filtering on the sphere** (arXiv 2604.24323): the natural
  **next index tier**. LSF allows *asymmetric* regions — a data point and a query
  independently select random caps of angular radius — and can afford a better
  collision exponent than LSH for angular distance. The paper is a self-contained
  treatment of the symmetric Gaussian filter on the unit sphere, which is exactly
  NeuLegion's projection space (cosine). Candidate: a filter-based candidate pool
  behind a default-off flag, benchmarked against `_getGlobalLSHCandidates` and the
  multi-probe stack. Not started (would need the construction read carefully
  before any wiring).
- **Positional LSH** (arXiv 2605.09472) — attention with linear biases viewed
  through the LSH lens; grounds an attention-kernels-domain refinement
  (`../research/attention-kernels.md`), not the ANN index.
- **2L-LSH** (arXiv 2604.21442) — a two-level LSH construction for rapid indexing;
  a candidate index-structure refinement if the bank grows.
- **FOLD** (arXiv 2606.03001) — fuzzy online de-duplication: replace the exact
  `_computeContentHash` equality with an ANN similarity floor so near-duplicate
  prototypes are suppressed; candidate for the memory-write path, needs a
  similarity-floor criterion proved before wiring.
