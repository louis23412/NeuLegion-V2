// dimensions — the structure-scaling contract (`_scaleAndSetDimensions`).
//
// `CONFIG.forceMin = true` in production, so the compact branch is the one the
// golden fingerprints pin; the full-size branch was flagged as unaudited in
// `docs/BUGS.md`. This entry audits both: it sweeps the full branch across the
// ensemble-size / input-size grid, checks the tensor shapes it declares against
// the tensors it allocates, exercises it end-to-end (predict/train/LSH churn),
// and proves the scaling-law structure that grounds the audit:
//
//   - exact compact (forceMin) overrides, fingerprinted as a JSON constant so an
//     accidental edit to the production branch is caught;
//   - hidden size always divisible by head count, headDim = hiddenSize/heads;
//   - lowDim inside its declared [max(4, 0.18*hidden), 0.78*hidden] band;
//   - projection / hyperplane / bucket tensors match the declared counts;
//   - the only dimension that depends on `inputSize` is the learning rate;
//   - layers, heads and hidden size are monotone non-increasing in ensemble size
//     while the learning rate is monotone non-decreasing (the width-scaling law);
//   - end-to-end churn leaves the LSH index consistent and the weights finite;
//   - self-similarity of the LSH projection is exactly ~1 (unit-norm geometry).
//
// Grounding: Kaplan et al., "Scaling Laws for Neural Language Models" (arXiv
// 2001.08361) for width/depth scaling; Yang et al., "Tensor Programs V" (arXiv
// 2203.03466, μP) for a width-dependent learning rate; Lakshminarayanan et al.,
// "Deep Ensembles" (arXiv 1612.01474) for distributing capacity over members.
import HiveMind from '../../../src/hivemind/hiveMind.js';

const STATE_DIR = 'state/dimensions';
let stateDirFor = (label) => `${STATE_DIR}/${label}`;

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function withSeed(seed, fn) {
    const orig = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = orig; }
}

function makeInputs(inputSize, steps, seed = 7) {
    const rnd = mulberry32(seed);
    const rows = [];
    for (let s = 0; s < steps; s++) {
        const row = new Array(inputSize);
        for (let i = 0; i < inputSize; i++) {
            const base = Math.sin((s + i * 3) * 0.17) * 0.5 + 0.5;
            const noise = (rnd() - 0.5) * 0.4;
            const spike = (s % 37 === 0 && i % 5 === 0) ? (rnd() - 0.5) * 6 : 0;
            row[i] = base + noise + spike;
        }
        rows.push(row);
    }
    return rows;
}

const DIM_FIELDS = [
    '_numLayers', '_numHeads', '_headDim', '_hiddenSize', '_feedForwardSize',
    '_protoCapacityFactor', '_memoryFactor', '_baseProtoCapacity', '_maxVariancePerDim',
    '_semanticLR', '_longTermMaxProtos', '_shortTermMaxProtos', '_rawMaxProtos',
    '_semanticMaxProtos', '_effectiveSemanticMax', '_coreMaxProtos', '_coreEpisodicMaxEntries',
    '_contextWindow', '_adaptiveWindow', '_maxTrustHistory', '_maxPerformanceHistory',
    '_lowDim', '_numProjections', '_swarmIntelligenceFactor', '_gradientResetFrequency',
    '_maxRetrievedProtos', '_numRetrievalCandidates', '_faithfulReplayEvery',
    '_generativeReplayEvery', '_maxEpisodicConsider', '_replaySamples', '_priorityMax',
    '_numLshSets', '_lshNumTables', '_lshHashBits', '_tempOverloadFactor',
    '_mergeTrimFactor', '_kernelGamma',
];

