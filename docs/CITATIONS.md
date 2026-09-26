# NeuLegion — bibliography

Citations are grouped by domain. arXiv identifiers are as returned by the
2026-09 sweep (and its 2026-09-18 / Round-3 refreshes); raw results are in
[`research/raw/`](research/raw/). Classic (non-arXiv) references are given with
venue/year so they remain findable.

## Memory & retrieval

- Behrouz, Zhong, Mirrokni. *Titans: Learning to Memorize at Test Time.* arXiv 2501.00663.
- *Titans Revisited: A Lightweight Reimplementation and Critical Analysis.* arXiv 2510.09551.
- *Titans-as-a-Layer: Test-Time Memory for Conversational Speech Emotion Recognition.* arXiv 2606.08573.
- *Self-Evolving World Models for LLM Agent Planning.* arXiv 2606.30639.
- *A Hippocampus for Linear Attention: An Exact Memory for What the Recurrent State Forgets.* arXiv 2607.02303.
- *Eviction as Estimation: A Fixed-Lag Smoothing View of Test-Time Memory.* arXiv 2607.24667.
- *Mela: Test-Time Memory Consolidation based on Transformation Hypothesis.* arXiv 2605.10537.
- *Anatomy of Associative Recall in Fixed-State Recurrences.* arXiv 2609.16183.
- Ramsauer et al. *Hopfield Networks is All You Need.* arXiv 2008.02217.
- Kanerva. *Sparse Distributed Memory.* MIT Press, 1988.

## LSH & approximate nearest neighbours

