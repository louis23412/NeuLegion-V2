// Lock registry — the machine-readable "what is proven, and by what" map.
//
// Every method bag in `test/component-manifest.js` must have exactly one entry
// here. `test/browser/entries/locks.test.js` (and its node mirror) fails if the
// registry drifts from the manifest, if a status is invalid, if a LOCKED* entry
// lacks supporting tests, or if a citation key is unknown.
//
// Status semantics (see docs/LOCKED.md):
//   LOCKED-bit-exact   behaviour pinned by a golden fingerprint; changing the
//                      arithmetic requires an intentional re-freeze.
//   LOCKED-structural  wiring/shape pinned by modules.test.js; no math claim.
//   LOCKED-invariant   a mathematical property pinned by a dedicated check.
//   NEEDS-LOCAL-RUN    plausible + cited, but only provable on a machine with
//                      Node + better-sqlite3 (`npm test`).
//   EXPERIMENTAL       additive candidate not yet proven; must not be imported
//                      by locked code paths.
//
// `proves` names test entry files under test/browser/entries/ (basenames). A
// LOCKED-bit-exact entry must additionally name the golden fingerprints that
// pin it, so a re-freeze is reviewable.

export const LOCK_LEVELS = Object.freeze({
    BIT_EXACT: 'LOCKED-bit-exact',
    STRUCTURAL: 'LOCKED-structural',
    INVARIANT: 'LOCKED-invariant',
    NEEDS_LOCAL_RUN: 'NEEDS-LOCAL-RUN',
    EXPERIMENTAL: 'EXPERIMENTAL',
});

// Domain -> research note. The locks test asserts each file exists on disk and
// carries a level-1 heading.
export const DOMAINS = Object.freeze({
    memory: 'docs/research/memory-retrieval.md',
    lsh: 'docs/research/lsh-ann.md',
    attention: 'docs/research/attention-kernels.md',
    ensemble: 'docs/research/ensemble-evolution.md',
    training: 'docs/research/training-distillation.md',
    continual: 'docs/research/continual-learning.md',
    finance: 'docs/research/financial-validation.md',
    observability: 'docs/research/observability.md',
});

// Citation keys used by the registry. Short form is what appears in docs.
export const CITATIONS = Object.freeze({
    charikar2002: 'Charikar, Similarity Estimation Techniques from Rounding Algorithms, STOC 2002',
    kanerva1988: 'Kanerva, Sparse Distributed Memory, MIT Press 1988',
    vaswani2017attention: 'Vaswani et al., Attention Is All You Need, arXiv 1706.03762',
    su2021rope: 'Su et al., RoFormer / Rotary Position Embedding, arXiv 2104.09864',
    zhang2019rmsnorm: 'Zhang & Sennrich, Root Mean Square Layer Normalization, arXiv 1910.07467',
    shazeer2020glu: 'Shazeer, GLU Variants Improve Transformer, arXiv 2002.05202',
    ramachandran2017swish: 'Ramachandran et al., Searching for Activation Functions, arXiv 1710.05941',
    ramsauer2020hopfield: 'Ramsauer et al., Hopfield Networks is All You Need, arXiv 2008.02217',
    behrouz2025titans: 'Behrouz et al., Titans: Learning to Memorize at Test Time, arXiv 2501.00663',
    shin2017generative: 'Shin et al., Continual Learning with Deep Generative Replay, arXiv 1705.08690',
    kirkpatrick2017ewc: 'Kirkpatrick et al., Overcoming Catastrophic Forgetting, arXiv 1612.00796',
    lakshminarayanan2017deep: 'Lakshminarayanan et al., Deep Ensembles, arXiv 1612.01474',
    hinton2015distilling: 'Hinton et al., Distilling the Knowledge in a Neural Network, arXiv 1503.02531',
    goyal2017accurate: 'Goyal et al., Accurate, Large Minibatch SGD, arXiv 1706.02677',
    salimans2017es: 'Salimans et al., Evolution Strategies as a Scalable Alternative to RL, arXiv 1703.03864',
    leprado2018afml: 'Lopez de Prado, Advances in Financial Machine Learning, Wiley 2018',
    hippocampus2607: 'A Hippocampus for Linear Attention, arXiv 2607.02303',
    eviction2607: 'Eviction as Estimation: A Fixed-Lag Smoothing View of Test-Time Memory, arXiv 2607.24667',
    mela2605: 'Mela: Test-Time Memory Consolidation, arXiv 2605.10537',
    interference2609: 'Anatomy of Associative Recall in Fixed-State Recurrences, arXiv 2609.16183',
    janus2609: 'JANUS Post-hoc Rectification for Stability-Plasticity, arXiv 2609.19985',
    homeostatic2609: 'Homeostatic Continual Learning, arXiv 2609.13771',
    eggroll2609: 'EGGROLL, Unrolled: Low-Rank Evolution Strategies at Scale, arXiv 2609.10980',
    diversitycollapse2608: 'Breaking Diversity Collapse in Pseudo-Ensembles, arXiv 2608.01090',
    binarypc2608: 'Training-Free Hashing-Based Attention via Binary Principal Components, arXiv 2608.04405',
    coverthomas2006: 'Cover & Thomas, Elements of Information Theory (2nd ed.), Wiley 2006 (binary symmetric channel: capacity 1 - H2(crossover))',
    andoni2015dd: 'Andoni, Indyk & Laarhoven, Optimal Data-Dependent Hashing for Approximate Near Neighbors, arXiv 1501.01062 (STOC 2015: data-dependent hashing beats the best data-independent LSH for every approximation factor)',
    denshash2012: 'Density Sensitive Hashing, arXiv 1205.2930 (hash directions from the data density)',
    weightedhamming2009: 'Fast Search on Binary Codes by Weighted Hamming Distance, arXiv 2009.08591 (hash bits are not equally reliable)',
    dqm2605: 'Dynamic Query Modification for Binary LSH, arXiv 2605.23807',
    hybrid2609: 'Modern Transformers Are Implicit Hybrids, arXiv 2609.02986',
    finval2609: 'SPEAR NeXT: Causal Latent Forecasting Across Horizons, arXiv 2609.16871',
    binanceTick: 'Binance, Symbol tick size & price precision (exchangeInfo PRICE_FILTER.tickSize), platform docs 2024',
    lv2017multiprobe: 'Lv et al., Multi-Probe LSH: Efficient Indexing for High-Dimensional Similarity Search, VLDB 2007',
    adaptivebuckets2604: 'Cardinality Estimation for High Dimensional Similarity Queries with Adaptive Bucket Probing, arXiv 2604.04603 (multi-probe LSH adapted to the query/distance threshold, exploring neighbouring buckets with a query-dependent budget)',
    neuroute2608: 'NeuRoute: Logit-Guided Neural Routing for Billion-Scale Vector Search, arXiv 2608.15438 (the query logits are an uncertainty signal: perturb only the low-confidence bits)',
    queryadaptive1904: 'Liu et al., Query-Adaptive Hash Code Ranking for Large-Scale Multi-View Visual Search, arXiv 1904.08623 (query-adaptive bitwise/tablewise weighting)',
    politis1994: 'Politis & Romano, The Stationary Bootstrap, JASA 1994',
    politis2004blocklength: 'Politis & White, Automatic Block-Length Selection for the Dependent Bootstrap, Econometric Reviews 23(1):53-70, 2004 (flat-top-kernel optimal block length)',
    patton2009correction: 'Patton, Politis & White, Correction to "Automatic Block-Length Selection for the Dependent Bootstrap", Econometric Reviews 28(4):372-375, 2009 (m = 2 max(m_hat, 1) correction)',
    politisromano1994subsampling: 'Politis & Romano, Large Sample Confidence Regions Based on Subsamples under Minimal Assumptions, Annals of Statistics 22(4):2031-2050, 1994 (variance-consistent subsampling inference)',
    politisromano1999book: 'Politis, Romano & Wolf, Subsampling, Springer Series in Statistics, 1999 (ch. 3-4: subsampling the studentized statistic; no long-run-variance estimate needed)',
    pardo2008walkforward: 'Pardo, The Evaluation and Optimization of Trading Strategies, Wiley 2008 (walk-forward analysis)',
    leakage2605: 'Decision-time leakage in financial ML, arXiv 2605.23959 (one-switch leakage benchmark)',
    honesteval2608: 'What Survives Honest Evaluation? Leakage-Safe, Search-Aware Strategy Discovery, arXiv 2608.27734 (a leaky Sharpe-35 oracle survives DSR/PBO)',
    algoxpert2603: 'AlgoXpert IS/WFA/OOS protocol for mitigating overfitting, arXiv 2603.09219',
    minervascore2608: 'Equity Strategy Backtesting: Luck or Edge? The MinervaScore as a Statistical Robustness Grade, arXiv 2608.23808 (search luck vs persistent signal)',
    meanshiftlrv2603: 'Difference-Based High-Dimensional Long-Run Covariance Matrix Estimation for Mean-shift Time Series, arXiv 2603.17226 (LRV bias when the level moves across segments)',
    bailey2016pbo: 'Bailey, Borwein, Lopez de Prado & Zhu, The Probability of Backtest Overfitting, Journal of Computational Finance 2016 (CSCV)',
    white2000rc: "White, A Reality Check for Data Snooping, Econometrica 48(5):1097-1126, 2000 (bootstrap max statistic)",
    hansen2005spa: 'Hansen, A Test for Superior Predictive Ability, Journal of Business & Economic Statistics 23(4):365-380, 2005 (studentized, recentred SPA)',
    romano2005stepm: 'Romano & Wolf, Stepwise Multiple Testing as Formalized Data Snooping, Econometrica 73(4):1237-1282, 2005 (step-down max-t, FWER-controlled stepwise SPA)',
    romano2007generalized: 'Romano & Wolf, Control of Generalized Error Rates in Multiple Testing, Annals of Statistics 35(4):1378-1408, 2007, arXiv 0710.2258 (single-step k-FWER and the FDP step-down)',
    delattre2014fdp: "Delattre & Roquain, New Procedures Controlling the False Discovery Proportion via Romano-Wolf's Heuristic, arXiv 1311.4030, 2014 (the growing-k FDP step-down; proves the heuristic is not rigorously FDP-controlling in finite samples)",
    kaplan2020scaling: 'Kaplan et al., Scaling Laws for Neural Language Models, arXiv 2001.08361 (width/depth scaling)',
    yang2022mup: 'Yang et al., Tensor Programs V: Tuning Large Neural Networks via Zero-Shot Hyperparameter Transfer, arXiv 2203.03466 (muP width scaling)',
    brier1950: 'Brier, Verification of Forecasts Expressed in Terms of Probability, Monthly Weather Review 78(1):1-3, 1950 (the proper quadratic scoring rule)',
    murphy1973: 'Murphy, A New Vector Partition of the Probability Score, Journal of Applied Meteorology 12(4):595-600, 1973 (reliability-resolution-uncertainty partition)',
    wald1945: 'Wald, Sequential Tests of Statistical Hypotheses, Annals of Mathematical Statistics 16(2):117-186, 1945 (sequential testing; the CUSUM precursor)',
    page1954: 'Page, Continuous Inspection Schemes, Biometrika 41(1/2):100-115, 1954 (the two-sided CUSUM control scheme)',
    cohen1960: 'Cohen, A Coefficient of Agreement for Nominal Scales, Educational and Psychological Measurement 20(1):37-46, 1960 (kappa: chance-corrected agreement)',
    kuncheva2003: 'Kuncheva & Whitaker, Measures of Diversity in Classifier Ensembles, Machine Learning 51(2):181-207, 2003 (ensemble diversity measures)',
    gini1912: 'Gini, Variabilita e mutabilita, 1912 (the Gini coefficient of inequality)',
    hirschman1945: 'Hirschman, National Power and the Structure of Foreign Trade, 1945 (the concentration index; Herfindahl-Hirschman)',
    cameronmiller2015: 'Cameron & Miller, A Practitioner\'s Guide to Cluster-Robust Inference, Journal of Human Resources 50(2):317-372, 2015 (clusters are the independent units; the cluster-robust variance estimator and the t(C-1) reference distribution with few clusters)',
    kunsch1989: 'Künsch, The Jackknife and the Bootstrap for General Stationary Observations, Annals of Statistics 17(3):1217-1241, 1989 (the delete-block jackknife variance estimator for serially dependent data)',
    clusterjackknife2602: 'Karim, Nielsen, MacKinnon & Webb, Improved Inference for CSDID Using the Cluster Jackknife, arXiv 2602.12043, 2026 (the delete-one-cluster jackknife repairs over-rejection with few/unequal clusters)',
    kish1965: 'Kish, Survey Sampling, Wiley 1965 (the design effect 1+(K-1)*rho: K correlated units are worth K/(1+(K-1)*rho) independent ones)',
    grinold1989: 'Grinold, The Fundamental Law of Active Management, Journal of Portfolio Management 15(3):30-37, 1989 (the information ratio scales with sqrt(breadth), where breadth is the number of INDEPENDENT forecasts)',
    ledoitwolf2008: 'Ledoit & Wolf, Robust Performance Hypothesis Testing with the Sharpe Ratio, Journal of Empirical Finance 15(5):850-859, 2008 (comparing two Sharpe ratios on dependent samples)',
    demsar2006: 'Demsar, Statistical Comparisons of Classifiers over Multiple Data Sets, Journal of Machine Learning Research 7:1-30, 2006 (the exact sign test as the robust paired comparison; recommended over the t-test for non-normal paired samples)',
    efftests1612: 'Halle, Djurovic, Andreassen & Langaas, Is the Familywise Error Rate in Genomics Controlled by Methods Based on the Effective Number of Independent Tests?, arXiv 1612.04535, 2016 (methods that substitute an effective number of independent tests do NOT control the FWER)',
    harveysliu2016: 'Harvey, Liu & Zhu, ...and the Cross-Section of Expected Returns, Review of Financial Studies 29(1):5-68, 2016 (correlated tests are still tests that were run: the multiple-testing hurdle grows with the number searched)',
    frazzini2018costs: 'Frazzini, Israel & Moskowitz, Trading Costs, SSRN 3221167, 2018 (the empirical scale of trading costs, and why a gross-only verdict is not a verdict)',
    binancefees: 'Binance, Spot and USDⓈ-M futures fee schedules (spot taker 10 bps, USDⓈ-M futures taker 5 bps), platform docs 2024-2026',
    constantinides1986: 'Constantinides, Capital Market Equilibrium with Transaction Costs, Journal of Political Economy 94(4):842-862, 1986 (a proportional cost makes a no-trade region optimal: do nothing while the position is inside the band)',
    davisnorman1990: 'Davis & Norman, Portfolio Selection with Transaction Costs, Mathematics of Operations Research 15(4):676-713, 1990 (characterises the region boundaries and the impulse/continuity structure: an enter/exit hysteresis pair, not one threshold)',
    garleanu2013: 'Garleanu & Pedersen, Dynamic Trading with Predictable Returns and Transaction Costs, Journal of Finance 68(6):2309-2340, 2013 (the modern dynamic formulation: a cost-scaled aim in/out region and the effective-turnover notion)',
    notrade2101: 'Optimal investment in illiquid market with search frictions and transaction costs, arXiv 2101.09936 (small-cost asymptotics of the no-trade region boundaries and value function)',
    alphadecay2502: 'On the Effect of Alpha Decay and Transaction Costs on the Multi-period Optimal Trading Strategy, arXiv 2502.04284 (alpha decay: past signal values matter, so the cost-aware optimal policy is a holding/hysteresis rule)',
    turnoverreg2509: 'Finance-Grounded Optimization For Algorithmic Trading, arXiv 2509.04541 (turnover regularization: a loss term constraining a position series turnover to a budget)',
    deepmomentum1904: 'Enhancing Time Series Momentum Strategies Using Deep Neural Networks, arXiv 1904.04912 (learned trend + position sizing retains an edge after 2-3 bps of cost)',
    bouthillier2019: 'Bouthillier, Laurent & Vincent, Unreproducible Research is Reproducible, ICML 2019 (arXiv 1910.08527) (the same code on the same data varies across runs; a single run is not evidence and its variance must be reported)',
    henderson2018: 'Henderson et al., Deep Reinforcement Learning that Matters, AAAI 2018 (arXiv 1709.06560) (seed choice alone can change the measured ORDERING of algorithms, so a comparison must be repeated over seeds)',
    agarwal2021: 'Agarwal, Schwarzer, Castro, Courville & Bellemare, Deep Reinforcement Learning at the Edge of the Statistical Precipice, NeurIPS 2021 (arXiv 2108.13264) (the interquartile mean (IQM) and stratified-bootstrap confidence intervals are the robust way to summarize noisy per-run metrics)',
    glasserman1992: 'Glasserman & Yao, Some Guidelines and Guarantees for Common Random Numbers, Management Science 38(6):884-908, 1992 (common random numbers reduce the variance of the DIFFERENCE between two systems when the response is monotone in the shared randomness)',
    diebold1995: 'Diebold & Mariano, Comparing Predictive Accuracy, Journal of Business & Economic Statistics 13(3):253-263, 1995 (the paired test on per-period loss differentials: the correct way to say "model A forecasts better than model B" on the same bars)',
    hansenlundenason2011: 'Hansen, Lunde & Nason, The Model Confidence Set, Econometrica 79(2):453-497, 2011 (return the SET of models that cannot be distinguished from the best at a chosen confidence, instead of crowning a winner from noisy dependent losses)',
    gneitingraftery2007: 'Gneiting & Raftery, Strictly Proper Scoring Rules, Prediction and Estimation, Journal of the American Statistical Association 102(477):359-378, 2007 (which scores are PROPER, so "the model is good" cannot be earned by hedging toward the base rate)',
    jamieson2016sha: 'Jamieson & Talwalkar, Non-stochastic Best Arm Identification and Hyperparameter Optimization, AISTATS 2016 (arXiv 1502.07943) (successive halving: give many arms a small budget, keep the top 1/eta, repeat)',
    li2018hyperband: 'Li, Jamieson, DeSalvo, Rostamizadeh & Talwalkar, Hyperband: A Novel Bandit-Based Approach to Hyperparameter Optimization, JMLR 18(185):1-52, 2018 (arXiv 1603.06560) (successive halving as a subroutine; the budget/eta schedule)',
});

