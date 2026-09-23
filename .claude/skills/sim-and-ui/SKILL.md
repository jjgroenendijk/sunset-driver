---
name: sim-and-ui
description: The gotchas of src/sim and src/ui in Sunset Driver — Rapier physics, vehicles, weapons, damage, on-foot movement, the HUD, the map, the title screen, the loading screen, saves, ambient traffic, parked cars, the tram and pedestrians. Use before editing anything under src/sim or src/ui, and when a vehicle behaves wrongly, a save will not load, the HUD reads wrong or traffic drifts out of step.
---

# Changing the simulation or the interface

`src/sim` is plain serialisable state. Simulation time is the integer `tick` at 60 Hz, and nothing
in it may read a wall clock or a frame delta. `spec.md` sections 11 to 14, 16 and 18 are the design.

The determinism rules apply: `rngFor` rather than `Math.random()`, and the sorted helpers in
`src/core/sort.ts` rather than iterating a `Set` or a `Map`.

## The gotchas

`docs/sim-and-ui.md` holds them, under eleven headings — the player and the HUD, the map,
physics, casualties and the ragdoll, on foot, hotwiring, weapons, the emergency services, the
ground, vehicles and damage. It opens with a contents list. Read the section the work touches, not
the file. `docs/police.md` holds death, arrest, the heat and the police. `docs/boarding.md` holds
getting into a vehicle and out of it.

`docs/city-life.md` holds the city that lives around the player, the six subjects of spec section
13: the ambient traffic, the traffic lights, the parked cars, the tram, the pedestrians and the
metro. Read it instead when the work is one of those. The tram has `docs/tram.md` of its own,
and the pedestrians `docs/crowd.md`.

`docs/menus.md` holds the screens around play: the title screen and its menu walk, the loading
screen after Start, the pause menu, the saves and the scene behind the menu. Read it instead when
the work is one of those.

`docs/shops.md` holds the shops the player walks into, and `docs/market.md` the contraband market
of spec section 16.2: what a good is worth in a district, where the dealers stand and what a deal
writes into the record. `docs/safehouses.md` holds the properties of spec section 16.3: what a door
costs, the stash and the garage behind it, and why a respawn reads it. `docs/missions.md` holds the
work of spec section 18: where a contact stands, how a job is drawn from the seed, the legs one is
judged by, and the authored chain written on top of all three.

The two that catch a session most often:

- Rapier reads a heightfield as `heights[j * (rows + 1) + i]` with `i` walking `z`. The other way
  round gives a world rotated a quarter turn, with no error.
- Rapier keeps a force or a torque until it is told to forget it, so `step` clears the last tick's.

## Look at the interface

A map or HUD change is judged from the picture:

```
node scripts/map-preview.ts <seed> out.png
node scripts/map-preview.ts <seed> mini.png --minimap
```
