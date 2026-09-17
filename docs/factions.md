# Factions, reputation and territory

The gotchas of spec section 17: the roster, the standing the player builds with each faction, whose
block is whose, and who comes when a block is taken. The contraband the standing prices is
`docs/market.md`; the record all of it is written into is `src/sim/simulation.ts`, in
`docs/sim-and-ui.md`.

## Contents

- The roster is one table
- Home turf is the seed's, not the roster's
- Reputation, and why a rivalry is symmetric
- Nothing about a holding is stored
- Taking a block
- The enforcers, and the fight they put up
- The overlay

## The roster is one table

- `FACTIONS` (`src/sim/faction.ts`) is the spec's own table: home culture, business, arsenal,
  vehicles, the offer, the rivals and the map colour. Everything else reads it. A new faction goes
  in that array and nowhere else; `FACTION_IDS` is the order the record stores a row per faction in,
  so never reorder it — a save would then read somebody else's standing.
- Seven factions are territorial. Unit 13 is the police and holds no ground, which is `territorial:
  false` and is why `factionForCulture` refuses to answer with it.
- The arsenal is what an enforcer of that faction comes out carrying, so a weapon added to a row
  changes who is shooting at the player and how fast.

## Home turf is the seed's, not the roster's

- A faction's ground is seeded from the districts whose `culture` matches it, and
  `src/world/districts.ts` is what hands those cultures out. So a faction has as many home
  neighbourhoods as the seed gave it, in the places the seed put them, and a seed that fails to
  place one leaves that faction with no ground at all.
- `districtFactions` answers who runs each district, as an array indexed by district id. It is an
  array and not a map because `src/sim` may not walk a map (the determinism rules of `CLAUDE.md`).
- So a faction with no district of its culture holds nothing anywhere. That is not only a theory:
  `withBeachCulture` in `src/world/beaches.ts` overwrites the culture of the districts its longest
  resort runs through, which on seed `sunset` costs Los Reyes and the Bratva every block they would
  have had. Issue #348 is that bug. Look at a seed before concluding a faction is missing from the
  roster: `node scripts/map-preview.ts <seed> out.png --turf --day=8`.

## Reputation, and why a rivalry is symmetric

- `FactionState.standing` is one number a faction, -1..1, in the record. 0 is a stranger: they
  trade, and they do not shoot.
- `shiftStanding` is the one door onto it. Helping one faction is the same act as crossing its
  rivals, so it moves the rivals the other way by half as much in the same call. Nothing else may
  write the row, or a shift would move one side of a rivalry and not the other.
- The rivalries are named on both sides of every pair, and `test/factions.test.ts` pins it. A
  one-sided pair would move the standing in only one direction, which is a bug you would find weeks
  later as a faction that can never be made friendly.
- What moves it today: a capture (`captureBlock`, a quarter of the range off the loser) and every
  contraband trade on a faction's own street (`credit` in `market.ts`, a hundredth). The missions of
  spec section 18 are the rest of it.
- `HOSTILE` is the line at which they shoot on sight, and it is what `stepTerritory` reads to decide
  a block may be taken at all.

## Nothing about a holding is stored

- `TerritoryMap.holderAt(state, bx, by)` is the only answer there is, and it is a pure function of
  the seed, the tick and the block, the way a contraband price is. No map of the turf is kept,
  stepped or saved.
- The reach grows a day at a time (`reachOn`), so the turf spreads over a session. It is a step at
  midnight rather than a drift, which is legible: a player who learns a border on Tuesday finds it
  where they left it until Wednesday.
- The border would be a circle if the reach alone decided it. `raggedness` is a jitter keyed on the
  block and the faction, drawn once and never again, so the shape of a border holds still while the
  reach behind it grows. Key it on the tick and every border crawls.
- The record carries `FactionState.captured`, which is the blocks the player has taken, and that is
  the one thing the function cannot answer. It is kept sorted, so `captured()` is a binary search
  and two sessions that took the same blocks in a different order write the same record.
- `TerritoryMap` is built once for a world because the buildable test is not a function of the block
  alone: sea, the backwoods and the ground off the map are nobody's, and only the heightfield and
  the zone rings know which those are.