// Test entries that `proves` may reference.
export const KNOWN_TESTS = Object.freeze([
    'core.test.js',
    'sanity.test.js',
    'features.test.js',
    'indicators.test.js',
    'consolidation.test.js',
    'consolidation_worker.test.js',
    'fetcher.test.js',
    'golden.test.js',
    'modules.test.js',
    'legion.test.js',
    'candles.test.js',
    'locks.test.js',
    'analysis.test.js',
    'price_precision.test.js',
    'multisymbol.test.js',
    'lsh.test.js',
    'surprise.test.js',
    'sample_weights.test.js',
    'homeostasis.test.js',
    'evolve.test.js',
    'multiprobe.test.js',
    'binarypc.test.js',
    'bitweight.test.js',
    'querymod.test.js',
    'walkforward.test.js',
    'dimensions.test.js',
    'guards.test.js',
    'observer.test.js',
    'analyze.test.js',
]);

// ---------------------------------------------------------------------------
// Analysis supercharges (`src/analysis/*`).
//
// These are *additive* — they never import from, and are never imported by, the
// locked hot path, so they cannot move a golden fingerprint. Each is a pure
// module with exact reference vectors in `analysis.test.js`, which is what lets
// it be LOCKED-invariant rather than EXPERIMENTAL.
// ---------------------------------------------------------------------------

export const ANALYSIS_MODULES = Object.freeze({
    'performance.js': [
        'erf', 'normalCdf', 'normalInvCdf', 'mean', 'stdPopulation', 'stdSample',
        'sharpeRatio', 'annualizeSharpe', 'deannualizeSharpe', 'skewness', 'kurtosis',
        'sharpeStandardError', 'probabilisticSharpeRatio', 'expectedMaxSharpe',
        'defaultTrialVariance', 'deflatedSharpeRatio', 'minimumTrackRecordLength',
        'stationaryBootstrapSharpe', 'evaluateStrategy',
    ],
    'splits.js': [
        'normalizeLabelSpans', 'purgedKFoldSplit', 'walkForwardSplit', 'assertNoLeakage', 'combinatorialPurgedSplit',
    ],
    'labels.js': [
        'tripleBarrierLabels', 'cusumFilter', 'fractionalDiffWeights', 'fractionalDiff',
        'fracDiffLogPrices', 'DEFAULT_FD_WINDOW',
    ],
    'uniqueness.js': [
        'sampleUniqueness', 'averageUniqueness', 'effectiveSampleSize', 'sequentialBootstrap',
    ],
    'backtest.js': [
        'positionsFromSignals', 'turnover', 'strategyReturns', 'equityCurve', 'maxDrawdown',
        'hitRate', 'tradeCount', 'backtestMetrics', 'purgedCVBacktest', 'annualizedReturn',
    ],
    'walkforward.js': [
        'barReturns', 'logReturns', 'probToPosition', 'isCausalFold', 'aggregateFolds',
        'foldWinFraction', 'auditNoLookahead', 'walkForwardEvaluate', 'promoteDecision',
        'formatReport', 'familywiseSearch', 'walkForwardSearch',
        'sharpeStandardError', 'minimumDetectableSharpe', 'barsToDetect', 'UNDERPOWERED_MDE', 'poolReports',
        'dependenceSummary', 'clustersOf', 'pairedPromotionTest', 'restateReportAtCost', 'costLadder',
        'familyCorrelation', 'DEPENDENCE_GATE_READER',
        'confidenceToPosition', 'confidenceFromProb', 'restateReportAtPolicy', 'verifyPolicyRoundTrip',
        'positionSeriesFromConfidence',
    ],
    'holding.js': [
        'DEFAULT_TURNOVER_GRID', 'turnoverSweep', 'bestTurnoverPolicy', 'formatTurnoverSweep',
    ],
    'streams.js': [
        'resampleCandles', 'designEffectOfStreams', 'selectStreams', 'formatStreamSelection',
    ],
    'replication.js': [
        'interquartileMean', 'stratifiedBootstrapCI', 'varianceComponents',
        'seedDistribution', 'pairedVarianceRatio', 'formatSeedReplication',
    ],
    'forecast.js': [
        'forecastPairs', 'brierBinIndex', 'brierScore', 'logScore', 'brierDecomposition',
        'brierLosses', 'bootstrapMeans', 'dieboldMariano', 'modelConfidenceSet',
        'forecastComparison', 'formatForecast',
    ],
    'decision.js': [
        'foldConcentration', 'confidencePersistence', 'nextRunPlan',
        'decisionReport', 'formatDecision',
    ],
    'race.js': [
        'halvingRounds', 'halvingSchedule', 'successiveHalving', 'formatRace',
    ],
    'dependence.js': [
        'pearsonCorrelation', 'meanPairwiseCorrelation', 'equicorrelationDesignEffect',
        'equicorrelationEffectiveSize', 'foldWindowClusters', 'concatClusters', 'clusterJackknife',
        'pairedClusterTest', 'pairedClusterSignTest', 'signTest', 'signTestFloor',
        'clusterStability', 'regularizedIncompleteBeta', 'studentTPValue', 'studentTCdf',
    ],
    'world.js': [
        'DEFAULT_SHOCK', 'shockFactor', 'volumeShockFactor', 'shockCandles', 'makeCandleViewFor', 'worldFromCandles',
    ],
    'features.js': [
        'DEFAULT_POSITION', 'clampPosition', 'momentum', 'fracDiffAt', 'fracMomentum',
        'volRegime', 'momentumAgreement', 'rangeLocation', 'volumeImbalance', 'autocorr1',
        'acceleration', 'causalZScore', 'positionAt', 'signalForCandidate', 'SIGNAL_CANDIDATES',
    ],
    'overfitting.js': [
        'DEFAULT_PBO_CONFIG', 'cscvBlocks', 'cscvSplit', 'relativeRank',
        'oosOnIsRegression', 'probabilityOfBacktestOverfitting',
    ],
    'reality_check.js': [
        'DEFAULT_RC_CONFIG', 'benchmarkSeries', 'relativePerformance',
        'stationaryBlockIndices', 'bootstrapRelativeMeans', 'whiteRealityCheck', 'hansenSpa',
        'consistentRecentring', 'hansenSpaConsistent', 'romanoWolfStepM',
        'politisWhiteBlockLength', 'autoBlockLength',
        'DEFAULT_SUB_CONFIG', 'neweyWestSE', 'subsamplingSpa', 'subsamplingStepM',
        'subsamplingKfwer', 'subsamplingFdp',
    ],
});

