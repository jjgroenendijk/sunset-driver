# Vehicle bodies

How the road vehicles are shaped, how their doors and bonnet open, and how their glass is drawn.
`spec.md` section 11.3 is the design, and the Vehicles section of `docs/art-style.md` the look.
Issue #713 chose the style, the "clean low-poly" of the mock-up at
https://claude.ai/artifact/GG1rY85JAWdEPzsmQWcheo.

## Contents

- The hull
- The parts
- The leaves
- The glass and the inside
- Instanced vehicles
- Tests and previews

## The hull

- `vehicle-hull.ts` lofts the compact, saloon, sports, patrol, off-roader, van, truck cab and bus.
- `loft.ts` builds every other body. `loft` runs an octagon through sections along the vehicle,
  `wing` a six-sided chord across it, `fin` a section up it, `vHull` a V bottom, and `disc` a
  wheel. `arc` bends a strip round a wheel. The motorcycle is in `vehicle-mesh.ts`, the buggy and
  the boat in `open-craft.ts`, and the aircraft in `aircraft-mesh.ts`.
- `solid` joins the rings and turns every face outwards by the sign of the volume they close. So a
  loft may run along any axis, and a ring may wind either way. A ring may shrink to a point.
- A hull is a row of stations, nose to tail. A station gives its floor, shoulder and roof as
  shares of the body's height, and the body and roof widths as shares of `BODY_WIDTH` × the row's
  half width. The flag names the span to the next station: `W` windscreen or rear glass, `S` side
  windows, `P` a pillar.
- Every ring has 14 points. A station with no glass folds its glass and rail points into the roof
  edge, so the rings still join point for point. The folds make zero-area triangles, and
  `vehicle-geometry.ts` drops them.
- The rings run nose to tail and wind the same way, so every face is already outward. Do not flip
  faces by comparing with a centre. The mock-up did, and the low bonnet faces came out inside out.
- A station must stand at each end of each door, bonnet and boot span. A span takes the intervals
  whose middles lie inside it.
- Door length drives the boarding move. `test/boarding.test.ts` fails when a door longer than
  about 1.15 m makes the body step faster than 0.1 m a tick. Move the door, not the test.

## The parts

- The hull is cut into single-colour parts, each with `on` set: the panel it was cut for, or
  `'shell'`. `vehicleBoxes` trusts `on` before `panelAt`. A bonnet stands as high as a roof, so its
  position alone would call it the roof.
- A part's `faces` are polygons about its middle. `partGeometry` fans them and adds zero texture
  coordinates, so a lofted part merges with boxes in one geometry.
- Under every panel that can be torn off, the shell keeps an inset copy: the dark engine bay under
  the bonnet and the boot, and the trim inside each door. A lost panel shows the inside, not a
  hole.
- The lamps are boxes at the nose and tail stations, placed by `panelAt` as before.

## The leaves

- Leaves are the four doors and the bonnet: 0 the driver's front door (`-z`), 1 the other front
  door, 2 and 3 the rear doors, 4 the bonnet (`BONNET_LEAF`, `sim/leaves.ts`). A class simply has
  no parts for a leaf it lacks.
- Every part of a leaf carries the same `hinge`. `VehicleModel` hangs each part from a group at
  that point, named `door`, and `swing` turns them. A door turns about up, the bonnet about the
  axle axis, and a van's load door slides back along the flank.
- `VehicleState.leaves` holds `open` (0 to 1) and `want`. `sim/doors.ts` steps them each tick
  toward their target:
  - the bonnet key (O), from the seat or beside the car;
  - a workshop visit, which holds the bonnet up;
  - `damage.ajar`, set when a panel's dent reaches `AJAR_DENT`, which leaves the front door of that
    flank or the bonnet hanging at `AJAR`. A repair resets the damage, and with it the ajar flags.
- The boarding move's door is not in the record. `openDoor` takes the larger of the two angles.

## The glass and the inside

- Glass parts carry `glass: true`. The model draws them at `GLASS_OPACITY` and casts no shadow from
  them. The colour `GLASS` alone does not make a part transparent, because trams, bus shelters and
  aircraft use it too.
- The glass still writes depth, so the edge pass keeps the outline of the cabin.
- The hull faces out, and the renderer culls back faces. So each cabin has a `tub`, just inside the
  hull: a floor facing up, walls to the shoulder facing in, and above the glass the pillars, rails
  and ceiling facing in. Without it the glass shows the world through the car. Without the floor it
  was the bus with no bottom; without the ceiling, a bus seen from the street was an empty cage.
- The lining above the shoulder is on the roof panel, so it goes when the roof does. A cabin that
  runs to the tail, as the bus's does, also gets a wall inside the tail.
- The seats and dashboard are shell parts. The bus gets rows of seats instead.
- A driver sits in the seat while driving (`WorldScene.walkPlayer`), at the end pose of the move in.

## Instanced vehicles

- Traffic, parked cars and police draw glass as a third instanced mesh with its own transparent
  material (`glassMaterial`). That is one more draw per class.
- Traffic on its tour carries a driver (`occupant.ts`) in the same mesh as a bike's rider.
- Instanced doors cannot swing one car at a time. The patrol car's front doors are drawn apart
  (`police-doors.ts`), as the emergency units do: `trafficParts(spec, PATROL_LEAVES)` leaves them
  out of the body, and each door's instance matrix is the car's times a turn about the hinge.
  `PoliceUnit.doors` opens for `DOOR_HOLD` ticks after the crew gets out or back in.

## Tests and previews

- `test/vehicle-mesh.test.ts` checks which leaves each class hangs, that each body has faces and
  transparent glass, and that the record's leaves turn the hinges.
- `test/doors.test.ts` checks the stepping, the key, the workshop and the ajar flags.
- `node scripts/render-preview.ts 7 out.png --vehicle=saloon --on-foot --heading=150 --distance=9
  --open=all` draws the doors and the bonnet open. `--open=doors` and `--open=bonnet` open one set.
