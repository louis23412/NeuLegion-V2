# `src/` — module map

Starting point for anyone (human or agent) working on the code under `src/`.
The high-level overview and running instructions live in the repo `README.md`;
the **frozen core design** and the definition of done for a new system live in
`../docs/DESIGN.md` (with the configuration/commands and expected test ledger in
`../docs/RUNBOOK.md`); the bug log and optimization log live in `../docs/`, and
the A/B run forensics + plan live in `../docs/RUN-ANALYSIS.md`, and the
evaluation-method decisions (e.g. why the scored path replays each fold rather than
warming a per-stream snapshot) live in `../docs/METHOD.md`. This
file is the **directory-level map**: what each file owns, which technique it
implements, which test proves it, and whether it is safe to edit or should be
considered locked.

## Why this directory is split the way it is

`HiveMind` and `HiveMindController` were each originally one ~2.5k–7.5k-line
file. They are now thin class shells plus a set of **component modules** whose
methods are copied onto the class prototype by
`hivemind/internal/mixins.js#installMethods`. The split is *behavioural*: the
method bodies are byte-identical to the originals, and the golden suite
(`test/browser/entries/golden.test.js`) proves it by fingerprinting the exact
floating-point trajectory.

The rule when editing:

> **A method lives in exactly one component module. Its name is listed in
> `../test/component-manifest.js`, and `modules.test.js` fails if the manifest
> and the installed prototype disagree.** To add/move/rename a method, update
> the bag, the manifest, and the class shell's install loop together.

Keep the class shell readable: fields, constructor, and the public API only.
Anything that is a pure helper over `this` state belongs in a component bag.

## HiveMind core — `hivemind/`

`hiveMind.js` is the shell: imports, `_`-prefixed fields, the constructor, the
public `predict` / `train` / `dumpState`, and the install loop. All ~100
helpers (the manifest is authoritative) live in the modules below, grouped by
domain. **The hot math is locked to bit-exactness** — see the golden suite and
`../docs/OPTIMIZATION.md` for the A/B method. Do not reorder multiply-add
chains, change `Math.fround` placement, or alter the seeded PRNG call order
without re-freezing the golden fingerprints.