export const ANALYSIS_REGISTRY = Object.freeze({
    'performance.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml', 'finval2609', 'politis1994'],
        proves: ['analysis.test.js'],
        note: 'Sharpe/PSR/DSR/MinTRL + stationary bootstrap. Exact reference vectors: normalCdf(0)=0.5, kurtosis([1..5])=1.7, MinTRL(SR=0.5,95%)=13.174945, DSR<=PSR, DSR(trials=1)=PSR. Stationary bootstrap is now calibrated (BUGS.md #10): the 5% test rejects 5.8% of pure-noise series (was 17.5% before the Politis-Romano block-restart fix) while keeping full power on a strong edge.',
    },
    'splits.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml'],
        proves: ['analysis.test.js'],
        note: 'Purged K-fold + embargo + walk-forward + combinatorial purged CV (AFML ch. 12). Proved: train/test disjoint, zero label-window leakage, train starts after embargo; combinatorialPurgedSplit yields C(k,m) folds, each test set a union of whole groups, each observation tested exactly C(k-1,m-1) times (the backtest-path count), with embargo monotonically shrinking the training set. Hardening (BUGS.md #12/#13): walkForwardSplit rejects a non-positive/non-finite step (a zero step used to make the fold loop never terminate), and combinatorialPurgedSplit rejects a C(k,m) above the fold cap instead of attempting an astronomical enumeration.',
    },
    'labels.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml'],
        proves: ['analysis.test.js'],
        note: 'Triple-barrier, CUSUM, fractional differentiation. Proved: label in {-1,0,1} with exact first-touch indices; FD weights d=1 => [1,-1,0], d=0.5 => [1,-0.5,-0.125]; FD(first difference) of a linear series is constant.',
    },
    'uniqueness.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml'],
        proves: ['analysis.test.js'],
        note: 'Sample uniqueness + sequential bootstrap. Proved: uniqueness of [[0,2],[1,3]] = 2/3 each; ESS of point labels = n; deterministic sequential bootstrap.',
    },
    'backtest.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml', 'finval2609'],
        proves: ['analysis.test.js'],
        note: 'No-lookahead backtest: positions lag one bar, costs charged on turnover. Proved exact arithmetic (cost 10bps on entry => 0.019, maxDrawdown 0.5), and that it does NOT bless noise: perfect foresight PSR>0.99 / drawdown ~0, anti-signal PSR<0.01 / drawdown >0.5, zero-skill signal DSR<0.95, costs monotone. purgedCVBacktest pools per-fold net returns; the series-reading metrics are correct, and the position-based ones (turnover/tradeCount/totalCost/grossSharpe) are overridden with the per-fold strategy sums + the pooled gross Sharpe, so the pooled report is a real strategy summary rather than an all-long overlay (BUGS.md #11). ROUND 25: backtestMetrics takes an `effectiveBars` sample size (the design-effect-adjusted n) and returns psrAdjusted/dsrAdjusted computed on it — null, not the unadjusted value, when no design effect was justified; it also reports participation (nonZeroFraction/meanAbsPosition, which is what distinguished the attempt-3 `query-mod` candidate: a median fold Sharpe of exactly 0 with a pooled DSR of 0.9992 is a filter that abstains on most folds) and a `minTrackRecordLengthStatus` (finite | beyond-horizon | unavailable), because JSON.stringify turns the Infinity of "no track record length would suffice" into a null indistinguishable from "not computed". poolFolds aggregates the participation metrics over the folds (the all-long overlay of the pooled series would report 1.0/1.0 — the overlay\\x27s participation, not the strategy\\x27s) and forwards `effectiveBars`; purgedCVBacktest retains `foldInputs` (each fold\\x27s returns/signals BY REFERENCE, no copies) so a finished report can be restated at any cost level without the model (walkforward#restateReportAtCost). Round 26 (R26-3): it also journals the raw pre-policy confidence per fold (`confidenceForFold`), so the whole report can be restated at another confidence->position policy too (`walkforward#restateReportAtPolicy`) — still without the model.',
    },
    'walkforward.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['pardo2008walkforward', 'leprado2018afml', 'leakage2605', 'honesteval2608', 'algoxpert2603', 'politisromano1994subsampling', 'romano2005stepm', 'minervascore2608', 'meanshiftlrv2603', 'cameronmiller2015', 'kunsch1989', 'clusterjackknife2602', 'kish1965', 'ledoitwolf2008', 'demsar2006', 'efftests1612', 'harveysliu2016', 'frazzini2018costs', 'binancefees'],
        proves: ['analysis.test.js', 'walkforward.test.js'],
        note: 'Walk-forward harness on top of backtest.js. Proved: barReturns/logReturns exact; probToPosition is odd about prob=50, monotone, bounded and zero on the dead-zone band; aggregateFolds mean/median/positiveFraction exact; and the flagship no-lookahead audit is exact — a signal reading view.returns[t+1] is flagged at 17/18 test bars and a full-sample-mean signal is flagged, while a strictly causal signal is clean, and walkForwardEvaluate throws on non-causal (non-walk-forward) folds. The promotion gate is size/power calibrated: requiring the absolute DSR>=0.95 edge floor cuts false promotions of a zero-skill candidate to ~3.5% (was ~37-41% relative-only) while still promoting an AR(1) momentum edge at full power. The real-candle runner (walkforward.test.js) drives a live HiveMind over a shipped symbol, re-fit per fold and frozen afterwards, with a clean audit, a caught t+1 feature, an exact per-fold buy-and-hold anchor, bit-identical determinism, and an A/B of the default-off features whose inert settings (surprise floor=1, homeostasis gain=0) are bit-identical to off end-to-end. Round 8: familywiseSearch/walkForwardSearch put the variance-consistent subsampling SPA + Romano-Wolf step-down (Politis & Romano 1994; Romano & Wolf 2005) on the honest-evaluation path over a report set, segment-aware via the fold lengths passed as `groups` (no resampling window straddles a fold boundary; each fold\x27s no-exposure first bar trimmed, arXiv 2603.17226 mean-shift LRV grounding); promoteDecision gains opt-in maxSearchP / requireSearchReject hurdles (defaults null/false, so the existing gate is bit-identical) and formatReport renders a search-corrected line, so the walk-forward runner can report the search-luck-corrected decision next to DSR (arXiv 2608.23808). Round 9: familywiseSearch/walkForwardSearch take opt-in `kfwer` (single-step k-FWER, arXiv 0710.2258) and `fdpTarget` (the FDP step-down heuristic, arXiv 1311.4030), both default-off so the Round-8 object is byte-identical; promoteDecision gains a maxFdp hurdle (null by default, so the existing gate is unchanged) and formatReport renders kfwer/fdp lines only when attached. Round 11: walkforward.test.js section I repeats the section-H family-wise A/B on the full 150-bar / 6-fold slice (48 windows, groups 14^6, b=7, m=1) with the same verdict — oracle caught, no real feature promoted, DSR and family-wise agree on every candidate. ROUND 23 (N0/N2): auditNoLookahead gains an optional viewFor(returns, perturb) hook so the audit perturbs the actual model input — without it a candle-driven model passed vacuously (BUGS.md #22) — and now returns {clean, violations, probes, viewDiffers, reachable, vacuous} with a requireReachable flag and an explicit non-finite-position reason; walkForwardEvaluate forwards viewFor to both the scoring view and the audit, and returns `power`. sharpeStandardError(bars)/minimumDetectableSharpe add the Lo (2002) Sharpe SE and the 95% MDE so every report says how much edge the sample could even see; poolReports merges one walk-forward report per stream (symbol) into a single pooled report via backtest#poolFolds (a single report is the identity); formatReport prints the power line and reads an undefined metric as n/a instead of NaN. ROUND 24b: the power summary gains an `underpowered` flag (MDE95 above UNDERPOWERED_MDE = 1.0, i.e. a null verdict that could not have detected Sharpe 1) and `barsToDetect1` (the pooled sample that would detect Sharpe ±1.0) from the new pure helper `barsToDetect`; formatReport marks an underpowered power line, and analyze#formatAnalysis states the same run-level verdict. ROUND 25 (dependence-aware inference): the pooled sample of a K-stream walk-forward is a RECTANGULAR fold grid, so the i.i.d. Lo (2002) SE is wrong twice over — the streams are strongly correlated per fold (measured 0.41-0.52 on the attempt-3 power run, where the i.i.d. SE understated the truth ~2x and `underpowered` read false while the honest MDE95 was ≈±1.0 Sharpe) and the fold windows are the sample unit that actually repeats. New: `dependenceSummary` measures the delete-one-cluster jackknife SE of the pooled Sharpe over fold-window clusters (Efron 1979; Cameron & Miller 2015; the delete-block jackknife for stationary series, Künsch 1989; a 2026 CSDID application where it repairs over-rejection with few/unequal clusters, arXiv 2602.12043) and reports designEffect=(seCluster/seIid)^2, effectiveBars=bars/designEffect, and the equicorrelation reading K/(1+(K-1)*rbar) (Kish 1965, as a diagnostic); `powerSummary` rides the honest SE alongside the i.i.d. one (seDependent/mdeSharpeDependent/underpoweredDependent/varianceInflation) rather than replacing it, and `poolFolds`/`backtestMetrics` take `effectiveBars` so PSR/DSR are also reported on the design-effect-adjusted sample (dsrAdjusted/psrAdjusted, null — not 1 — when no design effect was measured); `pairedPromotionTest` builds the paired delete-one-cluster Sharpe-difference t(C-1) and the exact sign test over the same clusters (Demsar 2006; Ledoit & Wolf 2008 for comparing Sharpe ratios); `promoteDecision` gains opt-in requireSharpeDiff / requireBreadth / minDsrAdjusted which are SKIPPED (not failed, and recorded as `skipped-no-panel` in the returned `gate`) when a single-stream report has no panel to estimate them from, so every default decision is bit-identical to round 24b; `restateReportAtCost`/`costLadder` re-score the retained per-fold (returns, signals) at any cost level with the exact scored arithmetic (defaulting `trials` to the report\x27s own deflation count) — the attempt-3 verdict flipped between costBps 0 (keep-off) and 2 (sig:acceleration promotes with zero reasons), so a single scored cost level cannot express it (Binance taker fees 5/10 bps; Frazzini, Israel & Moskowitz 2018 on the cost scale); and `familyCorrelation` reports how correlated the candidates\x27 per-fold excess returns were (mean pairwise r, the strongest pair, an effective trial count) — DIAGNOSTIC ONLY, because substituting an effective number of independent tests for the number of tests actually run does not control the family-wise error rate (arXiv 1612.04535) and correlated tests are still tests that were run (Harvey, Liu & Zhu 2016), so the deflated Sharpe keeps trials=K. Round 26 (R26-3): `confidenceFromProb`/`confidenceToPosition` are the ONE signed-confidence -> position pipeline both candidate families use (the controller via `probToPosition`, which is re-expressed through them and byte-identical on the whole controller domain; the signals via `makeSignalForVariant`), so a turnover/participation comparison is no longer confounded by the mapping; `walkForwardEvaluate` journals the raw pre-policy confidence beside the emitted positions, and `restateReportAtPolicy`/`verifyPolicyRoundTrip` restate/verify a policy sweep offline (pinned: the scored policy reproduces the emitted positions and pooled Sharpe exactly). Round 26 (R26-7): the shipped dependence gate is now magnitude-plus-stability — `requireSharpeDiff` (the paired-Sharpe effect-size floor) together with `requireClusterStability` (the leave-one-cluster-out stability of that same difference) — while `requireBreadth`/`pairedPromotionTest.breadth` is demoted to REPORTED, not shipped, because a breadth count does not by itself bound the family-wise error of the search; `promoteDecision` gains `requireClusterStability`/`minStableFraction` (both default-off, so the classic gate path is bit-identical) and `pairedPromotionTest` returns `stability`.',
    },
    'dependence.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['cameronmiller2015', 'kunsch1989', 'clusterjackknife2602', 'kish1965', 'demsar2006', 'efftests1612', 'harveysliu2016', 'pardo2008walkforward', 'ledoitwolf2008'],
        proves: ['analysis.test.js', 'walkforward.test.js'],
        note: 'Dependence-aware inference for the pooled cross-stream evaluation (round 25) — the pure statistical primitives, importing nothing. Proved (analysis.test.js, section AD): pearsonCorrelation is exact on hand-computed vectors and NaN (never 0) on a zero-variance or short pair; meanPairwiseCorrelation skips uncorrelatable pairs; the equicorrelation design effect is exactly 1+(K-1)*rho and negative rho legitimately SHRINKS it (hedging streams really are worth more than one independent observation); foldWindowClusters tiles a rectangular stream panel into fold-window clusters and THROWS rather than mis-grouping a ragged/misaligned panel; concatClusters drops exactly the requested cluster; the delete-one-cluster jackknife SE is pinned against an independently computed leave-one-out sum; and the calibration that matters is Monte-Carlo checked — for a K-stream panel with equicorrelation rho, the jackknife SE / i.i.d. Lo SE ratio equals sqrt(1+(K-1)rho) at rho = 0, 0.25, 0.5, 0.75 (predicted 1.000/1.658/2.121/2.500), so the estimator recovers exactly the design effect it claims to. pairedClusterTest is a paired delete-one-cluster difference of Sharpe ratios referenced to t(C-1) (Cameron & Miller 2015 §IV; the delete-block jackknife for stationary observations, Künsch 1989; arXiv 2602.12043 for the same remedy with few/unequal clusters) and pairedClusterSignTest is the exact PER-WINDOW binomial sign test (this cluster\x27s statistic vs the baseline\x27s, ties dropped; Demsar 2006) — both exact on a deterministic fixture, both (available:false) rather than throwing when the panels differ. Round 26b fixed a copy-paste defect in pairedClusterSignTest: it had compared `all-but-cluster-c` (the jackknife form that belongs to pairedClusterTest/clusterStability), so it computed a leave-one-out stability test rather than the per-window win-fraction it replaces; the analysis.test.js fixture is now discriminating (4 wins / 1 loss / 1 tie on a panel where the leave-one-out form would read 6/6). studentTPValue is verified against exact table values (t=2.030108 at df=35 is two-sided 0.05; t=2 at df=1 is the Cauchy value 0.295167) and the sign test against exact binomial tails (25/36 -> 0.014408, 36/36 -> 2^-36); a DEGENERATE panel (zero jackknife variance with a non-zero difference) gives t = +-Infinity and p = 0 rather than NaN, so a perfectly dominant candidate is not silently failed. The module deliberately reports an effective number of independent tests as a DIAGNOSTIC only: such methods do not control the family-wise error rate (arXiv 1612.04535), so the family-wise gate keeps the searched K (Harvey, Liu & Zhu 2016). Round 26 (R26-7): clusterStability is the magnitude companion to pairedClusterSignTest — the pooled Sharpe difference recomputed on each leave-one-cluster-out panel must stay positive for (at least) every window (minFraction, default 1), so an edge carried by a single lucky fold is refused while an edge spread across folds passes; it is the promotion-stability reading of the delete-one-cluster series (Pardo 2008; Ledoit & Wolf 2008) built on the same design-effect-honest comparison (Cameron & Miller 2015; Kunsch 1989), and together with the gate magnitude floor it replaces the REPORTED-only breadth statistic.',
    },
    'world.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leakage2605', 'honesteval2608'],
        proves: ['analysis.test.js', 'walkforward.test.js'],
        note: 'The audited evaluation world (round 23, N0). Why it exists: auditNoLookahead can only certify causality for information it can REACH, and the shipped model (HiveMindController) reads the candle series, not the return array, so a returns-only perturbation never touched its input and its audit passed VACUOUSLY (measured: a blatant t+1 leak passed clean 0/30 probes; BUGS.md #22). This module builds the view a candle-driven model actually consumes: shockCandles scales every bar AFTER the probe point by a bounded, deterministic, NON-uniform factor (1 + probe*(1 + sin(frequency*t)), so a shocked path is always positive and cannot explode — the non-uniformity matters because the controller robustly normalises its indicators, so a uniform level shift can be normalised away), and re-derives view.returns from the (possibly shocked) closes so there is never a second, unshocked copy of the future in the state object. Proved (analysis.test.js + walkforward.test.js section K): shockFactor is 1 at and before `after` and strictly inside [1, 1+2*probe] after it; shockCandles is deterministic, never mutates its input, and touches no bar at or before `after`; makeCandleViewFor returns the REAL candles on the base pass (perturb null) and a shocked, self-consistent close/returns/volume/candles tuple on a probe pass; worldFromCandles aligns candles/closes/returns and honours maxBars. The regression guard is the vacuity trap itself: a t+1 candle leak is invisible without viewFor and caught WITH it, an honest causal candle signal stays clean, and a viewFor that ignores the perturbation is flagged vacuous (clean:false, vacuous:true) so a green audit can never again be bought with an unreachable input.',
    },
    'features.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml', 'finval2609'],
        proves: ['analysis.test.js'],
        note: 'The causal signal family (round 23, N1) — what the A/B compares against the baseline, and what the mechanism flags are actually for. Eight pure point-in-time features are each reduced to a position by the SAME recipe: raw feature -> causal z-score over the trailing zWindow (mean/std computed ONLY from observations <= t, minObs fallback to 0) -> clampPosition to the saturation bound, so every candidate abstains (0) rather than throwing on a missing series or a degenerate window. The eight: momentum (trailing 16-bar return), frac-momentum (one-bar change of the d=0.4 fractionally-differenced log price, AFML ch. 5 — stationary but memory-preserving, the P3-1 claim that was never implemented), vol-regime (8-bar realised vol / 32-bar - 1), momentum agreement (sign consensus across 4/8/16/32 lenses), range location (close within the trailing 32-bar high/low range), volume imbalance (short/long volume share - 1), autocorr1 (lag-1 autocorrelation of returns), acceleration (change in momentum). Proved (analysis.test.js): each feature has an exact hand-computed reference vector; f(series, t) is invariant to every value after t (causality, by construction and by test); causalZScore is 0 below minObs and on a zero-variance window, and its output is the exact (raw - mean)/stdSample of the trailing window; clampPosition is bounded, odd and sign-preserving; SIGNAL_CANDIDATES ids are unique and each signal(view, test) returns exactly |test| finite positions in [-1, 1], abstaining on a returns-only or empty view. Famously, none of these is a guarantee of edge: they are candidates on the SAME family-wise gate as the mechanism flags, so the multiple-testing correction covers the whole searched universe (K >= 15).',
    },
    'overfitting.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['bailey2016pbo', 'leprado2018afml'],
        proves: ['analysis.test.js'],
        note: 'Probability of Backtest Overfitting via Combinatorially Symmetric Cross-Validation (Bailey et al. 2016; AFML ch. 12) — the non-parametric counterpart of the deflated Sharpe. Proved: cscvBlocks partitions exactly (remainder on the first blocks); cscvSplit yields the C(S,S/2) symmetric splits, each a disjoint cover of the timeline, with each block in exactly C(S-1,S/2-1) in-sample sets and the set closed under complement; relativeRank maps rank to omega=rank/(N+1) in (0,1) with average ranks for ties (best=3/4, worst=1/4, full tie=1/2); oosOnIsRegression is exact. Calibration: on 20 iid-noise strategies (T=500, S=10, 252 splits) PBO = 0.464 (~1/2) with a ~0 degradation slope; a genuine persistent edge drives PBO to 0 with a positive OOS-on-IS slope; a planted regime flip drives PBO to 1; and an all-flat matrix gives PBO=1 under the documented tie convention. Invalid inputs (too few strategies, ragged matrix, odd blocks, too few bars) all throw, and cscvSplit rejects an astronomical C(S,S/2) above the split cap (BUGS.md #13).',
    },
    'streams.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['grinold1989', 'kish1965', 'harveysliu2016'],
        proves: ['analysis.test.js'],
        note: 'Effective independence of the stream basket (round 26, R26-6): Grinold (1989) is the finance statement of the fix — the information ratio scales with sqrt(breadth), and breadth is the number of INDEPENDENT forecasts, not the number of bars — and Kish (1965) converts a raw count into an effective one (designEffect = 1+(K-1)*rbar; effectiveStreams = K/DE; effectiveBars = K*T/DE). Why it exists: the power run pools 8 crypto majors that move together, so the effective sample is smaller than the bar count; a second bar interval is a genuinely different horizon (not a copy) and a redundant stream is pure cost under the measured cost law (time ~= pooledBars x folds-per-stream). Proved (analysis.test.js section AF/AG): resampleCandles aggregates exact OHLCV (open first, close last, high max, low min, volume sum, timestamp first), is a shallow copy at factor 1, drops a trailing partial group unless asked to keep it, never mutates its input, and rejects a non-positive/non-integer factor; designEffectOfStreams reports K=1 as the trivial panel (DE=1), two identical streams as one bet (rbar=1, DE=2, effectiveStreams=1), the exact 1+(K-1)*rbar law for K=3, and flags a perfectly hedging pair (DE<=0) and a <3-bar common window as unavailable; selectStreams keeps the diversifying stream over a redundant copy, stops after one stream on a fully redundant pool, honours maxStreams, and is deterministic (ties by label). Diagnostic/design only — no scored number changes (the deflated Sharpe keeps trials=K; Harvey, Liu & Zhu 2016).',
    },
    'replication.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['bouthillier2019', 'henderson2018', 'agarwal2021', 'glasserman1992'],
        proves: ['analysis.test.js'],
        note: 'Seed replication, common random numbers and the honest summary of a noisy per-run metric (round 26, R26-13). Why it exists: a single-seed ordering is not a ranking — seed-to-seed variation routinely exceeds the variation attributed to the compared factor, and seed choice alone can change the measured ordering (Bouthillier et al. 2019; Henderson et al. 2018). The fix has three parts: a robust LEVEL (the interquartile mean, which discards the best and worst quarters — the summary Agarwal et al. 2021 recommend for noisy per-run metrics), a stratified bootstrap CI that resamples WITHIN each seed stratum (so the interval reflects both seed and fold spread), and a variance decomposition stating what fraction of the spread is seed noise rather than fold noise. pairedVarianceRatio is the CRN criterion: with common random numbers the variance of the paired DIFFERENCE between two variants should fall below the unpaired one (Glasserman & Yao 1992), and the difference is exactly what a promotion decision consumes. All pure + seeded (reproducible). Proved (analysis.test.js section AH): interquartileMean drops the best/worst quarter exactly (nine sorted values -> the middle five) and falls back to the mean below four values, ignoring non-finite ones; the stratified bootstrap is deterministic for a fixed seed, ordered, and resamples WITHIN strata (two constant unequal strata give a zero-width CI at the pooled mean, which pooling would not); varianceComponents is hand-computed exact on four crafted panels (pure between-seed -> seedFraction 1; pure within-seed -> foldFraction 1; mixed -> 0.2/0.8; repeated cell -> residualFraction 1) with the fractions summing to 1, and unavailable below two observations; seedDistribution reports the exact flat mean/IQM, the CI and the component split, and unavailable with no finite values; pairedVarianceRatio shows a variance reduction for tightly paired differences and reports unavailable on too-few or zero-variance samples; formatSeedReplication names the variant, level and interval, and states unavailability instead of rendering NaN. Default-on in analyze (variant-independent fold seed = seed + testStart*977) so the A/B comparison is paired; --crn=0 restores the historical per-variant seed for reproducing old runs.',
    },
    'forecast.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['brier1950', 'murphy1973', 'gneitingraftery2007', 'diebold1995', 'hansenlundenason2011'],
        proves: ['analysis.test.js'],
        note: 'Forecast comparison — the family scored as *forecasters*, not only as PnL streams (round 26, R26-14). Why it exists: "best family" is a predictive-accuracy question, and a proper score cannot be earned by hedging toward the base rate (Gneiting & Raftery 2007). The pieces are classical: the Brier score + its Murphy (1973) reliability/resolution/uncertainty partition and the log score per variant; the Diebold–Mariano (1995) test on the paired per-bar Brier-loss differentials (candidate vs baseline), block-bootstrapped so serial dependence does not inflate it; and the Hansen, Lunde & Nason (2011) Model Confidence Set — the SET of families that cannot be distinguished from the best at 90/95% confidence, rather than the sample-best (the selection bias the project exists to avoid). Pure + seeded (deterministic for a fixed seed). Proved (analysis.test.js section AI): forecastPairs maps confidence -> probability and next-bar sign and drops each fold last bar; brierScore/logScore/brierLosses exact hand-computed values (logScore clips instead of returning Infinity); brierDecomposition reproduces REL/RES/UNC and the exact identity BS_binned = REL - RES + UNC on two crafted cases (one point per bin, and both points in one bin); bootstrapMeans is deterministic and reports its block length; the DM test rejects a constant positive differential with p=0 and no-rejects a zero one, is deterministic with a finite SE, and reports unavailable on too few pairs; the MCS eliminates a uniformly worse model and keeps the indistinguishable pair, is deterministic, and a higher confidence level yields a superset (membership monotone); forecastComparison scores every variant, names the MCS members, keeps a perfect forecaster with a lower Brier/log score, and refuses a mismatched window rather than comparing unpaired. On by default in analyze (--forecast=0 disables) and pure post-processing of the journaled confidence, so it moves no scored number.',
    },
    'decision.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml', 'pardo2008walkforward', 'bouthillier2019', 'henderson2018', 'agarwal2021', 'alphadecay2502', 'gneitingraftery2007'],
        proves: ['analysis.test.js', 'analyze.test.js'],
        note: 'The decision-grade report (round 26, R26-8) — the composition half of the honest-evaluation battery. It computes NO new strategy statistic: foldConcentration restates the scored folds (top-K share of gross PnL, signed fold sums, the pooled Sharpe on each leave-one-fold-out panel, and each fold marginal contribution to that pooled Sharpe, rebuilt from the retained foldInputs with the same strategyReturns arithmetic the scored pass used); confidencePersistence measures the lag-1 autocorrelation of the journaled raw pre-policy confidence within folds and its exponential half-life (the alpha-decay ranking input, arXiv 2502.04284); nextRunPlan converts the finished run into sizing knobs (effective bars + MDE i.i.d. and dependence-corrected, the bars a detection of Sharpe 1 / of the observed Sharpe would need at the measured design effect, the turnover break-even against 0/2/5/10 bps, the observed per-fold wall time, and the single cheapest lever that would flip the verdict); decisionReport composes the six questions (training / edge / concentration / economics / family / nextRun) so every field is a value or an explicit {available:false, reason}; formatDecision renders the summary lines. Grounded in the same experimental-design references as the replication layer (Bouthillier et al. 2019; Henderson et al. 2018; Agarwal et al. 2021) and Pardo (2008) for stability as a promotion criterion. Proved (analysis.test.js section AK): foldConcentration exact on a hand-built fold grid (top-K shares sum to the gross, positive+negative = total, the leave-one-out range and marginal values match an independently recomputed leave-one-out Sharpe sweep, and the missing-foldInputs path is an explicit unavailable); confidencePersistence exact on the alternating (-1) and monotone (+1) series and on [0,0,1,1,1] (lag1 = 1/sqrt(3), halfLife = 2 ln2 / ln3); nextRunPlan exact on a frozen power/dependence fixture (barsToDetectDependent, the clearsBps booleans, the magnitude cheapest-flip factor — whose fixture now carries the REAL pairedClusterTest block, since a bare-number fixture hid a round-26b fix: the branch read `sharpeDifference` as a scalar when a real report carries a `.value`-bearing object — and the paired-units sizing `pairedUnitsNeeded`) and its cost/promoted branches, plus the stability, gate and search flip branches; decisionReport returns all six question blocks with availability flags and never a bare null (its `training.labelDistribution` is derived from the model diagnostics, not the unproduced `model.labelDistribution` field — `BUGS.md` #40; its `family` seed fields read a `replication` shape the only producer (`replicateAnalysis`, keyed `byVariant`) never emits, so their reasons now point at `replication.json` — `BUGS.md` #41); formatDecision names the verdict. On by default in analyze (--decision=0 disables) and pure post-processing, so it moves no scored number.',
    },
    'race.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['jamieson2016sha', 'li2018hyperband', 'bouthillier2019'],
        proves: ['analysis.test.js'],
        note: 'Successive-halving / Hyperband racing for the family search (round 26, R26-15) — the ENGINE only, and the shipped analyze driver deliberately has NO --race flag yet, because R26-15 is GATED on an economics win (R26-5) or a diversity win (R26-6) and RUN-ANALYSIS.md section 7 measured neither. Why it exists now despite the closed gate: the cost of the family search is the number of arms (variants x seeds x policy configs), not a fold, so the engine and its full-grid validation are built so the gate can be revisited cheaply and the correctness requirement (a racing budget must not change the DECIDED set) is a test rather than a promise. halvingRounds/halvingSchedule are exact reference vectors; successiveHalving is evaluator-agnostic (sync or async evaluate(arm, budget)) and deterministic (a non-finite evaluation is eliminated, never silently ranked), returns the full per-rung scored table, and reports both the evaluation count and the budget-weighted cost (spentBudget vs gridBudget). Grounding: Jamieson & Talwalkar 2016 (arXiv 1502.07943); Li et al. 2018 (arXiv 1603.06560). Proved (analysis.test.js section AM): the exact schedule for eta=3, the winner on a deterministic noisy-evaluator fixture, the full-grid oracle agreement, the budget-saving identity spentBudget < gridBudget, a minimize variant, the unavailable guards, and formatRace.',
    },
    'holding.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['constantinides1986', 'davisnorman1990', 'garleanu2013', 'notrade2101', 'alphadecay2502', 'turnoverreg2509', 'deepmomentum1904', 'frazzini2018costs', 'binancefees'],
        proves: ['analysis.test.js'],
        note: 'The turnover attack as pure post-processing (round 26, R26-5): restate the journaled pre-policy confidence under a dead-zone x entry/exit-hysteresis x minimum-holding grid and report which policy clears a realistic taker cost. Why it exists: the family-wise ceiling is ECONOMIC — the signals\' gross edge per unit of turnover is 0.09-3.47 bps against a 5-10 bps taker round-trip (Frazzini et al. 2018; the Binance fee schedule) — so the decision is not whether a signal predicts but whether its prediction can be held long enough to pay for its trading. The optimal form is classical: a proportional cost makes a no-trade region optimal (Constantinides 1986), characterised by an impulse/continuity structure (Davis & Norman 1990) and given its modern dynamic form by Garleanu & Pedersen (2013); with alpha decay the optimal policy uses PAST signal values (arXiv 2502.04284), which is exactly the enter/exit hysteresis rule. Proved (analysis.test.js section AF): positionSeriesFromConfidence is BYTE-IDENTICAL to confidences.map(confidenceToPosition) when no holding rule is set (so the R26-3 round-trip certificate and every default path are unchanged); it holds a position through the whole no-trade band (enter |c|>=0.3, exit |c|<=0.1 => positions [1,1,1,1,1,-1,0] on the fixture) and only flips on a decisive opposite signal; a minimum holding period suppresses both the exit and the flip until it elapses ([0.5,-0.4,0,0,0,0] with minHold 3 => [1,1,1,0,0,0]); DEFAULT_TURNOVER_GRID is a frozen non-empty cross product including a no-hold policy; turnoverSweep is available on a report with fold inputs, enumerates the full grid (8x1x6), sorts rows by break-even cost descending, prefers a promoting row in bestTurnoverPolicy, and reports available:false (never a throw) when the baseline has no fold inputs — a wide dead zone abstains at least as much as a narrow one. Pure: no I/O, no RNG; it cannot move a scored number.',
    },
    'reality_check.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['white2000rc', 'hansen2005spa', 'romano2005stepm', 'romano2007generalized', 'delattre2014fdp', 'politis1994', 'politis2004blocklength', 'patton2009correction', 'politisromano1994subsampling', 'politisromano1999book', 'leprado2018afml'],
        proves: ['analysis.test.js'],
        note: "White's Reality Check and Hansen's Superior Predictive Ability test — the bootstrap multiple-testing corrections that answer 'is the best of K candidates actually > benchmark?', complementary to DSR (parametric single-statistic) and PBO (rank-based selection bias). RC/SPA resample the SAME stationary-bootstrap timeline for every candidate, preserving cross-sectional dependence. Proved: benchmarkSeries handles a scalar/series/null benchmark and subtracts it elementwise (means [0,3] for benchmark 2); RC statistic is exactly sqrt(T)*max_k mean(f_k) (2 for 0.2 over T=100), selects the right best index, is exactly 0 when every candidate equals the benchmark, and shifts by -sqrt(T)*b for a constant benchmark b; the shared stationaryBlockIndices has length T, in-range indices, is deterministic given its rng stream, and at blockLength=1 is EXACTLY i.i.d. sampling with replacement (matched against a hand-drawn draw sequence); the default blockLength is floor(T^(1/3)). SPA studentizes each candidate by its bootstrap standard error (capturing serial dependence), so its statistic is exactly max(0, mean_k/SE_k); a zero-variance positive candidate yields an infinite t-stat with p=0, and SPA bootStats respect the max-with-0 convention while RC bootStats may be negative. Flagship (Hansen's conservativeness result): on a design with one genuine edge and nine poor, high-variance candidates SPA's p is 0.078 while RC's is 0.762 (rc>0.3 and spa<rc), both reject a strong persistent edge at p<0.02, and under a pure iid-noise null (150 replications, K=5, T=100, nBoot=199) both keep their size at ~5% (SPA 0.06, RC 0.04) with mean p-values ~0.47/~0.48, i.e. approximately Uniform. Invalid matrices, benchmarks, blockLength/n and nBoot all throw. Section V extends this with Hansen's *consistent* recentring (A_k = omega_k*sqrt(2 log log T), exact bound pinned) and the Romano-Wolf step-down max-t: a candidate more than A_k below the benchmark is recentred to zero, so on the flagship design consistent SPA p is 0.058 vs upper 0.078 vs RC 0.762; when every candidate is valid the consistent test is bit-identical to the upper one. StepM reuses the same bootstrap to name WHICH candidates win, with the first step provably equal to the single-step consistent SPA p-value, monotone step p-values, a degenerate guard (a candidate exactly at the benchmark is never rejected), and the exact structural identity 'a family is rejected iff its first step is'. Measured FWER at 5% over 200 reps: 0.075 with the default block bootstrap (the documented finite-sample price of block resampling on i.i.d. noise) and 0.065 with blockLength=1; power on a planted edge 0.89 with 0.94 mean rejections. Section W adds the Politis-White automatic block length: politisWhiteBlockLength reproduces the reference implementation arch.bootstrap.optimal_block_length (validated against Patton's MATLAB code) to floating-point precision on the paper's own AR(1) benchmark (phi=0.3, T=10000, RandomState(0)) — stationary 13.635665130318229, circular 15.608940081363109, m=6 — with the NumPy MT19937 stream itself pinned inside the test (rand()=0.5488135039273248, standard_normal()=1.764052345967664), and the PPPW2009 correction is what makes m=2*max(m_hat,1); autoBlockLength pools the per-candidate selectors (mean by default; max is deliberately NOT the default because the selector is right-skewed in small samples) and floors at 1, so on i.i.d. data the pooled estimate is ~1.0 (correctly detecting no dependence) while on AR(1) phi=0.8 at T=120 it averages ~8.8. Measured 5% sizes (hansenSpaConsistent, K=5/T=100, 150 reps, nBoot=99): i.i.d. 0.0867 with the fixed floor(T^(1/3)) rule vs 0.0467 with blockLength=auto — the automatic rule removes the documented finite-sample liberality of the fixed rule; AR(1) phi=0.8: 0.44 (fixed), 0.4133 (auto), 0.4267 (b=15) and 0.74 (b=1), i.e. auto is never worse and the long block length is load-bearing. KNOWN LIMITATION (measured in Section W, FIXED in Section X): the stationary bootstrap's variance of the mean is downward-biased under strong persistence — at phi=0.8, T=120 the ratio bootstrapSE/trueSE is 0.32 (b=1), 0.61 (b=4), 0.69 (b=9), 0.71 (b=15), 0.69 (b=25) — so block-bootstrap SPA/StepM over-reject (size 0.41-0.55) no matter the block length (effective sample size only T(1-phi)/(1+phi)=13). Section X fixes it with variance-consistent subsampling: neweyWestSE is the exact Bartlett standard error (m=0 is the i.i.d. s.e., m=1/2 pinned); subsamplingSpa builds the reference from every overlapping window (nWindows=T-b+1, default b=round(T/3), ONE bandwidth m=round(b/6) shared by the window and full scales, shrink=sqrt(1-b/T) exactly), is deterministic (no rng), and its statistic is max(0, max_k fbar_k/se_k); because the reference scale is the data's own the 5% size is nominal at EVERY persistence — T=100/K=5/300 reps: 0.0533 (iid), 0.0533 (phi=0.2), 0.0567 (phi=0.5), 0.0433 (phi=0.8), versus the block bootstrap's 0.20 and 0.4067 at phi=0.5/0.8 (~9x distortion cut, gap >= 0.30); T=120 phi=0.8: 0.0567 vs 0.3867; power at phi=0 is 0.7167 (T=100) / 0.80 (T=120), and phi=0.8 still rejects above its size. subsamplingStepM is the Romano-Wolf step-down on the same windows: its first step IS the single-step consistent subsampling SPA p-value (0.6667 pinned), step p-values are monotone, it always uses Hansen's consistent recentring, never rejects a candidate exactly at the benchmark (omega=0, t=0 guard), keeps FWER 0.0533 at phi=0.8 (family-rejected-iff-first-step-rejected on all 300 reps) and keeps power 0.72 with <1.3 mean rejections. Round 8: both subsampling functions take an optional `groups` = contiguous segment lengths tiling T; every window and the full-scale long-run variance are then computed WITHIN a segment (a single group reduces exactly to the whole-sample estimator, so all pinned section-X values are unchanged), with the default window = half the shortest segment; grounded in the mean-shift LRV bias result (arXiv 2603.17226) and used to keep walk-forward resampling inside a fold. Round 9: the same window law now supports the two standard generalisations of the FWER. subsamplingKfwer is the SINGLE-STEP k-FWER (Romano & Wolf 2007, arXiv 0710.2258): reject candidate i iff its k-th largest FULL-family window statistic tail probability is <= alpha, so P(k or more false rejections) <= alpha. Its k=1 p-value is EXACTLY the max-t step-down first p-value (=== the single-step consistent SPA p, pinned), its p-values are exact window counts, k>K clamps to K (where the reference is the window minimum), p-values are non-increasing and the rejection set non-decreasing in k, and the measured 2-FWER under the global null (K=4, 200 reps) is 0.075 at T=200 / 0.055 at T=80 against a nominal 0.05. subsamplingFdp is the Romano-Wolf / Delattre-Roquain FDP step-down heuristic (arXiv 1311.4030) - EXPERIMENTAL, because the heuristic is not rigorously FDP-controlling in finite samples: it steps candidates down in t order applying the k-FWER reference with the GROWING k_l = floor(fdpTarget*l)+1, reports FDP <= (k_l-1)/R, matches an independent mirror of the rule exactly, is a prefix (a step-down, never a step-up), and rejects nothing on the global null in ~95% of reps (pinned 0.07/0.04). A rejected design is documented in the module: the natural 'k-th largest of the SURVIVOR set' generalisation is INVALID (measured 2-FWER 0.085 at T=80 and 0.145 at T=200, worsening with data), so subsamplingStepM stays max-t (k=1) only. familywiseSearch/walkForwardSearch gain opt-in `kfwer`/`fdpTarget`, both default-off so every Round-8 result is byte-identical. Round 10: the mixture-family validation (analysis.test.js section AA, 11 checks) proves the power/FDP trade-off on planted mixtures on the same window grid — k=2 k-FWER is strictly more powerful than k=1 (0.155 -> 0.4975) while FWER/2-FWER stay <= alpha, and the FDP step-down rejects monotonically more as the target loosens on a 20-candidate/10-edge family (6.833 < 9.05 < 9.783; kHat 1.2/2.6/3.7), beating the strict max-t step-down (9.783 vs 7.0) with realised FDP below target (0.0098/0.0257/0.0528) — but over-running a tight target on a sparse family (0.1014 > 0.10, est 0), the measured finite-sample non-control (Delattre & Roquain 2014; arXiv 1901.04885) that keeps subsamplingFdp EXPERIMENTAL. Round 12: analysis.test.js section AB (8 checks) hardens the degenerate families for subsamplingKfwer/subsamplingFdp — a single-candidate matrix throws (K >= 2), an all-zero family rejects nothing (t=0 guard), tied candidates share a statistic/p-value/decision, a series benchmark zeroes the equal candidate, groups=[T] is bit-identical to ungrouped, a tiny target keeps kHat=1, a near-zero alpha never rejects more, and missing/empty/too-short matrices throw.",
    },
});

