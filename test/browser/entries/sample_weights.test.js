// Sample-uniqueness weighting — proof suite for
// `src/hivemind/training/sample_weights.js` and its integration into
// `HiveMind.train`.
//
// Grounding: Lopez de Prado, "Advances in Financial Machine Learning", ch. 4.
// Overlapping labels share information, so each observation is weighted by its
// average uniqueness (the mean of 1/concurrency over its label span). The
// weighted objective's effective sample size then matches the number of
// independent observations the labels actually carry.
//
// The suite splits the guarantees so a failure names the tier:
//
//   A. PURE MATH (exact vectors + properties)
//      Average uniqueness on fixed label intervals — hand-computed, and
//      cross-checked bit-for-bit against `analysis/uniqueness.js`. Clamping,
//      normalisation (mean exactly 1 / sum exactly 1) and the Kish effective
//      sample size of a weight vector.
//
//   B. UNIQUENESS SEMANTICS (what the weights mean)
//      Point labels are all weight 1; fully-overlapping labels share credit;
//      `spanWeightsFromEntries` turns entry bars + a horizon into the same
//      overlap structure the controller feeds to training.
//
//   C. THE TRAIN STEP IS LINEAR IN THE SAMPLE WEIGHT
//      `train(inputs, target, w)` scales the entire accumulated gradient by
//      exactly w (gradient-energy ratio == w^2), `w = 0` yields a zero
//      gradient, and `w = 1` / non-finite w are bit-exact no-ops against the
//      default path (fingerprint-equal trajectories) — which is why the
//      default-off feature cannot move a golden fingerprint.
//
// Like the other entries this takes an optional `{ ensureSql, stateDir }` so the
// node mirror can run against the real better-sqlite3 driver and a temp dir; in
// the browser harness it lazily loads the sql.js shim and uses the virtual fs.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import {
    DEFAULT_WEIGHT_CONFIG,
    overlapUniqueness,
    clampWeights,
    normalizeWeights,
    weightEffectiveSampleSize,
    weightedMean,
    sampleWeights,
    spanWeightsFromEntries,
    causalWindowWeight,
} from '../../../src/hivemind/training/sample_weights.js';
import {
    sampleUniqueness as analysisSampleUniqueness,
    effectiveSampleSize as analysisEffectiveSampleSize,
} from '../../../src/analysis/uniqueness.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// FNV-1a over a canonical rendering, so "bit-identical" can be asserted.
function fingerprint(value) {
    const parts = [];
    (function walk(v) {
        if (v === null) { parts.push('null'); return; }
        if (v === undefined) { parts.push('undefined'); return; }
        if (typeof v === 'number') { parts.push(Object.is(v, -0) ? '-0' : String(v)); return; }
        if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'bigint') { parts.push(String(v)); return; }
        if (Array.isArray(v) || ArrayBuffer.isView(v)) { parts.push('['); for (let i = 0; i < v.length; i++) walk(v[i]); parts.push(']'); return; }
        if (typeof v === 'object') { parts.push('{'); for (const k of Object.keys(v).sort()) { parts.push(k); walk(v[k]); } parts.push('}'); return; }
        parts.push(String(v));
    })(value);
    const text = parts.join('\u0001');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function sumSquares(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value * value : 0;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        let s = 0;
        for (let i = 0; i < value.length; i++) s += sumSquares(value[i]);
        return s;
    }
    if (value && typeof value === 'object') {
        let s = 0;
        for (const k of Object.keys(value)) s += sumSquares(value[k]);
        return s;
    }
    return 0;
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/sample-weights-${label}`);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const realRandom = Math.random;
    const seeded = (seed, fn) => {
        Math.random = mulberry32(seed);
        try { return fn(); } finally { Math.random = realRandom; }
    };
    const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

    const H_ES = 2, H_IS = 8;

    // ---- A. pure math --------------------------------------------------------
    try {
        check('DEFAULT_WEIGHT_CONFIG is frozen', Object.isFrozen(DEFAULT_WEIGHT_CONFIG));
        check('default normalisation is mean1 with a 1-bar horizon',
            DEFAULT_WEIGHT_CONFIG.normalization === 'mean1' && DEFAULT_WEIGHT_CONFIG.horizonBars === 1);

        const fixtures = [
            { name: 'point labels', spans: [[0, 0], [1, 1], [2, 2]], expected: [1, 1, 1] },
            { name: 'single label', spans: [[5, 7]], expected: [1] },
            { name: 'two 3-bar labels offset by 1', spans: [[0, 2], [1, 3]], expected: [2 / 3, 2 / 3] },
            { name: 'two identical 2-bar labels', spans: [[0, 1], [0, 1]], expected: [1 / 2, 1 / 2] },
            { name: 'three identical point labels', spans: [[0, 0], [0, 0], [0, 0]], expected: [1 / 3, 1 / 3, 1 / 3] },
            { name: 'partial overlap', spans: [[0, 0], [0, 1]], expected: [1 / 2, 3 / 4] },
        ];
        let exact = true, crossChecks = true, bounded = true;
        for (const f of fixtures) {
            const u = overlapUniqueness(f.spans);
            for (let i = 0; i < u.length; i++) if (!close(u[i], f.expected[i], 1e-12)) exact = false;
            const ref = analysisSampleUniqueness(f.spans);
            for (let i = 0; i < u.length; i++) if (!close(u[i], ref[i], 1e-15)) crossChecks = false;
            for (const v of u) if (!(v > 0 && v <= 1)) bounded = false;
        }
        check('overlapUniqueness matches hand-computed fixed intervals exactly', exact,
            fixtures.map((f) => `${f.name}=${JSON.stringify(overlapUniqueness(f.spans))}`).join(' | '));
        check('overlapUniqueness agrees bit-for-bit with analysis/uniqueness.js', crossChecks);
        check('every uniqueness lies in (0, 1]', bounded);

        check('empty input yields no weights',
            overlapUniqueness([]).length === 0 && sampleWeights([]).length === 0 && spanWeightsFromEntries([]).length === 0);

        // Sum of uniqueness is the LodePrado effective sample size.
        const ldp = analysisEffectiveSampleSize([[0, 2], [1, 3]]);
        const sumU = overlapUniqueness([[0, 2], [1, 3]]).reduce((a, b) => a + b, 0);
        check('sum of uniqueness == analysis effectiveSampleSize', close(sumU, ldp, 1e-15), `${sumU} vs ${ldp}`);

        // Normalisation.
        const raw = overlapUniqueness([[0, 0], [0, 1], [2, 3]]);
        const mean1 = normalizeWeights(raw, 'mean1');
        const sum1 = normalizeWeights(raw, 'sum1');
        const none = normalizeWeights(raw, 'none');
        check('mean1 normalisation has mean exactly 1',
            close(mean1.reduce((a, b) => a + b, 0) / mean1.length, 1, 1e-12),
            String(mean1.reduce((a, b) => a + b, 0) / mean1.length));
        check('mean1 normalisation sums to exactly n (average step size preserved)',
            close(mean1.reduce((a, b) => a + b, 0), mean1.length, 1e-12));
        check('sum1 normalisation sums to exactly 1',
            close(sum1.reduce((a, b) => a + b, 0), 1, 1e-12));
        check('none leaves the raw uniqueness untouched',
            none.length === raw.length && none.every((w, i) => w === raw[i]));

        // Clamping is exact.
        const clamped = clampWeights([0.2, 0.5, 0.9], 0.4, 0.8);
        check('clampWeights clamps both ends exactly',
            clamped[0] === 0.4 && clamped[1] === 0.5 && clamped[2] === 0.8,
            JSON.stringify(clamped));

        // Kish effective sample size of a weight vector.
        check('weightEffectiveSampleSize of uniform weights is exactly n',
            weightEffectiveSampleSize([1, 1, 1, 1]) === 4);
        check('weightEffectiveSampleSize of a degenerate vector is 1',
            weightEffectiveSampleSize([1, 0]) === 1 && weightEffectiveSampleSize([0, 0, 5]) === 1);
        const skewed = weightEffectiveSampleSize(overlapUniqueness([[0, 0], [0, 1], [2, 3]]));
        check('weightEffectiveSampleSize is < n for an overlap-skewed set',
            skewed < 3 && skewed > 0, String(skewed));

        check('weightedMean honours the weights',
            close(weightedMean([1, 3], [1, 0]), 1) && close(weightedMean([1, 3], [0, 1]), 3) &&
            close(weightedMean([1, 3], [1, 1]), 2));

        // sampleWeights(config) pipeline.
        const mean1Pi = sampleWeights([[0, 2], [1, 3]], { normalization: 'mean1' });
        check('sampleWeights default config == mean1 normalisation',
            close(mean1Pi.reduce((a, b) => a + b, 0), 2, 1e-12));
        const rawPi = sampleWeights([[0, 2], [1, 3]], { normalization: 'none' });
        check('sampleWeights(none) returns the raw uniqueness', close(rawPi[0], 2 / 3, 1e-15));
        const floorPi = sampleWeights([[0, 2], [1, 3]], { minWeight: 0.7, normalization: 'none' });
        check('sampleWeights clamps before normalising', floorPi.every((w) => w === 0.7), JSON.stringify(floorPi));
        const nullCfg = sampleWeights([[0, 2], [1, 3]], null);
        check('sampleWeights(null) uses the defaults', close(nullCfg[0], 1, 1e-12));
    } catch (error) {
        check('A: pure math completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- B. uniqueness semantics --------------------------------------------
    try {
        const point = sampleWeights([[0, 0], [1, 1], [2, 2]], { normalization: 'none' });
        check('B: non-overlapping point labels are all weight 1',
            point.every((w) => w === 1), JSON.stringify(point));

        const overlap = sampleWeights([[0, 0], [0, 0]], { normalization: 'none' });
        check('B: two labels sharing one bar share the credit (each 1/2)',
            overlap.every((w) => close(w, 0.5, 1e-15)), JSON.stringify(overlap));

        const horizon1 = spanWeightsFromEntries([0, 1, 2], { normalization: 'none' });
        check('B: horizon 1 (default) gives non-overlapping point labels',
            JSON.stringify(horizon1) === JSON.stringify([1, 1, 1]), JSON.stringify(horizon1));

        const horizon3 = spanWeightsFromEntries([0, 1, 2, 3], { horizonBars: 3, normalization: 'none' });
        const expectedH3 = [11 / 18, 7 / 18, 7 / 18, 11 / 18];
        check('B: entries closer than the horizon overlap (exact 11/18, 7/18 pattern)',
            horizon3.every((w, i) => close(w, expectedH3[i], 1e-12)), JSON.stringify(horizon3));
        check('B: the horizon-weighted set carries exactly 2 independent observations',
            close(horizon3.reduce((a, b) => a + b, 0), 2, 1e-12), String(horizon3.reduce((a, b) => a + b, 0)));
        check('B: horizon 3 gives edge trades more credit than middle ones',
            horizon3[0] > horizon3[1] && horizon3[3] > horizon3[2]);

        const spaced = spanWeightsFromEntries([0, 10, 20], { horizonBars: 3, normalization: 'none' });
        check('B: entries spaced beyond the horizon are independent again',
            spaced.every((w) => w === 1), JSON.stringify(spaced));
    } catch (error) {
        check('B: uniqueness semantics completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- C. train is linear in the sample weight -----------------------------
    const inputs8 = (s) => Array.from({ length: 8 }, (_, i) => Math.sin(s * 1.7 + i * 0.9) * 0.6);

    function buildHm(label, seed, resetFreq) {
        const hm = new HiveMind(stateDir(label), H_ES, H_IS, label, true);
        hm._gradientResetFrequency = resetFreq;
        return hm;
    }

    function gradEnergy(label, seed, weight) {
        return seeded(seed, () => {
            const hm = buildHm(label, seed, 1e9);
            seeded(seed * 31 + 7, () => {
                if (weight === undefined) hm.train(inputs8(1), 1);
                else hm.train(inputs8(1), 1, weight);
            });
            return sumSquares(hm._gradientAccumulation);
        });
    }

    function trajectoryFingerprint(label, seed, weight) {
        return seeded(seed, () => {
            const hm = buildHm(label, seed, 1);
            for (let s = 0; s < 6; s++) {
                seeded(seed * 31 + s, () => {
                    if (weight === undefined) hm.train(inputs8(s), s % 2);
                    else hm.train(inputs8(s), s % 2, weight);
                });
            }
            const snap = {
                trainingSteps: hm._trainingStepCount,
                attBias: hm._transformers.map((_, i) => Array.from(hm._attentionBias[i])),
                attW: hm._transformers.map((_, i) => Array.from(hm._attentionWeightMatrix[i])),
                spec: hm._transformers.map((_, i) => hm._specializationWeights[i].map((r) => Array.from(r))),
                out: hm._transformers.map((t) => ({ w: t.outputWeights.map((r) => Array.from(r)), b: [t.outputBias[0]] })),
            };
            return fingerprint(snap);
        });
    }

    try {
        const energy1 = gradEnergy('C_e1', 41, undefined);
        const energyHalf = gradEnergy('C_ehalf', 41, 0.5);
        const energyTwo = gradEnergy('C_etwo', 41, 2.0);
        const energyZero = gradEnergy('C_e0', 41, 0);
        check('C: an unweighted training step produces a non-zero gradient', energy1 > 0, String(energy1));
        check('C: gradient energy scales as w^2 (w=0.5 -> ratio 0.25)',
            close(Math.sqrt(energyHalf / energy1), 0.5, 1e-9), String(Math.sqrt(energyHalf / energy1)));
        check('C: gradient energy scales as w^2 (w=2 -> ratio 4)',
            close(Math.sqrt(energyTwo / energy1), 2.0, 1e-9), String(Math.sqrt(energyTwo / energy1)));
        check('C: w=0 yields an exactly zero gradient', energyZero === 0, String(energyZero));

        const fpDefault = trajectoryFingerprint('C_fp_def', 52, undefined);
        const fpOne = trajectoryFingerprint('C_fp_one', 52, 1);
        const fpNaN = trajectoryFingerprint('C_fp_nan', 52, NaN);
        const fpInf = trajectoryFingerprint('C_fp_inf', 52, Infinity);
        check('C: default and explicit w=1 give a bit-identical trajectory',
            fpDefault === fpOne, `default ${fpDefault} vs one ${fpOne}`);
        check('C: a NaN weight falls back to 1 (bit-identical trajectory)',
            fpNaN === fpDefault, `nan ${fpNaN} vs default ${fpDefault}`);
        check('C: an infinite weight falls back to 1 (bit-identical trajectory)',
            fpInf === fpDefault, `inf ${fpInf} vs default ${fpDefault}`);

        // A weighted step really does differ when w != 1.
        const fpWeighted = trajectoryFingerprint('C_fp_w', 52, 0.3);
        check('C: a non-trivial weight does change the trajectory (feature is live)',
            fpWeighted !== fpDefault, `weighted ${fpWeighted} vs default ${fpDefault}`);

        // The controller feed: a clustered batch is down-weighted, a spaced one
        // is not — exactly the LdP correction for overlapping labels.
        const clustered = sampleWeights([[0, 4], [1, 5], [2, 6], [3, 7]], { normalization: 'mean1' });
        const spread = sampleWeights([[0, 0], [10, 10], [20, 20], [30, 30]], { normalization: 'mean1' });
        check('C: a clustered batch gets non-uniform weights, a spread one does not',
            new Set(clustered.map((w) => w.toFixed(6))).size > 1 && spread.every((w) => close(w, 1, 1e-12)),
            `clustered=${JSON.stringify(clustered.map((w) => Number(w.toFixed(4))))}`);
    } catch (error) {
        check('C: train linearity completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- D. R27-3: the causal streaming-window weight ------------------------
    // The controller's online form of the same correction: a new label's weight is
    // its average uniqueness against a ring of the last `windowBars` OBSERVED
    // spans (plus itself), mean-1 normalised over the window. On non-overlapping
    // labels (the shipped `optimistic` labeller, horizon 1) every weight is
    // exactly 1 — the mechanism is a bit-exact no-op there, which the liveness
    // certificate reports as `inert`.
    try {
        const w0 = causalWindowWeight([], [0, 0]);
        check('D: a lone label in an empty window has weight 1 (nothing to overlap with)',
            w0.weight === 1 && w0.n === 1 && w0.ess === 1 &&
            JSON.stringify(w0.normalized) === JSON.stringify([1]),
            JSON.stringify(w0));

        // A point label against a duplicate point label: raw uniqueness is 1/2 each,
        // and mean-1 normalisation restores both to 1 (the mean step size is kept).
        const dupPoint = causalWindowWeight([[0, 0]], [0, 0]);
        check('D: a duplicated point label normalises back to weight 1 (mean-1 keeps the step size)',
            close(dupPoint.weight, 1, 1e-12) &&
            dupPoint.windowUniqueness.every((u) => close(u, 0.5, 1e-15)) &&
            dupPoint.n === 2 && close(dupPoint.ess, 2, 1e-12),
            JSON.stringify(dupPoint));

        // Point vs 3-bar: the raw uniqueness are 1/2 and 5/6, the mean-1 scale 3/2
        // gives exactly [3/4, 5/4], so the new (longer) label earns more credit.
        const asym = causalWindowWeight([[0, 0]], [0, 2]);
        check('D: an asymmetric overlap yields the exact mean-1 weight 5/4 and Kish ESS 32/17',
            close(asym.weight, 5 / 4, 1e-12) &&
            JSON.stringify(asym.normalized.map((w) => Number(w.toFixed(12)))) === JSON.stringify([0.75, 1.25]) &&
            close(asym.ess, 32 / 17, 1e-12) && asym.n === 2,
            JSON.stringify(asym));
        check('D: the mean-1 normalised window has mean exactly 1',
            close(asym.normalized.reduce((a, b) => a + b, 0) / asym.normalized.length, 1, 1e-12));

        // Disjoint spans share no bar, so both are fully unique (weight 1).
        const disjoint = causalWindowWeight([[0, 0]], [5, 5]);
        check('D: spans that share no bar are both fully unique (weight 1)',
            close(disjoint.weight, 1, 1e-12) &&
            disjoint.windowUniqueness.every((u) => u === 1) && disjoint.n === 2,
            JSON.stringify(disjoint));

        // Horizon-1, consecutive entries: no overlap at all, so every weight is 1 —
        // this is the stock labeller, hence `inert` in the A/B.
        let allOne = true;
        const ring = [];
        for (let i = 0; i < 5; i++) {
            const r = causalWindowWeight(ring, [i, i]);
            if (!close(r.weight, 1, 1e-12)) allOne = false;
            ring.push([i, i]);
        }
        check('D: horizon-1 non-overlapping entries produce an all-ones weight stream (the inert case)', allOne);

        // Purity: the ring is never mutated and a malformed new span degrades to 1.
        const fixedRing = [[0, 0], [1, 1]];
        const before = JSON.stringify(fixedRing);
        causalWindowWeight(fixedRing, [2, 2]);
        check('D: causalWindowWeight does not mutate the window ring', JSON.stringify(fixedRing) === before);
        const bad = causalWindowWeight([[0, 0]], [3, 1]);
        check('D: a malformed new span degrades to weight 1 with a null window vector',
            bad.weight === 1 && bad.windowUniqueness === null && bad.normalized === null);

        // A null config is byte-identical to the default config.
        const defCfg = causalWindowWeight([[0, 0]], [0, 2]);
        const nullCfg2 = causalWindowWeight([[0, 0]], [0, 2], null);
        check('D: causalWindowWeight(null config) is byte-identical to the default',
            JSON.stringify(defCfg) === JSON.stringify(nullCfg2));
    } catch (error) {
        check('D: causal-window weight completed', false, error && error.stack ? error.stack : String(error));
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
