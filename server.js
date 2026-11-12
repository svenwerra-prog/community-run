// Community Run – Server
// Liefert die Web-App aus und verteilt in Echtzeit: Laufstatus, Rangliste, Chat, Events, WebRTC-Signalisierung.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStore } = require('./store');

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
  iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- Zustand ----------
const newRun = (id, title = 'Community Run', targetKm = 5) => ({
  id, status: 'idle', title, targetKm, eventId: null, startAt: null, endedAt: null, saved: false,
});
// Dauerhaft gespeichert:
let state = {
  members: {},      // id -> { id, name, email, organizer, tokens[], joinedAt, lastSeen }
  adminTokens: [],  // Hashes der Geräte, die die Organisator-PIN eingegeben haben
  events: [],       // { id, title, at, targetKm, note, rsvp: { memberId: 'yes'|'no' }, done, createdAt }
  results: [],      // gespeicherte Ranglisten
  chat: [],
  run: newRun(1),
  stats: {},        // memberId -> Messwerte des aktuellen Laufs
};
// Nur zur Laufzeit:
const sessions = new Map(); // memberId -> { ws, admin, inCall, video, audio }
let store = null;
let rosterDirty = false;

const uid = () => crypto.randomUUID().slice(0, 8);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const emptyStats = () => ({ distance: 0, elapsed: 0, splits: [], lap: 0, finished: false, finishMs: 0 });
const num = (v, min, max, def = 0) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// ---------- Speichern (gebündelt) ----------
let saveTimer = null, saving = false, saveAgain = false;
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    await store.save(state);
  } catch (err) {
    console.error('Speichern fehlgeschlagen:', err.message);
  }
  saving = false;
  if (saveAgain) { saveAgain = false; persist(true); }
}
// urgent: wichtige Änderung (bald speichern); sonst Messwerte (seltener speichern)
function persist(urgent) {
  if (!store) return;
  if (saveTimer && !urgent) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, urgent ? 800 : 15000);
}

// ---------- Senden ----------
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [id, s] of sessions) if (id !== exceptId && s.ws.readyState === 1) s.ws.send(data);
}
function sendAdmins(msg) {
  const data = JSON.stringify(msg);
  for (const s of sessions.values()) if (s.admin && s.ws.readyState === 1) s.ws.send(data);
}
function roster() {
  return Object.values(state.members).map((m) => {
    const s = sessions.get(m.id);
    return {
      id: m.id, name: m.name, organizer: !!m.organizer, online: !!s,
      inCall: !!(s && s.inCall), video: !!(s && s.video), audio: s ? s.audio : true,
      stats: state.stats[m.id] || null,
    };
  });
}
// Nur für Organisatoren: enthält E-Mail-Adressen
function memberList() {
  return Object.values(state.members).map((m) => ({
    id: m.id, name: m.name, email: m.email, organizer: !!m.organizer, joinedAt: m.joinedAt, lastSeen: m.lastSeen,
    runs: state.results.filter((r) => r.ranking.some((x) => x.id === m.id)).length,
  }));
}
const pushMembers = () => sendAdmins({ t: 'members', members: memberList() });
const pushEvents = () => broadcast({ t: 'events', events: state.events });
const pushResults = () => broadcast({ t: 'results', results: state.results });

function pushChat(entry) {
  const msg = { id: crypto.randomUUID(), at: Date.now(), ...entry };
  state.chat.push(msg);
  if (state.chat.length > 300) state.chat.shift();
  broadcast({ t: 'chat', msg });
  persist(true);
}
const sys = (text) => pushChat({ sys: true, text });

function leaveCall(id) {
  const s = sessions.get(id);
  if (!s || !s.inCall) return;
  s.inCall = false;
  s.video = false;
  broadcast({ t: 'call:left', id }, id);
  rosterDirty = true;
}

// ---------- Ergebnisse ----------
let resultTimer = null;
function saveResult() {
  clearTimeout(resultTimer);
  resultTimer = null;
  const run = state.run;
  if (run.saved || run.status === 'idle') return;
  run.saved = true;
  const ranking = Object.entries(state.stats)
    .filter(([id, s]) => state.members[id] && s.distance > 0)
    .map(([id, s]) => ({
      id, name: state.members[id].name, distance: Math.round(s.distance), finished: s.finished,
      timeMs: Math.round(s.finished ? s.finishMs : s.elapsed), splits: s.splits.map(Math.round),
    }))
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return a.finished ? a.timeMs - b.timeMs : b.distance - a.distance;
    });
  if (!ranking.length) return;
  state.results.unshift({
    id: uid(), eventId: run.eventId, title: run.title, targetKm: run.targetKm,
    startAt: run.startAt, endedAt: run.endedAt || Date.now(), ranking,
  });
  if (state.results.length > 100) state.results.pop();
  const ev = state.events.find((e) => e.id === run.eventId);
  if (ev) { ev.done = true; pushEvents(); }
  pushResults();
  pushMembers();
  persist(true);
}

