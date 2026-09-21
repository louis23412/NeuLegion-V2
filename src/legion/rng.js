// NeuLegion legion component: deterministic RNG for reproducible runs
// (ROADMAP P0-2).
//
// The model draws from `Math.random` in dozens of places (init, sampling,
// replay, attention, consolidation tie-breaks). A run is reproducible iff every
// worker thread's `Math.random` is a deterministic function of (run seed,
// worker id). `deriveSeed` mixes the run seed with a stable FNV-1a hash of the
// worker's key, and `installSeededRandom` replaces `Math.random` with a
// mulberry32 stream — the same generator the tests already use via `withSeed`.
//
// Default is off: with `CONFIG.seed == null` nothing here runs, so the golden
// fingerprints and the existing tests are byte-identical.

export const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// Stable FNV-1a hash of a string -> uint32. Used to turn a worker key (e.g.
// "G0S1L0C3") into a distinct but deterministic sub-seed.
export const hashString = (str) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

// Mix a base seed with a key. Deterministic for any (finite) base + key.
export const deriveSeed = (base, key) => {
    const a = Number.isFinite(base) ? (base >>> 0) : 0;
    const b = hashString(String(key));
    let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h >>> 0;
};

// Install a deterministic `Math.random`. Returns the stream so a caller may
// keep a private handle. Safe to call once per worker/thread.
export const installSeededRandom = (seed) => {
    const rng = mulberry32(Number.isFinite(seed) ? (seed >>> 0) : hashString(String(seed)));
    Math.random = rng;
    return rng;
};
