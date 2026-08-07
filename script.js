/* ============================================================
   LUDEX — script.js
   Vanilla JS multiplayer card-game lounge. No build step, no
   frameworks. Everything is namespaced into small modules so a
   new game can be added without touching unrelated code.

   IMPORTANT — how "multiplayer" works here:
   This is a static front-end with no game server. We approximate
   multiplayer two ways:
     1. REAL cross-tab sync via localStorage. Open two tabs of this
        site in the same browser and they genuinely share rooms,
        players, ready-states and chat (see the Store module).
     2. Simulated bots fill empty seats with simple AI so a table
        never feels dead when you're testing solo.
   Swapping this for a real backend later means replacing the
   Store + Rooms modules with real network calls — the rest of the
   app (UI, routing, game engines) doesn't need to know the
   difference, since they only ever talk to Rooms/Store.

   Table of contents
     1.  Config & constants
     2.  Utils
     3.  Store (localStorage + cross-tab pub/sub)
     4.  Session (identity / nickname)
     5.  Presence & live stats
     6.  Bots (names, chat, simple AI)
     7.  Games registry
     8.  Cards, poker hand evaluation, blackjack hand value
     9.  Rooms (create/join/leave/ready/start/chat)
     10. BlackjackGame engine
     11. PokerGame engine
     12. Router
     13. UI helpers (icons, toast, modal)
     14. View renderers (home, games, rooms, create/join, room)
     15. Game table renderers (blackjack + poker, live & spectator)
     16. Init
   ============================================================ */

/* ---------- 1. CONFIG & CONSTANTS ---------- */
const CFG = {
  STORAGE_PREFIX: 'ludex:',
  PRESENCE_TTL_MS: 15000,     // a tab counts "online" if it heartbeat within this window
  HEARTBEAT_MS: 4000,
  TICK_MS: 2500,               // global tick: stats drift, bot ready-up, bot chat
  ROOM_POLL_MS: 2000,          // fallback poll while inside a room (in addition to storage events)
  STALE_ROOM_MS: 90000,        // a "playing" room with no updates this long is considered stalled
  STARTING_CHIPS: 1000,
  SMALL_BLIND: 10,
  BIG_BLIND: 20,
};

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
const SUIT_RED = { S: false, H: true, D: true, C: false };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

// Live game engines, keyed by roomId. Only the tab that clicked
// "Start" for a given room ever populates this — everyone else
// renders a read-only snapshot instead (see Rooms.updateSnapshot).
const ActiveEngines = new Map();

// Small bag of transient UI state that doesn't belong in Session
// or in a persisted Room (search boxes, filters, one-shot presets).
const AppState = {
  roomsFilter: 'all',
  roomsSearch: '',
  pendingGameFilter: null,
  presetPrivateGame: null,
  presetPublic: false,
  currentRoomId: null,
};

/* ---------- 2. UTILS ---------- */
const Utils = {
  uid(prefix) {
    return (prefix ? prefix + '_' : '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },
  roomCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  },
  escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, ch => map[ch]);
  },
  clamp(n, min, max) { return Math.min(max, Math.max(min, n)); },
  randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
  randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  },
  formatNumber(n) { return Number(n || 0).toLocaleString('en-US'); },
  initial(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?'; },
  timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }
};

