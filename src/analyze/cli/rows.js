// src/analyze/cli/rows.js (round-95 split of src/analyze/cli.js).
// Report-row shapers; the five helpers are exported for inter-part use only.
import { auditBlock } from './io.js';
import { ALL_VARIANTS } from '../roster.js';
import { summarizeModelStats } from '../models.js';


// One row of `report.variants` (the roster: what exists, and whether it ran).
export const variantRosterRow = (entry, modelStats = null) => ({
    id: entry.variant.id,
    label: entry.variant.label,
    kind: entry.variant.kind || 'mechanism',
    appliesTo: entry.variant.appliesTo || 'agnostic',
    skipped: entry.skipped,
    notApplicable: entry.notApplicable || null,
    // R27-1: the liveness certificate (null before finalizeAB has run).
    liveness: entry.liveness || null,
    inDefaultRoster: ALL_VARIANTS.includes(entry.variant),
    streams: entry.streams,
    // Round 26 (R26-2): null for a pure signal candidate (it never fits a model),
    // so an absent model block is never mistaken for a healthy one.
    model: summarizeModelStats(modelStats && modelStats.get(entry.variant.id)),
});

// The baseline row. `audit` is the full machine-readable block; `auditClean` keeps
// the old boolean for anything that already reads it.
export const baselineRow = (result, modelStats = null) => {
    const base = result.baseline;
    return {
        id: result.baselineVariant.id,
        label: result.baselineVariant.label || result.baselineVariant.id,
        // Round 26 (R26-2): did the model train, on what label base rate, and is
        // it any better than that base rate.
        model: summarizeModelStats(modelStats && modelStats.get(result.baselineVariant.id)),
        pooledMetrics: base.pooledMetrics,
        aggregate: base.aggregate,
        audit: auditBlock(base.audit),
        auditClean: base.audit ? !!base.audit.clean : null,
        power: base.power || null,
        // Round 25: the dependence panel (cluster jackknife SE, design effect,
        // effective bars, equicorrelation reading) — null on a single stream.
        dependence: base.dependence || null,
        // P4: the PRICE-ONLY dependence, when a funding/carry sleeve was appended to
        // the panel — so the measured effect of adding it is explicit on every row.
        dependenceWithoutExtras: base.dependenceWithoutExtras || null,
        pooledBars: base.pooledBars,
        foldLengths: base.foldLengths || null,
        // Round 26 (R26-13): the per-fold net Sharpe series, so a multi-seed run can
        // build the (seed x fold) panel without re-reading folds.jsonl.
        foldSharpes: (base.folds || []).map((f) => (f && f.metrics ? f.metrics.netSharpe : NaN)),
    };
};

