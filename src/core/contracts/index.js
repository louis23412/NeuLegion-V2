// The ten contracts, in one table. This barrel is the only file in the contract
// layer that imports other files, and it imports nothing outside `contracts/`
// (the import law's "contracts <- 0 deps" is the letter; this is its spirit:
// the contract layer depends on no other layer).

export {
    CONTRACT_VERSION,
    CAPABILITIES,
    CAPABILITY_VALUES,
    PLUGIN_STATES,
    ID_PATTERN,
    defineContract,
    validatePlugin,
    validateInstance,
    assertPlugin,
    assertInstance,
    describeContract,
} from './base.js';

export { SOURCE_CONTRACT, isSourcePlugin } from './source.js';
export { FEATURE_CONTRACT, isFeaturePlugin } from './feature.js';
export { LABEL_CONTRACT, isLabelPlugin } from './label.js';
export { LEARNER_CONTRACT, isLearnerPlugin } from './learner.js';
export { MEMORY_CONTRACT, isMemoryPlugin } from './memory.js';
export { RETRIEVE_CONTRACT, isRetrievePlugin } from './retrieve.js';
export { SLEEVE_CONTRACT, isSleevePlugin } from './sleeve.js';
export { BOOK_CONTRACT, isBookPlugin } from './book.js';
export { RISK_CONTRACT, isRiskPlugin } from './risk.js';
export { EVALUATOR_CONTRACT, isEvaluatorPlugin } from './evaluator.js';

import { SOURCE_CONTRACT } from './source.js';
import { FEATURE_CONTRACT } from './feature.js';
import { LABEL_CONTRACT } from './label.js';
import { LEARNER_CONTRACT } from './learner.js';
import { MEMORY_CONTRACT } from './memory.js';
import { RETRIEVE_CONTRACT } from './retrieve.js';
import { SLEEVE_CONTRACT } from './sleeve.js';
import { BOOK_CONTRACT } from './book.js';
import { RISK_CONTRACT } from './risk.js';
import { EVALUATOR_CONTRACT } from './evaluator.js';

// The canonical kind -> contract table. `core/registry.js` is built from this,
// so adding a contract is a one-line change here and nothing else.
export const CONTRACTS = Object.freeze({
    source: SOURCE_CONTRACT,
    feature: FEATURE_CONTRACT,
    label: LABEL_CONTRACT,
    learner: LEARNER_CONTRACT,
    memory: MEMORY_CONTRACT,
    retrieve: RETRIEVE_CONTRACT,
    sleeve: SLEEVE_CONTRACT,
    book: BOOK_CONTRACT,
    risk: RISK_CONTRACT,
    evaluator: EVALUATOR_CONTRACT,
});

export const CONTRACT_KINDS = Object.freeze(Object.keys(CONTRACTS));
