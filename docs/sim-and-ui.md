# Simulation and interface

The gotchas of `src/sim` and `src/ui`: what Rapier does with a wheel, a force and a heightfield,
what the record may hold, and what the HUD and the map read. `spec.md` sections 11, 12, 14, 16, 18
and 20.3 are the design. Read the section the work touches, not the file. The menus and the screens
around play — the title screen, the loading screen, the pause menu and the saves — are in
`docs/menus.md`, and the shops, the counters and the interiors of spec section 16 in
`docs/shops.md`. The properties the player buys are in `docs/safehouses.md`, the factions, their
reputation and their turf in `docs/factions.md`, and the work their contacts hand out in
`docs/missions.md`. The city that lives around the player — the ambient traffic, the lights, the
parked cars, the tram, the crowd and the metro of spec section 13 — is in `docs/city-life.md`.

## Contents

- The player and the HUD
- The map
- Physics
- On foot
- Hotwiring
- Weapons
- Death, arrest and heat
- Heat and the police
- The emergency services
- The ground the physics reads
- Vehicles
- Damage, fire and skids

## The player and the HUD

- The player's look is indices into the tables in `src/sim/character.ts`, so a save carries numbers,
  not colours. `normaliseAppearance` folds an out-of-range index back onto a real option, and
  `resolveAppearance` hands the renderer the entries. `src/render/character.ts` builds the model
  from them as boxes; the parts a top-down camera sees carry the chosen colours. What moves those
  boxes — the walk, the jump and the stroke — is in `docs/render-entities.md`.
- `src/ui/hud.ts` is the HUD of spec section 12: the status block at the top left is what a
  developer reads — seed, clock, draw calls, quality tier and what is being driven — and the panel
  at the bottom left is the game's own HUD: health, money, weapon and ammunition, heat and the
  current objective. Every field is written only when its text changes, because a DOM write lays the
  whole overlay out again and doing that sixty times a second for numbers that stand still is a
  frame the city could have spent on itself. The radio line under it is what `src/audio` says is on
  air (spec section 15), so it is there only while something is playing. `SimState.money` is moved
  by the shops of spec section 16.1 and the contraband market of 16.2 (`docs/market.md`).
  `SimState.objective` is the leg of the job being carried and what is left of its clock, written
  by the missions of spec section 18 (`docs/missions.md`) and by nothing else. The turf line under
  the heat is whose block the player is standing on and how far
  through taking it they are (spec section 17.2); `main.ts` reads it off `turfLine` and hands it in,
  because the HUD knows the record and not the world.

## The map

- `src/ui/map.ts` is the map model of spec section 12, and it is pure, so the projection, the zoom
  steps, the icon table and the culling are tested headless. The map keeps the world's own axes:
  world `(x, y)` is drawn at pixel `(x, y)`, so north is up and the map reads the way
  `scripts/world-preview.ts` draws the same world. `rotationForHeading` is what turns a rotating map
  so the player faces up. `POI_STYLES` is the one icon table: every type has a shape no other type
  uses and a colour no other type uses, and `test/map.test.ts` pins both. `MapPois.extra` is the
  slot a system that owns places writes — the shops of spec section 16.1, the safehouses of 16.3,
  the factions of 17, the missions of 18 — and nothing reads a second list.
- `MapDrawOptions.overlay` is the slot the territory of spec section 17.2 draws through
  (`docs/factions.md`). It is handed the canvas in world metres and the world box the view can show,
  so an overlay over the whole map draws only the part on screen.
- `src/ui/map-draw.ts` is the one place that says what a map looks like. `Minimap` (`minimap.ts`)
  and `MapScreen` (`map-screen.ts`) both draw through one `MapArt`, so the corner map and the full
  map cannot disagree about a road or a mark. The land and the sea are a bitmap one pixel to a
  terrain cell, drawn scaled; the roads are strokes off `RoadSegmentIndex`, so the map is sharp at
  half a metre to the pixel and at sixteen. Both widgets redraw only when something on them has
  moved, so a session standing still pays for neither.
- `MapScreen` is given a `touch` flag, and a touch browser is drawn a row of zoom and close keys
  over the picture: it has no wheel to zoom with and no `M` to close with. `docs/menus.md` holds
  the rest of what a phone changes.
