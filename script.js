/* ============================================================
   LUDEX — client.js
   Talks to a real server (server.js) over WebSocket. Every room,
   player, chat line, and card dealt here is authoritative on the
   server — this file only renders what the server sends and
   forwards user actions back to it.
   ============================================================ */

/* ---------- constants & tiny display helpers ---------- */
const SUIT_SYMBOL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
const SUIT_RED = { S: false, H: true, D: true, C: false };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const Utils = {
  escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, ch => map[ch]);
  },
  clamp(n, min, max) { return Math.min(max, Math.max(min, n)); },
  formatNumber(n) { return Number(n || 0).toLocaleString('en-US'); },
  initial(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?'; }
};

const Cards = {
  rankLabel(r) { return RANK_LABEL[r] || String(r); },
  suitSymbol(s) { return SUIT_SYMBOL[s]; },
  isRed(s) { return SUIT_RED[s]; }
};

// Pure display helper — recomputing this from visible cards is safe (it
// never sees hidden information); the server remains authoritative for
// who actually wins.
const Blackjack = {
  handValue(cards) {
    let total = 0, aceCount = 0;
    cards.forEach(c => {
      if (!c) return;
      if (c.rank === 14) { aceCount++; total += 11; }
      else if (c.rank >= 11 && c.rank <= 13) total += 10;
      else total += c.rank;
    });
    let acesAsEleven = aceCount;
    while (total > 21 && acesAsEleven > 0) { total -= 10; acesAsEleven--; }
    return { total, isSoft: acesAsEleven > 0, isBust: total > 21 };
  }
};

const Games = {
  list: [
    { id: 'blackjack', name: 'Blackjack', icon: '\u2660', tagline: 'Beat the dealer to 21.',
      description: 'Classic casino Blackjack. Hit, stand, and try to out-count the house without going bust.',
      minPlayers: 1, maxPlayers: 5, idealTable: 4 },
    { id: 'poker', name: 'Texas Hold\u2019em', icon: '\u2663', tagline: 'Read the table. Take the pot.',
      description: 'No-limit Hold\u2019em with blinds, community cards and full betting rounds against the table.',
      minPlayers: 2, maxPlayers: 6, idealTable: 5 }
  ],
  get(id) { return this.list.find(g => g.id === id) || null; }
};

/* ---------- Net: the WebSocket connection to server.js ---------- */
const Net = (() => {
  let ws = null;
  let reconnectDelay = 1000;
  let reconnecting = false;
  const listeners = {};

  function on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  function emit(type, payload) { (listeners[type] || []).forEach(fn => fn(payload)); }

  function send(type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(Object.assign({ type }, payload || {})));
    return true;
  }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + window.location.host);

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      const wasReconnect = reconnecting;
      reconnecting = false;
      emit('_open', { wasReconnect });
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      emit(msg.type, msg);
    });

    ws.addEventListener('close', () => {
      reconnecting = true;
      emit('_close', {});
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    });

    ws.addEventListener('error', () => { try { ws.close(); } catch (err) { /* no-op */ } });
  }

  return { connect, send, on };
})();

/* ---------- ClientState: what this browser currently knows ---------- */
const ClientState = {
  id: null,
  nickname: null,
  room: null,           // full room object as pushed by the server, or null
  stats: { online: 0, perGame: {}, publicRooms: 0 },
  roomsList: [],
  roomsFilter: 'all',
  roomsSearch: '',
  pendingGameFilter: null,
  presetPrivateGame: null,
  presetPublic: false,
  hasNickname() { return !!this.nickname; }
};

function canStartRoom(room) {
  // Mirrors the server's own check — purely for optimistic UI (disabling
  // the Start button); the server enforces this for real.
  if (!room || room.status !== 'waiting' || !room.players.length) return false;
  return room.players.every(p => p.ready);
}
const Icons = {
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  crown: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2 18h20l-2-9-5 4-3-7-3 7-5-4Z"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>',
  eye: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>'
};

const UI = {
  toast(message, type, title) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.innerHTML = (title ? '<strong>' + Utils.escapeHtml(title) + '</strong>' : '') + Utils.escapeHtml(message);
    const container = document.getElementById('toast-container');
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(16px)';
      setTimeout(() => el.remove(), 220);
    }, 3600);
  },
  openModal(cfg) {
    const modal = document.getElementById('modal');
    const backdrop = document.getElementById('modal-backdrop');
    modal.innerHTML =
      '<h3>' + Utils.escapeHtml(cfg.title) + '</h3>' +
      '<div class="modal-body-content">' + cfg.body + '</div>' +
      '<div class="modal-actions" id="modal-actions"></div>';
    const actionsEl = modal.querySelector('#modal-actions');
    (cfg.actions || []).forEach(a => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (a.className || 'btn-secondary');
      btn.textContent = a.label;
      btn.addEventListener('click', () => { if (a.onClick) a.onClick(); UI.closeModal(); });
      actionsEl.appendChild(btn);
    });
    modal.classList.add('open');
    backdrop.classList.add('open');
  },
  closeModal() {
    const modal = document.getElementById('modal');
    const backdrop = document.getElementById('modal-backdrop');
    if (modal) modal.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  }
};

function requireNickname(afterFn) {
  if (Session.hasNickname()) { afterFn(); return; }
  UI.openModal({
    title: 'Pick a nickname',
    body: '<div class="field"><input id="modal-nickname-input" class="input" maxlength="18" placeholder="e.g. NightOwl" autocomplete="off"></div>',
    actions: [
      { label: 'Cancel', className: 'btn-ghost' },
      { label: 'Let\u2019s play', className: 'btn-primary', onClick: () => {
          const val = document.getElementById('modal-nickname-input').value;
          if (Session.setNickname(val)) { renderNicknamePill(); afterFn(); }
          else UI.toast('Nicknames need at least 2 characters.', 'danger');
        } }
    ]
  });
  setTimeout(() => { const el = document.getElementById('modal-nickname-input'); if (el) { el.focus(); el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); modal_submit(); } }); } }, 50);
  function modal_submit() {
    const el = document.getElementById('modal-nickname-input');
    if (!el) return;
    if (Session.setNickname(el.value)) { UI.closeModal(); renderNicknamePill(); afterFn(); }
    else UI.toast('Nicknames need at least 2 characters.', 'danger');
  }
}

function openNicknameEditModal() {
  UI.openModal({
    title: 'Change nickname',
    body: '<div class="field"><input id="modal-nickname-input" class="input" maxlength="18" value="' + Utils.escapeHtml(Session.nickname || '') + '" autocomplete="off"></div>' +
          '<p class="field-hint" style="margin-top:.5rem;">This only changes how you appear here \u2014 it won\u2019t follow you if you refresh.</p>',
    actions: [
      { label: 'Cancel', className: 'btn-ghost' },
      { label: 'Save', className: 'btn-primary', onClick: () => {
          const val = document.getElementById('modal-nickname-input').value;
          if (Session.setNickname(val)) { renderNicknamePill(); UI.toast('Nickname updated.', 'success'); }
          else UI.toast('Nicknames need at least 2 characters.', 'danger');
        } }
    ]
  });
  setTimeout(() => { const el = document.getElementById('modal-nickname-input'); if (el) el.focus(); }, 50);
}

