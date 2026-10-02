// Sleeve R7 — the cross-sectional toptrader-ratio fade.
//
// Spec (FOLD-BACK R7, finalised by CYCLE-023/034/036 = F-40 → F-51 → F-53): the
// top-trader long/short ratio as a cross-sectional panel stream, demeaned, sign
// -1 (FADE the crowded side — a prior, not a fitted sign: validated held-out by
// e22/F-30), EWMA weights at lambda = 0.05 PINNED (the walk-forward rule loses
// here: OOS net@4 0.70 vs the pinned 1.14, F-51), renormalised, with a strict
// 12.5 % cap and NO band (a band at the cap's own turnover reads 0.78 — BELOW the
// uncapped base 0.82 — and the whole band sweep stays in [0.78, 0.95], F-53).
//
// The fade matters because it comes from NEW data (Binance futures metrics) and is
// independent of carry (rho ~ 0), but it is weak (Sharpe ~1.07) and its honest
// size is the OI schedule's ~$12-22 M (F-41), run as its own sleeve — never
// assumed additive with R8 (F-43: the two bind on the same thin alts).

import { CAPABILITIES } from '../../core/contracts/base.js';
import { isSleevePlugin } from '../../core/contracts/sleeve.js';
import { buildCrossSectionalBook, cleanBook, fin, firstCommonIndex, MIN_TRAIN_PERIODS } from '../../core/primitives/index.js';

export const TOPTRADER_FADE_SPEC = Object.freeze({
    policy: Object.freeze({ kind: 'ewma', lambda: 0.05, normalize: true }),
    sign: -1,
    cap: 0.125,
    bandEps: null,
    NEXT: 2,
    minTrainPeriods: MIN_TRAIN_PERIODS,
    feeBps: 4,
    sizeUsd: Object.freeze({ neverBreach: 12.62e6, recent24mP5: 21.87e6 }),
    lineage: 'NL-DATA-toptrader-fade@r31',
});

const topStartOf = (view) => {
    const k = view.topLS.length;
    return Math.max(1, Number.isInteger(view.from) ? view.from : firstCommonIndex(view.topLS, k));
};

export const toptraderFadeSleeve = {
    id: 'toptrader-fade',
    capability: CAPABILITIES.SLEEVE,
    family: 'positioning',
    speed: 'medium',
    spec: TOPTRADER_FADE_SPEC,

    // `view` carries { topLS, spotRet, times } (topLS[j][i] = the ratio for
    // symbol j at time i; spotRet[i][j] = the spot return over (i-1, i]).
    signal(view) {
        if (!Array.isArray(view && view.topLS) || !view.topLS.length) throw new Error('toptrader-fade: view.topLS must be a non-empty array of series');
        const k = view.topLS.length;
        const from = Number.isInteger(view.from) ? view.from : firstCommonIndex(view.topLS, k);
        if (from < 0) return [];
        const base = buildCrossSectionalBook({
            sig: view.topLS,
            spotRet: view.spotRet,
            times: view.times,
            NEXT: TOPTRADER_FADE_SPEC.NEXT,
            from,
            sign: TOPTRADER_FADE_SPEC.sign,
            policy: TOPTRADER_FADE_SPEC.policy,
            n: view.n === undefined ? null : view.n,
        });
        return cleanBook(base.weightRows, { cap: TOPTRADER_FADE_SPEC.cap, bandEps: TOPTRADER_FADE_SPEC.bandEps });
    },

    // Period t holds the weight and earns spotRet at (start + t + NEXT), exactly as
    // `buildMasked` does — where `start = max(1, from)` is the SAME effective start
    // `buildCrossSectionalBook` uses (its loop runs from `max(1, from)`), so the
    // returned rows are already offset by `start`. Reading bare `from` was an
    // off-by-one when a caller passed `from: 0` (the builder clamped, `returns` did
    // not).
    //
    // `earnTimes(view, weightRows)` names the earning bucket per scored row
    // for the yearly attribution (round 80; see oi-change for the trailing-row
    // convention).
    returns(view, weightRows) {
        const start = topStartOf(view);
        return weightRows.map((w, t) => {
            const forward = view.spotRet[start + t + TOPTRADER_FADE_SPEC.NEXT] || [];
            return w.reduce((acc, x, j) => acc + x * fin(forward[j]), 0);
        });
    },

    earnTimes(view, weightRows) {
        const start = topStartOf(view);
        const last = view.times[view.times.length - 1];
        return weightRows.map((_, t) => view.times[start + t + TOPTRADER_FADE_SPEC.NEXT] ?? last);
    },
};

export const isToptraderFade = (impl) => isSleevePlugin(impl) && impl.id === toptraderFadeSleeve.id;
