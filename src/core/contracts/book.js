// `Book` — the composition of sleeves into one weight series (audit A11).
//
// Kept separate from both the sleeves and the risk policy because the lab's
// measured object is a *portfolio*: F-43/F-44 show the fixed split and the joint
// LP differ (the LP's free split is ~the sum of the individual bounds but only
// reachable at 48.5x/yr gross turnover for net@4 0.62), so the composition rule
// must be a first-class, swappable decision.

import { defineContract, validatePlugin } from './base.js';

export const BOOK_CONTRACT = defineContract({
    kind: 'book',
    purpose: 'compose sleeve weight series into one book, with declared constraints',
    requires: ['compose'],
    optional: ['fingerprint'],
});

export const isBookPlugin = (impl) => validatePlugin(BOOK_CONTRACT, impl).ok;
