// The portfolio / risk layer (round 31, W3 — the round-30 `C-BREADTH` slot).
//
// The lab's three deployable books share one weight post-processing chain
// (`src/NeuLegion-lab/prototypes/port.js`, validated book-for-book by
// `e52_port_artefact.js`, F-60). This module vendors that chain (cap/band/clean,
// the pinned sleeve specs, the ~2.3 y minimum) and adds the risk-layer
// primitives the repo needs to HOLD a book: inverse-vol weighting, vol
// targeting, the clipped trailing-median OI schedule (F-42) and the fixed-split
// joint size (F-43/F-44). Pure, point-in-time, no I/O, no RNG.
//
// Conventions (from the lab): clip-and-HOLD, never renormalise; the cap is a
// tail winsorisation (F-54), not a shrink; the band is the general cost tool
// (F-52/F-53/F-58) and stacks on the cap for R8 only.

import { factorNeutralSharpe } from './dependence.js';

export const MIN_TRAIN_PERIODS = 2555;
const FIN = (v) => typeof v === 'number' && Number.isFinite(v);

export function clipWeights(weightRows, cap) {
    if (cap == null) return weightRows;
    return weightRows.map((w) => w.map((x) => (x > cap ? cap : x < -cap ? -cap : x)));
}

export function bandWeights(weightRows, eps) {
    if (eps == null) return weightRows;
    if (!Array.isArray(weightRows) || !weightRows.length) return weightRows;
    let held = weightRows[0].slice();
    return weightRows.map((w) => {
        const out = w.map((x, j) => (Math.abs(x - held[j]) > eps ? x : held[j]));
        held = out;
        return out;
    });
}

export function cleanBook(weightRows, { cap = null, bandEps = null } = {}) {
    return bandWeights(clipWeights(weightRows, cap), bandEps);
}

export const SLEEVE_SPECS = {
    R8: { name: 'carry dispersion', cap: 0.125, bandEps: 0.005 },
    R7: { name: 'toptrader fade', cap: 0.125, bandEps: null },
    OI: { name: 'OI-change 50/50', cap: null, bandEps: 0.03 },
};

export function cleanForSleeve(weightRows, sleeve) {
    const spec = SLEEVE_SPECS[sleeve];
    if (!spec) throw new Error(`unknown sleeve: ${sleeve}`);
    return cleanBook(weightRows, { cap: spec.cap, bandEps: spec.bandEps });
}

const variance = (s) => {
    const xs = s.filter(FIN);
    if (xs.length < 2) return NaN;
    const m = xs.reduce((a, v) => a + v, 0) / xs.length;
    return xs.reduce((a, v) => a + (v - m) * (v - m), 0) / (xs.length - 1);
};

// Inverse-volatility weights across streams (the R4 sizing half, F-16B).
// Zero/degenerate-vol streams get weight 0; the weights sum to 1 when at
// least one stream has positive vol, else all 0.
export function inverseVolWeights(streams) {
    const vols = streams.map((s) => {
        const v = variance(s);
        return FIN(v) && v > 0 ? Math.sqrt(v) : NaN;
    });
    const inv = vols.map((v) => (FIN(v) && v > 0 ? 1 / v : 0));
    const total = inv.reduce((a, v) => a + v, 0);
    if (!(total > 0)) return inv.map(() => 0);
    return inv.map((v) => v / total);
}

// Vol-target scale for a return series: target / realised vol (NaN when the
// series has no positive realised vol). The LEVEL is not banked — the caller
// re-estimates it causally (L09/F-16: an EWMA is the forecaster).
export function volTargetScale(returns, targetVol) {
    if (!(targetVol > 0)) return NaN;
    const v = variance(returns);
    if (!FIN(v) || !(v > 0)) return NaN;
    return targetVol / Math.sqrt(v);
}

