(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const media = $('#media');
  const stage = $('#stage');

  const SPEED_MIN = 0.25;
  const SPEED_MAX = 4;
  const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  const state = {
    items: [],        // { file, url, name, kind, duration }
    index: -1,
    a: null,
    b: null,
    seeking: false,
    lastSpeed: 1.5,   // R 키로 1배속 <-> 직전 배속 전환
    lastSave: 0,
  };

  /* ---------- storage (실패해도 동작하도록) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ---------- helpers ---------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const speedLabel = (v) => `${+v.toFixed(2)}×`;
  const posKey = (it) => `pos:${it.file.name}:${it.file.size}`;
  function setFill(input) {
    const min = +input.min, max = +input.max;
    input.style.setProperty('--p', `${((+input.value - min) / (max - min)) * 100}%`);
  }

  let toastTimer;
  function toast(msg, ms = 1800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  let badgeTimer;
  function flashBadge(text) {
    const el = $('#speedBadge');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => el.classList.remove('show'), 900);
  }

  /* ---------- speed ---------- */
  const presetWrap = $('#presets');
  PRESETS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = speedLabel(p);
    b.title = `${speedLabel(p)} (${i + 1})`;
    b.dataset.speed = p;
    b.addEventListener('click', () => setSpeed(p));
    presetWrap.appendChild(b);
  });

  function setSpeed(v, { silent = false } = {}) {
    v = round2(clamp(v, SPEED_MIN, SPEED_MAX));
    const cur = media.playbackRate;
    if (cur !== 1 && v === 1) state.lastSpeed = cur;
    media.defaultPlaybackRate = v;
    media.playbackRate = v;
    store.set('speed', v);
    renderSpeed();
    if (!silent) flashBadge(speedLabel(v));
  }

  function renderSpeed() {
    const v = media.playbackRate;
    $('#speedOut').textContent = speedLabel(v);
    const r = $('#speedRange');
    r.value = v;
    setFill(r);
    presetWrap.querySelectorAll('.btn').forEach((b) => b.classList.toggle('on', +b.dataset.speed === v));
    renderRemain();
  }

  function renderRemain() {
    const d = media.duration;
    const el = $('#remain');
    if (!isFinite(d) || d <= 0) { el.textContent = ''; return; }
    const left = (d - media.currentTime) / media.playbackRate;
    const saved = d - d / media.playbackRate;
    let txt = `남은 시간 ${fmt(left)}`;
    if (media.playbackRate > 1) txt += ` · 전체 ${fmt(saved)} 절약`;
    el.textContent = txt;
  }

  $('#speedRange').addEventListener('input', (e) => setSpeed(+e.target.value));
  $('#slower').addEventListener('click', () => setSpeed(media.playbackRate - 0.05));
  $('#faster').addEventListener('click', () => setSpeed(media.playbackRate + 0.05));

  function setPitch(on) {
    media.preservesPitch = on;
    media.mozPreservesPitch = on;
    media.webkitPreservesPitch = on;
    store.set('preservePitch', on);
  }
  $('#pitchToggle').addEventListener('change', (e) => setPitch(e.target.checked));

  /* ---------- files / playlist ---------- */
  const isMediaFile = (f) => /^(audio|video)\//.test(f.type) ||
    /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba|mp4|m4v|mov|webm|mkv|3gp)$/i.test(f.name);

  function addFiles(fileList) {
    const files = [...fileList].filter(isMediaFile);
    if (!files.length) { toast('재생할 수 있는 동영상/음원 파일이 아닙니다'); return; }
    const start = state.items.length;
    for (const file of files) {
      state.items.push({
        file,
        url: URL.createObjectURL(file),
        name: file.name,
        kind: file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i.test(file.name) ? 'audio' : 'video',
        duration: NaN,
      });
    }
    renderPlaylist();
    if (state.index === -1 || media.ended || media.paused) load(start, { autoplay: true });
    else toast(`${files.length}개 파일을 재생 목록에 추가했습니다`);
  }

  function load(i, { autoplay = false } = {}) {
    if (i < 0 || i >= state.items.length) return;
    saveProgress(true);
    state.index = i;
    const it = state.items[i];
    clearAB();
    media.src = it.url;
    media.load();
    stage.classList.remove('empty');
    $('#audioTitle').textContent = it.name;
    setAudioMode(it.kind === 'audio');
    document.title = `${it.name} · 배속 플레이어`;
    $('#seek').disabled = false;
    renderPlaylist();
    updateMediaSession(it);
    if (autoplay) {
      const p = media.play();
      if (p && p.catch) p.catch(() => { /* 자동재생 차단 시 사용자가 누르면 재생 */ });
    }
  }

  function setAudioMode(on) {
    stage.classList.toggle('audio', on);
    $('#audioArt').hidden = !on;
    $('#fsBtn').disabled = on;
  }

  function renderPlaylist() {
    const ol = $('#playlist');
    ol.innerHTML = '';
    state.items.forEach((it, i) => {
      const li = document.createElement('li');
      if (i === state.index) li.classList.add('active');
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = it.kind === 'audio' ? '🎵' : '🎬';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = it.name;
      name.title = it.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = isFinite(it.duration) ? fmt(it.duration) : '';
      const rm = document.createElement('button');
      rm.className = 'btn ghost remove';
      rm.setAttribute('aria-label', `${it.name} 목록에서 제거`);
      rm.textContent = '✕';
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeItem(i); });
      li.append(kind, name, meta, rm);
      li.addEventListener('click', () => load(i, { autoplay: true }));
      ol.appendChild(li);
    });
    const empty = state.items.length === 0;
    $('#playlistEmpty').hidden = !empty;
    $('#clearList').hidden = empty;
    $('#prevBtn').disabled = state.index <= 0;
    $('#nextBtn').disabled = state.index < 0 || state.index >= state.items.length - 1;
  }

  function removeItem(i) {
    const it = state.items[i];
    const wasCurrent = i === state.index;
    if (wasCurrent) saveProgress(true);
    state.items.splice(i, 1);
    URL.revokeObjectURL(it.url);
    if (wasCurrent) {
      if (state.items.length) { load(Math.min(i, state.items.length - 1)); return; }
      resetPlayer();
    } else if (i < state.index) {
      state.index--;
    }
    renderPlaylist();
  }

  function resetPlayer() {
    state.index = -1;
    media.removeAttribute('src');
    media.load();
    stage.classList.add('empty');
    setAudioMode(false);
    $('#seek').disabled = true;
    $('#seek').value = 0; setFill($('#seek'));
    $('#curTime').textContent = '0:00';
    $('#durTime').textContent = '0:00';
    document.title = '배속 플레이어';
    clearAB();
    renderRemain();
  }

  $('#clearList').addEventListener('click', () => {
    saveProgress(true);
    state.items.forEach((it) => URL.revokeObjectURL(it.url));
    state.items = [];
    resetPlayer();
    renderPlaylist();
  });

  ['#fileInput', '#fileInput2'].forEach((sel) => {
    $(sel).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  });

  // drag & drop
  let dragDepth = 0;
  const overlay = $('#dropOverlay');
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; overlay.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  /* ---------- transport ---------- */
  function togglePlay() {
    if (state.index < 0) { $('#fileInput').click(); return; }
    if (media.paused || media.ended) media.play().catch(() => {}); else media.pause();
  }
  function skip(sec) {
    if (state.index < 0 || !isFinite(media.duration)) return;
    media.currentTime = clamp(media.currentTime + sec, 0, media.duration);
    flashBadge(`${sec > 0 ? '+' : '−'}${Math.abs(sec)}초`);
  }
  const next = () => { if (state.index < state.items.length - 1) load(state.index + 1, { autoplay: true }); };
  const prev = () => {
    if (media.currentTime > 3) { media.currentTime = 0; return; }
    if (state.index > 0) load(state.index - 1, { autoplay: true });
  };

  $('#playBtn').addEventListener('click', togglePlay);
  $('#back10').addEventListener('click', () => skip(-10));
  $('#fwd10').addEventListener('click', () => skip(10));
  $('#nextBtn').addEventListener('click', next);
  $('#prevBtn').addEventListener('click', prev);
  media.addEventListener('click', togglePlay);

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    state.seeking = true;
    setFill(seek);
    if (isFinite(media.duration)) $('#curTime').textContent = fmt((seek.value / 1000) * media.duration);
  });
  seek.addEventListener('change', () => {
    if (isFinite(media.duration)) media.currentTime = (seek.value / 1000) * media.duration;
    state.seeking = false;
  });

  function renderTime() {
    const d = media.duration;
    if (!state.seeking) {
      $('#curTime').textContent = fmt(media.currentTime);
      seek.value = isFinite(d) && d > 0 ? Math.round((media.currentTime / d) * 1000) : 0;
      setFill(seek);
    }
    $('#durTime').textContent = fmt(d);
    renderRemain();
  }

  /* ---------- A-B repeat ---------- */
  function setA() {
    if (state.index < 0) return;
    state.a = media.currentTime;
    if (state.b !== null && state.b <= state.a) state.b = null;
    toast(`A 지점: ${fmt(state.a)}`);
    renderAB();
  }
  function setB() {
    if (state.index < 0) return;
    const t = media.currentTime;
    if (state.a === null) { state.a = 0; }
    if (t <= state.a + 0.2) { toast('B 지점은 A 지점보다 뒤여야 합니다'); return; }
    state.b = t;
    media.currentTime = state.a;
    toast(`구간 반복: ${fmt(state.a)} ~ ${fmt(state.b)}`);
    renderAB();
  }
  function clearAB() { state.a = null; state.b = null; renderAB(); }
  function renderAB() {
    const d = media.duration;
    $('#aBtn').classList.toggle('on', state.a !== null);
    $('#bBtn').classList.toggle('on', state.b !== null);
    $('#abClear').hidden = state.a === null && state.b === null;
    const r = $('#abRange');
    if (state.a !== null && isFinite(d) && d > 0) {
      const end = state.b !== null ? state.b : media.currentTime;
      r.hidden = false;
      r.style.left = `${(state.a / d) * 100}%`;
      r.style.width = `${Math.max(0.5, ((Math.max(end, state.a) - state.a) / d) * 100)}%`;
    } else r.hidden = true;
  }
  $('#aBtn').addEventListener('click', setA);
  $('#bBtn').addEventListener('click', setB);
  $('#abClear').addEventListener('click', () => { clearAB(); toast('구간 반복 해제'); });

  /* ---------- loop / volume / fullscreen ---------- */
  const loopBtn = $('#loopBtn');
  loopBtn.addEventListener('click', () => {
    media.loop = !media.loop;
    loopBtn.setAttribute('aria-pressed', String(media.loop));
    toast(media.loop ? '현재 파일 반복 켜짐' : '반복 꺼짐');
  });

  const vol = $('#volume');
  vol.addEventListener('input', () => { media.volume = +vol.value; media.muted = media.volume === 0; });
  function toggleMute() { media.muted = !media.muted; }
  $('#muteBtn').addEventListener('click', toggleMute);
  $('#muteBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMute(); } });
  media.addEventListener('volumechange', () => {
    vol.value = media.muted ? 0 : media.volume;
    setFill(vol);
    $('#muteBtn').textContent = media.muted || media.volume === 0 ? '🔇' : media.volume < 0.5 ? '🔉' : '🔊';
    store.set('volume', media.volume);
  });

  function toggleFullscreen() {
    if (state.index < 0 || stage.classList.contains('audio')) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen(); // iOS
  }
  $('#fsBtn').addEventListener('click', toggleFullscreen);
  media.addEventListener('dblclick', toggleFullscreen);

  /* ---------- media events ---------- */
  media.addEventListener('loadedmetadata', () => {
    const it = state.items[state.index];
    if (!it) return;
    // 확장자로 판단하기 어려운 경우(영상 트랙 없는 mp4 등) 오디오 모드로
    if (media.videoWidth === 0 && media.videoHeight === 0) { it.kind = 'audio'; setAudioMode(true); }
    else if (it.kind === 'audio') { it.kind = 'video'; setAudioMode(false); }
    it.duration = media.duration;
    // src 변경 시 일부 브라우저가 속도를 초기화하므로 다시 적용
    media.playbackRate = media.defaultPlaybackRate;
    setPitch($('#pitchToggle').checked);
    // 이어보기
    const saved = store.get(posKey(it), 0);
    if (saved > 5 && isFinite(media.duration) && saved < media.duration - 5) {
      media.currentTime = saved;
      toast(`이어서 재생합니다 (${fmt(saved)})`);
    }
    renderPlaylist();
    renderTime();
    renderSpeed();
  });

  media.addEventListener('timeupdate', () => {
    if (state.a !== null && state.b !== null && media.currentTime >= state.b) {
      media.currentTime = state.a;
    }
    renderTime();
    if (state.a !== null && state.b === null) renderAB();
    saveProgress(false);
  });
  media.addEventListener('durationchange', renderTime);
  media.addEventListener('ratechange', () => {
    // 외부(시스템 컨트롤 등)에서 속도가 바뀐 경우 UI 동기화
    if (Math.abs(media.playbackRate - +$('#speedRange').value) > 0.001) renderSpeed();
  });

  function syncPlayState() {
    const playing = !media.paused && !media.ended;
    $('#playIcon').hidden = playing;
    $('#pauseIcon').hidden = !playing;
    $('#playBtn').setAttribute('aria-label', playing ? '일시정지' : '재생');
    stage.classList.toggle('playing', playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
  media.addEventListener('play', syncPlayState);
  media.addEventListener('pause', () => { syncPlayState(); saveProgress(true); });
  media.addEventListener('ended', () => {
    syncPlayState();
    const it = state.items[state.index];
    if (it) store.del(posKey(it));
    if (state.index < state.items.length - 1) next();
  });
  media.addEventListener('error', () => {
    if (state.index < 0 || !media.getAttribute('src')) return;
    toast('이 파일 형식은 현재 브라우저에서 재생할 수 없습니다', 3200);
  });

  function saveProgress(force) {
    const it = state.items[state.index];
    if (!it || !isFinite(media.duration)) return;
    const now = Date.now();
    if (!force && now - state.lastSave < 2000) return;
    state.lastSave = now;
    store.set(posKey(it), Math.floor(media.currentTime));
  }
  window.addEventListener('pagehide', () => saveProgress(true));

  /* ---------- media session (잠금화면/이어폰 컨트롤) ---------- */
  function updateMediaSession(it) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: it.name,
        artist: '배속 플레이어',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported */ } };
      set('play', () => media.play());
      set('pause', () => media.pause());
      set('seekbackward', (d) => skip(-(d.seekOffset || 10)));
      set('seekforward', (d) => skip(d.seekOffset || 10));
      set('previoustrack', prev);
      set('nexttrack', next);
      set('seekto', (d) => { if (d.seekTime != null) media.currentTime = d.seekTime; });
    } catch { /* ignore */ }
  }

  /* ---------- keyboard ---------- */
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if ($('#helpDialog').open) return;
    // 한글 입력 상태에서도 동작하도록 e.code 사용
    switch (e.code) {
      case 'Space': case 'KeyK':
        if (tag === 'button' && e.code === 'Space') return;
        e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': if (tag === 'input') return; e.preventDefault(); skip(-5); break;
      case 'ArrowRight': if (tag === 'input') return; e.preventDefault(); skip(5); break;
      case 'KeyJ': skip(-10); break;
      case 'KeyL': skip(10); break;
      case 'KeyS': case 'Minus': case 'BracketLeft': setSpeed(media.playbackRate - 0.1); break;
      case 'KeyD': case 'Equal': case 'BracketRight': setSpeed(media.playbackRate + 0.1); break;
      case 'KeyR': setSpeed(media.playbackRate === 1 ? state.lastSpeed : 1); break;
      case 'KeyA': setA(); break;
      case 'KeyB': setB(); break;
      case 'KeyC': if (state.a !== null) { clearAB(); toast('구간 반복 해제'); } break;
      case 'KeyM': toggleMute(); break;
      case 'KeyF': toggleFullscreen(); break;
      case 'KeyN': next(); break;
      case 'KeyP': prev(); break;
      case 'ArrowUp': if (tag === 'input') return; e.preventDefault(); media.muted = false; media.volume = clamp(media.volume + 0.05, 0, 1); flashBadge(`볼륨 ${Math.round(media.volume * 100)}%`); break;
      case 'ArrowDown': if (tag === 'input') return; e.preventDefault(); media.volume = clamp(media.volume - 0.05, 0, 1); flashBadge(`볼륨 ${Math.round(media.volume * 100)}%`); break;
      default: {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (m) setSpeed(PRESETS[+m[1] - 1]);
      }
    }
  });

  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());

  /* ---------- PWA install ---------- */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null;
    $('#installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('앱이 설치되었습니다'); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // 파일로 열기 (설치된 앱에서 "연결 프로그램"으로 열었을 때, 지원 브라우저 한정)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      addFiles(files);
    });
  }

  /* ---------- init ---------- */
  const savedPitch = store.get('preservePitch', true);
  $('#pitchToggle').checked = savedPitch;
  setPitch(savedPitch);
  media.volume = clamp(+store.get('volume', 1) || 1, 0, 1);
  vol.value = media.volume; setFill(vol);
  setSpeed(+store.get('speed', 1) || 1, { silent: true });
  setFill(seek);
  renderPlaylist();
  syncPlayState();
})();
