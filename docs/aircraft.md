# Aircraft

The gotchas of the airfields of spec section 8.4 and the aircraft of section 11.3: where the fields
stand, how an aircraft flies, what the police do about it, and the hangar of section 16.3.

## Contents

- Where the airfields stand
- The road to the gate
- The ground an airfield claims
- The aircraft roster
- Flight
- Stands, theft and the picker
- The airside and the police
- The hangar
- Drawing an airfield
- What is not built

## Where the airfields stand

- `planAirfields` (`src/world/transit/airfields.ts`) runs before the roads and returns every field.
  The airport comes first, then up to two airstrips, the two heliports and the seaplane dock.
- A field is a rectangle in its own frame: `u` along the runway, `v` across it to the left.
  `airfield-frame.ts` holds the frame, and every question about a place on a field goes through it.
- `findSite` scores candidate sites with `judge`. The score is the fall across the rectangle, the
  bank round it, and twice the climb of the ramp out to the gate. Without the ramp term one seed
  put the airport's gate 41 m below the level, and no road could climb to it.
- A site whose gate stands more than `RAMP_GRADE` of the ramp's run off the level is refused
  outright. Seed 587507343 chose a gate 47 m below the level, and no road reached it.
- `findAirport` tries every runway length in the outskirts and the wilderness first. An airport in
  the suburbs bent the arterials round it to the shore, and one seed's suburbs lost their streets.
  Then it shortens the runway before it takes worse zones, and takes the core only last. An airport
  in the core broke the block sizes and, on one delta seed, dried up the river.
- The airport's first asks keep to the land the core stands on. An island airport hangs on the one
  link to its island, and on one seed that link failed.
- `coreClear` keeps the rectangle and its margin off the core's disc. The next-to-last asks keep
  only `CORE_CLEAR` from the middle of the core. An airport beside the middle once tilted it to a
  slope of 0.31, and the terrain sweep holds that slope under 0.15.
- The heliports keep out of the inner ring. A pad there, and the road to it, cut the small blocks
  round it apart.
  `airportAt` must be given the runway the site was judged for, not the one first asked for.
- `LandMasses` is built at the road's `DRY_MARGIN`, not at `SITE_DRY`. On a low delta the mainland
  is one piece only at the lower height, and no site was found at all.
- The rectangle is levelled to one height, blended back into the hillside over `LEVEL_BLEND`.
- The dock levels nothing. Its rectangle is water, and the roads and parcels keep off water anyway.

## The road to the gate

- The gate stands `GATE_OUT` past the rectangle: past the blend, on the ground as it was.
- `serveField` (`src/world/roads/roads.ts`) tries the gates from `gateChoices`, gentlest first. It
  keeps a laid road only if the network then has a curve within `GATE_REACH` of the gate. The
  network can keep only part of a route, and one seed's road began 185 m from its gate.
- `roadAtGate` measures to the segments, not to the points. A straight arterial has its points far
  apart, and a street laid to a gate it ran past ended on its carriageway.
- Only the airport is served before the minor fill, with an arterial, and after the boardwalks. An
  airport road laid first joined an arterial where a boardwalk's way on had to cross it, and the
  network cut the boardwalk back to nothing.
- The airstrips and the heliports are served after the fill: a dirt road for a strip, a street for
  a heliport. An arterial laid to an inner-city heliport before the fill cut the blocks round it
  apart.
- Any change here moves the district sites and the whole road network of most seeds, so run
  `npm run test:full`, not only the airfield sweep. The first run of this work found fifteen seeds
  broken in the road, terrain and traffic sweeps.

## The ground an airfield claims

- The router keeps off the rectangle and `AIRFIELD_KEEP` round it. It asks `AirfieldMask`, a
  64 m grid over the map, because it asks millions of times and `airfieldAt` walks every field.
- `parcels.ts` subtracts every rectangle and its ramp, so no building stands on a field.
- `SurfaceIndex` reads the paved parts and the ramp as asphalt and an airstrip's runway as dirt.
  A road still wins where one crosses a field's ground.

## The aircraft roster

