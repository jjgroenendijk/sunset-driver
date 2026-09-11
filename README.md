# Sunset Driver

A top-down open-world crime game for the browser. WebGPU, Rapier and Tone.js; no assets, no server. Everything is generated in code from a seed.

## Run

```
npm install
npm run dev
```

Requires a WebGPU-capable browser. The title screen takes the seed and the character; add `#seed=yourseed` to the URL to start it on a world.

The game watches its own frame rate and steps the quality down when it cannot hold 60 fps, and back up when it can. The tier in force is shown in the corner, and every change is written to the console. Add `?budget=6` to the URL to hold it to a frame no machine makes at full quality, which is how the steps are watched on a machine that does not need them.

## Controls

| Action | Keys |
|---|---|
| Move, drive | W A S D or arrows |
| Sprint | Shift |
| Handbrake, jump | Space |
| Horn | H |
| Interact, enter vehicle | E |
| Fire | F |
| Vehicle picker | V |

## Develop

`npm run verify` runs the typecheck, the determinism lint and the test sweeps. See `spec.md` for the design and `CLAUDE.md` for working conventions.