| module | methods | technique / what it does | proven by |
| --- | --- | --- | --- |
| `internal/mixins.js` | `installMethods` | prototype assembly helper; throws on duplicate key / non-method / assertCount mismatch | `modules.test.js` |
| `internal/diagnostics.js` | `diagnostics` | read-only weight/gradient stats, per-member memory counts, LSH consistency | `sanity.test.js`, `golden.test.js` |
| `kernels/activations.js` | `_silu`, `_siluDerivative`, `_sigmoid`, `_softmax` | SiLU/Swish, logistic, numerically-stable softmax (log-sum-exp) | `sanity.test.js` |
| `kernels/linalg.js` | `_fastVectorDot`, `_fastVectorAdd`, `_fastVectorScale`, `_vectorDot`, `_vectorNorm`, `_vectorSub`, `_cosineSimilarity`, `_weightedMean`, `_maxPairwiseKernel`, `_projSimilarity` | dense vector ops; cosine similarity; projection-average similarity | `sanity.test.js` |
| `kernels/normalization.js` | `_rmsNorm`, `_normalizeSemantic`, `_applyRoPE` | RMSNorm; semantic renormalisation; rotary position embedding | `sanity.test.js` |
| `kernels/sampling.js` | `_randomNormal`, `_sampleDirichlet`, `_generateProjectionMatrix`, `_generateLshHyperplanesLow`, `_dynamicInit` | Box–Muller normal; Dirichlet draws; random projection & LSH hyperplane generation; scale-aware init | `sanity.test.js` |
| `kernels/statistics.js` | `_computeVariance`, `_computeEMA`, `_computeDualEMA`, `_computeGradientConformity`, `_computeKernelRate`, `_computeFractalDimension`, `_computePercentile`, `_computeNTKStability`, `_computeDynamicPercentile`, `_computeSparseThreshold`, `_computeSpectralNorm`, `_computeGradientNorm`, `_detectSuddenDrop`, `_isStagnating` | dispersion (MAD proxy), EMAs, gradient-conformity/spectral statistics, percentile/threshold helpers, sudden-drop & stagnation detection | `sanity.test.js`, `core.test.js` |
| `persistence/load.js` | `_loadState` | restore the model from SQLite (dimensions, weights, gradients, protos, LSH) | `sanity.test.js` case F |
| `persistence/save.js` | `_saveState` | write the model to SQLite (float32 blobs — see known finding below) | `sanity.test.js`, `golden.test.js` |
| `persistence/dimensions.js` | `_scaleAndSetDimensions`, `_setTransformerStructure`, `_setGradientStructure` | choose/scale hidden size, layer count, head count, LSH dims (compact `forceMin` branch frozen; full branch follows a width-scaling law) | `dimensions.test.js`, `sanity.test.js` |
| `memory/lsh.js` | `_computeContentHash`, `_computeProjNorms`, `_invalidateProjCache`, `_getLshBitMasks`, `_computeLSHHashesLow`, `_insertProtoToLSH`, `_removeProtoFromLSH`, `_updateProtoInLSH`, `_getGlobalLSHCandidates`, `_refreshLshHyperplanes` | locality-sensitive hashing index (multi-set, multi-table) over prototype means; optional margin-order probing and a data-aware (PCA-aligned) hyperplane refresh, both off by default | `lsh.test.js` (recall + θ/π rounding law + refresh), `sanity.test.js` case C (churn consistency), `golden.test.js` |
| `memory/protos.js` | `_createNewProto`, `_reinforceProto`, `_finalizeSemanticProto`, `_decayProtos`, `_updateSemanticStats`, `_getAvgProtoVariance`, `_sortByUtilityDescInPlace`, `_sortedByUtilityDesc`, `_sortByScoreDescInPlace`, `_computeProtoUtility`, `_computeMemberAffinity` | prototype (mean + variance + size + importance + accessCount) lifecycle and utility ranking | `sanity.test.js`, `core.test.js` |
| `memory/replay.js` | `_replayOldMemory`, `_generativeReplay`, `_poolMultiPrototype` | experience replay / generative replay to fight catastrophic forgetting | `core.test.js` |
| `memory/retrieval.js` | `_kernelSimilarity`, `_retrieveTopRelevantProtos` | RBF kernel similarity + top-k prototype retrieval | `sanity.test.js`, `core.test.js` |
| `memory/consolidation.js` | `_consolidateSemanticProtos`, `_computeMemoryScoreFromProtos` | semantic prototype merge/split; attention-entropy memory scoring | `sanity.test.js`, `golden.test.js` |
| `memory/banks.js` | `_updateSemanticProtos`, `_pruneMemory`, `_updateMemoryBanks` | episodic/adaptive/semantic/core bank maintenance, capacity trim, prune; surprise-gated semantic writes (off by default) | `sanity.test.js`, `surprise.test.js` |
| `memory/surprise.js` | `DEFAULT_SURPRISE_CONFIG`, `clamp01`, `surpriseFromSimilarity`, `surpriseGate`, `surpriseGateFromSimilarity`, `updateSurpriseMomentum`, `smoothedSurprise` | pure surprise gate for memory writes (Titans): scales a write by `floor + (1-floor)·s^sharpness`; `floor=1` is an exact no-op | `surprise.test.js` |
| `memory/multiprobe.js` | margin-ordered multi-probe LSH (Lv et al. VLDB 2007): `DEFAULT_MULTIPROBE_CONFIG`, `resolveMultiProbeConfig`, `marginOrder`, `marginRanks`, `perturbationCost`, `rankPerturbations`, `applyFlips`, `multiProbeKeys`, `marginSingleBitKeys`, `prefixSingleBitKeys`, `flippedBits`, `marginCoverBudget`, `DEFAULT_ADAPTIVE_CONFIG`, `resolveAdaptiveConfig`, `adaptiveMultiProbeConfig`, `resolveEffectiveProbeConfig`, `adaptiveSingleBitBudget`, `adaptiveSingleBitKeys`. Wired into `_getGlobalLSHCandidates` behind the default-off `_multiProbeConfig`; with `_multiProbeConfig.adaptive` the probe depth is derived per query from the exact recovery coverage (Round 16). | `multiprobe.test.js`, `golden.test.js` |
| `memory/binarypc.js` | **data-aware** binary principal components (BinaryPC arXiv 2608.04405): `DEFAULT_BINARYPC_CONFIG`, `resolveBinaryPCConfig`, `createRng`, `randomNormal`, `randomVector`, `meanVector`, `centerRows`, `covarianceMatrix`, `matVec`, `dot`, `norm`, `powerIteration`, `principalComponents`, `explainedVariance`, `randomOrthonormalBasis`, `pcaHashTables`, `alignedHashTables`, `randomHashTables`, `binaryCode`, `quantizationError`. The Eckart–Young case for replacing the random LSH hyperplanes with PCA-aligned ones; imported by the locked `lsh` bag behind the default-off `_pcaHashConfig` (`_refreshLshHyperplanes`); also reports each direction's exact data variance (`tableVariances`) and takes a data-driven `rankPolicy` (`above-mean`/`noise`). | `binarypc.test.js`, `lsh.test.js` section I |
| `memory/bitweight.js` | bit-reliability theory for the LSH hash bits: `DEFAULT_BITWEIGHT_CONFIG`, `resolveBitWeightConfig`, `binaryEntropy`, `erf`, `normalCdf`, `flipProbability`, `reliabilityWeight`, `bitInformation`, `flipProbabilityFromMargin`, `estimateNoiseVariance`, `selectReliableRank`, `reliabilityWeights`, `weightedHamming`, `weightedKeyDistance`, `unpackWord`, `bitFlipProbabilities`, `poissonBinomialPmf`, `poissonBinomialQuantile`, `expectedFlippedBits`, `marginContainmentCoverage`, `marginContainmentDepth`, `probeRecoveryCoverage`, `recoveryDepth`, `calibrateNoiseFromFlips`. The exact flip law `P = arccos(sqrt(lambda/(lambda+sigma^2)))/pi` and its binary-symmetric-channel reading; fuels `binarypc.js`'s `rankPolicy` behind the default-off `_pcaHashConfig`. | `bitweight.test.js`, `binarypc.test.js`, `lsh.test.js`, `golden.test.js` |
| `memory/querymod.js` | dynamic query modification for binary LSH (arXiv 2605.23807): `DEFAULT_QUERYMOD_CONFIG`, `resolveQueryModConfig`, `dot`, `norm`, `cosine`, `normalize`, `meanVector`, `normalizedCentroid`, `dotProductSum`, `collisionProbabilityFromCos`, `collisionProbability`, `averageCollisionProbability`, `firstOrderCollisionProbability`, `averageCovariance`, `signBit`, `hashBits`, `collidesWithSet`, `centroidCollidesWithSet`, `collisionCoverage`, `selectCandidates`, `blendVectors`, `modifiedQuery`, `queryModificationGain`. Replaces the query with the l2-normalised centroid of the found neighbours (Theorems 1–2, Appendix C.1, §6.4); wired into `_getGlobalLSHCandidates` behind the default-off `_queryModConfig`. | `querymod.test.js`, `lsh.test.js` section J |
| `transformer/attention.js` | `_multiHeadAttention`, `_contextAwareAttention`, `_computeAttentionWeights`, `_cacheAverageWeights` | multi-head attention; memory-augmented context attention; average-weight cache | `sanity.test.js`, `golden.test.js` |
| `transformer/forward.js` | `_feedForwardBatch`, `_processTransformer` | transformer block forward pass (attention + gated FFN + norms) | `sanity.test.js`, `golden.test.js` |
| `ensemble/hiveState.js` | `_updateHiveState`, `_hiveMemorySharing`, `_computeWeightedSum`, `_getSpecWeightMatrix` | per-member forward + ensemble readout; inter-member prototype transfer/specialization gating | `sanity.test.js`, `golden.test.js` |
| `ensemble/scores.js` | `_computeSpecializationScores`, `_updatePerformanceScores`, `_updateAgreementScores`, `_updateTrustScores`, `_adjustPerformanceScores`, `_updateEnsembleWeights`, `_normalizeEnsembleWeights`, `_updateAdaptiveLearningRates`, `_updateMetrics` | the evolutionary layer: performance/agreement/trust scoring, ensemble weighting, adaptive per-member learning rates; optionally homeostatic (off by default) | `sanity.test.js`, `golden.test.js`, `homeostasis.test.js` |
| `ensemble/homeostasis.js` | `DEFAULT_HOMEOSTASIS_CONFIG`, `resolveHomeostasisConfig`, `isStableConfig`, `homeostaticScale`, `homeostaticLearningRates`, `updateActivity`, `rootMeanSquare`, `deviationEnergy` | pure homeostatic activity controller (Turrigiano synaptic scaling): a bounded/monotone error-driven multiplier that regulates each member's activity toward a set-point; `gain=0` is an exact no-op | `homeostasis.test.js` |
| `training/gradients.js` | `_scaleGradientMatrix`, `_scaleGradientVector`, `_scaleGradients`, `_accumulateGradients`, `_applyGradients`, `_rollbackGradients` | manual backprop accumulation, clipping/scaling, apply/rollback; the logit gradient carries an optional per-sample weight | `sanity.test.js`, `golden.test.js`, `sample_weights.test.js` |
| `training/distillation.js` | `_distillKnowledge` | knowledge distillation from the ensemble into members | `sanity.test.js` |
| `training/sample_weights.js` | `DEFAULT_WEIGHT_CONFIG`, `overlapUniqueness`, `clampWeights`, `normalizeWeights`, `weightEffectiveSampleSize`, `weightedMean`, `sampleWeights`, `spanWeightsFromEntries` | sample-uniqueness loss weights (LdP ch. 4): overlapping labels share credit so the weighted objective's effective sample size matches the labels' independent information | `sample_weights.test.js` |
| `knowledge/transfer.js` | `broadcastMemory`, `translateMemory` | public API: export prototypes for the "hivemind", import others' prototypes | `core.test.js`, `golden.test.js` |

`indicatorProcessor.js` (candles → 10 indicator series) and `utils.js` (numeric
predicates) are standalone and unchanged.

## HiveMindController — `hivemind/controller/`

`hiveMindController.js` keeps the fields, constructor and the public
`getSignal()`. The helpers live in `controller/`:

| module | methods | what it does | proven by |
| --- | --- | --- | --- |
| `controller/database.js` | `_initDatabase` | SQLite schema (`open_trades`, `closed_trades`, `candles`, `trained_features`, `global_stats`) | `core.test.js` |
| `controller/accuracy.js` | `_loadGlobalAccuracy`, `_saveGlobalAccuracy` | persist win/loss/points/memory counters | `golden.test.js` |
| `controller/candles.js` | `_getRecentCandles` | validated candle ring buffer (`cacheSize`-bounded) | `core.test.js` |
| `controller/features.js` | `_robustNormalize`, `_computeProtoQuality`, `_interleave`, `_extractFeatures`, `_chooseDimension` | percentile-robust feature scaling; prototype quality score; O(n) interleave; tier-aware feature vector; input-dimension search | `features.test.js`, `golden.test.js` |
| `controller/trades.js` | `_updateOpenTrades`, `_processClosedTrades` | simulate TP/SL fills against new candles; turn closed trades into training steps (dedup by feature/outcome hash) | `core.test.js`, `golden.test.js` |