/* ---------- 3. STORE ----------
   Thin wrapper around localStorage that namespaces keys and turns
   the native `storage` event into a scoped subscription. Reads and
   writes are try/caught — if storage is unavailable (privacy mode,
   sandboxed iframe, etc.) the app quietly falls back to an
   in-memory Map so nothing crashes, it just stops syncing across
   tabs and behaves like a single-player session.
*/
const Store = (() => {
  let memory = null;

  function probe() {
    try {
      const k = '__ludex_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  const useMemory = !probe();
  if (useMemory) memory = new Map();

  function fullKey(k) { return CFG.STORAGE_PREFIX + k; }

  function get(k, fallback) {
    try {
      if (useMemory) return memory.has(k) ? memory.get(k) : fallback;
      const raw = window.localStorage.getItem(fullKey(k));
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function set(k, value) {
    try {
      if (useMemory) { memory.set(k, value); return true; }
      window.localStorage.setItem(fullKey(k), JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  function remove(k) {
    try {
      if (useMemory) { memory.delete(k); return; }
      window.localStorage.removeItem(fullKey(k));
    } catch (e) { /* no-op */ }
  }

  const listeners = new Set();
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key.indexOf(CFG.STORAGE_PREFIX) !== 0) return;
    const shortKey = e.key.slice(CFG.STORAGE_PREFIX.length);
    listeners.forEach(fn => { try { fn(shortKey); } catch (err) { /* no-op */ } });
  });
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { get, set, remove, onChange, isCrossTabAvailable: !useMemory };
})();

/* ---------- 4. SESSION ----------
   No accounts, no persistence: identity is a random id created
   fresh on every load, and the nickname lives in memory only —
   refreshing the page always starts over, exactly as the brief
   asks for.
*/
const Session = {
  id: Utils.uid('u'),
  nickname: null,
  hasNickname() { return !!this.nickname; },
  setNickname(name) {
    const clean = String(name || '').trim().slice(0, 18);
    if (clean.length < 2) return false;
    this.nickname = clean;
    Presence.beat();
    return true;
  },
  avatarLetter() { return Utils.initial(this.nickname); }
};

/* ---------- 5. PRESENCE & LIVE STATS ----------
   Presence is genuinely real across tabs of the same browser (a
   heartbeat row per tab in localStorage). On top of that we blend
   in a slow-drifting simulated baseline so the lounge feels like a
   live platform rather than an empty room when you're the only one
   testing it.
*/
const Presence = {
  baseline: Utils.randInt(640, 1180),
  _timer: null,
  beat() {
    if (!Session.hasNickname()) return;
    const all = Store.get('presence', {});
    all[Session.id] = { nickname: Session.nickname, ts: Date.now() };
    Store.set('presence', all);
  },
  clear() {
    const all = Store.get('presence', {});
    delete all[Session.id];
    Store.set('presence', all);
  },
  realOnlineCount() {
    const all = Store.get('presence', {});
    const now = Date.now();
    let n = 0;
    for (const id in all) { if (now - all[id].ts <= CFG.PRESENCE_TTL_MS) n++; }
    return n;
  },
  start() {
    this.beat();
    this._timer = setInterval(() => {
      this.beat();
      this.baseline = Utils.clamp(this.baseline + Utils.randInt(-6, 7), 520, 2200);
    }, CFG.HEARTBEAT_MS);
    window.addEventListener('beforeunload', () => this.clear());
  },
  onlineCount() { return this.baseline + this.realOnlineCount(); }
};

const Stats = {
  snapshot() {
    const online = Presence.onlineCount();
    const rooms = Rooms.all();
    let publicCount = 0, privateCount = 0;
    const perGame = {};
    Games.list.forEach(g => { perGame[g.id] = Utils.randInt(g.baselineMin, g.baselineMax); });
    Object.values(rooms).forEach(r => {
      if (r.isPrivate) privateCount++; else publicCount++;
      perGame[r.gameId] = (perGame[r.gameId] || 0) + r.players.length;
    });
    return { online, perGame, publicRooms: publicCount, privateRooms: privateCount };
  }
};

/* ---------- 6. BOTS ---------- */
const Bots = {
  NAMES: [
    'ShadowFox', 'LuckyDeuce', 'MidnightRaven', 'ChipMonk', 'BluffMaster', 'AceInTheHole',
    'RiverRat', 'PocketRocket', 'FeltKing', 'QuietStorm', 'GrinderGus', 'TableTilt',
    'DealMeIn', 'CardsharkCleo', 'VelvetHand', 'LastCallLuna', 'StackAttack', 'AllInAmy',
    'HighRollerHal', 'SuitedUp', 'KingMeKit', 'DoubleDownDee', 'WildJoker', 'NoTellNell',
    'BankrollBea', 'SoftSeventeen'
  ],
  CHAT_LINES: [
    'gl all \ud83c\udf40', 'let\u2019s run it up', 'nice hand!', 'brutal beat \ud83d\ude29', 'in like flynn',
    'shuffle up and deal', 'big stack energy', 'tough spot there', 'gg',
    'table\u2019s heating up \ud83d\udd25', 'raise it up!', 'felt that one', 'one more hand',
    'this seat is lucky tonight', 'been a minute since I busted'
  ],
  randomName(exclude) {
    const usedSet = exclude instanceof Set ? exclude : new Set(exclude || []);
    const pool = this.NAMES.filter(n => !usedSet.has(n));
    return pool.length ? Utils.randChoice(pool) : 'Guest' + Utils.randInt(100, 999);
  },
  chatLine() { return Utils.randChoice(this.CHAT_LINES); },
  makeBotPlayers(count, existingNames) {
    const used = new Set(existingNames || []);
    const bots = [];
    for (let i = 0; i < count; i++) {
      const name = this.randomName(used);
      used.add(name);
      bots.push({
        id: Utils.uid('bot'), nickname: name, ready: false, isBot: true, isHost: false,
        joinedAt: Date.now(), readyAt: Date.now() + Utils.randInt(900, 3200)
      });
    }
    return bots;
  },
  // Simple "hit until 17" style dealer strategy — good enough for table bots.
  blackjackDecision(total, isSoft) {
    if (isSoft) return total <= 17 ? 'hit' : 'stand';
    return total <= 16 ? 'hit' : 'stand';
  },
  // Rough hand-strength heuristic with a little randomness for personality.
  pokerDecision({ handStrength, toCall, potOdds, stack, canCheck }) {
    const aggression = Math.random();
    if (toCall === 0) {
      if (handStrength > 0.72 && aggression > 0.45) return { action: 'raise' };
      return { action: 'check' };
    }
    if (handStrength < 0.28 - potOdds * 0.15) {
      return canCheck ? { action: 'check' } : { action: 'fold' };
    }
    if (handStrength > 0.78 && aggression > 0.4 && toCall < stack) return { action: 'raise' };
    if (toCall >= stack) return handStrength > 0.5 ? { action: 'call' } : { action: 'fold' };
    return { action: 'call' };
  }
};

/* ---------- 7. GAMES REGISTRY ----------
   Adding a new game later = add an entry here (with a baseline
   player-count range for the stats bar) plus a matching Engine
   class and table renderer. Nothing in the room/lobby code needs
   to change.
*/
const Games = {
  list: [
    {
      id: 'blackjack', name: 'Blackjack', icon: '\u2660', tagline: 'Beat the dealer to 21.',
      description: 'Classic casino Blackjack. Hit, stand, and try to out-count the house without going bust.',
      minPlayers: 1, maxPlayers: 5, idealTable: 4, baselineMin: 180, baselineMax: 420
    },
    {
      id: 'poker', name: 'Texas Hold\u2019em', icon: '\u2663', tagline: 'Read the table. Take the pot.',
      description: 'No-limit Hold\u2019em with blinds, community cards and full betting rounds against the table.',
      minPlayers: 2, maxPlayers: 6, idealTable: 5, baselineMin: 120, baselineMax: 340
    }
  ],
  get(id) { return this.list.find(g => g.id === id) || null; }
};

/* ---------- 8. CARDS, HAND EVALUATION & BLACKJACK VALUE ---------- */
const Cards = {
  freshDeck() {
    const deck = [];
    for (const s of SUITS) { for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s }); }
    return Utils.shuffleInPlace(deck);
  },
  rankLabel(r) { return RANK_LABEL[r] || String(r); },
  suitSymbol(s) { return SUIT_SYMBOL[s]; },
  isRed(s) { return SUIT_RED[s]; }
};

// Standard 5-card poker hand ranking, generalized to "best 5 of 7"
// for Texas Hold'em (2 hole cards + 5 community cards).
const HandEval = (() => {
  const NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

  function combinations(arr, k) {
    const results = [];
    (function go(start, combo) {
      if (combo.length === k) { results.push(combo.slice()); return; }
      for (let i = start; i < arr.length; i++) { combo.push(arr[i]); go(i + 1, combo); combo.pop(); }
    })(0, []);
    return results;
  }

  // Returns a score array [category, tiebreak1, tiebreak2, ...] —
  // compare with compareScores(). Category is 0 (high card) .. 8
  // (straight flush).
  function evaluate5(cards) {
    const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);

    const counts = {};
    ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    const groups = Object.entries(counts)
      .map(([r, c]) => ({ rank: +r, count: c }))
      .sort((a, b) => b.count - a.count || b.rank - a.rank);

    const uniq = [...new Set(ranks)];
    let isStraight = false, straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
        isStraight = true; straightHigh = 5; // wheel: A-2-3-4-5
      }
    }

    if (isStraight && isFlush) return [8, straightHigh];
    if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
    if (groups[0].count === 3 && groups[1] && groups[1].count === 2) return [6, groups[0].rank, groups[1].rank];
    if (isFlush) return [5, ...ranks];
    if (isStraight) return [4, straightHigh];
    if (groups[0].count === 3) return [3, groups[0].rank, groups[1].rank, groups[2].rank];
    if (groups[0].count === 2 && groups[1] && groups[1].count === 2) return [2, groups[0].rank, groups[1].rank, groups[2].rank];
    if (groups[0].count === 2) return [1, groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank];
    return [0, ...ranks];
  }

  function compareScores(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] === undefined ? -1 : a[i];
      const bv = b[i] === undefined ? -1 : b[i];
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  function best5of7(cards7) {
    let best = null;
    combinations(cards7, 5).forEach(combo => {
      const score = evaluate5(combo);
      if (!best || compareScores(score, best) > 0) best = score;
    });
    return best;
  }

  function describe(score) { return NAMES[score[0]]; }

  return { evaluate5, best5of7, compareScores, describe, NAMES };
})();

const Blackjack = {
  handValue(cards) {
    let total = 0, aceCount = 0;
    cards.forEach(c => {
      if (c.rank === 14) { aceCount++; total += 11; }
      else if (c.rank >= 11 && c.rank <= 13) total += 10;
      else total += c.rank;
    });
    let acesAsEleven = aceCount;
    while (total > 21 && acesAsEleven > 0) { total -= 10; acesAsEleven--; }
    return {
      total,
      isSoft: acesAsEleven > 0,
      isBust: total > 21,
      isBlackjack: total === 21 && cards.length === 2
    };
  }
};

// Rough preflop / postflop hand-strength estimate (0..1) used by
// poker bots to decide fold/call/raise. Not perfect equity math —
// just enough for believable table behavior.
const PokerHelpers = {
  estimateHandStrength(hole, community) {
    if (!community.length) {
      const a = hole[0], b = hole[1];
      const hi = Math.max(a.rank, b.rank), lo = Math.min(a.rank, b.rank);
      let s = (hi - 2) / 12 * 0.5;
      if (a.rank === b.rank) {
        s = 0.55 + (a.rank - 2) / 12 * 0.4;
      } else {
        if (a.suit === b.suit) s += 0.07;
        const gap = hi - lo;
        if (gap <= 4) s += (5 - gap) * 0.015;
      }
      return Utils.clamp(s, 0.03, 0.97);
    }
    const score = HandEval.best5of7(hole.concat(community));
    let s = score[0] / 8;
    s += ((score[1] || 0) / 14) * 0.06;
    return Utils.clamp(s, 0.02, 0.99);
  }
};

