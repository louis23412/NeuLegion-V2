// Analysis supercharges suite — honest-evaluation primitives.
//
// Every formula here is checked against exact reference vectors (hand-computed
// closed-form values), not merely "runs without error". These modules are pure
// and never imported by the locked hot path, so they cannot move a golden
// fingerprint; this suite is what earns them their LOCKED-invariant status.

import {
    normalCdf, normalInvCdf, mean, stdSample, stdPopulation,
    sharpeRatio, annualizeSharpe, deannualizeSharpe,
    skewness, kurtosis, sharpeStandardError,
    probabilisticSharpeRatio, expectedMaxSharpe, deflatedSharpeRatio,
    minimumTrackRecordLength, stationaryBootstrapSharpe, evaluateStrategy,
} from '../../../src/analysis/performance.js';
import {
    purgedKFoldSplit, walkForwardSplit, assertNoLeakage, normalizeLabelSpans, combinatorialPurgedSplit,
} from '../../../src/analysis/splits.js';
import {
    tripleBarrierLabels, cusumFilter, fractionalDiffWeights, fractionalDiff, fracDiffLogPrices, DEFAULT_FD_WINDOW,
} from '../../../src/analysis/labels.js';
import {
    sampleUniqueness, averageUniqueness, effectiveSampleSize, sequentialBootstrap,
} from '../../../src/analysis/uniqueness.js';
import {
    positionsFromSignals, turnover, strategyReturns, equityCurve, maxDrawdown,
    hitRate, tradeCount, backtestMetrics, purgedCVBacktest, purgedCVBacktestAsync, annualizedReturn, poolFolds,
} from '../../../src/analysis/backtest.js';
import { scheduleUnits, normaliseConcurrency, makeFoldExecutor } from '../../../src/analysis/parallel.js';
import {
    barReturns, logReturns, probToPosition, isCausalFold, aggregateFolds,
    foldWinFraction, auditNoLookahead, walkForwardEvaluate, walkForwardEvaluateAsync, promoteDecision,
    formatReport, familywiseSearch, walkForwardSearch,
    sharpeStandardError as wfSharpeStandardError, minimumDetectableSharpe, poolReports,
    dependenceSummary, clustersOf, pairedPromotionTest, restateReportAtCost, costLadder,
    familyCorrelation, DEPENDENCE_GATE_READER,
    confidenceToPosition, confidenceFromProb, verifyPolicyRoundTrip, restateReportAtPolicy,
    positionSeriesFromConfidence,
} from '../../../src/analysis/walkforward.js';
import {
    DEFAULT_TURNOVER_GRID, turnoverSweep, bestTurnoverPolicy, formatTurnoverSweep,
} from '../../../src/analysis/holding.js';
import {
    resampleCandles, designEffectOfStreams, selectStreams, formatStreamSelection,
} from '../../../src/analysis/streams.js';
import {
    interquartileMean, stratifiedBootstrapCI, varianceComponents,
    seedDistribution, pairedVarianceRatio, formatSeedReplication,
} from '../../../src/analysis/replication.js';
import {
    forecastPairs, brierBinIndex, brierScore, logScore, brierDecomposition, brierLosses,
    bootstrapMeans, dieboldMariano, modelConfidenceSet, forecastComparison, formatForecast,
} from '../../../src/analysis/forecast.js';
import {
    foldConcentration, confidencePersistence, nextRunPlan, decisionReport, formatDecision,
} from '../../../src/analysis/decision.js';
import {
    halvingRounds, halvingSchedule, successiveHalving, formatRace,
} from '../../../src/analysis/race.js';
import {
    pearsonCorrelation, meanPairwiseCorrelation, equicorrelationDesignEffect,
    equicorrelationEffectiveSize, foldWindowClusters, concatClusters, clusterJackknife,
    pairedClusterTest, pairedClusterSignTest, signTest, signTestFloor,
    regularizedIncompleteBeta, studentTPValue, studentTCdf, studentTCritical, clusterStability,
} from '../../../src/analysis/dependence.js';
import {
    DEFAULT_SHOCK, shockFactor, shockCandles, makeCandleViewFor, worldFromCandles,
} from '../../../src/analysis/world.js';
import {
    DEFAULT_POSITION, clampPosition, momentum, fracDiffAt, fracMomentum,
    volRegime, momentumAgreement, rangeLocation, volumeImbalance, autocorr1,
    acceleration, causalZScore, positionAt, signalForCandidate, SIGNAL_CANDIDATES,
} from '../../../src/analysis/features.js';
import {
    cscvBlocks, cscvSplit, relativeRank, oosOnIsRegression, probabilityOfBacktestOverfitting,
} from '../../../src/analysis/overfitting.js';
import {
    benchmarkSeries, relativePerformance, stationaryBlockIndices,
    whiteRealityCheck, hansenSpa, consistentRecentring,
    hansenSpaConsistent, romanoWolfStepM,
    politisWhiteBlockLength, autoBlockLength, bootstrapRelativeMeans,
    neweyWestSE, subsamplingSpa, subsamplingStepM, subsamplingFdp, subsamplingKfwer,
} from '../../../src/analysis/reality_check.js';

