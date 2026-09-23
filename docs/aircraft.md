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

- `planAirfields` (`src/world/airfields.ts`) runs before the roads and returns every field. The
  airport comes first, then up to two airstrips, the two heliports and the seaplane dock.
- A field is a rectangle in its own frame: `u` along the runway, `v` across it to the left.
  `airfield-frame.ts` holds the frame, and every question about a place on a field goes through it.
- `findSite` scores candidate sites with `judge`. The score is the fall across the rectangle, the
  bank round it, and twice the climb of the ramp out to the gate. Without the ramp term one seed
  put the airport's gate 41 m below the level, and no road could climb to it.
- The rectangle is levelled to one height, blended back into the hillside over `LEVEL_BLEND`.
- The dock levels nothing. Its rectangle is water, and the roads and parcels keep off water anyway.

## The road to the gate

- The gate stands `GATE_OUT` past the rectangle: past the blend, on the ground as it was.
- `serveField` (`src/world/roads.ts`) tries the gates from `gateChoices`, gentlest first. It keeps a
  laid road only if the network then has a curve within `GATE_REACH` of the gate. The network can
  keep only part of a route, and one seed's road began 185 m from its gate.
- A second pass after the minor fill serves any field still without a road. The fill lays streets
  the first pass could not reach.
- One seed (2355512367) still has its gate far below the level. The gentler gates did not route.

## The ground an airfield claims

- The router keeps off the rectangle and `AIRFIELD_KEEP` round it. It asks `AirfieldMask`, a
  64 m grid over the map, because it asks millions of times and `airfieldAt` walks every field.
- `parcels.ts` subtracts every rectangle and its ramp, so no building stands on a field.
- `SurfaceIndex` reads the paved parts and the ramp as asphalt and an airstrip's runway as dirt.
  A road still wins where one crosses a field's ground.

## The aircraft roster

- `src/sim/aircraft-roster.ts` holds the nine aircraft. `ROSTER` spreads them in, so every lookup
  by class finds them. `isAircraft` and `isMilitary` tell them apart.
- A helicopter has no wheels (`SKIDS`). `rideHeight` returns its `halfHeight`, so it rests on its
  skids. A plane has a tricycle gear. The seaplane has a hull and floats as a boat does.
- `FlightSpec` is the whole flight model's input: `topSpeed`, `thrust` in m/s², `stall`, `climb`,
  `turn` and `bank`.
- Any test that assumes a vehicle has wheels must use the ground classes. The mesh overhang, the
  damage bounds and the hotwire share all broke that way.

## Flight

- `Flight` (`src/sim/flight.ts`) is arcade: it sets targets and closes on them. It does not model
  lift. Physics calls it for every vehicle with a `flight`, after the wheels or the hull.
- A rotor lifts only once the climb key asks. A wing's lift fades in over the last 30% below its
  stall speed, so a plane that slows sinks rather than drops.
- Climb is `jump` (Space) and descend is `sprint` (Shift). `CEILING` is 260 m.
- The attitude is held with PD torques and the yaw closes on a target rate. Rapier keeps a torque
  until it is told to forget it, so every step resets the forces first.
- A plane is airborne when no wheel touches. A helicopter or the seaplane is airborne above 1.2 m.
- The camera adds `DISTANCE_PER_ALTITUDE` of zoom for each metre of height over the ground
  (`src/render/camera.ts`).

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

- `stepAirside` (`src/sim/airside.ts`) runs every `AIRSIDE_EVERY` ticks and stores nothing. It
  reports a player on the runway, a taxiway, the apron or a pad, up to `AIRSIDE_STARS`, and one in
  the compound, up to `COMPOUND_STARS`. A player more than 4 m over the level is flying over it.
- A pilot in a civil aircraft is exempt on the airside, because the hangar brings its aircraft out
  onto the apron. The compound is never exempt.
- `helicopterFire` (`src/sim/officer-fire.ts`) fires the door gun at four stars and above, in
  bursts. At two stars the helicopter already comes up for a player who is flying.

## The hangar

- `hangarPlaces` (`src/sim/hangar.ts`) makes the airport's first hangar a `SafehousePlace`. Its
  door stands behind the hangar, on the landside, so walking to it is no trespass.
- `hangar` on the place is the yard in front of the doors. `carPlace` brings a garage vehicle out
  there instead of at the door, and the yard is on the taxiway.
- A new hangar's garage holds `HANGAR_AIRCRAFT`, a light helicopter.

## Drawing an airfield

- `airfieldMesh` (`src/render/airfield-mesh.ts`) builds every field once, as one merged mesh. The
  scene adds it at the start. A map has a handful of fields, so they are not cut into chunks.
- Each surface kind lies at its own height over the level (`LIFT`), so overlapping parts never
  fight over one depth. The ramp is a strip laid on the carved ground's heights.
- A rotor or a propeller is a `VehicleBox` with `spin`. `VehicleModel.spin(dt)` turns them.
- The map paints the paved parts and marks each field with the `airfield` or `helipad` icon.

## What is not built

- Rooftop helipads: roofs have no colliders, so a helicopter cannot land on one. The heliports
  stand in for them.
- Buildings are not solid to an aircraft in the air.
- The dock has no collider either: a player wades out to the seaplane.
