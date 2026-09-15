# Simulation and interface

The gotchas of `src/sim` and `src/ui`: what Rapier does with a wheel, a force and a heightfield,
what the record may hold, and what the HUD and the map read. `spec.md` sections 11 to 14, 16 and 18
are the design.


- The player's look is indices into the tables in `src/sim/character.ts`, so a save carries numbers,
  not colours. `normaliseAppearance` folds an out-of-range index back onto a real option, and
  `resolveAppearance` hands the renderer the entries. `src/render/character.ts` builds the model
  from them as boxes; the parts a top-down camera sees carry the chosen colours.
- `src/ui/hud.ts` is the HUD of spec section 12: the status block at the top left is what a
  developer reads — seed, clock, draw calls, quality tier and what is being driven — and the panel
  at the bottom left is the game's own HUD: health, money, weapon and ammunition, heat and the
  current objective. Every field is written only when its text changes, because a DOM write lays the
  whole overlay out again and doing that sixty times a second for numbers that stand still is a
  frame the city could have spent on itself. `SimState.money`, `SimState.objective` and
  `SimState.waypoint` are the three slots it reads that nothing writes yet; the economy of spec
  section 16, the missions of 18 and the map are what will.
- `src/ui/map.ts` is the map model of spec section 12, and it is pure, so the projection, the zoom
  steps, the icon table and the culling are tested headless. The map keeps the world's own axes:
  world `(x, y)` is drawn at pixel `(x, y)`, so north is up and the map reads the way
  `scripts/world-preview.ts` draws the same world. `rotationForHeading` is what turns a rotating map
  so the player faces up. `POI_STYLES` is the one icon table: every type has a shape no other type
  uses and a colour no other type uses, and `test/map.test.ts` pins both. `MapPois.extra` is the
  slot a system that owns places writes — the shops of spec section 16.1, the safehouses of 16.3,
  the factions of 17, the missions of 18 — and nothing reads a second list.
- `src/ui/map-draw.ts` is the one place that says what a map looks like. `Minimap` (`minimap.ts`)
  and `MapScreen` (`map-screen.ts`) both draw through one `MapArt`, so the corner map and the full
  map cannot disagree about a road or a mark. The land and the sea are a bitmap one pixel to a
  terrain cell, drawn scaled; the roads are strokes off `RoadSegmentIndex`, so the map is sharp at
  half a metre to the pixel and at sixteen. Both widgets redraw only when something on them has
  moved, so a session standing still pays for neither.
- Look at the map before judging a change to it: `node scripts/map-preview.ts <seed> out.png`, and
  `--minimap` for the round window at the minimap's own scale. It needs a Chromium but no WebGPU
  device, because the map is a 2D canvas.
- `src/ui/title.ts` is the title screen as a main menu of pages: the main page, New game
  (`title-setup.ts`), Settings, and Controls under Settings (`title-controls.ts`). `PARENT` says
  where Escape and Back go from each page. A menu item with no action is drawn disabled; Load game,
  Graphics and Sound wait for what they open. The arrow keys walk the elements with `data-nav`, in
  DOM order, and skip a disabled one. The pointer moves the same focus, so only one item is lit. A
  character row takes the focus itself and changes on left and right; its two buttons carry no
  `data-nav`. The look lives in `title.css`, which `style.css` imports.
- `src/ui/menu-pages.ts` is the page walk both menus share: `parent`, the arrow keys, the pointer
  focus, and Escape going up a page. `src/ui/pause.ts` is the pause menu of spec section 12, drawn
  with the title's classes and the few rules of `pause.css`. It listens to no key: Escape both opens
  and closes it, so `main.ts` hands it every key while it is open. While it is open the frame loop
  takes no steps and the clock keeps its place between two ticks.
- A save (`src/sim/save.ts`) is the record and the seed text, nothing else, so a field added to
  `SimState` is saved with no change there. It is read against a fresh record: a missing field or a
  wrong type is refused, and an unknown field is dropped. Raise `SAVE_VERSION` when a field changes
  meaning. `src/ui/saves.ts` keeps one save per seed in `localStorage`.
