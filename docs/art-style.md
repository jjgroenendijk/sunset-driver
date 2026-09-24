# Art style

The look the game keeps: a cel-shaded city in bright, warm pastels, drawn with dark ink lines and
shadowed in coloured light. By day it is sunny and sweet; by night it is neon on indigo. This file
is the reference for every change that alters what the player sees: a material, a colour, a light,
the post chain or the UI. `spec.md` section 10 is the design; this file says what the design must
look like. `docs/rendering.md`, `docs/lighting.md` and `docs/post.md` say how the renderer works
today.

## Contents

- The reference
- The rules
- Palette
- Light and shadow
- Line
- Forms
- Sky, water and distance
- Day, night and weather
- The UI
- How it maps onto the renderer
- Where the game stands today
- Decisions
- Checking a change

## The reference

The style comes from a 43-second capture of a browser driving toy called Foldline. The capture is
not in the repository and must not be: the game ships no asset files (spec 1.2), and the capture is
someone else's work. This file describes it in words and numbers instead. Take what the style does,
never copy its content.

What the capture shows: a jeep drives through a Mediterranean town of stucco houses, terracotta
roofs, round trees and bougainvillea, then onto a bridge over a turquoise sea. Every frame reads
like a coloured ink drawing. The capture also lays the frame on paper, with grain and a torn edge;
this game does not take that part (see Decisions).

## The rules

1. **Every form has an ink line.** Silhouettes carry a heavy line, creases a thin one. Lines are
   clean, not wobbly.
2. **Shade in bands.** A surface has light, mid and shade bands, joined by a short soft ramp. It
   never shows a long smooth gradient.
3. **Shadows are colour, never black.** A shadow shifts the hue toward the shadow colour of the
   time of day and keeps the saturation. Black exists only in the ink.
4. **High key by day.** Most of the day frame sits in the upper half of brightness.
5. **Warm light, cool shade.** Lit faces lean yellow and orange; shaded faces lean blue and violet.
6. **Few, bold forms.** Detail comes from colour and line, not from polygons.
7. **Hue gradients on living things.** Foliage and flowers run from one hue to another across the
   form: lime to green, magenta to orange.
8. **Distance fades to a warm haze**, not toward grey or blue.
9. **Night is neon on indigo**, never black.

## Palette

Values sampled from the capture. They are starting points, not exact targets: the capture is
compressed video, and accent colours are more saturated than a sample of it shows.

| Role | Colour | Notes |
| --- | --- | --- |
| Haze | `#e9e3d3` | Warm cream; the far distance and the fog by day |
| Ink | `#2a2430` | Warm dark plum, never pure black |
| Road, lit | `#979abf` | Periwinkle stone slabs |
| Pavement | `#e7dec2` | Warm cream |
| Shadow on light ground | `#8f8fc0` | Lavender at noon; see Light and shadow |
| Kerb and verge | `#a1979f` | Lavender grey |
| Foliage, lit | `#c8dc4a` | Lime yellow; blooms in sun |
| Foliage, shade | `#6a8d41` | Olive green |
| Grass, dry | `#dabe40` | Mustard |
| Roof | `#cc6a3b` | Terracotta |
| Stucco, warm | `#d98b62` | Coral |
| Stucco, yellow | `#d9b84a` | Mustard |
| Shutter and door | `#2f5fc4` | Cobalt; also teal `#2e8c8a` |
| Flower, top | `#c21966` | Magenta |
| Flower, bottom | `#e8923a` | Orange |
| Sea, near | `#5fd0c8` | Turquoise, white glints |
| Sea, far | `#c5dedf` | Fades to the haze |
| Sky | `#c9dcea` | Pale; clouds lavender `#a6a9d8` |
| Road marking | `#f2c81e` | Warm yellow |
| Night ground | `#1e1b3a` | Indigo; the darkest colour except the ink |

Rules for the palette:

- Each building style of spec 10.3 keeps its own palette, as spec 10.3 says. Its colours move into
  this key: lighter, warmer, more saturated. Brutalist concrete becomes a warm lavender grey, not a
  neutral grey.
- Neutral grey (a colour with no hue) appears nowhere except in the ink. A grey surface takes a hue
  from its surroundings: lavender in shade, cream in light.
- A district keeps its identity through which accents dominate, not through darker colours.

## Light and shadow

- A lit surface has three bands: light, mid and shade. The step between two bands is a short soft
  ramp, a small share of the band's width.
- The shade band is the lit colour mixed toward the shadow colour, not the lit colour made darker.
- The shadow colour follows the time of day:

| Time | Shadow colour | Light |
| --- | --- | --- |
| Dawn | Violet-pink `#a98bb8` | Peach |
| Morning and noon | Lavender `#8f8fc0` | Warm white |
| Golden hour | Rose-violet `#9c78a8` | Orange |
| Dusk | Deep violet `#5c4a8a` | Rose and orange |
| Night | Navy `#232450` | Neon, windows, lamps |

- A cast shadow is one shape in the shadow colour, with the soft edge the CSM shadows already give.
- Bright lit areas glow a little: sun on lime foliage blooms into a soft yellow halo.
- Specular highlights are white dabs, not smooth gradients. Water glints are the clearest case.

## Line

- All lines come from one screen-space edge pass in the post chain. It replaces the inverted-hull
  outlines of today.
- A depth step draws the heavy silhouette line. A normal step draws the thin crease line: roof
  edges, window reveals, kerbs, the corners of a vehicle.
- Seams on flat surfaces, which have no depth or normal step, are drawn into the generated
  textures: road slabs, lane lines, window frames.
