// src/analysis/dependence/correlation.js (round-101 split of src/analysis/dependence.js).
// Pairwise correlation + the Kish equicorrelation design effect.
// Pearson product-moment correlation between two equal-length series. Returns
// NaN for a pair with fewer than three points or a zero-variance member (there is
// no correlation to speak of, and silently returning 0 would bias the average
// correlation down).
export function pearsonCorrelation(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 3) return NaN;
    const n = a.length;
    let ma = 0; let mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0; let sa = 0; let sb = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - ma; const db = b[i] - mb;
        sab += da * db; sa += da * da; sb += db * db;
    }
    if (!(sa > 0) || !(sb > 0)) return NaN;
    return sab / Math.sqrt(sa * sb);
}

// Mean pairwise correlation across a list of series (e.g. one per-fold Sharpe
// series per stream). Pairs that cannot be correlated are skipped; NaN when no
// pair survives or when the series are too few to form one.
export function meanPairwiseCorrelation(seriesList) {
    if (!Array.isArray(seriesList) || seriesList.length < 2) return NaN;
    const rs = [];
    for (let i = 0; i < seriesList.length; i++) {
        for (let j = i + 1; j < seriesList.length; j++) {
            const r = pearsonCorrelation(seriesList[i], seriesList[j]);
            if (Number.isFinite(r)) rs.push(r);
        }
    }
    if (!rs.length) return NaN;
    return rs.reduce((x, y) => x + y, 0) / rs.length;
}

// The equicorrelation design effect: with K units of equal size and a common
// pairwise correlation rho, the variance of the mean is inflated by
// 1 + (K-1)*rho (Kish, *Survey Sampling*, 1965; the survey-sampling "deff").
// Negative average correlation *reduces* the variance, which is legitimate —
// hedging streams really do buy more than one independent observation — so the
// raw rho is used rather than clamped at zero.
export function equicorrelationDesignEffect(k, rho) {
    if (!Number.isFinite(k) || k < 1) return NaN;
    if (!Number.isFinite(rho)) return NaN;
    return 1 + (k - 1) * rho;
}

// K correlated streams are worth this many independent ones (Kish 1965).
export function equicorrelationEffectiveSize(k, rho) {
    const deff = equicorrelationDesignEffect(k, rho);
    if (!Number.isFinite(deff) || deff <= 0) return NaN;
    return k / deff;
}