/* ---------- 9. ROOMS ----------
   All room CRUD lives here. Real rooms are persisted through the
   Store (and therefore synced across tabs). "Ghost" rooms are
   lightweight, non-persisted placeholders generated purely so the
   public list feels lively — the moment someone actually joins
   one, materializeGhost() turns it into a real, synced room.
*/
const Rooms = {
  _ghosts: null,

  all() { return Store.get('rooms', {}); },
  get(id) { return this.all()[id] || null; },
  _save(rooms) { Store.set('rooms', rooms); },
  _touch(room) { room.updatedAt = Date.now(); },

  isStale(room) {
    return (room.status === 'playing' || room.status === 'finished') && (Date.now() - room.updatedAt) > CFG.STALE_ROOM_MS;
  },

  create({ gameId, name, isPrivate, maxPlayers }) {
    const game = Games.get(gameId);
    const room = {
      id: Utils.uid('room'),
      code: isPrivate ? Utils.roomCode() : null,
      isPrivate: !!isPrivate,
      gameId,
      name: (name && name.trim() ? name.trim() : (Session.nickname + '\u2019s table')).slice(0, 30),
      players: [{ id: Session.id, nickname: Session.nickname, ready: false, isBot: false, isHost: true, joinedAt: Date.now() }],
      spectators: [],
      maxPlayers: Utils.clamp(maxPlayers || game.idealTable, game.minPlayers, game.maxPlayers),
      status: 'waiting',
      chat: [{ id: Utils.uid('c'), system: true, text: Session.nickname + ' opened the table.', ts: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      publicSnapshot: null
    };
    const rooms = this.all();
    rooms[room.id] = room;
    this._save(rooms);
    return room;
  },

  ghostRooms() {
    if (this._ghosts) return this._ghosts;
    const out = [];
    Games.list.forEach(game => {
      const tableCount = Utils.randInt(2, 4);
      for (let i = 0; i < tableCount; i++) {
        const hostName = Bots.randomName([]);
        const seats = Utils.randInt(1, Math.max(1, game.idealTable - 1));
        out.push({
          id: Utils.uid('ghost'), isGhost: true, gameId: game.id,
          name: hostName + '\u2019s table', players: seats, maxPlayers: game.idealTable,
          status: 'waiting' // ghosts are always open lobbies; only real rooms ever show "playing"
        });
      }
    });
    this._ghosts = out;
    return out;
  },

  materializeGhost(ghostId) {
    const ghost = (this._ghosts || []).find(g => g.id === ghostId);
    if (!ghost) return null;
    const bots = Bots.makeBotPlayers(Math.max(0, ghost.players), []);
    const room = {
      id: Utils.uid('room'), code: null, isPrivate: false, gameId: ghost.gameId, name: ghost.name,
      players: bots, spectators: [], maxPlayers: ghost.maxPlayers, status: 'waiting',
      chat: [{ id: Utils.uid('c'), system: true, text: 'Table opened.', ts: Date.now() }],
      createdAt: Date.now(), updatedAt: Date.now(), publicSnapshot: null
    };
    const rooms = this.all();
    rooms[room.id] = room;
    this._save(rooms);
    this._ghosts = this._ghosts.filter(g => g.id !== ghostId);
    return room;
  },

  listPublicForDisplay(gameFilter) {
    this._pruneAllRealRooms();
    const real = Object.values(this.all()).filter(r => !r.isPrivate);
    const ghosts = this.ghostRooms();
    let merged = real.map(r => ({
      id: r.id, isGhost: false, gameId: r.gameId, name: r.name,
      players: r.players.length, maxPlayers: r.maxPlayers, status: r.status
    })).concat(ghosts.map(g => Object.assign({}, g)));
    if (gameFilter && gameFilter !== 'all') merged = merged.filter(r => r.gameId === gameFilter);
    return merged.sort((a, b) => b.players - a.players);
  },

  findByCode(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return null;
    return Object.values(this.all()).find(r => r.code === clean) || null;
  },

  join(roomId, opts) {
    opts = opts || {};
    let rooms = this.all();
    let room = rooms[roomId];
    if (!room && (this._ghosts || []).some(g => g.id === roomId)) {
      room = this.materializeGhost(roomId);
      rooms = this.all();
    }
    if (!room) return { ok: false, reason: 'not-found' };
    if (room.players.some(p => p.id === Session.id) || room.spectators.some(p => p.id === Session.id)) {
      return { ok: true, room, alreadyIn: true };
    }
    const asSpectator = !!opts.asSpectator || room.players.length >= room.maxPlayers;
    if (asSpectator) {
      room.spectators.push({ id: Session.id, nickname: Session.nickname });
    } else {
      const shouldBeHost = !room.players.some(p => p.isHost);
      room.players.push({ id: Session.id, nickname: Session.nickname, ready: false, isBot: false, isHost: shouldBeHost, joinedAt: Date.now() });
      room.chat.push({ id: Utils.uid('c'), system: true, text: Session.nickname + ' joined the table.', ts: Date.now() });
    }
    this._touch(room);
    rooms[room.id] = room;
    this._save(rooms);
    return { ok: true, room, asSpectator };
  },

  leave(roomId) {
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    const mine = room.players.find(p => p.id === Session.id);
    const wasHost = mine && mine.isHost;
    room.players = room.players.filter(p => p.id !== Session.id);
    room.spectators = room.spectators.filter(p => p.id !== Session.id);
    if (wasHost && room.players.length) {
      const next = room.players.find(p => !p.isBot) || room.players[0];
      next.isHost = true;
      room.chat.push({ id: Utils.uid('c'), system: true, text: next.nickname + ' is now the host.', ts: Date.now() });
    }
    if (mine) room.chat.push({ id: Utils.uid('c'), system: true, text: Session.nickname + ' left the table.', ts: Date.now() });
    const realPlayersLeft = room.players.filter(p => !p.isBot).length;
    if (realPlayersLeft === 0) {
      delete rooms[roomId];
      this._save(rooms);
      ActiveEngines.delete(roomId);
      return;
    }
    this._touch(room);
    this._save(rooms);
  },

  toggleReady(roomId) {
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    const me = room.players.find(p => p.id === Session.id);
    if (!me) return;
    me.ready = !me.ready;
    this._touch(room);
    this._save(rooms);
  },

  canStart(room) {
    // Note: we intentionally do NOT require room.players.length to already
    // meet the game's minPlayers here — startGameInRoom() fills any extra
    // seats with bots at start time, so a solo host can always start.
    if (!room || room.status !== 'waiting') return false;
    if (!room.players.length) return false;
    return room.players.every(p => p.ready);
  },

  sendChat(roomId, text, opts) {
    opts = opts || {};
    const clean = String(text || '').trim().slice(0, 240);
    if (!clean) return;
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    let authorId = null, nickname = null;
    if (opts.system) { authorId = null; nickname = null; }
    else if (opts.asPlayer) { authorId = opts.asPlayer.id; nickname = opts.asPlayer.nickname; }
    else { authorId = Session.id; nickname = Session.nickname; }
    room.chat.push({ id: Utils.uid('c'), authorId, nickname, text: clean, ts: Date.now(), system: !!opts.system });
    if (room.chat.length > 80) room.chat = room.chat.slice(-80);
    this._touch(room);
    this._save(rooms);
  },

  setStatus(roomId, status, extra) {
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    room.status = status;
    if (extra) Object.assign(room, extra);
    this._touch(room);
    this._save(rooms);
  },

  updateSnapshot(roomId, snapshot) {
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    room.publicSnapshot = snapshot;
    this._touch(room);
    this._save(rooms);
  },

  resetToLobby(roomId) {
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    room.status = 'waiting';
    room.publicSnapshot = null;
    room.players.forEach(p => {
      p.ready = false;
      if (p.isBot) p.readyAt = Date.now() + Utils.randInt(600, 2200);
    });
    this._touch(room);
    this._save(rooms);
  },

  // Removes real (non-bot) players whose presence heartbeat has gone
  // stale — handles refreshed/closed tabs leaving "ghost" seats behind.
  pruneStalePlayers(roomId) {
    const rooms = this.all();
    const room = rooms[roomId];
    if (!room) return;
    const presence = Store.get('presence', {});
    const now = Date.now();
    const isStale = p => !p.isBot && p.id !== Session.id && (!presence[p.id] || now - presence[p.id].ts > CFG.PRESENCE_TTL_MS * 2);
    const staleSeats = room.players.filter(isStale);
    const staleSpecs = room.spectators.filter(isStale);
    if (!staleSeats.length && !staleSpecs.length) return;
    const hostGone = staleSeats.some(p => p.isHost);
    room.players = room.players.filter(p => !isStale(p));
    room.spectators = room.spectators.filter(p => !isStale(p));
    staleSeats.concat(staleSpecs).forEach(p => room.chat.push({ id: Utils.uid('c'), system: true, text: p.nickname + ' disconnected.', ts: Date.now() }));
    if (hostGone && room.players.length) {
      const next = room.players.find(p => !p.isBot) || room.players[0];
      next.isHost = true;
      room.chat.push({ id: Utils.uid('c'), system: true, text: next.nickname + ' is now the host.', ts: Date.now() });
    }
    if (room.players.filter(p => !p.isBot).length === 0) {
      delete rooms[roomId];
      this._save(rooms);
      ActiveEngines.delete(roomId);
      return;
    }
    this._touch(room);
    this._save(rooms);
  },

  // Lightweight prune pass over every real public room, used before
  // building the public list so player counts shown there are fresh.
  _pruneAllRealRooms() {
    const rooms = this.all();
    const presence = Store.get('presence', {});
    const now = Date.now();
    let changed = false;
    Object.keys(rooms).forEach(id => {
      const room = rooms[id];
      const humanCount = room.players.filter(p => !p.isBot).length;
      if (humanCount === 0) return; // handled by pruneStalePlayers when actually viewed
      const anyAlive = room.players.some(p => p.isBot || p.id === Session.id || (presence[p.id] && now - presence[p.id].ts <= CFG.PRESENCE_TTL_MS * 2));
      if (!anyAlive) { delete rooms[id]; changed = true; }
    });
    if (changed) this._save(rooms);
  }
};

/* ---------- 10. BLACKJACK ENGINE ----------
   One instance per active table. Runs entirely in the memory of
   whichever tab clicked "Start" — see onEngineChange() in the UI
   section for how its state gets published for spectators.
*/
class BlackjackGame {
  constructor(room) {
    this.roomId = room.id;
    this.seats = room.players.map(p => ({
      id: p.id, nickname: p.nickname, isBot: p.isBot,
      hand: [], bet: 0, chips: CFG.STARTING_CHIPS, status: 'betting', result: null
    }));
    this.dealerHand = [];
    this.deck = Cards.freshDeck();
    this.phase = 'betting'; // betting -> playerTurns -> dealerTurn -> roundEnd
    this.activeSeatIndex = -1;
    this.onChange = null; // assigned by the caller right after construction
    this._autoBets();
  }

  _emit() { if (this.onChange) this.onChange(); }

  _autoBets() {
    // Flat ante from everyone so a round can start without extra bet UI.
    this.seats.forEach(s => {
      const ante = Math.min(25, s.chips);
      s.bet = ante;
      s.chips -= ante;
    });
    this._dealRound();
  }

  _dealRound() {
    this.deck = Cards.freshDeck();
    this.dealerHand = [this.deck.pop(), this.deck.pop()];
    this.seats.forEach(s => { s.hand = [this.deck.pop(), this.deck.pop()]; s.status = 'playing'; s.result = null; });
    this.phase = 'playerTurns';
    this.activeSeatIndex = -1;
    this._advanceTurn();
  }

  currentSeat() { return this.activeSeatIndex >= 0 ? this.seats[this.activeSeatIndex] : null; }

  _advanceTurn() {
    let next = this.activeSeatIndex + 1;
    while (next < this.seats.length && this.seats[next].status !== 'playing') next++;
    if (next >= this.seats.length) {
      this.activeSeatIndex = -1;
      this._dealerTurn();
      return;
    }
    this.activeSeatIndex = next;
    const seat = this.seats[next];
    const val = Blackjack.handValue(seat.hand);
    if (val.isBlackjack) {
      seat.status = 'blackjack';
      this._emit();
      this._advanceTurn();
      return;
    }
    this._emit();
    if (seat.isBot) setTimeout(() => this._botAct(seat), Utils.randInt(650, 1300));
  }

  _botAct(seat) {
    if (this.phase !== 'playerTurns' || this.currentSeat() !== seat) return;
    const val = Blackjack.handValue(seat.hand);
    const decision = Bots.blackjackDecision(val.total, val.isSoft);
    if (decision === 'hit') this.playerHit(seat.id);
    else this.playerStand(seat.id);
  }

  playerHit(playerId) {
    const seat = this.currentSeat();
    if (!seat || seat.id !== playerId || this.phase !== 'playerTurns') return;
    seat.hand.push(this.deck.pop());
    const val = Blackjack.handValue(seat.hand);
    if (val.isBust) { seat.status = 'bust'; this._emit(); this._advanceTurn(); return; }
    if (val.total === 21) { seat.status = 'stood'; this._emit(); this._advanceTurn(); return; }
    this._emit();
    if (seat.isBot) setTimeout(() => this._botAct(seat), Utils.randInt(650, 1300));
  }

  playerStand(playerId) {
    const seat = this.currentSeat();
    if (!seat || seat.id !== playerId || this.phase !== 'playerTurns') return;
    seat.status = 'stood';
    this._emit();
    this._advanceTurn();
  }

  _dealerTurn() {
    this.phase = 'dealerTurn';
    this._emit();
    const anyoneLeft = this.seats.some(s => s.status === 'stood' || s.status === 'blackjack');
    const step = () => {
      if (!anyoneLeft) { this._payout(); return; }
      const val = Blackjack.handValue(this.dealerHand);
      if (val.total < 17) { // dealer stands on 17+, including soft 17
        this.dealerHand.push(this.deck.pop());
        this._emit();
        setTimeout(step, 700);
      } else {
        this._payout();
      }
    };
    setTimeout(step, 700);
  }

  _payout() {
    const dealerVal = Blackjack.handValue(this.dealerHand);
    this.seats.forEach(s => {
      if (s.status === 'bust') { s.result = 'lose'; return; }
      const val = Blackjack.handValue(s.hand);
      if (s.status === 'blackjack' && !dealerVal.isBlackjack) { s.chips += Math.floor(s.bet * 2.5); s.result = 'win'; return; }
      if (dealerVal.isBust) { s.chips += s.bet * 2; s.result = 'win'; return; }
      if (val.total > dealerVal.total) { s.chips += s.bet * 2; s.result = 'win'; }
      else if (val.total === dealerVal.total) { s.chips += s.bet; s.result = 'push'; }
      else { s.result = 'lose'; }
    });
    this.phase = 'roundEnd';
    this._emit();
    Rooms.sendChat(this.roomId, this._resultSummary(), { system: true });
  }

  _resultSummary() {
    const winners = this.seats.filter(s => s.result === 'win').map(s => s.nickname);
    if (!winners.length) return 'House wins this round.';
    return winners.join(', ') + (winners.length > 1 ? ' win' : ' wins') + ' this round!';
  }

  isFinished() { return this.phase === 'roundEnd'; }

  playAgain() {
    if (this.phase !== 'roundEnd') return;
    this._autoBets();
  }
}

/* ---------- 11. POKER ENGINE ----------
   No-limit Texas Hold'em with proper blinds, four betting streets
   and side pots. One instance per active table, same ownership
   model as BlackjackGame above.

   Note: the room-start logic (see startGameInRoom) always seats at
   least 3 players for poker specifically, so this engine can use
   the standard >2-handed action order and never has to special-case
   heads-up blind rules.
*/
class PokerGame {
  constructor(room) {
    this.roomId = room.id;
    this.seats = room.players.map(p => ({
      id: p.id, nickname: p.nickname, isBot: p.isBot,
      hole: [], stack: CFG.STARTING_CHIPS, folded: false, allIn: false,
      committed: 0, totalCommitted: 0, hasActed: false, lastAction: null
    }));
    this.dealerIndex = -1;
    this.onChange = null;
    this.handNumber = 0;
    this.tableBusted = false;
    this._startHand();
  }

  _emit() { if (this.onChange) this.onChange(); }
  activeSeats() { return this.seats.filter(s => !s.folded); }
  currentSeat() { return this.activeIndex >= 0 ? this.seats[this.activeIndex] : null; }

  _nextSeatIndex(fromIndex) {
    const n = this.seats.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIndex + step) % n;
      const s = this.seats[idx];
      if (!s.folded && !s.allIn && s.stack > 0) return idx;
    }
    return -1;
  }

  _startHand() {
    this.handNumber++;
    this.deck = Cards.freshDeck();
    this.community = [];
    this.pot = 0;
    this.phase = 'preflop';
    this.lastWinners = null;
    this.seats.forEach(s => {
      s.hole = []; s.folded = s.stack <= 0; s.allIn = false;
      s.committed = 0; s.totalCommitted = 0; s.hasActed = false; s.lastAction = null;
    });

    do { this.dealerIndex = (this.dealerIndex + 1) % this.seats.length; }
    while (this.seats[this.dealerIndex].folded && this.seats.some(s => !s.folded));

    const sbIndex = this._nextSeatIndex(this.dealerIndex);
    const bbIndex = sbIndex >= 0 ? this._nextSeatIndex(sbIndex) : -1;
    if (sbIndex >= 0) this._postBlind(sbIndex, CFG.SMALL_BLIND);
    if (bbIndex >= 0) this._postBlind(bbIndex, CFG.BIG_BLIND);

    this.currentBet = CFG.BIG_BLIND;
    this.minRaise = CFG.BIG_BLIND;

    for (let i = 0; i < 2; i++) { this.seats.forEach(s => { if (!s.folded) s.hole.push(this.deck.pop()); }); }

    const firstActor = bbIndex >= 0 ? this._nextSeatIndex(bbIndex) : -1;
    this._beginBettingRound(firstActor);
  }

  _postBlind(idx, amount) {
    const s = this.seats[idx];
    const amt = Math.min(amount, s.stack);
    s.stack -= amt; s.committed += amt; s.totalCommitted += amt; this.pot += amt;
    if (s.stack === 0) s.allIn = true;
  }

  _beginBettingRound(firstActorIndex) {
    const remaining = this.activeSeats();
    if (remaining.length === 1) { this._awardUncontested(remaining[0]); return; }
    const contenders = this.seats.filter(s => !s.folded && !s.allIn);
    if (contenders.length === 0 || firstActorIndex === -1) {
      // no one left who can bet — just run the board out with brief pauses
      this.activeIndex = -1;
      this._emit();
      setTimeout(() => this._advancePhase(), 900);
      return;
    }
    this.activeIndex = firstActorIndex;
    this._emit();
    const seat = this.currentSeat();
    if (seat && seat.isBot) setTimeout(() => this._botAct(seat), Utils.randInt(700, 1500));
  }

  _roundClosed() {
    const contenders = this.seats.filter(s => !s.folded && !s.allIn);
    if (contenders.length === 0) return true;
    return contenders.every(s => s.hasActed && s.committed === this.currentBet);
  }

  _afterAction() {
    const remaining = this.activeSeats();
    if (remaining.length === 1) { this._awardUncontested(remaining[0]); return; }
    if (this._roundClosed()) { this._advancePhase(); return; }
    const idx = this._nextSeatIndex(this.activeIndex);
    if (idx === -1) { this._advancePhase(); return; }
    this.activeIndex = idx;
    this._emit();
    const seat = this.currentSeat();
    if (seat && seat.isBot) setTimeout(() => this._botAct(seat), Utils.randInt(700, 1500));
  }

  _act(playerId, action, amount) {
    const seat = this.currentSeat();
    if (!seat || seat.id !== playerId || this.phase === 'showdown') return false;
    const toCall = this.currentBet - seat.committed;

    if (action === 'fold') {
      seat.folded = true; seat.lastAction = 'fold'; seat.hasActed = true;
    } else if (action === 'check') {
      if (toCall > 0) return false;
      seat.lastAction = 'check'; seat.hasActed = true;
    } else if (action === 'call') {
      const pay = Math.min(toCall, seat.stack);
      seat.stack -= pay; seat.committed += pay; seat.totalCommitted += pay; this.pot += pay;
      if (seat.stack === 0) seat.allIn = true;
      seat.lastAction = 'call'; seat.hasActed = true;
    } else if (action === 'raise') {
      const minRaiseTo = this.currentBet + this.minRaise;
      const maxRaiseTo = seat.committed + seat.stack;
      const raiseTo = Utils.clamp(amount || minRaiseTo, minRaiseTo, maxRaiseTo);
      const pay = raiseTo - seat.committed;
      seat.stack -= pay; seat.committed += pay; seat.totalCommitted += pay; this.pot += pay;
      if (seat.stack === 0) seat.allIn = true;
      this.minRaise = Math.max(this.minRaise, seat.committed - this.currentBet);
      this.currentBet = Math.max(this.currentBet, seat.committed);
      seat.lastAction = 'raise'; seat.hasActed = true;
      this.seats.forEach(s => { if (s !== seat && !s.folded && !s.allIn) s.hasActed = false; });
    } else {
      return false;
    }

    this._emit();
    this._afterAction();
    return true;
  }

  playerFold(id) { this._act(id, 'fold'); }
  playerCheck(id) { this._act(id, 'check'); }
  playerCall(id) { this._act(id, 'call'); }
  playerRaise(id, amount) { this._act(id, 'raise', amount); }

  _botAct(seat) {
    if (this.currentSeat() !== seat || seat.folded) return;
    const strength = PokerHelpers.estimateHandStrength(seat.hole, this.community);
    const toCall = this.currentBet - seat.committed;
    const potOdds = toCall / Math.max(1, this.pot + toCall);
    const canCheck = toCall === 0;
    const decision = Bots.pokerDecision({ handStrength: strength, toCall, potOdds, stack: seat.stack, canCheck });
    if (decision.action === 'fold') this.playerFold(seat.id);
    else if (decision.action === 'check') this.playerCheck(seat.id);
    else if (decision.action === 'call') this.playerCall(seat.id);
    else if (decision.action === 'raise') this.playerRaise(seat.id, this.currentBet + this.minRaise * Utils.randInt(1, 2));
  }

  _advancePhase() {
    this.seats.forEach(s => { s.committed = 0; s.hasActed = false; });
    this.currentBet = 0; this.minRaise = CFG.BIG_BLIND;

    if (this.phase === 'preflop') { this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.phase = 'flop'; }
    else if (this.phase === 'flop') { this.community.push(this.deck.pop()); this.phase = 'turn'; }
    else if (this.phase === 'turn') { this.community.push(this.deck.pop()); this.phase = 'river'; }
    else { this._showdown(); return; }

    this._beginBettingRound(this._nextSeatIndex(this.dealerIndex));
  }

  _awardUncontested(winner) {
    winner.stack += this.pot;
    this.phase = 'showdown';
    this.activeIndex = -1;
    this.lastWinners = [{ id: winner.id, nickname: winner.nickname, amount: this.pot, hand: null }];
    this.pot = 0;
    this._emit();
    Rooms.sendChat(this.roomId, winner.nickname + ' takes the pot \u2014 everyone else folded.', { system: true });
  }

  _sidePots() {
    const contributors = this.seats.filter(s => s.totalCommitted > 0);
    const levels = [...new Set(contributors.map(s => s.totalCommitted))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    levels.forEach(level => {
      const layerPayers = contributors.filter(s => s.totalCommitted >= level);
      const amount = (level - prev) * layerPayers.length;
      const eligible = layerPayers.filter(s => !s.folded).map(s => s.id);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    });
    return pots;
  }

  _showdown() {
    this.phase = 'showdown';
    this.activeIndex = -1;
    const pots = this._sidePots();
    const results = this.seats.filter(s => !s.folded).map(s => ({
      id: s.id, nickname: s.nickname, score: HandEval.best5of7(s.hole.concat(this.community))
    }));
    const winners = [];
    pots.forEach(pot => {
      const contenders = results.filter(r => pot.eligible.indexOf(r.id) !== -1);
      if (!contenders.length) return;
      let best = contenders[0];
      contenders.forEach(c => { if (HandEval.compareScores(c.score, best.score) > 0) best = c; });
      const ties = contenders.filter(c => HandEval.compareScores(c.score, best.score) === 0);
      const share = Math.floor(pot.amount / ties.length);
      ties.forEach(t => {
        const seat = this.seats.find(s => s.id === t.id);
        seat.stack += share;
        winners.push({ id: t.id, nickname: t.nickname, amount: share, hand: HandEval.describe(t.score) });
      });
    });
    this.lastWinners = winners;
    this.pot = 0;
    this._emit();
    const summary = winners.map(w => w.nickname + ' (' + w.hand + ')').join(', ');
    Rooms.sendChat(this.roomId, 'Showdown: ' + summary + ' win' + (winners.length === 1 ? 's' : '') + ' the pot.', { system: true });
  }

  isFinished() { return this.phase === 'showdown'; }

  playAgain() {
    if (this.phase !== 'showdown') return;
    const alive = this.seats.filter(s => s.stack > 0);
    if (alive.length < 2) { this.tableBusted = true; this._emit(); return; }
    this._startHand();
  }
}

/* ---------- 12. ROUTER ---------- */
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

/* ---------- 13. UI HELPERS ---------- */
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

/* ---------- 14. VIEW RENDERERS ---------- */

function renderStatsBar(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const s = Stats.snapshot();
  const perGameHtml = Games.list.map(g =>
    '<div class="stat-item"><span class="stat-value">' + Utils.formatNumber(s.perGame[g.id] || 0) + '</span><span class="stat-label">' + g.icon + ' playing ' + Utils.escapeHtml(g.name) + '</span></div>'
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
  const stats = Stats.snapshot();
  const filtered = Games.list.filter(g => !q || g.name.toLowerCase().indexOf(q) !== -1 || g.tagline.toLowerCase().indexOf(q) !== -1 || g.description.toLowerCase().indexOf(q) !== -1);
  if (!filtered.length) {
    el.innerHTML = '<div class="empty-state"><span class="suit-flourish">\u2660 \u2665</span><h4>No games match \u201c' + Utils.escapeHtml(query) + '\u201d</h4><p>Try Blackjack or Hold\u2019em \u2014 more tables are on the way.</p></div>';
    return;
  }
  el.innerHTML = filtered.map((g, i) => {
    const full = opts.full;
    return (
      '<div class="game-card" style="animation-delay:' + (i * 60) + 'ms">' +
        '<div class="game-card-top"><div class="game-card-icon">' + g.icon + '</div>' + (full ? '<span class="badge badge-playing">' + Utils.formatNumber(stats.perGame[g.id] || 0) + ' online</span>' : '') + '</div>' +
        '<div><h3>' + Utils.escapeHtml(g.name) + '</h3><p>' + Utils.escapeHtml(full ? g.description : g.tagline) + '</p></div>' +
        '<div class="game-card-meta">' + (full ? '<span>' + g.minPlayers + '\u2013' + g.maxPlayers + ' players</span>' : '<span><strong>' + Utils.formatNumber(stats.perGame[g.id] || 0) + '</strong> playing now</span>') + '</div>' +
        '<div class="game-card-actions">' +
          '<button class="btn btn-primary game-play-btn" data-game="' + g.id + '">Play</button>' +
          (full ? '<button class="btn btn-secondary game-host-btn" data-game="' + g.id + '">Host private</button>' : '') +
        '</div>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.game-play-btn').forEach(btn => btn.addEventListener('click', () => requireNickname(() => {
    AppState.pendingGameFilter = btn.dataset.game;
    Router.navigate('/rooms');
  })));
  el.querySelectorAll('.game-host-btn').forEach(btn => btn.addEventListener('click', () => requireNickname(() => {
    AppState.presetPrivateGame = btn.dataset.game;
    Router.navigate('/create-private');
  })));
}

function renderHeroPanel() {
  const panel = document.getElementById('hero-panel');
  if (!panel) return;
  if (Session.hasNickname()) {
    panel.innerHTML =
      '<div class="hero-welcome">' +
        '<div><div class="hero-panel-label">Welcome back, ' + Utils.escapeHtml(Session.nickname) + '</div><span class="muted" style="font-size:.85rem;">Ready to sit down?</span></div>' +
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
      if (Session.setNickname(val)) { renderNicknamePill(); renderHeroPanel(); UI.toast('Welcome, ' + Session.nickname + '!', 'success'); }
      else UI.toast('Nicknames need at least 2 characters.', 'danger');
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
  el.innerHTML = tabs.map(t => '<button class="filter-tab' + (AppState.roomsFilter === t.id ? ' active' : '') + '" data-filter="' + t.id + '">' + Utils.escapeHtml(t.label) + '</button>').join('');
  el.querySelectorAll('.filter-tab').forEach(btn => btn.addEventListener('click', () => {
    AppState.roomsFilter = btn.dataset.filter;
    renderRoomsFilterTabs();
    renderRoomsGrid();
  }));
}

function renderRoomsGrid() {
  const el = document.getElementById('rooms-grid');
  if (!el) return;
  const q = (AppState.roomsSearch || '').trim().toLowerCase();
  let rooms = Rooms.listPublicForDisplay(AppState.roomsFilter);
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
    const res = Rooms.join(btn.dataset.room, { asSpectator: btn.dataset.spectate === '1' });
    if (!res.ok) { UI.toast('That table just closed.', 'danger'); renderRoomsGrid(); return; }
    Router.navigate('/room/' + res.room.id);
  })));
}

function renderRoomsList(root) {
  const filter = AppState.pendingGameFilter || AppState.roomsFilter || 'all';
  AppState.roomsFilter = filter;
  AppState.pendingGameFilter = null;

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
  document.getElementById('rooms-search').addEventListener('input', e => { AppState.roomsSearch = e.target.value; renderRoomsGrid(); });
  document.getElementById('rooms-host-btn').addEventListener('click', () => requireNickname(() => {
    AppState.presetPublic = true;
    Router.navigate('/create-private');
  }));
}

function renderCreatePrivate(root) {
  const presetGame = AppState.presetPrivateGame; AppState.presetPrivateGame = null;
  const presetPublic = AppState.presetPublic; AppState.presetPublic = false;

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
    const room = Rooms.create({ gameId: gameSelect.value, name: document.getElementById('cp-name').value, isPrivate, maxPlayers: maxVal });
    UI.toast(isPrivate ? 'Table created \u2014 share the code!' : 'Your public table is live.', 'success');
    Router.navigate('/room/' + room.id);
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
    const room = Rooms.findByCode(code);
    if (!room) { errEl.textContent = 'No table found with that code.'; return; }
    const res = Rooms.join(room.id);
    if (!res.ok) { errEl.textContent = 'Could not join that table.'; return; }
    errEl.textContent = '';
    Router.navigate('/room/' + res.room.id);
  }));
}