// ---------------------------------------------------------------------------
// Support modules (`src/*.js`) — pure helpers that the locked paths import.
//
// Unlike the analysis supercharges these ARE on the hot path (the controller
// imports `price_precision.js`), so they are not "additive". They are still pure
// functions with exact reference vectors, which is what lets them be
// LOCKED-invariant: their behaviour is pinned by their own entry, and the golden
// fingerprints prove the hot-path integration is unchanged.
//
// `evolve.js` is the additive exception: a pure research module that nothing
// imports yet (the low-rank-ES prerequisite from docs/TODO.md item 3), so it is
// pinned by its own entry alone. `multiprobe.js` is now imported by the locked
// lsh bag behind the default-off `_multiProbeConfig`, so it is pinned by its own
// entry *and* by the golden no-op (like surprise.js / sample_weights.js).
// ---------------------------------------------------------------------------

export const SUPPORT_MODULES = Object.freeze({
    'price_precision.js': [
        'priceDecimals', 'priceGrid', 'MIN_PRICE_DECIMALS', 'MAX_PRICE_DECIMALS', 'DEFAULT_MIN_MOVEMENT',
    ],
    'surprise.js': [
        'DEFAULT_SURPRISE_CONFIG', 'clamp01', 'surpriseFromSimilarity', 'surpriseGate',
        'surpriseGateFromSimilarity', 'updateSurpriseMomentum', 'smoothedSurprise',
    ],
    'sample_weights.js': [
        'DEFAULT_WEIGHT_CONFIG', 'overlapUniqueness', 'clampWeights', 'normalizeWeights',
        'weightEffectiveSampleSize', 'weightedMean', 'sampleWeights', 'spanWeightsFromEntries',
    ],
    'homeostasis.js': [
        'DEFAULT_HOMEOSTASIS_CONFIG', 'resolveHomeostasisConfig', 'isStableConfig',
        'homeostaticScale', 'homeostaticLearningRates', 'updateActivity', 'rootMeanSquare',
        'deviationEnergy',
    ],
    'evolve.js': [
        'DEFAULT_ES_CONFIG', 'resolveESConfig', 'createRng', 'randomNormal', 'randomVector',
        'orthonormalBasis', 'projectCoeffs', 'empiricalSecondMoment', 'esGradientEstimate',
        'backtrackingLineSearch', 'lowRankESStep', 'runEvolution',
    ],
    'multiprobe.js': [
        'DEFAULT_MULTIPROBE_CONFIG', 'resolveMultiProbeConfig', 'marginOrder', 'marginRanks',
        'perturbationCost', 'rankPerturbations', 'applyFlips', 'multiProbeKeys',
        'marginSingleBitKeys', 'prefixSingleBitKeys', 'flippedBits', 'marginCoverBudget',
        'DEFAULT_ADAPTIVE_CONFIG', 'resolveAdaptiveConfig', 'adaptiveMultiProbeConfig',
        'resolveEffectiveProbeConfig', 'adaptiveSingleBitBudget', 'adaptiveSingleBitKeys',
    ],
    'binarypc.js': [
        'DEFAULT_BINARYPC_CONFIG', 'resolveBinaryPCConfig', 'createRng', 'randomNormal', 'randomVector',
        'meanVector', 'centerRows', 'covarianceMatrix', 'matVec', 'dot', 'norm', 'powerIteration',
        'principalComponents', 'explainedVariance', 'randomOrthonormalBasis', 'pcaHashTables',
        'alignedHashTables', 'randomHashTables', 'binaryCode', 'quantizationError',
    ],
    'bitweight.js': [
        'DEFAULT_BITWEIGHT_CONFIG', 'resolveBitWeightConfig', 'binaryEntropy', 'erf', 'normalCdf',
        'flipProbability', 'reliabilityWeight', 'bitInformation', 'flipProbabilityFromMargin',
        'estimateNoiseVariance', 'selectReliableRank', 'reliabilityWeights', 'weightedHamming',
        'weightedKeyDistance', 'unpackWord',
        'bitFlipProbabilities', 'poissonBinomialPmf', 'poissonBinomialQuantile', 'expectedFlippedBits',
        'marginContainmentCoverage', 'marginContainmentDepth', 'probeRecoveryCoverage', 'recoveryDepth',
        'calibrateNoiseFromFlips',
    ],
    'querymod.js': [
        'DEFAULT_QUERYMOD_CONFIG', 'resolveQueryModConfig', 'dot', 'norm', 'cosine', 'normalize',
        'meanVector', 'normalizedCentroid', 'dotProductSum', 'collisionProbabilityFromCos',
        'collisionProbability', 'averageCollisionProbability', 'firstOrderCollisionProbability',
        'averageCovariance', 'signBit', 'hashBits', 'collidesWithSet', 'centroidCollidesWithSet',
        'collisionCoverage', 'selectCandidates', 'blendVectors', 'modifiedQuery', 'queryModificationGain',
    ],
    'consolidation_logic.js': [
        'computeGaussianDistance', 'computeContentHash', 'decayAndSortMemories',
        'mergeMemories', 'collectPromotions', 'buildHierarchy',
    ],
    'candle_quality.js': [
        'DEFAULT_MAX_WICK_FRACTION', 'isImplausibleCandle', 'repairCandle',
        'repairSeries', 'findImplausibleWicks', 'stripRepairFlags',
    ],
    'sanitize.js': [
        'finiteOr', 'finiteOrNull', 'safeParseJSON', 'sanitizeSignal', 'sanitizeConsensus',
        'resolveFailureBudget', 'failureBudgetExceeded', 'describeFailure',
        'stableHash', 'configFingerprint', 'STRUCTURE_CONFIG_KEYS', 'assertControllerArgs',
    ],
    'rng.js': [
        'mulberry32', 'hashString', 'deriveSeed', 'installSeededRandom',
    ],
    'legion_metrics.js': [
        'mean', 'stdev', 'clamp01', 'brierScore', 'baseRate', 'reliabilityCurve',
        'brierDecomposition', 'shannonEntropy', 'hhi', 'effectiveVoters', 'gini',
        'ewmaSeries', 'cusum', 'cohensKappa', 'meanPairwiseKappa', 'influenceSummary',
        'consensusProbability',
    ],
    'alerts.js': [
        'SEVERITIES', 'DEFAULT_ALERT_RULES', 'compare', 'evaluateAlerts', 'highestSeverity',
    ],
    'analyze.js': [
        'FEATURE_LEN', 'VARIANTS', 'SIGNAL_VARIANTS', 'ALL_VARIANTS', 'resolveVariant', 'applyVariant',
        'featureVector', 'makeHiveMindModelFactory', 'makeControllerModelFactory', 'withSeed',
        'makeSignalForVariant', 'evaluateAB', 'formatAnalysis', 'readCloses', 'readCandles',
        'CONTROLLER_POSITION_POLICY', 'CONTROLLER_MODEL', 'runAnalysis',
        'auditVerdict', 'probesPerFold', 'auditBlock', 'ANALYZE_USAGE',
    ],
});