// The compact overrides are the production branch; any change here is a
// deliberate re-freeze and must be accompanied by a golden update.
const COMPACT_EXPECTED = Object.freeze({
    '_ensembleSize': 3, '_inputSize': 12,
    '_numLayers': 2, '_numHeads': 2, '_headDim': 4, '_hiddenSize': 8, '_feedForwardSize': 32,
    '_protoCapacityFactor': 0.5, '_memoryFactor': 2.5, '_baseProtoCapacity': 4,
    '_maxVariancePerDim': 20.9, '_semanticLR': 0.04,
    '_longTermMaxProtos': 3, '_shortTermMaxProtos': 5, '_rawMaxProtos': 4,
    '_semanticMaxProtos': 75, '_effectiveSemanticMax': 100, '_coreMaxProtos': 7,
    '_coreEpisodicMaxEntries': 6, '_contextWindow': 50, '_adaptiveWindow': 13,
    '_maxTrustHistory': 100, '_maxPerformanceHistory': 200, '_lowDim': 4,
    '_numProjections': 6, '_swarmIntelligenceFactor': 0.95, '_gradientResetFrequency': 30,
    '_maxRetrievedProtos': 16, '_numRetrievalCandidates': 32, '_faithfulReplayEvery': 5,
    '_generativeReplayEvery': 15, '_maxEpisodicConsider': 45, '_replaySamples': 3,
    '_priorityMax': 16, '_numLshSets': 2, '_lshNumTables': 2, '_lshHashBits': 6,
    '_tempOverloadFactor': 2.5, '_mergeTrimFactor': 1.75, '_kernelGamma': 32,
});