## Taking a block

- Standing on it is the whole of it. `stepTerritory` runs from `stepSim` before the physics, because
  a takeover is a rule about where the player is standing and the physics is about to move them off
  it.
- A takeover needs the player on foot, out of a shop, a safehouse and a deal, alive, and standing on
  a block held by a faction at or under `HOSTILE`. Anything else ends it.
- Walking onto the next block does not end a takeover so much as start a new one: the thirty seconds
  already stood are not carried over, which is what stops a player taking a quarter by strolling
  through it.
- The capture calls the next wave (`callWave`, round 2), which is the retaliation spec section 17.2
  asks for. A wave already out at a higher round is left to finish rather than replaced.
- Held ground pays once a game day, in `payIncome`. It is paid a day after the last payment rather
  than on the stroke of midnight, so a session that was not running at midnight is not skipped.

## The enforcers, and the fight they put up

- `EnforcerGang` (`src/sim/enforcer.ts`) is stepped by the physics beside `PoliceForce`, and for the
  same reason: they answer the tick the player has just walked. It holds no state of the fight, so a
  save is loaded and the same people carry on walking.
- They walk the road graph through `UnitRoads` (`unit-route.ts`) — the same routing the police
  drive, which is why that class is named for a unit and not for the police.
- They are drawn in the crowd's own mesh, so a wave costs no draw call. `src/ui/enforcers.ts` writes
  the list of people the mesh reads for both them and the dealers, because the mesh reads one list
  and the enforcers move every tick while the dealers move every few hours.
- **They are the only people on foot with a collider.** `EnforcerBodies` (`enforcer-bodies.ts`)
  stands each one inside the physics box in a kinematic capsule, the shape `capsuleOf` gives the
  average build, and answers `unitAt(handle)` the way `PoliceBodies` does. `gunfire.ts` calls
  `hurtEnforcer` with the weapon's own `damage`, because a person is measured on the player's health
  scale and not in the share of a panel a round takes. The crowd of spec section 13.1 still carries
  nothing: a collider per pedestrian on screen is a larger question.
- **The capsule is a sensor**, which in Rapier is a shape a ray finds and nothing pushes. A solid
  one is an immovable post: a car driven at an enforcer stops dead against them, which a test holds.
  Knocking somebody down is spec section 13.1's question, not this one.
- A melee swing does not use the capsule at all. An arc is not a cast, so `Gunfire.swing` sweeps the
  record with `swingReaches` and the capsule's radius says only how wide an enforcer is. That is why
  a bat reaches somebody a round cannot yet: a swing needs no body.
- A collider is found by a cast only from the step after it was built, so an enforcer who has just
  walked into the physics box cannot be shot until the next tick. A Rapier query against a world
  that has never been stepped finds nothing at all, which looks exactly like a shape that is not
  there.
- A wave is a fixed number of people. `WaveState.sent` counts who it has put on the street rather
  than who is still standing, so shooting one does not call another in their place, and a wave whose
  last enforcer falls is over (`beaten`). Counting the survivors instead gives you a wave that never
  ends.
- One put down drops the weapon they carried, loaded and with no spare rounds, which is how a player
  arms themselves off a wave.
- **There is no line of sight in the record**, so they fire only inside `ENFORCER_RANGE`, which is
  short enough that a wall is rarely between them. Widening that range without a sight test gives
  you enforcers shooting through buildings.
- The player's answers are three: shoot the wave down, hold the ground and take it, or get in a car
  and leave. A player in a car is walked after but not fired at, and a wave gives up once they are
  `GIVE_UP_RANGE` from the block that started it.

## The overlay

- `TerritoryOverlay` (`src/ui/territory.ts`) draws through the `overlay` slot `map-draw.ts` already
  carried, so the corner map and the full map cannot disagree about a border.
- The canvas arrives in world metres and with the world box the view can show, so the overlay walks
  only the blocks on screen and draws nothing at all where nobody holds anything.
- A block's edge is stroked only where its neighbour belongs to somebody else. Stroking every block
  gives you a grid; stroking only the changes gives you a border.
- The block being fought over is dashed in white over the wash, because it is the one block on the
  map the player is being shot at over.