function renderNotFound(root) {
  root.innerHTML = '<div class="view wrap section" style="text-align:center;"><div class="empty-state"><span class="suit-flourish">\u2660 \u2665 \u2666 \u2663</span><h4>Table\u2019s not here</h4><p>That page doesn\u2019t exist.</p><a href="#/home" class="btn btn-primary" style="margin-top:1rem;">Back home</a></div></div>';
}

/* ---------- ROOM VIEW (lobby + table) ---------- */
let roomPollTimer = null;
let roomStorageUnsub = null;
let lastRenderedChatCount = 0;

function cleanupRoomView() {
  if (roomPollTimer) { clearInterval(roomPollTimer); roomPollTimer = null; }
  if (roomStorageUnsub) { roomStorageUnsub(); roomStorageUnsub = null; }
  AppState.currentRoomId = null;
}

function renderRoomMissing(root, msg) {
  root.innerHTML =
    '<div class="view wrap section" style="text-align:center;"><div class="empty-state">' +
      '<span class="suit-flourish">\u2660 \u2665</span><h4>' + Utils.escapeHtml(msg || 'This table has closed') + '</h4>' +
      '<p>It might have emptied out, or the link was off.</p>' +
      '<a href="#/rooms" class="btn btn-primary" style="margin-top:1rem;">Find another table</a>' +
    '</div></div>';
}

