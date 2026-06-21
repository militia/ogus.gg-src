document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());

window.GamesTab = (function () {
  const DEFAULT_PLACE_IDS = [
    4796282774, 5872075530, 9825515356,
    134847171405831, 100337093788565, 6218169544,
    2609668898,
  ];
  const LS_KEY = 'ogus.games.custom';
  const LS_KEY_REMOVED = 'ogus.games.removed';
  const LS_KEY_UNI = 'ogus.games.universes';
  const RETRY_SECS = 60;
  const REFRESH_COOLDOWN = 8000;
  const MAX_GAMES = 50;

  const RBX_API = 'roproxy.com';

  const FALLBACK = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27%3E%3Crect width=%27100%27 height=%27100%27 fill=%27%231f1f23%27/%3E%3C/svg%3E";
  const ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;

  const WIFI_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/></svg>`;
  const onerr = `onerror="this.src='${FALLBACK}'"`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  let container, onlineEl, gamesCntEl, refreshBtn, noticeEl,
      addBtn, modal, closeBtn, formEl, inputEl, submitEl, errEl, listEl, resetBtn,
      linkEl, copyEl;
  let copyTimer = null;

  let games = null;
  let loaded = false;
  let loading = false;
  let rlActive = false;
  let retryTimer = null, countdownTimer = null;
  let refreshReady = true, cooldownTimer = null, cooldownLeft = 0;
  let resetArmed = false, resetTimer = null;

  const loadIds = key => {
    try { const a = JSON.parse(localStorage.getItem(key)); return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : []; }
    catch { return []; }
  };
  let customIds = loadIds(LS_KEY);
  let removedDefaults = loadIds(LS_KEY_REMOVED);
  function saveCustom()  { try { localStorage.setItem(LS_KEY, JSON.stringify(customIds)); } catch {} }
  function saveRemoved() { try { localStorage.setItem(LS_KEY_REMOVED, JSON.stringify(removedDefaults)); } catch {} }

  let universeCache = (function () {
    try { const o = JSON.parse(localStorage.getItem(LS_KEY_UNI)); return (o && typeof o === 'object') ? o : {}; }
    catch { return {}; }
  })();
  function saveUniverseCache() { try { localStorage.setItem(LS_KEY_UNI, JSON.stringify(universeCache)); } catch {} }
  const isDefaultId = id => DEFAULT_PLACE_IDS.includes(Number(id));
  const isPristine  = () => customIds.length === 0 && removedDefaults.length === 0;

  function allPlaceIds() {
    const seen = new Set(); const out = [];
    const defaults = DEFAULT_PLACE_IDS.filter(id => !removedDefaults.includes(Number(id)));
    for (const id of [...defaults, ...customIds]) {
      const n = Number(id);
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }

  function fmt(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toLocaleString();
  }
  function gameUrl(g) { return `https://www.roblox.com/games/${g.rootPlaceId}#!/game-instances`; }
  function boardLink() { return location.origin + '/games?games=' + allPlaceIds().join(','); }
  function updateShareLink() { if (linkEl) linkEl.value = boardLink(); }

  function importFromUrl() {
    let raw;
    try { raw = new URLSearchParams(location.search).get('games'); } catch { return; }
    if (!raw) return;
    const seen = new Set(), ids = [];
    for (const part of raw.split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); ids.push(n); }
      if (ids.length >= MAX_GAMES) break;
    }
    if (ids.length) {
      customIds = ids.filter(id => !isDefaultId(id));
      removedDefaults = DEFAULT_PLACE_IDS.filter(d => !ids.includes(Number(d)));
      saveCustom(); saveRemoved();
    }
    try { history.replaceState(history.state, '', '/games'); } catch {}
  }
  const bgStyleUrl = url => (url && url.startsWith('http')) ? `;--bg:url('${url}')` : '';

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.code = r.status; throw e; }
    return r.json();
  }

  async function loadGames(placeIds, prev) {
    prev = prev || new Map();
    let rateLimited = false, netCount = 0;

    let uniDirty = false;
    const resolved = await Promise.all(placeIds.map(async pid => {
      pid = Number(pid);
      if (universeCache[pid]) return { pid, uid: universeCache[pid], cat: 'ok' };
      try {
        const j = await getJson(`https://apis.${RBX_API}/universes/v1/places/${pid}/universe`);
        if (j.universeId) { universeCache[pid] = j.universeId; uniDirty = true; }
        return { pid, uid: j.universeId || null, cat: j.universeId ? 'ok' : 'missing' };
      } catch (e) {
        if (e.code === 429) { rateLimited = true; return { pid, uid: null, cat: 'rl' }; }
        if (e.code)         { return { pid, uid: null, cat: 'missing' }; }
        netCount++;         return { pid, uid: null, cat: 'net' };
      }
    }));
    if (uniDirty) saveUniverseCache();

    const uids = resolved.filter(r => r.uid).map(r => r.uid);
    let statsData = [], iconData = [], batchFailed = false;
    if (uids.length) {
      const ids = uids.join(',');
      try {
        const [stats, icons] = await Promise.all([
          getJson(`https://games.${RBX_API}/v1/games?universeIds=${ids}`),
          getJson(`https://thumbnails.${RBX_API}/v1/games/icons?universeIds=${ids}&size=256x256&format=Png`),
        ]);
        statsData = stats.data || [];
        iconData  = icons.data  || [];
      } catch (e) {
        batchFailed = true;
        if (e.code === 429) rateLimited = true;
        else if (!e.code)   netCount += uids.length;
      }
    }

    let okCount = 0;
    const entries = resolved.map(r => {
      const prevE = prev.get(r.pid);
      const keepPrev = () => { if (prevE && prevE.status === 'ok') { okCount++; return prevE; } return null; };

      if (r.uid) {
        const g = statsData.find(x => x.id === r.uid);
        if (g) {
          const icon = (iconData.find(x => x.targetId === r.uid) || {}).imageUrl;
          okCount++;
          return {
            placeId: r.pid, status: 'ok',
            rootPlaceId: g.rootPlaceId || r.pid,
            name: g.name || 'Unknown game',
            creator: (g.creator && g.creator.name) || '—',
            playing: g.playing || 0,
            icon: icon || FALLBACK,
          };
        }
        return keepPrev() || { placeId: r.pid, status: 'pending' };
      }

      if (r.cat === 'rl' || r.cat === 'net') return keepPrev() || { placeId: r.pid, status: 'pending' };
      return keepPrev() || { placeId: r.pid, status: 'missing' };
    });

    return {
      entries, rateLimited, okCount,
      netFailAll: placeIds.length > 0 && netCount >= placeIds.length,
    };
  }

  function okRow(g, i, max) {
    const empty = !g.playing;
    const stat = empty
      ? `<div class="gb-players empty"><span class="gb-off-icon">${WIFI_OFF_SVG}</span>0</div>
          <div class="gb-players-label">empty</div>`
      : `<div class="gb-players"><span class="live-dot"></span>${fmt(g.playing)}</div>
          <div class="gb-players-label">playing</div>`;
    return `<a class="gb-row${i === 0 ? ' top' : ''}${empty ? ' empty' : ''}" href="${gameUrl(g)}" target="_blank" rel="noopener" style="animation-delay:${i * 40}ms${bgStyleUrl(g.icon)}">
        <span class="gb-rank">${i + 1}</span>
        <img class="gb-icon" src="${g.icon}" alt="${esc(g.name)}" ${onerr}>
        <div class="gb-mid">
          <div class="gb-name">${esc(g.name)}</div>
          <div class="gb-creator">by ${esc(g.creator)}</div>
          <div class="gb-bar"><div class="gb-bar-fill" data-pct="${(g.playing / max * 100).toFixed(1)}"></div></div>
        </div>
        <div class="gb-stat">${stat}</div>
        <span class="gb-go">${ARROW_SVG}</span>
      </a>`;
  }

  function loadingRow(g, i) {
    const note = g.status === 'pending'
      ? (rlActive
          ? `<span class="live-dot retry"></span><span>Rate limited — retrying in <b data-retry-count>${RETRY_SECS}</b>s…</span>`
          : `<span class="live-dot retry"></span><span>Loading — retrying in <b data-retry-count>${RETRY_SECS}</b>s…</span>`)
      : `Couldn't load this place.`;
    return `<div class="gb-row loadingrow" style="animation-delay:${i * 40}ms">
        <span class="gb-rank">${i + 1}</span>
        <div class="gb-skel-box"></div>
        <div class="gb-mid">
          <div class="gb-load-id">Place ${g.placeId}</div>
          <div class="gb-load-note">${note}</div>
        </div>
        <div class="gb-stat"><div class="gb-skel-line" style="width:46px;height:16px;border-radius:6px"></div></div>
      </div>`;
  }

  function sortEntries(entries) {
    const ok   = entries.filter(e => e.status === 'ok').sort((a, b) => b.playing - a.playing);
    const rest = entries.filter(e => e.status !== 'ok');
    return [...ok, ...rest];
  }

  function buildRowEl(g, i, max) {
    const tpl = document.createElement('template');
    tpl.innerHTML = (g.status === 'ok' ? okRow(g, i, max) : loadingRow(g, i)).trim();
    const el = tpl.content.firstElementChild;
    el.dataset.place = g.placeId;
    el.dataset.status = g.status;
    el.style.order = i;
    return el;
  }

  function updateOkRow(el, g, i, max) {
    el.href = gameUrl(g);
    el.style.order = i;
    el.classList.toggle('top', i === 0);
    el.classList.toggle('empty', !g.playing);
    el.style.setProperty('--bg', (g.icon && g.icon.startsWith('http')) ? `url('${g.icon}')` : 'none');
    const rank = el.querySelector('.gb-rank'); if (rank) rank.textContent = i + 1;
    const img = el.querySelector('.gb-icon'); if (img && img.getAttribute('src') !== g.icon) img.src = g.icon;
    const nm = el.querySelector('.gb-name'); if (nm) nm.textContent = g.name;
    const cr = el.querySelector('.gb-creator'); if (cr) cr.textContent = 'by ' + g.creator;
    const fill = el.querySelector('.gb-bar-fill'); if (fill) fill.style.width = (g.playing / max * 100).toFixed(1) + '%';
    const stat = el.querySelector('.gb-stat');
    if (stat) stat.innerHTML = g.playing
      ? `<div class="gb-players"><span class="live-dot"></span>${fmt(g.playing)}</div><div class="gb-players-label">playing</div>`
      : `<div class="gb-players empty"><span class="gb-off-icon">${WIFI_OFF_SVG}</span>0</div><div class="gb-players-label">empty</div>`;
  }

  function render() {
    if (!games) return;
    container.className = 'games-render glow';
    const max = Math.max(...games.filter(g => g.status === 'ok').map(g => g.playing), 1);

    const existing = new Map();
    Array.from(container.children).forEach(el => {
      const pid = el.dataset && el.dataset.place;
      if (pid) existing.set(Number(pid), el); else el.remove();
    });

    const newFills = [];
    games.forEach((g, i) => {
      const pid = Number(g.placeId);
      const old = existing.get(pid);
      existing.delete(pid);
      if (old && old.dataset.status === g.status) {
        if (g.status === 'ok') {
          updateOkRow(old, g, i, max);
        } else {
          old.style.order = i;
          const r = old.querySelector('.gb-rank'); if (r) r.textContent = i + 1;
        }
      } else {
        if (old) old.remove();
        const el = buildRowEl(g, i, max);
        container.appendChild(el);
        const f = el.querySelector('[data-pct]'); if (f) newFills.push(f);
      }
    });
    existing.forEach(el => el.remove());

    if (newFills.length) requestAnimationFrame(() => newFills.forEach(f => { f.style.width = f.dataset.pct + '%'; }));
  }

  function renderSkeletons() {
    container.className = 'games-render skeletons';
    container.innerHTML = allPlaceIds().map(() => '<div class="gb-skel"></div>').join('');
  }

  function showError() {
    container.className = 'games-render';
    container.innerHTML = `<div class="games-error">Couldn't load games right now. Please try again in a bit.</div>`;
  }

  function animateCount(el, target) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = fmt(target); return;
    }
    const dur = 700, start = performance.now();
    (function step(now) {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    })(performance.now());
  }

  function updateSummary() {
    const total = games.reduce((s, g) => s + (g.status === 'ok' ? g.playing : 0), 0);
    animateCount(onlineEl, total);
    const n = games.length;
    gamesCntEl.innerHTML = 'across <b>' + n + '</b> game' + (n === 1 ? '' : 's');
  }

  function clearRetry() { clearTimeout(retryTimer); clearInterval(countdownTimer); retryTimer = countdownTimer = null; }
  function hideNotice() { noticeEl.hidden = true; noticeEl.innerHTML = ''; clearRetry(); }
  function updateRowCountdowns(left) {
    container.querySelectorAll('[data-retry-count]').forEach(b => { b.textContent = Math.max(0, left); });
  }
  function scheduleRetry(rateLimited) {
    clearRetry();
    let left = RETRY_SECS;
    const msg = rateLimited
      ? 'Roblox is rate-limiting requests — some games are still loading. Retrying in'
      : "Some games couldn't load — retrying in";
    noticeEl.hidden = false;
    const cooling = !refreshReady;
    noticeEl.innerHTML = `<span class="gn-ico">⚠</span><span class="gn-msg">${msg} <b id="rl-count">${left}</b>s.</span><button class="gn-retry${cooling ? ' cooling' : ''}" type="button"${cooling ? ` data-cooldown="Retry ready in ${cooldownLeft}s"` : ''}>Retry now</button>`;
    const retryBtn = noticeEl.querySelector('.gn-retry');
    retryBtn.addEventListener('click', () => {
      if (!refreshReady || loading) { retryBtn.classList.add('cd-show'); return; }
      retryBtn.classList.add('cooling');
      clearRetry();
      load();
    });
    retryBtn.addEventListener('mouseenter', () => { if (!refreshReady) retryBtn.classList.add('cd-show'); });
    retryBtn.addEventListener('mouseleave', () => retryBtn.classList.remove('cd-show'));
    updateRowCountdowns(left);
    countdownTimer = setInterval(() => {
      left--;
      const c = noticeEl.querySelector('#rl-count'); if (c) c.textContent = Math.max(0, left);
      updateRowCountdowns(left);
      if (left <= 0) clearInterval(countdownTimer);
    }, 1000);
    retryTimer = setTimeout(load, RETRY_SECS * 1000);
  }

  function startRefreshCooldown() {
    refreshReady = false;
    refreshBtn.classList.add('cooling', 'spinning');
    setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
    let left = Math.ceil(REFRESH_COOLDOWN / 1000);
    cooldownLeft = left;
    refreshBtn.dataset.cooldown = `Refresh ready in ${left}s`;
    updateRetryCooldown(left);
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      left--;
      cooldownLeft = Math.max(0, left);
      if (left <= 0) {
        clearInterval(cooldownTimer);
        refreshReady = true;
        refreshBtn.classList.remove('cooling', 'cd-show');
        refreshBtn.removeAttribute('data-cooldown');
        const rb = noticeEl.querySelector('.gn-retry');
        if (rb) { rb.classList.remove('cooling', 'cd-show'); rb.removeAttribute('data-cooldown'); }
      } else {
        refreshBtn.dataset.cooldown = `Refresh ready in ${left}s`;
        updateRetryCooldown(left);
      }
    }, 1000);
  }

  function updateRetryCooldown(left) {
    const rb = noticeEl.querySelector('.gn-retry');
    if (rb && rb.classList.contains('cooling')) rb.dataset.cooldown = `Retry ready in ${left}s`;
  }

  function load() {
    if (loading) return;
    loading = true;
    clearRetry();
    startRefreshCooldown();
    if (!games) renderSkeletons();
    const prev = new Map((games || []).map(g => [Number(g.placeId), g]));
    loadGames(allPlaceIds(), prev)
      .then(res => {
        if (res.netFailAll && res.okCount === 0 && !games) { showError(); return; }
        rlActive = res.rateLimited;
        games = sortEntries(res.entries);
        loaded = true;
        render();
        updateSummary();
        if (!modal.hidden) renderEditList();
        if (games.some(g => g.status === 'pending')) scheduleRetry(res.rateLimited);
        else hideNotice();
      })
      .catch(() => { if (!games) showError(); })
      .finally(() => { loading = false; });
  }

  function ensureLoaded() { if (!loaded && !loading) load(); }

  function parsePlaceId(raw) {
    const s = (raw || '').trim();
    if (!s) return { error: 'Paste a game link or place ID.' };
    if (/^\d+$/.test(s)) return { id: s };
    const m = s.match(/\/games\/(\d+)/i);
    if (m) return { id: m[1] };
    return { error: 'Enter a place ID or a roblox.com/games/… link.' };
  }
  function fieldError(msg) {
    inputEl.classList.add('invalid');
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function clearFieldError() {
    inputEl.classList.remove('invalid');
    errEl.hidden = true;
    errEl.textContent = '';
  }
  function setSubmitting(b) {
    submitEl.disabled = b;
    inputEl.disabled = b;
    submitEl.textContent = b ? 'Checking…' : 'Add';
  }

  async function buildEntry(placeId) {
    placeId = Number(placeId);
    let uid = universeCache[placeId];
    if (!uid) {
      const uni = await getJson(`https://apis.${RBX_API}/universes/v1/places/${placeId}/universe`);
      if (!uni || !uni.universeId) { const e = new Error('not found'); e.notFound = true; throw e; }
      uid = uni.universeId;
      universeCache[placeId] = uid; saveUniverseCache();
    }
    const [stats, icons] = await Promise.all([
      getJson(`https://games.${RBX_API}/v1/games?universeIds=${uid}`),
      getJson(`https://thumbnails.${RBX_API}/v1/games/icons?universeIds=${uid}&size=256x256&format=Png`),
    ]);
    const g = (stats.data || []).find(x => x.id === uid) || {};
    const icon = ((icons.data || []).find(x => x.targetId === uid) || {}).imageUrl;
    return {
      placeId: Number(placeId), status: 'ok',
      rootPlaceId: g.rootPlaceId || Number(placeId),
      name: g.name || 'Unknown game',
      creator: (g.creator && g.creator.name) || '—',
      playing: g.playing || 0,
      icon: icon || FALLBACK,
    };
  }

  function upsertGame(entry) {
    if (!games) games = [];
    const i = games.findIndex(g => Number(g.placeId) === Number(entry.placeId));
    if (i >= 0) games[i] = entry; else games.push(entry);
  }

  async function syncMissing() {
    const target = allPlaceIds();
    const targetSet = new Set(target);
    games = (games || []).filter(g => targetSet.has(Number(g.placeId)));
    const have = new Set(games.filter(g => g.status === 'ok').map(g => Number(g.placeId)));
    const missing = target.filter(id => !have.has(id));
    if (missing.length) {
      const res = await loadGames(missing, new Map(games.map(g => [Number(g.placeId), g])));
      res.entries.forEach(upsertGame);
      rlActive = res.rateLimited;
    }
  }

  async function tryAddGame() {
    clearFieldError();
    const { id, error } = parsePlaceId(inputEl.value);
    if (error) return fieldError(error);
    const idNum = Number(id);
    if (allPlaceIds().includes(idNum)) return fieldError('That game is already on your board.');
    if (allPlaceIds().length >= MAX_GAMES) return fieldError(`You can have up to ${MAX_GAMES} games on your board. Remove one to add another.`);

    setSubmitting(true);
    let entry;
    try {
      entry = await buildEntry(idNum);
    } catch (e) {
      setSubmitting(false);
      if (e.notFound) return fieldError('No game found for that place ID.');
      if (e.code === 429) return fieldError('Roblox is rate-limiting requests right now — wait a moment and try again.');
      if (e.code) return fieldError("Invalid place ID — couldn't find that game.");
      return fieldError('Network error — check your connection and try again.');
    }
    setSubmitting(false);

    if (isDefaultId(idNum)) { removedDefaults = removedDefaults.filter(x => x !== idNum); saveRemoved(); }
    else { customIds.push(idNum); saveCustom(); }
    upsertGame(entry);
    inputEl.value = '';
    renderEditList();
    refreshBoard();
  }

  function removeGame(id) {
    id = Number(id);
    if (isDefaultId(id) && !removedDefaults.includes(id)) { removedDefaults.push(id); saveRemoved(); }
    customIds = customIds.filter(x => x !== id);
    saveCustom();
    if (games) games = games.filter(g => Number(g.placeId) !== id);
    renderEditList();
    refreshBoard();
  }

  async function resetToDefault() {
    customIds = [];
    removedDefaults = [];
    saveCustom(); saveRemoved();
    resetBtn.disabled = true;
    await syncMissing();
    renderEditList();
    refreshBoard();
  }

  function refreshBoard() {
    if (!games) return;
    games = sortEntries(games);
    render();
    updateSummary();
    if (games.some(g => g.status === 'pending')) scheduleRetry(rlActive); else hideNotice();
  }

  function renderEditList() {
    const ids = allPlaceIds();
    if (!ids.length) {
      listEl.innerHTML = '<div class="ag-empty">No games — add one above, or reset to default.</div>';
    } else {
      const idSet = new Set(ids.map(Number));
      const order = [], seen = new Set();
      if (games) for (const g of sortEntries(games)) {
        const id = Number(g.placeId);
        if (idSet.has(id) && !seen.has(id)) { order.push(id); seen.add(id); }
      }
      for (const id of ids) if (!seen.has(id)) { order.push(id); seen.add(id); }
      listEl.innerHTML = order.map(id => {
        const g = (games || []).find(x => Number(x.placeId) === Number(id) && x.status === 'ok');
        const name = g ? esc(g.name) : ('Place ' + id);
        const icon = g ? g.icon : FALLBACK;
        return `<div class="ag-item">
            <img class="ag-item-icon" src="${icon}" alt="" ${onerr}>
            <div class="ag-item-name">${name}</div>
            <button class="ag-item-remove" type="button" data-remove="${id}" aria-label="Remove ${name}">&times;</button>
          </div>`;
      }).join('');
    }

    disarmReset();
    resetBtn.disabled = isPristine();
    updateShareLink();
  }

  function openModal() {
    clearFieldError();
    renderEditList();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => inputEl.focus(), 0);
  }
  function closeModal() {
    if (inputEl && inputEl.blur) inputEl.blur();
    disarmReset();
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    resetBtn.classList.remove('armed');
    resetBtn.textContent = 'Reset to default';
  }

  let wired = false;
  function init() {
    container  = document.getElementById('games-render');
    onlineEl   = document.getElementById('gsum-online');
    gamesCntEl = document.getElementById('gsum-games');
    refreshBtn = document.getElementById('gsum-refresh');
    noticeEl   = document.getElementById('games-notice');
    addBtn     = document.getElementById('gsum-add');
    modal      = document.getElementById('addgame-modal');
    closeBtn   = document.getElementById('addgame-close');
    formEl     = document.getElementById('addgame-form');
    inputEl    = document.getElementById('addgame-input');
    submitEl   = document.getElementById('addgame-submit');
    errEl      = document.getElementById('addgame-error');
    listEl     = document.getElementById('addgame-list');
    resetBtn   = document.getElementById('addgame-reset');
    linkEl     = document.getElementById('addgame-link');
    copyEl     = document.getElementById('addgame-copy');

    importFromUrl();

    if (!wired) {
      wired = true;
      refreshBtn.addEventListener('click', () => {
        if (refreshReady && !loading) { load(); return; }
        refreshBtn.classList.add('cd-show');
      });
      refreshBtn.addEventListener('mouseenter', () => refreshBtn.classList.add('cd-show'));
      refreshBtn.addEventListener('mouseleave', () => refreshBtn.classList.remove('cd-show'));
      document.addEventListener('pointerdown', e => { if (!refreshBtn.contains(e.target)) refreshBtn.classList.remove('cd-show'); });
      document.addEventListener('pointerdown', e => { const rb = noticeEl.querySelector('.gn-retry'); if (rb && !rb.contains(e.target)) rb.classList.remove('cd-show'); });
      addBtn.addEventListener('click', openModal);
      closeBtn.addEventListener('click', closeModal);
      modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
      formEl.addEventListener('submit', e => { e.preventDefault(); tryAddGame(); });
      inputEl.addEventListener('input', clearFieldError);
      listEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-remove]');
        if (btn) removeGame(btn.dataset.remove);
      });
      copyEl.addEventListener('click', () => {
        const url = linkEl.value;
        const done = () => {
          copyEl.textContent = 'Copied!';
          copyEl.classList.add('done');
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => { copyEl.textContent = 'Copy'; copyEl.classList.remove('done'); }, 1600);
        };
        const fallback = () => { try { linkEl.select(); document.execCommand('copy'); } catch {} done(); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(fallback);
        } else fallback();
      });
      resetBtn.addEventListener('click', () => {
        if (!resetArmed) {
          resetArmed = true;
          resetBtn.classList.add('armed');
          resetBtn.textContent = 'Click again to confirm';
          clearTimeout(resetTimer);
          resetTimer = setTimeout(disarmReset, 3000);
          return;
        }
        disarmReset();
        resetToDefault();
      });
    }

    ensureLoaded();
  }

  return { init };
})();

