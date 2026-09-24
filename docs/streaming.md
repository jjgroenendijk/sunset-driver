# Streaming and batches

How a chunk reaches the screen: the workers that build it, the frame budget that uploads it, the
batches its parts are merged into and the cells those batches are cut into. `spec.md` sections 9.1
and 9.2 are the design. What is done with a frame once the city is in the scene — quality tiers,
shader warm-up, smoothing, the roads, the water — is in `docs/rendering.md`, the three building
details in `docs/buildings.md`, and the frame and memory measurements in `docs/performance.md`.

## Contents

- Streaming the city
- Batches and cells

## Streaming the city

- The city is streamed in workers (spec section 9.1). `ChunkPool` (`chunk-pool.ts`) sends each
  worker the world description, the worker builds its own layers, and it answers with a
  `ChunkPayload` (`chunk-payload.ts`): typed arrays and no three.js object, handed over rather than
  copied. `chunk-worker.ts` may therefore import only what runs without a DOM, a renderer or a
  material, as `src/world` may.
- The main thread pays only for the upload. `WorldScene.update` runs the queue against `spendBudget`
  (`streaming.ts`) and a batch is filled a step at a time, so a chunk of the core lands over several
  frames. A step is indivisible and is the only thing that overruns the streaming slice,
  by about 0.4 ms on an Apple M1 laptop. A step copies at most `MAX_STEP_VERTICES` (`batch.ts`),
  so that overrun is a number the renderer chose and not the largest tower a seed happens to build —
  a core chunk carries towers of 33 000 vertices, which is sixteen steps. A part larger than a step
  is copied over several of them and is drawn only once its last step is in, because the index is
  what the renderer reads its vertices through. Cutting a part costs nothing: the chunk spends the
  same total either way. The worker also allocates the buffers each batch copies its parts into
  (`PackedBatch.storage`), and `fillOfPacked` merges the batch into them. A batch left to allocate
  its own does it inside its first part: tens of megabytes in one frame, and the piece a collection
  lands in.