## Legion — `legion/`

`mainController.js` is now a 13-line entry that calls `processCandles` from
`legion/runner.js`. The legion drives many controllers, aggregates their
signals by hierarchy, keeps a durable shared memory vault, and broadcasts
state.

| module | role | proven by |
| --- | --- | --- |
| `legion/state.js` | the 5 former module-level mutable values (`cache`, `structureDims`, `structureMap`, `candleCounter`, `httpWorker`) in one holder object | `legion.test.js` |
| `legion/config.js` | `CONFIG` + `scriptStart` (paths resolve from `src/legion/`) | `legion.test.js` |
| `legion/priorityQueue.js` | binary min/max heap used for scheduling | `legion.test.js` |
| `legion/accuracy.js` | legion-level accuracy & influence accumulators | `legion.test.js` |
| `legion/database.js` | opens the two SQLite DBs (`db`, `memoryDb`) and applies the schema — **runs at module-eval time** | `legion.test.js` |
| `legion/statements.js` | the ~62 prepared statements + `storeNewMemories` / `applyBulkDeltas` transactions | `legion.test.js` |
| `legion/broadcast.js` | dedicated HTTP server + `getCleanLegionState` + `broadcastLegionState` | `legion.test.js` |
| `legion/signals.js` | collect/enrich member signals, hierarchical aggregation, consensus resolution | `legion.test.js` |
| `legion/serialization.js` | `vectorToBlob`/`blobToVector`, canonical JSON, content hash, Gaussian distance | `legion.test.js` |
| `legion/structure.js` | tier/type mapping, fresh structure build, per-controller param selection | `legion.test.js` |
| `legion/persistence.js` | `saveLegionState` | `legion.test.js` |
| `legion/init.js` | `initLegion` | `legion.test.js` |
| `legion/batch.js` | `processBatch` — one candle step across the legion | `legion.test.js` |
| `legion/workers.js` | `runWorker` / `runConsolidationWorker` (worker URLs are `'../worker.js'` etc. relative to `src/legion/`) | `legion.test.js` |
| `legion/net.js` | `getLocalIP` | `legion.test.js` |
| `legion/runner.js` | `processCandles` — the top-level loop | `legion.test.js` |
| \`legion/evolve.js\` | **additive** low-rank evolution strategies (EGGROLL arXiv 2609.10980): antithetic ES gradient estimate, random orthonormal subspaces, monotone line-searched descent. Nothing imports it yet (formally deferred — see ROADMAP P3-2). | \`evolve.test.js\` |
| \`legion/sanitize.js\` | **run-integrity guards** (ROADMAP P0-1): \`finiteOr\`/\`finiteOrNull\`, \`safeParseJSON\`, \`sanitizeSignal\`/\`sanitizeConsensus\`, the controller-failure budget, \`stableHash\`/\`configFingerprint\`, \`assertControllerArgs\`. Pure, exception-path only. | \`guards.test.js\` |
| \`legion/rng.js\` | **deterministic runs** (ROADMAP P0-2): \`mulberry32\`, \`hashString\`, \`deriveSeed\`, \`installSeededRandom\`. Default-off (\`CONFIG.seed\` null). | \`guards.test.js\` |
| \`legion/http_server_worker.js\` | the read-only **monitor dashboard** server (ROADMAP P1-1): serves \`/\` (self-contained page), \`/api/state\`, \`/api/events\` (SSE) and \`/api/report\`; loopback, GET-only, ephemeral-port fallback. | \`http_view.test.js\` |

## Analysis supercharges — `analysis/`

Additive, pure modules for **honest evaluation**. They read signals/candles and
never import from (or are imported by) the locked hot path, so they cannot move
a golden fingerprint. Each has exact reference vectors in `analysis.test.js`
(562 checks; the walk-forward harness also has a real-candle end-to-end run in
`walkforward.test.js`, 62 checks) and is registered `LOCKED-invariant` in
`../test/lock-registry.js`.

| module | exports | what it does | proven by |
| --- | --- | --- | --- |
| `analysis/performance.js` | `sharpeRatio`, `skewness`, `kurtosis`, `sharpeStandardError`, `probabilisticSharpeRatio`, `expectedMaxSharpe`, `deflatedSharpeRatio`, `minimumTrackRecordLength`, `stationaryBootstrapSharpe`, `evaluateStrategy`, `normalCdf`/`normalInvCdf` | Sharpe + selection-bias-corrected significance (PSR/DSR/MinTRL), block-bootstrap p-value (null-calibrated — see `../docs/BUGS.md` #10) | `analysis.test.js` |
| `analysis/splits.js` | `purgedKFoldSplit`, `walkForwardSplit`, `assertNoLeakage`, `normalizeLabelSpans`, `combinatorialPurgedSplit` | leakage-free time-series CV with purging + embargo; walk-forward; combinatorial purged CV (`C(k,m)` folds → `C(k-1,m-1)` backtest paths) | `analysis.test.js` |
| `analysis/labels.js` | `tripleBarrierLabels`, `cusumFilter`, `fractionalDiffWeights`, `fractionalDiff`, `fracDiffLogPrices` | path-aware labels, event sampling, memory-preserving stationarity | `analysis.test.js` |
| `analysis/uniqueness.js` | `sampleUniqueness`, `averageUniqueness`, `effectiveSampleSize`, `sequentialBootstrap` | correct the effective sample size for overlapping labels | `analysis.test.js` |
| `analysis/backtest.js` | `positionsFromSignals`, `strategyReturns`, `maxDrawdown`, `hitRate`, `tradeCount`, `backtestMetrics`, `purgedCVBacktest`, `equityCurve`, `annualizedReturn`, `poolFolds` (extracted so a multi-stream / cross-symbol report pools with exactly the single-stream arithmetic) | no-lookahead backtest with turnover costs + PSR/DSR reporting; proven not to bless a zero-skill signal; pooled metrics report the strategy's real per-fold aggregates (`BUGS.md` #11); round 24b: `backtestMetrics`/`poolFolds` also carry `grossPnl` and `breakEvenCostBps` (the per-unit-turnover cost in bps at which the gross edge is exactly consumed — an assumption-free way to compare a high-turnover signal with a low-turnover mechanism) | `analysis.test.js` |
| `analysis/walkforward.js` | `barReturns`, `logReturns`, `probToPosition`, `isCausalFold`, `aggregateFolds`, `foldWinFraction`, `auditNoLookahead`, `walkForwardEvaluate`, `promoteDecision`, `formatReport`, `familywiseSearch`, `walkForwardSearch`, `sharpeStandardError`, `minimumDetectableSharpe`, `barsToDetect`, `UNDERPOWERED_MDE`, `poolReports` | walk-forward protocol for an *online* model: enforces causal folds, **tests** no-lookahead by perturbing future returns, and decides feature promotion with a size-calibrated rule (absolute `DSR ≥ 0.95` floor); the opt-in `familywiseSearch`/`walkForwardSearch` path adds a segment-aware family-wise (subsampling SPA + Romano–Wolf step-down) hurdle over the pooled OOS returns, and accepts `kfwer`/`fdpTarget` to attach the generalised error-rate tests (`subsamplingKfwer`/`subsamplingFdp`; default-off → byte-identical report). **Round 23:** `auditNoLookahead` takes an optional `viewFor(returns, perturb)` hook so the perturbation reaches a candle-driven model's actual input, and reports `{clean, violations, probes, viewDiffers, reachable, vacuous}` (a `viewFor` whose views do not differ is `vacuous`, never `clean` — `BUGS.md` #22); `walkForwardEvaluate` forwards `viewFor` to both the scoring view and the audit and returns a Lo (2002) power summary (`sharpeStandardError` / `minimumDetectableSharpe`); `poolReports` merges one report per stream (symbol) with the single-stream `poolFolds` arithmetic (one report is the identity); `formatReport` prints the power line and reads an undefined metric as `n/a`. **Round 24b:** the power summary also carries an `underpowered` flag (MDE95 above `UNDERPOWERED_MDE` = 1.0 — a null verdict that could not have detected Sharpe 1 is uninformative) and `barsToDetect1` (from `barsToDetect(SR)`, the pooled sample that would detect Sharpe ±1.0); `formatReport` marks an underpowered power line. **Round 25:** imports the dependence layer and adds `powerSummary(sharpe, bars, P, dependence)` (dependence-corrected `seDependent`/`mdeSharpeDependent`/`underpoweredDependent`/`varianceInflation`/`effectiveBars`), `dependenceSummary`, `foldWindowClusters`/`clusterJackknife`, `pairedPromotionTest` (paired cluster `t(C-1)` + exact sign), the `requireSharpeDiff`/`requireBreadth`/`minDsrAdjusted` `promoteDecision` hurdles (default-off; **R26-7** adds `requireClusterStability` and demotes `requireBreadth` to reported-only) with an explicit four-state `gate` record (`applied`/`skipped-no-panel`/`not-needed`/`off`), `familyCorrelation` (diagnostic), `restateReportAtCost`/`costLadder`, `trials` propagation, and the `part:`/`adjusted:`/`power*:`/`depend:`/`paired:` report lines | `analysis.test.js`, `walkforward.test.js` |
| `analysis/dependence.js` | `pearsonCorrelation`, `meanPairwiseCorrelation`, `equicorrelationDesignEffect`, `equicorrelationEffectiveSize`, `foldWindowClusters`, `concatClusters`, `clusterJackknife`, `pairedClusterTest`, `pairedClusterSignTest`, `signTest`, `signTestFloor`, `clusterStability`, `regularizedIncompleteBeta`, `studentTPValue`, `studentTCdf` | **dependence-aware inference** (round 25): the Kish design effect `1+(m-1)rhoBar` and `effectiveBars`, the delete-one-cluster jackknife over fold-window clusters that estimates the pooled Sharpe SE from the panel (no equicorrelation assumption), the paired cluster `t(C-1)` + exact sign test behind the promotion gate, and the incomplete-beta/Student-t tails. **Round 26 (R26-7)** adds `clusterStability`: the pooled paired Sharpe difference must stay positive on every leave-one-cluster-out panel — the magnitude companion to the sign test and the shipped stability gate | `analysis.test.js` (§AD, §AJ), `walkforward.test.js` (§9) |
| `analysis/overfitting.js` | `DEFAULT_PBO_CONFIG`, `cscvBlocks`, `cscvSplit`, `relativeRank`, `oosOnIsRegression`, `probabilityOfBacktestOverfitting` | **probability of backtest overfitting** via combinatorially symmetric CV (Bailey et al. 2016): the `C(S,S/2)` in-sample/complement splits, the rank-based logit, and the OOS-on-IS degradation regression — the non-parametric counterpart of the DSR | `analysis.test.js` |
| `analysis/reality_check.js` | `DEFAULT_RC_CONFIG`, `benchmarkSeries`, `relativePerformance`, `stationaryBlockIndices`, `bootstrapRelativeMeans`, `whiteRealityCheck`, `hansenSpa`, `consistentRecentring`, `hansenSpaConsistent`, `romanoWolfStepM`, `politisWhiteBlockLength`, `autoBlockLength`, `neweyWestSE`, `subsamplingSpa`, `subsamplingStepM`, `subsamplingKfwer`, `subsamplingFdp` | **White's Reality Check + Hansen's SPA** (White 2000; Hansen 2005) and the **consistent SPA + Romano-Wolf step-down** (Romano & Wolf 2005): bootstrap the MAX relative performance over the SAME stationary-bootstrap timeline for every candidate (preserving cross-sectional dependence), un-studentized (RC), studentized/recentred (SPA), and consistently recentred with a step-down that names which candidates win. The subsampling path accepts an opt-in `groups` argument (segment lengths tiling `T`) so the long-run variance is estimated *within* a segment (`sqrt(Σ_g (len_g·seNW_g)²)/T`; `groups=[T]` is bit-identical to ungrouped) — the mean-shift case of arXiv 2603.17226. `subsamplingKfwer` adds **single-step k-FWER** control (Romano & Wolf 2007, arXiv 0710.2258) over the same window grid (`k=1` is exactly the SPA/StepM first p-value), and `subsamplingFdp` adds the **step-down FDP** heuristic (Delattre & Roquain 2014, arXiv 1311.4030) with the growing reference `k_l = floor(fdpTarget·l)+1` (shipped **EXPERIMENTAL** — not rigorously FDP-controlling in finite samples). Answers "is the best of K candidates actually > benchmark, and which ones are?" — complements DSR (parametric) and PBO (rank-based) | `analysis.test.js` |

| `analysis/world.js` | `DEFAULT_SHOCK`, `shockFactor`, `volumeShockFactor`, `shockCandles`, `makeCandleViewFor`, `worldFromCandles` | **the audited evaluation world** (round 23, N0): the view a *candle-driven* model actually reads, so `auditNoLookahead` can perturb its real input. On a probe pass every bar after `t` is scaled by a bounded, deterministic, NON-uniform factor (`1 + probe*(1 + sin(freq·t))`) and `returns` is re-derived from the shocked closes, so no unshocked copy of the future survives in the state object; the base pass returns the real candles; round 24b added `volumeShockFactor` so the probe scales volume as well as OHLC, making a volume-driven candidate auditable | `analysis.test.js` (§AC), `walkforward.test.js` (§K) |
| `analysis/features.js` | `DEFAULT_POSITION`, `clampPosition`, `momentum`, `fracDiffAt`, `fracMomentum`, `volRegime`, `momentumAgreement`, `rangeLocation`, `volumeImbalance`, `autocorr1`, `acceleration`, `causalZScore`, `positionAt`, `signalForCandidate`, `SIGNAL_CANDIDATES` | **the causal signal family** (round 23, N1): 8 pure point-in-time features (momentum, d=0.4 fractional-diff momentum, realized-vol regime, multi-horizon momentum agreement, range location, volume/turnover imbalance, lag-1 autocorrelation, acceleration), each reduced to a position by one causal z-score → clamp pipeline. They are the A/B's real candidates on the same family-wise gate as the mechanism flags, so the searched universe is K = 15 | `analysis.test.js` (§AC) |
| `analysis/parallel.js` | `normaliseConcurrency`, `scheduleUnits`, `makeFoldExecutor` | **the order-preserving bounded-concurrency fold scheduler** (round 26, R26-4): `scheduleUnits` runs units with at most N in flight and returns them in unit order (the contract that keeps `folds.jsonl` byte-identical serial vs parallel), and `makeFoldExecutor` adapts a worker dispatch's `{positions, confidence, stats}` reply to the analysis executor contract. `analysis/fold_worker.js` is its process entry (one fold per worker); `backtest.js#purgedCVBacktestAsync`, `walkforward.js#walkForwardEvaluateAsync` and `analyze.js#evaluateABAsync` are the async twins | `analysis.test.js` (§AE), `analyze.test.js`, and the node-only `parallel_folds.test.js` |
| `analysis/holding.js` | `DEFAULT_TURNOVER_GRID`, `turnoverSweep`, `bestTurnoverPolicy`, `formatTurnoverSweep` | **the turnover attack** (round 26, R26-5): a frozen dead-zone × entry/exit-hysteresis × minimum-holding grid, restated as *pure post-processing* of the journaled pre-policy confidence (no model) — each policy's turnover / gross pnl / break-even cost / pooled Sharpe and its full promotion decision. `walkforward.js#positionSeriesFromConfidence` is the one holding-aware confidence→position map (byte-identical to the pointwise map with no holding rule, so the R26-3 round trip is unchanged). The optimal no-trade region is classical — Constantinides 1986 / Davis & Norman 1990 / Gârleanu & Pedersen 2013; alpha decay (arXiv 2502.04284) is why the rule uses past signal values | `analysis.test.js` (§AF) |
| `analysis/streams.js` | `resampleCandles`, `designEffectOfStreams`, `selectStreams`, `formatStreamSelection` | **effective independence of the stream basket** (round 26, R26-6): `resampleCandles` aggregates N consecutive bars into one (exact OHLCV) so a second bar interval — a different horizon, not a copy — can be added without a second dataset; `designEffectOfStreams` measures the Kish (1965) design effect `1+(K-1)·rbar` over the streams' own returns (or their per-fold Sharpe series), giving `effectiveStreams`/`effectiveBars`; `selectStreams` greedily orders candidates by marginal effective bars per raw bar (Grinold 1989 breadth under the measured cost law). Diagnostic/design only — no scored number changes | `analysis.test.js` (§AG) |

