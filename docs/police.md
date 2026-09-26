# Heat and the police

The gotchas of spec sections 11.7 and 14: how a run ends in a death or an arrest, what the heat is
worth, and how the police answer it. The code is `src/sim/police/crime.ts`,
`src/sim/police/police.ts` and `src/sim/player/respawn.ts`, and for the officers on foot
`officer.ts`, `squad.ts`, `duty.ts`, `officer-fire.ts` and `arrest.ts`, and for the patrol between
chases `patrol.ts`. The weapons that raise the heat are in `docs/sim-and-ui.md`. The airport's
airside, the theft of a military aircraft and the helicopter's gun are in `docs/aircraft.md`.

## Contents

- Death, arrest and heat
- Heat and the police
- The police on foot
- Sight, fire from a car and the patrol

## Death, arrest and heat

- `src/sim/player/respawn.ts` is death and arrest (spec section 11.7). A death is `player.health` at
  0 and an arrest is `SimState.arrested`; `stepSim` turns either into a respawn at the end of the
  tick, so whatever wrote them — a crash, a blast, the debug keys `K` and `B`, the cuffs closing —
  replays the same. The player comes back on foot with fists only; the car stays where the run
  ended. `loadout.shots` survives, because it keys the stream of every shot. An arrest also takes
  the contraband in the player's hands, and neither fate can reach a safehouse stash
  (`docs/safehouses.md`). A death sends the player to their active safehouse and an arrest to the
  nearest police station; a player who owns no safehouse comes back at `SimState.origin`, where the
  session started. The police stations come from `ParcelMap.stations`, built in the chunk workers,
  so `main.ts` reads them off `WorldScene.stations` after `settle` and hands them to the physics as
  `Ground.stations`. A world with none sends an arrest to the safehouse too. `SimState.respawn`
  changing is what makes `frame.ts` snap the camera.
- `SimState.heat` is the attention of spec section 14: a sounding alarm, every shot fired and every
  crime raise it, and melee raises none, because the spec calls it silent. The police read it, and
  an arrest is what a chase ends in. Only an officer on foot arrests; a car no longer does. A
  surrender (`X` at one or two stars) costs `SURRENDER_BRIBE` rather than `ARREST_BRIBE`, and
  `respawn` reads `police.surrendered` before `standDownAll` clears it.

## Heat and the police

- `src/sim/police/crime.ts` is the heat of spec section 14 and nothing else: `CRIME_HEAT` weighs a
  crime, `HEAT_CAP` is the six stars the HUD has room for, and `decayHeat` runs the heat down once
  nobody has seen the player for `COOL_DELAY`. It is the one table; `theft.ts` and `weapon.ts` no
  longer carry a weight of their own.
- `raiseHeat` makes each star cost more than the one before: the first costs 1.25 of crime and the
  sixth 3.75, so six stars take 15. The rule adds up the same however a raise is split. A test that
  expects a sum of weights must pass that sum through `raiseHeat(0, …)`; `effortFor` goes the other
  way, from a heat to what it costs.
- An arrest or a death calls the whole force off with `standDownAll`, not only the heat. Units
  left out after a six-star chase would take up the chase again at the first small crime.
- Every raise of the heat goes through `report` in `src/sim/police/police.ts`, which also writes
  down where it happened. That is what makes the cooling honest: the clock is measured from the last
  thing the police know, so a crime nobody stood next to still tells them the street to start on.
  Writing `state.heat` by hand instead leaves them looking in the wrong place, and the heat cools
  from the wrong tick.
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
  share of the car the round took. The helicopter carries no body at all. The class under it is
  `CarBodies`, fed by a getter of its cars and the box each one stands as; `EmergencyBodies`
  (`emergency-bodies.ts`) is the same class for the fire engines and the ambulances.
- `PersonBodies` (`person-bodies.ts`) is the same file for people, in an upright capsule rather
  than a box. `UnitBodies` (`unit-bodies.ts`) holds one for the faction enforcers of spec section
  17.2 and one for the officers on foot, each fed by a getter of its list, and the police cars. It
  is what `physics.ts` settles once a tick, because all three are given a body over the same box.
- The two exits of the spec are one rule reached two ways. Both hiding and wrecking the pursuers end
  the sighting, and the heat cools from there. Wrecking one costs `officerKilling`, which is the
  hard escalation the spec asks for, so the second exit is the longer one.