function renderNicknamePill() {
  const pill = document.getElementById('nickname-pill');
  if (!pill) return;
  if (Session.hasNickname()) {
    pill.innerHTML =
      '<div class="nickname-chip">' +
        '<span class="nickname-avatar">' + Utils.escapeHtml(Session.avatarLetter()) + '</span>' +
        '<span class="nm-full">' + Utils.escapeHtml(Session.nickname) + '</span>' +
        '<button class="nickname-edit" id="nickname-edit-btn" aria-label="Change nickname" title="Change nickname">' + Icons.edit + '</button>' +
      '</div>';
    document.getElementById('nickname-edit-btn').addEventListener('click', openNicknameEditModal);
  } else {
    pill.innerHTML = '<button class="btn btn-primary btn-sm" id="set-nickname-btn">Set nickname</button>';
    document.getElementById('set-nickname-btn').addEventListener('click', () => requireNickname(() => {}));
  }
  const headerCount = document.getElementById('header-online-count');
  if (headerCount) headerCount.textContent = Utils.formatNumber(Stats.snapshot().online);
}


function requireNickname(afterFn) {
  if (ClientState.hasNickname()) { afterFn(); return; }
  UI.openModal({
    title: 'Pick a nickname',
    body: '<div class="field"><input id="modal-nickname-input" class="input" maxlength="18" placeholder="e.g. NightOwl" autocomplete="off"></div>',
    actions: [
      { label: 'Cancel', className: 'btn-ghost' },
      { label: 'Let\u2019s play', className: 'btn-primary', onClick: () => submitNickname(document.getElementById('modal-nickname-input').value, afterFn) }
    ]
  });
  setTimeout(() => {
    const el = document.getElementById('modal-nickname-input');
    if (el) { el.focus(); el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitNickname(el.value, afterFn); } }); }
  }, 50);
}

function submitNickname(value, afterFn) {
  const clean = String(value || '').trim().slice(0, 18);
  if (clean.length < 2) { UI.toast('Nicknames need at least 2 characters.', 'danger'); return; }
  ClientState.nickname = clean;
  Net.send('hello', { nickname: clean });
  renderNicknamePill();
  UI.closeModal();
  if (afterFn) afterFn();
}

function openNicknameEditModal() {
  UI.openModal({
    title: 'Change nickname',
    body: '<div class="field"><input id="modal-nickname-input" class="input" maxlength="18" value="' + Utils.escapeHtml(ClientState.nickname || '') + '" autocomplete="off"></div>' +
          '<p class="field-hint" style="margin-top:.5rem;">This only changes how you appear here \u2014 it won\u2019t follow you if you refresh.</p>',
    actions: [
      { label: 'Cancel', className: 'btn-ghost' },
      { label: 'Save', className: 'btn-primary', onClick: () => {
          const clean = String(document.getElementById('modal-nickname-input').value || '').trim().slice(0, 18);
          if (clean.length < 2) { UI.toast('Nicknames need at least 2 characters.', 'danger'); return; }
          ClientState.nickname = clean;
          Net.send('hello', { nickname: clean });
          renderNicknamePill();
          UI.toast('Nickname updated.', 'success');
        } }
    ]
  });
  setTimeout(() => { const el = document.getElementById('modal-nickname-input'); if (el) el.focus(); }, 50);
}

function renderNicknamePill() {
  const pill = document.getElementById('nickname-pill');
  if (!pill) return;
  if (ClientState.hasNickname()) {
    pill.innerHTML =
      '<div class="nickname-chip">' +
        '<span class="nickname-avatar">' + Utils.escapeHtml(Utils.initial(ClientState.nickname)) + '</span>' +
        '<span class="nm-full">' + Utils.escapeHtml(ClientState.nickname) + '</span>' +
        '<button class="nickname-edit" id="nickname-edit-btn" aria-label="Change nickname" title="Change nickname">' + Icons.edit + '</button>' +
      '</div>';
    document.getElementById('nickname-edit-btn').addEventListener('click', openNicknameEditModal);
  } else {
    pill.innerHTML = '<button class="btn btn-primary btn-sm" id="set-nickname-btn">Set nickname</button>';
    document.getElementById('set-nickname-btn').addEventListener('click', () => requireNickname(() => {}));
  }
  const headerCount = document.getElementById('header-online-count');
  if (headerCount) headerCount.textContent = Utils.formatNumber(ClientState.stats.online);
}

function renderConnectionBanner(state) {
  let el = document.getElementById('conn-banner');
  if (state === 'connected') { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn-banner';
    el.style.cssText = 'position:fixed;top:64px;left:0;right:0;z-index:99;background:var(--ember);color:#fff;text-align:center;padding:.5rem;font-size:.85rem;font-weight:700;';
    document.body.appendChild(el);
  }
  el.textContent = state === 'connecting' ? 'Connecting to Ludex\u2026' : 'Connection lost \u2014 reconnecting\u2026';
}
function setupMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const header = document.getElementById('site-header');
  if (!toggle || !header) return;
  let panel = null;
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'mobile-nav-panel';
      panel.id = 'mobile-nav-panel';
      panel.innerHTML = document.getElementById('main-nav').innerHTML;
      header.after(panel);
      panel.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMobileNav));
    }
    panel.classList.toggle('open', !expanded);
  });
}
function closeMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const panel = document.getElementById('mobile-nav-panel');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (panel) panel.classList.remove('open');
}


