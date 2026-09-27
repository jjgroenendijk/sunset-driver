# Loading a new game

What happens between Play on the title screen and the first frame of the street, what each step
costs, and what could make it shorter. `main.ts` is the order of the steps. `docs/streaming.md` has
the chunk workers, and `docs/rendering.md` the shader warm-up.

## Contents

- Measuring a load: `node scripts/load-profile.ts`
- The steps
- What the first runs found
- What was fixed
- What is left

## Measuring a load: `node scripts/load-profile.ts`

`main.ts` marks each step of the load on the page's timeline as `load <step>`. The script builds the
game as it is deployed, serves the build, opens it in Chrome, presses New game and Play, and prints
the time each step took. It also prints the loading screen's own lines, so the count of chunks and
of shader groups is in the report, and the files the page downloaded.

```
node scripts/load-profile.ts sunset                 # three loads from the title screen
node scripts/load-profile.ts sunset --from=link     # straight into the seed, as Regenerate does
node scripts/load-profile.ts sunset --cpuprofile    # where the main thread spent the wait
node scripts/load-profile.ts sunset --cpu-slowdown=4 --device=phone
```

Every run uses a fresh browser profile, so nothing is cached between runs. `--dev` serves through
the Vite dev server instead, which gives the functions of a CPU profile their real names. It needs
a real GPU, as `render-profile.ts` does. The DevTools Performance panel shows the same marks on a
recording of any load.

The numbers move by a second or more when the machine is busy with other work. Compare the steps,
not only the total, and run each build more than once.

## The steps

| Mark | What ends there | Thread |
| --- | --- | --- |
| `physics` | Rapier's WebAssembly is loaded. It loads beside the graphics. | main |
| `renderer` | The WebGPU device and the canvas are ready. | main |
| `start` | Play was pressed. | — |
| `plan` | The world description is built. The title screen starts it, so it is usually done. | worker |
| `city` | `buildCity` has laid out the traffic, the crowd, the tram and the rest. | main |
| `physics world` | The Rapier world is built from the ground. | main |
| `ground` | The chunks under the player are in the scene (`WorldScene.settle`). | workers |
| `places` | The shops, the dealers, the safehouses and the parked cars are placed. | main |
| `post` | The post chain is built and SMAA has its tables. | main |
| `menus` | The pickers, the maps and the pause menu are built. | main |
| `shaders` | Every program the session draws with is compiled (`warm.ts`). | main |
| `revealed` | The loading screen has faded off the first frame. | main |

## What the first runs found

Seed `sunset`, the deployed build, 1600×900, headless Chrome on an Apple M1, on 27 September 2026.
Before the fixes below, the time from Play to a playable city was **14 to 15 s**:

| Step | Took | Share |
| --- | --- | --- |
| `city` | 2.3–2.8 s | 17 % |
| `ground` | 1.9–2.1 s, 1.0–1.1 s with the chunk workers started at boot | 13 % |
| `places`, `post`, `menus` | 0.3 s | 2 % |
| `shaders`: one frame per material group, 118 groups | 6.1–6.9 s | 44 % |
| `shaders`: one frame per post graph, 3 graphs | 3.3–4.3 s | 25 % |
| `revealed`: two frames and the 0.6 s fade | 1.0 s | — |

- The plan costs nothing after Play when the title screen has built it. Opened straight into the
  seed (`--from=link`), it adds 1.0 s.
- The page downloads 2.25 MB over the wire. The main script is 1.9 MB of it: three.js is 4.3 MB of
  its source, Rapier 2.8 MB, most of that its WebAssembly as base64, and Tone.js with
  `standardized-audio-context` 0.9 MB. Rapier is ready 0.5 s after the page opens, beside the
  renderer, so it delays nothing on this machine.
- As a stand-in for a phone, `--cpu-slowdown=4` slows the page and not the workers. From Play it
  took 54 s: 9.9 s for `city` and 41.6 s for `shaders`, of which 17.6 s was the post graphs. The
  shader warm-up is what a phone waits for.
- A CPU profile of the wait from Play: 63 % of the main thread's busy time was three.js, and most of
  that was its node builder turning TSL into WGSL. 12 % was `src/sim`, and 1.5 s of that was the
  crowd finding its crossings (`signalCrossings`, `pedestrian-crossing.ts`). The collector took 6 %.

### The chunk workers started late

A module worker starts through the page's main thread: its script runs only between tasks there.
The pool used to be made just before `buildCity`, which holds the thread for 2.3 s, so each worker
received its world 2.6 s late, and a chunk could be handed to it only after it answered, which it
could not do until `buildCity` ended.

### The shader warm-up

`warm.ts` draws one frame for each material group, then one frame through each post graph. The time
is the node builder of three.js on the main thread. The GPU's own compile is a small part of it.

- `drawGroup` showed each group's hidden objects, but did not hide the rest of the scene. The first
  frame built every program the scene around the player draws with: 4.5 s of 6.2 s, with the bar
  standing still (issue #784).
- three.js keys a render context on the render target, the MRT and the renderer's call depth, and a
  program on its render context. SMAA reads the frame through a texture of its own, so with SMAA
  the scene pass is drawn three `render` calls deep. Without SMAA it was drawn one call deep, and
  every scene material was a program of its own there: the lowest tier's graph cost 3.3–4.3 s, and
  the session held each program twice (issue #783).

## What was fixed

| Fix | Where | Effect on an M1 |
| --- | --- | --- |
| The chunk workers start at boot | `startChunkWorkers`, `chunk-pool.ts` | `ground` 2 s → 1 s |
| A worker is handed up to five chunks before its layers are built, and `main.ts` asks for the start's chunks before `buildCity` | `EARLY_CHUNKS`, `chunk-pool.ts` | `ground` 1 s → 0.3 s |
| A graph without SMAA reads the frame through two copies, so the scene pass is drawn as deep as under SMAA | `atSmaaDepth`, `post.ts` | post graphs 3.5 s → 0.05 s |
| Each group's frame takes the rest of the scene off its layers; the water sheet stays, so the mirror runs | `drawGroup`, `warm.ts` | the bar moves evenly; no time saved |
| The title scene is not drawn behind the opaque loading screen | `covered`, `main.ts` | small, not measured |

From Play to a playable city now takes **9.3–9.6 s**, against 14–15 s before. Two copies cost a
graph without SMAA two full-screen passes, where SMAA costs three. With the workers now building
beside it, `buildCity` took 3.0–3.2 s rather than 2.3–2.8 s. A drive through
`render-profile.ts --long --tier-at=120:lowest,240:full` still built no program.

## What is left

| Option | Saving on an M1 | Issue |
| --- | --- | --- |
| Draw the city with fewer distinct programs: the warm-up is now 5.7 s of the wait | up to about 5 s | #786 |
| Find the crowd's signal crossings with fewer samples | about 1.2 s | #787 |
| Build the workers' layers while the player is on the title screen | 0.3 s here, more on a phone | #788 |
| Load Tone.js later and Rapier's WebAssembly as a file | page load only | #789 |
| Size the worker pool from the device's memory | streaming after Play | #790 |
