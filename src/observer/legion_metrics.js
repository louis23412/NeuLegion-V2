// NeuLegion observer component: pure metrics for watching the *legion's own*
// health (ROADMAP P1-2).
//
// This is deliberately distinct from `src/analysis/*`, which scores a
// strategy's *returns*. The observer scores the running system: is the
// consensus calibrated, is the ensemble still diverse, has influence collapsed
// onto one controller, is the score distribution drifting, is memory/vault
// growth or the worker pool degrading. Everything here is a pure function with
// no state, no imports from the hot path, and exact reference vectors in
// `observer.test.js`, so the whole layer is `LOCKED-invariant`.
//
// Grounding: Brier 1950 (proper score), Murphy 1973 (reliability-resolution
// partition), Page 1954 (CUSUM), Cohen 1960 (kappa), Kuncheva & Whitaker 2003
// (diversity), Gini 1912 / Hirschman 1945 (concentration).

export const mean = (xs) => (xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Population standard deviation (the diversity readout). 0 for < 2 samples.
export const stdev = (xs) => {
    if (!Array.isArray(xs) || xs.length < 2) return 0;
    const m = mean(xs);
    let v = 0;
    for (const x of xs) {
        const d = Number(x) - m;
        if (Number.isFinite(d)) v += d * d;
    }
    return Math.sqrt(v / xs.length);
};

export const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

const asArrays = (outcomes, probs) => {
    if (!Array.isArray(outcomes) || !Array.isArray(probs)) return null;
    if (outcomes.length === 0 || outcomes.length !== probs.length) return null;
    return { outcomes, probs, n: outcomes.length };
};

// Brier score: mean((p - y)^2). The proper scoring rule for probabilistic
// forecasts (Brier 1950). 0 = perfect, 0.25 = a constant 0.5 forecast, 1 = the
// confident-and-wrong extreme.
export const brierScore = (outcomes, probs) => {
    const a = asArrays(outcomes, probs);
    if (!a) return 0;
    let s = 0;
    for (let i = 0; i < a.n; i++) {
        const p = Number(a.probs[i]);
        const y = Number(a.outcomes[i]) ? 1 : 0;
        const d = Number.isFinite(p) ? p : 0;
        s += (d - y) * (d - y);
    }
    return s / a.n;
};

export const baseRate = (outcomes) => (outcomes && outcomes.length
    ? outcomes.reduce((a, y) => a + (Number(y) ? 1 : 0), 0) / outcomes.length
    : 0);

// Equal-width binning of [0, 1]. Returns per-bin counts and means so both the
// reliability curve and the decomposition are computed from one pass.
export const reliabilityCurve = (outcomes, probs, bins = 10) => {
    const a = asArrays(outcomes, probs);
    if (!a) return [];
    const k = Math.max(1, Math.floor(bins));
    const acc = Array.from({ length: k }, () => ({ n: 0, sumP: 0, sumY: 0 }));
    for (let i = 0; i < a.n; i++) {
        const p = clamp01(Number(a.probs[i]));
        const y = Number(a.outcomes[i]) ? 1 : 0;
        let b = Math.floor(p * k);
        if (b >= k) b = k - 1;
        if (b < 0) b = 0;
        acc[b].n += 1;
        acc[b].sumP += p;
        acc[b].sumY += y;
    }
    return acc.map((cell, idx) => ({
        bin: idx,
        lo: idx / k,
        hi: (idx + 1) / k,
        n: cell.n,
        meanProb: cell.n ? cell.sumP / cell.n : 0,
        meanOutcome: cell.n ? cell.sumY / cell.n : 0,
    }));
};

// Murphy (1973) partition. For equal-width bins the exact algebraic identity is
//
//   Brier = REL - RES + UNC + WITHIN
//
// where WITHIN = (1/N)·Σ_bins Σ_i [ (p_i - p̄_b)² - 2 (p_i - p̄_b)(y_i - ō_b) ].
// The standard textbook form drops WITHIN (it vanishes for perfectly calibrated
// fine bins); we keep it so the identity is exact and testable at any bin count.
export const brierDecomposition = (outcomes, probs, bins = 10) => {
    const a = asArrays(outcomes, probs);
    if (!a) return { brier: 0, reliability: 0, resolution: 0, uncertainty: 0, within: 0, baseRate: 0, bins: [] };

    const curve = reliabilityCurve(outcomes, probs, bins);
    const oBar = baseRate(outcomes);
    const n = a.n;

    let reliability = 0;
    let resolution = 0;
    for (const cell of curve) {
        if (!cell.n) continue;
        const w = cell.n / n;
        reliability += w * (cell.meanProb - cell.meanOutcome) ** 2;
        resolution += w * (cell.meanOutcome - oBar) ** 2;
    }
    const uncertainty = oBar * (1 - oBar);

    // WITHIN: recompute per-bin deviations exactly from the raw pairs.
    const withinSum = Array.from({ length: curve.length }, () => ({ a2: 0, ab: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
        const p = clamp01(Number(a.probs[i]));
        const y = Number(a.outcomes[i]) ? 1 : 0;
        let b = Math.floor(p * curve.length);
        if (b >= curve.length) b = curve.length - 1;
        if (b < 0) b = 0;
        const cell = curve[b];
        const dp = p - cell.meanProb;
        const dy = y - cell.meanOutcome;
        withinSum[b].a2 += dp * dp;
        withinSum[b].ab += dp * dy;
        withinSum[b].count += 1;
    }
    let within = 0;
    for (const w of withinSum) if (w.count) within += (w.a2 - 2 * w.ab) / n;

    return {
        brier: brierScore(outcomes, probs),
        reliability,
        resolution,
        uncertainty,
        within,
        baseRate: oBar,
        bins: curve,
    };
};

// Shannon entropy (bits) of a non-negative weight vector, normalised to a
// distribution first. Used as the ensemble-diversity readout.
export const shannonEntropy = (weights) => {
    if (!Array.isArray(weights) || weights.length === 0) return 0;
    let total = 0;
    for (const w of weights) if (Number.isFinite(w) && w > 0) total += w;
    if (!(total > 0)) return 0;
    let h = 0;
    for (const w of weights) {
        if (!Number.isFinite(w) || w <= 0) continue;
        const p = w / total;
        h -= p * Math.log2(p);
    }
    return h;
};

// Herfindahl-Hirschman index of a non-negative weight vector (1 = one holder).
export const hhi = (weights) => {
    if (!Array.isArray(weights) || weights.length === 0) return 0;
    let total = 0;
    for (const w of weights) if (Number.isFinite(w) && w > 0) total += w;
    if (!(total > 0)) return 0;
    let s = 0;
    for (const w of weights) {
        if (!Number.isFinite(w) || w <= 0) continue;
        s += (w / total) ** 2;
    }
    return s;
};

// Effective number of voters = 1 / HHI (Laakso-Taagepera). 1 = a single voter.
export const effectiveVoters = (weights) => {
    const h = hhi(weights);
    return h > 0 ? 1 / h : 0;
};

// Population Gini coefficient of a non-negative value vector (0 = equal).
export const gini = (values) => {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    const n = xs.length;
    if (n === 0) return 0;
    const total = xs.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return 0;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += (i + 1) * xs[i];
    return (2 * acc) / (n * total) - (n + 1) / n;
};

// Exponentially weighted moving average series. `lambda` is the decay (higher =
// smoother); alpha = 1 - lambda. Returns one value per input (seeded with x0).
export const ewmaSeries = (values, lambda = 0.9) => {
    if (!Array.isArray(values) || values.length === 0) return [];
    const lam = Number.isFinite(lambda) ? Math.min(1, Math.max(0, lambda)) : 0.9;
    const out = [];
    let prev = Number(values[0]);
    if (!Number.isFinite(prev)) prev = 0;
    out.push(prev);
    for (let i = 1; i < values.length; i++) {
        const x = Number(values[i]);
        prev = lam * prev + (1 - lam) * (Number.isFinite(x) ? x : 0);
        out.push(prev);
    }
    return out;
};

// Two-sided CUSUM control statistic (Page 1954). Standardised by an explicit
// target and slack `k` (in units of sigma when `sigma` is given). Returns the
// running positive/negative statistics plus the first alarm indices at `h`.
export const cusum = (values, { target = 0, k = 0.5, h = 5, sigma = 1 } = {}) => {
    if (!Array.isArray(values) || values.length === 0) {
        return { positive: [], negative: [], alarms: [], alarmIndex: -1, lastPositive: 0, lastNegative: 0 };
    }
    const s = Number.isFinite(sigma) && sigma > 0 ? sigma : 1;
    const kk = (Number.isFinite(k) && k > 0 ? k : 0.5) * s;
    const hh = (Number.isFinite(h) && h > 0 ? h : 5) * s;
    const t = Number.isFinite(target) ? target : 0;

    const positive = [];
    const negative = [];
    const alarms = [];
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < values.length; i++) {
        const x = Number(values[i]);
        const z = Number.isFinite(x) ? x - t : 0;
        pos = Math.max(0, pos + z - kk);
        neg = Math.max(0, neg - z - kk);
        positive.push(pos);
        negative.push(neg);
        if (pos > hh || neg > hh) alarms.push(i);
    }
    const alarmIndex = alarms.length ? alarms[0] : -1;
    return {
        positive,
        negative,
        alarms,
        alarmIndex,
        // 'up' | 'down' | 'none' for the first alarm
        direction: alarmIndex < 0 ? 'none' : (positive[alarmIndex] > hh ? 'up' : 'down'),
        lastPositive: pos,
        lastNegative: neg,
    };
};

// Cohen's kappa for two binary label vectors (chance-corrected agreement).
export const cohensKappa = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    const n = a.length;
    let n11 = 0, n00 = 0, n10 = 0, n01 = 0;
    for (let i = 0; i < n; i++) {
        const x = Number(a[i]) ? 1 : 0;
        const y = Number(b[i]) ? 1 : 0;
        if (x && y) n11++;
        else if (!x && !y) n00++;
        else if (x && !y) n10++;
        else n01++;
    }
    const po = (n11 + n00) / n;
    const pe = ((n11 + n10) / n) * ((n11 + n01) / n) + ((n00 + n01) / n) * ((n00 + n10) / n);
    if (pe === 1) return po === 1 ? 1 : 0;
    return (po - pe) / (1 - pe);
};

// Mean pairwise Cohen's kappa across a set of binary vectors (the ensemble
// agreement readout). Returns { mean, min, max, pairs } where `pairs` is the
// number of pairs measured.
export const meanPairwiseKappa = (vectors) => {
    if (!Array.isArray(vectors) || vectors.length < 2) return { mean: 0, min: 0, max: 0, pairs: 0 };
    let sum = 0, lo = Infinity, hi = -Infinity, pairs = 0;
    for (let i = 0; i < vectors.length; i++) {
        for (let j = i + 1; j < vectors.length; j++) {
            const k = cohensKappa(vectors[i], vectors[j]);
            sum += k;
            lo = Math.min(lo, k);
            hi = Math.max(hi, k);
            pairs++;
        }
    }
    return { mean: pairs ? sum / pairs : 0, min: pairs ? lo : 0, max: pairs ? hi : 0, pairs };
};

// Summarise a legion snapshot's influence distribution. `controllers` is the
// { positive:{voters}, negative:{voters} } shape broadcast.js produces; each
// voter carries `influence`.
export const influenceSummary = (controllers) => {
    const voters = [
        ...(controllers?.positive?.voters ?? []),
        ...(controllers?.negative?.voters ?? []),
    ];
    const weights = voters.map((v) => (Number.isFinite(v?.influence) && v.influence > 0 ? v.influence : 0));
    return {
        count: voters.length,
        hhi: hhi(weights),
        effectiveVoters: effectiveVoters(weights),
        entropyBits: shannonEntropy(weights),
        gini: gini(weights),
        maxShare: (() => {
            const total = weights.reduce((a, b) => a + b, 0);
            if (!(total > 0)) return 0;
            return Math.max(...weights) / total;
        })(),
    };
};

// Convert a consensus confidence (0-100) + direction into a BUY probability.
export const consensusProbability = (consensus) => {
    const c = Number(consensus?.confidence);
    if (!Number.isFinite(c)) return 0.5;
    const p = clamp01(c / 100);
    return consensus?.direction === 'SELL' ? 1 - p : p;
};