const close = (a, b, tol = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= tol;

const LINEAR = [1, 2, 3, 4, 5];

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. normal distribution primitives ----------------------------------
    check('normalCdf(0) === 0.5 exactly', normalCdf(0) === 0.5, `${normalCdf(0)}`);
    check('normalCdf(1.96) ~= 0.9750021', close(normalCdf(1.96), 0.9750021048517795, 1e-5), `${normalCdf(1.96)}`);
    check('normalCdf(-1.96) ~= 0.0249979', close(normalCdf(-1.96), 0.0249978951482205, 1e-5), `${normalCdf(-1.96)}`);
    check('normalCdf is symmetric', close(normalCdf(1.5) + normalCdf(-1.5), 1, 1e-7));
    check('normalInvCdf(0.975) ~= 1.959964', close(normalInvCdf(0.975), 1.959963984540054, 1e-4), `${normalInvCdf(0.975)}`);
    check('normalInvCdf(0.5) ~= 0', Math.abs(normalInvCdf(0.5)) < 1e-9, `${normalInvCdf(0.5)}`);
    check('normalInvCdf round-trips normalCdf', close(normalInvCdf(normalCdf(0.8)), 0.8, 1e-4));

    // ---- B. moments ---------------------------------------------------------
    check('mean([1..5]) === 3', mean(LINEAR) === 3);
    check('stdSample([1..5]) === sqrt(2.5)', close(stdSample(LINEAR), Math.sqrt(2.5), 1e-12), `${stdSample(LINEAR)}`);
    check('stdPopulation([1..5]) === sqrt(2)', close(stdPopulation(LINEAR), Math.sqrt(2), 1e-12), `${stdPopulation(LINEAR)}`);
    check('skewness of symmetric data === 0', close(skewness(LINEAR), 0, 1e-12), `${skewness(LINEAR)}`);
    check('kurtosis([1..5]) === 1.7', close(kurtosis(LINEAR), 1.7, 1e-12), `${kurtosis(LINEAR)}`);
    check('kurtosis of normal-ish sample ~= 3', Math.abs(kurtosis([-1, 0, 1, 0, -1, 0, 1]) - 3) < 1.5, `${kurtosis([-1, 0, 1, 0, -1, 0, 1])}`);

    // ---- C. Sharpe & its standard error -------------------------------------
    check('sharpeRatio([1..5]) === 3/sqrt(2.5)', close(sharpeRatio(LINEAR), 3 / Math.sqrt(2.5), 1e-12), `${sharpeRatio(LINEAR)}`);
    check('annualize/deannualize round-trip', close(deannualizeSharpe(annualizeSharpe(1.5, 252), 252), 1.5, 1e-12));
    check('sharpeRatio flat series === 0 (not NaN)', sharpeRatio([0.01, 0.01, 0.01]) === 0);
    check('sharpeStandardError exact (SR=1,n=100,normal)', close(sharpeStandardError({ sharpe: 1, n: 100 }), Math.sqrt(1.5 / 99), 1e-12), `${sharpeStandardError({ sharpe: 1, n: 100 })}`);

    // ---- D. Probabilistic Sharpe Ratio --------------------------------------
    check('PSR(SR=0) === 0.5 exactly', probabilisticSharpeRatio({ sharpe: 0, n: 100 }) === 0.5);
    const psrLow = probabilisticSharpeRatio({ sharpe: 0.1, n: 100 });
    const psrHigh = probabilisticSharpeRatio({ sharpe: 0.5, n: 100 });
    check('PSR monotone increasing in SR', psrHigh > psrLow && psrLow > 0.5, `${psrLow} -> ${psrHigh}`);
    check('PSR in (0,1)', psrLow > 0 && psrLow < 1 && psrHigh > 0 && psrHigh < 1);
    const psrShort = probabilisticSharpeRatio({ sharpe: 0.5, n: 20 });
    check('PSR increases with sample length', probabilisticSharpeRatio({ sharpe: 0.5, n: 200 }) > psrShort, `${psrShort}`);

    // ---- E. Deflated Sharpe Ratio -------------------------------------------
    check('expectedMaxSharpe is 0 for a single trial', expectedMaxSharpe({ trials: 1, trialsVariance: 0.1 }) === 0);
    const hurdle10 = expectedMaxSharpe({ trials: 10, trialsVariance: 1 });
    const hurdle100 = expectedMaxSharpe({ trials: 100, trialsVariance: 1 });
    check('expectedMaxSharpe increases with trials', hurdle100 > hurdle10 && hurdle10 > 0, `${hurdle10} -> ${hurdle100}`);
    check('hurdle scales with SR std (sqrt)', close(expectedMaxSharpe({ trials: 10, trialsVariance: 4 }), 2 * hurdle10, 1e-12));
    const psrRef = probabilisticSharpeRatio({ sharpe: 0.5, n: 100 });
    check('DSR(trials=1) === PSR(benchmark 0)', close(deflatedSharpeRatio({ sharpe: 0.5, n: 100, trials: 1 }), psrRef, 1e-12));
    const dsr10 = deflatedSharpeRatio({ sharpe: 0.5, n: 100, trials: 10, trialsVariance: 0.05 });
    check('DSR <= PSR for trials>1', dsr10 <= psrRef, `dsr=${dsr10} psr=${psrRef}`);
    check('DSR decreases as trials grow', deflatedSharpeRatio({ sharpe: 0.5, n: 100, trials: 100, trialsVariance: 0.05 }) <= dsr10);

    // ---- F. Minimum track record length -------------------------------------
    const mtrl = minimumTrackRecordLength({ sharpe: 0.5, benchmarkSR: 0, prob: 0.95 });
    check('MinTRL exact (SR=0.5, 95%)', close(mtrl, 13.174945, 1e-4), `${mtrl}`);
    check('MinTRL infinite when SR <= benchmark', minimumTrackRecordLength({ sharpe: 0.1, benchmarkSR: 0.2 }) === Infinity);
    check('MinTRL decreases as SR rises', minimumTrackRecordLength({ sharpe: 0.8 }) < mtrl);

    // ---- G. Stationary bootstrap --------------------------------------------
    const rets = [];
    for (let i = 0; i < 200; i++) rets.push(0.001 + 0.01 * Math.sin(i * 1.3) + 0.001 * ((i * 2654435761) % 1000) / 1000);
    const bs1 = stationaryBootstrapSharpe({ returns: rets, samples: 200, blockLength: 10, seed: 7 });
    const bs2 = stationaryBootstrapSharpe({ returns: rets, samples: 200, blockLength: 10, seed: 7 });
    check('bootstrap p-value in [0,1]', bs1.pValue >= 0 && bs1.pValue <= 1, `${bs1.pValue}`);
    check('bootstrap deterministic under seed', bs1.pValue === bs2.pValue, `${bs1.pValue} vs ${bs2.pValue}`);
    check('bootstrap observed Sharpe finite', Number.isFinite(bs1.observed));

    // ---- G2. Stationary bootstrap: calibrated size + power -------------------
    // The 5% test must reject ~5% of pure-noise series. Before the Politis-Romano
    // block-restart fix (BUGS.md #10) the sampler never re-drew a block start, so
    // its null Sharpe distribution was degenerate and it rejected ~17.5%.
    const bootRnd = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const noiseSeries = (seed, n) => { const r = bootRnd(seed); return Array.from({ length: n }, () => (r() - 0.5) * 0.02); };
    const CAL_N = 120;
    let falsePositives = 0;
    let pSum = 0;
    for (let s = 0; s < CAL_N; s++) {
        const pv = stationaryBootstrapSharpe({ returns: noiseSeries(1000 + s, 500), samples: 400, seed: 10 + s }).pValue;
        if (pv <= 0.05) falsePositives++;
        pSum += pv;
    }
    check('bootstrap null false-positive rate is calibrated (<= 10% at the 5% level)',
        falsePositives >= 1 && falsePositives <= Math.round(0.10 * CAL_N),
        `${falsePositives}/${CAL_N} rejected (expect ~${Math.round(0.05 * CAL_N)})`);
    check('bootstrap null p-values are centered near 0.5',
        Math.abs(pSum / CAL_N - 0.5) < 0.06, `meanP=${(pSum / CAL_N).toFixed(4)}`);
    const edge400 = Array.from({ length: 400 }, (_, i) => 0.004 + 0.003 * Math.sin(i * 0.7));
    check('bootstrap still detects a strong edge (p <= 0.01)',
        stationaryBootstrapSharpe({ returns: edge400, samples: 300, seed: 11 }).pValue <= 0.01,
        `${stationaryBootstrapSharpe({ returns: edge400, samples: 300, seed: 11 }).pValue}`);
    const driftP = [0, 0.001, 0.004, 0.01].map((d) =>
        stationaryBootstrapSharpe({ returns: Array.from({ length: 400 }, (_, i) => d + 0.005 * Math.sin(i * 0.9)), samples: 300, seed: 5 }).pValue);
    check('bootstrap p-value is monotone non-increasing in drift',
        driftP[0] > driftP[1] && driftP[1] >= driftP[2] && driftP[2] >= driftP[3] && driftP[3] <= 0.01,
        JSON.stringify(driftP));

    // ---- H. Purged K-fold ---------------------------------------------------
    const split = purgedKFoldSplit({ n: 20, k: 5, labelSpan: 2, embargo: 1 });
    check('purged split has k folds', split.length === 5, `k=${split.length}`);
    check('fold 0 test is first block', JSON.stringify(split[0].test) === JSON.stringify([0, 1, 2, 3]), JSON.stringify(split[0].test));
    check('fold 0 train starts after embargo', split[0].train.length > 0 && split[0].train[0] === split[0].embargoEnd + 1, `train0=${split[0].train[0]} embargoEnd=${split[0].embargoEnd}`);
    let disjoint = true;
    for (const f of split) {
        const ts = new Set(f.test);
        if (f.train.some((i) => ts.has(i))) disjoint = false;
    }
    check('train and test are disjoint in every fold', disjoint);
    let leaked = 0;
    for (const f of split) leaked += assertNoLeakage(f, { n: 20, labelSpan: 2 }).length;
    check('no label-window leakage in any fold', leaked === 0, `leaked=${leaked}`);
    check('label span normaliser handles integers', normalizeLabelSpans(null, 5, 2)[2][1] === 3, JSON.stringify(normalizeLabelSpans(null, 5, 2)));

    // ---- I. Walk-forward ----------------------------------------------------
    const wf = walkForwardSplit({ n: 20, trainSize: 5, testSize: 3 });
    check('walk-forward fold count', wf.length === 5, `folds=${wf.length}`);
    check('walk-forward fold 0 test === [5,6,7]', JSON.stringify(wf[0].test) === JSON.stringify([5, 6, 7]), JSON.stringify(wf[0].test));
    check('walk-forward train precedes test', wf.every((f) => f.train.every((i) => i < f.testStart)));
    const wfExp = walkForwardSplit({ n: 20, trainSize: 5, testSize: 3, expanding: true });
    check('expanding walk-forward anchors at 0', wfExp.every((f) => f.train[0] === 0));

    // ---- I2. Combinatorial purged CV (AFML ch. 12) --------------------------
    // C(k, m) folds; each test set a union of whole groups; each observation
    // tested exactly C(k-1, m-1) times = the number of backtest paths.
    const cpcv = combinatorialPurgedSplit({ n: 24, k: 6, testGroups: 2 });
    check('CPCV fold count is C(k, m)', cpcv.length === 15, `folds=${cpcv.length}`);
    check('each CPCV test set is a union of whole groups',
        cpcv.every((f) => f.test.length === 2 * (24 / 6)), `sizes=${cpcv.map((f) => f.test.length).join(',')}`);
    const cpcvAppear = new Array(24).fill(0);
    for (const f of cpcv) for (const i of f.test) cpcvAppear[i]++;
    check('each observation is tested exactly C(k-1, m-1) times',
        cpcvAppear.every((c) => c === 5), JSON.stringify(cpcvAppear));
    check('CPCV train/test are disjoint in every fold',
        cpcv.every((f) => { const s = new Set(f.test); return f.train.every((i) => !s.has(i)); }));
    let cpcvLeak = 0;
    const cpcvLabeled = combinatorialPurgedSplit({ n: 24, k: 6, testGroups: 2, labelSpan: 3 });
    for (const f of cpcvLabeled) cpcvLeak += assertNoLeakage(f, { n: 24, labelSpan: 3 }).length;
    check('CPCV has zero label-window leakage (purge matches the label span)', cpcvLeak === 0, `leaked=${cpcvLeak}`);
    const cpcvFull = combinatorialPurgedSplit({ n: 12, k: 4, testGroups: 3 });
    const cpcvFullAppear = new Array(12).fill(0);
    for (const f of cpcvFull) for (const i of f.test) cpcvFullAppear[i]++;
    check('CPCV m = k-1 gives k folds, each observation tested k-1 times',
        cpcvFull.length === 4 && cpcvFullAppear.every((c) => c === 3), `folds=${cpcvFull.length}`);
    const cpcvEmb = combinatorialPurgedSplit({ n: 24, k: 6, testGroups: 2, embargo: 2 });
    check('CPCV embargo monotonically shrinks the training set',
        cpcvEmb.every((f, i) => f.train.length <= cpcv[i].train.length));
    check('CPCV rejects an out-of-range testGroups',
        (() => { try { combinatorialPurgedSplit({ n: 24, k: 6, testGroups: 6 }); return false; } catch { return true; } })());
    const cpcvBt = purgedCVBacktest({ returns: Array.from({ length: 24 }, (_, i) => Math.sin(i * 0.5) * 0.01), signals: Array.from({ length: 24 }, () => 1), folds: cpcv, costBps: 0 });
    check('CPCV folds run through the backtest engine',
        cpcvBt.folds.length === 15 && Number.isFinite(cpcvBt.meanFoldSharpe), `folds=${cpcvBt.folds.length}`);

    // ---- J. Triple-barrier labels -------------------------------------------
    const tbPt = tripleBarrierLabels({ prices: [100, 101, 102, 101, 103, 99], events: [0], ptSl: [1, 1], vol: 2, maxHolding: 5 });
    check('triple-barrier profit-take first', tbPt.length === 1 && tbPt[0].label === 1 && tbPt[0].t1 === 2, JSON.stringify(tbPt));
    const tbSl = tripleBarrierLabels({ prices: [100, 97, 96, 101], events: [0], ptSl: [1, 1], vol: 2, maxHolding: 3 });
    check('triple-barrier stop-loss first', tbSl[0].label === -1 && tbSl[0].t1 === 1, JSON.stringify(tbSl));
    const tbVert = tripleBarrierLabels({ prices: [100, 100.5, 100.8, 100.9], events: [0], ptSl: [1, 1], vol: 2, maxHolding: 3 });
    check('triple-barrier vertical barrier => label 0', tbVert[0].label === 0 && tbVert[0].t1 === 3, JSON.stringify(tbVert));
    check('triple-barrier label is always in {-1,0,1}', tbPt.concat(tbSl, tbVert).every((r) => [-1, 0, 1].includes(r.label)));

    // ---- K. CUSUM event filter ----------------------------------------------
    const rising = [100, 101, 102, 103, 104];
    check('cusum emits on threshold breach', JSON.stringify(cusumFilter({ prices: rising, threshold: 2.5 })) === JSON.stringify([3]), JSON.stringify(cusumFilter({ prices: rising, threshold: 2.5 })));
    check('cusum silent on flat series', cusumFilter({ prices: [100, 100, 100, 100], threshold: 1 }).length === 0);
    check('cusum is monotone in threshold', cusumFilter({ prices: rising, threshold: 10 }).length <= cusumFilter({ prices: rising, threshold: 1 }).length);

    // ---- L. Fractional differentiation --------------------------------------
    check('FD weights d=1 => [1,-1,0]', JSON.stringify(fractionalDiffWeights(1, 3)) === JSON.stringify([1, -1, 0]), JSON.stringify(fractionalDiffWeights(1, 3)));
    check('FD weights d=0.5 => [1,-0.5,-0.125]', JSON.stringify(fractionalDiffWeights(0.5, 3)) === JSON.stringify([1, -0.5, -0.125]), JSON.stringify(fractionalDiffWeights(0.5, 3)));
    check('FD default window is bounded', fractionalDiffWeights(0.4, 0).length === DEFAULT_FD_WINDOW, `len=${fractionalDiffWeights(0.4, 0).length}`);
    const fd1 = fractionalDiff([1, 2, 4, 7], 1, 0);
    check('FD d=1 is the first difference', Number.isNaN(fd1[0]) && fd1[1] === 1 && fd1[2] === 2 && fd1[3] === 3, JSON.stringify(fd1));
    const lin = fractionalDiff([0, 2, 4, 6, 8, 10], 1, 0);
    check('FD d=1 makes a linear series stationary (constant)', lin.slice(1).every((v) => close(v, 2, 1e-9)), JSON.stringify(lin));
    check('FD of log-prices is finite after warmup', fracDiffLogPrices([100, 101, 102, 103, 104, 105], 0.4, 5).slice(4).every(Number.isFinite));

    // ---- M. Sample uniqueness ------------------------------------------------
    const u = sampleUniqueness([[0, 2], [1, 3]]);
    check('uniqueness exact for overlapping labels', close(u[0], 2 / 3, 1e-12) && close(u[1], 2 / 3, 1e-12), JSON.stringify(u));
    check('average uniqueness exact', close(averageUniqueness([[0, 2], [1, 3]]), 2 / 3, 1e-12));
    check('ESS of point labels === n', close(effectiveSampleSize([[0, 0], [1, 1], [2, 2]]), 3, 1e-12));
    check('ESS of overlapping labels < n', effectiveSampleSize([[0, 2], [1, 3]]) < 2);
    const seq1 = sequentialBootstrap({ labelSpans: [[0, 1], [1, 2], [2, 3], [3, 4]], size: 8, seed: 3 });
    const seq2 = sequentialBootstrap({ labelSpans: [[0, 1], [1, 2], [2, 3], [3, 4]], size: 8, seed: 3 });
    check('sequential bootstrap length correct', seq1.length === 8, `len=${seq1.length}`);
    check('sequential bootstrap deterministic under seed', JSON.stringify(seq1) === JSON.stringify(seq2));
    check('sequential bootstrap indices in range', seq1.every((i) => i >= 0 && i < 4));

    // ---- N. Evaluate-strategy summary ---------------------------------------
    const ev = evaluateStrategy(rets, { periodsPerYear: 252, trials: 12 });
    check('evaluateStrategy returns finite core fields',
        Number.isFinite(ev.sharpe) && Number.isFinite(ev.psr) && Number.isFinite(ev.dsr)
        && Number.isFinite(ev.minTrackRecordLength) && Number.isFinite(ev.skew) && Number.isFinite(ev.kurtosis),
        JSON.stringify(ev));
    check('evaluateStrategy dsr <= psr', ev.dsr <= ev.psr + 1e-12);

    // ---- O. Backtest engine: exact arithmetic -------------------------------
    const pos = positionsFromSignals([1, 1, 1], { lag: 1 });
    check('positions lag by one bar', JSON.stringify(pos) === JSON.stringify([0, 1, 1]), JSON.stringify(pos));
    check('turnover counts the initial entry', turnover([0, 1, 1]) === 1);
    check('tradeCount counts transitions', tradeCount([0, 1, 1, -1, 0]) === 3, `${tradeCount([0, 1, 1, -1, 0])}`);
    const sr = strategyReturns({ returns: [0.01, 0.02, 0.03], signals: [1, 1, 1], costBps: 10 });
    check('strategy returns exact (gross)',
        close(sr.gross[0], 0, 1e-12) && close(sr.gross[1], 0.02, 1e-12) && close(sr.gross[2], 0.03, 1e-12),
        JSON.stringify(sr.gross));
    check('strategy returns charge cost on entry',
        close(sr.returns[0], 0, 1e-12) && close(sr.returns[1], 0.019, 1e-12) && close(sr.returns[2], 0.03, 1e-12),
        JSON.stringify(sr.returns));
    check('strategy totalCost exact', close(sr.cost.reduce((a, b) => a + b, 0), 0.001, 1e-12));
    check('maxDrawdown exact', close(maxDrawdown(equityCurve([0.1, -0.5, 0.25])), 0.5, 1e-12), `${maxDrawdown(equityCurve([0.1, -0.5, 0.25]))}`);
    check('hitRate excludes flat bars', close(hitRate([0, 0.01, -0.02, 0, 0.03]), 2 / 3, 1e-12), `${hitRate([0, 0.01, -0.02, 0, 0.03])}`);

    // ---- P. Backtest engine: it must not bless noise ------------------------
    // Deterministic zero-mean-ish return series.
    const rnd = (() => { let a = 12345 >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
    const mkt = Array.from({ length: 400 }, () => (rnd() - 0.5) * 0.04);
    const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const foresight = mkt.map((_, t) => sign(mkt[t + 1] ?? 0));
    const anti = mkt.map((_, t) => -sign(mkt[t + 1] ?? 0));
    const good = backtestMetrics({ returns: mkt, signals: foresight, costBps: 0 });
    const bad = backtestMetrics({ returns: mkt, signals: anti, costBps: 0 });
    check('foresight signal is significant (PSR > 0.99)', good.psr > 0.99, `psr=${good.psr}`);
    check('foresight has (almost) no drawdown', good.maxDrawdown < 0.05, `mdd=${good.maxDrawdown}`);
    check('anti signal is not significant (PSR < 0.01)', bad.psr < 0.01, `psr=${bad.psr}`);
    check('anti signal has negative Sharpe', bad.netSharpe < 0, `sr=${bad.netSharpe}`);
    check('anti signal drawdown is severe', bad.maxDrawdown > 0.5, `mdd=${bad.maxDrawdown}`);
    const choppy = mkt.map((_, t) => (t % 2 ? 1 : -1));
    const cheap = backtestMetrics({ returns: mkt, signals: choppy, costBps: 0 });
    const pricey = backtestMetrics({ returns: mkt, signals: choppy, costBps: 50 });
    check('costs cannot improve net Sharpe', pricey.netSharpe <= cheap.netSharpe, `${cheap.netSharpe} -> ${pricey.netSharpe}`);
    check('costs are monotone in costBps', pricey.totalCost > cheap.totalCost);
    check('zero-skill random signal is not significant (DSR < 0.95)',
        backtestMetrics({ returns: mkt, signals: mkt.map(() => (rnd() < 0.5 ? 1 : -1)), costBps: 0, trials: 1 }).dsr < 0.95);

    // ---- Q. Purged-CV backtest + annualization ------------------------------
    const cvReturns = Array.from({ length: 64 }, (_, i) => 0.001 + 0.01 * Math.sin(i * 0.7));
    const cvFolds = purgedKFoldSplit({ n: 64, k: 4, labelSpan: 2, embargo: 1 });
    const cv = purgedCVBacktest({ returns: cvReturns, signals: cvReturns.map(() => 1), folds: cvFolds, costBps: 0 });
    check('purged-CV backtest has one report per fold', cv.folds.length === 4, `folds=${cv.folds.length}`);
    check('purged-CV pooled bars > 0', cv.pooledBars > 0, `bars=${cv.pooledBars}`);
    check('purged-CV mean fold Sharpe finite', Number.isFinite(cv.meanFoldSharpe));
    // The pooled report must be a *strategy* summary, not an all-long overlay of
    // the pooled net stream (which made pooled turnover structurally 1 and
    // grossSharpe == netSharpe even under costs). See BUGS.md #11.
    check('purged-CV pooled turnover is the sum of per-fold turnover',
        close(cv.pooledMetrics.turnover, cv.folds.reduce((a, f) => a + f.metrics.turnover, 0), 1e-12),
        `pooled=${cv.pooledMetrics.turnover} sum=${cv.folds.reduce((a, f) => a + f.metrics.turnover, 0)}`);
    check('purged-CV pooled tradeCount/cost are the per-fold sums',
        cv.pooledMetrics.tradeCount === cv.folds.reduce((a, f) => a + f.metrics.tradeCount, 0) &&
        close(cv.pooledMetrics.totalCost, cv.folds.reduce((a, f) => a + f.metrics.totalCost, 0), 1e-12));
    const cvCost = purgedCVBacktest({ returns: cvReturns, signals: cvReturns.map(() => 1), folds: cvFolds, costBps: 10 });
    check('purged-CV gross Sharpe exceeds net Sharpe under costs',
        cvCost.pooledMetrics.grossSharpe > cvCost.pooledMetrics.netSharpe,
        `gross=${cvCost.pooledMetrics.grossSharpe} net=${cvCost.pooledMetrics.netSharpe}`);
    check('annualizedReturn increases with returns',
        annualizedReturn(cvReturns) > annualizedReturn(cvReturns.map((r) => r * 0.1)),
        `${annualizedReturn(cvReturns)}`);

    // ---- R. Full pipeline control on a pure random walk ---------------------
    // End to end: driftless GBM -> CUSUM events -> triple-barrier labels ->
    // uniqueness -> purged-CV backtest -> PSR/DSR. A driftless walk has no edge,
    // so the machinery must not manufacture significance from it, and the
    // multiple-testing hurdle must rise with the number of trials.
    {
        const walkRnd = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const gauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const SIGMA = 0.008;
        const N = 1200;
        const r = walkRnd(20260918);
        const prices = new Array(N);
        prices[0] = 100;
        for (let t = 1; t < N; t++) prices[t] = prices[t - 1] * Math.exp(SIGMA * gauss(r));
        const walkReturns = new Array(N).fill(0);
        for (let t = 1; t < N; t++) walkReturns[t] = prices[t] / prices[t - 1] - 1;

        const eventsLoose = cusumFilter({ prices, threshold: 2.0 * SIGMA * 100 });
        const eventsTight = cusumFilter({ prices, threshold: 3.0 * SIGMA * 100 });
        check('CUSUM sampling keeps only a minority of bars', eventsLoose.length > 0 && eventsLoose.length < N * 0.35,
            `events=${eventsLoose.length}/${N}`);
        check('CUSUM events are monotone decreasing in the threshold', eventsTight.length < eventsLoose.length,
            `tight=${eventsTight.length} loose=${eventsLoose.length}`);

        const labelled = tripleBarrierLabels({
            prices, events: eventsLoose, ptSl: [1, 1],
            vol: (i) => prices[i] * SIGMA * Math.sqrt(20), maxHolding: 20,
        });
        check('triple-barrier labels land in {-1,0,1} with a forward window',
            labelled.length === eventsLoose.length &&
            labelled.every((l) => [-1, 0, 1].includes(l.label) && l.t1 >= l.event && l.t1 <= l.event + 20),
            JSON.stringify(labelled.slice(0, 3)));
        const spans = labelled.map((l) => [l.event, l.t1]);
        const avgU = averageUniqueness(spans);
        const ess = effectiveSampleSize(spans);
        check('overlapping labels push average uniqueness below 1', avgU > 0 && avgU < 1, `avgU=${avgU}`);
        check('effective sample size is far below the nominal count', ess > 0 && ess < spans.length * 0.5,
            `ess=${ess} nominal=${spans.length}`);

        const folds = purgedKFoldSplit({ n: N, k: 6, labelSpan: 20, embargo: 5 });
        const sr = walkRnd(777);
        const zeroSkill = Array.from({ length: N }, () => (sr() < 0.5 ? 1 : -1));
        const cv = purgedCVBacktest({ returns: walkReturns, signals: zeroSkill, folds, costBps: 5 });
        check('purged-CV zero-skill backtest is not significant (DSR < 0.95)',
            Number.isFinite(cv.pooledMetrics.dsr) && cv.pooledMetrics.dsr < 0.95,
            `dsr=${cv.pooledMetrics.dsr}`);
        check('purged-CV zero-skill PSR is not extreme',
            Number.isFinite(cv.pooledMetrics.psr) && cv.pooledMetrics.psr < 0.95,
            `psr=${cv.pooledMetrics.psr}`);
        const hurdleSharpe = 0.2;
        const dsr1 = deflatedSharpeRatio({ sharpe: hurdleSharpe, n: 300, trials: 1 });
        const dsr200 = deflatedSharpeRatio({ sharpe: hurdleSharpe, n: 300, trials: 200 });
        check('multiple-testing hurdle is monotone in the number of trials', dsr200 < dsr1,
            `trials=1:${dsr1} trials=200:${dsr200}`);
    }

    // ---- S. Walk-forward harness: protocol, no-lookahead audit, promotion ----
    // The harness is the honesty layer over backtest.js: it (1) requires a
    // *causal* split (train strictly before test), (2) *tests* rather than
    // assumes no-lookahead, and (3) turns feature promotion into a rule that
    // cannot be won by one lucky fold.
    {
        const br = barReturns([100, 110, 99]);
        check('barReturns exact (close-to-close, r[0]=0)',
            close(br[0], 0, 1e-12) && close(br[1], 0.1, 1e-12) && close(br[2], -0.1, 1e-12), JSON.stringify(br));
        const lr = logReturns([100, 110, 99]);
        check('logReturns exact',
            close(lr[0], 0, 1e-15) && close(lr[1], Math.log(1.1), 1e-12) && close(lr[2], Math.log(0.9), 1e-12), JSON.stringify(lr));

        check('probToPosition abstains at p=50', probToPosition(50) === 0);
        check('probToPosition saturates at p=100 / p=0',
            probToPosition(100, { direction: 1 }) === 1 && probToPosition(0, { direction: -1 }) === 1);
        check('probToPosition is odd about p=50',
            close(probToPosition(75), -probToPosition(25), 1e-12) && close(probToPosition(80), -probToPosition(20), 1e-12));
        let mono = true; let prev = -2;
        for (let p = 0; p <= 100; p += 0.5) { const v = probToPosition(p); if (v < prev - 1e-12) mono = false; prev = v; }
        check('probToPosition monotone in p', mono);
        check('probToPosition dead zone abstains and is bounded',
            probToPosition(52, { deadZone: 0.1 }) === 0 && probToPosition(60, { deadZone: 0.1 }) > 0 &&
            Math.abs(probToPosition(100, { scale: 0.5 })) <= 0.5 && Math.abs(probToPosition(0, { scale: 0.5 })) <= 0.5,
            `p60=${probToPosition(60, { deadZone: 0.1 })}`);
        check('probToPosition clamps out-of-range p (and direction flips sign)',
            probToPosition(150) === 1 && probToPosition(-20) === -1 && probToPosition(100, { direction: -1 }) === -1);

        // --- R26-3: the one confidence -> position pipeline ------------------
        check('R26-3: confidenceFromProb is the exact clamped (prob-50)/50',
            confidenceFromProb(50) === 0 && confidenceFromProb(100) === 1 && confidenceFromProb(0) === -1 &&
            confidenceFromProb(150) === 1 && confidenceFromProb(-10) === -1);
        check('R26-3: confidenceToPosition generalises probToPosition on the whole controller domain',
            (() => {
                for (let p = 0; p <= 100; p += 0.5) {
                    if (probToPosition(p, { deadZone: 0.05, scale: 1 }) !== confidenceToPosition(confidenceFromProb(p), { deadZone: 0.05, scale: 1 })) return false;
                }
                return true;
            })());
        check('R26-3: confidenceToPosition is sign-preserving, bounded, dead-zoned and finite-safe',
            confidenceToPosition(1) === 1 && confidenceToPosition(-1) === -1 &&
            confidenceToPosition(0.5, { scale: 0.5 }) === 0.25 &&
            confidenceToPosition(0.4, { deadZone: 0.5 }) === 0 &&
            confidenceToPosition(NaN) === 0 && confidenceToPosition(Infinity) === 0 &&
            confidenceToPosition(2) === 1 && confidenceToPosition(-2) === -1);
        check('R26-3: verifyPolicyRoundTrip rejects a wrong policy and accepts the scored one',
            (() => {
                const rep = {
                    foldInputs: [{
                        returns: [0.01, -0.01],
                        signals: [confidenceToPosition(0.3, { deadZone: 0.05 }), 0],
                        confidence: [0.3, 0.01],
                    }],
                };
                return verifyPolicyRoundTrip(rep, { deadZone: 0.05 }).ok === true &&
                    verifyPolicyRoundTrip(rep, { deadZone: 0.5 }).mismatch > 0;
            })());
        check('R26-3: restateReportAtPolicy reproduces the scored positions and reshapes participation with the dead zone',
            (() => {
                const conf = [0.02, 0.3, -0.4, 0.01];
                const scored = { deadZone: 0.05, scale: 1 };
                const foldInputs = [{ returns: [0.01, 0.02, -0.03, 0.001], signals: conf.map((c) => confidenceToPosition(c, scored)), confidence: conf }];
                const report = {
                    foldInputs, folds: [{ testStart: 0, testEnd: 3 }], streamFoldLengths: [[4]],
                };
                const wide = restateReportAtPolicy(report, { deadZone: 0.5, scale: 1 });
                const same = restateReportAtPolicy(report, scored);
                return same.positions[0].every((p, i) => p === foldInputs[0].signals[i]) &&
                    wide.positions[0][0] === 0 && wide.positions[0][1] === 0 &&
                    wide.pooledMetrics.nonZeroFraction <= same.pooledMetrics.nonZeroFraction;
            })());

        check('walk-forward folds are causal', walkForwardSplit({ n: 20, trainSize: 5, testSize: 3 }).every(isCausalFold));
        check('purged K-fold folds are (correctly) not all causal',
            !purgedKFoldSplit({ n: 20, k: 4, labelSpan: 2, embargo: 1 }).every(isCausalFold));
        // BUGS.md #12: a non-positive/non-finite `step` used to make the fold loop
        // never advance — an infinite hang, not an error. It must throw instead.
        let wfStepThrew = 0;
        for (const badStep of [0, -1, NaN, Infinity]) {
            try { walkForwardSplit({ n: 20, trainSize: 5, testSize: 3, step: badStep }); } catch { wfStepThrew++; }
        }
        check('walkForwardSplit rejects a non-positive/non-finite step (BUGS.md #12)',
            wfStepThrew === 4, `threw=${wfStepThrew}`);
        check('walkForwardSplit still accepts a positive step',
            walkForwardSplit({ n: 20, trainSize: 5, testSize: 3, step: 2 }).length === 7,
            `folds=${walkForwardSplit({ n: 20, trainSize: 5, testSize: 3, step: 2 }).length}`);

        const agg = aggregateFolds([{ metrics: { netSharpe: 1 } }, { metrics: { netSharpe: 2 } }, { metrics: { netSharpe: 3 } }, { metrics: { netSharpe: 4 } }]);
        check('aggregateFolds mean/median/std exact',
            close(agg.mean, 2.5, 1e-12) && close(agg.median, 2.5, 1e-12) && close(agg.std, Math.sqrt(5 / 3), 1e-12) && agg.positiveFraction === 1,
            JSON.stringify(agg));
        check('aggregateFolds positive fraction exact',
            close(aggregateFolds([{ metrics: { netSharpe: 1 } }, { metrics: { netSharpe: -1 } }]).positiveFraction, 0.5, 1e-12));
        check('aggregateFolds ignores non-finite folds',
            close(aggregateFolds([{ metrics: { netSharpe: 2 } }, { metrics: { netSharpe: NaN } }]).mean, 2, 1e-12));
        check('foldWinFraction exact', close(foldWinFraction(
            [{ metrics: { netSharpe: 2 } }, { metrics: { netSharpe: -1 } }],
            [{ metrics: { netSharpe: 1 } }, { metrics: { netSharpe: 0 } }]), 0.5, 1e-12));

        // ---- the flagship: the audit must *catch* lookahead, not assume it ----
        const auditFolds = walkForwardSplit({ n: 30, trainSize: 12, testSize: 6 });
        const aReturns = Array.from({ length: 30 }, (_, i) => Math.sin(i * 0.7) * 0.01);
        const causalSignal = (train, test, view) => test.map((t) => Math.sign(view.returns[t]));
        const leakySignal = (train, test, view) => test.map((t) => view.returns[t] + (view.returns[t + 1] ?? 0));
        const meanSignal = (train, test, view) => {
            const m = view.returns.reduce((a, b) => a + b, 0) / view.returns.length;
            return test.map(() => m);
        };
        const auCausal = auditNoLookahead({ signalForFold: causalSignal, folds: auditFolds, returns: aReturns });
        const auLeaky = auditNoLookahead({ signalForFold: leakySignal, folds: auditFolds, returns: aReturns });
        const auMean = auditNoLookahead({ signalForFold: meanSignal, folds: auditFolds, returns: aReturns });
        check('audit passes a strictly causal signal', auCausal.clean, JSON.stringify(auCausal.violations.slice(0, 3)));
        check('audit flags a signal that peeks at t+1',
            !auLeaky.clean && auLeaky.violations.length === 17 && auLeaky.violations.every((v) => v.index < 29),
            `violations=${auLeaky.violations.length}`);
        check('audit flags a full-sample-mean signal', !auMean.clean && auMean.violations.length > 0,
            `violations=${auMean.violations.length}`);
        check('audit probes every test bar', auCausal.probes === 18, `probes=${auCausal.probes}`);

        let threw = false;
        try {
            walkForwardEvaluate({ returns: aReturns, folds: purgedKFoldSplit({ n: 30, k: 3, labelSpan: 2, embargo: 1 }), signalForFold: causalSignal });
        } catch { threw = true; }
        check('walkForwardEvaluate rejects non-causal folds', threw);

        const wfReport = walkForwardEvaluate({ returns: aReturns, folds: auditFolds, signalForFold: causalSignal, costBps: 2 });
        check('walk-forward report aggregates + clean audit',
            wfReport.folds.length === 3 && Number.isFinite(wfReport.aggregate.mean) && wfReport.audit.clean && wfReport.pooledBars > 0,
            JSON.stringify({ folds: wfReport.folds.length, mean: wfReport.aggregate.mean, audit: wfReport.audit.clean }));
        check('formatReport renders a finite summary',
            typeof formatReport(wfReport, { label: 'x' }) === 'string' && formatReport(wfReport).includes('audit'));

        // ---- promotion: size (no false edge) and power (a real edge) ----------
        const seedRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const gauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const makeWalk = (seed, n, rho = 0) => {
            const r = seedRng(seed);
            const out = new Array(n).fill(0);
            for (let t = 1; t < n; t++) out[t] = rho * out[t - 1] + 0.01 * gauss(r);
            return out;
        };
        const wfFolds = walkForwardSplit({ n: 200, trainSize: 100, testSize: 20 });
        const randomSignal = (seed) => {
            const r = seedRng(seed);
            return (train, test, view) => test.map(() => (r() < 0.5 ? 1 : -1));
        };
        let falsePromotions = 0;
        const ROUNDS = 40;
        for (let s = 0; s < ROUNDS; s++) {
            const rets = makeWalk(1000 + s, 200, 0);
            const base = walkForwardEvaluate({ returns: rets, folds: wfFolds, signalForFold: randomSignal(500 + s), costBps: 1, audit: false });
            const cand = walkForwardEvaluate({ returns: rets, folds: wfFolds, signalForFold: randomSignal(900 + s), costBps: 1, audit: false });
            if (promoteDecision(base, cand, { requireCleanAudit: false }).promote) falsePromotions++;
        }
        check('promotion size: a zero-skill candidate is rarely promoted',
            falsePromotions <= 8, `falsePromotions=${falsePromotions}/${ROUNDS}`);
        check('promotion size: the absolute DSR floor is what suppresses noise',
            (() => { let rel = 0; for (let s = 0; s < 12; s++) { const rets = makeWalk(3000 + s, 200, 0); const base = walkForwardEvaluate({ returns: rets, folds: wfFolds, signalForFold: randomSignal(1500 + s), costBps: 1, audit: false }); const cand = walkForwardEvaluate({ returns: rets, folds: wfFolds, signalForFold: randomSignal(1700 + s), costBps: 1, audit: false }); if (promoteDecision(base, cand, { minDsr: 0, requireCleanAudit: false }).promote) rel++; } return rel > 0; })(), `relative-only promotions in 12 seeds`);

        const arRets = makeWalk(4242, 600, 0.4);
        const arFolds = walkForwardSplit({ n: 600, trainSize: 200, testSize: 50 });
        const momentum = (train, test, view) => test.map((t) => Math.sign(view.returns[t]));
        const arBase = walkForwardEvaluate({ returns: arRets, folds: arFolds, signalForFold: randomSignal(77), costBps: 1, audit: false });
        const arCand = walkForwardEvaluate({ returns: arRets, folds: arFolds, signalForFold: momentum, costBps: 1, audit: true });
        check('promotion power: a causal momentum edge beats the baseline',
            arCand.pooledMetrics.netSharpe > arBase.pooledMetrics.netSharpe && arCand.audit.clean,
            `cand=${arCand.pooledMetrics.netSharpe} base=${arBase.pooledMetrics.netSharpe}`);
        check('promotion power: the edge is promoted',
            promoteDecision(arBase, arCand).promote,
            JSON.stringify(promoteDecision(arBase, arCand).reasons));

        // ---- promotion rule: every hurdle is load-bearing ---------------------
        const b = { aggregate: { mean: 1, positiveFraction: 0.5 }, pooledMetrics: { dsr: 0.95 }, folds: [{ metrics: { netSharpe: 1 } }, { metrics: { netSharpe: 1 } }], audit: { clean: true } };
        const c = { aggregate: { mean: 2, positiveFraction: 0.5 }, pooledMetrics: { dsr: 0.98 }, folds: [{ metrics: { netSharpe: 2 } }, { metrics: { netSharpe: 2 } }], audit: { clean: true } };
        check('promoteDecision promotes a dominating candidate', promoteDecision(b, c).promote);
        check('promoteDecision rejects a Sharpe regression', !promoteDecision(b, { ...c, aggregate: { mean: 0.5, positiveFraction: 0.5 } }).promote);
        check('promoteDecision rejects a DSR regression', !promoteDecision(b, { ...c, pooledMetrics: { dsr: 0.80 } }).promote);
        check('promoteDecision rejects a dirty audit', !promoteDecision(b, { ...c, audit: { clean: false, violations: [{}] } }).promote);
        check('promoteDecision rejections name the failing hurdle',
            promoteDecision(b, { ...c, pooledMetrics: { dsr: 0.80 } }).reasons.some((r) => r.includes('DSR')));
        const bLow = { ...b, pooledMetrics: { dsr: 0.5 } };
        check('promoteDecision enforces the absolute DSR floor',
            !promoteDecision(bLow, { ...c, pooledMetrics: { dsr: 0.90 } }).promote &&
            promoteDecision(bLow, { ...c, pooledMetrics: { dsr: 0.96 } }).promote);
        {
            const b3 = { ...b, folds: [{ metrics: { netSharpe: 1 } }, { metrics: { netSharpe: 1 } }, { metrics: { netSharpe: 1 } }] };
            const c3 = { ...c, folds: [{ metrics: { netSharpe: 2 } }, { metrics: { netSharpe: 0 } }, { metrics: { netSharpe: 2 } }] };
            const r = promoteDecision(b3, c3, { minFoldWinFraction: 0.9 });
            check('promoteDecision enforces the fold-win floor', !r.promote && r.reasons.some((x) => x.includes('fold win')), JSON.stringify(r.reasons));
        }
    }

    // ---- T. Probability of backtest overfitting (CSCV, Bailey et al. 2016) ---
    // The non-parametric companion to the deflated Sharpe: it needs only the
    // matrix of candidate returns, and makes selection bias a measurable
    // probability ("the in-sample winner has no out-of-sample edge") instead of
    // an assumption about independence or Normality.
    {
        const tBlocks = cscvBlocks(10, 4);
        check('cscvBlocks partitions exactly (remainder on the first blocks)',
            JSON.stringify(tBlocks) === JSON.stringify([[0, 1, 2], [3, 4, 5], [6, 7], [8, 9]]), JSON.stringify(tBlocks));

        const tSplits = cscvSplit({ n: 8, blocks: 4 });
        check('cscvSplit enumerates C(S,S/2) splits', tSplits.length === 6, `${tSplits.length}`);
        check('every split is a disjoint cover of the timeline',
            tSplits.every((sp) => sp.is.length === 4 && sp.oos.length === 4 &&
                sp.is.every((i) => !sp.oos.includes(i))));
        const blockCounts = new Array(4).fill(0);
        for (const sp of tSplits) for (const b of sp.isBlocks) blockCounts[b]++;
        check('each block is in exactly C(S-1,S/2-1) in-sample sets',
            JSON.stringify(blockCounts) === JSON.stringify([3, 3, 3, 3]), JSON.stringify(blockCounts));
        const key = (b) => b.slice().sort((a, c) => a - c).join(',');
        const isKeys = new Set(tSplits.map((sp) => key(sp.isBlocks)));
        check('split set is closed under complement',
            tSplits.every((sp) => isKeys.has(key([0, 1, 2, 3].filter((b) => !sp.isBlocks.includes(b))))));

        check('relativeRank: best is N/(N+1)', close(relativeRank([1, 2, 3], 2), 3 / 4, 1e-12));
        check('relativeRank: worst is 1/(N+1)', close(relativeRank([1, 2, 3], 0), 1 / 4, 1e-12));
        check('relativeRank: full tie is exactly 1/2', close(relativeRank([5, 5, 5], 0), 0.5, 1e-12));
        check('relativeRank is strictly inside (0,1)',
            relativeRank([1, 2, 3, 4], 3) < 1 && relativeRank([1, 2, 3, 4], 0) > 0);
        check('oosOnIsRegression exact (identity)', (() => { const r = oosOnIsRegression([1, 2, 3], [1, 2, 3]); return close(r.slope, 1) && close(r.intercept, 0) && close(r.r2, 1); })());
        check('oosOnIsRegression exact (reflection slope -1)', close(oosOnIsRegression([1, 2, 3], [3, 2, 1]).slope, -1, 1e-12));

        const seedRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const gauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

        // (1) Pure noise: every strategy has zero skill, so whichever one wins
        // in-sample is a coin flip out-of-sample and PBO sits at ~0.5.
        const noiseR = seedRng(20240);
        const noise = Array.from({ length: 20 }, () => Array.from({ length: 500 }, () => 0.01 * gauss(noiseR)));
        const noisePbo = probabilityOfBacktestOverfitting(noise, { blocks: 10 });
        check('PBO of pure noise is ~0.5', noisePbo.pbo > 0.35 && noisePbo.pbo < 0.65, `pbo=${noisePbo.pbo}`);
        check('PBO enumerates C(10,5) = 252 symmetric splits', noisePbo.splits === 252, `${noisePbo.splits}`);
        check('noise degradation slope ~0', Math.abs(noisePbo.degradation.slope) < 0.15, `slope=${noisePbo.degradation.slope}`);

        // (2) A genuine persistent edge: the IS winner also wins OOS, so PBO -> 0.
        const edgeR = seedRng(777);
        const withEdge = Array.from({ length: 20 }, (_, j) =>
            Array.from({ length: 500 }, () => (j === 0 ? 0.4 : 0) + 0.01 * gauss(edgeR)));
        const edgePbo = probabilityOfBacktestOverfitting(withEdge, { blocks: 10 });
        check('PBO collapses on a persistent edge', edgePbo.pbo <= 0.05, `pbo=${edgePbo.pbo}`);
        check('persistent edge: IS and OOS performance are positively related',
            edgePbo.degradation.slope > 0, `slope=${edgePbo.degradation.slope}`);

        // (3) A planted regime flip: whichever strategy is best in-sample is
        // worst out-of-sample, so PBO is near 1. Sign dominates a small wiggle so
        // the per-slice Sharpe is well-defined.
        const T3 = 400;
        const antiR = seedRng(31337);
        const anti = [
            Array.from({ length: T3 }, (_, t) => (t < T3 / 2 ? 0.3 : -0.3) + 0.05 * gauss(antiR)),
            Array.from({ length: T3 }, (_, t) => (t < T3 / 2 ? -0.3 : 0.3) + 0.05 * gauss(antiR)),
        ];
        const antiPbo = probabilityOfBacktestOverfitting(anti, { blocks: 10 });
        check('PBO detects a planted regime flip', antiPbo.pbo >= 0.9, `pbo=${antiPbo.pbo}`);

        // (4) All-flat strategies: no OOS edge can exist, and the documented tie
        // convention (average rank -> omega = 0.5 -> lambda = 0) gives PBO = 1.
        const flatPbo = probabilityOfBacktestOverfitting([new Array(40).fill(0), new Array(40).fill(0)], { blocks: 4 });
        check('all-flat strategies give PBO === 1 (tie convention)', flatPbo.pbo === 1, `pbo=${flatPbo.pbo}`);

        // (5) Input contract.
        let threwPbo = 0;
        try { probabilityOfBacktestOverfitting([new Array(40).fill(0)], { blocks: 4 }); } catch { threwPbo++; }
        try { probabilityOfBacktestOverfitting([[0, 1], [0]], { blocks: 2 }); } catch { threwPbo++; }
        try { probabilityOfBacktestOverfitting([new Array(40).fill(0), new Array(40).fill(0)], { blocks: 3 }); } catch { threwPbo++; }
        try { probabilityOfBacktestOverfitting([new Array(6).fill(0), new Array(6).fill(0)], { blocks: 4 }); } catch { threwPbo++; }
        check('PBO rejects invalid inputs (too few strategies / ragged / odd blocks / too few bars)',
            threwPbo === 4, `threw=${threwPbo}`);
        // BUGS.md #13: an astronomical C(S,S/2) / C(k,m) must be rejected up front,
        // not attempted (the enumeration would hang/OOM).
        let capThrew = 0;
        try { cscvSplit({ n: 200, blocks: 60 }); } catch { capThrew++; }
        try { combinatorialPurgedSplit({ n: 200, k: 40, testGroups: 20 }); } catch { capThrew++; }
        check('combinatorial splitters reject an astronomical enumeration (BUGS.md #13)',
            capThrew === 2, `threw=${capThrew}`);
    }

    // ---- U. Reality Check & Hansen SPA (White 2000; Hansen 2005) -------------
    // The multiple-testing companions to the deflated Sharpe and PBO. Both
    // bootstrap the MAX statistic over the SAME resampled timeline for every
    // candidate, so the cross-sectional dependence that naive per-strategy
    // p-values ignore is preserved. RC (White 2000) is the un-studentized max of
    // sqrt(T)*mean(f_k); SPA (Hansen 2005) studentizes each candidate by its own
    // bootstrap standard error and takes max(0, .), which is provably less
    // conservative than RC when many candidates are poor and noisy.
    {
        const uRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const uGauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const uMatrix = (K, T, seed, fn) => { const r = uRng(seed); return Array.from({ length: K }, (_, k) => Array.from({ length: T }, (_, t) => fn(k, t, r))); };

        // --- benchmark handling ---
        check('benchmarkSeries(scalar) fills a constant series', Array.from(benchmarkSeries(0.02, 3)).every((v) => v === 0.02));
        check('benchmarkSeries(null) is a zero series', Array.from(benchmarkSeries(null, 3)).every((v) => v === 0));
        const relScalar = relativePerformance([[1, 2, 3], [4, 5, 6]], 2);
        check('relativePerformance subtracts a scalar benchmark (means 0 and 3)',
            close(mean(relScalar.rel[0]), 0) && close(mean(relScalar.rel[1]), 3), JSON.stringify([mean(relScalar.rel[0]), mean(relScalar.rel[1])]));
        const relSeries = relativePerformance([[1, 2, 3], [4, 5, 6]], [1, 1, 1]);
        check('relativePerformance subtracts a benchmark series elementwise',
            relSeries.rel[0][0] === 0 && relSeries.rel[1][2] === 5);
        const relZero = relativePerformance([[1, 2, 3], [4, 5, 6]]);
        check('relativePerformance default benchmark is zero', close(mean(relZero.rel[0]), 2) && close(mean(relZero.rel[1]), 5));

        // --- White's Reality Check: exact statistic ---
        const rcExact = whiteRealityCheck({ returnsMatrix: [new Array(100).fill(0.2), new Array(100).fill(0.1)], nBoot: 100, seed: 1 });
        check('RC statistic is exactly sqrt(T) * max mean', close(rcExact.statistic, Math.sqrt(100) * 0.2, 1e-9), `${rcExact.statistic}`);
        check('RC selects the best candidate index', rcExact.bestIndex === 0);
        check('RC statistic with a shifted best candidate stays sqrt(T)*max mean',
            close(whiteRealityCheck({ returnsMatrix: [new Array(100).fill(0.2), new Array(100).fill(0.15)], nBoot: 100, seed: 1 }).statistic, 2, 1e-9));
        const rcNull = whiteRealityCheck({ returnsMatrix: [new Array(40).fill(0.7), new Array(40).fill(0.7)], benchmark: 0.7, nBoot: 50, seed: 1 });
        check('RC statistic is exactly 0 when every candidate equals the benchmark', rcNull.statistic === 0);
        check('RC follows a benchmark series exactly (means shift by -sqrt(T)*b)',
            close(whiteRealityCheck({ returnsMatrix: [new Array(50).fill(0.02), new Array(50).fill(0.0)], benchmark: 0.01, nBoot: 50, seed: 1 }).statistic, Math.sqrt(50) * 0.01, 1e-9));

        // --- SPA: studentized, recentred ---
        const spaDet1 = hansenSpa({ returnsMatrix: [[0.01, 0.02, 0.03], [0.0, 0.0, 0.01]], nBoot: 100, seed: 3 });
        const spaDet2 = hansenSpa({ returnsMatrix: [[0.01, 0.02, 0.03], [0.0, 0.0, 0.01]], nBoot: 100, seed: 3 });
        check('SPA is deterministic under a fixed seed', spaDet1.pValue === spaDet2.pValue && spaDet1.statistic === spaDet2.statistic, `${spaDet1.pValue}`);
        const spaDegenerate = hansenSpa({ returnsMatrix: [new Array(6).fill(0.5), new Array(6).fill(0)], nBoot: 40, seed: 1 });
        check('SPA: a zero-variance positive candidate gives an infinite t-stat and p=0',
            spaDegenerate.statistic === Infinity && spaDegenerate.pValue === 0, `stat=${spaDegenerate.statistic}`);
        check('SPA bootStats respect the max-with-0 convention', Array.from(spaDet1.bootStats).every((v) => v >= 0));
        check('RC bootStats may be negative (no max-with-0)', Array.from(whiteRealityCheck({ returnsMatrix: uMatrix(2, 60, 5, (k, t, r) => (k === 0 ? 0.3 : -0.3) + 0.2 * uGauss(r)), nBoot: 60, seed: 2 }).bootStats).some((v) => v < 0));

        // --- stationary block indices ---
        const idxDraw = stationaryBlockIndices(10, 3, uRng(11));
        check('stationaryBlockIndices has length T and in-range indices',
            idxDraw.length === 10 && Array.from(idxDraw).every((i) => Number.isInteger(i) && i >= 0 && i < 10));
        const uS = uRng(9);
        const uDraws = Array.from({ length: 11 }, () => uS());
        const expectedIid = [0, 1, 2, 3, 4].map((t) => Math.floor(uDraws[2 * t] * 5));
        const gotIid = Array.from(stationaryBlockIndices(5, 1, uRng(9)));
        check('blockLength=1 is exactly i.i.d. sampling with replacement', JSON.stringify(gotIid) === JSON.stringify(expectedIid), JSON.stringify(gotIid));
        check('different seeds give different index draws',
            JSON.stringify(Array.from(stationaryBlockIndices(10, 3, uRng(1)))) !== JSON.stringify(Array.from(stationaryBlockIndices(10, 3, uRng(2)))));
        check('default blockLength is floor(T^(1/3))',
            whiteRealityCheck({ returnsMatrix: [new Array(100).fill(0.2), new Array(100).fill(0.1)], nBoot: 10, seed: 1 }).blockLength === Math.floor(Math.pow(100, 1 / 3)));

        // --- the flagship: SPA is less conservative than RC on poor candidates,
        // and both keep their size under a true null (calibration) ---
        const poor = uMatrix(10, 120, 4242, (k, t, r) => (k === 0 ? 0.25 + 1.0 * uGauss(r) : -0.25 + 2.0 * uGauss(r)));
        const rcPoor = whiteRealityCheck({ returnsMatrix: poor, nBoot: 499, seed: 7 });
        const spaPoor = hansenSpa({ returnsMatrix: poor, nBoot: 499, seed: 7 });
        check('the poor-candidate design has one positive and nine negative means',
            spaPoor.means[0] > 0 && spaPoor.means.slice(1).every((m) => m < 0));
        check('SPA statistic is max(0, bestMean/bestSE)', close(spaPoor.statistic, Math.max(0, spaPoor.means[spaPoor.bestIndex] / spaPoor.standardErrors[spaPoor.bestIndex]), 1e-12));
        check('SPA standardErrors are positive and one per candidate',
            spaPoor.standardErrors.length === 10 && spaPoor.standardErrors.every((s) => s > 0));
        check('SPA is materially less conservative than RC with poor candidates (SPA p < RC p)',
            spaPoor.pValue < rcPoor.pValue && rcPoor.pValue > 0.3, `spa=${spaPoor.pValue} rc=${rcPoor.pValue}`);
        check('both p-values lie in [0,1]', spaPoor.pValue >= 0 && spaPoor.pValue <= 1 && rcPoor.pValue >= 0 && rcPoor.pValue <= 1);

        const strong = uMatrix(5, 100, 99, (k, t, r) => (k === 0 ? 0.35 + 1 * uGauss(r) : 0.0 + 1 * uGauss(r)));
        const spaStrong = hansenSpa({ returnsMatrix: strong, nBoot: 299, seed: 7 });
        const rcStrong = whiteRealityCheck({ returnsMatrix: strong, nBoot: 299, seed: 7 });
        check('SPA rejects a strong persistent edge', spaStrong.pValue < 0.02, `p=${spaStrong.pValue}`);
        check('RC rejects a strong persistent edge', rcStrong.pValue < 0.02, `p=${rcStrong.pValue}`);

        let spaRej = 0; let rcRej = 0; let spaSum = 0; let rcSum = 0;
        const NULL_REPS = 150;
        for (let rep = 0; rep < NULL_REPS; rep++) {
            const R = uMatrix(5, 100, 1000 + rep, (k, t, r) => uGauss(r));
            const s = hansenSpa({ returnsMatrix: R, nBoot: 199, seed: rep + 1 });
            const w = whiteRealityCheck({ returnsMatrix: R, nBoot: 199, seed: rep + 1 });
            if (s.pValue < 0.05) spaRej++;
            if (w.pValue < 0.05) rcRej++;
            spaSum += s.pValue; rcSum += w.pValue;
        }
        const spaSize = spaRej / NULL_REPS; const rcSize = rcRej / NULL_REPS;
        const spaMeanP = spaSum / NULL_REPS; const rcMeanP = rcSum / NULL_REPS;
        check('SPA 5% test is calibrated on pure noise (reject rate <= 0.10)', spaSize <= 0.10 && spaSize >= 0, `size=${spaSize}`);
        check('RC 5% test is calibrated on pure noise (reject rate <= 0.10)', rcSize <= 0.10 && rcSize >= 0, `size=${rcSize}`);
        check('SPA p-values are ~Uniform under the null (mean in [0.35,0.65])', spaMeanP >= 0.35 && spaMeanP <= 0.65, `meanP=${spaMeanP}`);
        check('RC p-values are ~Uniform under the null (mean in [0.35,0.65])', rcMeanP >= 0.35 && rcMeanP <= 0.65, `meanP=${rcMeanP}`);

        // --- input contract ---
        let threwU = 0;
        try { relativePerformance([[1, 2, 3]], 0); } catch { threwU++; }
        try { relativePerformance([[1, 2, 3], [1, 2]], 0); } catch { threwU++; }
        try { relativePerformance([[1, 2, 3], [1, 2, NaN]], 0); } catch { threwU++; }
        try { relativePerformance([[1, 2, 3], [1, 2, 3]], [1, 2]); } catch { threwU++; }
        try { benchmarkSeries([1, 2], 3); } catch { threwU++; }
        check('reality_check rejects invalid matrices and benchmarks (5 cases)', threwU === 5, `threw=${threwU}`);
        let threwU2 = 0;
        try { stationaryBlockIndices(0, 2, uRng(1)); } catch { threwU2++; }
        try { stationaryBlockIndices(5, 0, uRng(1)); } catch { threwU2++; }
        try { whiteRealityCheck({ returnsMatrix: [[1, 2, 3], [1, 2, 3]], nBoot: 0 }); } catch { threwU2++; }
        try { hansenSpa({ returnsMatrix: [[1, 2, 3], [1, 2, 3]], nBoot: -5 }); } catch { threwU2++; }
        check('reality_check rejects invalid n / blockLength / nBoot (4 cases)', threwU2 === 4, `threw=${threwU2}`);
    }

    // ---- V. Consistent SPA + Romano-Wolf StepM (Hansen 2005; Romano & Wolf 2005)
    // Section U measured that SPA (the "upper" bound, recentring every candidate
    // at its own mean) is less conservative than RC, but still pays for poor,
    // noisy candidates: their noise inflates the bootstrap maximum. Hansen's
    // *consistent* recentring removes that — a candidate more than
    // A_k = omega_k*sqrt(2 log log T) below the benchmark is recentred to zero.
    // Romano-Wolf then turns the same bootstrap into a step-down max-t that names
    // WHICH candidates beat the benchmark while controlling the family-wise error
    // rate. Both share one stationary-bootstrap pass, so the tests below pin the
    // exact recentring rule, the exact statistics, the FWER/size, and the power.
    {
        const vRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const vGauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const vMatrix = (K, T, seed, fn) => { const r = vRng(seed); return Array.from({ length: K }, (_, k) => Array.from({ length: T }, (_, t) => fn(k, t, r))); };

        // --- the consistent recentring rule: exact threshold -----------------
        const bound100 = Math.sqrt(2 * Math.log(Math.log(100)));
        check('consistent recentring bound is exactly sqrt(2 log log T)', close(bound100, 1.7476725241348283, 1e-12), `${bound100}`);
        const A100 = 0.1 * bound100;
        const recExact = consistentRecentring([0.2, -0.5, -A100], [0.1, 0.1, 0.1], 100);
        check('consistent recentring keeps candidates above the bound and zeroes those below',
            recExact.recentring[0] === 0.2 && recExact.recentring[1] === 0 && recExact.recentring[2] === -A100,
            JSON.stringify(Array.from(recExact.recentring)));
        check('the bound is inclusive (a candidate exactly at -A is kept)', recExact.recentring[2] === -A100);
        check('bound grows with T but sub-linearly (T=120 > T=100)', consistentRecentring([0], [1], 120).bound > bound100);
        let threwV = 0;
        try { consistentRecentring([0.1], [0.1], 2); } catch { threwV++; }
        try { consistentRecentring([0.1, 0.2], [0.1], 100); } catch { threwV++; }
        check('consistent recentring rejects T < 3 and mismatched fbar/omega', threwV === 2, `threw=${threwV}`);

        // --- consistent SPA vs upper SPA -------------------------------------
        const vAllPos = vMatrix(4, 60, 11, (k, t, r) => 0.1 + 0.5 * k + 0.3 * vGauss(r));
        const vSpaUpper = hansenSpa({ returnsMatrix: vAllPos, nBoot: 199, seed: 2 });
        const vSpaCons = hansenSpaConsistent({ returnsMatrix: vAllPos, nBoot: 199, seed: 2 });
        check('when every candidate is above the bound, consistent SPA equals upper SPA exactly',
            vSpaCons.pValue === vSpaUpper.pValue && vSpaCons.statistic === vSpaUpper.statistic,
            `${vSpaCons.pValue} vs ${vSpaUpper.pValue}`);
        check('consistent SPA recentres a valid candidate at its own mean',
            vSpaCons.recentring.every((v, k) => v === vSpaCons.means[k]));

        // the flagship design: one real edge among nine poor, high-variance
        // candidates (same matrix as section U's poor-candidate test)
        const vPoor = vMatrix(10, 120, 4242, (k, t, r) => (k === 0 ? 0.25 + 1.0 * vGauss(r) : -0.25 + 2.0 * vGauss(r)));
        const vRc = whiteRealityCheck({ returnsMatrix: vPoor, nBoot: 499, seed: 7 });
        const vUp = hansenSpa({ returnsMatrix: vPoor, nBoot: 499, seed: 7 });
        const vCo = hansenSpaConsistent({ returnsMatrix: vPoor, nBoot: 499, seed: 7 });
        const vCo2 = hansenSpaConsistent({ returnsMatrix: vPoor, nBoot: 499, seed: 7 });
        check('consistent SPA is deterministic under a fixed seed', vCo.pValue === vCo2.pValue && vCo.statistic === vCo2.statistic);
        check('consistent SPA is strictly less conservative than upper SPA on poor candidates',
            vCo.pValue < vUp.pValue && vUp.pValue < vRc.pValue, `co=${vCo.pValue} up=${vUp.pValue} rc=${vRc.pValue}`);
        check('consistent SPA statistic is still max(0, bestMean/bestSE)',
            close(vCo.statistic, Math.max(0, vCo.means[vCo.bestIndex] / vCo.standardErrors[vCo.bestIndex]), 1e-12), `${vCo.statistic}`);
        check('the three hopeless candidates are the ones recentred to zero',
            vCo.recentring.filter((x) => x === 0).length === 3 && vCo.means[0] > 0,
            `zeros=${vCo.recentring.filter((x) => x === 0).length}`);
        check('consistent SPA reports the log-log bound for its T', close(vCo.logLogBound, Math.sqrt(2 * Math.log(Math.log(120))), 1e-12));

        // --- Romano-Wolf StepM ------------------------------------------------
        const step5 = romanoWolfStepM({ returnsMatrix: vPoor, nBoot: 499, seed: 7, alpha: 0.05 });
        const step10 = romanoWolfStepM({ returnsMatrix: vPoor, nBoot: 499, seed: 7, alpha: 0.10 });
        check('StepM orders candidates by descending observed t',
            step5.order.every((k, j) => j === 0 || step5.tStats[step5.order[j - 1]] >= step5.tStats[k]));
        const p0 = step5.stepPValues[step5.order[0]];
        check('the first StepM step IS the single-step consistent SPA p-value',
            p0 === vCo.pValue && step5.order[0] === vCo.bestIndex, `p0=${p0} spa=${vCo.pValue}`);
        check('a step p-value is never below the one that precedes it (monotone step-down)',
            step5.order.every((k, j) => j === 0 || step5.stepPValues[step5.order[j - 1]] <= step5.stepPValues[k]));
        check('StepM at alpha=0.05 does not reject the single genuine edge (p=0.058)',
            step5.nRejected === 0 && step5.rejectedIndices.length === 0, `n=${step5.nRejected}`);
        check('StepM at alpha=0.10 rejects exactly that one edge and nothing else',
            step10.nRejected === 1 && step10.rejected[0] === true && step10.rejectedIndices[0] === 0,
            JSON.stringify(step10.rejectedIndices));
        let threwV2 = 0;
        try { romanoWolfStepM({ returnsMatrix: vPoor, alpha: 0 }); } catch { threwV2++; }
        try { romanoWolfStepM({ returnsMatrix: vPoor, alpha: 1 }); } catch { threwV2++; }
        try { romanoWolfStepM({ returnsMatrix: vPoor, alpha: NaN }); } catch { threwV2++; }
        check('StepM rejects alpha outside (0,1) (3 cases)', threwV2 === 3, `threw=${threwV2}`);

        // degenerate: a deterministic candidate above the benchmark, and one
        // exactly equal to it. The positive one is rejected with p=0; the equal
        // one must NOT be (this is the guard for the omega=0 / t=0 case).
        const vDeg = romanoWolfStepM({ returnsMatrix: [new Array(6).fill(0.5), new Array(6).fill(0)], nBoot: 40, seed: 1 });
        check('a deterministic positive candidate is rejected with p=0 and t=Infinity',
            vDeg.rejected[0] === true && vDeg.stepPValues[0] === 0 && vDeg.tStats[0] === Infinity, `p=${vDeg.stepPValues[0]}`);
        check('a candidate exactly equal to the benchmark is never rejected (degenerate guard)',
            vDeg.rejected[1] === false && vDeg.rejectedIndices.length === 1, JSON.stringify(vDeg.rejectedIndices));

        // --- calibration: family-wise error rate and power --------------------
        // Under a global null the step-down can only reject at its first step,
        // which is exactly the single-step SPA rejection — so its FWER equals
        // the SPA size. Measured over 200 reps at alpha=0.05: the default block
        // bootstrap is mildly liberal on i.i.d. noise (~0.075, the documented
        // price of robustness to autocorrelation), while blockLength=1 is
        // essentially exact (~0.065). Both match the single-step decision on
        // every rep (structural identity).
        const FWER_REPS = 200;
        let stepAny = 0; let iidAny = 0; let identity = 0;
        for (let rep = 0; rep < FWER_REPS; rep++) {
            const R = vMatrix(5, 100, 50000 + rep, (k, t, r) => vGauss(r));
            const sDef = romanoWolfStepM({ returnsMatrix: R, nBoot: 199, seed: rep + 1, alpha: 0.05 });
            const cDef = hansenSpaConsistent({ returnsMatrix: R, nBoot: 199, seed: rep + 1 });
            const sIid = romanoWolfStepM({ returnsMatrix: R, nBoot: 199, seed: rep + 1, alpha: 0.05, blockLength: 1 });
            if (sDef.nRejected >= 1) stepAny++;
            if (sIid.nRejected >= 1) iidAny++;
            if ((sDef.nRejected >= 1) === (cDef.pValue < 0.05)) identity++;
        }
        check('StepM FWER at 5% stays near nominal on pure noise (default block <= 0.12)', stepAny / FWER_REPS <= 0.12, `rate=${stepAny / FWER_REPS}`);
        check('StepM FWER with blockLength=1 is essentially exact on pure noise (<= 0.10)', iidAny / FWER_REPS <= 0.10, `rate=${iidAny / FWER_REPS}`);
        check('StepM rejects a family iff its first step (single-step SPA) does — on every rep',
            identity === FWER_REPS, `match=${identity}/${FWER_REPS}`);

        let hit0 = 0; let sumRej = 0;
        const POW_REPS = 200;
        for (let rep = 0; rep < POW_REPS; rep++) {
            const R = vMatrix(5, 100, 70000 + rep, (k, t, r) => (k === 0 ? 0.35 + 1 * vGauss(r) : vGauss(r)));
            const s = romanoWolfStepM({ returnsMatrix: R, nBoot: 199, seed: rep + 1, alpha: 0.05 });
            if (s.rejected[0]) hit0++;
            sumRej += s.nRejected;
        }
        check('StepM has power on a planted edge (rejects candidate 0 in >= 75% of reps)', hit0 / POW_REPS >= 0.75, `hit=${hit0 / POW_REPS}`);
        check('StepM rejects few false positives alongside the true edge (mean rejections < 1.3)', sumRej / POW_REPS < 1.3, `meanRej=${sumRej / POW_REPS}`);
    }

    // ---- W. Automatic block length (Politis & White 2004; PPPW 2009) --------
    // Sections U/V measured that the SPA/StepM family is mildly liberal on
    // i.i.d. noise under the fixed floor(T^(1/3)) block length, and the block
    // length is the one free tuning parameter of a block bootstrap. Politis &
    // White (2004) give the standard data-driven rule for it, with the
    // Patton-Politis-White (2009) correction to the tuning-lag selection.
    // Section W locks that selector against `arch`'s reference implementation
    // (itself validated against Patton's MATLAB code) by reproducing NumPy's
    // legacy RandomState(0) stream exactly, proves blockLength:"auto" resolves
    // to the identical number an explicit call would, pins the measured
    // calibration gain on i.i.d. noise, and pins the measured limitation that
    // remains under strong persistence (tracked in docs/TODO.md).
    {
        const wRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const wGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const wAr = (K, T, phi, seed) => {
            const r = wRng(seed);
            return Array.from({ length: K }, () => {
                const a = new Float64Array(T);
                let p = 0;
                for (let t = 0; t < T; t++) { p = phi * p + wGauss(r) * Math.sqrt(1 - phi * phi); a[t] = p; }
                return a;
            });
        };

        // --- the reference stream: NumPy's legacy RandomState(0) -------------
        // `arch`'s published vectors are produced from NumPy's legacy MT19937
        // plus the polar-method normal. Reproducing that stream byte-exactly is
        // what makes the comparison below independent of this codebase; the two
        // known first draws prove the reproduction itself.
        const wMt = (seed) => {
            const N = 624; const M = 397; const MA = 0x9908b0df; const UP = 0x80000000; const LO = 0x7fffffff;
            const mt = new Uint32Array(N);
            mt[0] = seed >>> 0;
            for (let i = 1; i < N; i++) mt[i] = (Math.imul(1812433253, (mt[i - 1] ^ (mt[i - 1] >>> 30)) >>> 0) + i) >>> 0;
            let mti = N;
            return () => {
                if (mti >= N) {
                    let kk;
                    for (kk = 0; kk < N - M; kk++) { const y = (mt[kk] & UP) | (mt[kk + 1] & LO); mt[kk] = mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MA : 0); }
                    for (; kk < N - 1; kk++) { const y = (mt[kk] & UP) | (mt[kk + 1] & LO); mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MA : 0); }
                    const y = (mt[N - 1] & UP) | (mt[0] & LO); mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MA : 0);
                    mti = 0;
                }
                let y = mt[mti++];
                y ^= (y >>> 11); y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= (y >>> 18);
                return y >>> 0;
            };
        };
        const wStream = (seed) => {
            const next = wMt(seed);
            const d = () => { const a = next() >>> 5; const b = next() >>> 6; return (a * 67108864 + b) / 9007199254740992; };
            let has = false; let cache = 0;
            const norm = () => {
                if (has) { has = false; const t = cache; cache = 0; return t; }
                let x1; let x2; let r2;
                do { x1 = 2 * d() - 1; x2 = 2 * d() - 1; r2 = x1 * x1 + x2 * x2; } while (r2 >= 1 || r2 === 0);
                const f = Math.sqrt(-2 * Math.log(r2) / r2);
                cache = f * x1; has = true;
                return f * x2;
            };
            return { d, norm };
        };
        const wU0 = wStream(0).d();
        const wN0 = wStream(0).norm();
        check('the reference NumPy RandomState(0) uniform stream is reproduced exactly', wU0 === 0.5488135039273248, `${wU0}`);
        check('the reference NumPy RandomState(0) normal stream is reproduced exactly', wN0 === 1.764052345967664, `${wN0}`);

        // arch's own benchmark series: standard_normal(10100) driven through
        // y[i] = 0.3 y[i-1] + e[i], then the 100-point burn-in dropped.
        const wRef = wStream(0);
        const wE = new Float64Array(10100);
        for (let i = 0; i < 10100; i++) wE[i] = wRef.norm();
        const wY = new Float64Array(10100);
        wY[0] = wE[0];
        for (let i = 1; i < 10100; i++) wY[i] = 0.3 * wY[i - 1] + wE[i];
        const wPw = politisWhiteBlockLength(wY.slice(100));
        check('the PW selector reproduces the arch stationary reference vector (13.635665)', close(wPw.stationary, 13.635665, 13.635665 * 1e-6), `${wPw.stationary}`);
        check('the PW selector reproduces the arch circular reference vector (15.608940)', close(wPw.circular, 15.60894, 15.60894 * 1e-6), `${wPw.circular}`);
        check('the PPPW2009 correction selects m = 2*max(m_hat,1) exactly (m_hat=3 gives m=6)', wPw.optM === 3 && wPw.m === 6, `optM=${wPw.optM} m=${wPw.m}`);
        check('the selection band and search window are exact: cv=2 sqrt(log10(T)/T), kn=max(5,floor(log10 T)), m_max=ceil(sqrt T)+kn, b_max=ceil(min(3 sqrt T,T/3))',
            close(wPw.criterion, 0.04, 1e-15) && wPw.kn === 5 && wPw.mMax === 105 && wPw.bMax === 300,
            JSON.stringify({ cv: wPw.criterion, kn: wPw.kn, mMax: wPw.mMax, bMax: wPw.bMax }));
        check('circular is exactly stationary * (3/2)^(1/3) — same g and sigma, c = 4/3 vs 2',
            close(wPw.circular / wPw.stationary, Math.pow(1.5, 1 / 3), 1e-11), `${wPw.circular / wPw.stationary}`);

        // --- the selector adapts to the dependence: ~1 on i.i.d., monotone in
        // the AR(1) persistence (the fixed T^(1/3) rule cannot do this) ---
        const wPooled = (phi, T, N, seedBase) => { let s = 0; for (let j = 0; j < N; j++) s += politisWhiteBlockLength(wAr(1, T, phi, seedBase + j)[0]).stationary; return s / N; };
        const wLad = [0, 0.2, 0.3, 0.5, 0.8].map((phi) => wPooled(phi, 120, 40, 3000 + Math.round(phi * 1000)));
        check('the pooled selector ladder is pinned (T=120, 40 series per rung)',
            close(wLad[0], 0.651331, 1e-4) && close(wLad[2], 2.856409, 1e-4) && close(wLad[4], 8.42925, 1e-4),
            JSON.stringify(wLad.map((v) => +v.toFixed(3))));
        check('the pooled selector increases monotonically with the AR(1) persistence',
            wLad.every((v, j) => j === 0 || v > wLad[j - 1]), JSON.stringify(wLad.map((v) => +v.toFixed(3))));
        check('on i.i.d. noise the pooled selector sits at the floor (<= 1.4)', wLad[0] <= 1.4, `${wLad[0]}`);
        check('on AR(1) phi=0.8 at T=120 the pooled selector is far above the fixed T^(1/3) rule (>= 4)', wLad[4] >= 4, `${wLad[4]}`);

        // --- autoBlockLength: single series, matrix reductions, validation ---
        const wOne = wAr(1, 120, 0.8, 12345)[0];
        const wSingle = autoBlockLength(wOne);
        check('autoBlockLength(series) returns one floored estimate',
            wSingle.n === 1 && wSingle.perSeries.length === 1 && wSingle.blockLength >= 1 && wSingle.blockLength === Math.max(1, wSingle.raw),
            JSON.stringify({ bl: wSingle.blockLength, raw: wSingle.raw }));
        const wMat = wAr(5, 120, 0.5, 777);
        const wAuto = autoBlockLength(wMat);
        const wSorted = [...wAuto.perSeries].sort((a, b) => a - b);
        check('autoBlockLength(matrix) estimates one length per candidate', wAuto.n === 5 && wAuto.perSeries.length === 5);
        check('the default reduction is the mean of the raw per-candidate selectors',
            wAuto.reduce === 'mean' && close(wAuto.raw, wSorted.reduce((a, b) => a + b, 0) / 5, 1e-12) && close(wAuto.blockLength, wAuto.raw, 1e-12),
            `${wAuto.blockLength}`);
        check('the min/median/max reductions are exactly the order statistics of the per-candidate values',
            close(autoBlockLength(wMat, { reduce: 'min' }).blockLength, Math.max(1, wSorted[0]), 1e-12) &&
            close(autoBlockLength(wMat, { reduce: 'median' }).blockLength, Math.max(1, wSorted[2]), 1e-12) &&
            close(autoBlockLength(wMat, { reduce: 'max' }).blockLength, Math.max(1, wSorted[4]), 1e-12),
            JSON.stringify(wSorted.map((v) => +v.toFixed(3))));
        check('the circular variant is exactly (3/2)^(1/3) longer than the stationary one',
            close(autoBlockLength(wMat, { type: 'circular' }).blockLength / wAuto.blockLength, Math.pow(1.5, 1 / 3), 1e-11));
        let threwW = 0;
        try { autoBlockLength(wMat, { type: 'block' }); } catch { threwW++; }
        try { autoBlockLength(wMat, { reduce: 'mode' }); } catch { threwW++; }
        try { autoBlockLength([]); } catch { threwW++; }
        try { politisWhiteBlockLength([1, 2, 3]); } catch { threwW++; }
        try { politisWhiteBlockLength([1, 2, 3, 4, 5, 6, 7, 8, 9, NaN]); } catch { threwW++; }
        check('autoBlockLength rejects a bad type/reduce/empty matrix and the selector a short/non-finite series (5 cases)', threwW === 5, `threw=${threwW}`);

        // --- blockLength:"auto" is wired through every entry point ---
        const wAutoBL = autoBlockLength(wMat).blockLength;
        const wBrmAuto = bootstrapRelativeMeans(wMat, { nBoot: 40, blockLength: 'auto', seed: 3, T: 120, K: 5 });
        const wBrmDef = bootstrapRelativeMeans(wMat, { nBoot: 40, blockLength: null, seed: 3, T: 120, K: 5 });
        check('bootstrapRelativeMeans resolves blockLength:"auto" to the pooled selector',
            wBrmAuto.blockLength === wAutoBL && wBrmAuto.blockLengthAuto !== null && wBrmAuto.blockLengthAuto.blockLength === wAutoBL, `${wBrmAuto.blockLength}`);
        check('bootstrapRelativeMeans keeps the fixed floor(T^(1/3)) default when blockLength is null',
            wBrmDef.blockLength === Math.floor(Math.pow(120, 1 / 3)) && wBrmDef.blockLengthAuto === null);
        const wSpaAuto = hansenSpaConsistent({ returnsMatrix: wMat, benchmark: 0, nBoot: 99, blockLength: 'auto', seed: 7 });
        const wSpaExp = hansenSpaConsistent({ returnsMatrix: wMat, benchmark: 0, nBoot: 99, blockLength: wAutoBL, seed: 7 });
        check('SPA with blockLength:"auto" is identical to the explicit resolved block length',
            wSpaAuto.pValue === wSpaExp.pValue && wSpaAuto.blockLength === wSpaExp.blockLength, `${wSpaAuto.pValue}`);
        check('every reality-check entry point accepts blockLength:"auto" and reports a numeric block length >= 1',
            [whiteRealityCheck, hansenSpa, hansenSpaConsistent, romanoWolfStepM].every((fn) => {
                const r = fn({ returnsMatrix: wMat, nBoot: 20, blockLength: 'auto', seed: 5 });
                return Number.isFinite(r.blockLength) && r.blockLength >= 1;
            }));

        // --- calibration: the automatic rule removes the fixed rule's i.i.d.
        // liberality (5% test, K=5, T=100, 150 reps, nBoot=99, pinned seeds) ---
        const wSize = (K, T, phi, reps, nBoot, bl, seedBase) => {
            let rej = 0; let blSum = 0;
            for (let i = 0; i < reps; i++) {
                const r = hansenSpaConsistent({ returnsMatrix: wAr(K, T, phi, seedBase + i), benchmark: 0, nBoot, blockLength: bl, seed: i + 1 });
                if (r.pValue <= 0.05) rej++;
                blSum += r.blockLength;
            }
            return { size: rej / reps, meanBL: blSum / reps };
        };
        const wIidAuto = wSize(5, 100, 0, 150, 99, 'auto', 4000);
        const wIidFixed = wSize(5, 100, 0, 150, 99, null, 4000);
        check('on i.i.d. noise the automatic rule restores nominal size (reject rate <= 0.06)', wIidAuto.size <= 0.06, `${wIidAuto.size}`);
        check('the fixed floor(T^(1/3)) rule is measurably more liberal on the same reps', wIidFixed.size > wIidAuto.size + 0.02, `auto=${wIidAuto.size} fixed=${wIidFixed.size}`);
        check('on i.i.d. noise the pooled selector correctly reports essentially no dependence (mean block <= 1.05)', wIidAuto.meanBL <= 1.05, `${wIidAuto.meanBL}`);
        const wArAuto = wSize(5, 100, 0.8, 150, 99, 'auto', 4000);
        const wArIid = wSize(5, 100, 0.8, 150, 99, 1, 4000);
        check('under AR(1) phi=0.8 the pooled selector detects the dependence (mean block >= 5)', wArAuto.meanBL >= 5, `${wArAuto.meanBL}`);
        check('the adaptation is load-bearing: blockLength=1 is far more liberal than the automatic rule',
            wArIid.size > wArAuto.size + 0.15, `b1=${wArIid.size} auto=${wArAuto.size}`);

        // --- KNOWN LIMITATION (measured here; fix tracked in docs/TODO.md) ----
        // Under strong persistence the stationary bootstrap's variance of the
        // MEAN is biased low, and because the SPA statistic divides the true
        // sampling spread by that too-small bootstrap standard error, it stays
        // over-sized no matter which block length is chosen. At phi=0.8, T=120
        // the effective sample size is only T(1-phi)/(1+phi) = 13, so the
        // long-run variance is genuinely not estimable at this T. Pinning the
        // shortfall here is what keeps the limitation visible (and keeps the
        // consequence above: AR(1) phi=0.8 size 0.41, not 0.05).
        const wTrue = Math.sqrt((1 + 0.8) / (1 - 0.8) / 120);
        const wRatio = {};
        {
            const acc = { 1: 0, 4: 0, 9: 0, 15: 0, 25: 0 };
            for (let j = 0; j < 20; j++) {
                const x = wAr(1, 120, 0.8, 6000 + j)[0];
                for (const b of [1, 4, 9, 15, 25]) {
                    const { fbar, fbarBoot } = bootstrapRelativeMeans([x], { nBoot: 3000, blockLength: b, seed: 50 + j, T: 120, K: 1 });
                    let s = 0;
                    for (let i = 0; i < 3000; i++) { const d = fbarBoot[i][0] - fbar[0]; s += d * d; }
                    acc[b] += Math.sqrt(s / 3000);
                }
            }
            for (const b of [1, 4, 9, 15, 25]) wRatio[b] = acc[b] / 20 / wTrue;
        }
        check('the bootstrap standard error of the mean is biased low at phi=0.8: ratio < 0.8 at every block length',
            [1, 4, 9, 15, 25].every((b) => wRatio[b] > 0.25 && wRatio[b] < 0.8),
            JSON.stringify([1, 4, 9, 15, 25].map((b) => +wRatio[b].toFixed(3))));
        check('no block length recovers the true long-run standard error (best ratio < 0.75)',
            Math.max(...[1, 4, 9, 15, 25].map((b) => wRatio[b])) < 0.75, `${Math.max(...[1, 4, 9, 15, 25].map((b) => wRatio[b]))}`);
        check('the shortfall curve is pinned (b=1 -> 0.33, b=4 -> 0.61, b=15 -> 0.72)',
            close(wRatio[1], 0.3265, 5e-4) && close(wRatio[4], 0.6143, 5e-4) && close(wRatio[15], 0.7211, 5e-4),
            JSON.stringify([1, 4, 9, 15, 25].map((b) => +wRatio[b].toFixed(4))));
        check('the consequence is pinned: under AR(1) phi=0.8 the automatic rule still over-rejects (size > 0.20)',
            wArAuto.size > 0.20, `${wArAuto.size}`);
    }

    // ---- X. Variance-consistent subsampling inference (Politis & Romano 1994;
    //         Politis, Romano & Wolf 1999) ------------------------------------
    // Section W pinned the block bootstrap's failure at high persistence: its
    // variance of the MEAN is biased low, so SPA/StepM over-reject at phi=0.8 no
    // matter the block length (size 0.41). Section X proves the subsampling fix:
    // the reference distribution is built from overlapping windows of the SAME
    // series, so its scale is the data's own and the low-variance bias is gone.
    // The window and the full sample are studentized by the SAME Newey-West
    // estimator (same bandwidth), which is what makes the window-vs-full
    // comparison approximately pivotal. Every window is used, so it is
    // deterministic (no rng): the calibration below is fully reproducible.
    {
        const xRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const xGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const xAr = (K, T, phi, seed) => {
            const r = xRng(seed);
            return Array.from({ length: K }, () => {
                const a = new Float64Array(T);
                let p = 0;
                for (let t = 0; t < T; t++) { p = phi * p + xGauss(r) * Math.sqrt(1 - phi * phi); a[t] = p; }
                return a;
            });
        };

        // --- the Newey-West (Bartlett) standard error is exact ---
        const xS = [1, 2, 4, 8, 16];
        check('neweyWestSE at bandwidth 0 is exactly the i.i.d. standard error sqrt(mean squared deviation / n)',
            close(neweyWestSE(xS, 0, 5, 0), 2.439672109116305, 1e-12), `${neweyWestSE(xS, 0, 5, 0)}`);
        check('neweyWestSE applies the exact Bartlett taper 2(1 - j/(m+1)) (m=1, m=2 pinned)',
            close(neweyWestSE(xS, 0, 5, 1), 2.7825168463101893, 1e-12) && close(neweyWestSE(xS, 0, 5, 2), 2.8049480090250043, 1e-12),
            `${neweyWestSE(xS, 0, 5, 1)} / ${neweyWestSE(xS, 0, 5, 2)}`);
        check('neweyWestSE on a sub-window is the same estimator applied to that slice (1.4229164… pinned)',
            close(neweyWestSE(xS, 1, 3, 1), 1.4229164972072996, 1e-12) && neweyWestSE(xS, 1, 3, 1) === neweyWestSE([2, 4, 8], 0, 3, 1));
        check('neweyWestSE of a constant window is exactly 0 (a deterministic candidate is an infinite t)', neweyWestSE([2, 2, 2, 2], 0, 4, 1) === 0);
        let threwX = 0;
        try { neweyWestSE(xS, 0, 6, 1); } catch { threwX++; }
        try { neweyWestSE(xS, 0, 5, 5); } catch { threwX++; }
        try { neweyWestSE(xS, 0, 1, 0); } catch { threwX++; }
        try { neweyWestSE(xS, 2, 4, 1); } catch { threwX++; }
        try { neweyWestSE([1, NaN, 3, 4], 0, 4, 1); } catch { threwX++; }
        check('neweyWestSE rejects an out-of-range window/bandwidth, a length<2 window and a non-finite series (5 cases)', threwX === 5, `threw=${threwX}`);

        // --- structure: defaults, determinism, and the exact window statistics ---
        const xK = 5; const xT = 120;
        const xX = xAr(xK, xT, 0.5, 909);
        const xSub = subsamplingSpa({ returnsMatrix: xX });
        check('subsamplingSpa defaults to b = round(T/3) and one bandwidth m = round(b/6) shared by every window',
            xSub.windowLength === Math.round(xT / 3) && xSub.bandwidth === Math.max(1, Math.round(xSub.windowLength / 6)),
            `b=${xSub.windowLength} m=${xSub.bandwidth}`);
        check('subsamplingSpa uses every overlapping window (nWindows = T - b + 1)',
            xSub.nWindows === xT - xSub.windowLength + 1 && xSub.windowStats.length === xSub.nWindows, `${xSub.nWindows}`);
        check('subsamplingSpa is deterministic — no rng, byte-identical on repeat',
            xSub.pValue === subsamplingSpa({ returnsMatrix: xX }).pValue && xSub.statistic === subsamplingSpa({ returnsMatrix: xX }).statistic);
        check('every window t-statistic is exactly (window mean - recentring)/shrink/neweyWestSE(window, m)',
            (() => {
                const b = xSub.windowLength; const m = xSub.bandwidth; const shrink = Math.sqrt(1 - b / xT);
                for (let s = 0; s < xSub.nWindows; s++) {
                    for (let k = 0; k < xK; k++) {
                        let mu = 0; for (let t = s; t < s + b; t++) mu += xX[k][t]; mu /= b;
                        const want = (mu - xSub.recentring[k]) / shrink / neweyWestSE(xX[k], s, b, m);
                        if (!close(xSub.tWindows[s * xK + k], want, 1e-12)) return false;
                    }
                }
                return true;
            })());
        check('the statistic is max(0, max_k fbar_k / se_k) with the full-sample standard errors',
            close(xSub.statistic, Math.max(0, Math.max(...xSub.means.map((f, k) => f / xSub.standardErrors[k]))), 1e-12) &&
            xSub.standardErrors.every((s, k) => close(s, neweyWestSE(xX[k], 0, xT, xSub.bandwidth), 1e-12)));
        check('the window shrink factor is exactly sqrt(1 - b/T) (the covariance of an overlapping window with its sample)',
            close(xSub.shrink, Math.sqrt(1 - xSub.windowLength / xT), 1e-15), `${xSub.shrink}`);
        const xSubC = subsamplingSpa({ returnsMatrix: xX, consistent: true });
        check('the default recentring is the sample mean; consistent=true zeroes exactly the candidates beyond se_k*sqrt(2 log log T)',
            xSub.recentring.every((r, k) => close(r, xSub.means[k], 1e-15)) &&
            xSubC.recentring.every((r, k) => (xSub.means[k] >= -xSub.standardErrors[k] * xSubC.logLogBound ? close(r, xSub.means[k], 1e-15) : r === 0)));

        let xThrow = 0;
        try { subsamplingSpa({ returnsMatrix: xAr(5, 120, 0, 1), windowLength: 120 }); } catch { xThrow++; }
        try { subsamplingSpa({ returnsMatrix: xAr(5, 120, 0, 1), windowLength: 1 }); } catch { xThrow++; }
        try { subsamplingSpa({ returnsMatrix: xAr(5, 120, 0, 1), bandwidth: 40 }); } catch { xThrow++; }
        try { subsamplingSpa({ returnsMatrix: xAr(5, 120, 0, 1), bandwidth: -1 }); } catch { xThrow++; }
        try { subsamplingSpa({ returnsMatrix: xAr(5, 4, 0, 1) }); } catch { xThrow++; }
        try { subsamplingStepM({ returnsMatrix: xAr(5, 120, 0, 1), alpha: 1 }); } catch { xThrow++; }
        check('subsampling rejects a bad window/bandwidth/alpha and a too-short sample (6 cases)', xThrow === 6, `threw=${xThrow}`);

        // --- the flagship: 5% size across the whole persistence sweep --------
        // Same data seeds as section W (xAr, K=5, T=100/120, 300 reps), so the
        // block-bootstrap and subsampling sizes are directly comparable.
        const xSubSize = (K, T, phi, reps, seedBase) => { let rej = 0; for (let i = 0; i < reps; i++) if (subsamplingSpa({ returnsMatrix: xAr(K, T, phi, seedBase + i) }).pValue <= 0.05) rej++; return rej / reps; };
        const xBlkSize = (K, T, phi, reps, seedBase) => { let rej = 0; for (let i = 0; i < reps; i++) if (hansenSpaConsistent({ returnsMatrix: xAr(K, T, phi, seedBase + i), nBoot: 199, seed: 1 }).pValue <= 0.05) rej++; return rej / reps; };
        const xSubPower = (K, T, phi, edge, reps, seedBase) => { let rej = 0; for (let i = 0; i < reps; i++) { const R = xAr(K, T, phi, seedBase + i); for (let t = 0; t < T; t++) R[0][t] += edge; if (subsamplingSpa({ returnsMatrix: R }).pValue <= 0.05) rej++; } return rej / reps; };
        const xPhi = [0, 0.2, 0.5, 0.8];

        const xSub100 = xPhi.map((phi) => xSubSize(5, 100, phi, 300, 4000));
        check('subsampling SPA holds its 5% size at every persistence (T=100, K=5, 300 reps)', xSub100.every((s) => s <= 0.075), JSON.stringify(xSub100));
        check('the subsampling size is pinned at i.i.d. (0.0533) and still nominal at phi=0.8 (0.0433)',
            close(xSub100[0], 0.0533, 1e-4) && close(xSub100[3], 0.0433, 1e-4), JSON.stringify(xSub100));
        const xBlk100 = [0.5, 0.8].map((phi) => xBlkSize(5, 100, phi, 300, 4000));
        check('the block-bootstrap SPA over-rejects on the same reps at phi=0.5 -> 0.20 and phi=0.8 -> 0.4067 (pinned)',
            close(xBlk100[0], 0.2, 1e-4) && close(xBlk100[1], 0.4067, 1e-4), JSON.stringify(xBlk100));
        check('variance-consistent subsampling cuts the phi=0.8 size distortion ~9x (0.4067 -> 0.0433, gap >= 0.30)',
            xBlk100[1] - xSub100[3] >= 0.30, `blk=${xBlk100[1]} sub=${xSub100[3]}`);
        const xSub120 = xPhi.map((phi) => xSubSize(5, 120, phi, 300, 4000));
        const xBlk120 = xBlkSize(5, 120, 0.8, 300, 4000);
        check('subsampling SPA stays nominal at T=120, still ~7x better than the block bootstrap at phi=0.8',
            xSub120.every((s) => s <= 0.075) && close(xBlk120, 0.3867, 1e-4) && xBlk120 - xSub120[3] >= 0.25,
            JSON.stringify([...xSub120, xBlk120]));

        const xPow100 = [0, 0.5, 0.8].map((phi) => xSubPower(5, 100, phi, 0.35, 300, 70000));
        const xPow120 = [0, 0.5, 0.8].map((phi) => xSubPower(5, 120, phi, 0.35, 300, 70000));
        check('subsampling SPA keeps power on a planted edge (phi=0: 0.7167 at T=100, 0.80 at T=120)',
            close(xPow100[0], 0.7167, 1e-4) && close(xPow120[0], 0.8, 1e-4), JSON.stringify([xPow100[0], xPow120[0]]));
        check('power is not silently lost under persistence (phi=0.8 rejects above the size)',
            xPow100[2] > xSub100[3] + 0.05, `${xPow100[2]} vs size ${xSub100[3]}`);

        // --- the step-down on the same subsampling reference ----------------
        const xStep = subsamplingStepM({ returnsMatrix: xAr(5, 120, 0.5, 777), alpha: 0.05 });
        const xStepC = subsamplingSpa({ returnsMatrix: xAr(5, 120, 0.5, 777), consistent: true });
        check('subsamplingStepM reports a valid ordering / step p-values and the resolved window geometry',
            xStep.order.length === 5 && xStep.stepPValues.every((p) => p >= 0 && p <= 1) && xStep.windowLength === 40 && xStep.bandwidth === 7,
            `b=${xStep.windowLength} m=${xStep.bandwidth}`);
        check('subsamplingStepM\'s first step IS the single-step consistent subsampling SPA p-value (pinned 0.666667)',
            close(xStep.stepPValues[xStep.order[0]], xStepC.pValue, 1e-12) && close(xStep.stepPValues[xStep.order[0]], 0.666667, 1e-6),
            `${xStep.stepPValues[xStep.order[0]]}`);
        check('subsamplingStepM step p-values are monotone down the descending-t order',
            xStep.order.every((idx, j) => j === 0 || xStep.stepPValues[idx] >= xStep.stepPValues[xStep.order[j - 1]] - 1e-15));
        check('subsamplingStepM always uses the consistent recentring (zero iff beyond se_k*sqrt(2 log log T))',
            xStep.recentring.every((r, k) => (xStep.means[k] >= -xStep.standardErrors[k] * xStep.logLogBound ? close(r, xStep.means[k], 1e-15) : r === 0)));
        const xStepDeg = subsamplingStepM({ returnsMatrix: Array.from({ length: 5 }, () => new Float64Array(120)), alpha: 0.5 });
        check('subsamplingStepM never rejects a candidate exactly at the benchmark (omega=0, t=0 guard)',
            xStepDeg.nRejected === 0 && xStepDeg.stepPValues.every((p) => p === 1), `nRej=${xStepDeg.nRejected}`);

        let xFwer = 0; let xIdent = 0;
        for (let i = 0; i < 300; i++) {
            const R = xAr(5, 100, 0.8, 4000 + i);
            const s = subsamplingStepM({ returnsMatrix: R, alpha: 0.05 });
            const c = subsamplingSpa({ returnsMatrix: R, consistent: true });
            if (s.nRejected >= 1) xFwer++;
            if ((s.nRejected >= 1) === (c.pValue <= 0.05)) xIdent++;
        }
        check('subsamplingStepM FWER stays nominal at phi=0.8 (0.0533 pinned, <= 0.08)',
            xFwer / 300 <= 0.08 && close(xFwer / 300, 0.0533, 1e-4), `${xFwer / 300}`);
        check('subsamplingStepM rejects a family iff its first step does — on every rep', xIdent === 300, `${xIdent}/300`);

        let xStepPow = 0; let xStepRej = 0;
        for (let i = 0; i < 300; i++) {
            const R = xAr(5, 100, 0, 70000 + i);
            for (let t = 0; t < 100; t++) R[0][t] += 0.35;
            const s = subsamplingStepM({ returnsMatrix: R, alpha: 0.05 });
            if (s.rejected[0]) xStepPow++;
            xStepRej += s.nRejected;
        }
        check('subsamplingStepM keeps power (phi=0: planted edge rejected in 0.72 of reps, < 1.3 mean rejections)',
            close(xStepPow / 300, 0.72, 1e-4) && xStepRej / 300 < 1.3, `${xStepPow / 300} / ${xStepRej / 300}`);
    }

    // ---- Y. Family-wise search correction on the walk-forward path ----------
    // Item 8: make the variance-consistent subsampling decision reachable from
    // the honest-evaluation path. Proved here on synthetic data (and end-to-end on
    // shipped candles in walkforward.test.js): the segment-aware (`groups`)
    // resampling keeps every window inside ONE block, its long-run variance
    // reduces exactly to the whole-sample estimator for a single block, and
    // familywiseSearch / walkForwardSearch are faithful, deterministic views of
    // the SPA/StepM pair. The promotion hurdle and the report line are strictly
    // additive: the default gate and the default report are byte-identical.
    {
        const yRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const yGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const yAr = (K, T, phi, seed) => {
            const r = yRng(seed);
            return Array.from({ length: K }, () => {
                const a = new Float64Array(T);
                let p = 0;
                for (let t = 0; t < T; t++) { p = phi * p + yGauss(r) * Math.sqrt(1 - phi * phi); a[t] = p; }
                return a;
            });
        };

        const yT = 120;
        const yK = 4;
        const yX = yAr(yK, yT, 0.5, 909);

        // --- a single segment is bit-identical to the ungrouped estimator -----
        const yBase = subsamplingSpa({ returnsMatrix: yX });
        const yOne = subsamplingSpa({ returnsMatrix: yX, groups: [yT] });
        check('groups=[T] is bit-identical to the ungrouped estimator (one block reduces exactly)',
            yOne.pValue === yBase.pValue && yOne.statistic === yBase.statistic && yOne.nWindows === yBase.nWindows &&
            yOne.windowLength === yBase.windowLength && yOne.bandwidth === yBase.bandwidth &&
            yOne.standardErrors.every((s, k) => s === yBase.standardErrors[k]));

        // --- grouped defaults, window grid, exact window arithmetic -----------
        const yG = [40, 40, 40];
        const y3 = subsamplingSpa({ returnsMatrix: yX, groups: yG });
        check('grouped default window is half the SHORTEST segment and the shared bandwidth follows it',
            y3.windowLength === 20 && y3.bandwidth === Math.max(1, Math.round(20 / 6)),
            `b=${y3.windowLength} m=${y3.bandwidth}`);
        check('grouped nWindows is the sum of WITHIN-segment windows (no window straddles a fold boundary)',
            y3.nWindows === 3 * (40 - 20 + 1) && y3.nWindows === 63, `${y3.nWindows}`);
        check('every grouped window is exactly the within-segment studentized statistic (manual recomputation)',
            (() => {
                const b = y3.windowLength; const m = y3.bandwidth; const shrink = Math.sqrt(1 - b / yT);
                const starts = [];
                for (let g = 0; g < 3; g++) { const o = g * 40; for (let s = o; s <= o + 40 - b; s++) starts.push(s); }
                const seFull = yX.map((row) => {
                    let acc = 0;
                    for (let g = 0; g < 3; g++) { const se = neweyWestSE(row, g * 40, 40, m); acc += (40 * se) ** 2; }
                    return Math.sqrt(acc) / yT;
                });
                const fbar = yX.map((row) => mean(row));
                const stat = Math.max(0, Math.max(...fbar.map((f, k) => f / seFull[k])));
                let exceed = 0;
                for (const s of starts) {
                    let mx = 0;
                    for (let k = 0; k < yK; k++) {
                        let mu = 0; for (let t = s; t < s + b; t++) mu += yX[k][t]; mu /= b;
                        const tv = (mu - fbar[k]) / shrink / neweyWestSE(yX[k], s, b, m);
                        if (tv > mx) mx = tv;
                    }
                    if (mx > stat) exceed++;
                }
                return close(y3.statistic, stat, 1e-12) && close(y3.pValue, exceed / starts.length, 1e-15) &&
                    y3.standardErrors.every((s, k) => close(s, seFull[k], 1e-12));
            })());
        check('segment-aware full-scale SE is sqrt(sum_g (len_g*seNW_g)^2)/T (2 segments, exact)',
            (() => {
                const y2s = subsamplingSpa({ returnsMatrix: yX, groups: [60, 60], windowLength: 20, bandwidth: 3 });
                return y2s.standardErrors.every((s, k) => close(s,
                    Math.sqrt((60 * neweyWestSE(yX[k], 0, 60, 3)) ** 2 + (60 * neweyWestSE(yX[k], 60, 60, 3)) ** 2) / yT, 1e-12));
            })());
        check('subsamplingStepM accepts groups and shares the same window grid as subsamplingSpa',
            (() => { const y3s = subsamplingStepM({ returnsMatrix: yX, groups: yG }); return y3s.windowLength === y3.windowLength && y3s.bandwidth === y3.bandwidth && y3s.nWindows === y3.nWindows; })());
        let threwY = 0;
        try { subsamplingSpa({ returnsMatrix: yX, groups: [] }); } catch { threwY++; }
        try { subsamplingSpa({ returnsMatrix: yX, groups: [50, 50] }); } catch { threwY++; }
        try { subsamplingSpa({ returnsMatrix: yX, groups: [40, 40, 40.5] }); } catch { threwY++; }
        try { subsamplingSpa({ returnsMatrix: yX, groups: [1, 119] }); } catch { threwY++; }
        try { subsamplingSpa({ returnsMatrix: yX, groups: yG, windowLength: 60 }); } catch { threwY++; }
        check('grouped subsampling rejects empty / mis-summed / non-integer / <2 groups and a window longer than the shortest segment (5 cases)',
            threwY === 5, `threw=${threwY}`);

        // --- familywiseSearch is a faithful, deterministic view ---------------
        const yLabels = ['a', 'b', 'c', 'd'];
        const yFamily = familywiseSearch({ strategies: yX, groups: yG, labels: yLabels });
        const yStep = subsamplingStepM({ returnsMatrix: yX, groups: yG, alpha: 0.05 });
        const ySpaG = subsamplingSpa({ returnsMatrix: yX, groups: yG });
        check('familywiseSearch is a faithful view of the SPA/StepM pair on the same window grid',
            yFamily.spaPValue === ySpaG.pValue && yFamily.spa.statistic === ySpaG.statistic &&
            yFamily.nWindows === ySpaG.nWindows && yFamily.windowLength === ySpaG.windowLength &&
            yFamily.bandwidth === ySpaG.bandwidth && yFamily.groups.join('x') === '40x40x40');
        check('familywiseSearch exposes per-candidate adjusted p-values, labels and the step-down rejection set',
            yFamily.candidates.length === yK && yFamily.K === yK &&
            yFamily.candidates.every((c, k) => c.pValue === yStep.stepPValues[k] && c.rejected === yStep.rejected[k] && c.label === yLabels[k]) &&
            yFamily.bestIndex === yFamily.spa.bestIndex && yFamily.bestLabel === yLabels[yFamily.bestIndex] &&
            yFamily.candidates[yFamily.bestIndex].spaPValue === yFamily.spaPValue &&
            yFamily.rejectedIndices.length === yStep.nRejected &&
            yFamily.rejectedIndices.every((k) => yStep.rejected[k]) &&
            yFamily.rejectedLabels.join(',') === yFamily.rejectedIndices.map((k) => yLabels[k]).join(','));
        check('familywiseSearch is deterministic (no rng — byte-identical on repeat)',
            (() => {
                const r = familywiseSearch({ strategies: yX, groups: yG, labels: yLabels });
                return r.spaPValue === yFamily.spaPValue &&
                    JSON.stringify(r.rejectedIndices) === JSON.stringify(yFamily.rejectedIndices) &&
                    r.candidates.every((c, k) => c.pValue === yFamily.candidates[k].pValue);
            })());
        let threwFY = 0;
        try { familywiseSearch({ strategies: [] }); } catch { threwFY++; }
        try { familywiseSearch({}); } catch { threwFY++; }
        check('familywiseSearch rejects an empty / missing strategy list (2 cases)', threwFY === 2, `threw=${threwFY}`);

        // --- walkForwardSearch maps a report set, and trims fold starts -------
        const yFolds = [30, 30, 30];
        const yNoise = yAr(3, 90, 0, 555);
        const yEdge = yAr(1, 90, 0, 556)[0].map((v) => v * 0.2 + 0.25);
        const yWF = walkForwardSearch({
            baseline: { pooledReturns: yNoise[0], foldLengths: yFolds },
            candidates: [{ pooledReturns: yEdge }, { pooledReturns: yNoise[1] }],
            labels: ['edge', 'null'], alpha: 0.05,
        });
        check('walkForwardSearch maps [baseline, ...candidates] to the family and labels every member',
            yWF.K === 3 && yWF.baselineIndex === 0 && JSON.stringify(yWF.candidateIndices) === '[1,2]' &&
            yWF.candidates[0].label === 'baseline' && yWF.candidates[1].label === 'edge' && yWF.candidates[2].label === 'null');
        check("walkForwardSearch trims each fold's no-exposure first bar (T = sum(len-1), groups = len-1)",
            yWF.trimmedFoldStarts === true && yWF.T === 87 && yWF.groups.join('x') === '29x29x29', `T=${yWF.T} groups=${yWF.groups}`);
        check('walkForwardSearch rejects the planted-edge candidate and never rejects the i.i.d. noise candidates',
            yWF.candidates[1].rejected === true && yWF.candidates[1].pValue < 0.01 &&
            !yWF.candidates[2].rejected && !yWF.candidates[0].rejected,
            JSON.stringify(yWF.candidates.map((c) => [c.label, c.pValue, c.rejected])));
        let threwWF = 0;
        try { walkForwardSearch({ baseline: {}, candidates: [{}] }); } catch { threwWF++; }
        try { walkForwardSearch({ baseline: { pooledReturns: yNoise[0] }, candidates: [] }); } catch { threwWF++; }
        try { walkForwardSearch({ baseline: { pooledReturns: yNoise[0] }, candidates: [{ pooledReturns: yNoise[0].slice(0, 60) }] }); } catch { threwWF++; }
        check('walkForwardSearch rejects a report without pooledReturns, an empty candidate list, and unequal series lengths (3 cases)',
            threwWF === 3, `threw=${threwWF}`);

        // --- the promotion hurdle is opt-in and additive ----------------------
        const yb = { aggregate: { mean: 1, positiveFraction: 0.5 }, pooledMetrics: { dsr: 0.95 }, folds: [{ metrics: { netSharpe: 1 } }, { metrics: { netSharpe: 1 } }], audit: { clean: true } };
        const yc = { aggregate: { mean: 2, positiveFraction: 0.5 }, pooledMetrics: { dsr: 0.98 }, folds: [{ metrics: { netSharpe: 2 } }, { metrics: { netSharpe: 2 } }], audit: { clean: true } };
        const yBaseDec = promoteDecision(yb, yc);
        check('the opt-in family-wise hurdles leave the default gate bit-identical (no search attachment)',
            promoteDecision(yb, yc, {}).promote === yBaseDec.promote &&
            JSON.stringify(promoteDecision(yb, yc, {}).reasons) === JSON.stringify(yBaseDec.reasons) &&
            promoteDecision(yb, { ...yc, search: { pValue: 0.20, rejected: false } }).promote === yBaseDec.promote);
        check('promoteDecision rejects a candidate whose family-wise p exceeds maxSearchP, and names the hurdle',
            !promoteDecision(yb, { ...yc, search: { pValue: 0.20, rejected: false } }, { maxSearchP: 0.05 }).promote &&
            promoteDecision(yb, { ...yc, search: { pValue: 0.20, rejected: false } }, { maxSearchP: 0.05 }).reasons.some((r) => r.includes('family-wise')) &&
            promoteDecision(yb, { ...yc, search: { pValue: 0.01, rejected: true } }, { maxSearchP: 0.05 }).promote);
        check('promoteDecision can require the step-down rejection set (requireSearchReject)',
            !promoteDecision(yb, { ...yc, search: { pValue: 0.01, rejected: false } }, { requireSearchReject: true }).promote &&
            promoteDecision(yb, { ...yc, search: { pValue: 0.01, rejected: true } }, { requireSearchReject: true }).promote);
        check('a maxSearchP hurdle with no search attachment rejects with a "missing" reason',
            !promoteDecision(yb, yc, { maxSearchP: 0.05 }).promote &&
            promoteDecision(yb, yc, { maxSearchP: 0.05 }).reasons.some((r) => r.includes('missing')));
        check('a satisfied family-wise hurdle adds no reason (rejections stay exactly attributable)',
            JSON.stringify(promoteDecision(yb, { ...yc, search: { pValue: 0.01, rejected: true } }, { maxSearchP: 0.05, requireSearchReject: true }).reasons)
                === JSON.stringify(yBaseDec.reasons));

        // --- formatReport renders the search line only when asked -------------
        const yReport = {
            folds: [{ metrics: {} }], pooledBars: 10,
            pooledMetrics: { netSharpe: 0.5, psr: 0.6, dsr: 0.97, maxDrawdown: 0.1, hitRate: 0.5 },
            aggregate: { mean: 0.5, median: 0.5, std: 0.1, positiveFraction: 0.6 }, audit: { clean: true },
        };
        const yLines = formatReport(yReport);
        check('formatReport is unchanged without a search object (6 lines incl. the cost and participation lines, no search line)',
            yLines.split('\n').length === 6 && !yLines.includes('search') && yLines.includes('breakEven='));
        const yFamLine = formatReport(yReport, { search: yFamily });
        check('formatReport renders the whole-family SPA/StepM line when given a search object',
            yFamLine.split('\n').length === 7 && yFamLine.includes('search:') && yFamLine.includes('SPA p=') &&
            yFamLine.includes('StepM rejects=[') && yFamLine.includes('groups=40x40x40'), yFamLine.split('\n')[6]);
        const yCandLine = formatReport({ ...yReport, search: { pValue: 0.0123, rejected: true, alpha: 0.05 } });
        check('formatReport renders a single-candidate search attachment and reads report.search',
            yCandLine.includes('StepM p=0.0123') && yCandLine.includes('rejected=true') && yCandLine.split('\n').length === 7);
        check('the search line prints the family-wise p-value the search object reports',
            formatReport(yReport, { search: { pValue: yFamily.spaPValue, rejected: false, alpha: 0.05 } }).includes(`p=${yFamily.spaPValue.toFixed(4)}`));

        // --- walkForwardEvaluate exposes the family-wise inputs ----------------
        const yRets = yAr(1, 60, 0.3, 4242)[0];
        const yRep = walkForwardEvaluate({ returns: yRets, folds: walkForwardSplit({ n: 60, trainSize: 30, testSize: 10 }), signalForFold: (tr, te) => te.map(() => 1), costBps: 1, audit: false });
        check('walkForwardEvaluate exposes pooledReturns/pooledGross/foldLengths (the family-wise inputs)',
            Array.isArray(yRep.pooledReturns) && yRep.pooledReturns.length === yRep.pooledBars &&
            yRep.pooledReturns.every(Number.isFinite) && yRep.foldLengths.join(',') === '10,10,10' &&
            yRep.foldLengths.reduce((a, b) => a + b, 0) === yRep.pooledBars &&
            Array.isArray(yRep.pooledGross) && yRep.pooledGross.length === yRep.pooledBars);
    }

    // ---- Z. Generalised error rates on the same window grid ------------------
    // Item 9: beyond the FWER the same deterministic window law supports the two
    // standard generalisations (Romano & Wolf 2007, arXiv 0710.2258): the
    // SINGLE-STEP k-FWER, which bounds P(k or more false rejections) <= alpha and
    // has a finite-sample bound from the empirical window law, and the Romano-Wolf
    // / Delattre-Roquain FDP step-down heuristic (arXiv 1311.4030, EXPERIMENTAL).
    // The FDP step-down keeps the FULL-family reference and grows k with the step
    // index l (k_l = floor(fdpTarget*l)+1); the natural-looking alternative — the
    // k-th largest of the SURVIVOR set — is provably invalid and is recorded as a
    // rejected design in reality_check.js.
    {
        const zRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const zGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const zAr = (K, T, phi, seed) => {
            const r = zRng(seed);
            return Array.from({ length: K }, () => {
                const a = new Float64Array(T);
                let p = 0;
                for (let t = 0; t < T; t++) { p = phi * p + zGauss(r) * Math.sqrt(1 - phi * phi); a[t] = p; }
                return a;
            });
        };
        const zX = zAr(5, 100, 0.5, 31337);
        const zSortedWindows = (tWindows, nWindows, K) => {
            const out = [];
            for (let s = 0; s < nWindows; s++) out.push(Array.from(tWindows.slice(s * K, s * K + K)).sort((a, b) => b - a));
            return out;
        };

        // --- the single-step k-FWER, and its EXACT k=1 reduction -------------
        const zD = subsamplingStepM({ returnsMatrix: zX, alpha: 0.05 });
        const zSpaC = subsamplingSpa({ returnsMatrix: zX, consistent: true });
        const zK1 = subsamplingKfwer({ returnsMatrix: zX, alpha: 0.05, k: 1 });
        check('k-FWER k=1 shares the step-down window grid, ordering and best index',
            zK1.k === 1 && zK1.kClamped === false && zK1.order.join(',') === zD.order.join(',') &&
            zK1.nWindows === zD.nWindows && zK1.windowLength === zD.windowLength && zK1.bandwidth === zD.bandwidth &&
            zK1.bestIndex === zD.bestIndex && zK1.T === zD.T && zK1.K === zD.K);
        check('k-FWER k=1 p-value IS the max-t step-down first p-value IS the single-step consistent SPA p-value (exact)',
            zK1.pValues[zK1.bestIndex] === zD.stepPValues[zD.bestIndex] &&
            zK1.pValues[zK1.bestIndex] === zSpaC.pValue &&
            zK1.rejected[zK1.bestIndex] === zD.rejected[zD.bestIndex],
            `${zK1.pValues[zK1.bestIndex]} / ${zD.stepPValues[zD.bestIndex]} / ${zSpaC.pValue}`);
        check('k-FWER p-values are exact counts of windows whose k-th largest FULL-family statistic exceeds t_i',
            (() => {
                const K = zK1.K; const W = zK1.nWindows; const sorted = zSortedWindows(zD.tWindows, W, K);
                for (let i = 0; i < K; i++) {
                    for (const kk of [1, 2, 3, K]) {
                        let ex = 0;
                        for (let s = 0; s < W; s++) if (sorted[s][kk - 1] > zK1.tStats[i]) ex++;
                        const want = zK1.tStats[i] > 0 ? ex / W : 1;
                        if (subsamplingKfwer({ returnsMatrix: zX, alpha: 0.05, k: kk }).pValues[i] !== want) return false;
                    }
                }
                return true;
            })());

        // --- k > K clamps to K, where the reference is the window MINIMUM -----
        const zKK = subsamplingKfwer({ returnsMatrix: zX, alpha: 0.05, k: 999 });
        check('k-FWER clamps k > K to K and reports the clamp',
            zKK.k === zX.length && zKK.kClamped === true && zKK.requestedK === 999);
        check('the clamped k=K reference is the window MINIMUM (the K-th largest of K)',
            (() => {
                const K = zKK.K; const W = zKK.nWindows; const tw = zD.tWindows; const i = zKK.bestIndex;
                let ex = 0;
                for (let s = 0; s < W; s++) { let mn = Infinity; for (let q = 0; q < K; q++) { const v = tw[s * K + q]; if (v < mn) mn = v; } if (mn > zKK.tStats[i]) ex++; }
                return zKK.pValues[i] === ex / W;
            })());

        // --- monotonicity in k -----------------------------------------------
        const zSeqK = [1, 2, 3, 4, 5].map((k) => subsamplingKfwer({ returnsMatrix: zX, alpha: 0.05, k }));
        check('the k-FWER p-value of every candidate is non-increasing in k (the k-th largest shrinks)',
            zX.every((_, i) => zSeqK.every((r, j) => j === 0 || r.pValues[i] <= zSeqK[j - 1].pValues[i] + 1e-12)));
        check('the k-FWER rejection set grows with k',
            zSeqK.every((r, j) => j === 0 || r.nRejected >= zSeqK[j - 1].nRejected),
            zSeqK.map((r) => `${r.k}:${r.nRejected}`).join(','));

        let zThrew = 0;
        for (const bad of [{ k: 0 }, { k: -1 }, { k: 1.5 }, { k: NaN }]) { try { subsamplingKfwer({ returnsMatrix: zX, ...bad }); } catch { zThrew++; } }
        for (const bad of [{ alpha: 0 }, { alpha: 1 }]) { try { subsamplingKfwer({ returnsMatrix: zX, ...bad }); } catch { zThrew++; } }
        check('k-FWER rejects a bad k (0 / -1 / 1.5 / NaN) and a bad alpha (0 / 1) in 6 cases', zThrew === 6, `threw=${zThrew}`);

        // --- calibration under the global null (K=4 noise, 200 reps) ---------
        const zNull = (K, T, reps, seed) => {
            const rr = zRng(seed);
            let f1 = 0; let f2 = 0; let f2k1 = 0; let fdpAny = 0;
            for (let rep = 0; rep < reps; rep++) {
                const mtx = Array.from({ length: K }, () => { const a = new Float64Array(T); for (let t = 0; t < T; t++) a[t] = zGauss(rr) * 0.01; return a; });
                const r1 = subsamplingKfwer({ returnsMatrix: mtx, alpha: 0.05, k: 1 });
                const r2 = subsamplingKfwer({ returnsMatrix: mtx, alpha: 0.05, k: 2 });
                if (r1.nRejected >= 1) f1++;
                if (r2.nRejected >= 2) f2++;
                if (r1.nRejected >= 2) f2k1++;
                if (subsamplingFdp({ returnsMatrix: mtx, alpha: 0.05, fdpTarget: 0.1 }).nRejected >= 1) fdpAny++;
            }
            return { fwer: f1 / reps, kfwer2: f2 / reps, fwer2: f2k1 / reps, fdpAny: fdpAny / reps };
        };
        const zNull200 = zNull(4, 200, 200, 20260918);
        const zNull80 = zNull(4, 80, 200, 20260918);
        check('single-step k=1 holds the FWER at about the 5% level under the global null (pinned 0.07 at T=200, 0.04 at T=80)',
            close(zNull200.fwer, 0.07, 1e-4) && close(zNull80.fwer, 0.04, 1e-4) && zNull200.fwer <= 0.09 && zNull80.fwer <= 0.09,
            `${zNull200.fwer}/${zNull80.fwer}`);
        check('single-step k=2 holds the 2-FWER near nominal (pinned 0.075 at T=200, 0.055 at T=80) and stays far below the rejected survivor design',
            close(zNull200.kfwer2, 0.075, 1e-4) && close(zNull80.kfwer2, 0.055, 1e-4) && zNull200.kfwer2 <= 0.09 && zNull80.kfwer2 <= 0.09,
            `${zNull200.kfwer2}/${zNull80.kfwer2}`);
        check('the k=2 procedure is at least as liberal as the k=1 one (its order statistic is lower)',
            zNull200.kfwer2 >= zNull200.fwer2 - 1e-12 && zNull80.kfwer2 >= zNull80.fwer2 - 1e-12);
        check('the FDP step-down rejects nothing on the global null in ~95% of reps (pinned 0.07 at T=200, 0.04 at T=80), because its first step IS the max-t step',
            close(zNull200.fdpAny, 0.07, 1e-4) && close(zNull80.fdpAny, 0.04, 1e-4) && zNull200.fdpAny <= 0.09 && zNull80.fdpAny <= 0.09,
            `${zNull200.fdpAny}/${zNull80.fdpAny}`);

        // --- subsamplingFdp: the growing-k FDP step-down ---------------------
        const zFdp = subsamplingFdp({ returnsMatrix: zX, alpha: 0.05, fdpTarget: 0.1 });
        check('subsamplingFdp reports one entry per k with a (k-1)/R_k bound',
            zFdp.perK.length === zX.length && zFdp.perK.every((e) => (e.nRejected === 0 ? e.fdpBound === Infinity : e.fdpBound === (e.k - 1) / e.nRejected)));
        check('subsamplingFdp perK counts ARE the single-step k-FWER counts at that fixed k (exact)',
            zFdp.perK.every((e) => e.nRejected === subsamplingKfwer({ returnsMatrix: zX, alpha: 0.05, k: e.k }).nRejected));
        check('subsamplingFdp reports the (kHat-1)/R bound of the last cleared step',
            zFdp.nRejected === 0 ? zFdp.kHat === 0 && zFdp.estimatedFdp === null
                : (zFdp.estimatedFdp === (zFdp.kHat - 1) / zFdp.nRejected && zFdp.kHat >= 1 && zFdp.kHat <= zX.length),
            `kHat=${zFdp.kHat} R=${zFdp.nRejected}`);
        check('subsamplingFdp matches an independent mirror of the growing-k step-down (order, p-values, set, kHat, bound)',
            (() => {
                const K = zX.length; const W = zD.nWindows; const sorted = zSortedWindows(zD.tWindows, W, K); const tStats = zD.tStats;
                const order = Array.from({ length: K }, (_, i) => i).sort((a, b) => tStats[b] - tStats[a]);
                const kthP = (i, kk) => { const th = tStats[i]; if (!(th > 0)) return 1; let ex = 0; for (let s = 0; s < W; s++) if (sorted[s][kk - 1] > th) ex++; return ex / W; };
                const rej = new Array(K).fill(false); const sp = new Array(K).fill(1); let nr = 0; let kHat = 0;
                for (let l = 1; l <= K; l++) {
                    const idx = order[l - 1]; const kL = Math.min(Math.floor(0.1 * l) + 1, K); const p = kthP(idx, kL); sp[idx] = p;
                    if (p <= 0.05) { rej[idx] = true; nr++; kHat = kL; } else break;
                }
                const est = nr > 0 ? (kHat - 1) / nr : null;
                return zFdp.order.join(',') === order.join(',') && zFdp.stepPValues.every((p, i) => p === sp[i]) &&
                    zFdp.rejected.every((r, i) => r === rej[i]) && zFdp.nRejected === nr && zFdp.kHat === kHat && zFdp.estimatedFdp === est;
            })());
        check('the FDP step p-values are monotone down the descending-t order',
            zFdp.order.every((idx, j) => j === 0 || zFdp.stepPValues[idx] >= zFdp.stepPValues[zFdp.order[j - 1]] - 1e-15));
        check('the FDP rejection set is a prefix of the step-down order (a step-down, never a step-up)',
            zFdp.rejectedIndices.every((idx) => zFdp.order.indexOf(idx) < zFdp.nRejected),
            JSON.stringify(zFdp.rejectedIndices));

        const zPlanted = new Float64Array(90);
        for (let t = 1; t < 90; t++) zPlanted[t] = 0.02 + zGauss(zRng(7 + t)) * 0.004;
        const zStrong = [zPlanted, ...zAr(3, 90, 0.3, 99)];
        const zKfStrong = subsamplingKfwer({ returnsMatrix: zStrong, alpha: 0.05, k: 1 });
        const zFdpStrong = subsamplingFdp({ returnsMatrix: zStrong, alpha: 0.05, fdpTarget: 0.1 });
        check('single-step k-FWER recovers a planted strong edge', zKfStrong.rejected[0] === true, `p=${zKfStrong.pValues[0]}`);
        check('subsamplingFdp recovers a planted strong edge with a zero estimated FDP (kHat=1)',
            zFdpStrong.nRejected >= 1 && zFdpStrong.rejectedIndices.includes(0) && zFdpStrong.estimatedFdp === 0,
            JSON.stringify(zFdpStrong.rejectedIndices));

        let zThrew2 = 0;
        for (const bad of [{ fdpTarget: 0 }, { fdpTarget: 1 }, { fdpTarget: 2 }]) { try { subsamplingFdp({ returnsMatrix: zX, ...bad }); } catch { zThrew2++; } }
        check('subsamplingFdp rejects a bad fdpTarget (0 / 1 / >1) in 3 cases', zThrew2 === 3, `threw=${zThrew2}`);

        // --- familywiseSearch / walkForwardSearch thread fdpTarget and kfwer --
        const zFam = familywiseSearch({ strategies: zX, groups: [50, 50], labels: ['a', 'b', 'c', 'd', 'e'], fdpTarget: 0.1, kfwer: 2 });
        check('familywiseSearch attaches a labelled FDP result when fdpTarget is set',
            zFam.fdp && zFam.fdp.fdpTarget === 0.1 && Array.isArray(zFam.fdp.rejectedLabels) &&
            zFam.fdp.rejectedLabels.length === zFam.fdp.nRejected);
        check('familywiseSearch attaches a labelled k-FWER result when kfwer is set, and mirrors it per candidate',
            zFam.kfwer && zFam.kfwer.k === 2 && zFam.kfwer.rejectedLabels.length === zFam.kfwer.nRejected &&
            zFam.candidates.every((c) => c.kfwerPValue === zFam.kfwer.pValues[c.index] && c.kfwerRejected === zFam.kfwer.rejected[c.index]),
            `k=${zFam.kfwer && zFam.kfwer.k} rej=${zFam.kfwer && zFam.kfwer.nRejected}`);
        check('familywiseSearch defaults leave both generalisations null (strictly additive)',
            (() => { const r = familywiseSearch({ strategies: zX, groups: [50, 50] }); return r.fdp === null && r.kfwer === null && r.candidates.every((c) => c.kfwerPValue === null && c.kfwerRejected === false); })());

        const zBaseRep = { pooledReturns: zX[0], foldLengths: [30, 30, 30, 10] };
        const zCandReps = [{ pooledReturns: zX[1] }, { pooledReturns: zX[2] }];
        const zWfs = walkForwardSearch({ baseline: zBaseRep, candidates: zCandReps, labels: ['b', 'c'], fdpTarget: 0.1, kfwer: 2 });
        check('walkForwardSearch passes fdpTarget and kfwer through to the family-wise test',
            zWfs.fdp && zWfs.fdp.fdpTarget === 0.1 && zWfs.kfwer && zWfs.kfwer.k === 2 &&
            zWfs.candidates.length === 3 && zWfs.baselineIndex === 0);

        // --- promoteDecision maxFdp is strictly additive ----------------------
        const zB = { aggregate: { mean: 0, positiveFraction: 0 }, pooledMetrics: { dsr: 0.1 }, folds: [{ metrics: { netSharpe: 0 } }], audit: { clean: true } };
        const zGood = { aggregate: { mean: 1, positiveFraction: 1 }, pooledMetrics: { dsr: 0.99 }, folds: [{ metrics: { netSharpe: 2 } }], audit: { clean: true }, search: { fdp: { kHat: 2, nRejected: 3, estimatedFdp: 0.05 } } };
        const zBadFdp = { ...zGood, search: { fdp: { kHat: 2, nRejected: 3, estimatedFdp: 0.5 } } };
        const zNoFdp = { ...zGood, search: { pValue: 0.01, rejected: true } };
        const zNoSearch = { ...zGood, search: undefined };
        check('default promoteDecision ignores any search/FDP attachment (byte-identical gate)',
            promoteDecision(zB, zGood).reasons.length === 0 && promoteDecision(zB, zBadFdp).reasons.length === 0);
        check('maxFdp accepts a candidate whose estimated FDP clears the target', promoteDecision(zB, zGood, { maxFdp: 0.1 }).reasons.length === 0);
        check('maxFdp rejects a candidate whose estimated FDP exceeds the target', promoteDecision(zB, zBadFdp, { maxFdp: 0.1 }).reasons.some((r) => r.includes('estimated FDP 0.5 > 0.1')));
        check('maxFdp flags a missing FDP estimate', promoteDecision(zB, zNoFdp, { maxFdp: 0.1 }).reasons.some((r) => r.includes('FDP estimate missing')));
        check('maxFdp flags a fully missing search attachment', promoteDecision(zB, zNoSearch, { maxFdp: 0.1 }).reasons.some((r) => r.includes('FDP estimate missing')));

        // --- formatReport renders the k-FWER and FDP lines --------------------
        const zRepStub = { pooledMetrics: {}, aggregate: {}, folds: [], pooledBars: 1, audit: { clean: true } };
        const zLine = formatReport(zRepStub, { search: zFam });
        check('formatReport prints the k-FWER line when the search object carries one', zLine.includes('kfwer: k=2'), zLine.split('\n')[6]);
        check('formatReport prints the FDP line when the search object carries one', zLine.includes('fdp:') && zLine.includes('target=0.1'));
        check('formatReport default (no kfwer/fdp) still prints the plain StepM line, 7 lines total',
            (() => { const l = formatReport(zRepStub, { search: familywiseSearch({ strategies: zX, groups: [50, 50] }) }); return l.includes('StepM rejects=') && !l.includes('fdp:') && !l.includes('kfwer:') && l.split('\n').length === 7; })());
    }

    // ---- AA. Generalised error rates on a MIXTURE family --------------------
    // Item 10: section Z proves SIZE under the global null; this proves the
    // POWER / FDP trade-off when the family is a mix of true edges and nulls, on
    // the same deterministic window grid. A planted fraction of candidates
    // carries a real mean edge; the rest are AR noise. Measured: (a) k-FWER gains
    // power as k grows while FWER / 2-FWER stay <= alpha; (b) the Delattre-Roquain
    // FDP step-down recovers more edges as the target loosens, with realised FDP
    // below the target on these mixtures (it is conservative, not anti-conservative
    // — the anti-conservative survivor-order-statistic design is recorded as
    // rejected in reality_check.js, which is why `subsamplingFdp` is EXPERIMENTAL).
    {
        const aRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const aGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const aMix = (rr, K, T, phi, nEdge, mu, sigma) => {
            const mtx = [];
            for (let i = 0; i < K; i++) {
                const a = new Float64Array(T);
                let p = 0; const shift = i < nEdge ? mu : 0;
                for (let t = 0; t < T; t++) { p = phi * p + aGauss(rr) * Math.sqrt(1 - phi * phi); a[t] = p * sigma + shift; }
                mtx.push(a);
            }
            return mtx;
        };
        const aStudy = (K, T, phi, nEdge, mu, sigma, reps, seed, fdpTargets) => {
            const rr = aRng(seed);
            let fwer = 0; let kfwer2 = 0; let tp1 = 0; let tp2 = 0; let rej1 = 0; let rej2 = 0; let stepMRej = 0;
            const acc = fdpTargets.map(() => ({ rej: 0, tp: 0, fp: 0, kHat: 0, anyFalse: 0, est: 0, estN: 0 }));
            for (let rep = 0; rep < reps; rep++) {
                const mtx = aMix(rr, K, T, phi, nEdge, mu, sigma);
                const r1 = subsamplingKfwer({ returnsMatrix: mtx, alpha: 0.05, k: 1 });
                const r2 = subsamplingKfwer({ returnsMatrix: mtx, alpha: 0.05, k: 2 });
                let f1 = 0; let f2 = 0;
                for (let i = 0; i < K; i++) {
                    if (r1.rejected[i]) { rej1++; if (i < nEdge) tp1++; else f1++; }
                    if (r2.rejected[i]) { rej2++; if (i < nEdge) tp2++; else f2++; }
                }
                if (f1 >= 1) fwer++;
                if (f2 >= 2) kfwer2++;
                stepMRej += subsamplingStepM({ returnsMatrix: mtx, alpha: 0.05 }).nRejected;
                fdpTargets.forEach((ft, j) => {
                    const rf = subsamplingFdp({ returnsMatrix: mtx, alpha: 0.05, fdpTarget: ft });
                    const a = acc[j];
                    a.rej += rf.nRejected; a.kHat += rf.kHat;
                    let fp = 0;
                    for (const idx of rf.rejectedIndices) { if (idx < nEdge) a.tp++; else { a.fp++; fp++; } }
                    if (fp >= 1) a.anyFalse++;
                    if (rf.estimatedFdp !== null) { a.est += rf.estimatedFdp; a.estN++; }
                });
            }
            return {
                fwer: fwer / reps, kfwer2: kfwer2 / reps,
                power1: tp1 / (reps * nEdge), power2: tp2 / (reps * nEdge),
                rej1: rej1 / reps, rej2: rej2 / reps, stepM: stepMRej / reps,
                fdp: acc.map((a) => ({ rej: a.rej / reps, tp: a.tp / reps, fp: a.fp / reps, kHat: a.kHat / reps, anyFalse: a.anyFalse / reps, est: a.estN ? a.est / a.estN : null, realised: a.rej > 0 ? a.fp / a.rej : null })),
            };
        };

        // --- (a) the k-FWER size/power trade-off on a weak 2-edge family ------
        const aA = aStudy(6, 200, 0.5, 2, 0.002, 0.01, 200, 424242, [0.1]);
        check('mixture: k=2 k-FWER is strictly more powerful than k=1 on a weak 2-edge family (pinned 0.155 -> 0.4975)',
            close(aA.power1, 0.155, 1e-4) && close(aA.power2, 0.4975, 1e-4) && aA.power2 > aA.power1 + 0.1,
            `${aA.power1}/${aA.power2}`);
        check('mixture: both k-FWER sizes stay at or below alpha (FWER 0.035, 2-FWER 0.025 pinned)',
            close(aA.fwer, 0.035, 1e-4) && close(aA.kfwer2, 0.025, 1e-4) && aA.fwer <= 0.05 && aA.kfwer2 <= 0.05,
            `${aA.fwer}/${aA.kfwer2}`);
        check('mixture: on a sparse 2-edge family the FDP step-down can slightly OVER-run a tight target (realised 0.1014 > 0.10 with est 0) — the honest finite-sample non-control that keeps it EXPERIMENTAL',
            close(aA.fdp[0].realised, 0.1014, 2e-3) && aA.fdp[0].realised > 0.1 && aA.fdp[0].est === 0,
            `${aA.fdp[0].realised}`);

        // --- (b) recovery of a denser mixture (4 edges in 12) -----------------
        const aB = aStudy(12, 200, 0.3, 4, 0.005, 0.01, 100, 777, [0.1]);
        check('mixture: 4 of 12 planted edges are recovered by k=1 (power 0.915 pinned) and near-fully by k=2 (0.9975)',
            close(aB.power1, 0.915, 1e-4) && close(aB.power2, 0.9975, 1e-4),
            `${aB.power1}/${aB.power2}`);
        check('mixture: the 4-edge family stays size-controlled (FWER 0.05, 2-FWER 0.05 pinned)',
            close(aB.fwer, 0.05, 1e-4) && close(aB.kfwer2, 0.05, 1e-4) && aB.fwer <= 0.05 && aB.kfwer2 <= 0.05,
            `${aB.fwer}/${aB.kfwer2}`);
        check('mixture: the FDP step-down is conservative on the 4-edge family too (realised FDP <= 0.1)',
            aB.fdp[0].realised !== null && aB.fdp[0].realised <= 0.1, `${aB.fdp[0].realised}`);

        // --- (c) the FDP step-down on a large mixed family --------------------
        const aC = aStudy(20, 200, 0.3, 10, 0.004, 0.01, 60, 909, [0.1, 0.2, 0.3]);
        check('mixture: the FDP step-down rejects monotonically more as the target loosens (pinned 6.833 < 9.05 < 9.783 of 20)',
            close(aC.fdp[0].rej, 6.833, 3e-3) && close(aC.fdp[1].rej, 9.05, 3e-3) && close(aC.fdp[2].rej, 9.783, 3e-3) &&
            aC.fdp[0].rej < aC.fdp[1].rej && aC.fdp[1].rej < aC.fdp[2].rej,
            `${aC.fdp[0].rej}/${aC.fdp[1].rej}/${aC.fdp[2].rej}`);
        check('mixture: the reported kHat grows with the target (pinned 1.2 / 2.6 / 3.7)',
            close(aC.fdp[0].kHat, 1.2, 3e-3) && close(aC.fdp[1].kHat, 2.6, 3e-3) && close(aC.fdp[2].kHat, 3.7, 3e-3),
            `${aC.fdp[0].kHat}/${aC.fdp[1].kHat}/${aC.fdp[2].kHat}`);
        check('mixture: realised FDP stays below the target at every setting (vs 0.1 / 0.2 / 0.3)',
            aC.fdp[0].realised <= 0.1 && aC.fdp[1].realised <= 0.2 && aC.fdp[2].realised <= 0.3,
            `${aC.fdp[0].realised}/${aC.fdp[1].realised}/${aC.fdp[2].realised}`);
        check('mixture: at the loosest target the FDP step-down recovers more planted edges than the strict max-t step-down (pinned 9.783 vs 7.0)',
            aC.fdp[2].tp > aC.stepM && close(aC.stepM, 7.0, 3e-3) && aC.fdp[2].tp > aC.fdp[0].tp,
            `tp=${aC.fdp[2].tp.toFixed(3)} stepM=${aC.stepM.toFixed(3)}`);
        check('mixture: on the global null the FDP step-down degenerates to the max-t step (pinned 0.017 rejections) with kHat ~0',
            (() => { const a0 = aStudy(20, 200, 0.3, 0, 0, 0.01, 60, 909, [0.2]); return close(a0.fdp[0].rej, 0.017, 2e-3) && close(a0.stepM, 0.017, 2e-3) && close(a0.fdp[0].kHat, 0.017, 2e-3); })());
    }
    // ---- AB. edge cases and invariants for the generalised error rates ------
    // Bug-hunt around the section-Z/AA procedures: the silent-wrong-answer
    // surfaces are the degenerate families (K=1, all-zero, exact ties, a
    // series benchmark), the `groups` interaction, and the alpha/target
    // extremes. These are invariants, not new calibration.
    {
        const bRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
        const bGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const bAr = (K, T, phi, seed) => {
            const r = bRng(seed);
            return Array.from({ length: K }, () => {
                const a = new Float64Array(T);
                let p = 0;
                for (let t = 0; t < T; t++) { p = phi * p + bGauss(r) * Math.sqrt(1 - phi * phi); a[t] = p; }
                return a;
            });
        };

        // K=1: the procedures need a family of at least 2 candidates and say so
        const one = [Float64Array.from([0.01, 0.02, -0.005, 0.03, 0.0, 0.01, 0.02, 0.0, 0.015, 0.005, 0.02, 0.01])];
        let oneThrew = 0;
        try { subsamplingKfwer({ returnsMatrix: one, k: 2 }); } catch { oneThrew++; }
        try { subsamplingFdp({ returnsMatrix: one, fdpTarget: 0.2 }); } catch { oneThrew++; }
        check('AB: a single-candidate family throws for both procedures (K >= 2 required)', oneThrew === 2, `threw=${oneThrew}`);

        // all-zero: no candidate over-performs -> the t=0 guard rejects nothing
        const zeros = Array.from({ length: 5 }, () => new Float64Array(60));
        const zK = subsamplingKfwer({ returnsMatrix: zeros, k: 1 });
        const zF = subsamplingFdp({ returnsMatrix: zeros, fdpTarget: 0.1 });
        check('AB: an all-zero family rejects nothing (t=0 guard) with p=1 and kHat 0',
            zK.nRejected === 0 && zK.pValues.every((p) => p === 1) && zF.nRejected === 0 && zF.kHat === 0 && zF.estimatedFdp === null);

        // exact ties: identical candidates must share a statistic and a decision
        const base = Float64Array.from(Array.from({ length: 80 }, (_, t) => 0.004 + 0.01 * Math.sin(t)));
        const tied = [base, base, Float64Array.from(Array.from({ length: 80 }, (_, t) => 0.01 * Math.cos(t)))];
        const tK = subsamplingKfwer({ returnsMatrix: tied, k: 2 });
        check('AB: perfectly tied candidates share a statistic, a p-value and a decision',
            tK.tStats[0] === tK.tStats[1] && tK.rejected[0] === tK.rejected[1] && tK.pValues[0] === tK.pValues[1]);

        // series benchmark: a candidate equal to the benchmark has a zero relative
        // series, so it is never rejected
        const bench = Float64Array.from(Array.from({ length: 70 }, (_, t) => (t % 3) * 0.001));
        const bMat = [bench, Float64Array.from(Array.from({ length: 70 }, (_, t) => 0.002 + (t % 3) * 0.001))];
        const bK = subsamplingKfwer({ returnsMatrix: bMat, benchmark: bench, k: 1 });
        check('AB: a series benchmark zeroes the candidate that equals it',
            bK.tStats[0] === 0 && bK.rejected[0] === false);

        // groups: deterministic, and groups=[T] is bit-identical to ungrouped
        const gx = bAr(4, 120, 0.4, 5150);
        const gA = subsamplingKfwer({ returnsMatrix: gx, k: 2 });
        const gB = subsamplingKfwer({ returnsMatrix: gx, k: 2, groups: [120] });
        const gC = subsamplingFdp({ returnsMatrix: gx, fdpTarget: 0.1 });
        const gD = subsamplingFdp({ returnsMatrix: gx, fdpTarget: 0.1, groups: [120] });
        check('AB: groups=[T] is bit-identical to the ungrouped path for k-FWER and FDP',
            gA.pValues.every((p, i) => p === gB.pValues[i]) && gA.nRejected === gB.nRejected &&
            gC.rejected.every((r, i) => r === gD.rejected[i]) && gC.stepPValues.every((p, i) => p === gD.stepPValues[i]));

        // target extremes: tiny target keeps kHat 1; loosening never reduces rejections
        const fT = subsamplingFdp({ returnsMatrix: gx, fdpTarget: 0.001 });
        const fH = subsamplingFdp({ returnsMatrix: gx, fdpTarget: 0.9 });
        check('AB: a tiny FDP target keeps kHat at 1 and loosening never reduces rejections',
            (fT.nRejected === 0 || fT.kHat === 1) && fH.nRejected >= fT.nRejected,
            `tiny=${fT.nRejected}/${fT.kHat} loose=${fH.nRejected}/${fH.kHat}`);

        // alpha monotonicity: a smaller alpha cannot reject more
        const aT = subsamplingKfwer({ returnsMatrix: gx, k: 2, alpha: 1e-9 });
        check('AB: a near-zero alpha never rejects more than the 5% level', aT.nRejected <= gA.nRejected);

        // invalid inputs throw for both procedures
        let abThrew = 0;
        for (const bad of [undefined, [], [new Float64Array(0)]]) {
            try { subsamplingKfwer({ returnsMatrix: bad, k: 1 }); } catch { abThrew++; }
            try { subsamplingFdp({ returnsMatrix: bad, fdpTarget: 0.1 }); } catch { abThrew++; }
        }
        check('AB: a missing / empty / too-short matrix throws for both procedures (6 cases)', abThrew === 6, `threw=${abThrew}`);
    }

    // ---- AC. the causal signal family + report pooling (round 23 N1/N2) -----
    // `analysis/features.js` is what the A/B actually compares against its
    // baseline, so its arithmetic is pinned with exact reference vectors here;
    // `poolReports`/`poolFolds` are pinned as the merge that carries a one-stream
    // report through untouched.
    {
        // --- clampPosition / the position pipeline --------------------------
        check('AC: clampPosition saturates at +/-1 and is exact in between',
            clampPosition(0) === 0 && close(clampPosition(1), 0.5, 1e-15) &&
            clampPosition(2) === 1 && clampPosition(3) === 1 && clampPosition(-3) === -1);
        check('AC: clampPosition is odd and bounded, and abstains (0) on a non-finite z or a bad saturation',
            [-5, -1.3, 0.4, 2.7].every((z) => clampPosition(-z, { saturation: 2 }) === -clampPosition(z, { saturation: 2 })) &&
            clampPosition(NaN) === 0 && clampPosition(Infinity) === 0 && clampPosition(-Infinity) === 0 &&
            clampPosition(1, { saturation: 0 }) === 0);
        check('AC: DEFAULT_POSITION is frozen with a positive saturation / window / minObs',
            Object.isFrozen(DEFAULT_POSITION) && DEFAULT_POSITION.saturation > 0 &&
            DEFAULT_POSITION.zWindow > 0 && DEFAULT_POSITION.minObs > 0);

        // --- the eight features, exact reference vectors ---------------------
        check('AC: momentum is the exact trailing return sum',
            momentum({ returns: [1, 2, 3, 4, 5, 6] }, 5, { window: 3 }) === 15);
        check('AC: momentum is NaN when the window runs off the start of the series',
            Number.isNaN(momentum({ returns: [1, 2, 3] }, 1, { window: 3 })));

        const eCloses = [1, Math.E, Math.exp(3)];
        check('AC: fracDiffAt with d=1 is the one-bar log difference and NaN before the window is full',
            close(fracDiffAt(eCloses, 2, { d: 1, window: 2 }), 2, 1e-12) &&
            Number.isNaN(fracDiffAt(eCloses, 0, { d: 1, window: 2 })));
        check('AC: fracMomentum with d=1 is the second difference of the log price',
            close(fracMomentum({ closes: eCloses }, 2, { d: 1, window: 2 }), 1, 1e-12));
        check('AC: volRegime is exactly 0 when both windows are the same length, -1 when the short window is flat, and >0 when the short window is hotter',
            volRegime({ returns: Array.from({ length: 40 }, (_, i) => (i % 2 ? -1 : 1)) }, 39, { window: 32, long: 32 }) === 0 &&
            volRegime({ returns: [].concat(new Array(24).fill(1), new Array(8).fill(5)) }, 31, { window: 8, long: 32 }) === -1 &&
            volRegime({ returns: [].concat(new Array(24).fill(0), [10, -10, 10, -10, 10, -10, 10, -10]) }, 31, { window: 8, long: 32 }) > 0 &&
            Number.isNaN(volRegime({ returns: new Array(40).fill(0) }, 39, { window: 8, long: 32 })));
        check('AC: momentumAgreement is exactly +1 / -1 when every lens agrees',
            momentumAgreement({ returns: new Array(40).fill(1) }, 39) === 1 &&
            momentumAgreement({ returns: new Array(40).fill(-1) }, 39) === -1);
        check('AC: rangeLocation is exact (close at the top of the range -> +0.5, at the bottom -> -0.5, middle -> 0) and NaN on a flat range',
            rangeLocation({ closes: [10, 20, 30, 20, 10, 20] }, 2, { window: 3 }) === 0.5 &&
            rangeLocation({ closes: [10, 20, 30, 20, 10, 20] }, 4, { window: 5 }) === -0.5 &&
            rangeLocation({ closes: [10, 20, 30, 20, 10, 20] }, 5, { window: 5 }) === 0 &&
            Number.isNaN(rangeLocation({ closes: new Array(8).fill(7) }, 7, { window: 8 })));
        check('AC: volumeImbalance is the exact short/long mean ratio minus 1',
            close(volumeImbalance({ volumes: [].concat(new Array(24).fill(100), new Array(8).fill(200)) }, 31, { window: 8, long: 32 }), 0.6, 1e-12));
        check('AC: autocorr1 is exactly -1 for a zero-mean alternating series over an even window',
            autocorr1({ returns: Array.from({ length: 40 }, (_, i) => (i % 2 ? -1 : 1)) }, 31, { window: 4 }) === -1);
        check('AC: acceleration is the exact momentum change over one window',
            acceleration({ returns: [0, 1, 2, 3, 4, 5, 6, 7] }, 7, { window: 2 }) === 4);

        // --- the causal z-score pipeline -------------------------------------
        const ramp = { returns: [1, 2, 3, 4] };
        const oneBar = (s, t) => s.returns[t];
        check('AC: causalZScore is the exact (raw - mean)/sample-std of the trailing window',
            close(causalZScore(oneBar, ramp, 3, { window: 1, zWindow: 4, minObs: 2 }), 1.5 / Math.sqrt(5 / 3), 1e-12),
            `${causalZScore(oneBar, ramp, 3, { window: 1, zWindow: 4, minObs: 2 })}`);
        check('AC: causalZScore abstains (0) below minObs and on a zero-variance window',
            causalZScore(oneBar, ramp, 3, { window: 1, zWindow: 4, minObs: 10 }) === 0 &&
            causalZScore(() => 0.25, ramp, 3, { window: 1, zWindow: 4, minObs: 2 }) === 0);
        check('AC: positionAt is the exact clamped z-score',
            close(positionAt({ fn: oneBar, window: 1, zWindow: 4, minObs: 2, saturation: 2 }, ramp, 3), (1.5 / Math.sqrt(5 / 3)) / 2, 1e-12));

        // --- causality: a position at t never reads t+1.. --------------------
        const T = 80;
        const baseReturns = Array.from({ length: T }, (_, i) => Math.sin(i * 0.7) * 0.01 + 0.002);
        const baseCloses = [100];
        for (let i = 1; i < T; i++) baseCloses.push(baseCloses[i - 1] * (1 + baseReturns[i]));
        const baseVolumes = Array.from({ length: T }, (_, i) => 100 + (i % 7) * 10);
        const series1 = { returns: baseReturns, closes: baseCloses, volumes: baseVolumes };
        const series2 = {
            returns: baseReturns.concat(Array.from({ length: 25 }, () => 0.5)),
            closes: baseCloses.concat(Array.from({ length: 25 }, (_, k) => baseCloses[T - 1] * (1 + 0.9 * k))),
            volumes: baseVolumes.concat(new Array(25).fill(1e6)),
        };
        const t0 = 65;
        const pos1 = SIGNAL_CANDIDATES.map((c) => positionAt(c, series1, t0));
        const pos2 = SIGNAL_CANDIDATES.map((c) => positionAt(c, series2, t0));
        check('AC: every candidate position at t is invariant to every value after t (causal by construction)',
            pos1.every((p, i) => p === pos2[i]), JSON.stringify(pos1));
        check('AC: the causality check is non-vacuous (at least one candidate is non-zero at t)',
            pos1.some((p) => p !== 0), JSON.stringify(pos1));

        // --- the candidate table + the signal entry point --------------------
        check('AC: SIGNAL_CANDIDATES is a frozen family of uniquely-idd, well-formed candidates',
            Object.isFrozen(SIGNAL_CANDIDATES) && SIGNAL_CANDIDATES.length >= 8 &&
            new Set(SIGNAL_CANDIDATES.map((c) => c.id)).size === SIGNAL_CANDIDATES.length &&
            SIGNAL_CANDIDATES.every((c) => c.kind === 'signal' && typeof c.fn === 'function' && c.window > 0 && typeof c.label === 'string'));
        const viewFull = { returns: baseReturns, closes: baseCloses, volumes: baseVolumes };
        const sigFull = SIGNAL_CANDIDATES.map((c) => signalForCandidate(c)(viewFull, [60, 65, 70]));
        check('AC: every signal returns one finite position per test bar inside [-1, 1]',
            sigFull.every((s) => s.length === 3 && s.every((p) => Number.isFinite(p) && p >= -1 && p <= 1)));
        const viewReturnsOnly = { returns: baseReturns };
        const rangeSig = signalForCandidate(SIGNAL_CANDIDATES.find((c) => c.id === 'sig-range'))(viewReturnsOnly, [60, 65, 70]);
        const momSig = signalForCandidate(SIGNAL_CANDIDATES.find((c) => c.id === 'sig-momentum'))(viewReturnsOnly, [60, 65, 70]);
        check('AC: a close-dependent candidate abstains on a returns-only view while the returns-based one still trades',
            rangeSig.every((p) => p === 0) && momSig.some((p) => p !== 0), `range=${rangeSig} mom=${momSig}`);
        check('AC: a signal on an empty view never throws', SIGNAL_CANDIDATES.every((c) => signalForCandidate(c)({}, [0, 1]).every((p) => p === 0)));

        // --- report pooling (N2) --------------------------------------------
        check('AC: sharpeStandardError is the exact Lo (2002) closed form (annualised)',
            close(wfSharpeStandardError(0, 252, 252), 1, 1e-12) &&
            close(wfSharpeStandardError(1, 252, 252), Math.sqrt((252 + 0.5) / 252), 1e-12) &&
            Number.isNaN(wfSharpeStandardError(NaN, 10)) && Number.isNaN(wfSharpeStandardError(1, 0)));
        check('AC: minimumDetectableSharpe is 1.96*SE and NaN without a sample',
            close(minimumDetectableSharpe(0, 252, 252), 1.959964, 1e-6) && Number.isNaN(minimumDetectableSharpe(1, 0)));

        const rA = {
            folds: [{ testStart: 0, testEnd: 1, metrics: { netSharpe: 1, turnover: 0.5, tradeCount: 2, totalCost: 0.001 } }],
            pooledReturns: [0.01, 0.02], pooledGross: [0.011, 0.021], foldLengths: [2],
            pooledMetrics: { netSharpe: 1 }, aggregate: { mean: 1 },
            audit: { clean: true, reachable: true, viewDiffers: true, vacuous: false, probes: 2, violations: [] },
            probed: true,
        };
        const rB = {
            folds: [{ testStart: 2, testEnd: 2, metrics: { netSharpe: -1, turnover: 0.25, tradeCount: 1, totalCost: 0.002 } }],
            pooledReturns: [-0.01], pooledGross: [-0.009], foldLengths: [1],
            pooledMetrics: { netSharpe: -1 }, aggregate: { mean: -1 },
            audit: { clean: false, reachable: true, viewDiffers: true, vacuous: false, probes: 3, violations: [{ bar: 5 }] },
        };
        check('AC: poolReports of a single report returns that exact object (one-stream path unchanged)',
            poolReports([rA]) === rA);
        const merged = poolReports([rA, rB], { periodsPerYear: 252, trials: 2 });
        check('AC: poolReports concatenates folds / pooled returns / gross returns across streams',
            merged.folds.length === 2 && merged.folds[0] === rA.folds[0] && merged.folds[1] === rB.folds[0] &&
            JSON.stringify(merged.pooledReturns) === '[0.01,0.02,-0.01]' &&
            JSON.stringify(merged.pooledGross) === '[0.011,0.021,-0.009]' && merged.pooledBars === 3);
        check('AC: poolReports merges the audit conservatively (probes summed, any dirty stream dirties the merge)',
            merged.audit.probes === 5 && merged.audit.clean === false && merged.audit.violations.length === 1 && merged.audit.streams === 2);
        check('AC: poolReports attaches a power summary for the pooled stream',
            merged.power && merged.power.bars === 3 && Number.isFinite(merged.power.se) &&
            merged.power.underpowered === true && merged.power.barsToDetect1 === 969);
        check('AC: poolReports uses poolFolds (the per-fold strategy aggregates survive the merge)',
            merged.pooledMetrics.turnover === 0.75 && merged.pooledMetrics.tradeCount === 3 &&
            close(merged.meanFoldSharpe, 0, 1e-12));
        let poolThrew = 0;
        try { poolReports([]); } catch { poolThrew++; }
        try { poolReports(null); } catch { poolThrew++; }
        check('AC: poolReports rejects an empty / non-array report list', poolThrew === 2);

        // --- the audited candle view (N0) -----------------------------------
        const kCandles = Array.from({ length: 30 }, (_, i) => ({ timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i }));
        check('AC: shockFactor is 1 at and before `after`, inside (1, 1+2*probe] after it, and independent of the array',
            shockFactor(5, { after: 5, probe: 0.05 }) === 1 && shockFactor(4, { after: 5, probe: 0.05 }) === 1 &&
            [6, 7, 8, 19].every((t) => shockFactor(t, { after: 5, probe: 0.05 }) > 1 && shockFactor(t, { after: 5, probe: 0.05 }) <= 1.1));
        check('AC: shockCandles is deterministic, does not mutate its input, and leaves bars <= after untouched',
            (() => {
                const before = JSON.stringify(kCandles);
                const s1 = shockCandles(kCandles, { after: 10, probe: 0.05 });
                const s2 = shockCandles(kCandles, { after: 10, probe: 0.05 });
                return JSON.stringify(s1) === JSON.stringify(s2) && JSON.stringify(kCandles) === before &&
                    s1.slice(0, 11).every((c, i) => c === kCandles[i]) && s1.slice(11).every((c, i) => c !== kCandles[i + 11] && c.close > 0);
            })());
        check('AC: shockCandles with perturb=null is the input array (base pass uses the real candles)',
            shockCandles(kCandles, null) === kCandles);
        check('AC: makeCandleViewFor returns real candles on the base pass and a self-consistent shocked view on a probe pass',
            (() => {
                const viewFor = makeCandleViewFor(kCandles);
                const base = viewFor(null, null);
                const probe = viewFor(null, { after: 10, probe: 0.05 });
                return base.candles === kCandles && base.closes !== probe.closes &&
                    probe.candles !== kCandles && probe.closes.length === 30 && probe.returns.length === 30 &&
                    probe.returns[29] === barReturns(probe.closes)[29] &&
                    base.volumes.length === 30 && probe.volumes.length === 30;
            })());
        check('AC: worldFromCandles aligns candles / closes / volumes / returns and honours maxBars',
            (() => {
                const w = worldFromCandles(kCandles);
                const w2 = worldFromCandles(kCandles, { maxBars: 10 });
                return w.candles.length === 30 && w.closes.length === 30 && w.volumes.length === 30 && w.returns.length === 30 &&
                    w2.candles.length === 10 && w2.closes[0] === kCandles[20].close && w2.volumes[0] === kCandles[20].volume;
            })());
        check('AC: the default shock is a bounded non-zero probe', DEFAULT_SHOCK.probe > 0 && DEFAULT_SHOCK.probe < 0.5 && DEFAULT_SHOCK.frequency > 0);

        // ---- AB. Dependence-aware inference (round 25) ----------------------
        // The pooled cross-stream report is a rectangular fold grid, so the i.i.d.
        // Lo (2002) SE is wrong twice over (correlated streams, repeated calendar
        // windows). These check the pure primitives that measure it against exact
        // hand-computed values, then the wiring that puts them on the report.
        {
            const abClose = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
            // Self-contained RNG helpers: the section's earlier helpers are scoped
            // to their own block, so AB must not reach for them.
            const abRng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; };
            const abGauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
            const abWalk = (seed, n, rho = 0) => { const r = abRng(seed); const out = new Array(n).fill(0); for (let x = 1; x < n; x++) out[x] = rho * out[x - 1] + 0.01 * abGauss(r); return out; };
            // Strip a report's cross-stream panel, to pin what a single-stream run
            // looks like to the round-25 gate.
            const abStripPanel = (r) => ({
                ...r,
                streamReturns: undefined,
                streamFoldLengths: undefined,
                dependence: { available: false, reason: 'single stream' },
                pooledMetrics: { ...r.pooledMetrics, dsrAdjusted: null },
            });

            // --- Pearson + the equicorrelation design effect (Kish 1965) ------
            check('AD: pearsonCorrelation is exactly +1/-1 on an affine pair and its exact value on a hand-computed triple',
                pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]) === 1 &&
                pearsonCorrelation([1, 2, 3, 4], [4, 3, 2, 1]) === -1 &&
                abClose(pearsonCorrelation([1, 2, 3], [1, 2, 4]), 0.9819805060619656, 1e-12));
            check('AD: pearsonCorrelation returns NaN (never a silent 0) for a short pair or a zero-variance member',
                Number.isNaN(pearsonCorrelation([1, 2], [1, 2])) && Number.isNaN(pearsonCorrelation([1, 1, 1], [1, 2, 3])) &&
                Number.isNaN(pearsonCorrelation([1, 2, 3], [1, 2])) && Number.isNaN(pearsonCorrelation('x', [1, 2, 3])));
            check('AD: meanPairwiseCorrelation averages only the correlations it can compute (uncorrelatable pairs are skipped, not zeroed)',
                abClose(meanPairwiseCorrelation([[1, 2, 3, 4], [2, 4, 6, 8], [4, 3, 2, 1]]), -1 / 3, 1e-12) &&
                meanPairwiseCorrelation([[1, 2, 3, 4], [2, 4, 6, 8], [1, 1, 1, 1]]) === 1 &&
                Number.isNaN(meanPairwiseCorrelation([[1, 2, 3]])));
            check('AD: the equicorrelation design effect is exactly 1+(K-1)*rho and negative rho legitimately SHRINKS it',
                equicorrelationDesignEffect(8, 0) === 1 && equicorrelationDesignEffect(8, 0.5) === 4.5 &&
                abClose(equicorrelationDesignEffect(8, -0.2), -0.4, 1e-12) &&
                abClose(equicorrelationEffectiveSize(8, 0.5), 8 / 4.5, 1e-12) &&
                equicorrelationEffectiveSize(8, 0) === 8 && Number.isNaN(equicorrelationDesignEffect(8, NaN)));

            // --- the cluster view --------------------------------------------
            check('AD: foldWindowClusters groups the same fold window across streams (one cluster = one window, all streams)',
                JSON.stringify(foldWindowClusters([[1, 2, 3, 4], [5, 6, 7, 8]], 2)) === '[[1,2,5,6],[3,4,7,8]]' &&
                foldWindowClusters([[1, 2]], 2).length === 1);
            let abClusterThrew = 0;
            try { foldWindowClusters([[1, 2, 3], [1, 2]], 2); } catch { abClusterThrew++; }
            try { foldWindowClusters([[1, 2, 3]], 2); } catch { abClusterThrew++; }
            try { foldWindowClusters([[1, 2, 3]], 0); } catch { abClusterThrew++; }
            try { foldWindowClusters([], 2); } catch { abClusterThrew++; }
            check('AD: foldWindowClusters THROWS rather than mis-grouping a ragged / non-tiling panel', abClusterThrew === 4);
            check('AD: concatClusters concatenates in order and drops exactly the requested cluster',
                JSON.stringify(concatClusters([[1, 2], [3, 4], [5, 6]])) === '[1,2,3,4,5,6]' &&
                JSON.stringify(concatClusters([[1, 2], [3, 4], [5, 6]], 1)) === '[1,2,5,6]');

            // --- the delete-one-cluster jackknife (Cameron & Miller 2015) -----
            const abMean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
            const abJk = clusterJackknife({ clusters: [[1, 2], [3, 4], [5, 6], [7, 8]], statistic: abMean });
            check('AD: clusterJackknife SE is exactly sqrt((C-1)/C * sum(theta_-c - mean)^2) on a hand-computed case',
                abJk.estimate === 4.5 && abJk.nClusters === 4 &&
                JSON.stringify(abJk.leaveOneOut.map((x) => Number(x.toFixed(6)))) === '[5.5,4.833333,4.166667,3.5]' &&
                abClose(abJk.se, Math.sqrt(5 / 3), 1e-12));
            check('AD: clusterJackknife reports NaN + a reason (never a fake 0 SE) with < 2 clusters or a non-finite estimate',
                Number.isNaN(clusterJackknife({ clusters: [[1, 2]], statistic: abMean }).se) &&
                typeof clusterJackknife({ clusters: [[1, 2]], statistic: abMean }).reason === 'string' &&
                Number.isNaN(clusterJackknife({ clusters: [[], []], statistic: abMean }).se));

            // --- the paired cluster test (t(C-1)) ----------------------------
            const abPaired = pairedClusterTest({
                clustersA: [[1, 2], [3, 4], [5, 6], [7, 8]],
                clustersB: [[0, 2], [3, 4], [5, 6], [7, 8]],
                statistic: abMean,
            });
            // The independently derived df=3 closed form: P(T > t) =
            // 0.5 - (atan(t/sqrt(3)) + (t/sqrt(3))/(1+t^2/3))/pi.
            const abTCdf3 = (t) => 0.5 - (Math.atan(t / Math.sqrt(3)) + (t / Math.sqrt(3)) / (1 + (t * t) / 3)) / Math.PI;
            check('AD: pairedClusterTest is exact on a hand-computed panel (value, jackknife SE, t, df = C-1)',
                abPaired.available === true && abClose(abPaired.value, 0.125, 1e-12) &&
                abClose(abPaired.se, 0.125, 1e-12) && abClose(abPaired.t, 1, 1e-12) && abPaired.df === 3 && abPaired.nClusters === 4);
            check('AD: pairedClusterTest p-values match an independently derived t(3) closed form',
                abClose(abPaired.pOneSided, abTCdf3(1), 1e-9) && abClose(abPaired.pTwoSided, 2 * abTCdf3(1), 1e-9) &&
                abPaired.significant === false);
            check('AD: pairedClusterTest refuses (available:false, no fabrication) when the panels differ in size',
                pairedClusterTest({ clustersA: [[1, 2]], clustersB: [[1, 2], [3, 4]], statistic: abMean }).available === false);
            check('AD: a degenerate panel (zero jackknife variance) gives t = +-Infinity and p = 0, never NaN (a perfect winner must not be silently failed)',
                (() => {
                    const d = pairedClusterTest({ clustersA: [[1, 1], [1, 1], [1, 1]], clustersB: [[0, 0], [0, 0], [0, 0]], statistic: abMean });
                    return d.available && d.se === 0 && d.t === Infinity && d.pOneSided === 0 && d.significant === true;
                })());

            // --- the exact sign test over clusters (Demsar 2006) -------------
            // A discriminating fixture: per-window the candidate wins 4 of the 6
            // windows (one loss, one tie), while the delete-one-cluster statistic
            // would compare all-but-c and report 6/6. This pins the sign test as the
            // PER-WINDOW test its reader claims (not a leave-one-out stability test).
            const abSweep = pairedClusterSignTest({ clustersA: [[2], [2], [2], [2], [0], [1]], clustersB: [[1], [1], [1], [1], [1], [1]], statistic: abMean });
            check('AD: pairedClusterSignTest is an exact PER-WINDOW binomial tail (ties dropped)',
                abSweep.available && abSweep.wins === 4 && abSweep.losses === 1 && abSweep.ties === 1 &&
                abSweep.n === 5 && abClose(abSweep.pValue, 3 / 16, 1e-15) && abSweep.significant === false);
            check('AD: signTest is exact at hand-computed tails (3/4 = 5/16, 5/5 = 1/32, 36/36 = 2^-36, 0/5 = 1)',
                abClose(signTest({ wins: 3, n: 4 }).pValue, 5 / 16, 1e-15) &&
                abClose(signTest({ wins: 5, n: 5 }).pValue, 1 / 32, 1e-15) &&
                abClose(signTest({ wins: 36, n: 36 }).pValue, Math.pow(2, -36), 1e-40) &&
                signTest({ wins: 0, n: 5 }).pValue === 1 &&
                abClose(signTest({ wins: 25, n: 36 }).pValue, 0.014408359827939421, 1e-15));
            check('AD: signTest is NaN on malformed counts and signTestFloor is exactly 2^-n (the resolution floor of the test)',
                Number.isNaN(signTest({ wins: 5, n: 4 }).pValue) && Number.isNaN(signTest({ wins: 2.5, n: 5 }).pValue) &&
                signTestFloor(5) === 1 / 32 && signTestFloor(36) === Math.pow(2, -36) && Number.isNaN(signTestFloor(0)));

            // --- the Student-t CDF (the p-value reference) -------------------
            check('AD: studentTPValue matches exact table values (t(35)=2.030108 is two-sided 0.05; one-sided 0.05 at 1.6896)',
                abClose(studentTPValue(2.030108, 35, { twoSided: true }), 0.05, 1e-6) &&
                abClose(studentTPValue(1.6896, 35, { twoSided: false }), 0.05, 1e-4));
            check('AD: studentTPValue reproduces the Cauchy closed form at df=1 and the df=3 closed form',
                abClose(studentTPValue(2, 1, { twoSided: true }), 2 * (0.5 - Math.atan(2) / Math.PI), 1e-9) &&
                abClose(studentTPValue(1, 3, { twoSided: false }), abTCdf3(1), 1e-9));
            check('AD: studentTPValue is pinned at t=0 and on the infinite/NaN edges',
                studentTPValue(0, 7, { twoSided: true }) === 1 && studentTPValue(0, 7, { twoSided: false }) === 0.5 &&
                studentTPValue(Infinity, 7) === 0 && studentTPValue(-Infinity, 7, { twoSided: false }) === 1 &&
                Number.isNaN(studentTPValue(NaN, 7)) && Number.isNaN(studentTPValue(1, 0)) &&
                studentTCdf === studentTPValue);
            check('AD: regularizedIncompleteBeta is exact on the trivial cases (I_x(1,1) = x, 0 at x=0, 1 at x=1)',
                abClose(regularizedIncompleteBeta(1, 1, 0.5), 0.5, 1e-12) &&
                regularizedIncompleteBeta(2, 3, 0) === 0 && regularizedIncompleteBeta(2, 3, 1) === 1 &&
                Number.isNaN(regularizedIncompleteBeta(0, 1, 0.5)));

            // --- dependenceSummary on a crafted panel ------------------------
            check('AD: dependenceSummary declines on a single stream and on a non-rectangular panel',
                dependenceSummary({ streamReturns: [[1, 2, 3, 4, 5, 6]] }).available === false &&
                dependenceSummary({ streamReturns: [[1, 2, 3, 4, 5, 6], [1, 2, 3]] }).available === false &&
                dependenceSummary({ streamReturns: [[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 7]] }).available === false &&
                dependenceSummary({}).available === false);
            const abPanel = [
                [0.01, -0.004, 0.007, 0.002, -0.005, 0.011, -0.003, 0.006, 0.001, -0.002, 0.009, -0.008],
                [0.008, -0.002, 0.005, 0.004, -0.003, 0.009, -0.001, 0.004, 0.003, -0.001, 0.007, -0.006],
            ];
            const abDep = dependenceSummary({ streamReturns: abPanel, foldLength: 3, periodsPerYear: 252 });
            const abPooledPanel = abPanel.flat();
            const abIidSe = wfSharpeStandardError(sharpeRatio(abPooledPanel, { periodsPerYear: 252 }), abPooledPanel.length, 252);
            check('AD: dependenceSummary measures the panel: 4 fold-window clusters, seIid is the Lo (2002) SE of the pooled series, designEffect is (seCluster/seIid)^2',
                abDep.available && abDep.nClusters === 4 && abDep.clustersPerStream === 4 && abDep.foldLength === 3 && abDep.streams === 2 &&
                abClose(abDep.seIid, abIidSe, 1e-12) && abClose(abDep.designEffect, (abDep.seCluster / abDep.seIid) ** 2, 1e-12) &&
                abClose(abDep.effectiveBars, abPooledPanel.length / abDep.designEffect, 1e-9) &&
                abDep.seCluster === clusterJackknife({ clusters: foldWindowClusters(abPanel, 3), statistic: (a) => sharpeRatio(a, { periodsPerYear: 252 }) }).se);
            const abDup = dependenceSummary({ streamReturns: [abPanel[0], abPanel[0].slice()], foldLength: 3 });
            check('AD: two IDENTICAL streams read as one independent observation (equicorrelation 1 -> designEffect 2, effectiveStreams 1)',
                abClose(abDup.meanPairwiseStreamCorr, 1, 1e-12) &&
                abClose(abDup.equicorrelationDesignEffect, 2, 1e-12) && abClose(abDup.effectiveStreams, 1, 1e-12));

            // --- clustersOf / pairedPromotionTest ---------------------------
            const abSingle = { pooledReturns: [0.01, -0.01], folds: [{ metrics: { netSharpe: 1 } }] };
            check('AD: clustersOf returns null for a single-stream report (no panel) and the fold-window clusters for a pooled one',
                clustersOf(abSingle) === null &&
                Array.isArray(clustersOf({ streamReturns: abPanel, dependence: { available: true, foldLength: 3 } })) &&
                clustersOf({ streamReturns: abPanel, dependence: { available: true, foldLength: 3 } }).length === 4);
            check('AD: pairedPromotionTest is available:false (not a fabricated pass) without a comparable panel',
                pairedPromotionTest(abSingle, abSingle).available === false);
            check('AD: DEPENDENCE_GATE_READER states the three hurdles and is non-empty',
                typeof DEPENDENCE_GATE_READER === 'string' && DEPENDENCE_GATE_READER.length > 100 &&
                DEPENDENCE_GATE_READER.includes('dsrAdjusted'));

            // --- restateReportAtCost / costLadder ---------------------------
            const abFolds = walkForwardSplit({ n: 90, trainSize: 30, testSize: 10 });
            const abRets = abWalk(777, 90, 0);
            const abBaseSig = (tr, te) => te.map((t) => ((t + tr.length) % 2 ? 1 : -1));
            const abCandSig = (tr, te, view) => te.map((t) => Math.sign(view.returns[t]) || 0);
            const abBaseRep = walkForwardEvaluate({ returns: abRets, folds: abFolds, signalForFold: abBaseSig, costBps: 0, trials: 3, audit: false });
            const abCandRep = walkForwardEvaluate({ returns: abRets, folds: abFolds, signalForFold: abCandSig, costBps: 0, trials: 3, audit: false });
            check('AD: walkForwardEvaluate records the trial count it deflated by', abBaseRep.trials === 3);
            const abR0 = restateReportAtCost(abBaseRep, 0);
            check('AD: restating at cost 0 reproduces the scored folds and pooled metrics BYTE-IDENTICALLY',
                JSON.stringify(abR0.folds) === JSON.stringify(abBaseRep.folds) &&
                JSON.stringify(abR0.pooledMetrics) === JSON.stringify(abBaseRep.pooledMetrics));
            check('AD: restating without an explicit trial count uses the trial count recorded on the reports own (a silent re-deflation would change the DSR)',
                restateReportAtCost(abBaseRep, 0).pooledMetrics.dsr === abBaseRep.pooledMetrics.dsr &&
                restateReportAtCost(abBaseRep, 0, { trials: 1 }).pooledMetrics.dsr !== abBaseRep.pooledMetrics.dsr);
            const abR5 = restateReportAtCost(abBaseRep, 5);
            check('AD: a higher cost keeps turnover/gross P&L and can only lower the net Sharpe',
                abR5.pooledMetrics.turnover === abBaseRep.pooledMetrics.turnover &&
                abR5.pooledMetrics.grossPnl === abBaseRep.pooledMetrics.grossPnl &&
                abR5.pooledMetrics.netSharpe < abR0.pooledMetrics.netSharpe &&
                abR5.costBps === 5);
            check('AD: restateReportAtCost declines a report without retained fold inputs',
                restateReportAtCost({ folds: [{ metrics: {} }] }, 0) === null && restateReportAtCost(null, 0) === null);
            const abLadder = costLadder({ baseline: abBaseRep, candidates: [{ ...abCandRep, id: 'cand' }], levels: [0, 2, 5], periodsPerYear: 252 });
            check('AD: costLadder restates every level, defaults trials to the report, and reports the per-level decision',
                abLadder.available && abLadder.trials === 3 && abLadder.rows.length === 3 &&
                abLadder.rows.map((r) => r.costBps).join(',') === '0,2,5' &&
                abLadder.rows.every((r) => r.candidates.length === 1 && typeof r.candidates[0].promote === 'boolean' && Number.isFinite(r.baseline.netSharpe)) &&
                abLadder.rows[0].baseline.netSharpe > abLadder.rows[2].baseline.netSharpe);
            check('AD: costLadder declines (available:false) when the reports carry no fold inputs',
                costLadder({ baseline: { folds: [] }, candidates: [{ id: 'x' }] }).available === false);
            check('AD: the cost ladder exposes a verdict that is about the COST ASSUMPTION (a real momentum edge promotes at 0-20 bps and stops at 40 bps)',
                (() => {
                    const rng = abRng(4242);
                    const ar = new Array(600).fill(0);
                    for (let t = 1; t < 600; t++) ar[t] = 0.4 * ar[t - 1] + 0.01 * abGauss(rng);
                    const f = walkForwardSplit({ n: 600, trainSize: 200, testSize: 50 });
                    const bRep = walkForwardEvaluate({
                        returns: ar, folds: f, costBps: 0, trials: 2, audit: false,
                        signalForFold: (tr, te) => { const r2 = abRng(77); return te.map(() => (r2() < 0.5 ? 1 : -1)); },
                    });
                    const cRep = walkForwardEvaluate({
                        returns: ar, folds: f, costBps: 0, trials: 2, audit: false,
                        signalForFold: (tr, te, view) => te.map((t) => Math.sign(view.returns[t]) || 0),
                    });
                    const l = costLadder({ baseline: bRep, candidates: [{ ...cRep, id: 'mom' }], levels: [0, 20, 40, 80], periodsPerYear: 252, decisionOptions: { requireCleanAudit: false } });
                    const promo = l.rows.map((r) => r.candidates[0].promote);
                    return l.available && promo[0] === true && promo[1] === true && promo[2] === false && promo[3] === false &&
                        l.rows[2].candidates[0].reasons.some((r2) => /DSR/.test(r2)) &&
                        l.rows[0].baseline.netSharpe > l.rows[3].baseline.netSharpe;
                })());

            // --- familyCorrelation (diagnostic only) -------------------------
            const abFam = familyCorrelation({ baseline: abBaseRep, candidates: [abCandRep, { ...abCandRep }] });
            check('AD: familyCorrelation measures a per-fold excess-return correlation and derives the Kish effective trial count',
                abFam.available && abFam.K === 2 && abFam.folds === abBaseRep.foldLengths.length &&
                abFam.maxPair.a === 0 && abFam.maxPair.b === 1 &&
                abFam.meanPairwiseExcessCorr === abFam.maxPair.rho &&
                abClose(abFam.effectiveTrials, 2 / (1 + (2 - 1) * abFam.meanPairwiseExcessCorr), 1e-12) &&
                abFam.excessCorrelations[0][0] === 1 && abFam.excessCorrelations[0][1] === abFam.excessCorrelations[1][0]);
            check('AD: familyCorrelation declines without a family / a fold grid / a shared series length',
                familyCorrelation({ baseline: abBaseRep, candidates: [abCandRep] }).available === false &&
                familyCorrelation({ baseline: { pooledReturns: [0.1, 0.2] }, candidates: [abCandRep, abCandRep] }).available === false &&
                familyCorrelation({ baseline: abBaseRep, candidates: [abCandRep, { pooledReturns: [0.1] }] }).available === false);

            // --- the round-25 gate semantics --------------------------------
            // A synthetic cross-stream panel with a tunable per-bar excess for the
            // candidate, so a winner can be made arbitrarily clear.
            const abGateReport = (excess, nFolds = 8, nStreams = 3) => {
                const q = 3;
                const streams = [];
                for (let s = 0; s < nStreams; s++) {
                    const r2 = abRng(4000 + s);
                    const row = [];
                    for (let t = 0; t < nFolds * q; t++) row.push(0.002 * ((t % 3) - 1) + 0.01 * abGauss(r2) + excess);
                    streams.push(row);
                }
                const folds = [];
                for (let f = 0; f < nFolds; f++) folds.push({ metrics: { netSharpe: 0.2 + excess * 100 } });
                return {
                    folds,
                    pooledReturns: streams.flat(),
                    foldLengths: new Array(nFolds).fill(q),
                    streamReturns: streams,
                    streamFoldLengths: streams.map(() => new Array(nFolds).fill(q)),
                    dependence: dependenceSummary({ streamReturns: streams, foldLength: q }),
                    pooledMetrics: { dsr: 0.99, netSharpe: 0.5, dsrAdjusted: 0.96 },
                    aggregate: { mean: 0.2, positiveFraction: 0.6 },
                    audit: { clean: true, violations: [] },
                };
            };
            const abGateBase = abGateReport(0);
            const abGateWin = abGateReport(0.003);
            const abGateDec = promoteDecision(abGateBase, abGateWin, { requireCleanAudit: false, requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95 });
            check('AD: the round-25 hurdles are APPLIED (not skipped) when a cross-stream panel exists',
                abGateDec.gate.requireSharpeDiff === 'applied' && abGateDec.gate.requireBreadth === 'applied' && abGateDec.gate.minDsrAdjusted === 'applied');
            check('AD: a candidate with a clear per-window excess clears all three round-25 hurdles and promotes',
                abGateDec.promote,
                JSON.stringify({ reasons: abGateDec.reasons, t: abGateDec.promotionTest.sharpeDifference.t, breadth: abGateDec.promotionTest.breadth }));
            check('AD: the breadth hurdle is an exact sign test over 8 fold windows (wins/n and p = 2^-n on a sweep)',
                abGateDec.promotionTest.breadth.wins === 8 && abGateDec.promotionTest.breadth.n === 8 &&
                abClose(abGateDec.promotionTest.breadth.pValue, Math.pow(2, -8), 1e-15) &&
                abGateDec.promotionTest.breadth.floor === Math.pow(2, -8));
            const abNoPanel = abStripPanel(abGateBase);
            const abSkipDec = promoteDecision(abNoPanel, abStripPanel(abGateWin), { requireCleanAudit: false, requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95 });
            check('AD: the round-25 hurdles are SKIPPED (never failed) on a single-stream report, and the gate says so',
                abSkipDec.gate.requireSharpeDiff === 'skipped-no-panel' && abSkipDec.gate.requireBreadth === 'skipped-no-panel' &&
                abSkipDec.gate.minDsrAdjusted === 'skipped-no-panel' &&
                abSkipDec.reasons.every((r) => !/unavailable|no cross-stream panel/.test(r)));
            check('AD: with the round-25 hurdles off the gate object reports them off (default path unchanged)',
                promoteDecision(abGateBase, abGateWin, { requireCleanAudit: false }).gate.minDsrAdjusted === 'off');
            const abBadDsr = { ...abGateWin, pooledMetrics: { ...abGateWin.pooledMetrics, dsrAdjusted: 0.5 } };
            const abDsrDec = promoteDecision(abGateBase, abBadDsr, { requireCleanAudit: false, minDsrAdjusted: 0.95 });
            check('AD: minDsrAdjusted fails (with an attributable reason) when the design-effect-adjusted DSR is below the floor',
                !abDsrDec.promote && abDsrDec.reasons.some((r) => /dependence-adjusted/.test(r) && /0\.5 < 0\.95/.test(r)));
            check('AD: a panel whose design effect is <= 1 is reported as not-needed, never conflated with a missing panel',
                (() => {
                    const noAdj = (r) => ({ ...r, pooledMetrics: { dsr: 0.99, netSharpe: 0.5, dsrAdjusted: null } });
                    const d = promoteDecision(noAdj(abGateBase), noAdj(abGateWin), { requireCleanAudit: false, minDsrAdjusted: 0.95 });
                    return d.gate.minDsrAdjusted === 'not-needed' && d.reasons.every((r) => !/dependence-adjusted/.test(r));
                })());
            const abBrDec = promoteDecision(abGateReport(0, 4, 3), abGateReport(0.003, 4, 3), { requireCleanAudit: false, requireBreadth: true });
            check('AD: requireBreadth fails on an unreadable panel, and the reason names the window count and the test resolution floor',
                !abBrDec.promote && abBrDec.reasons.some((r) => /breadth 4\/4 fold windows/.test(r) && /best possible 0\.0625/.test(r)));

            // --- calibration: the dependence gate is not anti-conservative ----
            // 24 zero-skill rounds over 4 correlated streams x 5 folds. Both gates
            // see the SAME panels, so the claim is like-for-like: adding the
            // dependence hurdles must not manufacture promotions.
            const abNullWorlds = [];
            for (let s = 0; s < 4; s++) {
                const r2 = abRng(9000 + s);
                const rets = new Array(100).fill(0);
                let common = 0;
                for (let t = 1; t < 100; t++) { common = 0.6 * common + 0.01 * abGauss(r2); rets[t] = common + 0.4 * 0.01 * abGauss(r2); }
                abNullWorlds.push({ label: 's' + s, returns: rets, folds: walkForwardSplit({ n: 100, trainSize: 50, testSize: 10 }) });
            }
            const abRand = (seed) => { const r2 = abRng(seed); return (tr, te) => te.map(() => (r2() < 0.5 ? 1 : -1)); };
            let abClassicPromo = 0; let abDepPromo = 0;
            const AB_ROUNDS = 24;
            for (let i = 0; i < AB_ROUNDS; i++) {
                const w = abNullWorlds.map((x) => ({ ...x }));
                const base = poolReports(w.map((s) => walkForwardEvaluate({ returns: s.returns, folds: s.folds, signalForFold: abRand(100 + i), costBps: 1, trials: 2, audit: false })), { trials: 2 });
                const cand = poolReports(w.map((s) => walkForwardEvaluate({ returns: s.returns, folds: s.folds, signalForFold: abRand(200 + i), costBps: 1, trials: 2, audit: false })), { trials: 2 });
                if (promoteDecision(base, cand, { requireCleanAudit: false }).promote) abClassicPromo++;
                if (promoteDecision(base, cand, { requireCleanAudit: false, requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95 }).promote) abDepPromo++;
            }
            check('AD: on zero-skill null panels the dependence gate never promotes more often than the classic gate',
                abDepPromo <= abClassicPromo, `classic=${abClassicPromo} dependence=${abDepPromo} of ${AB_ROUNDS}`);
            check('AD: the dependence gate keeps its size on null panels (at most 2 false promotions in 24 rounds, ~2 alpha-level hurdles)',
                abDepPromo <= 2, `dependence promotions=${abDepPromo}/${AB_ROUNDS}`);
            check('AD: the gate produces an attributable reason for every non-promotion (nothing fails silently)',
                (() => {
                    const base = poolReports(abNullWorlds.map((s) => walkForwardEvaluate({ returns: s.returns, folds: s.folds, signalForFold: abRand(11), costBps: 1, trials: 2, audit: false })), { trials: 2 });
                    const cand = poolReports(abNullWorlds.map((s) => walkForwardEvaluate({ returns: s.returns, folds: s.folds, signalForFold: abRand(12), costBps: 1, trials: 2, audit: false })), { trials: 2 });
                    const dec = promoteDecision(base, cand, { requireCleanAudit: false, requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95 });
                    return dec.promote || dec.reasons.length > 0;
                })());
        }
    }
    // ---- AE. R26-4: the concurrent fold scheduler ---------------------------
    // The scheduler's contract is order-preserving bounded concurrency, and the
    // async backtest/walk-forward twins must then be byte-identical to the serial
    // ones — same arithmetic, same emit order, only wall time moves.
    try {
        check('R26-4: normaliseConcurrency treats a non-finite / non-positive width as serial',
            normaliseConcurrency(0) === 1 && normaliseConcurrency(-3) === 1 &&
            normaliseConcurrency(NaN) === 1 && normaliseConcurrency(Infinity) === 1 &&
            normaliseConcurrency(1) === 1 && normaliseConcurrency(2.9) === 2 && normaliseConcurrency(1e6) === 64,
            JSON.stringify({ zero: normaliseConcurrency(0), two: normaliseConcurrency(2.9), cap: normaliseConcurrency(1e6) }));

        const schedOrder = await scheduleUnits(
            Array.from({ length: 12 }, (_, i) => i),
            { concurrency: 4, exec: async (u) => { await new Promise((r) => setTimeout(r, (12 - u) % 5)); return u * 10; } },
        );
        check('R26-4: scheduleUnits returns results in unit order regardless of completion order',
            JSON.stringify(schedOrder) === JSON.stringify(Array.from({ length: 12 }, (_, i) => i * 10)),
            JSON.stringify(schedOrder));

        let inFlight = 0; let peak = 0;
        await scheduleUnits(Array.from({ length: 20 }, (_, i) => i), {
            concurrency: 4,
            exec: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight--; },
        });
        check('R26-4: scheduleUnits never exceeds the requested concurrency', peak <= 4 && peak > 1, `peak=${peak}`);

        const startedUnits = [];
        let firstError = false;
        try {
            await scheduleUnits(Array.from({ length: 20 }, (_, i) => i), {
                concurrency: 3,
                exec: async (u) => { startedUnits.push(u); if (u === 5) throw new Error('boom'); await new Promise((r) => setTimeout(r, 1)); return u; },
            });
        } catch (err) { firstError = /boom/.test(String(err && err.message)); }
        check('R26-4: scheduleUnits rejects with the first error and starts no new units after it',
            firstError && !startedUnits.includes(17), `started=${startedUnits.join(',')}`);

        check('R26-4: scheduleUnits over no units is the empty array',
            JSON.stringify(await scheduleUnits([], { exec: async () => 1 })) === '[]');

        let badReplyFailed = false;
        try { await makeFoldExecutor({ dispatch: async () => ({ nope: 1 }) })({ variantId: 'v', foldIndex: 0 }); } catch { badReplyFailed = true; }
        check('R26-4: a malformed executor reply is rejected, never used as positions', badReplyFailed);
        check('R26-4: the executor reply preserves the confidence and stats channels',
            await (async () => {
                const ex = makeFoldExecutor({ dispatch: async () => ({ positions: [1, 0, -1], confidence: [0.5, 0, -0.5], stats: { folds: 1 } }) });
                const r = await ex({ variantId: 'v', foldIndex: 0 });
                return JSON.stringify(r.signals) === '[1,0,-1]' && r.stats && r.stats.folds === 1;
            })());

        // Byte-identity: the async twins reproduce the serial report exactly.
        const parReturns = (() => { const r = new Array(120).fill(0); for (let t = 1; t < 120; t++) r[t] = Math.floor(t / 12) % 2 === 0 ? 0.01 : -0.002; return r; })();
        const parFolds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
        const parSignal = (tr, te) => te.map((t) => Math.sign((parReturns[t - 1] ?? 0) + (parReturns[t - 2] ?? 0)));
        const parConf = (tr, te) => te.map((t) => 0.5 * Math.sign((parReturns[t - 1] ?? 0)));
        const serialCv = purgedCVBacktest({ returns: parReturns, folds: parFolds, signalForFold: parSignal, confidenceForFold: parConf, costBps: 1, trials: 3 });
        const asyncCv = await purgedCVBacktestAsync({
            returns: parReturns, folds: parFolds, costBps: 1, trials: 3, concurrency: 4,
            foldExecutor: async ({ train, test }) => ({ signals: parSignal(train, test), confidence: parConf(train, test) }),
        });
        check('R26-4: purgedCVBacktestAsync is byte-identical to purgedCVBacktest (concurrency 4)',
            JSON.stringify(asyncCv) === JSON.stringify(serialCv),
            `folds=${asyncCv.folds.length}`);
        check('R26-4: the concurrent path journals the raw confidence identically',
            JSON.stringify(asyncCv.foldInputs.map((f) => f.confidence)) === JSON.stringify(serialCv.foldInputs.map((f) => f.confidence)));

        const serialWfEvents = [];
        const serialWf = walkForwardEvaluate({
            returns: parReturns, folds: parFolds, signalForFold: parSignal, confidenceForFold: parConf,
            costBps: 1, trials: 3, audit: true, auditProbesPerFold: 1, onEvent: (e) => serialWfEvents.push(e),
        });
        const asyncWfEvents = [];
        const asyncWf = await walkForwardEvaluateAsync({
            returns: parReturns, folds: parFolds, signalForFold: parSignal, confidenceForFold: parConf,
            costBps: 1, trials: 3, audit: true, auditProbesPerFold: 1, concurrency: 5, onEvent: (e) => asyncWfEvents.push(e),
        });
        check('R26-4: walkForwardEvaluateAsync reproduces walkForwardEvaluate exactly (scored folds, audit and power)',
            JSON.stringify(asyncWf) === JSON.stringify(serialWf),
            `folds=${asyncWf.folds.length} audit=${JSON.stringify(asyncWf.audit && asyncWf.audit.clean)}`);
        check('R26-4: the concurrent path emits fold events in the identical order (scored folds, then audit passes)',
            JSON.stringify(asyncWfEvents.map((e) => [e.t, e.stage || '', e.foldIndex ?? ''])) === JSON.stringify(serialWfEvents.map((e) => [e.t, e.stage || '', e.foldIndex ?? ''])),
            `${asyncWfEvents.length} events`);
    } catch (e) {
        check('R26-4 concurrent-scheduler checks completed', false, e.stack);
    }

    // ---- AF. R26-5: the turnover attack (holding / hysteresis policy) ---------
    // The confidence->position layer is pointwise, so it cannot express a
    // no-trade band that depends on the *current* position — which is what a
    // proportional cost makes optimal (Constantinides 1986; Gârleanu & Pedersen
    // 2013). `positionSeriesFromConfidence` adds exactly that, and must be
    // byte-identical to the pointwise map when no holding rule is set so that
    // every default path (and the R26-3 round-trip certificate) is unchanged.
    try {
        const plain = [0.02, 0.3, -0.4, 0.01, 0.9, -0.9];
        check('R26-5: positionSeriesFromConfidence with no holding rule is byte-identical to the pointwise map',
            JSON.stringify(positionSeriesFromConfidence(plain, {})) === JSON.stringify(plain.map((c) => confidenceToPosition(c))) &&
            JSON.stringify(positionSeriesFromConfidence(plain, { deadZone: 0.1, scale: 0.5 })) === JSON.stringify(plain.map((c) => confidenceToPosition(c, { deadZone: 0.1, scale: 0.5 }))),
            JSON.stringify(positionSeriesFromConfidence(plain, { deadZone: 0.1, scale: 0.5 })));

        // Enter at |c| >= 0.3, do not leave until |c| <= 0.1: the position must
        // survive the whole narrow band (bars 1-4) and only flip on a decisive
        // opposite signal (bar 5).
        const bandSeries = [0.5, 0.2, -0.2, 0.15, -0.15, -0.4, 0.05];
        check('R26-5: hysteresis holds through the no-trade band and flips only on a decisive opposite signal',
            JSON.stringify(positionSeriesFromConfidence(bandSeries, { enter: 0.3, exit: 0.1 })) === JSON.stringify([1, 1, 1, 1, 1, -1, 0]));

        // A minimum holding period must suppress both the exit AND the flip until
        // it has elapsed.
        check('R26-5: a minimum holding period suppresses the exit (and the flip) until it elapses',
            JSON.stringify(positionSeriesFromConfidence([0.5, -0.4, 0, 0, 0, 0], { enter: 0.3, exit: 0.1, minHold: 3 })) === JSON.stringify([1, 1, 1, 0, 0, 0]));

        // The grid is data, and must be a valid, non-empty cross product.
        check('R26-5: DEFAULT_TURNOVER_GRID is a non-empty frozen cross product including a no-hold policy',
            Object.isFrozen(DEFAULT_TURNOVER_GRID) &&
            DEFAULT_TURNOVER_GRID.deadZones.length > 0 && DEFAULT_TURNOVER_GRID.scales.length > 0 &&
            DEFAULT_TURNOVER_GRID.holdings.length > 0 && DEFAULT_TURNOVER_GRID.holdings.includes(null));

        // A synthetic report (one stream, one fold) already in `foldInputs` form.
        const makeReport = (conf, returns, id) => ({
            id,
            foldInputs: [{
                returns,
                signals: conf.map((c) => confidenceToPosition(c, { deadZone: 0 })),
                confidence: conf,
            }],
            folds: [{ testStart: 0, testEnd: returns.length - 1 }],
            streamFoldLengths: [[returns.length]],
            trials: 1,
        });
        const sconf = [];
        const sret = [];
        for (let i = 0; i < 80; i++) { const s = Math.sin(i * 0.7); sconf.push(s * 0.6); sret.push(s * 0.01); }
        const sBase = makeReport(sconf, sret, 'base');
        const sCand = makeReport(sconf.map((c, i) => (i % 2 ? c : c * 0.9)), sret.map((r, i) => (i % 2 ? r * 1.1 : r)), 'cand');

        const sweep = turnoverSweep({
            baseline: sBase, candidates: [sCand],
            deadZones: [0, 0.5], scales: [1],
            holdings: [null, { enter: 0.3, exit: 0.1 }],
            trials: 2, decisionOptions: {},
        });
        check('R26-5: turnoverSweep is available on a report with fold inputs and enumerates the grid',
            sweep.available === true && sweep.rows.length === 4 && sweep.byId.cand != null,
            `rows=${sweep.rows ? sweep.rows.length : 'n/a'}`);
        check('R26-5: turnoverSweep rows are sorted by break-even cost (descending)',
            sweep.rows.every((r, i) => i === 0 || (sweep.rows[i - 1].breakEvenCostBps ?? -Infinity) >= (r.breakEvenCostBps ?? -Infinity)),
            JSON.stringify(sweep.rows.map((r) => r.breakEvenCostBps)));
        check('R26-5: a wide dead zone abstains more than a narrow one (participation and turnover fall)',
            (() => {
                const wide = sweep.rows.find((r) => r.policy.deadZone === 0.5 && r.policy.enter == null);
                const narrow = sweep.rows.find((r) => r.policy.deadZone === 0 && r.policy.enter == null);
                return wide && narrow && wide.nonZeroFraction <= narrow.nonZeroFraction && wide.turnover <= narrow.turnover;
            })());
        check('R26-5: bestTurnoverPolicy prefers a promoting row and targetMet is a boolean',
            (() => {
                const b = bestTurnoverPolicy(sweep, 'cand');
                return b != null && (b.promote || b.breakEvenCostBps != null) && typeof sweep.targetMet === 'boolean' && bestTurnoverPolicy(sweep, 'absent') === null;
            })());
        check('R26-5: formatTurnoverSweep names each candidate and the target',
            (() => { const s = formatTurnoverSweep(sweep); return typeof s === 'string' && s.includes('turnover cand:') && s.includes('target'); })());
        check('R26-5: turnoverSweep reports unavailable (not a throw) when the baseline has no fold inputs',
            (() => { const s = turnoverSweep({ baseline: { folds: [] }, candidates: [sCand] }); return s.available === false && typeof s.reason === 'string'; })());
    } catch (e) {
        check('R26-5 turnover-attack checks completed', false, e.stack);
    }

    // ---- AG. R26-6: effective independence (resample + stream selection) ------
    // Grinold (1989): the information ratio scales with sqrt(breadth), and breadth
    // is the number of INDEPENDENT forecasts. Kish (1965) converts a raw count into
    // an effective one (`DE = 1+(K-1)*rbar`). These checks pin the resampler's exact
    // OHLCV arithmetic and the design-effect / selection outcomes.
    try {
        const bars = [];
        for (let i = 0; i < 8; i++) bars.push({ timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i });
        const agg4 = resampleCandles(bars, { factor: 4 });
        check('R26-6: resampleCandles aggregates exact OHLCV (open first, close last, high max, low min, volume sum)',
            agg4.length === 2 &&
            JSON.stringify(agg4[0]) === JSON.stringify({ timestamp: 0, open: 100, high: 104, low: 99, close: 103.5, volume: 46 }) &&
            JSON.stringify(agg4[1]) === JSON.stringify({ timestamp: 4, open: 104, high: 108, low: 103, close: 107.5, volume: 62 }),
            JSON.stringify(agg4));
        check('R26-6: resampleCandles at factor 1 is a shallow copy and never mutates its input',
            resampleCandles(bars, { factor: 1 }).length === 8 &&
            resampleCandles(bars, { factor: 1 })[0] === bars[0] &&
            JSON.stringify(bars[0]) === JSON.stringify({ timestamp: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }));
        const ten = bars.concat([{ timestamp: 8, open: 108, high: 109, low: 107, close: 108.5, volume: 18 }, { timestamp: 9, open: 109, high: 110, low: 108, close: 109.5, volume: 19 }]);
        check('R26-6: resampleCandles drops a trailing partial group unless asked to keep it',
            resampleCandles(ten, { factor: 4 }).length === 2 &&
            resampleCandles(ten, { factor: 4, keepIncomplete: true }).length === 3);
        check('R26-6: resampleCandles rejects a non-positive / non-integer factor',
            [0, -1, 1.5, NaN].every((f) => { try { resampleCandles(bars, { factor: f }); return false; } catch { return true; } }));

        // Identical streams are one bet: DE = 2, effectiveStreams = 1.
        const a = Array.from({ length: 200 }, (_, i) => 0.01 * Math.sin(i * 0.37) + 0.002 * Math.sin(i * 1.9));
        const b = a.slice();
        const de2 = designEffectOfStreams({ a, b });
        check('R26-6: two identical streams are one bet (DE=2, effectiveStreams=1, effectiveBars=rawBars/2)',
            de2.available && de2.K === 2 && Math.abs(de2.meanPairwiseCorr - 1) < 1e-12 &&
            de2.designEffect === 2 && Math.abs(de2.effectiveStreams - 1) < 1e-12 &&
            Math.abs(de2.effectiveBars - de2.rawBars / 2) < 1e-9,
            JSON.stringify({ rbar: de2.meanPairwiseCorr, DE: de2.designEffect }));
        const c = Array.from({ length: 200 }, (_, i) => 0.01 * Math.sin(i * 0.37 + 2.1) + 0.002 * Math.sin(i * 1.9 + 1.7));
        const de3 = designEffectOfStreams({ a, b: c, c: Array.from({ length: 200 }, (_, i) => 0.01 * Math.sin(i * 0.37 + 4.7)) });
        check('R26-6: the design effect is exactly 1+(K-1)*rbar (Kish 1965) and effectiveStreams=K/DE',
            de3.available && de3.K === 3 && de3.designEffect === 1 + 2 * de3.meanPairwiseCorr &&
            Math.abs(de3.effectiveStreams - 3 / de3.designEffect) < 1e-12,
            JSON.stringify({ rbar: de3.meanPairwiseCorr, DE: de3.designEffect }));
        check('R26-6: a single stream is the trivial panel (K=1, DE=1) and a perfectly hedging pair is flagged degenerate',
            designEffectOfStreams({ a }).available && designEffectOfStreams({ a }).designEffect === 1 &&
            designEffectOfStreams({ a, anti: a.map((v) => -v) }).available === false);
        check('R26-6: designEffectOfStreams refuses a panel with fewer than three common bars',
            designEffectOfStreams({ a: [1, 2], b: [1, 2] }).available === false);

        // Selection: redundant partners are rejected in favour of diversifying ones.
        const sel = selectStreams({ seriesByLabel: { a, b: a.slice(), c, d: Array.from({ length: 200 }, (_, i) => 0.01 * Math.sin(i * 0.37 + 4.7) + 0.002 * Math.sin(i * 1.9 + 3.3)) } });
        check('R26-6: selectStreams greedily keeps the diversifying stream and rejects the redundant copy',
            sel.available && sel.chosen[0] === 'a' && sel.chosen.includes('c') &&
            (!sel.chosen.includes('b') || sel.chosen.indexOf('c') < sel.chosen.indexOf('b')) &&
            sel.curve.length === sel.chosen.length && sel.curve[0].K === 1,
            JSON.stringify(sel.chosen));
        check('R26-6: a fully redundant pool stops after one stream (no effective bars to buy)',
            JSON.stringify(selectStreams({ seriesByLabel: { x: a, y: a.slice(), z: a.slice() } }).chosen) === JSON.stringify(['x']));
        check('R26-6: selectStreams honours maxStreams and is deterministic',
            selectStreams({ seriesByLabel: { a, c, d: c }, maxStreams: 2 }).chosen.length === 2 &&
            JSON.stringify(selectStreams({ seriesByLabel: { a, c } }).chosen) === JSON.stringify(selectStreams({ seriesByLabel: { a, c } }).chosen));
        check('R26-6: formatStreamSelection names the panel and its effective size',
            (() => { const s = formatStreamSelection(sel); return typeof s === 'string' && s.includes('streams: ') && s.includes('designEffect='); })());
    } catch (e) {
        check('R26-6 effective-independence checks completed', false, e.stack);
    }

    // ---- AH. R26-13: seed replication + common random numbers -----------------
    // A single seed is not a ranking (Bouthillier et al. 2019; Henderson et al.
    // 2018). These checks pin the exact statistics the replication layer reports:
    // the interquartile mean (Agarwal et al. 2021), the stratified bootstrap CI,
    // the seed/fold/residual variance split, and the CRN paired-variance
    // criterion (Glasserman & Yao 1992).
    try {
        // IQM: drop the lowest and highest quarters, average the middle. Nine
        // sorted values -> drop 2 either side; the middle five of
        // [0,0,0,0,1,1,1,1,100] is [0,1,1,1,1] -> 0.8.
        check('R26-13: interquartileMean drops the best/worst quarter exactly',
            Math.abs(interquartileMean([0, 0, 0, 0, 1, 1, 1, 1, 100]) - 0.6) < 1e-12 &&
            interquartileMean([1, 2, 3, 4, 5, 6, 7, 8]) === 4.5);
        check('R26-13: interquartileMean falls back to the mean below four values and ignores non-finite ones',
            interquartileMean([1, 2, 3]) === 2 && Number.isNaN(interquartileMean([])) &&
            interquartileMean([1, NaN, 2, 3, Infinity]) === 2);

        // Constant, unequal strata: because the bootstrap preserves each stratum's
        // size, every replicate is identical -> a zero-width interval. That is the
        // proof it resamples WITHIN strata rather than pooling them.
        const flatCi = stratifiedBootstrapCI({ strata: [[0, 0, 0, 0, 0], [10, 10, 10]], statistic: (x) => x.reduce((a, b) => a + b, 0) / x.length, seed: 1 });
        check('R26-13: the stratified bootstrap resamples within strata (constant unequal strata -> zero-width CI)',
            flatCi.available && flatCi.lo === 3.75 && flatCi.hi === 3.75, JSON.stringify(flatCi));
        const varCi = stratifiedBootstrapCI({ strata: [[1, 2, 3], [10, 20, 30]], statistic: interquartileMean, seed: 99 });
        const varCi2 = stratifiedBootstrapCI({ strata: [[1, 2, 3], [10, 20, 30]], statistic: interquartileMean, seed: 99 });
        check('R26-13: the bootstrap CI is deterministic for a fixed seed, ordered, and resamples the requested count',
            varCi.available && varCi.lo <= varCi.hi && varCi.points > 0 &&
            JSON.stringify(varCi) === JSON.stringify(varCi2), JSON.stringify({ lo: varCi.lo, hi: varCi.hi }));
        check('R26-13: the bootstrap reports unavailable (never throws) with no finite observations',
            stratifiedBootstrapCI({ strata: [[], []] }).available === false);

        // Variance decomposition, hand-computed.
        const uniform = varianceComponents({ cells: [
            { seed: 1, fold: 0, value: 1 }, { seed: 1, fold: 1, value: 1 },
            { seed: 2, fold: 0, value: 1 }, { seed: 2, fold: 1, value: 1 },
            { seed: 3, fold: 0, value: 5 }, { seed: 3, fold: 1, value: 5 },
        ] });
        check('R26-13: varianceComponents attributes a pure between-seed spread to the seed fraction',
            uniform.available && Math.abs(uniform.seedFraction - 1) < 1e-12 &&
            Math.abs(uniform.foldFraction) < 1e-12 && Math.abs(uniform.residualFraction) < 1e-12,
            JSON.stringify({ s: uniform.seedFraction, f: uniform.foldFraction }));
        const foldOnly = varianceComponents({ cells: [
            { seed: 1, fold: 0, value: 0 }, { seed: 1, fold: 1, value: 2 },
            { seed: 2, fold: 0, value: 0 }, { seed: 2, fold: 1, value: 2 },
        ] });
        check('R26-13: varianceComponents attributes a pure within-seed (fold) spread to the fold fraction',
            Math.abs(foldOnly.seedFraction) < 1e-12 && Math.abs(foldOnly.foldFraction - 1) < 1e-12);
        const mixed = varianceComponents({ cells: [
            { seed: 1, fold: 0, value: 0 }, { seed: 1, fold: 1, value: 2 },
            { seed: 2, fold: 0, value: 1 }, { seed: 2, fold: 1, value: 3 },
        ] });
        check('R26-13: varianceComponents splits a mixed panel exactly (seed 0.2 / fold 0.8), fractions summing to 1',
            Math.abs(mixed.seedFraction - 0.2) < 1e-12 && Math.abs(mixed.foldFraction - 0.8) < 1e-12 &&
            Math.abs(mixed.seedFraction + mixed.foldFraction + mixed.residualFraction - 1) < 1e-12,
            JSON.stringify({ s: mixed.seedFraction, f: mixed.foldFraction }));
        const residual = varianceComponents({ cells: [
            { seed: 1, fold: 0, value: 0 }, { seed: 1, fold: 0, value: 2 },
            { seed: 2, fold: 0, value: 0 }, { seed: 2, fold: 0, value: 2 },
        ] });
        check('R26-13: varianceComponents isolates a repeated-cell residual fraction',
            Math.abs(residual.residualFraction - 1) < 1e-12 && Math.abs(residual.foldFraction) < 1e-12);
        check('R26-13: varianceComponents reports unavailable below two observations',
            varianceComponents({ cells: [{ seed: 1, fold: 0, value: 1 }] }).available === false);

        // The distribution block: exact IQM/mean over a crafted panel, plus the CI
        // and the component split.
        const dist = seedDistribution({ perSeed: [
            { seed: 1, values: [0, 0, 0, 0] }, { seed: 2, values: [1, 1, 1, 1] }, { seed: 3, values: [100] },
        ] });
        check('R26-13: seedDistribution reports the exact flat mean + IQM and a CI/component split',
            dist.available && dist.n === 9 && dist.seeds.length === 3 &&
            Math.abs(dist.iqm - 0.6) < 1e-12 && Math.abs(dist.statistic - 0.6) < 1e-12 &&
            dist.ci.available && dist.components.available &&
            dist.perSeedMean.length === 3 && JSON.stringify(dist.foldsPerSeed) === JSON.stringify([4, 4, 1]),
            JSON.stringify({ iqm: dist.iqm, mean: dist.mean }));
        check('R26-13: seedDistribution reports unavailable with no finite values',
            seedDistribution({ perSeed: [{ seed: 1, values: [] }] }).available === false);

        // CRN criterion: with common random numbers the variance of the paired
        // DIFFERENCE should be below the unpaired one.
        const crn = pairedVarianceRatio({
            paired: [1.0, 1.02, 0.98, 1.01, 0.99, 1.0],
            unpaired: [1, -1, 3, -3, 2, -2],
        });
        check('R26-13: pairedVarianceRatio shows a variance reduction when the differences are paired on the draws',
            crn.available && crn.varianceRatio < 1 && crn.varianceReduction > 0 &&
            Math.abs(crn.varianceReduction - (1 - crn.varianceRatio)) < 1e-12,
            JSON.stringify({ ratio: crn.varianceRatio }));
        check('R26-13: pairedVarianceRatio reports unavailable on too-few or zero-variance samples',
            pairedVarianceRatio({ paired: [1], unpaired: [1, 2] }).available === false &&
            pairedVarianceRatio({ paired: [1, 1], unpaired: [2, 2] }).available === false);

        check('R26-13: formatSeedReplication names the variant, level and interval',
            (() => {
                const s = formatSeedReplication({ label: 'seeds baseline', dist });
                return typeof s === 'string' && s.includes('seeds baseline:') && s.includes('IQM=') && s.includes('CI=');
            })());
        check('R26-13: formatSeedReplication states unavailability instead of rendering NaN',
            formatSeedReplication({ label: 'x', dist: { available: false, reason: 'none' } }).includes('unavailable'));
    } catch (e) {
        check('R26-13 replication checks completed', false, e.stack);
    }

    // ---- AI. R26-14: forecast proper scores, Diebold–Mariano, Model Confidence Set
    // The family compared as *forecasters*: proper scores cannot be earned by
    // hedging toward the base rate (Gneiting & Raftery 2007), the paired DM test
    // says whether a candidate's loss really differs (Diebold & Mariano 1995), and
    // the MCS returns the set of families that cannot be distinguished from the
    // best (Hansen, Lunde & Nason 2011) instead of crowning the sample-best.
    try {
        // The per-bar pair: a signed confidence in [-1,1] predicts the NEXT bar's
        // sign; the last bar of each fold is dropped (its outcome is outside).
        const pairs = forecastPairs([{ returns: [0.01, -0.02, 0.03], confidence: [0.5, -0.5, 0.9] }]);
        check('R26-14: forecastPairs maps confidence -> probability and next-bar sign, dropping each fold\'s last bar',
            pairs.bars === 2 && pairs.forecasts[0] === 0.75 && pairs.outcomes[0] === 0 &&
            pairs.forecasts[1] === 0.25 && pairs.outcomes[1] === 1,
            JSON.stringify(pairs));
        check('R26-14: forecastPairs skips non-finite pairs and an absent confidence',
            forecastPairs([{ returns: [0.01, 0.02], confidence: [null, 0.1] }]).bars === 0 &&
            forecastPairs([{ returns: [0.01, 0.02] }]).bars === 0 &&
            forecastPairs(null).bars === 0);
        check('R26-14: brierBinIndex puts 0, 0.5 (10 bins) and 1 in the right equal-width bin',
            brierBinIndex(0, 10) === 0 && brierBinIndex(0.5, 10) === 5 && brierBinIndex(1, 10) === 9);

        // Proper scores, hand-computed.
        check('R26-14: brierScore is the exact mean squared probability error',
            Math.abs(brierScore([0.2, 0.8], [0, 1]) - 0.04) < 1e-12 &&
            Number.isNaN(brierScore([], [])) &&
            Math.abs(brierScore([0.5, 0.5, NaN], [1, 0, 1]) - 0.25) < 1e-12);
        check('R26-14: logScore is the exact mean negative log-likelihood',
            Math.abs(logScore([0.5, 0.5], [0, 1]) - Math.log(2)) < 1e-12 &&
            Math.abs(logScore([0.9, 0.9], [1, 1]) - (-Math.log(0.9))) < 1e-12);
        check('R26-14: logScore clips a confidently-wrong forecast instead of returning Infinity',
            Number.isFinite(logScore([0, 1], [1, 0])));

        // Murphy's partition: BS_binned = REL - RES + UNC, exactly.
        const d1 = brierDecomposition({ forecasts: [0.2, 0.8], outcomes: [0, 1], bins: 2 });
        check('R26-14: brierDecomposition reproduces the exact REL/RES/UNC and the identity (one point per bin)',
            Math.abs(d1.reliability - 0.04) < 1e-12 && Math.abs(d1.resolution - 0.25) < 1e-12 &&
            Math.abs(d1.uncertainty - 0.25) < 1e-12 && Math.abs(d1.brierBinned - 0.04) < 1e-12 &&
            Math.abs(d1.identityResidual) < 1e-12 && Math.abs(d1.brier - 0.04) < 1e-12,
            JSON.stringify(d1));
        const d2 = brierDecomposition({ forecasts: [0.2, 0.4], outcomes: [0, 1], bins: 2 });
        check('R26-14: brierDecomposition accounts for within-bin variance (both in one bin)',
            Math.abs(d2.reliability - 0.04) < 1e-12 && Math.abs(d2.resolution) < 1e-12 &&
            Math.abs(d2.brierBinned - 0.29) < 1e-12 && Math.abs(d2.brier - 0.20) < 1e-12 &&
            Math.abs(d2.identityResidual) < 1e-12,
            JSON.stringify({ binned: d2.brierBinned, rel: d2.reliability }));
        check('R26-14: brierLosses is the per-bar squared error',
            JSON.stringify(brierLosses([0.5, 0.5], [1, 0])) === JSON.stringify([0.25, 0.25]));

        // Bootstrap determinism.
        const bsSeries = [[1, 2, 3, 4, 5, 6, 7, 8].map((x) => x / 10), [2, 3, 4, 5, 6, 7, 8, 9].map((x) => x / 10)];
        const bs1 = bootstrapMeans(bsSeries, { nBoot: 200, seed: 3 });
        const bs2 = bootstrapMeans(bsSeries, { nBoot: 200, seed: 3 });
        check('R26-14: bootstrapMeans is deterministic for a fixed seed and reports its block length',
            bs1.available && JSON.stringify([...bs1.means]) === JSON.stringify([...bs2.means]) && bs1.blockLength >= 1 && bs1.K === 2,
            JSON.stringify({ b: bs1.blockLength }));
        check('R26-14: bootstrapMeans reports unavailable on empty input',
            bootstrapMeans([]).available === false && bootstrapMeans([[]]).available === false);

        // Diebold–Mariano, exact degenerate cases.
        const dmConst = dieboldMariano({
            lossA: [0.3, 0.3, 0.3, 0.3], lossB: [0.2, 0.2, 0.2, 0.2], nBoot: 200, seed: 1,
        });
        check('R26-14: a constant positive loss differential is rejected with p=0 (candidate A worse => favored B)',
            dmConst.available && dmConst.meanDifferential > 0 && dmConst.pValue === 0 &&
            dmConst.statistic === Infinity && dmConst.favored === 'B', JSON.stringify(dmConst));
        const dmZero = dieboldMariano({ lossA: [0.2, 0.2], lossB: [0.2, 0.2], nBoot: 100, seed: 1 });
        check('R26-14: a zero differential is not rejected (statistic 0, p=1, favored null)',
            dmZero.available && dmZero.statistic === 0 && dmZero.pValue === 1 && dmZero.favored === null);
        const dmNoisy = dieboldMariano({
            lossA: Array.from({ length: 48 }, (_, i) => 0.25 + 0.02 * Math.sin(i)),
            lossB: Array.from({ length: 48 }, (_, i) => 0.22 + 0.02 * Math.cos(i)),
            nBoot: 400, seed: 5,
        });
        const dmNoisy2 = dieboldMariano({
            lossA: Array.from({ length: 48 }, (_, i) => 0.25 + 0.02 * Math.sin(i)),
            lossB: Array.from({ length: 48 }, (_, i) => 0.22 + 0.02 * Math.cos(i)),
            nBoot: 400, seed: 5,
        });
        check('R26-14: the DM test is deterministic, reports a finite SE and a p in (0,1], favoring the lower-loss side',
            dmNoisy.available && dmNoisy.se > 0 && dmNoisy.pValue > 0 && dmNoisy.pValue <= 1 &&
            dmNoisy.favored === 'B' && JSON.stringify(dmNoisy) === JSON.stringify(dmNoisy2),
            JSON.stringify({ se: dmNoisy.se, p: dmNoisy.pValue }));
        check('R26-14: the DM test reports unavailable on too few paired observations',
            dieboldMariano({ lossA: [0.1], lossB: [0.2] }).available === false);

        // Model Confidence Set: a strictly-worse model is eliminated; the identical
        // pair survives.
        const baseLoss = Array.from({ length: 60 }, (_, i) => 0.20 + 0.05 * Math.sin(i * 0.7));
        const worse = baseLoss.map((x) => x + 0.1);
        const mcs = modelConfidenceSet({ losses: [baseLoss, worse, baseLoss.slice()], ids: ['a', 'b', 'c'], alpha: 0.10, nBoot: 400, seed: 7 });
        check('R26-14: the MCS eliminates the uniformly worse model and keeps the indistinguishable pair',
            mcs.available && JSON.stringify(mcs.memberIds) === JSON.stringify(['a', 'c']) &&
            mcs.eliminated.length === 1 && mcs.eliminated[0].id === 'b',
            JSON.stringify({ members: mcs.memberIds, elim: mcs.eliminated }));
        check('R26-14: the MCS is deterministic and reports the eliminated step + p-value',
            JSON.stringify(modelConfidenceSet({ losses: [baseLoss, worse, baseLoss.slice()], ids: ['a', 'b', 'c'], alpha: 0.10, nBoot: 400, seed: 7 })) === JSON.stringify(mcs) &&
            typeof mcs.eliminated[0].pValue === 'number');
        const graded = [0, 1, 2, 3].map((k) => baseLoss.map((x) => x + k * 0.03 + 0.02 * Math.sin(k + 1)));
        const m90 = modelConfidenceSet({ losses: graded, ids: ['g0', 'g1', 'g2', 'g3'], alpha: 0.10, nBoot: 400, seed: 11 });
        const m95 = modelConfidenceSet({ losses: graded, ids: ['g0', 'g1', 'g2', 'g3'], alpha: 0.05, nBoot: 400, seed: 11 });
        check('R26-14: a higher confidence level yields a superset MCS (membership is monotone)',
            m90.available && m95.available &&
            m90.memberIds.every((id) => m95.memberIds.includes(id)) &&
            m95.memberIds.length >= m90.memberIds.length,
            JSON.stringify({ at90: m90.memberIds, at95: m95.memberIds }));
        check('R26-14: the MCS handles the degenerate sizes (one model is its own set; none is unavailable)',
            JSON.stringify(modelConfidenceSet({ losses: [baseLoss], ids: ['solo'] }).memberIds) === JSON.stringify(['solo']) &&
            modelConfidenceSet({ losses: [] }).available === false);

        // The whole layer over a journal.
        const fcRet = Array.from({ length: 40 }, (_, i) => 0.01 * Math.sin(i * 0.5));
        const fcBase = [{ returns: fcRet.slice(), confidence: fcRet.map((_, i) => 0.3 * Math.sin(i * 0.5)) }];
        // The forecast at bar j predicts the sign of bar j+1, so a "perfect"
        // forecaster is aligned to returns[j+1] (not returns[j]).
        const fcGood = [{ returns: fcRet.slice(), confidence: fcRet.map((_, j) => (j + 1 < fcRet.length ? (fcRet[j + 1] > 0 ? 0.9 : -0.9) : 0)) }];
        const fcBad = [{ returns: fcRet.slice(), confidence: fcGood[0].confidence.map((c) => -c) }];
        const cmp = forecastComparison({
            baseline: fcBase, candidates: [{ id: 'good', foldInputs: fcGood }, { id: 'bad', foldInputs: fcBad }],
            nBoot: 300, seed: 13,
        });
        check('R26-14: forecastComparison scores every variant and names the MCS members',
            cmp.available && cmp.bars === 39 && !!cmp.byId.baseline && !!cmp.byId.good && !!cmp.byId.bad &&
            cmp.mcs.at90.available && cmp.mcs.at95.available && cmp.mcs.at90.memberIds.length > 0 &&
            cmp.mcs.at90.memberIds.every((id) => ['baseline', 'good', 'bad'].includes(id)),
            JSON.stringify(cmp.mcs.at90.memberIds));
        check('R26-14: a perfect forecaster has a lower Brier/log score than the lagging baseline (and the MCS keeps it, dropping the inverted one)',
            cmp.byId.good.brier < cmp.byId.baseline.brier && cmp.byId.good.logScore < cmp.byId.baseline.logScore &&
            cmp.mcs.at90.memberIds.includes('good') && !cmp.mcs.at90.memberIds.includes('bad') &&
            cmp.byId.bad.brier > cmp.byId.baseline.brier,
            JSON.stringify({ base: cmp.byId.baseline.brier, good: cmp.byId.good.brier, bad: cmp.byId.bad.brier }));
        check('R26-14: forecastComparison refuses a mismatched window rather than comparing unpaired',
            forecastComparison({ baseline: fcBase, candidates: [{ id: 'short', foldInputs: [{ returns: [0.1, 0.2], confidence: [0.1, 0.2] }] }] }).available === false);
        check('R26-14: formatForecast renders the level, the baseline scores and both MCS sets',
            (() => { const s = formatForecast(cmp); return typeof s === 'string' && s.includes('forecast:') && s.includes('mcs90=[') && s.includes('mcs95=['); })());
        check('R26-14: formatForecast states unavailability rather than rendering NaN',
            formatForecast({ available: false, reason: 'none' }).includes('unavailable'));
        // R27-5: the family is scored WITHIN a kind. `(c+1)/2` inverts
        // `confidenceFromProb` exactly, so a controller candidate's Brier is a
        // proper score of a probability and the DM test vs the baseline is
        // meaningful; a signal's journaled confidence is a normalised z-score, so
        // it is scored only against the other signals (no cross-kind DM).
        const gRet = Array.from({ length: 30 }, (_, i) => 0.01 * Math.sin(i * 0.7));
        const gFI = (scale) => [{ returns: gRet.slice(), confidence: gRet.map((_, i) => scale * Math.sin(i * 0.7)) }];
        const grp = forecastComparison({
            baseline: gFI(0.4), baselineKind: 'controller',
            candidates: [{ id: 'ctl', kind: 'controller', foldInputs: gFI(0.6) }, { id: 'sig', kind: 'signal', foldInputs: gFI(0.2) }],
            nBoot: 200, seed: 21,
        });
        check('R27-5: forecastComparison groups by kind — the DM test vs the baseline runs only inside the baseline kind',
            grp.available && grp.kind === 'controller' &&
            grp.kinds.map((g) => g.kind).join(',') === 'controller,signal' &&
            grp.byKind.controller.members.join(',') === 'baseline,ctl' && grp.byKind.signal.members.join(',') === 'sig' &&
            grp.byId.ctl.kind === 'controller' && grp.byId.ctl.dm.available === true &&
            grp.byId.sig.kind === 'signal' && grp.byId.sig.dm.available === false && grp.byId.sig.dm.reason.includes('cross-kind') &&
            grp.mcs.at90.available && grp.mcs.at90.memberIds.every((id) => grp.byId[id].kind === 'controller') &&
            grp.reader.includes('grouped by `kind`'),
            JSON.stringify({ kinds: grp.kinds, ctl: grp.byId.ctl.dm.available, sig: grp.byId.sig.dm.available }));
        check('R27-5: the forecast summary names the grouped roster',
            (() => { const s = formatForecast(grp); return s.includes('groups: controller(') && s.includes('signal('); })());
    } catch (e) {
        check('R26-14 forecast checks completed', false, e.stack);
    }

    // ---- AJ. R26-7: give the gate discriminating power -------------------------
    // The sign-test `requireBreadth` hurdle passed every candidate and hit its 2^-n
    // floor, so it separated nothing about magnitude. The shipped dependence gate
    // now uses the magnitude floor (`requireSharpeDiff`, already present) plus a
    // cluster-STABILITY requirement (`clusterStability`): the paired Sharpe
    // difference must survive deleting any single fold-window cluster, so an edge
    // carried by a handful of folds cannot pass. Breadth stays REPORTED.
    try {
        // The stability primitive against hand-computed panels.
        const meanStat = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        const st = clusterStability({
            clustersA: [[1, 1], [1, 1], [1, 1], [1, 1]], clustersB: [[0, 0], [0, 0], [0, 0], [0, 0]], statistic: meanStat,
        });
        check('R26-7: clusterStability reports a uniformly positive panel as stable (every leave-one-out delta > 0)',
            st.available && st.stable && st.fractionPositive === 1 && st.nClusters === 4 && st.worstDelta === 1 && st.full === 1,
            JSON.stringify({ worst: st.worstDelta, frac: st.fractionPositive }));
        const frag = clusterStability({ clustersA: [[0], [10], [0], [0]], clustersB: [[0], [0], [0], [0]], statistic: meanStat });
        check('R26-7: clusterStability flags an edge carried by one window (dropping it leaves delta 0, not positive)',
            frag.available && !frag.stable && Math.abs(frag.fractionPositive - 0.75) < 1e-12 &&
            frag.worstCluster === 1 && frag.worstDelta === 0 && frag.full === 2.5,
            JSON.stringify({ frac: frag.fractionPositive, worst: frag.worstDelta }));
        check('R26-7: clusterStability reports unavailable below two clusters (never throws)',
            clusterStability({ clustersA: [[1]], clustersB: [[0]], statistic: meanStat }).available === false &&
            clusterStability({ clustersA: [[1], [2]], clustersB: [[1]], statistic: meanStat }).available === false);

        // The gate on a panel. A tiny per-window edge: the sign test passes 6/6, but
        // the paired magnitude test does not clear alpha — so breadth alone would
        // promote while the magnitude floor rejects.
        const panelFromClusters = (clusters, q) => {
            const streams = [new Array(clusters.length * q).fill(0), new Array(clusters.length * q).fill(0)];
            clusters.forEach((vals, c) => {
                for (let i = 0; i < q; i++) { streams[0][c * q + i] = vals[i]; streams[1][c * q + i] = vals[q + i]; }
            });
            return { streamReturns: streams, dependence: { available: true, foldLength: q } };
        };
        const mkReport = (clusters, q) => ({
            aggregate: { mean: 1, positiveFraction: 1 },
            pooledMetrics: { dsr: 0.99, dsrAdjusted: 0.99, effectiveBars: 1000 },
            folds: [], audit: null,
            ...panelFromClusters(clusters, q),
        });
        const C = 6; const q = 3;
        const base = (c) => {
            const pulse = [0.01, -0.004, 0.007, 0.002, -0.006, 0.005];
            const k = (c % 3) - 1;
            return pulse.map((x, i) => x + 0.001 * k * (i + 1));
        };
        const baselineClusters = Array.from({ length: C }, (_, c) => base(c));
        const repB = mkReport(baselineClusters, q);
        const gateOpts = {
            requireCleanAudit: false, minSharpeDelta: 0, minDsrDelta: 0, minDsr: 0,
            requireSharpeDiff: true, requireClusterStability: true, minDsrAdjusted: null, alpha: 0.05,
        };
        const decTiny = promoteDecision(repB, mkReport(baselineClusters.map((vals, c) => vals.map((x) => x + (c % 2 === 0 ? 0.0002 : 0.02))), q), gateOpts);
        check('R26-7: a candidate that wins every window with a magnitude inside the noise FAILS the magnitude floor',
            !decTiny.promote && decTiny.gate.requireSharpeDiff === 'applied' &&
            decTiny.reasons.some((r) => /Sharpe difference not significant/.test(r)) &&
            decTiny.promotionTest.breadth.significant === true,
            JSON.stringify({ reasons: decTiny.reasons, breadthP: decTiny.promotionTest.breadth.pValue }));
        const decReal = promoteDecision(repB, mkReport(baselineClusters.map((vals, c) => vals.map((x) => x + 0.02 + 0.002 * c)), q), gateOpts);
        check('R26-7: a genuine, stable edge passes the magnitude floor and the stability hurdle',
            decReal.promote && decReal.gate.requireSharpeDiff === 'applied' && decReal.gate.requireClusterStability === 'applied' &&
            decReal.promotionTest.stability.stable === true, JSON.stringify(decReal.reasons));
        const decFrag = promoteDecision(repB, mkReport(baselineClusters.map((vals, c) => c === 5 ? vals.map((x) => x + 0.5) : vals.map((x) => x - 0.004)), q), gateOpts);
        check('R26-7: an edge carried by ONE window fails the stability hurdle even though the full-sample difference is positive',
            !decFrag.promote && decFrag.gate.requireClusterStability === 'applied' &&
            decFrag.promotionTest.stability.stable === false &&
            decFrag.reasons.some((r) => /cluster stability/.test(r)),
            JSON.stringify({ reasons: decFrag.reasons, st: decFrag.promotionTest.stability }));
        // No panel: both dependence hurdles are SKIPPED, not failed.
        const noPanel = { aggregate: { mean: 1, positiveFraction: 1 }, pooledMetrics: { dsr: 0.99 }, folds: [], audit: null };
        const decNoPanel = promoteDecision(noPanel, noPanel, gateOpts);
        check('R26-7: a single-stream / no-panel report SKIPS the dependence hurdles (never claims them)',
            decNoPanel.promote && decNoPanel.gate.requireSharpeDiff === 'skipped-no-panel' &&
            decNoPanel.gate.requireClusterStability === 'skipped-no-panel' && decNoPanel.gate.requireBreadth === 'off');
        check('R26-7: the shipped dependence reader names the stability half and that breadth is reported-only',
            DEPENDENCE_GATE_READER.includes('STABLE') && DEPENDENCE_GATE_READER.includes('sign test') &&
            DEPENDENCE_GATE_READER.includes('dsrAdjusted') && DEPENDENCE_GATE_READER.includes('no longer a gate'));
    } catch (e) {
        check('R26-7 gate checks completed', false, e.stack);
    }

    // ---- AK. R26-8: the decision-grade report ----------------------------------
    // The six-question composition. Primitive-level exact reference vectors, then
    // the composer and the formatter. Nothing here computes a new strategy
    // statistic: `foldConcentration` restates the scored folds and the retained
    // `foldInputs`, and `nextRunPlan` reads the measured power.
    try {
        // (a) top-K share / signed sums, from the per-fold metrics alone.
        const mkFolds = (gross) => gross.map((g) => ({ metrics: { grossPnl: g, netSharpe: g, bars: 2, turnover: 0, totalCost: 0 } }));
        const concA = foldConcentration({ folds: mkFolds([0.10, 0.05, 0.02, -0.01]), topKs: [1, 2, 4] });
        check('R26-8: foldConcentration sums gross/positive/negative exactly',
            concA.available && Math.abs(concA.grossTotal - 0.16) < 1e-12 &&
            Math.abs(concA.positiveSum - 0.17) < 1e-12 && Math.abs(concA.negativeSum - (-0.01)) < 1e-12,
            JSON.stringify(concA));
        check('R26-8: foldConcentration top-K shares are exact and saturate at 1',
            Math.abs(concA.topKs[0].share - 0.625) < 1e-12 &&
            Math.abs(concA.topKs[1].share - 0.9375) < 1e-12 && Math.abs(concA.topKs[2].share - 1) < 1e-12);
        check('R26-8: foldConcentration without foldInputs reports the leave-one-out readouts as explicit unavailable',
            concA.deleteOneCluster.available === false && concA.marginal.available === false &&
            typeof concA.deleteOneCluster.reason === 'string' && typeof concA.marginal.reason === 'string');

        // (b) the leave-one-fold-out Sharpe range and per-fold marginal
        // contribution against an INDEPENDENTLY recomputed sweep.
        const sig = (n) => new Array(n).fill(1);
        const rawA = [[0.03, 0.01, 0.02], [0.01, -0.01, 0.02], [0.02, 0.02, -0.01]];
        const foldInputs = rawA.map((r) => ({ returns: r, signals: sig(r.length), confidence: null }));
        const nets = foldInputs.map((fi) => strategyReturns({ returns: fi.returns, signals: fi.signals, costBps: 0 }).returns);
        const expectFull = sharpeRatio([].concat(...nets), { periodsPerYear: 252 });
        const expectLOO = nets.map((_, i) => sharpeRatio([].concat(...nets.slice(0, i), ...nets.slice(i + 1)), { periodsPerYear: 252 }));
        const concB = foldConcentration({ folds: mkFolds(nets.map((n) => n.reduce((a, b) => a + b, 0))), foldInputs, costBps: 0 });
        check('R26-8: foldConcentration deleteOneCluster range/marginals match an independent leave-one-out sweep',
            concB.deleteOneCluster.available && concB.marginal.available &&
            Math.abs(concB.deleteOneCluster.full - expectFull) < 1e-12 &&
            concB.deleteOneCluster.min === Math.min(...expectLOO) && concB.deleteOneCluster.max === Math.max(...expectLOO) &&
            concB.marginal.values.every((v, i) => Math.abs(v - (expectFull - expectLOO[i])) < 1e-12),
            JSON.stringify({ full: concB.deleteOneCluster.full, expectFull }));
        const worst = expectLOO.indexOf(Math.min(...expectLOO));
        check('R26-8: the deleteOneCluster worst index names the fold whose removal drops the Sharpe most',
            concB.deleteOneCluster.worstIndex === worst && concB.deleteOneCluster.range >= 0);

        // (c) confidence persistence — exact lag-1 cases.
        check('R26-8: confidencePersistence is unavailable without a confidence journal',
            confidencePersistence({ foldInputs: [{ returns: [], signals: [] }] }).available === false);
        const alt = confidencePersistence({ foldInputs: [{ confidence: [0, 1, 0, 1] }] });
        check('R26-8: confidencePersistence gives lag1 = -1 (and no half-life) on an alternating series',
            alt.available && Math.abs(alt.lag1 + 1) < 1e-12 && alt.halfLife === null && alt.pairs === 3);
        const mono = confidencePersistence({ foldInputs: [{ confidence: [0, 1, 2, 3] }] });
        check('R26-8: confidencePersistence gives lag1 = 1 (no half-life) on a monotone series',
            Math.abs(mono.lag1 - 1) < 1e-12 && mono.halfLife === null);
        const rho = confidencePersistence({ foldInputs: [{ confidence: [0, 0, 1, 1, 1] }] });
        check('R26-8: confidencePersistence half-life is exact (lag1 = 1/sqrt(3), halfLife = 2 ln2 / ln3)',
            Math.abs(rho.lag1 - 1 / Math.sqrt(3)) < 1e-12 &&
            Math.abs(rho.halfLife - (2 * Math.log(2) / Math.log(3))) < 1e-12,
            JSON.stringify({ lag1: rho.lag1, halfLife: rho.halfLife }));
        const seg = confidencePersistence({ foldInputs: [{ confidence: [0, 1] }, { confidence: [100, 200] }] });
        check('R26-8: confidencePersistence counts adjacent pairs WITHIN folds (a fold boundary is not a time step)',
            seg.available && seg.pairs === 2 && seg.bars === 4);

        // (d) next-run sizing against a frozen fixture.
        const power = { observedSharpe: 1, mdeSharpe: 0.5, mdeSharpeDependent: 0.9, underpowered: false, underpoweredDependent: true, barsToDetect1: 969, effectiveBars: 4000 };
        const dependence = { designEffect: 4, effectiveBars: 4000, seCluster: 0.1 };
        const cand = {
            id: 'sig:x', promote: false, reasons: ['pooled Sharpe difference not significant'],
            gate: { requireSharpeDiff: 'applied', requireClusterStability: 'applied' },
            promotionTest: { available: true, sharpeDifference: { available: true, value: 0.05, se: 0.1, nClusters: 40 } },
            pooledMetrics: { breakEvenCostBps: 3 },
        };
        const nr = nextRunPlan({ power, dependence, candidate: cand, levels: [0, 2, 5, 10], periodsPerYear: 252, durationMs: 60000, folds: 100, streams: 8 });
        check('R26-8: nextRunPlan carries the effective sample and both MDEs',
            nr.available && nr.designEffect === 4 && nr.effectiveBars === 4000 &&
            nr.mde95 === 0.5 && nr.mde95Dependent === 0.9 && nr.underpowered===false && nr.underpoweredDependent === true);
        check('R26-8: nextRunPlan bars-to-detect are exact at the measured design effect',
            nr.barsToDetect1 === 969 && nr.barsToDetectObserved === 969 && nr.barsToDetectDependent === 3876,
            JSON.stringify({ o: nr.barsToDetectObserved, d: nr.barsToDetectDependent }));
        check('R26-8: nextRunPlan break-even is compared against every tested cost level',
            nr.breakEvenBps === 3 && nr.clearsBps[0] === true && nr.clearsBps[2] === true &&
            nr.clearsBps[5] === false && nr.clearsBps[10] === false);
        check('R26-8: nextRunPlan measures the per-fold wall time and projects a doubled fold count',
            nr.measuredPerFoldMs === 600 && nr.projected.folds === 200 && Math.abs(nr.projected.ms - 120000) < 1e-9);
        // R28 (BUGS.md #56): the requirement is the ONE-SIDED cluster-t — the test the
        // gate actually runs (`pairedClusterTest.significant` is `pOneSided <=
        // alpha`) — times the PAIRED SE, not the two-sided normal constant times the
        // single-series `seCluster`. On this fixture both SEs are 0.1, so the whole
        // change is the reference (1.959964 -> t(39) = 1.684875).
        const t39 = studentTCritical(39, { alpha: 0.05, twoSided: false });
        check('R28: the magnitude cheapest-flip is the one-sided cluster-t x the PAIRED SE (required = t(39) x 0.1, factor = required/difference)',
            nr.cheapestFlip.available && nr.cheapestFlip.kind === 'magnitude' && nr.cheapestFlip.scale === 'paired' &&
            nr.cheapestFlip.df === 39 &&
            Math.abs(nr.cheapestFlip.requiredSharpeDifference - t39 * 0.1) < 1e-9 &&
            Math.abs(nr.cheapestFlip.factor - (t39 * 0.1) / 0.05) < 1e-9,
            JSON.stringify(nr.cheapestFlip));
        // R27-5: the requirement is named as a requirement. `required.observed` read
        // as an observation ("we observed 37 clusters") when it is what the run
        // NEEDS; it is now `neededForObserved`, with the generic map kept alongside.
        check('R26-8/R27-5/R28: nextRunPlan sizes a PAIRED comparison from the paired SE, the cluster count and the ONE-SIDED cluster-t',
            nr.pairedUnits.available && nr.pairedUnits.se === 0.1 && nr.pairedUnits.seScale === 'paired' &&
            nr.pairedUnits.nClusters === 40 && nr.pairedUnits.side === 'one-sided' &&
            nr.pairedUnits.reference.kind === 'student-t' && nr.pairedUnits.reference.df === 39 &&
            Math.abs(nr.pairedUnits.reference.critical - t39) < 1e-12 &&
            Math.abs(nr.pairedUnits.reference.pairedMde95 - t39 * 0.1) < 1e-12 &&
            // 435 clusters: the smallest n whose t(n-1) x 0.1 x sqrt(40/n) <= 0.05.
            nr.pairedUnits.neededForObserved === 435 && nr.pairedUnits.needed.observed === 435 &&
            // R28: the same requirement at 80% power, and NOT the old cross-scale
            // `mde95Dependent` target (which sized a paired comparison with a
            // single-series MDE).
            nr.pairedUnits.neededForObservedPower80 === 991 &&
            nr.pairedUnits.neededForMde95Dependent === undefined,
            JSON.stringify(nr.pairedUnits));
        // The branches the first fixture left untested: the round-26 stability hint
        // (the R26-7 feature) and the gate/search fallbacks.
        const nrStab = nextRunPlan({
            candidate: {
                promote: false, reasons: ['r'], pooledMetrics: { breakEvenCostBps: 5 },
                promotionTest: { available: true, stability: { available: true, stable: false, worstCluster: 2, worstDelta: 0.01 } },
                gate: { requireSharpeDiff: 'applied', requireClusterStability: 'applied' },
            },
            dependence: { seCluster: 0.1 }, levels: [0, 2, 5, 10],
        });
        const nrGate = nextRunPlan({
            candidate: {
                promote: false, reasons: ['r1'], pooledMetrics: { breakEvenCostBps: 5 },
                promotionTest: { available: true, stability: { available: true, stable: true, worstDelta: 0.1 } },
                gate: { requireSharpeDiff: 'off' },
            },
            levels: [0, 2, 5, 10],
        });
        const nrSearch = nextRunPlan({ candidate: { promote: false, reasons: [], pooledMetrics: null, promotionTest: null, gate: null }, levels: [0, 2, 5, 10] });
        check('R26-8: the stability, gate and search cheapest-flip branches each name their binding lever',
            nrStab.cheapestFlip.kind === 'stability' && nrStab.cheapestFlip.binding === 'r' && /window 2/.test(nrStab.cheapestFlip.reader) &&
            nrGate.cheapestFlip.kind === 'gate' && nrGate.cheapestFlip.binding === 'r1' &&
            nrSearch.cheapestFlip.kind === 'search' && nrSearch.cheapestFlip.binding === null);
        const nrCost = nextRunPlan({ candidate: { promote: false, reasons: ['x'], pooledMetrics: { breakEvenCostBps: -0.5 }, promotionTest: null, gate: null }, levels: [0, 2, 5, 10] });
        check('R26-8: a negative break-even is reported as the cost-bound cheapest flip',
            nrCost.cheapestFlip.kind === 'cost' && /bps/.test(nrCost.cheapestFlip.reader));
        const nrPromoted = nextRunPlan({ candidate: { promote: true, reasons: [], pooledMetrics: { breakEvenCostBps: 6 }, promotionTest: null, gate: null } });
        check('R26-8: a promoted candidate has no cheapest flip to make',
            nrPromoted.cheapestFlip.kind === 'none');
        check('R26-8: nextRunPlan without a candidate reports the flip as unavailable',
            nextRunPlan({ power }).cheapestFlip.available === false);

        // (e) the composer: all six question blocks present, missing inputs explicit.
        const dec = decisionReport({ candidate: { id: 'sig:x', promote: false, reasons: ['r'], model: null } });
        check('R26-8: decisionReport returns all six question blocks under one schema',
            dec.schema === 'nl.decision.v1' && !!dec.training && !!dec.edge && !!dec.concentration &&
            !!dec.economics && !!dec.family && !!dec.nextRun && dec.verdict.promote === false);
        // BUGS #41: feed the REAL producer shape (`replicateAnalysis`'s aggregate is
        // keyed `byVariant`, with the component split nested as `.components`) — the
        // family seed fields accept a supplied aggregate but this producer does not
        // populate them, so they stay `na` and the readers now say where it lives.
        const decRep = decisionReport({ candidate: { id: 'sig:x', promote: false, reasons: ['r'], model: null }, replication: { seeds: [1, 2, 3], variants: ['baseline', 'sig:x'], commonRandomNumbers: true, byVariant: { 'sig:x': { available: true, mean: 0.1, components: { seedFraction: 0.2 } } } } });
        check('R26-8: absent inputs become explicit { available:false, reason } blocks, never bare null',
            dec.training.model.available === false && typeof dec.training.model.reason === 'string' &&
            dec.concentration.available === false && dec.economics.costLadder.available === false &&
            dec.family.seedDistribution.available === false && dec.nextRun.available === false &&
            // BUGS #41: the cross-seed fields must point at `replication.json` (the
            // per-seed report cannot summarize its siblings), not promise that
            // `--seeds` populates them here.
            /replication\.json/.test(dec.family.seedDistribution.reason) &&
            /replication\.json/.test(dec.family.varianceComponents.reason) &&
            /replication\.json/.test(dec.family.pairedVarianceRatio.reason) &&
            // ...and the real `byVariant` producer shape must not silently populate
            // them (the shape-mismatch the fields were written against, BUGS #41).
            decRep.family.seedDistribution.available === false &&
            decRep.family.varianceComponents.available === false &&
            decRep.family.pairedVarianceRatio.available === false);
        check('R26-8: the edge block names the binding hurdle and keeps the verdict',
            dec.edge.bindingHurdle === 'r' && dec.edge.promote === false && Array.isArray(dec.edge.reasons));
        const passedConcentration = foldConcentration({ folds: mkFolds([0.1, -0.1]), topKs: [1] });
        const dec2 = decisionReport({ candidate: { id: 'c', promote: true, reasons: [] }, concentration: passedConcentration, nextRun: nr });
        check('R26-8: decisionReport passes a provided block through by reference',
            dec2.concentration === passedConcentration && dec2.nextRun === nr && dec2.verdict.promote === true);
        const decModel = decisionReport({ candidate: { id: 'm', promote: false, reasons: [], model: { status: 'base-rate', baseRate: 0.27, resolved: { takeProfit: 1, stopLoss: 3, total: 4 }, heldBars: { count: 4, mean: 2 } } } });
        check('R26-8: training.labelDistribution is derived from the model diagnostics (never the unproduced model.labelDistribution field)',
            decModel.training.labelDistribution.baseRate === 0.27 && decModel.training.labelDistribution.status === 'base-rate' &&
            decModel.training.labelDistribution.resolved.total === 4 && decModel.training.labelDistribution.heldBars.mean === 2 &&
            decisionReport({ candidate: { id: 's', promote: false, reasons: [], model: null } }).training.labelDistribution === null);

        // R27-5: the round-26 winner is a pure signal (no model block), so the old
        // decision block rendered the training question as "no model diagnostics
        // were collected" — false, because the controllers did train. A winner with
        // no model of its own now borrows the BASELINE controller's diagnostics and
        // names it as an explicit referent.
        const baselineModel = { available: true, status: 'base-rate', baseRate: 0.38, trainingSteps: 900, resolved: { takeProfit: 1, stopLoss: 3, total: 4 }, heldBars: { count: 4, mean: 1 } };
        const decRef = decisionReport({
            candidate: { id: 'sig:momentum', promote: false, reasons: ['r'], model: null },
            model: baselineModel,
            modelReferent: { kind: 'baseline', reason: 'the featured row is a pure signal; the referent is the baseline controller' },
        });
        check('R27-5: a signal-wins decision names the BASELINE controller as its model referent (not n/a)',
            decRef.training.model === baselineModel && decRef.training.modelReferent && decRef.training.modelReferent.kind === 'baseline' &&
            decRef.training.labelDistribution && decRef.training.labelDistribution.baseRate === 0.38 &&
            decRef.training.labelDistribution.heldBars.mean === 1 && /EXPLICIT REFERENT/.test(decRef.training.reader),
            JSON.stringify({ referent: decRef.training.modelReferent, baseRate: decRef.training.labelDistribution && decRef.training.labelDistribution.baseRate }));
        check('R27-5: without a referent a pure-signal decision still states the absence of a model (no fabricated referent)',
            decisionReport({ candidate: { id: 'sig:x', promote: false, reasons: [], model: null } }).training.model.available === false &&
            decisionReport({ candidate: { id: 'sig:x', promote: false, reasons: [], model: null } }).training.modelReferent === null);

        // (f) the formatter.
        const line = formatDecision(dec);
        check('R26-8: formatDecision names the verdict, the concentration readout and the next-run knobs',
            /decision: keep-off/.test(line) && /concentration:/.test(line) && /nextRun:/.test(line),
            line);
        check('R26-8: formatDecision renders an unavailable decision instead of throwing',
            formatDecision(null) === 'decision: unavailable');
    } catch (e) {
        check('R26-8 decision checks completed', false, e.stack);
    }

    // ---- AL. R26-9: the correlated-fold null (why the scored path replays) ------
    // The method decision recorded in `docs/METHOD.md`: the scored walk-forward
    // keeps the per-fold full replay, because a warm per-stream snapshot would make
    // the fold outcomes share one fitted state and the cluster inference reads the
    // fold windows as the sample's independent unit. This fixture measures the
    // consequence directly: under the null (no edge) the exact sign test over C
    // windows is calibrated at ~alpha only when the windows are independent; a
    // positive common component inflates its size.
    try {
        const lcg = (seed) => {
            let s = seed >>> 0;
            return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        };
        const rand = lcg(12345);
        const normal = () => {
            let u = 0;
            while (u === 0) u = rand();
            const v = rand();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        };
        const C = 40;
        const reps = 400;
        const rate = (rho) => {
            let rej = 0;
            for (let r = 0; r < reps; r++) {
                const common = normal();
                let wins = 0;
                for (let i = 0; i < C; i++) {
                    const x = Math.sqrt(rho) * common + Math.sqrt(1 - rho) * normal();
                    if (x > 0) wins += 1;
                }
                if (signTest({ wins, n: C, alpha: 0.05 }).significant) rej += 1;
            }
            return rej / reps;
        };
        const fresh = rate(0);
        const rho25 = rate(0.25);
        const rho50 = rate(0.5);
        check('R26-9: independent fold windows keep the exact sign test at ~alpha under the null',
            fresh >= 0.01 && fresh <= 0.10, String(fresh));
        check('R26-9: a positive common fold component (the warm-snapshot regime) inflates the sign test size',
            rho50 > fresh + 0.15 && rho25 > fresh + 0.10 && rho50 >= rho25,
            JSON.stringify({ fresh, rho25, rho50 }));
        check('R26-9: the correlated-fold null variance is the equicorrelation design effect 1+(C-1)rho',
            Math.abs(equicorrelationDesignEffect(C, 0.25) - (1 + (C - 1) * 0.25)) < 1e-12 &&
            Math.abs(equicorrelationDesignEffect(C, 0.5) - (1 + (C - 1) * 0.5)) < 1e-12);
    } catch (e) {
        check('R26-9 method checks completed', false, e.stack);
    }

    // ---- AM. R26-15: the successive-halving engine (gated; engine only) ---------
    // R26-15 is gated on an economics/diversity win and the shipped driver has no
    // `--race` flag. The engine is built and validated anyway, so the gate can be
    // revisited cheaply and the correctness requirement is a test: a racing budget
    // must not change the DECIDED set versus scoring every arm at the top budget.
    try {
        const mkArms = () => [
            { id: 'a', q: 3.0 }, { id: 'b', q: 2.6 }, { id: 'c', q: 2.2 },
            { id: 'd', q: 1.8 }, { id: 'e', q: 1.4 }, { id: 'f', q: 1.0 },
            { id: 'g', q: 0.6 }, { id: 'h', q: 0.2 }, { id: 'i', q: -0.2 },
        ];
        // More budget => less noise (the SHA premise), deterministic.
        const evaluate = (arm, budget) => arm.q + (arm.q > 0 ? 0.05 : -0.05) / budget;

        check('R26-15: halvingRounds is exact for eta = 3 and eta = 2',
            halvingRounds({ maxBudget: 9, minBudget: 1, eta: 3 }) === 3 &&
            halvingRounds({ maxBudget: 9, minBudget: 1, eta: 2 }) === 4);
        const sched = halvingSchedule({ arms: mkArms(), maxBudget: 9, eta: 3 });
        check('R26-15: halvingSchedule eliminates 1/eta per rung on an exact schedule',
            sched.length === 2 &&
            sched[0].budget === 1 && sched[0].arms === 9 && sched[0].keep === 3 &&
            sched[1].budget === 3 && sched[1].arms === 3 && sched[1].keep === 1,
            JSON.stringify(sched));

        const race = await successiveHalving({ arms: mkArms(), evaluate, maxBudget: 9, eta: 3 });
        check('R26-15: the race keeps the true best arm and spends less budget than a full grid',
            race.available && race.winnerId === 'a' &&
            race.evaluated === 12 && race.spentBudget === 18 && race.gridBudget === 81 &&
            race.spentBudget < race.gridBudget,
            JSON.stringify({ w: race.winnerId, ev: race.evaluated, sb: race.spentBudget, gb: race.gridBudget }));
        check('R26-15: the first rung scores every arm and keeps exactly the top third',
            race.rounds[0].scored.length === 9 && race.rounds[0].survivorIds.join(',') === 'a,b,c' &&
            race.rounds[0].lostIds.length === 6);
        const oracle = mkArms().map((arm) => ({ arm, v: evaluate(arm, 9) })).sort((x, y) => y.v - x.v)[0].arm.id;
        check('R26-15: the race winner agrees with the full-grid oracle (a budget must not change the decided set)',
            race.winnerId === oracle, JSON.stringify({ race: race.winnerId, oracle }));
        const nonFinite = await successiveHalving({
            arms: mkArms(), maxBudget: 9, eta: 3,
            evaluate: (arm, budget) => (arm.id === 'a' ? NaN : evaluate(arm, budget)),
        });
        check('R26-15: a non-finite evaluation is eliminated, never silently ranked',
            nonFinite.available && nonFinite.winnerId === 'b' && nonFinite.rounds[0].nonFinite.includes('a'),
            JSON.stringify({ w: nonFinite.winnerId, nf: nonFinite.rounds[0].nonFinite }));

        const minrace = await successiveHalving({ arms: mkArms(), evaluate: (arm) => arm.q, maxBudget: 9, eta: 3, maximize: false });
        check('R26-15: maximize=false selects the lowest score (a cost-minimising race)',
            minrace.winnerId === 'i' && minrace.rounds[0].survivorIds.join(',') === 'i,h,g');
        check('R26-15: the engine refuses an empty arm list, a missing evaluator and a bad budget',
            (await successiveHalving({ arms: [], evaluate })).available === false &&
            (await successiveHalving({ arms: mkArms(), maxBudget: 9 })).available === false &&
            (await successiveHalving({ arms: mkArms(), evaluate, maxBudget: NaN })).available === false);
        check('R26-15: formatRace names the winner, the rungs and the evaluations spent',
            formatRace(race) === 'race: winner=a rungs=1x9 -> 3x3 evals=12/9 arms', formatRace(race));
    } catch (e) {
        check('R26-15 race checks completed', false, e.stack);
    }

    // ---- AM. R28: the sizing block's two scales, the reporting gate and the
    // knife-edge margins ---------------------------------------------------------
    // BUGS.md #55/#56/#57/#58. The round-27 reports said several true things in a
    // mixed vocabulary: a PAIRED Sharpe difference was sized with a SINGLE-SERIES
    // standard error and the TWO-SIDED normal constant while the test runs
    // ONE-SIDED; the raw fold-majority hurdle was an always-on reason over 288
    // CORRELATED folds although `DESIGN.md` §6.1 had already made it a statistic;
    // and a 0.00124 miss was invisible because only a message string carried it.
    try {
        // (a) the exact one-sided t quantile the paired test references, and its
        // inverse. `pairedClusterTest.significant` is `pOneSided <= alpha`.
        check('R28: studentTCritical is the exact one-sided t quantile on the frozen vector',
            close(studentTCritical(35, { alpha: 0.05, twoSided: false }), 1.6895724577805789, 1e-12) &&
            close(studentTCritical(39, { alpha: 0.05, twoSided: false }), 1.684875121708087, 1e-12) &&
            close(studentTCritical(9, { alpha: 0.05, twoSided: false }), 1.833112932656209, 1e-12),
            JSON.stringify([studentTCritical(35, { alpha: 0.05, twoSided: false }), studentTCritical(9, { alpha: 0.05, twoSided: false })]));
        check('R28: studentTCritical inverts studentTPValue (one- and two-sided)',
            close(studentTPValue(studentTCritical(35, { alpha: 0.05, twoSided: false }), 35, { twoSided: false }), 0.05, 1e-9) &&
            close(studentTPValue(studentTCritical(35, { alpha: 0.05, twoSided: true }), 35, { twoSided: true }), 0.05, 1e-9) &&
            close(studentTPValue(studentTCritical(11, { alpha: 0.10, twoSided: false }), 11, { twoSided: false }), 0.10, 1e-9));
        check('R28: the two-sided critical value is the one-sided value at alpha/2 (a >19% difference at df=35)',
            close(studentTCritical(35, { alpha: 0.05, twoSided: true }), studentTCritical(35, { alpha: 0.025, twoSided: false }), 1e-12) &&
            studentTCritical(35, { alpha: 0.05, twoSided: true }) / studentTCritical(35, { alpha: 0.05, twoSided: false }) > 1.19,
            JSON.stringify([studentTCritical(35, { alpha: 0.05, twoSided: false }), studentTCritical(35, { alpha: 0.05, twoSided: true })]));
        check('R28: studentTCritical converges to the normal quantile as df grows (and is monotone in df)',
            Math.abs(studentTCritical(1e9, { alpha: 0.05, twoSided: false }) - normalInvCdf(0.95)) < 1e-5 &&
            studentTCritical(9, { alpha: 0.05, twoSided: false }) > studentTCritical(35, { alpha: 0.05, twoSided: false }) &&
            studentTCritical(35, { alpha: 0.05, twoSided: false }) > studentTCritical(1e9, { alpha: 0.05, twoSided: false }),
            JSON.stringify({ t9: studentTCritical(9, { alpha: 0.05, twoSided: false }), inf: studentTCritical(1e9, { alpha: 0.05, twoSided: false }), z: normalInvCdf(0.95) }));
        check('R28: studentTCritical is NaN for a non-positive / non-finite df (never a fabricated finite value)',
            Number.isNaN(studentTCritical(0, { alpha: 0.05 })) && Number.isNaN(studentTCritical(NaN, { alpha: 0.05 })) &&
            Number.isNaN(studentTCritical(Infinity, { alpha: 0.05 })) && Number.isNaN(studentTCritical(5, { alpha: 1.5 })) &&
            // ...and the consumers turn that into an explicit `null`, not a NaN in
            // the report (`pairedUnitsNeeded` / `cheapestFlip`).
            nextRunPlan({
                dependence: { seCluster: 0.1, nClusters: 10 },
                candidate: { id: 'c', promote: false, reasons: ['r'], gate: { requireSharpeDiff: 'applied' },
                    promotionTest: { available: true, sharpeDifference: { value: 0.1, se: 0.1, nClusters: 10 } } },
            }).pairedUnits.neededForObserved !== null,
            JSON.stringify([studentTCritical(0, { alpha: 0.05 }), studentTCritical(Infinity, { alpha: 0.05 }), studentTCritical(5, { alpha: 1.5 })]));

        // (b) the round-27 Step-2 shape, which is the defect's own evidence
        // (`RUN-ANALYSIS.md` §13.3): pooled seCluster 0.54654, paired se 0.13554,
        // 36 clusters, paired difference 0.21640. The corrected reading is a
        // factor of 1.058 (not 4.95) and 41 clusters (not 55).
        const step2 = nextRunPlan({
            dependence: { seCluster: 0.54654, designEffect: 5.12, effectiveBars: 4000, nClusters: 36 },
            candidate: {
                id: 'label:conservative', promote: false, reasons: ['pooled DSR (dependence-adjusted) 0.25213 < 0.95'],
                gate: { requireSharpeDiff: 'applied' },
                promotionTest: { available: true, alpha: 0.05, sharpeDifference: { value: 0.21640, se: 0.13554, nClusters: 36, df: 35 } },
                pooledMetrics: { breakEvenCostBps: 2.24 },
            },
            levels: [0, 2, 5, 10], periodsPerYear: 252,
        });
        check('R28 (BUGS.md #56): the magnitude cheapest-flip reads the PAIRED SE and the ONE-SIDED cluster-t (factor 1.058, not 4.95)',
            step2.cheapestFlip.available && step2.cheapestFlip.kind === 'magnitude' &&
            step2.cheapestFlip.scale === 'paired' && step2.cheapestFlip.se === 0.13554 && step2.cheapestFlip.df === 35 &&
            close(step2.cheapestFlip.requiredSharpeDifference, studentTCritical(35, { alpha: 0.05, twoSided: false }) * 0.13554, 1e-12) &&
            close(step2.cheapestFlip.factor, 1.0582470005895548, 1e-9) &&
            // The old artefact: the two-sided constant x the SINGLE-SERIES se, read as
            // a paired requirement. It is ~4.7x the honest factor.
            (() => { const oldFactor = (1.959964 * 0.54654) / 0.21640; return oldFactor > 4.9 && oldFactor < 5.0 && oldFactor / step2.cheapestFlip.factor > 4.5; })(),
            JSON.stringify(step2.cheapestFlip));
        check('R28 (BUGS.md #56): pairedUnits sizes the requirement with the one-sided cluster-t — 41 clusters, not the two-sided 55',
            step2.pairedUnits.seScale === 'paired' && step2.pairedUnits.side === 'one-sided' &&
            step2.pairedUnits.se === 0.13554 && step2.pairedUnits.nClusters === 36 &&
            step2.pairedUnits.reference.kind === 'student-t' && step2.pairedUnits.reference.df === 35 &&
            step2.pairedUnits.neededForObserved === 41 && step2.pairedUnits.needed.observed === 41 &&
            step2.pairedUnits.neededForObservedPower80 === 89,
            JSON.stringify(step2.pairedUnits));
        check('R28: the paired requirement is the smallest n whose resolvable difference reaches the target (its predecessor does not)',
            (() => {
                const resolvable = (n) => studentTCritical(n - 1, { alpha: 0.05, twoSided: false }) * 0.13554 * Math.sqrt(36 / n);
                return resolvable(41) <= 0.21640 && resolvable(40) > 0.21640 && resolvable(41) < resolvable(30);
            })());
        // The two scales really are separable: a 5x larger SINGLE-SERIES SE must not
        // move the paired factor by 5x (the old code could not tell them apart).
        const sep = nextRunPlan({
            dependence: { seCluster: 0.5 },
            candidate: {
                id: 'c', promote: false, reasons: ['r'], gate: { requireSharpeDiff: 'applied' },
                promotionTest: { available: true, sharpeDifference: { value: 0.1, se: 0.1, nClusters: 25 } },
                pooledMetrics: { breakEvenCostBps: 5 },
            },
            levels: [0, 2, 5, 10],
        });
        check('R28 (BUGS.md #56): a 5x larger single-series SE does not move the paired factor (the scales are distinct quantities)',
            sep.cheapestFlip.se === 0.1 && sep.cheapestFlip.scale === 'paired' &&
            close(sep.cheapestFlip.factor, studentTCritical(24, { alpha: 0.05, twoSided: false }) * 0.1 / 0.1, 1e-12) &&
            // The old reading would have reported 1.959964 x 0.5 / 0.1 = 9.80, i.e.
            // 5.7x the honest factor.
            sep.cheapestFlip.factor < (1.959964 * 0.5 / 0.1) / 5,
            JSON.stringify(sep.cheapestFlip));

        // (c) the raw fold-majority hurdle: reported, not gated. The fixture's
        // candidate LOSES the raw fold majority and WINS every error-controlled
        // fold-window cluster — the exact round-27 pattern (`label:conservative`
        // 0.20139 raw vs 0.500 cluster; `sig:momentum` 0.49306 raw vs 0.52778).
        //
        // 3 streams x 6 windows x 4 bars. Streams 0-1 are baseline-favourable folds
        // (the candidate loses them); stream 2 is heavily negative for the baseline
        // and mildly positive for the candidate, so every 12-bar WINDOW favours the
        // candidate while only a third of the 18 FOLDS do.
        const p1eMus = { b: [0.004, 0.004, -0.02], c: [-0.001, -0.001, 0.01] };
        const p1eSeries = (which) => p1eMus[which].map((mu, s) =>
            Array.from({ length: 24 }, (_, i) => mu + 0.002 * Math.sin(i * 1.7 + s * 2.3)));
        const p1eBasePanel = p1eSeries('b');
        const p1eCandPanel = p1eSeries('c');
        const p1eFolds = (panel) => {
            const out = [];
            for (let w = 0; w < 6; w++) {
                for (let s = 0; s < 3; s++) out.push(panel[s].slice(w * 4, w * 4 + 4));
            }
            return out;
        };
        const p1eFoldMetrics = (panel) => p1eFolds(panel).map((r) => ({ metrics: backtestMetrics({ returns: r, signals: r.map(() => 1), costBps: 0 }) }));
        const p1eReport = (panel, { dsr, mean, posFrac }) => ({
            aggregate: { mean, positiveFraction: posFrac },
            pooledMetrics: { dsr, dsrAdjusted: dsr, effectiveBars: 4000 },
            folds: p1eFoldMetrics(panel),
            audit: { clean: true, violations: [] },
            streamReturns: panel,
            dependence: { available: true, foldLength: 4 },
        });
        const p1eB = p1eReport(p1eBasePanel, { dsr: 0.95, mean: 1, posFrac: 0.5 });
        const p1eC = p1eReport(p1eCandPanel, { dsr: 0.99, mean: 2, posFrac: 0.9 });
        const p1eOpts = { requireCleanAudit: true, requireSharpeDiff: true, requireBreadth: true, alpha: 0.05 };
        const p1eOn = promoteDecision(p1eB, p1eC, { ...p1eOpts, rawFoldHurdles: true });
        const p1eOff = promoteDecision(p1eB, p1eC, { ...p1eOpts, rawFoldHurdles: false });
        const p1eWinH = p1eOff.hurdles.find((h) => h.hurdle === 'foldWinFraction');
        check('R28 (BUGS.md #57): the raw fold majority is REPORTED in both modes and gates only when rawFoldHurdles is on',
            close(p1eOn.foldWinFraction, 1 / 3, 1e-12) && p1eOn.foldWinFraction === p1eOff.foldWinFraction &&
            p1eOn.promote === false && p1eOn.reasons.some((r) => /fold win fraction/.test(r)) &&
            p1eWinH && p1eWinH.value === p1eOn.foldWinFraction &&
            // It IS below its line (a real 1/3 vs 1/2) and would have gated; with the
            // raw hurdles off it is recorded as `failed` but NOT `gated`.
            p1eWinH.failed === true && p1eWinH.gated === false,
            JSON.stringify({ on: p1eOn.reasons, win: p1eOn.foldWinFraction, h: p1eWinH }));
        check('R28 (BUGS.md #57): with the raw hurdle off the error-controlled tests decide — and they ENDORSE a candidate the raw majority would have blocked',
            p1eOff.promote === true && p1eOff.reasons.length === 0 &&
            p1eOff.promotionTest.breadth.significant === true && p1eOff.promotionTest.breadth.wins === 6 &&
            p1eOff.promotionTest.sharpeDifference.significant === true &&
            p1eOn.promote === false && p1eOn.reasons.length === 1,
            JSON.stringify({ off: p1eOff.reasons, breadth: p1eOff.promotionTest.breadth, sd: p1eOff.promotionTest.sharpeDifference }));
        check('R28 (BUGS.md #57): a non-gated statistic keeps its own margin but can never be the tightest hurdle',
            p1eWinH.gated === false && p1eWinH.margin != null && p1eWinH.margin < 0 &&
            p1eOff.tightestHurdle != null && p1eOff.tightestHurdle.hurdle !== 'foldWinFraction' &&
            p1eOn.tightestHurdle.hurdle === 'foldWinFraction',
            JSON.stringify({ off: p1eOff.tightestHurdle, on: p1eOn.tightestHurdle }));
        check('R28 (BUGS.md #57): the shipped gate uses the error-controlled form (a positive/negative-fold statistic is never a hurdle)',
            p1eOff.hurdles.filter((h) => h.gated === false).map((h) => h.hurdle).sort().join(',') === 'foldWinFraction,positiveFoldFraction');

        // (d) the knife-edge margin (`sig:momentum`'s 0.9487614 vs the 0.95 floor).
        const knifeBase = {
            aggregate: { mean: 1, positiveFraction: 0.5 },
            pooledMetrics: { dsr: 0.95 },
            folds: [{ metrics: { netSharpe: 1 } }],
            audit: { clean: true, violations: [] },
        };
        const knifeCand = {
            aggregate: { mean: 2, positiveFraction: 0.9 },
            pooledMetrics: { dsr: 0.95, dsrAdjusted: 0.9487614, effectiveBars: 4000 },
            folds: [{ metrics: { netSharpe: 2 } }],
            audit: { clean: true, violations: [] },
        };
        const knife = promoteDecision(knifeBase, knifeCand, { rawFoldHurdles: false, minDsrAdjusted: 0.95 });
        check('R28 (BUGS.md #55): a knife-edge miss is a recorded margin, not just a rounded message string',
            knife.promote === false && knife.reasons.length === 1 &&
            knife.tightestHurdle.hurdle === 'minDsrAdjusted' && knife.tightestHurdle.failed === true &&
            close(knife.tightestHurdle.margin, -0.0012385999999999786, 1e-15) &&
            close(knife.tightestHurdle.value, 0.9487614, 1e-12) && knife.tightestHurdle.threshold === 0.95,
            JSON.stringify(knife.tightestHurdle));
        check('R28 (BUGS.md #55): every evaluated hurdle carries value/threshold/direction/margin/gated',
            knife.hurdles.length >= 5 &&
            knife.hurdles.every((h) => typeof h.hurdle === 'string' && 'value' in h && 'threshold' in h &&
                'margin' in h && typeof h.direction === 'string' && typeof h.failed === 'boolean' && typeof h.gated === 'boolean') &&
            knife.hurdles.find((h) => h.hurdle === 'minDsrAdjusted').margin < 0 &&
            knife.hurdles.filter((h) => h.failed).length === 1,
            JSON.stringify(knife.hurdles.map((h) => [h.hurdle, h.margin, h.failed, h.gated])));
        check('R28 (BUGS.md #55): the tightest hurdle is the closest one on the side that decided the verdict',
            (() => {
                const passed = promoteDecision(knifeBase, knifeCand, { rawFoldHurdles: false, minDsrAdjusted: 0.90 });
                return passed.promote === true && passed.tightestHurdle != null &&
                    passed.tightestHurdle.gated === true && passed.tightestHurdle.failed === false &&
                    Math.abs(passed.tightestHurdle.margin) === Math.min(...passed.hurdles.filter((h) => h.gated).map((h) => Math.abs(h.margin)));
            })());

        // (e) the composer + formatter surface the margins and the referent policy
        // (BUGS.md #55: the old `labelPolicy` named the RUN flag while sitting beside
        // a `label:conservative` row, so the report said `optimistic` about a
        // conservative model).
        const decKnife = decisionReport({
            candidate: { id: 'sig:momentum', promote: false, reasons: knife.reasons, hurdles: knife.hurdles, tightestHurdle: knife.tightestHurdle },
            runMeta: { labelPolicy: 'conservative', runLabelPolicy: 'optimistic' },
        });
        check('R28 (BUGS.md #55): decisionReport carries BOTH the referent policy and the run flag, and the hurdle ledger by reference',
            decKnife.training.labelPolicy === 'conservative' && decKnife.training.runLabelPolicy === 'optimistic' &&
            decKnife.verdict.hurdles === knife.hurdles && decKnife.verdict.tightestHurdle === knife.tightestHurdle &&
            /REFERENT model ran under/.test(decKnife.training.reader),
            JSON.stringify(decKnife.training.labelPolicy));
        const knifeLine = formatDecision(decKnife);
        check('R28 (BUGS.md #55): formatDecision prints the tightest hurdle margin and the referent-vs-run label policy',
            /margin: tightest hurdle minDsrAdjusted value=0\.94876 threshold=0\.95000 margin=-0\.0012386/.test(knifeLine) &&
            /label policy: referent=conservative run=optimistic/.test(knifeLine),
            knifeLine);
        check('R28: formatDecision omits the run flag when it equals the referent (no redundant echo)',
            /label policy: referent=optimistic\n/.test(formatDecision(decisionReport({ candidate: { id: 'x', promote: false, reasons: [] }, runMeta: { labelPolicy: 'optimistic', runLabelPolicy: 'optimistic' } }))) &&
            !/run=optimistic/.test(formatDecision(decisionReport({ candidate: { id: 'x', promote: false, reasons: [] }, runMeta: { labelPolicy: 'optimistic', runLabelPolicy: 'optimistic' } }))));
        check('R28: the sizing reader states the two scales and the report carries them explicitly',
            step2.scales && Array.isArray(step2.scales.singleSeries) && Array.isArray(step2.scales.paired) &&
            step2.scales.paired.includes('pairedUnits.se') && step2.scales.paired.includes('cheapestFlip.requiredSharpeDifference') &&
            step2.scales.singleSeries.includes('mde95') && /not interchangeable|differ by the design effect/.test(step2.scales.note) &&
            /Read `scales` before comparing/.test(step2.reader));
    } catch (e) {
        check('R28 reporting checks completed', false, e && e.stack ? e.stack : String(e));
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
