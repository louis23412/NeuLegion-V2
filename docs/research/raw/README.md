# arXiv sweep — 2026-09

Query endpoint (HTTPS only; `http://` is rejected by the API):

```
https://export.arxiv.org/api/query?search_query=all:%22<url+encoded+phrase>%22
    &sortBy=submittedDate&sortOrder=descending&max_results=15
```

Quoted phrases must be percent-encoded. An unquoted multi-word query is treated
as OR and returns mostly unrelated papers (astronomy, materials, …); the noise is
discarded and only relevant hits are kept in the JSON snapshots.

## Snapshots

- `arxiv-sweep-2026-09.json` — first sweep (2026-09): test-time training/memory,
  neural memory / generative replay, LSH/ANN, RoPE, linear attention/SSM, MoE,
  knowledge distillation, catastrophic forgetting, deep ensembles, evolution
  strategies, purged CV / deflated Sharpe / financial ML.
- `arxiv-sweep-2026-09b.json` — **refresh** (2026-09-18): homeostatic plasticity
  / synaptic scaling, low-rank ES, test-time memory, continual learning, and
  financial-ML leakage / spurious-predictability hits that appear in the research
  notes. Diffs against the first snapshot.
- `arxiv-sweep-2026-09c.json` — **refresh** (2026-09-19): finance-validation focus
  (Cycle M). Walk-forward protocol (AlgoXpert IS/WFA/OOS), a robust strategy
  objective (GT-Score), regime-conditional strategy comparison, combinatorial
  purged CV, and the key leakage result — a **leaky Sharpe-35 oracle survives
  Deflated Sharpe / PBO** (2608.27734), which is why the harness *tests* for
  lookahead instead of relying on DSR.
- `arxiv-sweep-2026-09d.json` — **refresh** (Round 3): quoted-phrase queries for
  the PBO/CSCV front (Bailey et al. 2016; MinervaScore 2608.23808), walk-forward
  analysis, neural scaling laws (2609.03533 Coupled Scaling, 2608.07222 Skaling,
  2606.25008 universality), test-time training/adaptation, multi-probe LSH
  (MP-RW-LSH 2103.05864), deep ensembles, synaptic scaling and knowledge
  distillation. Only relevant hits are kept; OR-noise (thousands of unrelated
  physics papers from unquoted queries) is discarded.

- `arxiv-sweep-2026-09e.json` — **refresh** (Round 4): the multiple-testing /
  data-snooping front implemented by `analysis/reality_check.js`. Headline:
  **2608.23808 MinervaScore** — an independent 2026 production study (359,062
  backtest records) whose robustness grade composes **DSR + PBO + SPA + MinTRL**,
  the exact four-test battery this project now ships — plus **2409.12662**
  (Diebold-Mariano power collapses under autocorrelation → why SPA is studentized
  by a dependence-aware bootstrap SE), **1811.06766** (discrete FDR over 21k
  technical rules), **2602.00080** (GT-Score), and **2212.08372** (stepwise
  multiple testing → the Romano-Wolf StepM follow-up).
- `arxiv-sweep-2026-09f.json` — **refresh** (Round 5): the block-bootstrap /
  multiple-testing front behind consistent SPA_c + Romano-Wolf StepM. Headline:
  **0903.0474** (the stationary bootstrap has the *largest* asymptotic variance
  among block bootstraps — supports the measured finding that the RC/SPA size
  distortion on i.i.d. noise comes from block resampling, not studentization),
  **1403.3275** (convergence rates of empirical block-length selectors → grounds
  the `blockLength: "auto"` follow-up), **2212.08372** (asymptotics of stepwise
  multiple testing procedures), and **1602.02854** (stepwise control of
  directional errors under dependence).
- `arxiv-sweep-2026-09g.json` — **refresh** (Round 6): the block-length /
  long-run-variance / variance-consistent-inference front behind automatic
  block-length selection (section W) and the `docs/TODO.md` item-7 fix.
  Headline: **1809.04541** (lugsail lag windows — LRV/HAC estimators have
  *significant negative bias* under positive correlation, which is exactly the
  measured `bootSE/trueSE = 0.33` at φ=0.8) and its 2026 successor **2606.17369**
  (zero-lugsail kernels: zero asymptotic bias regardless of correlation strength);
  **1204.1035** (fixed-b subsampling + p-value calibration → the
  variance-consistent-resampling motivation); **2606.25968** (studentized cheap
  bootstrap → the Romano–Wolf "Siegfried" pathway); and self-normalization
  (**2509.07112**, **1302.0114**) as the tuning-free alternative that sidesteps
  LRV estimation.
