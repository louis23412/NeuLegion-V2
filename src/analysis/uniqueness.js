// Sample uniqueness for overlapping labels.
//
// When labels span a horizon, neighbouring observations share information. The
// nominal sample size then overstates the evidence: 1000 overlapping labels may
// carry the weight of a few hundred independent ones. Each observation's
// "uniqueness" is the average of 1 / concurrency over its span, and the sum of
// uniqueness is the effective sample size used to weight the loss.
//
// Reference: Lopez de Prado, "Advances in Financial Machine Learning", ch. 4.
//
// Pure: no I/O, no RNG.

// labelSpans: array of [start, end] (inclusive) per observation.
// Returns per-observation uniqueness in (0, 1].
export function sampleUniqueness(labelSpans) {
    if (!labelSpans.length) return [];
    let maxEnd = 0;
    for (const [s, e] of labelSpans) maxEnd = Math.max(maxEnd, e, s);
    const concurrency = new Float64Array(maxEnd + 1);
    for (const [s, e] of labelSpans) {
        for (let t = s; t <= e; t++) concurrency[t] += 1;
    }
    return labelSpans.map(([s, e]) => {
        let acc = 0;
        const len = e - s + 1;
        for (let t = s; t <= e; t++) acc += 1 / concurrency[t];
        return acc / len;
    });
}

export function averageUniqueness(labelSpans) {
    const u = sampleUniqueness(labelSpans);
    if (!u.length) return NaN;
    return u.reduce((a, b) => a + b, 0) / u.length;
}

// Effective (independent) sample size: sum of uniqueness. For non-overlapping
// point labels this equals n exactly; for heavily overlapping labels it is much
// smaller.
export function effectiveSampleSize(labelSpans) {
    return sampleUniqueness(labelSpans).reduce((a, b) => a + b, 0);
}

// Sequential bootstrap: draw a bootstrap sample that respects uniqueness by
// favouring observations unique at the time they are drawn. Deterministic given
// `seed`. Returns the drawn indices.
//
// Reference: Lopez de Prado ch. 4 (sequential bootstrap).
export function sequentialBootstrap({ labelSpans, size = null, seed = 1 } = {}) {
    const n = labelSpans.length;
    if (!n) return [];
    const draws = size != null ? size : n;
    const rnd = mulberry32(seed);
    let maxEnd = 0;
    for (const [s, e] of labelSpans) maxEnd = Math.max(maxEnd, e, s);
    const concurrency = new Float64Array(maxEnd + 1);
    for (const [s, e] of labelSpans) for (let t = s; t <= e; t++) concurrency[t] += 1;

    const avgU = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const [s, e] = labelSpans[i];
        let acc = 0;
        for (let t = s; t <= e; t++) acc += 1 / concurrency[t];
        avgU[i] = acc;
    }

    const count = new Float64Array(n);
    const picked = [];
    for (let d = 0; d < draws; d++) {
        // Probability of index i ∝ its running average uniqueness / (1 + pick count).
        let total = 0;
        const w = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const denom = 1 + count[i];
            const val = avgU[i] / denom;
            w[i] = val;
            total += val;
        }
        if (!(total > 0)) break;
        let r = rnd() * total;
        let chosen = n - 1;
        for (let i = 0; i < n; i++) { r -= w[i]; if (r <= 0) { chosen = i; break; } }
        count[chosen] += 1;
        picked.push(chosen);
    }
    return picked;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