function renderRoomView(root, roomId) {
  cleanupRoomView();

  if (!Session.hasNickname()) {
    renderRoomMissing(root, 'Pick a nickname to take a seat');
    requireNickname(() => Router.navigate('/room/' + roomId));
    return;
  }

  const room = Rooms.get(roomId);
  if (!room) { renderRoomMissing(root); return; }

  if (!room.players.some(p => p.id === Session.id) && !room.spectators.some(p => p.id === Session.id)) {
    Rooms.join(roomId, { asSpectator: true });
  }

  AppState.currentRoomId = roomId;
  buildRoomShell(root, roomId);
  syncRoomView();

  roomPollTimer = setInterval(syncRoomView, CFG.ROOM_POLL_MS);
  roomStorageUnsub = Store.onChange((key) => { if (key === 'rooms') syncRoomView(); });
}

function buildRoomShell(root, roomId) {
  const room = Rooms.get(roomId);
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
    Rooms.sendChat(roomId, input.value);
    input.value = '';
    syncRoomView();
  });
}

function statusBadgeHtml(status) {
  const cls = status === 'playing' ? 'badge-playing' : (status === 'finished' ? 'badge-finished' : 'badge-waiting');
  return '<span class="badge ' + cls + '">' + status + '</span>';
}

function syncRoomView() {
  const roomId = AppState.currentRoomId;
  if (!roomId) return;
  Rooms.pruneStalePlayers(roomId);
  const room = Rooms.get(roomId);
  if (!room) { renderRoomMissing(document.getElementById('app-root')); cleanupRoomView(); return; }

  const me = room.players.find(p => p.id === Session.id);
  const isHost = !!(me && me.isHost);
  const isSpectatorOnly = !me;

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
    document.getElementById('leave-room-btn').addEventListener('click', () => confirmLeaveRoom(roomId));
  }

  const readyStrip = document.getElementById('ready-strip');
  if (readyStrip) {
    if (room.status === 'waiting' && me) {
      readyStrip.style.display = '';
      readyStrip.innerHTML =
        '<div>' + (me.ready ? '<span class="ready-tag">' + Icons.check + ' You\u2019re ready</span>' : '<span class="muted">Ready up when you\u2019re set.</span>') + '</div>' +
        '<div class="ready-strip-actions">' +
          '<button class="btn btn-secondary" id="ready-btn">' + (me.ready ? 'Not ready' : 'Ready up') + '</button>' +
          (isHost ? '<button class="btn btn-primary" id="start-btn"' + (Rooms.canStart(room) ? '' : ' disabled') + '>Start game</button>' : '') +
        '</div>';
      document.getElementById('ready-btn').addEventListener('click', () => { Rooms.toggleReady(roomId); syncRoomView(); });
      const startBtn = document.getElementById('start-btn');
      if (startBtn) startBtn.addEventListener('click', () => startGameInRoom(roomId));
    } else if (room.status === 'waiting' && !me) {
      readyStrip.style.display = '';
      const openSeat = room.players.length < room.maxPlayers;
      readyStrip.innerHTML =
        '<div class="muted">You\u2019re watching from the rail. ' + (openSeat ? 'A seat is open \u2014 want in?' : 'Table is full right now.') + '</div>' +
        (openSeat ? '<button class="btn btn-primary" id="take-seat-btn">Take a seat</button>' : '');
      const seatBtn = document.getElementById('take-seat-btn');
      if (seatBtn) seatBtn.addEventListener('click', () => { Rooms.join(roomId, { asSpectator: false }); syncRoomView(); });
    } else {
      readyStrip.style.display = 'none';
    }
  }

  renderPlayerList(room);

  const specEl = document.getElementById('spectator-list');
  if (specEl) specEl.textContent = room.spectators.length ? ('Watching: ' + room.spectators.map(s => s.nickname).join(', ')) : '';

  renderChatLog(room);
  renderGameArea(room, isSpectatorOnly, { skipIfLive: true });
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
      '<div class="player-row' + (p.id === Session.id ? ' is-self' : '') + '">' +
        '<div class="player-avatar">' + Utils.escapeHtml(Utils.initial(p.nickname)) + '</div>' +
        '<div class="player-info"><div class="player-name-row"><span class="nm">' + Utils.escapeHtml(p.nickname) + (p.id === Session.id ? ' (you)' : '') + '</span></div></div>' +
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
    const mine = m.authorId === Session.id;
    return '<div class="chat-message' + (mine ? ' me' : '') + '"><span class="who">' + Utils.escapeHtml(m.nickname) + '</span>' + Utils.escapeHtml(m.text) + '</div>';
  }).join('');
  if (wasNearBottom || room.chat.length !== lastRenderedChatCount) el.scrollTop = el.scrollHeight;
  lastRenderedChatCount = room.chat.length;
}

