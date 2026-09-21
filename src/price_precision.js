// Price-target precision for the controller.
//
// Take-profit and stop-loss levels are stored on a decimal grid so they are
// reproducible and directly comparable against candle high/low. The grid must
// be *fine relative to the instrument's own price scale*, otherwise rounding
// moves a target across the entry price and silently flips its direction:
//
//   - a sub-cent asset truncated to 2 dp collapses to 0.00 (DOGEUSDT trades at
//     $0.0013), so a "positive" controller emits sellPrice === stopLoss === 0;
//     `_updateOpenTrades` then reads `sellPrice > entryPrice` as false and
//     treats every long as a short whose stop is hit on the very next bar —
//     every trade is mislabelled a loss and the model trains on pure noise;
//   - mid-cent assets (ADAUSDT $0.02, XRPUSDT $0.12) round onto the 0.01 grid,
//     which is coarser than the configured minimum movement, so the same flip
//     happens intermittently.
//
// The number of decimals is therefore derived from the price magnitude and the
// configured minimum *relative* movement, not hardcoded. The grid is kept at
// least `SAFETY` times finer than `price * minMovement`:
//
//     10^-d <= price * minMovement / SAFETY
//  => d     >= log10(SAFETY / minMovement) - log10(price)
//
// so rounding can never move a target by more than a small fraction of the
// minimum distance — direction is always preserved. `d` is clamped to
// [MIN_PRICE_DECIMALS, MAX_PRICE_DECIMALS]; prices of $10 and above keep the
// historical 2 dp (the grid is already comfortably finer than the minimum move
// there), so high-priced instruments are byte-for-byte unchanged.

export const MIN_PRICE_DECIMALS = 2;
export const MAX_PRICE_DECIMALS = 8;
export const DEFAULT_MIN_MOVEMENT = 0.0025;

// The grid must be this many times finer than the minimum price movement.
const SAFETY = 10;

// Guards against a floating-point log10 landing a hair above an integer and
// promoting the result by one decimal (e.g. price = 4 exactly).
const CEIL_EPSILON = 1e-12;

// Decimal places that keep the take-profit/stop-loss grid at least `SAFETY`
// times finer than `price * minMovement`. Returns `min` for non-finite or
// non-positive prices so callers never receive NaN into `truncateToDecimals`.
export const priceDecimals = (
    price,
    { minMovement = DEFAULT_MIN_MOVEMENT, min = MIN_PRICE_DECIMALS, max = MAX_PRICE_DECIMALS } = {},
) => {
    if (!Number.isFinite(price) || price <= 0) return min;
    const movement = Number.isFinite(minMovement) && minMovement > 0 ? minMovement : DEFAULT_MIN_MOVEMENT;
    const wanted = Math.ceil(Math.log10(SAFETY / movement) - Math.log10(price) - CEIL_EPSILON);
    if (!Number.isFinite(wanted)) return min;
    return Math.min(max, Math.max(min, wanted));
};

// Convenience: the actual step between representable target prices (10^-d).
export const priceGrid = (price, options) => Math.pow(10, -priceDecimals(price, options));
