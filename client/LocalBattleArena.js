/* ═══════════════════════════════════════════════════════════
   LocalBattleArena.js — Controller for Phase 2 Bot Sandbox
   - Manages Local Battle Arena screen
   - Orchestrates matches between Bot vs Bot / Bot vs Human
   - Integrates Web Worker BotRunner with strict 50ms TLE
   - Telemetry Console & Realtime Board Visualization
   ═══════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.LocalBattleArena = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    class LocalBattleArena {
        constructor() {
            this.engineState = null;
            this.matchSeed = null;
            this.isRunning = false;
            this.isStepping = false;
            this.loopTimer = null;
            this.selectedCell = null;
            this.validMoves = [];

            // Bot Runners
            this.p1Runner = null;
            this.p2Runner = null;

            // DOM elements
            this.dom = {};
            this.initialized = false;
        }

        init() {
            if (this.initialized) return;
            this.cacheDom();
            if (this.dom.board && typeof OTTView !== 'undefined') {
                OTTView.buildBoardDOM(this.dom.board);
            }
            this.bindEvents();
            this.loadDefaultEditorCode();
            this.initialized = true;
        }

        cacheDom() {
            const $ = (id) => document.getElementById(id);
            this.dom = {
                lobbyScreen: $('lobby-screen'),
                arenaScreen: $('bot-arena-screen'),
                btnOpenArena: $('btn-open-bot-arena'),
                btnBackLobby: $('btn-arena-back-lobby'),

                board: $('arena-board'),
                seedVal: $('arena-seed-val'),
                stepCount: $('arena-step-count'),
                turnBadge: $('arena-turn-badge'),
                timeBadge: $('arena-time-badge'),
                statusText: $('arena-status-text'),
                p1Pieces: $('arena-p1-pieces'),
                p2Pieces: $('arena-p2-pieces'),

                btnStart: $('btn-arena-start'),
                btnPause: $('btn-arena-pause'),
                btnStep: $('btn-arena-step'),
                btnReset: $('btn-arena-reset'),

                speedSelect: $('arena-speed-select'),
                timeoutSelect: $('arena-timeout-select'),
                p1Select: $('arena-p1-select'),
                p2Select: $('arena-p2-select'),

                editorWrapper: $('arena-editor-wrapper'),
                codeEditor: $('arena-code-editor'),
                sampleSelect: $('arena-sample-select'),
                btnCheckSyntax: $('btn-arena-check-syntax'),
                syntaxStatus: $('arena-syntax-status'),

                logList: $('arena-log-list'),
                btnClearLog: $('btn-arena-clear-log')
            };
        }

        bindEvents() {
            if (this.dom.btnOpenArena) {
                this.dom.btnOpenArena.addEventListener('click', () => this.open());
            }
            if (this.dom.btnBackLobby) {
                this.dom.btnBackLobby.addEventListener('click', () => this.close());
            }

            if (this.dom.btnStart) this.dom.btnStart.addEventListener('click', () => this.start());
            if (this.dom.btnPause) this.dom.btnPause.addEventListener('click', () => this.pause());
            if (this.dom.btnStep) this.dom.btnStep.addEventListener('click', () => this.step());
            if (this.dom.btnReset) this.dom.btnReset.addEventListener('click', () => this.resetMatch());

            if (this.dom.sampleSelect) {
                this.dom.sampleSelect.addEventListener('change', (e) => {
                    const key = e.target.value;
                    if (typeof SampleBots !== 'undefined' && SampleBots[key]) {
                        this.dom.codeEditor.value = SampleBots[key];
                        this.checkSyntax();
                    }
                });
            }

            if (this.dom.btnCheckSyntax) {
                this.dom.btnCheckSyntax.addEventListener('click', () => this.checkSyntax());
            }

            if (this.dom.btnClearLog) {
                this.dom.btnClearLog.addEventListener('click', () => {
                    if (this.dom.logList) this.dom.logList.innerHTML = '';
                });
            }

            // Cell click on arena board (Human move support)
            if (this.dom.board) {
                this.dom.board.addEventListener('click', (e) => {
                    const cell = e.target.closest('.cell');
                    if (!cell) return;
                    const index = parseInt(cell.dataset.index, 10);
                    if (!isNaN(index)) this.onCellClick(index);
                });
            }
        }

        loadDefaultEditorCode() {
            if (this.dom.codeEditor && typeof SampleBots !== 'undefined') {
                this.dom.codeEditor.value = SampleBots.template || '';
            }
        }

        open() {
            this.init();
            if (this.dom.lobbyScreen) this.dom.lobbyScreen.classList.remove('active');
            if (this.dom.arenaScreen) this.dom.arenaScreen.classList.add('active');
            this.resetMatch();
            this.log('Chào mừng đến Đấu Trường Bot Sandbox (Local Arena)!', 'info');
        }

        close() {
            this.pause();
            this.destroyRunners();
            if (this.dom.arenaScreen) this.dom.arenaScreen.classList.remove('active');
            if (this.dom.lobbyScreen) this.dom.lobbyScreen.classList.add('active');
        }

        destroyRunners() {
            if (this.p1Runner) {
                this.p1Runner.destroy();
                this.p1Runner = null;
            }
            if (this.p2Runner) {
                this.p2Runner.destroy();
                this.p2Runner = null;
            }
        }

        checkSyntax() {
            if (!this.dom.codeEditor || !this.dom.syntaxStatus) return false;
            const code = this.dom.codeEditor.value;
            try {
                const fn = new Function('myPlayerId', 'gameState', code + '\nreturn typeof getNextMove === "function";');
                const ok = fn();
                if (ok) {
                    this.dom.syntaxStatus.textContent = '✅ Cú pháp hợp lệ — Tìm thấy hàm getNextMove()';
                    this.dom.syntaxStatus.className = 'syntax-status success';
                    return true;
                } else {
                    this.dom.syntaxStatus.textContent = '⚠️ Cảnh báo: Mã nguồn phải định nghĩa hàm getNextMove(myPlayerId, gameState)';
                    this.dom.syntaxStatus.className = 'syntax-status warning';
                    return false;
                }
            } catch (err) {
                this.dom.syntaxStatus.textContent = `❌ Lỗi cú pháp: ${err.message}`;
                this.dom.syntaxStatus.className = 'syntax-status error';
                return false;
            }
        }

        resetMatch() {
            this.pause();
            this.destroyRunners();

            this.matchSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
            if (typeof OTTGameEngine !== 'undefined') {
                this.engineState = OTTGameEngine.createInitialState(this.matchSeed, 9);
            }

            this.selectedCell = null;
            this.validMoves = [];
            this.render();
            this.updateHUD();

            if (this.dom.statusText) {
                this.dom.statusText.textContent = 'Ván cờ mới sẵn sàng';
            }
            this.log(`Tạo ván đấu mới với Seed #${this.matchSeed}`, 'info');
        }

        getBotCodeForType(type) {
            if (type === 'custom') {
                return this.dom.codeEditor ? this.dom.codeEditor.value : '';
            }
            if (typeof SampleBots !== 'undefined' && SampleBots[type]) {
                return SampleBots[type];
            }
            return null;
        }

        async setupRunnerForPlayer(playerNum) {
            const selectEl = playerNum === 1 ? this.dom.p1Select : this.dom.p2Select;
            const botType = selectEl ? selectEl.value : 'random';

            if (botType === 'human') {
                return null; // Human controlled
            }

            const code = this.getBotCodeForType(botType);
            if (!code) {
                throw new Error(`Không tìm thấy mã nguồn cho ${botType}`);
            }

            const timeoutMs = parseInt(this.dom.timeoutSelect ? this.dom.timeoutSelect.value : 50, 10) || 50;
            const runner = new BotRunner(timeoutMs, 'client/bot-sandbox.js');
            const displayName = `Player ${playerNum} (${botType})`;

            await runner.loadBot(code, displayName);
            return runner;
        }

        async start() {
            if (this.isRunning) return;
            if (!this.engineState || this.engineState.winner) {
                this.resetMatch();
            }

            try {
                this.log('Đang nạp Sandbox Web Worker cho 2 người chơi...', 'info');
                this.dom.btnStart.disabled = true;

                // Load runners
                if (!this.p1Runner) {
                    this.p1Runner = await this.setupRunnerForPlayer(1);
                }
                if (!this.p2Runner) {
                    this.p2Runner = await this.setupRunnerForPlayer(2);
                }

                this.isRunning = true;
                if (this.dom.btnStart) this.dom.btnStart.disabled = true;
                if (this.dom.btnPause) this.dom.btnPause.disabled = false;
                if (this.dom.statusText) this.dom.statusText.textContent = 'Đang thi đấu...';

                this.log('Trận đấu bắt đầu!', 'success');
                this.runLoop();

            } catch (err) {
                this.log(`Lỗi khởi tạo Bot: ${err.message}`, 'error');
                if (this.dom.btnStart) this.dom.btnStart.disabled = false;
                this.isRunning = false;
            }
        }

        pause() {
            this.isRunning = false;
            if (this.loopTimer) {
                clearTimeout(this.loopTimer);
                this.loopTimer = null;
            }
            if (this.dom.btnStart) this.dom.btnStart.disabled = false;
            if (this.dom.btnPause) this.dom.btnPause.disabled = true;
            if (this.dom.statusText) this.dom.statusText.textContent = 'Tạm dừng';
        }

        async step() {
            if (this.isStepping) return;
            if (!this.engineState || this.engineState.winner) return;

            this.isStepping = true;
            try {
                const turn = this.engineState.turn;
                let runner = turn === 1 ? this.p1Runner : this.p2Runner;

                // If runner not created yet, create on the fly
                if (!runner) {
                    const selectEl = turn === 1 ? this.dom.p1Select : this.dom.p2Select;
                    if (selectEl && selectEl.value !== 'human') {
                        runner = await this.setupRunnerForPlayer(turn);
                        if (turn === 1) this.p1Runner = runner;
                        else this.p2Runner = runner;
                    }
                }

                if (!runner) {
                    // Turn belongs to Human player — wait for click
                    this.log(`Lượt của Player ${turn} (Người chơi). Hãy nhấp vào bàn cờ.`, 'info');
                    this.isStepping = false;
                    return false;
                }

                // Prepare bot game state
                const botGameState = OTTGameEngine.createBotGameState(this.engineState, turn);
                if (!botGameState.validMoves || botGameState.validMoves.length === 0) {
                    // No moves available -> opponent wins
                    const otherPlayer = turn === 1 ? 2 : 1;
                    this.handleGameOver(otherPlayer, `Player ${turn} không còn nước đi hợp lệ.`);
                    this.isStepping = false;
                    return false;
                }

                // Execute move in sandbox with strict TLE
                const moveResult = await runner.getMove(turn, botGameState);
                const elapsed = moveResult.elapsedMs || 0;

                // Update time badge
                if (this.dom.timeBadge) {
                    this.dom.timeBadge.textContent = `⚡ ${elapsed}ms / ${runner.timeoutMs}ms`;
                    this.dom.timeBadge.className = elapsed > runner.timeoutMs * 0.8 ? 'time-badge warning' : 'time-badge normal';
                }

                // Validate move against engine validMoves
                const matched = botGameState.validMoves.find(m =>
                    (m.from === moveResult.from && m.to === moveResult.to) ||
                    (m.fromRow === moveResult.fromRow && m.fromCol === moveResult.fromCol &&
                     m.toRow === moveResult.toRow && m.toCol === moveResult.toCol)
                );

                if (!matched) {
                    // Illegal move penalty -> Disqualification
                    const otherPlayer = turn === 1 ? 2 : 1;
                    this.handleGameOver(otherPlayer, `Bot Player ${turn} đi nước cờ KHÔNG HỢP LỆ (${moveResult.from} ➔ ${moveResult.to}) — Xử thua ngay!`);
                    this.isStepping = false;
                    return false;
                }

                // Apply move in game engine
                const moveAction = { from: matched.from, to: matched.to };
                this.engineState = OTTGameEngine.applyMove(this.engineState, moveAction);

                // Log move
                const pieceName = ['?', 'Búa (✊)', 'Kéo (✌️)', 'Bao (✋)'][matched.pieceType] || 'Quân';
                const capText = matched.isCapture ? ' 💥 ĂN QUÂN' : '';
                this.log(`P${turn} [${elapsed}ms]: ${pieceName} (${matched.fromRow},${matched.fromCol}) ➔ (${matched.toRow},${matched.toCol})${capText}`, 'move');

                this.render();
                this.updateHUD();

                if (this.engineState.winner) {
                    this.handleGameOver(this.engineState.winner, `Player ${this.engineState.winner} đã giành chiến thắng!`);
                    this.isStepping = false;
                    return false;
                }

                this.isStepping = false;
                return true;

            } catch (err) {
                // TLE or Runtime Error
                const turn = this.engineState ? this.engineState.turn : 1;
                const otherPlayer = turn === 1 ? 2 : 1;
                this.handleGameOver(otherPlayer, err.message);
                this.isStepping = false;
                return false;
            }
        }

        runLoop() {
            if (!this.isRunning) return;

            const speed = parseInt(this.dom.speedSelect ? this.dom.speedSelect.value : 200, 10);

            this.step().then((canContinue) => {
                if (canContinue && this.isRunning) {
                    this.loopTimer = setTimeout(() => this.runLoop(), speed);
                } else if (!canContinue) {
                    this.pause();
                }
            });
        }

        handleGameOver(winnerId, reason) {
            this.pause();
            if (this.dom.statusText) {
                this.dom.statusText.textContent = `🏆 Player ${winnerId} Thắng!`;
            }
            this.log(`🏁 KẾT THÚC: Player ${winnerId} Thắng! Lý do: ${reason}`, 'winner');
            this.updateHUD();
        }

        onCellClick(index) {
            if (!this.engineState || this.engineState.winner) return;

            const turn = this.engineState.turn;
            const selectEl = turn === 1 ? this.dom.p1Select : this.dom.p2Select;
            if (!selectEl || selectEl.value !== 'human') return; // Not a human turn

            const piece = this.engineState.board[index];
            const piecePlayer = piece ? (piece <= 3 ? 1 : 2) : null;

            if (this.selectedCell !== null) {
                const move = this.validMoves.find(m => m.to === index);
                if (move) {
                    this.engineState = OTTGameEngine.applyMove(this.engineState, move);
                    this.selectedCell = null;
                    this.validMoves = [];
                    this.render();
                    this.updateHUD();

                    if (this.engineState.winner) {
                        this.handleGameOver(this.engineState.winner, `Player ${this.engineState.winner} đã giành chiến thắng!`);
                    } else if (this.isRunning) {
                        this.runLoop();
                    }
                    return;
                }
            }

            if (piecePlayer === turn) {
                this.selectedCell = index;
                this.validMoves = OTTGameEngine.getValidMoves(this.engineState, index);
                this.render();
            } else {
                this.selectedCell = null;
                this.validMoves = [];
                this.render();
            }
        }

        render() {
            if (!this.dom.board || !this.engineState) return;

            if (typeof OTTView !== 'undefined' && OTTView.renderBoard) {
                OTTView.renderBoard(this.dom.board, this.engineState, this.selectedCell, this.validMoves, false);
            }
        }

        updateHUD() {
            if (!this.engineState) return;

            if (this.dom.seedVal) this.dom.seedVal.textContent = this.matchSeed || '—';
            if (this.dom.stepCount) this.dom.stepCount.textContent = this.engineState.stepCount || 0;

            if (this.dom.turnBadge) {
                const t = this.engineState.turn;
                this.dom.turnBadge.textContent = t === 1 ? '🔵 Lượt Player 1' : '🔴 Lượt Player 2';
                this.dom.turnBadge.className = `turn-badge ${t === 1 ? 'p1' : 'p2'}`;
            }

            // Piece counts
            if (typeof OTTGameEngine !== 'undefined') {
                const counts = OTTGameEngine.countPieces(this.engineState.board);
                if (this.dom.p1Pieces) {
                    this.dom.p1Pieces.innerHTML = `
                        <span class="pc rock">✊×${counts[1].rock}</span>
                        <span class="pc scissors">✌️×${counts[1].scissors}</span>
                        <span class="pc paper">✋×${counts[1].paper}</span>
                    `;
                }
                if (this.dom.p2Pieces) {
                    this.dom.p2Pieces.innerHTML = `
                        <span class="pc rock">✊×${counts[2].rock}</span>
                        <span class="pc scissors">✌️×${counts[2].scissors}</span>
                        <span class="pc paper">✋×${counts[2].paper}</span>
                    `;
                }
            }
        }

        log(msg, type = 'info') {
            if (!this.dom.logList) return;

            const li = document.createElement('li');
            li.className = `arena-log-item ${type}`;

            const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
            li.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-msg">${msg}</span>`;

            this.dom.logList.appendChild(li);
            this.dom.logList.scrollTop = this.dom.logList.scrollHeight;
        }
    }

    // Auto-instantiate singleton on browser window
    const arenaInstance = new LocalBattleArena();
    if (typeof window !== 'undefined') {
        window.localBattleArena = arenaInstance;
        // Bind after DOM loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => arenaInstance.init());
        } else {
            arenaInstance.init();
        }
    }

    return LocalBattleArena;
});
