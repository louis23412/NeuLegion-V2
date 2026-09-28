// `Labeler` — turn events into a training target.
//
// Absorbs the controller's online trade labelling + `analysis/labels.js`
// (triple-barrier / CUSUM / fractional differentiation, Lopez de Prado 2018).
// `docs/ARCHITECTURE-v2.md` §2.1 records the measured status: the label *policy*
// did not replicate (round 27), which is why the labeler is a plugin rather than
// a constructor argument.

import { defineContract, validatePlugin } from './base.js';

export const LABEL_CONTRACT = defineContract({
    kind: 'label',
    purpose: 'label events against a view (barrier / horizon / uniqueness aware)',
    requires: ['label'],
    optional: ['fingerprint'],
});

export const isLabelPlugin = (impl) => validatePlugin(LABEL_CONTRACT, impl).ok;
