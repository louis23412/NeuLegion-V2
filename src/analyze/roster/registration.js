// src/analyze/roster/registration.js (round-99 split of src/analyze/roster.js).
// Roster queries (snapshot, registration, reasons, listing).
import { hashString } from '../../legion/rng.js';
import { LINEAGE_BRANCHES, uncoveredVariantIds, DROPPED_VARIANT_IDS } from '../../lineage.js';
import { ALL_VARIANTS, RESOLVABLE_VARIANTS } from './tables.js';


export const rosterSnapshot = () => {
    const ids = ALL_VARIANTS.map((v) => v.id);
    return { ids, count: ids.length, hash: hashString(ids.join(',')) };
};

// Round 30 (BUGS.md #69): the guard the CLI applies to a PRESENT-but-empty list
// flag. Pure, so it is testable without spawning the CLI: `raw` is the string
// after `--name=` (null when the flag carried no value). A bare `--name` and a
// `--name=` both count as given-but-empty and must error rather than silently
// falling back. Returns the error message, or null when the flag is absent or has
// at least one non-empty entry.
export const emptyListFlagError = (name, given, raw, consequence = 'the default dataset') => {
    if (!given) return null;
    const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (list.length) return null;
    return `analyze: --${name}= was provided but names no files — refusing to silently fall back to ${consequence} (BUGS.md #69)`;
};

// Round 30: the register contract in code form (see docs/LINEAGE.md /
// docs/DROPPED.md). Every field must be empty for the register to be a faithful
// contract: `uncovered` = a resolvable variant with no lineage entry,
// `missingVariant` = a register entry naming a variant that no longer resolves,
// `droppedInRoster` = a DROPPED branch back in the default roster.
export const rosterRegistration = () => {
    const resolvableIds = RESOLVABLE_VARIANTS.map((v) => v.id);
    const rosterIds = ALL_VARIANTS.map((v) => v.id);
    return {
        resolvableCount: resolvableIds.length,
        rosterCount: rosterIds.length,
        uncovered: uncoveredVariantIds(resolvableIds),
        missingVariant: LINEAGE_BRANCHES
            .filter((b) => b.variant && !resolvableIds.includes(b.variant))
            .map((b) => b.id),
        droppedInRoster: rosterIds.filter((id) => DROPPED_VARIANT_IDS.includes(id)),
    };
};

// R27-2: can this variant's mechanism reach the code path the A/B scores? Returns
// a one-line reason when it cannot (so the report marks it `not-applicable`
// instead of presenting it as a tested arm), or null when it can.
export const notApplicableReason = (variant, model = 'controller', ctx = {}) => {
    if (!variant) return null;
    if (variant.appliesTo === 'broadcast') {
        return `not-applicable: acts only on the memory broadcast path (broadcastMemory -> _getGlobalLSHCandidates), whose output the scored ${model} model never reads back`;
    }
    if (variant.appliesTo === 'controller' && model !== 'controller') {
        return `not-applicable: acts only on the controller-backed model, not the ${model} model`;
    }
    // Round 30 (BUGS.md #70): a cross-sectional candidate reads the OTHER streams
    // through `view.panel`. On a run with fewer than two aligned streams its
    // position is identically 0, so it cannot be evaluated — it must be marked
    // not-applicable (which also excludes it from K and the family-wise search)
    // rather than reported as a live degenerate arm.
    if (variant.crossSectional === true && Number.isFinite(ctx.streamCount) && ctx.streamCount < 2) {
        return `not-applicable: reads the cross-section (view.panel) but this run has ${ctx.streamCount} stream${ctx.streamCount === 1 ? '' : 's'} — the cross-sectional position is identically 0 without ≥2 aligned streams (BUGS.md #70)`;
    }
    return null;
};

