import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OTTGameEngine } = require('../../shared/OTTGameEngine.js');

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');

function webCryptoSignatureToDer(raw) {
  const bytes = Buffer.from(raw, 'hex');
  if (bytes.length !== 64) throw new Error('ECDSA P-256 signature must be 64 bytes');
  const integer = part => {
    let value = Buffer.from(part);
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const r = integer(bytes.subarray(0, 32));
  const s = integer(bytes.subarray(32));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export function verifySessionProof(jwk, proof, signature) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !proof || typeof signature !== 'string') return false;
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return verifySignature('sha256', Buffer.from(canonical(proof)), key, webCryptoSignatureToDer(signature));
}

export function verifyReplay(replay, expectedSeed, expectedMatchId) {
  if (!replay || replay.format !== 'ottv2-replay-v1' || replay.matchId !== expectedMatchId || replay.seed !== expectedSeed || !Array.isArray(replay.moves)) {
    throw new Error('Replay metadata does not match the registered match');
  }
  let state = OTTGameEngine.deserialize(replay.initialState);
  if (state.seed !== expectedSeed || state.stepCount !== 0 || state.winner) throw new Error('Replay initial state is invalid');
  const generated = OTTGameEngine.createGame(expectedSeed, state.pieceCount);
  const initialHash = sha256({ board: Array.from(state.board), turn: state.turn, stepCount: state.stepCount, winner: state.winner || null, seed: state.seed, pieceCount: state.pieceCount, lastMove: state.lastMove || null });
  const generatedHash = sha256({ board: Array.from(generated.board), turn: generated.turn, stepCount: generated.stepCount, winner: generated.winner || null, seed: generated.seed, pieceCount: generated.pieceCount, lastMove: generated.lastMove || null });
  if (initialHash !== generatedHash) throw new Error('Replay initial board does not match deterministic seed');
  for (let index = 0; index < replay.moves.length; index++) {
    const entry = replay.moves[index];
    if (!entry || entry.stepCount !== index + 1 || ![1, 2].includes(entry.player) || entry.player !== state.turn ||
        !entry.move || !Number.isInteger(entry.move.from) || !Number.isInteger(entry.move.to) || typeof entry.nonce !== 'string') {
      throw new Error(`Replay step ${index + 1} has invalid metadata`);
    }
    const expectedCommit = sha256({ matchId: expectedMatchId, stepCount: index, player: entry.player, move: entry.move, nonce: entry.nonce });
    if (expectedCommit !== entry.commit) throw new Error(`Replay step ${index + 1} commit hash is invalid`);
    state = OTTGameEngine.applyMove(state, entry.move);
    const stateHash = sha256({ board: Array.from(state.board), turn: state.turn, stepCount: state.stepCount, winner: state.winner || null, seed: state.seed, pieceCount: state.pieceCount, lastMove: state.lastMove || null });
    if (stateHash !== entry.stateHash) throw new Error(`Replay state hash mismatch at step ${index + 1}`);
  }
  if (!state.winner) throw new Error('Replay has no completed winning state');
  const finalHash = sha256({ board: Array.from(state.board), turn: state.turn, stepCount: state.stepCount, winner: state.winner || null, seed: state.seed, pieceCount: state.pieceCount, lastMove: state.lastMove || null });
  return { state, finalHash, winner: state.winner, stepCount: state.stepCount };
}
