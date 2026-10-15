/* ═══════════════════════════════════════════════════════════
   OTTv2 — Game Controller & P2P Networking
   Refactored for Stage 1: Powered by OTTGameEngine & OTTView
   Deterministic PRNG · Seeded State · State Hashing
   ═══════════════════════════════════════════════════════════ */

// ── Focus Match State ─────────────────────────────────────
let engineState = null;     // GameState managed by OTTGameEngine
let myPlayer = null;        // 1, 2, or null (spectator)
let isSpectator = false;    // true if spectating
let selectedIndex = null;   // 0..80
let validMoves = [];        // [{ from, to, isAttack }]
let matchSeed = null;       // 32-bit PRNG seed

// Networking
let peer = null;
let hostConns = [];         // If host: array of all client connections (P2 + Spectators)
let hostPlayer2Conn = null;
let conn = null;            // If client
let roomId = null;
let isHost = false;
let configuredPieceCount = 9;
let backendMatchClient = null;
let backendMode = false;
let backendAccount = null;

// ── 3 Side Mini-Board Slots ────────────────────────────────
let sideSlots = [
    { slot: 0, roomId: null, peer: null, conn: null, state: null, connected: false, status: 'Chưa kết nối' },
    { slot: 1, roomId: null, peer: null, conn: null, state: null, connected: false, status: 'Chưa kết nối' },
    { slot: 2, roomId: null, peer: null, conn: null, state: null, connected: false, status: 'Chưa kết nối' },
];

let myPlayerMatchState = null; // Backup state when player switches focus to inspect mini-board

// ── DOM References ─────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const lobbyScreen = $('lobby-screen');
const gameScreen = $('game-screen');
const btnCreate = $('btn-create');
const btnJoin = $('btn-join');
const btnSpectate = $('btn-spectate');
const btnOpenDashboard = $('btn-open-dashboard');
const inputRoom = $('input-room');
const inputSpectateRoom = $('input-spectate-room');
const inputPieceCount = $('input-piece-count');
const totalPiecesLabel = $('total-pieces-label');
const lobbyStatus = $('lobby-status');
const lobbyStatusTx = $('lobby-status-text');
const roomInfo = $('room-info');
const roomCodeDisp = $('room-code-value');
const btnCopy = $('btn-copy');
const backendUrlInput = $('backend-url');
const backendStatusEl = $('backend-account-status');
const backendEmailInput = $('backend-email');
const backendPasswordInput = $('backend-password');
const backendDisplayNameInput = $('backend-display-name');
const btnBackendLogin = $('btn-backend-login');
const btnBackendRegister = $('btn-backend-register');
const btnFindMatch = $('btn-find-match');
const btnCancelMatch = $('btn-cancel-match');

const boardEl = $('board');
const gameRoomId = $('game-room-id');
const btnReturnMyMatch = $('btn-return-my-match');
const btnReturnLobbyNotice = $('btn-return-lobby-notice');
const btnLeaveHud = $('btn-leave-hud');

const gameLog = $('game-log');
const btnPlayAgain = $('btn-play-again');
const btnBackLobby = $('btn-back-lobby');

const tabFocus = $('tab-focus');
const tabSide = $('tab-side');
const focusArea = $('focus-area');
const sidePanel = $('side-panel');
const sideActiveCount = $('side-active-count');

// ═══════════════════════════════════════════════════════════
//  GAME ENGINE & VIEW GLUE
// ═══════════════════════════════════════════════════════════

function renderBoard() {
    if (!engineState) return;

    OTTView.renderBoard(boardEl, engineState, selectedIndex, validMoves, isSpectator);

    const counts = OTTGameEngine.countPieces(engineState.board);
    const fastHash = computeFastHash(engineState);

    OTTView.updateHUD({
        state: engineState,
        myPlayer: myPlayer,
        isSpectator: isSpectator,
        roomId: roomId,
        counts: counts,
        fastHash: fastHash,
        hasMyMatchReturn: !!myPlayerMatchState,
        myMatchRoomId: myPlayerMatchState ? myPlayerMatchState.roomId : null
    });
}

function onCellClick(index) {
    if (isSpectator || !engineState || engineState.winner) return;
    if (engineState.turn !== myPlayer) return;
    if (consensus && consensus.frozen) return;

    const piece = engineState.board[index];
    const piecePlayer = piece ? (piece <= 3 ? 1 : 2) : null;

    if (selectedIndex !== null) {
        const move = validMoves.find(m => m.to === index);
        if (move) {
            if (!consensus || !consensus.ready || consensus.frozen || consensus.pending) {
                addLog('Consensus is syncing or frozen; move was not sent.', 'system');
                return;
            }
            void proposeConsensusMove(move);
            return;
        }

        if (piece && piecePlayer === myPlayer) {
            selectPiece(index);
            return;
        }

        deselectPiece();
        return;
    }

    if (piece && piecePlayer === myPlayer) {
        selectPiece(index);
    }
}

function selectPiece(index) {
    selectedIndex = index;
    validMoves = OTTGameEngine.getValidMoves(engineState, index);
    renderBoard();
}

function deselectPiece() {
    selectedIndex = null;
    validMoves = [];
    renderBoard();
}

function executeMove(move) {
    try {
        const prevPiece = engineState.board[move.from];
        const capturedPiece = engineState.board[move.to];

        engineState = OTTGameEngine.applyMove(engineState, move);
        selectedIndex = null;
        validMoves = [];

        const fromStr = OTTGameEngine.toAlgebraic(move.from);
        const toStr = OTTGameEngine.toAlgebraic(move.to);
        const pEmoji = OTT_CONSTANTS.PIECE_EMOJIS[prevPiece];
        const hash = computeFastHash(engineState);

        if (capturedPiece) {
            const cEmoji = OTT_CONSTANTS.PIECE_EMOJIS[capturedPiece];
            addLog(`${pEmoji} ${fromStr} ⚔️ ${cEmoji} ${toStr} [hash: ${hash.slice(0, 4)}]`, 'capture');
            OTTView.triggerCaptureAnimation(boardEl, move.to);
        } else {
            addLog(`${pEmoji} ${fromStr} → ${toStr} [hash: ${hash.slice(0, 4)}]`, 'move');
        }

        renderBoard();

        if (engineState.winner) {
            endGame(engineState.winner);
        }

        // Broadcast updated state to all peers (P2 + spectators)
        broadcastState({
            type: 'move',
            serializedState: OTTGameEngine.serialize(engineState),
            move: move,
            hash: hash
        });

    } catch (err) {
        console.error('Execute move error:', err);
        addLog(`⚠️ Lỗi nước đi: ${err.message}`, 'system');
    }
}