const Router = {
  routes: {},
  current: null,
  init() {
    this.routes = {
      '/home': renderHome,
      '/games': renderGames,
      '/rooms': renderRoomsList,
      '/create-private': renderCreatePrivate,
      '/join-private': renderJoinPrivate
    };
    window.addEventListener('hashchange', () => this._onHashChange());
    this._onHashChange();
  },
  navigate(path) { window.location.hash = '#' + path; },
  _onHashChange() {
    const path = window.location.hash.replace(/^#/, '') || '/home';
    this.current = path;
    this._updateNavActive(path);
    const root = document.getElementById('app-root');
    if (path.indexOf('/room/') === 0) {
      renderRoomView(root, decodeURIComponent(path.slice('/room/'.length)));
    } else {
      cleanupRoomView();
      const fn = this.routes[path];
      if (fn) fn(root); else renderNotFound(root);
    }
    try { window.scrollTo(0, 0); } catch (e) { /* no-op in environments without scrollTo */ }
    closeMobileNav();
  },
  _updateNavActive(path) {
    document.querySelectorAll('[data-route]').forEach(a => {
      const route = a.getAttribute('data-route');
      const active = route === path || (path.indexOf('/room/') === 0 && route === '/rooms');
      a.classList.toggle('active', active);
    });
  }
};


/* ---------- View renderers: Home / Games / Rooms / Create / Join ---------- */

function renderStatsBar(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const s = ClientState.stats;
  const perGameHtml = Games.list.map(g =>
    '<div class="stat-item"><span class="stat-value">' + Utils.formatNumber((s.perGame || {})[g.id] || 0) + '</span><span class="stat-label">' + g.icon + ' playing ' + Utils.escapeHtml(g.name) + '</span></div>'
  ).join('');
  el.innerHTML =
    '<div class="stat-item"><span class="stat-value">' + Utils.formatNumber(s.online) + '</span><span class="stat-label">online now</span></div>' +
    perGameHtml +
    '<div class="stat-item"><span class="stat-value">' + Utils.formatNumber(s.publicRooms) + '</span><span class="stat-label">public tables open</span></div>';
}

function renderGameGrid(containerId, query, opts) {
  opts = opts || {};
  const el = document.getElementById(containerId);
  if (!el) return;
  const q = (query || '').trim().toLowerCase();
  const stats = ClientState.stats;
  const filtered = Games.list.filter(g => !q || g.name.toLowerCase().indexOf(q) !== -1 || g.tagline.toLowerCase().indexOf(q) !== -1 || g.description.toLowerCase().indexOf(q) !== -1);
  if (!filtered.length) {
    el.innerHTML = '<div class="empty-state"><span class="suit-flourish">\u2660 \u2665</span><h4>No games match \u201c' + Utils.escapeHtml(query) + '\u201d</h4><p>Try Blackjack or Hold\u2019em \u2014 more tables are on the way.</p></div>';
    return;
  }
  el.innerHTML = filtered.map((g, i) => {
    const full = opts.full;
    return (
      '<div class="game-card" style="animation-delay:' + (i * 60) + 'ms">' +
        '<div class="game-card-top"><div class="game-card-icon">' + g.icon + '</div>' + (full ? '<span class="badge badge-playing">' + Utils.formatNumber((stats.perGame || {})[g.id] || 0) + ' online</span>' : '') + '</div>' +
        '<div><h3>' + Utils.escapeHtml(g.name) + '</h3><p>' + Utils.escapeHtml(full ? g.description : g.tagline) + '</p></div>' +
        '<div class="game-card-meta">' + (full ? '<span>' + g.minPlayers + '\u2013' + g.maxPlayers + ' players</span>' : '<span><strong>' + Utils.formatNumber((stats.perGame || {})[g.id] || 0) + '</strong> playing now</span>') + '</div>' +
        '<div class="game-card-actions">' +
          '<button class="btn btn-primary game-play-btn" data-game="' + g.id + '">Play</button>' +
          (full ? '<button class="btn btn-secondary game-host-btn" data-game="' + g.id + '">Host private</button>' : '') +
        '</div>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.game-play-btn').forEach(btn => btn.addEventListener('click', () => requireNickname(() => {
    ClientState.pendingGameFilter = btn.dataset.game;
    Router.navigate('/rooms');
  })));
  el.querySelectorAll('.game-host-btn').forEach(btn => btn.addEventListener('click', () => requireNickname(() => {
    ClientState.presetPrivateGame = btn.dataset.game;
    Router.navigate('/create-private');
  })));
}

function renderHeroPanel() {
  const panel = document.getElementById('hero-panel');
  if (!panel) return;
  if (ClientState.hasNickname()) {
    panel.innerHTML =
      '<div class="hero-welcome">' +
        '<div><div class="hero-panel-label">Welcome back, ' + Utils.escapeHtml(ClientState.nickname) + '</div><span class="muted" style="font-size:.85rem;">Ready to sit down?</span></div>' +
        '<div style="display:flex;gap:.6rem;flex-wrap:wrap;">' +
          '<button class="btn btn-secondary" id="hero-change-btn">Change name</button>' +
          '<a href="#/rooms" class="btn btn-primary">Find a table</a>' +
        '</div>' +
      '</div>';
    document.getElementById('hero-change-btn').addEventListener('click', openNicknameEditModal);
  } else {
    panel.innerHTML =
      '<div class="hero-panel-label">\u2666 Enter a nickname to sit down</div>' +
      '<form class="hero-form" id="hero-nickname-form">' +
        '<input class="input" id="hero-nickname-input" maxlength="18" placeholder="e.g. NightOwl" autocomplete="off">' +
        '<button class="btn btn-primary" type="submit">Sit down \u2192</button>' +
      '</form>' +
      '<p class="field-hint" style="margin-top:.6rem;">Just for this session \u2014 nothing is saved.</p>';
    document.getElementById('hero-nickname-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = document.getElementById('hero-nickname-input').value;
      const clean = String(val || '').trim().slice(0, 18);
      if (clean.length < 2) { UI.toast('Nicknames need at least 2 characters.', 'danger'); return; }
      ClientState.nickname = clean;
      Net.send('hello', { nickname: clean });
      renderNicknamePill();
      renderHeroPanel();
      UI.toast('Welcome, ' + ClientState.nickname + '!', 'success');
    });
  }
}

function renderHome(root) {
  root.innerHTML =
    '<div class="view">' +
      '<section class="wrap hero">' +
        '<div class="hero-grid">' +
          '<div>' +
            '<div class="hero-eyebrow"><span class="suit-flourish">\u2660 \u2665 \u2666 \u2663</span> Multiplayer card lounge</div>' +
            '<h1>Pick a table.<br>Play <em>tonight</em>.</h1>' +
            '<p class="hero-sub">No accounts, no downloads. Choose a nickname, sit down at Blackjack or Hold\u2019em, and you\u2019re in \u2014 it only lasts as long as this tab does.</p>' +
          '</div>' +
          '<div class="hero-panel" id="hero-panel"></div>' +
        '</div>' +
        '<div class="hero-stats"><div class="stats-bar" id="stats-bar"></div></div>' +
      '</section>' +
      '<section class="wrap section">' +
        '<div class="section-head"><div><h2 class="section-title"><span class="suit-flourish">\u2663</span>Games</h2><p class="section-desc">Jump straight into a table.</p></div></div>' +
        '<div class="search-row"><input class="input" id="home-search" placeholder="Search games\u2026" autocomplete="off"></div>' +
        '<div class="game-grid" id="home-game-grid"></div>' +
      '</section>' +
    '</div>';

  renderHeroPanel();
  renderStatsBar('stats-bar');
  renderGameGrid('home-game-grid', '', { full: false });
  document.getElementById('home-search').addEventListener('input', e => renderGameGrid('home-game-grid', e.target.value, { full: false }));
}

function renderGames(root) {
  root.innerHTML =
    '<div class="view wrap section">' +
      '<div class="page-head"><h1>Games</h1><p>Every table on Ludex, playable the moment you sit down.</p></div>' +
      '<div class="search-row"><input class="input" id="games-search" placeholder="Search games\u2026" autocomplete="off"></div>' +
      '<div class="game-grid" id="games-page-grid"></div>' +
    '</div>';
  renderGameGrid('games-page-grid', '', { full: true });
  document.getElementById('games-search').addEventListener('input', e => renderGameGrid('games-page-grid', e.target.value, { full: true }));
}

function renderRoomsFilterTabs() {
  const el = document.getElementById('rooms-filter-tabs');
  if (!el) return;
  const tabs = [{ id: 'all', label: 'All games' }].concat(Games.list.map(g => ({ id: g.id, label: g.icon + ' ' + g.name })));
  el.innerHTML = tabs.map(t => '<button class="filter-tab' + (ClientState.roomsFilter === t.id ? ' active' : '') + '" data-filter="' + t.id + '">' + Utils.escapeHtml(t.label) + '</button>').join('');
  el.querySelectorAll('.filter-tab').forEach(btn => btn.addEventListener('click', () => {
    ClientState.roomsFilter = btn.dataset.filter;
    renderRoomsFilterTabs();
    renderRoomsGrid();
  }));
}

function renderRoomsGrid() {
  const el = document.getElementById('rooms-grid');
  if (!el) return;
  const q = (ClientState.roomsSearch || '').trim().toLowerCase();
  let rooms = ClientState.roomsList.slice();
  if (ClientState.roomsFilter && ClientState.roomsFilter !== 'all') rooms = rooms.filter(r => r.gameId === ClientState.roomsFilter);
  if (q) rooms = rooms.filter(r => r.name.toLowerCase().indexOf(q) !== -1);
  if (!rooms.length) {
    el.innerHTML = '<div class="empty-state"><span class="suit-flourish">\u2660 \u2666</span><h4>No open tables here yet</h4><p>Be the first \u2014 open a table and friends can find it right here.</p></div>';
    return;
  }
  el.innerHTML = rooms.map((r, i) => {
    const game = Games.get(r.gameId);
    const full = r.players >= r.maxPlayers;
    const statusClass = r.status === 'playing' ? 'badge-playing' : (r.status === 'finished' ? 'badge-finished' : 'badge-waiting');
    const spectate = r.status === 'playing' || r.status === 'finished' || full;
    const cta = spectate ? 'Watch' : 'Join table';
    return (
      '<div class="room-card" style="animation-delay:' + (i * 50) + 'ms">' +
        '<div class="room-card-top"><span class="room-card-game">' + game.icon + ' ' + Utils.escapeHtml(game.name) + '</span><span class="badge ' + statusClass + '">' + r.status + '</span></div>' +
        '<h4>' + Utils.escapeHtml(r.name) + '</h4>' +
        '<div class="room-card-players"><span class="mono">' + r.players + '/' + r.maxPlayers + '</span><div class="bar"><div class="bar-fill" style="width:' + Math.min(100, (r.players / r.maxPlayers) * 100) + '%"></div></div></div>' +
        '<div class="room-card-foot"><button class="btn btn-primary btn-sm join-room-btn" data-room="' + r.id + '" data-spectate="' + (spectate ? '1' : '0') + '">' + cta + '</button></div>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.join-room-btn').forEach(btn => btn.addEventListener('click', () => requireNickname(() => {
    Net.send('join_room', { roomId: btn.dataset.room, asSpectator: btn.dataset.spectate === '1' });
  })));
}

function renderRoomsList(root) {
  const filter = ClientState.pendingGameFilter || ClientState.roomsFilter || 'all';
  ClientState.roomsFilter = filter;
  ClientState.pendingGameFilter = null;

  root.innerHTML =
    '<div class="view wrap section">' +
      '<div class="page-head"><h1>Public Rooms</h1><p>Anyone can join. Full or in-progress tables are spectate-only.</p></div>' +
      '<div class="filter-tabs" id="rooms-filter-tabs"></div>' +
      '<div class="search-row" style="justify-content:space-between;">' +
        '<input class="input" id="rooms-search" placeholder="Search tables\u2026" autocomplete="off" style="max-width:280px;">' +
        '<button class="btn btn-felt" id="rooms-host-btn">+ Open a table</button>' +
      '</div>' +
      '<div class="room-grid" id="rooms-grid"></div>' +
    '</div>';

  renderRoomsFilterTabs();
  renderRoomsGrid();
  Net.send('list_rooms', {});
  document.getElementById('rooms-search').addEventListener('input', e => { ClientState.roomsSearch = e.target.value; renderRoomsGrid(); });
  document.getElementById('rooms-host-btn').addEventListener('click', () => requireNickname(() => {
    ClientState.presetPublic = true;
    Router.navigate('/create-private');
  }));
}

function renderCreatePrivate(root) {
  const presetGame = ClientState.presetPrivateGame; ClientState.presetPrivateGame = null;
  const presetPublic = ClientState.presetPublic; ClientState.presetPublic = false;

  root.innerHTML =
    '<div class="view wrap section narrow">' +
      '<div class="page-head"><h1>Open a table</h1><p>Set it up, then send the code to friends \u2014 or open it to everyone.</p></div>' +
      '<div class="form-card">' +
        '<div class="segmented" id="privacy-toggle"><button type="button" data-val="private" class="active">Private \u00b7 code only</button><button type="button" data-val="public">Public \u00b7 anyone can join</button></div>' +
        '<div class="field"><label for="cp-game">Game</label><select class="input" id="cp-game"></select></div>' +
        '<div class="field"><label for="cp-name">Table name</label><input class="input" id="cp-name" maxlength="30" placeholder="e.g. Friday Night Table" autocomplete="off"></div>' +
        '<div class="field"><label>Max players</label><div class="stepper"><button type="button" id="cp-minus">\u2212</button><span class="stepper-value" id="cp-max-val">4</span><button type="button" id="cp-plus">+</button></div></div>' +
        '<button class="btn btn-primary btn-lg btn-block" id="cp-create-btn">Create table</button>' +
      '</div>' +
    '</div>';

  const gameSelect = document.getElementById('cp-game');
  gameSelect.innerHTML = Games.list.map(g => '<option value="' + g.id + '">' + g.icon + ' ' + Utils.escapeHtml(g.name) + '</option>').join('');
  if (presetGame) gameSelect.value = presetGame;

  let isPrivate = !presetPublic;
  if (presetPublic) document.querySelectorAll('#privacy-toggle button').forEach(b => b.classList.toggle('active', b.dataset.val === 'public'));

  function currentGame() { return Games.get(gameSelect.value); }
  let maxVal = currentGame().idealTable;
  const maxValEl = document.getElementById('cp-max-val');
  maxValEl.textContent = maxVal;

  document.getElementById('cp-minus').addEventListener('click', () => { maxVal = Utils.clamp(maxVal - 1, currentGame().minPlayers, currentGame().maxPlayers); maxValEl.textContent = maxVal; });
  document.getElementById('cp-plus').addEventListener('click', () => { maxVal = Utils.clamp(maxVal + 1, currentGame().minPlayers, currentGame().maxPlayers); maxValEl.textContent = maxVal; });
  gameSelect.addEventListener('change', () => { maxVal = currentGame().idealTable; maxValEl.textContent = maxVal; });

  document.querySelectorAll('#privacy-toggle button').forEach(btn => btn.addEventListener('click', () => {
    isPrivate = btn.dataset.val === 'private';
    document.querySelectorAll('#privacy-toggle button').forEach(b => b.classList.toggle('active', b === btn));
  }));

  document.getElementById('cp-create-btn').addEventListener('click', () => requireNickname(() => {
    Net.send('create_room', { gameId: gameSelect.value, name: document.getElementById('cp-name').value, isPrivate, maxPlayers: maxVal });
    UI.toast(isPrivate ? 'Table created \u2014 share the code!' : 'Your public table is live.', 'success');
  }));
}

function renderJoinPrivate(root) {
  root.innerHTML =
    '<div class="view wrap section narrow">' +
      '<div class="page-head"><h1>Join a private table</h1><p>Enter the 6-character code a friend sent you.</p></div>' +
      '<div class="form-card">' +
        '<div class="field"><label for="jp-code">Room code</label><input class="input input-code" id="jp-code" maxlength="6" placeholder="XXXXXX" autocomplete="off"></div>' +
        '<div class="field-error" id="jp-error"></div>' +
        '<button class="btn btn-primary btn-lg btn-block" id="jp-join-btn">Join table</button>' +
      '</div>' +
    '</div>';

  const input = document.getElementById('jp-code');
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('jp-join-btn').click(); } });

  document.getElementById('jp-join-btn').addEventListener('click', () => requireNickname(() => {
    const code = input.value.trim();
    const errEl = document.getElementById('jp-error');
    if (code.length !== 6) { errEl.textContent = 'Codes are 6 characters.'; return; }
    errEl.textContent = '';
    Net.send('join_by_code', { code });
  }));
}

function renderNotFound(root) {
  root.innerHTML = '<div class="view wrap section" style="text-align:center;"><div class="empty-state"><span class="suit-flourish">\u2660 \u2665 \u2666 \u2663</span><h4>Table\u2019s not here</h4><p>That page doesn\u2019t exist.</p><a href="#/home" class="btn btn-primary" style="margin-top:1rem;">Back home</a></div></div>';
}

/* ---------- Room view (lobby + table) ---------- */
let lastRenderedChatCount = 0;

function renderRoomWaiting(root, msg) {
  root.innerHTML =
    '<div class="view wrap section" style="text-align:center;"><div class="empty-state">' +
      '<span class="suit-flourish">\u2660 \u2665</span><h4>' + Utils.escapeHtml(msg) + '</h4>' +
    '</div></div>';
}

function cleanupRoomView() { /* no timers to clear anymore — the server pushes updates in real time */ }

function renderRoomView(root, roomId) {
  if (!ClientState.hasNickname()) {
    renderRoomWaiting(root, 'Pick a nickname to take a seat');
    requireNickname(() => Router.navigate('/room/' + roomId));
    return;
  }
  if (ClientState.room && ClientState.room.id === roomId) {
    buildRoomShell(root, ClientState.room);
    syncRoomView();
  } else {
    renderRoomWaiting(root, 'Joining table\u2026');
    Net.send('join_room', { roomId, asSpectator: false });
  }
}

function buildRoomShell(root, room) {
  const game = Games.get(room.gameId);
  root.innerHTML =
    '<div class="view wrap section">' +
      '<div class="room-view-header">' +
        '<div class="room-title-block">' +
          '<h2>' + game.icon + ' <span id="room-name-text">' + Utils.escapeHtml(room.name) + '</span></h2>' +
          '<div class="room-sub" id="room-sub-line"></div>' +
        '</div>' +
        '<div class="room-header-actions" id="room-header-actions"></div>' +
      '</div>' +
      '<div class="room-layout">' +
        '<div class="room-main">' +
          '<div class="ready-strip" id="ready-strip"></div>' +
          '<div id="game-area"></div>' +
        '</div>' +
        '<div class="room-sidebar">' +
          '<div class="panel">' +
            '<h4 style="font-family:var(--font-display);margin-bottom:.75rem;">Players</h4>' +
            '<div class="player-list" id="player-list"></div>' +
            '<div class="spectator-list" id="spectator-list"></div>' +
          '</div>' +
          '<div class="chat-panel">' +
            '<div class="chat-log" id="chat-log"></div>' +
            '<form class="chat-form" id="chat-form">' +
              '<input class="input" id="chat-input" placeholder="Say something\u2026" autocomplete="off" maxlength="240">' +
              '<button class="btn btn-primary btn-icon" type="submit" aria-label="Send">' + Icons.send + '</button>' +
            '</form>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  lastRenderedChatCount = 0;
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (!input.value.trim()) return;
    Net.send('chat', { text: input.value });
    input.value = '';
  });
}