- A load writes the save into the live record in place, because every closure in `main.ts` holds
  that record, and then builds a new `SimPhysics` from it. Never `adopt` a loaded record into the
  old physics: the traffic bodies keep their cursors and their promoted bodies from before the load.
- A save of another seed needs another world, so an import of one, and Regenerate, load the page
  again. The note in `sessionStorage` from `setPendingStart` tells the next boot to skip the title
  and start that seed, from its save or afresh.
- `src/render/scene.ts` is the scene behind the menu: a parked car, a lit street lamp and the
  driver, with no world. The camera swings over the front of the car and never goes all the way
  round, because the lamp post stands on the far side. The lamp is the game's own `LampLight`, so
  the scene draws only through a renderer from `createRenderer`, which registers that light.
- `src/ui/seed-preview.ts` draws the map of the seed on the title screen, through the same `MapArt`,
  so the picture the player picks a seed from is the map they will play on. A build blocks the frame
  loop for a second or two, so it happens when the player asks for it — the dice button, the Show
  the map button, or Enter in the seed box — and never on a key press in the box.
  `MapDrawOptions.player` is null there: the preview is the map alone, with no arrow on it. The
  world it built travels back in `TitleChoice.world`, and `main.ts` reuses it rather than
  generating the same seed twice.
- `src/ui/controls.ts` is the one list of key bindings. It is shown on the title screen and copied
  into the README; `Keyboard.sample` must stay in step with the rows that are part of the input
  frame, and `main.ts` listens for the rows after them itself.
- `src/sim/physics.ts` is the only place Rapier is used, with `ground-bodies.ts` (the heightfield
  tiles and the decks), `drivetrain.ts` (what the input does to the wheels, the rider and the hull)
  and `gunfire.ts` (the casts, the swings and the flights) beside it. `await initPhysics()` loads
  its WebAssembly once, then `new SimPhysics(ground, state)` builds a world and `stepSim(state,
  input, physics)` steps it once per tick. The bodies are built from `state.vehicle` and never
  stored in it, so the state stays plain data: `adopt` makes the world agree with the record again
  after a load, and `spawn` puts the car down on the ground.
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
- `src/sim/theft.ts` is the hotwire minigame (spec section 11.4). `needsHotwire` reads the roster's
  own `alarm` and `luxury` flags, so nothing carries a second list of what is worth stealing, and
  `VehicleState.hotwired` says a lock is beaten once and not again. An attempt can only end in the
  vehicle opening: `HOTWIRE_CAP` ticks after it starts the last pin gives way, so no player is ever
  stranded at a door. `physics.ts` steps it from the tick it steps everything else from, which is
  what keeps the world running around it, and a player working at a lock is walked with an empty
  input rather than frozen, so the ground still holds them up. `transfer` owns the interact key
  while an attempt runs; nothing else may read that edge.
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
  through. The shooter's own body is left out of every cast, so nobody shoots their own door. Only
  the player's vehicle can be hit: a cast that meets a traffic body stops there as if it met the
  ground, until #256 lands.
- Gunfire damages a vehicle through `damageVehicle` in `damage.ts`, which is the dent, the integrity
  and the fire roll; `hitVehicle` is the same rule with the severity read off the speed a crash
  lost, and `disableEngine` is what the Barrett M82 does. A direction reaches those as the vehicle's
  own `(along, across, up)`, which is `unrotate`'s `x`, `z`, `y` in that order.
- `src/ui/weapon-picker.ts` is the debug picker for the arsenal, as `vehicle-picker.ts` is for the
  roster: `G` opens it, and a row hands over the weapon loaded with spare ammunition behind it.
  Shift and a row drops the weapon three metres ahead as a pickup instead, and the buttons under the
  rows fit and remove the attachments of the weapon in hand. The weapon shops and faction dealers of
  spec section 11.6 are what will replace it.