- A job after the first starts only when the longest job so far this frame would still end inside
  the budget. The first upload of a buffer copies the whole array, so each buffer of a batch is
  created in a step of its own. What still overruns the slice on a drive is a garbage collection
  that lands in a job, at 3–4 ms on an M1 (issue #639).
- Nothing is built on the frame thread any more, so
  `WorldScene.settle(x, y, radius, timeoutMs, onProgress)` is how the game and the preview wait for
  the ground under the player. `onProgress` is told how many of the wanted chunks are in the scene,
  which is what the loading screen draws; the total is the most ever outstanding, because a chunk
  already in the scene was never outstanding.
- The world itself is built in a worker too (`world-source.ts`, `world-source-worker.ts`). Half a
  second on the frame thread is the title screen frozen mid-swing and a loading screen that cannot
  draw its own progress. `WorldSource` holds one world at a time: asking for the seed being built
  hands back the same promise, and asking for another seed gives up on the one in flight and rejects
  it with `GIVEN_UP`. `warm` starts the seed the title screen opens on, so Start usually finds it
  finished. In Node there is no `Worker` of that kind and it falls back to the calling thread.
- Only the first worker of the pool is asked for the parking bays. Every worker builds the same
  bays from the same layers and the pool keeps one answer, so asking them all cost every worker but
  one a chunk's worth of time before its first chunk.
- WebGPU compiles a pipeline the first time it draws with it, so a session drawing its first frame
  compiles the whole city over that frame and the twenty after it: the street stutters into place
  while the player is already driving on it. `main.ts` calls `renderer.compileAsync(scene, camera)`
  after `settle` and before the first frame, with the camera already standing where the session
  starts, because what is compiled is what the camera can see. `render-profile.ts` throws away the
  same frames for the same reason.
- The far ring is the same chunk at `'far'` detail: the ground, the highways and arterials over it,
  and every building as its massing, with no plants. A chunk that crosses between the
  rings is built again and swapped when it lands, so nothing disappears while its replacement is
  built.
- The buildings have three details of their own (spec section 9.2). Only the chunks within
  `FACADE_RADIUS` of the player generate facades. The rest of the near ring is `'mid'` detail: the
  chunk in full, but every building a block from `block-mesh.ts`. The far ring is one box per
  building (`buildMassingGeometry`). No detail builds a line of ink: the edge pass of `edges.ts`
  draws every one from the frame. On the dearest core chunk of 24 seeds the buildings cost
  1 240 000 vertices near, 87 000 mid and 7 300 far, measured when each building still carried an
  outline hull; without the hulls they cost less.
  `CHUNK_VERTEX_CAP` (`chunk-cost.ts`) holds each detail, and the sweep counts it with
  `buildingVertices`. A coarser bay and floor on the generated facade is not a middle detail: twice
  the bay and twice the floor still costs 45 % of the full facade, because the cornices, piers and
  finials do not scale with the bays.

## Batches and cells

- **A `BatchedMesh` is a trap on WebGPU in three.js 0.186.** It is drawn as one draw call per
  instance, after its instances are culled and sorted on the processor, in every pass: the view,
  each shadow cascade and the water's mirror. Its shaders are keyed on the batch itself, so a batch
  that comes into view in a pass for the first time builds them again, at 25 to 35 ms. Neither the
  GPU-side culling nor the single draw that spec section 9.2 asks for is what the class does today.
  A merged mesh shares its shaders with every chunk in the same material and is one draw, and its
  bounds are what culls it. `chunkDrawCalls(chunk)` (`chunk-cost.ts`) is the most a chunk costs —
  the ground, the markings, and each batch in every cell — and `CHUNK_DRAW_CALL_CAP` is the most it
  may; `payloadDrawCalls` counts the cells a built chunk fills, and the HUD shows the dearest chunk
  built. A count over the cap is a batching regression, not a cap to raise.
- A batch is cut into cells (`cells.ts`): a quarter of a chunk at near and mid detail, and the whole
  chunk in the far ring. A mesh is culled whole in the view, in each shadow cascade and in the
  mirror, so a batch that spanned its 250 m chunk was drawn whole wherever a corner of it was seen.
  A part goes into the cell its frame's origin stands in, or the middle of its box when it has no
  frame, so a building's shell, its roof dressing and its footing always share a cell. On seed
  `sunset`, standing on the core at full quality on an Apple M1 laptop, cells cut the still frame
  from 19.7 to 14.4 ms and the triangles from 3.42 M to 1.89 M, for 66 more draws and about 1 ms
  more processor time. At a pixel ratio of 2 the frame went from 35 to 28 ms. Cells of a ninth of a
  chunk drew 1.46 M triangles but no faster a frame, with a worse 95th percentile, so the draws cost
  what they saved. The far ring is not cut: its batches are a few thousand vertices each.
- **A chunk must not be held twice in the page's memory.** iOS Safari kills a page that holds too
  much, then reloads it, so the player lands on the title screen with no error (issue #448). Three
  things held the city twice and more: 1.45 GB of array storage, measured at the size of a phone.
  - In V8 a closure keeps the whole scope it was made in. A closure a tile keeps, such as a
    `dispose`, must not be made in a scope that also holds the payload: `groundPart` (`ground.ts`)
    exists for this reason.
  - `ChunkTiles.add` (`chunk-tiles.ts`) empties `TilePart.steps` once they are queued, because a
    step holds the arrays it copies from.
  - A full batch lets its arrays go (`Batch.letGo`). `letGo` reads the renderer's own record and
    releases only an attribute whose current version is on the GPU. A batch released too early is
    drawn from an empty buffer, and WebGPU reports a vertex range larger than the bound buffer.
  - Each step uploads the ranges it wrote (`uploadBatchesWith`, called by `renderer.ts`), so a
    batch lets go after its last step. Waiting for the first draw kept the arrays of every batch
    the camera had not looked at yet, which was 267 MB on the core of seed `sunset`. A batch the
    steps uploaded frees its own buffers on `dispose`, because three.js frees only the buffers of
    a geometry it drew. `docs/performance.md` has the numbers.
  - A renderer is disposed through `disposeRenderer` (`renderer.ts`). A bare `dispose` leaves it
    as the uploader: the next batches upload into its dead record and let go of their arrays, and
    the next renderer draws buffers of 0 bytes, with a WebGPU error for each.
- A generated facade is packed in the worker (`facade-pack.ts`): 48 bytes a vertex instead of 144,
  drawn through an index. Its normal is four signed bytes, so `batch.ts` turns it by the part's
  frame and writes it back as bytes. Half floats are a `Float16Array`: three.js 0.186 turns a
  `Float16BufferAttribute` into 32-bit integers on upload.

