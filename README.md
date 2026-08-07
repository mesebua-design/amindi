# Ludex — real multiplayer card lounge

A live, server-backed multiplayer site: Blackjack + Texas Hold'em, with real
rooms, real private-room codes, and real players — no fake online counts, no
decorative "ghost" rooms. Everything you see is actually happening on the
server.

## Run it

```
npm install
node server.js
```

Then open the URL it prints, e.g. `http://localhost:3000`.

- **Same machine, multiple tabs/browsers:** just open the URL again — they're
  genuinely independent connections to the same server.
- **Other devices on your Wi‑Fi:** the server also prints a `Network:` URL
  (your machine's LAN IP) — open that on a phone/laptop on the same network.
- **Friends elsewhere on the internet:** localhost/LAN only reaches your own
  network. To let anyone join from anywhere, deploy this app somewhere that
  can run `node server.js` continuously — Render, Railway, Fly.io, a small
  VPS, etc. all work; there's no database to configure, it's a single
  process. Once deployed, share that public URL instead.

## How it works

- `server.js` is the single source of truth: it holds every room, player,
  chat message, and the actual Blackjack/Poker game engines, and pushes
  updates to connected browsers over WebSocket in real time.
- `public/client.js` is a thin client — it renders whatever the server sends
  and forwards clicks/actions back over the socket. It holds no game logic
  of its own.
- Poker hole cards are only ever sent to the player who owns them (masked
  for everyone else until showdown) — enforced server-side, not just hidden
  in the UI.
- Bots fill empty seats so a table is playable solo; they're always labeled
  "Bot" and are never counted in the real online/player stats.
- Identity is still just a nickname for the session (no accounts) — closing
  the tab or losing connection removes you from your table.

## Adding another game later

1. Add an entry to the `Games.list` registry (top of `server.js`).
2. Write an engine class following the `BlackjackGame` / `PokerGame` pattern
   (`onChange` to push state, `onSystemChat` for result messages).
3. Add a matching `serializeGameForViewer` branch (mask anything that
   shouldn't be visible to other players) and a `paint*Table` renderer in
   `public/client.js`.

The room/lobby/chat code doesn't need to change.
