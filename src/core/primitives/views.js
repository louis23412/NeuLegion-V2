// The one-view rule (audit A16; `BUGS.md` #33 generalised).
//
// The A/B driver once built its own candle window, so the model was scored on one
// view and perturbed on another and a real look-ahead leak read clean. The rule
// the V2 runtime must obey is: the runtime produces the view, and the evaluator
// consumes the SAME view. This module makes "same view" a checkable statement
// rather than a convention.

import { fingerprint } from './fingerprint.js';

// The identity of a view: the data that decides what a consumer sees. A view may
// carry extra metadata (labels, params) that must not change its identity — only
// the rows/times/symbols do.
export function viewIdentity(view) {
    if (view == null) return { candles: null, times: null, symbols: null, n: null };
    const rows = view.candles || view.rows || null;
    return {
        candles: rows,
        times: view.times || null,
        symbols: view.symbols || null,
        n: rows ? rows.length : (view.n ?? null),
    };
}

export function viewFingerprint(view) {
    return fingerprint(viewIdentity(view));
}

export function sameView(a, b) {
    return viewFingerprint(a) === viewFingerprint(b);
}

export function assertOneView(scoringView, auditView, label = 'view') {
    const a = viewFingerprint(scoringView);
    const b = viewFingerprint(auditView);
    if (a !== b) {
        throw new Error(`${label}: the scoring view and the audit view differ (${a} vs ${b}) — one-view rule (docs/AUDIT-round31-v2.md A16, BUGS.md #33)`);
    }
    return true;
}
