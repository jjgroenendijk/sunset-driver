# Post and the colour grade

The gotchas of the post chain: `src/render/post.ts`, `edges.ts`, `grade.ts` and `lut-upload.ts`.
`spec.md` section 10.6 is the design. How a frame reaches the chain — the streaming and the
batches — is in `docs/streaming.md`, what a quality tier moves in `docs/rendering.md`, and what
lights it in `docs/lighting.md`.

## Contents

- The chain and its order
- The ink
- The graphs
- The grade
- The cube on the GPU

## The chain and its order

- `PostChain` (`post.ts`) is the post chain of spec section 10.6, and it draws the frame:
  `post.render()` replaces `renderer.render`. The order is the design. The scene is drawn in real
  light and multiplied by the exposure; bloom reads that, so `BLOOM_THRESHOLD` is a number about the
  frame the player sees. The bloom leaves the sky out, all but `SKY_BLOOM_SHARE` of it, and finds
  it by depth: the dome writes none. Read whole, a clear day sky glared white over every tower.
  Tone mapping brings it to 0..1, the grade follows, and SMAA comes last because it wants linear
  colour. The chain therefore tone maps and encodes the frame itself, and
  `outputColorTransform` is off so the pipeline does not do both again. `PostQuality` is the part of
  a quality tier this file owns: `setRenderScale` (`renderer.ts`) and a switch for each effect.
- TSL's chained `mix` takes the receiver as the factor: `a.mix(b, t)` compiles to `mix(b, t, a)`. It
  reads like a blend and is not one. Use the free `mix(a, b, t)` from `tsl.ts`. `smoothstep` chains
  the same way.

## The ink

- `inked` (`edges.ts`) draws every ink line of the art style (`docs/art-style.md`), on the exposed
  scene colour, before the bloom. There are no outline meshes: the inverted hulls round the
  buildings and the vehicles were removed when the pass came in.
- It reads the depth and nothing else. On any plane the inverse of view depth is linear across the
  screen, so its second difference over a pixel and its two neighbours is zero on a flat face,
  however steep. A large value is a silhouette, a small one a crease. The measure is divided by
  the pixel's own inverse depth, so one threshold serves near and far.
- Both pixels of a depth step see the step, so a silhouette is two pixels wide at any render scale.
  A crease is drawn at `CREASE_INK`, which reads thinner. Past `FADE` the ink thins to `FAR_INK`.
- What writes no depth draws no line. The sky writes none. The road markings are transparent and
  write none, so a lane line is not a step over the road (`createMarkingMaterial`). A seam on a
  flat surface has no depth step, so it must be painted into the material.
- The See-through cut (`cutaway.ts`) dithers holes into a building, and every hole is a depth step.
  So the pass asks `cutaway.ghostAlong` about each sample. A pair with a ghosted pixel in it
  measures nothing, and a ghosted pixel draws nothing. Reading a ghosted neighbour as the centre
  instead drew the edge of the cut as a line. Nothing under `GHOST_FLOOR` counts as ghosted: the
  cone takes in the street in front of the player, and its cars lost their ink.
- The cone is tested once per pixel, along the centre's ray, and each sample adds only its depth.
  A full cone test at every sample was 0.5 ms of a 0.6 ms pass at 1600x900 on an M-series GPU.
  The pass is in the `post RTT` line of `render-profile.ts --passes`: on seed 7 that line is 0.49 ms
  against 0.14 ms without the pass, and 0.69 against 0.21 at a pixel ratio of 2.
- The thresholds are tuned for the game camera. A lower camera sees planes at a grazing angle, where
  depth precision runs out and a flat road can start to draw creases. Look before moving them.

## The graphs

- The graphs are built once and kept, by the effects they draw: `postGraphs` names the distinct ones
  a list of tiers asks for, and the four tiers come to three. Setting `quality` hands the render
  scale to the renderer and swaps the output node, and builds only where no tier has asked for that
  set of effects yet. Hence `ready()` waits for the SMAA tables of every graph built, not only the
  one standing. Each graph owns full-size targets, so the graphs not drawn are shrunk to a pixel,
  which frees their textures. An effect sizes its targets to the frame before it draws, so a tier
  change still compiles nothing.
- A graph is keyed on the effects it draws, which are not quite the effects a tier asked for:
  `PostChain.effective` drops the grade where the cube never reached the GPU. Every place that
  keys, builds or compares a graph goes through it, or a tier change would swap in a graph that
  grades from a table that was never written.

## The grade

- `gradeAt(light)` (`grade.ts`) is the colour grade, as a table of colours the frame is looked up
  in. It is pure, so the tests run it headless, and it is rebuilt `GRADE_STEPS` times a game day
  rather than every frame. The grade works on display values and the frame is light, so
  `PostChain.lookUp` encodes a colour before the lookup and decodes it after: a lift big enough to
  warm a dusk shadow turns a whole night frame orange if it is added to light instead.
- `key` is a power on each channel before the contrast, 1 neutral. It moves the middle tones and
  leaves black and white where they are. `DAY_GRADE` sets it under 1, which puts more than half of
  a noon city frame into the upper half of the brightness: the high key of `docs/art-style.md`.
  Lifting the key costs colour, so the day saturation rises with it. The grade finishes the look;
  the colours must be right in the materials first.
- The table is a `Data3DTexture` read by `Lut3DNode`, so the sampler interpolates all three axes
  and the grade costs one texture fetch.

## The cube on the GPU

- three.js 0.186 reaches a 3D texture through 2D views in both places it touches one, and WebGPU
  refuses a 2D view of a texture declared 3D. `generateMipmaps` must stay off, or it builds mipmaps
  that way and fills the console with validation errors every frame; nothing reads those levels.
- The upload is the other place, and it is the one that draws a black frame. three.js writes a
  `Data3DTexture` a slice at a time, sixteen writes of a 16x16x1 region into the 16-cube. Each is a
  partial write, and a partial write makes the driver clear the rest of the texture first — which
  some Dawn builds do through 2D views. Every slice is then refused, the cube keeps the zeros it was
  allocated with, and the grade maps every colour of the frame to black.
- So the chain uploads the cube itself. `source.dataReady` set to false tells the renderer to
  allocate the texture and transfer nothing into it, and `uploadLut` (`lut-upload.ts`) writes the
  whole cube in one `writeTexture`. A copy that covers the texture needs no clear before it, so
  nothing builds a view of anything. `renderer.initTexture` is what makes the texture exist before
  the first frame is drawn rather than during it.
- The refusal follows the browser build, not the code. The same commit draws the city on the
  Chromium a GitHub runner installs and a black rectangle on the one a cloud container holds, both
  on SwiftShader. A browser that reports no error is not evidence the slice-by-slice upload is
  sound, which is why the one-copy write stays whatever the console says.
- A grade that cannot be uploaded is dropped rather than drawn: `uploadLut` returns false, and
  `PostChain` warns once and rebuilds the graph without the lookup. An ungraded frame is a frame
  someone can still judge; a frame looked up in a cube that never arrived is a black rectangle that
  looks exactly like a rendering change that drew nothing.
- `npm run test:render` (`scripts/render-check.ts`) is what tells the two apart: it renders one
  frame and fails on a blank or flat one. Run it after anything that touches the chain.
