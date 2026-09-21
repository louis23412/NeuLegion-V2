// HiveMind component: protos
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const protoMethods = {
    _createNewProto (mean, variance, baseSize = 1, isCore = false) {
        const size = Math.max(1, Math.round(baseSize));
        const accessCount = Math.max(1, Math.round(size * 0.5));
        const importance = isCore 
            ? Math.round(15 + Math.log10(1 + size) * 5 * this._protoCapacityFactor) 
            : Math.round(5 + Math.log10(1 + size) * 2 * this._protoCapacityFactor);
        return {
            mean: new Float32Array(mean),
            variance: new Float32Array(variance),
            size,
            accessCount,
            projNorms: null,
            isCore,
            importance,
            protoId: `${this._hiveId}-${(this._protoIdCounter++).toString()}`,
            contentHash: this._computeContentHash(mean)
        };
    },

    _reinforceProto (proto, accessInc = this._baseAccessInc, sizeInc = 0, impInc = this._baseImpInc, multiplier = 1.0) {
        if (!proto) return;
        if (sizeInc !== 0) proto.size = Math.max(1, proto.size + sizeInc * multiplier);
        if (accessInc !== 0) {
            proto.accessCount = Math.max(1, (proto.accessCount || 1) * this._protoAccessDecay + accessInc * multiplier);
        }
        if (impInc !== 0) {
            proto.importance = Math.max(1, (proto.importance || 5) * this._protoImpDecay + impInc * multiplier);
        }
    },

    // Passing a null/undefined transformerIdx computes projNorms + contentHash
    // but skips LSH registration - use that for transient candidate protos that
    // are handed to _updateSemanticProtos (which never stores them as-is), so
    // the bucket index stays in lockstep with _semanticProtos.
    _finalizeSemanticProto (proto, transformerIdx) {
        if (!proto || !proto.mean) return;
        if (!proto.projNorms || proto.projNorms.length !== this._numProjections) {
            proto.projNorms = this._computeProjNorms(proto.mean);
        }
        if (transformerIdx !== null && transformerIdx !== undefined) {
            this._updateProtoInLSH(transformerIdx, proto);
        }
        proto.contentHash = this._computeContentHash(proto.mean);
    },

    _decayProtos (protos) {
        for (const p of protos) {
            if (p.isCore) continue;
            p.accessCount *= this._protoAccessDecay;
            p.size *= this._protoSizeDecay;
            p.importance *= this._protoImpDecay;
            p.accessCount = Math.max(1, p.accessCount);
            p.size = Math.max(1, p.size);
            p.importance = Math.max(1, p.importance);
        }
    },

    _updateSemanticStats (transformerIdx) {
        const sem = this._semanticProtos[transformerIdx];
        if (sem.length === 0) {
            this._cachedAvgVariance[transformerIdx] = 0;
            this._cachedUtilityScores[transformerIdx] = new Float32Array(0);
            return;
        }

        let totalVar = 0;
        const utilities = new Float32Array(sem.length);
        for (let i = 0; i < sem.length; i++) {
            const p = sem[i];
            let varSum = 0;
            for (let j = 0; j < this._hiddenSize; j++) varSum += p.variance[j];
            totalVar += varSum;
            utilities[i] = this._computeProtoUtility(p);
        }
        this._cachedAvgVariance[transformerIdx] = totalVar / (sem.length * this._hiddenSize);
        this._cachedUtilityScores[transformerIdx] = utilities;
    },

    _getAvgProtoVariance (transformerIdx) {
        return this._cachedAvgVariance[transformerIdx] || 0;
    },

    // Sorting by prototype utility used to be written inline as
    //   protos.sort((a, b) => this._computeProtoUtility(b) - this._computeProtoUtility(a))
    // which recomputes BOTH operands' utility on every single comparison — O(n log n)
    // transcendental-heavy calls instead of O(n). These decorate once, then sort.
    _sortByUtilityDescInPlace (protos) {
        const n = protos.length;
        const decorated = new Array(n);
        for (let i = 0; i < n; i++) {
            const p = protos[i];
            decorated[i] = { p, u: this._computeProtoUtility(p) };
        }
        decorated.sort((a, b) => b.u - a.u);
        for (let i = 0; i < n; i++) protos[i] = decorated[i].p;
        return protos;
    },

    _sortedByUtilityDesc (protos) {
        return this._sortByUtilityDescInPlace(protos.slice());
    },

    _sortByScoreDescInPlace (protos, scoreFn) {
        const n = protos.length;
        const decorated = new Array(n);
        for (let i = 0; i < n; i++) decorated[i] = { p: protos[i], s: scoreFn(protos[i]) };
        decorated.sort((a, b) => b.s - a.s);
        for (let i = 0; i < n; i++) protos[i] = decorated[i].p;
        return protos;
    },

    _computeProtoUtility (proto) {
        if (!proto || !proto.mean || proto.mean.length !== this._hiddenSize) return 0;

        let varSum = 0;
        for (let j = 0; j < this._hiddenSize; j++) varSum += proto.variance[j];
        const avgVariance = varSum / this._hiddenSize;

        const importanceFactor = 1 + 0.1 * Math.log(1 + Math.max(0, proto.importance || 0));
        const effectiveCount = Math.sqrt((proto.size || 1) * (proto.accessCount || 1));
        return effectiveCount * (1 + Math.sqrt(Math.max(avgVariance, 1e-6))) * importanceFactor;
    },

    _computeMemberAffinity(proto, transformerIdx) {
        const memberProtos = this._semanticProtos[transformerIdx];
        if (memberProtos.length === 0) return this._computeProtoUtility(proto);

        const topMember = this._sortedByUtilityDesc(memberProtos)
            .slice(0, Math.min(8, memberProtos.length));

        let matchSum = 0;
        for (const mp of topMember) {
            matchSum += this._kernelSimilarity(proto, mp);
        }
        const expertiseMatch = matchSum / topMember.length;

        const util = this._computeProtoUtility(proto);
        const spec = this._specializationScores[transformerIdx] ?? 0.5;
        const trustHist = this._trustScoresHistory[transformerIdx] || [0.5];
        const avgTrust = trustHist.reduce((a, b) => a + b, 0) / trustHist.length;

        return (
            0.45 * util +
            0.35 * expertiseMatch +
            0.20 * (spec * avgTrust)
        );
    }

};
