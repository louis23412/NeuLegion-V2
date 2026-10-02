// `single` — the trivial book: one sleeve, no composition.
//
// Kept as a plugin (rather than a special case) so `score(book)` has exactly one
// shape: the lab's R8/R7/OI readings are all single-sleeve books, and every
// joint statement (F-43/F-44) is a comparison against this one.

import { CAPABILITIES } from '../../core/contracts/base.js';
import { isBookPlugin } from '../../core/contracts/book.js';

export const singleBook = {
    id: 'single',
    capability: CAPABILITIES.AGNOSTIC,
    constraints: Object.freeze({ maxSleeves: 1 }),

    // `entries` = [{ rows, times, weight }] — exactly one, whose weight must be 1
    // (a single book is the sleeve's own weights; scaling it is the risk layer's
    // job, not the book's).
    compose(entries) {
        if (!Array.isArray(entries) || entries.length !== 1) {
            throw new Error(`single book takes exactly one sleeve entry, got ${Array.isArray(entries) ? entries.length : 'no'} entries`);
        }
        const [entry] = entries;
        if (!Array.isArray(entry.rows)) throw new Error('single book: entry.rows must be a weight-row array');
        if (entry.weight !== undefined && entry.weight !== 1) throw new Error('single book: the entry weight must be 1 (use the risk layer to size a book)');
        return { weightRows: entry.rows, bookTimes: entry.times ? entry.times.slice() : null, weights: [1] };
    },
};

export const isSingleBook = (impl) => isBookPlugin(impl) && impl.id === singleBook.id;