// ---------- Schutz der Organisator-PIN gegen Durchprobieren ----------
let pinFails = [];
function pinLocked() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  pinFails = pinFails.filter((t) => t > cutoff);
  return pinFails.length >= 10;
}
function pinMatches(input) {
  const a = hash(String(input)), b = hash(ADMIN_PIN);
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  let member = null, session = null;
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
      const email = clean(m.email, 120).toLowerCase();
      if (token.length < 8 || !name) return send(ws, { t: 'loginError', text: 'Bitte einen Namen eingeben.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(ws, { t: 'loginError', text: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
      const th = hash(token);
      if (m.pin) {
        if (pinLocked()) return send(ws, { t: 'loginError', text: 'Zu viele falsche PIN-Versuche. Bitte in 10 Minuten erneut versuchen.' });
        if (!pinMatches(m.pin)) {
          pinFails.push(Date.now());
          return send(ws, { t: 'loginError', text: 'Die Organisator-PIN ist falsch.' });
        }
        if (!state.adminTokens.includes(th)) state.adminTokens.push(th);
        if (state.adminTokens.length > 20) state.adminTokens.shift();
      }

      const now = Date.now();
      let mem = Object.values(state.members).find((x) => x.email === email);
      const isNew = !mem;
      if (!mem) {
        mem = { id: uid(), name, email, organizer: false, tokens: [], joinedAt: now, lastSeen: now };
        state.members[mem.id] = mem;
      }
      if (!mem.tokens.includes(th)) mem.tokens.push(th);
      if (mem.tokens.length > 10) mem.tokens.shift();
      mem.name = name;
      mem.lastSeen = now;
      const admin = state.adminTokens.includes(th);
      if (admin) mem.organizer = true;

      const old = sessions.get(mem.id);
      if (old && old.ws !== ws) {
        // Gleiche Person auf zweitem Gerät/Tab: alte Verbindung ablösen
        leaveCall(mem.id);
        send(old.ws, { t: 'replaced' });
        old.ws.close();
      }
      member = mem;
      session = { ws, admin, inCall: false, video: false, audio: true };
      sessions.set(mem.id, session);
      send(ws, {
        t: 'welcome', you: { id: mem.id, name: mem.name, admin }, run: state.run, chat: state.chat, roster: roster(),
        events: state.events, results: state.results, members: admin ? memberList() : undefined, now: Date.now(), iceServers,
      });
      if (isNew) sys(`${mem.name} ist neu in der Community 👋`);
      rosterDirty = true;
      pushMembers();
      persist(true);
      return;
    }

    if (!member || sessions.get(member.id) !== session) return;
    const run = state.run;
    const admin = session.admin;

    switch (m.t) {
      case 'stats': {
        if (m.runId !== run.id || run.status === 'idle') return;
        const s = state.stats[member.id] || (state.stats[member.id] = emptyStats());
        s.distance = num(m.distance, 0, 1e6);
        s.elapsed = num(m.elapsed, 0, 1e9);
        s.lap = num(m.lap, 0, 1e7);
        s.splits = Array.isArray(m.splits) ? m.splits.slice(0, 200).map((x) => num(x, 0, 1e8)) : [];
        const wasFinished = s.finished;
        s.finished = !!m.finished;
        s.finishMs = num(m.finishMs, 0, 1e9);
        if (s.finished && !wasFinished) sys(`🏁 ${member.name} ist im Ziel!`);
        rosterDirty = true;
        persist(false);
        break;
      }
      case 'chat': {
        const text = clean(m.text, 500);
        if (text) pushChat({ from: member.id, name: member.name, text });
        break;
      }
      case 'rsvp': {
        const ev = state.events.find((e) => e.id === m.eventId);
        if (!ev || ev.done) return;
        if (m.answer === 'yes' || m.answer === 'no') ev.rsvp[member.id] = m.answer;
        else delete ev.rsvp[member.id];
        pushEvents();
        persist(true);
        break;
      }

      // ----- nur Organisator -----
      case 'config': {
        if (!admin || run.status !== 'idle') return;
        run.title = clean(m.title, 60) || 'Community Run';
        run.targetKm = num(Number(m.targetKm), 0, 1000);
        run.eventId = state.events.some((e) => e.id === m.eventId) ? m.eventId : null;
        broadcast({ t: 'run', run });
        persist(true);
        break;
      }
      case 'start': {
        if (!admin || run.status !== 'idle') return;
        const countdown = num(Number(m.countdown), 3, 120, 10);
        run.status = 'running';
        run.startAt = Date.now() + countdown * 1000;
        run.endedAt = null;
        run.saved = false;
        state.stats = {};
        broadcast({ t: 'run', run });
        sys(`🚦 ${member.name} startet den Lauf – Countdown ${countdown} s`);
        rosterDirty = true;
        persist(true);
        break;
      }
      case 'stop': {
        if (!admin || run.status !== 'running') return;
        run.status = 'finished';
        run.endedAt = Date.now();
        broadcast({ t: 'run', run });
        sys('🏁 Der Lauf wurde beendet. Die Rangliste wird gespeichert.');
        // Kurz warten, damit die letzten Messwerte aller Geräte noch eintreffen
        resultTimer = setTimeout(saveResult, 4000);
        persist(true);
        break;
      }
      case 'reset': {
        if (!admin) return;
        saveResult();
        state.run = newRun(run.id + 1, run.title, run.targetKm);
        state.stats = {};
        broadcast({ t: 'run', run: state.run });
        sys('Neuer Lauf wird vorbereitet.');
        rosterDirty = true;
        persist(true);
        break;
      }
      case 'event:create': {
        if (!admin) return;
        const title = clean(m.title, 60);
        const at = Number(m.at);
        if (!title || !Number.isFinite(at)) return;
        state.events.push({ id: uid(), title, at, targetKm: num(Number(m.targetKm), 0, 1000), note: clean(m.note, 300), rsvp: {}, done: false, createdAt: Date.now() });
        if (state.events.length > 50) state.events.shift();
        state.events.sort((a, b) => a.at - b.at);
        pushEvents();
        sys(`📅 Neues Event: ${title} – bitte in „Community“ zu- oder absagen.`);
        break;
      }
      case 'event:delete': {
        if (!admin) return;
        state.events = state.events.filter((e) => e.id !== m.id);
        if (run.eventId === m.id) run.eventId = null;
        pushEvents();
        persist(true);
        break;
      }
      case 'result:delete': {
        if (!admin) return;
        state.results = state.results.filter((r) => r.id !== m.id);
        pushResults();
        pushMembers();
        persist(true);
        break;
      }
      case 'member:remove': {
        if (!admin || m.id === member.id || !state.members[m.id]) return;
        const s = sessions.get(m.id);
        if (s) {
          leaveCall(m.id);
          send(s.ws, { t: 'removed' });
          sessions.delete(m.id);
          s.ws.close();
        }
        delete state.members[m.id];
        delete state.stats[m.id];
        for (const e of state.events) delete e.rsvp[m.id];
        pushEvents();
        pushMembers();
        rosterDirty = true;
        persist(true);
        break;
      }

      // ----- Call -----
      case 'call:join': {
        const peers = [...sessions].filter(([id, s]) => s.inCall && id !== member.id).map(([id]) => id);
        session.inCall = true;
        session.video = !!m.video;
        session.audio = m.audio !== false;
        send(ws, { t: 'call:peers', peers });
        rosterDirty = true;
        break;
      }
      case 'call:state': {
        if (!session.inCall) return;
        session.video = !!m.video;
        session.audio = !!m.audio;
        rosterDirty = true;
        break;
      }
      case 'call:leave':
        leaveCall(member.id);
        break;
      case 'rtc': {
        const to = sessions.get(m.to);
        if (to && to.inCall && session.inCall) send(to.ws, { t: 'rtc', from: member.id, data: m.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (member && sessions.get(member.id) === session) {
      leaveCall(member.id);
      sessions.delete(member.id);
      if (state.members[member.id]) state.members[member.id].lastSeen = Date.now();
      rosterDirty = true;
      persist(false);
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

// ---------- Start ----------
(async () => {
  store = await createStore();
  try {
    const loaded = await store.load();
    if (loaded && typeof loaded === 'object') state = { ...state, ...loaded };
  } catch (err) {
    console.error('Laden fehlgeschlagen – starte leer:', err.message);
  }
  server.listen(PORT, () => {
    console.log(`Community Run läuft auf http://localhost:${PORT}`);
    console.log(`Speicher: ${store.kind} – ${Object.keys(state.members).length} Mitglieder, ${state.results.length} gespeicherte Läufe`);
    console.log(`Organisator-PIN: ${process.env.ADMIN_PIN ? '(aus ADMIN_PIN)' : ADMIN_PIN + ' (zufällig – mit Umgebungsvariable ADMIN_PIN fest einstellbar)'}`);
  });
})();

// Beim Herunterfahren (z. B. neues Deployment) den letzten Stand sichern
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try {
      if (store) await store.save(state);
    } catch {}
    process.exit(0);
  });
}
