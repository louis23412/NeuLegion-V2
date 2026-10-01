// src/analysis/decision/report.js (round-97 split of src/analysis/decision.js).
// Decision report section.

import { isNum, na } from './measures.js';



// ---------------------------------------------------------------------------
// Composition — the six-question decision block
// ---------------------------------------------------------------------------
export function decisionReport({
    model = null,
    // R27-5: when the featured row has no model block of its own (a pure signal
    // candidate that won), the caller passes the BASELINE's model here, so the
    // training question is answered by the baseline controller and labelled as such
    // instead of degrading to n/a. `{ kind: 'baseline' }` is the only kind today.
    modelReferent = null,
    runMeta = {},
    baseline = null,
    candidate = null,
    concentration = null,
    confidence = null,
    nextRun = null,
    familyCorrelation = null,
    familywise = null,
    costLadder = null,
    forecast = null,
    replication = null,
    positionPolicy = null,
} = {}) {
    const meta = runMeta || {};
    const referentBaseline = !!(modelReferent && modelReferent.kind === 'baseline');
    const modelBlock = model || null;
    const candModel = candidate && candidate.model ? candidate.model : null;
    // Which model block the training question is answered by. Without a referent
    // this is the featured candidate's own model (or the `model` argument); with a
    // baseline referent it is the baseline's, explicitly labelled.
    const effectiveModel = referentBaseline ? modelBlock : (candModel || modelBlock);
    const modelAvailable = !!(effectiveModel && effectiveModel.available !== false);
    const training = {
        // Question 1: did the models train, and on what? Null model diagnostics is
        // stated as such, never rendered as a healthy model.
        model: effectiveModel || na('no model diagnostics were collected for this run (a pure-signal or bare run)'),
        modelReferent: modelReferent || null,
        // R28 (BUGS.md #55): `labelPolicy` is the POLICY THE REFERENT MODEL RAN
        // UNDER (the featured candidate's controller policy when the featured row
        // is a model-backed candidate), and `runLabelPolicy` is the run-level flag.
        // They differ when the featured row is a label-policy variant: the old
        // field named the run flag while sitting beside a `label:conservative`
        // row, so the report said `optimistic` about a conservative model.
        labelPolicy: meta.labelPolicy == null ? null : meta.labelPolicy,
        runLabelPolicy: meta.runLabelPolicy == null ? null : meta.runLabelPolicy,
        labelHorizonBars: meta.labelHorizonBars == null ? null : meta.labelHorizonBars,
        seed: meta.seed == null ? null : meta.seed,
        trials: meta.trials == null ? null : meta.trials,
        saveInterval: meta.saveInterval == null ? null : meta.saveInterval,
        // P2: every decision carries the evaluation cadence it was made at, so a
        // cross-run level comparison can never silently mix configurations.
        cadence: meta.cadence == null ? null : meta.cadence,
        // Derived from the model block's own label diagnostics: `summarizeModelStats`
        // exposes `baseRate`/`resolved`/`heldBars`/`status` — NOT a
        // `labelDistribution` field — so reading `candidate.model.labelDistribution`
        // here was always a silent null (the same shape-mismatch class as `BUGS.md`
        // #38). A model-backed candidate now carries its label distribution; a pure
        // signal candidate (no model) is still an explicit null. R27-5: when a
        // referent is supplied, the distribution follows the referent (the effective
        // model block above), so the two always agree on whose model they describe.
        labelDistribution: modelAvailable ? {
            status: effectiveModel.status == null ? null : effectiveModel.status,
            baseRate: effectiveModel.baseRate == null ? null : effectiveModel.baseRate,
            resolved: effectiveModel.resolved || null,
            heldBars: effectiveModel.heldBars || null,
        } : null,
        reader: (referentBaseline
            ? 'the per-variant model diagnostics (training steps, label base rate, skill, resolved-barrier split, entry-to-close holding-period distribution) plus the label policy, seed and searched-roster size, WITH AN EXPLICIT REFERENT: the featured row is a pure signal with no model of its own, so `model` and `labelDistribution` are the BASELINE controller\'s, stated as such via `modelReferent`. A null model block means a pure-signal variant, not a trained one. The entry-to-training age (the FIFO/`processCount=1` drain lag) is NOT yet measured — see TODO #62.'
            : 'the per-variant model diagnostics (training steps, label base rate, skill, resolved-barrier split, entry-to-close holding-period distribution) plus the label policy, seed and searched-roster size. A null model block means a pure-signal variant, not a trained one. The entry-to-training age (the FIFO/`processCount=1` drain lag) is NOT yet measured — see TODO #62.')
            + ' `labelPolicy` is the policy the REFERENT model ran under (a label-policy variant reports its own); `runLabelPolicy` is the run-level flag (R28, BUGS.md #55).',
    };
    const edge = {
        available: true,
        promote: candidate ? !!candidate.promote : null,
        reasons: candidate ? (candidate.reasons || []) : null,
        bindingHurdle: candidate && candidate.reasons && candidate.reasons.length ? candidate.reasons[0] : null,
        gate: meta.gate == null ? null : meta.gate,
        gateOptions: meta.gateOptions || null,
        dependence: candidate && candidate.dependence ? candidate.dependence : (baseline && baseline.dependence ? baseline.dependence : null),
        promotionTest: candidate && candidate.promotionTest ? candidate.promotionTest : null,
        familyCorrelation: familyCorrelation || na('no family to correlate (fewer than two candidates)'),
        familywise: familywise || na('the family-wise search did not run'),
        reader: 'the promoted/keep-off verdict, the named binding hurdle, the dependence-aware panel and paired cluster test behind it, and the family-wise search cross-check. A keep-off verdict is only citable when the binding hurdle is named and the run was powered.',
    };
    const economics = {
        available: true,
        costLadder: costLadder || na('the cost ladder did not run'),
        confidence: confidence || na('the raw confidence was not journaled'),
        positionPolicy: positionPolicy == null ? null : positionPolicy,
        breakEvenBps: candidate && candidate.pooledMetrics && isNum(candidate.pooledMetrics.breakEvenCostBps) ? candidate.pooledMetrics.breakEvenCostBps : null,
        participation: candidate && candidate.pooledMetrics ? {
            nonZeroFraction: candidate.pooledMetrics.nonZeroFraction == null ? null : candidate.pooledMetrics.nonZeroFraction,
            meanAbsPosition: candidate.pooledMetrics.meanAbsPosition == null ? null : candidate.pooledMetrics.meanAbsPosition,
        } : null,
        reader: 'whether it pays: the whole verdict restated at 0/2/5/10 bps of turnover, the measured break-even cost, participation under the unified confidence->position policy, and the raw-confidence decay (the alpha-decay ranking input).',
    };
    const family = {
        available: true,
        forecast: forecast || na('the forecast comparison did not run'),
        // R26-13's cross-seed distribution is aggregated ACROSS runs and written to
        // `replication.json` beside the first run dir, so a per-seed report has no
        // summary of its siblings. These fields accept a supplied aggregate, but the
        // shipped path never supplies one — and `replicateAnalysis`'s aggregate is
        // keyed `byVariant` (with `varianceComponents` NESTED as `.components`), not
        // `seedDistribution`/`varianceComponents`/`pairedVarianceRatio`, so reading
        // those names here was the same shape-mismatch class as `BUGS.md` #38/#40
        // (structurally unreachable, no information lost because `replication.json`
        // carries the aggregate). The readers below say exactly that.
        seedDistribution: replication && replication.seedDistribution ? replication.seedDistribution : na('the cross-seed distribution is aggregated into replication.json by a multi-seed run (--seeds=a,b,c); a per-seed report does not summarize its siblings'),
        varianceComponents: replication && replication.varianceComponents ? replication.varianceComponents : na('the seed/fold variance decomposition is aggregated into replication.json by a multi-seed run'),
        pairedVarianceRatio: replication && replication.pairedVarianceRatio ? replication.pairedVarianceRatio : na('the paired/unpaired variance ratio (the CRN criterion) is aggregated into replication.json by a multi-seed run'),
        reader: 'is it the best family, or just the best of these? proper forecast scores + the Model Confidence Set; the cross-seed distribution and variance decomposition come from a multi-seed run and live in replication.json (a single-seed point estimate is not a family decision).',
    };
    return {
        schema: 'nl.decision.v1',
        verdict: {
            promote: candidate ? !!candidate.promote : null,
            candidateId: candidate && candidate.id != null ? candidate.id : null,
            reasons: candidate ? (candidate.reasons || []) : null,
            // R28 (BUGS.md #55): every evaluated hurdle with its value, threshold
            // and MARGIN, so a knife-edge miss (the round-27 `sig:momentum`
            // adjusted DSR is 0.00124 short of the floor) is visible in the report
            // instead of only inferable from two rounded numbers in a string.
            hurdles: candidate && Array.isArray(candidate.hurdles) ? candidate.hurdles : null,
            tightestHurdle: candidate && candidate.tightestHurdle ? candidate.tightestHurdle : null,
        },
        training,
        edge,
        concentration: concentration || na('the concentration readout did not run'),
        economics,
        family,
        nextRun: nextRun || na('the next-run sizing block did not run'),
        reader: 'The decision-grade report (R26-8). Six blocks, one per question the next cycle asks (training / edge / concentration / economics / family / nextRun). Every block states its own availability; a missing input is an explicit { available: false, reason } rather than a null that could read as a healthy zero. It adds no new strategy statistic — it makes the existing ones legible, printing the design-effect-adjusted numbers and the seed distribution beside the point estimates.',
    };
}