export const SUPPORT_REGISTRY = Object.freeze({
    'price_precision.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['binanceTick', 'leprado2018afml'],
        proves: ['price_precision.test.js', 'multisymbol.test.js'],
        note: 'Target-price decimal grid. Proved: exact vectors (DOGE $0.001329 -> 7 dp, ADA $0.02 -> 6, XRP $0.12 -> 5, BTC $3946 -> 2), prices >= $40 keep the historical 2 dp (so the golden fingerprints are unchanged), and rounding a target by the minimum movement can never cross the entry price (direction preservation). Grounds the fix for the sub-cent direction-inversion bug.',
    },
    'surprise.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'memory',
        citations: ['behrouz2025titans'],
        proves: ['surprise.test.js', 'golden.test.js'],
        note: 'Surprise-gated semantic memory writes (Titans, arXiv 2501.00663): the write strength of a candidate prototype is surface-of-(1 - bestSim) against the existing bank, not a constant. Proved: gate endpoints (0 -> floor, 1 -> 1), bounded [floor, 1] and monotone in surprise, floor=1 collapses the gate to exactly 1 (so it is a bit-exact no-op, confirmed by fingerprinting two identically-seeded banks), a novel candidate is written at nearly full strength while a predictable one is attenuated toward the floor, and the measured gated/ungated write-size ratio equals surpriseGate(1 - measuredSimilarity) exactly. Off by default (`_surpriseGateEnabled = false`), so the hot-path golden fingerprints are unchanged.',
    },
    'sample_weights.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml'],
        proves: ['sample_weights.test.js', 'golden.test.js'],
        note: 'Sample-uniqueness loss weighting (Lopez de Prado, AFML ch. 4). Proved: exact average uniqueness on fixed label intervals (and bit-for-bit agreement with `analysis/uniqueness.js` `sampleUniqueness` on shared fixtures), mean-1 normalisation has mean exactly 1 and sum exactly n, `sum1` sums to exactly 1, clamps are exact, and `weightEffectiveSampleSize` of uniform weights is exactly n (2/3,2/3 -> exactly 2). Integration: `train(inputs, target, w)` scales the whole accumulated gradient by exactly w (linearity check on `_gradientAccumulation` against the weight-1 run), while `w = 1` and a non-finite `w` are bit-exact no-ops (fingerprint-equal trajectories) so the golden fingerprints are unchanged. Off by default (`_sampleWeightConfig = null`).',
    },
    'homeostasis.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'ensemble',
        citations: ['homeostatic2609'],
        proves: ['homeostasis.test.js', 'golden.test.js'],
        note: 'Homeostatic plasticity for per-member learning rates (Turrigiano synaptic scaling; the output-anomaly controller of arXiv 2609.13771). Proved: the multiplier is bounded [minScale,maxScale], monotone non-increasing in activity, and exactly 1 at the set-point (so target activity is a true fixed point, not an approximation); non-finite activity falls back to the set-point; the EMA activity signal is an exact EMA of |value|; isStableConfig matches the proven contraction condition 0 < gain*target < 2. Closed-loop: on the toy system activity = k*lr, lr <- lr*scale(k*lr) converges to target/k for a k-sweep with the set-point error decreasing every step, and different initial rates reach the same set-point. Integration: enabled-with-gain-0 is bit-exact against the disabled path (fingerprint-equal trajectories), which is why the default-off feature cannot move a golden fingerprint; a non-trivial gain changes the trajectory, so the feature is live. Off by default (`_homeostasisEnabled = false`).',
    },
    'evolve.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'ensemble',
        citations: ['eggroll2609', 'salimans2017es'],
        proves: ['evolve.test.js'],
        note: 'Low-rank evolution strategies (EGGROLL arXiv 2609.10980; antithetic estimator arXiv 1703.03864). Additive: nothing imports it yet. Proved: for a quadratic f = 1/2 th^T H th the antithetic estimate is EXACTLY g = S*H*th with S = (1/P) sum eps eps^T (checked to 1e-9 against an independently computed S); S is symmetric PSD so g.th_grad = (H th)^T S (H th) >= 0, i.e. the estimate is always a descent direction; full-rank large-population estimates align with the true gradient (cos > 0.99); low-rank estimates lie exactly in their subspace and are unbiased (Monte Carlo) for the projected gradient. Closed loop: backtracking line search turns descent into strict monotone fitness decrease on a toy convex quadratic over 300 (full-rank) / 400 (rank-3) generations to the optimum, and the optimum is a no-op. Deterministic under an explicit seed.',
    },
    'multiprobe.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'lsh',
        citations: ['lv2017multiprobe', 'charikar2002', 'adaptivebuckets2604', 'neuroute2608', 'queryadaptive1904'],
        proves: ['multiprobe.test.js', 'golden.test.js'],
        note: 'Margin-ordered multi-probe LSH (Lv et al., VLDB 2007). Proved: marginOrder is a total ascending permutation of the hash bits by |query . hyperplane| and rankPerturbations emits distinct non-empty perturbations of <= maxFlips bits, each costed at exactly the sum of its flipped margins and sorted by (cost, flips, margin-rank). The flip lemma is exact: for a neighbour q+delta, bit b flips iff |delta_b| > |q_b| and the perturbation opposes the query side, so every flipped bit has margin below the perturbation magnitude and the lowest-margin cover is complete (zero violations over 300 trials). Empirically P(flip) decreases monotonically with margin (0.48 -> 0.04 across octiles), margin probing dominates the historical prefix baseline at every budget and beats every sampled random order, its recall is monotone in the budget, and all-pairs/single-bit probing are complete exactly on <=2-bit / <=1-bit neighbours. Integration (default-off): `_getGlobalLSHCandidates` probes in margin order only when `_multiProbeConfig` is set, and the disabled branch is byte-identical to the original prefix loop, so all 11 golden fingerprints are unchanged (golden.test.js). Enabled on a realistic 107-bit bank it lifts lean-helper self-recall under noise from 0.167 to 0.517 at sigma=0.25 (and 0.033 to 0.30 measured at the raw probe level), i.e. ~3x, at the same probe budget. ROUND 16 adds a query-adaptive budget (NeuRoute arXiv 2608.15438; adaptive bucket probing arXiv 2604.04603; query-adaptive hash ranking arXiv 1904.08623): `adaptiveMultiProbeConfig` is OFF by default and byte-identical to the fixed config when off, and when on reads the budget off the query margins — `maxFlips` is the Poisson-binomial quantile of the flip count and `depth` is the smallest number of smallest-margin bits whose EXHAUSTIVE subset enumeration reaches the requested recovery coverage (`probeRecoveryCoverage`, memory/bitweight.js), with the depth capped so the subset count fits `budgetCap`. Proved (multiprobe.test.js section G, 77 checks): the config clamps, is idempotent (recomputing from its own output is identical — this caught a real round-trip bug where the caps were dropped), the off-path is byte-identical, the depth reaches the target coverage exactly (or saturates at the cap), `budget` is exactly the number of subsets of the top-`depth` bits (size <= maxFlips), the enumeration is exhaustive (every such subset present exactly once), the probe set is a superset for a confident query (depth 0 -> just the exact key) and grows for an ambiguous one, and the noiseless limit collapses it to the exact key. Monte Carlo confirms the probe set recovers the neighbour at the EXACT predicted coverage. On a real 107-bit index with sigma CALIBRATED from the measured Hamming distance (`calibrateNoiseFromFlips` predicts it to 1e-6), the adaptive budget dominates the historical prefix-4 probe at every noise level, spends fewer probes than the fixed budget at low noise (with queries that need NO probing at all), and beats the fixed 8-probe budget at high noise; the fixed-8 comparison is recorded because the model is optimistic at low noise (the fixed budget enumerates more multi-bit subsets than the query-adaptive depth needs).',
    },
    'binarypc.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'lsh',
        citations: ['binarypc2608', 'charikar2002', 'andoni2015dd', 'denshash2012', 'weightedhamming2009'],
        proves: ['binarypc.test.js', 'lsh.test.js', 'golden.test.js'],
        note: 'Data-aware binary principal components for the LSH hash family (BinaryPC, arXiv 2608.04405) — the training-free alternative to Charikar random-hyperplane SimHash (2002): use the data\'s principal components as the hash directions so a fixed bit budget carries more variance. Imported by the locked lsh bag behind the default-off `_pcaHashConfig` (see `_refreshLshHyperplanes`); with the flag null nothing here runs, so the hot path and all 11 golden fingerprints are unchanged. Proved (binarypc.test.js): power iteration recovers the dominant eigenpair of a diagonal matrix and is deterministic under a seed; on a diagonal covariance the eigenvalues are the exact diagonal (ordered descending), the components are exactly orthonormal, and the eigenvalues sum to the total variance (the trace); the top component recovers a planted direction (|cos| > 0.999); the flagship Eckart-Young claim holds — the PCA-aligned B-subspace beats EVERY one of 20 random B-subspaces on reconstruction error with a > 2x margin on the planted data, and its error is non-increasing in the bit count; `pcaHashTables` returns orthonormal tables inside the top-bits principal subspace; `alignedHashTables` extends that to an oversubscribed budget (bits > dim) by aligning only min(bits, dim, nrows-1, maxRank) directions and drawing the surplus from random unit vectors (which the test proves are unit-norm, so the hash semantics are unchanged); bits > dim and zero-variance data throw; `resolveBinaryPCConfig` clamps. End-to-end (lsh.test.js section I, default-off flag, real 107-bit / lowDim-71 index with a planted anisotropic bank): aligned hyperplanes combined with the already-wired margin multi-probe raise self-recall under noise from 0.68 to 0.775 at sigma=0.25 (and 0.01 -> 0.04 at sigma=0.5) with no loss at sigma=0.1 — BUT aligning EVERY direction is a no-gain config (0.655, below random) because it dedicates bits to the low-variance noise tail; the optimum is a broad plateau around dim/4, which is the wiring default. Round 15 extends this module: `alignedHashTables` now also returns `tableVariances` (the exact data variance of the data along every returned direction, computed from the rotation coefficients and eigenvalues) and accepts `rankPolicy` (`above-mean` | `noise`) so its aligned rank can come from the spectrum instead of the fixed `maxRank` constant.',
    },
    'bitweight.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'lsh',
        citations: ['charikar2002', 'lv2017multiprobe', 'coverthomas2006', 'weightedhamming2009', 'denshash2012', 'adaptivebuckets2604', 'neuroute2608'],
        proves: ['bitweight.test.js', 'binarypc.test.js', 'lsh.test.js', 'golden.test.js'],
        note: 'Bit-reliability theory for the LSH hash bits: how much a single hash bit tells us about a NOISY neighbour. The law: for a direction whose data variance is lambda under isotropic noise variance sigma^2, a stored bit flips with P = arccos(sqrt(lambda/(lambda+sigma^2)))/pi — Charikar\'s theta/pi with theta the signal/noise angle — so P -> 1/2 as lambda -> 0 (a pure-noise bit) and P -> 0 as lambda -> infinity. That makes each bit a binary symmetric channel about the neighbourhood with crossover P; its information 1 - H2(P) (Cover & Thomas) is what a bit is worth, and a low-variance ("tail") direction is worth nothing. Proved (bitweight.test.js, 69 checks): exact law values (P(1,1)=1/4 exactly, the 0-variance/noiseless limits), strict monotonicity in both arguments, bounds [0,1/2], reliabilityWeight == 1 - 2P with weight 0 for a pure-noise bit and -> 1 for a stable one, bitInformation 0 bits at a pure-noise bit and -> 1 noiseless; the closed form matched to Monte Carlo at 4 (lambda, sigma) pairs (max diff 0.00055 over 2e5 draws) and the identity that the law is the average of the margin law Phi(-|margin|/sigma); the margin law is exactly 1/2 at margin 0, vanishes for a large margin, is monotone in |margin|, and ascending |margin| order IS descending flip-probability order — the rigorous reason margin-ordered multi-probe (Lv et al.) probes the right bits first; the sub-mean/min/median-tail spectral noise estimator; selectReliableRank above-mean (count PCs above the random-direction baseline trace/dim, since a random unit direction captures trace/dim variance in expectation, so a PC at or below it is worse than random); exact per-bit reliabilityWeights (uniform variances collapse to Hamming); weightedHamming/weightedKeyDistance/unpackWord (arXiv 2009.08591) exact, symmetric, and equal to plain Hamming at unit weights, verified against a brute-force unpacked recompute on 32-bit AND BigInt 40-bit words; and the live-index validation: the law predicts the measured bit-flip rate of a real PCA-aligned index to within 0.012 (measured 0.1390 vs predicted 0.1267 at sigma=0.5). The recorded negative (section I): reliability-weighted Hamming does NOT beat plain Hamming for ranking candidates on this index, because the rotation-based alignment already equalises per-direction variance while the random surplus bits get down-weighted for nothing — so the pool is left in bucket order and re-scored downstream by the exact projection cosine. Wired: `selectReliableRank`/`estimateNoiseVariance` drive `alignedHashTables`\' `rankPolicy` behind the default-off `_pcaHashConfig` — on the real 107-bit/lowDim-71 index the above-mean policy reads ranks 22-23 off the spectrum (not the dim/4=18 constant) and reaches 0.75 self-recall at sigma=0.25 with the margin multi-probe, versus 0.68 random and 0.655 for full alignment. With `_pcaHashConfig` null nothing here runs, so all 11 golden fingerprints are unchanged. ROUND 16 adds the query-adaptive budget primitives: `bitFlipProbabilities` (q_b = Phi(-|margin|/sigma)), the exact Poisson-binomial `poissonBinomialPmf`/`poissonBinomialQuantile`, `expectedFlippedBits`, the exact containment coverage `marginContainmentCoverage` (provably monotone, so `marginContainmentDepth` bisects exactly) and the exact RECOVERY coverage `probeRecoveryCoverage` (containment factor x P(inside count <= maxFlips), no union bound), the single-pass O(n^2) `recoveryDepth`, and `calibrateNoiseFromFlips` (bisection for the sigma matching an observed mean flip count). Proved (bitweight.test.js section J, 69 checks): the Poisson-binomial pmf is exactly the binomial pmf on four 1/2 coins (1,4,6,4,1)/16 and a point mass at the degenerate limits; the quantile is exact there (1/2->2, 0.6875->2, 0.6876->3, 1->4) and monotone in coverage; containment coverage is exactly 2^k/16 and monotone in depth; recovery coverage is exactly (d+1)/16 at maxFlips=1 and 1/16,4/16,11/16 at maxFlips=2 d=0,2,4, equals P(no flip)+P(one flip inside) in the single-bit mode, and is monotone in maxFlips; `recoveryDepth` matches a brute-force forward scan over 120 random spectra EXACTLY (the incremental implementation is proven equivalent); `calibrateNoiseFromFlips` round-trips the expected flip count to 1e-6 and returns 0/Infinity at the endpoints; Monte Carlo matches the exact containment and recovery coverages to <0.02; and the depth is query-adaptive (0 for a confident query, deep for an ambiguous one, monotone in the coverage target).',
    },
    'querymod.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'lsh',
        citations: ['dqm2605', 'charikar2002', 'lv2017multiprobe', 'denshash2012'],
        proves: ['querymod.test.js', 'lsh.test.js', 'golden.test.js'],
        note: 'Dynamic query modification for binary LSH (Claydon, Connor and Dearle, arXiv 2605.23807) - the query-side companion to the data-aware hash: replace the query with the l2-normalised centroid <c> of the neighbours found so far and continue the search from it. Imported by the locked lsh bag behind the default-off `_queryModConfig`; with the flag null nothing here runs, so the hot path and all 11 golden fingerprints are unchanged (golden.test.js). Proved exact (querymod.test.js, 51 checks): Theorem 1 - no unit direction beats <c> on sum_{x in S}(x.u), and dotProductSum(<c>,S) equals ||sum x|| equals k*||mean|| exactly; Theorem 2 - firstOrderCollisionProbability has the exact form 0.5 + dotProductSum/(k pi) and no random direction beats <c> (which also beats the average random direction on the EXACT Charikar ACP); Appendix C.1 - averageCovariance is exactly const - ((sum x.u)/k)^2, minimised at +-<c>; Section 6.4 - the centroid collides with a member of S on EVERY direction (zero failures over 200 directions) while a raw query can collide with none (the exact singleton witness q=-x fails 200/200, and an opposing query fails the majority on a non-degenerate tight set); the Charikar collision law 1 - arccos(a.b)/pi matched by 40000 random hyperplanes to < 0.01; the denoising law - the 40-view centroid at sigma=0.3 cuts the per-bit error rate several-fold against a single view and the rate shrinks with the view count; and the synthetic regime sweep - query modification strictly raises pool recall while the hash is informative (6..12 bits, e.g. 0.540 -> 0.789 recall at 6 bits) and the gain decays monotonically to zero as the word narrows (0.001 at 24 bits), the empty-consensus-bucket regime. Integration (lsh.test.js section J): the flag is null by default and toggling it back is byte-identical; the returned pool is mechanically a SUPERSET of the baseline (so recall can never fall); on the narrow forceMin 6-bit / lowDim-4 index the branch is demonstrably LIVE (it enlarges the pool for the large majority of queries), while on the production 107-bit index it adds nothing (differ = 0; the exact buckets hold ~0.1-1 prototypes so each set found set is empty or a single already-probed candidate) - an honest, measured negative that matches the synthetic crossover exactly.',
    },
    'consolidation_logic.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'memory',
        citations: ['mela2605', 'behrouz2025titans'],
        proves: ['consolidation.test.js', 'consolidation_worker.test.js'],
        note: 'Pure memory-lifecycle algorithms extracted verbatim from consolidation_worker.js (Gaussian distance, content hash, decay, pairwise merge, promotion, and the prototype proximity graph). consolidation.test.js (48 checks) pins the pure algorithms, including a differential test against the original inline copies (300 randomized trials x {decay, merge, promote, hierarchy}, all Object.is-identical), and documents two deliberate behaviours: mutually-nearest prototypes emit the same directed edge up to 4x (safe because the insert is ON CONFLICT(source, polarity, parent_proto, child_proto) DO NOTHING, so the edge table stays a set), and the pairwise merge is inherently O(n^2*d) and order-dependent (the algorithm, not waste). consolidation_worker.test.js (18 checks) pins the real worker wiring: row decode, config field names, and the posted delta shape against an isolated state dir.',
    },
    'candle_quality.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['binanceTick', 'leprado2018afml'],
        proves: ['candles.test.js'],
        note: 'Impossible-wick winsorizer, applied at read time. Proved by candles.test.js (95 checks): isImplausibleCandle/repairCandle/repairSeries are exact on the real LINKUSDT 2020-03-12T10:00 flash print (low 0.0001 on a ~3.0 bar), the repair is idempotent, preserves every OHLC invariant, leaves genuine extremes (the ADA/LINK 2025-10-10 crash, XRP/DOGE listing spikes, BNB 2017) untouched at the default 0.9 body-fraction threshold, and never modifies open/close/volume/timestamp. Wired into legion/runner.js behind CONFIG.candleWickRepair; the dataset audit reports the repair count. Keeps the raw JSONL floor as the exact venue record instead of rewriting it.',
    },
    'sanitize.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'observability',
        citations: [],
        proves: ['guards.test.js'],
        note: 'Run-integrity boundary guards (ROADMAP P0-1): the finite/JSON coercions, signal/consensus sanitising, the controller-failure budget, the config fingerprint and the controller-argument validator. Proved by guards.test.js (58 checks): finiteOr/finiteOrNull are value-identical for valid numbers (so the golden fingerprints cannot move) and fall back on NaN/Infinity/null/non-numeric strings; safeParseJSON never throws on corrupt/truncated/empty input; sanitizeSignal zeroes non-finite prices, maps a non-finite prob to the -1 sentinel and leaves clean signals byte-identical; sanitizeConsensus zeroes non-finite fields; resolveFailureBudget is exact (a fraction of 128 -> 13, never rounds to zero, >1 is absolute, 0 means any failure breaches, null/negative never) and failureBudgetExceeded uses it; stableHash is key-order independent and configFingerprint ignores paths/ports but changes with any structure key; assertControllerArgs rejects every malformed argument shape. Nothing here is on a hot arithmetic path, so all 11 golden fingerprints are unchanged (golden.test.js).',
    },
    'rng.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'observability',
        citations: [],
        proves: ['guards.test.js'],
        note: 'Deterministic seeded randomness for runs (ROADMAP P0-2): mulberry32, an FNV-style string hash, a per-worker seed derivation and an installable seeded Math.random. Proved by guards.test.js: mulberry32 is bit-identical for a seed and differs across seeds, stays in [0,1); hashString is stable; deriveSeed is deterministic, differs per worker key and returns a uint32; installSeededRandom makes Math.random reproducible and is fully restored afterwards. With CONFIG.seed == null (the default) the dispatcher never installs it, so the golden fingerprints are unchanged.',
    },
    'legion_metrics.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'observability',
        citations: ['brier1950', 'murphy1973', 'page1954', 'cohen1960', 'kuncheva2003', 'gini1912', 'hirschman1945'],
        proves: ['observer.test.js'],
        note: 'Pure legion-health metrics (ROADMAP P1-2): calibration, diversity, drift and concentration. Proved by observer.test.js (75 checks) with exact reference vectors: brierScore is 0 for a perfect forecast, 1 for the confidently wrong and 0.25 for a constant 0.5; the Murphy (1973) partition satisfies Brier = REL - RES + UNC + WITHIN exactly (to 1e-12) at 10 bins; shannonEntropy([1,1,1,1]) = 2 bits and [1,3] = 0.8112781, hhi([1,1,1,1]) = 0.25, effectiveVoters = 1/HHI; gini([0,1]) = 0.5; ewmaSeries is an exact EMA; the two-sided CUSUM alarms at the exact index under a sustained shift and is silent otherwise; cohensKappa is 1 for perfect agreement, -1 for total disagreement and guarded at pe=1; meanPairwiseKappa averages all pairs exactly; influenceSummary reports the exact HHI/entropy/effective voters/max share; consensusProbability maps confidence+direction to a BUY probability. Pure, stateless, no hot-path imports — all 11 golden fingerprints are unchanged.',
    },
    'analyze.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['pardo2008walkforward', 'leprado2018afml', 'politisromano1994subsampling', 'romano2005stepm'],
        proves: ['analyze.test.js'],
        note: 'The A/B analysis driver (ROADMAP P2-1): build a causal walk-forward split, evaluate the default-off baseline plus each feature variant with the locked analysis layer, decide with promoteDecision (DSR floor + fold-win + positive-fold + a clean look-ahead audit), cross-check with the family-wise subsampling SPA / Romano-Wolf step-down, and write a run directory. Proved by analyze.test.js (216 checks): the variant table is well-formed and applyVariant sets exactly the feature flags (no-op for baseline and the controller-scoped sample-weights); featureVector is causal and the leaky slot peeks at t+1; the injected-fake model factory constructs/trains/predicts deterministically under a seed and runs configure + afterFit; evaluateAB flags a drifting oracle via the audit and refuses to promote it, promotes a clean dominant causal candidate, never promotes a zero-skill control, and attaches segment-aware (trimmed) family-wise statistics with the oracle identified as best; input guards throw; formatAnalysis renders the verdict; readCloses skips malformed lines and honours maxBars. Pure core is model-agnostic; the HiveMind-backed factory is imported only by the CLI. ROUND 24 (run integrity — all off the arithmetic path): each fit\'s state can be reclaimed (`modelRetention`, factory default `keep`, the CLI default `discard`) — `makeSignalForVariant` disposes the model in a `finally`; reclaim closes the fit\'s `_db` handle and removes its state directory; the emitted positions are byte-identical either way and `dispose()` is idempotent; `evaluateAB` gained reporting-only `onEvent`/`onVariant` hooks (every scored fold and every audit base/probe pass, tagged with its variant/stream, self-contained bar indices + positions + realised returns + metrics, plus the audit\'s behavioural `reachableFolds` counter; the audit base pass reproduces the scored pass exactly, and `probesPerFold`/`auditVerdict`/`auditBlock` shape the readout); `runAnalysis` checkpoints `partial-report.json` after every variant with an atomic write, keeps `progress.json` as a liveness heartbeat and `folds.jsonl` as a fold journal, emits a greppable stdout progress line, and on a crash writes a `status:\'failed\'` checkpoint that keeps every finished variant. ROUND 23: the CLI/model default flipped to the SHIPPED controller (makeControllerModelFactory builds a real HiveMindController per fold, pre-creates its _hivemind so mind-level flags are reachable, streams bars 1..testStart-1, then reads getSignal(candles[0..t]) prequentially and maps prob->position with the documented dead-zone policy; the -1 untrained sentinel and a throwing controller both ABSTAIN), the candidate family grew to K>=15 by adding the 8 causal signal candidates (variant.signal is dispatched by makeSignalForVariant without building any model), and one-or-more symbols can be pooled (worlds, --symbols=all, readCandles, --model/--probe/--audit-probes/--variants). A controller-scoped variant (sample-weights) is `skipped` on the bare model and evaluated on the controller one. Section N covers the whole `runAnalysis` CLI path with injected fake model classes (no SQLite, no DB; the browser fs shim gained `mkdtempSync` and a pre-`mkdtemp` `mkdirSync` so the temp model state dir works off-disk): the controller report shape, the 15-variant family with sample-weights NOT skipped, `--model=bare` (14 variants, no position policy, the controller-scoped candidate absent), `--variants` id resolution through ALL_VARIANTS, the family-wise block, and the three named errors (unknown symbol / too few candles / an unbounded 290-fold split). `CONTROLLER_MODEL.warmup` is load-bearing: a fold with less streamed history than the floor abstains (reported via `stats().undertrained`), so a tiny fold cannot "predict" from an untrained controller. ROUND 24b (premium hardening after the first complete smoke run): the audit shock scales volume as well as OHLC (`world.js#volumeShockFactor`), so a volume-driven candidate is reachable; pooled metrics carry `grossPnl` and an assumption-free `breakEvenCostBps` (the per-unit-turnover cost at which the gross edge is exhausted) and `--cost-bps` is threaded to the scoring; `--reuse-base` reuses the scored pass as the audit base pass (one fewer refit per fold, verdict-identical, recorded as `baseReused`); `folds.jsonl` lines carry `probeIndex` and `reused` so the journal is readable offline; and the run summary states the Sharpe power verdict with an `underpowered` flag and `barsToDetect1`. ROUND 25: `--gate=classic|dependence` (default dependence) threads the dependence-aware hurdles into every candidate decision via `evaluateAB`\x27s `gateOptions`, and each candidate row records the paired cluster test and which hurdles were APPLIED vs SKIPPED-for-lack-of-panel; `--cost-ladder=0,2,5,10` restates the whole verdict at each cost level (the attempt-3 flip from keep-off at 0 bps to sig:acceleration promoting at 2 bps is invisible in a single scored level); a `familyCorrelation` block reports how concentrated the search was (diagnostic only); per-variant wall times and the trial count are recorded in `timings` and on every candidate row (the measured cost law is `0.035 s x sum_f(testStart_f) x streams x passes x mechanismVariants`, O(n^2) per stream - see `OPTIMIZATION.md` round 25b, so the next run can be sized from the checkpoint); and `run.json`/the checkpoints state the gate and the ladder levels so a verdict is never ambiguous about what produced it. ROUND 26 (R26-12): `saveInterval` throttles `HiveMind.dumpState()` off the arithmetic path — the full-ensemble SQLite write is ~25% of the per-call cost, the default `1` dumps every call (bit-identical to before, so the three re-frozen `ctl:*` fingerprints are the R26-0 ones only), a finite `k` dumps on every k-th eligible call and `Infinity` never dumps during a run; `core.test.js` proves the emitted signal stream is identical at `k = 1, 3, Infinity` while the write count is exactly `ticks` / `floor(ticks/k)` / `0`, `makeControllerModelFactory` defaults to `1` and threads an override, and `runAnalysis` defaults the A/B to `Infinity` (it never reads a fit state back) and records the value in `run.json` and `report.json`; the controller\x27s new `flushState()` writes the state on demand (used once at disposal when a fit is KEPT and the interval never dumps, so a forensic state dir is not empty) and cannot move a signal. ROUND 26 (R26-2, model readiness/label diagnostics — BUGS.md #35/#37): the controller accumulates the resolved-barrier split (`resolved_take_profit`/`resolved_stop_loss`), the Brier components and a dropped-candle count and persists them; `makeControllerModelFactory`\'s `stats()` reports the label base rate, a proper Brier skill score against the base-rate forecast and a chance-corrected accuracy, with a three-state `status` (`not-trained` | `base-rate` | `skilful`); the readiness gate is now `trainingSteps > 0` (the old `testStart >= warmup` guard could never fire at the default split). `runAnalysis` pools the per-fold stats into a per-variant `model` block in `report.json` (null for a pure signal candidate, so an absent model is never read as healthy) and renders a `models:` summary line. Proved by new analyze.test.js checks and core.test.js section I. ROUND 26 (R26-3, one confidence->position pipeline — BUGS.md #34): `POSITION_POLICY` is applied to BOTH families through `walkforward#confidenceToPosition` (signals now carry the controller dead zone); the factories expose `rawConfidence()`, `folds.jsonl` journals the raw pre-policy confidence, and `report.json` carries a `policyRoundTrip` certificate. ROUND 26 (R26-11, trade-label policy — BUGS.md #36): `LABEL_VARIANTS` (`label-conservative`, `label-triple`; `kind:\'label\'`, controller-scoped) are resolvable by id through `RESOLVABLE_VARIANTS` while the default family stays 15, the factory sets the run-level `labelPolicy`/`labelHorizonBars` on the controller BEFORE `variant.configure` (so a label variant overrides it — `optimistic` is byte-identical and the three `ctl:*` goldens are untouched), `--label-policies` appends exactly the two candidates, `--label-policy=`/`--label-horizon=` are validated (an unknown name throws) and recorded in `run.json`/`report.json`, and the label lifecycle counters (`heldBarsSum`/`heldBarsCount`/`heldBarsMax`, `resolvedTimeBarrier`) round-trip. Proved by new analyze.test.js checks and core.test.js section J (browser + native). ROUND 26 (R26-4, parallel fold loop): `concurrency` (default `1` = the serial driver, byte-identical) dispatches whole fold-passes to worker threads via `analysis/parallel.js#scheduleUnits` (order-preserving bounded concurrency) and `makeNodeFoldDispatcher`/`analysis/fold_worker.js` (one worker per fold, reconstructing the same seeded signal function from the same data, so `folds.jsonl` and the verdict are byte-identical); `evaluateABAsync` shares `finalizeAB` with `evaluateAB` so the two drivers cannot drift, and the worker reports its model diagnostics so the per-variant `model` block survives the round-trip. Proved by analyze.test.js + analysis.test.js checks (an injected inline executor reproduces the serial report) and the node-only `parallel_folds.test.js` (real worker threads, byte-identical `folds.jsonl`). ROUND 26 (R26-5, the turnover attack): the journaled pre-policy confidence is restated under a frozen dead-zone x entry/exit-hysteresis x minimum-holding grid (`analysis/holding.js`, pure post-processing — no model); the block is opt-in (`--turnover-sweep`/`--turnover-target=<bps>`, null by default) and recorded in `run.json`/`report.json`, the summary renders it, and an identical sweep-off run proves it moves no scored number. Proved in the browser and natively by the node-only `analyze_cli.test.js` (the spawned CLI documents and threads both flags). ROUND 26 (R26-6, effective independence): `--interval=<n>` resamples every stream to a coarser bar horizon (exact OHLCV aggregation; a different horizon rather than a copy) and `--select-streams[=<n>]` measures the basket\'s Kish design effect over the streams\' returns (Grinold 1989 breadth) and optionally keeps the first n of the greedy most-diversifying order; both are recorded in `run.json`/`report.json` and rendered, and both are DESIGN choices — they cannot change how an included stream is scored. ROUND 26 (R26-13, seed replication + common random numbers): common random numbers are on by default (the per-fold seed is variant-independent — `seed + testStart*977` — so the variant comparison is paired on the random draws and the variance of the difference falls; Glasserman & Yao 1992); `--crn=0` restores the historical per-variant seed; and `--seeds=a,b,c` replicates the A/B under several master seeds and aggregates every variant mean/IQM/stratified-bootstrap CI/seed-fold variance split (Bouthillier et al. 2019; Agarwal et al. 2021) into `replication.json`. Every baseline/candidate row now carries its per-fold net-Sharpe series, and `crn=<bool>` is recorded in `run.json`, `report.json` and the summary. ROUND 26 (R26-14, forecast comparison): the run now carries a `forecast` block (on by default; `--forecast=0` disables) — proper scores (Brier + reliability/resolution/uncertainty, log score) per variant, the block-bootstrapped Diebold-Mariano test of each candidate\'s per-bar Brier loss vs the baseline, and the family Model Confidence Set at 90% and 95% (Hansen-Lunde-Nason) — all pure post-processing of the journaled confidence, so it moves no scored number; the block and a `forecast:` summary line are asserted, and `forecast=false` nulls it while changing no scored number.',
    },
    'alerts.js': {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'observability',
        citations: ['kuncheva2003'],
        proves: ['observer.test.js'],
        note: 'Pure alert rule engine for the observer (ROADMAP P1-2): rules are plain data (metric + comparison + threshold + severity) and evaluateAlerts is a pure function of (metrics, rules, previously-firing). Proved by observer.test.js: compare supports all six operators and never fires on a non-finite metric; the default rules are frozen with unique ids; every breached rule fires (Brier, influence HHI, effective voters, ensemble diversity, worker errors, quarantined rows, vault growth) with a formatted message; highestSeverity ranks critical over warning over info; a healthy snapshot fires nothing and reports the previous firings as resolved; hysteresis via the previous firing set works with an array or a Set; custom rules and the non-function message fallback are exact. Read-only with respect to the run, so all 11 golden fingerprints are unchanged.',
    },
});

