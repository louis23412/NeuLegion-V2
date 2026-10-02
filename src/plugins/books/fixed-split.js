// `fixed-split` — a book of sleeves combined at FIXED capital fractions.
//
// This is the composition the lab's joint work says to deploy: F-43 measured that
// running R7 and R8 at their individual sizes breaches the 5 %-of-OI cap in 78 %
// of periods (the individual sizes do NOT add — both bind on the same thin alts),
// and F-44 showed the exact joint LP's free split is ~the sum only at an unstable,
// high-churn schedule (48.5x gross/yr for net@4 0.62). The recommendation is
// therefore a fixed split sized against the JOINT bound — not the LP.
//
// Alignment: different sleeves start at different times (R7's toptrader panel and
// the OI panel begin later than the funding panel), so the book is defined on the
// INTERSECTION of the sleeves' book times, in the first entry's time order. That
// is a real decision, not an implementation detail: it is what makes a joint
// statement comparable to the single-sleeve one (a silently zero-filled leading
// window would understate the joint book).

import { CAPABILITIES } from '../../core/contracts/base.js';
import { isBookPlugin } from '../../core/contracts/book.js';

// The index map of the entries' shared time grid: `keep[t]` is the per-entry row
// index of the t-th common time. Exported so a test can pin the alignment.
export function commonTimeIndexes(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('book: at least one sleeve entry is required');
    for (const entry of entries) {
        if (!Array.isArray(entry.rows)) throw new Error('book: entry.rows must be a weight-row array');
    }
    const first = entries[0];
    if (!Array.isArray(first.times)) {
        // No time grid: all sleeves must already be row-aligned.
        const n = first.rows.length;
        for (const entry of entries) {
            if (entry.rows.length !== n) throw new Error(`book: entries without times must share a row count (${first.rows.length} vs ${entry.rows.length})`);
        }
        return { hasTimes: false, keep: Array.from({ length: n }, (_, i) => entries.map(() => i)), times: null };
    }
    const maps = entries.slice(1).map((entry) => new Map(entry.times.map((t, i) => [t, i])));
    const keep = [];
    for (let i = 0; i < first.times.length; i++) {
        const t = first.times[i];
        const indexes = [i];
        let present = true;
        for (const map of maps) {
            if (!map.has(t)) { present = false; break; }
            indexes.push(map.get(t));
        }
        if (present) keep.push(indexes);
    }
    return { hasTimes: true, keep, times: keep.map((indexes) => first.times[indexes[0]]) };
}

export const fixedSplitBook = {
    id: 'fixed-split',
    capability: CAPABILITIES.AGNOSTIC,
    constraints: Object.freeze({ maxSleeves: null, renormalize: false }),

    // `entries` = [{ rows, times, weight }]. Weights default to equal capital and
    // must sum to 1 (a split, not a leverage decision — sizing is the risk layer's).
    compose(entries) {
        const { keep, times } = commonTimeIndexes(entries);
        const n = entries.length;
        const weights = entries.map((entry) => (entry.weight === undefined ? 1 / n : entry.weight));
        const total = weights.reduce((a, b) => a + b, 0);
        if (Math.abs(total - 1) > 1e-9) throw new Error(`fixed-split: entry weights must sum to 1, got ${total}`);
        const k = entries[0].rows[0] ? entries[0].rows[0].length : 0;
        const weightRows = keep.map((indexes) => {
            const row = new Array(k).fill(0);
            entries.forEach((entry, e) => {
                const source = entry.rows[indexes[e]] || [];
                for (let j = 0; j < k; j++) row[j] += weights[e] * (Number.isFinite(source[j]) ? source[j] : 0);
            });
            return row;
        });
        return { weightRows, bookTimes: times, weights };
    },
};

export const isFixedSplitBook = (impl) => isBookPlugin(impl) && impl.id === fixedSplitBook.id;