const BADGE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none'><g clip-path='url(#clip0_8_46)'><rect x='5.88818' width='22.89' height='22.89' transform='rotate(15 5.88818 0)' fill='#0066FF'/><path fill-rule='evenodd' clip-rule='evenodd' d='M20.543 8.7508L20.549 8.7568C21.15 9.3578 21.15 10.3318 20.549 10.9328L11.817 19.6648L7.45 15.2968C6.85 14.6958 6.85 13.7218 7.45 13.1218L7.457 13.1148C8.058 12.5138 9.031 12.5138 9.633 13.1148L11.817 15.2998L18.367 8.7508C18.968 8.1498 19.942 8.1498 20.543 8.7508Z' fill='white'/></g><defs><clipPath id='clip0_8_46'><rect width='28' height='28' fill='white'/></clipPath></defs></svg>`;

const FALLBACK_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%231f1f23'/%3E%3Ccircle cx='50' cy='40' r='16' fill='%232a2a30'/%3E%3Crect x='26' y='62' width='48' height='30' rx='15' fill='%232a2a30'/%3E%3C/svg%3E";

function avatarUrl(hash) {
  return hash ? `https://tr.rbxcdn.com/30DAY-Avatar-${hash}-Png/420/420/Avatar/Png/noFilter` : null;
}

// Parses the optional value tag at the end of a user row, e.g. "w:5842.00" (wallet/
// account, an estimate) or "i:230.48" (inventory). Returns { type, val }; type is
// null when there's no value.
function parseUsd(raw) {
  if (typeof raw !== 'string') return { type: null, val: 0 };
  const m = /^([wi]):([\d.]+)$/.exec(raw);
  if (!m) return { type: null, val: 0 };
  return { type: m[1], val: parseFloat(m[2]) || 0 };
}

// $152 (<1k, no decimals), $5.8K, $253K, $1.2M. "w" values are estimates, shown ~$…+.
function fmtUsd(type, val) {
  let s;
  if (val >= 1e9)      s = '$' + (val / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  else if (val >= 1e6) s = '$' + (val / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  else if (val >= 1e3) s = '$' + (val / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  else                 s = '$' + Math.round(val);
  return type === 'w' ? '~' + s + '+' : s;
}

const PAGE_SIZE = 40;
const NOW = Date.now();

let allUsers = [];
let filtered = [];
let rendered = 0;
let showMoreData = null;

const filters = { verifiedOnly: false, showAlts: false, showBanned: false, lenMax: 0 };

const sort = { key: 'date', dir: -1 };
const SORT_CYCLE = [
  { key: 'date',  dir: -1, label: 'Join date', arrow: '↓' },
  { key: 'date',  dir:  1, label: 'Join date', arrow: '↑' },
  { key: 'alpha', dir:  1, label: 'A → Z',     arrow: '↑' },
  { key: 'alpha', dir: -1, label: 'Z → A',     arrow: '↓' },
];
let sortIndex = 0;
let searchSortOverride = false;

const LEN_CYCLE = [
  { max: 0, label: 'Any length' },
  { max: 3, label: '≤ 3 chars' },
  { max: 4, label: '≤ 4 chars' },
  { max: 5, label: '≤ 5 chars' },
];
let lengthIndex = 0;

function matchRank(u, q) {
  const ogu   = (u.ogu || '').toLowerCase();
  const uname = (u.username || '').toLowerCase();
  const id    = u.id;
  if      (ogu === q)            return 0;
  else if (ogu.startsWith(q))    return 1;
  else if (uname === q)          return 2;
  else if (uname.startsWith(q))  return 3;
  else if (id === q)             return 4;
  else if (id.startsWith(q))     return 5;
  else if (ogu.includes(q))      return 6;
  else if (uname.includes(q))    return 7;
  else if (id.includes(q))       return 8;
  return -1;
}

// Length of the field that matched q, so the shortest match within a relevance
// bucket sorts first (e.g. "da" → "dai" before "david"). Mirrors matchRank's
// ogu / username / id field ordering.
function matchLen(u, r) {
  return (r === 2 || r === 3 || r === 7) ? (u.username || u.ogu).length
       : (r === 4 || r === 5 || r === 8) ? String(u.id).length
       : (u.ogu || u.username).length;
}

function sortCmp(a, b) {
  if (sort.key === 'alpha') {
    return sort.dir * (a.username || '').localeCompare(b.username || '', undefined, { sensitivity: 'base' });
  }
  return sort.dir * ((a.created || 0) - (b.created || 0));
}

function applySortOrder(arr) {
  return arr.slice().sort(sortCmp);
}

function relativeAge(created) {
  if (!created) return '—';
  const ms = NOW - created;
  const days = Math.floor(ms / 86400000);
  if (days < 1) return '<1d';
  if (days < 30) return days + 'd';
  const months = Math.floor(days / 30.44);
  if (months < 12) return months + 'mo';
  return Math.floor(months / 12) + 'y';
}

function buildCard(user, opts) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `https://www.roblox.com/users/${user.id}/profile`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const img = document.createElement('img');
  img.className = 'card-avatar';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = user.avatar || FALLBACK_AVATAR;
  img.alt = user.username;
  img.onerror = () => { img.onerror = null; img.src = FALLBACK_AVATAR; };

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';

  if (user.banned) {
    a.classList.add('banned');
    const tag = document.createElement('span');
    tag.className = 'card-banned-tag';
    tag.textContent = 'Banned';
    a.appendChild(tag);
  } else if (!user.valid && !(opts && opts.usd)) {
    // USD tab shows inactive accounts as normal cards (no greyed-out treatment).
    a.classList.add('inactive');
    const tag = document.createElement('span');
    tag.className = 'card-inactive-tag';
    tag.textContent = 'Inactive';
    a.appendChild(tag);
  }

  const age = document.createElement('span');
  age.className = 'card-age';
  const fullDate = user.created
    ? new Date(user.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Unknown';
  const short = document.createElement('span');
  short.className = 'age-short';
  short.textContent = relativeAge(user.created);
  age.appendChild(short);
  const expanded = document.createElement('span');
  expanded.className = 'age-expanded';
  expanded.textContent = 'Created · ' + fullDate;
  age.appendChild(expanded);

  const body = document.createElement('div');
  body.className = 'card-body';

  const displayRow = document.createElement('div');
  displayRow.className = 'card-display-row';

  const displayEl = document.createElement('span');
  displayEl.className = 'card-display';
  displayEl.textContent = user.display;
  displayRow.appendChild(displayEl);

  if (user.verified) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.title = 'Verified badge';
    badge.innerHTML = BADGE_SVG;
    displayRow.appendChild(badge);
  }

  const oguVal = user.ogu || user.username;
  const usernameEl = document.createElement('div');
  usernameEl.className = 'card-username';
  const oguSpan = document.createElement('span');
  oguSpan.className = 'uname-ogu';
  oguSpan.textContent = '@' + oguVal;
  usernameEl.appendChild(oguSpan);
  if (oguVal !== user.username) {
    usernameEl.classList.add('animatable');
    const rblxSpan = document.createElement('span');
    rblxSpan.className = 'uname-rblx';
    rblxSpan.textContent = '@' + user.username;
    usernameEl.appendChild(rblxSpan);
  }

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  footer.appendChild(usernameEl);
  footer.appendChild(age);

  if (opts && opts.usd && user.usdType) {
    const usd = document.createElement('div');
    usd.className = 'card-usd';
    usd.textContent = fmtUsd(user.usdType, user.usdVal);
    usd.title = user.usdType === 'w' ? 'Estimated account value' : 'Inventory value';
    body.appendChild(usd);
  }
  body.appendChild(displayRow);
  body.appendChild(footer);

  a.appendChild(img);
  a.appendChild(overlay);
  a.appendChild(body);
  return a;
}

function renderMore() {
  if (rendered >= filtered.length) return;
  const frag = document.createDocumentFragment();
  const end = Math.min(rendered + PAGE_SIZE, filtered.length);
  for (let i = rendered; i < end; i++) {
    const card = buildCard(filtered[i]);
    card.style.animationDelay = Math.min((i - rendered) * 22, 180) + 'ms';
    frag.appendChild(card);
  }
  rendered = end;
  grid.appendChild(frag);
  if (rendered >= filtered.length) appendShowMore();
}

const grid = document.getElementById('grid');
const sentinel = document.getElementById('sentinel');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('search');
const searchWrap = document.querySelector('.search-wrap');
const clearBtn = document.getElementById('search-clear');
const btnVerified = document.getElementById('btn-verified');
const btnAlts = document.getElementById('btn-alts');
const btnBanned = document.getElementById('btn-banned');
const btnLength = document.getElementById('btn-length');
const lengthLabel = document.getElementById('length-label');
const btnSort = document.getElementById('btn-sort');
const sortLabel = document.getElementById('sort-label');
const sortArrow = document.getElementById('sort-arrow');
const btnClear = document.getElementById('btn-clear');
const topbarFill = document.getElementById('topbar-fill');
const topbarLabel = document.getElementById('topbar-label');

function setProgress(pct) {
  const p = Math.min(100, pct);
  topbarFill.style.width = p + '%';
  topbarLabel.textContent = 'Loading ' + Math.round(p) + '%';
}

function hideProgress() {
  document.getElementById('topbar').classList.add('hidden');
  topbarLabel.classList.add('hidden');
}

function showSkeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'skeleton-card';
    frag.appendChild(d);
  }
  grid.appendChild(frag);
}

let scrollScheduled = false;

function scheduleScrollCheck() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(function run() {
    scrollScheduled = false;
    if (document.getElementById('view-roblox').hidden) return;
    if (rendered >= filtered.length) return;
    if (sentinel.getBoundingClientRect().top < window.innerHeight + 600) {
      renderMore();
      if (rendered < filtered.length &&
          sentinel.getBoundingClientRect().top < window.innerHeight + 600) {
        scrollScheduled = true;
        requestAnimationFrame(run);
      }
    }
  });
}

