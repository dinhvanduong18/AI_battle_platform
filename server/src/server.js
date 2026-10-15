import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { createToken, hashPassword, verifyPassword, verifyToken } from './auth.js';
import { calculateElo } from './elo.js';
import { enqueueOrMatch, cancelQueue } from './matchmaker.js';
import { verifyReplay, verifySessionProof } from './replay.js';
import { createReplayStorage } from './storage.js';

const pool = new Pool({ connectionString: config.databaseUrl });
const redis = createClient({ url: config.redisUrl });
redis.on('error', err => console.error('Redis error:', err.message));
const redisEvents = redis.duplicate();
const instanceId = randomUUID();
const replayStorage = createReplayStorage(config);
const liveSockets = new Map();
const searchTimers = new Map();
const MAX_BODY = 2 * 1024 * 1024;

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};
const publicUser = user => ({ id: user.id, email: user.email, displayName: user.display_name, elo: user.elo });
const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) reject(Object.assign(new Error('Request body too large'), { status: 413 })); });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
  req.on('error', reject);
});
function authFromHeader(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return verifyToken(match[1], config.jwtSecret);
}
function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function userSocket(userId) {
  const current = liveSockets.get(userId);
  return current && current.readyState === WebSocket.OPEN ? current : null;
}
async function deliverToUser(userId, type, data) {
  const socket = userSocket(userId);
  if (socket) {
    if (type === 'match-found') {
      socket.searchCancelled = true;
      socket.searching = false;
      const timer = searchTimers.get(userId); if (timer) clearTimeout(timer);
      searchTimers.delete(userId);
      await cancelQueue(redis, userId).catch(() => {});
    }
    send(socket, type, data);
    return;
  }
  await redis.publish(`ottv2:user:${userId}`, JSON.stringify({ type, data }));
}
function canonicalMatchIds(match) { return [match.player1_id, match.player2_id]; }

async function createMatch(user, paired) {
  const [opponentResult] = await Promise.all([pool.query('SELECT id, email, display_name, elo FROM users WHERE id=$1', [paired.opponentId])]);
  const opponent = opponentResult.rows[0];
  if (!opponent) throw new Error('Opponent account no longer exists');
  const player1 = user.id < opponent.id ? user : opponent;
  const player2 = user.id < opponent.id ? opponent : user;
  const matchId = randomUUID();
  const seed = randomInt(1, 0x7fffffff);
  await pool.query('INSERT INTO matches(id, seed, player1_id, player2_id, status) VALUES($1,$2,$3,$4,\'active\')', [matchId, seed, player1.id, player2.id]);
  const record = { id: matchId, seed, player1_id: player1.id, player2_id: player2.id, created_at: new Date().toISOString() };
  for (const [player, role, other] of [[player1, 'player1', player2], [player2, 'player2', player1]]) {
    await deliverToUser(player.id, 'match-found', { match: record, role, opponent: publicUser(other), signaling: 'server-relay' });
  }
}

async function runSearch(userId) {
  searchTimers.delete(userId);
  const socket = userSocket(userId);
  if (!socket || socket.searchCancelled) return;
  const userResult = await pool.query('SELECT id, email, display_name, elo FROM users WHERE id=$1', [userId]);
  const user = userResult.rows[0];
  if (!user) return;
  const started = socket.searchStartedAt || Date.now();
  const gap = Math.min(config.maxEloGap, config.minEloGap + Math.floor((Date.now() - started) / config.expandEveryMs) * config.minEloGap);
  const paired = await enqueueOrMatch(redis, user, { ...config, currentGap: gap });
  if (paired) {
    socket.searchCancelled = true;
    await Promise.all([cancelQueue(redis, userId), cancelQueue(redis, paired.opponentId)]);
    await createMatch(user, paired);
    return;
  }
  searchTimers.set(userId, setTimeout(() => runSearch(userId).catch(err => {
    console.error('Matchmaking retry failed:', err);
    send(socket, 'error', { message: 'Matchmaking temporarily unavailable' });
  }), 2000));
}