- Look at the map before judging a change to it: `node scripts/map-preview.ts <seed> out.png`, and
  `--minimap` for the round window at the minimap's own scale. It needs a Chromium but no WebGPU
  device, because the map is a 2D canvas.

## Physics

- `src/sim/physics.ts` is the only place Rapier is used, with `ground-bodies.ts` (the heightfield
  tiles and the decks), `drivetrain.ts` (what the input does to the wheels, the rider and the hull)
  and `gunfire.ts` (the casts, the swings and the flights) beside it. `await initPhysics()` loads
  its WebAssembly once, then `new SimPhysics(ground, state)` builds a world and `stepSim(state,
  input, physics)` steps it once per tick. The bodies are built from `state.vehicle` and never
  stored in it, so the state stays plain data: `adopt` makes the world agree with the record again
  after a load, and `spawn` puts the car down on the ground.
- The `Ground` it is built from is `src/city.ts`: everything placed once for a seed and then read
  every tick — the traffic, the crowd, the tram, the police, the emergency services — and the
  heights and decks under them. `main.ts` calls `buildCity` and runs the frame; a test builds the
  pieces it needs by hand instead, because every field but the heights is optional.

## On foot

- `src/sim/on-foot.ts` is the player out of the car (spec sections 11.2, 11.5): their record, the
  numbers a person is made of, and the pure rules for reaching a door and stepping out of one.
  `physics.ts` is the Rapier half. Exactly one body moves: driving builds the vehicle's dynamic
  body, and on foot builds the player's kinematic capsule and leaves the vehicle as a fixed body, so
  a parked car is walked round rather than simulated. `adopt` builds whichever the record asks for,
  and `player.driving` is what it reads.
- The player walks in the map's own axes, because the camera never turns: the forward axis walks
  toward `-y`, which is up the screen, and the steering axis across it. They then turn to face the
  way they walk. Gravity is integrated in `walk` rather than by Rapier, since a kinematic body is
  moved and never pushed.
- The input frame carries a key as a level, not a press, so `player.held` keeps last tick's interact
  and jump: a door that opened on the level would open sixty times a second. Health regenerates only
  through `heal(player, source)`; nothing heals on its own (spec section 11.5).
- Water over the feet deeper than `SWIM_DEPTH` of the player's own height — chest deep — swims
  instead of walking (spec section 11.5). `swims` is the test and `swimRise` the water: it holds the
  body at `FLOAT_DEPTH` of its height under the surface and takes back the speed of whatever fall
  carried it in, so a jump off a bridge sinks and comes back up rather than reaching the sea floor.
  `FLOAT_DEPTH` is deeper than `SWIM_DEPTH` on purpose, or a floating player would bob in and out of
  swimming. The pace is `swimPaceOf`, there is nothing to jump off, and the sea floor under a
  swimmer takes nothing back: the water owns their speed up and down. No field is added to the
  record — whether they swim is a function of where they stand — so a save from before it still
  loads.

## Hotwiring

- `src/sim/theft.ts` is the hotwire minigame (spec section 11.4). `needsHotwire` reads the roster's
  own `alarm` and `luxury` flags, so nothing carries a second list of what is worth stealing, and
  `VehicleState.hotwired` says a lock is beaten once and not again. An attempt can only end in the
  vehicle opening: `HOTWIRE_CAP` ticks after it starts the last pin gives way, so no player is ever
  stranded at a door. `physics.ts` steps it from the tick it steps everything else from, which is
  what keeps the world running around it, and a player working at a lock is walked with an empty
  input rather than frozen, so the ground still holds them up. `transfer` owns the interact key
  while an attempt runs; nothing else may read that edge.

## Weapons