| `analysis/replication.js` | `interquartileMean`, `stratifiedBootstrapCI`, `varianceComponents`, `seedDistribution`, `pairedVarianceRatio`, `formatSeedReplication` | **seed replication + common random numbers** (round 26, R26-13): a single seed is not a ranking (Bouthillier et al. 2019; Henderson et al. 2018), so the level is the interquartile mean (Agarwal et al. 2021), the interval is a **stratified bootstrap** resampling within each seed stratum, and the spread is split into seed/fold/residual fractions. `pairedVarianceRatio` is the CRN criterion (Glasserman & Yao 1992). Pure + seeded; the A/B defaults to CRN on (`foldSeed = seed + testStart*977`, variant-independent) and `replicateAnalysis`/`--seeds` aggregates the per-variant distribution into `replication.json` | `analysis.test.js` (§AH) |

| `analysis/forecast.js` | `forecastPairs`, `brierScore`, `logScore`, `brierDecomposition`, `brierLosses`, `bootstrapMeans`, `dieboldMariano`, `modelConfidenceSet`, `forecastComparison`, `formatForecast` | **forecast comparison** (round 26, R26-14): the family scored as forecasters — proper scores (Brier + Murphy reliability/resolution/uncertainty, log score; Gneiting & Raftery 2007), the block-bootstrapped Diebold–Mariano test on per-bar Brier-loss differentials (Diebold & Mariano 1995), and the Hansen–Lunde–Nason Model Confidence Set at 90/95% (the families that cannot be distinguished from the best). Pure post-processing of the journaled confidence; on by default in `analyze` (`--forecast=0` disables) | `analysis.test.js` (§AI) |
| `analysis/decision.js` | `foldConcentration`, `confidencePersistence`, `nextRunPlan`, `decisionReport`, `formatDecision` | **the decision-grade report** (round 26, R26-8): composes the run's already-computed blocks into the six questions the next cycle asks (training / edge / concentration / economics / family / nextRun), each field a value or an explicit `available:false` + reason, and adds the concentration readout (leave-one-fold-out Sharpe range + per-fold marginal contribution), the raw-confidence half-life and the next-run sizing knobs. Pure post-processing — it computes no new strategy statistic | `analysis.test.js` (§AK), `analyze.test.js` |
| `analysis/race.js` | `halvingRounds`, `halvingSchedule`, `successiveHalving`, `formatRace` | **successive-halving family-search engine** (round 26, R26-15) — engine only; the `--race` driver is gated (`docs/METHOD.md` §2). Evaluator-agnostic, deterministic, budget-aware; validated against the full-grid oracle | `analysis.test.js` (§AM) |
`candles_audit.js` (integrity auditor + `CANDLE_MANIFEST`) and
`candle_quality.js` (impossible-wick winsorizer) are the data-quality layer;
`update_candles_basket.js` updates every manifest file in one command
(`npm run fetch:all`).