- `src/sim/vehicles/aircraft-roster.ts` holds the nine aircraft. `ROSTER` spreads them in, so every
  lookup by class finds them. `isAircraft` and `isMilitary` tell them apart.
- A helicopter has no wheels (`SKIDS`). `rideHeight` returns its `halfHeight`, so it rests on its
  skids. A plane has a tricycle gear. The seaplane has a hull and floats as a boat does.
- `FlightSpec` is the whole flight model's input: `topSpeed`, `thrust` in m/s², `stall`, `climb`,
  `turn` and `bank`.
- Any test that assumes a vehicle has wheels must use the ground classes. The mesh overhang, the
  damage bounds and the hotwire share all broke that way.

## Flight

- `Flight` (`src/sim/vehicles/flight.ts`) is arcade: it sets targets and closes on them. It does not
  model lift. Physics calls it for every vehicle with a `flight`, after the wheels or the hull.
- A rotor lifts only once the climb key asks. A wing's lift fades in over the last 30% below its
  stall speed, so a plane that slows sinks rather than drops.
- Climb is `jump` (Space) and descend is `sprint` (Shift). `CEILING` is 260 m.
- The attitude is held with PD torques and the yaw closes on a target rate. Rapier keeps a torque
  until it is told to forget it, so every step resets the forces first.
- A plane is airborne when no wheel touches. A helicopter or the seaplane is airborne above 1.2 m.
- The camera adds `DISTANCE_PER_ALTITUDE` of zoom for each metre of height over the ground
  (`src/render/camera/camera.ts`).

## Stands, theft and the picker

- Each airfield lists its `stands`. `buildParkingBays` appends them as bays of use `'aircraft'`,
  with the class in `craft`. An aircraft bay is always full and always holds the same class.
- Every aircraft is alarmed, so it needs the hotwire. `theftOf` makes the theft of a military one
  the crime `militaryTheft`.
- The debug picker (V) puts a plane at the nearest runway end (`runwayStart`) and a seaplane on the
  nearest water. A helicopter stays where the player is.
- The pilot boards through a door at 45% of the length for a rotor and 55% for a wing, and sits
  just inside it. A seat amidships made the climb in faster than a sprint.

## The airside and the police

- `stepAirside` (`src/sim/police/airside.ts`) runs every `AIRSIDE_EVERY` ticks and stores nothing.
  It reports a player on the runway, a taxiway, the apron or a pad, up to `AIRSIDE_STARS`, and one
  in the compound, up to `COMPOUND_STARS`. A player more than 4 m over the level is flying over it.
- A pilot in a civil aircraft is exempt on the airside, because the hangar brings its aircraft out
  onto the apron. The compound is never exempt.
- `helicopterFire` (`src/sim/police/officer-fire.ts`) fires the door gun at four stars and above, in
  bursts. At two stars the helicopter already comes up for a player who is flying.

## The hangar

- `hangarPlaces` (`src/sim/places/hangar.ts`) makes the airport's first hangar a `SafehousePlace`.
  Its door stands behind the hangar, on the landside, so walking to it is no trespass.
- `hangar` on the place is the yard in front of the doors. `carPlace` brings a garage vehicle out
  there instead of at the door, and the yard is on the taxiway.
- A new hangar's garage holds `HANGAR_AIRCRAFT`, a light helicopter.

## Drawing an airfield

- `airfieldMesh` (`src/render/roads/airfield-mesh.ts`) builds every field once, as one merged mesh.
  The scene adds it at the start. A map has a handful of fields, so they are not cut into chunks.
- Each surface kind lies at its own height over the level (`LIFT`), so overlapping parts never
  fight over one depth. The ramp is a strip laid on the carved ground's heights.
- A rotor or a propeller is a `VehicleBox` with `spin`. `VehicleModel.spin(dt)` turns them.
- The map paints the paved parts and marks each field with the `airfield` or `helipad` icon.

## What is not built

- Rooftop helipads: roofs have no colliders, so a helicopter cannot land on one. The heliports
  stand in for them.
- Buildings are not solid to an aircraft in the air.
- The dock has no collider either: a player wades out to the seaplane.
