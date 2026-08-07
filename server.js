/* ============================================================
   LUDEX — server.js
   Real backend: an Express static server + a WebSocket hub that
   is the single source of truth for rooms, players, chat and the
   actual card games. Every connected browser talks to THIS
   process, so rooms/private codes/chat genuinely work across
   different tabs, devices, and people — not just localStorage.

   Run:  npm install && node server.js
   Then open http://localhost:3000 (or your machine's LAN IP for
   other devices on the same network — see the printed URL below).
   To let friends elsewhere join, deploy this app (Render, Railway,
   Fly.io, Glitch, a VPS, etc.) — anything that can run `node server.js`.
   ============================================================ */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ---------- shared config ---------- */
const CFG = {
  STARTING_CHIPS: 1000,
  SMALL_BLIND: 10,
  BIG_BLIND: 20,
  DISCONNECT_GRACE_MS: 15000, // how long a dropped connection's seat is held before it's freed up
};

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
const SUIT_RED = { S: false, H: true, D: true, C: false };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

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
    this.onSystemChat = null; // assigned by the caller — used for round/hand result messages
    this._autoBets();
  }

  _emit() { if (this.onChange) this.onChange(); }
  _systemChat(text) { if (this.onSystemChat) this.onSystemChat(text); }

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
    this._systemChat(this._resultSummary());
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
    this.onSystemChat = null; // assigned by the caller — used for hand result messages
    this.handNumber = 0;
    this.tableBusted = false;
    this._startHand();
  }

  _emit() { if (this.onChange) this.onChange(); }
  _systemChat(text) { if (this.onSystemChat) this.onSystemChat(text); }
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
    this._systemChat(winner.nickname + ' takes the pot \u2014 everyone else folded.');
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
    this._systemChat('Showdown: ' + summary + ' win' + (winners.length === 1 ? 's' : '') + ' the pot.');
  }

  isFinished() { return this.phase === 'showdown'; }

  playAgain() {
    if (this.phase !== 'showdown') return;
    const alive = this.seats.filter(s => s.stack > 0);
    if (alive.length < 2) { this.tableBusted = true; this._emit(); return; }
    this._startHand();
  }
}



/* ---------- Real-time room manager ---------- */
const rooms = new Map();               // roomId -> room
const clients = new Map();             // ws -> { id, nickname, roomId }
const socketsByPlayerId = new Map();   // playerId -> ws

function send(ws, type, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(Object.assign({ type }, payload))); } catch (e) { /* no-op */ }
}
function sendError(ws, message) { send(ws, 'error', { message }); }

function myRoom(meta) { return meta.roomId ? rooms.get(meta.roomId) : null; }

function makeUniqueCode() {
  let code;
  do { code = Utils.roomCode(); } while ([...rooms.values()].some(r => r.code === code));
  return code;
}

function pushChat(room, msg) {
  room.chat.push({
    id: Utils.uid('c'), authorId: msg.authorId || null, nickname: msg.nickname || null,
    text: msg.text, ts: Date.now(), system: !!msg.system
  });
  if (room.chat.length > 80) room.chat = room.chat.slice(-80);
  room.updatedAt = Date.now();
}

// ----- serialization: what a given viewer is allowed to see -----
function serializeGameForViewer(room, viewerId) {
  const engine = room.engine;
  if (!engine) return null;
  if (room.gameId === 'blackjack') {
    return {
      gameId: 'blackjack', phase: engine.phase,
      dealerHand: engine.phase === 'playerTurns' ? [engine.dealerHand[0], null] : engine.dealerHand,
      seats: engine.seats.map(s => ({ id: s.id, nickname: s.nickname, isBot: s.isBot, hand: s.hand, status: s.status, bet: s.bet, chips: s.chips, result: s.result })),
      activeSeatId: engine.currentSeat() ? engine.currentSeat().id : null
    };
  }
  return {
    gameId: 'poker', phase: engine.phase, community: engine.community, pot: engine.pot,
    dealerId: engine.seats[engine.dealerIndex] ? engine.seats[engine.dealerIndex].id : null,
    currentBet: engine.currentBet, minRaise: engine.minRaise,
    seats: engine.seats.map(s => {
      const reveal = s.id === viewerId || (engine.phase === 'showdown' && !s.folded);
      return { id: s.id, nickname: s.nickname, isBot: s.isBot, stack: s.stack, folded: s.folded, allIn: s.allIn, committed: s.committed, hole: reveal ? s.hole : null };
    }),
    activeSeatId: engine.currentSeat() ? engine.currentSeat().id : null,
    lastWinners: engine.lastWinners || null,
    tableBusted: !!engine.tableBusted
  };
}