- `src/sim/weapon.ts` is the arsenal of spec section 11.6: what a weapon is made of and the firing
  model. `arsenal.ts` is the table of every weapon the spec lists and `loadout.ts` what the player
  is carrying; both come out through `weapon.ts`. Ammunition is per calibre, so a magazine is two
  numbers — the rounds in the weapon and the pool behind it — and `AMMO_CAP` is what a player can
  carry of each. `stepWeapons` is one tick of the whole model, the way `stepTheft` is one tick of
  the minigame: the aim, the weapon cycle, the reload, the recoil and the trigger. A trigger is read
  as a level on an automatic weapon and as an edge on everything else, and a pull on an empty
  magazine starts the reload instead of firing. Recoil only comes back `RECOIL_SETTLE` ticks after
  the last shot, which is why holding a machine gun sprays and letting go settles it. Only a pistol
  or an SMG fires from a seat.
- `src/sim/attachment.ts` is what an attachment does. A fitted weapon is a `WeaponSpec` like any
  row, so read a carried weapon through `slotSpec` or `currentWeapon`, never `weaponOf(slot.id)`:
  the bare row has the wrong magazine and the wrong heat. `fitted` shares one frozen row per weapon
  and list, because the firing model reads the weapon in hand several times a tick. A slot keeps its
  attachments in the order of `ATTACHMENTS`, so a save does not depend on the order they were
  fitted in. `Shot.alert` is the radius police hear a shot from and `showsLongGun` is whether they
  see a long gun; the police of spec section 14 are what will read both.
- `src/sim/pickup.ts` is the weapons lying in the world. `stepSim` steps them after the physics, so
  the player takes what lies where the tick left them. `takeWeapon` answers false where a pickup
  would give nothing, and such a pickup stays on the ground rather than vanishing. `dropCarried` and
  `dropPoliceCar` are the calls the pedestrians of spec section 13.1 and the police of section 14
  make; nothing calls them yet but the picker.
- `physics.ts` is the Rapier half of that: a gun casts a ray per pellet, a melee weapon sweeps the
  arc `swingReaches` describes, and a thrown weapon or a launcher puts a `ProjectileState` into the
  record that `fly` carries one tick at a time, bouncing it off what it meets until its fuse burns
  through. The shooter's own body is left out of every cast, so nobody shoots their own door. A
  round can hit the player's vehicle, a police car or an enforcer; a cast that meets a traffic body
  stops there as if it met the ground, until #256 lands.
- A swing reaches four things, and one blow may meet several. The enforcers of spec section 17.2 and
  the crowd of section 13.1 are swept **off the record** rather than out of the world, because an
  arc is not a cast: so a bat reaches an enforcer who has just walked into the physics box, and a
  person on the pavement, who stands in no physics at all. The player's own vehicle is measured to
  its panels as a round is. Everything else — a police car, a parked car, the traffic, a kerb — is
  found by the fan of `SWING_RAYS` rays `Gunfire.sweep` casts through the arc, and only a police car
  is taken further once the swing has already landed on something the record knows.
- A blow on a person of the crowd puts them to flight and is a `brawl`; a blow on a police car costs
  what shooting at one costs. The crowd reaches the physics through `Ground.crowd`, which is a
  `CrowdSource` — who is near, where they are and a fright — so a test hands it a bystander rather
  than a city.
- Every blow that lands is written into `SimState.hits` by `src/sim/melee.ts`: what was struck
  (`person`, `vehicle` or `hard`), where, and how hard. It is on the record because two readers need
  it a frame later and neither is the simulation — `src/render/melee-fx.ts` throws the burst and
  `src/audio/plan.ts` fires the cue — and both read every hit newer than the tick they last read, so
  a frame that stepped six ticks sees all six. A hit is forgotten `HIT_MEMORY` ticks after it lands.
  `swingProgress` is how far through a swing the weapon is, which is what the pose is drawn from.
- A swing never shoves a car: a player on foot is a player whose own vehicle is a **fixed** body, so
  it takes the dent and stands still.
- Gunfire damages a vehicle through `damageVehicle` in `damage.ts`, which is the dent, the integrity
  and the fire roll; `hitVehicle` is the same rule with the severity read off the speed a crash
  lost, and `disableEngine` is what the Barrett M82 does. A direction reaches those as the vehicle's
  own `(along, across, up)`, which is `unrotate`'s `x`, `z`, `y` in that order.
