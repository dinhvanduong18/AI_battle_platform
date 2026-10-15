(function (root) {
    class BackendMatchClient {
        constructor(baseUrl) {
            this.baseUrl = String(baseUrl || 'http://localhost:8787').replace(/\/$/, '');
            this.token = null;
            this.user = null;
            this.ws = null;
            this.handlers = new Map();
            this.connection = null;
            this.pc = null;
            this.candidateQueue = [];
            this.pendingSignals = [];
            this.signalingReady = false;
            this.match = null;
        }
        on(type, callback) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(callback); return this; }
        emit(type, payload) { (this.handlers.get(type) || []).forEach(fn => fn(payload)); }
        async request(path, body) {
            const response = await fetch(this.baseUrl + path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Backend request failed (${response.status})`);
            return result;
        }
        async register(email, password, displayName) {
            const result = await this.request('/api/auth/register', { email, password, displayName });
            this.saveSession(result); return result;
        }
        async login(email, password) {
            const result = await this.request('/api/auth/login', { email, password });
            this.saveSession(result); return result;
        }
        saveSession(result) {
            this.token = result.token; this.user = result.user;
            localStorage.setItem('ottv2-backend-token', this.token);
            localStorage.setItem('ottv2-backend-user', JSON.stringify(this.user));
        }
        restoreSession() {
            this.token = localStorage.getItem('ottv2-backend-token');
            try { this.user = JSON.parse(localStorage.getItem('ottv2-backend-user') || 'null'); } catch (_) { this.user = null; }
            return Boolean(this.token && this.user);
        }
        async connect() {
            if (!this.token) throw new Error('Log in first');
            if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
            const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
            await new Promise((resolve, reject) => {
                const socket = new WebSocket(wsUrl); this.ws = socket;
                const timer = setTimeout(() => reject(new Error('Backend WebSocket timed out')), 8000);
                socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token: this.token })));
                socket.addEventListener('message', event => {
                    let packet; try { packet = JSON.parse(event.data); } catch (_) { return; }
                    if (packet.type === 'authenticated') { clearTimeout(timer); this.user = packet.user; resolve(); }
                    this.receive(packet);
                });
                socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to backend WebSocket')); });
                socket.addEventListener('close', () => this.emit('closed'));
            });
        }
        receive(packet) {
            this.emit(packet.type, packet);
            if (packet.type === 'match-found') this.setupPeerConnection(packet).catch(err => this.emit('error', { message: err.message }));
            if (packet.type === 'signal') {
                if (!this.pc || !this.signalingReady) this.pendingSignals.push(packet.payload);
                else this.handleSignal(packet.payload).catch(err => this.emit('error', { message: err.message }));
            }
        }
        send(packet) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Backend is disconnected');
            this.ws.send(JSON.stringify(packet));
        }
        async findMatch() { await this.connect(); this.send({ type: 'find-match' }); }
        async cancelMatch() { if (this.ws) this.send({ type: 'cancel-match' }); }
        async submitResult(payload) {
            const response = await fetch(this.baseUrl + '/api/match/submit-result', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Result submission failed (${response.status})`);
            return result;
        }
        async submitDisconnectClaim(envelope) {
            const response = await fetch(this.baseUrl + '/api/match/claim-disconnect', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(envelope)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Disconnect claim failed (${response.status})`);
            return result;
        }
        async setupPeerConnection(packet) {
            this.match = packet.match;
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            this.pc = pc;
            pc.onicecandidate = event => { if (event.candidate) this.send({ type: 'signal', matchId: this.match.id, payload: { candidate: event.candidate } }); };
            pc.onconnectionstatechange = () => {
                if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
                    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'rtc-disconnected', matchId: this.match.id });
                    this.emit('peer-disconnected', { matchId: this.match.id });
                } else if (pc.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
                    this.send({ type: 'rtc-connected', matchId: this.match.id });
                    this.emit('peer-reconnected', { matchId: this.match.id });
                }
            };
            if (packet.role === 'player1') {
                this.bindDataChannel(pc.createDataChannel('ottv2-match', { ordered: true }));
                const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
                this.send({ type: 'signal', matchId: this.match.id, payload: { description: pc.localDescription } });
            } else {
                pc.ondatachannel = event => this.bindDataChannel(event.channel);
            }
            this.signalingReady = true;
            this.emit('match-found-ready', packet);
            while (this.pendingSignals.length) await this.handleSignal(this.pendingSignals.shift());
        }
        bindDataChannel(channel) {
            const adapter = {
                open: false,
                send: data => { if (channel.readyState !== 'open') throw new Error('P2P DataChannel is not open'); channel.send(JSON.stringify(data)); },
                on: (event, callback) => { if (!adapter._handlers) adapter._handlers = {}; (adapter._handlers[event] ||= []).push(callback); return adapter; },
                close: () => channel.close()
            };
            const fire = (name, value) => (adapter._handlers?.[name] || []).forEach(callback => callback(value));
            channel.onopen = () => { adapter.open = true; this.connection = adapter; this.emit('datachannel-open', adapter); fire('open'); };
            channel.onmessage = event => {
                let data; try { data = JSON.parse(event.data); } catch (_) { data = event.data; }
                fire('data', data);
            };
            channel.onclose = () => { adapter.open = false; fire('close'); this.emit('datachannel-close'); };
            channel.onerror = error => fire('error', error);
            this.connection = adapter;
        }
        async handleSignal(payload) {
            if (!this.pc || !payload) return;
            if (payload.description) {
                await this.pc.setRemoteDescription(payload.description);
                while (this.candidateQueue.length) await this.pc.addIceCandidate(this.candidateQueue.shift());
                if (payload.description.type === 'offer') {
                    const answer = await this.pc.createAnswer(); await this.pc.setLocalDescription(answer);
                    this.send({ type: 'signal', matchId: this.match.id, payload: { description: this.pc.localDescription } });
                }
            }
            if (payload.candidate) {
                if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload.candidate);
                else this.candidateQueue.push(payload.candidate);
            }
        }
        close() {
            if (this.pc) this.pc.close();
            if (this.ws) this.ws.close();
            this.pc = null; this.ws = null; this.connection = null;
        }
    }
    root.BackendMatchClient = BackendMatchClient;
})(typeof window !== 'undefined' ? window : globalThis);