const scrollTopBtn = document.getElementById('scroll-top');

window.addEventListener('scroll', scheduleScrollCheck, { passive: true });
window.addEventListener('resize', scheduleScrollCheck, { passive: true });
window.addEventListener('scroll', () => {
  scrollTopBtn.classList.toggle('visible', window.scrollY > 500);
}, { passive: true });

scrollTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

let applyScheduled = false;
function scheduleApply() {
  if (applyScheduled) return;
  applyScheduled = true;
  requestAnimationFrame(() => {
    applyScheduled = false;
    applySearch();
  });
}

function toggleFilter(key, btn) {
  filters[key] = !filters[key];
  btn.classList.toggle('active', filters[key]);
  btn.setAttribute('aria-pressed', filters[key]);
  scheduleApply();
}

btnVerified.addEventListener('click', () => toggleFilter('verifiedOnly', btnVerified));
btnAlts.addEventListener('click', () => toggleFilter('showAlts', btnAlts));
btnBanned.addEventListener('click', () => toggleFilter('showBanned', btnBanned));

btnLength.addEventListener('click', () => {
  lengthIndex = (lengthIndex + 1) % LEN_CYCLE.length;
  const l = LEN_CYCLE[lengthIndex];
  filters.lenMax = l.max;
  lengthLabel.textContent = l.label;
  btnLength.classList.toggle('active', l.max > 0);
  scheduleApply();
});

