// Browser-side test harness for NeuLegion.
//
// Bundles project files with esbuild-wasm (reading them from a mounted
// filesystem exposed on globalThis.__fs) while aliasing Node built-ins to the
// shims in ./shims. The result is a Blob-URL ESM module that can be imported
// inside a Worker, letting the database-heavy core run headlessly.

export const PROJECT = 'src/NeuLegion-master/NeuLegion-master';
const SHIMS = `${PROJECT}/test/browser/shims`;

export const DEFAULT_ALIASES = {
    'better-sqlite3': `${SHIMS}/better-sqlite3.js`,
    'fs': `${SHIMS}/fs.js`,
    'node:fs': `${SHIMS}/fs.js`,
    'path': `${SHIMS}/path.js`,
    'node:path': `${SHIMS}/path.js`,
    'crypto': `${SHIMS}/crypto.js`,
    'node:crypto': `${SHIMS}/crypto.js`,
    'node:os': `${SHIMS}/os.js`,
    'os': `${SHIMS}/os.js`,
    'node:readline': `${SHIMS}/readline.js`,
    'readline': `${SHIMS}/readline.js`,
    'node:worker_threads': `${SHIMS}/worker_threads.js`,
    'node:perf_hooks': `${SHIMS}/perf_hooks.js`,
    'node:url': `${SHIMS}/url.js`,
    'url': `${SHIMS}/url.js`,
};

let esbuildPromise = null;
async function getEsbuild() {
    if (!esbuildPromise) {
        esbuildPromise = (async () => {
            const { default: esbuild } = await import('https://esm.sh/esbuild-wasm@0.21.5?bundle');
            await esbuild.initialize({ wasmURL: 'https://esm.sh/esbuild-wasm@0.21.5/esbuild.wasm' });
            return esbuild;
        })();
    }
    return esbuildPromise;
}

function pathUtils() {
    const dirname = (p) => p.slice(0, p.lastIndexOf('/'));
    const normalize = (parts) => {
        const out = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') out.pop();
            else out.push(part);
        }
        return out.join('/');
    };
    return { dirname, normalize };
}

export async function bundleProject(entry, { aliases = {}, rewrite = true } = {}) {
    const fsApi = globalThis.__fs;
    const esbuild = await getEsbuild();
    const { dirname, normalize } = pathUtils();
    const aliasMap = { ...DEFAULT_ALIASES, ...aliases };

    const plugin = {
        name: 'workspace',
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.path.startsWith('http://') || args.path.startsWith('https://')) {
                    return { path: args.path, external: true };
                }
                if (args.path.startsWith('./') || args.path.startsWith('../')) {
                    const base = args.importer ? dirname(args.importer) : '';
                    return { path: normalize(base.split('/').concat(args.path.split('/'))), namespace: 'ws' };
                }
                if (Object.prototype.hasOwnProperty.call(aliasMap, args.path)) {
                    return { path: aliasMap[args.path], namespace: 'ws' };
                }
                if (args.path.startsWith('src/')) return { path: args.path, namespace: 'ws' };
                return { path: args.path, external: true };
            });

            build.onLoad({ filter: /.*/, namespace: 'ws' }, async (args) => {
                let p = args.path;
                const exists = async (q) => {
                    try { await fsApi.readTextFile(q); return true; } catch { return false; }
                };
                if (!(await exists(p))) {
                    for (const ext of ['.js', '.mjs', '/index.js', '.json']) {
                        if (await exists(p + ext)) { p = p + ext; break; }
                    }
                }
                let text = await fsApi.readTextFile(p);
                const loader = p.endsWith('.json') ? 'json' : 'js';
                if (rewrite && p.endsWith('.js')) {
                    // Browser ESM has no import.meta.dirname.
                    text = text.replace(/import\.meta\.dirname/g, JSON.stringify(dirname(p)));
                }
                return { contents: text, loader, resolveDir: dirname(p) };
            });
        },
    };

    const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        write: false,
        sourcemap: 'inline',
        logLevel: 'silent',
        plugins: [plugin],
        platform: 'neutral',
        mainFields: ['module', 'main'],
        conditions: ['import', 'default'],
        inject: [`${SHIMS}/globals.js`],
    });
    return result.outputFiles[0].text;
}

export async function importBundled(entry, opts = {}) {
    const code = await bundleProject(entry, opts);
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const mod = await import(url);
    return { mod, code, url };
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function makeCandles(n, { start = 100, seed = 1, trend = 0, vol = 1 } = {}) {
    const rnd = mulberry32(seed);
    const candles = [];
    let price = start;
    const baseTs = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const drift = trend * price;
        const noise = (rnd() - 0.5) * 2 * vol;
        const open = price;
        price = Math.max(0.5, price + drift + noise);
        const close = price;
        const high = Math.max(open, close) + rnd() * vol;
        const low = Math.min(open, close) - rnd() * vol;
        candles.push({
            timestamp: new Date(baseTs + i * 60000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number(high.toFixed(4)),
            low: Number(low.toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: Math.round(1000 + rnd() * 5000),
        });
    }
    return candles;
}
