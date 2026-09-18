# Multiplayer

The gotchas of `src/net`: the room, the handshake, the shared clock, and the two ways a session ends
up back on its own. `spec.md` section 21 is the design. The pause menu page this is driven from is
in `docs/menus.md`.

## Contents

- The pieces and what may import what
- The room code and the invite link
- The handshake and the refusals
- The shared clock
- Signalling, the relays and the CSP
- Going back to single player
- What is not here yet

## The pieces and what may import what

- `invite.ts` — the room code, and the invite link that carries the seed and the room in the hash.
  Pure, and imported at the top level, so a page opened on a link reads its room without loading a
  line of networking.
- `protocol.ts` — what crosses the wire, and what a peer is allowed to say. Everything arriving from
  another browser is read into a shape here or dropped.
- `tick-lock.ts` — the shared clock, as arithmetic in tick space. It reads no clock of its own.
- `party.ts` — the room as a state machine: the handshake, the peer count, the refusals and the
  fall back to single player. It holds no Trystero and no DOM; `NetLink` is the whole of its contact
  with a socket, so `test/multiplayer.test.ts` drives it with a link that has nothing behind it.
- `link.ts` — the Trystero half: the strategies, the relay wait, and the two actions. Loaded only
  from `control.ts`, never at the top level.
- `control.ts` — what the session holds: offline until a press, and the one place the lazy import
  happens.
- `attach.ts` — the wiring `main.ts` calls once. The only file here that reads the page, because the
  invite link lives in the address bar.

`src/net` is not one of the order-stable directories, so a `Map` may be walked here. Nothing in it
may be imported from `src/sim`: the record is single-player state, and the room reads it rather than
the other way round.

## The room code and the invite link

- A code is six characters of `CODE_ALPHABET`, which leaves out `0`/`O`, `1`/`I`/`L` and `U`: a
  code is read aloud down a phone. `readRoomCode` takes it back in any case and with spaces or
  dashes in it.
- The code is drawn from `crypto.getRandomValues`, not from `rngFor`. A room is the player's choice
  of company, not part of the simulation, and two sessions on one seed must land in different rooms.
- The seed and the room both travel in the hash, so the link needs nothing of the server.
  `attach.ts` writes the room into the hash while a room is open and clears it when there is none,
  so the address bar is always the link to copy, or the plain seed.

## The handshake and the refusals

- Both sides send `hello` when Trystero reports a peer. It carries the protocol, the seed, the
  sender's tick and whether the sender is the host.
- A peer on another seed or another protocol is turned away, and so is one that would be the seventh
  player. There is no message for a refusal: the other side reads our own `hello` and refuses us for
  the same reason, so both ends land on the same line without a round trip.
- A joiner turned away by the host has nobody left, so it closes and goes back to single player. A
  host turns the peer away and keeps its room.
- `PROTOCOL` goes up whenever a message changes shape. Two builds that read one field differently
  would diverge quietly, which is the one failure the shared clock cannot show.

## The shared clock

- The host is the authority. It beats its tick every `BEAT_TICKS`, and only while somebody is in the
  room.
- A joiner locks to the host's tick at the handshake and nowhere else: `onSnap` carries the tick up
  to `main.ts`, which puts the record on it and resets the camera, the smoothing and the audio, the
  way a metro trip does.
- Between beats the joiner walks: one extra step in a frame that is behind, one fewer in a frame
  that is ahead. At 60 frames a second that closes a second of drift in a second, so the city runs
  slightly fast or slow rather than jumping.
- Past `SNAP_TICKS` it jumps instead. Two seconds is more than a slow frame or a lost beat explains.
- A beat carries the host's tick as it was when it was sent, so a joiner sits half a round trip
  behind. Measuring that needs the round trip, which is not here yet.
- **A session in a room is never paused.** `main.ts` keeps stepping while the pause menu is open
  when `party.live`, because a peer that stopped would be dragged back to the host's clock the
  moment it came back. The menu still takes every key, and the frame is stepped with an empty input.

## Signalling, the relays and the CSP

- **The subpaths of the `trystero` package throw.** In 0.25 `trystero/mqtt` is a shim that raises
  "Importing from … is deprecated". The strategies are their own packages: `@trystero-p2p/nostr` and
  `@trystero-p2p/mqtt`, which is what `link.ts` imports and `package.json` depends on.
- Nostr is tried first and MQTT second. A strategy has `RELAY_TIMEOUT_MS` to get one socket open;
  where none opens, the room is left and the next strategy is tried. Neither relay list is ours and
  no server is deployed or paid for by anyone.
- Each strategy is fetched by its own dynamic import, so a session that never falls back never
  downloads the MQTT client. `npm run build` shows this: the trystero chunks are referenced from the
  `link` chunk and from nowhere in `index`.
- **WebRTC's ICE servers are checked against `connect-src`.** The relays are `wss:`, which
  `public/_headers` already allowed, but the default STUN servers are the `stun:` scheme and are
  refused without it. That failure looks like peers that never connect, with nothing in the log but
  a CSP violation.

## Going back to single player

Everything ends in `Party.close`, which leaves the room, lets go of the host's clock and reports one
line the player reads. It happens when the player leaves, when the last peer leaves a room that had
company, when the host leaves, when the host refuses us, and — in `control.ts` — when no relay
answers at all. The session keeps the tick it stands on and carries on without a reload.

## What is not here yet

Spec section 21 is larger than what `src/net` holds. The next issue brings player replication and
host authority: promoted actors and mission entities as deltas, each player authoritative over
itself, correction snapshots, interest management, and host migration when the host leaves. Until
migration exists, a room whose host leaves degrades like any other room that empties.