btnSort.addEventListener('click', () => {
  searchSortOverride = true;
  sortIndex = (sortIndex + 1) % SORT_CYCLE.length;
  const s = SORT_CYCLE[sortIndex];
  sort.key = s.key;
  sort.dir = s.dir;
  sortLabel.textContent = s.label;
  sortArrow.textContent = s.arrow;
  scheduleApply();
});

function updateSearchUI() {
  searchWrap.classList.toggle('has-value', searchEl.value.length > 0);
}

function updateClearVisibility() {
  const active = filters.verifiedOnly || filters.showAlts || filters.showBanned ||
                 filters.lenMax > 0 || searchEl.value.trim() !== '';
  btnClear.classList.toggle('visible', active);
}

function syncFilterUI() {
  btnVerified.classList.toggle('active', filters.verifiedOnly);
  btnVerified.setAttribute('aria-pressed', filters.verifiedOnly);
  btnAlts.classList.toggle('active', filters.showAlts);
  btnAlts.setAttribute('aria-pressed', filters.showAlts);
  btnBanned.classList.toggle('active', filters.showBanned);
  btnBanned.setAttribute('aria-pressed', filters.showBanned);
  btnLength.classList.toggle('active', filters.lenMax > 0);
  lengthLabel.textContent = LEN_CYCLE[lengthIndex].label;
}