function statusBadgeHtml(status) {
  const cls = status === 'playing' ? 'badge-playing' : (status === 'finished' ? 'badge-finished' : 'badge-waiting');
  return '<span class="badge ' + cls + '">' + status + '</span>';
}

function syncRoomView() {
  const room = ClientState.room;
  if (!room) return;
  const me = room.players.find(p => p.id === ClientState.id);
  const isHost = !!(me && me.isHost);

  const subEl = document.getElementById('room-sub-line');
  if (subEl) {
    const bits = [statusBadgeHtml(room.status)];
    if (room.isPrivate) bits.push('<span class="badge badge-private">Private</span>');
    if (room.isPrivate && room.code) bits.push('<span class="room-code-chip">' + room.code + '</span>');
    bits.push('<span>' + room.players.length + '/' + room.maxPlayers + ' players</span>');
    if (room.spectators.length) bits.push('<span>' + Icons.eye + ' ' + room.spectators.length + ' watching</span>');
    subEl.innerHTML = bits.join('<span style="opacity:.4"> \u00b7 </span>');
  }

  const actionsEl = document.getElementById('room-header-actions');
  if (actionsEl) {
    let html = '';
    if (room.isPrivate && room.code) html += '<button class="btn btn-secondary btn-sm" id="copy-code-btn">' + Icons.copy + ' Copy code</button>';
    html += '<button class="btn btn-danger btn-sm" id="leave-room-btn">Leave table</button>';
    actionsEl.innerHTML = html;
    const copyBtn = document.getElementById('copy-code-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      const code = room.code;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => UI.toast('Code copied \u2014 send it to a friend.', 'success')).catch(() => UI.toast(code, 'info', 'Room code'));
      } else { UI.toast(code, 'info', 'Room code'); }
    });
    document.getElementById('leave-room-btn').addEventListener('click', confirmLeaveRoom);
  }

  const readyStrip = document.getElementById('ready-strip');
  if (readyStrip) {
    if (room.status === 'waiting' && me) {
      readyStrip.style.display = '';
      readyStrip.innerHTML =
        '<div>' + (me.ready ? '<span class="ready-tag">' + Icons.check + ' You\u2019re ready</span>' : '<span class="muted">Ready up when you\u2019re set.</span>') + '</div>' +
        '<div class="ready-strip-actions">' +
          '<button class="btn btn-secondary" id="ready-btn">' + (me.ready ? 'Not ready' : 'Ready up') + '</button>' +
          (isHost ? '<button class="btn btn-primary" id="start-btn"' + (canStartRoom(room) ? '' : ' disabled') + '>Start game</button>' : '') +
        '</div>';
      document.getElementById('ready-btn').addEventListener('click', () => Net.send('toggle_ready', {}));
      const startBtn = document.getElementById('start-btn');
      if (startBtn) startBtn.addEventListener('click', () => Net.send('start_game', {}));
    } else if (room.status === 'waiting' && !me) {
      readyStrip.style.display = '';
      const openSeat = room.players.length < room.maxPlayers;
      readyStrip.innerHTML =
        '<div class="muted">You\u2019re watching from the rail. ' + (openSeat ? 'A seat is open \u2014 want in?' : 'Table is full right now.') + '</div>' +
        (openSeat ? '<button class="btn btn-primary" id="take-seat-btn">Take a seat</button>' : '');
      const seatBtn = document.getElementById('take-seat-btn');
      if (seatBtn) seatBtn.addEventListener('click', () => Net.send('take_seat', {}));
    } else {
      readyStrip.style.display = 'none';
    }
  }

  renderPlayerList(room);

  const specEl = document.getElementById('spectator-list');
  if (specEl) specEl.textContent = room.spectators.length ? ('Watching: ' + room.spectators.map(s => s.nickname).join(', ')) : '';

  renderChatLog(room);
  renderGameArea(room);
}