// ---------------------------------------------------------------------------
// HiveMind component bags (keys must match COMPONENTS in component-manifest.js)
// ---------------------------------------------------------------------------

export const HIVEMIND_REGISTRY = Object.freeze({
    activations: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'attention',
        citations: ['shazeer2020glu', 'ramachandran2017swish'],
        proves: ['golden.test.js', 'core.test.js', 'modules.test.js'],
        fingerprints: ['hm:predictions', 'hm:diagnostics'],
        note: 'SiLU/Sigmoid/Softmax gating; outputs pinned by the forward-pass fingerprints.',
    },
    linalg: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'attention',
        citations: ['charikar2002', 'vaswani2017attention'],
        proves: ['golden.test.js', 'core.test.js'],
        fingerprints: ['hm:predictions', 'hm:diagnostics'],
        note: 'Dot/norm/cosine/kernel primitives; the similarity currency shared by retrieval and attention.',
    },
    normalization: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'attention',
        citations: ['zhang2019rmsnorm', 'su2021rope'],
        proves: ['golden.test.js', 'core.test.js'],
        fingerprints: ['hm:predictions'],
        note: 'RMSNorm + RoPE; rotation preserves norm (invariant checked in core).',
    },
    sampling: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'attention',
        citations: ['charikar2002'],
        proves: ['golden.test.js', 'sanity.test.js'],
        fingerprints: ['hm:diagnostics', 'hm:memberCounts'],
        note: 'Seeded PRNG makes construction deterministic; hyperplane draw pinned under the seeded workload.',
    },
    statistics: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'continual',
        citations: ['kirkpatrick2017ewc', 'homeostatic2609'],
        proves: ['sanity.test.js', 'core.test.js', 'golden.test.js'],
        fingerprints: ['hm:diagnostics'],
        note: 'Robust spread/percentile/EMA helpers. Known limits documented in docs/BUGS.md: _computeVariance is an MAD-style robust spread (not classical variance), _computePercentile maps 0->1.0, _isStagnating is tuned trigger-happy. These are pinned, intentional behaviours, not bugs to "fix" without a benchmark.',
    },
    loadState: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'memory',
        citations: ['kanerva1988'],
        proves: ['sanity.test.js', 'core.test.js'],
        note: 'Persistence round-trip: two reloads of one snapshot are bit-identical; float32 storage drift bounded.',
    },
    saveState: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'memory',
        citations: ['kanerva1988'],
        proves: ['sanity.test.js', 'core.test.js'],
        note: 'Float32 blob serialisation; same invariant as loadState.',
    },
    dimensions: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'attention',
        citations: ['kaplan2020scaling', 'yang2022mup', 'lakshminarayanan2017deep'],
        proves: ['dimensions.test.js', 'modules.test.js', 'core.test.js'],
        note: 'Structure-scaling contract for both branches of _scaleAndSetDimensions. Proved by dimensions.test.js (185 checks): the compact (forceMin, production) overrides are frozen as exact constants; across the es x is grid the full-size branch allocates tensors matching its declared counts (hidden divisible by heads, headDim = hiddenSize/heads, lowDim inside [max(4,0.18*hidden), 0.78*hidden], numLshSets = floor(numProjections/3)); layers, heads and hidden size are monotone non-increasing in ensemble size while the learning rate is monotone non-decreasing (a width-scaling law, Kaplan 2020 / muP Yang 2022); every normalized-derived dimension saturates once log10(es)/3 >= 1 while gradientResetFrequency scales with es; the only dimension that depends on inputSize is the learning rate; end-to-end churn keeps the LSH index consistent with exact bucket multiplicity, weights/gradients finite, and each LSH projection unit-norm (self-similarity ~1); boundary configs (es=1, is=1) construct with consistent shapes. Capacity is distributed across members (Deep Ensembles, Lakshminarayanan 2017). Grounded by the mixin contract in docs/COMPONENTS.md for wiring.',
    },
    lsh: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'lsh',
        citations: ['charikar2002', 'binarypc2608', 'dqm2605', 'lv2017multiprobe'],
        proves: ['sanity.test.js', 'golden.test.js', 'core.test.js', 'lsh.test.js'],
        fingerprints: ['hm:memberCounts', 'hm:broadcast'],
        note: 'SimHash-family recall index. Maths proved by lsh.test.js: projections are unit norm so _projSimilarity is a true average cosine (self-score exactly 1; the historical 1/sqrt(lowDim) rescale that killed the 0.35 filter is reproduced and shown to fail), hash words equal the hyperplane sign pattern bit-for-bit, identical vectors collide, insert/remove/update keep the bucket index a leak-free mirror of _semanticProtos, exact-match queries recall 100% of the bank, and the measured bit-flip rate matches the Charikar rounding law Pr[differ]=theta/pi to <=0.03. sanity.test.js pins churn consistency; golden pins the hashed candidate sets. The candidate probe loop can run in margin order (memory/multiprobe.js) when `_multiProbeConfig` is set; it is null by default and the disabled branch is byte-identical, so the goldens are unchanged. lsh.test.js section I additionally proves `_refreshLshHyperplanes` (memory/binarypc.js, BinaryPC): off by default, a no-op with the flag null (reference-identical hyperplanes), and when enabled it replaces every set hyperplane with finite lowDim-sized unit vectors, rebuilds the bucket index into an exact leak-free mirror of _semanticProtos, is bit-deterministic under a seed, no-ops below its minRows data floor, and survives a SQLite round-trip (reload bit-identical, buckets rebuilt under the restored hyperplanes); on a real 107-bit/lowDim-71 index with a planted anisotropic bank it lifts self-recall under noise from 0.68 to 0.775 at sigma=0.25 (0.315 -> 0.395 for the prefix probe) with the margin multi-probe on, with no loss at sigma=0.1 and no gain from aligning every direction (the noise-tail effect). Round 15 adds a data-driven rank: with `_pcaHashConfig.rankPolicy` set the aligned rank is read off the spectrum by `selectReliableRank` (memory/bitweight.js) instead of the fixed dim/4 default — on the real index the above-mean policy picks ranks 22-23 and reaches 0.75 self-recall at sigma=0.25 (vs 0.68 random and 0.655 full alignment), with `_lshAlignedRank` recording the rank actually used; with the flag null nothing changes. Round 16 adds a QUERY-ADAPTIVE probe depth on top of margin order: `_multiProbeConfig` also accepts `{ adaptive: true, sigma, coverage, ... }`, in which case `multiProbeKeys` (memory/multiprobe.js) derives the probe depth per query from the bit-flip model — see `memory/bitweight.js` `probeRecoveryCoverage` / `recoveryDepth`. Calibrated on the live 107-bit index (`calibrateNoiseFromFlips` predicts the measured mean Hamming distance to 1e-6) the adaptive budget dominates the historical prefix-4 probe at every noise level, needs no probing at all for many queries at low noise, and beats the fixed 8-probe margin budget at high noise. Still null by default, so the hot path and goldens are unchanged.',
    },
    protos: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'memory',
        citations: ['behrouz2025titans', 'kanerva1988'],
        proves: ['golden.test.js', 'core.test.js', 'candles.test.js'],
        fingerprints: ['hm:diagnostics', 'hm:memberCounts'],
        note: 'Prototype lifecycle (create/reinforce/finalize/decay/utility-sort). Surprise-gated writes are implemented and proven (see the `surprise.js` support module: Titans arXiv 2501.00663) but ship off by default.',
    },
    replay: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'memory',
        citations: ['shin2017generative', 'behrouz2025titans'],
        proves: ['golden.test.js', 'core.test.js'],
        fingerprints: ['hm:predictions', 'hm:diagnostics'],
        note: 'Generative replay rehearses condensed past signal instead of raw history.',
    },
    retrieval: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'memory',
        citations: ['ramsauer2020hopfield', 'kanerva1988', 'interference2609'],
        proves: ['golden.test.js', 'core.test.js', 'candles.test.js'],
        fingerprints: ['hm:predictions', 'hm:diagnostics'],
        note: 'Kernel top-k retrieval. Interference-wall result (2609.16183) argues for a bounded working window; the bank carries the long tail.',
    },
    consolidation: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'memory',
        citations: ['mela2605', 'behrouz2025titans'],
        proves: ['consolidation.test.js', 'consolidation_worker.test.js', 'golden.test.js'],
        fingerprints: ['hm:diagnostics'],
        note: 'Consolidation is deterministic and idempotent under repeated application (consolidation suites).',
    },
    banks: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'memory',
        citations: ['behrouz2025titans', 'eviction2607'],
        proves: ['golden.test.js', 'sanity.test.js'],
        fingerprints: ['hm:diagnostics', 'hm:memberCounts'],
        note: 'Three-tier bank update + prune. Eviction-as-estimation (2607.24667) motivates bounded accumulation.',
    },
    attention: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'attention',
        citations: ['vaswani2017attention', 'su2021rope'],
        proves: ['golden.test.js', 'core.test.js'],
        fingerprints: ['hm:predictions'],
        note: 'Multi-head + context-aware attention; output shapes and softmax row-sum=1 checked in core.',
    },
    forward: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'attention',
        citations: ['vaswani2017attention', 'hybrid2609'],
        proves: ['golden.test.js', 'sanity.test.js'],
        fingerprints: ['hm:predictions', 'hm:translate'],
        note: 'The forward pass. Chaotic under float32: do not reorder multiply-adds without a re-freeze.',
    },
    hiveState: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'ensemble',
        citations: ['lakshminarayanan2017deep'],
        proves: ['golden.test.js', 'core.test.js'],
        fingerprints: ['hm:diagnostics', 'hm:broadcast'],
        note: 'Weighted-sum shared state; the exchange channel across members.',
    },
    scores: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'ensemble',
        citations: ['lakshminarayanan2017deep', 'diversitycollapse2608'],
        proves: ['golden.test.js', 'core.test.js', 'legion.test.js'],
        fingerprints: ['hm:diagnostics'],
        note: 'Specialisation/performance/agreement/trust + ensemble weights. Invariant: weights non-negative and sum to 1.',
    },
    gradients: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'training',
        citations: ['goyal2017accurate'],
        proves: ['golden.test.js', 'core.test.js', 'sanity.test.js'],
        fingerprints: ['hm:predictions'],
        note: 'Capture -> scale -> accumulate -> apply / rollback. Rollback is an exact undo.',
    },
    distillation: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'training',
        citations: ['hinton2015distilling'],
        proves: ['golden.test.js', 'features.test.js'],
        fingerprints: ['hm:diagnostics'],
        note: 'Ensemble-consensus distillation into each member.',
    },
    transfer: {
        status: LOCK_LEVELS.BIT_EXACT,
        domain: 'training',
        citations: ['hinton2015distilling'],
        proves: ['golden.test.js', 'core.test.js', 'sanity.test.js'],
        fingerprints: ['hm:broadcast', 'hm:translate'],
        note: 'Cross-member memory broadcast/translate; shape and injectedRatio bounds checked.',
    },
    diagnostics: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'ensemble',
        citations: [],
        proves: ['sanity.test.js', 'core.test.js', 'modules.test.js', 'candles.test.js'],
        fingerprints: ['hm:diagnostics'],
        note: 'Read-only observation surface. Invariant: LSH index consistency, finite weights/gradients, exact training-step count.',
    },
});

