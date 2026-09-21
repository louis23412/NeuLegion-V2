// NeuLegion legion component: legion structure, tiers and controller params
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import fs from 'fs';
import path from 'path';
import { state } from './state.js';
import { CONFIG } from './config.js';

export const getTierAndType = (cluster) => {
    const baseBlock  = CONFIG.basePairs * 2;
    const elderBlock = CONFIG.elderPairs * 2;

    let tier;
    let local;
    let blockSize;

    if (cluster < baseBlock) {
        tier = 1;
        local = cluster % baseBlock;
        blockSize = baseBlock;
    } else {
        const remaining = cluster - baseBlock;
        tier = 2 + Math.floor(remaining / elderBlock);
        local = remaining % elderBlock;
        blockSize = elderBlock;
    }

    const halfLocal = Math.floor(blockSize / 2);
    const type = local < halfLocal ? 'positive' : 'negative';

    return { tier, type };
};

export const buildFreshStructure = () => {
    const legionStructure = Array.from({ length: state.structureDims[0] }, (_, group) =>
        Array.from({ length: state.structureDims[1] }, (_, section) =>
            Array.from({ length: state.structureDims[2] }, (_, layer) =>
                Array.from({ length: state.structureDims[3] }, (_, cluster) => {
                    const { tier, type } = getTierAndType(cluster);
                    const directoryPath = path.join(CONFIG.stateFolder, 'clusters', `Group${group}`, `Section${section}`, `Layer${layer}`, `G${group}S${section}L${layer}C${cluster}`);

                    return {
                        tier,
                        type,
                        directoryPath,
                        group,
                        section,
                        layer,
                        id: cluster,
                        signalSpeed: 0,
                        memConnections : 0,
                        childConnections : 0,
                        lastSignal: {},
                        signalHistory : [],
                        probHistory : [],
                        scoreHistory : [],
                        lifetimeMinScore: 100,
                        lifetimeMaxScore: 0,
                        lifetimeMinProb: 100,
                        lifetimeMaxProb: 0
                    };
                })
            )
        )
    );

    fs.mkdirSync(CONFIG.stateFolder, { recursive: true });
    legionStructure.flat(3).forEach(controller => {
        fs.mkdirSync(controller.directoryPath, { recursive: true });
    });

    return legionStructure;
};

export const getControllerParams = (group, section, layer) => {
    const reversedGroup = state.structureDims[0] - 1 - group;
    const reversedSection = state.structureDims[1] - 1 - section;
    const reversedLayer = state.structureDims[2] - 1 - layer;

    const groupCacheFactor = 1 + CONFIG.groupCacheBoost * group;
    const sectionCacheFactor = 1 + CONFIG.sectionCacheBoost * section;
    const layerCacheFactor = 1 + CONFIG.layerCacheBoost * layer;
    const cacheFactor = groupCacheFactor * sectionCacheFactor * layerCacheFactor;

    const groupMoneyFactor = 1 + CONFIG.groupPriceBoost * group;
    const sectionMoneyFactor = 1 + CONFIG.sectionPriceBoost * section;
    const layerMoneyFactor = 1 + CONFIG.layerPriceBoost * layer;
    const moneyFactor = groupMoneyFactor * sectionMoneyFactor * layerMoneyFactor;

    const groupPopFactor = 1 + CONFIG.groupPopBoost * reversedGroup;
    const sectionPopFactor = 1 + CONFIG.sectionPopBoost * reversedSection;
    const layerPopFactor = 1 + CONFIG.layerPopBoost * reversedLayer;
    const popFactor = groupPopFactor * sectionPopFactor * layerPopFactor;

    return {
        cacheSize: Math.round(CONFIG.baseCache * cacheFactor),
        atrFactor: Number((CONFIG.baseAtr * moneyFactor).toFixed(3)),
        stopFactor: Number((CONFIG.baseStop * moneyFactor).toFixed(3)),
        minPriceMovement: Number((CONFIG.minPriceMove * moneyFactor).toFixed(3)),
        maxPriceMovement: Number((CONFIG.maxPriceMove * moneyFactor).toFixed(3)),
        pop: Math.round(CONFIG.basePop * popFactor)
    };
};