## Price precision — `price_precision.js`

`priceDecimals(price, {minMovement})` returns the number of decimals the
controller's take-profit/stop-loss grid uses, derived from the price magnitude so
the grid is always at least 10× finer than `price * minPriceMovement` (clamped to
2–8 dp). It replaced a hardcoded `2`, which collapsed sub-cent symbols to `0.00`
and inverted their trade direction (see `../docs/BUGS.md` #9). Prices ≥ $40 keep
2 dp, so the controller golden fingerprints are unchanged. Proven by
`price_precision.test.js` + `multisymbol.test.js`, registered `LOCKED-invariant`
in `../test/lock-registry.js` (`SUPPORT_REGISTRY`).

## LSH recall — `hivemind/memory/lsh.js`

The semantic bank is indexed by random-hyperplane SimHash (`lowDim`-dimensional
projections, multi-set / multi-table). `test/browser/entries/lsh.test.js` (69
checks) proves the recall contract: unit-norm projections (so `_projSimilarity`
is a true average cosine and self-similarity is exactly 1 — the historical
`1/sqrt(lowDim)` rescale that killed the 0.35 filter is reproduced and shown to
fail), hash words equal the hyperplane sign pattern bit-for-bit, the bucket index
mirrors `_semanticProtos` without leaking, exact-match queries recall 100% of the
bank at both config widths, the measured bit-flip rate matches the Charikar
rounding law `Pr[differ] = θ/π` to ≤0.03, and the end-to-end retrieval path
recalls the query prototype. Registered under the `lsh` bag in
`../test/lock-registry.js`; details and the width caveat in
`../docs/research/lsh-ann.md`.

## Margin-ordered multi-probe LSH — `hivemind/memory/multiprobe.js`

The lean `_getGlobalLSHCandidates` helper probes the *first four* hash bits of
every table regardless of the query, so at production hash width (100+ bits) its
recall collapses past σ≈0.1 (documented in `lsh.test.js`). `multiprobe.js` is the
researched fix, wired into `_getGlobalLSHCandidates` behind a default-off flag
(`_multiProbeConfig`): probe in ascending order of the query's
margin `|dot(queryProj, hyperplane)|` — the hyperplanes a near neighbour is most
likely on the other side of (Lv, Josephson, Wang, Charikar & Indyk, *Multi-Probe
LSH*, VLDB 2007). The **flip lemma** explains why the order is the right one: for
a neighbour `q + δ` in the pre-normalisation projection space, bit *b* flips
exactly when `|δ_b| > |q_b|` and the perturbation opposes the query's side, so
every flipped bit has margin below the perturbation magnitude and the
lowest-margin bits are a complete cover. `multiprobe.test.js` (77 checks) proves
the exact structure/cost ordering, the lemma (zero violations over 300 trials),
that `P(flip)` falls monotonically with margin (0.48 → 0.04 across octiles), that
margin order dominates both the historical prefix probe and 12 sampled random
orders at every budget, the exact ≤1-bit/≤2-bit completeness identities, and — on
a real 107-bit index — a self-recall gain from 0.03 to 0.30 at σ=0.25 exactly
where the prefix probe collapses. Registered `LOCKED-invariant`; the wiring is done
(off by default via `_multiProbeConfig`; `golden.test.js` proves the no-op and
section F measures 0.167 → 0.517 at σ=0.25 with the flag on), leaving only an
intentional `hm:broadcast` re-freeze for the on-by-default flip in
`../docs/TODO.md` item 2.

**Round 16** made the budget query-adaptive rather than fixed. Two independent
2026 lines ask for this: NeuRoute (arXiv 2608.15438) perturbs only the bits the
query is least sure of, and *adaptive bucket probing* (arXiv 2604.04603) explores
neighbouring buckets with a budget adapted to the query and distance threshold
(query-adaptive hash-code ranking, 1904.08623, is the ranking-side sibling).
`adaptiveMultiProbeConfig` is **off by default** (byte-identical to the fixed
config when off, so the goldens are unmoved) and, when on, reads both knobs off
the flip model per query: `maxFlips` from the Poisson-binomial quantile of the
flip count, and `depth` from the exact recovery probability
`[∏_{b∉top-depth}(1−q_b)]·P(K_inside ≤ maxFlips)`, capped so the exhaustive subset
enumeration fits `budgetCap`. The enumeration is exhaustive over exactly the
`depth` smallest-margin bits, so the budget meets the stated probability exactly.
Measured on the live 107-bit index (σ calibrated from the measured Hamming
distance by `calibrateNoiseFromFlips`, which predicts it to 1e-6): the adaptive
budget dominates the historical prefix-4 probe at every noise level, needs **no
probing at all** for a majority of queries at low noise (below the fixed budget of
8 probes), and beats the fixed 8-probe budget at high noise. The honest caveat:
at low noise a broad fixed budget can out-recall the adaptive depth because it
enumerates more multi-bit subsets than the query needs — recorded in section G,
not hidden.

## Data-aware LSH hyperplanes — `hivemind/memory/binarypc.js`

The hash directions above are *data-independent* (SimHash, `w ~ N(0, I)`), so a
fixed bit budget is spent on directions the data barely varies in. BinaryPC
(arXiv 2608.04405) instead hashes along the data's **principal components**,
which by Eckart–Young minimise the orthogonal-complement variance and so carry
strictly more of the data's structure per bit — the optimality of data-dependent
hashing being the Andoni–Indyk–Laarhoven result (arXiv 1501.01062). The module
shipped in Round 13 with the pure proof; Round 14 wired it into the locked `lsh`
bag behind the default-off `_pcaHashConfig` (`lsh.js#_refreshLshHyperplanes`),
which learns the directions from the **live** prototype projections and rebuilds
the bucket index under them. Because the live hash is wider than the projection
dimension, `alignedHashTables` aligns only
`rank = min(bits, dim, nrows − 1, maxRank)` directions and draws the surplus from
random unit vectors.

Measured on a real 107-bit / `lowDim`-71 index with a planted anisotropic bank
(200 paired noisy queries, margin multi-probe on): self-recall under noise rises
**0.68 → 0.775** at σ=0.25 and **0.01 → 0.04** at σ=0.5, the prefix probe rises
**0.315 → 0.395**, and nothing is lost at σ=0.1 (1.0 everywhere). The honest
caveat the sweep found: aligning **every** direction is a no-gain configuration
(**0.655**, below the random baseline) because it dedicates bits to the
low-variance, noise-dominated tail — the optimum is a broad plateau around
`dim/4`, which is the wiring default. That matches the density-sensitive-hashing
(1205.2930) and weighted-Hamming (2009.08591) literature: not every direction
deserves a bit. **Round 15** turned that into a data-driven rank: with
`_pcaHashConfig.rankPolicy = 'above-mean'` the rank is read off the spectrum
(`selectReliableRank`, `memory/bitweight.js` — keep only PCs above the
random-direction baseline `trace/dim`, since a random unit direction captures
that much variance in expectation). On the same index that policy picks ranks
**22–23** and reaches **0.75** self-recall at σ=0.25 (vs `0.68` random and `0.655`
full alignment) — inside the plateau with no hand-tuned constant. `_lshAlignedRank`
records the rank each set used. Registered `LOCKED-invariant`; the off-state is
byte-identical (the flag is null), so all 11 golden fingerprints are unchanged.

## Bit-reliability theory — `hivemind/memory/bitweight.js`

The flip law that answers *how much a single hash bit tells us about a noisy
neighbour*. For a hash direction whose data variance is `λ` under isotropic noise
variance `σ²`, a stored bit flips with probability

```
P(flip) = arccos( sqrt(λ / (λ + σ²)) ) / π
```

— which is Charikar's `θ/π` law with `θ` the angle between the signal and the
noisy signal — so `P → 1/2` as `λ → 0` (a pure-noise bit) and `P → 0` as
`λ → ∞` (a perfectly stable bit). Each bit is therefore a **binary symmetric
channel** about the neighbourhood with crossover `P`, and its information is
`1 − H₂(P)` (Cover & Thomas) — zero for a noise-dominated direction. The same
model gives the query-side flip probability `Φ(−|margin|/σ)`, which is monotone in
`|margin|` and so *proves* that margin-ordered multi-probe (Lv et al. 2007)
probes the most-likely-flipped bits first.

`bitweight.test.js` (69 checks) verifies the law exactly and against Monte Carlo
(max deviation 0.00055 over 2e5 draws at four `(λ, σ)` pairs), the BSC weight and
information identities, the margin law and its ordering, the spectral noise
estimator, `selectReliableRank`, exact reliability weights, and the
weighted-Hamming metric (`weightedHamming` / `weightedKeyDistance`, checked
against a brute-force unpacked recompute on 32-bit **and** BigInt words). It also
validates the law on a **real index**: it predicts the measured bit-flip rate of
a PCA-aligned hash to within 0.012. One honest negative result is recorded: using
the reliability weights to rank candidates does **not** beat plain Hamming on the
rotation-based index (the rotation already equalises per-direction variance, and
the random surplus bits get down-weighted for nothing), so the weighted metric is
deliberately left unwired — the candidate pool is re-scored downstream by the
exact projection cosine anyway.

**Round 16** turned the flip law into a *query-adaptive budget*. `q_b =
Φ(−|margin_b|/σ)` gives each bit's flip probability for this query; the number of
simultaneous flips is Poisson-binomial (`poissonBinomialPmf`,
`poissonBinomialQuantile`); the probability the whole flipped set lies in the `k`
smallest-margin bits is the exact product `∏_{b∉top-k}(1−q_b)`
(`marginContainmentCoverage`, provably monotone so the depth bisects exactly); and
the recovery probability multiplies that by `P(K_inside ≤ maxFlips)`
(`probeRecoveryCoverage`). `recoveryDepth` finds the smallest depth reaching a
target in one incremental O(n²) pass, proven equal to a brute-force scan over 120
random spectra. `calibrateNoiseFromFlips` inverts the expected flip count for σ,
which is how the real-index measurement calibrates itself. Everything is exact
and Monte-Carlo-validated to <0.02, and the depth is genuinely query-dependent
(0 for a confident query, deep for an ambiguous one).

## Dynamic query modification — `hivemind/memory/querymod.js`

The **query-side** companion to the index-side recall fixes. Binary SimHash hashes
a query to a sign word; one failure mode is that the *query itself* is a poor
representative of its neighbourhood (a query that no neighbour agrees with on
any direction hashes to a bucket containing none of them). The fix replaces the
query with the l2-normalised **centroid** `<c>` of the neighbours found so far
and continues the search from it — Rocchio / pseudo-relevance feedback for binary
codes.

Four results, each proved exactly (`querymod.test.js`, 51 checks):

- **Theorem 1 (maximality)** — `<c>` maximises `Σ_{x∈S} x·u`, and
  `Σ_{x∈S} <c>·x` equals `‖Σx‖` equals `k‖mean‖`.
- **Theorem 2 (average collision probability)** — to first order
  `ACP(u,S) = ½ + Σ x·u/(kπ)`, maximised at `<c>`; `<c>` also beats the average
  random direction on the *exact* Charikar ACP.
- **Appendix C.1 (minimal residual covariance)** — `averageCovariance` is exactly
  `const − ((Σ x·u)/k)²`, minimised at `±<c>`.
- **§6.4 (hash-failure elimination)** — `<c>` collides with some member of `S` on
  **every** hyperplane; a raw query can collide with none (exhibited exactly).

Two empirical laws are pinned with margin: Charikar's collision law (matched by
4e4 random hyperplanes to <0.01) and the **denoising** law (the centroid of many
noisy views has a lower per-bit error rate than a single view). The **synthetic
regime sweep** shows *when* it pays — a strict recall gain while the hash word is
informative (6..12 bits, e.g. `0.540 → 0.789` at 6 bits), decaying
**monotonically** to zero as the word narrows (the empty-consensus-bucket
regime).