btnClear.addEventListener('click', () => {
  filters.verifiedOnly = false;
  filters.showAlts = false;
  filters.showBanned = false;
  filters.lenMax = 0;
  lengthIndex = 0;
  syncFilterUI();
  searchEl.value = '';
  updateSearchUI();
  scheduleApply();
});

let scope = 'ogu';
let scopeCounts = { ogu: 0, all: 0 };
const SCOPE_LABEL = { ogu: 'OGUs', all: 'All' };
const scopeDD = document.getElementById('scope-dd');
const btnScope = document.getElementById('btn-scope');
const scopeMenu = document.getElementById('scope-menu');
const scopeCurEl = document.getElementById('scope-cur');
const scopeCountEl = document.getElementById('scope-count');

function inScope(u) { return scope === 'all' || u.isOgu; }

function updateScopeUI() {
  scopeCurEl.textContent = SCOPE_LABEL[scope];
  scopeCountEl.textContent = '(' + scopeCounts[scope].toLocaleString() + ')';
  scopeMenu.querySelectorAll('.scope-opt').forEach(opt => {
    const s = opt.dataset.scope;
    opt.classList.toggle('selected', s === scope);
    opt.setAttribute('aria-selected', s === scope);
    const c = opt.querySelector('.scope-opt-count');
    if (c) c.textContent = '(' + scopeCounts[s].toLocaleString() + ')';
  });
}