function renderPlayerList(room) {
  const el = document.getElementById('player-list');
  if (!el) return;
  el.innerHTML = room.players.map(p => {
    const flags = [];
    if (p.isHost) flags.push('<span class="host-tag" title="Host">' + Icons.crown + '</span>');
    if (p.isBot) flags.push('<span class="bot-tag">Bot</span>');
    if (room.status === 'waiting') flags.push(p.ready ? '<span class="ready-tag">' + Icons.check + '</span>' : '<span class="muted" style="font-size:.75rem;">not ready</span>');
    return (
      '<div class="player-row' + (p.id === ClientState.id ? ' is-self' : '') + '">' +
        '<div class="player-avatar">' + Utils.escapeHtml(Utils.initial(p.nickname)) + '</div>' +
        '<div class="player-info"><div class="player-name-row"><span class="nm">' + Utils.escapeHtml(p.nickname) + (p.id === ClientState.id ? ' (you)' : '') + '</span></div></div>' +
        '<div class="player-flags">' + flags.join('') + '</div>' +
      '</div>'
    );
  }).join('');
}

function renderChatLog(room) {
  const el = document.getElementById('chat-log');
  if (!el) return;
  const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = room.chat.map(m => {
    if (m.system) return '<div class="chat-message system">' + Utils.escapeHtml(m.text) + '</div>';
    const mine = m.authorId === ClientState.id;
    return '<div class="chat-message' + (mine ? ' me' : '') + '"><span class="who">' + Utils.escapeHtml(m.nickname) + '</span>' + Utils.escapeHtml(m.text) + '</div>';
  }).join('');
  if (wasNearBottom || room.chat.length !== lastRenderedChatCount) el.scrollTop = el.scrollHeight;
  lastRenderedChatCount = room.chat.length;
}

