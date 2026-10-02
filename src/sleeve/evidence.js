// Sleeve evidence block (round-81 split): DSR / yearly / first-last readouts.
// Pure, per-bar Sharpe units (Lo 2002); the report annualizes only for display.
import { clusterJackknife } from '../analysis/dependence.js';
import { sharpeRatio, sharpeStandardError, deflatedSharpeRatio, skewness, kurtosis } from '../analysis/performance.js';

// The sleeve DSR block (round 75): the G5 `dsr` knob, machine-scored.
//
// The walk-forward gate clears its DSR floor on the design-effect-adjusted
// sample (`walkforward#dependenceSummary` + `backtestMetrics#effectiveBars`,
// Bailey & Lopez de Prado (2014) — deflated Sharpe). The sleeve book has no folds, so the
// cluster unit is the G5's own block grid: the delete-one-block jackknife
// (`dependence#clusterJackknife`, Cameron & Miller 2015) over `blocks`
// contiguous calendar blocks — the same window in every stream is one market
// event, the project's documented cluster position (`dependence.js`) — gives
// the honest (cluster-robust) SE of the book Sharpe, `designEffect =
// (seCluster/seIid)^2` the variance inflation, and `effectiveBars =
// bars/designEffect` the sample the DSR floor uses. It absorbs serial
// dependence, block-concentration and non-normality together: an edge carried
// by one block makes the leave-one-out Sharpes disagree, the SE explodes, and
// the DSR collapses — the concentration veto the gate wants.
//
// Three outcomes, mirroring the walk-forward gate's own three states:
//   `deflated`    DE > 1 and at least two effective bars: the DSR is re-run
//                 on the effective sample (the `backtestMetrics` convention).
//   `full-sample` DE <= 1 (measurable, nothing over-confident to deflate):
//                 the unadjusted floor is the honest one — the gate's
//                 `not-needed` state, scored at the full sample, never a fail.
//   unavailable   unmeasurable (too short, non-finite, degenerate): fail-closed,
//                 `dsrAdjusted` stays null and the G5 knob fails as before.
// `trials` is 1: the shipped spec is one frozen recipe, stated, not banked —
// so this DSR is an UPPER bound on selection-adjusted confidence (the lab
// search history that produced the spec is unquantified and documented, not
// hidden). The `nStar < 2` guard (fewer than two effective bars) is a
// theoretical trip-wire — unreachable at the shipped block counts — kept so a
// single-block event can never manufacture a passing DSR.
// Units: everything runs in PER-BAR Sharpe with n in bars — Lo (2002)'s SE
// formula is stated in per-observation units, so annualizing the jackknife
// statistic while counting bars would make the design effect depend on the
// display annualization. The report annualizes only for display.

export const SLEEVE_DSR_BLOCKS = 6;
export const SLEEVE_DSR_TRIALS = 1;