function endGame(winner) {
    OTTView.showVictoryOverlay(winner, myPlayer, isSpectator);
    addLog(`🏁 Player ${winner} thắng trận!`, 'system');
    if (!isSpectator) void signFinalProof(winner);
}

function addLog(text, type = 'move') {
    const li = document.createElement('li');
    li.className = type;
    li.textContent = text;
    gameLog.prepend(li);
    while (gameLog.children.length > 50) gameLog.lastChild.remove();
}

// ═══════════════════════════════════════════════════════════
//  PEERJS NETWORKING & STATE SYNCHRONIZATION
// ═══════════════════════════════════════════════════════════

// Dual-client P2P consensus state and cryptographic protocol.
let consensus = null;

function newConsensusState() {
    return {
        matchId: null, identity: null, publicKey: null, remotePublicKey: null,
        ready: false, frozen: false, pending: null, replay: [],
        initialState: null, initialStateHash: null, lastAckedStep: 0,
        lastAckedStateHash: null, finalProofSent: false, replayExported: false,
        disconnectTimer: null, backend: false, helloSent: false, remoteHello: false,
        remoteReady: false, ownFinalPacket: null, remoteFinalPacket: null, resultSubmitted: false
    };
}

function requireConsensusCrypto() {
    if (typeof OTTConsensusCrypto === 'undefined') throw new Error('Consensus crypto module is not loaded');
    return OTTConsensusCrypto;
}

async function beginHostConsensusSession() {
    if (consensus && consensus.disconnectTimer) clearTimeout(consensus.disconnectTimer);
    consensus = newConsensusState();
    const cryptoApi = requireConsensusCrypto();
    consensus.identity = await cryptoApi.generateIdentity();
    consensus.publicKey = consensus.identity.publicJwk;
    consensus.matchId = roomId + '-' + matchSeed + '-' + Date.now();
    consensus.initialState = OTTGameEngine.serialize(engineState);
    consensus.initialStateHash = await cryptoApi.hashState(engineState);
    consensus.lastAckedStateHash = consensus.initialStateHash;
}

async function beginBackendConsensusSession() {
    consensus = newConsensusState();
    consensus.backend = true;
    consensus.matchId = roomId;
    consensus.identity = await requireConsensusCrypto().generateIdentity();
    consensus.publicKey = consensus.identity.publicJwk;
    consensus.initialState = OTTGameEngine.serialize(engineState);
    consensus.initialStateHash = await requireConsensusCrypto().hashState(engineState);
    consensus.lastAckedStateHash = consensus.initialStateHash;
    backendMatchClient.send({ type: 'session-key', matchId: roomId, publicKey: consensus.publicKey });
    const hello = { type: 'HELLO', matchId: roomId, publicKey: consensus.publicKey, initialStateHash: consensus.initialStateHash };
    consensus.helloSent = true;
    sendConsensusPacket(hello);
}

function setupBackendMatch(packet) {
    backendMode = true;
    roomId = packet.match.id;
    matchSeed = packet.match.seed;
    isHost = packet.role === 'player1';
    myPlayer = isHost ? 1 : 2;
    isSpectator = false;
    engineState = OTTGameEngine.createGame(matchSeed, 9);
    selectedIndex = null;
    validMoves = [];
    if (backendStatusEl) backendStatusEl.textContent = `Đã ghép trận với ${packet.opponent.displayName} · Elo ${packet.opponent.elo}. Đang kết nối P2P…`;
    if (btnFindMatch) btnFindMatch.disabled = true;
    if (btnCancelMatch) btnCancelMatch.disabled = true;
}

function attachBackendDataConnection(connection) {
    conn = connection;
    if (isHost) {
        hostPlayer2Conn = connection;
        hostConns = [connection];
    }
    connection.on('data', data => {
        if (data && ['HELLO', 'READY', 'COMMIT', 'REVEAL_REQUEST', 'REVEAL', 'STEP_ACK', 'FINAL_PROOF', 'MATCH_RESET'].includes(data.type)) {
            void handleConsensusMessage(connection, data);
        }
    });
    connection.on('close', () => startDisconnectCountdown(myPlayer === 1 ? 2 : 1));
    connection.on('error', err => addLog('P2P DataChannel error: ' + (err.message || err), 'system'));
    void beginBackendConsensusSession().then(() => {
        startGame();
        if (backendStatusEl) backendStatusEl.textContent = `Đang đấu xếp hạng · Elo ${backendAccount?.elo ?? ''} · Match ${roomId}`;
        addLog('P2P WebRTC connected; server will verify the signed replay at match end.', 'system');
    }).catch(err => freezeConsensus('Could not initialize ranked match: ' + err.message));
}

function getBackendMatchClient() {
    const url = backendUrlInput?.value.trim() || 'http://localhost:8787';
    if (!backendMatchClient || backendMatchClient.baseUrl !== url) {
        backendMatchClient = new BackendMatchClient(url);
        if (backendMatchClient.restoreSession()) {
            backendAccount = backendMatchClient.user;
            updateBackendAccountStatus();
        }
        backendMatchClient
            .on('authenticated', packet => { backendAccount = packet.user; updateBackendAccountStatus(); })
            .on('searching', () => {
                if (backendStatusEl) backendStatusEl.textContent = 'Đang tìm đối thủ theo Elo…';
                if (btnFindMatch) btnFindMatch.disabled = true;
                if (btnCancelMatch) btnCancelMatch.disabled = false;
            })
            .on('match-found', setupBackendMatch)
            .on('datachannel-open', attachBackendDataConnection)
            .on('peer-disconnected', () => {
                addLog('WebRTC bị ngắt; chờ 10 giây trước khi gửi claim.', 'system');
                startDisconnectCountdown(myPlayer === 1 ? 2 : 1);
            })
            .on('peer-reconnected', () => {
                if (consensus?.disconnectTimer) clearTimeout(consensus.disconnectTimer);
                if (consensus) {
                    consensus.disconnectTimer = null;
                    consensus.frozen = false;
                    consensus.ready = Boolean(consensus.remoteHello && consensus.remoteReady);
                }
                addLog('WebRTC đã kết nối lại.', 'system');
            })
            .on('error', packet => {
                if (backendStatusEl) backendStatusEl.textContent = packet.message;
                if (btnFindMatch) btnFindMatch.disabled = false;
                if (btnCancelMatch) btnCancelMatch.disabled = true;
            });
    }
    return backendMatchClient;
}

function updateBackendAccountStatus() {
    if (backendStatusEl && backendAccount) backendStatusEl.textContent = `Đăng nhập: ${backendAccount.displayName} · Elo ${backendAccount.elo}`;
}