function shapeProblems(hm) {
    const p = [];
    const hidden = hm._hiddenSize, heads = hm._numHeads, headDim = hm._headDim;
    const lowDim = hm._lowDim, proj = hm._numProjections, sets = hm._numLshSets;
    if (!Number.isInteger(hidden / heads)) p.push('hidden%heads!=0');
    if (headDim !== hidden / heads) p.push('headDim!=hidden/heads');
    if (!(lowDim >= 1)) p.push('lowDim<1');
    if (lowDim > hidden) p.push('lowDim>hidden');
    const minLow = Math.max(4, Math.round(hidden * 0.18));
    const maxLow = Math.round(hidden * 0.78);
    if (lowDim < minLow || lowDim > maxLow) p.push(`lowDim outside [${minLow},${maxLow}]`);
    if (sets < 1) p.push('sets<1');
    if (sets !== Math.max(1, Math.floor(proj / 3))) p.push('sets!=floor(proj/3)');
    if (hm._lshHyperplanes.length !== sets) p.push('hyperplanes len');
    if (hm._lshHyperplanes[0].length !== hm._lshNumTables) p.push('hyperplane tables');
    if (hm._lshHyperplanes[0][0].length !== hm._lshHashBits) p.push('hyperplane bits');
    for (const vec of hm._lshHyperplanes[0][0]) if (vec.length !== lowDim) { p.push('hyperplane dim'); break; }
    if (hm._projectionMatrices.length !== proj) p.push('proj matrices len');
    if (hm._projectionMatrices[0].length !== hidden) p.push('proj rows');
    if (hm._projectionMatrices[0][0].length !== lowDim) p.push('proj cols');
    if (hm._semanticLSHBuckets.length !== hm._ensembleSize) p.push('buckets len');
    if (hm._semanticLSHBuckets[0].length !== sets) p.push('bucket sets');
    if (hm._semanticLSHBuckets[0][0].length !== hm._lshNumTables) p.push('bucket tables');
    if (hm._transformers.length !== hm._ensembleSize) p.push('transformers len');
    if (hm._transformers[0].attentionWeights.length !== hm._numLayers) p.push('layers len');
    if (hm._transformers[0].ffnWeights[0].gate_proj[0].length !== hm._feedForwardSize) p.push('ffn width');
    if (hm._transformers[0].outputWeights.length !== hidden) p.push('out rows');
    if (hm._maxRetrievedProtos < 1) p.push('maxRet<1');
    if (hm._numRetrievalCandidates < 1) p.push('numCand<1');
    if (hm._priorityMax < 1) p.push('prio<1');
    if (!(hm._learningRate > 0 && hm._learningRate <= 0.0025)) p.push('lr range');
    if (hm._feedForwardSize < 1) p.push('ff<1');
    if (hm._baseProtoCapacity < 1) p.push('base<1');
    return p;
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    stateDirFor = options.stateDir || ((label) => `${STATE_DIR}/${label}`);
    const checks = [];
    const t = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

    // ---- A. compact (production) branch is frozen --------------------------
    const minHm = withSeed(3000, () => new HiveMind(stateDirFor('min'), 3, 12, 'Dmin', true));
    for (const [k, v] of Object.entries(COMPACT_EXPECTED)) {
        t(`compact ${k} == ${v}`, Object.is(minHm[k], v), `${minHm[k]}`);
    }
    t('compact shapes consistent', shapeProblems(minHm).length === 0, shapeProblems(minHm).join(','));
    const minD = minHm.diagnostics();
    t('compact LSH index consistent', minD.lshConsistent === true);

    // ---- B. full-size branch sweep: shapes + smoke -------------------------
    const configs = [];
    for (const es of [2, 3, 8, 16, 64, 256, 1000]) for (const is of [4, 12, 32]) configs.push([es, is]);
    let idx = 0;
    const dims = {};
    for (const [es, is] of configs) {
        idx++;
        let hm = null, err = null;
        try { hm = withSeed(4000 + idx, () => new HiveMind(stateDirFor(`${es}_${is}`), es, is, `D${idx}`, false)); }
        catch (e) { err = e.message; }
        t(`full es=${es} is=${is} constructs`, !err, err || '');
        if (!hm) continue;
        const shape = shapeProblems(hm);
        t(`full es=${es} is=${is} shapes`, shape.length === 0, shape.join(','));
        t(`full es=${es} is=${is} ensembleSize`, hm._ensembleSize === es);
        let finite = true, trainOk = true;
        try {
            for (let s = 0; s < 6; s++) {
                const inp = Array.from({ length: is }, (_, k) => Math.sin(s * 0.3 + k * 0.11));
                const p = hm.predict(inp);
                if (!Number.isFinite(p) || p < 0 || p > 1) finite = false;
                hm.train(inp, s % 2, 1);
            }
        } catch (e) { trainOk = false; err = e.message; }
        t(`full es=${es} is=${is} finite predict`, finite);
        t(`full es=${es} is=${is} train ok`, trainOk, err || '');
        if (is === 12) dims[es] = hm;
    }

    // ---- C. scaling-law structure (monotonicity) ---------------------------
    const esKeys = Object.keys(dims).map(Number).sort((a, b) => a - b);
    let layersMono = true, headsMono = true, hiddenMono = true, lrMono = true;
    const trace = [];
    for (let i = 1; i < esKeys.length; i++) {
        const a = dims[esKeys[i - 1]], b = dims[esKeys[i]];
        if (b._numLayers > a._numLayers) layersMono = false;
        if (b._numHeads > a._numHeads) headsMono = false;
        if (b._hiddenSize > a._hiddenSize) hiddenMono = false;
        if (b._learningRate < a._learningRate) lrMono = false;
    }
    for (const es of esKeys) trace.push(`${es}:L${dims[es]._numLayers}/H${dims[es]._hiddenSize}/hd${dims[es]._numHeads}/lr${dims[es]._learningRate}`);
    t('full layers monotone non-increasing in es', layersMono, trace.join(' '));
    t('full heads monotone non-increasing in es', headsMono);
    t('full hiddenSize monotone non-increasing in es', hiddenMono);
    t('full learningRate monotone non-decreasing in es', lrMono);
    // normalized clamps at 1.0 for es >= 1000, so every normalized-derived
    // dimension must coincide; `_gradientResetFrequency` is the one field that
    // also reads `ensembleSize` directly (its cadence is a real step count), so
    // it is excluded.
    const big1 = withSeed(5000, () => new HiveMind(stateDirFor('big1'), 1000, 12, 'B1', false));
    const big2 = withSeed(5000, () => new HiveMind(stateDirFor('big2'), 5000, 12, 'B2', false));
    const bigDiff = DIM_FIELDS.filter(f => f !== '_gradientResetFrequency' && !Object.is(big1[f], big2[f]));
    t('normalized-derived dims saturate once log10(es)/3 >= 1', bigDiff.length === 0, bigDiff.join(','));
    t('gradientResetFrequency scales with ensembleSize', big2._gradientResetFrequency > big1._gradientResetFrequency,
        `${big1._gradientResetFrequency} < ${big2._gradientResetFrequency}`);

    // ---- D. only the learning rate depends on inputSize --------------------
    const is4 = withSeed(6000, () => new HiveMind(stateDirFor('is4'), 16, 4, 'I4', false));
    const is32 = withSeed(6000, () => new HiveMind(stateDirFor('is32'), 16, 32, 'I32', false));
    const isDiff = DIM_FIELDS.filter(f => !Object.is(is4[f], is32[f]));
    t('dimensions independent of inputSize', isDiff.length === 0, isDiff.join(','));
    t('learningRate depends on inputSize', is4._learningRate !== is32._learningRate, `${is4._learningRate} vs ${is32._learningRate}`);

    // ---- E. end-to-end churn on a full-size instance -----------------------
    for (const [label, es, is] of [['full-A', 16, 12], ['full-B', 64, 12]]) {
        const rows = makeInputs(is, 220, 23 + es);
        let hm = null, err = null;
        try {
            hm = withSeed(7000 + es, () => new HiveMind(stateDirFor(`churn-${label}`), es, is, label, false));
            for (let s = 0; s < rows.length; s++) {
                withSeed(7100 + es + s, () => hm.train(rows[s], s % 2, 1));
            }
        } catch (e) { err = e.message; }
        t(`churn ${label} trained`, !err, err || '');
        if (!hm) continue;
        const d = hm.diagnostics();
        t(`churn ${label} LSH consistent`, d.lshConsistent === true, JSON.stringify(d.problems.slice(0, 3)));
        t(`churn ${label} no dead protos in LSH`, d.deadInBuckets === 0, `dead=${d.deadInBuckets}`);
        t(`churn ${label} no live protos missing`, d.missingFromBuckets === 0, `missing=${d.missingFromBuckets}`);
        t(`churn ${label} weights finite`, d.weights.nonFinite === 0);
        t(`churn ${label} gradients finite`, d.gradients.nonFinite === 0);
        t(`churn ${label} protos formed`, d.totals.semantic > 0, `sem=${d.totals.semantic}`);
        const expectedRefs = d.numLshSets * d.lshNumTables;
        const badMult = d.members.filter(m => m.bucketEntries !== expectedRefs * m.semantic);
        t(`churn ${label} bucket multiplicity exact`, badMult.length === 0,
            JSON.stringify(badMult.slice(0, 2).map(m => ({ idx: m.idx, sem: m.semantic, entries: m.bucketEntries, expected: expectedRefs * m.semantic }))));

        // projection geometry: a unit-norm projection compared with itself is 1.
        const proto = hm._semanticProtos[0] && hm._semanticProtos[0][0];
        if (proto) {
            const selfSim = hm._projSimilarity(proto.projNorms, proto.projNorms);
            t(`churn ${label} unit-norm projection self-similarity ~1`, selfSim > 0.999, `self=${selfSim}`);
            let minNorm = Infinity, maxNorm = 0;
            for (const proj of proto.projNorms) {
                let n = 0; for (const v of proj) n += v * v;
                n = Math.sqrt(n);
                minNorm = Math.min(minNorm, n); maxNorm = Math.max(maxNorm, n);
            }
            t(`churn ${label} every projection is unit norm`, Math.abs(minNorm - 1) < 1e-3 && Math.abs(maxNorm - 1) < 1e-3,
                `norms in [${minNorm}, ${maxNorm}]`);
        } else {
            t(`churn ${label} unit-norm projection self-similarity ~1`, false, 'no proto');
            t(`churn ${label} every projection is unit norm`, false, 'no proto');
        }
        const wsum = hm._ensembleWeights.reduce((a, b) => a + b, 0);
        t(`churn ${label} ensemble weights sum to 1`, Math.abs(wsum - 1) < 1e-9, `sum=${wsum}`);
        t(`churn ${label} ensemble weights non-negative`, hm._ensembleWeights.every(w => w >= 0));
    }

    // ---- F. boundary configs ----------------------------------------------
    for (const [es, is] of [[1, 1], [1, 64], [2, 1]]) {
        let hm = null, err = null;
        try { hm = withSeed(8000 + es + is, () => new HiveMind(stateDirFor(`bound-${es}-${is}`), es, is, `B${es}${is}`, false)); }
        catch (e) { err = e.message; }
        t(`boundary es=${es} is=${is} constructs`, !err, err || '');
        if (hm) t(`boundary es=${es} is=${is} shapes`, shapeProblems(hm).length === 0, shapeProblems(hm).join(','));
    }

    const failed = checks.filter(c => !c.ok);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
