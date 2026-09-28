// The two book constructions the sleeves share.
//
// Both are verbatim ports of the lab's constructions, because the lab's numbers
// are only a claim about the *lab's* code until the repo runs the same arithmetic:
//
//   `buildFundingBook`          <- e17_low_turnover.js#buildBook (the R8 shell:
//                                  target from funding at t-1, P&L = basis + funding at t)
//   `buildCrossSectionalBook`   <- e21_open_interest.js#xsBookImpl /
//                                  e22_toptrader_validate.js#buildMasked (identical
//                                  formulas; the masked demean, the policy, the
//                                  forward `spotRet[i + NEXT]`)
//
// Causality is the whole point and is the lab's documented convention: the book
// grid is the aligned leg grid, a book period uses the signal snapshot at (or
// before) its own index, and earns the NEXT-period forward return, so no period's
// signal can earn its own move. `e52_port_artefact.js` is the reference output
// (F-60) and the lab's `e73_port_verify.js` reproduces it from THIS module.
//
// `n` — the BOOK GRID LENGTH — is an explicit input because the lab's own
// experiments disagree on where it comes from: e17's `buildBook` reads
// `legs.times.length`, e21/e22 read `legs.spotRet.length`, and `e52` then hands
// `xsBookImpl` the shorter `times` array. A single hard-coded rule therefore cannot
// reproduce all three published books, so the rule is the caller's: `n` defaults to
// the leg rows (the funding/spot arrays), and a caller with a different grid passes
// it in. The book times are read defensively (`null` past the end of `times`).
//
// The `counter` a `hold` policy is phased on is PER PRODUCED ROW, starting at 0
// (row 0 is a rebalance), in BOTH builders — the lab's `e17#buildBook` convention.
// `buildCrossSectionalBook` used to pass its absolute grid index `i` instead, so
// the same policy object phased differently in the two shells; that was unified.

import { applyWeightPolicy, crossSectionalTarget, fin } from './series.js';
import { normalizeL1 } from './weights.js';

const normalize = (row, policy) => (policy && policy.normalize ? normalizeL1(row) : row);

// R8's construction shell: a target from the PREVIOUS period's funding row, a
// weight policy, and P&L of `sum_j w_j * (basisPnl_t[j] + fRate_t[j])`.
export function buildFundingBook({ fRate, basisPnl, times, targetFn, policy, n = null }) {
    const steps = n === null ? fRate.length : n;
    const k = fRate[0] ? fRate[0].length : 0;
    const weightRows = [];
    const rets = [];
    const bookTimes = [];
    let held = new Array(k).fill(0);
    let counter = 0;
    for (let i = 1; i < steps; i++) {
        const target = targetFn(fRate[i - 1]);
        held = normalize(applyWeightPolicy(held, target, policy, counter), policy);
        counter += 1;
        weightRows.push(held.slice());
        const b = basisPnl[i] || [];
        const f = fRate[i] || [];
        let acc = 0;
        for (let j = 0; j < k; j++) acc += held[j] * (fin(b[j]) + fin(f[j]));
        rets.push(acc);
        bookTimes.push(times && i < times.length ? times[i] : null);
    }
    return { weightRows, rets, bookTimes };
}

// The masked cross-sectional book: signal `sig[j][i]` at book index i, forward
// return `spotRet[i + NEXT][j]`. Missing symbols are excluded from the demean and
// held at 0 (never zeroed out of the mean — L10-r); a `null` COLUMN (`sig[j] ===
// null`, a symbol with no series at all) is masked exactly the same way.
export function buildCrossSectionalBook({ sig, spotRet, times, NEXT = 2, from = 0, sign = 1, policy = { kind: 'daily' }, n = null }) {
    const steps = n === null ? spotRet.length : n;
    const k = sig.length;
    const weightRows = [];
    const rets = [];
    const bookTimes = [];
    let held = new Array(k).fill(0);
    let counter = 0;
    for (let i = Math.max(1, from); i < steps - 1; i++) {
        const row = new Array(k);
        for (let j = 0; j < k; j++) row[j] = sig[j] ? sig[j][i] : null;
        const { target } = crossSectionalTarget(row, sign);
        held = normalize(applyWeightPolicy(held, target, policy, counter), policy);
        counter += 1;
        weightRows.push(held.slice());
        const forward = spotRet[i + NEXT] || [];
        let acc = 0;
        for (let j = 0; j < k; j++) acc += held[j] * fin(forward[j]);
        rets.push(acc);
        bookTimes.push(times && i < times.length ? times[i] : null);
    }
    return { weightRows, rets, bookTimes };
}

// Turn a raw signal-by-symbol matrix into the diagonal-log form the OI sleeve
// trades (Δlog of a strictly positive level per symbol).
//
// A column with NO records at all (a symbol the source has none of — e21's
// `fieldBySym` returns `null` for it) yields a `null` COLUMN rather than throwing;
// e21's `dlog(arr, i)` guard (`if (!arr) return null`) produces the same thing one
// index at a time, so a `null` column means "this symbol is absent everywhere".
// Every cross-sectional consumer treats it that way (`firstCommonIndex` can never
// complete a cross-section, `buildCrossSectionalBook` masks it). The guard sits at
// the OUTER level (R31c): inside the callback `series` is always the array being
// mapped, so `!series` there was dead code.
export function dlogMatrix(levelBySymbol) {
    return levelBySymbol.map((series) => {
        if (!series) return null;
        return series.map((_, i) => {
            if (i === 0) return null;
            const a = series[i];
            const b = series[i - 1];
            return (a > 0 && b > 0) ? Math.log(a / b) : null;
        });
    });
}

// A 50/50 capital blend of two separately-constructed books (F-46's construction,
// which F-56/F-57/F-58 then held to be the sleeve's final recipe). A non-finite or
// absent second leg counts as 0 via the lab's `fin` — uniform with `blendRows`/
// `ewmaUpdate` and the rest of the primitives, so an out-of-contract row cannot
// inject NaN/Infinity into the blended book (R31c).
export function blendBooks(bookA, bookB, weightA = 0.5) {
    const rows = bookA.weightRows.map((row, i) => {
        const other = bookB.weightRows[i] || [];
        return normalizeL1(row.map((x, j) => weightA * x + (1 - weightA) * fin(other[j])));
    });
    return { weightRows: rows, rets: null, bookTimes: bookA.bookTimes };
}