function openScopeMenu()  { scopeMenu.hidden = false; scopeDD.classList.add('open'); btnScope.setAttribute('aria-expanded', 'true'); }
function closeScopeMenu() { scopeMenu.hidden = true;  scopeDD.classList.remove('open'); btnScope.setAttribute('aria-expanded', 'false'); }

function setScope(s) {
  if (s === scope) return;
  scope = s;
  updateScopeUI();
  scheduleApply();
}

btnScope.addEventListener('click', e => {
  e.stopPropagation();
  if (scopeMenu.hidden) openScopeMenu(); else closeScopeMenu();
});
scopeMenu.addEventListener('click', e => {
  const opt = e.target.closest('.scope-opt');
  if (!opt) return;
  closeScopeMenu();
  setScope(opt.dataset.scope);
});
document.addEventListener('click', e => { if (!scopeDD.contains(e.target)) closeScopeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeScopeMenu(); });

// Reset the Users tab. Switching tabs clears just the search and filters; an
// explicit refresh (re-clicking the active tab or clicking the title) passes
// full=true to also reset the sort and scope. Either way: rebuild, scroll to top.
function resetRoblox(full) {
  searchEl.value = '';
  filters.verifiedOnly = filters.showAlts = filters.showBanned = false;
  filters.lenMax = 0;
  lengthIndex = 0;
  if (full) {
    sortIndex = 0;
    searchSortOverride = false;
    sort.key = SORT_CYCLE[0].key;
    sort.dir = SORT_CYCLE[0].dir;
    sortLabel.textContent = SORT_CYCLE[0].label;
    sortArrow.textContent = SORT_CYCLE[0].arrow;
    scope = 'ogu';
    updateScopeUI();
  }
  syncFilterUI();
  updateSearchUI();
  applySearch();
  window.scrollTo({ top: 0 });
}

function recomputeStats() {
  const total  = allUsers.length;
  const banned = allUsers.filter(u => u.banned).length;
  const valid  = allUsers.filter(u => u.valid && !u.banned).length;
  const alts   = total - valid - banned;
  document.getElementById('stat-total').textContent  = total.toLocaleString();
  document.getElementById('stat-valid').textContent  = valid.toLocaleString();
  document.getElementById('stat-alts').textContent   = alts.toLocaleString();
  document.getElementById('stat-banned').textContent = banned.toLocaleString();
}

let searchTimeout;
searchEl.addEventListener('input', () => {
  updateSearchUI();
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(applySearch, 150);
});

clearBtn.addEventListener('click', () => {
  searchEl.value = '';
  updateSearchUI();
  applySearch();
  searchEl.focus();
});

document.addEventListener('keydown', (e) => {
  const usdSearch = document.getElementById('usd-search');
  const usdVisible = !document.getElementById('view-usd').hidden && usdSearch;
  const robloxVisible = !document.getElementById('view-roblox').hidden;
  // Search box for the visible tab, or null when the current tab has none (Games).
  const activeSearch = usdVisible ? usdSearch : (robloxVisible ? searchEl : null);
  const typing = document.activeElement === searchEl;
  const typingAny = typing || document.activeElement === usdSearch;
  if (e.key === '/' && !typingAny) {
    if (!activeSearch) return;
    e.preventDefault();
    activeSearch.focus();
  } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
    if (!activeSearch) return;
    e.preventDefault();
    activeSearch.focus();
    activeSearch.select();
  } else if (e.key === 'Enter' && typing) {
    e.preventDefault();
    clearTimeout(searchTimeout);
    applySearch();
    searchEl.blur();
  } else if (e.key === 'Escape' && typing) {
    if (searchEl.value) {
      searchEl.value = '';
      updateSearchUI();
      applySearch();
    } else {
      searchEl.blur();
    }
  }
});

(function () {
  const addBtn = document.getElementById('add-user-btn');
  const modal = document.getElementById('add-modal');
  const closeBtn = document.getElementById('add-modal-close');
  const tgBtn = document.getElementById('tg-btn');
  const tgLabel = document.getElementById('tg-label');
  const TG_HANDLE = '@golden_canyon_31';
  let copyTimer;

  function openModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }
  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    addBtn.focus();
  }

  addBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  tgBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(TG_HANDLE);
    } catch (err) {

      const tmp = document.createElement('textarea');
      tmp.value = TG_HANDLE;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(tmp);
    }
    tgBtn.classList.add('copied');
    tgLabel.textContent = 'Copied to clipboard!';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      tgBtn.classList.remove('copied');
      tgLabel.textContent = TG_HANDLE;
    }, 1600);
  });
})();

// The USD tab: every user carrying a value tag, sorted high → low, with search.
// Reuses buildCard()/matchRank() from the main directory; no filters by design.
const UsdTab = (function () {
  let gridEl, sentinelEl, countEl, searchEl, searchWrap, clearBtn, bannedBtn;
  let pool = [];   // users with a value, sorted high → low (built once data lands)
  let view = [];   // current search result
  let rendered = 0;
  let wired = false;
  let ready = false;
  let showBanned = false;   // inactive users always show; banned are opt-in
  let searchTimeout = null;
  let scrollScheduled = false;

  const isHidden = () => { const v = document.getElementById('view-usd'); return !v || v.hidden; };

  function filterPool() {
    const base = showBanned ? pool : pool.filter(u => !u.banned);
    const q = searchEl.value.trim().toLowerCase();
    if (!q) return base;
    // Bucket by relevance like the main directory, then within each bucket put the
    // shortest matching name first ("da" → "dai" before "david"), ties broken by
    // value (base is already sorted high → low).
    const buckets = [[], [], [], [], [], [], [], [], []];
    for (const u of base) {
      const r = matchRank(u, q);
      if (r >= 0) buckets[r].push(u);
    }
    const out = [];
    buckets.forEach((b, r) => {
      b.sort((a, c) => matchLen(a, r) - matchLen(c, r) || c.usdVal - a.usdVal);
      out.push(...b);
    });
    return out;
  }

  function renderMore() {
    if (rendered >= view.length) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(rendered + PAGE_SIZE, view.length);
    for (let i = rendered; i < end; i++) {
      const card = buildCard(view[i], { usd: true });
      card.style.animationDelay = Math.min((i - rendered) * 22, 180) + 'ms';
      frag.appendChild(card);
    }
    rendered = end;
    gridEl.appendChild(frag);
  }

  function scheduleScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(function run() {
      scrollScheduled = false;
      if (isHidden() || rendered >= view.length) return;
      if (sentinelEl.getBoundingClientRect().top < window.innerHeight + 600) {
        renderMore();
        if (rendered < view.length &&
            sentinelEl.getBoundingClientRect().top < window.innerHeight + 600) {
          scrollScheduled = true;
          requestAnimationFrame(run);
        }
      }
    });
  }

  function build() {
    if (!wired) return;
    view = filterPool();
    gridEl.innerHTML = '';
    rendered = 0;
    if (view.length === 0) {
      const nr = document.createElement('div');
      nr.className = 'no-results';
      const q = searchEl.value.trim();
      if (q) {
        nr.append('No matches for ');
        const strong = document.createElement('strong');
        strong.textContent = '“' + q + '”';
        nr.append(strong, '.');
      } else {
        nr.textContent = ready ? 'No users have a USD value yet.' : 'Loading…';
      }
      gridEl.appendChild(nr);
      countEl.textContent = ready ? '0 users' : '';
      return;
    }
    countEl.textContent = view.length === 1 ? '1 user' : view.length.toLocaleString() + ' users';
    renderMore();
    scheduleScroll();
  }

  function updateSearchUI() {
    searchWrap.classList.toggle('has-value', searchEl.value.length > 0);
  }

  // Called once the directory data has finished loading.
  function setData() {
    pool = allUsers.filter(u => u.usdType).sort((a, b) => b.usdVal - a.usdVal);
    ready = true;
    if (wired && !isHidden()) build();
  }

  // Called every time the USD tab is shown; wires the DOM on first use.
  function init() {
    if (!wired) {
      gridEl     = document.getElementById('usd-grid');
      sentinelEl = document.getElementById('usd-sentinel');
      countEl    = document.getElementById('usd-count');
      searchEl   = document.getElementById('usd-search');
      searchWrap = document.getElementById('usd-search-wrap');
      clearBtn   = document.getElementById('usd-search-clear');
      bannedBtn  = document.getElementById('usd-btn-banned');
      wired = true;

      bannedBtn.addEventListener('click', () => {
        showBanned = !showBanned;
        bannedBtn.classList.toggle('active', showBanned);
        bannedBtn.setAttribute('aria-pressed', showBanned);
        build();
      });
      searchEl.addEventListener('input', () => {
        updateSearchUI();
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(build, 150);
      });
      clearBtn.addEventListener('click', () => {
        searchEl.value = '';
        updateSearchUI();
        build();
        searchEl.focus();
      });
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(searchTimeout);
          build();
          searchEl.blur();
        } else if (e.key === 'Escape') {
          if (searchEl.value) { searchEl.value = ''; updateSearchUI(); build(); }
          else searchEl.blur();
        }
      });
      window.addEventListener('scroll', scheduleScroll, { passive: true });
      window.addEventListener('resize', scheduleScroll, { passive: true });
    }
    build();
  }

  // Re-clicking the USD tab resets it: clear the search and the banned toggle,
  // rebuild the list, and jump back to the top.
  function reset() {
    if (!wired) return;
    searchEl.value = '';
    showBanned = false;
    bannedBtn.classList.remove('active');
    bannedBtn.setAttribute('aria-pressed', 'false');
    updateSearchUI();
    build();
    window.scrollTo({ top: 0 });
  }

  return { init, setData, reset };
})();