function serializeRoom(room, viewerId) {
  return {
    id: room.id, code: room.code, isPrivate: room.isPrivate, gameId: room.gameId, name: room.name,
    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, isBot: p.isBot, isHost: p.isHost, ready: p.ready })),
    spectators: room.spectators.map(p => ({ id: p.id, nickname: p.nickname })),
    maxPlayers: room.maxPlayers, status: room.status, chat: room.chat.slice(-80),
    createdAt: room.createdAt, updatedAt: room.updatedAt,
    game: serializeGameForViewer(room, viewerId)
  };
}

function broadcastRoom(room) {
  const everyone = room.players.concat(room.spectators);
  everyone.forEach(p => {
    const ws = socketsByPlayerId.get(p.id);
    if (ws) send(ws, 'room_state', { room: serializeRoom(room, p.id) });
  });
  broadcastRoomsList();
}

function publicRoomsPayload(gameFilter) {
  let list = [...rooms.values()].filter(r => !r.isPrivate).map(r => ({
    id: r.id, gameId: r.gameId, name: r.name, players: r.players.length, maxPlayers: r.maxPlayers, status: r.status
  }));
  if (gameFilter && gameFilter !== 'all') list = list.filter(r => r.gameId === gameFilter);
  return list.sort((a, b) => b.players - a.players);
}

function broadcastRoomsList() {
  const payload = { rooms: publicRoomsPayload(null) };
  clients.forEach((meta, ws) => send(ws, 'rooms_list', payload));
}

function statsSnapshot() {
  const online = [...clients.values()].filter(m => !!m.nickname).length;
  const perGame = {};
  Games.list.forEach(g => { perGame[g.id] = 0; });
  let publicRooms = 0;
  rooms.forEach(r => {
    if (!r.isPrivate) publicRooms++;
    perGame[r.gameId] = (perGame[r.gameId] || 0) + r.players.filter(p => !p.isBot).length;
  });
  return { online, perGame, publicRooms };
}

function broadcastStats() {
  const payload = statsSnapshot();
  clients.forEach((meta, ws) => send(ws, 'stats', payload));
}

function hostOf(room) { return room.players.find(p => p.isHost) || null; }

function reassignHostIfNeeded(room) {
  if (room.players.length && !hostOf(room)) {
    const next = room.players.find(p => !p.isBot) || room.players[0];
    next.isHost = true;
    pushChat(room, { system: true, text: next.nickname + ' is now the host.' });
  }
}

function removePlayerFromRoom(roomId, playerId, nickname) {
  const room = rooms.get(roomId);
  if (!room) return;
  const wasPlayer = room.players.some(p => p.id === playerId);
  room.players = room.players.filter(p => p.id !== playerId);
  room.spectators = room.spectators.filter(p => p.id !== playerId);
  if (wasPlayer) pushChat(room, { system: true, text: (nickname || 'A player') + ' left the table.' });
  reassignHostIfNeeded(room);
  const realLeft = room.players.filter(p => !p.isBot).length;
  if (realLeft === 0) {
    room.spectators.forEach(p => {
      const sws = socketsByPlayerId.get(p.id);
      if (sws) send(sws, 'room_closed', { roomId: room.id });
    });
    rooms.delete(roomId);
    broadcastRoomsList();
    broadcastStats();
    return;
  }
  room.updatedAt = Date.now();
  broadcastRoom(room);
  broadcastStats();
}

function canStart(room) {
  if (!room || room.status !== 'waiting') return false;
  if (!room.players.length) return false;
  return room.players.every(p => p.ready);
}

function onEngineChange(room) {
  const engine = room.engine;
  room.status = engine.isFinished() ? 'finished' : 'playing';
  room.updatedAt = Date.now();
  broadcastRoom(room);
}

function startGame(room) {
  const game = Games.get(room.gameId);
  const floor = room.gameId === 'poker' ? Math.max(3, game.minPlayers) : game.minPlayers;
  const target = Utils.clamp(Utils.randInt(floor, game.idealTable), room.players.length, room.maxPlayers);
  if (room.players.length < target) {
    const existingNames = room.players.map(p => p.nickname);
    room.players = room.players.concat(Bots.makeBotPlayers(target - room.players.length, existingNames));
  }
  room.status = 'playing';
  room.updatedAt = Date.now();

  const EngineClass = room.gameId === 'blackjack' ? BlackjackGame : PokerGame;
  const engine = new EngineClass(room);
  engine.onChange = () => onEngineChange(room);
  engine.onSystemChat = (text) => { pushChat(room, { system: true, text }); broadcastRoom(room); };
  room.engine = engine;

  pushChat(room, { system: true, text: 'Game started.' });
  broadcastRoom(room);
}