- The width is fixed on screen, in pixels, at every distance. The heavy line is about two pixels at
  full render scale and scales with the render scale; the thin line is about one.
- The ink colour is warm plum (`#2a2430`). Far away the line lightens toward the haze.
- The pass must leave out what the See-through camera of spec 10.7 dithers: a dithered building
  has no line inside the cone. Pixels the cutaway drops must not draw edges.
- The water mirror and the sky draw no lines.

## Forms

- Buildings: simple masses with deep window openings, shutters, balconies, flower boxes and
  awnings. Roofs are strong shapes in a single colour. Rows vary in height and colour.
- Grime and weathering (spec 10.3) stay, drawn as flat painted strokes in a darker or cooler shade
  of the wall colour, never as photographic dirt.
- Trees: in town, a faceted low-poly blob on a trunk, flat-shaded per facet, with a hue gradient
  from lit top to shaded bottom, and tall cypress spindles beside them. In parks and the wild,
  `TreeGenerator` and `ForestGenerator` forms with the same bands and gradient.
- Flowers: large faceted clusters in magenta and orange, hanging over walls and arches.
- Vehicles: chunky, with clear panels and colour blocks rather than materials.
- Props: lamp posts, rocks and planters are low-poly with the same line and bands.

## Sky, water and distance

- By day the sky is pale blue fading to the haze at the horizon, with flat lavender clouds that
  have light edges.
- Water is turquoise near the shore and fades to the haze in the distance. It carries white glints
  and is clear enough to show the sea floor near the shore.
- Distance fades objects toward the haze. Far islands become pale pastel silhouettes.

## Day, night and weather

- **Dawn and golden hour**: warm light in peach and orange.
- **Noon**: the palette above.
- **Dusk**: saturated rose and orange sky.
- **Night**: the ground and the sky are deep indigo, not black. Neon, windows, lamps and headlights
  are the brightest things in the frame, and they bloom. The ink stays darker than the indigo.
- **Rain**: the palette cools and loses some saturation. Puddles are flat mirrors.

Night is where the crime tone of spec 10.1 lives. The day is bright and sweet; the night is neon on
indigo. The contrast between a pretty town and what happens in it is the satire.

## The UI

- Panels are cream cards (`#f4efe2`) with a thin ink border and a small drop shadow.
- Titles are hand-lettered: italic, brush-like capitals, from a system font stack (below). Labels
  are small capitals in a plain sans.
- Accent badges are round, in warm yellow with an ink outline.
- Buttons are small pills with an ink border; the active one is ink with cream text.
- Crossing into a new district shows its name as a large title in the middle of the screen, with a
  one-line subtitle, and fades out. Streets get no title.
- Map and minimap icons follow the same rules: flat colour, ink outline.

The game ships no font file, so the hand-lettered face is a system font stack with a fallback,
for example `"Marker Felt", "Segoe Print", "Bradley Hand", cursive`. It looks a little different
on each system; that is accepted.

## How it maps onto the renderer

Where each rule lands. None of it needs an asset file.

- **Bands** — `cel.ts`, a light model on the shared node materials: the sun's cosine times its
  cast shadow, stepped into three bands with a short `smoothstep` between them.
- **Shadow colour** — `daylightAt` carries it for the time of day (`shade.ts`). The shade band and
  a cast shadow are lit by the sky fill alone, and the fill is that colour, so both shift toward it
  instead of darkening.
- **Lines** — an edge pass in `PostChain`, after the scene and before bloom. It reads depth and a
  normal target. The inverted hulls (`building-hull.ts`, `OUTLINE` in `vehicle.ts` and the others)
  are removed when it lands, which also removes their geometry from every batch.
- **Hue gradients** — a vertex colour or a height term in the foliage and flower materials.
- **Distance to haze** — the fog colour becomes the haze colour of the time of day.
- **Grade** — the LUT of `grade.ts` lifts the day into high key and warms the lights. It only
  finishes the look; the colours must be right in the materials first.
- **UI** — CSS on the DOM overlay.

## Where the game stands today

A preview of seed 1 at noon (`node scripts/render-preview.ts 1 out.png`) shows the gap:

- Mid greys dominate: asphalt, concrete, car parks. The frame is low key.
- Shadows are dark grey, close to black.
- Outlines are inverted hulls in near black (`0x150f12`), silhouettes only, no crease lines.
- Shading is smooth, not banded; materials aim at realism.

The layout, the bloom and the colour grade are the foundation the style builds on. The work is in
the materials, the light model and the edge pass.

## Decisions

Made on 2026-09-24. Change this list only with a new decision.

| Question | Decision |
| --- | --- |
| How far to go | Palette and bands; no paper grain, no torn frame edge |
| Bands | Three, joined by a short soft ramp |
| Shadow colour | Follows the time of day |
| Line width | Fixed on screen |
| Line wobble | None |
| Lines | One screen-space edge pass for silhouettes and creases; hulls removed |
| Night | Neon on indigo |
| Trees | Blobs in town, generator trees in parks and the wild |
| Grime | Kept, as painted strokes |
| Lettering | System font stack |
| Place titles | District names only |

## Checking a change

- Take a picture before and after with `node scripts/render-preview.ts <seed> out.png`, and a sheet
  of several seeds with `render-sheet.ts`, at noon and at night. Read both.
- Check the rules against the picture. The quickest tests: is any shadow black or neutral grey? Is
  most of the day frame bright? Does every object have a line, and does the line stay the same
  width near and far?
- A style change costs frame time like any other. Profile it (`docs/profiling.md`).
