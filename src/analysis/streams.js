// Buying effective independence, not bars (round 26, R26-6).
//
// The power run's verdict is a sample-size statement as much as a signal
// statement: 4,320 pooled bars over 8 streams, but the streams are crypto majors
// that move together, so the *effective* sample is smaller than the raw count
// (measured equicorrelation rho ~ 0.35-0.57 across the candidate family). Grinold
// (1989) is the finance statement of the fix — the information ratio scales with
// the square root of *breadth*, and breadth is the number of INDEPENDENT
// forecasts, not the number of bars — and Kish (1965) supplies the conversion:
//
//   designEffect = 1 + (K-1) * rhoBar        (the survey-sampling "deff")
//   effectiveStreams = K / designEffect
//   effectiveBars = rawBars / designEffect
//
// This module makes the stream basket a *measured* choice rather than a habit:
//
//   * `resampleCandles` aggregates N consecutive bars (e.g. 1h -> 4h), so a second
//     bar interval — a genuinely different horizon, not another copy of the same
//     one — can be added to the panel without shipping a second dataset;
//   * `designEffectOfStreams` measures the panel's Kish design effect from the
//     streams' own returns (or their per-fold Sharpe series, matching
//     `walkforward#dependenceSummary`);
//   * `selectStreams` greedily orders the candidates by their *marginal* effective
//     bars per raw bar (the cost law is `time ~= pooledBars x folds-per-stream`, so
//     a stream that adds no effective breadth is pure cost).
//
// Pure: no I/O, no RNG. The returned numbers feed the report; they never enter the
// scored arithmetic.

import { meanPairwiseCorrelation, equicorrelationDesignEffect } from './dependence.js';
import { sharpeRatio } from './performance.js';

// Aggregate every `factor` consecutive bars into one. `open` is the group's first
// open, `close` its last close, `high`/`low` the group extremes, `volume` the sum
// (a missing volume counts as 1, exactly like `world.js`), and `timestamp` the
// group's first timestamp. Only COMPLETE groups are emitted unless
// `keepIncomplete`; a trailing partial group is dropped so the resampled grid is
// regular (a partial bar silently misrepresents its period). Never mutates the
// input; `factor === 1` returns a shallow copy (the same bar objects, a new array).
export function resampleCandles(candles, { factor = 1, keepIncomplete = false } = {}) {
    if (!Array.isArray(candles)) throw new Error('resampleCandles: candles must be an array');
    if (!Number.isInteger(factor) || factor < 1) throw new Error(`resampleCandles: factor must be a positive integer (got ${factor})`);
    if (factor === 1) return candles.slice();
    const complete = keepIncomplete ? candles.length : candles.length - (candles.length % factor);
    const out = [];
    for (let from = 0; from < complete; from += factor) {
        const group = candles.slice(from, from + factor);
        let high = -Infinity;
        let low = Infinity;
        let volume = 0;
        for (const c of group) {
            if (Number.isFinite(c.high)) high = Math.max(high, c.high);
            if (Number.isFinite(c.low)) low = Math.min(low, c.low);
            volume += Number.isFinite(c.volume) ? c.volume : 1;
        }
        const open = Number.isFinite(group[0].open) ? group[0].open : group[0].close;
        const close = group[group.length - 1].close;
        out.push({
            timestamp: group[0].timestamp,
            open,
            high: Number.isFinite(high) ? high : Math.max(open, close),
            low: Number.isFinite(low) ? low : Math.min(open, close),
            close,
            volume,
        });
    }
    return out;
}

// Segment a series into per-fold Sharpe values (the same statistic
// `dependenceSummary` correlates across streams), falling back to the raw series
// when no usable fold length was supplied.
function segment(series, foldLength, periodsPerYear) {
    if (!Number.isInteger(foldLength) || foldLength < 3 || series.length % foldLength !== 0) return series;
    const out = [];
    for (let from = 0; from < series.length; from += foldLength) out.push(sharpeRatio(series.slice(from, from + foldLength), { periodsPerYear }));
    return out;
}

