// Walk-forward *integration* suite — the harness on real shipped candles.
//
// `analysis.test.js` section S proves the walk-forward algebra on synthetic data.
// This entry proves the end-to-end claim the research note makes: a *live*
// HiveMind, re-fit from scratch on each fold's training slice and then frozen,
// can be evaluated out-of-sample over a real symbol, with
//
//   - a clean no-lookahead audit (the model's test positions do not move when
//     every future return is perturbed), and
//   - the audit *catching* a feature that peeks at t+1, so the clean result is
//     evidence rather than a vacuous pass.
//
// It also anchors the harness against a closed form: an always-long signal with
// zero costs must reproduce the per-fold buy-and-hold equity exactly.
//
// This is the instrument that later promotes the default-off features (surprise
// gate, uniqueness weights, homeostasis, multi-probe) from flag to on-by-default:
// `walkForwardEvaluate` + `promoteDecision` applied to the same candles.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import { walkForwardSplit } from '../../../src/analysis/splits.js';
import { walkForwardEvaluate, promoteDecision, walkForwardSearch, formatReport, auditNoLookahead, sharpeStandardError, minimumDetectableSharpe, barsToDetect, poolReports, dependenceSummary, clustersOf, pairedPromotionTest, restateReportAtCost, costLadder, familyCorrelation, DEPENDENCE_GATE_READER } from '../../../src/analysis/walkforward.js';
import { makeCandleViewFor, shockCandles, shockFactor, worldFromCandles, DEFAULT_SHOCK } from '../../../src/analysis/world.js';
import { CANDLE_MANIFEST } from '../../../src/candles_audit.js';

const FEATURE_LEN = 12;
const STATE_DIR = 'state/walkforward';
const PROJECT_ROOT = import.meta.dirname
    ? import.meta.dirname.replace(/[\\/]test[\\/]browser[\\/]entries$/, '')
    : '';
const CANDLE_FILE = `${PROJECT_ROOT}/${CANDLE_MANIFEST.find((e) => e.symbol === 'ADAUSDT').file}`;
const COST_BPS = 5;

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A causal feature vector: a trailing window of past returns plus the current
// bar's sign. With `leaky` the last slot is filled from returns[t+1] instead —
// the classic accidental lookahead the audit must catch.
function featureVector(returns, t, { leaky = false } = {}) {
    const f = new Array(FEATURE_LEN).fill(0);
    for (let k = 0; k < FEATURE_LEN - 2; k++) {
        const idx = t - 1 - k;
        f[k] = idx >= 0 ? returns[idx] * 100 : 0;
    }
    f[FEATURE_LEN - 2] = Math.sign(returns[t] ?? 0);
    f[FEATURE_LEN - 1] = leaky ? (returns[t + 1] ?? 0) * 1000 : 0;
    return f;
}

// One model adapter = a fresh HiveMind per fold. HiveMind persists to SQLite
let fitCounter = 0;
let stateDirFor = (label) => `${STATE_DIR}/${label}`;

// The core uses `Math.random()` for initialisation and for LSH candidate
// probing, so — exactly like golden.test.js / sanity.test.js — every core call
// is wrapped in a seeded PRNG. The seed is derived from the *fold*
// (`test[0]`), not a call counter, so re-running a fold (as the lookahead audit
// does) reproduces the identical model: then the only difference between a
// clean and a flagged run is the perturbed data itself.
function withSeed(seed, fn) {
    const real = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = real; }
}

function makeModel({ id = 'WF', leaky = false, shuffleLabels = false, seed = 1, configure = null } = {}) {
    let hm = null;
    let predictSeed = 0;
    const shuffleRng = mulberry32((seed * 2654435761) >>> 0);
    return {
        fit(train, test, returns) {
            const testStart = Math.min(...test);
            const foldSeed = (seed * 131 + testStart) >>> 0;
            // A unique directory per fit, so no fit resumes another's state.
            const dir = `${stateDirFor(id)}-${fitCounter++}`;
            const bars = train.filter((t) => t + 1 < testStart);
            const labels = bars.map((t) => ((returns[t + 1] ?? 0) > 0 ? 1 : 0));
            if (shuffleLabels) {
                for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(shuffleRng() * (i + 1)); const tmp = labels[i]; labels[i] = labels[j]; labels[j] = tmp; }
            }
            withSeed(foldSeed, () => {
                hm = new HiveMind(dir, 3, FEATURE_LEN, id, true);
                if (configure) configure(hm);
                for (let i = 0; i < bars.length; i++) hm.train(featureVector(returns, bars[i], { leaky }), labels[i]);
            });
            predictSeed = (foldSeed + 7777) >>> 0;
        },
        predict(test, returns) {
            return withSeed(predictSeed, () => test.map((t) => (hm.predict(featureVector(returns, t, { leaky })) - 0.5) * 2));
        },
    };
}

