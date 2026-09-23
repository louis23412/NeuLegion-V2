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
    VARIANTS, SIGNAL_VARIANTS, ALL_VARIANTS, LABEL_VARIANTS, OPT_IN_VARIANTS, RESOLVABLE_VARIANTS,
    FEATURE_LEN, resolveVariant, applyVariant, notApplicableReason, listVariants, formatVariantList, forecastKindOf,
    inertReasonFor,
    featureVector, makeHiveMindModelFactory, makeControllerModelFactory, makeSignalForVariant,
    withSeed, evaluateAB, evaluateABAsync, makeNodeFoldDispatcher, formatAnalysis, readCloses, readCandles, runAnalysis,
    replicateAnalysis,
    CONTROLLER_MODEL, CONTROLLER_POSITION_POLICY, probesPerFold, auditVerdict,
} from '../../../src/analyze.js';
import { walkForwardSplit } from '../../../src/analysis/splits.js';
import { poolReports, auditNoLookahead, restateReportAtPolicy, confidenceToPosition, confidenceFromProb, familyCorrelation } from '../../../src/analysis/walkforward.js';
import { backtestMetrics } from '../../../src/analysis/backtest.js';
import { shockCandles, volumeShockFactor, makeCandleViewFor } from '../../../src/analysis/world.js';
import { CANDLE_MANIFEST } from '../../../src/candles_audit.js';

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
    check('every non-baseline default variant has a configure',
        VARIANTS.every((v) => v.id === 'baseline' || typeof v.configure === 'function'));
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
    // R27-3: `sample-weights` is now an opt-in variant WITH a real configure, so
    // the "no configure" example is a synthetic controller-scoped variant.
    check('applyVariant applies the opt-in sample-weights configure to a controller',
        (() => { const c = {}; return applyVariant(c, resolveVariant('sample-weights')) === true && c._sampleWeightConfig && c._sampleWeightConfig.mode === 'causal-window'; })());
    check('applyVariant reports a controller-scoped variant with no configure as not applied',
        applyVariant({}, { id: 'x', controllerScoped: true, configure: null }) === false);
    check('applyVariant is a no-op for a signal candidate (no configure)',
        applyVariant({}, resolveVariant(SIGNAL_VARIANTS[0].id)) === false);

    // ---- B2. R27-2: the candidate taxonomy (which code path each variant reaches)
    // A variant that cannot reach the scored model must say so, so the report marks
    // it `not-applicable` instead of presenting it as a tested arm (BUGS.md #44).
    const taxonomy = listVariants('controller');
    check('R27-2: every resolvable variant declares a taxonomy (id, kind, appliesTo, applicable)',
        taxonomy.length === RESOLVABLE_VARIANTS.length &&
        taxonomy.every((r) => typeof r.id === 'string' && ['mechanism', 'signal', 'label'].includes(r.kind) &&
            ['agnostic', 'model', 'controller', 'broadcast'].includes(r.appliesTo) && typeof r.applicable === 'boolean') &&
        taxonomy.every((r) => r.applicable || (typeof r.reason === 'string' && r.reason.length > 0)),
        JSON.stringify(taxonomy.map((r) => [r.id, r.appliesTo, r.applicable])));
    check('R27-2: multi-probe and query-mod are broadcast-only, so they are not-applicable on the scored controller',
        notApplicableReason(resolveVariant('multiprobe'), 'controller').includes('broadcastMemory') &&
        notApplicableReason(resolveVariant('querymod'), 'controller').includes('broadcastMemory') &&
        listVariants('controller').filter((r) => !r.applicable).map((r) => r.id).sort().join(',') === 'multiprobe,querymod');
    check('R27-2: pca-hash stays applicable on the controller (its live reader is _retrieveTopRelevantProtos)',
        notApplicableReason(resolveVariant('pca-hash'), 'controller') === null &&
        resolveVariant('pca-hash').note.includes('_retrieveTopRelevantProtos'));
    check('R27-2: a controller-scoped variant is not-applicable on a non-controller model',
        notApplicableReason(resolveVariant('sample-weights'), 'bare').includes('controller-backed') &&
        notApplicableReason(resolveVariant('surprise'), 'bare') === null &&
        notApplicableReason(resolveVariant(SIGNAL_VARIANTS[0].id), 'bare') === null);
    check('R27-2: the taxonomy table renders one row per resolvable variant with an applies-to column',
        (() => { const s = formatVariantList(taxonomy); return s.split('\n').length === taxonomy.length + 2 && s.includes('applies-to') && s.includes('broadcast'); })());
    check('R27-2: sample-weights is resolvable (opt-in) but NOT in the default roster',
        !ALL_VARIANTS.some((v) => v.id === 'sample-weights') && resolveVariant('sample-weights').id === 'sample-weights' &&
        listVariants('controller').find((r) => r.id === 'sample-weights').inDefaultRoster === false &&
        listVariants('controller').find((r) => r.id === 'sample-weights').controllerScoped === true);
    check('R27-5: forecastKindOf groups the controller family (baseline/mechanism/label) apart from the signals',
        forecastKindOf(resolveVariant('baseline')) === 'controller' &&
        forecastKindOf(resolveVariant('surprise')) === 'controller' &&
        forecastKindOf(resolveVariant('label-triple')) === 'controller' &&
        forecastKindOf(resolveVariant(SIGNAL_VARIANTS[0].id)) === 'signal');

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
        flushState() { this.flushStateCalls = (this.flushStateCalls || 0) + 1; return { status: true }; }
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

    // R26-2: the model diagnostics are referenced to the label base rate (BUGS.md
    // #37). A model that only matches the base-rate forecast earns no skill; a
    // genuinely better-than-base-rate model does.
    const labelStats = (over) => {
        class LCtl extends FakeController {
            getSignal() { this.calls++; this._globalAccuracy.trainingSteps = this.calls; Object.assign(this._globalAccuracy, over); return { prob: 55 }; }
        }
        const f = makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: LCtl, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0 });
        const m = f(resolveVariant('baseline'));
        m.fit([0, 1], [2], ctlView);
        return m.stats();
    };
    const sNoSkill = labelStats({ resolvedTakeProfit: 270, resolvedStopLoss: 730, brierSum: 200, brierCount: 1000, wins: 700, total: 1000 });
    const sSkill = labelStats({ resolvedTakeProfit: 730, resolvedStopLoss: 270, brierSum: 150, brierCount: 1000, wins: 800, total: 1000 });
    check('R26-2: a model no better than its base-rate forecast is reported base-rate (no skill)',
        sNoSkill.status === 'base-rate' && Math.abs(sNoSkill.baseRate - 0.27) < 1e-9 &&
        sNoSkill.brierSkill < 0 && sNoSkill.accuracySkill < 0 && sNoSkill.chanceAccuracy === 0.73,
        JSON.stringify(sNoSkill));
    check('R26-2: a model that beats the base-rate forecast is reported skilful (proper score, positive skill)',
        sSkill.status === 'skilful' && Math.abs(sSkill.baseRate - 0.73) < 1e-9 &&
        sSkill.brierSkill > 0 && sSkill.raw.brierCount === 1000,
        JSON.stringify(sSkill));
    const ctlDup = ctlFactory(resolveVariant('pca-hash'));
    ctlDup.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11], ctlView);
    check('the controller factory is deterministic under a fixed seed (positions)',
        JSON.stringify(ctlDup.predict([10, 11], ctlView)) === JSON.stringify(ctlModel.predict([10, 11], ctlView)));

    // R26-12: the checkpoint throttle (`HiveMind.dumpState()` on every getSignal is
    // ~25% of the per-call cost, and the A/B never reads the state back).
    check('R26-12: the controller factory defaults the save interval to 1 (dump every call, bit-identical)',
        (() => {
            const f = makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: FakeController, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0 });
            f(resolveVariant('baseline')).fit([0, 1], [2], ctlView);
            return FakeController.instances.at(-1)._saveInterval === 1;
        })());
    check('R26-12: the controller factory threads a requested save interval onto the controller',
        (() => {
            const f = makeControllerModelFactory({ HiveMind: FakeMind, HiveMindController: FakeController, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0, saveInterval: 7 });
            f(resolveVariant('baseline')).fit([0, 1], [2], ctlView);
            return FakeController.instances.at(-1)._saveInterval === 7;
        })());
    check('R26-12: a KEPT fit is flushed once at disposal when the interval never dumps during the run (and never otherwise)',
        (() => {
            const opts = { HiveMind: FakeMind, HiveMindController: FakeController, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0, modelRetention: 'keep' };
            const kept = makeControllerModelFactory({ ...opts, saveInterval: Infinity })(resolveVariant('baseline'));
            kept.fit([0, 1], [2], ctlView);
            const keptCtl = FakeController.instances.at(-1);
            const beforeDispose = keptCtl.flushStateCalls || 0;
            kept.dispose();
            const finite = makeControllerModelFactory({ ...opts, saveInterval: 1 })(resolveVariant('baseline'));
            finite.fit([0, 1], [2], ctlView);
            const finiteCtl = FakeController.instances.at(-1);
            finite.dispose();
            return beforeDispose === 0 && keptCtl.flushStateCalls === 1 && (finiteCtl.flushStateCalls || 0) === 0;
        })());

    // ---- R26-0: the driver must feed the controller the PRODUCTION WINDOW ------
    // (BUGS.md #33). Production passes `state.cache.slice(-cacheSize)` — the last
    // `cacheSize` candles — and the controller trims its candle table to
    // `cacheSize`, so feeding the whole growing prefix re-inserts the trimmed
    // history and hands `_updateOpenTrades` bars older than the entry. A recording
    // controller pins the driver's per-call input contract without a DB.
    class RecordingCtl {
        constructor(id, dp, cs, es, type, tier, priceObj, forceMin) {
            this._cacheSize = cs; this._inputSize = 8; this._forceMin = forceMin;
            this._globalAccuracy = { trainingSteps: 0, quarantinedRows: 0 };
            this.calls = [];
            RecordingCtl.instances.push(this);
        }
        getSignal(candles) { this.calls.push(candles); this._globalAccuracy.trainingSteps = this.calls.length; return { prob: 55 }; }
    }
    RecordingCtl.instances = [];

    const recCacheSize = 10;
    const recReturns = synthReturns(60);
    const recCandles = candlesFromReturns(recReturns, { start: 10 });
    const recView = { returns: recReturns, candles: recCandles };
    const recFactory = makeControllerModelFactory({
        HiveMind: FakeMind, HiveMindController: RecordingCtl,
        stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0, cacheSize: recCacheSize,
    });
    const recModel = recFactory(resolveVariant('baseline'));
    recModel.fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], [15, 16, 17], recView);
    recModel.predict([15, 16, 17], recView);
    const rec = RecordingCtl.instances.at(-1);
    const recExpected = [];
    for (let i = 1; i <= 15; i++) recExpected.push(recCandles.slice(Math.max(0, i - recCacheSize), i));
    for (const t of [15, 16, 17]) recExpected.push(recCandles.slice(Math.max(0, t + 1 - recCacheSize), t + 1));
    const recInputsMatch = rec.calls.length === recExpected.length && rec.calls.every((c, k) =>
        c.length === recExpected[k].length && c.every((x, j) => x.timestamp === recExpected[k][j].timestamp));
    check('R26-0 window contract: every getSignal input is at most cacheSize candles',
        rec.calls.length > 0 && rec.calls.every((c) => c.length <= recCacheSize),
        JSON.stringify(rec.calls.map((c) => c.length)));
    check('R26-0 window contract: each input is the contiguous, advancing production window (last cacheSize candles)',
        recInputsMatch,
        `calls=${rec.calls.length} widths=${JSON.stringify(rec.calls.map((c) => c.length))}`);

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

    // The warm-up floor is now a *reported statistic*, not a gate: the gate is the
    // model's own readiness (`trainingSteps > 0`), because the old
    // `testStart >= warmup` guard could never fire at the default split
    // (trainSize 60 > warmup 40) — a false certificate (round 26, R26-2 /
    // BUGS.md #35).
    const coldFactory = makeControllerModelFactory({
        HiveMind: FakeMind, HiveMindController: FakeController, stateDir: path.join('.nl-analyze-test', 'models'),
        seed: 5, warmup: 100,
    });
    const coldModel = coldFactory(resolveVariant('baseline'));
    coldModel.fit([0, 1, 2, 3], [4], ctlView);
    check('a fold below the warm-up floor is reported undertrained (a statistic, not a gate)',
        coldModel.stats().undertrained === true && CONTROLLER_MODEL.warmup > 0);
    check('a fold below the warm-up floor that DID train still predicts (warmup no longer gates)',
        coldModel.stats().ready === true && coldModel.predict([4], ctlView).every((p) => p > 0));
    // The readiness gate: a controller that never trained abstains on every bar.
    class ColdCtl extends FakeController { getSignal() { this.calls++; return { prob: 55 }; } }
    const neverFactory = makeControllerModelFactory({
        HiveMind: FakeMind, HiveMindController: ColdCtl, stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0,
    });
    const neverModel = neverFactory(resolveVariant('baseline'));
    neverModel.fit([0, 1], [2], ctlView);
    check('readiness gate (R26-2): a controller that never trained abstains on every bar',
        neverModel.stats().ready === false && neverModel.stats().status === 'not-trained' &&
        neverModel.predict([2], ctlView).every((p) => p === 0));
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

    // ---- M2. R27-1: the liveness certificate + the active-K restatement -------
    // A candidate that never reaches the model path (an inert mechanism, a
    // duplicate of an earlier live candidate) used to be scored, counted in K and
    // handed a fabricated hurdle list. It is now certified, excluded from K and the
    // family-wise search, and carries exactly one reason.
    {
        const ret = synthReturns(120);
        const folds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
        const mkSignal = (variant) => {
            let call = 0;
            return (tr, te, view) => {
                const foldIndex = call++;
                const base = te.map((t) => Math.sign(view.returns[t] || 0));
                switch (variant.id) {
                    case 'inert-a': return base;
                    case 'live-diff': return base.map((s) => -s);
                    case 'dup-a': return base.map((s) => -s);
                    case 'flip-one': return base.map((s, i) => (foldIndex === 1 && i === 0 ? -s : s));
                    default: return base;
                }
            };
        };
        const variants = [
            { id: 'baseline', label: 'baseline', configure: null },
            { id: 'live-diff', label: 'live-diff', configure: null },
            { id: 'inert-a', label: 'inert-a', configure: null },
            { id: 'dup-a', label: 'dup-a', configure: null },
            { id: 'flip-one', label: 'flip-one', configure: null },
            // R27-3: a variant may carry its own precise inert reason (the shipped
            // `sample-weights` does: labels do not overlap, so it reaches the model
            // path and multiplies by 1) instead of the generic "never reaches" wording.
            { id: 'inert-why', label: 'inert-why', inertReason: 'no two label spans overlap', configure: null },
        ];
        const res = evaluateAB({ returns: ret, folds, variants, signalForVariant: mkSignal, audit: false, costBps: 0 });
        const byId = Object.fromEntries(res.candidates.map((c) => [c.variant.id, c]));
        check('R27-1/R28: an inert candidate is certified inert, excluded from K/search, and carries exactly one reason',
            byId['inert-a'].liveness.status === 'inert' && byId['inert-a'].active === false &&
            byId['inert-a'].search === null && byId['inert-a'].decision.inactive === true &&
            byId['inert-a'].decision.reasons.length === 1 &&
            // R28 (BUGS.md #53/#44): the generic fallback is a MEASURED statement —
            // it may NEVER claim a structural unreachability, because a variant only
            // reaches the liveness comparison after the taxonomy approved it.
            !/never reaches the model path|not-applicable|unreachable/.test(byId['inert-a'].liveness.reason) &&
            /changed no emitted position/.test(byId['inert-a'].liveness.reason) &&
            /all 6 folds/.test(byId['inert-a'].liveness.reason) &&
            // R27-3: a variant's own `inertReason` is used when it has one (the shipped
            // `sample-weights` cites the assumed span horizon), else the generic wording.
            byId['inert-why'].liveness.status === 'inert' && byId['inert-why'].active === false &&
            byId['inert-why'].liveness.reason.includes('no two label spans overlap'),
            JSON.stringify({ inert: byId['inert-a'].liveness, why: byId['inert-why'].liveness }));
        check('R28 (BUGS.md #53): a MODEL-scoped variant\'s inert reason can never be a structural claim (the pca-hash certificate)',
            (() => {
                const pca = resolveVariant('pca-hash');
                const reason = inertReasonFor(pca, { totalFolds: 18, identicalFolds: 18, model: 'controller' });
                return pca.appliesTo === 'model' && typeof pca.inertReason === 'function' &&
                    /REACHABLE/.test(reason) && /6\/288/.test(reason) &&
                    /SET is invariant/.test(reason) && /lsh\.test\.js §K/.test(reason) &&
                    /18 folds/.test(reason) &&
                    !/never reaches the model path/.test(reason) &&
                    // ...and the generic fallback (a variant with no reason of its own)
                    // is measured too, naming the model path and the fold count.
                    /changed no emitted position/.test(inertReasonFor(resolveVariant('surprise'), { totalFolds: 7, model: 'controller' })) &&
                    /all 7 folds/.test(inertReasonFor(null, { totalFolds: 7, model: 'bare' })) &&
                    !/never reaches the model path/.test(inertReasonFor(null, { totalFolds: 7, model: 'bare' }));
            })());
        check('R27-1: a candidate identical to an earlier live candidate is certified duplicate-of:<id>',
            byId['dup-a'].liveness.status === 'duplicate-of:live-diff' && byId['dup-a'].active === false &&
            byId['dup-a'].search === null && byId['dup-a'].decision.inactive === true,
            JSON.stringify(byId['dup-a'].liveness));
        check('R27-1: a candidate that differs on one fold is live, in the search, and reports its max fold diff',
            byId['live-diff'].active === true && byId['live-diff'].search !== null && byId['live-diff'].liveness.maxAbsDiff > 0 &&
            byId['flip-one'].active === true && byId['flip-one'].search !== null && byId['flip-one'].liveness.maxAbsDiff > 0,
            JSON.stringify({ live: byId['live-diff'].liveness, flip: byId['flip-one'].liveness }));
        check('R27-1: trials is the ACTIVE K (baseline + live), trialsRoster the requested roster, and the counts add up',
            res.trials === 3 && res.trialsRoster === 6 && res.trialsInactive === 3 &&
            res.inactiveCounts.inert >= 1 && res.inactiveCounts.duplicate >= 1 &&
            res.liveness.active === 3 && res.liveness.roster === 6,
            JSON.stringify({ trials: res.trials, roster: res.trialsRoster, inactive: res.trialsInactive, counts: res.inactiveCounts }));
        check('R27-1: an inactive row keeps its roster-K report in reportRoster while every row carries the active K in report',
            byId['inert-a'].reportRoster.trials === 6 && byId['inert-a'].report.trials === 3 &&
            byId['live-diff'].report.trials === 3,
            JSON.stringify({ rosterK: byId['inert-a'].reportRoster.trials, activeK: byId['inert-a'].report.trials }));
        // R28 (BUGS.md #55): the family-correlation readout resolves `maxPair` against
        // the ACTIVE arms the matrix was built from. Resolving it against the FULL
        // roster names the wrong arms whenever an inactive candidate sits before an
        // active one — the round-27 summary printed `sample-weights~multiprobe` for a
        // `surprise~homeostasis` pair.
        check('R28 (BUGS.md #55): the summary maxPair names the ACTIVE arms, not the same indices of the full roster',
            (() => {
                const activeRows = res.candidates.filter((c) => c.active);
                const fc = familyCorrelation({
                    baseline: res.baseline,
                    candidates: activeRows.map((c) => c.report),
                    labels: activeRows.map((c) => c.variant.id),
                });
                if (!fc.available || !fc.maxPair || !fc.labels) return false;
                const line = formatAnalysis(res, { familyCorrelation: fc });
                const mp = /maxPair=([^~]+)~([^ ]+) r=/.exec(line);
                if (!mp) return false;
                const full = [res.baselineVariant, ...res.candidates.map((c) => c.variant)];
                return mp[1] === fc.labels[fc.maxPair.a] && mp[2] === fc.labels[fc.maxPair.b] &&
                    // the two resolutions really do disagree on this fixture
                    (full[fc.maxPair.a].id !== mp[1] || full[fc.maxPair.b].id !== mp[2]);
            })());

        // R27-2: the taxonomy is ENFORCED, not just declared. A broadcast-only
        // variant cannot reach the scored controller, so it is certified
        // `not-applicable` (naming the broadcast path), excluded from K and the
        // search, and given exactly one reason — never scored and handed fabricated
        // hurdles. Note the signal would be identical to the baseline here, so
        // without the taxonomy it would be misreported as `inert` (a tested arm).
        const variantsB = [
            { id: 'baseline', label: 'baseline', configure: null },
            { id: 'live-diff', label: 'live-diff', configure: null },
            { id: 'multiprobe', label: 'multi-probe', appliesTo: 'broadcast', configure: null },
        ];
        const resB = evaluateAB({ returns: ret, folds, variants: variantsB, signalForVariant: mkSignal, audit: false, costBps: 0, model: 'controller' });
        const byB = Object.fromEntries(resB.candidates.map((c) => [c.variant.id, c]));
        check('R27-2: a broadcast-only variant on the controller is not-applicable, outside K/search, naming the broadcast path',
            byB['multiprobe'].liveness.status === 'not-applicable' && byB['multiprobe'].active === false &&
            typeof byB['multiprobe'].notApplicable === 'string' && byB['multiprobe'].notApplicable.includes('broadcastMemory') &&
            byB['multiprobe'].search === null && byB['multiprobe'].decision.inactive === true &&
            byB['multiprobe'].decision.reasons.length === 1 &&
            resB.trials === 2 && resB.trialsRoster === 3 && resB.inactiveCounts.notApplicable === 1,
            JSON.stringify({ status: byB['multiprobe'].liveness.status, ro: resB.trialsRoster, act: resB.trials }));
    }

    // ---- N. runAnalysis (the CLI core, with injected fakes) ----------------
    // A deterministic *varying* controller stand-in, so the pooled streams are not
    // flat and the family-wise cross-check is actually exercised.
    class VaryCtl extends FakeController {
        getSignal() {
            this.calls++;
            this._globalAccuracy.trainingSteps = this.calls;
            // R26-2: a realistic label lifecycle (≈27 % TP, Brier 0.20) so the
            // report's model block is exercised with a base rate and a skill score.
            this._globalAccuracy.resolvedTakeProfit = Math.round(this.calls * 0.27);
            this._globalAccuracy.resolvedStopLoss = this.calls - this._globalAccuracy.resolvedTakeProfit;
            this._globalAccuracy.brierSum = this.calls * 0.20;
            this._globalAccuracy.brierCount = this.calls;
            return { prob: 50 + 6 * Math.sin(this.calls * 0.7) };
        }
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
        check('runAnalysis evaluates the default 14-candidate family on the controller path (sample-weights is opt-in, not in the roster)',
            rep.variants.length === 14 && !rep.variants.some((v) => v.id === 'sample-weights') &&
            rep.variants.filter((v) => v.kind === 'signal').length === 8);
        check('runAnalysis reports the audit as skipped when audit=false', rep.baseline.audit === null);
        check('the run summary names the model, streams and probe', typeof rep.summary === 'string' && rep.summary.includes('model: controller') && rep.summary.includes('streams=1'));
        check('the run carries a family-wise cross-check over the pooled stream',
            rep.familywise && Number.isFinite(rep.familywise.K) && typeof rep.familywise.best === 'string' && rep.familywise.K === rep.trials,
            JSON.stringify(rep.familywise).slice(0, 200));
        check('every candidate row carries a decision, a reason list and a pooled metrics block',
            rep.candidates.length === 13 && rep.candidates.every((c) => typeof c.promote === 'boolean' && Array.isArray(c.reasons) && !!c.pooledMetrics && c.kind));
        check('R26-7: runAnalysis states the dependence gate, its alpha and every hurdle it applies',
            rep.gate === 'dependence' && rep.gateAlpha === 0.05 && rep.gateOptions.requireSharpeDiff === true &&
            rep.gateOptions.requireClusterStability === true && rep.gateOptions.minDsrAdjusted === 0.95 && rep.gateOptions.alpha === 0.05 &&
            rep.gateOptions.requireBreadth === undefined);
        check('R26-7: a single-stream run has no panel, so the dependence block is null and the panel hurdles read skipped-no-panel',
            rep.baseline.dependence === null && rep.candidates.every((c) => c.dependence === null) &&
            rep.candidates.filter((c) => c.active).every((c) => c.gate && c.gate.requireSharpeDiff === 'skipped-no-panel' &&
                c.gate.requireClusterStability === 'skipped-no-panel' && c.gate.minDsrAdjusted === 'skipped-no-panel') &&
            // R27-1: an inactive candidate is not gated at all — it carries one
            // explicit reason and is excluded from K and the search.
            rep.candidates.filter((c) => !c.active).every((c) => c.inactive === true && c.liveness && typeof c.liveness.reason === 'string' && c.liveness.reason.length > 0),
            JSON.stringify({ dep: rep.baseline.dependence, active: rep.candidates.filter((c) => c.active).map((c) => [c.id, c.gate && c.gate.requireSharpeDiff, c.dependence]), inactive: rep.candidates.filter((c) => !c.active).map((c) => [c.id, c.inactive, c.liveness && c.liveness.reason && c.liveness.reason.slice(0, 30)]) }));
        check('every candidate row carries the paired promotion test object (available:false with a reason, never absent)',
            rep.candidates.every((c) => c.promotionTest && c.promotionTest.available === false && typeof c.promotionTest.reason === 'string'));
        check('the run carries the default cost ladder, restating the baseline at every level',
            rep.costLadder && rep.costLadder.available && rep.costLadder.trials === rep.trials &&
            rep.costLadder.rows.length === 4 && rep.costLadder.rows.map((r) => r.costBps).join(',') === '0,2,5,10' &&
            rep.costLadder.rows.every((r) => r.baseline.dsrAdjusted === null) &&
            rep.costLadder.rows[0].baseline.netSharpe >= rep.costLadder.rows[3].baseline.netSharpe);
        check('the run carries the family-correlation diagnostic over the whole active family (baseline excluded)',
            rep.familyCorrelation && rep.familyCorrelation.available &&
            rep.familyCorrelation.K === rep.candidates.filter((c) => c.active).length &&
            rep.familyCorrelation.folds === rep.folds);
        // R26-5: the turnover attack is opt-in and, off, contributes nothing.
        check('R26-5: the turnover attack is off by default (null block and target, no summary line)',
            rep.turnoverSweep === null && rep.turnoverTargetBps === null && !rep.summary.includes('turnover '));
        const tsCfg = {
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            variantIds: ['sig-momentum', 'sig-accel'], model: 'controller', writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        };
        const tsOff = await runAnalysis({ ...tsCfg });
        const tsOn = await runAnalysis({ ...tsCfg, turnoverSweep: true, turnoverTarget: 5 });
        const tsRep = tsOn.report;
        check('R26-5: --turnover-sweep enumerates the dead-zone x holding grid as pure post-processing',
            tsRep.turnoverSweep && tsRep.turnoverSweep.available === true &&
            tsRep.turnoverSweep.policies === 48 && tsRep.turnoverSweep.rows.length === 96 &&
            Object.keys(tsRep.turnoverSweep.byId).length === 2 &&
            tsRep.turnoverSweep.targetBps === 5 && typeof tsRep.turnoverSweep.targetMet === 'boolean',
            JSON.stringify({ p: tsRep.turnoverSweep && tsRep.turnoverSweep.policies, r: tsRep.turnoverSweep && tsRep.turnoverSweep.rows.length }));
        check('R26-5: the turnover grid rows are sorted by break-even cost (descending)',
            tsRep.turnoverSweep.rows.every((r, i) => i === 0 || (tsRep.turnoverSweep.rows[i - 1].breakEvenCostBps ?? -Infinity) >= (r.breakEvenCostBps ?? -Infinity)));
        check('R26-5: the run summary renders the turnover block and the target',
            tsRep.turnoverSweep.rows.length > 0 && tsRep.summary.includes('turnover ') && tsRep.summary.includes('target 5bps'));
        check('R26-5: enabling the turnover attack changes no scored number (pure post-processing)',
            tsRep.baseline.pooledMetrics.netSharpe === tsOff.report.baseline.pooledMetrics.netSharpe &&
            JSON.stringify(tsRep.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe])) ===
            JSON.stringify(tsOff.report.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe])),
            JSON.stringify(tsRep.candidates.map((c) => [c.id, c.promote])));
        // R26-6: the bar interval and the stream basket are opt-in, recorded, and
        // cannot change how an included stream is scored.
        check('R26-6: the stream interval and selection are off by default (raw bars, no selection block)',
            rep.intervalBars === 1 && rep.streamSelection === null && rep.summary.includes('intervalBars=1'));
        const ivRun = await runAnalysis({
            file: bigFile, maxBars: 300, trainSize: 30, testSize: 10, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, intervalBars: 4,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-6: --interval resamples every stream (300 1h bars -> 75 4h bars) and records the factor',
            ivRun.report.intervalBars === 4 && ivRun.report.candles === 75 && ivRun.report.folds === 4 &&
            ivRun.report.summary.includes('intervalBars=4'),
            JSON.stringify({ bars: ivRun.report.candles, folds: ivRun.report.folds }));
        const msCfg = {
            files: [worldFile, bigFile], maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        };
        const msRun = await runAnalysis({ ...msCfg, streamSelect: true });
        const msRep = msRun.report;
        const msLabels = msRun.result.streamLabels;
        check('R26-6: --select-streams measures the basket (K streams, design effect, greedy order) without dropping any',
            msRep.streams === 2 && msRep.streamSelection && msRep.streamSelection.available &&
            msRep.streamSelection.order.length === 2 && msRep.streamSelection.keep === null &&
            msRep.streamSelection.kept.length === 2 && msRep.streamSelection.keptDesignEffect.available &&
            msRep.summary.includes('streams: 2 streams'),
            JSON.stringify(msRep.streamSelection && msRep.streamSelection.order));
        const keptRep = (await runAnalysis({ ...msCfg, streamSelect: 1 })).report;
        check('R26-6: --select-streams=<n> keeps only the first n of the greedy order and reports the kept basket',
            keptRep.streams === 1 && keptRep.streamSelection.keep === 1 &&
            keptRep.streamSelection.kept.length === 1 && keptRep.streamSelection.keptDesignEffect.designEffect === 1 &&
            keptRep.summary.includes('streams kept=1'),
            JSON.stringify({ streams: keptRep.streams, kept: keptRep.streamSelection && keptRep.streamSelection.kept }));

        // R27-5: journal/report hygiene — a stream label is the SYMBOL (a manifest
        // match) or the uppercased file basename, never the operator's absolute
        // path (the round-26 journal embedded `/home/<operator>/.../candles.jsonl`).
        check('R27-5: stream labels are symbols/basenames, never filesystem paths',
            msLabels.length === 2 && msLabels.join(',') === 'WORLD,BIG' &&
            msLabels.every((l) => typeof l === 'string' && l.length > 0 && !l.includes('/') && !l.includes('\\')),
            JSON.stringify(msLabels));
        const symDir = path.join(dir, 'src');
        if (typeof fs.mkdirSync === 'function') { try { fs.mkdirSync(symDir, { recursive: true }); } catch { /* exists */ } }
        const symbolPath = path.join(dir, CANDLE_MANIFEST[0].file);
        fs.writeFileSync(symbolPath, mkRows(120, 100));
        const symRun = await runAnalysis({
            file: symbolPath, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R27-5: a manifest-matched candle file is labelled by its SYMBOL, not its path',
            JSON.stringify(symRun.result.streamLabels) === JSON.stringify([CANDLE_MANIFEST[0].symbol]) && symRun.report.streams === 1,
            JSON.stringify({ labels: symRun.result.streamLabels, symbol: CANDLE_MANIFEST[0].symbol, file: CANDLE_MANIFEST[0].file }));

        // R27-5: the two always-zero diagnostics are replaced by statistics that
        // mean something. `underTrainedFolds` counts folds whose model trained on
        // fewer rows than the explicit `minTrainingSteps` floor (so it CAN fire);
        // `shallowHistoryFolds` is the old `testStart < warmup` count under its true
        // name. The per-fold training-step distribution lets the floor be set from
        // evidence.
        const utRep = (await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, minTrainingSteps: 1e9,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        })).report;
        check('R27-5: underTrainedFolds CAN fire (a floor above the observed steps) and the floor/distribution are recorded',
            utRep.minTrainingSteps === 1e9 && utRep.baseline.model.minTrainingSteps === 1e9 &&
            utRep.baseline.model.underTrainedFolds > 0 && utRep.baseline.model.underTrainedFolds <= utRep.baseline.model.folds &&
            utRep.baseline.model.trainingStepsDistribution && utRep.baseline.model.trainingStepsDistribution.max > 0,
            JSON.stringify({ under: utRep.baseline.model.underTrainedFolds, dist: utRep.baseline.model.trainingStepsDistribution }));
        check('R27-5: at the default floor no fold is under-trained and the old always-zero certificate is gone',
            rep.baseline.model.underTrainedFolds === 0 && rep.baseline.model.minTrainingSteps === 1 &&
            typeof rep.baseline.model.shallowHistoryFolds === 'number' &&
            Object.prototype.hasOwnProperty.call(rep.baseline.model, 'undertrainedFolds') === false,
            JSON.stringify({ under: rep.baseline.model.underTrainedFolds, shallow: rep.baseline.model.shallowHistoryFolds }));
        check('per-variant wall times and the trial count are recorded on every row (baseline first)',
            rep.timings.length === 14 && rep.timings[0].role === 'baseline' &&
            rep.timings.every((t) => typeof t.id === 'string' && Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0) &&
            // The candidate rows must carry the same provenance: elapsedMs/streams
            // (dropped by evaluateAB's projection before round 25b) and the K every
            // DSR was deflated by (R27-1: the ACTIVE roster, not the requested one).
            rep.trials === 1 + rep.candidates.filter((c) => c.active).length &&
            rep.trialsRoster === rep.variants.length &&
            rep.candidates.every((c) => Number.isFinite(c.elapsedMs) && c.streams === rep.streams && c.trials === rep.trials));
        check('the run summary renders the gate, the cost ladder, the family diagnostic and the paired line',
            rep.summary.includes('gate:   dependence') && rep.summary.includes('cost-ladder +0bps:') &&
            rep.summary.includes('family: excessCorr=') && rep.summary.includes('paired: n/a ('));
        // R26-2: the per-variant model block (readiness + label base rate + skill).
        // This is what makes a keep-off verdict readable as "no edge" vs "no model".
        check('R26-2: the report carries a per-variant model block (trained, base rate, skill, status)',
            rep.baseline.model && rep.baseline.model.trained === true && rep.baseline.model.folds === rep.folds &&
            Math.abs(rep.baseline.model.baseRate - 0.27) < 0.02 && rep.baseline.model.brierSkill < 0 &&
            rep.baseline.model.status === 'base-rate' && rep.baseline.model.raw &&
            Number.isFinite(rep.baseline.model.trainingSteps),
            JSON.stringify(rep.baseline.model));
        check('R26-2: a pure signal candidate carries a null model block (an absent model is never a healthy one)',
            rep.candidates.filter((c) => c.kind === 'signal').every((c) => c.model === null) &&
            rep.variants.filter((v) => v.kind === 'signal').every((v) => v.model === null) &&
            rep.variants.filter((v) => v.kind !== 'signal').every((v) => v.model && v.model.trained === true));
        check('R26-2: the run summary renders the models line', rep.summary.includes('models: ') && rep.summary.includes('base-rate'));
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

        // R26-12: the A/B never reads a fit's persisted state back, so its default
        // is "never dump"; the throttle is threaded and recorded for provenance.
        check('R26-12: the A/B defaults the controller save interval to Infinity (no dump is ever read back)',
            FakeController.instances.at(-1)._saveInterval === Infinity);
        const siRun = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            variantIds: ['surprise'], model: 'controller', writeFiles: false, audit: false, saveInterval: 3,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-12: runAnalysis threads the save interval through to the controller and records it in the report',
            FakeController.instances.at(-1)._saveInterval === 3 && siRun.report.saveInterval === 3,
            JSON.stringify({ onCtl: FakeController.instances.at(-1)._saveInterval, inReport: siRun.report.saveInterval }));

        // ---- R26-11: the trade-label policy (BUGS.md #36) -------------------
        // `optimistic` is the shipped labeller and the baseline behaviour. The
        // `conservative` and `triple` labels are opt-in A/B candidates: a label
        // change is a *training-set* change, so it must be asked for explicitly and
        // the default family must stay exactly 14 candidates.
        check('R26-11/R28: the label variants resolve by id but stay out of the default family (opt-in only)',
            resolveVariant('label-conservative').id === 'label-conservative' &&
            resolveVariant('label-triple').id === 'label-triple' &&
            LABEL_VARIANTS.length === 2 && RESOLVABLE_VARIANTS.length === ALL_VARIANTS.length + OPT_IN_VARIANTS.length + LABEL_VARIANTS.length &&
            ALL_VARIANTS.every((v) => v.kind !== 'label') &&
            LABEL_VARIANTS.every((v) => v.controllerScoped === true && v.kind === 'label' &&
                typeof v.configure === 'function' && (v.labelPolicy === 'conservative' || v.labelPolicy === 'triple')),
            `all=${ALL_VARIANTS.length} resolvable=${RESOLVABLE_VARIANTS.length}`);
        check('R26-11: a label variant overrides the run-level policy on the controller (configure runs after the default), and the horizon is threaded',
            (() => {
                const mk = (over) => makeControllerModelFactory({
                    HiveMind: FakeMind, HiveMindController: FakeController,
                    stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0, ...over,
                });
                const base = mk({ labelPolicy: 'optimistic' })(resolveVariant('label-conservative'));
                base.fit([0, 1], [2], ctlView);
                const conCtl = FakeController.instances.at(-1);
                const tri = mk({ labelPolicy: 'conservative', labelHorizonBars: 3 })(resolveVariant('label-triple'));
                tri.fit([0, 1], [2], ctlView);
                const labelCtl = FakeController.instances.at(-1);
                const run = mk({ labelPolicy: 'conservative', labelHorizonBars: 3 })(resolveVariant('baseline'));
                run.fit([0, 1], [2], ctlView);
                const plainCtl = FakeController.instances.at(-1);
                // A non-finite horizon is recorded as null, never NaN.
                const noHorizon = mk({ labelPolicy: 'triple', labelHorizonBars: Infinity })(resolveVariant('baseline'));
                noHorizon.fit([0, 1], [2], ctlView);
                const noCtl = FakeController.instances.at(-1);
                return conCtl._labelPolicy === 'conservative' && conCtl._labelHorizonBars === null &&
                    labelCtl._labelPolicy === 'triple' && labelCtl._labelHorizonBars === 3 &&
                    plainCtl._labelPolicy === 'conservative' && plainCtl._labelHorizonBars === 3 &&
                    noCtl._labelPolicy === 'triple' && noCtl._labelHorizonBars === null;
            })());

        const lpRun = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            variantIds: ['label-conservative', 'label-triple'], model: 'controller', writeFiles: false, audit: false,
            labelPolicy: 'conservative', labelHorizonBars: 3,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-11: runAnalysis records the label policy and the triple-barrier horizon in the report',
            lpRun.report.labelPolicy === 'conservative' && lpRun.report.labelHorizonBars === 3 &&
            JSON.stringify(lpRun.report.variants.map((v) => v.id)) === JSON.stringify(['baseline', 'label-conservative', 'label-triple']),
            JSON.stringify({ policy: lpRun.report.labelPolicy, horizon: lpRun.report.labelHorizonBars }));

        const lpFull = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, labelPolicies: true,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-11: --label-policies appends exactly the two label variants to the 14-candidate family',
            lpFull.report.variants.length === 16 &&
            lpFull.report.variants.slice(-2).map((v) => v.id).join(',') === 'label-conservative,label-triple',
            JSON.stringify(lpFull.report.variants.map((v) => v.id)));
        check('R26-11: the label variants are controller-scoped, so --model=bare never runs them even when asked',
            (await runAnalysis({
                file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
                model: 'bare', writeFiles: false, audit: false, labelPolicies: true,
                HiveMind: FakeMind, HiveMindController: VaryCtl,
            })).report.variants.every((v) => v.kind !== 'label'));

        let badPolicyThrew = false;
        try {
            await runAnalysis({ file: worldFile, model: 'controller', writeFiles: false, labelPolicy: 'nope', HiveMind: FakeMind, HiveMindController: VaryCtl });
        } catch (err) { badPolicyThrew = /unknown labelPolicy/.test(String(err && err.message)); }
        check('R26-11: an unknown labelPolicy throws a named error (before reading any file)', badPolicyThrew);

        // ---- R28: the weighting mechanism's configuration and scale, the measured
        // span, and the shipped gate's raw-hurdle decision (BUGS.md #54/#57/#58) -----
        // All of this is OFF the default path: both sample-weight arms are opt-in
        // variants, so no default trajectory (and no golden fingerprint) moves.
        const swCfg = (over) => {
            const ctl = { ...over };
            applyVariant(ctl, resolveVariant('sample-weights'));
            return ctl._sampleWeightConfig;
        };
        check('R28 (BUGS.md #58): sample-weights configures a MEASURED span (horizon null) and a mean-1 emitted stream',
            swCfg({}).mode === 'causal-window' && swCfg({}).horizonBars === null &&
            swCfg({}).emittedNormalization === 'mean1' && swCfg({}).normalization === 'mean1' &&
            swCfg({}).windowBars > 0,
            JSON.stringify(swCfg({})));
        check('R28 (P1c): an explicit span horizon wins over the label horizon, and a horizon-1 labeller is never adopted as a span',
            swCfg({ _sampleWeightHorizon: 12 }).horizonBars === 12 &&
            swCfg({ _labelHorizonBars: 20 }).horizonBars === 20 &&
            swCfg({ _sampleWeightHorizon: 12, _labelHorizonBars: 20 }).horizonBars === 12 &&
            // `optimistic` has no vertical barrier, so its label horizon is 1; adopting
            // it would silently re-create the horizon-1 artefact of BUGS.md #58.
            swCfg({ _labelHorizonBars: 1 }).horizonBars === null &&
            swCfg({ _sampleWeightHorizon: Infinity }).horizonBars === null &&
            swCfg({ _sampleWeightHorizon: 0 }).horizonBars === null);
        check('R28 (P1c): --sample-weight-horizon is threaded onto the controller (null when absent, never NaN)',
            (() => {
                const mk = (over) => makeControllerModelFactory({
                    HiveMind: FakeMind, HiveMindController: FakeController,
                    stateDir: path.join('.nl-analyze-test', 'models'), seed: 5, warmup: 0, ...over,
                });
                mk({ sampleWeightHorizon: 7 })(resolveVariant('baseline')).fit([0, 1], [2], ctlView);
                const withHorizon = FakeController.instances.at(-1)._sampleWeightHorizon;
                mk({ sampleWeightHorizon: Infinity })(resolveVariant('baseline')).fit([0, 1], [2], ctlView);
                const noHorizon = FakeController.instances.at(-1)._sampleWeightHorizon;
                return withHorizon === 7 && noHorizon === null;
            })());

        // P3 arm C: the SCALE-CONTROL. Same spans, no dispersion — so a harmful
        // sample-weights verdict can be attributed to dispersion rather than to the
        // silent learning-rate shift (the round-27 Step-3 confound, BUGS.md #54).
        const scaleVariant = resolveVariant('sample-weights-scale-control');
        const scaleCtl = { _sampleWeightHorizon: 9 };
        applyVariant(scaleCtl, scaleVariant);
        const swCtl = { _sampleWeightHorizon: 9 };
        applyVariant(swCtl, resolveVariant('sample-weights'));
        check('R28 (P3/BUGS.md #54): the scale-control arm exists, is opt-in, and differs from sample-weights ONLY in the emitted normalisation',
            !!scaleVariant && scaleVariant.controllerScoped === true && scaleVariant.appliesTo === 'controller' &&
            OPT_IN_VARIANTS.length === 2 && !ALL_VARIANTS.some((v) => v.id === 'sample-weights-scale-control') &&
            listVariants('controller').find((r) => r.id === 'sample-weights-scale-control').inDefaultRoster === false &&
            scaleCtl._sampleWeightConfig.emittedNormalization === 'scale' &&
            swCtl._sampleWeightConfig.emittedNormalization === 'mean1' &&
            JSON.stringify({ ...scaleCtl._sampleWeightConfig, emittedNormalization: null }) ===
                JSON.stringify({ ...swCtl._sampleWeightConfig, emittedNormalization: null }),
            JSON.stringify({ scale: scaleCtl._sampleWeightConfig, sw: swCtl._sampleWeightConfig }));

        // P1a′: the inert reason is the MEASURED cause, never the labeller's name.
        const swModelBlock = { sampleWeights: { count: 100, min: 1, max: 1, mean: 1, meanUnnormalised: 1, horizonBars: 1, measureHorizon: false, effectiveFraction: 1 } };
        const heldBlock = { heldBars: { count: 4369, mean: 8.301, max: 54 } };
        const swReasonFixed = inertReasonFor(resolveVariant('sample-weights'), { modelBlock: swModelBlock, baselineModelBlock: heldBlock });
        const swReasonMeasured = inertReasonFor(resolveVariant('sample-weights'), {
            modelBlock: { sampleWeights: { count: 10, min: 1, max: 1, mean: 1, meanUnnormalised: 2.45, horizonBars: 8, measureHorizon: true, effectiveFraction: 1 } },
            baselineModelBlock: heldBlock,
        });
        check('R28 (BUGS.md #58): the sample-weights inert reason names the ASSUMED span horizon and the MEASURED holding period — never "the labeller emits one-bar labels"',
            /FIXED span horizon of 1 bar/.test(swReasonFixed) &&
            /mean 8\.30 \/ max 54/.test(swReasonFixed) &&
            /ASSUMED horizon, not of the labeller/.test(swReasonFixed) &&
            /BUGS\.md #58/.test(swReasonFixed) &&
            !/labeller emits one-bar labels/.test(swReasonFixed) &&
            !/no two label spans overlap/.test(swReasonFixed) &&
            // A MEASURED horizon that still yields all-ones is a real property of this
            // run's trade timing, and the reason must say that instead.
            /MEASURED \(causal EMA/.test(swReasonMeasured) &&
            /no two assumed spans overlapped/.test(swReasonMeasured) &&
            !/ASSUMED horizon, not of the labeller/.test(swReasonMeasured),
            JSON.stringify({ fixed: swReasonFixed, measured: swReasonMeasured }));
        check('R28 (BUGS.md #58): the reason degrades honestly when the run carries no sample-weight block at all',
            (() => {
                const r = inertReasonFor(resolveVariant('sample-weights'), {});
                return /span horizon of 1 bar/.test(r) && /every emitted weight was exactly 1/.test(r) && !/undefined/.test(r) && !/NaN/.test(r);
            })());

        // The shipped gate: the raw fold fractions are reported, never gated.
        check('R28 (BUGS.md #57): the shipped dependence gate reports the raw fold fractions but does not gate on them',
            rep.gateOptions.rawFoldHurdles === false &&
            rep.candidates.filter((c) => c.active).every((c) => Array.isArray(c.hurdles) &&
                c.hurdles.filter((h) => h.hurdle === 'foldWinFraction' || h.hurdle === 'positiveFoldFraction').every((h) => h.gated === false)) &&
            !rep.candidates.some((c) => (c.reasons || []).some((r) => /fold win fraction/.test(r))),
            JSON.stringify({ raw: rep.gateOptions.rawFoldHurdles, rows: rep.candidates.filter((c) => c.active).map((c) => [c.id, (c.hurdles || []).filter((h) => !h.gated).map((h) => h.hurdle)]) }).slice(0, 300));
        check('R28 (BUGS.md #55): every candidate row carries its hurdle ledger and the tightest one',
            rep.candidates.every((c) => (c.hurdles === null || Array.isArray(c.hurdles)) &&
                (c.tightestHurdle === null || (typeof c.tightestHurdle.hurdle === 'string' && typeof c.tightestHurdle.gated === 'boolean'))) &&
            rep.candidates.filter((c) => c.active && !c.promote).some((c) => c.tightestHurdle && c.tightestHurdle.margin != null),
            JSON.stringify(rep.candidates.filter((c) => c.active).map((c) => [c.id, c.tightestHurdle && c.tightestHurdle.hurdle, c.tightestHurdle && c.tightestHurdle.margin])));

        // ---- R26-13: seed replication + common random numbers ---------------
        // A single-seed ordering is not a ranking: seed-to-seed variation routinely
        // exceeds the variation attributed to the compared factor (Bouthillier et al.
        // 2019; Henderson et al. 2018). CRN (Glasserman & Yao 1992) pairs the variant
        // comparison on the random draws so the variance of the DIFFERENCE falls.
        // The fold seed is observable because the model's constructor draws from the
        // seeded `Math.random` that `withSeed` installs.
        class RandMind {
            constructor() { this.r = Math.random(); this.trained = 0; RandMind.instances.push(this); }
            train() { this.trained++; return 0; }
            predict() { return 0.5; }
        }
        RandMind.instances = [];
        const mkRandFactory = (over) => makeHiveMindModelFactory({
            HiveMind: RandMind, stateDir: path.join('.nl-analyze-test', 'models'), seed: 7, ...over,
        });
        const fitArgs = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11]];
        mkRandFactory({})(resolveVariant('surprise')).fit(...fitArgs, retsView);
        mkRandFactory({})(resolveVariant('querymod')).fit(...fitArgs, retsView);
        check('R26-13: with CRN on the per-fold seed is variant-independent (both variants draw the same init)',
            RandMind.instances.length === 2 && RandMind.instances[0].r === RandMind.instances[1].r,
            JSON.stringify(RandMind.instances.map((m) => m.r)));
        mkRandFactory({ commonRandomNumbers: false })(resolveVariant('surprise')).fit(...fitArgs, retsView);
        mkRandFactory({ commonRandomNumbers: false })(resolveVariant('querymod')).fit(...fitArgs, retsView);
        check('R26-13: with CRN off the historical per-variant seed is restored (the two variants draw differently)',
            RandMind.instances.length === 4 && RandMind.instances[2].r !== RandMind.instances[3].r);
        mkRandFactory({})(resolveVariant('surprise')).fit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [12, 13], retsView);
        check('R26-13: under CRN the seed still varies per fold (testStart enters the seed)',
            RandMind.instances[4].r !== RandMind.instances[0].r);
        check('R26-13: the controller factory threads CRN too (default on, off restores per-variant seeds)',
            (() => {
                class SeedCtl extends FakeController {
                    constructor(...a) { super(...a); this._rand = Math.random(); }
                }
                const mkCtl = (over) => makeControllerModelFactory({
                    HiveMind: FakeMind, HiveMindController: SeedCtl,
                    stateDir: path.join('.nl-analyze-test', 'models'), seed: 7, warmup: 0, ...over,
                });
                const onA = mkCtl({})(resolveVariant('surprise')); onA.fit([0, 1], [2], ctlView);
                const onB = mkCtl({})(resolveVariant('querymod')); onB.fit([0, 1], [2], ctlView);
                const offA = mkCtl({ commonRandomNumbers: false })(resolveVariant('surprise')); offA.fit([0, 1], [2], ctlView);
                const offB = mkCtl({ commonRandomNumbers: false })(resolveVariant('querymod')); offB.fit([0, 1], [2], ctlView);
                const rows = SeedCtl.instances.slice(-4).map((c) => c._rand);
                return rows[0] === rows[1] && rows[2] !== rows[3];
            })());

        check('R26-13: runAnalysis defaults to common random numbers and records it in the report + summary',
            rep.commonRandomNumbers === true && rep.summary.includes('crn=true'));
        const crnOffRun = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, commonRandomNumbers: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-13: --crn=0 is recorded honestly (report false, summary crn=false) and changes the seeds',
            crnOffRun.report.commonRandomNumbers === false && crnOffRun.report.summary.includes('crn=false') &&
            crnOffRun.report.baseline.pooledMetrics.netSharpe !== undefined);
        check('R26-13: every row carries the per-fold net-Sharpe series (the seed x fold panel input)',
            Array.isArray(rep.baseline.foldSharpes) && rep.baseline.foldSharpes.length === rep.folds &&
            rep.candidates.every((c) => Array.isArray(c.foldSharpes) && c.foldSharpes.length === rep.folds));
        const repRuns = await replicateAnalysis({
            seeds: [11, 12], file: worldFile, maxBars: 120, trainSize: 60, testSize: 15,
            stateFolder: path.join(dir, 'state'), model: 'controller', writeFiles: false, audit: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-13: replicateAnalysis runs once per seed and aggregates each variant\'s seed distribution',
            repRuns.runs.length === 2 && repRuns.replication.seeds.join(',') === '11,12' &&
            repRuns.replication.byVariant.baseline && repRuns.replication.byVariant.baseline.available === true &&
            repRuns.replication.byVariant.baseline.seeds.length === 2 &&
            repRuns.replication.byVariant.baseline.ci.available === true &&
            repRuns.replication.byVariant.baseline.components.available === true &&
            repRuns.replication.commonRandomNumbers === true &&
            repRuns.runs.every((r) => r.report.commonRandomNumbers === true),
            JSON.stringify({ seeds: repRuns.replication.seeds, n: repRuns.replication.byVariant.baseline.n }));
        check('R26-13: replicateAnalysis refuses an empty seed list',
            await (async () => {
                try {
                    await replicateAnalysis({
                        seeds: [], writeFiles: false, file: worldFile,
                        HiveMind: FakeMind, HiveMindController: VaryCtl,
                    });
                    return false;
                } catch { return true; }
            })());

        // ---- R26-14: the forecast-comparison block --------------------------
        // The family scored as forecasters: proper scores per variant + the
        // Diebold–Mariano test vs baseline + the family Model Confidence Set. Pure
        // post-processing of the journaled confidence, so it moves no scored number.
        check('R26-14: the run carries the forecast block by default (scores for every ACTIVE variant, grouped by forecast kind)',
            rep.forecast && rep.forecast.available === true && rep.forecast.bars > 0 &&
            rep.forecast.byId.baseline && rep.forecast.mcs.at90.available && rep.forecast.mcs.at95.available &&
            rep.forecast.mcs.at90.memberIds.length > 0 &&
            rep.forecast.mcs.at90.memberIds.every((id) => rep.forecast.byId[id]) &&
            rep.candidates.filter((c) => c.active).every((c) => rep.forecast.byId[c.id] &&
                Number.isFinite(rep.forecast.byId[c.id].brier) && Number.isFinite(rep.forecast.byId[c.id].logScore) &&
                // R27-5: the DM test is defined only inside the baseline's kind; a
                // cross-kind candidate carries an explicit reason instead.
                (rep.forecast.byId[c.id].kind === rep.forecast.kind
                    ? rep.forecast.byId[c.id].dm.available === true
                    : rep.forecast.byId[c.id].dm.available === false && typeof rep.forecast.byId[c.id].dm.reason === 'string')),
            JSON.stringify({ bars: rep.forecast && rep.forecast.bars, m90: rep.forecast && rep.forecast.mcs.at90.memberIds }));
        check('R26-14: the run summary renders the forecast line and both MCS sets',
            rep.summary.includes('forecast:') && rep.summary.includes('mcs90=[') && rep.summary.includes('mcs95=['));
        // R27-5: the forecast family is scored WITHIN a kind. The controller
        // family's journaled confidence is `confidenceFromProb(prob)`, which the
        // affine `(c+1)/2` inverts exactly; a signal's is a normalised z-score.
        // Mixing them would score a probability against a z-score, so each kind
        // gets its own MCS and the DM-vs-baseline is defined only inside the
        // baseline's (controller) kind.
        const fcSigCand = rep.candidates.find((c) => c.active && c.kind === 'signal');
        const fcCross = rep.candidates.filter((c) => c.active && c.kind === 'signal');
        const fcSame = rep.candidates.filter((c) => c.active && c.kind !== 'signal');
        check('R27-5: the forecast block groups by forecast kind, one MCS per kind, controller first',
            rep.forecast.kind === 'controller' && rep.forecast.baselineId === 'baseline' &&
            rep.forecast.kinds.map((g) => g.kind).join(',') === 'controller,signal' &&
            rep.forecast.kinds.find((g) => g.kind === 'controller').n === 1 + rep.candidates.filter((c) => c.active && c.kind !== 'signal').length &&
            rep.forecast.kinds.find((g) => g.kind === 'signal').n === rep.candidates.filter((c) => c.active && c.kind === 'signal').length &&
            rep.forecast.byKind.controller.mcs.at90.available && rep.forecast.byKind.signal.mcs.at90.available &&
            rep.forecast.reader.includes('grouped by `kind`'),
            JSON.stringify(rep.forecast.kinds));
        check('R27-5: the DM test is defined only inside the baseline kind; every cross-kind candidate states why',
            !!fcSigCand && fcCross.length > 0 &&
            fcCross.every((c) => rep.forecast.byId[c.id].kind === 'signal' &&
                rep.forecast.byId[c.id].dm.available === false && rep.forecast.byId[c.id].dm.reason.includes('cross-kind')) &&
            fcSame.every((c) => rep.forecast.byId[c.id].kind === 'controller' && rep.forecast.byId[c.id].dm.available === true),
            JSON.stringify({ active: rep.candidates.filter((c) => c.active).map((c) => [c.id, c.kind]) }));
        check('R27-5: the forecast summary names the grouped roster',
            rep.summary.includes('groups: controller(') && rep.summary.includes('signal('));
        const fcOff = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, forecast: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-14: forecast=false nulls the block and drops the summary line, changing no scored number',
            fcOff.report.forecast === null && !fcOff.report.summary.includes('mcs90') &&
            fcOff.report.baseline.pooledMetrics.netSharpe === rep.baseline.pooledMetrics.netSharpe &&
            JSON.stringify(fcOff.report.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe])) ===
            JSON.stringify(rep.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe])));

        // ---- R26-8: the decision-grade report --------------------------------
        // Six question blocks composed from the numbers above (nothing recomputed),
        // every field a value or an explicit { available:false, reason }. On by
        // default; `decision:false` nulls the block and moves no scored number.
        check('R26-8: the run carries the six-question decision block by default',
            rep.decisionEnabled === true && rep.decision && rep.decision.schema === 'nl.decision.v1' &&
            !!rep.decision.training && !!rep.decision.edge && !!rep.decision.concentration &&
            !!rep.decision.economics && !!rep.decision.family && !!rep.decision.nextRun,
            JSON.stringify(Object.keys(rep.decision || {})));
        check('R26-8: the featured candidate is a real one and the composed blocks are the run own blocks',
            rep.candidates.some((c) => c.id === rep.decision.verdict.candidateId) &&
            rep.decision.economics.costLadder === rep.costLadder &&
            rep.decision.edge.familyCorrelation === rep.familyCorrelation &&
            rep.decision.family.forecast === rep.forecast,
            JSON.stringify({ featured: rep.decision.verdict.candidateId, cands: rep.candidates.map((c) => c.id) }));
        check('R26-8: the run summary renders the decision, concentration and next-run lines',
            rep.summary.includes('decision:') && rep.summary.includes('concentration:') && rep.summary.includes('nextRun:'));
        const decOff = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state'),
            model: 'controller', writeFiles: false, audit: false, decision: false,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-8: decision=false nulls the block and drops the summary lines, changing no scored number',
            decOff.report.decision === null && decOff.report.decisionEnabled === false &&
            !decOff.report.summary.includes('nextRun:') &&
            JSON.stringify(decOff.report.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe])) ===
            JSON.stringify(rep.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe])));
        // R26-10 item 10: the report-completeness contract — every sub-block of the
        // decision states its own availability, and an unavailable one names a reason.
        const decisionBlocks = [
            rep.decision.training.model, rep.decision.concentration,
            rep.decision.economics.costLadder, rep.decision.economics.confidence,
            rep.decision.family.forecast, rep.decision.family.seedDistribution,
            rep.decision.family.varianceComponents, rep.decision.family.pairedVarianceRatio,
            rep.decision.nextRun,
        ];
        check('R26-10: every decision sub-block states availability and every unavailable one carries a reason',
            ['training', 'edge', 'concentration', 'economics', 'family', 'nextRun'].every((k) => rep.decision[k] && typeof rep.decision[k] === 'object') &&
            decisionBlocks.every((b) => b && typeof b === 'object' && (b.available !== false || (typeof b.reason === 'string' && b.reason.length > 0))),
            JSON.stringify(decisionBlocks.map((b) => (b && b.available === false ? b.reason : `available:${b && b.available}`))));
        // R26-8 clause 6 + the R26-3 journal, end-to-end on a real MULTI-STREAM run
        // (not just the unit fixture): the paired sizing must read the paired SE and
        // the cluster count from the report's own `promotionTest`, and the decay
        // readout must find the journaled confidence. This is exactly the shape a
        // bare-number unit fixture cannot see (BUGS.md #38).
        check('R26-8: a multi-stream run populates the paired sizing, the journal decay and the leave-one-fold range',
            msRep.decision.nextRun.pairedUnits.available === true &&
            Number.isFinite(msRep.decision.nextRun.pairedUnits.se) &&
            msRep.decision.nextRun.pairedUnits.nClusters >= 2 &&
            msRep.decision.nextRun.pairedUnits.neededForObserved != null &&
            msRep.decision.nextRun.pairedUnits.needed.observed === msRep.decision.nextRun.pairedUnits.neededForObserved &&
            msRep.decision.economics.confidence.available === true &&
            msRep.decision.concentration.deleteOneCluster.available === true,
            JSON.stringify({
                pairedUnits: {
                    neededForObserved: msRep.decision.nextRun.pairedUnits.neededForObserved,
                    neededForMde95Dependent: msRep.decision.nextRun.pairedUnits.neededForMde95Dependent,
                },
                confidenceAvailable: msRep.decision.economics.confidence.available,
                looAvailable: msRep.decision.concentration.deleteOneCluster.available,
            }));

        // ---- R26-4: the concurrent A/B driver -------------------------------
        // A fake `spawnWorker` runs the fold inline with the SAME injected fakes
        // (exactly what `fold_worker.js` does with the real modules), so the report
        // must be byte-identical to the serial run apart from wall-time `timings`.
        // This pins the whole parallel wiring in the browser; the real worker is
        // covered by the node-only test.
        const inlineFold = (req) => {
            const stateDir = fs.mkdtempSync(path.join(dir, 'fold-'));
            const factory = makeControllerModelFactory({
                HiveMind: FakeMind, HiveMindController: VaryCtl, stateDir, seed: req.seed,
                cacheSize: req.cacheSize, ensembleSize: req.ensembleSize, tier: req.tier, warmup: req.warmup,
                positionPolicy: req.positionPolicy, saveInterval: req.saveInterval,
                labelPolicy: req.labelPolicy, labelHorizonBars: req.labelHorizonBars,
                commonRandomNumbers: req.commonRandomNumbers,
            });
            const view = req.candles ? makeCandleViewFor(req.candles)(req.returns, null) : { returns: req.returns };
            let stats = null;
            const fold = makeSignalForVariant(factory, {
                positionPolicy: req.positionPolicy,
                onStats: (_v, s) => { stats = s; },
            })(resolveVariant(req.variantId));
            const positions = fold(req.train, req.test, view);
            const confidence = typeof fold.confidenceForFold === 'function' ? fold.confidenceForFold() : null;
            return { positions, confidence, stats };
        };
        const fakeSpawn = (url, workerData) => ({
            on(evt, cb) { if (evt === 'message') { Promise.resolve().then(() => cb(inlineFold(workerData))); } return this; },
            terminate() { return Promise.resolve(0); },
        });
        const stripAB = (r) => JSON.stringify({
            candidates: r.candidates.map((c) => ({ id: c.id, promote: c.promote, reasons: c.reasons, model: c.model, pooled: c.pooledMetrics })),
            baseline: { model: r.baseline.model, pooled: r.baseline.pooledMetrics },
        });
        const parRep = await runAnalysis({
            file: worldFile, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(dir, 'state-par'),
            model: 'controller', writeFiles: false, audit: false, concurrency: 3, spawnWorker: fakeSpawn,
            HiveMind: FakeMind, HiveMindController: VaryCtl,
        });
        check('R26-4: runAnalysis @ concurrency 3 reproduces the serial report (same verdict, same per-variant model block)',
            stripAB(parRep.report) === stripAB(rep) && parRep.report.concurrency === 3,
            `concurrency=${parRep.report.concurrency} promote=${JSON.stringify(parRep.report.candidates.map((c) => c.promote))}`);
        check('R26-4: the parallel run still carries a non-null model block for every model variant (the worker stats are pooled)',
            parRep.report.baseline.model && parRep.report.baseline.model.trained === true &&
            parRep.report.variants.filter((v) => v.kind !== 'signal').every((v) => v.model && v.model.trained === true),
            JSON.stringify(parRep.report.baseline.model));
        check('R26-4: a serial run records concurrency 1 (the default is byte-identical)',
            rep.concurrency === 1, `serial concurrency=${rep.concurrency}`);

        // The dispatcher contract: an injected spawn returns the fold reply, a
        // malformed reply rejects, and a worker `{error}` rejects with the reason.
        const dispatcher = makeNodeFoldDispatcher({
            url: 'file:///fake/fold_worker.js',
            spawn: (u, wd) => ({
                on(evt, cb) { if (evt === 'message') { Promise.resolve().then(() => cb({ positions: [1, 0, -1], confidence: [0.1, 0, -0.1], stats: { folds: 1 } })); } return this; },
                terminate() { return Promise.resolve(0); },
            }),
        });
        const dispatched = await dispatcher({ variantId: 'baseline', streamIndex: 0, foldIndex: 0 });
        check('R26-4: makeNodeFoldDispatcher resolves a well-formed fold reply (positions/confidence/stats)',
            JSON.stringify(dispatched.positions) === '[1,0,-1]' && dispatched.stats.folds === 1);
        let dispatcherBad = false;
        try {
            await makeNodeFoldDispatcher({
                url: 'file:///fake/fold_worker.js',
                spawn: (u, wd) => ({ on(evt, cb) { if (evt === 'message') Promise.resolve().then(() => cb({ nope: 1 })); return this; }, terminate() { return Promise.resolve(0); } }),
            })({ variantId: 'baseline', streamIndex: 0, foldIndex: 0 });
        } catch { dispatcherBad = true; }
        check('R26-4: makeNodeFoldDispatcher rejects a malformed fold reply', dispatcherBad);
        let dispatcherErr = false;
        try {
            await makeNodeFoldDispatcher({
                url: 'file:///fake/fold_worker.js',
                spawn: (u, wd) => ({ on(evt, cb) { if (evt === 'message') Promise.resolve().then(() => cb({ error: 'fold blew up' })); return this; }, terminate() { return Promise.resolve(0); } }),
            })({ variantId: 'baseline', streamIndex: 0, foldIndex: 0 });
        } catch (err) { dispatcherErr = /fold blew up/.test(String(err && err.message)); }
        check('R26-4: a worker {error} payload rejects with the reason (settle-once dispatch)', dispatcherErr);

        // evaluateABAsync over the injected synthetic family is byte-identical too.
        const abRets = synthReturns(120);
        const abFolds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
        const abVars = mkVariants();
        const abSignals = signalsFor();
        const abSerial = evaluateAB({ returns: abRets, folds: abFolds, variants: abVars, signalForVariant: (v) => abSignals[v.id], costBps: 1, audit: false });
        const abAsync = await evaluateABAsync({
            returns: abRets, folds: abFolds, variants: abVars, signalForVariant: (v) => abSignals[v.id], costBps: 1, audit: false,
            concurrency: 4,
            foldExecutorFor: (variant) => async ({ train, test }) => ({ signals: abSignals[variant.id](train, test, { returns: abRets }), confidence: null }),
        });
        // With the audit ON and a worker executor in play, the scored pass is remote
        // but the audit re-fits PERTURBED views in-process, so it still needs the
        // folded signal function — a concurrent run with the default audit crashed
        // here before `evaluateABAsync` supplied it (BUGS.md #42).
        const abSerialA = evaluateAB({ returns: abRets, folds: abFolds, variants: abVars, signalForVariant: (v) => abSignals[v.id], costBps: 1, audit: true, auditProbesPerFold: 1 });
        const abAsyncA = await evaluateABAsync({
            returns: abRets, folds: abFolds, variants: abVars, signalForVariant: (v) => abSignals[v.id], costBps: 1, audit: true, auditProbesPerFold: 1,
            concurrency: 4,
            foldExecutorFor: (variant) => async ({ train, test }) => ({ signals: abSignals[variant.id](train, test, { returns: abRets }), confidence: null }),
        });
        const stripEval = (r) => JSON.stringify({
            baseline: { pooledMetrics: r.baseline.pooledMetrics, aggregate: r.baseline.aggregate, audit: r.baseline.audit },
            candidates: r.candidates.map((c) => ({ id: c.variant.id, promote: c.decision.promote, reasons: c.decision.reasons, pooledMetrics: c.report.pooledMetrics })),
            search: r.search,
        });
        check('R26-4: evaluateABAsync (concurrency 4, injected executor) is byte-identical to evaluateAB apart from wall-time (audit off and on)',
            stripEval(abAsync) === stripEval(abSerial) && stripEval(abAsyncA) === stripEval(abSerialA));

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
        q1Run.modelRetention === 'discard' && q1Run.requireReachable === true && q1Run.foldLog === 'all' &&
        q1Run.reuseBase === false && q1Run.costBps === 0 &&
        q1Run.folds === 4 && Array.isArray(q1Run.variants) && q1Run.variants.length === 14,
        JSON.stringify({ retention: q1Run.modelRetention, folds: q1Run.folds, variants: q1Run.variants.length }));
    const q1Rep = qReadJson(q1.runDir, 'report.json');
    check('R26-12: run.json and report.json record the checkpoint throttle (the A/B default is the never-dump "inf")',
        q1Run.saveInterval === 'inf' && q1Rep.saveInterval === 'inf',
        JSON.stringify({ run: q1Run.saveInterval, report: q1Rep.saveInterval }));
    check('R26-11: run.json and report.json record the label policy and the (absent) triple-barrier horizon',
        q1Run.labelPolicy === 'optimistic' && q1Run.labelHorizonBars === null && q1Run.labelPolicies === false &&
        q1Rep.labelPolicy === 'optimistic' && q1Rep.labelHorizonBars === null,
        JSON.stringify({ run: q1Run.labelPolicy, horizon: q1Run.labelHorizonBars, roster: q1Run.labelPolicies }));
    check('R26-5: run.json records the turnover attack as off by default (and a null target)',
        q1Run.turnoverSweep === false && q1Run.turnoverTarget === null &&
        q1Rep.turnoverSweep === null && q1Rep.turnoverTargetBps === null,
        JSON.stringify({ run: q1Run.turnoverSweep, target: q1Run.turnoverTarget }));
    check('R26-6: run.json records the raw interval and no stream selection by default',
        q1Run.intervalBars === 1 && q1Run.streamSelect === false && q1Rep.intervalBars === 1 && q1Rep.streamSelection === null,
        JSON.stringify({ interval: q1Run.intervalBars, select: q1Run.streamSelect }));
    check('report.json is the canonical complete verdict with the machine-readable audit block',
        q1Rep.status === 'complete' && q1Rep.schema === 'nl.analyze.v1' && q1Rep.candidates.length === 13 &&
        !!q1Rep.baseline.audit && typeof q1Rep.baseline.audit.clean === 'boolean' && typeof q1Rep.baseline.audit.probes === 'number' &&
        typeof q1Rep.candidates[0].audit.clean === 'boolean' && !!q1Rep.familywise && typeof q1Rep.reader === 'string' && !!q1Rep.artifacts);
    const q1Part = qReadJson(q1.runDir, 'partial-report.json');
    check('partial-report.json is the per-variant checkpoint, matching the final report row counts',
        q1Part.status === 'complete' && q1Part.schema === 'nl.analyze.v1' && q1Part.candidates.length === 13 && q1Part.variants.length === 14);
    // R27-5: the FIRST checkpoint carries the full config echo, so a kill-and-recover
    // reader can reconstruct the run's design (gate, K, throttle, label, concurrency,
    // resampling, CRN, selection floor) without guessing it from the code.
    check('R27-5: partial-report.json carries the run config echo in its checkpoint',
        q1Part.gate === 'dependence' && q1Part.gateOptions && q1Part.gateOptions.requireSharpeDiff === true &&
        q1Part.trials === q1Rep.trials && q1Part.variantsTotal === 14 && q1Part.saveInterval === 'inf' && q1Part.labelPolicy === 'optimistic' &&
        q1Part.labelHorizonBars === null && Number.isFinite(q1Part.concurrency) &&
        q1Part.intervalBars === 1 && q1Part.commonRandomNumbers === true && q1Part.streamSelection === null &&
        q1Part.turnoverSweep === false && q1Part.minTrainingSteps === 1 &&
        Object.prototype.hasOwnProperty.call(q1Part, 'policyRoundTrip'),
        JSON.stringify({ gate: q1Part.gate, reqSharpe: q1Part.gateOptions && q1Part.gateOptions.requireSharpeDiff, trials: q1Part.trials, repTrials: q1Rep.trials,
            vt: q1Part.variantsTotal, save: q1Part.saveInterval, lp: q1Part.labelPolicy, lh: q1Part.labelHorizonBars, conc: q1Part.concurrency,
            iv: q1Part.intervalBars, crn: q1Part.commonRandomNumbers, ss: q1Part.streamSelection, ts: q1Part.turnoverSweep,
            prt: typeof q1Part.policyRoundTrip, min: q1Part.minTrainingSteps }));
    // R27-5: the per-variant checkpoint in run.log names the variant's KIND and its
    // wall time, so a long run's log is self-describing.
    check('R27-5: run.log variant checkpoints name the variant kind and its elapsed time',
        (() => {
            const log = fs.readFileSync(path.join(q1.runDir, 'run.log'), 'utf8').trim().split('\n')
                .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            const vc = log.filter((r) => r.message === 'progress' && r.data && r.data.phase === 'variant-checkpoint');
            return vc.length === 14 && vc.every((r) => typeof r.data.variantId === 'string' && typeof r.data.kind === 'string' && Number.isFinite(r.data.elapsedMs));
        })());
    const q1Prog = qReadJson(q1.runDir, 'progress.json');
    check('progress.json is a complete heartbeat (every budgeted pass accounted for)',
        q1Prog.phase === 'complete' && q1Prog.counters.events === q1Prog.counters.eventsTotal && q1Prog.counters.eventsTotal === 224 &&
        q1Prog.reuseBase === false && q1Prog.costBps === 0,
        JSON.stringify(q1Prog.counters));
    const q1Folds = fs.readFileSync(path.join(q1.runDir, 'folds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('folds.jsonl is a self-contained fold journal (one line per pass, matching the heartbeat)',
        q1Folds.length === q1Prog.counters.events &&
        q1Folds.every((r) => typeof r.stage === 'string' && typeof r.v === 'string' && Number.isFinite(r.fold)));
    // R26-3: the journal now carries the raw pre-policy confidence beside the emitted
    // positions, and the scored policy must reproduce those positions exactly.
    check('R26-3: folds.jsonl journals the raw pre-policy confidence beside the emitted positions',
        (() => {
            const score = q1Folds.filter((r) => r.stage === 'score');
            return score.length > 0 && score.every((r) => Array.isArray(r.confidence) && Array.isArray(r.signals) &&
                r.confidence.length === r.signals.length && r.confidence.every((c) => Number.isFinite(c) && c >= -1 && c <= 1));
        })());
    check('R26-3: report.json carries the byte-for-byte policy round-trip certificate and the unified policy',
        q1Rep.policyRoundTrip && q1Rep.policyRoundTrip.ok === true && q1Rep.policyRoundTrip.mismatch === 0 &&
        JSON.stringify(q1Rep.positionPolicy) === JSON.stringify({ deadZone: 0.05, scale: 1 }),
        JSON.stringify({ roundTrip: q1Rep.policyRoundTrip, policy: q1Rep.positionPolicy }));
    check('R26-3: restating the baseline at the scored policy reproduces its pooled Sharpe (the sweep is pure post-processing)',
        (() => {
            const scored = restateReportAtPolicy(q1.result.baseline, { deadZone: 0.05, scale: 1 });
            return !!scored && Math.abs(scored.pooledMetrics.netSharpe - q1.result.baseline.pooledMetrics.netSharpe) < 1e-12;
        })());
    check('R26-3: a wider dead zone abstains at least as much (the policy genuinely reaches the signals, not only the controller)',
        (() => {
            const scored = restateReportAtPolicy(q1.result.baseline, { deadZone: 0.05, scale: 1 });
            const wider = restateReportAtPolicy(q1.result.baseline, { deadZone: 0.5, scale: 1 });
            return !!scored && !!wider && wider.pooledMetrics.nonZeroFraction <= scored.pooledMetrics.nonZeroFraction &&
                confidenceToPosition(confidenceFromProb(52), { deadZone: 0.05 }) === 0 &&
                confidenceToPosition(confidenceFromProb(60), { deadZone: 0.05 }) > 0;
        })());
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

    const q8 = await runAnalysis({
        file: qWorld, maxBars: 120, trainSize: 60, testSize: 15, stateFolder: path.join(qDir, 's8'),
        variantIds: ['sig-momentum'], model: 'controller', writeFiles: true, audit: false,
        turnoverSweep: true, turnoverTarget: 7, streamSelect: true, progressMs: -1, HiveMind: FakeMind, HiveMindController: DiskCtl,
    });
    const q8Run = qReadJson(q8.runDir, 'run.json');
    const q8Rep = qReadJson(q8.runDir, 'report.json');
    check('R26-5: run.json and report.json persist the turnover sweep (block, target and grid size)',
        q8Run.turnoverSweep === true && q8Run.turnoverTarget === 7 &&
        q8Rep.turnoverSweep && q8Rep.turnoverSweep.available === true && q8Rep.turnoverSweep.targetBps === 7 &&
        q8Rep.turnoverTargetBps === 7 && q8Rep.turnoverSweep.rows.length === 48 &&
        q8Rep.turnoverSweep.rows.every((r) => r.id === 'sig-momentum') &&
        typeof q8Rep.turnoverSweep.targetMet === 'boolean',
        JSON.stringify({ run: q8Run.turnoverSweep, target: q8Run.turnoverTarget, rows: q8Rep.turnoverSweep && q8Rep.turnoverSweep.rows.length }));
    check('R26-6: run.json and report.json persist the interval and the stream selection',
        q8Run.intervalBars === 1 && q8Run.streamSelect === true && q8Rep.intervalBars === 1 &&
        q8Rep.streamSelection && q8Rep.streamSelection.available === true && q8Rep.streamSelection.keep === null &&
        q8Rep.streamSelection.order.length === 1,
        JSON.stringify({ interval: q8Run.intervalBars, select: q8Run.streamSelect }));

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
