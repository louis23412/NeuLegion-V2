// Truncates toward zero. Using Math.floor was wrong for negative inputs (it
// rounds toward -Infinity, so -1.239 became -1.24), which matters for any
// signed value such as a price difference or a centered mean.
export const truncateToDecimals = (value, decimals) => {
    if (!Number.isFinite(value)) return value;
    const factor = Math.pow(10, decimals);
    return Math.trunc(value * factor) / factor;
};

// `isValidNumber` is used as a pure boolean predicate in ~250 call sites
// (Array.prototype.every/filter, ternaries, guards). It must NEVER throw,
// otherwise a single malformed datum (or a non-numeric field such as an ISO
// timestamp string) aborts the entire pipeline.
export const isValidNumber = (value) => {
    if (value == null) return false;

    if (typeof value === 'string') {
        if (value === '') return false;
        if (/\s/.test(value)) return false;
        if (!/^-?\d*(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return false;
        value = Number(value);
    } else if (typeof value !== 'number') {
        return false;
    }

    return Number.isFinite(value);
};

// Exact fast-path twin of `isValidNumber` for numeric hot loops. For every
// possible input the result is identical (`typeof value === 'number'` routes
// straight to `Number.isFinite`, which is precisely what the full predicate
// returns for numbers; everything else defers to the full predicate). The
// difference is that the common numeric case never touches the string/regex
// branches, so V8 can inline it into tight loops over typed arrays.
export const isFiniteNumber = (value) =>
    typeof value === 'number' ? Number.isFinite(value) : isValidNumber(value);

// Timestamps are stored/keyed as TEXT (ISO-8601 strings by default), so they
// must be validated as opaque non-empty string/number identifiers, not as
// numbers. Accepting both keeps numeric-epoch feeds working too.
export const isValidTimestamp = (value) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.trim().length > 0;
    return false;
};