function confirmLeaveRoom(roomId) {
  UI.openModal({
    title: 'Leave this table?',
    body: 'You can rejoin later with the same room code if it\u2019s private, or from the public list.',
    actions: [
      { label: 'Stay', className: 'btn-ghost' },
      { label: 'Leave table', className: 'btn-danger', onClick: () => {
          Rooms.leave(roomId);
          ActiveEngines.delete(roomId);
          Router.navigate('/rooms');
          UI.toast('You left the table.', 'info');
        } }
    ]
  });
}

function startGameInRoom(roomId) {
  const rooms = Rooms.all();
  const room = rooms[roomId];
  if (!room || !Rooms.canStart(room)) return;
  const game = Games.get(room.gameId);

  // Fill remaining seats with bots up to a randomized target. Poker
  // additionally needs >=3 seats so blind/action order stays "normal"
  // (see PokerGame's class comment).
  const floor = room.gameId === 'poker' ? Math.max(3, game.minPlayers) : game.minPlayers;
  const target = Utils.clamp(Utils.randInt(floor, game.idealTable), room.players.length, room.maxPlayers);
  if (room.players.length < target) {
    const existingNames = room.players.map(p => p.nickname);
    room.players = room.players.concat(Bots.makeBotPlayers(target - room.players.length, existingNames));
  }
  room.status = 'playing';
  room.updatedAt = Date.now();
  rooms[roomId] = room;
  Store.set('rooms', rooms);

  const EngineClass = room.gameId === 'blackjack' ? BlackjackGame : PokerGame;
  const engine = new EngineClass(room);
  engine.onChange = () => onEngineChange(roomId, engine);
  ActiveEngines.set(roomId, engine);
  Rooms.sendChat(roomId, 'Game started.', { system: true });

  syncRoomView();          // refresh shell: status badges, player list, ready strip
  onEngineChange(roomId, engine); // explicit first paint of the table itself
}

