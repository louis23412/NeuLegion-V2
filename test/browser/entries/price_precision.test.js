// Price-precision suite for NeuLegion, executed inside a browser Worker via
// test/browser/harness.js (mirrored by test/node/price_precision.test.js).
//
// `src/price_precision.js` decides how many decimals the controller's
// take-profit / stop-loss grid has. It is a bug-fix module: the grid used to be
// hardcoded to 2 dp, which turned any "positive" signal on a sub-$4 asset into a
// short whose stop sat on the first bar (DOGEUSDT at $0.0013 truncated to 0.00).
//
// These checks pin (a) exact reference vectors, (b) the clamps and invalid-input
// contract, and (c) the property the controller actually relies on: rounding a
// target by the configured minimum movement must never cross the entry price.

import {
    priceDecimals,
    priceGrid,
    MIN_PRICE_DECIMALS,
    MAX_PRICE_DECIMALS,
    DEFAULT_MIN_MOVEMENT,
} from '../../../src/price_precision.js';
import { truncateToDecimals } from '../../../src/hivemind/utils.js';

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. exact reference vectors (default 0.25% min movement) --------------
    const VECTORS = [
        [0.001329, 7],   // DOGEUSDT low
        [0.0029004, 7],  // DOGEUSDT mid
        [0.02009, 6],    // ADAUSDT low
        [0.11942, 5],    // XRPUSDT low
        [0.3645, 5],     // LINKUSDT low
        [0.4058, 4],
        [1.3312, 4],     // SOLUSDT low
        [3.9999, 4],
        [4, 3],
        [9.99, 3],
        [10, 3],
        [50, 2],
        [100, 2],
        [3946.37, 2],    // BTCUSDT low
        [126011.18, 2],  // BTCUSDT high
    ];
    for (const [price, dp] of VECTORS) {
        check(`priceDecimals(${price}) === ${dp}`, priceDecimals(price) === dp, String(priceDecimals(price)));
    }

    // 2 dp is the historical behaviour for every price >= $40, which is what
    // keeps the controller golden trajectory byte-identical.
    check('prices >= $40 keep the historical 2 dp',
        [40, 50, 100, 1000, 126011.18, 1e9].every((p) => priceDecimals(p) === 2),
        JSON.stringify([40, 100, 1e9].map(priceDecimals)));

    // ---- B. invalid input never propagates NaN -------------------------------
    check('non-finite price falls back to the minimum', priceDecimals(NaN) === MIN_PRICE_DECIMALS && priceDecimals(Infinity) === MIN_PRICE_DECIMALS);
    check('non-positive price falls back to the minimum', priceDecimals(0) === MIN_PRICE_DECIMALS && priceDecimals(-3) === MIN_PRICE_DECIMALS);
    check('invalid minMovement falls back to the default',
        priceDecimals(1, { minMovement: 0 }) === priceDecimals(1, { minMovement: DEFAULT_MIN_MOVEMENT }) &&
        priceDecimals(1, { minMovement: NaN }) === priceDecimals(1, { minMovement: DEFAULT_MIN_MOVEMENT }));

    // ---- C. clamps + monotonicity --------------------------------------------
    check('maximum decimals are clamped', priceDecimals(1e-8) === MAX_PRICE_DECIMALS, String(priceDecimals(1e-8)));
    check('minimum decimals are clamped', priceDecimals(1e12) === MIN_PRICE_DECIMALS, String(priceDecimals(1e12)));
    let monotone = true;
    let prev = Infinity;
    for (let e = -6; e <= 6; e += 0.25) {
        const d = priceDecimals(Math.pow(10, e));
        if (d > prev) { monotone = false; break; }
        prev = d;
    }
    check('decimals are non-increasing in price', monotone);

    // ---- D. grid equals 10^-decimals ----------------------------------------
    check('priceGrid is 10^-priceDecimals',
        [0.001329, 0.02, 0.4, 1.3, 100].every((p) => priceGrid(p) === Math.pow(10, -priceDecimals(p))));

    // ---- E. the property the controller relies on ---------------------------
    // For long targets: truncate(price + price*minMovement, dp) must stay above
    // price; for short targets: truncate(price - price*minMovement, dp) below.
    // If either failed, a take-profit could round back onto the entry and the
    // trade would be read as the opposite direction.
    const movement = DEFAULT_MIN_MOVEMENT;
    const broken = [];
    for (let e = -4; e <= 5; e += 0.1) {
        const price = Math.pow(10, e);
        const dp = priceDecimals(price);
        const up = truncateToDecimals(price + price * movement, dp);
        const down = truncateToDecimals(price - price * movement, dp);
        if (!(up > price)) broken.push(`up@${price}->${up}`);
        if (!(down < price)) broken.push(`down@${price}->${down}`);
    }
    check('rounding a target never crosses the entry price', broken.length === 0, broken.slice(0, 5).join(','));

    // ---- F. the bug, reproduced and fixed ------------------------------------
    // A sub-cent entry must yield a strictly positive, correctly-sided target.
    for (const price of [0.001329, 0.0029004, 0.02009, 0.11942]) {
        const dp = priceDecimals(price);
        const long = truncateToDecimals(price + price * movement, dp);
        const short = truncateToDecimals(price - price * movement, dp);
        check(`sub-dollar ${price}: long target > 0 and > entry, short target > 0 and < entry`,
            long > price && long > 0 && short < price && short > 0,
            `dp=${dp} long=${long} short=${short}`);
    }
    check('2 dp would have collapsed a sub-cent entry to 0 (the original bug)',
        truncateToDecimals(0.001329 + 0.001329 * movement, 2) === 0,
        String(truncateToDecimals(0.001329 + 0.001329 * movement, 2)));

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
