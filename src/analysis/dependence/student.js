// src/analysis/dependence/student.js (round-101 split of src/analysis/dependence.js).
// Student-t machinery (incomplete beta) + first-PC factor-neutral leg.
// ---------------------------------------------------------------------------
// Student-t CDF (regularised incomplete beta, Numerical Recipes 6.4)
// ---------------------------------------------------------------------------
// Included because the cluster-robust p-values above are referenced to t(C-1),
// and the project has no t distribution anywhere else. Verified against exact
// table values in `analysis.test.js` (t = 2.0301 at df = 35 is two-sided 0.05).

function gammln(xx) {
    const cof = [
        76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let x = xx;
    let y = xx;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) {
        y += 1;
        ser += cof[j] / y;
    }
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
    const FPMIN = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 3e-16) break;
    }
    return h;
}

// I_x(a,b): the regularised incomplete beta function.
export function regularizedIncompleteBeta(a, b, x) {
    if (!(a > 0) || !(b > 0) || !Number.isFinite(x)) return NaN;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(
        gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x),
    );
    if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
    return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// The Student-t critical value: the `t` at which the upper tail equals `alpha`
// (one-sided) or `alpha / 2` (two-sided). This is the INVERSE of `studentTPValue`
// and it is what a sizing statement needs: `pairedClusterTest.significant` is
// `pOneSided <= alpha`, so the difference a paired test can resolve is
// `tCritical(C - 1, alpha) * se`, NOT `1.959964 * se`. Using the normal constant
// for a one-sided t test at C = 36 overstates the requirement by ~16%
// (1.959964 / 1.68957) — the round-28 reading defect `BUGS.md` #56.
//
// Bisection on the monotone upper tail (P(T > t) strictly decreases in t), with
// a doubling bracket, so it needs no table and is exact to float precision.
// Verified against table values in `analysis.test.js` (t = 1.68957 at df = 35,
// one-sided 0.05; t = 2.03011 at df = 35, two-sided 0.05).
export function studentTCritical(df, { alpha = 0.05, twoSided = false } = {}) {
    if (!Number.isFinite(df) || df <= 0) return NaN;
    const p = twoSided ? alpha / 2 : alpha;
    if (!(p > 0) || !(p < 1)) return NaN;
    let lo = 0;
    let hi = 1;
    while (hi < 1e8 && studentTPValue(hi, df, { twoSided: false }) > p) hi *= 2;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (studentTPValue(mid, df, { twoSided: false }) > p) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// P(T > t) for a Student-t with `df` degrees of freedom (one-sided), or the
// two-sided p-value when `twoSided`. t = 0 gives exactly 0.5 / 1.
//
// The infinite cases are handled BEFORE the finite guard: a cluster-robust t can
// be exactly +-Infinity when the delete-one-cluster differences are degenerate
// (zero jackknife SE with a non-zero difference), and p must be 0 there — the
// guard used to swallow them and return NaN, which silently turned a perfectly
// dominant candidate into "not significant".
export function studentTPValue(t, df, { twoSided = true } = {}) {
    if (!Number.isFinite(df) || df <= 0) return NaN;
    if (t === Infinity) return twoSided ? 0 : 0;
    if (t === -Infinity) return twoSided ? 0 : 1;
    if (!Number.isFinite(t)) return NaN;
    const x = df / (df + t * t);
    const oneSidedUpper = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
    if (twoSided) return Math.min(1, 2 * oneSidedUpper);
    return t >= 0 ? oneSidedUpper : 1 - oneSidedUpper;
}

// Alias kept only so the lock registry/test naming convention has a stable name.
// CAUTION: this returns a p-value (an upper-tail probability), NOT a cumulative
// distribution value — `studentTCdf(-Infinity)` is 1, not 0. Use `studentTPValue`
// and read the option; a true CDF would be `1 - studentTPValue(t, df, { twoSided: false })`.
export const studentTCdf = studentTPValue;

export function firstPCWeights(panel) {
    if (!Array.isArray(panel) || panel.length < 1) return null;
    const n = Math.min(...panel.map((s) => Array.isArray(s) ? s.length : 0));
    if (!(n >= 2)) return null;
    const k = panel.length;
    const means = panel.map((s) => {
        let a = 0, c = 0;
        for (let i = 0; i < n; i++) { const v = s[i]; if (Number.isFinite(v)) { a += v; c++; } }
        return c > 0 ? a / c : NaN;
    });
    if (means.some((m) => !Number.isFinite(m))) return null;
    const cov = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
        let s = 0, c = 0;
        for (let i = 0; i < n; i++) { const x = panel[a][i] - means[a], y = panel[b][i] - means[b]; if (Number.isFinite(x) && Number.isFinite(y)) { s += x * y; c++; } }
        const v = c >= 2 ? s / (c - 1) : NaN;
        if (!Number.isFinite(v)) return null;
        cov[a][b] = v; cov[b][a] = v;
    }
    let w = new Array(k).fill(0);
    w[0] = 1;
    for (let it = 0; it < 200; it++) {
        const z = cov.map((row) => row.reduce((a, v, j) => a + v * w[j], 0));
        const nrm = Math.sqrt(z.reduce((a, v) => a + v * v, 0));
        if (!(nrm > 0)) return null;
        const w2 = z.map((v) => v / nrm);
        let d = 0;
        for (let j = 0; j < k; j++) d = Math.max(d, Math.abs(w2[j] - w[j]));
        w = w2;
        if (d < 1e-12) break;
    }
    return w;
}
export function factorNeutralResidual(series, panel) {
    if (!Array.isArray(series) || !Array.isArray(panel) || !panel.length) return null;
    const n = Math.min(series.length, ...panel.map((s) => Array.isArray(s) ? s.length : 0));
    if (!(n >= 2)) return null;
    const w = firstPCWeights(panel.map((s) => s.slice(0, n)));
    if (!w) return null;
    const means = panel.map((s) => s.slice(0, n).reduce((a, v) => a + v, 0) / n);
    const pc = [];
    for (let i = 0; i < n; i++) {
        let a = 0;
        for (let j = 0; j < panel.length; j++) { const v = panel[j][i]; if (!Number.isFinite(v)) { a = NaN; break; } a += w[j] * v; }
        pc.push(a);
    }
    if (pc.some((v) => !Number.isFinite(v))) return null;
    let ms = 0; for (let i = 0; i < n; i++) ms += series[i];
    ms /= n;
    let mp = 0; for (let i = 0; i < n; i++) mp += pc[i];
    mp /= n;
    let cov = 0, vp = 0;
    for (let i = 0; i < n; i++) { cov += (series[i] - ms) * (pc[i] - mp); vp += (pc[i] - mp) * (pc[i] - mp); }
    if (!(vp > 0)) return series.slice(0, n).map((v) => v - ms);
    const beta = cov / vp;
    return series.slice(0, n).map((v, i) => v - beta * pc[i]);
}
export function factorNeutralSharpe(series, panel) {
    const r = factorNeutralResidual(series, panel);
    if (!r || r.length < 2) return { raw: NaN, neutral: NaN, residual: null };
    const mean = (a) => a.reduce((x, v) => x + v, 0) / a.length;
    const stdS = (a) => {
        const m = mean(a);
        let s = 0;
        for (const v of a) s += (v - m) * (v - m);
        return Math.sqrt(s / (a.length - 1));
    };
    const mr = mean(series.slice(0, r.length)), sr = stdS(series.slice(0, r.length));
    const mn = mean(r), sn = stdS(r);
    const nScale = Math.max(1, Math.abs(mn));
    return { raw: sr > 0 ? mr / sr : 0, neutral: sn > 1e-12 * nScale ? mn / sn : 0, residual: r };
}