function confirmLeaveRoom() {
  UI.openModal({
    title: 'Leave this table?',
    body: 'You can rejoin later with the same room code if it\u2019s private, or from the public list.',
    actions: [
      { label: 'Stay', className: 'btn-ghost' },
      { label: 'Leave table', className: 'btn-danger', onClick: () => {
          Net.send('leave_room', {});
          ClientState.room = null;
          Router.navigate('/rooms');
          UI.toast('You left the table.', 'info');
        } }
    ]
  });
}

function renderGameArea(room) {
  const el = document.getElementById('game-area');
  if (!el) return;

  if (room.status === 'waiting' || !room.game) {
    const game = Games.get(room.gameId);
    el.innerHTML = '<div class="empty-state"><span class="suit-flourish">' + game.icon + '</span><h4>Waiting in the lobby</h4><p>Ready up, then the host can start the table.</p></div>';
    return;
  }

  if (room.gameId === 'blackjack') renderBlackjackTable(el, room.game);
  else renderPokerTable(el, room.game);
}

/* ---------- Game table renderers ---------- */
/* ---------- 15. GAME TABLE RENDERERS ---------- */

function cardHtml(card, extraClass) {
  if (!card) return cardBackHtml(extraClass);
  const red = Cards.isRed(card.suit);
  const label = Cards.rankLabel(card.rank);
  const suit = Cards.suitSymbol(card.suit);
  return (
    '<div class="playing-card' + (red ? ' red' : '') + (extraClass ? ' ' + extraClass : '') + '">' +
      '<span class="pip-top">' + label + suit + '</span>' +
      '<span class="suit-big">' + suit + '</span>' +
      '<span class="pip-bottom">' + label + suit + '</span>' +
    '</div>'
  );
}
function cardBackHtml(extraClass) { return '<div class="playing-card playing-card--back' + (extraClass ? ' ' + extraClass : '') + '"></div>'; }
function cardBackSmHtml() { return '<div class="playing-card playing-card--back playing-card-sm"></div>'; }

function phaseLabelBlackjack(phase) {
  return { betting: 'Placing bets\u2026', playerTurns: 'Player turns', dealerTurn: 'Dealer\u2019s turn', roundEnd: 'Round complete' }[phase] || phase;
}
function phaseLabelPoker(phase) {
  return { preflop: 'Pre-flop betting', flop: 'The flop', turn: 'The turn', river: 'The river', showdown: 'Showdown' }[phase] || phase;
}