- `arxiv-sweep-2026-09h.json` — **refresh** (Round 8): the family-wise-search /
  honest-evaluation-path front behind `docs/TODO.md` item 8. Headline:
  **2608.23808 MinervaScore** (search luck vs persistent edge — grounds reporting
  a search-corrected p-value next to DSR) and **2603.17226** (LRV estimation for
  **mean-shift** series — the SE analogue of the fold-boundary problem: a single
  window HAC estimate is biased when the level moves, so the walk-forward
  subsampling is done per segment via `groups`). Also **2512.14131** (exact FWER
  control), **2212.08372** / **1311.4030** / **0710.2258** (the stepwise /
  FDP / k-FWER family), **2512.12924** and **2602.10785** (walk-forward protocol
  and window-length sensitivity), and the carry-overs **2606.17369**,
  **1809.04541**, **1204.1035**.
- `arxiv-sweep-2026-09i.json` — **refresh** (Round 9): the **generalized-error-rate**
  front behind `docs/TODO.md` item 9 (shipped: section Z, `subsamplingKfwer` +
  `subsamplingFdp`) and item 10 (sustained power under a growing candidate
  universe). Headline: **math/0507420** (Romano & Wolf — *Generalizations of the
  Familywise Error Rate*, the k-FWER foundation), **math/0611266** / **0810.5004**
  (stepup / stepwise gFWER procedures), **2504.17611** (gFWER control *under
  dependence*, 2025), **math/0610843** / **1406.0266** (step-down FDP control and
  its finite-sample limits), and — the honest one — **1901.04885** (*only closed
  testing procedures are admissible for controlling FDP*), which is why
  `subsamplingFdp` ships **EXPERIMENTAL** rather than LOCKED-exact. FDP-uncertainty
  under dependence: **2207.00926** / **2207.01619** / **1010.6056** / **1305.7007**
  / **0803.1971**. Candidate-universe growth: **2601.10279** (stepwise asset-pricing
  model selection, 2026) and **2303.07631** (multiple testing under a high-dimensional
  dynamic factor model). Robust/heavy-tailed and online extensions: **2211.11959**,
  **2301.10392**, **1603.09000**, **2501.16985**, **1910.04900**. Carry-over:
  **2608.23808** (MinervaScore).
- `arxiv-sweep-2026-09j.json` — **refresh** (Round 13): the **data-aware hashing**
  front behind `docs/TODO.md` item 2 and the new `memory/binarypc.js`.
  Headline: **2608.04405** (BinaryPC — training-free hashing via binary principal
  components; the module's grounding) and **2609.02155** (*exact limits of random
  projections* for distance, NN-rank and covariance preservation — the
  theoretical reason a PCA-aligned basis is worth a flag). Data-dependent hashing:
  **1303.0339** (column generation), **1810.01008** (Hamming-distance targets).
  Taxonomy/comparison: **1408.2927**, **1612.07545**, **2102.08942**. Stronger /
  time-varying families: **1602.06922** (cross-polytope LSH), **2006.11284**
  (projected-NN). 2026 extensions: **2603.19724** (hyperbolic LSH),
  **2609.09427** (ultra-high-dim `l-infinity` ANN).
- `arxiv-sweep-2026-09k.json` — **refresh** (Round 14): the data-aware-hashing
  front *wired* into `memory/lsh.js#_refreshLshHyperplanes` (default-off
  `_pcaHashConfig`), plus the section-I finding that only the high-variance
  principal directions should be aligned. Headline: **1501.01062**
  (Andoni–Indyk–Laarhoven, *Optimal Data-Dependent Hashing* — an optimal
  data-dependent scheme beats the best data-independent LSH for every
  approximation factor `c > 1`; the optimality grounding for the whole
  direction), **1205.2930** (Density Sensitive Hashing — directions from the data
  density, the relative of the noise-tail effect), **1605.09784** (DrusillaHash —
  data-selected projection bases), **2009.08591** (weighted Hamming distance —
  bits are not equally reliable, grounds weighting/dropping the tail). Scaling:
  **0809.2274** (randomised PCA) and **1508.04535** (bit-scalable hashing). Fresh
  2026 theory: **2609.07681** (recall scaling laws via hashing) and **2602.19259**
  (sketch/ANN limits).
