// Book hygiene primitives — the ported `prototypes/port.js` chain.
//
// The lab's three deployable books (R8 cross-sectional carry dispersion, R7
// toptrader fade, the standalone OI sleeve) share ONE weight post-processing
// chain, extracted in `src/NeuLegion-lab/prototypes/port.js` and validated
// book-for-book by `e52_port_artefact.js` (F-60: 5/5 stored books reproduced).
// The V2 port moves that chain here, byte-for-byte, so the repo and the lab run
// the same code (the lab's experiment e73 imports these functions and asserts
// equality with `port.js`).
//
// Contract (the lab's PROTOCOL §4): PURE and POINT-IN-TIME. Each function takes
// weight ROWS (`[[w_j per symbol], ...]` in time order) and returns new rows; it
// reads nothing else, and row t depends only on rows <= t. No renormalisation is
// ever applied — the cap/band conventions clip-and-hold.
//
// Why this shape: the reusable recipe the repo lacked is not a signal, it is the
// *book hygiene* that made weak streams tradable — (1) a strict per-symbol cap
// (`1/k`, F-27/F-50) that is a tail winsorisation (F-54) and a concentration /
// capacity tool (F-52), and (2) a per-symbol no-trade band (F-52/F-53/F-58) that
// cuts churn by trading only when the target actually moves. Caps and bands are
// signal-agnostic, so they live in one place.
//
// FROZEN-PARAMETER RULE (F-49/F-55 for lambda, F-59 for the OI band's eps): any
// frozen parameter must be chosen on >= ~2.3 years (2555 8h-periods) of trailing
// data; shorter windows pick a fast lambda / the largest band.

import { fin } from './series.js';

export const MIN_TRAIN_PERIODS = 2555; // ~2.3 y at the lab's 8h grid (3 periods/day)

// Strict per-symbol cap (F-27): clip and HOLD — no renormalisation. At cap = 1/k
// this is the structural "no symbol may be more than an equal share" constraint.
export function clipWeights(weightRows, cap) {
    if (cap == null) return weightRows;
    return weightRows.map((w) => w.map((x) => (x > cap ? cap : x < -cap ? -cap : x)));
}

// Smooth saturation cap (F-54): the hard clip's level is what matters, not its
// form — `c*tanh(w/c)` matched the hard clip at c = 0.125 (net@4 6.04 vs 6.18)
// while a power shrinkage (`sign(w)|w|^p`) collapsed (4.44 -> 2.27 for p >= 1.25).
export function saturateWeights(weightRows, c) {
    if (c == null) return weightRows;
    return weightRows.map((w) => w.map((x) => c * Math.tanh(x / c)));
}

// Per-symbol no-trade band (F-52/F-53): move symbol j only when its target has
// moved more than `eps` from what is held; otherwise keep the held weight.
// Stateful in TIME only (row t reads rows <= t). Row 0 is its own reference, so
// it is returned unchanged.
export function bandWeights(weightRows, eps) {
    if (eps == null) return weightRows;
    if (!weightRows.length) return weightRows;
    let held = weightRows[0].slice();
    return weightRows.map((w) => {
        const out = w.map((x, j) => (Math.abs(x - held[j]) > eps ? x : held[j]));
        held = out;
        return out;
    });
}

// The chain. Order matters: CAP first, then BAND (F-52 found the band stacks on
// the capped book; a band on the raw book recovers almost none of the cap's
// benefit).
export function cleanBook(weightRows, { cap = null, bandEps = null } = {}) {
    return bandWeights(clipWeights(weightRows, cap), bandEps);
}

// ---- the small vector helpers the sleeves and the risk layer share ----------

export function sumAbs(row) {
    let acc = 0;
    for (let j = 0; j < row.length; j++) acc += Math.abs(row[j] || 0);
    return acc;
}

export function sumRow(row) {
    let acc = 0;
    for (let j = 0; j < row.length; j++) acc += row[j] || 0;
    return acc;
}

export function maxAbs(row) {
    let acc = 0;
    for (let j = 0; j < row.length; j++) { const a = Math.abs(row[j] || 0); if (a > acc) acc = a; }
    return acc;
}

// Normalise a row to sum|w| = 1 (the lab's `normRow` / policy `normalize`).
// A zero row is returned unchanged (the lab's `|| 1` guard, not NaN).
export function normalizeL1(row) {
    const g = sumAbs(row) || 1;
    return row.map((x) => x / g);
}

export function isValidRow(row) {
    return Array.isArray(row) && row.length > 0;
}

// Per-period L1 turnover of a weight-vector series (e16#turnoverSeries): the
// sum over symbols of |w_t - w_{t-1}|, with a zero book as the initial holding.
// A non-finite / non-numeric weight counts as 0 (the lab's `fin`), so an
// out-of-contract row cannot turn a turnover reading into `NaN`/`Infinity`.
export function turnoverSeries(weightRows) {
    if (!weightRows.length) return [];
    const k = weightRows[0].length;
    const out = new Array(weightRows.length).fill(0);
    let prev = new Array(k).fill(0);
    for (let t = 0; t < weightRows.length; t++) {
        const w = weightRows[t];
        let s = 0;
        for (let j = 0; j < k; j++) s += Math.abs(fin(w[j]) - fin(prev[j]));
        out[t] = s;
        prev = w;
    }
    return out;
}