function buildPublicSnapshot(engine, gameId) {
  if (gameId === 'blackjack') {
    return {
      gameId, phase: engine.phase,
      dealerHand: engine.phase === 'playerTurns' ? [engine.dealerHand[0], null] : engine.dealerHand,
      seats: engine.seats.map(s => ({ id: s.id, nickname: s.nickname, isBot: s.isBot, hand: s.hand, status: s.status, bet: s.bet, result: s.result })),
      activeSeatId: engine.currentSeat() ? engine.currentSeat().id : null
    };
  }
  return {
    gameId, phase: engine.phase, community: engine.community, pot: engine.pot, dealerIndex: engine.dealerIndex,
    seats: engine.seats.map(s => ({
      id: s.id, nickname: s.nickname, isBot: s.isBot, stack: s.stack, folded: s.folded, allIn: s.allIn, committed: s.committed,
      hole: (engine.phase === 'showdown' && !s.folded) ? s.hole : null
    })),
    activeSeatId: engine.currentSeat() ? engine.currentSeat().id : null,
    lastWinners: engine.lastWinners || null,
    tableBusted: !!engine.tableBusted
  };
}

function onEngineChange(roomId, engine) {
  const room = Rooms.get(roomId);
  if (!room) return;
  const snapshot = buildPublicSnapshot(engine, room.gameId);
  const status = engine.isFinished() ? 'finished' : 'playing';
  Rooms.setStatus(roomId, status, { publicSnapshot: snapshot });
  if (AppState.currentRoomId === roomId) renderGameArea(Rooms.get(roomId), false);
}