/* ---- Blackjack ---- */
function paintBlackjackTable(el, vm, handlers) {
  const dealerVal = vm.dealerHidden ? null : Blackjack.handValue(vm.dealerHand.filter(Boolean));
  const dealerCardsHtml = vm.dealerHand.map((c, i) => ((vm.dealerHidden && i > 0) || c === null) ? cardBackHtml() : cardHtml(c)).join('');

  const seatsHtml = vm.seats.map(s => {
    const val = Blackjack.handValue(s.hand);
    const isTurn = vm.activeSeatId === s.id;
    const resultHtml = s.result ? '<span class="bj-result ' + s.result + '">' + s.result + '</span>' : '';
    return (
      '<div class="bj-seat' + (isTurn ? ' is-turn' : '') + (val.isBust ? ' is-bust' : '') + '">' +
        '<div class="bj-seat-name">' + Utils.escapeHtml(s.nickname) + (s.id === ClientState.id ? ' (you)' : '') + (s.isBot ? ' <span class="bot-tag">Bot</span>' : '') + '</div>' +
        '<div class="card-row overlap">' + s.hand.map(c => cardHtml(c, 'card-deal-anim')).join('') + '</div>' +
        '<div class="hand-value">' + (val.total || 0) + (val.isSoft && !val.isBust ? ' soft' : '') + (s.status === 'blackjack' ? ' \u2022 Blackjack!' : '') + '</div>' +
        '<div class="bj-bet">Bet ' + s.bet + ' \u00b7 ' + Utils.formatNumber(s.chips) + ' chips</div>' +
        resultHtml +
      '</div>'
    );
  }).join('');

  const isMyTurn = !!handlers && vm.activeSeatId === ClientState.id && vm.phase === 'playerTurns';
  let actionHtml = '';
  if (isMyTurn) {
    actionHtml = '<div class="action-bar"><button class="btn btn-primary" id="bj-hit-btn">Hit</button><button class="btn btn-secondary" id="bj-stand-btn">Stand</button></div>';
  } else if (handlers && vm.phase === 'roundEnd') {
    actionHtml = '<div class="action-bar"><button class="btn btn-primary" id="bj-next-btn">Deal next round</button><button class="btn btn-secondary" id="bj-lobby-btn">Back to lobby</button></div>';
  }

  el.innerHTML =
    '<div class="table-wrap"><div class="table-felt">' +
      '<div class="table-status-line"><span>' + phaseLabelBlackjack(vm.phase) + '</span>' + (vm.isLive ? '' : '<span class="badge badge-waiting">Spectating</span>') + '</div>' +
      '<div class="dealer-area"><div class="dealer-label">Dealer</div><div class="card-row overlap">' + dealerCardsHtml + '</div>' + (dealerVal ? '<div class="hand-value">' + dealerVal.total + '</div>' : '') + '</div>' +
      '<div class="bj-seats">' + seatsHtml + '</div>' +
      actionHtml +
    '</div></div>';

  if (handlers) {
    const hit = document.getElementById('bj-hit-btn'); if (hit) hit.addEventListener('click', handlers.onHit);
    const stand = document.getElementById('bj-stand-btn'); if (stand) stand.addEventListener('click', handlers.onStand);
    const next = document.getElementById('bj-next-btn'); if (next) next.addEventListener('click', handlers.onNext);
    const lobby = document.getElementById('bj-lobby-btn'); if (lobby) lobby.addEventListener('click', handlers.onLobby);
  }
}


function renderBlackjackTable(el, game) {
  const vm = {
    dealerHand: game.dealerHand, dealerHidden: game.phase === 'playerTurns',
    seats: game.seats, activeSeatId: game.activeSeatId, phase: game.phase,
    isLive: game.seats.some(s => s.id === ClientState.id)
  };
  paintBlackjackTable(el, vm, {
    onHit: () => Net.send('game_action', { action: 'hit' }),
    onStand: () => Net.send('game_action', { action: 'stand' }),
    onNext: () => Net.send('play_again', {}),
    onLobby: () => Net.send('return_to_lobby', {})
  });
}
function seatPositions(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI / 2) + (i / count) * Math.PI * 2; // i=0 -> bottom-center
    const left = 50 + 42 * Math.cos(angle);
    const top = 50 + 40 * Math.sin(angle);
    positions.push({ top: Utils.clamp(top, 6, 94), left: Utils.clamp(left, 8, 92) });
  }
  return positions;
}
function rotateSeatsForViewer(seats, viewerId) {
  const idx = seats.findIndex(s => s.id === viewerId);
  if (idx === -1) return seats;
  return seats.slice(idx).concat(seats.slice(0, idx));
}

