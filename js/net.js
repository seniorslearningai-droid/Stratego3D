// Peer-to-peer link between the two browsers, using PeerJS (loaded as a
// global script). The player who creates the game is the host: their browser
// keeps the real game state and referees every move. The guest connects to
// the host by game code.

const PREFIX = 'stratego3d-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PING_EVERY = 4000;
const SILENCE_LIMIT = 14000;

export function makeCode() {
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function makeToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const isCode = (s) => /^[A-Z0-9]{5}$/.test(s);

const PEER_OPTIONS = { debug: 0 };

// Keeps a data connection honest: pings regularly and reports it dead if the
// other side goes quiet (browsers can take a long time to notice on their own).
function watch(conn, onDead) {
  let lastHeard = Date.now();
  let dead = false;
  const timer = setInterval(() => {
    if (Date.now() - lastHeard > SILENCE_LIMIT) kill();
    else if (conn.open) conn.send({ t: 'ping' });
  }, PING_EVERY);
  function kill() {
    if (dead) return;
    dead = true;
    clearInterval(timer);
    try { conn.close(); } catch { /* already closed */ }
    onDead();
  }
  return {
    heard() { lastHeard = Date.now(); },
    kill,
  };
}

// The host's end. Accepts one guest at a time; handlers decide whether a
// guest is let in (see main.js).
export class HostLink {
  constructor(code, { onReady, onIdTaken, onMessage, onGuestLeft, onStatus }) {
    this.code = code;
    this.handlers = { onReady, onIdTaken, onMessage, onGuestLeft, onStatus };
    this.conns = new Set();
    this.destroyed = false;
  }

  // retryTaken: keep trying if the code is still held (e.g. right after a reload).
  start({ retryTaken = true } = {}) {
    let attempts = 0;
    const open = () => {
      if (this.destroyed) return;
      const peer = new Peer(PREFIX + this.code, PEER_OPTIONS);
      this.peer = peer;
      peer.on('open', () => {
        this.handlers.onStatus?.('online');
        this.handlers.onReady?.();
      });
      peer.on('connection', (conn) => this.accept(conn));
      peer.on('disconnected', () => {
        if (this.destroyed || peer.destroyed) return;
        this.handlers.onStatus?.('reconnecting');
        setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          peer.destroy();
          attempts++;
          if (retryTaken && attempts < 20) {
            this.handlers.onStatus?.('claiming');
            setTimeout(open, 2500);
          } else {
            this.handlers.onIdTaken?.();
          }
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          this.handlers.onStatus?.('reconnecting');
        }
      });
    };
    open();
  }

  accept(conn) {
    let watcher;
    conn.on('open', () => {
      this.conns.add(conn);
      watcher = watch(conn, () => this.drop(conn));
    });
    conn.on('data', (msg) => {
      watcher?.heard();
      if (!msg || typeof msg !== 'object' || msg.t === 'ping') return;
      this.handlers.onMessage(msg, conn);
    });
    conn.on('close', () => watcher ? watcher.kill() : this.drop(conn));
    conn.on('error', () => watcher?.kill());
  }

  drop(conn) {
    if (!this.conns.delete(conn)) return;
    this.handlers.onGuestLeft?.(conn);
  }

  send(conn, msg) {
    if (conn && conn.open) conn.send(msg);
  }

  // Close every connection except `keep` (used when a guest reconnects).
  closeOthers(keep) {
    for (const c of [...this.conns]) {
      if (c !== keep) {
        this.conns.delete(c);
        try { c.close(); } catch { /* ignore */ }
      }
    }
  }

  destroy() {
    this.destroyed = true;
    this.peer?.destroy();
  }
}

// The guest's end. Keeps trying to reach the host until destroyed.
export class GuestLink {
  constructor(code, { onConnected, onMessage, onLost, onStatus }) {
    this.code = code;
    this.handlers = { onConnected, onMessage, onLost, onStatus };
    this.destroyed = false;
    this.conn = null;
    this.retryTimer = null;
  }

  start() {
    const peer = new Peer(PEER_OPTIONS);
    this.peer = peer;
    peer.on('open', () => this.connect());
    peer.on('disconnected', () => {
      if (this.destroyed || peer.destroyed) return;
      setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (this.destroyed) return;
      if (err.type === 'peer-unavailable') {
        this.handlers.onStatus?.('host-offline');
        this.retry(4000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'webrtc'].includes(err.type)) {
        this.handlers.onStatus?.('reconnecting');
        this.retry(4000);
      }
    });
  }

  connect() {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    this.handlers.onStatus?.('connecting');
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    let watcher;
    conn.on('open', () => {
      watcher = watch(conn, () => this.lost(conn));
      this.handlers.onStatus?.('online');
      this.handlers.onConnected?.();
    });
    conn.on('data', (msg) => {
      watcher?.heard();
      if (!msg || typeof msg !== 'object' || msg.t === 'ping') return;
      this.handlers.onMessage(msg);
    });
    conn.on('close', () => watcher ? watcher.kill() : this.lost(conn));
    conn.on('error', () => watcher?.kill());
  }

  lost(conn) {
    if (this.destroyed || conn !== this.conn) return;
    this.conn = null;
    this.handlers.onLost?.();
    this.retry(2500);
  }

  retry(delay) {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
      if (this.peer.open) this.connect();
      else this.retry(delay);
    }, delay);
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      this.conn.send(msg);
      return true;
    }
    return false;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    this.peer?.destroy();
  }
}
