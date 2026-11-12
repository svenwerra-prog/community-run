/* Community Run – Client */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  // Testhilfen: ?sim=3 simuliert einen Lauf mit 3 m/s, ?u=xyz trennt mehrere Test-Teilnehmer im selben Browser
  const SIM = params.has('sim') ? parseFloat(params.get('sim')) || 3 : 0;
  const NS = 'cr_' + (params.get('u') || '') + '_';
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
  let me = null, myName = '', pin = '';
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
    if (!$('#voiceToggle').checked || !('speechSynthesis' in window)) return;
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
  document.addEventListener('visibilitychange', () => { if (loggedIn) keepAwake(); });

  // Server wach halten: manche Hoster legen Gratis-Dienste ohne normale Seitenaufrufe schlafen
  setInterval(() => { if (loggedIn) fetch('/healthz', { cache: 'no-store' }).catch(() => {}); }, 4 * 60 * 1000);

  // ---------- Verbindung ----------
  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => {
      send({ t: 'hello', token, name: myName, pin: pin || undefined });
      bestRtt = Infinity;
      for (let i = 0; i < 5; i++) setTimeout(() => send({ t: 'ping', t0: Date.now() }), i * 400);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      connected = false;
      renderBadges();
      if (inCall) closeAllPeers();
      if (!stopReconnect) setTimeout(connect, 2000);
    };
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
        roster = m.roster || [];
        $('#login').hidden = true;
        $('#app').hidden = false;
        $('#adminPanel').hidden = !me.admin;
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
        roster = m.roster;
        renderBoard();
        renderCallMeta();
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
    const t = now();
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

  function sendStats() {
    if (!track || run.status === 'idle') return;
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

  function renderBoard() {
    const ul = $('#board');
    ul.textContent = '';
    const list = [...roster].sort((a, b) => {
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
      who.textContent = u.name + (u.admin ? ' ⭐' : '') + (u.inCall ? ' 🎧' : '');
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
    for (const id of ['#cfgTitle', '#cfgTarget', '#cfgCountdown']) $(id).disabled = !idle;
    if (document.activeElement !== $('#cfgTitle')) $('#cfgTitle').value = run.title;
    if (document.activeElement !== $('#cfgTarget')) $('#cfgTarget').value = run.targetKm;
    $('#adminInfo').textContent = idle
      ? 'Der Start löst auf allen angemeldeten Geräten gleichzeitig den Countdown und die Messung aus.'
      : run.status === 'running' ? '„Lauf beenden“ stoppt die Messung bei allen.' : 'Mit „Neuen Lauf vorbereiten“ wird die Rangliste geleert.';
  }
  const sendConfig = () => send({ t: 'config', title: $('#cfgTitle').value, targetKm: parseFloat($('#cfgTarget').value.replace(',', '.')) || 0 });
  $('#cfgTitle').addEventListener('change', sendConfig);
  $('#cfgTarget').addEventListener('change', sendConfig);
  $('#btnStart').addEventListener('click', () => {
    sendConfig();
    const n = roster.filter((u) => u.online).length;
    if (confirm(`Lauf jetzt für alle ${n} Teilnehmer starten?`)) send({ t: 'start', countdown: parseInt($('#cfgCountdown').value, 10) || 10 });
  });
  $('#btnStop').addEventListener('click', () => { if (confirm('Lauf für alle beenden?')) send({ t: 'stop' }); });
  $('#btnReset').addEventListener('click', () => { if (confirm('Rangliste leeren und neuen Lauf vorbereiten?')) send({ t: 'reset' }); });

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
  let gpsStarted = false;
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    myName = $('#nameInput').value.trim();
    if (!myName) return;
    pin = $('#pinInput').value.trim();
    $('#pinInput').value = '';
    store.set('name', myName);
    $('#loginError').hidden = true;
    unlockAudio();     // Töne brauchen eine Nutzer-Geste
    keepAwake();
    if (!gpsStarted) { gpsStarted = true; startGps(); }
    stopReconnect = false;
    connect();
  });
})();
