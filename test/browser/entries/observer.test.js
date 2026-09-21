// Observer suite (ROADMAP P1-2).
//
// Proves the pure observability layer that watches the *legion's own* health
// (distinct from src/analysis, which scores a strategy's returns):
//   * legion_metrics.js — calibration (Brier + Murphy decomposition), diversity
//                         (entropy/HHI/effective voters/Gini/kappa), drift
//                         (EWMA/CUSUM) and the consensus probability mapping.
//   * alerts.js         — the pure rule engine (compare/firing/resolution).
//   * report.js         — deterministic run-id + spool/report artifacts.
//   * collector.js      — the stateful snapshot collector wired to
//                         state.onBatchSnapshot (read-only w.r.t. the run).
//
// Every metric has an exact reference vector, so the layer is LOCKED-invariant.
// The collector integration feeds synthetic snapshots (no DB, no stream).

import {
    mean, stdev, clamp01, brierScore, baseRate, reliabilityCurve,
    brierDecomposition, shannonEntropy, hhi, effectiveVoters, gini,
    ewmaSeries, cusum, cohensKappa, meanPairwiseKappa, influenceSummary,
    consensusProbability,
} from '../../../src/observer/legion_metrics.js';
import {
    SEVERITIES, DEFAULT_ALERT_RULES, compare, evaluateAlerts, highestSeverity,
} from '../../../src/observer/alerts.js';
import {
    makeRunId, createRunDirectory, pruneRunDirectories, writeJson, readJson,
    appendSnapshot, appendLog, writeReport,
} from '../../../src/observer/report.js';
import { createObserver } from '../../../src/observer/collector.js';
import fs from 'fs';
import path from 'path';
import { state as legionState } from '../../../src/legion/state.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. descriptive ---------------------------------------------------
    check('mean of [] is 0 and of [1,2,3] is 2', mean([]) === 0 && mean([1, 2, 3]) === 2);
    check('stdev is population (not sample)', close(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2));
    check('stdev of <2 samples is 0', stdev([]) === 0 && stdev([5]) === 0);
    check('clamp01 bounds + rejects non-finite', clamp01(-1) === 0 && clamp01(2) === 1 && clamp01(0.4) === 0.4 && clamp01(NaN) === 0);

    // ---- B. Brier score ---------------------------------------------------
    check('brier: perfect forecast is 0', brierScore([1, 0, 1, 0], [1, 0, 1, 0]) === 0);
    check('brier: confidently wrong is 1', brierScore([1, 0, 1, 0], [0, 1, 0, 1]) === 1);
    check('brier: constant 0.5 forecast is 0.25', brierScore([1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5]) === 0.25);
    check('brier: mismatched/empty inputs degrade to 0', brierScore([1, 0], [0.5]) === 0 && brierScore([], []) === 0 && brierScore(null, null) === 0);
    check('brier: non-finite prob treated as 0', close(brierScore([0], [NaN]), 0));

    // ---- C. base rate + reliability curve ---------------------------------
    check('baseRate counts positives', baseRate([1, 0, 1, 1]) === 0.75);
    const curve = reliabilityCurve([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9], 10);
    check('reliabilityCurve has one cell per bin', curve.length === 10);
    check('reliabilityCurve bins assign by floor(p*k)', curve[1].n === 1 && curve[2].n === 1 && curve[8].n === 1 && curve[9].n === 1);
    check('reliabilityCurve reports meanProb/meanOutcome per bin', close(curve[8].meanProb, 0.8) && curve[8].meanOutcome === 1);
    check('reliabilityCurve empty on bad input', reliabilityCurve(null, null).length === 0);

    // ---- D. Murphy decomposition: the identity is EXACT -------------------
    const o = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    const p = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
    const d = brierDecomposition(o, p, 10);
    check('decomposition: Brier = REL - RES + UNC + WITHIN (exact)',
        close(d.brier, d.reliability - d.resolution + d.uncertainty + d.within, 1e-12),
        JSON.stringify({ brier: d.brier, rel: d.reliability, res: d.resolution, unc: d.uncertainty, within: d.within }));
    check('decomposition: uncertainty = baseRate*(1-baseRate)', close(d.uncertainty, 0.25) && close(d.baseRate, 0.5));
    check('decomposition: reliability is the exact per-bin meanProb error', close(d.reliability, 0.3825, 1e-12));
    check('decomposition: empty input degrades cleanly', brierDecomposition([], []).brier === 0);

    // ---- E. diversity: entropy / HHI / effective voters / Gini ------------
    check('entropy: 4 equal weights = 2 bits', close(shannonEntropy([1, 1, 1, 1]), 2));
    check('entropy: a single holder = 0 bits', shannonEntropy([1, 0, 0, 0]) === 0 && shannonEntropy([5]) === 0);
    check('entropy: [1,3] = 0.8112781 bits', close(shannonEntropy([1, 3]), 0.8112781244591328, 1e-12));
    check('entropy: all-zero / empty = 0', shannonEntropy([0, 0]) === 0 && shannonEntropy([]) === 0);
    check('entropy: scale invariant', close(shannonEntropy([10, 30]), shannonEntropy([1, 3])));
    check('hhi: 4 equal = 0.25, single = 1', close(hhi([1, 1, 1, 1]), 0.25) && hhi([9]) === 1);
    check('effectiveVoters = 1/HHI', close(effectiveVoters([1, 1, 1, 1]), 4) && close(effectiveVoters([1, 1, 2]), 1 / 0.375, 1e-12));
    check('gini: equal values = 0', gini([5, 5, 5]) === 0 && gini([1, 1, 1, 1]) === 0);
    check('gini: [0,1] = 0.5 (maximally unequal for n=2)', close(gini([0, 1]), 0.5));
    check('gini: zero-total = 0', gini([0, 0, 0]) === 0);

    // ---- F. EWMA + CUSUM --------------------------------------------------
    const ew = ewmaSeries([1, 2, 3], 0.5);
    check('ewma seeds with x0 then lags toward x', ew.length === 3 && close(ew[0], 1) && close(ew[1], 1.5) && close(ew[2], 2.25));
    check('ewma of empty = []', ewmaSeries([]).length === 0);
    const cu = cusum([0, 0, 0, 0, 0, 0, 3, 3, 3, 3], { target: 0, k: 0.5, h: 5, sigma: 1 });
    check('cusum: no alarm on a flat series', cusum([0, 0, 0], { h: 5 }).alarmIndex === -1);
    check('cusum: a sustained upward shift alarms at index 8', cu.alarmIndex === 8, JSON.stringify(cu.positive));
    check('cusum: alarm direction is up', cu.direction === 'up');
    check('cusum: statistic stays at 0 while below target', cu.positive[5] === 0);
    check('cusum: downward shift alarms with direction down',
        cusum([0, 0, 0, 0, 0, 0, -3, -3, -3, -3], { h: 5 }).direction === 'down');
    check('cusum: empty input is safe', cusum([]).alarmIndex === -1 && cusum(null).alarms.length === 0);

    // ---- G. Cohen's kappa + ensemble agreement ----------------------------
    check('kappa: perfect agreement = 1', cohensKappa([1, 1, 0, 0], [1, 1, 0, 0]) === 1);
    check('kappa: total disagreement = -1', close(cohensKappa([1, 0, 1, 0], [0, 1, 0, 1]), -1));
    check('kappa: degenerate all-agree constant = 1 (pe=1 guard)', cohensKappa([1, 1, 1], [1, 1, 1]) === 1);
    check('kappa: mismatched lengths = 0', cohensKappa([1, 0], [1, 0, 1]) === 0);
    const kp = meanPairwiseKappa([[1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 1, 1]]);
    check('meanPairwiseKappa averages all pairs', kp.pairs === 3 && close(kp.mean, -1 / 3, 1e-12) && kp.min === -1 && kp.max === 1);

    // ---- H. influence summary + consensus probability ---------------------
    const inf = influenceSummary({ positive: { voters: [{ influence: 1 }, { influence: 1 }] }, negative: { voters: [{ influence: 2 }] } });
    check('influenceSummary counts every voter', inf.count === 3);
    check('influenceSummary HHI over shares', close(inf.hhi, 0.375) && close(inf.effectiveVoters, 1 / 0.375, 1e-12));
    check('influenceSummary entropy + maxShare', close(inf.entropyBits, 1.5) && close(inf.maxShare, 0.5));
    check('influenceSummary handles an empty legion', influenceSummary(null).count === 0 && influenceSummary({}).hhi === 0);
    check('consensusProbability maps confidence/direction', close(consensusProbability({ confidence: 80, direction: 'BUY' }), 0.8) && close(consensusProbability({ confidence: 80, direction: 'SELL' }), 0.2));
    check('consensusProbability defaults to 0.5', consensusProbability({}) === 0.5 && consensusProbability({ confidence: NaN }) === 0.5);

    // ---- I. alerts engine -------------------------------------------------
    check('compare supports the six operators', compare(2, '>', 1) && compare(1, '>=', 1) && compare(0, '<', 1) && compare(1, '<=', 1) && compare(2, '===', 2) && compare(2, '!==', 3));
    check('compare is false for a non-finite metric', !compare(NaN, '>', 0) && !compare(undefined, '<', 5));
    check('default rules are frozen + have unique ids', Object.isFrozen(DEFAULT_ALERT_RULES) && new Set(DEFAULT_ALERT_RULES.map((r) => r.id)).size === DEFAULT_ALERT_RULES.length);

    const bad = evaluateAlerts({ brier: 0.5, influenceHhi: 0.5, effectiveVoters: 1, memberProbStd: 0, workerErrorRate: 0.2, quarantinedRows: 3, vaultGrowthPerBatch: 9000 });
    const firedIds = bad.firing.map((a) => a.id);
    check('alerts fire on every breached rule', firedIds.includes('brier-worse-than-chance') && firedIds.includes('influence-concentrated') && firedIds.includes('few-effective-voters') && firedIds.includes('ensemble-diversity-collapse') && firedIds.includes('worker-errors') && firedIds.includes('quarantined-rows') && firedIds.includes('vault-growth'));
    check('alerts carry a formatted message', bad.firing.every((a) => typeof a.message === 'string' && a.message.length > 0));
    check('highestSeverity picks critical over warning/info', highestSeverity(bad.firing) === SEVERITIES.critical);

    const clean = evaluateAlerts({ brier: 0.1, influenceHhi: 0.1, effectiveVoters: 9, memberProbStd: 0.2, workerErrorRate: 0, quarantinedRows: 0, vaultGrowthPerBatch: 0 }, DEFAULT_ALERT_RULES, bad.firingIds);
    check('no alerts on a healthy legion', clean.firing.length === 0);
    check('previous firings are reported as resolved', clean.resolved.length === bad.firingIds.size && clean.resolved.includes('brier-worse-than-chance'));
    check('evaluateAlerts accepts an array or a Set for the previous set',
        evaluateAlerts({ brier: 0.5 }, DEFAULT_ALERT_RULES, ['brier-near-chance']).firing.some((a) => a.id === 'brier-near-chance'));
    check('highestSeverity of nothing is null', highestSeverity([]) === null);

    const custom = [{ id: 'x', metric: 'm', op: '>', threshold: 1, severity: SEVERITIES.info, message: () => 'custom' }];
    check('custom rules + non-function message fallback work',
        evaluateAlerts({ m: 2 }, custom).firing[0].message === 'custom' && evaluateAlerts({ m: 2 }, [{ id: 'y', metric: 'm', op: '>', threshold: 1, severity: 'info' }]).firing[0].message === 'm > 1');

    // ---- J. report artifacts ----------------------------------------------
    check('makeRunId embeds a UTC stamp + seed', makeRunId({ seed: 5, startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) }) === '20260102T030405-seed5');
    check('makeRunId marks a seedless run', makeRunId({ seed: null, startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) }) === '20260102T030405-seednone');
    // A relative scratch root keeps this entry portable: a real filesystem
    // (node mirror) creates a throwaway tree in the cwd; the browser shim keeps
    // it in its virtual fs. Either way the round-trip semantics are identical.
    const dir = createRunDirectory('.nl-observer-test', 'run-a');
    writeJson(dir, 'report.json', { hello: 'world' });
    check('createRunDirectory returns the runs/<id> path', /runs[\\/]run-a$/.test(dir));
    check('writeJson/readJson round-trip', JSON.stringify(readJson(dir, 'report.json')) === JSON.stringify({ hello: 'world' }));
    check('readJson falls back on a missing file', readJson(dir, 'nope.json', { fb: 1 }).fb === 1);
    check('appendSnapshot/appendLog no-op without a dir (shim-safe)', appendSnapshot(null, {}) === false && appendLog(null, 'info', 'x') === false);
    check('pruneRunDirectories keeps under the retention cap', JSON.stringify(pruneRunDirectories('.nl-observer-test', 5)) === JSON.stringify({ removed: [] }));
    check('writeReport writes report.json', writeReport(dir, { ok: true }) !== null);
    try { if (typeof fs.rmSync === 'function') fs.rmSync('.nl-observer-test', { recursive: true, force: true }); } catch { /* best effort */ }

    // ---- K. collector integration (synthetic snapshots) -------------------
    const voter = (influence, probability, score, memories) => ({ influence, stats: { probability, accuracyScore: score }, memory: { controllerMemories: memories } });
    const snapshot = (confidence, direction, c1, c0, failed = 0) => ({
        consensus: { confidence, direction },
        controllers: {
            positive: { voters: [voter(1, 0.5, 0.5, 100), voter(1, 0.5, 0.5, 100)] },
            negative: { voters: [voter(1, 0.5, 0.5, 100)] },
        },
        overview: { controllerFailures: failed, quarantinedRows: 0 },
        lastCandles: [{ close: c0 }, { close: c1 }],
    });

    const obs = createObserver({ dir: null, maxHistory: 4 });
    let t = 0;
    for (const c of [10, 20, 30, 40, 50]) obs.onSnapshot(snapshot(c, 'BUY', 1 + (c % 2) * 0.01, 1, c === 50 ? 3 : 0));
    check('collector counts snapshots', obs.snapshots === 5);
    check('collector pairs each batch with the prior batch\'s probability', obs.history.pairs.length === 4);
    check('collector windows are capped by maxHistory', obs.history.meanScore.length === 4 && obs.history.influenceHhi.length === 4);
    const m = obs.metrics();
    check('collector brier is a valid probability score', m.brier >= 0 && m.brier <= 1 && m.pairs === 4);
    check('collector sees the collapsed (zero-variance) ensemble', m.memberProbStd === 0 && m.memberProbEntropy > 0);
    check('collector reads the worker error rate from the snapshot', m.workerErrorRate > 0);
    check('collector publishes firing alerts onto legion state', Array.isArray(legionState.alerts) && legionState.alerts.some((a) => a.id === 'ensemble-diversity-collapse'));
    check('collector vault growth is per batch', m.batches === 4 && m.vaultGrowthPerBatch === 0);

    const rep = obs.report({ summary: { note: 'unit' } });
    check('report carries version + metrics + alerts + series', rep.version === 1 && rep.metrics.pairs === 4 && Array.isArray(rep.alerts.all) && rep.series.meanScoreEwma.length === obs.history.meanScore.length);
    check('report summary passes through', rep.summary && rep.summary.note === 'unit');

    const failed = checks.filter((x) => !x.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
