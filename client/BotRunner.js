/**
 * BotRunner - Web Worker lifecycle and execution manager.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BotRunner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    class BotRunner {
        constructor(timeoutMs = 50, workerScriptPath = 'client/bot-sandbox.js') {
            this.timeoutMs = timeoutMs;
            this.workerScriptPath = workerScriptPath;
            this.worker = null;
            this.ready = false;
            this.name = 'Bot';
            this.lastElapsedMs = 0;
        }
        async loadBot(botCode, name = 'Bot') {
            this.name = name;
            this.destroy();
            return new Promise((resolve, reject) => {
                let worker;
                try {
                    if (typeof Worker === 'undefined') throw new Error('Web Worker is unavailable');
                    worker = new Worker(this.workerScriptPath);
                    this.worker = worker;
                } catch (err) {
                    reject(new Error('Cannot create sandbox worker: ' + err.message));
                    return;
                }
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    worker.removeEventListener('message', onMessage);
                    worker.removeEventListener('error', onError);
                    worker.removeEventListener('messageerror', onMessageError);
                };
                const fail = (err) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    this.destroy();
                    reject(err);
                };
                const timer = setTimeout(() => fail(new Error('Timed out loading bot "' + name + '"')), 3000);
                const onMessage = (event) => {
                    const data = event.data;
                    if (!data || data.type !== 'bot-loaded' || settled) return;
                    settled = true;
                    cleanup();
                    if (data.success) {
                        this.ready = true;
                        resolve();
                    } else {
                        this.destroy();
                        reject(new Error('Bot load failed: ' + data.error));
                    }
                };
                const onError = (event) => fail(new Error('Sandbox worker error: ' + (event.message || 'unknown error')));
                const onMessageError = () => fail(new Error('Could not read sandbox worker response'));
                worker.addEventListener('message', onMessage);
                worker.addEventListener('error', onError);
                worker.addEventListener('messageerror', onMessageError);
                worker.postMessage({ type: 'load-bot', botCode: botCode });
            });
        }
        async getMove(myPlayerId, gameState) {
            if (!this.ready || !this.worker) throw new Error('Bot "' + this.name + '" is not loaded');
            const worker = this.worker;
            const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
            const start = now();
            return new Promise((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    worker.removeEventListener('message', onMessage);
                    worker.removeEventListener('error', onError);
                    worker.removeEventListener('messageerror', onMessageError);
                };
                const fail = (err, terminate = false) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    if (terminate) this.destroy();
                    reject(err);
                };
                const timer = setTimeout(() => {
                    const elapsedMs = now() - start;
                    const err = new Error('TLE: bot "' + this.name + '" exceeded ' + this.timeoutMs + ' ms');
                    err.isTimeout = true;
                    err.timeoutMs = this.timeoutMs;
                    err.elapsedMs = elapsedMs;
                    err.botName = this.name;
                    err.disqualifiedPlayer = myPlayerId;
                    fail(err, true);
                }, this.timeoutMs);
                const onMessage = (event) => {
                    const data = event.data;
                    if (!data || data.type !== 'move-result' || settled) return;
                    const elapsedMs = Math.round((now() - start) * 10) / 10;
                    if (!data.success) {
                        fail(new Error(data.error || 'Bot did not return a move'));
                        return;
                    }
                    settled = true;
                    cleanup();
                    this.lastElapsedMs = elapsedMs;
                    resolve(Object.assign({}, data.move, { elapsedMs: elapsedMs }));
                };
                const onError = (event) => fail(new Error('Sandbox worker error: ' + (event.message || 'unknown error')), true);
                const onMessageError = () => fail(new Error('Could not read sandbox worker response'), true);
                worker.addEventListener('message', onMessage);
                worker.addEventListener('error', onError);
                worker.addEventListener('messageerror', onMessageError);
                worker.postMessage({ type: 'get-move', myPlayerId: myPlayerId, gameState: gameState });
            });
        }
        destroy() {
            if (this.worker) this.worker.terminate();
            this.worker = null;
            this.ready = false;
        }
    }
    return BotRunner;
});