function paintPokerTable(el, vm, handlers) {
  const ordered = rotateSeatsForViewer(vm.seats, ClientState.id);
  const positions = seatPositions(ordered.length);

  const seatsHtml = ordered.map((s, i) => {
    const pos = positions[i];
    const isTurn = vm.activeSeatId === s.id;
    const isDealer = vm.dealerId === s.id;
    const showHole = vm.phase === 'showdown' ? !s.folded : s.id === ClientState.id;
    let holeCards;
    if (showHole && s.hole && s.hole.length) holeCards = s.hole.map(c => cardHtml(c, 'playing-card-sm')).join('');
    else if (s.folded) holeCards = '';
    else holeCards = cardBackSmHtml() + cardBackSmHtml();
    const won = (vm.lastWinners || []).find(w => w.id === s.id);
    const wonHtml = won ? '<div class="badge badge-playing" style="margin-top:.2rem;">Won ' + Utils.formatNumber(won.amount) + '</div>' : '';
    return (
      '<div class="poker-seat' + (isTurn ? ' is-turn' : '') + (s.folded ? ' is-folded' : '') + '" style="top:' + pos.top + '%;left:' + pos.left + '%;">' +
        '<div class="poker-seat-card">' +
          (isDealer ? '<span class="dealer-btn">D</span>' : '') +
          '<div class="poker-seat-name">' + Utils.escapeHtml(s.nickname) + (s.id === ClientState.id ? ' (you)' : '') + '</div>' +
          '<div class="poker-seat-stack">' + Utils.formatNumber(s.stack) + '</div>' +
          (s.committed ? '<div class="poker-seat-bet">bet ' + s.committed + '</div>' : '') +
          wonHtml +
        '</div>' +
        '<div class="poker-seat-holecards">' + holeCards + '</div>' +
      '</div>'
    );
  }).join('');

  const communityHtml = vm.community.map(c => cardHtml(c, 'card-deal-anim')).join('');
  const mySeat = vm.seats.find(s => s.id === ClientState.id);
  const isMyTurn = !!handlers && vm.phase !== 'showdown' && vm.activeSeatId === ClientState.id && mySeat;
  let actionHtml = '';

  if (isMyTurn) {
    const toCall = vm.currentBet - mySeat.committed;
    const canCheck = toCall <= 0;
    const minRaiseTo = vm.currentBet + vm.minRaise;
    const maxRaiseTo = mySeat.committed + mySeat.stack;
    actionHtml =
      '<div class="action-bar">' +
        '<button class="btn btn-danger" id="pk-fold-btn">Fold</button>' +
        (canCheck ? '<button class="btn btn-secondary" id="pk-check-btn">Check</button>' : '<button class="btn btn-secondary" id="pk-call-btn">Call ' + Utils.formatNumber(Math.min(toCall, mySeat.stack)) + '</button>') +
        (maxRaiseTo > minRaiseTo && mySeat.stack > 0 ?
          ('<div class="bet-controls"><div class="raise-slider"><input type="range" id="pk-raise-range" min="' + minRaiseTo + '" max="' + maxRaiseTo + '" value="' + minRaiseTo + '" step="' + Math.max(1, Math.round(CFG.BIG_BLIND / 2)) + '"></div>' +
          '<span class="mono" id="pk-raise-value">' + Utils.formatNumber(minRaiseTo) + '</span>' +
          '<button class="btn btn-primary" id="pk-raise-btn">Raise to</button></div>') : '') +
      '</div>';
  } else if (handlers && vm.phase === 'showdown') {
    if (vm.tableBusted) {
      actionHtml = '<div class="action-bar"><span class="muted" style="align-self:center;">Only one stack left standing.</span><button class="btn btn-secondary" id="pk-lobby-btn">Back to lobby</button></div>';
    } else {
      actionHtml = '<div class="action-bar"><button class="btn btn-primary" id="pk-next-btn">Deal next hand</button><button class="btn btn-secondary" id="pk-lobby-btn">Back to lobby</button></div>';
    }
  }

  el.innerHTML =
    '<div class="table-wrap">' +
      '<div class="table-status-line"><span>' + phaseLabelPoker(vm.phase) + '</span>' + (vm.isLive ? '' : '<span class="badge badge-waiting">Spectating</span>') + '</div>' +
      '<div class="poker-table-outer"><div class="poker-oval">' +
        seatsHtml +
        '<div class="poker-center"><div class="pot-display">Pot ' + Utils.formatNumber(vm.pot) + '</div><div class="community-cards">' + communityHtml + '</div></div>' +
      '</div></div>' +
      actionHtml +
    '</div>';

  if (handlers) {
    const foldBtn = document.getElementById('pk-fold-btn'); if (foldBtn) foldBtn.addEventListener('click', handlers.onFold);
    const checkBtn = document.getElementById('pk-check-btn'); if (checkBtn) checkBtn.addEventListener('click', handlers.onCheck);
    const callBtn = document.getElementById('pk-call-btn'); if (callBtn) callBtn.addEventListener('click', handlers.onCall);
    const raiseRange = document.getElementById('pk-raise-range');
    const raiseValue = document.getElementById('pk-raise-value');
    if (raiseRange) raiseRange.addEventListener('input', () => { raiseValue.textContent = Utils.formatNumber(raiseRange.value); });
    const raiseBtn = document.getElementById('pk-raise-btn');
    if (raiseBtn) raiseBtn.addEventListener('click', () => handlers.onRaise(parseInt(raiseRange.value, 10)));
    const nextBtn = document.getElementById('pk-next-btn'); if (nextBtn) nextBtn.addEventListener('click', handlers.onNext);
    const lobbyBtn = document.getElementById('pk-lobby-btn'); if (lobbyBtn) lobbyBtn.addEventListener('click', handlers.onLobby);
  }
}


function renderPokerTable(el, game) {
  const vm = {
    seats: game.seats, community: game.community, pot: game.pot,
    activeSeatId: game.activeSeatId, dealerId: game.dealerId,
    phase: game.phase, currentBet: game.currentBet, minRaise: game.minRaise,
    lastWinners: game.lastWinners, tableBusted: !!game.tableBusted,
    isLive: game.seats.some(s => s.id === ClientState.id)
  };
  paintPokerTable(el, vm, {
    onFold: () => Net.send('game_action', { action: 'fold' }),
    onCheck: () => Net.send('game_action', { action: 'check' }),
    onCall: () => Net.send('game_action', { action: 'call' }),
    onRaise: (amt) => Net.send('game_action', { action: 'raise', amount: amt }),
    onNext: () => Net.send('play_again', {}),
    onLobby: () => Net.send('return_to_lobby', {})
  });
}

/* ---------- 16. INIT ---------- */
function refreshVisibleStats() {
  const headerCount = document.getElementById('header-online-count');
  if (headerCount) headerCount.textContent = Utils.formatNumber(ClientState.stats.online);
  if (document.getElementById('stats-bar')) renderStatsBar('stats-bar');
  if (document.getElementById('home-game-grid')) renderGameGrid('home-game-grid', document.getElementById('home-search') ? document.getElementById('home-search').value : '', { full: false });
}

const App = {
  init() {
    Router.init();
    renderNicknamePill();
    setupMobileNav();
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => UI.closeModal());

    Net.on('_open', ({ wasReconnect }) => {
      renderConnectionBanner('connected');
      if (wasReconnect) {
        if (ClientState.nickname) Net.send('hello', { nickname: ClientState.nickname });
        if (ClientState.room) Net.send('join_room', { roomId: ClientState.room.id });
        UI.toast('Back online.', 'success');
      }
    });
    Net.on('_close', () => renderConnectionBanner('reconnecting'));

    Net.on('welcome', (msg) => {
      ClientState.id = msg.id;
      if (msg.nickname) ClientState.nickname = msg.nickname;
      renderNicknamePill();
    });

    Net.on('stats', (msg) => {
      ClientState.stats = { online: msg.online, perGame: msg.perGame || {}, publicRooms: msg.publicRooms || 0 };
      refreshVisibleStats();
      if (Router.current === '/games') { /* stats-only badges refresh lazily on next render, fine to skip here */ }
    });

    Net.on('rooms_list', (msg) => {
      ClientState.roomsList = msg.rooms || [];
      if (Router.current === '/rooms') renderRoomsGrid();
    });

    Net.on('room_state', (msg) => {
      ClientState.room = msg.room;
      const path = '/room/' + msg.room.id;
      if (Router.current !== path) Router.navigate(path);
      else syncRoomView();
    });

    Net.on('room_closed', (msg) => {
      if (ClientState.room && ClientState.room.id === msg.roomId) {
        ClientState.room = null;
        UI.toast('That table closed.', 'info');
        Router.navigate('/rooms');
      }
    });

    Net.on('error', (msg) => {
      UI.toast(msg.message, 'danger');
      if (Router.current && Router.current.indexOf('/room/') === 0) {
        const routeRoomId = Router.current.slice('/room/'.length);
        if (!ClientState.room || ClientState.room.id !== routeRoomId) Router.navigate('/rooms');
      }
    });

    renderConnectionBanner('connecting');
    Net.connect();
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