// ---------------------------------------------------------------------------
// HiveMindController component bags
// ---------------------------------------------------------------------------

export const CONTROLLER_REGISTRY = Object.freeze({
    controllerDatabase: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'memory',
        citations: [],
        proves: ['core.test.js', 'golden.test.js'],
        note: 'Opens the per-controller SQLite DB. Promoted NEEDS-LOCAL-RUN -> LOCKED-invariant after the green local `npm test` (BUGS.md #18): the golden/core mirrors drive this path on the real better-sqlite3 driver, and `golden.test.js` pins the bounded reload gap (<1e-4) plus the reloaded memory structure.',
    },
    controllerAccuracy: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'ensemble',
        citations: ['lakshminarayanan2017deep'],
        proves: ['golden.test.js'],
        note: 'Global accuracy persistence against a live DB. Promoted NEEDS-LOCAL-RUN -> LOCKED-invariant after the green local run: the `ctl:accuracyTotals` / `ctl:signalTrajectory` fingerprints pin the accumulated counters end-to-end on the native driver.',
    },
    controllerCandle: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml'],
        proves: ['core.test.js', 'indicators.test.js', 'legion.test.js'],
        note: 'Window selection over the candle array; entryPrice == last close invariant checked in core.',
    },
    controllerFeature: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'attention',
        citations: ['leprado2018afml', 'zhang2019rmsnorm'],
        proves: ['features.test.js'],
        note: 'Feature extraction: robust-normalise + interleave. Exact emitted sequence pinned; plain-array == TypedArray equivalence pinned.',
    },
    controllerTrade: {
        status: LOCK_LEVELS.INVARIANT,
        domain: 'finance',
        citations: ['leprado2018afml'],
        proves: ['core.test.js', 'multisymbol.test.js', 'golden.test.js'],
        note: 'Open/closed trade bookkeeping against the live DB; direction invariants (TP/SL side) checked in core and across all eight symbols by multisymbol.test.js, and the per-bar bookkeeping pinned by the `ctl:*` fingerprints, all now on the native driver (BUGS.md #18). The target-price grid is owned by price_precision.js. `_sampleWeightsForBatch` is the additive uniqueness-weight bridge (see the `sample_weights.js` support module); it returns null by default, so the training path is unchanged.',
    },
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REQUIRED_FOR = {
    [LOCK_LEVELS.BIT_EXACT]: { proves: true, citations: true, fingerprints: true },
    [LOCK_LEVELS.INVARIANT]: { proves: true, citations: false, fingerprints: false },
    [LOCK_LEVELS.STRUCTURAL]: { proves: true, citations: false, fingerprints: false },
    [LOCK_LEVELS.NEEDS_LOCAL_RUN]: { proves: false, citations: false, fingerprints: false },
    [LOCK_LEVELS.EXPERIMENTAL]: { proves: false, citations: true, fingerprints: false },
};