(function () {
  const tabs = document.querySelectorAll('#tabs .tab');
  const tip = document.getElementById('tab-tooltip');
  const hero = document.querySelector('.hero');
  const heroTitleMain = document.getElementById('hero-title-main');
  const heroTitleGames = document.getElementById('hero-title-games');
  const heroTitleUsd = document.getElementById('hero-title-usd');
  const heroDesc = document.getElementById('hero-desc');
  const heroStats = document.getElementById('hero-stats');
  const viewRoblox = document.getElementById('view-roblox');
  const viewGames = document.getElementById('view-games');
  const viewUsd = document.getElementById('view-usd');

  const HERO_DESC = {
    roblox: 'A directory of OGU Roblox accounts — short, rare, and original usernames.',
    games:  'Your favorite games — gathered in one place.',
    usd:    'Accounts ranked by inventory value.',
  };

  // name → { view element, hero title element, url path, compact hero, show stat pills }
  const VIEWS = {
    roblox: { view: viewRoblox, title: heroTitleMain,  path: '/',      compact: false, stats: true,  doc: 'Users' },
    games:  { view: viewGames,  title: heroTitleGames, path: '/games', compact: true,  stats: false, doc: 'Games' },
    usd:    { view: viewUsd,    title: heroTitleUsd,   path: '/usd',   compact: true,  stats: false, doc: 'USD'   },
  };

  let gamesInjected = false, gamesInjecting = false;
  async function ensureGamesView() {
    if (gamesInjected || gamesInjecting) return;
    gamesInjecting = true;
    try {
      const res = await fetch('./games.html', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      viewGames.innerHTML = await res.text();
      gamesInjected = true;
      if (window.GamesTab) window.GamesTab.init();
    } catch (e) {
      viewGames.innerHTML = '<div class="games-error">Couldn\'t load the games view. Please try again.</div>';
    } finally {
      gamesInjecting = false;
    }
  }

  // USD view lives in usd.html (same pattern as games). Fetch+inject once, then
  // (re)build on every activation — UsdTab.init() only wires the DOM on first run.
  let usdInjected = false, usdInjecting = false;
  async function ensureUsdView() {
    if (usdInjected) { UsdTab.init(); return; }
    if (usdInjecting) return;
    usdInjecting = true;
    try {
      const res = await fetch('./usd.html', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      viewUsd.innerHTML = await res.text();
      usdInjected = true;
      UsdTab.init();
    } catch (e) {
      viewUsd.innerHTML = '<div class="games-error">Couldn\'t load the USD view. Please try again.</div>';
    } finally {
      usdInjecting = false;
    }
  }

  function showTip(tab) {
    const r = tab.getBoundingClientRect();
    tip.textContent = tab.dataset.tip;
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top = (r.bottom + 9) + 'px';
    tip.classList.add('show');
  }
  function hideTip() { tip.classList.remove('show'); }

  function activate(name, push) {
    if (!VIEWS[name]) name = 'roblox';
    const cfg = VIEWS[name];
    // Keep html[data-tab] in sync so the pre-paint anti-flash CSS matches the
    // current tab after client-side switches too (not just the initial load).
    document.documentElement.dataset.tab = name;

    document.querySelectorAll('.modal-overlay').forEach(m => { m.hidden = true; });
    document.body.style.overflow = '';
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    tabs.forEach(t => t.classList.toggle('active', !t.dataset.tip && t.dataset.tab === name));

    for (const key in VIEWS) {
      VIEWS[key].view.hidden = key !== name;
      VIEWS[key].title.hidden = key !== name;
    }
    heroStats.hidden = !cfg.stats;
    hero.classList.toggle('compact', cfg.compact);
    heroDesc.textContent = HERO_DESC[name] || HERO_DESC.roblox;
    document.title = cfg.doc + ' | OGUs.gg';

    // Render the main grid on activation. Needed when the page was first loaded
    // on /games or /usd (roblox view hidden): the data-load render bails while
    // hidden, so the grid would otherwise stay empty until a filter/search runs.
    if (name === 'roblox') scheduleScrollCheck();
    if (name === 'games') ensureGamesView();
    if (name === 'usd') ensureUsdView();

    if (push) {
      try { history.pushState({ tab: name }, '', cfg.path + location.search); } catch (_) {}
    }
  }

  tabs.forEach(t => {
    if (t.dataset.tip) {

      t.addEventListener('click', e => e.preventDefault());
      t.addEventListener('mouseenter', () => showTip(t));
      t.addEventListener('mouseleave', hideTip);
    } else {
      t.addEventListener('click', () => {
        const name = t.dataset.tab;
        const switching = document.documentElement.dataset.tab !== name;
        if (switching) activate(name, true);
        // Switching clears the destination tab's search + filters; re-clicking
        // the active tab is a full refresh (also resets its sort + scope).
        resetTab(name, !switching);
      });
    }
  });

  function resetTab(name, full) {
    if (name === 'roblox') resetRoblox(full);
    else if (name === 'usd') UsdTab.reset();
    else window.scrollTo({ top: 0 });
  }

  // Clicking a hero title (OGUs.gg / USD / Games) refreshes the active tab — the
  // same full reset as clicking its tab button again.
  document.querySelectorAll('.hero-title').forEach(h => {
    h.addEventListener('click', () => resetTab(document.documentElement.dataset.tab, true));
  });

  document.querySelector('.tabs-wrap').addEventListener('scroll', hideTip, { passive: true });

  const tabForPath = p => /\/games\/?$/.test(p) ? 'games' : /\/usd\/?$/.test(p) ? 'usd' : 'roblox';

  activate(tabForPath(location.pathname), false);
  window.addEventListener('popstate', () => activate(tabForPath(location.pathname), false));
})();

function applySearch() {
  updateClearVisibility();
  const q = searchEl.value.trim().toLowerCase();
  if (!q) searchSortOverride = false;

  let pool = allUsers.filter(u =>
    inScope(u) && (u.banned ? filters.showBanned : (u.valid || filters.showAlts))
  );
  if (filters.verifiedOnly) pool = pool.filter(u => u.verified);
  if (filters.lenMax) pool = pool.filter(u => (u.ogu || u.username).length <= filters.lenMax);

  if (q) {
    const buckets = [[], [], [], [], [], [], [], [], []];
    for (const u of pool) {
      const r = matchRank(u, q);
      if (r < 0) continue;
      buckets[r].push(u);
    }
    // Default: within each relevance bucket, shortest matching name first (e.g.
    // "demoni" → "demonic" before "demonizing"), ties broken by the active sort.
    // Once the user presses the sort toggle during a search, that sort takes over.
    filtered = [];
    buckets.forEach((b, r) => {
      if (!b.length) return;
      if (searchSortOverride) b.sort(sortCmp);
      else b.sort((a, c) => matchLen(a, r) - matchLen(c, r) || sortCmp(a, c));
      filtered.push(...b);
    });
  } else {
    filtered = applySortOrder(pool);
  }

  showMoreData = null;
  if (q) {
    const reasons = { scope: 0, banned: 0, inactive: 0, verified: 0, length: 0 };
    let count = 0;
    for (const u of allUsers) {
      if (matchRank(u, q) < 0) continue;
      const passScope    = inScope(u);
      const passBase     = u.banned ? filters.showBanned : (u.valid || filters.showAlts);
      const passVerified = !filters.verifiedOnly || u.verified;
      const passLen      = !filters.lenMax || (u.ogu || u.username).length <= filters.lenMax;
      if (passScope && passBase && passVerified && passLen) continue;
      count++;
      if (!passScope)             reasons.scope++;
      if (!passBase && u.banned)  reasons.banned++;
      if (!passBase && !u.banned) reasons.inactive++;
      if (!passVerified)          reasons.verified++;
      if (!passLen)               reasons.length++;
    }
    if (count > 0) showMoreData = { count, reasons, searched: true };
  } else {
    // Empty search: surface everyone hidden by the soft filters — the other scope
    // (non-OGU "All" names), the inactive/banned reveal toggles, and the length range.
    // Verified-only is a positive filter, so it stays a hard constraint, not offered to undo.
    const reasons = { scope: 0, banned: 0, inactive: 0, verified: 0, length: 0 };
    let count = 0;
    for (const u of allUsers) {
      if (filters.verifiedOnly && !u.verified) continue;
      const passScope = inScope(u);
      const passBase  = u.banned ? filters.showBanned : (u.valid || filters.showAlts);
      const passLen   = !filters.lenMax || (u.ogu || u.username).length <= filters.lenMax;
      if (passScope && passBase && passLen) continue;
      count++;
      if (!passScope)             reasons.scope++;
      if (!passBase && u.banned)  reasons.banned++;
      if (!passBase && !u.banned) reasons.inactive++;
      if (!passLen)               reasons.length++;
    }
    if (count > 0) showMoreData = { count, reasons, searched: false };
  }

  grid.innerHTML = '';
  rendered = 0;
  if (filtered.length === 0) {
    const nr = document.createElement('div');
    nr.className = 'no-results';
    if (q && showMoreData) {
      nr.append('No matches for ');
      const strong = document.createElement('strong');
      strong.textContent = '“' + searchEl.value.trim() + '”';
      nr.append(strong, ' with your current filters.');
    } else if (q) {
      nr.append('No matches for ');
      const strong = document.createElement('strong');
      strong.textContent = '“' + searchEl.value.trim() + '”';
      nr.append(strong, '. Try a different search or loosen your filters.');
    } else {
      nr.textContent = 'No users match the current filters.';
    }
    if (showMoreData) nr.classList.add('with-more');
    grid.appendChild(nr);
    appendShowMore();
    countEl.textContent = '0 users';
    return;
  }
  countEl.textContent = filtered.length === 1
    ? '1 user'
    : filtered.length.toLocaleString() + ' users';
  scheduleScrollCheck();
}

function appendShowMore() {
  if (!showMoreData) return;
  if (grid.querySelector('.show-more-card')) return;

  const r = showMoreData.reasons;
  const cats = [];
  if (r.scope)    cats.push('non-OGU names');
  if (r.banned)   cats.push('banned');
  if (r.inactive) cats.push('inactive');
  if (r.verified) cats.push('non-verified');
  if (r.length)   cats.push('longer names');

  const catText = cats.length === 1
    ? cats[0]
    : cats.slice(0, -1).join(', ') + ' and ' + cats[cats.length - 1];

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'show-more-card';
  card.style.animationDelay = '40ms';

  const plus = document.createElement('div');
  plus.className = 'show-more-plus';
  plus.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';

  const count = document.createElement('div');
  count.className = 'show-more-count';
  count.textContent = showMoreData.count === 1
    ? (showMoreData.searched ? '1 more match' : '1 more user')
    : showMoreData.count.toLocaleString() + (showMoreData.searched ? ' more matches' : ' more users');

  const cat = document.createElement('div');
  cat.className = 'show-more-cats';
  cat.textContent = 'hidden in ' + catText;

  card.append(plus, count, cat);
  card.addEventListener('click', () => {
    if (r.scope) { scope = 'all'; updateScopeUI(); }
    if (r.banned) filters.showBanned = true;
    if (r.inactive) filters.showAlts = true;
    if (r.verified) filters.verifiedOnly = false;
    if (r.length) { filters.lenMax = 0; lengthIndex = 0; }
    syncFilterUI();
    applySearch();
  });
  grid.appendChild(card);
}

showSkeletons(28);

(async () => {
  let fakeTimer = null;
  try {
    const res = await fetch('./users.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const contentLength = +res.headers.get('Content-Length') || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    if (!contentLength) {
      let fakePct = 0;
      fakeTimer = setInterval(() => {
        fakePct += (88 - fakePct) * 0.07;
        setProgress(fakePct);
      }, 80);
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength) setProgress(received / contentLength * 100);
    }

    if (fakeTimer) clearInterval(fakeTimer);
    setProgress(100);

    const decoder = new TextDecoder();
    let text = '';
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();

    const data = JSON.parse(text);

    allUsers = Object.entries(data)
      .map(([id, a]) => {
        const usd = parseUsd(a[9]);
        return {
          id,
          ogu:      a[0],
          username: a[1] || a[0],
          display:  a[2] || a[1] || a[0],
          created:  a[3] ? a[3] * 1000 : null,
          banned:   a[4],
          verified: a[5],
          avatar:   avatarUrl(a[6]),
          valid:    a[7],
          isOgu:    a[8] === 0,
          usdType:  usd.type,
          usdVal:   usd.val,
        };
      })
      .sort((a, b) => Number(a.id) - Number(b.id));

    scopeCounts = { ogu: allUsers.filter(u => u.isOgu).length, all: allUsers.length };
    updateScopeUI();
    recomputeStats();

    grid.innerHTML = '';
    hideProgress();
    applySearch();
    UsdTab.setData();
  } catch (e) {
    if (fakeTimer) clearInterval(fakeTimer);
    hideProgress();
    grid.innerHTML = '<div class="no-results">Couldn\'t load the directory right now. Please try again in a bit.</div>';
  }
})();
