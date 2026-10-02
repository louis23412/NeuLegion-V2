// src/analyze/evaluate/async.js (round-96 split of src/analyze/evaluate.js).
// evaluateABAsync (worker/callback path).
import { walkForwardEvaluateAsync, promoteDecision, poolReports } from '../../analysis/walkforward.js';
import { ALL_VARIANTS, notApplicableReason } from '../roster.js';
import { finalizeAB } from './core.js';


export async function evaluateABAsync({
    returns = null, folds = null, viewFor = null, worlds = null,
    variants = ALL_VARIANTS, signalForVariant,
    foldExecutorFor = null,
    costBps = 0, periodsPerYear = 252, audit = true, requireCausal = true, alpha = 0.05,
    probe = 1e3, requireReachable = false, auditProbesPerFold = 0, model = 'bare',
    auditReuseBase = false, gateOptions = null,
    // Round 29 -> 30 (P4): independent panel streams (the funding/carry sleeve) to
    // fold into every candidate's dependence/DSR panel (see `evaluateAB`).
    extraPanelStreams = null,
    onEvent = null, onVariant = null, onModelStats = null, concurrency = 1,
    // R28: the per-variant model accumulator (see `evaluateAB`).
    modelStats = null,
} = {}) {
    if (typeof signalForVariant !== 'function') {
        throw new Error('evaluateABAsync: signalForVariant(variant) => signalForFold is required');
    }
    if (!Array.isArray(variants) || variants.length < 2) {
        throw new Error('evaluateABAsync: at least a baseline and one candidate are required');
    }
    const streams = Array.isArray(worlds) && worlds.length
        ? worlds
        : [{ returns, folds, viewFor, label: 'main' }];
    if (!Array.isArray(streams[0].returns) || !Array.isArray(streams[0].folds) || !streams[0].folds.length) {
        throw new Error('evaluateABAsync: either `worlds` or (`returns` + `folds`) is required');
    }

    const baselineIndex = Math.max(0, variants.findIndex((v) => v.id === 'baseline'));
    const evaluateOne = async (vi) => {
        const variant = variants[vi];
        const startedAt = Date.now();
        const skipped = !!variant.controllerScoped && model !== 'controller';
        const notApplicable = notApplicableReason(variant, model, { streamCount: streams.length });
        const reports = [];
        for (let si = 0; si < streams.length; si++) {
            const s = streams[si];
            const rawExecutor = foldExecutorFor ? foldExecutorFor(variant, si, s) : null;
            // Surface the worker's model diagnostics to the same accumulator the
            // in-process `onStats` feeds, so the per-variant `model` block (R26-2) is
            // present in the parallel run too. Reporting only — no arithmetic.
            const executor = rawExecutor
                ? async (ctx) => {
                    const r = await rawExecutor(ctx);
                    if (onModelStats && r && r.stats) {
                        try { onModelStats(variant, r.stats); } catch { /* reporting is best-effort */ }
                    }
                    return { signals: r.signals, confidence: r.confidence };
                }
                : null;
            const foldFor = signalForVariant(variant);
            reports.push(await walkForwardEvaluateAsync({
                returns: s.returns, folds: s.folds,
                // The scored pass may run in a worker (`executor`), but the look-ahead
                // audit always runs HERE, in-process, because it re-fits the signal on
                // PERTURBED views — and a fold executor has no view channel. Nulling
                // `signalForFold` when an executor existed crashed `auditNoLookahead`
                // for every `concurrency > 1` run with `audit` on (the default).
                // `signalForVariant` is a cheap closure over the shared factory; when
                // an executor handles the scored pass only the audit calls it.
                signalForFold: foldFor,
                foldExecutor: executor || null,
                confidenceForFold: !executor && typeof foldFor.confidenceForFold === 'function' ? foldFor.confidenceForFold : null,
                costBps, periodsPerYear, trials: variants.length, audit, requireCausal,
                viewFor: s.viewFor == null ? viewFor : s.viewFor,
                probe, requireReachable, auditProbesPerFold, auditReuseBase,
                concurrency,
                onEvent: onEvent
                    ? (e) => onEvent({
                        ...e,
                        variantId: variant.id, variantIndex: vi, variantTotal: variants.length,
                        stream: si, streamLabel: s.label == null ? null : s.label, streamsTotal: streams.length,
                    })
                    : null,
            }));
        }
        const report = reports.length ? poolReports(reports, { periodsPerYear, trials: variants.length, extraPanelStreams }) : null;
        return { variant, report, skipped, notApplicable, streams: reports.length, elapsedMs: Date.now() - startedAt };
    };

    const evaluated = new Array(variants.length);
    evaluated[baselineIndex] = await evaluateOne(baselineIndex);
    if (onVariant) onVariant({ role: 'baseline', index: baselineIndex, entry: evaluated[baselineIndex], decision: null });
    const decisionsByIndex = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        evaluated[vi] = await evaluateOne(vi);
        // Provisional (roster-K) decision for the live checkpoint; `finalizeAB`
        // recomputes the authoritative decision at the active K.
        const decision = evaluated[vi].report
            ? promoteDecision(evaluated[baselineIndex].report, evaluated[vi].report, {
                requireCleanAudit: audit,
                ...(variants[vi].decision || {}),
                ...(gateOptions || {}),
            })
            : null;
        decisionsByIndex.set(vi, decision);
        if (onVariant) onVariant({ role: 'candidate', index: vi, entry: evaluated[vi], decision });
    }

    return finalizeAB({
        variants, evaluated, baselineIndex, decisionsByIndex, alpha, audit, model,
        streamCount: streams.length, streamLabels: streams.map((s) => s.label || null),
        probe, auditProbesPerFold, requireReachable, auditReuseBase, costBps,
        gateOptions,
        modelStats,
    });
}