// Returns an array of human-readable problems; empty means the registry is valid
// in isolation (completeness against the manifest is checked by locks.test.js).
export function validateRegistry(registry, { manifestKeys, label }) {
    const problems = [];
    const keys = Object.keys(registry);
    for (const k of keys) {
        const e = registry[k];
        if (!e || typeof e !== 'object') { problems.push(`${label}.${k}: not an object`); continue; }
        if (!Object.values(LOCK_LEVELS).includes(e.status)) {
            problems.push(`${label}.${k}: invalid status "${e.status}"`);
            continue;
        }
        if (!DOMAINS[e.domain]) problems.push(`${label}.${k}: unknown domain "${e.domain}"`);
        const req = REQUIRED_FOR[e.status];
        const proves = Array.isArray(e.proves) ? e.proves : [];
        const citations = Array.isArray(e.citations) ? e.citations : [];
        if (req.proves && proves.length === 0) problems.push(`${label}.${k}: ${e.status} needs at least one proving test`);
        if (req.citations && citations.length === 0) problems.push(`${label}.${k}: ${e.status} needs at least one citation`);
        if (req.fingerprints && (!Array.isArray(e.fingerprints) || e.fingerprints.length === 0)) {
            problems.push(`${label}.${k}: ${e.status} needs at least one golden fingerprint`);
        }
        for (const t of proves) if (!KNOWN_TESTS.includes(t)) problems.push(`${label}.${k}: unknown test "${t}"`);
        for (const c of citations) if (!CITATIONS[c]) problems.push(`${label}.${k}: unknown citation key "${c}"`);
        if (e.status === LOCK_LEVELS.NEEDS_LOCAL_RUN && !e.localScript) {
            problems.push(`${label}.${k}: NEEDS-LOCAL-RUN needs a localScript`);
        }
        if (typeof e.note !== 'string' || e.note.length < 8) problems.push(`${label}.${k}: needs a note`);
    }
    if (manifestKeys) {
        for (const k of manifestKeys) if (!registry[k]) problems.push(`${label}.${k}: missing from registry`);
        for (const k of keys) if (!manifestKeys.includes(k)) problems.push(`${label}.${k}: not in component manifest`);
    }
    return problems;
}