// One candidate row: the decision, the pooled metrics, the audit block and (when
// the family-wise cross-check has run) the joint `search` statistics. R27-1: a
// candidate that was NOT evaluated (not-applicable / skipped) has a null report,
// so every report-derived field is null rather than a crash; it still carries its
// liveness certificate and its single reason.
export const candidateRow = (entry, decision, search, modelStats = null) => {
    const report = entry.report || null;
    const fallbackReason = entry.liveness && entry.liveness.reason
        ? [entry.liveness.reason]
        : (entry.notApplicable ? [entry.notApplicable] : []);
    return {
        id: entry.variant.id,
        label: entry.variant.label,
        kind: entry.variant.kind || 'mechanism',
        appliesTo: entry.variant.appliesTo || 'agnostic',
        skipped: entry.skipped,
        notApplicable: entry.notApplicable || null,
        // R27-1: the liveness certificate. `status` is one of
        // live | inert | skipped | not-applicable | duplicate-of:<id>.
        liveness: entry.liveness || null,
        active: !!(entry.liveness && entry.liveness.status === 'live'),
        // Round 26 (R26-2): the per-variant model diagnostics (null for a signal).
        model: summarizeModelStats(modelStats && modelStats.get(entry.variant.id)),
        promote: decision ? decision.promote : false,
        // R27-1: true for a candidate excluded from K / the search (inert,
        // duplicate, not-applicable or skipped). It carries exactly one reason in
        // `reasons` and a null promotion test; `active` is its complement.
        inactive: !!(decision && decision.inactive),
        reasons: decision ? decision.reasons : fallbackReason,
        // R28 (BUGS.md #55): the structured hurdles with their margins, and the one
        // closest to its line. Both ride through from `promoteDecision`.
        hurdles: decision && Array.isArray(decision.hurdles) ? decision.hurdles : null,
        tightestHurdle: decision && decision.tightestHurdle ? decision.tightestHurdle : null,
        foldWinFraction: decision ? decision.foldWinFraction : null,
        positiveFoldFraction: decision && Number.isFinite(decision.positiveFoldFraction) ? decision.positiveFoldFraction : null,
        pooledMetrics: report ? report.pooledMetrics : null,
        aggregate: report ? report.aggregate : null,
        audit: auditBlock(report ? report.audit : null),
        auditClean: report && report.audit ? !!report.audit.clean : null,
        power: report ? (report.power || null) : null,
        // Round 25: the dependence panel, the paired cluster test behind the new
        // hurdles, and which hurdles were actually applied (vs skipped for lack of a
        // cross-stream panel) — so the report can never claim a gate it did not run.
        dependence: report ? (report.dependence || null) : null,
        // P4: the PRICE-ONLY dependence, when a funding/carry sleeve was appended to
        // the panel. `dependence` (with) vs this (without) is the measured effect of
        // the extra stream; both are null when no sleeve was supplied.
        dependenceWithoutExtras: report ? (report.dependenceWithoutExtras || null) : null,
        promotionTest: decision ? (decision.promotionTest || null) : null,
        gate: decision ? (decision.gate || null) : null,
        elapsedMs: entry.elapsedMs ?? null,
        // How many streams actually contributed to this variant's pooled report.
        streams: entry.streams ?? null,
        // The number of searches this candidate's DSR was deflated by (K, the
        // ACTIVE roster after R27-1). It rides on the report, but it was not
        // surfaced in `report.json`, so a reader could not see the trial count the
        // verdict assumed.
        trials: report && Number.isFinite(report.trials) ? report.trials : null,
        pooledBars: report ? report.pooledBars : null,
        // Round 26 (R26-13): the per-fold net Sharpe series (seed x fold panel input).
        foldSharpes: report && Array.isArray(report.folds)
            ? report.folds.map((f) => (f && f.metrics ? f.metrics.netSharpe : NaN))
            : [],
        search: search ? { pValue: search.pValue, rejected: search.rejected, statistic: search.statistic, kfwerPValue: search.kfwerPValue ?? null, fdp: search.fdp ?? null } : null,
    };
};

export const foldRecord = (event) => ({
    stage: event.t === 'fold' ? 'score' : event.stage,
    v: event.variantId,
    variantIndex: event.variantIndex,
    stream: event.stream,
    streamLabel: event.streamLabel,
    fold: event.foldIndex,
    foldTotal: event.foldTotal,
    testStart: event.testStart ?? null,
    testEnd: event.testEnd ?? null,
    test: event.test ?? null,
    probeAt: event.probeAt ?? null,
    // The index of the probe inside the fold's test array. Without it the journal
    // cannot be read offline (the reachability comparison is `k > probeIndex`).
    probeIndex: event.probeIndex ?? null,
    // True for an audit base pass that REUSED the scored signals instead of re-fitting.
    reused: event.reused ?? null,
    signals: event.signals ?? null,
    // The raw pre-policy confidence (round 26, R26-3). With the scored policy this
    // reproduces `signals` byte-for-byte (`analyze#verifyPolicyRoundTrip`), so a
    // dead-zone/scale/holding sweep is pure post-processing.
    confidence: event.confidence ?? null,
    returns: event.returns ?? null,
    metrics: event.metrics ?? null,
});

export const fmtClock = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '--:--';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
};
