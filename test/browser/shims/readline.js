// Minimal `readline` shim: createInterface({ input }) yields the lines of an
// async-iterable input stream and supports `.close()` (as used by
// mainController's candle reader).

export function createInterface({ input }) {
    let buffer = '';
    let done = false;
    const pending = [];
    const resolvers = [];

    const push = (line) => {
        if (resolvers.length) resolvers.shift()({ value: line, done: false });
        else pending.push(line);
    };
    const finish = () => {
        done = true;
        while (resolvers.length) resolvers.shift()({ value: undefined, done: true });
    };

    (async () => {
        try {
            for await (const chunk of input) {
                buffer += chunk;
                let idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    let line = buffer.slice(0, idx);
                    if (line.endsWith('\r')) line = line.slice(0, -1);
                    buffer = buffer.slice(idx + 1);
                    push(line);
                }
            }
            if (buffer.length) push(buffer);
        } catch (e) {
            if (resolvers.length) resolvers.shift()(Promise.reject(e));
        } finally {
            finish();
        }
    })();

    return {
        close() { finish(); },
        [Symbol.asyncIterator]() {
            return {
                next() {
                    if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
                    if (done) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve) => resolvers.push(resolve));
                },
            };
        },
    };
}

const api = { createInterface };
export default api;
