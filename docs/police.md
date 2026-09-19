# Heat and the police

The gotchas of spec sections 11.7 and 14: how a run ends in a death or an arrest, what the heat is
worth, and how the police answer it. The code is `src/sim/crime.ts`, `src/sim/police.ts` and
`src/sim/respawn.ts`. The weapons that raise the heat are in `docs/sim-and-ui.md`.

## Contents

- Death, arrest and heat
- Heat and the police

## Death, arrest and heat

- `src/sim/respawn.ts` is death and arrest (spec section 11.7). A death is `player.health` at 0 and
  an arrest is `SimState.arrested`; `stepSim` turns either into a respawn at the end of the tick, so
  whatever wrote them — a crash, a blast, the debug keys `K` and `B`, the police later — replays the
  same. The player comes back on foot with fists only; the car stays where the run ended.
  `loadout.shots` survives, because it keys the stream of every shot. An arrest also takes the
  contraband in the player's hands, and neither fate can reach a safehouse stash
  (`docs/safehouses.md`). A death sends the player to their active safehouse and an arrest to the
  nearest police station; a player who owns no safehouse comes back at `SimState.origin`, where the
  session started. The police stations come from
  `ParcelMap.stations`, built in the chunk workers, so `main.ts` reads them off
  `WorldScene.stations` after `settle` and hands them to the physics as `Ground.stations`. A world
  with none sends an arrest to the safehouse too. `SimState.respawn` changing is what makes
  `frame.ts` snap the camera.
- `SimState.heat` is the attention of spec section 14: a sounding alarm, every shot fired and every
  crime raise it, and melee raises none, because the spec calls it silent. The police read it, and
  an arrest is what a chase ends in.

## Heat and the police

- `src/sim/crime.ts` is the heat of spec section 14 and nothing else: `CRIME_HEAT` weighs a crime,
  `HEAT_CAP` is the six stars the HUD has room for, and `decayHeat` runs the heat down once nobody
  has seen the player for `COOL_DELAY`. It is the one table; `theft.ts` and `weapon.ts` no longer
  carry a weight of their own.
- `raiseHeat` makes each star cost more than the one before: the first costs 1.25 of crime and the
  sixth 3.75, so six stars take 15. The rule adds up the same however a raise is split. A test that
  expects a sum of weights must pass that sum through `raiseHeat(0, …)`; `effortFor` goes the other
  way, from a heat to what it costs.
- An arrest or a death calls the whole force off with `standDownAll`, not only the heat. Units
  left out after a six-star chase would take up the chase again at the first small crime.
- Every raise of the heat goes through `report` in `src/sim/police.ts`, which also writes down where
  it happened. That is what makes the cooling honest: the clock is measured from the last thing the
  police know, so a crime nobody stood next to still tells them the street to start on. Writing
  `state.heat` by hand instead leaves them looking in the wrong place, and the heat cools from the
  wrong tick.
- `PoliceForce` is stepped by the physics, after the world has moved, so the units answer the tick
  the player has just driven. It holds no state of the chase: `SimState.police` is the record, so a
  save is loaded and the same force carries on from it. `UnitRoads` (`unit-route.ts`) is the
  routing — `RoadGraph.shortestPath` over travel time — and it caches the legs of a route per unit,
  because a route is planned every two seconds and read every tick. The faction enforcers of spec
  section 17.2 walk the same roads through the same class, which is why it is named for a unit and
  not for the police.
- A unit is routed to a place, never along the player's path: a chase is aimed at the last sighting,
  a cut-off and a roadblock at a point ahead of the way the player was going, and a search at a
  place round the last sighting that its own stream picks. A unit within `HOLD_RANGE` of its goal
  pulls up and stands there, or a car that had arrived would drive round the block for ever.
- A unit comes in on a road `SPAWN_RANGE` from **what the police know**, not from where the player
  is. Sending it out round the player is what makes hiding impossible: the car arrives on top of
  them, sees them, and the heat never cools.
- `PoliceBodies` (`police-bodies.ts`) gives the units inside the physics box a kinematic body, the
  way the trams have one, so a roadblock is a wall. It also answers `unitAt(handle)`, which is how a
  round that went into a police car finds the unit it hit; `gunfire.ts` calls `shootUnit` with the
  share of the car the round took. The helicopter carries no body at all.
- `EnforcerBodies` (`enforcer-bodies.ts`) is the same file for the faction enforcers of spec section
  17.2, in an upright capsule rather than a box; `docs/factions.md` has it. `UnitBodies`
  (`unit-bodies.ts`) holds both and is what `physics.ts` settles once a tick, because both are given
  a body over the same box of ground.
- The two exits of the spec are one rule reached two ways. Both hiding and wrecking the pursuers end
  the sighting, and the heat cools from there. Wrecking one costs `officerKilling`, which is the
  hard escalation the spec asks for, so the second exit is the longer one.
- `src/render/police.ts` draws the units off the record. They are stepped once a tick like the
  player, so nothing is evaluated between two ticks there, unlike the traffic and the trams.