// The Kish design effect of a stream panel. `seriesByLabel` maps a stream label to
// its return series (one value per bar). Streams of different lengths are aligned
// on their most recent `T = min length` bars — the shared evaluation window. When
// `foldLength` is supplied (and tiles T) the correlation is taken between per-fold
// Sharpe series, matching `walkforward#dependenceSummary`; otherwise it is taken
// between the raw return series.
export function designEffectOfStreams(seriesByLabel, { foldLength = null, periodsPerYear = 252, labels = null, T: fixedT = null } = {}) {
    if (!seriesByLabel || typeof seriesByLabel !== 'object') {
        return { available: false, reason: 'no stream series supplied' };
    }
    const keys = Array.isArray(labels) && labels.length ? labels : Object.keys(seriesByLabel);
    if (keys.length < 1) return { available: false, reason: 'no streams supplied' };
    const series = keys.map((k) => seriesByLabel[k]);
    if (!series.every((s) => Array.isArray(s))) return { available: false, reason: 'a stream series is missing' };
    const T = Number.isInteger(fixedT) && fixedT > 0 ? Math.min(fixedT, ...series.map((s) => s.length)) : Math.min(...series.map((s) => s.length));
    if (T < 3) return { available: false, reason: 'the common window is shorter than three bars' };
    const aligned = series.map((s) => s.slice(-T));
    const K = keys.length;
    // A single stream is the trivial panel: no correlation to measure, design
    // effect 1, effective bars = raw bars. It is `available` so the selector can
    // score its first pick.
    if (K === 1) {
        return {
            available: true, labels: keys.slice(), K: 1, T,
            foldLength: Number.isInteger(foldLength) ? foldLength : null,
            method: 'single', periodsPerYear,
            meanPairwiseCorr: null, designEffect: 1, effectiveStreams: 1,
            rawBars: T, effectiveBars: T, effectiveBarsPerBar: 1,
            reader: 'a single stream: no cross-stream dependence to measure, design effect 1 (Kish 1965).',
        };
    }
    const method = Number.isInteger(foldLength) && foldLength >= 3 && T % foldLength === 0 ? 'fold-sharpe' : 'raw-returns';
    const corrSeries = method === 'fold-sharpe'
        ? aligned.map((s) => segment(s, foldLength, periodsPerYear))
        : aligned;
    const rbar = meanPairwiseCorrelation(corrSeries);
    const designEffect = equicorrelationDesignEffect(K, rbar);
    if (!Number.isFinite(designEffect) || designEffect <= 0) {
        return { available: false, reason: 'the pairwise correlation could not be estimated (constant or too-short streams)' };
    }
    const rawBars = K * T;
    const effectiveBars = rawBars / designEffect;
    return {
        available: true,
        labels: keys.slice(),
        K,
        T,
        foldLength: Number.isInteger(foldLength) ? foldLength : null,
        method,
        periodsPerYear,
        meanPairwiseCorr: rbar,
        designEffect,
        effectiveStreams: K / designEffect,
        rawBars,
        effectiveBars,
        // effective bars bought per raw bar processed: 1/DE. Under the measured
        // cost law (`time ~= pooledBars x folds-per-stream`) this is the efficiency
        // of the basket.
        effectiveBarsPerBar: 1 / designEffect,
        reader: 'Kish (1965) design effect 1+(K-1)*rbar over the streams\' per-fold Sharpe series (or raw returns when no fold length is supplied); effectiveBars = K*T/designEffect; effectiveStreams = K/designEffect. Grinold (1989): information ratio scales with sqrt(breadth), breadth = independent forecasts. A DIAGNOSTIC/DESIGN quantity — the scored arithmetic and the deflated Sharpe are unchanged.',
    };
}

// Greedy stream selection. Start from the empty set and repeatedly add the
// candidate that buys the most effective bars per raw bar added
// (`marginalEfficiency`); stop when the best remaining candidate cannot improve
// effective bars (marginalEfficiency <= `minMarginalEfficiency`) or `maxStreams`
// is reached. Deterministic: ties are broken by label order. The returned `order`
// ranks every candidate by its marginal contribution, so the caller can keep the
// first N.
export function selectStreams({ seriesByLabel, maxStreams = Infinity, minMarginalEfficiency = 0, foldLength = null, periodsPerYear = 252 } = {}) {
    const base = designEffectOfStreams(seriesByLabel, { foldLength, periodsPerYear });
    if (!base.available) return { available: false, reason: base.reason };
    const all = base.labels;
    const limit = Number.isFinite(maxStreams) && maxStreams > 0 ? Math.floor(maxStreams) : all.length;
    const chosen = [];
    const remaining = all.slice();
    const curve = [];
    let current = null; // last usable measurement
    while (chosen.length < Math.min(limit, all.length) && remaining.length) {
        let best = null;
        for (const label of remaining) {
            const candidate = designEffectOfStreams(seriesByLabel, { foldLength, periodsPerYear, labels: [...chosen, label], T: base.T });
            if (!candidate.available) continue;
            const prevBars = current ? current.effectiveBars : 0;
            const addedBars = candidate.rawBars - (current ? current.rawBars : 0);
            const marginal = candidate.effectiveBars - prevBars;
            const marginalEfficiency = addedBars > 0 ? marginal / addedBars : 0;
            const entry = { label, ...candidate, marginalBars: marginal, marginalEfficiency };
            // Best marginal efficiency; ties broken by label for determinism.
            if (!best || entry.marginalEfficiency > best.marginalEfficiency ||
                (entry.marginalEfficiency === best.marginalEfficiency && entry.label < best.label)) {
                best = entry;
            }
        }
        if (!best || best.marginalBars <= 0 || best.marginalEfficiency <= minMarginalEfficiency) break;
        chosen.push(best.label);
        remaining.splice(remaining.indexOf(best.label), 1);
        current = best;
        curve.push(best);
    }
    return {
        available: true,
        chosen: chosen.slice(),
        curve,
        order: curve.map((e) => e.label),
        baseline: base,
        maxStreams: Number.isFinite(maxStreams) ? Math.floor(maxStreams) : null,
        reader: 'greedy forward selection by marginal effective-bars-per-raw-bar (Grinold 1989 breadth / Kish 1965 design effect); deterministic tie-break by label. Diagnostic only — the scored arithmetic is unchanged.',
    };
}

// Render a compact selection block for the human summary.
export function formatStreamSelection(selection) {
    if (!selection) return null;
    if (!selection.available) return `streams: unavailable (${selection.reason})`;
    const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
    const b = selection.baseline;
    const lines = [`streams: ${b.K} streams, rbar=${f(b.meanPairwiseCorr)} (${b.method}) ` +
        `designEffect=${f(b.designEffect)} effectiveStreams=${f(b.effectiveStreams)} ` +
        `effectiveBars=${f(b.effectiveBars, 0)} of ${b.rawBars} raw`];
    for (const e of selection.curve) {
        lines.push(`streams +${e.label}: K=${e.K} DE=${f(e.designEffect)} ` +
            `effectiveBars=${f(e.effectiveBars, 0)} (+${f(e.marginalBars, 0)}) ` +
            `eff/bar=${f(e.marginalEfficiency)}`);
    }
    return lines.join('\n');
}
