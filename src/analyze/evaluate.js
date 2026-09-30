// A/B evaluation core — evaluateAB/Async, decisions, report formatters (round-83 split of src/analyze.js).
// Pure, no I/O. Imported by ./cli.js; re-exported by the analyze.js shim.
import { walkForwardEvaluate, walkForwardEvaluateAsync, promoteDecision, formatReport, walkForwardSearch, restateReportAtCost, poolReports, costLadder, familyCorrelation } from '../analysis/walkforward.js';
import { formatTurnoverSweep } from '../analysis/holding.js';
import { formatStreamSelection } from '../analysis/streams.js';
import { formatForecast } from '../analysis/forecast.js';
import { formatDecision } from '../analysis/decision.js';
import { ALL_VARIANTS, notApplicableReason, inertReasonFor, CONTROLLER_POSITION_POLICY } from './roster.js';
import { summarizeModelStats } from './models.js';



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
const finalizeAB = ({
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

const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

// The one-line audit verdict for the human summary. `reachable`/`reachableFolds`
// are what distinguish a *structural* certificate (the perturbation changed the
// object the model reads) from a *behavioural* one (it demonstrably moved a later
// position); the machine-readable report always carries the full audit object.
export const auditVerdict = (report) => {
    const a = report && report.audit;
    if (!a) return 'skipped';
    const parts = [
        a.clean ? 'clean' : 'LEAK',
        `probes=${a.probes || 0}`,
        `reachable=${a.reachable === true}`,
    ];
    if (a.reachableFolds != null) parts.push(`reachableFolds=${a.reachableFolds}`);
    if (a.vacuous) parts.push('VACUOUS');
    return parts.join(' ');
};

// Render the A/B verdict as a human-readable block. `extra` carries the round-25
// run-level blocks (`costLadder`, `familyCorrelation`, `gate`) that are computed
// after the evaluation: they are optional so `formatAnalysis(result)` still
// renders on its own (the tests, and any caller that only wants the raw A/B).
// Round 33 (lab R1): render the long-sample readout. One line per arm naming the
// pooled full-history Sharpe, the break-even, the 5/10 bps restatements and the
// block readout, so a verdict read off the --bars window can be compared at a
// glance. Unavailable arms state their reason; a null block renders nothing (the
// default run is byte-identical).
export function formatFullHistory(block) {
    if (!block || block.available === false) return '';
    const arms = block.arms || {};
    const lines = [];
    for (const id of Object.keys(arms)) {
        const a = arms[id];
        if (!a || a.available === false) {
            lines.push(`full-history ${id}: n/a (${(a && a.reason) || 'not scored'})`);
            continue;
        }
        const m = a.pooledMetrics || {};
        const bs = a.blockStability || {};
        const per = Array.isArray(a.perStream)
            ? a.perStream.map((s) => `${s.label} ${Number.isFinite(s.metrics && s.metrics.netSharpe) ? s.metrics.netSharpe.toFixed(4) : 'n/a'}`).join(', ')
            : '';
        lines.push(`full-history ${id}: pooled Sharpe=${Number.isFinite(m.netSharpe) ? m.netSharpe.toFixed(4) : 'n/a'}` +
            ` @${a.bars}bars/${a.streams}streams breakEven=${m.breakEvenCostBps == null ? 'n/a' : `${m.breakEvenCostBps.toFixed(4)}bps`}` +
            ` @5bps=${Number.isFinite(a.netSharpeAt5bps) ? a.netSharpeAt5bps.toFixed(4) : 'n/a'}` +
            ` @10bps=${Number.isFinite(a.netSharpeAt10bps) ? a.netSharpeAt10bps.toFixed(4) : 'n/a'}` +
            ` blocks k=${bs.blocks == null ? 'n/a' : bs.blocks} positive=${Number.isFinite(bs.positiveFraction) ? bs.positiveFraction.toFixed(4) : 'n/a'}` +
            (per ? ` | streams: ${per}` : ''));
    }
    return lines.join('\n');
}

export function formatAnalysis(result, extra = {}) {
    const lines = [];
    const s = result.search;
    lines.push(`walk-forward A/B: ${result.candidates.length + 1} variants, ` +
        `${result.baseline.folds ? result.baseline.folds.length : 0} folds, ${result.baseline.pooledBars} pooled bars`);
    const ib = extra.intervalBars != null ? extra.intervalBars : (result.intervalBars || 1);
    lines.push(`model: ${result.model || 'bare'} | streams=${result.streams || 1} | ` +
        `positionPolicy=${JSON.stringify(result.positionPolicy || CONTROLLER_POSITION_POLICY)} | ` +
        `probe=${f4(result.probe)} | auditProbesPerFold=${result.auditProbesPerFold || 0} | costBps=${result.costBps || 0} | reuseBase=${result.reuseBase === true}` +
        ` | intervalBars=${ib} | crn=${extra.commonRandomNumbers !== false}`);
    // Round 26 (R26-2): whether each model-backed variant actually trained, and
    // whether it beats its label base rate. Without this, a keep-off verdict is
    // ambiguous between "no edge" and "no model" (BUGS.md #35/#37).
    const ms = extra.model || null;
    if (ms && typeof ms.get === 'function' && typeof ms.size === 'number' && ms.size > 0) {
        const parts = [];
        for (const [id, acc] of ms) {
            const d = summarizeModelStats(acc);
            if (!d) continue;
            parts.push(`${id} ${d.status} steps=${d.trainingSteps}` +
                ` base=${d.baseRate == null ? 'n/a' : f4(d.baseRate)}` +
                ` skill=${d.brierSkill == null ? 'n/a' : f4(d.brierSkill)}` +
                ` warmErrors=${d.warmErrors}`);
        }
        if (parts.length) lines.push(`models: ${parts.join(' | ')}`);
    }
    // Round 25: state the gate. A `keep-off` verdict means something different
    // under a dependence-aware gate than under the classic one, so the reader
    // must be told which one produced it.
    const g = extra.gate || null;
    if (g && g.mode) {
        lines.push(`gate:   ${g.mode}${g.alpha != null ? ` (alpha=${f4(g.alpha)})` : ''}` +
            (g.mode === 'dependence'
                ? ' — paired cluster Sharpe difference + exact sign test over fold windows + DSR floor on design-effect-adjusted bars'
                : ' — the round-23/24 hurdles only (no dependence correction)'));
    }
    lines.push(formatReport(result.baseline, { label: `baseline(${result.baselineVariant.label})` }));
    for (const c of result.candidates) {
        const decision = c.decision || { promote: false, reasons: [], gate: null, promotionTest: null };
        const verdict = decision.promote ? 'PROMOTE' : 'keep-off';
        const kind = c.variant.kind === 'signal' ? ' |signal' : '';
        const fw = c.search ? ` | StepM p=${f4(c.search.pValue)} rejected=${!!c.search.rejected}` : '';
        // Name any round-25 hurdle that was SKIPPED for lack of a panel, so a
        // green gate can never be read as "all hurdles passed".
        const skippedHurdles = decision.gate
            ? Object.entries(decision.gate).filter(([, v]) => v === 'skipped-no-panel').map(([k2]) => k2)
            : [];
        const gt = skippedHurdles.length ? ` | gate-skipped=${skippedHurdles.join(',')}` : '';
        // R27-1: an inactive candidate (inert / duplicate / not-applicable / skipped)
        // names its status inline, and a candidate with no report (never evaluated)
        // is stated as such rather than crashing the formatter on a null report.
        const liveTag = c.active ? '' : ` [${(c.liveness && c.liveness.status) || (c.skipped ? 'skipped' : 'inactive')}]`;
        const label = `${c.variant.label} [${verdict}]${kind}${liveTag}${c.skipped ? ' (skipped: controller-scoped)' : ''}${fw}${gt}`;
        if (!c.report) {
            lines.push(`[${label}] not evaluated`);
            lines.push(`  reasons: ${(decision.reasons || []).join('; ')}`);
            continue;
        }
        // The paired cluster test belongs to the candidate-vs-baseline DECISION,
        // not to the report, so it is handed to the formatter here (round 25). A
        // single-stream run still renders it — as `paired: n/a (reason)` — so the
        // absence of a panel is stated rather than silently omitted.
        lines.push(formatReport(c.report, {
            label,
            promotionTest: decision.promotionTest,
        }));
        if (!decision.promote) lines.push(`  reasons: ${(decision.reasons || []).join('; ')}`);
    }
    if (s && s.skipped) {
        lines.push(`family-wise: skipped (${s.reason || 'no active candidates'})`);
    } else if (s && Array.isArray(s.candidates)) {
        lines.push(`family-wise: SPA p=${f4(s.spaPValue)} best=${s.bestLabel} Rejects=[${s.rejectedLabels.length ? s.rejectedLabels.join(',') : 'none'}] K=${s.K} T=${s.T}`);
    } else if (s && s.error) {
        lines.push(`family-wise: unavailable (${s.error})`);
    }
    // Round 25: how concentrated the search was. DIAGNOSTIC ONLY — the deflated
    // Sharpe keeps trials=K on purpose (an effective number of independent tests
    // does not control the FWER: arXiv 1612.04535).
    const fc = extra.familyCorrelation;
    if (fc && fc.available) {
        const mp = fc.maxPair ? ` | maxPair=${familyPairLabel(fc.maxPair, result, fc.labels)} r=${f4(fc.maxPair.rho)}` : '';
        lines.push(`family: excessCorr=${f4(fc.meanPairwiseExcessCorr)} effectiveTrials=${f4(fc.effectiveTrials)} of ${fc.K}${mp}` +
            ' (diagnostic only; DSR keeps trials=K)');
    }
    // Round 25: the cost ladder. One line per level, naming the promoting
    // candidates, so a verdict that only holds at one cost assumption is obvious.
    const cl = extra.costLadder;
    if (cl && cl.available && Array.isArray(cl.rows)) {
        for (const row of cl.rows) {
            const promo = row.candidates.filter((c) => c.promote).map((c) => c.id);
            // Round 32 (lab R3): name every candidate's restated net Sharpe on the
            // line itself, so the 5/10 bps verdict is readable without opening the
            // machine-readable rows (a promotes-only line hides a cost death).
            const nets = row.candidates.map((c) => `${c.id} ${f4(c.netSharpe)}`).join(', ');
            lines.push(`cost-ladder +${row.costBps}bps: baseline Sharpe=${f4(row.baseline.netSharpe)} DSR=${f4(row.baseline.dsr)}` +
                ` | promotes=[${promo.length ? promo.join(',') : 'none'}] | netSharpe=[${nets}]`);
        }
    }
    // Round 26 (R26-5): the turnover attack. One line per candidate naming the
    // best break-even policy, so the reader sees whether any no-trade band (or
    // hysteresis / minimum holding) clears the target cost — and which.
    const ts = extra.turnoverSweep;
    if (ts) {
        const rendered = formatTurnoverSweep(ts);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
    }
    // Round 26 (R26-6): the effective independence of the stream basket (Kish
    // design effect over the streams' own returns) and, when asked, the greedy
    // selection order. Design/diagnostic only.
    const ss = extra.streamSelection;
    if (ss) {
        const rendered = formatStreamSelection(ss);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
        if (ss.keep != null && ss.keptDesignEffect && ss.keptDesignEffect.available) {
            lines.push(`streams kept=${ss.keep} -> ${ss.kept.join(',')} DE=${f4(ss.keptDesignEffect.designEffect)} ` +
                `effectiveBars=${f4(ss.keptDesignEffect.effectiveBars)}`);
        }
    }
    // Round 26 (R26-14): the forecast-comparison line — proper scores and the
    // Model Confidence Set. The MCS is the headline: which families cannot be
    // distinguished from the best, rather than a single sample-best winner.
    const fcBlock = extra.forecast;
    if (fcBlock) {
        const rendered = formatForecast(fcBlock);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
    }
    // Run-level power honesty (round 24b): a null verdict from a run that could
    // not have detected a Sharpe of 1 is "underpowered", not "no edge". Name the
    // sample size that would settle it, so the next run can be sized.
    const pw = result.baseline && result.baseline.power;
    if (pw && Number.isFinite(pw.mdeSharpe)) {
        lines.push(`power:  MDE95 Sharpe=±${f4(pw.mdeSharpe)} over ${pw.bars} pooled bars` +
            (pw.underpowered
                ? ` — UNDERPOWERED: this run cannot rule out edges below that; ~${pw.barsToDetect1} pooled bars are needed to detect Sharpe ±1.0`
                : ''));
    }
    // Round 25: the honest (cluster-jackknife) power, when a panel exists.
    if (pw && Number.isFinite(pw.mdeSharpeDependent)) {
        lines.push(`power*: MDE95 Sharpe=±${f4(pw.mdeSharpeDependent)} under the cluster jackknife` +
            ` (i.i.d. variance understated by ${f4(pw.varianceInflation)}x; ${f4(pw.effectiveBars)} effective bars of ${pw.bars})` +
            (pw.underpoweredDependent ? ' — UNDERPOWERED' : ''));
    }
    // Round 26 (R26-8): the decision-grade report — the verdict, the concentration
    // readout and the next-run sizing knobs stated in one place, so a reader does
    // not have to reconstruct them from the per-candidate lines above.
    if (extra.decision) {
        const renderedDecision = formatDecision(extra.decision);
        if (renderedDecision) for (const line of renderedDecision.split('\n')) lines.push(line);
    }
    // Round 33 (lab R1): the long-sample readout beside the verdict — the same
    // arms scored contiguously over the full history, so a window artefact
    // (F-01) is visible on the summary itself.
    if (extra.fullHistory) {
        const renderedFull = formatFullHistory(extra.fullHistory);
        if (renderedFull) for (const line of renderedFull.split('\n')) lines.push(line);
    }
    lines.push(`audit: baseline ${auditVerdict(result.baseline)}`);
    return lines.join('\n');
}

// "candidate-a~candidate-b" for a family-correlation max pair. R28 (BUGS.md #55):
// prefer the labels the correlation object carries (`fc.labels`, the ACTIVE list
// the matrix was built from); the driver's `result.candidates` is the FULL list,
// so resolving against it names the wrong arms when an inactive candidate
// precedes an active one (the round-27 summary printed `sample-weights~multiprobe`
// for a `surprise~homeostasis` pair).
function familyPairLabel(pair, result, labels = null) {
    const label = (i) => {
        if (Array.isArray(labels) && labels[i] != null) return labels[i];
        const c = result && result.candidates ? result.candidates[i] : null;
        return c && c.variant ? c.variant.id : `#${i}`;
    };
    return `${label(pair.a)}~${label(pair.b)}`;
}

// ---------------------------------------------------------------------------
// CLI driver — reads a candle stream, runs the A/B, writes the run directory.