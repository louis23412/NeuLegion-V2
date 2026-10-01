// src/analysis/decision/cadence.js (round-97 split of src/analysis/decision.js).
// Decision cadence section.

import { isNum } from './measures.js';



// ---------------------------------------------------------------------------
// P2 (round 29 → 30): configuration-robust promotion
// ---------------------------------------------------------------------------
// A promotion read off ONE evaluation configuration is a verdict about the cadence
// as much as about the strategy (RUN-ANALYSIS.md §15.3). The configuration-robust
// rule is the AlgoXpert-style "majority pass with a catastrophic veto": a candidate
// is promotable only when it promotes at MORE THAN HALF of the evaluated cadences
// and does not fail catastrophically at any. It is deliberately STRICTER than the
// single-cadence gate, never looser: a rule that promoted on "any cadence" would
// raise the false-promotion rate rather than lower it.
//
// `evaluations` is one row per cadence: `{ cadence, promote, reasons, netSharpe,
// dsrAdjusted, catastrophic? }`. `catastrophic` defaults to a failed look-ahead
// audit or a NEGATIVE pooled net Sharpe at that cadence — an arm that is outright
// losing at some configuration is not "uncertain", it is disqualified.
export const defaultCatastrophic = (e) => !!(e && (
    e.catastrophic === true ||
    (Array.isArray(e.reasons) && e.reasons.some((r) => /audit/i.test(String(r)))) ||
    (isNum(e.netSharpe) && e.netSharpe < 0)
));

export function promotionAcrossCadences({
    evaluations = [], majorityFraction = 0.5, catastrophic = defaultCatastrophic, cadenceKey = 'cadence',
} = {}) {
    const rows = (Array.isArray(evaluations) ? evaluations : []).filter((e) => e && typeof e.promote === 'boolean');
    const n = rows.length;
    if (!n) return { available: false, reason: 'no evaluations (each row needs a boolean `promote` and its cadence)' };
    const passes = rows.filter((e) => e.promote);
    const fails = rows.filter((e) => !e.promote);
    const catastrophicRows = rows.filter((e) => catastrophic(e));
    // "More than half" — a strict majority of the evaluated cadences.
    const majority = n > 0 && passes.length / n > majorityFraction;
    const vetoed = catastrophicRows.length > 0;
    const promote = majority && !vetoed;
    const reasons = [];
    if (!majority) reasons.push(`configuration-robust: promoted at only ${passes.length}/${n} cadences (need more than ${majorityFraction * n})`);
    if (vetoed) reasons.push(`configuration-robust: catastrophic failure at cadence(s) ${catastrophicRows.map((e) => e[cadenceKey]).join(', ')}`);
    return {
        available: true,
        n,
        majorityFraction,
        passes: passes.length,
        fails: fails.length,
        majority,
        vetoed,
        catastrophic: catastrophicRows.map((e) => ({ cadence: e[cadenceKey], reasons: e.reasons || [] })),
        promote,
        reasons,
        cadences: rows.map((e) => ({ cadence: e[cadenceKey], promote: e.promote, reasons: e.reasons || [], netSharpe: isNum(e.netSharpe) ? e.netSharpe : null, dsrAdjusted: isNum(e.dsrAdjusted) ? e.dsrAdjusted : null })),
        reader: 'majority-pass with a catastrophic veto across the evaluated cadences (AlgoXpert-style; PLAN-round29.md P2). A candidate promotes only if it promotes at more than half the cadences AND never fails catastrophically (default: a failed look-ahead audit, or a negative pooled net Sharpe). Strictly stricter than a single-cadence gate.',
    };
}