- Charikar. *Similarity Estimation Techniques from Rounding Algorithms.* STOC 2002.
- *Training-Free Hashing-Based Attention via Binary Principal Components.* arXiv 2608.04405. (data-aware hashing — use the data's principal components as the hash hyperplanes rather than random ones, so a fixed bit budget carries more variance; grounds `hivemind/memory/binarypc.js` and its Eckart–Young dominance proof, and the wired `_refreshLshHyperplanes` refresh)
- Andoni, Indyk & Laarhoven. *Optimal Data-Dependent Hashing for Approximate Near Neighbors.* arXiv 1501.01062 (STOC 2015). (an optimal data-dependent scheme beats the best data-independent LSH for every approximation factor `c > 1` — the optimality grounding for aligning the hash to the data)
- *Density Sensitive Hashing.* arXiv 1205.2930. (hash directions from the data *density*, not just the covariance — the research relative of the measured low-variance noise-tail effect)
- *Fast approximate furthest neighbors with data-dependent hashing (DrusillaHash).* arXiv 1605.09784. (projection bases selected from the data distribution)
- *Fast Search on Binary Codes by Weighted Hamming Distance.* arXiv 2009.08591. (hash bits are not equally reliable — grounds the weighted-Hamming metric in `hivemind/memory/bitweight.js`)
- Cover & Thomas. *Elements of Information Theory* (2nd ed.), Wiley 2006. (binary symmetric channel — the bit is a channel about the neighbourhood with crossover `P(flip)`, so its reliability is `1 − H₂(P)`; grounds the information reading of the flip law)
- *NeuRoute: Logit-Guided Neural Routing for Billion-Scale Vector Search with Sub-Hour Index Construction.* arXiv 2608.15438. (2026 — a learned hashing index whose query-time logits yield an *uncertainty* signal that prioritises perturbing the bits the query is least sure of: reliability-weighted probing, learned rather than from the spectrum. Grounds the Round-16 query-adaptive probe budget — same idea, with the uncertainty read off the exact flip law `Φ(−|margin|/σ)` instead of a logit head)
- *PDET-LSH: Scalable In-Memory Indexing for High-Dimensional ANN with Quality Guarantees.* arXiv 2603.24920. (index-construction efficiency)
- *DSCH-Loss: A Dynamic Semantic Channel Objective for Deep Semantic Hashing.* arXiv 2607.24567. (an information-channel objective for hash bits)
- *Clark Hash: Stateless Sparse Johnson-Lindenstrauss Quantization for Neural Embeddings.* arXiv 2605.28034. (float queries scored against stored sketches — the mirror of a binary bucket index plus an exact cosine rescore)
- *U-HNSW: An Efficient Graph-based Solution to ANNS Under Universal Lp Metrics.* arXiv 2605.02030.
- *A randomized algorithm for principal component analysis.* arXiv 0809.2274. (Halko, Martinsson & Tropp — the randomised range finder, the scaling path for a large aligned rank)
- *Bit-Scalable Deep Hashing with Regularized Similarity Learning.* arXiv 1508.04535. (choose the code length with the data — grounds the oversubscribed-hash-width observation)
- *On the Recall Scaling Laws in Mamba: A Theoretical and Mechanistic Study via Hashing.* arXiv 2609.07681. (2026 — recall-vs-width scaling laws for hashing-based associative recall)
- *Dynamic Query Modification for Binary Locality Sensitive Hashing.* arXiv 2605.23807. (the query-side companion to data-aware hashing — replace the query with the l2-normalised centroid of the neighbours found so far; grounds `hivemind/memory/querymod.js`: Theorem 1 maximality of the centroid, Theorem 2 first-order ACP, Appendix C.1 minimal residual covariance, §6.4 hash-failure elimination, and the denoising/synthetic regime laws, all proved in `querymod.test.js`)
- *A Tour of Locality Sensitive Filtering on the Sphere.* arXiv 2604.24323. (asymmetric Gaussian *filters* — a data point and a query independently select caps — can beat LSH's collision exponent for angular distance; the self-contained unit-sphere treatment is exactly NeuLegion's projection space, so this is the next index-tier lead for `hivemind/memory/lsh.js`)
- *Predictive Associative Memory: Retrieval Beyond Similarity Through Temporal Co-occurrence.* arXiv 2602.11322. (retrieve the memory that *followed* a similar state rather than the state that looks similar — a research direction for the memory-retrieval path; needs a trained predictor, not a pure-function proof)
- *Dense Holographic Associative Memories.* arXiv 2606.18492. (dense Hopfield-style associative recall via a volume-hologram analogy — capacity/denoising theory for the episodic bank)
- *Sinkhorn Based Associative Memory Retrieval Using Spherical Hellinger Kantorovich Dynamics.* arXiv 2606.28300. (an optimal-transport retrieval energy over weighted point clouds — a heavier recall operator than the cosine kernel)
- *Positional LSH: Binary Block Matrix Approximation for Attention with Linear Biases.* arXiv 2605.09472. (positional-bias attention through the LSH lens — an attention-kernels-domain lead)
- *2L-LSH: A Locality-Sensitive Hash Function-Based Method For Rapid Point Cloud Indexing.* arXiv 2604.21442. (a two-level LSH construction — a candidate index-structure refinement)
- *Exact Limits of Random Projections for Preserving Geometry: Distance Recovery, Nearest-Neighbor Rankings, and Covariance Shape in Gaussian Models.* arXiv 2609.02155. (quantifies what data-INdependent random projections fail to preserve — the theoretical case for the data-aware PCA-aligned basis in `hivemind/memory/binarypc.js`)
- *Spectral-LSH: Sub-Quadratic Prompt Compression via Krylov-Projected LSH.* arXiv 2607.19368.
- *MESS: Fast and Private Semantic Search on Multi-Graph HNSW.* arXiv 2607.28999.
- *Learning Partition Trees for Nearest Neighbor Search.* arXiv 2607.09909.
- *MP-RW-LSH: An Efficient Multi-Probe LSH Solution to ANNS in L1 Distance.* arXiv 2103.05864.
- *Cardinality Estimation for High-Dimensional Similarity Queries with Adaptive Bucket Probing.* arXiv 2604.04603. (2026 — adopts multi-probe LSH but explores neighbouring buckets with a budget adapted to the query and the distance threshold; grounds the query-adaptive probe depth in `hivemind/memory/multiprobe.js` / `bitweight.js`)
- *Query-Adaptive Hash Code Ranking for Large-Scale Multi-View Visual Search.* arXiv 1904.08623. (the sibling idea for ranking — query-adaptive bitwise/tablewise weighting rather than a fixed Hamming score)
- *FOLD: Fuzzy Online Deduplication for Very Large Evolving Datasets via ANN.* arXiv 2606.03001.

## Attention, kernels & normalisation

- Su et al. *RoFormer: Enhanced Transformer with Rotary Position Embedding.* arXiv 2104.09864.
- *Disentangling the Expressivity of RoPE.* arXiv 2608.11909.
- *Position Encoding in Transformers: … RoPE and Long-Context Scaling.* arXiv 2608.10021.
- *ATFlash: Per-RoPE-Wavelength Attention Windows.* arXiv 2608.02947.
- Zhang & Sennrich. *Root Mean Square Layer Normalization.* arXiv 1910.07467.
- Shazeer. *GLU Variants Improve Transformer.* arXiv 2002.05202.
- Ramachandran et al. *Searching for Activation Functions.* arXiv 1710.05941.
- *Higher-Dimensional Rotary Position Embedding.* arXiv 2608.29715.
- *MeRoTune: RoPE-Safe Merging with a Tunable Dial.* arXiv 2609.07971.
- *RoLA: Rotary-Positioned Low-Rank Linear Attention for Efficient Diffusion Transformers.* arXiv 2609.06712.
- *Modern Transformers Are Implicit Hybrids.* arXiv 2609.02986.
- *SpectralShift: Context Extension of Gated DeltaNet.* arXiv 2609.14320.
- *Consensus Dynamics in Selective State Space Models.* arXiv 2609.17997.
- *RunningTensor: Generalizing Linear Attention to Higher-Order Recurrent States.* arXiv 2609.12814.
- *Content-Based Addressing for Long Context.* arXiv 2609.07314.

## Structure scaling (width / depth)

- Kaplan et al. *Scaling Laws for Neural Language Models.* arXiv 2001.08361.
- Yang et al. *Tensor Programs V: Tuning Large Neural Networks via Zero-Shot Hyperparameter Transfer* (μP). arXiv 2203.03466.
- *Coupled Scaling: A Representational Accessibility Framework for Neural Scaling.* arXiv 2609.03533.
- *Skaling: Chinchilla's Exponents Meet Kaplan's Coupling.* arXiv 2608.07222.
- *Neural Scaling Universality: If Exponents Are Fixed, Time to Understand Them.* arXiv 2606.25008.
- *The Entropic Bound for Transformers: Why Static Rank Fails and Attention Wins.* arXiv 2607.23050.

## Ensemble & evolution

- Lakshminarayanan, Pritzel, Blundell. *Simple and Scalable Predictive Uncertainty Estimation using Deep Ensembles.* arXiv 1612.01474.
- *Breaking Diversity Collapse in Spiking Pseudo-Ensembles.* arXiv 2608.01090.
- *Reliability Analysis for BraTS-GoAT: Deep-Ensemble Uncertainty.* arXiv 2608.13223.
- *EGGROLL, Unrolled: Low-Rank Evolution Strategies at Scale.* arXiv 2609.10980.
- *Gradient-Free Training of Spiking Neural Networks via Low-Rank Evolution Strategies.* arXiv 2605.30361.
- *Understanding Evolution Strategies for LLM Reasoning.* arXiv 2608.27351.
- *Integer Natural Evolution Strategies.* arXiv 2608.23714.
- Salimans et al. *Evolution Strategies as a Scalable Alternative to RL.* arXiv 1703.03864.
- Hansen. *The CMA Evolution Strategy: A Tutorial.* arXiv 1604.00772.

## Training & distillation

- Hinton, Vinyals, Dean. *Distilling the Knowledge in a Neural Network.* arXiv 1503.02531.
- *Multi-Teacher Distillation for Cross-Domain Streaming Speech Encoding.* arXiv 2609.18686.
- *Enhanced Knowledge Distillation for Detection Transformer via Teacher Prediction Refinement.* arXiv 2609.19964.
- *Label-Guided Knowledge Distillation for 3D-CNNs.* arXiv 2609.13024.
- *Knowledge Distillation of a Normalising Flow for Real-Time Anomaly Detection.* arXiv 2609.15295.
- *Infinite-Parameter LLMs: Generating and Adapting Weights from Live Data.* arXiv 2609.18842.
- *Confidence-Anchored Test-Time Adaptation for GUI Grounding.* arXiv 2609.15307.
- *Rollback the World, Keep the Reflection.* arXiv 2609.18304.

## Continual learning

- Kirkpatrick et al. *Overcoming Catastrophic Forgetting in Neural Networks.* PNAS 2017, arXiv 1612.00796.
- Shin et al. *Continual Learning with Deep Generative Replay.* arXiv 1705.08690.
- *Effects of Introducing Synaptic Scaling on Spiking Neural Network Learning.* arXiv 2601.11261.
- *Local homeostatic regulation of the spectral radius of echo-state networks.* arXiv 2101.10665.
- *DR.WILSS: Diffusion-Based Replay for Weakly Supervised Continual Semantic Segmentation.* arXiv 2609.18444.
- *Past, Future, All at Once: Post-hoc JANUS Rectification.* arXiv 2609.19985.
- *Homeostatic Continual Learning.* arXiv 2609.13771.
- *Uncertainty-Aware Continual Learning for Open-World Intent Discovery.* arXiv 2609.17866.
- *CLARE: Scalable Class-Incremental Continual Learning via Sparsity.* arXiv 2609.17026.
- *Parameter Isolation with Domain-Specific Experts.* arXiv 2609.14730.
- *Where Should a Document Live: Context, Representations, or Parameters?* arXiv 2609.17346.

## Financial validation

- López de Prado. *Advances in Financial Machine Learning.* Wiley, 2018.
- López de Prado. *Machine Learning for Asset Managers.* Cambridge, 2020.
- Bailey & López de Prado. *The Deflated Sharpe Ratio.* 2014.
- Bailey, Borwein, López de Prado, Zhu. *The Probability of Backtest Overfitting.* Journal of Computational Finance, 2016. (combinatorially symmetric cross-validation; `analysis/overfitting.js`)
- Bailey, Borwein, López de Prado, Zhu. *Pseudo-Mathematics and Financial Charlatanism.* 2014.
- Politis & Romano. *The Stationary Bootstrap.* JASA, 1994. (geometric-block resampling for the bootstrap p-values and for the RC/SPA draws)
- Politis & White. *Automatic Block-Length Selection for the Dependent Bootstrap.* Econometric Reviews 23(1):53–70, 2004. (flat-top-lag-window block-length selector: `K_n = max(5, ceil(sqrt(log10 n)))`, the smallest `m` with autocorrelations below `2·sqrt(log10(n)/n)`, then `b_opt = (2·g²/D_SB)^(1/3)·n^(1/3)`; `analysis/reality_check.js` `politisWhiteBlockLength`)
- Patton, Politis & White. *Correction to "Automatic Block-Length Selection for the Dependent Bootstrap".* Econometric Reviews 28(4):372–375, 2009. (adds the circular-bootstrap variant and the `m ≤ m_max` / `b ≤ b_max` caps reproduced in `politisWhiteBlockLength`)
- Politis & Romano. *Large Sample Confidence Regions Based on Subsamples under Minimal Assumptions.* Annals of Statistics 22(4):2031–2050, 1994. (variance-consistent **subsampling** — the reference distribution is built from overlapping windows of the same series, so no long-run-variance estimate is needed; `analysis/reality_check.js` `subsamplingSpa`/`subsamplingStepM`)
- Politis, Romano & Wolf. *Subsampling.* Springer Series in Statistics, 1999 (ch. 3–4). (the subsampling theory for the studentized statistic: the window studentization is approximately pivotal, which is why the window and full scales must share one bandwidth)
- *Lugsail Lag Windows for Estimating Time-Average Covariance Matrices.* arXiv 1809.04541. (kernel HAC/LRV estimators have a significant **negative** bias under positive correlation — the mechanism behind the block bootstrap's under-estimated studentizer, measured at `bootSE/trueSE ≈ 0.33` for φ=0.8, T=120)
- *Inference Optimal Long Run Variance Estimation with Lugsail Kernels.* arXiv 2606.17369. (zero-lugsail kernels: zero asymptotic bias for the long-run variance regardless of correlation strength, with inference-optimal bandwidths)
- *Fixed-b Subsampling and Block Bootstrap: Improved Confidence Sets Based on P-value Calibration.* arXiv 1204.1035. (bandwidth sensitivity of subsampling p-values, and the calibration that makes them size-correct — grounds pinning ONE bandwidth shared by the window and full scales in `subsamplingSpa`)
- *Difference-Based High-Dimensional Long-Run Covariance Matrix Estimation for Mean-shift Time Series.* arXiv 2603.17226. (a single-window HAC estimate is biased when the level moves between segments — the standard-error analogue of the walk-forward fold boundary, motivating the segment-aware `groups` resampling in `subsamplingSpa` / `subsamplingStepM` / `walkForwardSearch`)
- *Most Powerful Test with Exact Family-Wise Error Rate Control: Necessary Conditions and a Path to Fast Computing.* arXiv 2512.14131.
- *On Asymptotic Behaviors of Stepwise Multiple Testing Procedures.* arXiv 2212.08372. (the step-down/step-up family the Romano–Wolf StepM belongs to)
- *New Procedures Controlling the False Discovery Proportion via Romano–Wolf's Heuristic.* arXiv 1311.4030. (extends the step-down to FDP when the candidate universe grows past a handful)
- *Control of Generalized Error Rates in Multiple Testing.* arXiv 0710.2258. (k-FWER / FDP — the relaxation used when strict FWER costs too much power)
- Romano & Wolf. *Generalizations of the Familywise Error Rate.* Annals of Statistics 33(3):1138–1154, 2005. (the k-FWER criterion and its single-step / step-down constructions; `analysis/reality_check.js` `subsamplingKfwer`; preprint arXiv math/0507420)
- *Stepup Procedures for Control of Generalizations of the Familywise Error Rate.* arXiv math/0611266. (step-up / step-down gFWER constructions — grounds choosing the single-step k-FWER and the step-down FDP as the two ends of the family)
- *On Stepwise Control of the Generalized Familywise Error Rate.* arXiv 0810.5004. (the general stepwise gFWER scheme `subsamplingFdp` instantiates — why the reference must be taken over the FULL family, not a survivor set)
- *Some Results on Generalized Familywise Error Rate Controlling Procedures under Dependence.* arXiv 2504.17611. (gFWER control remains available for CORRELATED test statistics — the walk-forward family, which is why `subsamplingKfwer` references the full family on the shared window grid)
- *On Stepdown Control of the False Discovery Proportion.* arXiv math/0610843. (the step-down FDP construction `subsamplingFdp` follows — descend in statistic order, apply a growing-k reference)
- *Further Results on Controlling the False Discovery Proportion.* arXiv 1406.0266. (finite-sample limits of step-down FDP control — one reason `subsamplingFdp` is labelled EXPERIMENTAL)
- *Only Closed Testing Procedures are Admissible for Controlling False Discovery Proportions.* arXiv 1901.04885. (a step-down heuristic is not closed testing, so it cannot rigorously control the FDP — the honest, citable reason `subsamplingFdp` ships EXPERIMENTAL)
- *Asymptotic Uncertainty of False Discovery Proportion for Dependent t-Tests.* arXiv 2207.01619. (realized-FDP uncertainty under exactly the dependence the walk-forward candidate streams have — why `estimatedFdp` is a point estimate, not a guaranteed bound)
- *Estimating False Discovery Proportion Under Arbitrary Covariance Dependence.* arXiv 1010.6056. (dependence-robust FDP estimation — a future upgrade path for `estimatedFdp`)
- *Selecting and Testing Asset Pricing Models: A Stepwise Approach.* arXiv 2601.10279. (finance-domain analogue of growing the candidate universe with a stepwise multiple-testing screen — grounds `docs/TODO.md` item 10)
- *Multiple Testing under High-dimensional Dynamic Factor Model.* arXiv 2303.07631. (factor-driven dependence as the candidate universe grows — the structure to expect when more features enter the family)
- *Interpretable Hypothesis-Driven Trading: A Rigorous Walk-Forward Validation Framework for Market Microstructure Signals.* arXiv 2512.12924.
- *A Novel Approach to Trading Strategy Parameter Optimization Using Double Out-of-Sample Data and Walk-Forward Techniques.* arXiv 2602.10785. (walk-forward window-length sensitivity — why the subsampling `windowLength` is an explicit knob rather than a hidden default)
- White. *A Reality Check for Data Snooping.* Econometrica 48(5):1097–1126, 2000. (bootstrap max-statistic over candidate strategies; `analysis/reality_check.js`)
- Hansen. *A Test for Superior Predictive Ability.* Journal of Business & Economic Statistics 23(4):365–380, 2005. (studentized, recentred SPA — less conservative than RC when many candidates are poor; `analysis/reality_check.js`)
- Romano & Wolf. *Stepwise Multiple Testing as Formalized Data Snooping.* Econometrica 73(4):1237–1282, 2005. (the step-down max-t that names *which* candidates beat the benchmark while controlling the family-wise error rate; `analysis/reality_check.js`) Hansen (2005) §4 supplies the *consistent* recentring `A_k = ω_k·√(2 ln ln T)` used by the consistent SPA p-value and the step-down.
- *Testing for Equal Predictive Accuracy with Strong Dependence.* arXiv 2409.12662. (Diebold-Mariano power collapses under autocorrelation — why SPA is studentized by a dependence-aware bootstrap standard error)
- Pardo. *The Evaluation and Optimization of Trading Strategies.* Wiley, 2008. (walk-forward analysis)
- *When Alpha Disappears: A One-Switch Benchmark for Decision-Time Leakage in Financial Backtests.* arXiv 2605.23959.
- *What Survives Honest Evaluation? Leakage-Safe, Search-Aware Assessment of LLM-Driven Trading Strategy Discovery.* arXiv 2608.27734. (a leaky Sharpe-35 oracle **survives** DSR/PBO — statistical correction is not a substitute for a structural look-ahead guardrail)
- *AlgoXpert Alpha Research Framework: A Rigorous IS/WFA/OOS Protocol for Mitigating Overfitting in Quantitative Strategies.* arXiv 2603.09219.
- *The GT-Score: A Robust Objective Function for Reducing Overfitting in Data-Driven Trading Strategies.* arXiv 2602.00080.
- *Regime-Conditional Distributional Comparison of Trading Strategies: A GAMLSS/ZAGA Framework.* arXiv 2606.31251.
- *Spurious Predictability in Financial Machine Learning.* arXiv 2604.15531.
- *Equity Strategy Backtesting: Luck or Edge? The MinervaScore as a Statistical Robustness Grade.* arXiv 2608.23808. (independent 2026 production study — 359,062 backtest records — whose robustness grade composes **DSR + PBO + SPA + MinTRL**, the same four-test battery this project ships)
- *Volatility-Aware Extreme Event Detection in High-Frequency Financial Markets.* arXiv 2607.17555.
- *Stock Price Prediction Using Triple Barrier Labeling and Raw OHLCV Data.* arXiv 2504.02249.
- *Supervised Autoencoders with Fractionally Differentiated Features and Triple Barrier Labelling.* arXiv 2411.12753.
- Binance. *Symbol tick size & price precision* (`exchangeInfo` `PRICE_FILTER.tickSize`). Platform docs, 2024.
- *Hopfield Networks for Asset Allocation.* arXiv 2407.17645.
- *Conditional Independence Testing in Time Series.* arXiv 2609.20772.
- *SPEAR NeXT: Causal Latent Forecasting Across Multiple Horizons.* arXiv 2609.16871.
- Cameron & Miller. *A Practitioner's Guide to Cluster-Robust Inference.* Journal of Human Resources 50(2):317–372, 2015. (clusters are the independent units; the cluster-robust variance estimator and the t(C−1) reference distribution with few clusters — grounds `analysis/dependence.js` `clusterJackknife`/`pairedClusterTest` and the fold-window cluster view)
- Künsch. *The Jackknife and the Bootstrap for General Stationary Observations.* Annals of Statistics 17(3):1217–1241, 1989. (the delete-block jackknife variance estimator for serially dependent data — deleting one fold window across all streams and re-estimating is exactly this estimator applied to the walk-forward's own block structure)
- Karim, Nielsen, MacKinnon & Webb. *Improved Inference for CSDID Using the Cluster Jackknife.* arXiv 2602.12043, 2026. (the delete-one-cluster jackknife repairs over-rejection with few/unequal clusters — the same remedy, independent 2026 evidence; grounds preferring the jackknife over the planned equicorrelation scaling of the pooled Sharpe SE)
- Kish. *Survey Sampling.* Wiley, 1965. (the design effect `1 + (K−1)ρ`: K correlated units are worth `K/(1+(K−1)ρ)` independent ones — the `equicorrelationDesignEffect` / `effectiveStreams` diagnostic, and the reason K streams are not K observations)
- Ledoit & Wolf. *Robust Performance Hypothesis Testing with the Sharpe Ratio.* Journal of Empirical Finance 15(5):850–859, 2008. (comparing two Sharpe ratios on dependent samples — the paired-cluster Sharpe difference behind `requireSharpeDiff`)
- Demšar. *Statistical Comparisons of Classifiers over Multiple Data Sets.* Journal of Machine Learning Research 7:1–30, 2006. (the exact sign test as the robust paired comparison, recommended over the t-test for non-normal paired samples — grounds `pairedClusterSignTest` and the `requireBreadth` hurdle)
- Halle, Djurović, Andreassen & Langaas. *Is the Familywise Error Rate in Genomics Controlled by Methods Based on the Effective Number of Independent Tests?* arXiv 1612.04535, 2016. (methods that substitute an effective number of independent tests for the number of tests actually run do **not** control the FWER — the citable reason `effectiveTrials` is a diagnostic and the deflated Sharpe keeps `trials = K`)
- Harvey, Liu & Zhu. *…and the Cross-Section of Expected Returns.* Review of Financial Studies 29(1):5–68, 2016. (correlated tests are still tests that were run: the multiple-testing hurdle grows with the number searched — the second reason `trials = K` is retained even when the family is concentrated)
- Frazzini, Israel & Moskowitz. *Trading Costs.* SSRN 3221167, 2018. (the empirical scale of trading costs, and why a gross-only verdict is not a verdict — grounds the `costLadder` levels and `breakEvenCostBps`)
- Binance. *Spot and USDⓈ-M futures fee schedules* (spot taker 10 bps, USDⓈ-M futures taker 5 bps). Platform docs, 2024–2026. (the concrete cost levels the default `costLadder` brackets)

## Trading costs, turnover & position policy

Grounding for round 26 (R26-3/R26-5): the *economic* half of the ceiling the
`20260921T062511-seed1` run exposed. The signal family's gross edge per unit of
turnover is 0.09-3.47 bps against a 5-10 bps taker cost, so the question is not
whether a signal predicts but whether its prediction can be *held* long enough to
pay for the trading it implies. **(Window-dependence caveat, round 26: that figure
is the 2,200-bar sample. On the 600-bar design the same family measures 14.64 bps
(`sig:momentum`) and 11.57 bps (`sig:acceleration`) — clearing a 5-10 bps taker —
at the same per-bar turnover, because the momentum edge is concentrated in the
recent window. Cite the sample when a cost conclusion is drawn —
`RUN-ANALYSIS.md` §10.5.)**

- Constantinides. *Capital Market Equilibrium with Transaction Costs.* Journal of
  Political Economy 94(4):842–862, 1986. (a proportional transaction cost makes the
  optimal policy a **no-trade region**: do nothing until the position drifts outside
  a band — the theoretical form of the dead zone plus the holding rule in R26-5)
- Davis & Norman. *Portfolio Selection with Transaction Costs.* Mathematics of
  Operations Research 15(4):676–713, 1990. (characterises the region's boundaries
  and the impulse/continuity structure of the optimal policy — the reason an
  `enter`/`exit` hysteresis pair, not a single threshold, is the right parameterisation)
- Gârleanu & Pedersen. *Dynamic Trading with Predictable Returns and Transaction
  Costs.* Journal of Finance 68(6):2309–2340, 2013. (the modern dynamic formulation:
  the optimal trade is a fraction of the distance to the aim portfolio, with a
  cost-scaled **aim in and out** region — grounds trading *slower* rather than not at
  all, and supplies the "effective turnover" notion)
- *Optimal investment in illiquid market with search frictions and transaction
  costs.* arXiv 2101.09936. (small-cost asymptotics of the no-trade region's
  boundaries and value function — the quantitative shape the dead-zone sweep is
  searching over)
- *Large-Scale Portfolio Allocation Under Transaction Costs and Model Uncertainty.*
  arXiv 1709.06296. (shows turnover penalisation is *equivalent to* regularisation of
  the portfolio weights, and that it dominates ordinary shrinkage out of sample —
  the theoretical reason `clampPosition`/`deadZone` should be tuned against turnover
  rather than chosen a priori)
- *On the Effect of Alpha Decay and Transaction Costs on the Multi-period Optimal
  Trading Strategy.* arXiv 2502.04284. (models alpha decay — *past* signal values
  have predictive power — and derives the optimal multi-period policy under costs:
  the rigorous version of "hold a position while the decaying signal still justifies
  paying to keep it", i.e. exactly R26-5's hysteresis rule)
- *Finance-Grounded Optimization For Algorithmic Trading.* arXiv 2509.04541.
  (introduces **turnover regularization** — a loss term that constrains a learned
  position series' turnover to a pre-set budget — and shows financially grounded
  losses beat accuracy losses; the learning-side complement to the policy-side sweep)
- *Enhancing Time Series Momentum Strategies Using Deep Neural Networks.*
  arXiv 1904.04912. (Deep Momentum Networks learn trend *and* position sizing jointly
  by optimising the Sharpe ratio, retaining an edge after 2-3 bps of cost — evidence
  that a learned sizing/sign-shaping layer is the right place to attack turnover)
- Grinold. *The Fundamental Law of Active Management.* Journal of Portfolio
  Management 15(3):30–37, 1989. (the information ratio scales with √breadth, where
  breadth is the number of *independent* forecasts — the reason R26-6 buys effective
  independent streams rather than bars, and the finance-domain statement of the same
  design-effect correction `analysis/dependence.js` measures)
- Cawley & Talbot. *On Over-fitting in Model Selection and Subsequent Selection Bias
  in Performance Evaluation.* Journal of Machine Learning Research 11:2079–2107,
  2010. (model *selection* must be nested inside the evaluation or the reported
  performance is biased — the standard result behind R26-9's warning that reusing one
  warmed model across folds/trials changes what the fold statistics mean)
- *Identifying Predictions That Influence the Future: Detecting Performative Concept
  Drift in Data Streams.* arXiv 2412.10545. (trading is a performative setting where
  the deployed model can induce the drift it then reacts to; the argument *for*
  periodically refitting rather than snapshotting once — the other side of R26-9)
- Jamieson & Talwalkar. *Non-stochastic Best Arm Identification and Hyperparameter
  Optimization.* AISTATS 2016 (arXiv 1502.07943). (successive halving: give many
  arms a small budget, keep the top 1/eta, repeat — the engine behind R26-15)
- Li, Jamieson, DeSalvo, Rostamizadeh & Talwalkar. *Hyperband: A Novel Bandit-Based
  Approach to Hyperparameter Optimization.* JMLR 18(185):1–52, 2018 (arXiv
  1603.06560). (successive halving as a subroutine; the budget/eta schedule R26-15
  implements)
- Moskowitz & Grinblatt. *Do Industries Explain Momentum?* Journal of Finance
  54(4):1259–1295, 1999. (cross-sectional momentum: ranking a *basket* and going
  long the leaders / short the laggards — the construction that makes the common
  market factor cancel, so per-stream returns are far less correlated than the same
  feature applied to each stream independently; grounds round 26's cross-sectional
  lead)
- Moskowitz, Ooi & Pedersen. *Time Series Momentum.* Journal of Financial Economics
  104(2):228–250, 2012. (the time-series counterpart and the evidence that the two
  families are genuinely different bets — grounds the current signal family's
  framing and the diversity argument for adding the cross-sectional one)
- Asness, Moskowitz & Pedersen. *Value and Momentum Everywhere.* Journal of Finance
  68(4):929–985, 2013. (momentum across asset classes: combining weakly-correlated
  sleeves is how breadth is actually bought — the empirical form of Grinold's √breadth
  and of the round-26 composite lead)

## Experimental design, replication & model comparison

Grounding for round 26's family-search half (R26-11…R26-15). The correctness,
throughput and economics items make a *reading* trustworthy; these make a
*decision between models* legitimate. The core fact is that a variant ordering from
one seed is not a ranking, and the core tool is a paired, replicated, distribution-
aware comparison.

- Bouthillier, Laurent & Vincent. *Unreproducible Research is Reproducible.*
  Proceedings of the 36th International Conference on Machine Learning (ICML),
  2019. (running identical code with different seeds changes results materially,
  and seed-to-seed variation routinely exceeds the variation attributed to the
  factor being compared — the reason a single-seed variant ordering is not a family
  ranking, and the reason R26-13 exists)
- Henderson, Islam, Bachman, Pineau, Precup & Meger. *Deep Reinforcement Learning
  that Matters.* AAAI 2018. arXiv 1709.06560. (the same conclusion from the RL
  side, with the reporting recipe: several seeds, a distribution rather than a
  point, and the seed recorded in the manifest so a result can be reproduced)
- Agarwal, Schwarzer, Castro, Courville & Bellemare. *Deep Reinforcement Learning
  at the Edge of the Statistical Precipice.* NeurIPS 2021. arXiv 2108.13264.
  (interquartile mean and **stratified bootstrap** confidence intervals over runs,
  plus performance profiles — the honest summary of a noisy per-run metric, and the
  source of R26-13's "report the distribution, never a single run" rule)
- Glasserman & Yao. *Some Guidelines and Guarantees for Common Random Numbers.*
  Management Science 38(6):884–908, 1992. (**common random numbers**: using the same
  random stream across the alternatives being compared reduces the variance of the
  *difference* even though it leaves each level's variance alone — the reason the
  A/B's fold seed should be variant-independent, since "A beats B" is a statement
  about the paired difference)
- Jamieson & Talwalkar. *Non-stochastic Best Arm Identification and Hyperparameter
  Optimization.* AISTATS 2016. arXiv 1502.07943. (successive halving: give every arm
  a small budget, discard the statistically bad ones, reallocate — the principled
  way to search a family under a compute budget, which is exactly this project's
  constraint; grounds R26-15)
- Li, Jamieson, DeSalvo, Rostamizadeh & Talwalkar. *Hyperband: A Novel Bandit-Based
  Approach to Hyperparameter Optimization.* Journal of Machine Learning Research
  18(185):1–52, 2018. arXiv 1603.06560. (the bracket/racing formulation on top of
  successive halving, with the exploration/exploitation budget split explicit — the
  template for R26-15's driver)
- Diebold & Mariano. *Comparing Predictive Accuracy.* Journal of Business &
  Economic Statistics 13(3):253–263, 1995. (the paired test on per-period loss
  differentials — the correct way to say "model A forecasts better than model B" on
  the same bars, and the statistic R26-14 is built from)
- Hansen, Lunde & Nason. *The Model Confidence Set.* Econometrica 79(2):453–497,
  2011. (return the **set** of models that cannot be distinguished from the best at
  a chosen confidence, instead of crowning a winner from noisy, dependent losses —
  the right output when K families are compared, and R26-14's headline)
- Gneiting & Raftery. *Strictly Proper Scoring Rules, Prediction and Estimation.*
  Journal of the American Statistical Association 102(477):359–378, 2007. (which
  scores are **proper** — so "the model is good" cannot be earned by hedging toward
  the base rate; the constraint R26-14's and R26-2's metric choices must satisfy)
- Young. *A First Order Approximation to the Optimum Checkpoint Interval.*
  Communications of the ACM 17(9):530–532, 1974. (the checkpoint interval that
  balances dump cost against expected lost work — why a full-state dump on every
  call is far from optimal, and the frame for R26-12's `saveInterval`)
- Daly. *A Higher Order Estimate of the Optimum Checkpoint Interval for Restart
  Dumps.* Future Generation Computer Systems 22(3), 2006. (the refined interval for
  large dumps — the same tradeoff for the A/B, where the dump is large and the
  failure window is a whole run)

Added in round 27 — the **liveness / non-vacuity** discipline, which is what makes a
candidate's "it did not promote" a statement about the candidate rather than about
the harness:

- Adebayo, Gilmer, Muelly, Goodfellow, Hardt & Kim. *Sanity Checks for Saliency
  Maps.* NeurIPS 2018. arXiv 1810.03292. (the discipline: a mechanism must be
  subjected to a **randomised control** before its explanation/effect is believed —
  a method whose output is unchanged when the thing it claims to explain is
  randomised is untested, not validated. The candidate analogue is the round-27
  `liveness` certificate: a candidate that cannot differ from the baseline is
  `inert`, and an inert candidate must not contribute a "reason" or a `K` trial —
  the same rule `BUGS.md` #22 already applies to the look-ahead audit's probes)
- Fisher, Rudin & Dominici. *All Models are Wrong, but Many are Useful: Learning a
  Variable's Importance by Studying an Entire Class of Prediction Models
  Simultaneously.* JMLR 20(177):1–81, 2019. arXiv 1801.01489. (**model reliance** —
  the quantity a feature-ablation study is estimating, and the argument that
  attribution must be defined against the unit the feature can actually act on; the
  reason `multi-probe`/`query-mod` being off the controller's path is a
  *taxonomy* fact, not a performance result, `BUGS.md` #44)
- Gelman & Loken. *The Garden of Forking Paths: Why Multiple Comparisons Can Be a
  Problem, Even When There Is No "Fishing Expedition" or "p-Hacking" and the
  Research Hypothesis Was Posited Ahead of Time.* 2013 (unpublished). (a `K` that
  silently includes untested arms is not a conservative correction but a
  mis-statement of the search that was actually run; grounds the round-27
  `trialsRoster`/`trialsInactive` split)
- Abadie, Athey, Imbens & Wooldridge. *When Should You Adjust Standard Errors for
  Clustering?* Quarterly Journal of Economics 138(1):1–35, 2023. (the decisive
  question is whether the treatment varies within the cluster; with few clusters the
  t(C−1) reference is the honest one — together with Cameron & Miller 2015, the frame
  for the `pairedUnits.neededForObserved` sizing that names the next run's cheapest
  lever, R27-8)

## Observability, calibration & monitoring

Grounding for the dedicated outer analysis layer (`src/observer/`, ROADMAP P1-2) —
the online metrics that watch the legion's *internal* health, as opposed to the
`analysis/*` battery which scores its *returns*.

- Brier. *Verification of Forecasts Expressed in Terms of Probability.* Monthly Weather Review 78(1):1–3, 1950. (the Brier score — the proper scoring rule the consensus calibration is measured with)
- Murphy. *A New Vector Partition of the Probability Score.* Journal of Applied Meteorology 12(4):595–600, 1973. (the reliability–resolution–uncertainty decomposition, so a bad Brier score can be attributed to miscalibration rather than to an uninformative forecast)
- Wald. *Sequential Tests of Statistical Hypotheses.* Annals of Mathematical Statistics 16(2):117–186, 1945. (the sequential probability ratio test — a rolling hit-rate-vs-chance alarm that stops as soon as the evidence is decisive, instead of waiting for a fixed window)
- Page. *Continuous Inspection Schemes.* Biometrika 41(1/2):100–115, 1954. (CUSUM — the drift detector for per-controller score and consensus Brier; cheaper and better-powered than a moving-average threshold for a persistent mean shift)
- Cohen. *A Coefficient of Agreement for Nominal Scales.* Educational and Psychological Measurement 20(1):37–46, 1960. (Cohen's κ — chance-corrected member agreement, so "diversity" is not confused with "all members predict the majority class")
- Kuncheva & Whitaker. *Measures of Diversity in Classifier Ensembles and Their Relationship with the Ensemble Accuracy.* Machine Learning 51(2):181–207, 2003. (the diversity-measure family and its accuracy relationship — grounds using agreement/entropy as the echo-chamber alarm for the hivemind broadcast)
- Gini. *Variabilità e Mutabilità.* 1912. (the Gini coefficient — the influence-concentration readout)
- Hirschman. *National Power and the Structure of Foreign Trade.* 1945. (the Herfindahl–Hirschman index — the concentration readout alongside Gini, so a single-controller consensus capture is visible)

## Statistical sizing & decision coherence (round 28)

Grounding for `PLAN-round28.md` P1d/P1e and `METHOD.md` §7/§8 — how a *paired* decision must be
sized, and why a raw fold fraction is not a gate. The arithmetic is the project's own
(`analysis/dependence.js`, `analysis/decision.js`); these are the external anchors.

- Cameron & Miller. *A Practitioner's Guide to Cluster-Robust Inference.* Journal of Human Resources 50(2):317–372, 2015. (the cluster is the unit of independence; a test over correlated sub-observations over-states its own evidence — grounds using fold *windows*, not the 288 folds, and `pairedClusterTest`)
- Demšar. *Statistical Comparisons of Classifiers over Multiple Data Sets.* JMLR 7:1–30, 2006. (the exact sign test over paired units is the distribution-free majority statement — the error-controlled replacement for a raw win fraction)
- Ledoit & Wolf. *Robust Performance Hypothesis Testing with the Sharpe Ratio.* Journal of Empirical Finance 15(5):850–859, 2008. (the Sharpe *difference* and its standard error — the paired sizing is this SE, not the level's)
- Künsch. *The Jackknife and the Bootstrap for General Stationary Observations.* Annals of Statistics 17(3):1217–1241, 1989. (delete-block/delete-cluster resampling for serially dependent observations — `clusterJackknife`)
- Kish. *Survey Sampling.* Wiley 1965. (the design effect `deff = 1 + (m−1)ρ̄` — the effective-sample-size correction the DSR floor is evaluated on)
- Harvey, Liu & Zhu. *…and the Cross-Section of Expected Returns.* Review of Financial Studies 29(1):5–68, 2016. (count the searches: the deflated Sharpe keeps `trials = K`)
- arXiv 1612.04535. *Is the familywise error rate controlled by methods based on the effective number of independent tests?* (an effective test count is a diagnostic, never an FWER discount)
- Cohen. *Statistical Power Analysis for the Behavioral Sciences.* 2nd ed., 1988. (the `(z_α + z_β)²` power factor — why an 80 %-powered paired test needs ≈2–2.3× the significance-only clusters; a *one-sided* α is the reference the shipped test uses, so the two-sided `z = 1.959964` in `pairedUnitsNeeded` over-states the requirement)

## Cross-sectional / market-neutral sleeves (round 28 research lead)

Grounding for `PLAN-round28.md` P6 — buying *independent* breadth by cancelling the common
factor rather than by adding correlated streams (the design effect is the binding constraint:
`effectiveStreams` 2.05–2.47 of 8).

- Moskowitz & Grinblatt. *Do Industries Explain Momentum?* Journal of Finance 54(4):1249–1290, 1999. (cross-sectional momentum — rank the cross-section, long leaders / short laggards)
- Moskowitz, Ooi & Pedersen. *Time Series Momentum.* Journal of Financial Economics 104(2):228–250, 2012. (the time-series counterpart; the two sleeves are weakly correlated, so combining them buys breadth)
- Asness, Moskowitz & Pedersen. *Value and Momentum Everywhere.* Journal of Finance 68(3):929–985, 2013. (combining weakly correlated sleeves is the standard breadth purchase)
- arXiv 2302.10175. *Spatio-Temporal Momentum: Jointly Learning Time-Series and Cross-Sectional Strategies.* (the joint time-series + cross-sectional formulation)
- arXiv 2012.07149. *Building Cross-Sectional Systematic Strategies By Learning to Rank.* (a learned cross-sectional ranking objective)
- arXiv 2208.09968. *Transfer Ranking in Finance: Applications to Cross-Sectional Momentum with Data Scarcity.* (cross-sectional momentum under small `m` — the 8-stream case)
- arXiv 1908.02164. *Statistical Arbitrage for Multiple Co-Integrated Stocks.* (market-neutral eigenportfolio construction with backtests)
- arXiv 1901.09309. *High-dimensional statistical arbitrage with factor models and stochastic control.* (factor-neutral construction)
- Grinold. *The Fundamental Law of Active Management.* Journal of Portfolio Management 15(3):30–37, 1989. (breadth counts *independent* forecasts — the reason a market-neutral sleeve is worth more per stream than a ninth correlated one)

## Round 29 — the model class, new data sources, and configuration robustness

Grounding for [`PLAN-round29.md`](PLAN-round29.md) and the five
[`research/round29-*.md`](research/) notes plus the consolidated index
[`research/round29-README.md`](research/round29-README.md). The round-28 readout
established that the controller has **negative** forecast skill and that every
positive-Sharpe arm is ~100 % market exposure with an ≈0 cross-sectional residual; these
citations answer what the open-source record says about *why* and *where else to look*.

**Model class — is a from-scratch tiny transformer the right forecaster?**
- Zeng, Arik, Jenq, Huang, Steiner, Zohar. *Are Transformers Effective for Time Series
  Forecasting?* arXiv **2205.13504** (AAAI 2023). (DLinear: a one-layer linear model
  beats the LTSF transformer family; self-attention is permutation-invariant, so tokens
  lose temporal order — the mechanism behind a tiny attention model's negative skill)
- Elsayed, Thyssens, Rashed, Jomaa, Schmidt-Thieme. *Do We Really Need Deep Learning
  Models for Time Series Forecasting?* arXiv **2101.02118** (2021). (a GBRT baseline
  matches the deep models)
- Chen, Li, Bao, Wang, et al. *TSMixer: An All-MLP Architecture for Time Series
  Forecasting.* arXiv **2303.06053** (2023); Ekambaram et al. *TSMixer: Lightweight
  MLP-Mixer Model.* arXiv **2306.09364** (2023). (time+feature MLP mixing matches SOTA)
- Das, Kong, Leach, Mathur, Sen, Yu. *Long-term Forecasting with TiDE: Time-series
  Dense Encoder.* arXiv **2304.08424** (2024). Oreshkin et al. *N-BEATS.* arXiv
  **1905.10437** (2020). *A Temporal Linear Network for Time Series Forecasting.* arXiv
  **2410.21448** (2024).
- Ekambaram, Jati, Nguyen, Sinthong, Kalagnanam. *Tiny Time Mixers (TTMs).* arXiv
  **2401.03955** (2024). *Tiny-TSM.* arXiv **2511.19272** (2025). (1M–23M-parameter
  **pretrained** TSFMs beat training from scratch; the corpus, not the parameter count,
  is the lever)
- *Chronos.* arXiv **2403.07815** (2024); *Chronos-2.* arXiv **2510.15821** (2025);
  *Moirai.* arXiv **2402.02592** (2024); *Moirai 2.0.* arXiv **2511.11698** (2026);
  *TiRex.* arXiv **2505.23719** (2025); *In-Context Fine-Tuning for Time-Series
  Foundation Models.* arXiv **2410.24087** (2024).
- *Scaling Transformers for Time Series Forecasting: Do Pretrained Large Models
  Outperform Small-Scale Alternatives?* arXiv **2507.02907** (2025). *Forecasting
  Realized Volatility with Time Series Foundation Models: A Comparison with
  Econometric Benchmarks.* arXiv **2607.05291** (2026). (domain-scoped reality checks)
- Wood, Giegerich, Roberts, Zohren. *Trading with the Momentum Transformer.* arXiv
  **2112.08534** (2022). (attention beats TS-momentum benchmarks **net of cost** — but
  learned over a long history, not per 60-bar fold; the optimistic case, scoped)
- **The Red Queen's Trap: Limits of Deep Evolution in High-Frequency Trading.** arXiv
  **2512.15732** (2025). (a rigorous post-mortem of a genetic-survival + transformer
  trading system — the external test of the evolutionary-hivemind bet; grounds the
  decision *not* to wire `legion/evolve.js`)

**Crypto edges — reversal, factors, carry.**
- *Short-horizon mean reversion in cryptocurrency markets: a matched cross-market
  measurement.* arXiv **2608.21888** (2026). (**90 % of 183 Binance pairs** carry
  significant directional reversal at 15m vs 2.7 % of US equities; the signal lives in
  **signs, not magnitudes** — the strongest external lead for round-29 P3)
- *Cryptoasset Factor Models.* arXiv **1811.07860** (2019, with source code).
  *A Time-Varying Network for Cryptocurrencies.* arXiv **1802.03708** (2022). (return
  cross-predictability and technological similarity — a **conditional** cross-sectional
  structure)
- *Deep Learning Statistical Arbitrage.* arXiv **2106.04028** (2022). (arbitrage
  portfolios as **residuals from conditional latent factors** — the construction a
  cross-sectional sleeve must use, and the one that leaves *less* residual at 1h)
- *Quantifying Cryptocurrency Unpredictability.* arXiv **2502.09079** (2025). *Review
  of deep learning models for crypto price prediction.* arXiv **2405.11431** (2024).
- *BitMEX Funding Correlation with Bitcoin Exchange Rate.* arXiv **1912.03270** (2019).
  (funding is Granger-causal with the perp price and heteroskedastic) *Designing funding
  rates for perpetual futures in cryptocurrency markets.* arXiv **2506.08573** (2025).
  *Funding-Aware Optimal Market Making for Perpetual DEXs.* arXiv **2605.06405** (2026).
  (funding/basis as a structurally independent **carry** stream)
- *Optimal market-neutral currency trading on the cryptocurrency platform.* arXiv
  **2405.15461** (2024). *Dynamic Multi-Pair Trading Strategy in Cryptocurrency Markets
  with DRL.* arXiv **2606.04574** (2026).

**Adaptation, regime, and the cadence nuisance.**
- *Test-Time Adaptation for Non-stationary Time Series: From Synthetic Regime Shifts to
  Financial Markets.* arXiv **2602.00073** (2026). (frozen backbone, only
  **normalization affine** params updated on recent unlabeled windows — the antidote to
  schedule-bound retraining) *PETSA.* arXiv **2506.23424** (2025). *Towards Principled
  Test-Time Adaptation for TS Forecasting.* arXiv **2605.17250** (2026).
- *DeePM: Regime-Robust Deep Learning for Systematic Macro Portfolio Management.* arXiv
  **2601.05975** (2026). (the **"ragged filtration"** problem and a directed-delay
  **causal sieve** — causal impulse-response over information freshness)
- Adams & MacKay. *Bayesian Online Changepoint Detection.* arXiv **0710.3742** (2007);
  *Robust and Scalable Bayesian Online Changepoint Detection.* arXiv **2302.04759**
  (2023). *Exploring the Predictability of Cryptocurrencies via Bayesian Hidden Markov
  Models.* arXiv **2011.03741** (2020). (a four-state crypto regime model beats a
  single-regime random walk in forecast density)
- *Adaptive Financial Transformer with Regime-Gated Attention.* arXiv **2606.29347**
  (2026). *Adaptive and Regime-Aware RL for Portfolio Optimization.* arXiv **2509.14385**
  (2025).
- *Online Portfolio Selection: A Survey.* arXiv **1212.2129** (2013). *An Introduction
  To Regret Minimization In Algorithmic Trading.* arXiv **2105.13126** (2021). *Efficient
  and Near-Optimal Online Portfolio Selection.* arXiv **2209.13932** (2025). *Damped
  Online Newton Step for Portfolio Selection.* arXiv **2202.07574** (2022). *High order
  universal portfolios.* arXiv **2311.13564** (2023). *Noise-proofing Universal
  Portfolio Shrinkage.* arXiv **2511.10478** (2025). *Meta-Learning the Optimal Mixture
  of Strategies for Online Portfolio Selection.* arXiv **2505.03659** (2025). (a
  no-assumption baseline with a regret guarantee)
- *Model-free Online Learning for the Kalman Filter: Forgetting Factor and Logarithmic
  Regret.* arXiv **2505.08982** (2025).

**Configuration robustness and selection.**
- Lo. *The Statistics of Sharpe Ratios.* Financial Analysts Journal 58(4):36–52, 2002.
  (the Sharpe estimator depends on the **return measurement interval** under
  autocorrelation — the theory behind the round-28 cadence effect)
- *Connecting Sharpe ratio and Student t-statistic, and beyond.* arXiv **1808.04233**
  (2019). *Asymptotic distribution of the Markowitz portfolio.* arXiv **1312.0557**
  (2020).
- *Publication Bias in Asset Pricing Research.* arXiv **2209.13623** (2023). *The
  Corporate Bond Factor Replication Crisis.* arXiv **2604.07880** (2026). *Multi-Factor
  Inception: What to Do with All of These Features?* arXiv **2307.13832** (2023).
  *Avoiding Backtesting Overfitting by Covariance-Penalties.* arXiv **1905.05023**
  (2019).
- *AlgoXpert Alpha Research Framework: A Rigorous IS/WFA/OOS Protocol.* arXiv
  **2603.09219** (2026). (**stable parameter regions**; **majority pass + catastrophic
  veto**; parameters locked OOS — the template for round-29 P2) *Interpretable
  Hypothesis-Driven Trading: A Rigorous Walk-Forward Validation Framework.* arXiv
  **2512.12924** (2025). *A Novel Approach to Trading Strategy Parameter Optimization
  Using Double Out-of-Sample Data and Walk-Forward Techniques.* arXiv **2602.10785**
  (2026). *The GT-Score.* arXiv **2602.00080** (2026).
- *Optimal Turnover, Liquidity, and Autocorrelation.* arXiv **2110.03810** (2022).
  (steady-state turnover has a closed form in the alpha's **autocorrelation** and
  liquidity — the right objective for the dead-zone/cost work)

**Ensemble size — is a bigger per-controller ensemble worth testing? (round-29 P7/P7b;
`research/round29-ensemble-size.md`)**
- *Linear Ensemble Sampling with Smaller Ensembles.* arXiv **2609.13954** (2026). (the
  regret framework needs `Θ(d log T)` members with an intrinsic `Ω(d)` barrier, and
  **smaller** ensembles retain the guarantee — size follows the effective dimension)
- *Time-uniform accuracy of ensemble Kalman filters with localization.* arXiv
  **2609.23927** (2026). (the required ensemble size depends on the **effective rank** of
  the covariance and the unstable-subspace dimension, not the ambient dimension — a
  second, independent statement of the same principle)
- *Decorrelation Is Not Complementarity: Skill, Not Lineage, Governs Trusted-Monitor
  Ensembles.* arXiv **2608.16190** (2026). (**minimising pairwise correlation is not
  complementarity; the members' skill governs** — the central counterweight to
  "more members → more diversity → more skill")
- Lakshminarayanan, Pritzel & Blundell. *Simple and Scalable Predictive Uncertainty
  Estimation using Deep Ensembles.* arXiv **1612.01474** (2016). (the canonical
  deep-ensembles result: calibrated uncertainty, **diminishing returns in `M`**; already
  cited in `research/ensemble-evolution.md`)
- *BatchEnsemble: An Alternative Approach to Efficient Ensemble and Lifelong Learning.*
  arXiv **2002.06715** (2020). ("an ensemble's cost … increases **linearly** with the
  number of networks, which quickly becomes untenable"; per-member rank-1 modulation of a
  shared backbone — the many-cheap-members template)
- *Model soups: averaging weights of multiple fine-tuned models improves accuracy without
  increasing inference time.* arXiv **2203.05482** (2022). *Trainable Weight Averaging.*
  arXiv **2205.13104** (2022). (the many-member benefit in **weight space**, at
  single-model inference cost)
- *Virtual neural networks: hundreds of souls in a body.* arXiv **2609.24782** (2026).
  (constant trainable parameters, hundreds of members by **weight sharing** — member
  count and parameter count are separable)
- *FLAME: Condensing Ensemble Diversity into a Single Network.* arXiv **2604.04038**
  (2026). *Diffusion Distillation for Efficient Weather Ensembles.* arXiv **2608.27728**
  (2026). (the value of an `N`-member ensemble can be condensed/ distilled into one
  network — the ensemble as a training signal, not a deployment cost)
- *Ensemble Diversity Optimization for Subjective Supervision.* arXiv **2607.08493**
  (2026). (learns ensemble composition **and size** end-to-end with a signed diversity
  regularizer — the "learn the cardinality" route)
- *Measuring consistency via ensemble margin and local prediction variability.* arXiv
  **2609.01397** (2026). *Uncertainty quantification for trustworthy deep learning:
  Methods and measures.* arXiv **2607.28248** (2026). (how to **measure** multiplicity /
  diversity — the es-sweep's readout instruments)

**Implementation verdicts (round 29 → 30).** The landed code — P1 the model-class benchmark, P2 the
configuration-robust + exposure-matched gate, P3 the 15m reversal family, P4 the funding/basis carry
sleeve — **reuses the external anchors already listed above and adds no new ones**. Mapping:
the benchmark's forecaster comparison uses the proper-scoring / DM / MCS anchors already recorded in
`research/financial-validation.md` (Gneiting & Raftery 2007; Diebold & Mariano 1995;
Hansen–Lunde–Nason); P2's cadence gate is Lo 2002 + AlgoXpert (arXiv 2603.09219) + Cameron & Miller
2015 + Ledoit & Wolf 2008; P4's independence reading is Kish 1965 + Grinold 1989 + Asness, Moskowitz
& Pedersen 2013; P3's reversal lead is arXiv 2608.21888. The implementation *verdicts* (G-A/G-B/G-C
branches, the measured numbers) are in
[`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §16.1–§16.6 and
[`research/round29-README.md`](research/round29-README.md) §8; the frontier they open is `../TODO.md` 94–97.