function renderGameArea(room, isSpectatorOnly, opts) {
  opts = opts || {};
  const el = document.getElementById('game-area');
  if (!el) return;

  if (room.status === 'waiting') {
    const game = Games.get(room.gameId);
    el.innerHTML = '<div class="empty-state"><span class="suit-flourish">' + game.icon + '</span><h4>Waiting in the lobby</h4><p>Ready up, then the host can start the table.</p></div>';
    return;
  }

  const engine = ActiveEngines.get(room.id);
  if (opts.skipIfLive && engine) return; // the engine's own onChange keeps this painted live

  if (engine) {
    if (room.gameId === 'blackjack') renderBlackjackTable(el, room, engine);
    else renderPokerTable(el, room, engine);
    return;
  }

  if (Rooms.isStale(room)) {
    el.innerHTML =
      '<div class="empty-state"><span class="suit-flourish">\u2660</span><h4>This table stalled</h4>' +
      '<p>The host seems to have disconnected mid-hand.</p>' +
      '<button class="btn btn-primary" id="reset-stale-btn" style="margin-top:1rem;">Return to lobby</button></div>';
    const btn = document.getElementById('reset-stale-btn');
    if (btn) btn.addEventListener('click', () => { Rooms.resetToLobby(room.id); syncRoomView(); });
    return;
  }

  renderSpectatorSnapshot(el, room);
}

function renderSpectatorSnapshot(el, room) {
  const snap = room.publicSnapshot;
  if (!snap) { el.innerHTML = '<div class="empty-state"><h4>Setting up the table\u2026</h4></div>'; return; }
  if (snap.gameId === 'blackjack') renderSpectatorBlackjack(el, snap);
  else renderSpectatorPoker(el, snap);
}

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
        '<div class="bj-seat-name">' + Utils.escapeHtml(s.nickname) + (s.id === Session.id ? ' (you)' : '') + (s.isBot ? ' <span class="bot-tag">Bot</span>' : '') + '</div>' +
        '<div class="card-row overlap">' + s.hand.map(c => cardHtml(c, 'card-deal-anim')).join('') + '</div>' +
        '<div class="hand-value">' + (val.total || 0) + (val.isSoft && !val.isBust ? ' soft' : '') + (s.status === 'blackjack' ? ' \u2022 Blackjack!' : '') + '</div>' +
        '<div class="bj-bet">Bet ' + s.bet + ' \u00b7 ' + Utils.formatNumber(s.chips) + ' chips</div>' +
        resultHtml +
      '</div>'
    );
  }).join('');

  const isMyTurn = !!handlers && vm.activeSeatId === Session.id && vm.phase === 'playerTurns';
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

function renderBlackjackTable(el, room, engine) {
  const vm = {
    dealerHand: engine.dealerHand, dealerHidden: engine.phase === 'playerTurns',
    seats: engine.seats, activeSeatId: engine.currentSeat() ? engine.currentSeat().id : null,
    phase: engine.phase, isLive: true
  };
  paintBlackjackTable(el, vm, {
    onHit: () => engine.playerHit(Session.id),
    onStand: () => engine.playerStand(Session.id),
    onNext: () => engine.playAgain(),
    onLobby: () => { ActiveEngines.delete(room.id); Rooms.resetToLobby(room.id); syncRoomView(); }
  });
}

function renderSpectatorBlackjack(el, snapshot) {
  const vm = {
    dealerHand: snapshot.dealerHand, dealerHidden: snapshot.phase === 'playerTurns',
    seats: snapshot.seats, activeSeatId: snapshot.activeSeatId, phase: snapshot.phase, isLive: false
  };
  paintBlackjackTable(el, vm, null);
}

/* ---- Poker ---- */
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
  const ordered = rotateSeatsForViewer(vm.seats, Session.id);
  const positions = seatPositions(ordered.length);

  const seatsHtml = ordered.map((s, i) => {
    const pos = positions[i];
    const isTurn = vm.activeSeatId === s.id;
    const isDealer = vm.dealerId === s.id;
    const showHole = vm.phase === 'showdown' ? !s.folded : s.id === Session.id;
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
          '<div class="poker-seat-name">' + Utils.escapeHtml(s.nickname) + (s.id === Session.id ? ' (you)' : '') + '</div>' +
          '<div class="poker-seat-stack">' + Utils.formatNumber(s.stack) + '</div>' +
          (s.committed ? '<div class="poker-seat-bet">bet ' + s.committed + '</div>' : '') +
          wonHtml +
        '</div>' +
        '<div class="poker-seat-holecards">' + holeCards + '</div>' +
      '</div>'
    );
  }).join('');

  const communityHtml = vm.community.map(c => cardHtml(c, 'card-deal-anim')).join('');
  const mySeat = vm.seats.find(s => s.id === Session.id);
  const isMyTurn = !!handlers && vm.phase !== 'showdown' && vm.activeSeatId === Session.id && mySeat;
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

function renderPokerTable(el, room, engine) {
  const vm = {
    seats: engine.seats, community: engine.community, pot: engine.pot,
    activeSeatId: engine.currentSeat() ? engine.currentSeat().id : null,
    dealerId: engine.seats[engine.dealerIndex] ? engine.seats[engine.dealerIndex].id : null,
    phase: engine.phase, currentBet: engine.currentBet, minRaise: engine.minRaise,
    lastWinners: engine.lastWinners, tableBusted: !!engine.tableBusted, isLive: true
  };
  paintPokerTable(el, vm, {
    onFold: () => engine.playerFold(Session.id),
    onCheck: () => engine.playerCheck(Session.id),
    onCall: () => engine.playerCall(Session.id),
    onRaise: (amt) => engine.playerRaise(Session.id, amt),
    onNext: () => engine.playAgain(),
    onLobby: () => { ActiveEngines.delete(room.id); Rooms.resetToLobby(room.id); syncRoomView(); }
  });
}

function renderSpectatorPoker(el, snapshot) {
  const vm = {
    seats: snapshot.seats, community: snapshot.community, pot: snapshot.pot,
    activeSeatId: snapshot.activeSeatId,
    dealerId: snapshot.seats[snapshot.dealerIndex] ? snapshot.seats[snapshot.dealerIndex].id : null,
    phase: snapshot.phase, currentBet: 0, minRaise: 0, lastWinners: snapshot.lastWinners,
    tableBusted: !!snapshot.tableBusted, isLive: false
  };
  paintPokerTable(el, vm, null);
}

/* ---------- 16. INIT ---------- */
function refreshVisibleStats() {
  const headerCount = document.getElementById('header-online-count');
  if (headerCount) headerCount.textContent = Utils.formatNumber(Stats.snapshot().online);
  if (document.getElementById('stats-bar')) renderStatsBar('stats-bar');
  if (Router.current === '/rooms') renderRoomsGrid();
}

const App = {
  _timer: null,
  tick() {
    Presence.beat();

    if (AppState.currentRoomId) {
      const rooms = Rooms.all();
      const room = rooms[AppState.currentRoomId];
      if (room && room.status === 'waiting') {
        let changed = false;
        room.players.forEach(p => {
          if (p.isBot && !p.ready && p.readyAt && Date.now() >= p.readyAt) { p.ready = true; changed = true; }
        });
        if (changed) { Store.set('rooms', rooms); syncRoomView(); }

        const bots = room.players.filter(p => p.isBot);
        if (bots.length && Math.random() < 0.12) {
          Rooms.sendChat(AppState.currentRoomId, Bots.chatLine(), { asPlayer: Utils.randChoice(bots) });
        }
      }
    }

    refreshVisibleStats();
  },
  init() {
    Router.init();
    renderNicknamePill();
    Presence.start();
    setupMobileNav();
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => UI.closeModal());
    this._timer = setInterval(() => this.tick(), CFG.TICK_MS);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