// The clipped trailing-median OI schedule (F-42): size to the trailing median
// of the per-period capacity, hard-clipped at f * min_j OI_j(t)/|w_j(t)| —
// never a fixed number, never a smoothed target. Returns 0 when no weight is
// deployed or no capacity is measurable.
export function clippedTrailingMedianSchedule(capacities, { lookback = 26, f = 0.05 } = {}) {
    if (!Array.isArray(capacities) || !capacities.length) return 0;
    const win = capacities.slice(-Math.max(1, lookback)).filter((v) => FIN(v) && v > 0);
    if (!win.length) return 0;
    win.sort((a, b) => a - b);
    const mid = Math.floor(win.length / 2);
    const median = win.length % 2 ? win[mid] : (win[mid - 1] + win[mid]) / 2;
    const cap = capacities[capacities.length - 1];
    if (FIN(cap) && cap > 0) return Math.min(median, f * cap);
    return median;
}

// The fixed-split joint size (F-43/F-44): a portfolio of sleeve books is sized
// to the fixed-split joint bound — never the LP-optimal schedule (48.5x
// gross/yr for net@4 0.62). `sizes` are per-sleeve deployable sizes, `w` the
// fixed capital split (sums to 1); the joint is sum(w_i * sizes_i).
export function fixedSplitJointSize(sizes, w) {
    if (!Array.isArray(sizes) || !Array.isArray(w) || sizes.length !== w.length || !sizes.length) return NaN;
    let acc = 0;
    for (let i = 0; i < sizes.length; i++) {
        if (!FIN(sizes[i]) || !FIN(w[i])) return NaN;
        acc += w[i] * sizes[i];
    }
    return acc;
}

export function bookReturns(weightRows, retRows) {
    if (!Array.isArray(weightRows) || !Array.isArray(retRows) || weightRows.length !== retRows.length || !weightRows.length) return null;
    const out = [];
    for (let i = 0; i < weightRows.length; i++) {
        const w = weightRows[i], r = retRows[i];
        if (!Array.isArray(w) || !Array.isArray(r) || w.length !== r.length) return null;
        let a = 0;
        for (let j = 0; j < w.length; j++) {
            if (!Number.isFinite(w[j]) || !Number.isFinite(r[j])) return null;
            a += w[j] * r[j];
        }
        out.push(a);
    }
    return out;
}
export function bookTurnover(weightRows) {
    if (!Array.isArray(weightRows) || weightRows.length < 2) return 0;
    let a = 0;
    for (let i = 1; i < weightRows.length; i++) {
        const p = weightRows[i - 1], c = weightRows[i];
        if (!Array.isArray(p) || !Array.isArray(c) || p.length !== c.length) return NaN;
        for (let j = 0; j < c.length; j++) {
            if (!Number.isFinite(p[j]) || !Number.isFinite(c[j])) return NaN;
            a += Math.abs(c[j] - p[j]);
        }
    }
    return a;
}
export function scoreBook(weightRows, retRows, { costBps = 0 } = {}) {
    const gross = bookReturns(weightRows, retRows);
    if (!gross) return null;
    const n = gross.length;
    const mg = gross.reduce((a, v) => a + v, 0) / n;
    let sg = 0;
    for (const v of gross) sg += (v - mg) * (v - mg);
    sg = n > 1 ? Math.sqrt(sg / (n - 1)) : NaN;
    const to = bookTurnover(weightRows);
    if (!Number.isFinite(to)) return null;
    const cost = (costBps / 1e4) * to / n;
    const net = gross.map((v) => v - cost);
    const mn = net.reduce((a, v) => a + v, 0) / n;
    let sn = 0;
    for (const v of net) sn += (v - mn) * (v - mn);
    sn = n > 1 ? Math.sqrt(sn / (n - 1)) : NaN;
    const be = to > 0 ? (1e4 * gross.reduce((a, v) => a + v, 0)) / to : null;
    return {
        gross, net,
        grossSharpe: sg > 0 ? mg / sg : 0,
        netSharpe: sn > 0 ? mn / sn : 0,
        turnover: to,
        turnoverPerYear: to,
        breakEvenCostBps: be,
    };
}

export function scoreSleeveBook(weightRows, retRows, panel, { costBps = 0 } = {}) {
    const book = scoreBook(weightRows, retRows, { costBps });
    if (!book) return null;
    const fn = Array.isArray(panel) && panel.length ? factorNeutralSharpe(book.net, panel) : { raw: book.netSharpe, neutral: NaN, residual: null };
    return { book, neutralSharpe: fn.neutral, rawSharpe: fn.raw, panelStreams: Array.isArray(panel) ? panel.length : 0 };
}
