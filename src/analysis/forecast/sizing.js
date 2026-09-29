// Forecast-sized books (W4c-z, round 65) — split from `analysis/forecast.js`
// in round 71 (byte-exact move; the `forecast.js` re-export shim keeps every
// import path working). The causal vol-target scaling arithmetic (vendored
// bit-exact into `plugins/risk/vol-target.js`). Self-contained: no imports.

// ---- W4c-z: forecast-sized books (round 65) ---------------------------------
// F-16/F-106: sizing is a risk result, not a forecast result — the repo owns
// the causal scaling arithmetic, the caller owns the target (re-estimated
// causally, never banked). `target` is a scalar vol or a per-bar array aligned
// with `vols` (e.g. a trailing mean); every bar with a non-finite return, a
// non-positive forecast vol, or a non-positive target is skipped, never
// assigned an infinite scale.
export function applyVolTargetScaling(returns, vols, { target, cap = 4 } = {}) {
  if (!Array.isArray(returns) || !Array.isArray(vols) || returns.length !== vols.length) return { available: false, reason: 'returns and vols must be aligned arrays (W4c-z)' };
  if (!Array.isArray(target) && !(target > 0)) return { available: false, reason: 'target must be a positive vol (W4c-z)' };
  if (Array.isArray(target) && target.length !== vols.length) return { available: false, reason: 'array target must align with vols (W4c-z)' };
  if (!(cap > 0)) return { available: false, reason: 'cap must be a positive multiple (W4c-z)' };
  const index = [];
  const scaled = [];
  const scales = [];
  let skipped = 0;
  for (let t = 0; t < returns.length; t++) {
    const r = returns[t];
    const v = vols[t];
    const tg = Array.isArray(target) ? target[t] : target;
    if (!Number.isFinite(r) || !Number.isFinite(v) || !(v > 0) || !(tg > 0)) { skipped++; continue; }
    const s = Math.min(cap, tg / v);
    index.push(t);
    scales.push(s);
    scaled.push(s * r);
  }
  if (!scaled.length) return { available: false, reason: 'no scorable bars (W4c-z)' };
  return { available: true, n: returns.length, scored: scaled.length, skipped, index, scales, scaled };
}