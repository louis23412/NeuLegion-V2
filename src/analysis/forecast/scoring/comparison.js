// src/analysis/forecast/scoring/comparison.js (round-104 split of src/analysis/forecast/scoring.js).
// Kind-grouped family comparison + human-summary renderer.
import { forecastPairs, brierDecomposition, brierLosses, logScore } from './scores.js';
import { dieboldMariano, modelConfidenceSet } from './resampling.js';
// The whole forecast layer over a journal: proper scores per variant, the DM test
// of each candidate against the baseline, and the family Model Confidence Set at
// 90% and 95%. `baseline` and each `candidates[].foldInputs` are the report's
// `foldInputs` arrays; every variant shares the fold grid, so the per-bar losses
// line up. Pure post-processing.
export function forecastComparison({
    baseline = null, candidates = [], baselineKind = 'mechanism', baselineId = 'baseline',
    alpha = 0.10, nBoot = 1000, blockLength = null, seed = 12345, bins = 10,
} = {}) {
    const base = forecastPairs(baseline);
    if (!base.bars) return { available: false, reason: 'the baseline journal carries no finite confidence/outcome pairs' };
    // P1: the benchmark models journal a calibrated probability just as the
    // controller does, so they share the controller's calibration group and are
    // scored against it (MCS + DM), while a signal's normalised z-score keeps its
    // own group. `group` is the grouping key; `kind` stays the variant's own label.
    const groupOf = (kind) => (kind === 'benchmark' ? (baselineKind === 'signal' ? 'signal' : 'controller') : kind);
    const variants = [{ id: baselineId, kind: baselineKind, group: groupOf(baselineKind), pairs: base }];
    for (const c of candidates) {
        if (!c || c.foldInputs == null) continue;
        const pairs = forecastPairs(c.foldInputs);
        if (pairs.bars !== base.bars) {
            // Alignment is the whole point of a paired test; refuse rather than
            // silently compare mismatched windows.
            return { available: false, reason: `variant ${c.id} has ${pairs.bars} pairs, baseline has ${base.bars}` };
        }
        const kind = c.kind || baselineKind;
        variants.push({ id: c.id, kind, group: groupOf(kind), pairs });
    }
    const byId = {};
    for (const v of variants) {
        const decomp = brierDecomposition({ forecasts: v.pairs.forecasts, outcomes: v.pairs.outcomes, bins });
        // P1 (round 29 → 30): referenced proper scores per variant, the quantities
        // the model-class benchmark decides on — a forecaster earns skill only by
        // beating the base-rate forecast on the Brier score (`brierSkill > 0`) or
        // its accuracy (`accuracySkill > 0`). `brierBaseline = p̄(1−p̄)`.
        const baseRate = decomp.baseRate;
        const brierBaseline = Number.isFinite(baseRate) ? baseRate * (1 - baseRate) : null;
        const brier = decomp.brier;
        const brierSkill = (Number.isFinite(brier) && Number.isFinite(brierBaseline) && brierBaseline > 0)
            ? 1 - brier / brierBaseline : null;
        let hits = 0;
        let scored = 0;
        for (let i = 0; i < v.pairs.forecasts.length; i++) {
            const p = v.pairs.forecasts[i];
            const o = v.pairs.outcomes[i];
            if (!Number.isFinite(p) || !Number.isFinite(o)) continue;
            scored++;
            if ((p >= 0.5 ? 1 : 0) === o) hits++;
        }
        const accuracy = scored ? hits / scored : null;
        const chanceAccuracy = Number.isFinite(baseRate) ? Math.max(baseRate, 1 - baseRate) : null;
        const accuracySkill = (Number.isFinite(accuracy) && Number.isFinite(chanceAccuracy)) ? accuracy - chanceAccuracy : null;
        byId[v.id] = {
            kind: v.kind,
            group: v.group,
            bars: v.pairs.bars,
            brier,
            brierBinned: decomp.brierBinned,
            brierBaseline,
            brierSkill,
            accuracy,
            chanceAccuracy,
            accuracySkill,
            logScore: logScore(v.pairs.forecasts, v.pairs.outcomes),
            reliability: decomp.reliability,
            resolution: decomp.resolution,
            uncertainty: decomp.uncertainty,
            baseRate: decomp.baseRate,
        };
    }
    // R27-5: score WITHIN a kind. `(c+1)/2` is a *probability* only for a
    // controller-family candidate: its journaled confidence is
    // `confidenceFromProb(prob) = prob/50 - 1`, which the affine map inverts
    // exactly. A signal candidate's journaled confidence is a normalised z-score
    // (`clamp(z/saturation, -1, 1)`), so mapping it to `(c+1)/2` yields a number
    // that is neither a probability nor comparable across kinds — a cross-kind
    // Brier/DM/MCS would compare a probability against a z-score. So each kind is
    // scored separately: its own Model Confidence Set, and (only inside the
    // baseline's kind, which is the run's reference) the Diebold–Mariano test
    // against the baseline.
    const kinds = [];
    for (const v of variants) if (!kinds.includes(v.group)) kinds.push(v.group);
    const baselineGroup = groupOf(baselineKind);
    const byKind = {};
    for (const kind of kinds) {
        const group = variants.filter((v) => v.group === kind);
        const losses = group.map((v) => brierLosses(v.pairs.forecasts, v.pairs.outcomes));
        const ids = group.map((v) => v.id);
        byKind[kind] = {
            members: ids,
            n: ids.length,
            mcs: {
                at90: modelConfidenceSet({ losses, ids, alpha: 0.10, nBoot, blockLength, seed }),
                at95: modelConfidenceSet({ losses, ids, alpha: 0.05, nBoot, blockLength, seed }),
            },
        };
    }
    const baseLoss = brierLosses(base.forecasts, base.outcomes);
    for (const v of variants.slice(1)) {
        if (v.group === baselineGroup) {
            byId[v.id].dm = dieboldMariano({
                lossA: brierLosses(v.pairs.forecasts, v.pairs.outcomes),
                lossB: baseLoss,
                nBoot, blockLength, seed,
            });
        } else {
            byId[v.id].dm = {
                available: false,
                reason: `cross-kind: ${v.id} is a ${v.kind} candidate, whose journaled confidence is a normalised z-score rather than a calibrated probability, so the paired DM test against the ${baselineKind} baseline is undefined (R27-5)`,
            };
        }
    }
    const primary = byKind[baselineGroup] || { mcs: { at90: null, at95: null } };
    return {
        available: true,
        bars: base.bars,
        baseRate: byId[baselineId].baseRate,
        baselineId,
        kind: baselineKind,
        baselineGroup,
        kinds: kinds.map((k) => ({ kind: k, n: byKind[k].n, members: byKind[k].members })),
        byKind,
        byId,
        mcs: primary.mcs,
        reader: `proper scores (Brier + reliability/resolution/uncertainty, log score) per variant, grouped by \`kind\` (R27-5): the ${baselineKind} family's journaled confidence is \`confidenceFromProb(prob)\`, which \`(c+1)/2\` inverts exactly, so its Brier is a proper score of a probability and \`dm\` is the block-bootstrapped Diebold–Mariano test vs the baseline (favored = lower loss); a non-${baselineKind} family's confidence is a normalised z-score, so those candidates carry \`dm.available=false\` with a reason and are scored only against each other. P1: the benchmark arms (kind 'benchmark') journal a calibrated probability, so they share the baseline's calibration GROUP and are scored against it in the same MCS/DM (each byId row also carries brierBaseline, brierSkill, accuracy, chanceAccuracy and accuracySkill — the referenced proper-skill readout the P1 decision uses). \`mcs\` is the Hansen–Lunde–Nason Model Confidence Set of the baseline's group at 90% and 95% (\`byKind[group].mcs\` holds every kind) — the families that cannot be distinguished from the best. A single sample-best variant is not a winner (selection bias).`,
    };
}
// Render the forecast block for the human summary.
export function formatForecast(block) {
    if (!block || !block.available) return `forecast: unavailable (${block ? block.reason : 'none'})`;
    const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
    const m90 = block.mcs && block.mcs.at90 && block.mcs.at90.available ? block.mcs.at90.memberIds.join(',') : 'n/a';
    const m95 = block.mcs && block.mcs.at95 && block.mcs.at95.available ? block.mcs.at95.memberIds.join(',') : 'n/a';
    const base = block.byId && block.byId[block.baselineId || 'baseline'];
    // R27-5: the block is scored per kind, so the summary names each group (a
    // signal family is not comparable to the probability-calibrated controller).
    const groups = Array.isArray(block.kinds) ? block.kinds.map((g) => `${g.kind}(${g.n})`).join(' ') : null;
    return `forecast: bars=${block.bars} baseRate=${f(block.baseRate)} ` +
        `baseline(brier=${f(base && base.brier)} log=${f(base && base.logScore)}) | mcs90=[${m90}] mcs95=[${m95}]` +
        (groups ? ` | groups: ${groups}` : '');
}