async function loginBackend(register) {
    try {
        const client = getBackendMatchClient();
        const email = backendEmailInput.value.trim();
        const password = backendPasswordInput.value;
        const result = register
            ? await client.register(email, password, backendDisplayNameInput.value.trim())
            : await client.login(email, password);
        backendAccount = result.user;
        updateBackendAccountStatus();
    } catch (err) {
        if (backendStatusEl) backendStatusEl.textContent = err.message;
    }
}

async function beginClientConsensusSession(protocol) {
    if (!protocol || !protocol.matchId || !protocol.publicKey) throw new Error('Host did not provide consensus session data');
    if (consensus && consensus.disconnectTimer) clearTimeout(consensus.disconnectTimer);
    consensus = newConsensusState();
    const cryptoApi = requireConsensusCrypto();
    consensus.identity = await cryptoApi.generateIdentity();
    consensus.publicKey = consensus.identity.publicJwk;
    consensus.remotePublicKey = await cryptoApi.importPublicKey(protocol.publicKey);
    consensus.matchId = protocol.matchId;
    consensus.initialState = OTTGameEngine.serialize(engineState);
    consensus.initialStateHash = await cryptoApi.hashState(engineState);
    consensus.lastAckedStateHash = consensus.initialStateHash;
    conn.send({
        type: 'HELLO',
        matchId: consensus.matchId,
        publicKey: consensus.publicKey,
        initialStateHash: consensus.initialStateHash
    });
}

function buildConsensusInit() {
    return {
        matchId: consensus.matchId,
        publicKey: consensus.publicKey,
        initialStateHash: consensus.initialStateHash
    };
}

function sendConsensusPacket(packet) {
    if (!consensus || consensus.frozen) throw new Error('Consensus session is frozen');
    if (isHost) {
        if (!hostPlayer2Conn || !hostPlayer2Conn.open) throw new Error('Player 2 is not connected');
        hostPlayer2Conn.send(packet);
    } else {
        if (!conn || !conn.open) throw new Error('Host connection is closed');
        conn.send(packet);
    }
}

function freezeConsensus(reason, details = {}) {
    if (!consensus || consensus.frozen) return;
    consensus.frozen = true;
    consensus.ready = false;
    addLog('CONSENSUS FROZEN: ' + reason, 'system');
    exportReplayLog(reason, details);
}

