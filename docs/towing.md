# Towing

The gotchas of the tow trucks of spec section 20.2: the wrecks the city takes away and what it
drops unseen. The code is `src/sim/traffic/tow.ts` and
`src/sim/city/tow-truck.ts`. The truck is dispatched and driven by
`src/sim/city/emergency.ts`, which `docs/sim-and-ui.md` covers. The parked cars and the traffic
are in `docs/city-life.md`.

## Contents

- The wrecks the city tows

## The wrecks the city tows

- `src/sim/traffic/tow.ts` takes a vehicle back out of the record, and `rejoin.ts` puts a bumped
  car near the player back on its tour (`docs/giving-way.md`). Everything else the player touches
  stays in `TrafficState.promoted`, so a session spent crashing into traffic leaves shells behind.
- A shell that has stood `TOW_WAIT` ticks since it went up calls a tow truck (`callTow`). The truck
  is a third kind of emergency unit, `'tow'`, so it is dispatched, routed and retired by
  `emergency.ts` like an engine (`docs/sim-and-ui.md`). `TOWS_OUT` trucks go out on top of
  `UNITS_OUT`, so a wreck never keeps an engine from a fire. A truck has no crew and no siren; its
  amber bar flashes only while it works.
- `city/tow-truck.ts` is the truck's work. On arrival `hookUp` takes the record out of `promoted`
  and puts it on the unit as its `load`, with the pose it stood in. `loadPose` winches it onto the
  deck over `WINCH_TICKS`, as a function of the tick. `render/vehicles/traffic.ts` draws the load
  with the traffic, since it is one of the city's cars. A vehicle that has gone before the truck
  arrives leaves nothing to hook, and the truck drives off empty.
- Out of sight nobody needs to watch. A shell that is due and lies `TOW_REACH` or more from the
  player is dropped, with no truck. A car of the city that was only bumped, and is not on fire, is
  dropped as soon as the player is that far. `TOW_REACH` is wider than `TRAFFIC_VIEW` and than the
  physics box, so nothing vanishes on screen and a dropped record never leaves a Rapier body.
- The player's own car, left where they took another, carries `left` and is never dropped. It is
  still there on their return, as spec section 20.2 asks.
- A burnt-out parked car is promoted under `PARKED_ID` plus its bay, and the bay stays empty while
  that record lasts, so towing it also gives the kerb back to `parked.ts`.
