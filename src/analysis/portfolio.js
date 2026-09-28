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
export function scoreBookReturns(gross, weightRows, { costBps = 0 } = {}) {
    if (!Array.isArray(gross) || !gross.length) return null;
    for (const v of gross) if (!Number.isFinite(v)) return null;
    if (!Array.isArray(weightRows) || weightRows.length !== gross.length) return null;
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
export function scoreBook(weightRows, retRows, { costBps = 0 } = {}) {
    const gross = bookReturns(weightRows, retRows);
    if (!gross) return null;
    return scoreBookReturns(gross, weightRows, { costBps });
}

export function scoreSleeveBook(weightRows, retRows, panel, { costBps = 0 } = {}) {
    const book = scoreBook(weightRows, retRows, { costBps });
    if (!book) return null;
    const fn = Array.isArray(panel) && panel.length ? factorNeutralSharpe(book.net, panel) : { raw: book.netSharpe, neutral: NaN, residual: null };
    return { book, neutralSharpe: fn.neutral, rawSharpe: fn.raw, panelStreams: Array.isArray(panel) ? panel.length : 0 };
}

export function stressHalves(net) {
    if (!Array.isArray(net) || net.length < 4) return { first: NaN, second: NaN, min: NaN };
    for (const v of net) if (!Number.isFinite(v)) return { first: NaN, second: NaN, min: NaN };
    const h = Math.floor(net.length / 2);
    const sh = (a) => {
        const m = a.reduce((x, v) => x + v, 0) / a.length;
        let s = 0;
        for (const v of a) s += (v - m) * (v - m);
        const sd = a.length > 1 ? Math.sqrt(s / (a.length - 1)) : NaN;
        return sd > 0 ? m / sd : 0;
    };
    const first = sh(net.slice(0, h));
    const second = sh(net.slice(h));
    return { first, second, min: Math.min(first, second) };
}
export function worstBlock(net, blocks = 6) {
    const all = blockSharpes(net, blocks);
    if (!all) return NaN;
    let worst = Infinity;
    for (const sh of all) if (sh < worst) worst = sh;
    return worst;
}
export function blockSharpes(net, blocks = 6) {
    const k = Number.isInteger(blocks) ? blocks : Math.floor(blocks);
    if (!Array.isArray(net) || net.length < 1 || !Number.isFinite(k) || k < 1) return null;
    for (const v of net) if (!Number.isFinite(v)) return null;
    const size = Math.floor(net.length / k);
    if (size < 1) return null;
    const out = [];
    for (let b = 0; b < k; b++) {
        const seg = net.slice(b * size, (b + 1) * size);
        const m = seg.reduce((x, v) => x + v, 0) / seg.length;
        let s = 0;
        for (const v of seg) s += (v - m) * (v - m);
        const sd = seg.length > 1 ? Math.sqrt(s / (seg.length - 1)) : NaN;
        out.push(sd > 0 ? m / sd : 0);
    }
    return out;
}

// The tightened G5 conjunction (audit A8, round-31 G5): the first bankable
// positive result is not one number but five computable knobs plus two human
// attestations, all of which must hold. The machine checks what it can and
// RECORDS what only a human can (decay documentation, unseen data) — an
// attestation is pass-through, never computed, so the report can never claim a
// check it did not run.
//
// Knobs (all gating): `level` (net Sharpe at the stated cost above `minSharpe`),
// `blocks` (fraction of positive block Sharpes at/above `minBlockFraction`,
// default 4/6), `dsr` (`dsrAdjusted` at/above `minDsrAdjusted`, default 0.95 —
// null reads as fail, not skip: an unscored hurdle is not a cleared one),
// `neutral` (factor-neutral Sharpe above `minNeutralSharpe`, default 0),
// `capacity` (passes vacuously when no size is stated; a paper Sharpe with no
// size claim breaches nothing). Reported, never gating: split halves and the
// weakest block. `verdict` is the conjunction.
export function scoreG5({ net, costBps = 0, blocks = 6, dsrAdjusted = null, neutralSharpe = null, sizeUsd = null, capacityUsd = null, minSharpe = 0, minBlockFraction = 4 / 6, minDsrAdjusted = 0.95, minNeutralSharpe = 0, decayDocumented = false, unseenData = false } = {}) {
    const knobs = [];
    const reasons = [];
    const knob = (name, value, threshold, pass, gated = true, note = null) => {
        knobs.push({ knob: name, value, threshold, pass: !!pass, gated, note });
        if (gated && !pass) reasons.push(name);
    };
    const fin = (v) => typeof v === 'number' && Number.isFinite(v);
    const ok = Array.isArray(net) && net.length > 0 && net.every(fin);
    const mean = ok ? net.reduce((a, v) => a + v, 0) / net.length : NaN;
    let sd = NaN;
    if (ok && net.length > 1) {
        let s = 0;
        for (const v of net) s += (v - mean) * (v - mean);
        sd = Math.sqrt(s / (net.length - 1));
    }
    const level = sd > 0 ? mean / sd : 0;
    knob('level', ok ? level : null, minSharpe, ok && level > minSharpe, true, `net Sharpe at ${costBps} bps`);
    const all = ok ? blockSharpes(net, blocks) : null;
    const frac = all ? all.filter((x) => x > 0).length / all.length : null;
    knob('blocks', frac, minBlockFraction, frac !== null && frac + 1e-12 >= minBlockFraction, true, `${all ? all.filter((x) => x > 0).length : 0}/${all ? all.length : 0} positive blocks`);
    knob('dsr', fin(dsrAdjusted) ? dsrAdjusted : null, minDsrAdjusted,
        fin(dsrAdjusted) && dsrAdjusted >= minDsrAdjusted, true,
        fin(dsrAdjusted) ? null : 'dsrAdjusted was not scored — an unscored hurdle fails');
    knob('neutral', fin(neutralSharpe) ? neutralSharpe : null, minNeutralSharpe,
        fin(neutralSharpe) && neutralSharpe > minNeutralSharpe, true,
        fin(neutralSharpe) ? null : 'no factor-neutral readout — an unscored hurdle fails');
    if (sizeUsd === null && capacityUsd === null) {
        knob('capacity', null, null, true, true, 'no size claim — nothing to breach');
    } else {
        const capOk = fin(sizeUsd) && fin(capacityUsd) && capacityUsd > 0 && sizeUsd <= capacityUsd;
        knob('capacity', fin(sizeUsd) ? sizeUsd : null, fin(capacityUsd) ? capacityUsd : null, capOk, true,
            fin(sizeUsd) && fin(capacityUsd) ? `size $${sizeUsd} vs bound $${capacityUsd}` : 'size or bound not stated — an unscored hurdle fails');
    }
    const halves = ok && net.length >= 4 ? stressHalves(net) : { first: NaN, second: NaN, min: NaN };
    knob('halves', halves.min, null, true, false, `split-half Sharpes ${halves.first}/${halves.second} (reported, never gating)`);
    knob('worstBlock', all ? Math.min(...all) : null, null, true, false, 'weakest-block Sharpe (reported, never gating)');
    knob('decay', decayDocumented === true, true, decayDocumented === true, true, 'human attestation: a decay check is documented');
    knob('unseen', unseenData === true, true, unseenData === true, true, 'human attestation: scored on data the frozen spec did not select on');
    return { verdict: reasons.length === 0, reasons, knobs, costBps, blocks };
}