function exportReplayLog(reason, details = {}) {
    if (!consensus || consensus.replayExported || typeof Blob === 'undefined' || typeof URL === 'undefined') return;
    consensus.replayExported = true;
    const replay = {
        format: 'ottv2-replay-v1',
        matchId: consensus.matchId,
        seed: matchSeed,
        reason: reason,
        initialState: consensus.initialState,
        moves: consensus.replay,
        pendingStep: consensus.pending ? Object.assign({}, consensus.pending) : null,
        lastAcknowledgedStep: consensus.lastAckedStep,
        lastAcknowledgedStateHash: consensus.lastAckedStateHash,
        localState: engineState ? OTTGameEngine.serialize(engineState) : null,
        details: details
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ottv2-replay-' + (consensus.matchId || 'unknown') + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLog('Replay JSON downloaded for reconciliation.', 'system');
}

function sendToSpectators(packet) {
    if (!isHost) return;
    hostConns.forEach(c => {
        if (c && c.open && c !== hostPlayer2Conn) c.send(packet);
    });
}

async function proposeConsensusMove(move) {
    try {
        if (!consensus || !consensus.ready || consensus.frozen || consensus.pending) {
            addLog('Move blocked: consensus handshake is not ready or another step is pending.', 'system');
            return;
        }
        const legal = OTTGameEngine.getAllValidMoves(engineState).some(m => m.from === move.from && m.to === move.to);
        if (!legal) throw new Error('Selected move is no longer legal');
        const nonce = requireConsensusCrypto().createNonce();
        const stepCount = engineState.stepCount;
        const turn = engineState.turn;
        const reveal = { from: move.from, to: move.to };
        const commit = await requireConsensusCrypto().hashMove({
            matchId: consensus.matchId, stepCount: stepCount, player: turn, move: reveal, nonce: nonce
        });
        consensus.pending = {
            role: 'mover', stepCount: stepCount, player: turn,
            move: reveal, nonce: nonce, commit: commit,
            localStateHash: null, remoteAck: null
        };
        selectedIndex = null;
        validMoves = [];
        renderBoard();
        sendConsensusPacket({ type: 'COMMIT', matchId: consensus.matchId, stepCount: stepCount, player: turn, hash: commit });
        addLog('COMMIT sent for step ' + (stepCount + 1) + '.', 'system');
    } catch (err) {
        freezeConsensus('Could not commit move: ' + err.message);
    }
}

async function applyConsensusReveal(move, nonce) {
    const pending = consensus && consensus.pending;
    if (!pending || consensus.frozen) return;
    try {
        const legal = OTTGameEngine.getAllValidMoves(engineState).some(m => m.from === move.from && m.to === move.to);
        if (!legal) throw new Error('Revealed move is illegal');
        const before = engineState;
        const movedPiece = before.board[move.from];
        const capturedPiece = before.board[move.to];
        engineState = OTTGameEngine.applyMove(before, move);
        pending.move = { from: move.from, to: move.to };
        pending.nonce = nonce;
        pending.localApplied = true;
        selectedIndex = null;
        validMoves = [];
        renderBoard();
        const fromText = OTTGameEngine.toAlgebraic(move.from);
        const toText = OTTGameEngine.toAlgebraic(move.to);
        addLog((capturedPiece ? 'Capture ' : 'Move ') + 'P' + pending.player + ' ' + fromText + ' -> ' + toText, capturedPiece ? 'capture' : 'move');
        if (capturedPiece) OTTView.triggerCaptureAnimation(boardEl, move.to);
        if (movedPiece === 0) throw new Error('Source piece disappeared during consensus step');

        pending.localStateHash = await requireConsensusCrypto().hashState(engineState);
        if (consensus.pending !== pending || consensus.frozen) return;
        sendConsensusPacket({
            type: 'STEP_ACK', matchId: consensus.matchId,
            stepCount: engineState.stepCount, stateHash: pending.localStateHash
        });
        await maybeCompleteConsensusStep();
    } catch (err) {
        freezeConsensus('Could not apply revealed move: ' + err.message, { move: move });
    }
}

async function maybeCompleteConsensusStep() {
    const pending = consensus && consensus.pending;
    if (!pending || !pending.localStateHash || !pending.remoteAck || consensus.frozen) return;
    if (pending.localStateHash !== pending.remoteAck) {
        freezeConsensus('State hash mismatch at step ' + (pending.stepCount + 1), {
            localHash: pending.localStateHash, remoteHash: pending.remoteAck, stepCount: pending.stepCount + 1
        });
        return;
    }

    const entry = {
        stepCount: pending.stepCount + 1, player: pending.player,
        move: pending.move, nonce: pending.nonce, commit: pending.commit,
        stateHash: pending.localStateHash
    };
    consensus.replay.push(entry);
    consensus.lastAckedStep = entry.stepCount;
    consensus.lastAckedStateHash = entry.stateHash;
    consensus.pending = null;

    if (isHost) {
        sendToSpectators({
            type: 'move', serializedState: OTTGameEngine.serialize(engineState),
            move: Object.assign({}, entry.move, { isAttack: !!engineState.lastMove.isAttack }),
            hash: computeFastHash(engineState)
        });
    }
    addLog('STEP_ACK verified for step ' + entry.stepCount + '.', 'system');
    if (engineState.winner) endGame(engineState.winner);
}

async function handleConsensusMessage(source, packet) {
    if (!packet || !packet.type || !consensus ||
        (consensus.frozen && packet.type !== 'MATCH_RESET')) return;
    if (isHost && source !== hostPlayer2Conn) return;
    if (!isHost && source !== conn) return;

    try {
        const cryptoApi = requireConsensusCrypto();
        switch (packet.type) {
            case 'HELLO': {
                if ((!isHost && !consensus.backend) || packet.matchId !== consensus.matchId) return;
                consensus.remotePublicKey = await cryptoApi.importPublicKey(packet.publicKey);
                if (packet.initialStateHash !== consensus.initialStateHash) {
                    freezeConsensus('Initial state hash mismatch', {
                        localHash: consensus.initialStateHash, remoteHash: packet.initialStateHash
                    });
                    return;
                }
                consensus.remoteHello = true;
                sendConsensusPacket({
                    type: 'READY', matchId: consensus.matchId,
                    initialStateHash: consensus.initialStateHash
                });
                if (consensus.backend && consensus.remoteReady) consensus.ready = true;
                else if (!consensus.backend) consensus.ready = true;
                addLog(consensus.ready ? 'Consensus handshake ready.' : 'Consensus hello verified.', 'system');
                break;
            }
            case 'READY': {
                if ((isHost && !consensus.backend) || packet.matchId !== consensus.matchId) return;
                if (packet.initialStateHash !== consensus.initialStateHash) {
                    freezeConsensus('Initial state hash mismatch', {
                        localHash: consensus.initialStateHash, remoteHash: packet.initialStateHash
                    });
                    return;
                }
                consensus.remoteReady = true;
                if (consensus.backend) consensus.ready = consensus.remoteHello && consensus.helloSent;
                else consensus.ready = true;
                addLog('Consensus handshake ready with host.', 'system');
                break;
            }
            case 'COMMIT': {
                if (!consensus.ready || packet.matchId !== consensus.matchId ||
                    packet.stepCount !== engineState.stepCount ||
                    packet.player !== engineState.turn || packet.player === myPlayer || consensus.pending) {
                    freezeConsensus('Unexpected or out-of-order COMMIT', { packet: packet });
                    return;
                }
                consensus.pending = {
                    role: 'receiver', stepCount: packet.stepCount, player: packet.player,
                    move: null, nonce: null, commit: packet.hash,
                    localStateHash: null, remoteAck: null
                };
                sendConsensusPacket({ type: 'REVEAL_REQUEST', matchId: consensus.matchId, stepCount: packet.stepCount });
                break;
            }
            case 'REVEAL_REQUEST': {
                const pending = consensus.pending;
                if (!pending || pending.role !== 'mover' || packet.matchId !== consensus.matchId ||
                    packet.stepCount !== pending.stepCount) {
                    freezeConsensus('Unexpected REVEAL_REQUEST', { packet: packet });
                    return;
                }
                sendConsensusPacket({
                    type: 'REVEAL', matchId: consensus.matchId, stepCount: pending.stepCount,
                    player: pending.player, move: pending.move, nonce: pending.nonce
                });
                await applyConsensusReveal(pending.move, pending.nonce);
                break;
            }
            case 'REVEAL': {
                const pending = consensus.pending;
                if (!pending || pending.role !== 'receiver' || packet.matchId !== consensus.matchId ||
                    packet.stepCount !== pending.stepCount || packet.player !== pending.player ||
                    !packet.move || !packet.nonce) {
                    freezeConsensus('Unexpected or malformed REVEAL', { packet: packet });
                    return;
                }
                const expected = await cryptoApi.hashMove({
                    matchId: consensus.matchId, stepCount: pending.stepCount,
                    player: pending.player, move: packet.move, nonce: packet.nonce
                });
                if (expected !== pending.commit) {
                    freezeConsensus('REVEAL does not match COMMIT', { stepCount: pending.stepCount + 1 });
                    return;
                }
                await applyConsensusReveal(packet.move, packet.nonce);
                break;
            }
            case 'STEP_ACK': {
                const pending = consensus.pending;
                if (!pending || packet.matchId !== consensus.matchId ||
                    packet.stepCount !== pending.stepCount + 1 || !/^[0-9a-f]{64}$/i.test(packet.stateHash || '')) {
                    freezeConsensus('Unexpected or malformed STEP_ACK', { packet: packet });
                    return;
                }
                pending.remoteAck = packet.stateHash;
                await maybeCompleteConsensusStep();
                break;
            }
            case 'FINAL_PROOF': {
                if (packet.matchId !== consensus.matchId || !packet.proof || !packet.publicKey || !packet.signature) return;
                const valid = consensus.remotePublicKey &&
                    packet.proof.matchId === consensus.matchId &&
                    packet.publicKey && packet.proof.winner === engineState.winner &&
                    packet.proof.stepCount === engineState.stepCount &&
                    await cryptoApi.verify(consensus.remotePublicKey, packet.proof, packet.signature);
                if (!valid || packet.proof.stateHash !== await cryptoApi.hashState(engineState)) {
                    freezeConsensus('Invalid peer final signature', { packet: packet });
                    return;
                }
                addLog('Peer final proof signature verified.', 'system');
                consensus.remoteFinalPacket = packet;
                void submitBackendResultWhenReady();
                break;
            }
            case 'MATCH_RESET': {
                if (isHost || packet.matchId == null) return;
                engineState = OTTGameEngine.deserialize(packet.serializedState);
                matchSeed = packet.seed;
                selectedIndex = null;
                validMoves = [];
                OTTView.hideVictoryOverlay();
                await beginClientConsensusSession(packet.protocol);
                gameLog.innerHTML = '';
                startGame();
                break;
            }
        }
    } catch (err) {
        freezeConsensus('Protocol error: ' + err.message, { packet: packet });
    }
}

async function signFinalProof(winner) {
    if (!consensus || !consensus.ready || consensus.finalProofSent) return;
    try {
        const stateHash = await requireConsensusCrypto().hashState(engineState);
        const proof = {
            matchId: consensus.matchId, roomId: roomId,
            winner: winner, stepCount: engineState.stepCount, stateHash: stateHash
        };
        const signature = await requireConsensusCrypto().sign(consensus.identity, proof);
        consensus.finalProofSent = true;
        const finalPacket = {
            type: 'FINAL_PROOF', matchId: consensus.matchId,
            proof: proof, publicKey: consensus.publicKey, signature: signature
        };
        consensus.ownFinalPacket = finalPacket;
        sendConsensusPacket(finalPacket);
        addLog('Signed final proof sent to peer.', 'system');
        void submitBackendResultWhenReady();
    } catch (err) {
        addLog('Could not sign final proof: ' + err.message, 'system');
    }
}

async function submitBackendResultWhenReady() {
    if (!backendMode || !backendMatchClient || !consensus || consensus.resultSubmitted ||
        !consensus.ownFinalPacket || !consensus.remoteFinalPacket) return;
    const player1Packet = myPlayer === 1 ? consensus.ownFinalPacket : consensus.remoteFinalPacket;
    const player2Packet = myPlayer === 2 ? consensus.ownFinalPacket : consensus.remoteFinalPacket;
    const replay = {
        format: 'ottv2-replay-v1', matchId: consensus.matchId, seed: matchSeed,
        reason: 'completed', initialState: consensus.initialState,
        moves: consensus.replay, pendingStep: null,
        lastAcknowledgedStep: consensus.lastAckedStep,
        lastAcknowledgedStateHash: consensus.lastAckedStateHash
    };
    try {
        const result = await backendMatchClient.submitResult({
            matchId: consensus.matchId,
            proofs: {
                player1: { proof: player1Packet.proof, signature: player1Packet.signature },
                player2: { proof: player2Packet.proof, signature: player2Packet.signature }
            }, replay: replay
        });
        consensus.resultSubmitted = true;
        if (backendAccount) {
            backendAccount.elo = myPlayer === 1 ? result.elo.player1.after : result.elo.player2.after;
            localStorage.setItem('ottv2-backend-user', JSON.stringify(backendAccount));
            updateBackendAccountStatus();
        }
        addLog(`Server accepted result. Elo P1 ${result.elo.player1.after}, P2 ${result.elo.player2.after}.`, 'system');
    } catch (err) {
        addLog('Could not submit verified result: ' + err.message, 'system');
    }
}

function startDisconnectCountdown(disconnectedPlayer) {
    if (!consensus || !consensus.identity || !consensus.ready || consensus.disconnectTimer || (engineState && engineState.winner)) return;
    consensus.frozen = true;
    consensus.ready = false;
    addLog('Peer disconnected. Match frozen; claim window is 10 seconds.', 'system');
    consensus.disconnectTimer = setTimeout(() => {
        submitDisconnectClaim(disconnectedPlayer).catch(err => {
            addLog('Disconnect claim failed: ' + err.message, 'system');
            exportReplayLog('disconnect claim failed');
        });
    }, 10000);
}

async function submitDisconnectClaim(disconnectedPlayer) {
    if (!consensus || !consensus.identity || !consensus.lastAckedStateHash) return;
    const proof = {
        kind: 'disconnect-claim', matchId: consensus.matchId, roomId: roomId,
        claimantPlayer: myPlayer, disconnectedPlayer: disconnectedPlayer,
        winner: myPlayer, lastAckedStep: consensus.lastAckedStep,
        lastAckedStateHash: consensus.lastAckedStateHash, issuedAt: new Date().toISOString()
    };
    const signature = await requireConsensusCrypto().sign(consensus.identity, proof);
    const envelope = { proof: proof, publicKey: consensus.publicKey, signature: signature, replay: consensus.replay };
    if (backendMode && backendMatchClient) {
        try {
            const result = await backendMatchClient.submitDisconnectClaim(envelope);
            addLog('Signed disconnect claim stored: ' + result.status + '.', 'system');
        } catch (err) {
            addLog('Server did not accept disconnect claim: ' + err.message, 'system');
            exportReplayLog('disconnect claim rejected');
        }
        return;
    }
    let submitted = false;
    const endpoint = (typeof window !== 'undefined' && window.OTT_MATCH_CLAIM_ENDPOINT) ||
        '/api/match/claim-disconnect';
    try {
        const response = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope)
        });
        submitted = response.ok;
        if (submitted) addLog('Signed disconnect claim accepted by server.', 'system');
    } catch (_) {}
    if (!submitted) {
        downloadJson(envelope, 'ottv2-disconnect-claim-' + consensus.matchId + '.json');
        addLog('No claim API is available; signed proof downloaded locally.', 'system');
    }
}