Wired into the locked `_getGlobalLSHCandidates` behind the default-off
`_queryModConfig`; with the flag null nothing runs and the goldens are
byte-identical. Because a round only *unions* buckets the returned pool is
mechanically a **superset**, so recall can never fall. `lsh.test.js` section J
measures the honest regime split: **live** on the narrow `forceMin` 6-bit index
(pool grows for most queries) and a **measured no-op** on the production 107-bit
index (`differ = 0` — buckets hold ~0.1–1 protos, so each set's found set is empty
or a single already-probed candidate).

## Surprise-gated memory writes — `hivemind/memory/surprise.js`

Titans (arXiv 2501.00663) writes to long-term memory in proportion to prediction
*surprise*, not merely on membership. `surprise.js` is the pure gate:
`surpriseFromSimilarity(sim) = clamp01(1 - sim)` (a prototype that is already well
represented is unsurprising), and `surpriseGate(s) = floor + (1-floor)·s^sharpness`
with an optional EMA momentum term (`momentumWeight`, default 0 = no smoothing).
`banks.js#_updateSemanticProtos` multiplies every semantic merge/reinforcement
term by `surpriseGateFromSimilarity(bestSim, cfg)` when `_surpriseGateEnabled` is
true; the shipped default is **false**, so `floor=1` collapses the multiply to
exactly `1.0`. `surprise.test.js` (32 checks) proves the pure math, the bit-exact
off switch (two identically-seeded banks fingerprint equally → all 11 goldens
unmoved), and that the enabled gate's measured gated/ungated write ratio equals
`surpriseGate(1 - measuredSimilarity)` with novel written >2× more strongly than
predictable. Registered `LOCKED-invariant` in `../test/lock-registry.js`
(`SUPPORT_REGISTRY`); rationale in `../docs/research/memory-retrieval.md`.

