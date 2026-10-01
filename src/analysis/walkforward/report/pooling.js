// src/analysis/walkforward/report/pooling.js (round-106 split of src/analysis/walkforward/report.js).
// Walk-forward pooling across streams: one rectangular fold grid, one pooled report.
import { poolFolds } from '../../backtest.js';
import { aggregateFolds, blockStability } from '../folds.js';
import { dependenceSummary, powerSummary } from '../power.js';
// one-stream path stays byte-identical.
export function poolReports(reports, { periodsPerYear = 252, trials = 1, extraPanelStreams = null, blockWindows = 6 } = {}) {
    if (!Array.isArray(reports) || reports.length === 0) {
        throw new Error('poolReports: at least one report is required');
    }
    if (reports.length === 1) return reports[0];
    const perFold = reports.flatMap((r) => r.folds || []);
    const pooled = reports.flatMap((r) => r.pooledReturns || []);
    const pooledGross = reports.flatMap((r) => r.pooledGross || []);
    // The per-stream panel, retained by reference: `streamReturns` is what the
    // dependence machinery groups into fold-window clusters, and `foldInputs` is
    // what lets the report be restated at another cost level (round 25).
    const priceStreamReturns = reports.map((r) => r.pooledReturns || []);
    const priceFoldLengths = reports.map((r) => r.foldLengths || []);
    // Round 29 -> 30 (P4): a funding/carry sleeve is a genuinely independent RETURN
    // source, so the DSR's design-effect adjustment should count it. Extra streams
    // are appended to the panel (never to the scored price returns), and each extra
    // stream is declared as one fold of its own length. A stream in this panel is a
    // PER-STREAM series (the test bars of one world, folds concatenated) — so an
    // extra stream must match `priceStreamReturns[0].length`, NOT the concatenated
    // `pooled.length` (which is every stream's bars). A mismatch is reported as
    // unavailable rather than silently dropped (a silent drop would leave the
    // design effect looking better than it is).
    const extra = (Array.isArray(extraPanelStreams) ? extraPanelStreams : [])
        .filter((s) => Array.isArray(s) && s.length);
    const panelLength = priceStreamReturns.length ? (priceStreamReturns[0] || []).length : 0;
    const hasVariance = (s) => {
        const first = s[0];
        for (let i = 1; i < s.length; i++) if (s[i] !== first) return true;
        return false;
    };
    const lengthMismatch = extra.some((s) => s.length !== panelLength);
    // A CONSTANT stream carries no information and makes every pairwise correlation
    // undefined, so it must not enter the panel either — that is the same class of
    // silent degradation the length check guards (and is exactly what a mis-wired
    // sleeve, e.g. an all-zero carry series, looks like).
    const degenerate = extra.some((s) => !hasVariance(s));
    const panelMismatch = lengthMismatch || degenerate;
    const panelMismatchReason = lengthMismatch ? 'length' : (degenerate ? 'degenerate' : null);
    const streamReturns = panelMismatch ? priceStreamReturns : [...priceStreamReturns, ...extra];
    const streamFoldLengths = panelMismatch ? priceFoldLengths : [...priceFoldLengths, ...extra.map((s) => [s.length])];
    const foldInputs = reports.flatMap((r) => r.foldInputs || []);
    const priceDependence = dependenceSummary({ streamReturns: priceStreamReturns, streamFoldLengths: priceFoldLengths, periodsPerYear });
    const dependence = panelMismatch
        ? priceDependence
        : dependenceSummary({ streamReturns, streamFoldLengths, periodsPerYear });
    const effectiveBars = dependence && dependence.available ? dependence.effectiveBars : null;
    const { pooledMetrics, meanFoldSharpe } = poolFolds(perFold, pooled, pooledGross, { periodsPerYear, trials, effectiveBars });
    const audits = reports.map((r) => r.audit).filter(Boolean);
    const audit = audits.length
        ? {
            clean: audits.every((a) => a.clean),
            vacuous: audits.some((a) => a.vacuous),
            reachable: audits.every((a) => a.reachable === true),
            viewDiffers: audits.every((a) => a.viewDiffers !== false),
            probes: audits.reduce((n, a) => n + (a.probes || 0), 0),
            reachableFolds: audits.reduce((n, a) => n + (a.reachableFolds || 0), 0),
            baseReused: audits.reduce((n, a) => n + (a.baseReused || 0), 0),
            violations: audits.flatMap((a) => a.violations || []),
            streams: audits.length,
        }
        : null;
    return {
        folds: perFold,
        pooledMetrics,
        meanFoldSharpe,
        trials,
        pooledBars: pooled.length,
        pooledReturns: pooled,
        pooledGross,
        streamReturns,
        streamFoldLengths,
        priceStreamReturns,
        priceStreamFoldLengths: priceFoldLengths,
        foldInputs,
        foldLengths: reports.flatMap((r) => r.foldLengths || []),
        aggregate: aggregateFolds(perFold),
        dependence,
        // Round 32 (lab R2): the window-robustness readout over the PRICE-ONLY
        // panel. The extra sleeve streams enter `dependence` but never this
        // statistic: it scores the priced series the verdict is about (the
        // L10-cs lesson — panel extensions must not move price tests).
        blockStability: blockStability(priceStreamReturns, blockWindows, { periodsPerYear }),
        // Round 29 -> 30 (P4): the extra (carry/funding) panel streams that were
        // folded into `dependence`, plus the PRICE-ONLY dependence so a reader can
        // see exactly what adding the sleeve did. `panelMismatch` is true when a
        // supplied stream did not tile the pooled price grid, in which case the
        // extra streams were excluded from `dependence` (never silently averaged).
        panelStreams: extra.length,
        panelMismatch,
        panelMismatchReason,
        dependenceWithoutExtras: extra.length ? priceDependence : null,
        extraPanelStreams: extra.length && !panelMismatch ? extra : null,
        audit,
        power: powerSummary(pooledMetrics.netSharpe, pooled.length, periodsPerYear, dependence),
        probed: reports.some((r) => r.probed === true),
    };
}