function downloadJson(value, filename) {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined') return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function showLobbyStatus(text) {
    lobbyStatus.classList.remove('hidden');
    lobbyStatusTx.textContent = text;
}

function hideLobbyStatus() {
    lobbyStatus.classList.add('hidden');
}

async function createRoom() {
    if (inputPieceCount) {
        configuredPieceCount = Math.max(3, Math.min(36, parseInt(inputPieceCount.value) || 9));
    }
    roomId = generateRoomId();
    isHost = true;
    myPlayer = 1;
    isSpectator = false;
    matchSeed = Math.floor(Math.random() * 2147483647);
    engineState = OTTGameEngine.createGame(matchSeed, configuredPieceCount);
    showLobbyStatus('Preparing signed consensus session...');
    btnCreate.disabled = true;
    btnJoin.disabled = true;
    try {
        await beginHostConsensusSession();
    } catch (err) {
        showLobbyStatus('Consensus crypto unavailable: ' + err.message);
        btnCreate.disabled = false;
        btnJoin.disabled = false;
        return;
    }

    showLobbyStatus('Đang tạo phòng…');
    btnCreate.disabled = true;
    btnJoin.disabled = true;

    hostConns = [];
    hostPlayer2Conn = null;

    peer = new Peer('ottv2-' + roomId, { debug: 0 });

    peer.on('open', () => {
        showLobbyStatus('Phòng đã tạo! Đang chờ đối thủ & khán giả…');
        roomInfo.classList.remove('hidden');
        roomCodeDisp.textContent = roomId;

        selectedIndex = null;
        validMoves = [];
        myPlayerMatchState = { roomId: roomId, myPlayer: 1, isHost: true };

        startGame();
    });

    peer.on('connection', (connection) => {
        let assignedRole = 'spectator';
        if (!hostPlayer2Conn) {
            assignedRole = 'p2';
            hostPlayer2Conn = connection;
        }
        hostConns.push(connection);

        const sendInit = () => {
            try {
                connection.send({
                    type: 'init',
                    serializedState: OTTGameEngine.serialize(engineState),
                    role: assignedRole,
                    roomId: roomId,
                    seed: matchSeed,
                    protocol: buildConsensusInit(),
                });
                addLog(`📢 ${assignedRole === 'p2' ? 'Player 2' : 'Khán giả'} đã vào phòng`, 'system');
            } catch (err) {
                console.error('Error sending init to peer:', err);
            }
        };

        if (connection.open) {
            sendInit();
        } else {
            connection.on('open', sendInit);
        }

        connection.on('data', (data) => {
            if (assignedRole === 'p2' && connection === hostPlayer2Conn) {
                void handleConsensusMessage(connection, data);
            }
        });

        connection.on('close', () => {
            hostConns = hostConns.filter(c => c !== connection);
            if (connection === hostPlayer2Conn) {
                hostPlayer2Conn = null;
                startDisconnectCountdown(2);
            }
            addLog('⚠️ Một kết nối đã rời phòng', 'system');
        });
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        showLobbyStatus(`Lỗi: ${err.message}`);
        btnCreate.disabled = false;
        btnJoin.disabled = false;
    });
}