## Sample-uniqueness weighted training — `hivemind/training/sample_weights.js`

Overlapping labels share information, so a training set of `n` overlapping
labels is worth fewer than `n` independent observations (Lopez de Prado,
*Advances in Financial Machine Learning*, ch. 4). `sample_weights.js` computes
each observation's **average uniqueness** — the mean of `1/concurrency` over its
label span — and turns it into a loss weight: `overlapUniqueness` → `clampWeights`
→ `normalizeWeights` (`mean1` keeps the mean weight at exactly 1 so the average
step size is preserved while credit is redistributed; `sum1` gives a convex
combination). `spanWeightsFromEntries(entries, {horizonBars})` derives the spans
from entry bars for the streaming controller. `HiveMind.train(inputs, target,
sampleWeight)` multiplies the logit gradient by the weight (default 1, a
bit-exact no-op); the controller feeds it via `_sampleWeightsForBatch`, which
returns `null` unless `_sampleWeightConfig` is set, so the default path is
unchanged. `sample_weights.test.js` (36 checks) proves the pure math (bit-for-bit
against `analysis/uniqueness.js`) and that the train step is exactly linear in the
weight. Registered `LOCKED-invariant` in `../test/lock-registry.js`; rationale in
`../docs/research/financial-validation.md`.

## Homeostatic plasticity — `hivemind/ensemble/homeostasis.js`

The per-member learning rates are governed by a *rank-based* controller: each
member's composite score is compared against a percentile of the ensemble. Rank
control is blind to common-mode drift (scale every member up equally and the
control signal is unchanged), so `homeostasis.js` adds an *absolute*
error-driven regulator in the spirit of Turrigiano's synaptic scaling and the
homeostatic-continual-learning controller of arXiv 2609.13771.
`homeostaticScale(activity) = clamp(1 + gain·(target − activity))` is bounded to
`[minScale, maxScale]`, monotone non-increasing, and exactly `1` when the
activity equals the set-point, so the target is a true fixed point. `updateActivity`
maintains an EMA of `|output|` as the activity signal; `rootMeanSquare` and
`deviationEnergy` are the comparison metrics; `isStableConfig` reports the
analytic stability region `0 < gain·target < 2`. `_updateAdaptiveLearningRates`
applies the multiplier to each already-rank-controlled rate when
`_homeostasisEnabled` is true. The shipped default is **false**, and the test
proves that enabling with `gain = 0` produces fingerprint-equal trajectories to
the disabled path, so all 11 golden values are unaffected. `homeostasis.test.js`
(30 checks) proves the pure math and the closed-loop convergence to `target/k`
on the toy system `activity = k·lr`. Registered `LOCKED-invariant` in
`../test/lock-registry.js` (`SUPPORT_REGISTRY`); rationale in
`../docs/research/continual-learning.md` and
`../docs/research/ensemble-evolution.md`.

## Run integrity, observability & drivers — top level + `observer/`