- `src/sim/respawn.ts` is death and arrest (spec section 11.7). A death is `player.health` at 0 and
  an arrest is `SimState.arrested`; `stepSim` turns either into a respawn at the end of the tick, so
  whatever wrote them — a crash, a blast, the debug keys `K` and `B`, the police later — replays the
  same. The player comes back on foot with fists only; the car stays where the run ended.
  `loadout.shots` survives, because it keys the stream of every shot. `SimState.safehouse` is where
  the session started until spec section 16.3 lands. The police stations come from
  `ParcelMap.stations`, built in the chunk workers, so `main.ts` reads them off
  `WorldScene.stations` after `settle` and hands them to the physics as `Ground.stations`. A world
  with none sends an arrest to the safehouse. `SimState.respawn` changing is what makes `main.ts`
  snap the camera.
- `SimState.heat` is the attention of spec section 14. Nothing spends it yet; a sounding alarm and
  every shot fired raise it, and melee raises none, because the spec calls it silent.
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
- `src/world/surface.ts` says what the ground is made of at a place — asphalt, dirt, sand or open
  ground — and where the nearest road a car can start on, or the nearest open water a boat can, is.
  It is a read of the parcel model's allocation, not a second one: a road claims the ground within
  `footprintHalfWidth` of its centreline and a beach claims its sand.
- `src/sim/damage.ts` is the damage, fire and explosion of spec section 11.3: what one impact does
  to a vehicle, the panels it dents and tears off, and the progression `intact` to `dented` to
  `smoking` to `burning` to `burnt`. A vehicle only ever moves forward through it. `physics.ts`
  measures the impacts as the speed the chassis lost over one step, because Rapier resolves a crash
  inside one step and nothing a driver does moves a vehicle by anything near `IMPACT_FLOOR` in a
  tick; the direction it was pushed says which panel took the blow. `spreadFire(vehicles, seed,
  tick)` is the rule for fire between vehicles: it reaches out every `SPREAD_PERIOD` ticks once a
  fire has burned for `SPREAD_DELAY`, and each vehicle in reach takes one roll however many fires
  reach it, so the answer does not depend on the order of the list. Nothing calls it until #256
  gives the promoted traffic its damage.
- `WheelState.skid` is the one definition of a sliding tyre: the body is going across its own axle
  faster than `SKID_SLIP`, whether that came from the handbrake, a corner or a spin.
  `src/render/skid.ts` is what draws it.
- The gradient needs no rule of its own. The chassis is a rigid body, so a climb has gravity to
  fight and a descent has it behind; adding a slope term on top of that would count it twice.
- `src/sim/traffic.ts` is the ambient traffic of spec sections 5.3 and 13.1. `AmbientTraffic`
  places the vehicles once for a world: per directed edge, the tier's `TierSpec.density` thinned by
  `ZONE_TRAFFIC` and the district's density, in a lane on the right of the carriageway that
  `laneOffset` divides as `road-section.ts` paints it. Each vehicle drives the closed tour
  `traffic-tour.ts` walks for it, at `CRUISE` of the speed limit of each edge. Vehicles meet at
  junctions and can overlap in a lane, because no vehicle reads another.
- A tour is steps, not legs: `traffic-timing.ts` lays each one down as a drive over part of a leg or
  a wait in one place, in a whole number of ticks. That is why `cursorAt` (evaluated) and `advance`
  (stepped) agree exactly rather than to a rounding, and why `test/traffic.test.ts` and
  `test/sim-traffic.test.ts` can compare them with `toEqual`. A pose is read `SMOOTH` metres behind
  and ahead of the vehicle and stands between the two readings, which is how a vehicle rounds a
  corner. `poseAt` takes a fractional tick, which is what the renderer draws between two ticks.
- `src/sim/signals.ts` is the traffic lights. A junction takes one where an arterial meets a street
  or another arterial on the ground, and never with a highway. Its roads split into the arterial's
  axis and the one across it, and a light is a function of the tick and the junction's seeded
  offset alone. `crossingOpen` is the phase the pedestrians of spec section 13.1 will wait for.
  `TrafficRoads.junctions` is what turns the lights on; a test that leaves it out gets none.