function resetRoomToLobby(room) {
  room.status = 'waiting';
  room.engine = null;
  room.players.forEach(p => {
    p.ready = false;
    if (p.isBot) p.readyAt = Date.now() + Utils.randInt(600, 2200);
  });
  room.updatedAt = Date.now();
}

// Bots ready themselves up shortly after being seated, and occasionally
// chirp in chat while a room is waiting — purely cosmetic liveliness, not
// counted anywhere in the real stats.
setInterval(() => {
  rooms.forEach(room => {
    if (room.status !== 'waiting') return;
    let changed = false;
    room.players.forEach(p => {
      if (p.isBot && !p.ready && p.readyAt && Date.now() >= p.readyAt) { p.ready = true; changed = true; }
    });
    const bots = room.players.filter(p => p.isBot);
    if (bots.length && Math.random() < 0.05) {
      pushChat(room, { authorId: null, nickname: Utils.randChoice(bots).nickname, text: Bots.chatLine() });
      changed = true;
    }
    if (changed) broadcastRoom(room);
  });
}, 2000);

// A "playing"/"finished" room with no updates for a while is likely
// abandoned (everyone disconnected mid-hand) — quietly return it to the
// lobby so it doesn't sit there stale forever.
setInterval(() => {
  const now = Date.now();
  rooms.forEach(room => {
    if ((room.status === 'playing' || room.status === 'finished') && now - room.updatedAt > 90000) {
      resetRoomToLobby(room);
      pushChat(room, { system: true, text: 'This table timed out and reset.' });
      broadcastRoom(room);
    }
  });
}, 15000);

