// Community Run – Server
// Liefert die Web-App aus und verteilt in Echtzeit: Laufstatus, Rangliste, Chat, WebRTC-Signalisierung.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || String(crypto.randomInt(100000, 1000000));
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Optionaler TURN-Server (für Audio/Video hinter strengen Mobilfunk-/Firmennetzen)
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL,
    username: process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || '',
  });
}

// ---------- HTTP (statische Dateien) ----------
const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- Zustand (im Arbeitsspeicher) ----------
const users = new Map(); // token -> user
const byId = new Map(); // öffentliche id -> user
const chat = []; // letzte Nachrichten
let run = { id: 1, status: 'idle', title: 'Community Run', targetKm: 5, startAt: null, endedAt: null };
let rosterDirty = false;

const emptyStats = () => ({ distance: 0, elapsed: 0, splits: [], lap: 0, finished: false, finishMs: 0 });

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg, exceptUser) {
  const data = JSON.stringify(msg);
  for (const u of users.values()) {
    if (u !== exceptUser && u.ws && u.ws.readyState === 1) u.ws.send(data);
  }
}
function roster() {
  return [...users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    admin: u.admin,
    online: !!u.ws,
    inCall: u.inCall,
    video: u.video,
    audio: u.audio,
    stats: u.stats,
  }));
}
function pushChat(entry) {
  const msg = { id: crypto.randomUUID(), at: Date.now(), ...entry };
  chat.push(msg);
  if (chat.length > 300) chat.shift();
  broadcast({ t: 'chat', msg });
}
const sys = (text) => pushChat({ sys: true, text });
const num = (v, min, max, def = 0) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function leaveCall(u) {
  if (!u.inCall) return;
  u.inCall = false;
  u.video = false;
  broadcast({ t: 'call:left', id: u.id }, u);
  rosterDirty = true;
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  let user = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') return send(ws, { t: 'pong', t0: m.t0, now: Date.now() });

    if (m.t === 'hello') {
      const token = clean(m.token, 64);
      const name = clean(m.name, 24);
      if (token.length < 8 || !name) return send(ws, { t: 'loginError', text: 'Bitte einen Namen eingeben.' });
      if (m.pin && String(m.pin) !== ADMIN_PIN) return send(ws, { t: 'loginError', text: 'Die Organisator-PIN ist falsch.' });

      let u = users.get(token);
      const isNew = !u;
      if (!u) {
        u = { id: crypto.randomUUID().slice(0, 8), token, name, admin: false, ws: null, inCall: false, video: false, audio: true, stats: emptyStats() };
        users.set(token, u);
        byId.set(u.id, u);
      }
      if (u.ws && u.ws !== ws) {
        // Gleiche Person auf zweitem Gerät/Tab: alte Verbindung ablösen
        send(u.ws, { t: 'replaced' });
        u.ws.close();
        leaveCall(u);
      }
      u.name = name;
      if (m.pin) u.admin = true;
      u.ws = ws;
      user = u;
      send(ws, { t: 'welcome', you: { id: u.id, name: u.name, admin: u.admin }, run, chat, roster: roster(), now: Date.now(), iceServers });
      if (isNew) sys(`${u.name} ist dabei 👋`);
      rosterDirty = true;
      return;
    }

    if (!user || user.ws !== ws) return;

    switch (m.t) {
      case 'stats': {
        if (m.runId !== run.id || run.status === 'idle') return;
        const s = user.stats;
        s.distance = num(m.distance, 0, 1e6);
        s.elapsed = num(m.elapsed, 0, 1e9);
        s.lap = num(m.lap, 0, 1e7);
        s.splits = Array.isArray(m.splits) ? m.splits.slice(0, 200).map((x) => num(x, 0, 1e8)) : [];
        const wasFinished = s.finished;
        s.finished = !!m.finished;
        s.finishMs = num(m.finishMs, 0, 1e9);
        if (s.finished && !wasFinished) sys(`🏁 ${user.name} ist im Ziel!`);
        rosterDirty = true;
        break;
      }
      case 'chat': {
        const text = clean(m.text, 500);
        if (text) pushChat({ from: user.id, name: user.name, text });
        break;
      }
      case 'config': {
        if (!user.admin || run.status !== 'idle') return;
        run.title = clean(m.title, 60) || 'Community Run';
        run.targetKm = num(Number(m.targetKm), 0, 1000);
        broadcast({ t: 'run', run });
        break;
      }
      case 'start': {
        if (!user.admin || run.status !== 'idle') return;
        const countdown = num(Number(m.countdown), 3, 120, 10);
        run.status = 'running';
        run.startAt = Date.now() + countdown * 1000;
        run.endedAt = null;
        for (const u of users.values()) u.stats = emptyStats();
        broadcast({ t: 'run', run });
        sys(`🚦 ${user.name} startet den Lauf – Countdown ${countdown} s`);
        rosterDirty = true;
        break;
      }
      case 'stop': {
        if (!user.admin || run.status !== 'running') return;
        run.status = 'finished';
        run.endedAt = Date.now();
        broadcast({ t: 'run', run });
        sys('🏁 Der Lauf wurde beendet.');
        break;
      }
      case 'reset': {
        if (!user.admin) return;
        run = { id: run.id + 1, status: 'idle', title: run.title, targetKm: run.targetKm, startAt: null, endedAt: null };
        for (const [token, u] of users) {
          u.stats = emptyStats();
          if (!u.ws) {
            users.delete(token);
            byId.delete(u.id);
          }
        }
        broadcast({ t: 'run', run });
        sys('Neuer Lauf wird vorbereitet.');
        rosterDirty = true;
        break;
      }
      case 'call:join': {
        const peers = [...users.values()].filter((u) => u.inCall && u !== user && u.ws).map((u) => u.id);
        user.inCall = true;
        user.video = !!m.video;
        user.audio = m.audio !== false;
        send(ws, { t: 'call:peers', peers });
        rosterDirty = true;
        break;
      }
      case 'call:state': {
        if (!user.inCall) return;
        user.video = !!m.video;
        user.audio = !!m.audio;
        rosterDirty = true;
        break;
      }
      case 'call:leave':
        leaveCall(user);
        break;
      case 'rtc': {
        const to = byId.get(m.to);
        if (to && to.inCall && user.inCall) send(to.ws, { t: 'rtc', from: user.id, data: m.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (user && user.ws === ws) {
      user.ws = null;
      leaveCall(user);
      rosterDirty = true;
    }
  });
});

// Rangliste gebündelt verteilen, tote Verbindungen aufräumen
setInterval(() => {
  if (!rosterDirty) return;
  rosterDirty = false;
  broadcast({ t: 'roster', roster: roster() });
}, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`Community Run läuft auf http://localhost:${PORT}`);
  console.log(`Organisator-PIN: ${ADMIN_PIN}${process.env.ADMIN_PIN ? ' (aus ADMIN_PIN)' : ' (zufällig – mit Umgebungsvariable ADMIN_PIN fest einstellbar)'}`);
});
