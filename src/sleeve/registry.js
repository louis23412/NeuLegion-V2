// Sleeve registry (round-81 split of sleeve_score.js): ids + resolver only.
// Pure, no I/O. Imported by scoring/sizing/report; the shim re-exports it.
import { carryDispersionSleeve } from '../plugins/sleeves/carry-dispersion.js';
import { toptraderFadeSleeve } from '../plugins/sleeves/toptrader-fade.js';
import { oiChangeSleeve } from '../plugins/sleeves/oi-change.js';

export const SLEEVE_IDS = Object.freeze(['carry-dispersion', 'toptrader-fade', 'oi-change']);

const SLEEVES = Object.freeze({
    'carry-dispersion': carryDispersionSleeve,
    'toptrader-fade': toptraderFadeSleeve,
    'oi-change': oiChangeSleeve,
});

export function resolveSleeve(sleeveId) {
    const sleeve = SLEEVES[sleeveId];
    if (!sleeve) throw new Error(`sleeve_score: unknown sleeve "${String(sleeveId)}" (known: ${SLEEVE_IDS.join(', ')})`);
    return sleeve;
}