- A light and a tour only agree for ever when the tour takes whole `SIGNAL_CYCLE`s. So a tour that
  meets a light is timed from one stop line, its `sync`: tick 0 is that line's green. The drive back
  to it is stretched to arrive on red, and `phaseOf` moves the vehicle by up to half a cycle so its
  tick 0 falls on that green. A queue is estimated from the lane's density, not from the vehicles
  in it. `test/signal-lap.ts` steps a lap and holds a vehicle to the lights.
- On seed 1 about three vehicles in four meet a light, they spend about a third of the time
  standing, and timing the tours takes the traffic from about 35 ms to about 180 ms to place.
- `src/sim/traffic-bodies.ts` is the Rapier half. Inside the box of ground tiles, each vehicle is a
  kinematic body aimed at its pose on the next tick. A vehicle entering the box is evaluated on that
  tick and stepped after it. The player touches a vehicle when `footprintsTouch` finds their car or
  their capsule within `TOUCH_MARGIN` of it. The touched vehicle leaves its tour for good: its
  record goes into `SimState.traffic.promoted`, ascending by id, and it becomes a dynamic box with
  its speed. A touch is a 2D box test and not a Rapier contact: Rapier makes no contact between
  two kinematic bodies by default, and the player's capsule is one.
- `src/sim/parked.ts` says which bay holds a car at a tick. Each bay has its own stay length and
  offset; a stay rolls once, keyed on its first tick, against `FILL` at the middle of the stay. So
  a car stays put for the whole stay, and a street fills and empties by the hour with nothing
  stepped. A touched parked car is promoted like the traffic, under `PARKED_ID` plus its bay, and
  the bay stays empty while that record lasts. `PromotedVehicle.paint` is kept because a parked
  car's paint depends on the stay it was taken in.
- `parked-bodies.ts` stands a fixed body in each full bay of the physics box. It asks a bay again
  only when its stay ends, so a tick costs nothing for the bays that did not turn over. The bays
  come from the chunk workers, so `main.ts` sets `Ground.parked` after `settle`, and the physics
  reads it on every step rather than once when it is built.
- The ground of the game hands the physics the traffic as `Ground.traffic`. A test that is not about
  traffic leaves it out. `test/traffic-grid.ts` is a grid of every tier for the tests that need it.
- `src/sim/pedestrians.ts` is the crowd of spec sections 5.3 and 13.1. `AmbientPedestrians` places
  people per directed edge of a tier with a pavement, from `TierSpec.walkers` thinned by
  `ZONE_PEDESTRIANS`. A person walks one pavement round a loop, at a pace of their gait. The loop
  starts on the edge they were placed on: `walkOut` walks as the traffic does but only
  `WALK_REACH`, and a loop that closes some way off is walked out to and back from. Without that a
  person spawns up to a loop away from their district, and wears its clothes in the wrong zone.
- A loop takes a whole number of ticks and a whole number of strides, so `cursorAt` and `advance`
  agree exactly and the walk cycle comes round without a jump. `pedestrian-route.ts` cuts two
  pavement lines where they cross, which is how a turn one way keeps to the kerb and a turn the
  other way crosses both roads. A pose within `NODE_REACH` of a node checks `onCarriageway` too:
  a pavement that runs straight over a junction crosses the side road, and stands lower there.
- The candidates `near` answers are every loop through the box, and on seed 1 that is about 1300
  people round the core for 160 in view. `edgeAt` and `edgeMeets` skip the far ones before a pose
  is read. Reading the rest costs about 0.6 ms a frame on an M-series core.
- `startle` is the hook for spec section 20.1: it takes everyone in a radius off their loops into
  `SimState.pedestrians.startled`, and `startledPose` moves them off and stands them still. Nothing
  calls it yet. `releaseFar` gives them back to their loops where the player cannot see the jump.
