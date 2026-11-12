/* Community Run – Client */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  // Testhilfen: ?sim=3 simuliert einen Lauf mit 3 m/s, ?u=xyz trennt mehrere Test-Teilnehmer im selben Browser
  const SIM = params.has('sim') ? parseFloat(params.get('sim')) || 3 : 0;
  const NS = 'cr_' + (params.get('u') || '') + '_';
  // Nur in der Android-App gesetzt (mobile/native/native.js); im Browser bleibt beides leer
  const SERVER = ((window.CR_CONFIG || {}).server || '').replace(/\/+$/, ''); // z. B. https://community-run.onrender.com
  const NATIVE = window.CRNative || null;                                     // GPS im Hintergrund, Sprachansage
  const store = {
    get(k) { try { return localStorage.getItem(NS + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(NS + k, v); } catch {} },
  };

  function randomToken() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let token = store.get('token');
  if (!token) { token = randomToken(); store.set('token', token); }

  // ---------- Zustand ----------
  let ws = null, connected = false, stopReconnect = false, loggedIn = false;
  let me = null, myName = '', myEmail = '', pin = '';
  let events = [], results = [], members = [];
  const NO_STATS = { distance: 0, elapsed: 0, splits: [], lap: 0, finished: false, finishMs: 0 };
  const withStats = (list) => (list || []).map((u) => ({ ...u, stats: u.stats || NO_STATS }));
  let run = { id: 0, status: 'idle', title: 'Community Run', targetKm: 0, startAt: null, endedAt: null };
  let roster = [];
  let clockOffset = 0, bestRtt = Infinity;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let track = null;          // eigene Messung des aktuellen Laufs
  let lastPt = null;         // letzter gültiger GPS-Punkt
  let recent = [];           // Verlauf für "aktuelle Pace"
  let gps = { acc: null, at: 0, error: '' };
  let activeTab = 'run', unread = 0, lastCount = null;

  const now = () => Date.now() + clockOffset;

  // ---------- Formatierung ----------
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }
  function fmtPace(msPerKm) {
    if (!Number.isFinite(msPerKm) || msPerKm <= 0 || msPerKm > 30 * 60000) return '–:––';
    const s = Math.round(msPerKm / 1000);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }
  const fmtKm = (m) => (m / 1000).toFixed(2).replace('.', ',');
  const initials = (name) => name.trim().slice(0, 2).toUpperCase();
  const fmtDate = (ms) => new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const focusEvent = params.get('event'); // Einladungslink: direkt zum Event springen
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function toast(text, ms = 3500) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- Ton & Ansagen ----------
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
    } catch {}
  }
  function beep(freq, dur) {
    if (!audioCtx) return;
    try {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.25, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + dur);
    } catch {}
  }
  function speak(text) {
    if (!$('#voiceToggle').checked) return;
    if (NATIVE) { NATIVE.speak(text); return; }
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      speechSynthesis.speak(u);
    } catch {}
  }
  const spokenPace = (ms) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)} Minuten ${s % 60}`;
  };

  // ---------- Bildschirm wach halten ----------
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (!loggedIn) return;
    keepAwake();
    if (document.visibilityState === 'visible') checkConnection(); // nach dem Entsperren sofort aufholen
  });

  // Server wach halten: manche Hoster legen Gratis-Dienste ohne normale Seitenaufrufe schlafen
  setInterval(() => {
    if (loggedIn) fetch(SERVER + '/healthz', SERVER ? { cache: 'no-store', mode: 'no-cors' } : { cache: 'no-store' }).catch(() => {});
  }, 4 * 60 * 1000);

  // ---------- Verbindung ----------
  let reconnectTimer = null, lastMsgAt = 0;
  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const url = SERVER ? SERVER.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      send({ t: 'hello', token, name: myName, email: myEmail, pin: pin || undefined });
      bestRtt = Infinity;
      for (let i = 0; i < 5; i++) setTimeout(() => send({ t: 'ping', t0: Date.now() }), i * 400);
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastMsgAt = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;                 // bereits durch eine neue Verbindung ersetzt
      connected = false;
      renderBadges();
      if (inCall) closeAllPeers();
      if (!stopReconnect) reconnectTimer = setTimeout(connect, 2000);
    };
  }
  // Verbindung sofort neu aufbauen (ohne die 2 Sekunden Wartezeit)
  function reconnectNow() {
    if (!loggedIn || stopReconnect) return;
    const old = ws;
    ws = null;
    connected = false;
    if (old) { try { old.close(); } catch {} }
    if (inCall) closeAllPeers();
    connect();
  }
  // Prüft z. B. nach dem Entsperren, ob die Verbindung noch lebt, und baut sie sonst neu auf
  function checkConnection() {
    if (!loggedIn || stopReconnect) return;
    if (!ws || ws.readyState === 3) { reconnectNow(); return; }
    if (ws.readyState !== 1) return;           // Aufbau läuft gerade
    const sock = ws, sentAt = Date.now();
    send({ t: 'ping', t0: sentAt });
    setTimeout(() => { if (ws === sock && lastMsgAt < sentAt) reconnectNow(); }, 5000);
  }

  function handle(m) {
    switch (m.t) {
      case 'pong': {
        const t1 = Date.now(), rtt = t1 - m.t0;
        if (rtt < bestRtt) { bestRtt = rtt; clockOffset = m.now - (m.t0 + t1) / 2; }
        break;
      }
      case 'loginError':
        stopReconnect = true;
        ws.close();
        $('#loginError').textContent = m.text;
        $('#loginError').hidden = false;
        $('#login').hidden = false;
        $('#app').hidden = true;
        break;
      case 'replaced':
        stopReconnect = true;
        toast('Du bist auf einem anderen Gerät angemeldet – diese Sitzung wurde getrennt.', 10000);
        break;
      case 'welcome':
        connected = true;
        loggedIn = true;
        pin = '';
        me = m.you;
        if (Number.isFinite(m.now) && bestRtt === Infinity) clockOffset = m.now - Date.now();
        if (m.iceServers) iceServers = m.iceServers;
        roster = withStats(m.roster);
        events = m.events || [];
        results = m.results || [];
        members = m.members || [];
        $('#login').hidden = true;
        $('#app').hidden = false;
        $('#adminPanel').hidden = !me.admin;
        $('#eventForm').hidden = !me.admin;
        $('#membersCard').hidden = !me.admin;
        renderEvents();
        renderHistory();
        renderMembers();
        if (focusEvent && events.some((e) => e.id === focusEvent)) showTab('community');
        $('#chatList').textContent = '';
        m.chat.forEach((c) => addChat(c, true));
        scrollChat();
        onRun(m.run);
        renderBoard();
        renderBadges();
        if (inCall) send({ t: 'call:join', video: !!camTrack, audio: micOn }); // nach Verbindungsabbruch wieder einsteigen
        break;
      case 'run':
        onRun(m.run);
        break;
      case 'roster':
        roster = withStats(m.roster);
        renderBoard();
        renderCallMeta();
        renderEvents();
        break;
      case 'events':
        events = m.events || [];
        renderEvents();
        renderAdmin();
        break;
      case 'results':
        results = m.results || [];
        renderHistory();
        break;
      case 'members':
        members = m.members || [];
        renderMembers();
        break;
      case 'removed':
        stopReconnect = true;
        toast('Du wurdest vom Organisator aus der Community entfernt.', 10000);
        break;
      case 'chat':
        addChat(m.msg, false);
        break;
      case 'call:peers':
        m.peers.forEach((id) => makePeer(id, true));
        break;
      case 'call:left':
        closePeer(m.id);
        break;
      case 'rtc':
        onRtc(m.from, m.data).catch((err) => console.warn('rtc', err));
        break;
    }
  }

  // ---------- Lauf ----------
  function loadTrack(runId) {
    try {
      const t = JSON.parse(store.get('track'));
      if (t && t.runId === runId) return t;
    } catch {}
    return { runId, distance: 0, splits: [], lastSplitAt: 0, lastT: 0, finished: false, finishMs: 0 };
  }
  const saveTrack = () => track && store.set('track', JSON.stringify(track));

  function onRun(r) {
    const prev = run;
    run = r;
    if (r.status === 'idle') {
      track = null;
      lastPt = null;
      recent = [];
      lastCount = null;
    } else if (!track || track.runId !== r.id) {
      track = loadTrack(r.id);
      lastPt = null;
      recent = [];
    }
    if (prev.status === 'running' && r.status === 'finished') {
      beep(660, 0.6);
      speak('Der Lauf ist beendet. Stark gemacht!');
      sendStats();
    }
    $('#runTitle').textContent = r.title;
    document.title = r.title;
    renderAdmin();
    renderSplits();
    render();
  }

  // Läuft die Messung gerade? (Lauf gestartet, Countdown vorbei, noch nicht im Ziel)
  const isActive = () => run.status === 'running' && track && !track.finished && now() >= run.startAt;

  function elapsedMs() {
    if (!track || run.status === 'idle' || !run.startAt) return 0;
    if (track.finished) return track.finishMs;
    const end = run.status === 'finished' && run.endedAt ? run.endedAt : now();
    return Math.max(0, end - run.startAt);
  }

  function addDistance(d, t) {
    if (!isActive() || !(d > 0)) return;
    const elapsed = Math.max(0, t - run.startAt);
    const before = track.distance;
    const prevT = track.lastT;
    track.distance += d;
    const at = (mark) => prevT + (elapsed - prevT) * Math.min(1, Math.max(0, (mark - before) / d));

    // Kilometer-Runden
    while (track.distance >= (track.splits.length + 1) * 1000) {
      const cross = at((track.splits.length + 1) * 1000);
      const split = cross - track.lastSplitAt;
      track.splits.push(split);
      track.lastSplitAt = cross;
      beep(880, 0.25);
      speak(`Kilometer ${track.splits.length}. Rundenzeit ${spokenPace(split)}. Durchschnitt ${spokenPace(cross / track.splits.length)}.`);
      renderSplits();
    }
    // Ziel erreicht?
    const target = run.targetKm * 1000;
    if (target > 0 && track.distance >= target) {
      track.finished = true;
      track.finishMs = at(target);
      track.distance = target;
      beep(1040, 0.8);
      speak(`Ziel erreicht! ${run.targetKm} Kilometer in ${fmtTime(track.finishMs)}.`);
      sendStats();
    }
    track.lastT = elapsed;
    recent.push({ t: elapsed, d: track.distance });
    while (recent.length > 2 && elapsed - recent[0].t > 30000) recent.shift();
    saveTrack();
  }

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
    gps = { acc, at: Date.now(), error: '' };
    if (!isActive()) { lastPt = null; return; }
    if (acc > 40) return;                       // zu ungenau
    const t = now() - (pos.late || 0);          // App: verspätet zugestellte Positionen auf ihre Messzeit zurückrechnen
    if (!lastPt) { lastPt = { lat, lon, t }; return; }
    const d = haversine(lastPt, { lat, lon });
    if (d < 3) return;                          // GPS-Zittern im Stand ignorieren
    const dt = (t - lastPt.t) / 1000;
    lastPt = { lat, lon, t };
    if (dt <= 0 || d / dt > 10) return;         // Sprung (> 36 km/h) verwerfen
    addDistance(d, t);
  }

  function startGps() {
    if (SIM) {
      setInterval(() => addDistance(SIM * (0.9 + Math.random() * 0.2), now()), 1000);
      return;
    }
    if (NATIVE) {
      // Android-App: Standort kommt vom Vordergrunddienst und läuft bei gesperrtem Bildschirm weiter.
      // Im Hintergrund bremst Android Zeitgeber – deshalb hängen Senden und Verbindungsprüfung hier an jeder Position.
      NATIVE.startGps((pos) => {
        onFix(pos);
        if (!ws || ws.readyState === 3) checkConnection();
        if (Date.now() - lastStatsAt > 4000 && run.status === 'running' && track && now() >= run.startAt) sendStats();
      }, (text) => { gps.error = text; });
      return;
    }
    if (!('geolocation' in navigator)) { gps.error = 'kein GPS'; return; }
    navigator.geolocation.watchPosition(onFix, (err) => {
      gps.error = err.code === 1 ? 'Standort gesperrt' : 'kein Signal';
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  function lapPace() {
    if (!track) return NaN;
    const lapDist = track.distance - track.splits.length * 1000;
    if (lapDist < 50) return NaN;
    const end = track.finished ? track.finishMs : elapsedMs();
    return (end - track.lastSplitAt) / (lapDist / 1000);
  }
  function currentPace() {
    if (!isActive() || recent.length < 2) return NaN;
    const a = recent[0], b = recent[recent.length - 1];
    if (b.d - a.d < 10 || elapsedMs() - b.t > 10000) return NaN;
    return (b.t - a.t) / ((b.d - a.d) / 1000);
  }

  let lastStatsAt = 0;
  function sendStats() {
    if (!track || run.status === 'idle') return;
    lastStatsAt = Date.now();
    send({
      t: 'stats', runId: run.id, distance: track.distance, elapsed: elapsedMs(),
      splits: track.splits, lap: lapPace() || 0, finished: track.finished, finishMs: track.finishMs,
    });
  }
  setInterval(() => { if (run.status === 'running' && track && now() >= run.startAt) sendStats(); }, 3000);

  // ---------- Darstellung ----------
  function render() {
    const panel = $('#statePanel'), text = $('#stateText'), cd = $('#countdown');
    const t = now();
    let cls = 'idle', label = 'Warten auf den Start durch den Organisator', sub = 'Warten auf den Start';

    if (run.status === 'running' && t < run.startAt) {
      const left = Math.ceil((run.startAt - t) / 1000);
      cd.hidden = false;
      $('#countNum').textContent = left;
      if (left !== lastCount) { lastCount = left; beep(left <= 3 ? 880 : 440, 0.15); }
      label = 'Countdown läuft'; sub = 'Start in ' + left + ' s';
    } else {
      if (!cd.hidden) {            // Startsignal
        cd.hidden = true;
        if (run.status === 'running') {
          beep(1320, 0.9);
          speak('Los geht’s!');
          if (activeTab !== 'call') showTab('run');
        }
      }
      lastCount = null;
      if (run.status === 'running') {
        cls = 'running';
        label = track && track.finished ? 'Du bist im Ziel 🎉' : 'Lauf läuft';
        sub = run.targetKm > 0 ? `Ziel: ${String(run.targetKm).replace('.', ',')} km` : 'Offene Distanz';
        if (track && track.finished) cls = 'finished';
      } else if (run.status === 'finished') {
        cls = 'finished'; label = 'Lauf beendet'; sub = 'Lauf beendet';
      }
    }
    panel.className = 'state ' + cls;
    text.textContent = label;
    $('#runSub').textContent = sub;
    $('#timer').textContent = fmtTime(elapsedMs());

    const dist = track ? track.distance : 0;
    $('#mDist').textContent = fmtKm(dist);
    $('#mAvg').textContent = dist >= 50 ? fmtPace(elapsedMs() / (dist / 1000)) : '–:––';
    $('#mNow').textContent = fmtPace(currentPace());
    $('#mLap').textContent = fmtPace(lapPace());
    $('#lapNo').textContent = track ? track.splits.length + 1 : 1;
    $('#mLast').textContent = track && track.splits.length ? fmtPace(track.splits[track.splits.length - 1]) : '–:––';
    renderHost();
    renderBadges();
  }
  setInterval(render, 250);

  function renderSplits() {
    const ol = $('#splits');
    ol.textContent = '';
    if (!track || !track.splits.length) {
      const li = document.createElement('li');
      li.className = 'muted empty';
      li.textContent = 'Noch keine Runde abgeschlossen.';
      ol.append(li);
      return;
    }
    const best = Math.min(...track.splits);
    track.splits.forEach((s, i) => {
      const li = document.createElement('li');
      const a = document.createElement('span'), b = document.createElement('span');
      a.textContent = `km ${i + 1}`;
      b.textContent = fmtPace(s) + ' /km';
      if (s === best && track.splits.length > 1) b.className = 'best';
      li.append(a, b);
      ol.prepend(li);
    });
  }

  function renderBadges() {
    const c = $('#connBadge'), g = $('#gpsBadge');
    c.textContent = connected ? 'online' : 'offline';
    c.className = 'badge ' + (connected ? 'ok' : 'bad');
    if (SIM) { g.textContent = 'GPS simuliert'; g.className = 'badge warn'; return; }
    if (gps.error) { g.textContent = gps.error; g.className = 'badge bad'; return; }
    if (!gps.at || Date.now() - gps.at > 15000) { g.textContent = 'GPS sucht …'; g.className = 'badge warn'; return; }
    g.textContent = `GPS ±${Math.round(gps.acc)} m`;
    g.className = 'badge ' + (gps.acc <= 20 ? 'ok' : 'warn');
  }

  // Hauptläufer (Organisator): sein Stand und der eigene Abstand zu ihm
  const fmtGap = (m) => (m >= 1000 ? fmtKm(m) + ' km' : Math.round(m / 10) * 10 + ' m');
  function renderHost() {
    const box = $('#hostCard');
    const host = roster.find((u) => u.organizer);
    if (!host || !me || run.status === 'idle' || (run.startAt && now() < run.startAt)) { box.hidden = true; return; }
    const diffEl = $('#hostDiff');
    if (host.id === me.id) {
      const others = roster.filter((u) => u.id !== me.id && u.stats.distance > 0);
      $('#hostLine').textContent = '⭐ Du bist der Hauptläufer';
      diffEl.className = 'host-diff';
      diffEl.textContent = others.length === 1 ? '1 Person läuft mit dir' : others.length ? `${others.length} laufen mit dir` : 'Die Community läuft mit dir';
      box.hidden = false;
      return;
    }
    const s = host.stats;
    const t = s.finished ? s.finishMs : s.elapsed;
    $('#hostLine').textContent = `⭐ ${host.name} (Hauptläufer): ${fmtKm(s.distance)} km` + (s.distance >= 50 ? ` · Ø ${fmtPace(t / (s.distance / 1000))}` : '');
    const gap = (track ? track.distance : 0) - s.distance;
    diffEl.className = 'host-diff' + (gap < -20 ? ' behind' : '');
    diffEl.textContent = Math.abs(gap) <= 20 ? `Gleichauf mit ${host.name}` : gap > 0 ? `${fmtGap(gap)} vor ${host.name}` : `${fmtGap(-gap)} hinter ${host.name}`;
    box.hidden = false;
  }

  function renderBoard() {
    const ul = $('#board');
    ul.textContent = '';
    // Nur wer online ist oder in diesem Lauf schon Strecke hat
    const list = roster.filter((u) => u.online || u.stats.distance > 0).sort((a, b) => {
      if (a.stats.finished !== b.stats.finished) return a.stats.finished ? -1 : 1;
      if (a.stats.finished) return a.stats.finishMs - b.stats.finishMs;
      return b.stats.distance - a.stats.distance || a.name.localeCompare(b.name);
    });
    $('#boardCount').textContent = `· ${list.filter((u) => u.online).length} online`;
    list.forEach((u, i) => {
      const s = u.stats;
      const li = document.createElement('li');
      if (me && u.id === me.id) li.classList.add('me');
      if (!u.online) li.classList.add('offline');
      const pos = document.createElement('div'); pos.className = 'pos'; pos.textContent = s.finished ? '🏁' : i + 1;
      const who = document.createElement('div'); who.className = 'who';
      who.textContent = u.name + (u.inCall ? ' 🎧' : '');
      if (u.organizer) who.append(el('span', 'host-tag', '⭐ Hauptläufer'));
      const small = document.createElement('small');
      small.textContent = !u.online ? 'offline' : s.finished ? `im Ziel nach ${fmtTime(s.finishMs)}`
        : s.splits.length ? `letzter km ${fmtPace(s.splits[s.splits.length - 1])}` : run.status === 'running' ? 'unterwegs' : 'bereit';
      who.append(small);
      const nums = document.createElement('div'); nums.className = 'nums';
      nums.textContent = fmtKm(s.distance) + ' km';
      const p = document.createElement('small');
      const t = s.finished ? s.finishMs : s.elapsed;
      p.textContent = s.distance >= 50 ? `Ø ${fmtPace(t / (s.distance / 1000))} /km` : 'Ø –:––';
      nums.append(p);
      li.append(pos, who, nums);
      ul.append(li);
    });
  }

  // ---------- Organisator ----------
  function renderAdmin() {
    if (!me || !me.admin) return;
    const idle = run.status === 'idle';
    $('#btnStart').hidden = !idle;
    $('#btnStop').hidden = run.status !== 'running';
    $('#btnReset').hidden = idle;
    for (const id of ['#cfgTitle', '#cfgTarget', '#cfgCountdown', '#cfgEvent']) $(id).disabled = !idle;
    const sel = $('#cfgEvent');
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '– freier Lauf ohne Event –';
    sel.append(none);
    for (const ev of events.filter((e) => !e.done || e.id === run.eventId)) {
      const o = document.createElement('option');
      o.value = ev.id;
      o.textContent = `${ev.title} (${fmtDate(ev.at)})`;
      sel.append(o);
    }
    sel.value = run.eventId || '';
    if (document.activeElement !== $('#cfgTitle')) $('#cfgTitle').value = run.title;
    if (document.activeElement !== $('#cfgTarget')) $('#cfgTarget').value = run.targetKm;
    $('#adminInfo').textContent = idle
      ? 'Der Start löst auf allen angemeldeten Geräten gleichzeitig den Countdown und die Messung aus.'
      : run.status === 'running' ? '„Lauf beenden“ stoppt die Messung bei allen und speichert die Rangliste dauerhaft.'
        : 'Die Rangliste ist unter „Gespeicherte Läufe“ abgelegt. „Neuen Lauf vorbereiten“ leert nur die Live-Ansicht.';
  }
  const sendConfig = () => send({
    t: 'config', title: $('#cfgTitle').value, eventId: $('#cfgEvent').value || null,
    targetKm: parseFloat($('#cfgTarget').value.replace(',', '.')) || 0,
  });
  $('#cfgEvent').addEventListener('change', () => {
    const ev = events.find((e) => e.id === $('#cfgEvent').value);
    if (ev) { $('#cfgTitle').value = ev.title; $('#cfgTarget').value = ev.targetKm; }
    sendConfig();
  });
  $('#cfgTitle').addEventListener('change', sendConfig);
  $('#cfgTarget').addEventListener('change', sendConfig);
  $('#btnStart').addEventListener('click', () => {
    sendConfig();
    const n = roster.filter((u) => u.online).length;
    if (confirm(`Lauf jetzt für alle ${n} Teilnehmer starten?`)) send({ t: 'start', countdown: parseInt($('#cfgCountdown').value, 10) || 10 });
  });
  $('#btnStop').addEventListener('click', () => { if (confirm('Lauf für alle beenden und die Rangliste speichern?')) send({ t: 'stop' }); });
  $('#btnReset').addEventListener('click', () => { if (confirm('Rangliste leeren und neuen Lauf vorbereiten?')) send({ t: 'reset' }); });

  // ---------- Events & Zusagen ----------
  const nameById = (id) => (roster.find((u) => u.id === id) || {}).name;
  function renderEvents() {
    const box = $('#events');
    box.textContent = '';
    const list = [...events].sort((a, b) => a.done - b.done || a.at - b.at);
    if (!list.length) box.append(el('div', 'empty-note', 'Noch kein Event geplant.'));
    let unanswered = 0;
    for (const ev of list) {
      const mine = me ? ev.rsvp[me.id] : null;
      if (!ev.done && !mine) unanswered++;
      const yes = [], no = [];
      for (const [id, a] of Object.entries(ev.rsvp)) {
        const n = nameById(id);
        if (n) (a === 'yes' ? yes : no).push(n);
      }
      const pending = roster.filter((u) => !ev.rsvp[u.id]).map((u) => u.name);

      const card = el('div', 'event' + (ev.done ? ' done' : '') + (ev.id === focusEvent ? ' highlight' : ''));
      card.append(el('h3', null, ev.title + (ev.done ? ' – abgeschlossen' : '')));
      card.append(el('div', 'when', `${fmtDate(ev.at)} Uhr` + (ev.targetKm > 0 ? ` · ${String(ev.targetKm).replace('.', ',')} km` : '')));
      if (ev.note) card.append(el('div', 'note', ev.note));
      card.append(el('div', 'counts', `✅ ${yes.length} dabei · ❌ ${no.length} nicht dabei · ❔ ${pending.length} offen`));
      if (yes.length) card.append(el('div', 'names', 'Dabei: ' + yes.join(', ')));
      if (me && me.admin) {
        if (no.length) card.append(el('div', 'names', 'Nicht dabei: ' + no.join(', ')));
        if (pending.length) card.append(el('div', 'names', 'Noch offen: ' + pending.join(', ')));
      }

      const actions = el('div', 'actions');
      if (!ev.done) {
        const bYes = el('button', 'btn yes' + (mine === 'yes' ? ' on' : ''), '✅ Bin dabei');
        const bNo = el('button', 'btn no' + (mine === 'no' ? ' on' : ''), '❌ Nicht dabei');
        bYes.addEventListener('click', () => send({ t: 'rsvp', eventId: ev.id, answer: mine === 'yes' ? null : 'yes' }));
        bNo.addEventListener('click', () => send({ t: 'rsvp', eventId: ev.id, answer: mine === 'no' ? null : 'no' }));
        const bShare = el('button', 'btn', '🔗 Einladung teilen');
        bShare.addEventListener('click', () => shareEvent(ev));
        actions.append(bYes, bNo, bShare);
      }
      if (me && me.admin) {
        const bDel = el('button', 'btn small', 'Löschen');
        bDel.addEventListener('click', () => { if (confirm(`Event „${ev.title}“ mit allen Zusagen löschen?`)) send({ t: 'event:delete', id: ev.id }); });
        actions.append(bDel);
      }
      card.append(actions);
      box.append(card);
    }
    $('#eventBadge').hidden = unanswered === 0 || activeTab === 'community';
  }

  async function shareEvent(ev) {
    const url = `${SERVER || location.origin}/?event=${encodeURIComponent(ev.id)}`;
    const text = `Community Run: ${ev.title} am ${fmtDate(ev.at)} Uhr – bist du dabei? Hier zu- oder absagen:`;
    try {
      if (navigator.share) await navigator.share({ title: ev.title, text, url });
      else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Einladungstext mit Link kopiert.'); }
    } catch {}
  }

  $('#btnEvCreate').addEventListener('click', () => {
    const title = $('#evTitle').value.trim();
    const at = new Date($('#evAt').value).getTime();
    if (!title || !Number.isFinite(at)) { toast('Bitte Titel sowie Datum und Uhrzeit angeben.'); return; }
    send({ t: 'event:create', title, at, targetKm: parseFloat($('#evTarget').value.replace(',', '.')) || 0, note: $('#evNote').value });
    $('#evTitle').value = '';
    $('#evNote').value = '';
    toast('Event angelegt – alle Mitglieder sehen es jetzt in „Community“.');
  });

  // ---------- Gespeicherte Läufe ----------
  const openResults = new Set();
  function renderHistory() {
    const box = $('#history');
    box.className = 'history';
    box.textContent = '';
    if (!results.length) { box.append(el('div', 'empty-note', 'Noch kein Lauf gespeichert. Nach „Lauf beenden“ erscheint die Rangliste hier.')); return; }
    for (const r of results) {
      const d = el('details');
      d.open = openResults.has(r.id);
      d.addEventListener('toggle', () => (d.open ? openResults.add(r.id) : openResults.delete(r.id)));
      const s = el('summary', null, r.title);
      s.append(el('small', null, `${fmtDate(r.startAt)} Uhr · ${r.ranking.length} Teilnehmer · ${r.targetKm > 0 ? String(r.targetKm).replace('.', ',') + ' km' : 'offene Distanz'}`));
      d.append(s);
      if (me && me.admin) {
        const tools = el('div', 'tools');
        const bCsv = el('button', 'btn small', 'Als Tabelle (CSV) laden');
        bCsv.addEventListener('click', () => downloadCsv(r));
        const bDel = el('button', 'btn small', 'Löschen');
        bDel.addEventListener('click', () => { if (confirm(`Gespeicherten Lauf „${r.title}“ endgültig löschen?`)) send({ t: 'result:delete', id: r.id }); });
        tools.append(bCsv, bDel);
        d.append(tools);
      }
      const ol = el('ol');
      r.ranking.forEach((x, i) => {
        const li = el('li');
        const nums = el('div', 'nums', fmtKm(x.distance) + ' km');
        nums.append(el('small', null, `${fmtTime(x.timeMs)} · Ø ${x.distance >= 50 ? fmtPace(x.timeMs / (x.distance / 1000)) : '–:––'}`));
        li.append(el('div', 'pos', i + 1), el('div', null, x.name + (x.finished ? ' 🏁' : '')), nums);
        ol.append(li);
      });
      d.append(ol);
      box.append(d);
    }
  }

  function downloadCsv(r) {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['Platz', 'Name', 'Distanz (km)', 'Zeit', 'Ø Pace (min/km)', 'Im Ziel', 'Kilometer-Runden']];
    r.ranking.forEach((x, i) => rows.push([
      i + 1, x.name, fmtKm(x.distance), fmtTime(x.timeMs), x.distance >= 50 ? fmtPace(x.timeMs / (x.distance / 1000)) : '',
      x.finished ? 'ja' : 'nein', x.splits.map(fmtPace).join(' | '),
    ]));
    const csv = '﻿' + rows.map((row) => row.map(q).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${r.title.replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'Lauf'} ${fmtDay(r.startAt)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- Mitglieder (nur Organisator) ----------
  function renderMembers() {
    if (!me || !me.admin) return;
    const ul = $('#members');
    ul.textContent = '';
    $('#memberCount').textContent = `· ${members.length}`;
    const online = new Set(roster.filter((u) => u.online).map((u) => u.id));
    for (const m of [...members].sort((a, b) => a.name.localeCompare(b.name))) {
      const li = el('li');
      const who = el('div', 'who', m.name + (m.organizer ? ' ⭐' : ''));
      who.append(el('small', null, m.email));
      const info = el('small', online.has(m.id) ? 'on' : null,
        `dabei seit ${fmtDay(m.joinedAt)} · ${m.runs} ${m.runs === 1 ? 'Lauf' : 'Läufe'} · ${online.has(m.id) ? 'gerade online' : 'zuletzt ' + fmtDay(m.lastSeen)}`);
      who.append(info);
      li.append(who);
      if (m.id !== me.id) {
        const b = el('button', 'btn small', 'Entfernen');
        b.addEventListener('click', () => { if (confirm(`${m.name} aus der Community entfernen?`)) send({ t: 'member:remove', id: m.id }); });
        li.append(b);
      }
      ul.append(li);
    }
  }
  $('#btnCopyMails').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(members.map((m) => m.email).join('; '));
      toast(`${members.length} E-Mail-Adressen kopiert.`);
    } catch { toast('Kopieren nicht möglich.'); }
  });

  // ---------- Als App installieren ----------
  let installEvt = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
    $('#btnInstall').hidden = false;
    $('#btnInstall2').hidden = false;
    $('#installInfo').hidden = true;
  });
  const doInstall = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null;
    $('#btnInstall').hidden = true;
    $('#btnInstall2').hidden = true;
  };
  $('#btnInstall').addEventListener('click', doInstall);
  $('#btnInstall2').addEventListener('click', doInstall);
  if (standalone) $('#installInfo').textContent = 'Die App ist auf diesem Gerät installiert.';
  else if (isIos) {
    $('#iosHint').hidden = false;
    $('#installInfo').textContent = 'App-Icon: in Safari unten auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.';
  }
  $('#btnLogout').addEventListener('click', () => {
    stopReconnect = true;
    if (ws) ws.close();
    location.reload();
  });

  // ---------- Chat ----------
  function addChat(c, initial) {
    const list = $('#chatList');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const div = document.createElement('div');
    if (c.sys) {
      div.className = 'msg sys';
      div.textContent = c.text;
    } else {
      const mine = me && c.from === me.id;
      div.className = 'msg' + (mine ? ' me' : '');
      const head = document.createElement('div');
      const from = document.createElement('span'); from.className = 'from'; from.textContent = mine ? 'Du' : c.name;
      const time = document.createElement('span'); time.className = 'time';
      const d = new Date(c.at); time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      head.append(from, time);
      const body = document.createElement('div'); body.textContent = c.text;
      div.append(head, body);
    }
    list.append(div);
    if (initial) return;
    if (activeTab === 'chat') { if (nearBottom) scrollChat(); }
    else if (!c.sys && !(me && c.from === me.id)) {
      unread++;
      $('#chatBadge').hidden = false;
      toast(`💬 ${c.name}: ${c.text.slice(0, 80)}`);
    }
  }
  const scrollChat = () => { const l = $('#chatList'); l.scrollTop = l.scrollHeight; };
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    $('#chatInput').value = '';
  });

  // ---------- Tabs ----------
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.id === 'tab-' + name));
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'chat') { unread = 0; $('#chatBadge').hidden = true; scrollChat(); }
    if (name === 'community') { $('#eventBadge').hidden = true; renderEvents(); renderMembers(); }
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- Audio/Video (WebRTC, jeder mit jedem) ----------
  const peers = new Map(); // id -> { pc, tile, video, audio, pending, ready, audioSender, videoSender }
  let inCall = false, micTrack = null, camTrack = null, micOn = true, selfTile = null;
  const nameOf = (id) => (roster.find((u) => u.id === id) || {}).name || 'Teilnehmer';

  function makeTile(label, self) {
    const tile = document.createElement('div'); tile.className = 'tile' + (self ? ' self' : '');
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = initials(label);
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; video.hidden = true;
    const name = document.createElement('div'); name.className = 'name'; name.textContent = label;
    tile.append(avatar, video, name);
    $('#tiles').append(tile);
    return { tile, video, name };
  }

  async function joinCall(withVideo) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Ton/Video braucht eine sichere Verbindung (https).', 6000);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: withVideo ? { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } : false,
      });
    } catch {
      toast('Mikrofon/Kamera konnte nicht geöffnet werden – bitte Zugriff erlauben.', 6000);
      return;
    }
    unlockAudio();
    micTrack = stream.getAudioTracks()[0] || null;
    camTrack = stream.getVideoTracks()[0] || null;
    micOn = true;
    inCall = true;
    $('#callLobby').hidden = true;
    $('#callRoom').hidden = false;
    selfTile = makeTile('Du', true);
    updateSelf();
    send({ t: 'call:join', video: !!camTrack, audio: true });
  }

  function updateSelf() {
    if (!selfTile) return;
    selfTile.video.hidden = !camTrack;
    selfTile.video.srcObject = camTrack ? new MediaStream([camTrack]) : null;
    $('#btnMic').classList.toggle('off', !micOn);
    $('#btnMic').textContent = micOn ? '🎙️' : '🔇';
    $('#btnCam').classList.toggle('off', !camTrack);
  }

  function makePeer(id, initiator) {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers });
    const p = { pc, pending: [], ready: false, audioSender: null, videoSender: null, ...makeTile(nameOf(id), false) };
    p.audio = document.createElement('audio');
    p.audio.autoplay = true;
    p.tile.append(p.audio);
    peers.set(id, p);

    pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'rtc', to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      const el = e.track.kind === 'audio' ? p.audio : p.video;
      el.srcObject = new MediaStream([e.track]);
      el.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peers.get(id) === p) {
        toast(`Verbindung zu ${nameOf(id)} fehlgeschlagen.`);
        closePeer(id);
      }
    };
    if (initiator) {
      p.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      p.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      if (micTrack) p.audioSender.replaceTrack(micTrack);
      if (camTrack) p.videoSender.replaceTrack(camTrack);
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } }))
        .catch((err) => console.warn('offer', err));
    }
    renderCallMeta();
    return p;
  }

  async function onRtc(from, data) {
    if (!inCall || !data) return;
    let p = peers.get(from);
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        p = makePeer(from, false);
        await p.pc.setRemoteDescription(data.sdp);
        for (const tr of p.pc.getTransceivers()) {
          tr.direction = 'sendrecv';
          if (tr.receiver.track.kind === 'audio') { p.audioSender = tr.sender; if (micTrack) await tr.sender.replaceTrack(micTrack); }
          else { p.videoSender = tr.sender; if (camTrack) await tr.sender.replaceTrack(camTrack); }
        }
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        send({ t: 'rtc', to: from, data: { sdp: p.pc.localDescription } });
      } else if (p) {
        await p.pc.setRemoteDescription(data.sdp);
      } else return;
      p.ready = true;
      for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate && p) {
      if (p.ready) await p.pc.addIceCandidate(data.candidate).catch(() => {});
      else p.pending.push(data.candidate);
    }
  }

  function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch {}
    p.tile.remove();
  }
  function closeAllPeers() { [...peers.keys()].forEach(closePeer); }

  function leaveCall() {
    send({ t: 'call:leave' });
    closeAllPeers();
    if (micTrack) micTrack.stop();
    if (camTrack) camTrack.stop();
    micTrack = camTrack = null;
    inCall = false;
    if (selfTile) selfTile.tile.remove();
    selfTile = null;
    $('#callLobby').hidden = false;
    $('#callRoom').hidden = true;
    renderCallMeta();
  }

  async function toggleCam() {
    if (camTrack) {
      camTrack.stop();
      camTrack = null;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } });
        camTrack = s.getVideoTracks()[0];
      } catch {
        toast('Kamera konnte nicht geöffnet werden.');
        return;
      }
    }
    for (const p of peers.values()) if (p.videoSender) p.videoSender.replaceTrack(camTrack).catch(() => {});
    updateSelf();
    send({ t: 'call:state', video: !!camTrack, audio: micOn });
  }
  function toggleMic() {
    micOn = !micOn;
    if (micTrack) micTrack.enabled = micOn;
    updateSelf();
    send({ t: 'call:state', video: !!camTrack, audio: micOn });
  }

  // Namen, Kamera-/Mikrofonstatus der anderen und "Call läuft"-Hinweis
  function renderCallMeta() {
    const others = roster.filter((u) => u.inCall && (!me || u.id !== me.id));
    $('#callBadge').hidden = inCall || others.length === 0;
    $('#callWho').textContent = others.length ? `Gerade im Call: ${others.map((u) => u.name).join(', ')}.` : 'Noch ist niemand im Call.';
    for (const [id, p] of peers) {
      const u = roster.find((x) => x.id === id);
      if (!u) continue;
      p.name.textContent = u.name + (u.audio ? '' : ' 🔇');
      p.video.hidden = !u.video;
    }
  }

  $('#btnJoinAudio').addEventListener('click', () => joinCall(false));
  $('#btnJoinVideo').addEventListener('click', () => joinCall(true));
  $('#btnLeave').addEventListener('click', leaveCall);
  $('#btnCam').addEventListener('click', toggleCam);
  $('#btnMic').addEventListener('click', toggleMic);

  // ---------- Anmeldung ----------
  $('#nameInput').value = store.get('name') || '';
  $('#emailInput').value = store.get('email') || '';
  let gpsStarted = false;
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    myName = $('#nameInput').value.trim();
    myEmail = $('#emailInput').value.trim();
    if (!myName || !myEmail) return;
    pin = $('#pinInput').value.trim();
    $('#pinInput').value = '';
    store.set('name', myName);
    store.set('email', myEmail);
    $('#loginError').hidden = true;
    unlockAudio();     // Töne brauchen eine Nutzer-Geste
    keepAwake();
    if (!gpsStarted) { gpsStarted = true; startGps(); }
    stopReconnect = false;
    connect();
  });
})();