function signalForModel(model) {
    return (train, test, view) => { model.fit(train, test, view.returns); return model.predict(test, view.returns); };
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    stateDirFor = options.stateDir || ((label) => `${STATE_DIR}/${label}`);
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    const readFile = (options && typeof options.readFile === 'function')
        ? options.readFile
        : (globalThis.__fs && typeof globalThis.__fs.readTextFile === 'function' ? (p) => globalThis.__fs.readTextFile(p) : null);
    if (!readFile) { check('candle reader available', false, 'no readFile option and no globalThis.__fs'); return { total: 1, failed: 1, failures: checks, checks }; }

    let text;
    try { text = await readFile(CANDLE_FILE); } catch (e) { check('candle file readable', false, e.message); return { total: 1, failed: 1, failures: checks, checks }; }
    check('candle file readable', typeof text === 'string' && text.length > 1000, `bytes=${text && text.length}`);

    // Parse the raw JSONL (timestamp/ohlcv) and take a deterministic contiguous
    // slice from the middle of the series, so the run is fast and reproducible.
    const rows = text.trim().split('\n');
    const parsed = [];
    for (const line of rows) {
        try { const o = JSON.parse(line); if (o && Number.isFinite(o.close)) parsed.push(o); } catch { /* skip */ }
    }
    const N = 150;
    const start = Math.max(0, Math.floor(parsed.length / 2) - Math.floor(N / 2));
    const closes = parsed.slice(start, start + N).map((c) => c.close);
    check('parsed a usable candle slice', closes.length === N && closes.every((c) => c > 0), `n=${closes.length}`);

    const returns = new Array(N).fill(0);
    for (let t = 1; t < N; t++) returns[t] = closes[t] / closes[t - 1] - 1;
    check('returns are finite and mostly non-zero', returns.every(Number.isFinite) && returns.slice(1).filter((r) => r !== 0).length > N * 0.9);

    const folds = walkForwardSplit({ n: N, trainSize: 90, testSize: 10 });
    check('walk-forward split built for real data', folds.length === 6 && folds.every((f) => f.test.length === 10), `folds=${folds.length}`);

    // ---- A. the live model evaluates out-of-sample with finite stats ----------
    let report = null;
    try {
        report = walkForwardEvaluate({
            returns, folds, signalForFold: signalForModel(makeModel({ id: 'WF-A' })),
            costBps: COST_BPS, trials: 6, audit: false,
        });
        const m = report.pooledMetrics;
        check('real walk-forward report is produced', report.folds.length === 6 && report.pooledBars === 60, `folds=${report.folds.length} bars=${report.pooledBars}`);
        check('real report stats are finite',
            ['netSharpe', 'psr', 'dsr', 'maxDrawdown', 'hitRate', 'finalEquity'].every((k) => Number.isFinite(m[k])),
            JSON.stringify({ sharpe: m.netSharpe, psr: m.psr, dsr: m.dsr, hit: m.hitRate }));
        check('real model traded (per-fold turnover, not the pooled overlay)',
            report.folds.some((f) => f.metrics.turnover > 0) && report.folds.some((f) => f.metrics.tradeCount > 0) &&
            Number.isFinite(report.aggregate.mean),
            `turnover=${report.folds.map((f) => f.metrics.turnover).join(',')}`);
    } catch (e) {
        check('real walk-forward run completed', false, e.stack);
    }

    // ---- B. closed-form anchor: always-long == per-fold buy-and-hold ----------
    try {
        const longReport = walkForwardEvaluate({
            returns, folds, signalForFold: () => folds[0].test.map(() => 1), costBps: 0, trials: 1, audit: false,
        });
        // The pooled series lags one bar per fold, so each fold's first test bar
        // contributes zero; the rest multiply the equity.
        let expected = 1;
        for (const fold of folds) for (let k = 1; k < fold.test.length; k++) expected *= (1 + returns[fold.test[k]]);
        check('always-long reproduces per-fold buy-and-hold exactly',
            Math.abs(longReport.pooledMetrics.finalEquity - expected) <= 1e-12,
            `got=${longReport.pooledMetrics.finalEquity} expected=${expected}`);
    } catch (e) {
        check('buy-and-hold anchor completed', false, e.stack);
    }

    // ---- C. a flat signal is exactly inert -----------------------------------
    try {
        const flat = walkForwardEvaluate({
            returns, folds, signalForFold: (tr, te) => te.map(() => 0), costBps: COST_BPS, trials: 1, audit: false,
        });
        check('flat signal: zero turnover, zero cost, equity 1',
            flat.folds.every((f) => f.metrics.turnover === 0 && f.metrics.tradeCount === 0 && f.metrics.totalCost === 0) &&
            flat.pooledMetrics.finalEquity === 1,
            JSON.stringify({ to: flat.folds.map((f) => f.metrics.turnover), eq: flat.pooledMetrics.finalEquity }));
    } catch (e) {
        check('flat-signal anchor completed', false, e.stack);
    }

    // ---- D. determinism: same seed -> identical report ------------------------
    try {
        const a = walkForwardEvaluate({ returns, folds, signalForFold: signalForModel(makeModel({ id: 'WF-D', seed: 7 })), costBps: COST_BPS, audit: false });
        const b = walkForwardEvaluate({ returns, folds, signalForFold: signalForModel(makeModel({ id: 'WF-D', seed: 7 })), costBps: COST_BPS, audit: false });
        check('walk-forward is deterministic under a fixed seed',
            a.pooledMetrics.netSharpe === b.pooledMetrics.netSharpe && a.pooledMetrics.finalEquity === b.pooledMetrics.finalEquity,
            `${a.pooledMetrics.netSharpe} vs ${b.pooledMetrics.netSharpe}`);
    } catch (e) {
        check('determinism run completed', false, e.stack);
    }

    // ---- E. the audit on the real model: clean, and it catches a leak ---------
    // One fold, five test bars, so the audit is cheap (one refit per probe).
    const auditFolds = walkForwardSplit({ n: N, trainSize: N - 6, testSize: 5 });
    check('audit fold is a single 5-bar test window', auditFolds.length === 1 && auditFolds[0].test.length === 5, `folds=${auditFolds.length}`);
    try {
        const clean = walkForwardEvaluate({
            returns, folds: auditFolds, signalForFold: signalForModel(makeModel({ id: 'WF-E1' })), costBps: 0, audit: true,
        });
        check('the live causal model passes the lookahead audit',
            clean.audit && clean.audit.clean && clean.audit.probes === 5,
            JSON.stringify(clean.audit && clean.audit.violations.slice(0, 2)));

        const leaky = walkForwardEvaluate({
            returns, folds: auditFolds, signalForFold: signalForModel(makeModel({ id: 'WF-E2', leaky: true })), costBps: 0, audit: true,
        });
        check('the audit catches a live model with a t+1 feature',
            leaky.audit && !leaky.audit.clean && leaky.audit.violations.length >= 4,
            `violations=${leaky.audit && leaky.audit.violations.length}`);
    } catch (e) {
        check('audit runs completed', false, e.stack);
    }

    // ---- F. the promotion gate is honest on real reports ----------------------
    try {
        const shuffled = walkForwardEvaluate({ returns, folds, signalForFold: signalForModel(makeModel({ id: 'WF-F1', shuffleLabels: true, seed: 11 })), costBps: COST_BPS, audit: false });
        const decision = promoteDecision(report, shuffled, { requireCleanAudit: false });
        check('promotion decision is well-formed',
            typeof decision.promote === 'boolean' && Array.isArray(decision.reasons) && Number.isFinite(decision.foldWinFraction),
            JSON.stringify({ promote: decision.promote, reasons: decision.reasons.length }));
        // The absolute DSR floor is what keeps noise out: whenever the shuffled
        // control is rejected the decision must name a hurdle, and if it somehow
        // passes it must be on a demonstrated edge (DSR >= 0.95).
        check('the shuffled-label control is not promoted without a demonstrated edge',
            !decision.promote ? decision.reasons.length > 0 : shuffled.pooledMetrics.dsr >= 0.95,
            JSON.stringify({ promote: decision.promote, reasons: decision.reasons, dsr: shuffled.pooledMetrics.dsr }));
    } catch (e) {
        check('promotion-gate run completed', false, e.stack);
    }

    // ---- G. the default-off features run through the A/B harness ------------
    // Each Round-2 feature ships off by default. Its mathematically inert
    // setting (surprise floor=1, homeostasis gain=0) must be bit-identical to
    // off *through the whole walk-forward harness* — not just in the module's own
    // unit test — so a promotion decision changes exactly one thing.
    try {
        const abReturns = returns.slice(0, 90);
        const abFolds = walkForwardSplit({ n: 90, trainSize: 60, testSize: 10 });
        const runAB = (configure) => walkForwardEvaluate({
            returns: abReturns, folds: abFolds, signalForFold: signalForModel(makeModel({ id: 'WF-G', configure })),
            costBps: COST_BPS, audit: false,
        });
        const base = runAB(null);
        const same = (a, b) => a.pooledMetrics.netSharpe === b.pooledMetrics.netSharpe && a.pooledMetrics.finalEquity === b.pooledMetrics.finalEquity;
        const surpriseNoop = runAB((hm) => { hm._surpriseGateEnabled = true; hm._surpriseConfig = { floor: 1 }; });
        const homeoNoop = runAB((hm) => { hm._homeostasisEnabled = true; hm._homeostasisConfig = { gain: 0 }; });
        check('A/B: surprise gate at floor=1 is a bit-identical no-op through the harness',
            same(base, surpriseNoop), `${base.pooledMetrics.finalEquity} vs ${surpriseNoop.pooledMetrics.finalEquity}`);
        check('A/B: homeostasis at gain=0 is a bit-identical no-op through the harness',
            same(base, homeoNoop), `${base.pooledMetrics.finalEquity} vs ${homeoNoop.pooledMetrics.finalEquity}`);
        const surpriseLive = runAB((hm) => { hm._surpriseGateEnabled = true; hm._surpriseConfig = { floor: 0.3, sharpness: 1 }; });
        const homeoLive = runAB((hm) => { hm._homeostasisEnabled = true; hm._homeostasisConfig = { gain: 0.5, target: 1, minScale: 0.5, maxScale: 1.5 }; });
        const multiProbe = runAB((hm) => { hm._multiProbeConfig = { maxFlips: 2, budget: 8 }; });
        check('A/B: feature-on candidates produce finite reports',
            [surpriseLive, homeoLive, multiProbe].every((r) => Number.isFinite(r.pooledMetrics.netSharpe) && r.pooledBars === 30),
            JSON.stringify([surpriseLive, homeoLive, multiProbe].map((r) => r.pooledMetrics.netSharpe)));
        check('A/B: the live settings change the walk-forward trajectory',
            !same(base, surpriseLive) && !same(base, homeoLive),
            JSON.stringify([surpriseLive, homeoLive, multiProbe].map((r) => r.pooledMetrics.finalEquity)));
        // R27-2: multi-probe is a BROADCAST-path flag — `_getGlobalLSHCandidates` is
        // read only by `broadcastMemory`, which the scored predict never consults —
        // so through this harness it must be a bit-identical no-op. That is the
        // "not applicable to the scored model" claim, measured (the taxonomy in
        // analyze.js says the same, and the A/B reports it `not-applicable`).
        check('R27-2: a broadcast-only flag (multi-probe) is bit-identical through the model harness',
            same(base, multiProbe) && multiProbe.pooledBars === base.pooledBars,
            `${base.pooledMetrics.finalEquity} vs ${multiProbe.pooledMetrics.finalEquity}`);
        const decision = promoteDecision(base, multiProbe, { requireCleanAudit: false });
        check('A/B: the promotion gate returns a well-formed decision',
            typeof decision.promote === 'boolean' && Array.isArray(decision.reasons) && Number.isFinite(decision.foldWinFraction));
    } catch (e) {
        check('feature A/B completed', false, e.stack);
    }

    // ---- H. family-wise search correction on the real candles ---------------
    // Item 8 end-to-end: the DSR-floor promotion gate vs the variance-consistent
    // subsampling SPA / Romano-Wolf step-down over the SAME real OOS return
    // streams. The family is [baseline, ...feature candidates, oracle control];
    // the fold lengths go in as `groups` so no resampling window straddles a fold
    // boundary and each fold's no-exposure first bar is trimmed. The oracle (it
    // peeks one bar ahead) is the positive control: a harness that cannot detect
    // a planted edge proves nothing about the real candidates.
    try {
        const hReturns = returns.slice(0, 90);
        const hFolds = walkForwardSplit({ n: 90, trainSize: 60, testSize: 10 });
        const runH = (configure) => walkForwardEvaluate({
            returns: hReturns, folds: hFolds, signalForFold: signalForModel(makeModel({ id: 'WF-H', configure })),
            costBps: COST_BPS, audit: false,
        });
        const hBase = runH(null);
        const hCands = [
            { label: 'surprise', report: runH((hm) => { hm._surpriseGateEnabled = true; hm._surpriseConfig = { floor: 0.3, sharpness: 1 }; }) },
            { label: 'homeostasis', report: runH((hm) => { hm._homeostasisEnabled = true; hm._homeostasisConfig = { gain: 0.5, target: 1, minScale: 0.5, maxScale: 1.5 }; }) },
            { label: 'multiprobe', report: runH((hm) => { hm._multiProbeConfig = { maxFlips: 2, budget: 8 }; }) },
            {
                label: 'oracle(ctrl)',
                report: walkForwardEvaluate({
                    returns: hReturns, folds: hFolds,
                    signalForFold: (tr, te, view) => te.map((i, k) => (k + 1 < te.length ? Math.sign(view.returns[te[k + 1]]) : 0)),
                    costBps: 0, audit: false,
                }),
            },
        ];
        const search = walkForwardSearch({ baseline: hBase, candidates: hCands.map((c) => c.report), labels: hCands.map((c) => c.label), alpha: 0.05 });
        check('real family-wise search runs over the pooled OOS streams, segment-aware (trimmed folds)',
            search.K === 5 && search.T === 27 && search.groups.join('x') === '9x9x9' && search.trimmedFoldStarts === true &&
            search.nWindows === 3 * (9 - search.windowLength + 1),
            JSON.stringify({ K: search.K, T: search.T, b: search.windowLength, m: search.bandwidth, wins: search.nWindows, groups: search.groups }));
        check('real family-wise search reports finite per-candidate statistics and a well-formed rejection set',
            search.candidates.every((c) => Number.isFinite(c.statistic) && Number.isFinite(c.pValue) && c.pValue >= 0 && c.pValue <= 1) &&
            search.candidates[0].isBest === (search.bestIndex === 0) &&
            search.rejectedIndices.length === search.candidates.filter((c) => c.rejected).length);
        const dsrPromotes = hCands.map((c) => promoteDecision(hBase, c.report, { requireCleanAudit: false }).promote);
        const fwRejects = hCands.map((_, i) => search.candidates[i + 1].rejected);
        check('real A/B: the oracle control is caught by BOTH rules, and the real features by neither',
            dsrPromotes[3] === true && fwRejects[3] === true &&
            dsrPromotes.slice(0, 3).every((p) => p === false) && fwRejects.slice(0, 3).every((r) => r === false),
            JSON.stringify({ dsrPromotes, fwRejects, p: search.candidates.map((c) => c.pValue) }));
        check('real A/B: the two rules agree on every candidate (neither promotes on search luck)',
            dsrPromotes.every((p, i) => p === fwRejects[i]),
            JSON.stringify({ dsrPromotes, fwRejects }));
        const hLine = formatReport(hBase, { label: 'wf-h', search });
        check('the real report renders the search-corrected line (SPA p + StepM reject set + window grid)',
            hLine.split('\n').length === 8 && hLine.includes('search: SPA p=') && hLine.includes('StepM rejects=[') && hLine.includes('groups=9x9x9') && hLine.includes('breakEven='),
            hLine.split('\n')[7]);
    } catch (e) {
        check('family-wise A/B completed', false, e.stack);
    }

    // ---- I. the family-wise gate on a LONGER walk-forward (more windows) -----
    // Item 10: section H runs the gate on 90 bars / 3 folds / 18 subsampling
    // windows — correctly sized but weakly powered. This repeats it on the full
    // 150-bar slice with 6 folds of 15 test bars, so the SAME family-wise gate
    // runs over ~48 windows. A wider grid is the power lever the research note
    // asks for; the claim is that the gate stays well-formed and still agrees with
    // the DSR floor (catches the oracle control, promotes no real feature).
    try {
        const iReturns = returns;
        const iFolds = walkForwardSplit({ n: 150, trainSize: 60, testSize: 15 });
        check('longer real walk-forward split built (6 folds of 15 test bars)',
            iFolds.length === 6 && iFolds.every((f) => f.test.length === 15), `folds=${iFolds.length}`);
        const runI = (configure) => walkForwardEvaluate({
            returns: iReturns, folds: iFolds, signalForFold: signalForModel(makeModel({ id: 'WF-I', configure })),
            costBps: COST_BPS, audit: false,
        });
        const iBase = runI(null);
        const iCands = [
            { label: 'surprise', report: runI((hm) => { hm._surpriseGateEnabled = true; hm._surpriseConfig = { floor: 0.3, sharpness: 1 }; }) },
            { label: 'homeostasis', report: runI((hm) => { hm._homeostasisEnabled = true; hm._homeostasisConfig = { gain: 0.5, target: 1, minScale: 0.5, maxScale: 1.5 }; }) },
            { label: 'multiprobe', report: runI((hm) => { hm._multiProbeConfig = { maxFlips: 2, budget: 8 }; }) },
            {
                label: 'oracle(ctrl)',
                report: walkForwardEvaluate({
                    returns: iReturns, folds: iFolds,
                    signalForFold: (tr, te, view) => te.map((i, k) => (k + 1 < te.length ? Math.sign(view.returns[te[k + 1]]) : 0)),
                    costBps: 0, audit: false,
                }),
            },
        ];
        const iSearch = walkForwardSearch({ baseline: iBase, candidates: iCands.map((c) => c.report), labels: iCands.map((c) => c.label), alpha: 0.05 });
        check('longer-grid family-wise search is well-formed over >30 windows (vs section H 18)',
            iSearch.K === 5 && iSearch.groups.join('x') === '14x14x14x14x14x14' && iSearch.trimmedFoldStarts === true &&
            iSearch.nWindows === 6 * (14 - iSearch.windowLength + 1) && iSearch.nWindows > 30,
            JSON.stringify({ K: iSearch.K, T: iSearch.T, b: iSearch.windowLength, m: iSearch.bandwidth, wins: iSearch.nWindows, groups: iSearch.groups }));
        check('longer grid reports finite per-candidate statistics and a well-formed rejection set',
            iSearch.candidates.every((c) => Number.isFinite(c.statistic) && Number.isFinite(c.pValue) && c.pValue >= 0 && c.pValue <= 1) &&
            iSearch.rejectedIndices.length === iSearch.candidates.filter((c) => c.rejected).length);
        const iDsr = iCands.map((c) => promoteDecision(iBase, c.report, { requireCleanAudit: false }).promote);
        const iFw = iCands.map((_, i) => iSearch.candidates[i + 1].rejected);
        check('longer-grid A/B: the oracle control is caught by BOTH rules and no real feature by either',
            iDsr[3] === true && iFw[3] === true && iDsr.slice(0, 3).every((p) => p === false) && iFw.slice(0, 3).every((r) => r === false),
            JSON.stringify({ dsrPromotes: iDsr, fwRejects: iFw, p: iSearch.candidates.map((c) => c.pValue) }));
        check('longer-grid A/B: the two rules still agree on every candidate',
            iDsr.every((p, i) => p === iFw[i]), JSON.stringify({ dsrPromotes: iDsr, fwRejects: iFw }));
        const iLine = formatReport(iBase, { label: 'wf-i', search: iSearch });
        check('longer-grid report renders the search-corrected line', iLine.split('\n').length === 8 && iLine.includes('search: SPA p='), iLine.split('\n')[7]);
    } catch (e) {
        check('longer-grid family-wise A/B completed', false, e.stack);
    }

    // ---- K. audit non-vacuity for a candle-driven model (round 23, N0) -----
    //
    // The regression guard for docs/BUGS.md #22. `auditNoLookahead` perturbs the
    // array the model reads; a model whose features come from candles never reads
    // `view.returns`, so before the fix its audit passed vacuously and a blatant
    // leak survived. The fix is `viewFor`, which lets the caller build the view the
    // model actually consumes from the perturbed series (`analysis/world.js`).
    {
        const kCloses = [];
        let kp = 100;
        for (let i = 0; i < 60; i++) { kp += Math.sin(i / 3) * 0.5 + 0.1; kCloses.push(kp); }
        const kReturns = kCloses.map((c, i) => (i ? (c - kCloses[i - 1]) / kCloses[i - 1] : 0));
        const kFolds = walkForwardSplit({ n: 60, trainSize: 30, testSize: 10 });

        // A blatant leak, expressed over the FIXED candle array (guard the series
        // end so a NaN cannot masquerade as a "position moved" violation).
        const leakOnCandles = (tr, te) => te.map((t) => (t + 1 < kCloses.length ? Math.sign(kCloses[t + 1] - kCloses[t]) : 0));
        // The same leak, but reading the view the audit can reach.
        const leakOnViewCandles = (tr, te, view) => {
            const c = view.closes;
            return te.map((t) => (t + 1 < c.length ? Math.sign(c[t + 1] - c[t]) : 0));
        };
        // An honest, causal candle-driven signal (the last completed bar's sign).
        const causalOnViewCandles = (tr, te, view) => {
            const c = view.closes;
            return te.map((t) => Math.sign(c[t] - c[t - 1]));
        };
        const candles = kCloses.map((close, t) => ({ timestamp: new Date(Date.UTC(2024, 0, 1) + t * 3600000).toISOString(), open: close, high: close, low: close, close, volume: 1 }));
        const viewFor = makeCandleViewFor(candles);

        // (1) The bug, documented: without `viewFor` the candle-driven leak is
        //     invisible to the audit (0 violations) — this is the vacuous pass.
        const vacuousLeak = auditNoLookahead({ signalForFold: leakOnCandles, folds: kFolds, returns: kReturns });
        check('a candle-driven leak is invisible to the returns-only audit (the vacuity this fix removes)',
            vacuousLeak.clean === true && vacuousLeak.violations.length === 0,
            JSON.stringify({ clean: vacuousLeak.clean, v: vacuousLeak.violations.length }));

        // (2) The fix: with the audited candle view the same leak is CAUGHT, and
        //     the perturbation is structurally non-vacuous.
        const caught = auditNoLookahead({ signalForFold: leakOnViewCandles, folds: kFolds, returns: kReturns, viewFor, probe: 0.05 });
        check('the audited candle view catches the same leak (BUGS.md #22 fixed)',
            caught.clean === false && caught.violations.length > 0 && caught.violations.every((v) => Number.isFinite(v.index) && v.index >= 0),
            JSON.stringify({ clean: caught.clean, v: caught.violations.length, first: caught.violations[0] }));
        check('the audited view is structurally non-vacuous (base and perturbed views differ)',
            caught.viewDiffers === true && caught.vacuous === false, JSON.stringify({ viewDiffers: caught.viewDiffers, vacuous: caught.vacuous }));
        check('the perturbation reaches the model (a later position moves)', caught.reachable === true, String(caught.reachable));

        // (3) An honest candle-driven signal is clean on the same view — so the
        //     guard is not merely "everything fails".
        const honest = auditNoLookahead({ signalForFold: causalOnViewCandles, folds: kFolds, returns: kReturns, viewFor, probe: 0.05 });
        check('an honest candle-driven signal passes clean on the audited view',
            honest.clean === true && honest.reachable === true,
            JSON.stringify({ clean: honest.clean, v: honest.violations.length, reachable: honest.reachable }));

        // (4) A view factory that ignores the perturbation is reported VACUOUS
        //     (never clean): the audit refuses to certify what it cannot reach.
        const ignoreView = () => ({ closes: kCloses });
        const uninformed = auditNoLookahead({ signalForFold: causalOnViewCandles, folds: kFolds, returns: kReturns, viewFor: ignoreView, probe: 0.05 });
        check('a view factory that ignores the perturbation is flagged vacuous, not clean',
            uninformed.clean === false && uninformed.vacuous === true && uninformed.viewDiffers === false,
            JSON.stringify({ clean: uninformed.clean, vacuous: uninformed.vacuous, viewDiffers: uninformed.viewDiffers }));

        // (5) `requireReachable` catches a model that does not read the input.
        const unreachable = auditNoLookahead({ signalForFold: (tr, te) => te.map(() => 0), folds: kFolds, returns: kReturns, requireReachable: true });
        check('requireReachable rejects an audit that never reaches the model',
            unreachable.clean === false && unreachable.vacuous === true && unreachable.reachable === false,
            JSON.stringify({ clean: unreachable.clean, vacuous: unreachable.vacuous }));
        check('requireReachable is off by default (a constant signal still audits clean)',
            auditNoLookahead({ signalForFold: (tr, te) => te.map(() => 0), folds: kFolds, returns: kReturns }).clean === true);
        check('a non-finite position is reported with its own reason, not as a leak',
            (() => {
                const r = auditNoLookahead({ signalForFold: (tr, te) => te.map((t) => (t + 2 > 59 ? NaN : 1)), folds: kFolds, returns: kReturns });
                return r.clean === false && r.violations.some((v) => /non-finite/.test(v.reason || ''));
            })());

        // (6) Sampling: probing a subset of decision points still catches a leak
        //     that manifests at every bar, and reports the reduced probe count.
        const sampled = auditNoLookahead({ signalForFold: leakOnViewCandles, folds: kFolds, returns: kReturns, viewFor, probe: 0.05, auditProbesPerFold: 2 });
        check('a sampled audit catches the same leak with fewer probes',
            sampled.clean === false && sampled.probes > 0 && sampled.probes < caught.probes,
            JSON.stringify({ sampled: sampled.probes, full: caught.probes, clean: sampled.clean }));

        // (7) The viewFor path flows through walkForwardEvaluate, and the report
        //     carries the power readout (round 23, N2).
        const wf = walkForwardEvaluate({ returns: kReturns, folds: kFolds, signalForFold: leakOnViewCandles, viewFor, probe: 0.05, audit: true, costBps: 0 });
        check('walkForwardEvaluate forwards viewFor to the audit',
            wf.audit.clean === false && wf.probed === true, JSON.stringify({ clean: wf.audit.clean, probed: wf.probed }));
        check('every report carries the Sharpe power readout',
            Number.isFinite(wf.power.se) && Number.isFinite(wf.power.mdeSharpe) && wf.power.bars === wf.pooledBars,
            JSON.stringify(wf.power));
        check('sharpeStandardError/minimumDetectableSharpe match the closed form sqrt((P + SR^2/2)/T)',
            (() => {
                const sr = 1.5, bars = 400, p = 252;
                const expect = Math.sqrt((p + 0.5 * sr * sr) / bars);
                return Math.abs(sharpeStandardError(sr, bars, p) - expect) < 1e-15 &&
                    Math.abs(minimumDetectableSharpe(sr, bars, p) - 1.959964 * expect) < 1e-12 &&
                    !Number.isFinite(sharpeStandardError(NaN, bars, p)) && !Number.isFinite(sharpeStandardError(sr, 0, p));
            })());
        // (7b) Round 24b: the sample-size guidance and the underpowered flag.
        check('barsToDetect is ceil(P*(z/SR)^2) and powerSummary carries the underpowered flag',
            (() => {
                const z = 1.959964;
                return barsToDetect(1, 252) === Math.ceil(252 * z * z) &&
                    barsToDetect(2, 252) === Math.ceil(252 * (z / 2) ** 2) &&
                    Math.abs(barsToDetect(1, 252) - 969) <= 1 &&
                    Number.isNaN(barsToDetect(0)) && Number.isNaN(barsToDetect(-1)) && Number.isNaN(barsToDetect(1, 0)) &&
                    typeof wf.power.underpowered === 'boolean' &&
                    wf.power.underpowered === (wf.power.mdeSharpe > 1) &&
                    wf.power.barsToDetect1 === barsToDetect(1, 252);
            })(), JSON.stringify({ barsToDetect1: wf.power.barsToDetect1, underpowered: wf.power.underpowered }));

        // (8) The world's shock is bounded, deterministic and non-uniform (causal
        //     by construction), and worldFromCandles keeps the most recent bars.
        check('the shock is 1 at and before the probe point, bounded above, and non-uniform',
            shockFactor(10, { after: 10, probe: 0.05 }) === 1 &&
            shockFactor(0, { after: 10, probe: 0.05 }) === 1 &&
            (() => {
                const fs = [];
                for (let t = 11; t < 80; t++) fs.push(shockFactor(t, { after: 10, probe: 0.05 }));
                return fs.every((x) => x >= 1 && x <= 1 + 2 * 0.05 + 1e-12) && new Set(fs.map((x) => x.toFixed(6))).size > 10;
            })());
        check('the shock is deterministic and never mutates its input',
            (() => {
                const bars = candles.slice();
                const a = shockCandles(bars, { after: 20, probe: 0.05 });
                const b = shockCandles(bars, { after: 20, probe: 0.05 });
                return JSON.stringify(a) === JSON.stringify(b) && bars[30].close === candles[30].close && a[30].close !== bars[30].close && a[20].close === bars[20].close;
            })());
        check('worldFromCandles returns aligned closes/returns and honours maxBars',
            (() => {
                const w = worldFromCandles(candles, { maxBars: 20 });
                return w.candles.length === 20 && w.closes.length === 20 && w.returns.length === 20 &&
                    w.returns[1] === kCloses[41] / kCloses[40] - 1 && DEFAULT_SHOCK.probe === 0.05;
            })());

        const wfHonest = walkForwardEvaluate({ returns: kReturns, folds: kFolds, signalForFold: causalOnViewCandles, viewFor, probe: 0.05, audit: true, costBps: 0 });
        check('the honest candle signal is clean end-to-end and its report renders clean with its reachability',
            wfHonest.audit.clean === true &&
            formatReport(wfHonest, { label: 'wf-k' }).includes('audit:  clean reachable=') &&
            formatReport(wfHonest, { label: 'wf-k' }).includes(`reachable=${wfHonest.audit.reachableFolds}/${wfHonest.folds.length}`),
            formatReport(wfHonest, { label: 'wf-k' }).split('\n').find((l) => l.includes('audit:')));

        // ---- (9) Round 25: dependence-aware reports, the cost ladder, the family
        //     diagnostic. Synthetic streams (no model), so this stays cheap.
        {
            const q25 = 10;
            const nFolds25 = 6;
            const n25 = 30 + nFolds25 * q25;
            const folds25 = walkForwardSplit({ n: n25, trainSize: 30, testSize: q25 });
            // A SHARED common factor plus per-stream noise: crypto majors are
            // correlated, so the panel must be too — an independent-noise fixture
            // would have a design effect of ~1 and never exercise the adjustment.
            const common25 = (() => {
                const r = mulberry32(699);
                const out = [];
                let c = 0;
                for (let t = 0; t < n25; t++) { c = 0.6 * c + 0.01 * (r() * 2 - 1); out.push(c); }
                return out;
            })();
            const mkStream25 = (seed) => {
                const r = mulberry32(seed);
                return common25.map((x, t) => (t === 0 ? 0 : x + 0.004 * (r() * 2 - 1)));
            };
            const streams25 = [0, 1, 2, 3].map((s) => mkStream25(700 + s));
            const baseSig25 = (tr, te) => te.map((t) => (t % 2 ? 1 : -1));
            const candSig25 = (tr, te, view) => te.map((t) => Math.sign(view.returns[t]) || 0);
            const cand2Sig25 = (tr, te) => te.map((t) => (t % 3 === 0 ? 1 : 0));
            const ev25 = (rets, sig) => walkForwardEvaluate({ returns: rets, folds: folds25, signalForFold: sig, costBps: 0, trials: 2, audit: false });
            const base25 = poolReports(streams25.map((r) => ev25(r, baseSig25)), { periodsPerYear: 252, trials: 2 });
            const cand25 = poolReports(streams25.map((r) => ev25(r, candSig25)), { periodsPerYear: 252, trials: 2 });
            const cand25b = poolReports(streams25.map((r) => ev25(r, cand2Sig25)), { periodsPerYear: 252, trials: 2 });
            const single25 = ev25(streams25[0], baseSig25);

            check('(9) a pooled report measures the cross-stream panel: one cluster per fold window, the jackknife SE beside the i.i.d. one',
                base25.dependence.available && base25.dependence.nClusters === nFolds25 &&
                base25.dependence.foldLength === q25 && base25.dependence.streams === 4 &&
                clustersOf(base25).length === nFolds25 && clustersOf(single25) === null,
                JSON.stringify({ clusters: base25.dependence.nClusters, deff: base25.dependence.designEffect }));
            check('(9) the honest power line IS the cluster jackknife, and the design effect is what inflates the i.i.d. variance',
                base25.power.seDependent === base25.dependence.seCluster &&
                base25.power.varianceInflation === base25.dependence.designEffect &&
                base25.power.effectiveBars === base25.dependence.effectiveBars &&
                base25.power.underpoweredDependent === (base25.power.mdeSharpeDependent > 1) &&
                Number.isFinite(base25.pooledMetrics.dsrAdjusted));
            check('(9) the pooled report records the trial count it deflated by, and restating at cost 0 is byte-identical',
                base25.trials === 2 &&
                JSON.stringify(restateReportAtCost(base25, 0).pooledMetrics) === JSON.stringify(base25.pooledMetrics) &&
                JSON.stringify(restateReportAtCost(base25, 0).folds) === JSON.stringify(base25.folds) &&
                restateReportAtCost(base25, 0).trials === 2);
            check('(9) the cost ladder restates the whole decision at every level, monotonically in cost',
                (() => {
                    const l = costLadder({ baseline: base25, candidates: [{ ...cand25, id: 'cand' }], levels: [0, 2, 5, 10], periodsPerYear: 252 });
                    return l.available && l.trials === 2 && l.rows.length === 4 &&
                        l.rows[0].baseline.netSharpe >= l.rows[1].baseline.netSharpe &&
                        l.rows[1].baseline.netSharpe >= l.rows[3].baseline.netSharpe &&
                        l.rows.every((r) => r.candidates.length === 1 && typeof r.candidates[0].promote === 'boolean');
                })());
            check('(9) the paired cluster test is available on a pooled report (t referenced to C-1, plus the sign test over windows)',
                (() => {
                    const pt = pairedPromotionTest(base25, cand25, { alpha: 0.05 });
                    return pt.available && pt.nClusters === nFolds25 && Number.isFinite(pt.sharpeDifference.t) &&
                        pt.sharpeDifference.df === nFolds25 - 1 && pt.breadth.available &&
                        pt.breadth.wins + pt.breadth.losses + pt.breadth.ties === nFolds25 &&
                        pt.breadth.floor === Math.pow(2, -nFolds25);
                })());
            check('(9) the round-25 hurdles are APPLIED on a pooled report, and the adjusted floor says applied-or-not-needed by the rule',
                (() => {
                    const d = promoteDecision(base25, cand25, { requireCleanAudit: false, requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95 });
                    return d.gate.requireSharpeDiff === 'applied' && d.gate.requireBreadth === 'applied' &&
                        d.gate.minDsrAdjusted === (cand25.pooledMetrics.dsrAdjusted == null ? 'not-needed' : 'applied') &&
                        base25.dependence.adjustmentNeeded === (base25.dependence.designEffect > 1);
                })());
            check('(9) and SKIPPED (never failed) on a single-stream report, with the gate saying which',
                (() => {
                    const d = promoteDecision(single25, ev25(streams25[0], candSig25), { requireCleanAudit: false, requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95 });
                    return d.gate.requireSharpeDiff === 'skipped-no-panel' && d.gate.requireBreadth === 'skipped-no-panel' &&
                        d.gate.minDsrAdjusted === 'skipped-no-panel' && d.reasons.every((r) => !/unavailable/.test(r));
                })());
            check('(9) familyCorrelation reports the per-fold excess correlation and the Kish effective trial count',
                (() => {
                    const f = familyCorrelation({ baseline: base25, candidates: [cand25, cand25b], periodsPerYear: 252 });
                    return f.available && f.K === 2 && f.folds === base25.folds.length && Number.isFinite(f.meanPairwiseExcessCorr) &&
                        Math.abs(f.effectiveTrials - 2 / (1 + f.meanPairwiseExcessCorr)) < 1e-12 &&
                        f.excessCorrelations[0][0] === 1;
                })());
            const fmt25 = formatReport(base25, { label: 'wf-pool' });
            check('(9) a pooled report renders the participation, adjusted, dependent-power and dependence lines',
                fmt25.includes('part:   nonZero=') && fmt25.includes('depend: streamCorr=') &&
                fmt25.includes('power*: SE=') && fmt25.includes('adjusted: DSR=') && fmt25.includes('search') === false);
            check('(9) a report with no design effect says so instead of printing a fabricated adjusted line',
                !formatReport(single25, { label: 'wf-one' }).includes('adjusted: DSR=') &&
                !formatReport(single25, { label: 'wf-one' }).includes('power*:') &&
                single25.pooledMetrics.dsrAdjusted === null);
            check('(9) the per-report paired line renders when a test is attached, and reads n/a without a panel',
                formatReport({ ...cand25, promotionTest: pairedPromotionTest(base25, cand25) }, { label: 'x' }).includes('paired: dSharpe=') &&
                formatReport({ ...single25, promotionTest: pairedPromotionTest(single25, single25) }, { label: 'x' }).includes('paired: n/a'));
            check('(9) the minimum-track-record status distinguishes a finite horizon from one no track record can reach',
                ['finite', 'beyond-horizon', 'unavailable'].includes(base25.pooledMetrics.minTrackRecordLengthStatus) &&
                (base25.pooledMetrics.netSharpe <= 0) === (base25.pooledMetrics.minTrackRecordLengthStatus === 'beyond-horizon'));
            check('(9) dependenceSummary declines a panel it cannot tile rather than inventing a design effect',
                dependenceSummary({ streamReturns: [[1, 2, 3, 4], [1, 2, 3]] }).available === false &&
                dependenceSummary({ streamReturns: [[1, 2, 3, 4], [1, 2, 3, 5]] }).available === false &&
                typeof DEPENDENCE_GATE_READER === 'string' && DEPENDENCE_GATE_READER.includes('dsrAdjusted'));
        }
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