/* ---------- WebSocket message handling ---------- */
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  const meta = clients.get(ws);
  if (!meta) return;

  switch (msg.type) {
    case 'hello': {
      const clean = String(msg.nickname || '').trim().slice(0, 18);
      meta.nickname = clean.length >= 2 ? clean : null;
      send(ws, 'welcome', { id: meta.id, nickname: meta.nickname });
      broadcastStats();
      break;
    }

    case 'list_rooms': {
      send(ws, 'rooms_list', { rooms: publicRoomsPayload(msg.gameFilter) });
      break;
    }

    case 'create_room': {
      if (!meta.nickname) return sendError(ws, 'Set a nickname first.');
      const game = Games.get(msg.gameId);
      if (!game) return sendError(ws, 'Unknown game.');
      const room = {
        id: Utils.uid('room'),
        code: msg.isPrivate ? makeUniqueCode() : null,
        isPrivate: !!msg.isPrivate, gameId: msg.gameId,
        name: (msg.name && String(msg.name).trim() ? String(msg.name).trim() : (meta.nickname + '\u2019s table')).slice(0, 30),
        players: [{ id: meta.id, nickname: meta.nickname, ready: false, isBot: false, isHost: true, joinedAt: Date.now() }],
        spectators: [],
        maxPlayers: Utils.clamp(msg.maxPlayers || game.idealTable, game.minPlayers, game.maxPlayers),
        status: 'waiting',
        chat: [{ id: Utils.uid('c'), system: true, text: meta.nickname + ' opened the table.', ts: Date.now() }],
        createdAt: Date.now(), updatedAt: Date.now(), engine: null
      };
      rooms.set(room.id, room);
      meta.roomId = room.id;
      send(ws, 'room_state', { room: serializeRoom(room, meta.id) });
      broadcastRoomsList();
      broadcastStats();
      break;
    }

    case 'join_room':
    case 'join_by_code': {
      if (!meta.nickname) return sendError(ws, 'Set a nickname first.');
      let room = null;
      if (msg.type === 'join_room') room = rooms.get(msg.roomId);
      else {
        const code = String(msg.code || '').trim().toUpperCase();
        room = [...rooms.values()].find(r => r.code === code) || null;
        if (!room) return sendError(ws, 'No table found with that code.');
      }
      if (!room) return sendError(ws, 'That table has closed.');
      const already = room.players.some(p => p.id === meta.id) || room.spectators.some(p => p.id === meta.id);
      if (!already) {
        const asSpectator = !!msg.asSpectator || room.players.length >= room.maxPlayers;
        if (asSpectator) {
          room.spectators.push({ id: meta.id, nickname: meta.nickname });
        } else {
          const shouldBeHost = !hostOf(room);
          room.players.push({ id: meta.id, nickname: meta.nickname, ready: false, isBot: false, isHost: shouldBeHost, joinedAt: Date.now() });
          pushChat(room, { system: true, text: meta.nickname + ' joined the table.' });
        }
      }
      meta.roomId = room.id;
      room.updatedAt = Date.now();
      broadcastRoom(room);
      broadcastStats();
      break;
    }

    case 'take_seat': {
      const room = myRoom(meta);
      if (!room) return;
      if (room.players.some(p => p.id === meta.id)) return;
      if (room.players.length >= room.maxPlayers) return sendError(ws, 'Table is full.');
      room.spectators = room.spectators.filter(p => p.id !== meta.id);
      const shouldBeHost = !hostOf(room);
      room.players.push({ id: meta.id, nickname: meta.nickname, ready: false, isBot: false, isHost: shouldBeHost, joinedAt: Date.now() });
      pushChat(room, { system: true, text: meta.nickname + ' took a seat.' });
      broadcastRoom(room);
      broadcastStats();
      break;
    }

    case 'leave_room': {
      const room = myRoom(meta);
      meta.roomId = null;
      if (room) removePlayerFromRoom(room.id, meta.id, meta.nickname);
      break;
    }

    case 'toggle_ready': {
      const room = myRoom(meta);
      if (!room) return;
      const me = room.players.find(p => p.id === meta.id);
      if (!me) return;
      me.ready = !me.ready;
      room.updatedAt = Date.now();
      broadcastRoom(room);
      break;
    }

    case 'start_game': {
      const room = myRoom(meta);
      if (!room || !canStart(room)) return;
      startGame(room);
      break;
    }

    case 'chat': {
      const room = myRoom(meta);
      if (!room) return;
      const text = String(msg.text || '').trim().slice(0, 240);
      if (!text) return;
      pushChat(room, { authorId: meta.id, nickname: meta.nickname, text });
      broadcastRoom(room);
      break;
    }

    case 'game_action': {
      const room = myRoom(meta);
      if (!room || !room.engine) return;
      const engine = room.engine;
      if (room.gameId === 'blackjack') {
        if (msg.action === 'hit') engine.playerHit(meta.id);
        else if (msg.action === 'stand') engine.playerStand(meta.id);
      } else if (room.gameId === 'poker') {
        if (msg.action === 'fold') engine.playerFold(meta.id);
        else if (msg.action === 'check') engine.playerCheck(meta.id);
        else if (msg.action === 'call') engine.playerCall(meta.id);
        else if (msg.action === 'raise') engine.playerRaise(meta.id, msg.amount);
      }
      break;
    }

    case 'play_again': {
      const room = myRoom(meta);
      if (!room || !room.engine) return;
      room.engine.playAgain();
      break;
    }

    case 'return_to_lobby': {
      const room = myRoom(meta);
      if (!room) return;
      resetRoomToLobby(room);
      broadcastRoom(room);
      break;
    }

    default: break;
  }
}

/* ---------- HTTP + WebSocket server ---------- */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const meta = { id: Utils.uid('u'), nickname: null, roomId: null };
  clients.set(ws, meta);
  socketsByPlayerId.set(meta.id, ws);
  send(ws, 'welcome', { id: meta.id });
  send(ws, 'stats', statsSnapshot());
  send(ws, 'rooms_list', { rooms: publicRoomsPayload(null) });

  ws.on('message', (raw) => handleMessage(ws, raw));

  ws.on('close', () => {
    const m = clients.get(ws);
    if (!m) return;
    clients.delete(ws);
    socketsByPlayerId.delete(m.id);
    if (m.roomId) removePlayerFromRoom(m.roomId, m.id, m.nickname);
    broadcastStats();
  });
});

httpServer.listen(PORT, () => {
  console.log('Ludex server running:');
  console.log('  Local:   http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  Object.values(nets).flat().forEach(net => {
    if (net.family === 'IPv4' && !net.internal) console.log('  Network: http://' + net.address + ':' + PORT + '  (other devices on your Wi-Fi/LAN)');
  });
  console.log('  To let people outside your network join, deploy this app (Render, Railway, Fly.io, a VPS, etc).');
});