// R27-3 / R28 (BUGS.md #53, #58): the single reason an INERT candidate carries.
//
// A variant may supply a precise reason — a string, or a function of the MEASURED
// run context (`{ totalFolds, identicalFolds, model, report, baseline }`). The
// generic fallback must NOT claim a structural unreachability: a variant only
// reaches the liveness comparison after `notApplicableReason` returned null, i.e.
// it IS on the scored path and produced fold signals (it merely matched the
// baseline on every fold). The old fallback asserted "the mechanism never reaches
// the model path" for every inert candidate, which was a FALSE certificate for
// `pca-hash` (a `model`-scoped mechanism that is live at some budgets — 6/288
// folds on the round-26 run — and inert at others). A reason must be a measured
// per-run statement, not a structural one (BUGS.md #44's corrected wording).
export const inertReasonFor = (variant, ctx = {}) => {
    const custom = variant && variant.inertReason;
    if (typeof custom === 'function') {
        try {
            const r = custom(ctx);
            if (typeof r === 'string' && r) return r;
        } catch { /* a variant reason must never break the run */ }
    }
    if (typeof custom === 'string' && custom) return custom;
    return `the mechanism reached the scored ${ctx.model || 'model'} path but changed no emitted position at this run's configuration over all ${ctx.totalFolds} folds (measured; the variant supplies no specific reason)`;
};


// R27-5: the grouping key a variant's journaled confidence is scored within. Every
// probability-calibrated arm (the controller,
// the mechanism flags, the label policies) journals a confidence derived from a
// probability — `confidenceFromProb(prob)` — so `(c+1)/2` recovers that
// probability and a proper score is meaningful. A signal variant journals a
// normalised z-score, which is NOT a probability, so it is scored only against
// the other signals. Grouping by this key (rather than raw `kind`) keeps a
// `label` candidate in the controller family where it belongs.
export const forecastKindOf = (variant) => (variant && variant.signal ? 'signal' : (variant && variant.benchmark ? 'benchmark' : 'controller'));

// R27-2: a human-readable taxonomy table for `--list-variants`. Columns:
// id | label | kind | appliesTo | applicable-here. `model` decides the last
// column; the default roster marks opt-in variants too.
export const listVariants = (model = 'controller') => {
    const kindOf = (v) => v.kind || (v.signal ? 'signal' : 'mechanism');
    return RESOLVABLE_VARIANTS.map((v) => {
        const reason = notApplicableReason(v, model);
        const inDefaultRoster = ALL_VARIANTS.includes(v);
        return {
            id: v.id,
            label: v.label,
            kind: kindOf(v),
            appliesTo: v.appliesTo || 'agnostic',
            controllerScoped: !!v.controllerScoped,
            inDefaultRoster,
            applicable: reason == null,
            reason: reason || null,
        };
    });
};

// R27-5: a fixed-width table for `--list-variants`, so an operator can see the
// full resolvable universe (id | kind | appliesTo | default? | applicable-here)
// and the one-line reason a variant cannot reach the scored model.
export const formatVariantList = (rows) => {
    const w = (s, n) => String(s == null ? '-' : s).padEnd(n);
    const header = `${w('id', 22)} ${w('kind', 10)} ${w('applies-to', 11)} ${w('default', 8)} applicable`;
    const lines = [header, '-'.repeat(header.length)];
    for (const r of rows) {
        lines.push(`${w(r.id, 22)} ${w(r.kind, 10)} ${w(r.appliesTo, 11)} ${w(r.inDefaultRoster ? 'yes' : (r.controllerScoped ? 'opt-in' : 'no'), 8)} ${r.applicable ? 'yes' : `no — ${r.reason}`}`);
    }
    return lines.join('\n');
};

// The confidence→position policy for the A/B (round 26, R26-3 / BUGS.md #34).
//
// ONE policy, applied to BOTH candidate families through
// `walkforward#confidenceToPosition`, in one documented signed-confidence space:
//   - the controller hands in `(prob − 50)/50`;
//   - a signal candidate hands in `clamp(z / saturation, −1, 1)` (its feature's
//     causal z-score normalised to the same [-1, 1] space).
// Before R26-3 the controller carried this dead zone and the signal family did
// not, so every turnover/participation comparison was confounded by the mapping.
// The controller's confidence is a small deviation around 50 (measured test
// windows sit in ~46-58), so a 5% dead zone abstains on prob in [47.5, 52.5].
// Measured behaviour is recorded in the report, and the raw confidence is
// journaled so the policy can be swept offline (`restateReportAtPolicy`).