function joinRoom() {
    const code = inputRoom.value.trim().toUpperCase();
    if (!code) { inputRoom.focus(); return; }

    roomId = code;
    isHost = false;

    showLobbyStatus('Đang kết nối vào phòng…');
    btnCreate.disabled = true;
    btnJoin.disabled = true;

    peer = new Peer(undefined, { debug: 0 });

    peer.on('open', () => {
        conn = peer.connect('ottv2-' + roomId, { reliable: true });

        const onConnect = () => {
            showLobbyStatus('Đã kết nối! Đang đồng bộ trạng thái…');
        };

        if (conn.open) {
            onConnect();
        } else {
            conn.on('open', onConnect);
        }

        conn.on('data', (data) => {
            if (data.type === 'init') {
                engineState = OTTGameEngine.deserialize(data.serializedState);
                matchSeed = data.seed;
                if (data.role === 'spectator') {
                    isSpectator = true;
                    myPlayer = null;
                    addLog('👁️ Bạn tham gia với vai trò Khán giả (Phòng đã đủ 2 người chơi)', 'system');
                } else {
                    isSpectator = false;
                    myPlayer = 2;
                }
                selectedIndex = null;
                validMoves = [];
                startGame();
                if (!isSpectator) {
                    beginClientConsensusSession(data.protocol).catch(err => {
                        freezeConsensus('Handshake failed: ' + err.message);
                    });
                }
            } else if (data && ['HELLO', 'READY', 'COMMIT', 'REVEAL_REQUEST', 'REVEAL', 'STEP_ACK', 'FINAL_PROOF', 'MATCH_RESET'].includes(data.type)) {
                void handleConsensusMessage(conn, data);
            } else {
                handleMessage(data);
            }
        });

        conn.on('close', () => {
            if (myPlayer === 2 && !isSpectator) startDisconnectCountdown(1);
        });

        conn.on('error', (err) => {
            showLobbyStatus(`Lỗi kết nối: ${err.message || err}`);
            btnCreate.disabled = false;
            btnJoin.disabled = false;
        });
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        showLobbyStatus(`Lỗi: ${err.message}`);
        btnCreate.disabled = false;
        btnJoin.disabled = false;
    });
}

function joinSpectator(code) {
    const targetRoom = code || (inputSpectateRoom ? inputSpectateRoom.value.trim().toUpperCase() : '');
    if (!targetRoom) { if (inputSpectateRoom) inputSpectateRoom.focus(); return; }

    roomId = targetRoom;
    isHost = false;
    isSpectator = true;
    myPlayer = null;

    showLobbyStatus('Đang kết nối xem trận đấu…');
    btnCreate.disabled = true;
    btnJoin.disabled = true;

    peer = new Peer(undefined, { debug: 0 });

    peer.on('open', () => {
        conn = peer.connect('ottv2-' + roomId, { reliable: true });

        const onOpen = () => {
            showLobbyStatus('Đã kết nối Chế độ Khán giả!');
        };

        if (conn.open) {
            onOpen();
        } else {
            conn.on('open', onOpen);
        }

        conn.on('data', (data) => {
            if (data.type === 'init') {
                engineState = OTTGameEngine.deserialize(data.serializedState);
                matchSeed = data.seed;
                isSpectator = true;
                myPlayer = null;
                startGame();
            } else {
                handleMessage(data);
            }
        });

        conn.on('error', (err) => {
            showLobbyStatus(`Lỗi xem trận: ${err.message || err}`);
            btnCreate.disabled = false;
            btnJoin.disabled = false;
        });
    });
}

function broadcastState(data) {
    if (isHost && hostConns.length > 0) {
        hostConns.forEach(c => {
            if (c && c.open) c.send(data);
        });
    } else if (!isHost && conn && conn.open) {
        conn.send(data);
    }
}

function sendState(data) {
    broadcastState(data);
}

function handleMessage(data) {
    switch (data.type) {
        case 'move':
            engineState = OTTGameEngine.deserialize(data.serializedState);
            selectedIndex = null;
            validMoves = [];

            // State hash verification (Anti-Desync check)
            const localHash = computeFastHash(engineState);
            if (data.hash && data.hash !== localHash) {
                addLog(`⚠️ Cảnh báo Desync: Hash không khớp! (Local: ${localHash}, Remote: ${data.hash})`, 'system');
            }

            if (data.move) {
                const p = engineState.board[data.move.to];
                const fromStr = OTTGameEngine.toAlgebraic(data.move.from);
                const toStr = OTTGameEngine.toAlgebraic(data.move.to);
                const emoji = OTT_CONSTANTS.PIECE_EMOJIS[p] || '?';
                addLog(`👤 ${emoji} ${fromStr} → ${toStr} [hash: ${localHash.slice(0, 4)}]`, 'move');

                if (data.move.isAttack) {
                    OTTView.triggerCaptureAnimation(boardEl, data.move.to);
                }
            }

            renderBoard();

            if (engineState.winner) {
                endGame(engineState.winner);
            }
            break;

        case 'play-again':
            engineState = OTTGameEngine.deserialize(data.serializedState);
            selectedIndex = null;
            validMoves = [];
            OTTView.hideVictoryOverlay();
            gameLog.innerHTML = '';
            addLog('🔄 Ván mới bắt đầu!', 'system');
            renderBoard();
            break;
    }
}

