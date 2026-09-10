# Sunset Driver

A top-down open-world crime game for the browser. WebGPU, Rapier and Tone.js; no assets, no server. Everything is generated in code from a seed.

## Run

```
npm install
npm run dev
```

Requires a WebGPU-capable browser. The title screen takes the seed and the character; add `#seed=yourseed` to the URL to start it on a world.

## Controls

| Action | Keys |
|---|---|
| Move, drive | W A S D or arrows |
| Sprint | Shift |
| Handbrake, jump | Space |
| Horn | H |
| Interact, enter vehicle | E |
| Fire | F |

## Develop

`npm run verify` runs the typecheck, the determinism lint and the test sweeps. See `spec.md` for the design and `CLAUDE.md` for working conventions.
