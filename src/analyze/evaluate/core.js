// src/analyze/evaluate/core.js (round-96 split of src/analyze/evaluate.js).
// evaluateAB + finalizeAB (exported for inter-part use only).
import { walkForwardEvaluate, walkForwardEvaluateAsync, promoteDecision, formatReport, walkForwardSearch, restateReportAtCost, poolReports, costLadder, familyCorrelation } from '../../analysis/walkforward.js';
import { ALL_VARIANTS, notApplicableReason, inertReasonFor, CONTROLLER_POSITION_POLICY } from '../roster.js';
import { summarizeModelStats } from '../models.js';


// ---------------------------------------------------------------------------
// The A/B core (pure; injected signalForVariant)
// ---------------------------------------------------------------------------

// Evaluate the whole variant family over one causal split, or over several
// independent streams (round 23, N2: one walk-forward per symbol, pooled).
//
//   returns/folds  — a single stream, or
//   worlds         — [{ returns, folds, viewFor, label }] (multi-stream; pooled)
//   variants       — the candidate family; the one with id 'baseline' is the bench
//   signalForVariant — (variant) => signalForFold(train, test, view)
//   audit          — run the look-ahead audit on every report
//   model          — 'bare' | 'controller': labels the model and decides whether a
//                    `controllerScoped` variant can run at all
//   viewFor/probe/requireReachable/auditProbesPerFold — forwarded to the scoring
//                    view and the audit, so a candle-driven model is audited on the
//                    data it actually reads (analysis/world.js)
//
// Returns { baseline, baselineVariant, candidates[], search, variants }.
export function evaluateAB({
    returns = null, folds = null, viewFor = null, worlds = null,
    variants = ALL_VARIANTS, signalForVariant,
    costBps = 0, periodsPerYear = 252, audit = true, requireCausal = true, alpha = 0.05,
    probe = 1e3, requireReachable = false, auditProbesPerFold = 0, model = 'bare',
    auditReuseBase = false,
    // Round 29 -> 30 (P4): independent panel streams (the funding/carry sleeve) to
    // fold into every candidate's dependence/DSR panel. Each must tile the pooled
    // price grid; a mismatch is reported, never silently dropped.
    extraPanelStreams = null,
    // Round 25: extra `promoteDecision` options applied to every candidate (after
    // each variant's own `decision` overrides). The real driver passes the
    // dependence-aware hurdles here; the default `{}` keeps the round-23/24
    // decision path byte-identical.
    gateOptions = null,
    // Reporting hooks (round 24). `onEvent` receives every scored fold and every
    // audit pass (tagged with the variant/stream it belongs to); `onVariant`
    // receives each variant's completed report plus its decision, so a caller can
    // checkpoint after every variant. Both are optional and have no arithmetic
    // effect on the returned reports.
    onEvent = null, onVariant = null,
    // R28 (BUGS.md #53/#58): the per-variant model accumulator the caller fills
    // through `makeSignalForVariant`'s `onStats`/`onModelStats`, handed to
    // `finalizeAB` so an inert certificate's reason can quote measured numbers.
    modelStats = null,
} = {}) {
    if (typeof signalForVariant !== 'function') {
        throw new Error('evaluateAB: signalForVariant(variant) => signalForFold is required');
    }
    if (!Array.isArray(variants) || variants.length < 2) {
        throw new Error('evaluateAB: at least a baseline and one candidate are required');
    }
    const streams = Array.isArray(worlds) && worlds.length
        ? worlds
        : [{ returns, folds, viewFor, label: 'main' }];
    if (!Array.isArray(streams[0].returns) || !Array.isArray(streams[0].folds) || !streams[0].folds.length) {
        throw new Error('evaluateAB: either `worlds` or (`returns` + `folds`) is required');
    }

    // The baseline is evaluated FIRST so a per-variant checkpoint can carry a
    // decision for every row it reports (a decision needs the baseline). The
    // returned `variants` keep the caller's order, and no number can move: every
    // fit is independent and seeded from (variant, fold) alone.
    const baselineIndex = Math.max(0, variants.findIndex((v) => v.id === 'baseline'));
    const evaluateOne = (vi) => {
        const variant = variants[vi];
        const startedAt = Date.now();
        // A controller-scoped variant (sample-weights, the label policies) can only
        // run on the controller-backed model; a 'broadcast'-path variant
        // (multi-probe, query-mod) cannot reach the scored model at all (R27-2).
        // Both are still EVALUATED here (so the claim "identical to the baseline"
        // is measured, not assumed); `finalizeAB` marks them inactive and excludes
        // them from K and the search.
        const skipped = !!variant.controllerScoped && model !== 'controller';
        const notApplicable = notApplicableReason(variant, model, { streamCount: streams.length });
        const reports = streams.map((s, si) => {
            // One fold function per (variant, stream): it holds the raw-confidence
            // cache the journal reads (round 26, R26-3).
            const foldFor = signalForVariant(variant);
            return walkForwardEvaluate({
                returns: s.returns, folds: s.folds, signalForFold: foldFor,
                confidenceForFold: typeof foldFor.confidenceForFold === 'function' ? foldFor.confidenceForFold : null,
                costBps, periodsPerYear, trials: variants.length, audit, requireCausal,
                viewFor: s.viewFor == null ? viewFor : s.viewFor,
                probe, requireReachable, auditProbesPerFold, auditReuseBase,
                onEvent: onEvent
                    ? (e) => onEvent({
                        ...e,
                        variantId: variant.id, variantIndex: vi, variantTotal: variants.length,
                        stream: si, streamLabel: s.label == null ? null : s.label, streamsTotal: streams.length,
                    })
                    : null,
            });
        });
        const report = reports.length ? poolReports(reports, { periodsPerYear, trials: variants.length, extraPanelStreams }) : null;
        // Per-variant wall time (round 25, observability): the cost law
        // (`~0.035 s x sum_f(testStart_f) x streams x passes x mechanismVariants`,
        // O(n^2) per stream — docs/RUN-ANALYSIS.md section 4) can only be checked,
        // and the next run sized, if the run says how long each variant actually
        // took. Pure reporting — it has no arithmetic effect.
        return { variant, report, skipped, notApplicable, streams: reports.length, elapsedMs: Date.now() - startedAt };
    };

    const evaluated = new Array(variants.length);
    evaluated[baselineIndex] = evaluateOne(baselineIndex);
    const baseline = evaluated[baselineIndex].report;
    if (onVariant) onVariant({ role: 'baseline', index: baselineIndex, entry: evaluated[baselineIndex], decision: null });
    const decisionsByIndex = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        evaluated[vi] = evaluateOne(vi);
        // Round 25: the driver's dependence-aware hurdles ride on `gateOptions`;
        // each variant's own `decision` overrides them, and with `gateOptions`
        // null/absent the round-23/24 decision path is unchanged. This decision is
        // PROVISIONAL (computed at the roster K) and feeds the live checkpoint;
        // `finalizeAB` recomputes the authoritative decision at the active K.
        const decision = evaluated[vi].report
            ? promoteDecision(baseline, evaluated[vi].report, {
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

// The shared tail of `evaluateAB` and `evaluateABAsync` (round 26, R26-4): the
// candidate projection, the family-wise search and the returned result object. It
// reads only already-computed reports, so the serial and concurrent drivers cannot
// drift and the concurrency change stays strictly off the arithmetic path.
//
// Round 27 (R27-1) adds the LIVENESS CERTIFICATE and the K RESTATEMENT. A
// candidate that never reached the model path (a mechanism bolted to a dead
// reader, a label policy with no horizon) used to be scored, counted in K, and
// handed a fabricated hurdle list - so an untested arm looked tested and inflated
// every DSR. Each candidate is now compared, fold by fold, against the baseline
// (and against earlier LIVE candidates, for duplicate detection); only `live`
// candidates enter the family-wise search and the trial count K, and every
// inactive candidate carries exactly one explanatory reason. K affects the DSR,
// and `restateReportAtCost` re-pools a retained report at a new K, so the active
// reports are restated at the active K (it is proven to be the identity at the
// report's own K - see `analysis.test.js`).
export const finalizeAB = ({
    variants, evaluated, baselineIndex, decisionsByIndex, alpha, audit, model,
    streamCount, streamLabels, probe, auditProbesPerFold, requireReachable, auditReuseBase, costBps,
    gateOptions = null,
    // R28 (BUGS.md #53/#58): the per-variant model accumulator, so the liveness
    // certificate's reason can quote MEASURED diagnostics (the emitted sample
    // weights, the assumed span horizon, the realized holding period). Optional:
    // `null` degrades the reason to the generic measured wording.
    modelStats = null,
}) => {
    const baselineEntry = evaluated[baselineIndex];
    const baseline = baselineEntry.report;

    // --- R27-1: per-fold position series + the liveness comparison -------------
    const foldSignals = (r) => (r && Array.isArray(r.foldInputs)
        ? r.foldInputs.map((f) => (f && Array.isArray(f.signals)) ? f.signals : [])
        : null);
    const compare = (aSignals, bSignals) => {
        const totalFolds = Math.max(aSignals.length, bSignals.length);
        let identicalFolds = 0, maxAbsDiff = 0, firstDifferingFold = null;
        for (let fi = 0; fi < totalFolds; fi++) {
            const a = aSignals[fi] || [];
            const b = bSignals[fi] || [];
            const n = Math.max(a.length, b.length);
            let diff = 0;
            for (let i = 0; i < n; i++) {
                const d = Math.abs((Number.isFinite(a[i]) ? a[i] : 0) - (Number.isFinite(b[i]) ? b[i] : 0));
                if (d > diff) diff = d;
            }
            if (diff === 0) identicalFolds += 1;
            else {
                if (firstDifferingFold === null) firstDifferingFold = fi;
                if (diff > maxAbsDiff) maxAbsDiff = diff;
            }
        }
        return { identicalFolds, totalFolds, maxAbsDiff, firstDifferingFold };
    };

    const baseSignals = foldSignals(baseline);
    const liveIndices = [];
    const livenessByIndex = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const entry = evaluated[vi];
        const variant = entry.variant;
        let status = 'live';
        let reason = null;
        let cmp = null;
        const naReason = entry.notApplicable || notApplicableReason(variant, model, { streamCount });
        if (naReason) {
            status = 'not-applicable';
            reason = naReason;
        } else if (entry.skipped) {
            status = 'skipped';
            reason = `skipped: a controller-scoped variant on the ${model} model`;
        } else if (!baseSignals || !entry.report) {
            status = 'skipped';
            reason = 'skipped: the candidate was not evaluated';
        } else {
            const candSignals = foldSignals(entry.report);
            if (candSignals) {
                cmp = compare(candSignals, baseSignals);
                if (cmp.totalFolds > 0 && cmp.identicalFolds === cmp.totalFolds) {
                    status = 'inert';
                    // R27-3 / R28 (BUGS.md #53, #58): a variant may state WHY it is
                    // inert from the MEASURED run context (the sample weights it
                    // emitted, the reported span horizon, the baseline's realized
                    // holding period). The generic fallback is deliberately NOT a
                    // structural claim — a variant that got here IS on the scored
                    // path (see `inertReasonFor`).
                    const detail = inertReasonFor(variant, {
                        variantId: variant.id,
                        model,
                        totalFolds: cmp.totalFolds,
                        identicalFolds: cmp.identicalFolds,
                        report: entry.report,
                        baseline,
                        modelBlock: modelStats ? summarizeModelStats(modelStats.get(variant.id)) : null,
                        baselineModelBlock: modelStats ? summarizeModelStats(modelStats.get(variants[baselineIndex].id)) : null,
                    });
                    reason = `inert: identical to the baseline on all ${cmp.totalFolds} folds — ${detail}`;
                } else {
                    const dup = liveIndices.find((xi) => {
                        const xs = foldSignals(evaluated[xi].report);
                        if (!xs) return false;
                        const c2 = compare(candSignals, xs);
                        return c2.totalFolds > 0 && c2.identicalFolds === c2.totalFolds;
                    });
                    if (dup != null) {
                        const dupId = evaluated[dup].variant.id;
                        status = `duplicate-of:${dupId}`;
                        reason = `duplicate-of:${dupId}: identical to the earlier live candidate ${evaluated[dup].variant.label || dupId}`;
                    }
                }
            }
        }
        const cert = { status, reason, ...(cmp || {}) };
        livenessByIndex.set(vi, cert);
        entry.liveness = cert;
        if (status === 'live') liveIndices.push(vi);
    }
    if (baselineEntry) baselineEntry.liveness = { status: 'baseline', reason: null };

    // --- R27-1: the active set + the K restatement -----------------------------
    const activeIndices = [baselineIndex, ...liveIndices];
    const trialsRoster = variants.length;
    const trialsActive = activeIndices.length;
    const restate = (report) => {
        if (!report || !Array.isArray(report.foldInputs) || !report.foldInputs.length) return report;
        const r = restateReportAtCost(report, costBps, { trials: trialsActive });
        if (!r) return report;
        // Swap only what K (and the cost) affect; keep the scored report's audit,
        // foldInputs, probed flag, foldSharpes and stream labels.
        return {
            ...report,
            trials: r.trials,
            pooledMetrics: r.pooledMetrics,
            power: r.power,
            aggregate: r.aggregate,
            dependence: r.dependence,
            // P4: `dependenceWithoutExtras` is a restated block too, so it must come
            // from the restatement (paired with `dependence` at the same cost) rather
            // than from the scored report.
            dependenceWithoutExtras: r.dependenceWithoutExtras,
            folds: r.folds,
            pooledBars: r.pooledBars,
        };
    };
    const baselineRestated = restate(baseline);
    // R27-1: restate EVERY candidate report at the active K, not just the live
    // ones. An inactive candidate's DSR is not a family-wise statistic (it is
    // outside K and the search), but its row must still carry the same K the run
    // was deflated by, so a reader never sees two different `trials` values in one
    // report. Its pre-restatement (roster-K) report is kept in `reportRoster`.
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex || !evaluated[vi].report) continue;
        evaluated[vi].reportRestated = restate(evaluated[vi].report);
    }

    // --- R27-1: the final decisions over the ACTIVE set ------------------------
    const finalDecision = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const entry = evaluated[vi];
        if (entry.liveness.status === 'live' && entry.reportRestated) {
            finalDecision.set(vi, promoteDecision(baselineRestated, entry.reportRestated, {
                requireCleanAudit: audit,
                ...(variants[vi].decision || {}),
                ...(gateOptions || {}),
            }));
        } else {
            finalDecision.set(vi, {
                promote: false,
                reasons: [entry.liveness.reason || `${entry.liveness.status} candidate`],
                foldWinFraction: null,
                promotionTest: {
                    available: false,
                    reason: 'candidate is not active (inert / duplicate / not-applicable / skipped): it is excluded from K and the family-wise search',
                },
                gate: { minDsrAdjusted: 'off', requireSharpeDiff: 'off', requireBreadth: 'off', requireClusterStability: 'off', blockStability: 'off' },
                inactive: true,
            });
        }
    }

    // --- R27-1: the family-wise search over the ACTIVE set ---------------------
    let search = null;
    try {
        if (!liveIndices.length) {
            // R27-1: a skipped search keeps the normal search shape (with an empty
            // candidate list and explicit nulls), so a reader that expects
            // `spaPValue`/`rejectedLabels`/`bestLabel` never crashes on it.
            search = {
                skipped: true,
                reason: 'no active candidates (every candidate was inert / duplicate / not-applicable / skipped)',
                K: 1, T: null, alpha: alpha ?? null,
                spaPValue: null, bestLabel: null, rejectedLabels: [],
                candidates: [],
            };
        } else {
            search = walkForwardSearch({
                baseline: baselineRestated,
                candidates: liveIndices.map((vi) => evaluated[vi].reportRestated),
                labels: liveIndices.map((vi) => evaluated[vi].variant.label),
                alpha,
            });
        }
    } catch (err) {
        search = { error: err.message || String(err) };
    }
    const searchRowFor = (vi) => {
        if (!search || !Array.isArray(search.candidates)) return null;
        const pos = activeIndices.indexOf(vi);
        return pos >= 0 ? (search.candidates[pos] || null) : null;
    };

    const counts = { inert: 0, duplicate: 0, notApplicable: 0, skipped: 0 };
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const s = livenessByIndex.get(vi).status;
        if (s === 'inert') counts.inert += 1;
        else if (s.startsWith('duplicate-of:')) counts.duplicate += 1;
        else if (s === 'not-applicable') counts.notApplicable += 1;
        else if (s === 'skipped') counts.skipped += 1;
    }

    const candidates = [];
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const entry = evaluated[vi];
        candidates.push({
            variant: entry.variant,
            report: entry.reportRestated || entry.report,
            // The report BEFORE the K restatement (same foldInputs/audit, the
            // roster K); kept so an offline reader can compare the two Ks.
            reportRoster: entry.report || null,
            skipped: entry.skipped,
            notApplicable: entry.notApplicable || null,
            liveness: entry.liveness || null,
            // R27-1: whether this candidate entered K and the family-wise search.
            // The report side filters on this (cost ladder, family correlation,
            // forecast comparison, decision feature), so it must live on the
            // result object, not only on the projected `candidateRow`.
            active: !!(entry.liveness && entry.liveness.status === 'live'),
            elapsedMs: entry.elapsedMs,
            streams: entry.streams,
            decision: finalDecision.get(vi) || null,
            search: searchRowFor(vi),
        });
    }

    return {
        baselineIndex,
        baselineVariant: variants[baselineIndex],
        baseline: baselineRestated,
        variants: evaluated,
        candidates,
        search,
        auditClean: audit ? !!(baseline && baseline.audit && baseline.audit.clean) : null,
        model,
        streams: streamCount,
        probe,
        auditProbesPerFold,
        requireReachable,
        reuseBase: auditReuseBase,
        costBps,
        positionPolicy: model === 'controller' ? CONTROLLER_POSITION_POLICY : null,
        streamLabels,
        // R27-1: the trial accounting. `trials` is the K every DSR was deflated by
        // (the ACTIVE roster); `trialsRoster` is what was requested.
        trials: trialsActive,
        trialsRoster,
        trialsInactive: trialsRoster - trialsActive,
        inactiveCounts: counts,
        liveness: { roster: trialsRoster, active: trialsActive, ...counts },
    };
}
// The concurrent twin of `evaluateAB` (round 26, R26-4). Same options, plus
// `foldExecutorFor(variant, streamIndex, stream)` — returning a fold executor for a
// unit (e.g. a worker dispatch), or null/undefined to run that variant in-process
// via `signalForVariant` — and `concurrency` (the in-flight width). The variant
// order, the emit order and every number are unchanged; only wall time moves. The
// result is assembled by the SAME `finalizeAB`, so the two drivers cannot drift.