- `src/render/services/police.ts` draws the units off the record. They are stepped once a tick like
  the player, so nothing is evaluated between two ticks there, unlike the traffic and the trams.

## The police on foot

- **A crew gets out of a car that has stopped.** `bailOut` (`duty.ts`) lets the crew out of a car
  standing within `BAIL_RANGE` of the player, or of a roadblock within `BLOCK_BAIL_RANGE`. A car is
  held while any of its crew is out (`crewOut` in `police.ts`), and a car whose whole crew was put
  down stands where it stopped for good: it no longer counts toward the force, so another is sent.
  The crew walk back and `board` once the player drives off past `RECALL_RANGE`.
- **The cuffs are judged before the physics.** `stepSim` calls `stepArrest` first; while it answers
  true the physics steps with `EMPTY_INPUT`, so a held player moves nothing. `startCuffs` runs at
  the end of `Squad.step`, after the officers have moved, so the one who has just run up takes hold
  on the tick they arrive. A driver is taken only in a car under `DRAG_SPEED`, and `transfer` in
  `physics.ts` then pulls them out of the seat, whatever `EXIT_SPEED` says.
- **A key held when the cuffs go on is not a press.** `Cuffs.held` starts true, so the struggle
  counts from the first fresh press of jump. A test that mashes from the first tick is one short.
- **An officer's path is a straight line round walls.** `Squad.wayRound` feels ahead with
  `CasualtyGround.reach` and turns further off the line, always to its own side, until it is clear.
  The same ray answers whether an officer sees the player. It is enough for a city of blocks; an
  officer can still be stuck in a concave courtyard. Without a ground, as in a test, the street is
  open.
- **The police shoot through the player's own record.** `officerFire` writes tracers with `by:
  'police'`. Only `by === 'player'` tracers kick the camera (`frame.ts`) and mark the crosshair;
  `audio/police-ears.ts` plays a gunshot for each police tracer with `pellet === 0`. The shooting
  starts at `FIRE_STARS` (two), and nobody fires at a player being cuffed or who has given up.
- **Barks are records, not sounds.** `bark()` keeps one of a kind a second at most in
  `police.barks`, and the audio reads the new ones each frame: a shout in the street, or a squelch
  and a radio call for `spotted` and `lost`.
- **The views.** `ui/hud/officers.ts` pushes the officers into the crowd's list of standing people
  after the street life, and `render/services/uniform.ts` is their look. The fourth value of
  `pedMotion` is the uniform flag, and 1 paints a patrol officer's shoulders hi-vis. An officer with
  their gun out is drawn in the `aim` gait, and `render/services/officer-guns.ts` puts the gun in
  the hands. The fallen are drawn by `render/people/casualties.ts` from `police.fallen`. `--police`
  on the render preview lays one of each.

## Sight, fire from a car and the patrol

- **A car sees nothing through a building.** `PoliceForce.look` asks `inSight` (`squad.ts`), the
  ray the officers on foot see by, from `CAR_EYE` over the road. That is over the car's own roof,
  so the ray does not start inside the car's own body and stop at once. The helicopter is not
  asked: it looks down over the roofs. Without a ground, as in a test, every street is open.
- **A crew still in a stopped car fires out of the window.** `unitFire` (`officer-fire.ts`) fires
  the gun an officer of that crew would draw, through the same `shoot` as an officer on foot, but
  slower and worse. It keys its own stream, `Subsystem.UnitFire`, and runs after `Squad.step`, so a
  crew that got out this tick does not also fire from the seats. `PoliceUnit.fired` is its clock.
- **The patrol runs only at no heat.** `patrol` (`patrol.ts`) reads the diary of spec section 20.5
  once a second and sends a car to an incident within `ANSWER_NEAR` of the player: behind the
  driver of a traffic stop, to the corner of anything else. The car has the task `answer` and the
  incident's id in `incident`. At any heat, `PoliceForce.step` gives it a chase task like every
  other unit, so a chase never pays for the patrol. `standDown` leaves an `answer` car alone. A car
  whose incident is over turns to `leave`, drives off with no siren, and is taken off the map once
  it is `STAND_DOWN_RANGE` away. The corners come from `Ground.crimes`, which `physics.ts` passes
  to `step`; without them nothing is answered.
