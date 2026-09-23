# Sunset Driver

A top-down open-world crime game for the browser. WebGPU, Rapier and Tone.js; no assets, no server.
Everything is generated in code from a seed.

## Run

```
npm install
npm run dev
```

Every car has a radio: nine stations, one for each neighbourhood culture of the city and one over
the lot, all played rather than recorded. Between songs the stations read harm-reduction
announcements, and a chase lays its own music over what is playing.

Requires a WebGPU-capable browser. New game on the title screen takes the seed and the character;
add `#seed=yourseed` to the URL to start it on a world.

The game watches its own frame rate and steps the quality down when it cannot hold 60 fps, and back
up when it can. The tier in force is shown in the corner, and every change is written to the
console. Add `?budget=6` to the URL to hold it to a frame no machine makes at full quality, which is
how the steps are watched on a machine that does not need them.

## Controls

<!-- controls: generated from src/ui/controls.ts by scripts/readme-controls.ts -->

| Action | Keys |
|---|---|
| Move, drive | W A S D or arrows |
| Sprint | Shift |
| Handbrake, jump | Space |
| Horn | H |
| Enter, use, hotwire | E |
| Fire, swing | Left click |
| Aim | Right click |
| Reload | R |
| Cycle weapon | Mouse wheel |
| Give up (1–2 stars) | X |
| Radio | ] and [ |
| Pick a row | 1 to 9 |
| Shop, dealer: choose, buy | ↑ ↓ Enter or click |
| Dealer: sell all | Shift and Enter, or Shift and 1 to 9 |
| Pause | Esc |
| Map | M |
| Map zoom, centre, legend | + − Space L |
| Camera view | C |
| Look around (chase views) | Mouse |
| Vehicles | V |
| Weapons | G |
| Debug info | F3 |
| Debug die | K |
| Debug arrest | B |

<!-- end controls -->

The title screen shows the same list, drawn as key caps. To change a binding, change
`src/ui/controls.ts` and run `node scripts/readme-controls.ts`.

## On a phone

A phone reaches none of those keys, so it is offered the city instead of the game. The title screen
opens on **Explore**, which starts the seed in the box straight into the free camera, two
hundred metres over the streets. The left thumb flies it, a drag anywhere turns the view, a pinch
sets the speed, and the keys down the right edge rise, fall and go six times as fast. Menu, Map and
Land sit in the top corner.

It needs WebGPU, which on an iPhone means iOS 26 or later; an older one is told so and stops.

## Develop

`npm run verify` runs the typecheck, the determinism lint and the test sweeps. See `spec.md` for the
design and `CLAUDE.md` for working conventions.
