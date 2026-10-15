/**
 * Cryptographic helpers for the OTTv2 P2P consensus protocol.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OTTConsensusCrypto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    function getCrypto() {
        if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
        if (typeof require === 'function') return require('crypto').webcrypto;
        throw new Error('Web Crypto API is unavailable; use HTTPS or localhost');
    }
    const encoder = new TextEncoder();
    function canonicalize(value) {
        if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
        if (value && typeof value === 'object') {
            return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
        }
        return JSON.stringify(value);
    }
    function toHex(bytes) {
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }
    function fromHex(hex) {
        if (typeof hex !== 'string' || hex.length % 2) throw new Error('Invalid hex data');
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
    }
    async function digest(payload) {
        const c = getCrypto();
        return toHex(await c.subtle.digest('SHA-256', encoder.encode(canonicalize(payload))));
    }
    async function generateIdentity() {
        const c = getCrypto();
        const keys = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        return { privateKey: keys.privateKey, publicKey: keys.publicKey, publicJwk: await c.subtle.exportKey('jwk', keys.publicKey) };
    }
    async function importPublicKey(jwk) {
        return getCrypto().subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    }
    async function hashState(state) {
        return digest({
            board: Array.from(state.board),
            turn: state.turn,
            stepCount: state.stepCount,
            winner: state.winner || null,
            seed: state.seed,
            pieceCount: state.pieceCount,
            lastMove: state.lastMove || null
        });
    }
    async function hashMove(payload) { return digest(payload); }
    function createNonce() {
        const bytes = new Uint8Array(32);
        getCrypto().getRandomValues(bytes);
        return toHex(bytes);
    }
    async function sign(identity, payload) {
        const c = getCrypto();
        const signature = await c.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, encoder.encode(canonicalize(payload)));
        return toHex(signature);
    }
    async function verify(publicKey, payload, signature) {
        const c = getCrypto();
        return c.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromHex(signature), encoder.encode(canonicalize(payload)));
    }
    return { canonicalize, digest, generateIdentity, importPublicKey, hashState, hashMove, createNonce, sign, verify };
});