Added in ROADMAP P0-P3. All of it is either an error-path guard or additive,
read-only tooling: nothing here is imported by the locked hot path, so a change
cannot move a golden fingerprint (the only golden change this round was the
deliberate \`hm:postReloadPrediction\` rounding — \`../docs/BUGS.md\` #19).

| module | role | proven by |
| --- | --- | --- |
| \`preflight.js\` | \`npm run preflight\` — the read-only gate before a long run (node floor, candle sample, state dir, native SQLite round-trip, config sanity, a real worker smoke test, port + resource headroom) | \`preflight.test.js\` |
| \`dryrun.js\` | \`npm run dryrun\` — runs the REAL pipeline over a synthetic stream with a compact config and self-checks its invariants | \`dryrun.test.js\` |
| \`analyze.js\` | \`npm run analyze\` — the walk-forward **feature A/B driver** (ROADMAP P2-1): the default-off variant family plus, after round 23, the 8 causal signal candidates (K = 15 on one family-wise gate); \`promoteDecision\` + \`walkForwardSearch\`, a run report. The default model is the **shipped \`HiveMindController\`** (\`makeControllerModelFactory\`: real OHLCV, prequential per fold, documented \`prob -> position\` policy, abstains on the \`-1\` sentinel or a throw); \`--model=bare\` reproduces the round-22 proxy, \`--symbols=a,b|all\` + \`--files\` pool streams (all 8 audited symbols), \`--probe\`/\`--audit-probes\`/`--variants\`/\`--bars\`/\`--train\`/\`--test\`/\`--seed\` tune the run. Round 24b (premium hardening after the first complete smoke run): `--reuse-base` reuses the scored pass as the audit base pass (one fewer refit per fold, verdict-identical, recorded in the report as `baseReused`), `--cost-bps` is threaded to the scoring, `folds.jsonl` lines carry `probeIndex` + `reused` (so the journal is readable offline), and the summary states the run-level power verdict. Round 24 (run integrity, all arithmetic-free): \`modelRetention\` (factory default \`keep\`, CLI default \`discard\`) reclaims each fit's state dir; a run writes \`run.json\` / \`report.json\` / \`partial-report.json\` / \`progress.json\` / \`folds.jsonl\` / \`run.log\`; the report carries a machine-readable \`audit\` block (\`clean\`/\`reachable\`/\`reachableFolds\`/\`probes\`); flags \`--keep-models\` / \`--reachable\` / \`--fold-log\` / \`--progress-ms\` / \`--help\`. | \`analyze.test.js\` (143) |
| \`dashboard.js\` | the self-contained monitor HTML (inline CSS + vanilla JS, SSE + polling) served by \`legion/http_server_worker.js\` | \`http_view.test.js\` |
| \`observer/legion_metrics.js\` | **pure** legion-health metrics: Brier + Murphy partition, entropy/HHI/effective voters/Gini, Cohen κ, EWMA/CUSUM, consensus probability | \`observer.test.js\` |
| \`observer/alerts.js\` | **pure** alert rule engine (metric + op + threshold + severity; hysteresis via the previous firing set) | \`observer.test.js\` |
| \`observer/collector.js\` | subscribes to \`state.onBatchSnapshot\` and maintains the rolling windows; read-only w.r.t. the run | \`observer.test.js\` |
| \`observer/report.js\` | run directory (\`run.json\`), snapshot spool (\`snapshots.jsonl\`), \`run.log\`, \`report.json\`, and retention pruning | \`observer.test.js\`, \`report_lifecycle.test.js\` |

## Candle data

`candles.jsonl` is the BTCUSDT 1h stream the legion trains on; the other seven
Binance 1h symbols live in `data/` (ETH, SOL, BNB, XRP, ADA, DOGE, LINK —
**567,684 rows / ~63 MB** total, audited by `candles.test.js`). The canonical
list is `CANDLE_MANIFEST` in `candles_audit.js`. `candle_fetcher.js` is the
network-free fetch/merge/gap library (tested by `fetcher.test.js`, 101 checks);
`fetch_candles.js` is the single-symbol CLI and `update_candles_basket.js` the
basket orchestrator. See the repo `README.md` for the `npm run fetch*` scripts.

## Status legend

The full, machine-readable classification — with the citations and proving tests
for every component — is [`../docs/LOCKED.md`](../docs/LOCKED.md) and
[`../test/lock-registry.js`](../test/lock-registry.js) (checked by
`locks.test.js`). Summary:

- **LOCKED (bit-exact)** — `hiveMind.js` + everything under `hivemind/`
  (except `internal/mixins.js`, pure additions like `diagnostics`, and
  `persistence/dimensions.js`, which is now `LOCKED-invariant`). Any
  change must keep `golden.test.js` fingerprints identical, or be an
  intentional, documented re-freeze. (One exception to "identical": the
  `hm:predictions` fingerprint is compared at 6 significant digits, because it
  hashes raw float64 `predict()` output and was JS-engine-sensitive rather than
  driver-sensitive — see `../docs/BUGS.md` #17 and
  `test/node/engine_portability.test.js`. The other ten are literal.)
- **LOCKED (structural)** — `legion/` and `hivemind/controller/` are covered by
  `legion.test.js` / `modules.test.js` / `core.test.js`; they are not
  fingerprint-locked method-by-method, but their behaviour is pinned.
- **LOCKED (invariant)** — the `analysis/` supercharges (`performance.js`,
  `splits.js`, `labels.js`, `uniqueness.js`, `backtest.js`, `walkforward.js`,
  `overfitting.js`, `reality_check.js`) and the hot-path support modules (`price_precision.js`, `hivemind/memory/surprise.js`,
  `hivemind/training/sample_weights.js`, `hivemind/ensemble/homeostasis.js`,
  `legion/evolve.js`, `hivemind/memory/multiprobe.js`, `hivemind/memory/binarypc.js`,
  `hivemind/memory/bitweight.js`, `hivemind/memory/querymod.js`,
  `consolidation_logic.js`,
  `candle_quality.js`): exact reference vectors.
  `price_precision.js` is additionally covered by `multisymbol.test.js` and the
  unchanged golden fingerprints; `surprise.js`, `sample_weights.js`,
  `homeostasis.js` and `evolve.js` are each covered by their own entry (the first
  three are default-off no-ops that keep the goldens unchanged; `evolve.js` is the
  one remaining additive module nothing imports yet), while `multiprobe.js`,
  `binarypc.js`, `bitweight.js` and `querymod.js` are flag-gated into the locked
  `lsh` bag behind `_multiProbeConfig`, `_pcaHashConfig` and `_queryModConfig`,
  so each is pinned by its own entry **and** the golden no-op.
- **NEEDS-LOCAL-RUN** — **none remain.** The `test/node/` mirrors (real
  `better-sqlite3` + real `worker_threads`) are green locally
  (`npm test`, **115/115 blocks across 39 files** at round 22,
  `../docs/BUGS.md` #20/#21), so the three controller
  DB bags (`controllerDatabase`, `controllerAccuracy`, `controllerTrade`) were
  promoted to `LOCKED-invariant` (`../docs/LOCKED.md`, `../test/lock-registry.js`).
  Re-run `npm test` locally after any change to the hot path or the mirrors.

## Known findings (details in `../docs/BUGS.md`)

- **State is not bit-idempotent through SQLite** (reload ≠ in-memory), for two
  independent reasons: the matrix/gradient columns are float32 BLOBs while
  memory is float64, **and** derived state is recomputed rather than restored
  (the loader truncates `_priorityIndices` to `_priorityMax` while the runtime
  uses `priorityMax * tempOverloadFactor`; `projNorms`/`_cachedAvgVariance` can
  be stale on the live side). A float64-blob-only fix was tried and reverted —
  it didn't reach `Object.is` and shifted the training trajectory. Fix Cause 2
  first; see `BUGS.md` for the measured breakdown.
- `blobToVector` assumes 8-byte-aligned BLOBs (true for better-sqlite3 and the
  sql.js shim).
- The browser test shim cannot run the same entry twice in one worker (sql.js
  `registry` vs `globalThis.__vfs` mismatch); use a fresh worker per entry.
- **The `hm:predictions` golden fingerprint is JS-engine-sensitive by nature**
  (it is the one observable over raw, unrounded float64 `predict()` output), so
  it is compared at 6 significant digits; a last-ulp transcendental difference
  moves it and nothing else. The other ten golden hashes are literal.
  `test/node/engine_portability.test.js` guards the invariant under a simulated
  +1-ulp `Math.exp` drift; see `BUGS.md` #17.
