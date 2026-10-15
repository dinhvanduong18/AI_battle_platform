/**
 * OTTView.js
 * Pure UI & DOM Renderer for OTTv2
 * Decoupled from networking and game logic
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.OTTView = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const COLS = 'abcdefghi'.split('');
    const SPECIAL_A1 = 72; // a1 (row 8, col 0)
    const SPECIAL_I9 = 8;  // i9 (row 0, col 8)

    class OTTView {
        /**
         * Build main board grid and coordinate labels
         * @param {HTMLElement} boardEl 
         * @param {Function} onCellClick - callback(index)
         */
        static buildBoardDOM(boardEl, onCellClick) {
            boardEl.innerHTML = '';

            const colTop = document.getElementById('col-labels-top');
            const colBot = document.getElementById('col-labels-bottom');
            if (colTop) {
                colTop.innerHTML = '';
                COLS.forEach(c => {
                    const span = document.createElement('span');
                    span.textContent = c;
                    colTop.appendChild(span);
                });
            }
            if (colBot) {
                colBot.innerHTML = '';
                COLS.forEach(c => {
                    const span = document.createElement('span');
                    span.textContent = c;
                    colBot.appendChild(span);
                });
            }

            const rowL = document.getElementById('row-labels-left');
            const rowR = document.getElementById('row-labels-right');
            if (rowL) {
                rowL.innerHTML = '';
                for (let r = 0; r < 9; r++) {
                    const span = document.createElement('span');
                    span.textContent = 9 - r;
                    rowL.appendChild(span);
                }
            }
            if (rowR) {
                rowR.innerHTML = '';
                for (let r = 0; r < 9; r++) {
                    const span = document.createElement('span');
                    span.textContent = 9 - r;
                    rowR.appendChild(span);
                }
            }

            for (let i = 0; i < 81; i++) {
                const r = Math.floor(i / 9);
                const c = i % 9;
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.dataset.index = i;
                cell.dataset.row = r;
                cell.dataset.col = c;
                cell.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');

                if (i === SPECIAL_A1) cell.classList.add('special-a1');
                if (i === SPECIAL_I9) cell.classList.add('special-i9');

                cell.addEventListener('click', () => {
                    if (onCellClick) onCellClick(i);
                });
                boardEl.appendChild(cell);
            }
        }

        /**
         * Render board pieces and highlights
         */
        static renderBoard(boardEl, state, selectedIndex, validMoves = [], isSpectator = false) {
            if (!boardEl || !state || !state.board) return;

            const cells = boardEl.children;
            const validMap = new Map();
            if (!isSpectator && validMoves) {
                validMoves.forEach(m => validMap.set(m.to, m.isAttack));
            }

            for (let i = 0; i < 81; i++) {
                const cell = cells[i];
                if (!cell) continue;

                const piece = state.board[i];
                cell.classList.remove('selected', 'valid-move', 'valid-attack', 'last-from', 'last-to');

                let pieceEl = cell.querySelector('.piece');
                if (!piece) {
                    if (pieceEl) pieceEl.remove();
                } else {
                    const player = piece <= 3 ? 1 : 2;
                    const emojis = { 1: '✊', 2: '✋', 3: '✌️', 4: '✊', 5: '✋', 6: '✌️' };
                    const names = { 1: 'Đấm', 2: 'Lá', 3: 'Kéo', 4: 'Đấm', 5: 'Lá', 6: 'Kéo' };

                    if (!pieceEl) {
                        pieceEl = document.createElement('div');
                        cell.appendChild(pieceEl);
                    }
                    pieceEl.className = `piece p${player}`;
                    pieceEl.textContent = emojis[piece];
                    pieceEl.title = `${names[piece]} (P${player})`;
                }

                // Selected highlight
                if (!isSpectator && selectedIndex === i) {
                    cell.classList.add('selected');
                }

                // Valid move/attack highlights
                if (validMap.has(i)) {
                    cell.classList.add(validMap.get(i) ? 'valid-attack' : 'valid-move');
                }

                // Last move highlight
                if (state.lastMove) {
                    if (state.lastMove.from === i) cell.classList.add('last-from');
                    if (state.lastMove.to === i) cell.classList.add('last-to');
                }
            }
        }

        /**
         * Update Heads-Up Display (piece counters, turn badges, state hash)
         */
        static updateHUD(options) {
            const {
                state,
                myPlayer,
                isSpectator,
                roomId,
                counts,
                fastHash,
                hasMyMatchReturn,
                myMatchRoomId
            } = options;

            const spectatorNotice = document.getElementById('spectator-lock-notice');
            const btnReturnMyMatch = document.getElementById('btn-return-my-match');
            const myMatchRoomCode = document.getElementById('my-match-room-code');
            const roleBadgeTag = document.getElementById('role-badge-tag');
            const roleBadgeText = document.getElementById('role-badge-text');
            const spectatorBannerLbl = document.getElementById('spectator-banner-label');
            const turnIndicator = document.getElementById('turn-indicator');
            const turnText = document.getElementById('turn-text');
            const selfPieces = document.getElementById('self-pieces');
            const oppPieces = document.getElementById('opponent-pieces');
            const selfName = document.getElementById('self-name');
            const oppName = document.getElementById('opponent-name');
            const gameRoomId = document.getElementById('game-room-id');

            if (gameRoomId) gameRoomId.textContent = roomId || '—';

            if (isSpectator) {
                if (spectatorNotice) spectatorNotice.classList.remove('hidden');
                if (btnReturnMyMatch) {
                    if (hasMyMatchReturn) {
                        btnReturnMyMatch.classList.remove('hidden');
                        if (myMatchRoomCode) myMatchRoomCode.textContent = myMatchRoomId || '—';
                    } else {
                        btnReturnMyMatch.classList.add('hidden');
                    }
                }
                if (roleBadgeTag) roleBadgeTag.className = 'role-badge-tag spectator';
                if (roleBadgeText) roleBadgeText.textContent = '👁️ Khán giả (Spectator)';
                if (spectatorBannerLbl) spectatorBannerLbl.textContent = 'Đang xem ván đấu:';
                if (turnText) {
                    turnText.textContent = state.turn === 1 ? '🔴 Lượt Player 1' : '🔵 Lượt Player 2';
                }
                if (turnIndicator) turnIndicator.className = 'turn-indicator opp-turn';

                if (selfPieces) {
                    selfPieces.innerHTML = `
                        <span class="pc rock" title="Đấm">✊×${counts[1].rock}</span>
                        <span class="pc paper" title="Lá">✋×${counts[1].paper}</span>
                        <span class="pc scissors" title="Kéo">✌️×${counts[1].scissors}</span>`;
                }
                if (oppPieces) {
                    oppPieces.innerHTML = `
                        <span class="pc rock" title="Đấm">✊×${counts[2].rock}</span>
                        <span class="pc paper" title="Lá">✋×${counts[2].paper}</span>
                        <span class="pc scissors" title="Kéo">✌️×${counts[2].scissors}</span>`;
                }
                if (selfName) selfName.textContent = 'Player 1';
                if (oppName) oppName.textContent = 'Player 2';
                return;
            }

            // Active player HUD
            if (spectatorNotice) spectatorNotice.classList.add('hidden');
            if (spectatorBannerLbl) spectatorBannerLbl.textContent = 'Phòng:';
            if (roleBadgeTag) roleBadgeTag.className = 'role-badge-tag player';
            if (roleBadgeText) {
                roleBadgeText.textContent = myPlayer === 1 ? '🎮 Player 1 (Đội A)' : '🎮 Player 2 (Đội B)';
            }

            const isMyTurn = state.turn === myPlayer;
            if (turnText) {
                turnText.textContent = isMyTurn ? '🟢 Lượt của bạn' : '🔴 Lượt đối thủ';
            }
            if (turnIndicator) {
                turnIndicator.className = 'turn-indicator ' + (isMyTurn ? 'my-turn' : 'opp-turn');
            }

            const myP = myPlayer || 1;
            const opP = myP === 1 ? 2 : 1;

            if (selfPieces) {
                selfPieces.innerHTML = `
                    <span class="pc rock" title="Đấm">✊×${counts[myP].rock}</span>
                    <span class="pc paper" title="Lá">✋×${counts[myP].paper}</span>
                    <span class="pc scissors" title="Kéo">✌️×${counts[myP].scissors}</span>`;
            }
            if (oppPieces) {
                oppPieces.innerHTML = `
                    <span class="pc rock" title="Đấm">✊×${counts[opP].rock}</span>
                    <span class="pc paper" title="Lá">✋×${counts[opP].paper}</span>
                    <span class="pc scissors" title="Kéo">✌️×${counts[opP].scissors}</span>`;
            }

            if (selfName) selfName.textContent = `Player ${myP}`;
            if (oppName) oppName.textContent = `Player ${opP}`;
        }

        /**
         * Trigger visual animation when an attack/capture occurs
         */
        static triggerCaptureAnimation(boardEl, cellIndex) {
            if (!boardEl) return;
            const cell = boardEl.children[cellIndex];
            if (cell) {
                cell.classList.add('capture-anim');
                setTimeout(() => cell.classList.remove('capture-anim'), 400);
            }
        }

        /**
         * Show Victory Overlay
         */
        static showVictoryOverlay(winner, myPlayer, isSpectator) {
            const victoryOvl = document.getElementById('victory-overlay');
            const victoryIcon = document.getElementById('victory-icon');
            const victoryTitle = document.getElementById('victory-title');
            const victoryDesc = document.getElementById('victory-desc');

            if (!victoryOvl) return;

            const iWin = winner === myPlayer;
            if (victoryIcon) {
                victoryIcon.textContent = iWin ? '🏆' : (isSpectator ? '🏁' : '😢');
            }
            if (victoryTitle) {
                victoryTitle.textContent = isSpectator ? `Player ${winner} thắng!` : (iWin ? 'Chiến thắng!' : 'Thất bại!');
            }
            if (victoryDesc) {
                victoryDesc.textContent = `Trận đấu kết thúc! Player ${winner} giành chiến thắng.`;
            }

            victoryOvl.classList.remove('hidden');
        }

        static hideVictoryOverlay() {
            const victoryOvl = document.getElementById('victory-overlay');
            if (victoryOvl) victoryOvl.classList.add('hidden');
        }

        /**
         * Build Mini Board DOM (for the 3 side dashboard cards)
         */
        static buildMiniBoardDOM(container, onClick) {
            if (!container) return;
            container.innerHTML = '';
            for (let i = 0; i < 81; i++) {
                const r = Math.floor(i / 9);
                const c = i % 9;
                const cell = document.createElement('div');
                cell.className = 'mini-cell';
                cell.dataset.index = i;
                cell.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');

                if (i === SPECIAL_A1) cell.classList.add('special-a1');
                if (i === SPECIAL_I9) cell.classList.add('special-i9');

                container.appendChild(cell);
            }
            if (onClick) container.onclick = onClick;
        }

        /**
         * Render a Mini Board with state data
         */
        static renderMiniBoard(container, state, statusEl, slotInfo) {
            if (!container) return;
            const cells = container.children;
            const board = state ? state.board : null;

            const emojis = { 1: '✊', 2: '✋', 3: '✌️', 4: '✊', 5: '✋', 6: '✌️' };

            for (let i = 0; i < 81; i++) {
                const cell = cells[i];
                if (!cell) continue;

                const piece = board ? board[i] : 0;
                let pieceEl = cell.querySelector('.mini-piece');

                if (!piece) {
                    if (pieceEl) pieceEl.remove();
                } else {
                    const player = piece <= 3 ? 1 : 2;
                    if (!pieceEl) {
                        pieceEl = document.createElement('div');
                        cell.appendChild(pieceEl);
                    }
                    pieceEl.className = `mini-piece p${player}`;
                    pieceEl.textContent = emojis[piece];
                }
            }

            if (statusEl && slotInfo) {
                if (!slotInfo.connected) {
                    statusEl.textContent = slotInfo.status || 'Chưa kết nối';
                    statusEl.style.color = 'var(--text-muted)';
                } else {
                    const turnStr = (state && state.turn === 1) ? 'P1 lượt' : 'P2 lượt';
                    statusEl.textContent = `🟢 ${slotInfo.roomId || 'Phòng'} (${turnStr})`;
                    statusEl.style.color = 'var(--accent-cyan)';
                }
            }
        }
    }

    return OTTView;
});