- `src/ui/weapon-picker.ts` is the debug picker for the arsenal, as `vehicle-picker.ts` is for the
  roster: `G` opens it, and a row hands over the weapon loaded with spare ammunition behind it.
  Shift and a row drops the weapon three metres ahead as a pickup instead, and the buttons under the
  rows fit and remove the attachments of the weapon in hand. The weapon shops and faction dealers of
  spec section 11.6 are what will replace it.

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
  `main.ts` snap the camera.
- `SimState.heat` is the attention of spec section 14: a sounding alarm, every shot fired and every
  crime raise it, and melee raises none, because the spec calls it silent. The police read it, and
  an arrest is what a chase ends in.

## Heat and the police

- `src/sim/crime.ts` is the heat of spec section 14 and nothing else: `CRIME_HEAT` weighs a crime,
  `HEAT_CAP` is the six stars the HUD has room for, and `decayHeat` runs the heat down once nobody
  has seen the player for `COOL_DELAY`. It is the one table; `theft.ts` and `weapon.ts` no longer
  carry a weight of their own.
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

## The emergency services

- `src/sim/emergency.ts` is the fire engines and the ambulances of spec section 20.3. It is not the
  police: the police come out on the heat, which is about the player, and these come out on what has
  happened, which is not — a car left burning across town draws an engine whether anybody is
  watching or not. What has happened is written down as an `EmergencyCall` on the record. A call
  within `CALL_RANGE` of one already open is the same scene, so a street of burning cars and a
  firefight that goes on for a minute are each one call.
- A call waits the district's own `responseTicks`, the police's own function, and is then given to a
  unit. `UNITS_OUT` is the ceiling on both services together, so a long fire never empties the city.
  A unit comes in on a road `SPAWN_RANGE` from the scene, drives to it, works it for
  `WORK_TICKS`, and drives back out; it is taken off the map once it is `RETIRE_RANGE` from the
  player, and drives another `SPAWN_RANGE` out rather than standing in the street if it gets home
  while still in sight.
- Routing is `unit-route.ts`, the police's own, with one addition. `plan` ends at the node nearest
  the goal, and the nodes of a city are a block apart, so an engine sent to a fire in the middle of
  a street would stop at the corner and hose nothing. `planBeside` drives the run of road the scene
  stands on, and `nearestAlong` says where along it to pull up. A unit's `stop` is that distance,
  and reaching it is what counts as arriving.
- A fire engine that has arrived calls `douseFires` every tick it stands there, so a fire that
  reaches the next car along while it is working is put out too.

## The ground the physics reads

- The physics reads the world through a `Ground`: the carved height at a place, what that ground is
  made of, and where the sea stands. The game hands it `WorldScene.heightAt`, `SurfaceIndex` and
  `world.water.seaLevel`; a test hands it a hillside of its own, which is why
  `test/sim-sweep.test.ts` generates no cities.
- `roadDecks(world)` (`decks.ts`) is the deck of every bridged stretch as plain data: the strip the
  road drives on at its bed height, as wide as the surface `road-mesh.ts` lofts, with a parapet
  `PARAPET_HEIGHT` high each side. A bridged segment carves nothing, so nothing else says where a
  bridge is. The physics stands on it and the renderer draws its parapet at the same height, so what
  holds the car is what the player sees.
- Ground is a Rapier heightfield collider per 50 m tile, laid on a grid anchored on the origin, two
  tiles each way of the car. The decks of `Ground.decks` are laid over the same box, one trimesh per
  span, and a whole span is laid or dropped at once so a bridge never ends under a car halfway
  across it. Rapier reads a heightfield as `heights[j * (rows + 1) + i]` with `i` walking `z` and
  `j` walking `x`; getting that round the wrong way gives a world rotated a quarter turn, with no
  error.

## Vehicles

- Rapier takes the engine as a force and the brake as the impulse of one step, so `setWheelBrake` is
  given newtons divided by the tick rate. A driven wheel ignores its brake entirely while the engine
  is pushing it, so rolling resistance comes off the drive there and off the brake everywhere else.
- The vehicle's own frame is forward along local `+x`, up `+y`, axle `+z` — the frame the character
  model already uses, since a yaw of `-heading` points local `+x` along the map heading. Rapier
  turns a steered wheel the other way round the up axis, so the steering angle is the negative of
  the input.
