/**
 * OTTGameEngine.js
 * Headless & Deterministic Game Engine for OTTv2 (Rock-Paper-Scissors Chess 9x9)
 * Pure State Machine: S_{t+1} = f(S_t, Action)
 * Supports both Browser (window.OTTGameEngine) and Node.js (CommonJS / ES Modules).
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const exports = factory();
        root.OTTGameEngine = exports.OTTGameEngine;
        root.mulberry32 = exports.mulberry32;
        root.computeFastHash = exports.computeFastHash;
        root.computeStateHashAsync = exports.computeStateHashAsync;
        root.OTT_CONSTANTS = exports.OTT_CONSTANTS;
    }
})(typeof self !== 'undefined' ? self : this, function () {

    // ── Constants & Definitions ──────────────────────────────────
    const COLS = 'abcdefghi'.split('');
    const ROWS = 9;
    const TOTAL_CELLS = 81; // 9x9

    // Piece Encoding (Int8):
    // 0: Empty
    // 1: P1 Rock (✊),     2: P1 Paper (✋),     3: P1 Scissors (✌️)
    // 4: P2 Rock (✊),     5: P2 Paper (✋),     6: P2 Scissors (✌️)
    const PIECE = {
        EMPTY: 0,
        P1_ROCK: 1,
        P1_PAPER: 2,
        P1_SCISSORS: 3,
        P2_ROCK: 4,
        P2_PAPER: 5,
        P2_SCISSORS: 6,
    };

    const PIECE_TYPE_NAMES = {
        1: 'rock', 2: 'paper', 3: 'scissors',
        4: 'rock', 5: 'paper', 6: 'scissors',
    };

    const PIECE_EMOJIS = {
        0: '',
        1: '✊', 2: '✋', 3: '✌️',
        4: '✊', 5: '✋', 6: '✌️',
    };

    const PIECE_VIET_NAMES = {
        1: 'Đấm', 2: 'Lá', 3: 'Kéo',
        4: 'Đấm', 5: 'Lá', 6: 'Kéo',
    };

    // Special win cells
    // a1: col 0, row 8 -> index 8*9 + 0 = 72
    // i9: col 8, row 0 -> index 0*9 + 8 = 8
    const SPECIAL_A1_INDEX = 72;
    const SPECIAL_I9_INDEX = 8;

    // Movement directions: 8 adjacent neighbors (dr, dc)
    const DIRECTIONS = [
        [-1, -1], [-1, 0], [-1, 1],
        [ 0, -1],          [ 0, 1],
        [ 1, -1], [ 1, 0], [ 1, 1]
    ];

    // ── Seeded PRNG: Mulberry32 ──────────────────────────────────
    function mulberry32(seed) {
        let s = (seed >>> 0) || 1;
        return function next() {
            s |= 0;
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seededShuffle(arr, rng) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // ── State Hash Functions ─────────────────────────────────────
    /**
     * Compute ultra-fast 32-bit FNV-1a hash over board, turn, stepCount, winner
     * Used for per-turn desync detection between dual clients (<0.001ms)
     */
    function computeFastHash(state) {
        let hash = 0x811c9dc5;
        const board = state.board;

        for (let i = 0; i < TOTAL_CELLS; i++) {
            hash ^= board[i];
            hash = Math.imul(hash, 0x01000193);
        }

        hash ^= (state.turn & 0xFF);
        hash = Math.imul(hash, 0x01000193);

        hash ^= (state.stepCount & 0xFFFF);
        hash = Math.imul(hash, 0x01000193);

        hash ^= ((state.winner || 0) & 0xFF);
        hash = Math.imul(hash, 0x01000193);

        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * Cryptographic SHA-256 hash for Final Signed Proof (Browser & Node.js)
     */
    async function computeStateHashAsync(state, matchId = '') {
        const fastHash = computeFastHash(state);
        const rawPayload = `${matchId}|${fastHash}|${state.turn}|${state.stepCount}|${state.winner || 0}`;

        if (typeof crypto !== 'undefined' && crypto.subtle) {
            const enc = new TextEncoder();
            const buf = await crypto.subtle.digest('SHA-256', enc.encode(rawPayload));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
            // Node.js fallback
            try {
                const nodeCrypto = require('crypto');
                return nodeCrypto.createHash('sha256').update(rawPayload).digest('hex');
            } catch (e) {
                return fastHash; // Fallback if crypto is unavailable
            }
        }
    }

    // ── OTTGameEngine Class ──────────────────────────────────────
    class OTTGameEngine {
        /**
         * Initialize a new game state deterministically from a numeric seed
         * @param {number} seed - PRNG seed
         * @param {number} pieceCountPerSide - Pieces per player (3 to 36, default 9)
         */
        static createGame(seed = 1234567, pieceCountPerSide = 9) {
            const count = Math.max(3, Math.min(36, Math.floor(pieceCountPerSide || 9)));
            const board = new Int8Array(TOTAL_CELLS);
            const rng = mulberry32(seed);

            // Lower-left triangle: row > col
            const p1Indices = [];
            for (let r = 0; r < 9; r++) {
                for (let c = 0; c < 9; c++) {
                    if (r > c) {
                        p1Indices.push(r * 9 + c);
                    }
                }
            }

            // Pool of pieces for P1 (1: Rock, 2: Paper, 3: Scissors)
            const piecePool = [];
            for (let i = 0; i < count; i++) {
                piecePool.push((i % 3) + 1);
            }

            const shuffledIndices = seededShuffle(p1Indices, rng).slice(0, count);
            const shuffledPieces = seededShuffle(piecePool, rng);

            // Place P1 and symmetric P2 pieces across diagonal (r, c) <-> (c, r)
            for (let i = 0; i < count; i++) {
                const p1Idx = shuffledIndices[i];
                const r = Math.floor(p1Idx / 9);
                const c = p1Idx % 9;
                const pType = shuffledPieces[i]; // 1, 2, or 3

                board[p1Idx] = pType;              // P1: 1 (Rock), 2 (Paper), 3 (Scissors)
                board[c * 9 + r] = pType + 3;      // P2: 4 (Rock), 5 (Paper), 6 (Scissors)
            }

            return {
                seed: seed,
                pieceCount: count,
                board: board,
                turn: 1,
                stepCount: 0,
                winner: null,
                lastMove: null, // { from, to, isAttack, piece, captured }
            };
        }

        /**
         * Alias for createGame
         */
        static createInitialState(seed = 1234567, pieceCountPerSide = 9) {
            return this.createGame(seed, pieceCountPerSide);
        }

        /**
         * Check if attacker piece can capture defender piece
         * 1/4 (Rock) beats 3/6 (Scissors)
         * 3/6 (Scissors) beats 2/5 (Paper)
         * 2/5 (Paper) beats 1/4 (Rock)
         */
        static canCapture(attackerPiece, defenderPiece) {
            if (!attackerPiece || !defenderPiece) return false;
            const aPlayer = attackerPiece <= 3 ? 1 : 2;
            const dPlayer = defenderPiece <= 3 ? 1 : 2;
            if (aPlayer === dPlayer) return false;

            const aType = attackerPiece <= 3 ? attackerPiece : attackerPiece - 3;
            const dType = defenderPiece <= 3 ? defenderPiece : defenderPiece - 3;

            if (aType === dType) return false; // Same type cannot capture
            return (aType === 1 && dType === 3) || // Rock beats Scissors
                   (aType === 3 && dType === 2) || // Scissors beats Paper
                   (aType === 2 && dType === 1);   // Paper beats Rock
        }

        /**
         * Get valid moves for a given cell index (0..80)
         * @returns {Array<{ from: number, to: number, isAttack: boolean }>}
         */
        static getValidMoves(state, fromIndex) {
            if (state.winner || fromIndex < 0 || fromIndex >= TOTAL_CELLS) return [];
            const piece = state.board[fromIndex];
            if (!piece) return [];

            const piecePlayer = piece <= 3 ? 1 : 2;
            if (piecePlayer !== state.turn) return [];

            const r = Math.floor(fromIndex / 9);
            const c = fromIndex % 9;
            const valid = [];

            for (let i = 0; i < DIRECTIONS.length; i++) {
                const nr = r + DIRECTIONS[i][0];
                const nc = c + DIRECTIONS[i][1];
                if (nr < 0 || nr >= 9 || nc < 0 || nc >= 9) continue;

                const toIndex = nr * 9 + nc;
                const target = state.board[toIndex];

                if (target === PIECE.EMPTY) {
                    valid.push({ from: fromIndex, to: toIndex, isAttack: false });
                } else {
                    const targetPlayer = target <= 3 ? 1 : 2;
                    if (targetPlayer !== piecePlayer && this.canCapture(piece, target)) {
                        valid.push({ from: fromIndex, to: toIndex, isAttack: true });
                    }
                }
            }

            return valid;
        }

        /**
         * Get all valid moves for the current active player
         */
        static getAllValidMoves(state) {
            if (state.winner) return [];
            const allMoves = [];
            for (let i = 0; i < TOTAL_CELLS; i++) {
                const piece = state.board[i];
                if (piece) {
                    const player = piece <= 3 ? 1 : 2;
                    if (player === state.turn) {
                        const moves = this.getValidMoves(state, i);
                        for (let j = 0; j < moves.length; j++) {
                            allMoves.push(moves[j]);
                        }
                    }
                }
            }
            return allMoves;
        }

        /**
         * Pure State Transition: Apply move and return next GameState
         * S_{t+1} = applyMove(S_t, Move)
         */
        static applyMove(state, move) {
            if (state.winner) throw new Error("Game is already over");
            if (!move || move.from === undefined || move.to === undefined) {
                throw new Error("Invalid move object");
            }

            if (!Number.isInteger(move.from) || !Number.isInteger(move.to) ||
                move.from < 0 || move.from >= TOTAL_CELLS ||
                move.to < 0 || move.to >= TOTAL_CELLS || move.from === move.to) {
                throw new Error("Move coordinates are out of bounds or invalid");
            }
            const piece = state.board[move.from];
            if (!piece) throw new Error(`No piece at source cell ${move.from}`);
            const piecePlayer = piece <= 3 ? 1 : 2;
            if (piecePlayer !== state.turn) {
                throw new Error(`It is Player ${state.turn}'s turn, but piece belongs to Player ${piecePlayer}`);
            }

            const legalMove = this.getValidMoves(state, move.from).some(candidate => candidate.to === move.to);
            if (!legalMove) throw new Error(`Illegal move from ${move.from} to ${move.to}`);
            const captured = state.board[move.to];
            const isAttack = captured !== PIECE.EMPTY;

            if (isAttack && !this.canCapture(piece, captured)) {
                throw new Error(`Illegal capture from ${move.from} to ${move.to}`);
            }

            // Clone board (Int8Array.slice is extremely fast)
            const nextBoard = new Int8Array(state.board);
            nextBoard[move.to] = piece;
            nextBoard[move.from] = PIECE.EMPTY;

            const nextStepCount = state.stepCount + 1;
            const lastMoveInfo = {
                from: move.from,
                to: move.to,
                isAttack: isAttack,
                piece: piece,
                captured: captured || null
            };

            const winner = this.checkWinCondition(nextBoard, lastMoveInfo, state.turn);
            const nextTurn = winner ? state.turn : (state.turn === 1 ? 2 : 1);

            return {
                seed: state.seed,
                pieceCount: state.pieceCount,
                board: nextBoard,
                turn: nextTurn,
                stepCount: nextStepCount,
                winner: winner,
                lastMove: lastMoveInfo,
            };
        }

        /**
         * Check win condition after a move is made
         * 1. Occupation of Special Win Square: a1 (72) or i9 (8)
         * 2. Total elimination of any 1 piece type of the opponent (rock, paper, or scissors)
         */
        static checkWinCondition(board, lastMove, movingPlayer) {
            // Rule 1: Special Win Square reached on this move
            if (lastMove && (lastMove.to === SPECIAL_A1_INDEX || lastMove.to === SPECIAL_I9_INDEX)) {
                return movingPlayer;
            }

            // Rule 2: Count opponent pieces
            const opponent = movingPlayer === 1 ? 2 : 1;
            let oppRock = 0;
            let oppPaper = 0;
            let oppScissors = 0;

            for (let i = 0; i < TOTAL_CELLS; i++) {
                const p = board[i];
                if (!p) continue;
                const owner = p <= 3 ? 1 : 2;
                if (owner === opponent) {
                    const type = p <= 3 ? p : p - 3;
                    if (type === 1) oppRock++;
                    else if (type === 2) oppPaper++;
                    else if (type === 3) oppScissors++;
                }
            }

            // If opponent lost all of at least one piece type -> current player wins!
            if (oppRock === 0 || oppPaper === 0 || oppScissors === 0) {
                return movingPlayer;
            }

            return null;
        }

        /**
         * Count remaining pieces for both players
         */
        static countPieces(board) {
            const counts = {
                1: { rock: 0, paper: 0, scissors: 0, total: 0 },
                2: { rock: 0, paper: 0, scissors: 0, total: 0 }
            };

            for (let i = 0; i < TOTAL_CELLS; i++) {
                const p = board[i];
                if (!p) continue;
                const owner = p <= 3 ? 1 : 2;
                const typeName = PIECE_TYPE_NAMES[p];
                counts[owner][typeName]++;
                counts[owner].total++;
            }

            return counts;
        }

        /**
         * Standardized Bot API state formatter (Phase 2)
         * Produces clean object conforming to Bot API:
         * {
         *    board, validMoves: [{ from, to, fromRow, fromCol, toRow, toCol, isCapture, pieceType }],
         *    myPieces: [{ row, col, type }],
         *    opponentPieces: [{ row, col, type }],
         *    turn, stepCount, boardRows: 9, boardCols: 9
         * }
         */
        static createBotGameState(state, forPlayer = state.turn) {
            const rawMoves = this.getAllValidMoves(state);
            const validMoves = rawMoves.map(m => {
                const piece = state.board[m.from];
                const pieceType = piece <= 3 ? piece : piece - 3;
                return {
                    from: m.from,
                    to: m.to,
                    fromRow: Math.floor(m.from / 9),
                    fromCol: m.from % 9,
                    toRow: Math.floor(m.to / 9),
                    toCol: m.to % 9,
                    isCapture: m.isAttack,
                    pieceType: pieceType
                };
            });

            const myPieces = [];
            const opponentPieces = [];
            for (let i = 0; i < TOTAL_CELLS; i++) {
                const p = state.board[i];
                if (!p) continue;
                const owner = p <= 3 ? 1 : 2;
                const type = p <= 3 ? p : p - 3;
                const info = {
                    index: i,
                    row: Math.floor(i / 9),
                    col: i % 9,
                    type: type,
                    rawPiece: p
                };
                if (owner === forPlayer) {
                    myPieces.push(info);
                } else {
                    opponentPieces.push(info);
                }
            }

            return {
                board: Array.from(state.board),
                validMoves: validMoves,
                myPieces: myPieces,
                opponentPieces: opponentPieces,
                turn: state.turn,
                stepCount: state.stepCount,
                boardRows: 9,
                boardCols: 9
            };
        }

        // Coordinate conversion helpers
        static toIndex(row, col) { return row * 9 + col; }
        static toCoords(index) { return { row: Math.floor(index / 9), col: index % 9 }; }
        static toAlgebraic(index) {
            const col = COLS[index % 9];
            const row = 9 - Math.floor(index / 9);
            return `${col}${row}`;
        }
        static fromAlgebraic(alg) {
            if (!alg || alg.length < 2) return -1;
            const c = COLS.indexOf(alg[0].toLowerCase());
            const r = 9 - parseInt(alg.slice(1), 10);
            if (c < 0 || c >= 9 || r < 0 || r >= 9) return -1;
            return r * 9 + c;
        }

        /**
         * Serialize state to JSON-safe plain object
         */
        static serialize(state) {
            return {
                seed: state.seed,
                pieceCount: state.pieceCount,
                board: Array.from(state.board),
                turn: state.turn,
                stepCount: state.stepCount,
                winner: state.winner,
                lastMove: state.lastMove,
                hash: computeFastHash(state)
            };
        }

        /**
         * Create an ergonomic, safe, and descriptive GameState view for Bots
         * Conforms to: { board, validMoves, myPieces, opponentPieces, turn }
         */
        static createBotGameState(state, myPlayerId) {
            const myId = myPlayerId || state.turn;
            const oppId = myId === 1 ? 2 : 1;

            // 1. Build 2D board
            const board2D = [];
            for (let r = 0; r < 9; r++) {
                const row = [];
                for (let c = 0; c < 9; c++) {
                    const idx = r * 9 + c;
                    const val = state.board[idx];
                    const player = val ? (val <= 3 ? 1 : 2) : null;
                    const type = val ? PIECE_TYPE_NAMES[val] : null;
                    row.push({
                        row: r,
                        col: c,
                        index: idx,
                        player: player,
                        type: type,
                        value: val,
                        isMyPiece: player === myId,
                        isOpponentPiece: player === oppId
                    });
                }
                board2D.push(row);
            }

            // 2. Extract myPieces and opponentPieces
            const myPieces = [];
            const opponentPieces = [];
            for (let i = 0; i < TOTAL_CELLS; i++) {
                const val = state.board[i];
                if (!val) continue;
                const player = val <= 3 ? 1 : 2;
                const r = Math.floor(i / 9);
                const c = i % 9;
                const item = {
                    row: r,
                    col: c,
                    index: i,
                    algebraic: this.toAlgebraic(i),
                    player: player,
                    type: PIECE_TYPE_NAMES[val],
                    raw: val
                };
                if (player === myId) myPieces.push(item);
                else opponentPieces.push(item);
            }

            // 3. Extract and enrich valid moves
            const rawMoves = this.getAllValidMoves(state);
            const validMoves = rawMoves.map(m => {
                const fromR = Math.floor(m.from / 9);
                const fromC = m.from % 9;
                const toR = Math.floor(m.to / 9);
                const toC = m.to % 9;
                const pVal = state.board[m.from];
                const tVal = state.board[m.to];
                return {
                    from: m.from,
                    to: m.to,
                    fromRow: fromR,
                    fromCol: fromC,
                    toRow: toR,
                    toCol: toC,
                    fromAlg: this.toAlgebraic(m.from),
                    toAlg: this.toAlgebraic(m.to),
                    isAttack: m.isAttack,
                    pieceType: PIECE_TYPE_NAMES[pVal],
                    targetType: tVal ? PIECE_TYPE_NAMES[tVal] : null
                };
            });

            const counts = this.countPieces(state.board);

            return {
                board: board2D,
                flatBoard: Array.from(state.board),
                validMoves: validMoves,
                myPieces: myPieces,
                opponentPieces: opponentPieces,
                turn: state.turn,
                stepCount: state.stepCount,
                myPlayerId: myId,
                opponentPlayerId: oppId,
                myPieceCounts: counts[myId],
                opponentPieceCounts: counts[oppId],
                specialCells: {
                    a1: SPECIAL_A1_INDEX,
                    i9: SPECIAL_I9_INDEX,
                    myWinIndex: myId === 1 ? SPECIAL_A1_INDEX : SPECIAL_I9_INDEX,
                    opponentWinIndex: oppId === 1 ? SPECIAL_A1_INDEX : SPECIAL_I9_INDEX
                }
            };
        }

        /**
         * Deserialize plain object back to GameState with Int8Array
         */
        static deserialize(obj) {
            return {
                seed: obj.seed,
                pieceCount: obj.pieceCount,
                board: new Int8Array(obj.board),
                turn: obj.turn,
                stepCount: obj.stepCount,
                winner: obj.winner,
                lastMove: obj.lastMove,
            };
        }
    }

    return {
        OTTGameEngine,
        mulberry32,
        computeFastHash,
        computeStateHashAsync,
        OTT_CONSTANTS: {
            COLS, ROWS, TOTAL_CELLS,
            PIECE, PIECE_TYPE_NAMES, PIECE_EMOJIS, PIECE_VIET_NAMES,
            SPECIAL_A1_INDEX, SPECIAL_I9_INDEX
        }
    };
});