- `arxiv-sweep-2026-09l.json` — **refresh** (Round 15): the bit-reliability model
  new in `memory/bitweight.js` (the exact flip law
  `P = arccos(sqrt(lambda/(lambda+sigma^2)))/pi`, its binary-symmetric-channel
  reading, and the data-driven aligned-rank policy) plus the recorded section-I
  negative result on reliability-weighted candidate ranking. Headline fresh lead:
  **2608.15438** (NeuRoute — a learned hashing index whose query-time logits give
  an *uncertainty* signal that prioritises perturbing the bits the query is least
  sure of, i.e. reliability-weighted probing). Also **2603.24920** (PDET-LSH —
  index-construction efficiency with quality guarantees), **2607.24567**
  (DSCH-loss — an information-channel objective for hashing), **2605.28034**
  (Clark Hash — float queries scored against stored sketches), **2605.02030**
  (U-HNSW — universal-`Lp` graph ANN), **2601.09159** (isolation-kernel binary
  embeddings), **2605.11921** (LSH distortion for Ulam/Cayley similarities), and
  the still-open **2605.23807** (dynamic query modification) with **2608.04405**
  (BinaryPC, extended this round).
- `arxiv-sweep-2026-09m.json` — **refresh** (Round 16): the query-adaptive probe
  budget now in `memory/multiprobe.js` + `memory/bitweight.js`. Headline:
  **2604.04603** (*Adaptive Bucket Probing* — multi-probe LSH with a budget adapted
  to the query and the distance threshold; the direct grounding for a per-query
  probe depth), **2608.15438** (NeuRoute — query logits as an uncertainty signal
  that prioritises perturbing low-confidence bits; implemented with the
  uncertainty read off the exact flip law instead of a learned head) and
  **1904.08623** (query-adaptive hash-code ranking — the ranking-side sibling,
  deliberately NOT adopted because of the Round-15 recorded negative).
  Supporting: **2306.03612** (weighted-Hamming sequence extension),
  **2103.05864** (MP-RW-LSH, why some LSH families resist multi-probe). Still
  open: **2605.23807** (dynamic query modification).
- `arxiv-sweep-2026-09n.json` — **refresh** (Round 17): **2605.23807** (dynamic
  query modification) is now **implemented** — `memory/querymod.js` +
  `querymod.test.js` (51 checks) prove Theorems 1–2, Appendix C.1 and §6.4
  exactly and the denoising/hash-width-crossovers empirically, wired behind the
  default-off `_queryModConfig` (`lsh.test.js` section J). Next-cycle leads:
  **2604.24323** (Locality-Sensitive **Filtering** on the sphere — asymmetric
  filters that beat LSH's exponent on angular distance, the natural next index
  tier) and **2602.11322** (Predictive Associative Memory — retrieval by
  *temporal co-occurrence* rather than similarity, for the memory-retrieval
  domain). Supporting: **2606.18492** (dense holographic associative memories),
  **2606.28300** (Sinkhorn spherical Hellinger–Kantorovich recall),
  **2605.09472** (Positional LSH for linear-bias attention),
  **2604.21442** (2L-LSH point-cloud indexing), **2606.03001** (FOLD fuzzy
  online dedup).

## Topics swept

- test-time training / test-time memory
- neural memory / episodic memory / generative replay
- locality-sensitive hashing / approximate nearest neighbour / data-aware (PCA / binary principal component) hashing
- locality-sensitive filtering (asymmetric Gaussian filters on the sphere) / dynamic query modification
- associative memory retrieval (similarity vs temporal co-occurrence; dense/holographic Hopfield variants)
- rotary position embedding
- linear attention / state space models
- mixture of experts / routing
- block bootstrap / long-run variance estimation
- multiple testing / familywise error control / generalized FWER (k-FWER) / false discovery proportion
- knowledge distillation
- catastrophic forgetting / continual learning
- homeostatic plasticity / synaptic scaling
- deep ensembles / uncertainty
- evolution strategies / low-rank evolution strategies
- purged / combinatorial cross-validation, deflated Sharpe, triple-barrier, financial ML

## Re-running

A future agent can re-run the sweep with `fetch_url` + the query above and diff
the results against the snapshots above. The JSON keeps, per topic, the
id / date / title of the relevant hits only.
