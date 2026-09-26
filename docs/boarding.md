# Getting into a vehicle and out of it

The move a player makes at a door: walk to it, take the handle, open it, climb in, pull it shut.
Getting out is the same move the other way round. `spec.md` sections 11.2 and 11.5 are the design.

## Contents

- The record
- The body
- The door
- Tests

## The record

- `src/sim/player/boarding.ts` holds one move as `state.boarding`: the way (`in` or `out`), the
  start tick, the side, and the ticks of walking to the door. It is `null` when no move runs. A save
  from before the field loads, because a `null` template field accepts `undefined`.
- The move is time, not a switch. `player.driving` changes only on the tick the move ends, in
  `Physics.board`. Until then the player on foot walks with `EMPTY_INPUT`, and a driver's vehicle
  is held with the handbrake on. The same pattern as `state.theft`.
- A move in starts where the player stands. `startBoarding` times the walk to the door at
  `WALK_PACE`, round the nose or the tail when the player stands there, capped at `WALK_CAP`
  ticks. So a player at the tail of a bus walks the length of it.
- `doorAlong(spec)` is where the driver's door is along the vehicle. A car's is at its middle. A
  van, truck and bus have it at the cab, and a boat at its console. `exitPlace` stands a player
  there after they get out, so the move out ends where the record puts them.
- A move out always uses the driver's side (`-1`). A move in uses the side the player stands on.
- A player dragged out by the police skips the move. A move in is cancelled when the vehicle
  leaves reach or the player is cuffed. `spawn`, a respawn and a fetched car clear the record. A
  shop door or a safehouse door refuses a player in the middle of a move.

## The body

- `src/render/people/boarding.ts` turns the record and a progress from 0 to 1 into a frame: the
  body's place and turn in the vehicle's own frame, its pose, and how far the door is open. It has
  no three.js, so it is tested in Node.
- `src/render/people/boarder.ts` puts that frame on the model. It applies the vehicle's whole turn,
  as `rider.ts` does for a rider, so the body moves with a vehicle that rolls or lists.
- The beats are shares of the time after the walk: the door opens, the body turns and ducks into
  the seat, the arm pulls the door shut. `pointArm` points the hand at the handle and at the inner
  edge of the door. So a tall player and a short one both reach it.
- A motorcycle has no door: the rider walks up and swings a leg over the saddle.
- `WorldScene.walkPlayer` takes the move and places the body. `frame.ts` stows the held weapon
  while a move runs.

## The door

- Every door of a lofted body hangs from its own hinge (`docs/vehicle-bodies.md`). `doorOf` finds
  the front door of a side as leaf 0 or 1. `openDoor(side, angle)` holds that door open by the
  move's angle, or by the record's where that is wider.
- The wheel test finds the wheels as the groups with children, so it skips the groups named
  `door`.
- A class with no hinged door gets a virtual one in `doorFor`, placed at `doorAlong`. The body
  still steps to it and climbs in. Nothing swings.

## Tests

- `test/sim/player/boarding.test.ts` checks the first and last frames, the door, the headroom, the
  record and the hold. It also checks that no class moves the body faster than 0.1 m a tick, which
  is where a jump shows.
- Tests that press interact and expect to drive at once call `finishBoarding` from
  `test/support/sim-harness.ts`.
- `node scripts/render-preview.ts <seed> out.png --vehicle=saloon --board=in:0.4` draws one
  frame of the move. `out:0.7` draws a move out, and `in:0.4:1` a move in from the far side.
