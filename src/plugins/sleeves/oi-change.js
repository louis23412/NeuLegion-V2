// Sleeve OI — the standalone open-interest-change book.
//
// Spec (FOLD-BACK R7's OI branch, finalised by CYCLE-039/041/042 = F-56 → F-58 →
// F-59): the cross-sectional Δlog(open-interest value), sign +1, built as the
// 50/50 capital blend of two separately-constructed EWMA books (lambda 0.1 and
// 0.25 — F-46's unfitted ensemble; no fixed non-equal mix beats equal capital,
// F-56), renormalised, with NO cap and a per-symbol no-trade band at eps = 0.03
// (the cadence route was a spike: hold-6 reads 0.87 on a fine grid but is an
// isolated point, F-57; the band is a smooth plateau and beats the frozen-cadence
// rule at 11/11 splits, F-59).
//
// It is a WEAK, churny, standalone sleeve (net@4 0.92, turnover 198x/yr,
// break-even 15.22 bps, positive every year 2022-26) and the plan does NOT treat
// it as a joint member with R8 (F-43/F-47: both bind on the same thin alts).
// `eps` is PINNED: a trailing pick is unstable below ~2.3 y and collapses to the
// largest band, underperforming fixed 0.03 OOS (1.03-1.22 vs 1.40-1.65).

import { CAPABILITIES } from '../../core/contracts/base.js';
import { SLEEVE_CONTRACT, isSleevePlugin } from '../../core/contracts/sleeve.js';
import { blendBooks, buildCrossSectionalBook, cleanBook, dlogMatrix, fin, firstCommonIndex, MIN_TRAIN_PERIODS } from '../../core/primitives/index.js';

export const OI_CHANGE_SPEC = Object.freeze({
    policies: Object.freeze([
        Object.freeze({ kind: 'ewma', lambda: 0.1, normalize: true }),
        Object.freeze({ kind: 'ewma', lambda: 0.25, normalize: true }),
    ]),
    sign: 1,
    cap: null,
    bandEps: 0.03,
    NEXT: 2,
    minTrainPeriods: MIN_TRAIN_PERIODS,
    feeBps: 4,
    breakEvenBps: 15.22,
    lineage: 'NL-DATA-oi-change@r31',
});

const oiStartOf = (view) => {
    const k = view.oiValue.length;
    return Math.max(1, Number.isInteger(view.from) ? view.from : firstCommonIndex(dlogMatrix(view.oiValue), k));
};

export const oiChangeSleeve = {
    id: 'oi-change',
    capability: CAPABILITIES.SLEEVE,
    family: 'positioning',
    speed: 'fast',
    spec: OI_CHANGE_SPEC,
    // `view` carries { oiValue, spotRet, times } (oiValue[j][i] = the per-symbol
    // open-interest notional level; the sleeve differences it itself).
    signal(view) {
        if (!Array.isArray(view && view.oiValue) || !view.oiValue.length) throw new Error('oi-change: view.oiValue must be a non-empty array of series');
        const k = view.oiValue.length;
        const sig = dlogMatrix(view.oiValue);
        const from = Number.isInteger(view.from) ? view.from : firstCommonIndex(sig, k);
        if (from < 0) return [];
        const build = (policy) => buildCrossSectionalBook({
            sig,
            spotRet: view.spotRet,
            times: view.times,
            NEXT: OI_CHANGE_SPEC.NEXT,
            from,
            sign: OI_CHANGE_SPEC.sign,
            policy,
            n: view.n === undefined ? null : view.n,
        });
        const blended = blendBooks(build(OI_CHANGE_SPEC.policies[0]), build(OI_CHANGE_SPEC.policies[1]));
        return cleanBook(blended.weightRows, { cap: OI_CHANGE_SPEC.cap, bandEps: OI_CHANGE_SPEC.bandEps });
    },

    // Row t is the weight held over the book period with signal index
    // `start + t`, so it earns `spotRet[start + t + NEXT]` — the SAME effective
    // start (`max(1, from)`) `buildCrossSectionalBook` clamps to. Reading bare
    // `from` was an off-by-one for a caller passing `from: 0`.
    //
    // `earnTimes(view, weightRows)` names the earning bucket per scored row
    // for the yearly attribution (round 80): row t earns the bucket at
    // `start + t + NEXT`. The trailing row earns past the last bucket (the
    // builder's `fin` guard scores it 0, never NaN) — it attributes to the
    // final bucket, stated, diluting the last year by one zero bar.
    returns(view, weightRows) {
        const start = oiStartOf(view);
        return weightRows.map((w, t) => {
            const forward = view.spotRet[start + t + OI_CHANGE_SPEC.NEXT] || [];
            return w.reduce((acc, x, j) => acc + x * fin(forward[j]), 0);
        });
    },

    earnTimes(view, weightRows) {
        const start = oiStartOf(view);
        const last = view.times[view.times.length - 1];
        return weightRows.map((_, t) => view.times[start + t + OI_CHANGE_SPEC.NEXT] ?? last);
    },
};

export const isOiChange = (impl) => isSleevePlugin(impl) && impl.id === oiChangeSleeve.id;
