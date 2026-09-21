// A/B analysis driver suite (ROADMAP P2-1 / round 23 N0-N2).
//
// Proves `src/analyze.js` — the productionized walk-forward A/B harness. The
// core is model-agnostic (`evaluateAB` takes an injected `signalForVariant`), so
// the whole decision pipeline is pinned here with SYNTHETIC signals (no DB, no
// HiveMind): the audit catches a leaky candidate, the promotion gate promotes a
// dominant-and-clean candidate and rejects noise, and the family-wise cross-check
// attaches per-candidate statistics. The HiveMind-backed model factory is pinned
// with an injected fake so its wiring (configure/afterFit/train/predict, seeded
// determinism) is proven without the native driver.
//
// Round 23 additions:
//   * N0 — `makeControllerModelFactory` (the shipped `HiveMindController` is the
//     model the A/B evaluates) is pinned with an injected fake controller/mind,
//     plus the `view`-based fit/predict contract and the `-1` abstain sentinel;
//   * N1 — the causal signal family (`SIGNAL_VARIANTS` / `ALL_VARIANTS`) and the
//     `variant.signal` dispatch inside `makeSignalForVariant`;
//   * N2 — multi-stream (`worlds`) evaluation pooled via `poolReports`, and the
//     full-OHLCV `readCandles` reader.
//
// Round 24 additions (run integrity — all off the arithmetic path):
//   * O — per-fit state reclamation (`modelRetention: 'discard' | 'keep'`): the
//     fit's directory is closed and deleted after its prediction is consumed, the
//     emitted positions are IDENTICAL either way, and disposal is idempotent;
//   * P — the reporting event stream (`onEvent`): every scored fold and every
//     audit pass, with the fold's bar indices / positions / realised returns, plus
//     the audit's behavioural reachability counter;
//   * Q — `runAnalysis` checkpoints: `partial-report.json` after every variant,
//     `progress.json` as a liveness heartbeat, `folds.jsonl` as a self-contained
//     fold journal, and a `status:'failed'` post-mortem that keeps every variant
//     that finished (so a crashed run's science is not lost).

import fs from 'fs';
import path from 'path';
import {
    VARIANTS, SIGNAL_VARIANTS, ALL_VARIANTS, FEATURE_LEN, resolveVariant, applyVariant,
    featureVector, makeHiveMindModelFactory, makeControllerModelFactory, makeSignalForVariant,
    withSeed, evaluateAB, formatAnalysis, readCloses, readCandles, runAnalysis,
    CONTROLLER_MODEL, CONTROLLER_POSITION_POLICY, probesPerFold, auditVerdict,
} from '../../../src/analyze.js';
import { walkForwardSplit } from '../../../src/analysis/splits.js';
import { poolReports, auditNoLookahead } from '../../../src/analysis/walkforward.js';
import { backtestMetrics } from '../../../src/analysis/backtest.js';
import { shockCandles, volumeShockFactor, makeCandleViewFor } from '../../../src/analysis/world.js';

// A deterministic synthetic return series with a persistent, learnable rhythm:
// slow up/down blocks, so a causal signal can genuinely carry an edge (and a
// one-bar-ahead peek is dramatically better still).
const synthReturns = (n = 120) => {
    const r = new Array(n).fill(0);
    for (let t = 1; t < n; t++) r[t] = Math.floor(t / 12) % 2 === 0 ? 0.01 : -0.002;
    return r;
};

// A synthetic candle series consistent with a return series (close_t = close_{t-1}
// * (1 + r_t)), so a candle-driven and a returns-driven view agree.
const candlesFromReturns = (returns, { start = 100 } = {}) => {
    const candles = [];
    let close = start;
    for (let t = 0; t < returns.length; t++) {
        const open = close;
        close = close * (1 + (returns[t] || 0));
        candles.push({ timestamp: t, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 + t });
    }
    return candles;
};