- `src/sim/vehicle.ts` holds the roster of spec section 11.3 as a table of `VehicleSpec`, and
  `SURFACE_GRIP` what a tyre finds on each surface; nothing else should carry those numbers.
  `VehicleState.cls` names the row, so the body, the handling and the model are all rebuilt from the
  record; `specOf` reads it and `VEHICLE_CLASSES` is the order the picker shows.
  `src/ui/vehicle-picker.ts` is that picker.
- Rapier keeps a force or a torque until it is told to forget it, so `step` clears the last tick's
  before adding this tick's. Without that the buoyancy of a hull and the rider of a two-wheeler both
  grow without bound over a few seconds, and nothing says why.
- A boat has no wheels, so `physics.ts` gives it its own controller: lift at the four quarters of
  the hull, drag much higher across it than along it, and a rudder whose bite grows with the water
  flowing past it. A hull out of the water is a box resting on the ground.
- Rapier takes a vehicle's roll stiffness from where its wheels stand, so two wheels on the
  centreline have none and a motorcycle falls over. It stands on four at a track of a few
  centimetres; `VehicleSpec.inline` tells the model to draw the two the rider sees.
  `VehicleSpec.balance` is the rider on top of that: roll is sprung and damped, pitch is only
  damped, so the bike still points up a hill.
- `src/render/vehicle-mesh.ts` is the one place that says what shape each class is: boxes in the
  vehicle's own frame, with the masses that carry the outline of spec section 10.1 marked. It holds
  no three.js, so the silhouettes are measured headless.
- How wet the road is comes from the weather of spec section 13.4, which is `docs/weather.md`.
- `src/world/surface.ts` says what the ground is made of at a place — asphalt, dirt, sand or open
  ground — and where the nearest road a car can start on, or the nearest open water a boat can, is.
  It is a read of the parcel model's allocation, not a second one: a road claims the ground within
  `footprintHalfWidth` of its centreline and a beach claims its sand.

## Damage, fire and skids

- `src/sim/damage.ts` is the damage, fire and explosion of spec section 11.3: what one impact does
  to a vehicle, the panels it dents and tears off, and the progression `intact` to `dented` to
  `smoking` to `burning` to `burnt`. A vehicle only ever moves forward through it. `physics.ts`
  measures the impacts as the speed the chassis lost over one step, because Rapier resolves a crash
  inside one step and nothing a driver does moves a vehicle by anything near `IMPACT_FLOOR` in a
  tick; the direction it was pushed says which panel took the blow. `spreadFire(vehicles, seed,
  tick)` is the rule for fire between vehicles: it reaches out every `SPREAD_PERIOD` ticks once a
  fire has burned for `SPREAD_DELAY`, and each vehicle in reach takes one roll however many fires
  reach it, so the answer does not depend on the order of the list. `extinguish` is the one step
  back through the progression, from `burning` to `smoking`, and nothing takes a vehicle out of
  `burnt`.
- `src/sim/fire.ts` is the list those rules are run over: the player's vehicle and every promoted
  one, which is everything in the record that can burn. `physics.ts` calls `stepFires` after `burn`,
  because `burn` is where the player's own car goes up and it has the body to throw.
- A vehicle burns for `FUSE_TICKS`, which is seven seconds, and nothing can cross a city in seven
  seconds. So a fire engine never saves the car that started a fire: what it fights is the `Blaze`
  the wreck leaves where it stood. A blaze burns for `BLAZE_SECONDS`, lights the vehicles within
  `SPREAD_RADIUS` on the same timer and the same roll `spreadFire` uses, and goes out when it burns
  itself out or a hose reaches it. That is the fire that spreads, and the one spec section 20.3 has
  an engine put out.
- `WheelState.skid` is the one definition of a sliding tyre: the body is going across its own axle
  faster than `SKID_SLIP`, whether that came from the handbrake, a corner or a spin.
  `src/render/skid.ts` is what draws it.
- The gradient needs no rule of its own. The chassis is a rigid body, so a climb has gravity to
  fight and a descent has it behind; adding a slope term on top of that would count it twice.