// ═══════════════════════════════════════════════════════════
//  GAME FLOW & DASHBOARD MANAGEMENT
// ═══════════════════════════════════════════════════════════

function startGame() {
    lobbyScreen.classList.remove('active');
    gameScreen.classList.add('active');
    gameRoomId.textContent = roomId || 'DASHBOARD';

    OTTView.buildBoardDOM(boardEl, onCellClick);
    renderBoard();
    buildMiniBoardsDOM();

    addLog('🎮 Trận đấu bắt đầu!', 'system');
    if (isSpectator) {
        addLog(`👁️ Bạn đang xem ván đấu phòng: ${roomId}`, 'system');
    } else {
        addLog(`Bạn là Player ${myPlayer}`, 'system');
    }
}

function openDashboardDemo() {
    isSpectator = true;
    myPlayer = null;
    matchSeed = 1001;
    engineState = OTTGameEngine.createGame(matchSeed, 9);
    roomId = 'MULTI-DASHBOARD';

    // Set sample mini slots using deterministic PRNG
    sideSlots[0].state = OTTGameEngine.createGame(2002, 6);
    sideSlots[0].connected = true;
    sideSlots[0].roomId = 'ROOM-A';

    sideSlots[1].state = OTTGameEngine.createGame(3003, 9);
    sideSlots[1].connected = true;
    sideSlots[1].roomId = 'ROOM-B';

    sideSlots[2].state = OTTGameEngine.createGame(4004, 12);
    sideSlots[2].connected = true;
    sideSlots[2].roomId = 'ROOM-C';

    startGame();
    renderMiniBoard(0);
    renderMiniBoard(1);
    renderMiniBoard(2);

    addLog('📺 Đã bật Chế độ Multi-Match Dashboard (4 Trận)', 'system');
}

async function resetGame() {
    if (backendMode) {
        addLog('Ranked matches cannot be reset; finish or leave the match.', 'system');
        return;
    }
    if (!isHost) {
        addLog('Only the host can start a new match.', 'system');
        return;
    }

    matchSeed = Math.floor(Math.random() * 2147483647);
    engineState = OTTGameEngine.createGame(matchSeed, configuredPieceCount);
    selectedIndex = null;
    validMoves = [];
    OTTView.hideVictoryOverlay();
    gameLog.innerHTML = '';

    try {
        await beginHostConsensusSession();
        renderBoard();
        addLog('New consensus match started.', 'system');
        if (hostPlayer2Conn && hostPlayer2Conn.open) {
            hostPlayer2Conn.send({
                type: 'MATCH_RESET', matchId: consensus.matchId,
                serializedState: OTTGameEngine.serialize(engineState),
                seed: matchSeed, protocol: buildConsensusInit()
            });
        }
        sendToSpectators({
            type: 'play-again', serializedState: OTTGameEngine.serialize(engineState), seed: matchSeed
        });
    } catch (err) {
        freezeConsensus('Could not reset match: ' + err.message);
    }
}