export function sleeveDsr({ net, blocks = SLEEVE_DSR_BLOCKS, trials = SLEEVE_DSR_TRIALS } = {}) {
    const fail = (reason) => ({ available: false, reason, trials, blocks, dsrAdjusted: null });
    if (!Array.isArray(net) || net.length === 0) return fail('no scored book series');
    const T = net.length;
    const b = Number.isInteger(blocks) && blocks >= 2 ? blocks : SLEEVE_DSR_BLOCKS;
    if (T < 2 * b) return fail(`the book has ${T} bars — fewer than two bars per block over ${b} blocks`);
    for (const v of net) if (!Number.isFinite(v)) return fail('the scored book series is not finite');
    const perBar = sharpeRatio(net, { periodsPerYear: 1 });
    const sk = skewness(net);
    const ku = kurtosis(net);
    const base = Math.floor(T / b);
    const rem = T % b;
    const clusters = [];
    let from = 0;
    for (let c = 0; c < b; c++) {
        const size = base + (c < rem ? 1 : 0);
        clusters.push(net.slice(from, from + size));
        from += size;
    }
    const stat = (a) => sharpeRatio(a, { periodsPerYear: 1 });
    const jk = clusterJackknife({ clusters, statistic: stat });
    if (!Number.isFinite(jk.estimate) || !Number.isFinite(jk.se)) return fail('the delete-one-block jackknife is not finite');
    const seIid = sharpeStandardError({ sharpe: jk.estimate, n: T, skew: sk, kurtosis: ku });
    if (!(seIid > 0)) return fail('the i.i.d. Sharpe standard error is not positive');
    const designEffect = (jk.se / seIid) ** 2;
    if (!Number.isFinite(designEffect) || designEffect < 0) return fail('the variance inflation is not finite');
    let mode = 'full-sample';
    let n = T;
    if (designEffect > 1) {
        const nStar = Math.round(T / designEffect);
        if (nStar >= 2 && nStar < T) { mode = 'deflated'; n = nStar; }
        else if (nStar < 2) return fail('fewer than two effective bars — the edge is a single-block event');
    }
    const dsrAdjusted = deflatedSharpeRatio({ sharpe: perBar, n, skew: sk, kurtosis: ku, trials });
    const dsrFullSample = deflatedSharpeRatio({ sharpe: perBar, n: T, skew: sk, kurtosis: ku, trials });
    if (!Number.isFinite(dsrAdjusted) || !Number.isFinite(dsrFullSample)) return fail('the deflated Sharpe is not finite');
    return {
        available: true, dsrAdjusted, dsrFullSample, designEffect, effectiveBars: n,
        bars: T, clusters: b, trials, mode, seCluster: jk.se, seIid,
        perBarSharpe: perBar, skew: sk, kurtosis: ku, reason: null,
    };
}

// The yearly decay attribution (round 76, TODO 105): the scored book grouped by
// calendar year of the EARNING bucket (`buildFundingBook` earns legs[i] under
// weights set at i-1, so bar t of a (B-1)-bar book labels at `times[t+1]` — the
// caller passes exactly that; any length mismatch fail-closes, never trims).
// Per year: bar count + per-bar Sharpe (the `scoreBookReturns` convention; a
// sub-2-bar year is unmeasurable, `netSharpe: null`, never a fabricated 0).
// `slope` is the OLS slope of measurable yearly Sharpes on calendar year —
// descriptive, deliberately NOT a test: a p-value on ~8 yearly Sharpes would be
// theater, and the G5 `decay` knob stays a human attestation either way. This
// is the evidence the attestation reads, beside `stressHalves`/`worstBlock`.

export function sleeveYearly({ net, times } = {}) {
    const fail = (reason) => ({ available: false, reason, years: [], slope: null });
    if (!Array.isArray(net) || !Array.isArray(times)) return fail('the book series and its bar times are required');
    if (net.length === 0) return fail('no scored bars');
    if (times.length !== net.length) {
        return fail(`the bar times (${times.length}) do not match the scored bars (${net.length})`);
    }
    for (const v of net) if (!Number.isFinite(v)) return fail('the scored book series is not finite');
    for (const t of times) if (!Number.isFinite(t)) return fail('a bar time is not finite');
    const byYear = new Map();
    for (let i = 0; i < net.length; i++) {
        const year = new Date(times[i]).getUTCFullYear();
        if (!Number.isInteger(year)) return fail('a bar time does not parse to a year');
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(net[i]);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b).map((year) => {
        const bars = byYear.get(year);
        return { year, bars: bars.length, netSharpe: bars.length >= 2 ? sharpeRatio(bars, { periodsPerYear: 1 }) : null };
    });
    const fit = years.filter((y) => Number.isFinite(y.netSharpe));
    let slope = null;
    if (fit.length >= 2) {
        const n = fit.length;
        let sx = 0, sy = 0;
        for (const y of fit) { sx += y.year; sy += y.netSharpe; }
        const mx = sx / n, my = sy / n;
        let num = 0, den = 0;
        for (const y of fit) { num += (y.year - mx) * (y.netSharpe - my); den += (y.year - mx) * (y.year - mx); }
        slope = den > 0 ? num / den : null;
    }
    if (slope !== null && !Number.isFinite(slope)) return fail('the yearly slope is not finite');
    return { available: true, years, slope, reason: null };
}

// The JSON-safe projection of a `sleeveYearly` result for the report artifact.

