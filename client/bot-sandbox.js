/* ═══════════════════════════════════════════════════════════
   bot-sandbox.js — Isolated Web Worker Sandbox
   Runs inside a dedicated Worker thread.
   - Blocks dangerous global APIs (fetch, XHR, WebSocket…)
   - Compiles user-supplied bot code defining getNextMove()
   - Responds to 'load-bot' and 'get-move' messages
   ═══════════════════════════════════════════════════════════ */

// ── 1. Lock down dangerous APIs ─────────────────────────────
(function blockDangerousAPIs() {
    try {
        const BLOCKED = [
            'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
            'EventSource', 'Worker', 'SharedWorker',
            'indexedDB', 'caches',
            'requestAnimationFrame', 'cancelAnimationFrame'
        ];

        const noop = function () {
            throw new Error('🚫 API bị chặn trong môi trường sandbox');
        };

        BLOCKED.forEach(function (api) {
            try {
                self[api] = noop;
            } catch (_) { /* ignore if not configurable */ }
        });

        // Block network capabilities on navigator if available
        try {
            if (typeof navigator !== 'undefined' && navigator && navigator.sendBeacon) {
                navigator.sendBeacon = noop;
            }
        } catch (_) { /* ignore */ }
    } catch (_outer) {
        /* sandbox init fallback */
    }
})();

// ── 2. Bot state ────────────────────────────────────────────
var _botGetNextMove = null;

// ── 3. Message handler ─────────────────────────────────────
self.onmessage = function (e) {
    var msg = e.data;

    // ── load-bot: Compile user code ──
    if (msg.type === 'load-bot') {
        try {
            _botGetNextMove = null;

            // Create a limited scope and evaluate the bot code
            // The bot code must define: function getNextMove(myPlayerId, gameState) { ... }
            var compileFn = new Function(
                'var module = { exports: {} }; var exports = module.exports;\n' +
                msg.botCode + '\n' +
                'if (typeof getNextMove === "function") return getNextMove;\n' +
                'if (typeof module.exports === "function") return module.exports;\n' +
                'if (typeof module.exports.getNextMove === "function") return module.exports.getNextMove;\n' +
                'return null;'
            );

            _botGetNextMove = compileFn();

            if (typeof _botGetNextMove !== 'function') {
                self.postMessage({
                    type: 'bot-loaded',
                    success: false,
                    error: 'Bot code phải định nghĩa hàm getNextMove(myPlayerId, gameState)'
                });
                return;
            }

            self.postMessage({ type: 'bot-loaded', success: true });

        } catch (err) {
            self.postMessage({
                type: 'bot-loaded',
                success: false,
                error: err.message || 'Lỗi biên dịch không xác định'
            });
        }
        return;
    }

    // ── get-move: Execute bot for a single turn ──
    if (msg.type === 'get-move') {
        if (typeof _botGetNextMove !== 'function') {
            self.postMessage({
                type: 'move-result',
                success: false,
                error: 'Bot chưa được nạp hoặc hàm getNextMove không tồn tại'
            });
            return;
        }

        try {
            var rawMove = _botGetNextMove(msg.myPlayerId, msg.gameState);

            if (!rawMove || typeof rawMove !== 'object') {
                self.postMessage({
                    type: 'move-result',
                    success: false,
                    error: 'getNextMove() phải trả về một object { fromRow, fromCol, toRow, toCol }'
                });
                return;
            }

            // Normalize move — support both flat index (0..80) and row/col formats (0..8)
            var cols = (msg.gameState && msg.gameState.boardCols) || 9;
            var move = {};

            if (typeof rawMove.from === 'number' && typeof rawMove.to === 'number') {
                move.from = rawMove.from;
                move.to = rawMove.to;
                move.fromRow = typeof rawMove.fromRow === 'number' ? rawMove.fromRow : Math.floor(rawMove.from / cols);
                move.fromCol = typeof rawMove.fromCol === 'number' ? rawMove.fromCol : (rawMove.from % cols);
                move.toRow = typeof rawMove.toRow === 'number' ? rawMove.toRow : Math.floor(rawMove.to / cols);
                move.toCol = typeof rawMove.toCol === 'number' ? rawMove.toCol : (rawMove.to % cols);
            } else if (typeof rawMove.fromRow === 'number' && typeof rawMove.fromCol === 'number' &&
                       typeof rawMove.toRow === 'number' && typeof rawMove.toCol === 'number') {
                move.fromRow = rawMove.fromRow;
                move.fromCol = rawMove.fromCol;
                move.toRow = rawMove.toRow;
                move.toCol = rawMove.toCol;
                move.from = rawMove.fromRow * cols + rawMove.fromCol;
                move.to = rawMove.toRow * cols + rawMove.toCol;
            } else {
                self.postMessage({
                    type: 'move-result',
                    success: false,
                    error: 'Move không hợp lệ — cần { fromRow, fromCol, toRow, toCol } hoặc { from, to }'
                });
                return;
            }

            self.postMessage({
                type: 'move-result',
                success: true,
                move: move
            });

        } catch (err) {
            self.postMessage({
                type: 'move-result',
                success: false,
                error: 'Runtime Error: ' + (err.message || 'Lỗi không xác định')
            });
        }
        return;
    }
};