async function registerSessionKey(userId, packet) {
  if (!packet.matchId || !packet.publicKey) throw new Error('Missing matchId/publicKey');
  const result = await pool.query('SELECT id, player1_id, player2_id FROM matches WHERE id=$1 AND status IN (\'active\',\'pending\')', [packet.matchId]);
  const match = result.rows[0];
  if (!match || !canonicalMatchIds(match).includes(userId)) throw new Error('Player is not part of this active match');
  const key = packet.publicKey;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') throw new Error('Only ECDSA P-256 session keys are accepted');
  const column = match.player1_id === userId ? 'player1_key' : 'player2_key';
  await pool.query(`UPDATE matches SET ${column}=$1::jsonb WHERE id=$2`, [JSON.stringify(key), packet.matchId]);
  const otherId = match.player1_id === userId ? match.player2_id : match.player1_id;
  await deliverToUser(otherId, 'peer-session-key', { matchId: packet.matchId, playerId: userId, publicKey: key });
}

async function submitResult(userId, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [body.matchId]);
    const match = result.rows[0];
    if (!match || !canonicalMatchIds(match).includes(userId)) throw Object.assign(new Error('Match not found for this player'), { status: 404 });
    if (match.status === 'completed') {
      const prior = await client.query('SELECT * FROM match_results WHERE match_id=$1', [body.matchId]);
      await client.query('COMMIT');
      const row = prior.rows[0];
      return { alreadySubmitted: true, matchId: match.id, winnerId: match.winner_id, finalStateHash: match.final_state_hash,
        elo: { player1: { before: row.player1_elo_before, after: row.player1_elo_after }, player2: { before: row.player2_elo_before, after: row.player2_elo_after } },
        replaySha256: match.replay_sha256 };
    }
    if (match.status !== 'active') throw Object.assign(new Error('Match is not active'), { status: 409 });
    const p1 = body.proofs?.player1;
    const p2 = body.proofs?.player2;
    if (!p1?.proof || !p1.signature || !p2?.proof || !p2.signature) throw Object.assign(new Error('Both signed player proofs are required'), { status: 400 });
    if (!match.player1_key || !match.player2_key) throw Object.assign(new Error('Both session public keys must be registered over the authenticated WebSocket'), { status: 409 });
    const proofShapeValid = proof => proof.matchId === match.id && proof.roomId === match.id &&
      Number.isInteger(proof.stepCount) && proof.stepCount >= 1 && /^[0-9a-f]{64}$/i.test(proof.stateHash || '') &&
      Number.isInteger(proof.winner) && [1, 2].includes(proof.winner);
    if (!proofShapeValid(p1.proof) || !proofShapeValid(p2.proof) ||
        p1.proof.winner !== p2.proof.winner || p1.proof.stepCount !== p2.proof.stepCount || p1.proof.stateHash !== p2.proof.stateHash) {
      throw Object.assign(new Error('Players submitted conflicting final proofs'), { status: 409 });
    }
    if (!verifySessionProof(match.player1_key, p1.proof, p1.signature) || !verifySessionProof(match.player2_key, p2.proof, p2.signature)) {
      throw Object.assign(new Error('A final proof signature is invalid'), { status: 400 });
    }
    const replayResult = verifyReplay(body.replay, match.seed, match.id);
    if (replayResult.finalHash !== p1.proof.stateHash || replayResult.stepCount !== p1.proof.stepCount || replayResult.winner !== p1.proof.winner) {
      throw Object.assign(new Error('Replay result does not match signed final proof'), { status: 400 });
    }
    const usersResult = await client.query('SELECT id, elo FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[match.player1_id, match.player2_id]]);
    const u1 = usersResult.rows.find(user => user.id === match.player1_id);
    const u2 = usersResult.rows.find(user => user.id === match.player2_id);
    const score1 = replayResult.winner === 1 ? 1 : 0;
    const elo1 = calculateElo(u1.elo, u2.elo, score1, config.fideK);
    const elo2 = calculateElo(u2.elo, u1.elo, 1 - score1, config.fideK);
    const storedReplay = await replayStorage.put(match.id, body.replay);
    await client.query('UPDATE users SET elo=$1 WHERE id=$2', [elo1, u1.id]);
    await client.query('UPDATE users SET elo=$1 WHERE id=$2', [elo2, u2.id]);
    await client.query('INSERT INTO match_results(match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1) VALUES($1,$2,$3,$4,$5,$6)', [match.id, u1.elo, u2.elo, elo1, elo2, score1]);
    await client.query(`UPDATE matches SET status='completed', winner_id=$1, final_state_hash=$2, replay_key=$3, replay_sha256=$4, replay_json=$5::jsonb, player1_proof=$6::jsonb, player2_proof=$7::jsonb, completed_at=now() WHERE id=$8`, [replayResult.winner === 1 ? u1.id : u2.id, replayResult.finalHash, storedReplay.key, storedReplay.checksum, storedReplay.json ? JSON.stringify(storedReplay.json) : null, JSON.stringify(p1), JSON.stringify(p2), match.id]);
    await client.query('COMMIT');
    return { matchId: match.id, winnerId: replayResult.winner === 1 ? u1.id : u2.id, finalStateHash: replayResult.finalHash, elo: { player1: { before: u1.elo, after: elo1 }, player2: { before: u2.elo, after: elo2 } }, replaySha256: storedReplay.checksum };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', config.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim().slice(0, 40);
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || !displayName) return json(res, 400, { error: 'Provide a valid email, display name and password of at least 10 characters' });
      const passwordHash = await hashPassword(password);
      const created = await pool.query('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name,elo', [email, passwordHash, displayName]);
      const user = created.rows[0];
      return json(res, 201, { token: createToken(user, config.jwtSecret), user: publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const result = await pool.query('SELECT id,email,password_hash,display_name,elo FROM users WHERE email=$1', [email]);
      const user = result.rows[0];
      if (!user || !await verifyPassword(String(body.password || ''), user.password_hash)) return json(res, 401, { error: 'Email or password is incorrect' });
      return json(res, 200, { token: createToken(user, config.jwtSecret), user: publicUser(user) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const auth = authFromHeader(req);
      const result = await pool.query('SELECT id,email,display_name,elo FROM users WHERE id=$1', [auth.sub]);
      if (!result.rows[0]) return json(res, 401, { error: 'Account not found' });
      return json(res, 200, { user: publicUser(result.rows[0]) });
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const result = await pool.query('SELECT id,display_name,elo FROM users ORDER BY elo DESC,created_at ASC LIMIT 100');
      return json(res, 200, { players: result.rows.map(user => ({ id: user.id, displayName: user.display_name, elo: user.elo })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/matches') {
      const auth = authFromHeader(req);
      const result = await pool.query(`SELECT m.id,m.seed,m.status,m.winner_id,m.final_state_hash,m.replay_sha256,m.created_at,m.completed_at, u1.display_name AS player1,u2.display_name AS player2 FROM matches m JOIN users u1 ON u1.id=m.player1_id JOIN users u2 ON u2.id=m.player2_id WHERE m.player1_id=$1 OR m.player2_id=$1 ORDER BY m.created_at DESC LIMIT 50`, [auth.sub]);
      return json(res, 200, { matches: result.rows });
    }
    if (req.method === 'GET' && /^\/api\/matches\/[0-9a-f-]+\/replay$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const matchId = url.pathname.split('/')[3];
      const result = await pool.query('SELECT replay_json,replay_key,player1_id,player2_id FROM matches WHERE id=$1 AND status=\'completed\'', [matchId]);
      const match = result.rows[0];
      if (!match || ![match.player1_id, match.player2_id].includes(auth.sub)) return json(res, 404, { error: 'Replay not found' });
      if (match.replay_json) return json(res, 200, { replay: match.replay_json });
      const downloadUrl = await replayStorage.getUrl(match.replay_key);
      if (!downloadUrl) return json(res, 404, { error: 'Replay data is unavailable' });
      return json(res, 200, { downloadUrl });
    }
    if (req.method === 'POST' && url.pathname === '/api/match/submit-result') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const result = await submitResult(auth.sub, body);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/match/claim-disconnect') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const proof = body.proof;
      if (!proof || proof.kind !== 'disconnect-claim' || !body.signature || !Number.isInteger(proof.lastAckedStep) ||
          !/^[0-9a-f]{64}$/i.test(proof.lastAckedStateHash || '')) return json(res, 400, { error: 'Malformed disconnect claim' });
      const transaction = await pool.connect();
      try {
        await transaction.query('BEGIN');
        const found = await transaction.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [proof.matchId]);
        const match = found.rows[0];
        if (!match || match.status !== 'active' || !canonicalMatchIds(match).includes(auth.sub)) throw Object.assign(new Error('Active match not found for this player'), { status: 404 });
        const claimantSeat = match.player1_id === auth.sub ? 1 : 2;
        const disconnectedId = claimantSeat === 1 ? match.player2_id : match.player1_id;
        const disconnectedSeat = claimantSeat === 1 ? 2 : 1;
        if (proof.claimantPlayer !== claimantSeat || proof.disconnectedPlayer !== disconnectedSeat || proof.winner !== claimantSeat ||
            match.disconnected_player_id !== disconnectedId || !match.disconnected_at || Date.now() - new Date(match.disconnected_at).getTime() < 10000) {
          throw Object.assign(new Error('Server has not observed the opponent disconnected for 10 seconds'), { status: 409 });
        }
        const key = claimantSeat === 1 ? match.player1_key : match.player2_key;
        if (!verifySessionProof(key, proof, body.signature)) throw Object.assign(new Error('Disconnect claim signature is invalid'), { status: 400 });
        await transaction.query("INSERT INTO disconnect_claims(match_id,claimant_id,disconnected_id,proof,signature,status) VALUES($1,$2,$3,$4::jsonb,$5,'needs-review') ON CONFLICT(match_id,claimant_id) DO NOTHING", [match.id, auth.sub, disconnectedId, JSON.stringify(proof), body.signature]);
        await transaction.query("UPDATE matches SET status='disputed' WHERE id=$1", [match.id]);
        await transaction.query('COMMIT');
        return json(res, 202, { status: 'needs-review', message: 'Signed disconnect evidence stored. The match is disputed; no Elo was awarded automatically.' });
      } catch (err) {
        await transaction.query('ROLLBACK'); throw err;
      } finally { transaction.release(); }
    }
    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('HTTP request failed:', err.message);
    return json(res, err.status || (err.code === '23505' ? 409 : 500), { error: err.status ? err.message : err.code === '23505' ? 'Email already registered' : 'Internal server error' });
  }
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', ws => {
  ws.authenticated = false;
  const authTimeout = setTimeout(() => ws.close(4401, 'Authentication timeout'), 5000);
  ws.on('message', async raw => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { message: 'Malformed JSON' }); }
    try {
      if (!ws.authenticated) {
        if (packet.type !== 'auth' || typeof packet.token !== 'string') return ws.close(4401, 'Send auth token first');
        const auth = verifyToken(packet.token, config.jwtSecret);
        const userResult = await pool.query('SELECT id,email,display_name,elo FROM users WHERE id=$1', [auth.sub]);
        if (!userResult.rows[0]) return ws.close(4401, 'Unknown account');
        clearTimeout(authTimeout);
        ws.authenticated = true;
        ws.user = userResult.rows[0];
        ws.searchStartedAt = 0;
        const previous = liveSockets.get(ws.user.id);
        liveSockets.set(ws.user.id, ws);
        if (previous && previous !== ws) previous.close(4001, 'Replaced by a newer session');
        await cancelQueue(redis, ws.user.id).catch(() => {});
        await redis.set(`ottv2:presence:${ws.user.id}`, instanceId, { EX: 60 });
        await pool.query("UPDATE matches SET disconnected_player_id=NULL, disconnected_at=NULL WHERE status='active' AND disconnected_player_id=$1", [ws.user.id]);
        send(ws, 'authenticated', { user: publicUser(ws.user) });
        return;
      }
      const userId = ws.user.id;
      if (packet.type === 'find-match') {
        if (ws.searching) return;
        ws.searching = true;
        ws.searchCancelled = false;
        ws.searchStartedAt = Date.now();
        send(ws, 'searching', { elo: ws.user.elo });
        await runSearch(userId);
      } else if (packet.type === 'cancel-match') {
        ws.searching = false;
        ws.searchCancelled = true;
        const timer = searchTimers.get(userId); if (timer) clearTimeout(timer);
        searchTimers.delete(userId);
        await cancelQueue(redis, userId);
        send(ws, 'search-cancelled');
      } else if (packet.type === 'session-key') {
        await registerSessionKey(userId, packet);
        send(ws, 'session-key-accepted', { matchId: packet.matchId });
      } else if (packet.type === 'rtc-disconnected' || packet.type === 'rtc-connected') {
        const found = await pool.query('SELECT id,player1_id,player2_id,status FROM matches WHERE id=$1', [packet.matchId]);
        const match = found.rows[0];
        if (!match || match.status !== 'active' || !canonicalMatchIds(match).includes(userId)) throw new Error('Not authorized for this match');
        if (packet.type === 'rtc-disconnected') {
          const peerId = match.player1_id === userId ? match.player2_id : match.player1_id;
          await pool.query("UPDATE matches SET disconnected_at=CASE WHEN disconnected_player_id=$1 THEN disconnected_at ELSE now() END, disconnected_player_id=$1 WHERE id=$2 AND status='active'", [peerId, match.id]);
        } else {
          await pool.query('UPDATE matches SET disconnected_player_id=NULL,disconnected_at=NULL WHERE id=$1 AND status=\'active\'', [match.id]);
        }
      } else if (packet.type === 'signal') {
        if (!packet.matchId || !packet.payload) throw new Error('Missing signaling payload');
        const result = await pool.query('SELECT player1_id,player2_id,status FROM matches WHERE id=$1', [packet.matchId]);
        const match = result.rows[0];
        if (!match || match.status !== 'active' || !canonicalMatchIds(match).includes(userId)) throw new Error('Not authorized to signal this match');
        const peerId = match.player1_id === userId ? match.player2_id : match.player1_id;
        const online = await redis.get(`ottv2:presence:${peerId}`);
        if (!online) return send(ws, 'peer-offline', { matchId: packet.matchId });
        await deliverToUser(peerId, 'signal', { matchId: packet.matchId, from: userId, payload: packet.payload });
      } else if (packet.type === 'ping') send(ws, 'pong', { at: Date.now() });
      else send(ws, 'error', { message: 'Unknown message type' });
    } catch (err) { send(ws, 'error', { message: err.message }); }
  });
  ws.on('close', async () => {
    clearTimeout(authTimeout);
    if (!ws.user) return;
    const isCurrentSession = liveSockets.get(ws.user.id) === ws;
    if (!isCurrentSession) return;
    liveSockets.delete(ws.user.id);
    ws.searchCancelled = true;
    const timer = searchTimers.get(ws.user.id); if (timer) clearTimeout(timer);
    searchTimers.delete(ws.user.id);
    await cancelQueue(redis, ws.user.id).catch(() => {});
    const presence = await redis.get(`ottv2:presence:${ws.user.id}`).catch(() => null);
    if (presence === instanceId) await redis.del(`ottv2:presence:${ws.user.id}`).catch(() => {});
    const active = await pool.query("SELECT id, player1_id, player2_id FROM matches WHERE status='active' AND (player1_id=$1 OR player2_id=$1)", [ws.user.id]).catch(() => ({ rows: [] }));
    for (const match of active.rows) {
      const peerId = match.player1_id === ws.user.id ? match.player2_id : match.player1_id;
      await pool.query("UPDATE matches SET disconnected_player_id=$1, disconnected_at=now() WHERE id=$2 AND status='active'", [ws.user.id, match.id]).catch(() => {});
      await deliverToUser(peerId, 'peer-disconnected', { matchId: match.id, disconnectedPlayerId: ws.user.id }).catch(() => {});
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  for (const [userId, socket] of liveSockets) {
    if (socket.readyState === WebSocket.OPEN) redis.set(`ottv2:presence:${userId}`, instanceId, { EX: 60 }).catch(() => {});
  }
}, 30000);
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

async function main() {
  await redis.connect();
  await redisEvents.connect();
  await redisEvents.pSubscribe('ottv2:user:*', (message, channel) => {
    const userId = channel.slice('ottv2:user:'.length);
    const socket = userSocket(userId);
    if (!socket) return;
    try {
      const event = JSON.parse(message);
      if (event.type === 'match-found') {
        socket.searchCancelled = true;
        socket.searching = false;
        const timer = searchTimers.get(userId); if (timer) clearTimeout(timer);
        searchTimers.delete(userId);
        cancelQueue(redis, userId).catch(() => {});
      }
      send(socket, event.type, event.data);
    } catch (err) { console.error('Invalid Redis event:', err.message); }
  });
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  httpServer.listen(config.port, () => console.log(`OTTv2 backend listening on :${config.port}`));
}
async function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  await redis.quit().catch(() => {});
  await redisEvents.quit().catch(() => {});
  await pool.end().catch(() => {});
  httpServer.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(err => { console.error('Backend startup failed:', err); process.exit(1); });
