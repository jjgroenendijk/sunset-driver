# Loading a new game

What happens between Play on the title screen and the first frame of the street, what each step
costs, and what could make it shorter. `main.ts` is the order of the steps. `docs/streaming.md` has
the chunk workers, and `docs/rendering.md` the shader warm-up.

## Contents

- Measuring a load: `node scripts/load-profile.ts`
- The steps
- What the first runs found
- Where the shader time goes
- Options, largest saving first

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
The time from Play to a playable city was **14 to 15 s**:

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
received its world 2.6 s after it was sent. Its layers then took 1.0 s, and only then did the
chunks start. `startChunkWorkers` (`chunk-pool.ts`) now starts them at boot, and the pool takes
them. The workers now build their layers while `buildCity` runs, and `ground` fell from about 2 s
to about 1 s.

## Where the shader time goes

`warm.ts` draws one frame for each material group, then one frame through each post graph. The time
is the node builder of three.js on the main thread. The GPU's own compile is a small part of it.

- **The first group is most of it.** `drawGroup` shows the group's hidden objects, but it does not
  hide the rest of the scene. The first frame therefore builds every program the scene around the
  player draws with: 4.5 s of the 6.2 s. The loading bar stands still for that time.
  `docs/rendering.md` says the rest of the scene is hidden. The code does not do that (issue #784).
- **The third post graph builds every scene program a second time.** three.js keys a render
  context on the render target, the MRT and the renderer's call depth, and a program on its render
  context. SMAA reads the frame through a texture of its own, so with SMAA on, the scene pass is
  drawn three `render` calls deep. The graph of the lowest tier has no SMAA, and the scene pass is
  drawn one call deep. Every scene material is a new program there: 3.3–4.3 s on an M1, 17.6 s at a
  fourfold slowdown. The session then holds each of those programs twice. One extra texture copy
  (`convertToTexture`) takes the depth to two and changes nothing (issue #783).
- The first two graphs cost 30 ms together, because the material frames already went through them.

## Options, largest saving first

The savings are for the M1 above. A phone saves about four times as much in the main-thread steps.

1. **Build the lowest tier's graph at the same call depth (about 3.5 s, 25 %).** Either keep SMAA at
   the lowest tier, so its graph is the tier above's at a smaller render scale and there are two
   graphs, not three; or wrap its frame in two texture copies, so the scene pass is drawn three
   calls deep as with SMAA. The first costs the lowest tier SMAA at half scale, the second two
   full-screen copies. Spec section 9.2 does not require the lowest tier to drop SMAA.
2. **Fewer distinct programs (up to about 6 s, scales with the count).** The warm-up is 118 material
   groups, and each is a program per pass: the scene, the shadow cascades and the mirror. Materials
   that differ only in a colour or a number can share one program if the value comes from a uniform
   or an attribute. An audit of the groups by cost is the first step: `drawGroup` can time each one.
3. **Queue the first chunks before the workers are ready (about 1 s).** The pool hands a worker a
   chunk only after that worker says its layers are built. That message waits until `buildCity`
   ends. If the start chunks were posted with the world, a worker would build them straight after
   its layers, and the ground would be done when the city is. A deeper step: send the world to the
   workers as soon as the title screen has built it, so the layers are built before Play.
4. **Find the crowd's crossings for less (about 1.2 s).** `scanCorner` reads the walk every 0.5 m
   round every corner with lights, for every person. A coarse step with a bisection at each edge
   of a carriageway would read far fewer points. The crossings would move by less than a step, so
   the sweep's expectations may need to be updated.
5. **Hide the rest of the scene in `drawGroup` (no saving, a moving bar).** The same programs are
   built either way, but one material a frame spreads the 4.5 s of the first frame over the bar.
6. **Stop drawing the title scene behind the loading screen (small, not measured).** The frame loop
   draws the title preview at 30 fps until the session exists, behind an opaque screen.
7. **A smaller first download (about 1 s on a slow phone link, nothing after Play).** Load Tone.js
   when the first sound plays, and Rapier's WebAssembly as a file of its own so the browser can
   compile it while it streams in.
