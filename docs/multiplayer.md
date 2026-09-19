# Multiplayer

The gotchas of `src/net`: the room, the handshake, the shared clock, and the two ways a session ends
up back on its own. `spec.md` section 21 is the design. The pause menu page this is driven from is
in `docs/menus.md`.

## Contents

- The pieces and what may import what
- The room code and the invite link
- The handshake and the refusals
- The shared clock
- Who owns what
- The players on the wire
- The world the host owns
- When the host leaves
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
- `move.ts` — one player on the wire: the packed frame, the reader, and the one function that
  reads the record into a frame.
- `replica.ts` — one remote player, drawn between the frames they sent and carried on when one is
  late. Pure arithmetic; it holds no models.
- `roster.ts` — everybody else: their looks, their replicas, and who is owed a frame now.
- `divergence.ts` — the parts of a record the host owns, the deltas and the correction snapshots.
- `party.ts` — the room as a state machine: the handshake, the peer count, the refusals and the
  fall back to single player. It holds no Trystero and no DOM; `NetLink` is the whole of its contact
  with a socket. `test/multiplayer.test.ts` drives it with a link that has nothing behind it, and
  `test/replication.test.ts` stands a whole room of them back to back.
- `link.ts` — the Trystero half: the strategies, the relay wait, and the two actions. Loaded only
  from `control.ts`, never at the top level.
- `control.ts` — what the session holds: offline until a press, and the one place the lazy import
  happens.
- `attach.ts` — the wiring `main.ts` calls once. The only file here that reads the page, because the
  invite link lives in the address bar.

`src/net` is not one of the order-stable directories, so a `Map` may be walked here. Nothing under
`src/sim` may import from here: the record does not know it is in a room. This side reads the
record freely, and writes exactly one thing into it — the divergence set of `divergence.ts`, at the
top of `Party.frame`, so a message off a socket never lands in the middle of a tick.

`src/render/remote-players.ts` draws the room. It imports the pose type from `roster.ts` and
nothing else, as a type, so a single-player build still pulls in no networking.

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
  sender's tick, whether the sender is the host, and the look they picked, so the room can draw
  them. A look that is not one of the creator's choices is wrapped into them rather than refused.
- **Trystero reports a join once, to the handler set at that moment.** `openLink` builds the
  `Party` on the link before it waits on the relays, because a peer already in the room can connect
  inside that wait. A join reported to nobody is never greeted, and the room stays half open: the
  host never counts the joiner, so it sends no beat, no world and no frames.
- A `hello` from a peer not yet greeted is answered with our own. So one missed join event still
  ends in a full handshake on both sides.
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
- **A session in a room is never paused.** `frame.ts` keeps stepping while the pause menu is open
  when `party.live`, because a peer that stopped would be dragged back to the host's clock the
  moment it came back. The menu still takes every key, and the frame is stepped with an empty input.

## Who owns what

Spec section 21.4 splits authority three ways, and every file above sits on one side of that split.

- **Each player owns itself.** A peer's own vehicle and character are never written by anybody
  else, so driving never waits on the network. What goes out is the pose and the inputs; what comes
  back is drawn and never stepped.
- **The host owns divergence.** The promoted cars, the startled crowd, the fires, the police, the
  emergency units, the enforcers, the settled street crime and the session's captured blocks are the
  host's, and every joiner's record is written from them.
- **Everything else is derived.** The rest of the city is a function of `(seed, tick)`, which is
  what the shared clock buys. A career is the player's own (21.3): money, missions, reputation,
  loadout and faction standing are not on the wire and are not in the divergence set.

## The players on the wire

- A frame is 25 numbers in a `Float32Array`, about a quarter of what the same fields weigh as JSON.
  Trystero takes a typed array as a payload of its own, so nothing is encoded twice.
- **A `Float32Array` holds a whole number exactly only to 2^24**, which a session passes in 77 hours
  of play, so the tick is split across two slots and put back together on the other side.
- The inputs ride with the pose because the reader predicts with them: a car under throttle is still
  accelerating when the next frame is late.
- A replica is drawn `DELAY_TICKS` behind the local clock, so the frames either side of the moment
  being drawn have usually arrived and the pose is the blend of them. Past the last frame it is dead
  reckoning, for at most `REACH_TICKS`; after that the player holds still, because a pose invented
  for a second and a half is worse than one that stands.
- Interest management is per peer, not per room: a peer within `INTEREST_RANGE` is sent frames at
  `NEAR_TICKS` and one further away at `FAR_TICKS`. A player across the map still arrives smoothly;
  they arrive on fewer frames.

## The world the host owns

- A delta goes out every `DELTA_TICKS` and carries the parts that changed, at most
  `PARTS_PER_DELTA` of them, taking the parts in turn. That cap is what keeps the host's broadcast
  load off the back of how busy the city is (spec section 21.5).
- **The round of parts is read once, before the loop.** Moving the mark inside it steps over the
  part after each one taken, which looks like a delta that is simply never sent.
- A correction snapshot carries the whole set every `SNAPSHOT_TICKS`, so a peer that lost a delta is
  put right within ten seconds instead of drifting until it leaves.
- **A session's territory is in the set, and is written to nobody's save.** Spec section 21.3 says
  a room's captures last as long as the room. So a joiner keeps the blocks it came in with, and
  `control.ts` puts them back as the room closes: the single-player map is as the player left it.
- A part arriving is refused unless it is the shape that part of a record has, and it is copied
  through JSON before it is written in. The host is trusted to describe its own world; this is what
  keeps a malformed peer from putting something in a record that the simulation then steps.

## When the host leaves

- The lowest peer id takes over. Every peer sorts the same list and reaches the same answer on its
  own, so the `host` message that follows is the confirmation and not the decision.
- **Nothing of the divergence set has to be handed over.** Every peer has been writing the host's
  deltas into its own record all along, so the new host already holds what it now owns. It sends a
  correction snapshot at once and starts beating its own clock; the others walk in behind it the way
  they walked in behind the old one.
- A room of two whose host leaves has nobody left, so it falls back to single player as before.

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

- **Friendly fire.** Spec section 21.5 has it on, and nothing here carries a hit yet. A shot finds
  what it hits by a Rapier cast, so a remote player has to stand in the physics world as a body of
  its own — `police-bodies.ts` and `enforcer-bodies.ts` are that file for the police and the
  enforcers — before the owner of the body struck can be told to take the damage.
- **A remote vehicle's damage.** The dents, the lost panels and the fire are not on the wire, so
  another player's car is drawn clean however hard they have been driving it.
- **The round trip.** A beat still carries the host's tick as it was when it was sent, so a joiner
  sits half a round trip behind. Measuring that needs the round trip, which nothing here asks for.
