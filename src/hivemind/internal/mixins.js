// Prototype-installation helper used to assemble the HiveMind class from its
// component modules.
//
// HiveMind is a large, tightly-coupled simulation object: its ~100 methods all
// read and write the same underscore-prefixed instance state. Splitting it into
// separate *classes* would mean rewriting every field access; instead each
// component module exports a plain bag of methods, and this helper copies them
// onto HiveMind.prototype. The methods themselves are byte-identical to the
// originals (object-literal method syntax is the same as class-method syntax),
// so the numerics are untouched.
//
// `Object.getOwnPropertyDescriptors` + `defineProperty` is used deliberately:
// the descriptors carry the function value and flags without ever *invoking*
// anything on the source bag, and re-defining with `enumerable: false` keeps
// the prototype shape the same as a normal class body (class methods are
// non-enumerable), so `for...in`/`Object.keys` over a prototype never change.

export function installMethods (target, methods, options = {}) {
    if (typeof target !== 'function' || !target.prototype) {
        throw new TypeError('installMethods(target, methods): target must be a class/constructor');
    }
    if (!methods || typeof methods !== 'object') {
        throw new TypeError('installMethods(target, methods): methods must be an object bag');
    }

    const descriptors = Object.getOwnPropertyDescriptors(methods);
    const installed = [];

    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (typeof descriptor.value !== 'function') {
            // Accessors would change the instance protocol; bail loudly rather
            // than silently install a getter that shadows state.
            throw new TypeError(`installMethods: "${key}" is not a plain method`);
        }
        if (Object.prototype.hasOwnProperty.call(target.prototype, key)) {
            throw new Error(`installMethods: "${key}" is already defined on ${target.name}.prototype`);
        }
        Object.defineProperty(target.prototype, key, { ...descriptor, enumerable: false });
        installed.push(key);
    }

    if (options.assertCount !== undefined && installed.length !== options.assertCount) {
        throw new Error(`installMethods: expected ${options.assertCount} methods, installed ${installed.length}`);
    }

    return installed;
}

export default installMethods;
