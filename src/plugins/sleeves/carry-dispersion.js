// Sleeve R8 — cross-sectional carry dispersion (the lab's first deployable book).
//
// The spec is the lab's FINAL pinned recipe (`src/NeuLegion-lab/FOLD-BACK.md` R8,
// CYCLE-021/022/032/033 + F-50): rank the funding rate across the basket FROM THE
// PREVIOUS PERIOD, dollar-neutral, EWMA weights at lambda = 0.02, renormalised,
// with a strict 12.5 % per-symbol cap and NO band (the band does not stack on the
// capped fade; on the dispersion book the stacked band measured +0.18 but is not
// part of the pinned spec — F-52's `cap+band 6.31` is a documented variant, not
// the port).
//
// Why it matters: this is the only sleeve in the lab that is positive in EVERY
// crash measured (F-17/F-21: +2.98 / +13.18 / +5.51 in the 2022 bear / LUNA month
// / FTX month, while the flat carry book reads -1.43 / -4.19 / -5.12), because it
// trades the *dispersion* of funding, not the common carry level. It is the
// return source the project's own plan (round 31 W2) exists to land, and R8's
// honest size is tens of millions (OI-bound on LINK, F-41) — not a big book, but
// a real, decorrelated one.
//
// Falsifier (FOLD-BACK): the dispersion book's full-history Sharpe <= the flat
// book's, or its price correlation not lower. Not falsified on the extended
// history (5.03 vs 4.54 at a 2.93 % vs 7.96 % drawdown).

import { CAPABILITIES } from '../../core/contracts/base.js';
import { isSleevePlugin } from '../../core/contracts/sleeve.js';
import { buildFundingBook, cleanBook, fin, MIN_TRAIN_PERIODS, rowRankWeights } from '../../core/primitives/index.js';

export const CARRY_DISPERSION_SPEC = Object.freeze({
    policy: Object.freeze({ kind: 'ewma', lambda: 0.02, normalize: true }),
    cap: 0.125,
    bandEps: null,
    minTrainPeriods: MIN_TRAIN_PERIODS,
    feeBps: 4,
    costBpsBreakEven: 15.97,
    sizeUsd: Object.freeze({ neverBreach: 11.5e6, recent24mP5: 20.34e6 }),
    lineage: 'NL-DATA-carry-dispersion@r31',
});

export const carryDispersionSleeve = {
    id: 'carry-dispersion',
    capability: CAPABILITIES.SLEEVE,
    family: 'carry',
    speed: 'slow',
    spec: CARRY_DISPERSION_SPEC,

    // `view` carries the aligned funding panel:
    //   { fRate, basisPnl, times } — fRate[i][j] = per-period funding rate,
    //   basisPnl[i][j] = the marked basis P&L of the perp/spot pair.
    // `view.n` optionally overrides the book-grid length (default: the leg rows).
    signal(view) {
        requireView(view, ['fRate', 'basisPnl', 'times']);
        const base = buildFundingBook({
            fRate: view.fRate,
            basisPnl: view.basisPnl,
            times: view.times,
            targetFn: rowRankWeights,
            policy: CARRY_DISPERSION_SPEC.policy,
            n: view.n === undefined ? null : view.n,
        });
        return cleanBook(base.weightRows, { cap: CARRY_DISPERSION_SPEC.cap, bandEps: CARRY_DISPERSION_SPEC.bandEps });
    },

    // The book's own P&L, from the (cleaned) weights: period t holds the weight
    // and earns basis + funding at t+1 (e52's `r8Rets`).
    returns(view, weightRows) {
        return weightRows.map((w, t) => {
            const b = view.basisPnl[t + 1] || [];
            const f = view.fRate[t + 1] || [];
            return w.reduce((acc, x, j) => acc + x * (fin(b[j]) + fin(f[j])), 0);
        });
    },
};

function requireView(view, fields) {
    if (!view || typeof view !== 'object') throw new Error('carry-dispersion: a view object is required');
    for (const field of fields) {
        if (!Array.isArray(view[field]) || !view[field].length) throw new Error(`carry-dispersion: view.${field} must be a non-empty array`);
    }
}

export const isCarryDispersion = (impl) => isSleevePlugin(impl) && impl.id === carryDispersionSleeve.id;