function goBackToLobby() {
    if (consensus && consensus.disconnectTimer) clearTimeout(consensus.disconnectTimer);
    consensus = null;
    hostPlayer2Conn = null;
    if (conn) conn.close();
    if (peer) peer.destroy();
    if (hostConns.length) hostConns.forEach(c => c.close());
    hostConns = [];
    conn = null;
    peer = null;
    if (backendMatchClient) backendMatchClient.close();
    backendMatchClient = null;
    backendMode = false;
    roomId = null;
    isHost = false;
    if (consensus && consensus.disconnectTimer) clearTimeout(consensus.disconnectTimer);
    consensus = null;

    sideSlots.forEach(s => {
        if (s.conn) s.conn.close();
        if (s.peer) s.peer.destroy();
        s.connected = false;
        s.state = null;
    });

    engineState = null;
    myPlayer = null;
    isSpectator = false;
    selectedIndex = null;
    validMoves = [];
    myPlayerMatchState = null;

    gameScreen.classList.remove('active');
    lobbyScreen.classList.add('active');
    OTTView.hideVictoryOverlay();
    roomInfo.classList.add('hidden');
    hideLobbyStatus();
    if (btnCreate) btnCreate.disabled = false;
    if (btnJoin) btnJoin.disabled = false;
    if (inputRoom) inputRoom.value = '';
    if (inputSpectateRoom) inputSpectateRoom.value = '';
    gameLog.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════
//  MINI BOARDS (3 SIDE SLOTS FOR DASHBOARD)
// ═══════════════════════════════════════════════════════════

function buildMiniBoardsDOM() {
    sideSlots.forEach((slot, index) => {
        const container = $(`mini-board-${index}`);
        if (!container) return;

        OTTView.buildMiniBoardDOM(container, () => focusSideMatch(index));
    });

    document.querySelectorAll('.btn-mini-connect').forEach(btn => {
        btn.onclick = (e) => {
            const slot = +e.target.dataset.slot;
            connectMiniSlot(slot);
        };
    });

    document.querySelectorAll('.btn-mini-focus').forEach(btn => {
        btn.onclick = (e) => {
            const slot = +e.target.dataset.slot;
            focusSideMatch(slot);
        };
    });
}

function renderMiniBoard(index) {
    const slot = sideSlots[index];
    const container = $(`mini-board-${index}`);
    const statusEl = $(`mini-status-${index}`);
    if (!container) return;

    OTTView.renderMiniBoard(container, slot.state, statusEl, slot);
    updateActiveSideCount();
}

function updateActiveSideCount() {
    const activeCount = sideSlots.filter(s => s.connected).length;
    if (sideActiveCount) sideActiveCount.textContent = activeCount;
}

function connectMiniSlot(slotIndex) {
    const inputEl = $(`mini-input-${slotIndex}`);
    if (!inputEl) return;
    const code = inputEl.value.trim().toUpperCase();
    if (!code) { inputEl.focus(); return; }

    const slot = sideSlots[slotIndex];
    if (slot.conn) try { slot.conn.close(); } catch (e) { }
    if (slot.peer) try { slot.peer.destroy(); } catch (e) { }

    slot.roomId = code;
    slot.status = 'Đang kết nối…';
    slot.connected = false;
    renderMiniBoard(slotIndex);

    slot.peer = new Peer(undefined, { debug: 0 });
    slot.peer.on('open', () => {
        const connection = slot.peer.connect('ottv2-' + code, { reliable: true });
        slot.conn = connection;

        const handleData = (data) => {
            if (data && (data.type === 'init' || data.type === 'move')) {
                slot.state = OTTGameEngine.deserialize(data.serializedState);
                slot.connected = true;
                slot.status = '🟢 Live';
                renderMiniBoard(slotIndex);
            }
        };

        const handleOpen = () => {
            slot.connected = true;
            slot.status = 'Đã kết nối';
            renderMiniBoard(slotIndex);
        };

        connection.on('data', handleData);
        connection.on('close', () => {
            slot.connected = false;
            slot.status = 'Đã ngắt';
            renderMiniBoard(slotIndex);
        });
        connection.on('error', (err) => {
            slot.connected = false;
            slot.status = 'Lỗi kết nối';
            renderMiniBoard(slotIndex);
        });

        if (connection.open) {
            handleOpen();
        } else {
            connection.on('open', handleOpen);
        }
    });

    slot.peer.on('error', (err) => {
        console.error(`Mini slot ${slotIndex} peer error:`, err);
        slot.connected = false;
        slot.status = 'Không tìm thấy phòng';
        renderMiniBoard(slotIndex);
    });
}

function focusSideMatch(slotIndex) {
    const slot = sideSlots[slotIndex];
    if (!slot || !slot.state) {
        alert('Phòng đấu này chưa có dữ liệu!');
        return;
    }

    // If user was an active player in their own match, save state
    if (!isSpectator && myPlayer) {
        myPlayerMatchState = {
            roomId: roomId,
            myPlayer: myPlayer,
            isHost: isHost,
            engineState: engineState,
        };
    }

    engineState = slot.state;
    isSpectator = true;
    myPlayer = null;
    roomId = slot.roomId || 'MINI';
    gameRoomId.textContent = roomId;

    renderBoard();
    addLog(`👁️ Đã chuyển Bàn cờ chính sang xem phòng: ${roomId}`, 'system');
}

function returnToMyMatch() {
    if (!myPlayerMatchState) return;

    isSpectator = false;
    myPlayer = myPlayerMatchState.myPlayer;
    roomId = myPlayerMatchState.roomId;
    isHost = myPlayerMatchState.isHost;

    if (myPlayerMatchState.engineState) {
        engineState = myPlayerMatchState.engineState;
    }
    selectedIndex = null;
    validMoves = [];
    gameRoomId.textContent = roomId;

    renderBoard();
    addLog(`🎮 Đã quay trở lại trận đấu chính của bạn (Phòng: ${roomId})`, 'system');
}

// ═══════════════════════════════════════════════════════════
//  EVENT LISTENERS & MOBILE TABS
// ═══════════════════════════════════════════════════════════

btnCreate.addEventListener('click', createRoom);
btnJoin.addEventListener('click', joinRoom);
if (btnSpectate) btnSpectate.addEventListener('click', () => joinSpectator());
if (btnReturnMyMatch) btnReturnMyMatch.addEventListener('click', returnToMyMatch);
if (btnReturnLobbyNotice) btnReturnLobbyNotice.addEventListener('click', goBackToLobby);
if (btnOpenDashboard) btnOpenDashboard.addEventListener('click', openDashboardDemo);
if (btnBackendLogin) btnBackendLogin.addEventListener('click', () => void loginBackend(false));
if (btnBackendRegister) btnBackendRegister.addEventListener('click', () => void loginBackend(true));
if (btnFindMatch) btnFindMatch.addEventListener('click', async () => {
    try {
        const client = getBackendMatchClient();
        if (!client.token && !client.restoreSession()) throw new Error('Đăng nhập hoặc đăng ký trước khi tìm trận.');
        backendAccount = client.user;
        await client.findMatch();
    } catch (err) {
        if (backendStatusEl) backendStatusEl.textContent = err.message;
        if (btnFindMatch) btnFindMatch.disabled = false;
    }
});
if (btnCancelMatch) btnCancelMatch.addEventListener('click', async () => {
    try { await getBackendMatchClient().cancelMatch(); } catch (err) { if (backendStatusEl) backendStatusEl.textContent = err.message; }
    if (btnFindMatch) btnFindMatch.disabled = false;
    if (btnCancelMatch) btnCancelMatch.disabled = true;
});
if (backendUrlInput) backendUrlInput.addEventListener('change', () => {
    if (backendMatchClient && backendMatchClient.baseUrl !== backendUrlInput.value.trim().replace(/\/$/, '')) {
        backendMatchClient.close();
        backendMatchClient = null;
    }
});
if (getBackendMatchClient().restoreSession()) {
    backendAccount = backendMatchClient.user;
    updateBackendAccountStatus();
}

inputRoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
if (inputSpectateRoom) inputSpectateRoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinSpectator(); });

btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(roomId).then(() => {
        btnCopy.textContent = '✅';
        setTimeout(() => btnCopy.textContent = '📋', 1500);
    });
});

btnPlayAgain.addEventListener('click', resetGame);
btnBackLobby.addEventListener('click', goBackToLobby);
if (btnLeaveHud) btnLeaveHud.addEventListener('click', goBackToLobby);

if (inputPieceCount && totalPiecesLabel) {
    inputPieceCount.addEventListener('input', () => {
        let val = parseInt(inputPieceCount.value) || 3;
        if (val < 3) val = 3;
        if (val > 36) val = 36;
        totalPiecesLabel.textContent = val;
    });
}

// Mobile Tabs
if (tabFocus && tabSide) {
    tabFocus.addEventListener('click', () => {
        tabFocus.classList.add('active');
        tabSide.classList.remove('active');
        focusArea.style.display = 'flex';
        sidePanel.style.display = 'none';
    });

    tabSide.addEventListener('click', () => {
        tabSide.classList.add('active');
        tabFocus.classList.remove('active');
        focusArea.style.display = 'none';
        sidePanel.style.display = 'flex';
    });
}

// Keyboard: Escape to deselect
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') deselectPiece();
});

// ═══════════════════════════════════════════════════════════
//  PHASE 2: BOT SANDBOX ARENA WIRING
// ═══════════════════════════════════════════════════════════
const btnOpenBotArena = $('btn-open-bot-arena');
const botArenaScreen = $('bot-arena-screen');
const btnArenaBackLobby = $('btn-arena-back-lobby');
const localArenaInstance = (typeof window !== 'undefined' && window.localBattleArena) ? window.localBattleArena : null;

if (btnOpenBotArena) {
    btnOpenBotArena.addEventListener('click', () => {
        lobbyScreen.classList.remove('active');
        gameScreen.classList.remove('active');
        if (botArenaScreen) botArenaScreen.classList.add('active');

    });
}

if (btnArenaBackLobby) {
    btnArenaBackLobby.addEventListener('click', () => {
        if (localArenaInstance) {
            localArenaInstance.pause();
        }
        if (botArenaScreen) botArenaScreen.classList.remove('active');
        lobbyScreen.classList.add('active');
    });
}