// Three injected variants over one split: a causal baseline, a drifting oracle
// and a flat (zero-skill) control.
const mkVariants = () => ([
    { id: 'baseline', label: 'baseline', configure: null },
    { id: 'oracle', label: 'oracle', configure: null },
    { id: 'noise', label: 'noise', configure: null },
]);
const signalsFor = () => ({
    baseline: (tr, te, view) => te.map((t) => Math.sign((view.returns[t - 1] ?? 0) + (view.returns[t - 2] ?? 0))),
    oracle: (tr, te, view) => te.map((i, k) => (k + 1 < te.length ? Math.sign(view.returns[te[k + 1]] ?? 0) : 0)),
    noise: (tr, te) => te.map(() => 0),
});
const signalForVariant = (variant) => signalsFor()[variant.id];

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. variant table -------------------------------------------------
    check('baseline is present and first', VARIANTS[0].id === 'baseline');
    check('variant ids are unique', new Set(VARIANTS.map((v) => v.id)).size === VARIANTS.length);
    check('every non-baseline variant has a configure (except the controller-scoped one)',
        VARIANTS.every((v) => v.id === 'baseline' || typeof v.configure === 'function' || v.controllerScoped === true));
    check('the default family ships the Round-2..16 features',
        ['surprise', 'homeostasis', 'multiprobe', 'querymod', 'pca-hash'].every((id) => VARIANTS.some((v) => v.id === id)));
    check('resolveVariant returns the right entry', resolveVariant('homeostasis').id === 'homeostasis');
    check('resolveVariant throws on an unknown id', (() => { try { resolveVariant('nope'); return false; } catch { return true; } })());

    // ---- A2. the causal signal family is part of the searched universe ------
    check('the signal family is non-empty and every id is unique across the family',
        SIGNAL_VARIANTS.length >= 8 && new Set(ALL_VARIANTS.map((v) => v.id)).size === ALL_VARIANTS.length,
        `signals=${SIGNAL_VARIANTS.length} all=${ALL_VARIANTS.length}`);
    check('every signal candidate is callable and carries kind=signal',
        SIGNAL_VARIANTS.every((v) => typeof v.signal === 'function' && v.kind === 'signal'));
    check('ALL_VARIANTS = mechanism variants + signal family',
        ALL_VARIANTS.length === VARIANTS.length + SIGNAL_VARIANTS.length);
    check('resolveVariant finds a signal candidate by id', resolveVariant(SIGNAL_VARIANTS[0].id).id === SIGNAL_VARIANTS[0].id);
    check('the controller position policy is documented and bounded',
        CONTROLLER_POSITION_POLICY.deadZone > 0 && CONTROLLER_POSITION_POLICY.deadZone < 1 &&
        Number.isFinite(CONTROLLER_POSITION_POLICY.scale) &&
        CONTROLLER_MODEL.cacheSize > 0 && CONTROLLER_MODEL.ensembleSize > 0 && CONTROLLER_MODEL.warmup >= 0);

    // ---- B. applyVariant --------------------------------------------------
    const stub = {};
    check('applyVariant is a no-op for the baseline', applyVariant(stub, resolveVariant('baseline')) === false);
    check('applyVariant applies surprise flags', applyVariant(stub, resolveVariant('surprise')) === true && stub._surpriseGateEnabled === true && stub._surpriseConfig.floor === 0.3);
    const stub2 = {};
    applyVariant(stub2, resolveVariant('multiprobe'));
    check('applyVariant applies the multi-probe config', stub2._multiProbeConfig.maxFlips === 2);
    const stub3 = {};
    applyVariant(stub3, resolveVariant('querymod'));
    check('applyVariant applies the query-mod config', stub3._queryModConfig && stub3._queryModConfig.enabled === true);
    const stub4 = {};
    applyVariant(stub4, resolveVariant('pca-hash'));
    check('applyVariant applies the pca-hash config', stub4._pcaHashConfig && stub4._pcaHashConfig.rankPolicy === 'above-mean');
    const stub5 = {};
    check('applyVariant reports the controller-scoped variant as not applied', applyVariant(stub5, resolveVariant('sample-weights')) === false);
    check('applyVariant is a no-op for a signal candidate (no configure)',
        applyVariant({}, resolveVariant(SIGNAL_VARIANTS[0].id)) === false);

    // ---- C. featureVector -------------------------------------------------
    const r = [0.01, -0.02, 0.03, 0.04, -0.05, 0.06];
    const fv = featureVector(r, 3);
    check('featureVector has the configured length', fv.length === FEATURE_LEN);
    check('featureVector is causal (only indices < t)', fv[0] === r[2] * 100 && fv[1] === r[1] * 100);
    check('featureVector encodes the current sign', fv[FEATURE_LEN - 2] === Math.sign(r[3]));
    check('featureVector is zero-padded before the series start', featureVector(r, 0).slice(0, FEATURE_LEN - 2).every((x) => x === 0));
    check('featureVector leaky slot peeks at t+1', featureVector(r, 3, { leaky: true })[FEATURE_LEN - 1] === r[4] * 1000);

    // ---- D. HiveMind model factory (injected fake) ------------------------
    class FakeHiveMind {
        constructor(dir, groups, len, id, forceMin) {
            this.dir = dir; this.len = len; this.id = id; this.forced = forceMin;
            this.trained = 0; this.refreshes = 0;
            FakeHiveMind.instances.push(this);
        }
        train() { this.trained++; return 0.1; }
        predict(x) { return 0.5 + (x[x.length - 2] || 0) * 0.1; }
        _refreshLshHyperplanes() { this.refreshes++; return true; }
    }
    FakeHiveMind.instances = [];

    const factory = makeHiveMindModelFactory({ HiveMind: FakeHiveMind, stateDir: path.join('.nl-analyze-test', 'models'), seed: 3 });
    const model = factory(resolveVariant('pca-hash'));
    const rets = synthReturns(60);
    const retsView = { returns: rets };
    model.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], retsView);
    const hm0 = FakeHiveMind.instances[0];
    check('factory constructs the injected HiveMind', !!hm0 && hm0.forced === true && hm0.len === FEATURE_LEN);
    check('factory applies the variant configure', hm0._pcaHashConfig && hm0._pcaHashConfig.rankPolicy === 'above-mean');
    check('factory trains once per training bar (test start excluded)', hm0.trained === 9);
    check('factory runs afterFit (pca-hash refresh)', hm0.refreshes === 1);
    const positions = model.predict([10, 11], retsView);
    check('predict returns one finite position per test bar', positions.length === 2 && positions.every(Number.isFinite));
    check('factory derives a distinct directory per fit', (() => { model.fit([0, 1], [2, 3], retsView); return FakeHiveMind.instances[1].dir !== hm0.dir; })());
    check('the model reads its data from the VIEW argument (fit contract)',
        (() => {
            const before = FakeHiveMind.instances.length;
            const m2 = factory(resolveVariant('baseline'));
            m2.fit([0, 1], [2], { returns: [0, 0, 0, 0.5] });
            const inst = FakeHiveMind.instances[before];
            // the last trained label is derived from view.returns[t+1] which is 0.5 -> label 1
            return inst.trained === 1;
        })());
    const a = factory(resolveVariant('surprise')); a.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], retsView);
    const b = factory(resolveVariant('surprise')); b.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], retsView);
    check('the model is deterministic under a fixed seed', JSON.stringify(a.predict([10, 11], retsView)) === JSON.stringify(b.predict([10, 11], retsView)));
    const sig = makeSignalForVariant(factory)(resolveVariant('baseline'));
    check('makeSignalForVariant wires fit->predict', Array.isArray(sig([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], retsView)));

    // ---- D2. signal dispatch does NOT build a model ------------------------
    let factoryCalls = 0;
    const countingFactory = (v) => { factoryCalls++; return { fit() {}, predict() { return []; } }; };
    const signalVariant = resolveVariant(SIGNAL_VARIANTS[0].id);
    const signalFold = makeSignalForVariant(countingFactory)(signalVariant);
    const sigPositions = signalFold([0, 1, 2], [30, 31, 32], { closes: candlesFromReturns(synthReturns(80)).map((c) => c.close), returns: synthReturns(80) });
    check('a signal candidate is evaluated by its own pure function (factory untouched)',
        factoryCalls === 0 && sigPositions.length === 3 && sigPositions.every((p) => Number.isFinite(p) && p >= -1 && p <= 1));
    check('a signal fold abstains (0) rather than throwing on a returns-only view',
        makeSignalForVariant(countingFactory)(signalVariant)([], [5], { returns: synthReturns(40) }).every((p) => p === 0));

    // ---- E. evaluateAB: the audit gate ------------------------------------
    const returns = synthReturns(120);
    const folds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
    check('walk-forward split is causal fold count', folds.length === 6 && folds.every((f) => f.test.length === 10));

    const withAudit = evaluateAB({ returns, folds, variants: mkVariants(), signalForVariant, audit: true, costBps: 0 });
    check('evaluateAB evaluates every variant', withAudit.variants.length === 3 && withAudit.candidates.length === 2);
    check('baseline is identified by id', withAudit.baselineVariant.id === 'baseline' && withAudit.baselineIndex === 0);
    check('the baseline is clean under the audit', withAudit.baseline.audit.clean === true);
    const oracle = withAudit.candidates.find((c) => c.variant.id === 'oracle');
    const noise = withAudit.candidates.find((c) => c.variant.id === 'noise');
    check('the oracle is flagged by the look-ahead audit', oracle.report.audit.clean === false && oracle.report.audit.violations.length > 0);
    check('the leaked oracle is NOT promoted and the reason names the audit',
        oracle.decision.promote === false && oracle.decision.reasons.join(' ').includes('lookahead audit'));
    check('the zero-skill control is not promoted', noise.decision.promote === false);
    check('every decision is well-formed', withAudit.candidates.every((c) =>
        typeof c.decision.promote === 'boolean' && Array.isArray(c.decision.reasons) && Number.isFinite(c.decision.foldWinFraction)));
    check('the result labels the bare model and reports one stream',
        withAudit.model === 'bare' && withAudit.streams === 1 && withAudit.positionPolicy === null && withAudit.streamLabels.length === 1);

    // ---- F. evaluateAB: a clean, dominant candidate is promoted -----------
    const cleanReturns = synthReturns(120);
    const cleanFolds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
    const cleanVariants = [
        { id: 'baseline', label: 'baseline' },
        { id: 'strong', label: 'strong' },
    ];
    // The baseline abstains; the candidate acts on the CURRENT bar's sign, which
    // is causal (returns[t] is known at t) and, on the slow-block rhythm, a
    // genuine persistent edge.
    const causalSignals = {
        baseline: (tr, te) => te.map(() => 0),
        strong: (tr, te, view) => te.map((t) => Math.sign(view.returns[t] ?? 0)),
    };
    const clean = evaluateAB({ returns: cleanReturns, folds: cleanFolds, variants: cleanVariants, signalForVariant: (v) => causalSignals[v.id], audit: true, costBps: 0 });
    const strong = clean.candidates.find((c) => c.variant.id === 'strong');
    check('the dominant candidate passes the look-ahead audit', strong.report.audit.clean === true && clean.auditClean === true);
    check('a clean, dominant causal candidate is promoted on merit',
        strong.decision.promote === true && strong.decision.reasons.length === 0,
        JSON.stringify({ promote: strong.decision.promote, reasons: strong.decision.reasons, dsr: strong.report.pooledMetrics.dsr }));
    check('a promoted candidate has a positive fold-win fraction', strong.decision.foldWinFraction > 0.5, String(strong.decision.foldWinFraction));
    check('the report carries a power readout (Sharpe SE / MDE)', strong.report.power && Number.isFinite(strong.report.power.se) && strong.report.power.bars > 0,
        JSON.stringify(strong.report.power));

    // ---- G. the family-wise cross-check -----------------------------------
    check('evaluateAB attaches a family-wise search over baseline + candidates',
        withAudit.search && Array.isArray(withAudit.search.candidates) && withAudit.search.K === 3);
    check('the family-wise search is segment-aware and well-formed (trimmed folds, grouped windows)',
        withAudit.search.trimmedFoldStarts === true && withAudit.search.T === 54 &&
        withAudit.search.groups.join('x') === '9x9x9x9x9x9' && withAudit.search.nWindows > 0,
        JSON.stringify({ T: withAudit.search.T, groups: withAudit.search.groups, wins: withAudit.search.nWindows }));
    check('every candidate carries finite family-wise statistics',
        withAudit.candidates.every((c) => c.search && Number.isFinite(c.search.statistic) && Number.isFinite(c.search.pValue) && c.search.pValue >= 0 && c.search.pValue <= 1));
    check('the family-wise search identifies the drifting oracle as the best strategy', withAudit.search.bestIndex === 1);

    // ---- H. input guards --------------------------------------------------
    check('evaluateAB requires signalForVariant', (() => { try { evaluateAB({ returns, folds, variants: mkVariants() }); return false; } catch { return true; } })());
    check('evaluateAB requires at least two variants', (() => { try { evaluateAB({ returns, folds, variants: [VARIANTS[0]], signalForVariant }); return false; } catch { return true; } })());
    check('evaluateAB requires a returns+folds pair or worlds', (() => { try { evaluateAB({ variants: mkVariants(), signalForVariant }); return false; } catch { return true; } })());

    // ---- I. formatAnalysis ------------------------------------------------
    const text = formatAnalysis(withAudit);
    check('formatAnalysis labels the baseline + verdicts', text.includes('walk-forward A/B') && text.includes('baseline') && (text.includes('[PROMOTE]') || text.includes('[keep-off]')));
    check('formatAnalysis names the audit result', text.includes('audit:'));
    check('formatAnalysis renders the family-wise line', text.includes('family-wise:'));
    check('formatAnalysis states the run-level power verdict (round 24b)',
        text.includes('power:  MDE95 Sharpe=') && text.includes('UNDERPOWERED') && text.includes('pooled bars are needed to detect Sharpe ±1.0'),
        text.split('\n').filter((l) => l.startsWith('power:')).join(' | '));
    check('formatAnalysis names the model + streams + probe (round 23 header)',
        text.includes('model: bare') && text.includes('streams=1') && text.includes('probe=') && text.includes('positionPolicy='));
    check('formatAnalysis marks signal candidates with |signal',
        (() => {
            const res = evaluateAB({
                returns, folds, variants: [VARIANTS[0], resolveVariant(SIGNAL_VARIANTS[0].id)],
                signalForVariant: makeSignalForVariant(countingFactory), audit: true,
            });
            return formatAnalysis(res).includes('|signal');
        })());

    // ---- J. readCloses / readCandles --------------------------------------
    const tmp = path.join('.nl-analyze-test', 'candles.jsonl');
    if (typeof fs.mkdirSync === 'function') { try { fs.mkdirSync(path.dirname(tmp), { recursive: true }); } catch { /* exists */ } }
    fs.writeFileSync(tmp, [
        JSON.stringify({ close: 1 }), 'not json', JSON.stringify({ close: 2 }), JSON.stringify({ close: 3 }), JSON.stringify({ close: 4 }),
    ].join('\n'));
    check('readCloses skips malformed lines', JSON.stringify(readCloses(tmp)) === JSON.stringify([1, 2, 3, 4]));
    check('readCloses honours maxBars', JSON.stringify(readCloses(tmp, { maxBars: 2 })) === JSON.stringify([3, 4]));
    check('readCandles reads full rows with finite OHLCV', (() => {
        const rows = readCandles(tmp);
        return rows.length === 4 && rows.every((c) => Number.isFinite(c.close) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.volume));
    })());
    check('readCandles honours maxBars', readCandles(tmp, { maxBars: 2 }).length === 2);
    fs.writeFileSync(tmp, [
        JSON.stringify({ timestamp: 1, open: 10, high: 12, low: 9, close: 11, volume: 500 }),
        JSON.stringify({ timestamp: 2, close: 13 }),
        'garbage',
        JSON.stringify({ timestamp: 3, close: null }),
    ].join('\n'));
    const rows = readCandles(tmp);
    check('readCandles keeps full rows and back-fills a close-only row',
        rows.length === 2 && rows[0].volume === 500 && rows[1].open === 13 && rows[1].high === 13 && rows[1].low === 13 && rows[1].volume === 1,
        JSON.stringify(rows));

    // ---- K. the controller-backed model factory (N0) -----------------------
    class FakeController {
        constructor(id, dp, cs, es, type, tier, priceObj, forceMin) {
            this._controllerID = id; this._dir = dp; this._cacheSize = cs; this._ensembleSize = es;
            this._type = type; this._tier = tier; this._priceObj = priceObj; this._forceMin = forceMin;
            this._inputSize = 8;
            this._globalAccuracy = { trainingSteps: 0, quarantinedRows: 0 };
            this.calls = 0; this._hivemind = null;
            FakeController.instances.push(this);
        }
        getSignal() { this.calls++; this._globalAccuracy.trainingSteps = this.calls; return { prob: 55 }; }
    }
    FakeController.instances = [];
    class FakeMind {
        constructor(dir, es, isz, id, forceMin) { this.dir = dir; this.isz = isz; this.id = id; this.forceMin = forceMin; FakeMind.instances.push(this); }
        train() { return 0.1; }
        predict() { return 0.5; }
        _refreshLshHyperplanes() { return true; }
    }
    FakeMind.instances = [];

    const ctlFactory = makeControllerModelFactory({
        HiveMind: FakeMind, HiveMindController: FakeController, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5,
        warmup: 5,
    });
    const ctlRets = synthReturns(60);
    const ctlView = { returns: ctlRets, candles: candlesFromReturns(ctlRets, { start: 10 }) };
    const ctlModel = ctlFactory(resolveVariant('pca-hash'));
    ctlModel.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], ctlView);
    const ctl = FakeController.instances[0];
    const mind = FakeMind.instances[0];
    check('the controller factory constructs the injected controller', !!ctl && ctl._cacheSize === CONTROLLER_MODEL.cacheSize && ctl._ensembleSize === CONTROLLER_MODEL.ensembleSize);
    check('the controller factory warms up on bars 1..testStart-1 (prequential history)', ctl.calls === 10, `calls=${ctl.calls}`);
    check('the mind is pre-created and hooked into the controller so mind-level flags are reachable',
        !!mind && ctl._hivemind === mind && mind.isz === ctl._inputSize);
    check('a mind-level variant flag lands on the pre-created mind', !!mind._pcaHashConfig);
    check('a controller-scoped flag would land on the controller', (() => {
        const m2 = ctlFactory({ id: 'sample-weights', label: 'sample-weights', configure: (c) => { c._sampleWeightConfig = { on: true }; } });
        m2.fit([0, 1], [2], ctlView);
        const c2 = FakeController.instances.at(-1);
        return c2._sampleWeightConfig && c2._sampleWeightConfig.on === true;
    })());
    const ctlPositions = ctlModel.predict([10, 11], ctlView, { });
    check('the controller predicts one position per test bar from probToPosition', ctlPositions.length === 2 && ctlPositions.every((p) => Number.isFinite(p)));
    check('the position policy maps prob 55 to a small non-zero position',
        ctlPositions.every((p) => p > 0) && ctlPositions.every((p) => p <= CONTROLLER_POSITION_POLICY.scale),
        JSON.stringify(ctlPositions));
    check('the controller factory reports stats', (() => { const s = ctlModel.stats(); return s.folds === 1 && s.trainingSteps > 0 && s.warmErrors === 0; })());
    const ctlDup = ctlFactory(resolveVariant('pca-hash'));
    ctlDup.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], ctlView);
    check('the controller factory is deterministic under a fixed seed (positions)',
        JSON.stringify(ctlDup.predict([10, 11], ctlView)) === JSON.stringify(ctlModel.predict([10, 11], ctlView)));

    // the -1 untrained sentinel abstains (prob -> 50 -> dead-zone 0)
    class SentCtl extends FakeController { getSignal() { return { prob: -1 }; } }
    const sentFactory = makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: SentCtl, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0 });
    const sentModel = sentFactory(resolveVariant('baseline'));
    sentModel.fit([0, 1], [2], ctlView);
    check('the untrained -1 sentinel abstains (position 0)', sentModel.predict([2], ctlView).every((p) => p === 0) && sentModel.stats().undertrained === false);
    class ThrowCtl extends FakeController { getSignal() { throw new Error('boom'); } }
    const throwFactory = makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: ThrowCtl, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0 });
    const throwModel = throwFactory(resolveVariant('baseline'));
    throwModel.fit([0, 1], [2], ctlView);
    check('a controller that throws abstains on every bar rather than propagating',
        throwModel.predict([2], ctlView).every((p) => p === 0) && throwModel.stats().warmErrors === 2,
        JSON.stringify({ pos: throwModel.predict([2], ctlView), stats: throwModel.stats() }));

    // the documented warm-up floor: a fold with too little streamed history abstains
    const coldFactory = makeControllerModelFactory({
        HiveMind: FakeMind, HiveMindController: FakeController, stateDir: path.join('.nl-analyze-test', 'models'),
        seed: 5, warmup: 100,
    });
    const coldModel = coldFactory(resolveVariant('baseline'));
    coldModel.fit([0, 1, 2, 3], [4], ctlView);
    check('a fold below the documented warm-up floor abstains entirely (no leakage-exposed prediction)',
        coldModel.predict([4], ctlView).every((p) => p === 0) && coldModel.stats().undertrained === true);
    const warmModel = ctlFactory(resolveVariant('baseline'));
    warmModel.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], ctlView);
    check('a fold at or above the warm-up floor is not flagged undertrained',
        warmModel.stats().undertrained === false && CONTROLLER_MODEL.warmup > 0);

    // ---- L. multi-stream evaluation (N2) -----------------------------------
    const worldA = { label: 'A', returns: synthReturns(120), folds: walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 }) };
    const worldB = { label: 'B', returns: synthReturns(120).map((x) => -x), folds: walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 }) };
    const multi = evaluateAB({ worlds: [worldA, worldB], variants: cleanVariants, signalForVariant: (v) => causalSignals[v.id], audit: true, costBps: 0 });
    check('evaluateAB pools multiple worlds into one report per variant', multi.streams === 2 && multi.baseline.folds.length === 12 && multi.baseline.pooledBars === 120,
        JSON.stringify({ folds: multi.baseline.folds.length, bars: multi.baseline.pooledBars }));
    check('a pooled report is the concatenation of its streams (poolReports is the merge)',
        (() => {
            const m = (k, s, t, c) => ({ netSharpe: s, turnover: t, tradeCount: c, totalCost: 0 });
            const ra = { folds: [{ metrics: m(0.1, 1, 1, 0.01) }], pooledReturns: [1, 2], pooledGross: [1.1, 2.1], foldLengths: [2], pooledMetrics: {}, aggregate: {}, audit: { clean: true, reachable: true, viewDiffers: true, probes: 1 } };
            const rb = { folds: [{ metrics: m(0.2, 2, 1, 0.01) }], pooledReturns: [3], pooledGross: [3.1], foldLengths: [1], pooledMetrics: {}, aggregate: {}, audit: { clean: true, reachable: true, viewDiffers: true, probes: 2 } };
            const merged = poolReports([ra, rb], { periodsPerYear: 252, trials: 2 });
            return merged.folds.length === 2 && JSON.stringify(merged.pooledReturns) === '[1,2,3]' && merged.audit.probes === 3 && merged.audit.clean === true;
        })());
    check('poolReports of a single report is the identity (one-stream path byte-identical)',
        (() => { const x = { folds: [{ x: 1 }], pooledReturns: [1] }; return poolReports([x]) === x; })());
    check('pooled stream labels are recorded', JSON.stringify(multi.streamLabels) === JSON.stringify(['A', 'B']));
    check('the pooled audit merges per-stream audits', multi.baseline.audit && multi.baseline.audit.streams === 2 && multi.baseline.audit.clean === true);

    // ---- L2. dependence-aware evaluation (round 25) ------------------------
    {
        const worldC = { label: 'C', returns: synthReturns(120).map((x, i) => (i % 4 === 0 ? -x : x)), folds: worldA.folds };
        const gateOptions = { requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95, alpha: 0.05, periodsPerYear: 252 };
        const depRun = evaluateAB({
            worlds: [worldA, worldB, worldC], variants: cleanVariants,
            signalForVariant: (v) => causalSignals[v.id], audit: false, costBps: 0, gateOptions,
        });
        check('evaluateAB threads gateOptions into every candidate decision (the driver gate reaches the gate)',
            depRun.candidates.every((c) => c.decision.gate && c.decision.gate.requireSharpeDiff === 'applied' && c.decision.gate.requireBreadth === 'applied') &&
            depRun.candidates.every((c) => c.decision.promotionTest && c.decision.promotionTest.available === true),
            JSON.stringify(depRun.candidates.map((c) => c.decision.gate)));
        check('a pooled (multi-stream) report carries the dependence block and the honest cluster-jackknife power line',
            depRun.baseline.dependence.available && depRun.baseline.dependence.streams === 3 &&
            depRun.baseline.dependence.nClusters === depRun.baseline.folds.length / 3 &&
            depRun.baseline.power.seDependent === depRun.baseline.dependence.seCluster &&
            depRun.baseline.power.varianceInflation === depRun.baseline.dependence.designEffect,
            JSON.stringify({ deff: depRun.baseline.dependence.designEffect, nClusters: depRun.baseline.dependence.nClusters }));
        check('the report records the trial count the cost restatement must reuse', depRun.baseline.trials === depRun.variants.length);
        check('per-variant wall times are recorded for observability', depRun.variants.every((v) => Number.isFinite(v.elapsedMs) && v.elapsedMs >= 0));
        check('without gateOptions the round-25 hurdles stay off (the default decision path is unchanged)',
            (() => {
                const d = evaluateAB({ worlds: [worldA, worldB], variants: cleanVariants, signalForVariant: (v) => causalSignals[v.id], audit: false, costBps: 0 });
                return d.candidates.every((c) => c.decision.gate.requireSharpeDiff === 'off' && c.decision.gate.minDsrAdjusted === 'off' && c.decision.gate.requireBreadth === 'off');
            })());
    }

    // ---- M. controller-scoped variant gating -------------------------------
    const bareRun = evaluateAB({ returns: synthReturns(120), folds: walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 }), variants: [VARIANTS[0], resolveVariant('sample-weights')], signalForVariant: () => (tr, te) => te.map(() => 0), audit: false });
    const bareSw = bareRun.candidates.find((c) => c.variant.id === 'sample-weights');
    check('a controller-scoped variant is marked skipped on the bare model', bareSw && bareSw.skipped === true);
    const ctlRun = evaluateAB({
        returns: synthReturns(120), folds: walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 }),
        variants: [VARIANTS[0], resolveVariant('sample-weights')], signalForVariant: () => (tr, te) => te.map(() => 0), audit: false, model: 'controller',
    });
    const ctlSw = ctlRun.candidates.find((c) => c.variant.id === 'sample-weights');
    check('the same variant is NOT skipped on the controller model', ctlSw && ctlSw.skipped === false && ctlRun.model === 'controller');
    check('the controller model reports its position policy in the result',
        JSON.stringify(ctlRun.positionPolicy) === JSON.stringify(CONTROLLER_POSITION_POLICY));

    // ---- N. runAnalysis (the CLI core, with injected fakes) ----------------
    // A deterministic *varying* controller stand-in, so the pooled streams are not
    // flat and the family-wise cross-check is actually exercised.
    class VaryCtl extends FakeController {
        getSignal() { this.calls++; this._globalAccuracy.trainingSteps = this.calls; return { prob: 50 + 6 * Math.sin(this.calls * 0.7) }; }
    }
    {
        const dir = path.join('.nl-analyze-test');
        if (typeof fs.mkdirSync === 'function') { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ } }
        const worldFile = path.join(dir, 'world.jsonl');
        const bigFile = path.join(dir, 'big.jsonl');
        const mkRows = (n, start) => {
            const rows = [];
            let close = start;
            for (let i = 0; i < n; i++) {
                const open = close;
                close = close * (1 + Math.sin(i * 0.3) * 0.01);
                rows.push(JSON.stringify({ timestamp: i, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 + (i % 5) }));
            }
            return rows.join('\n');
        };
        fs.writeFileSync(worldFile, mkRows(120, 100));
        fs.writeFileSync(bigFile, mkRows(300, 100));

        const run = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        const rep = run.report;
        check('runAnalysis builds the controller-backed report over the injected fakes',
            rep.model === 'controller' && rep.streams === 1 && rep.candles === 120 && !!rep.baseline && !!rep.baseline.pooledMetrics,
            JSON.stringify({ model: rep.model, candles: rep.candles, folds: rep.folds }));
        check('runAnalysis runs the walk-forward folds of the requested split (4 folds of 15 test bars)', rep.folds === 4, `folds=${rep.folds}`);
        check('runAnalysis records the run config (sizes, probe, audit, power, position policy)',
            rep.trainSize === 60 && rep.testSize === 15 && rep.maxBars === 120 &&
            rep.auditProbesPerFold === 2 && Number.isFinite(rep.probe) && rep.probe > 0 &&
            rep.power && rep.power.bars > 0 && JSON.stringify(rep.positionPolicy) === JSON.stringify(CONTROLLER_POSITION_POLICY));
        check('runAnalysis evaluates the full 15-candidate family on the controller path (sample-weights included, not skipped)',
            rep.variants.length === 15 && rep.variants.some((v) => v.id === 'sample-weights' && v.skipped === false) &&
            rep.variants.filter((v) => v.kind === 'signal').length === 8);
        check('runAnalysis reports the audit as skipped when audit=false', rep.baseline.audit === null);
        check('the run summary names the model, streams and probe', typeof rep.summary === 'string' && rep.summary.includes('model: controller') && rep.summary.includes('streams=1'));
        check('the run carries a family-wise cross-check over the pooled stream',
            rep.familywise && Number.isFinite(rep.familywise.K) && typeof rep.familywise.best === 'string' && rep.familywise.K === 15,
            JSON.stringify(rep.familywise).slice(0, 200));
        check('every candidate row carries a decision, a reason list and a pooled metrics block',
            rep.candidates.length === 14 && rep.candidates.every((c) => typeof c.promote === 'boolean' && Array.isArray(c.reasons) && !!c.pooledMetrics && c.kind));
        check('runAnalysis states the round-25 gate, its alpha and every hurdle it applied',
            rep.gate === 'dependence' && rep.gateAlpha === 0.05 && rep.gateOptions.requireSharpeDiff === true &&
            rep.gateOptions.requireBreadth === true && rep.gateOptions.minDsrAdjusted === 0.95 && rep.gateOptions.alpha === 0.05);
        check('a single-stream run has no panel, so the dependence block is null and the round-25 hurdles read skipped-no-panel',
            rep.baseline.dependence === null && rep.candidates.every((c) => c.dependence === null) &&
            rep.candidates.every((c) => c.gate && c.gate.requireSharpeDiff === 'skipped-no-panel' &&
                c.gate.requireBreadth === 'skipped-no-panel' && c.gate.minDsrAdjusted === 'skipped-no-panel'));
        check('every candidate row carries the paired promotion test object (available:false with a reason, never absent)',
            rep.candidates.every((c) => c.promotionTest && c.promotionTest.available === false && typeof c.promotionTest.reason === 'string'));
        check('the run carries the default cost ladder, restating the baseline at every level',
            rep.costLadder && rep.costLadder.available && rep.costLadder.trials === rep.variants.length &&
            rep.costLadder.rows.length === 4 && rep.costLadder.rows.map((r) => r.costBps).join(',') === '0,2,5,10' &&
            rep.costLadder.rows.every((r) => r.baseline.dsrAdjusted === null) &&
            rep.costLadder.rows[0].baseline.netSharpe >= rep.costLadder.rows[3].baseline.netSharpe);
        check('the run carries the family-correlation diagnostic over the whole searched family',
            rep.familyCorrelation && rep.familyCorrelation.available && rep.familyCorrelation.K === 14 && rep.familyCorrelation.folds === rep.folds);
        check('per-variant wall times are recorded for every variant (baseline first)',
            rep.timings.length === 15 && rep.timings[0].role === 'baseline' &&
            rep.timings.every((t) => typeof t.id === 'string' && Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0));
        check('the run summary renders the gate, the cost ladder, the family diagnostic and the paired line',
            rep.summary.includes('gate:   dependence') && rep.summary.includes('cost-ladder +0bps:') &&
            rep.summary.includes('family: excessCorr=') && rep.summary.includes('paired: n/a ('));
        check('the pooled metrics carry an explicit minimum-track-record status (a null MinTRL on disk is not ambiguous)',
            ['finite', 'beyond-horizon', 'unavailable'].includes(rep.baseline.pooledMetrics.minTrackRecordLengthStatus));

        const classicRep = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, gate: 'classic', costLadderLevels: [],
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('--gate=classic drops the dependence hurdles and --cost-ladder= disables the ladder (both recorded honestly)',
            classicRep.report.gate === 'classic' && !classicRep.report.gateOptions.requireSharpeDiff &&
            classicRep.report.costLadder === null &&
            classicRep.report.candidates.every((c) => c.gate.requireSharpeDiff === 'off' && c.gate.minDsrAdjusted === 'off') &&
            classicRep.report.summary.includes('gate:   classic'));
        check('the gate does not change the decision path: on a single-stream run both gates promote exactly the same set',
            JSON.stringify(rep.candidates.map((c) => c.promote)) === JSON.stringify(classicRep.report.candidates.map((c) => c.promote)),
            JSON.stringify({ dependence: rep.candidates.filter((c) => c.promote).map((c) => c.id), classic: classicRep.report.candidates.filter((c) => c.promote).map((c) => c.id) }));

        const bareRep = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'bare', writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('--model=bare reproduces the round-22 proxy (14 variants, no controller-scoped candidate, no position policy)',
            bareRep.report.model === 'bare' && bareRep.report.variants.length === 14 && bareRep.report.positionPolicy === null &&
            !bareRep.report.variants.some((v) => v.id === 'sample-weights'));

        const narrowed = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            variantIds: ['surprise', 'sig-momentum'], writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('--variants keeps the baseline first and resolves ids through ALL_VARIANTS (mechanism + signal)',
            JSON.stringify(narrowed.report.variants.map((v) => v.id)) === JSON.stringify(['baseline', 'surprise', 'sig-momentum']));

        let unknownThrew = false;
        try {
            await runAnalysis({ symbols: ['NOPE'], writeFiles: false, HiveMind: FakeMind, HiveMindController: FakeController });
        } catch (err) { unknownThrew = /unknown symbol/.test(String(err && err.message)); }
        check('an unknown --symbols value throws a named error (before reading any file)', unknownThrew);

        let shortThrew = false;
        try {
            await runAnalysis({ file: worldFile, maxBars: 15, trainSize: 20, testSize: 10, writeFiles: false, HiveMind: FakeMind, HiveMindController: FakeController });
        } catch (err) { shortThrew = /not enough candles/.test(String(err && err.message)); }
        check('a file shorter than train+test throws a named error', shortThrew);

        let manyThrew = false;
        try {
            await runAnalysis({ file: bigFile, trainSize: 10, testSize: 1, writeFiles: false, audit: false, HiveMind: FakeMind, HiveMindController: FakeController });
        } catch (err) { manyThrew = /too many/.test(String(err && err.message)); }
        check('an unbounded split (290 folds) throws with a message naming the bound', manyThrew);

        try { if (typeof fs.rmSync === 'function') fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // ---- O. per-fit state reclamation (round 24) ---------------------------
    // A HiveMind stand-in that materialises its fit directory and holds an open
    // SQLite-style handle, so `modelRetention: 'discard'` can be proven to close
    // the handle and delete the directory — and, crucially, to do so WITHOUT
    // moving a single emitted position.
    class DiskMind extends FakeHiveMind {
        constructor(dir, groups, len, id, forceMin) {
            super(dir, groups, len, id, forceMin);
            this._db = { closed: false, close() { this.closed = true; } };
            try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
            fs.writeFileSync(path.join(dir, 'hivemind_state-ID-AN.db'), 'state');
        }
    }
    // The controller-side stand-in: a varying signal (so the identity check is not
    // trivially satisfied by a constant), plus the fit directory and handle.
    class DiskCtl extends VaryCtl {
        constructor(id, dp, cs, es, type, tier, priceObj, forceMin) {
            super(id, dp, cs, es, type, tier, priceObj, forceMin);
            this._db = { closed: false, close() { this.closed = true; } };
            try { fs.mkdirSync(dp, { recursive: true }); } catch { /* ignore */ }
            fs.writeFileSync(path.join(dp, 'hivemind_controller-AN.db'), 'state');
        }
    }
    class BoomCtl extends DiskCtl {
        constructor(...args) {
            super(...args);
            if (String(args[0]).includes('homeostasis')) throw new Error('boom-ctl');
        }
    }

    const ret = (tag) => path.join('.nl-analyze-test', `retention-${tag}`);
    const retView = { returns: synthReturns(60) };
    const retCtlView = { returns: synthReturns(60), candles: candlesFromReturns(synthReturns(60), { start: 10 }) };
    const retTrain = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const retTest = [10, 11];

    const keepSig = makeSignalForVariant(makeHiveMindModelFactory({ HiveMind: DiskMind, stateDir: ret('keep-sig'), seed: 3 }))(resolveVariant('baseline'));
    const discSig = makeSignalForVariant(makeHiveMindModelFactory({ HiveMind: DiskMind, stateDir: ret('discard-sig'), seed: 3, modelRetention: 'discard' }))(resolveVariant('baseline'));
    check('mind reclamation is off the arithmetic path: discard and keep emit identical positions',
        JSON.stringify(keepSig(retTrain, retTest, retView)) === JSON.stringify(discSig(retTrain, retTest, retView)));

    const keepFit = makeHiveMindModelFactory({ HiveMind: DiskMind, stateDir: ret('keep'), seed: 3 })(resolveVariant('baseline'));
    keepFit.fit(retTrain, retTest, retView);
    const keepDb = DiskMind.instances.at(-1)._db;
    check('retention=keep (the factory default) leaves the fit dir on disk and its handle open',
        keepFit.stats().retention === 'keep' && keepFit.stats().reclaimed === false &&
        fs.existsSync(path.join(ret('keep'), 'baseline-0')) && keepDb.closed === false);
    const discFit = makeHiveMindModelFactory({ HiveMind: DiskMind, stateDir: ret('discard'), seed: 3, modelRetention: 'discard' })(resolveVariant('baseline'));
    discFit.fit(retTrain, retTest, retView);
    const discDb = DiskMind.instances.at(-1)._db;
    const firstDispose = discFit.dispose();
    check('retention=discard closes the fit handle and removes its state dir',
        discDb.closed === true && !fs.existsSync(path.join(ret('discard'), 'baseline-0')) &&
        firstDispose.closed === true && firstDispose.removed === true && discFit.stats().reclaimed === true);
    const secondDispose = discFit.dispose();
    check('dispose is idempotent (a second call is a no-op, and never throws)',
        secondDispose.closed === false && secondDispose.removed === false);

    const keepCtlSig = makeSignalForVariant(makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: DiskCtl, stateDir: ret('ctl-keep-sig'), seed: 5, warmup: 5 }))(resolveVariant('baseline'));
    const discCtlSig = makeSignalForVariant(makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: DiskCtl, stateDir: ret('ctl-discard-sig'), seed: 5, warmup: 5, modelRetention: 'discard' }))(resolveVariant('baseline'));
    const keepCtl = { pos: keepCtlSig(retTrain, retTest, retCtlView) };
    const keepCtlInst = FakeController.instances.at(-1);
    const discCtl = { pos: discCtlSig(retTrain, retTest, retCtlView) };
    const discCtlInst = FakeController.instances.at(-1);
    check('controller reclamation is off the arithmetic path: discard and keep emit identical positions',
        JSON.stringify(keepCtl.pos) === JSON.stringify(discCtl.pos) && keepCtl.pos.length === 2,
        JSON.stringify({ keep: keepCtl.pos, disc: discCtl.pos }));
    check('the kept controller fit dir survives with its handle open; the discarded one is closed and removed',
        fs.existsSync(path.join(ret('ctl-keep-sig'), 'baseline-0')) && keepCtlInst._db.closed === false &&
        !fs.existsSync(path.join(ret('ctl-discard-sig'), 'baseline-0')) && discCtlInst._db.closed === true);

    // ---- P. the reporting event stream (round 24) --------------------------
    const pEvents = [];
    const pRes = evaluateAB({
        returns: synthReturns(120), folds: walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 }),
        variants: mkVariants(), signalForVariant, audit: true, costBps: 0, auditProbesPerFold: 2,
        onEvent: (e) => pEvents.push(e),
    });
    const pIds = ['baseline', 'oracle', 'noise'];
    const pBy = (id, t, stage) => pEvents.filter((e) => e.variantId === id && e.t === t && (stage === undefined || e.stage === stage)).length;
    check('every event is tagged with its variant, stream and index',
        pEvents.length > 0 && pEvents.every((e) => typeof e.variantId === 'string' && Number.isInteger(e.variantIndex) &&
            e.variantTotal === 3 && e.stream === 0 && e.streamsTotal === 1 && e.streamLabel === 'main'));
    check('the stream carries one scored fold + one base pass + probesPerFold probes per fold per variant',
        pIds.every((id) => pBy(id, 'fold') === 6 && pBy(id, 'pass', 'base') === 6 && pBy(id, 'pass', 'probe') === 12),
        JSON.stringify(pIds.map((id) => [id, pBy(id, 'fold'), pBy(id, 'pass', 'base'), pBy(id, 'pass', 'probe')])));
    check('a scored-fold event is self-contained (bar indices, positions, realised returns, metrics)',
        pEvents.filter((e) => e.t === 'fold').every((e) => Array.isArray(e.test) && e.test.length === 10 &&
            Array.isArray(e.signals) && e.signals.length === 10 && Array.isArray(e.returns) && e.returns.length === 10 &&
            e.metrics && Number.isFinite(e.metrics.netSharpe)));
    check('a probe event names the perturbed decision point',
        pEvents.filter((e) => e.t === 'pass' && e.stage === 'probe').every((e) => Number.isFinite(e.probeAt) && Number.isFinite(e.probeIndex)));
    check('every pass event carries the fold cursor (so live progress can advance during the audit, not freeze on the last scored fold)',
        pEvents.filter((e) => e.t === 'pass').every((e) => Number.isFinite(e.foldIndex) && Number.isFinite(e.foldTotal) && e.foldIndex < e.foldTotal));
    check('scored folds arrive in order',
        pEvents.filter((e) => e.t === 'fold' && e.variantId === 'oracle').map((e) => e.foldIndex).join(',') === '0,1,2,3,4,5');
    const pScoreSig = (id, fi) => pEvents.find((e) => e.t === 'fold' && e.variantId === id && e.foldIndex === fi).signals;
    const pBaseSig = (id, fi) => pEvents.find((e) => e.t === 'pass' && e.stage === 'base' && e.variantId === id && e.foldIndex === fi).signals;
    check('the audit base pass reproduces the scored pass exactly (the audit certifies the object the metrics used)',
        [0, 1, 2, 3, 4, 5].every((fi) => JSON.stringify(pScoreSig('oracle', fi)) === JSON.stringify(pBaseSig('oracle', fi))));
    check('the audit reports a behavioural reachability count bounded by the fold count',
        Number.isFinite(pRes.baseline.audit.reachableFolds) && pRes.baseline.audit.reachableFolds >= 0 && pRes.baseline.audit.reachableFolds <= 6);
    check('probesPerFold sizes the audit budget (stride = ceil(testLen / auditProbesPerFold))',
        probesPerFold(15, 2) === 2 && probesPerFold(10, 2) === 2 && probesPerFold(10, 1) === 1 && probesPerFold(10, 0) === 10,
        JSON.stringify([probesPerFold(15, 2), probesPerFold(10, 2), probesPerFold(10, 1), probesPerFold(10, 0)]));
    check('auditVerdict names the structural and behavioural halves',
        auditVerdict({ audit: { clean: true, probes: 4, reachable: true, reachableFolds: 2 } }) === 'clean probes=4 reachable=true reachableFolds=2',
        auditVerdict({ audit: { clean: true, probes: 4, reachable: true, reachableFolds: 2 } }));
    check('auditVerdict reports skipped when no audit ran', auditVerdict({ audit: null }) === 'skipped');

    // ---- Q. runAnalysis checkpoints and post-mortem (round 24) -------------
    const qDir = path.join('.nl-analyze-test', 'q');
    if (typeof fs.mkdirSync === 'function') { try { fs.mkdirSync(qDir, { recursive: true }); } catch { /* exists */ } }
    const qWorld = path.join(qDir, 'qworld.jsonl');
    const qRows = (n, start) => {
        const rows = [];
        let close = start;
        for (let i = 0; i < n; i++) {
            const open = close;
            close = close * (1 + Math.sin(i * 0.3) * 0.01);
            rows.push(JSON.stringify({ timestamp: i, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 + (i % 5) }));
        }
        return rows.join('\n');
    };
    fs.writeFileSync(qWorld, qRows(120, 100));
    const qReadJson = (runDir, name) => JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));

    const q1Log = [];
    const q1 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's1'),
        model: 'controller', writeFiles: true, audit: true, auditProbesPerFold: 2,
        progressMs: 0, log: (line) => q1Log.push(line),
        HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    const q1Run = qReadJson(q1.runDir, 'run.json');
    check('run.json records the round-24 integrity config (retention, reachability, fold log, folds, roster)',
        q1Run.modelRetention === 'discard' && q1Run.requireReachable === false && q1Run.foldLog === 'all' &&
        q1Run.reuseBase === false && q1Run.costBps === 0 &&
        q1Run.folds === 4 && Array.isArray(q1Run.variants) && q1Run.variants.length === 15,
        JSON.stringify({ retention: q1Run.modelRetention, folds: q1Run.folds, variants: q1Run.variants.length }));
    const q1Rep = qReadJson(q1.runDir, 'report.json');
    check('report.json is the canonical complete verdict with the machine-readable audit block',
        q1Rep.status === 'complete' && q1Rep.schema === 'nl.analyze.v1' && q1Rep.candidates.length === 14 &&
        !!q1Rep.baseline.audit && typeof q1Rep.baseline.audit.clean === 'boolean' && typeof q1Rep.baseline.audit.probes === 'number' &&
        typeof q1Rep.candidates[0].audit.clean === 'boolean' && !!q1Rep.familywise && typeof q1Rep.reader === 'string' && !!q1Rep.artifacts);
    const q1Part = qReadJson(q1.runDir, 'partial-report.json');
    check('partial-report.json is the per-variant checkpoint, matching the final report row counts',
        q1Part.status === 'complete' && q1Part.schema === 'nl.analyze.v1' && q1Part.candidates.length === 14 && q1Part.variants.length === 15);
    const q1Prog = qReadJson(q1.runDir, 'progress.json');
    check('progress.json is a complete heartbeat (every budgeted pass accounted for)',
        q1Prog.phase === 'complete' && q1Prog.counters.events === q1Prog.counters.eventsTotal && q1Prog.counters.eventsTotal === 240 &&
        q1Prog.reuseBase === false && q1Prog.costBps === 0,
        JSON.stringify(q1Prog.counters));
    const q1Folds = fs.readFileSync(path.join(q1.runDir, 'folds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('folds.jsonl is a self-contained fold journal (one line per pass, matching the heartbeat)',
        q1Folds.length === q1Prog.counters.events &&
        q1Folds.every((r) => typeof r.stage === 'string' && typeof r.v === 'string' && Number.isFinite(r.fold)));
    check('run.log journals the completion',
        fs.readFileSync(path.join(q1.runDir, 'run.log'), 'utf8').includes('"message":"analyze complete"'));
    check('the reclaimed models/ directory is removed once every fit has been discarded',
        !fs.existsSync(path.join(q1.runDir, 'models')));
    check('the stdout progress lines report the run phase (greppable liveness for a watcher)',
        q1Log.some((l) => l.startsWith('[analyze] ') && l.includes('complete')) && q1Log.some((l) => l.includes('PROMOTE') || l.includes('keep-off')));

    const q2 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's2'),
        variantIds: ['surprise'], model: 'controller', writeFiles: true, audit: false,
        foldLog: 'off', progressMs: -1, HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    check('--fold-log=off writes no fold journal', !fs.existsSync(path.join(q2.runDir, 'folds.jsonl')));
    const q3 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's3'),
        variantIds: ['surprise'], model: 'controller', writeFiles: true, audit: false,
        foldLog: 'off', progressMs: -1, HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    check('runAnalysis is deterministic (identical summary and baseline pooled Sharpe across identical runs)',
        q3.report.summary === q2.report.summary &&
        q3.report.baseline.pooledMetrics.netSharpe === q2.report.baseline.pooledMetrics.netSharpe);
    const q4 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's4'),
        variantIds: ['surprise'], model: 'controller', writeFiles: true, audit: false,
        foldLog: 'all', progressMs: -1, HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    check('the fold journal is pure reporting: writing it does not change the verdict',
        q4.report.summary === q2.report.summary && fs.existsSync(path.join(q4.runDir, 'folds.jsonl')));
    const q5 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's5'),
        variantIds: ['surprise'], model: 'controller', writeFiles: true, audit: false,
        modelRetention: 'keep', progressMs: -1, HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    check('--keep-models retains every fit state dir for forensics',
        fs.existsSync(path.join(q5.runDir, 'models')) && fs.readdirSync(path.join(q5.runDir, 'models')).length === 8,
        JSON.stringify(fs.readdirSync(path.join(q5.runDir, 'models')).length));

    let qFail = null;
    try {
        await runAnalysis({
            file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's6'),
            variantIds: ['surprise', 'homeostasis'], model: 'controller', writeFiles: true, audit: false,
            progressMs: -1, HiveMind: FakeMind, HiveMindController: BoomCtl,
        });
    } catch (err) { qFail = err; }
    check('a crashed run rejects with the underlying error', !!qFail && /boom-ctl/.test(String(qFail && qFail.message)));
    const q6Runs = fs.readdirSync(path.join(qDir, 's6', 'runs'));
    const q6Dir = path.join(qDir, 's6', 'runs', q6Runs[0]);
    const q6Part = qReadJson(q6Dir, 'partial-report.json');
    check('a crashed run leaves a failed checkpoint that keeps every finished variant',
        q6Part.status === 'failed' && /boom-ctl/.test(String(q6Part.error && q6Part.error.message)) &&
        q6Part.candidates.length === 1 && q6Part.progress.variantsDone === 2,
        JSON.stringify({ status: q6Part.status, candidates: q6Part.candidates.length, done: q6Part.progress.variantsDone }));
    check('a crashed run leaves no canonical report (the checkpoint is the artifact)',
        !fs.existsSync(path.join(q6Dir, 'report.json')));

    check('the fold journal is readable offline: probe lines carry `probeIndex`, base lines carry `reused`',
        q1Folds.filter((r) => r.stage === 'probe').length > 0 &&
        q1Folds.filter((r) => r.stage === 'probe').every((r) => Number.isFinite(r.probeIndex) && Number.isFinite(r.probeAt)) &&
        q1Folds.filter((r) => r.stage === 'base').every((r) => r.reused === false));
    check('run.json and report.json record the cost model and the audit-reuse choice',
        q1Run.costBps === 0 && q1Run.reuseBase === false && q1Rep.costBps === 0 && q1Rep.reuseBase === false &&
        q1Rep.candidates.every((c) => Object.prototype.hasOwnProperty.call(c.pooledMetrics, 'breakEvenCostBps') &&
            Object.prototype.hasOwnProperty.call(c.pooledMetrics, 'grossPnl')) &&
        Object.prototype.hasOwnProperty.call(q1Rep.baseline.pooledMetrics, 'breakEvenCostBps'));

    const q7 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's7'),
        variantIds: ['surprise'], model: 'controller', writeFiles: true, audit: true, auditProbesPerFold: 2,
        costBps: 5, reuseBase: true, progressMs: -1, HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    const q7Run = qReadJson(q7.runDir, 'run.json');
    const q7Rep = qReadJson(q7.runDir, 'report.json');
    const q7Folds = fs.readFileSync(path.join(q7.runDir, 'folds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('--reuse-base is recorded and reuses the scored signals as the base pass (no refit)',
        q7Run.reuseBase === true && q7Rep.reuseBase === true &&
        q7Folds.filter((r) => r.stage === 'base').length === 8 &&
        q7Folds.filter((r) => r.stage === 'base').every((r) => r.reused === true) &&
        q7Rep.baseline.audit.baseReused === 4);
    check('charging costBps books a cost and moves net Sharpe away from gross Sharpe',
        q7Rep.costBps === 5 && q7Rep.baseline.pooledMetrics.totalCost > 0 &&
        q7Rep.baseline.pooledMetrics.netSharpe !== q7Rep.baseline.pooledMetrics.grossSharpe,
        JSON.stringify({ cost: q7Rep.baseline.pooledMetrics.totalCost, net: q7Rep.baseline.pooledMetrics.netSharpe, gross: q7Rep.baseline.pooledMetrics.grossSharpe }));

    // ---- R. evaluation integrity: volume reach, break-even cost, audit reuse -----
    // (a) The shock must reach VOLUME. Measured on the completed smoke run: without
    //     a volume shock, `sig-volume` was unreachable in 0/32 probes, so its audit
    //     was vacuous (structurally "clean", behaviourally empty). The phase-shifted
    //     volume shock fixes that and closes future-volume leakage.
    const kCandles = Array.from({ length: 40 }, (_, i) => ({ timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i }));
    check('the volume shock is 1 at and before the probe point, bounded above, and non-uniform',
        volumeShockFactor(10, { after: 10, probe: 0.05 }) === 1 && volumeShockFactor(0, { after: 10, probe: 0.05 }) === 1 &&
        [11, 12, 13, 25].every((t) => volumeShockFactor(t, { after: 10, probe: 0.05 }) >= 1 && volumeShockFactor(t, { after: 10, probe: 0.05 }) <= 1.1 + 1e-12) &&
        new Set([11, 12, 13, 14, 15, 16, 17, 18].map((t) => volumeShockFactor(t, { after: 10, probe: 0.05 }).toFixed(6))).size > 4);
    check('shockCandles scales volume after the probe point and never mutates its input',
        (() => {
            const before = JSON.stringify(kCandles);
            const s = shockCandles(kCandles, { after: 10, probe: 0.05 });
            return s[10].volume === kCandles[10].volume && s[11].volume !== kCandles[11].volume &&
                s.slice(11).every((c) => c.volume > 0) && JSON.stringify(kCandles) === before;
        })());
    check('the candle view exposes a shocked volume series on a probe pass (a volume-only strategy is reachable)',
        (() => {
            const vf = makeCandleViewFor(kCandles);
            const base = vf(null, null);
            const probe = vf(null, { after: 10, probe: 0.05 });
            return base.volumes[20] === kCandles[20].volume && probe.volumes[20] !== kCandles[20].volume &&
                probe.volumes.slice(0, 11).every((v, i) => v === kCandles[i].volume);
        })());
    const volFolds = walkForwardSplit({ n: 40, trainSize: 20, testSize: 5 });
    const volSignal = (tr, te, view) => te.map((t) => Math.sign(((view.volumes[t] / view.volumes[t - 1]) || 1) - 1));
    const volAudit = auditNoLookahead({ signalForFold: volSignal, folds: volFolds, returns: new Array(40).fill(0), viewFor: makeCandleViewFor(kCandles), probe: 0.05 });
    check('a volume-only strategy is behaviourally reachable by the audit (the shock moves a later position)',
        volAudit.clean === true && volAudit.reachable === true && volAudit.reachableFolds > 0,
        JSON.stringify({ clean: volAudit.clean, reachable: volAudit.reachable, folds: volAudit.reachableFolds }));

    // (b) Break-even cost: assumption-free and turnover-normalised, so a high-turnover
    //     signal and a low-turnover mechanism can be compared on one axis.
    const beReturns = [0.01, -0.02, 0.03, 0.04, -0.05, 0.06, 0.02, -0.01];
    const beSignals = [1, 1, -1, 1, 1, -1, 1, 1];
    const be = backtestMetrics({ returns: beReturns, signals: beSignals, costBps: 0 });
    check('backtestMetrics reports the gross P&L and the exact break-even cost it implies',
        Number.isFinite(be.grossPnl) && Number.isFinite(be.breakEvenCostBps) &&
        Math.abs(be.breakEvenCostBps - (1e4 * be.grossPnl) / be.turnover) < 1e-9,
        JSON.stringify({ grossPnl: be.grossPnl, turnover: be.turnover, breakEven: be.breakEvenCostBps }));
    check('a zero-turnover strategy reports a null break-even cost rather than Infinity/NaN',
        backtestMetrics({ returns: beReturns, signals: beReturns.map(() => 0) }).breakEvenCostBps === null);
    const costed = evaluateAB({ returns: synthReturns(120), folds: walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 }), variants: mkVariants(), signalForVariant, audit: false, costBps: 5 });
    const costedOracle = costed.candidates.find((c) => c.variant.id === 'oracle').report.pooledMetrics;
    check('charging costBps books a cost and separates net from gross Sharpe',
        costed.baseline.pooledMetrics.totalCost > 0 && costedOracle.totalCost > 0 && costedOracle.netSharpe !== costedOracle.grossSharpe &&
        Number.isFinite(costedOracle.breakEvenCostBps),
        JSON.stringify({ net: costedOracle.netSharpe, gross: costedOracle.grossSharpe, cost: costedOracle.totalCost }));

    // (c) Audit base reuse is provably the same verdict with one fewer refit per fold.
    const reuseFolds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
    const refitRun = evaluateAB({ returns: synthReturns(120), folds: reuseFolds, variants: mkVariants(), signalForVariant, audit: true, costBps: 0 });
    const reuseRun = evaluateAB({ returns: synthReturns(120), folds: reuseFolds, variants: mkVariants(), signalForVariant, audit: true, costBps: 0, auditReuseBase: true });
    check('auditReuseBase changes nothing in the verdict (metrics, audit, decisions) and reports the reuse',
        JSON.stringify(refitRun.baseline.pooledMetrics) === JSON.stringify(reuseRun.baseline.pooledMetrics) &&
        JSON.stringify(refitRun.candidates.map((c) => [c.decision.promote, c.report.audit.clean, c.report.audit.reachableFolds])) ===
        JSON.stringify(reuseRun.candidates.map((c) => [c.decision.promote, c.report.audit.clean, c.report.audit.reachableFolds])) &&
        reuseRun.baseline.audit.baseReused === 6 && refitRun.baseline.audit.baseReused === 0,
        JSON.stringify({ refitReused: refitRun.baseline.audit.baseReused, reuseReused: reuseRun.baseline.audit.baseReused }));

    try { if (typeof fs.rmSync === 'function') fs.rmSync('.nl-analyze-test', { recursive: true, force: true }); } catch { /* best effort */ }

    const failed = checks.filter((x) => !x.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