export function yearlyReport(y) {
    if (!y || y.available !== true) {
        return { available: false, slope: null, years: [], reason: (y && y.reason) || 'unscored' };
    }
    return {
        available: true, slope: y.slope, reason: null,
        years: y.years.map((r) => ({ year: r.year, bars: r.bars, netSharpe: r.netSharpe })),
    };
}

// The formal first-vs-last comparison (round 77, TODO 105): the scored book
// split into calendar halves at floor(T/2) — the same split `stressHalves`
// reads, so each per-half Sharpe matches the stress readout exactly — with a
// per-half Lo (2002) standard error and 95% interval, plus the second-minus-
// first difference with its combined SE. Descriptive, deliberately NOT a test:
// the halves are serially dependent, so the i.i.d. intervals understate the
// honest uncertainty (the DSR's cluster-robust SE beside it is the honest
// one), and the G5 `decay` knob stays a human attestation. This is the
// evidence the attestation reads: whether the second half sits below the
// first, and by how much with what (understated) precision.

export function sleeveFirstLast({ net } = {}) {
    const fail = (reason) => ({ available: false, reason, first: null, second: null, diff: null, seDiff: null, ciLow: null, ciHigh: null });
    if (!Array.isArray(net)) return fail('the book series is not an array');
    if (net.length < 4) return fail(`the book has ${net.length} bars — fewer than two bars per half`);
    for (const v of net) if (!Number.isFinite(v)) return fail('the scored book series is not finite');
    const h = Math.floor(net.length / 2);
    const half = (a) => {
        const perBarSharpe = sharpeRatio(a, { periodsPerYear: 1 });
        const sk = skewness(a);
        const ku = kurtosis(a);
        const se = sharpeStandardError({ sharpe: perBarSharpe, n: a.length, skew: sk, kurtosis: ku });
        if (!Number.isFinite(perBarSharpe) || !Number.isFinite(se)) return null;
        return {
            n: a.length, perBarSharpe, skew: sk, kurtosis: ku, se,
            ciLow: perBarSharpe - 1.96 * se, ciHigh: perBarSharpe + 1.96 * se,
        };
    };
    const first = half(net.slice(0, h));
    const second = half(net.slice(h));
    if (!first || !second) return fail('a half-book Sharpe interval is not finite');
    const diff = second.perBarSharpe - first.perBarSharpe;
    const seDiff = Math.sqrt(first.se * first.se + second.se * second.se);
    if (!Number.isFinite(seDiff)) return fail('the half-difference standard error is not finite');
    return {
        available: true, first, second, diff, seDiff,
        ciLow: diff - 1.96 * seDiff, ciHigh: diff + 1.96 * seDiff, reason: null,
    };
}

// The JSON-safe projection of a `sleeveFirstLast` result for the report artifact.

export function firstLastReport(f) {
    if (!f || f.available !== true) {
        return { available: false, first: null, second: null, diff: null, seDiff: null, ciLow: null, ciHigh: null, reason: (f && f.reason) || 'unscored' };
    }
    const proj = (x) => ({ n: x.n, perBarSharpe: x.perBarSharpe, se: x.se, ciLow: x.ciLow, ciHigh: x.ciHigh });
    return {
        available: true, first: proj(f.first), second: proj(f.second),
        diff: f.diff, seDiff: f.seDiff, ciLow: f.ciLow, ciHigh: f.ciHigh, reason: null,
    };
}

// The JSON-safe projection of a `sleeveDsr` result for the report artifact.
export function dsrReport(d) {
    if (!d || d.available !== true) {
        return { available: false, trials: SLEEVE_DSR_TRIALS, dsrAdjusted: null, reason: (d && d.reason) || 'unscored' };
    }
    return {
        available: true, trials: d.trials, mode: d.mode,
        dsrAdjusted: d.dsrAdjusted, dsrFullSample: d.dsrFullSample,
        designEffect: d.designEffect, effectiveBars: d.effectiveBars, bars: d.bars,
        clusters: d.clusters, seCluster: d.seCluster, seIid: d.seIid,
        perBarSharpe: d.perBarSharpe, reason: null,
    };
}
