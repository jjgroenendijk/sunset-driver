# Sunset Driver — Specification

Sunset Driver is a top-down open-world crime game for the browser: WebGPU, Rapier, Tone.js, no
assets, no server. This document is the single source of truth for building it.

Sections are ordered by implementation: build from the top down. Each section stands on the ones
above it.

---

## 1. Principles and vetoes

### 1.1 Layout is claimed once

Streets, parks, car parks and buildings must never overlap. Rather than detecting and repairing
collisions, the [parcel model](#6-road-network-and-parcels) allocates every piece of ground to
exactly one owner, so overlap cannot be expressed, and the [verification
gates](#3-verification-gates) fail the build if it ever appears.

### 1.2 Hard vetoes

Do not implement these, and do not propose them again.

- No armour. No pickups, no stat, no bar.
- No news. No ticker, no headline strip, no news or talk-news radio station.
- No asset files. No models, textures or audio files. Everything is generated in code at runtime.
- No hosting. No game server, signalling server, database or serverless function. The deployment is
  a static site.
- No feature exists to justify an addon. Broad three.js coverage is a goal, but every addon must
  serve a feature that is wanted on its own merits.
- No overlap-by-collision-checking. Layout is constrained at placement time, never detected and
  repaired afterwards.

---

## 2. Foundation

### 2.1 Stack

- Vite + npm + TypeScript, multi-file project. `npm install && npm run dev` works from a clean
  clone.
- three.js at latest stable (0.185.1 today), rendering through `WebGPURenderer` from `three/webgpu`.
  WebGPU only, no WebGL fallback.
- Rapier (`@dimforge/rapier3d-compat`) for physics, with `DynamicRayCastVehicleController` for
  vehicles.
- Tone.js for all audio and music, synthesised at runtime.
- Keyboard and mouse input.
- Conventional Commits, one atomic change per commit.

### 2.2 Simulation loop

- Fixed-step simulation at 60 Hz with an accumulator, decoupled from an uncapped render loop.
  Physics and gameplay are frame-rate independent.
- Simulation time is a monotonic integer tick counter. Simulation code never reads wall-clock time
  or frame delta.
- One in-game day is 24 real minutes (one real minute per game hour).

### 2.3 Architecture

- World generation returns a plain, serialisable world description. It may use three.js (math,
  curves, the city and terrain generators) but must run headless in Node, because the seed sweep
  runs there. It must not touch the renderer, Rapier or the DOM.
- Rendering, physics and gameplay read the world description; they do not mutate it.
- UI is DOM, overlaid on the canvas.

### 2.4 Performance target

60 fps on integrated graphics is the hard constraint. World density, draw distance, entity counts
and generation budgets are the variables that give way to meet it, never the other way round.

Frustum culling alone does not get there; the fixed top-down camera already keeps the visible area
small. The frame is won on draw calls, shadows, lights and simulation scope. Each system owns a
slice of a 16 ms frame budget and is measured against it:

| Slice | Budget | How it is kept |
|---|---|---|
| Render | 9 ms | One `BatchedMesh` or instanced draw per type per chunk, GPU-side per-instance culling, 1–2 CSM cascades, clustered lighting with a hard light cap, minimal post |
| Physics | 2 ms | Only promoted actors have Rapier bodies; ambient traffic is kinematic |
| Gameplay and AI | 2 ms | Nothing outside the streaming radius is stepped; police and traffic plan on the road graph, not on geometry |
| Streaming | 2 ms | Chunk work in `WorkerPool`, main-thread upload capped per frame |
| Headroom | 1 ms | Absorbed by the quality-tier stepdown when missed |

---

## 3. Verification gates

Set up before the first line of world generation, so every feature lands under the gate.

- `npm run typecheck` (`tsc --noEmit`) passes.
- Lint rules: no `Math.random()` and no iteration over `Set`, `Map` insertion order or object keys
  anywhere in generation or simulation code.
- The seed sweep. Generates hundreds of seeds. For each seed it generates a fixed set of chunks (a
  block around the origin plus a handful at fixed far offsets) and asserts:
  - zero geometric overlaps between roads, corridors, parcels, buildings, parks, car parks, beaches,
    water and ground cover;
  - the road graph has a single connected component;
  - every building is reachable from the road network;
  - nothing floats above or sinks below the carved terrain;
  - a chunk generated in isolation is identical to the same chunk generated with all neighbours
    loaded;
  - generation is byte-identical across runs.
- The simulation sweep. Runs the headless simulation and asserts:
  - replaying a seed from tick zero with a recorded input stream reproduces identical state;
  - simulating at 30, 60 and 144 fps yields identical state at the same tick;
  - two independent instances stepped to the same tick agree;
  - an ambient actor evaluated on demand at tick N matches the same actor simulated continuously to
    tick N.
- Frame-time regression check against the 60 fps integrated-graphics target.

Any failure fails the build. The gate is never weakened, skipped or made optional.

---

## 4. Hosting and deployment

- Source on GitHub; hosted on Cloudflare Pages as a static site.
- Deployment runs from GitHub Actions, not from Cloudflare's Git integration: on every push to
  `main` and every pull request the workflow installs, typechecks, builds and publishes `dist` with
  `wrangler pages deploy`. Pushes to `main` become the production deployment; pull requests get
  preview deployments on their own branch alias.
- The workflow needs two repository secrets: `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN`
  with Pages edit permission.
- Vite uses a relative `base`, so the build is path-independent.
- `public/_headers`: immutable caching for content-hashed assets, no-cache for `index.html`, and a
  Content Security Policy that permits WebRTC plus outbound `wss:` to the public Nostr relays and
  MQTT brokers used for signalling.
- `public/_redirects`: SPA fallback.
- Node version pinned in `.nvmrc` and used by the workflow, so local and CI builds match.
- The site stays fully static. No serverless functions, no KV, no D1, no secrets in the build. If a
  feature seems to need a backend, the feature is wrong.

---

## 5. Determinism

The whole world — its geometry and its life — is a pure function of `(seed, tick)`. Two players on
the same seed at the same tick see the same city, the same cars in the same places, the same
pedestrians, weather and events. The only non-deterministic inputs are player inputs.

### 5.1 Rules

- Every random draw comes from a seeded generator keyed by `hash(seed, tick, subsystem, entityId)`.
- Every collection iterated during simulation has a stable, sorted order.
- Traffic spawns, routes, pedestrian appearance and schedules, wildlife, weather, market drift, city
  events and street crime all follow from the seed. Replaying a seed from tick zero reproduces the
  session.

### 5.2 The seed

Visible, editable and shareable in the UI, and encoded in the URL hash so a link reproduces a world
exactly.

### 5.3 Ambient life is evaluated, not spawned

Traffic and pedestrians are not entities that spawn near the player and vanish behind them. Each is
a deterministic function of `(seed, tick)` and a stable identity, derived from the road graph and
the schedule system.

- Actors outside the streaming radius are not stepped; their state is evaluated on demand from their
  trajectory when a player comes into range. This is what lets a large streamed world stay
  deterministic, and it is cheaper than simulating the whole city.
- Ambient actors are kinematic — moved along their trajectory, not simulated by Rapier — until they
  are touched.
- Once a player interacts with an actor (hits it, steals it, shoots at it) it is promoted to a
  tracked entity with a Rapier body. Its state now diverges from the trajectory and is owned by the
  simulation (and, in multiplayer, replicated).

### 5.4 Floating point

Rapier's WASM build is consistent for identical inputs on the same binary, but long-run
cross-machine agreement is not guaranteed. Divergence is expected and corrected by multiplayer
snapshots, not assumed away.

---

## 6. Road network and parcels

This is the most important section. It exists to make overlap unrepresentable.

### 6.1 Tensor-field roads

- Road direction follows a seeded, continuous tensor field. Influences: terrain gradient (roads
  follow contours on steep ground), coastlines and river banks (roads run parallel to water), radial
  fields around the core, grid fields in planned districts. Blending these produces natural bends
  and irregular blocks rather than a uniform grid.
- Major roads are traced first as streamlines; minor roads fill the space between them. The result
  is a real hierarchy, not a grid with some roads recoloured.
- Roads are curves. Bends, sweeping arcs and irregular junction angles are the default. Road
  surfaces, kerbs, rails and decks are lofted along these curves.
- A segment whose grade exceeds the tier's maximum is rejected, rerouted, bridged or tunnelled —
  never laid over the hill.

### 6.2 Tiers

Each tier has its own width, lane count, speed limit, markings, surface, traffic density and
permitted traffic.

| Tier | Character |
|---|---|
| Highway | Multi-lane, high speed, elevated sections, on/off ramps. No pedestrians; junctions only at interchanges. |
| Arterial | Main urban through-routes. Signalised junctions, bus routes, tram lanes, dense traffic. |
| Street | Residential and commercial. Parking both sides, pedestrian crossings. |
| Alley / service road | Narrow, unmarked. Bins, loading bays, shortcuts, escape routes. |
| Dirt road | Outskirts and wilderness. Unpaved, reduced grip, dust, no markings or lighting. |

Bridges carry roads over water. Overpasses carry roads over roads; an overpass is not a junction,
and junction generation must respect grade separation.

### 6.3 Corridors

Elevated highways and the tram line are corridors and take part in the same footprint subtraction as
roads.

- An elevated highway corridor owns a strip of land. The ground beneath the deck is its own parcel
  type, under-structure: car parks, dealers' pitches, alley-grade access. Pillars are placed only
  inside it.
- The tram runs at street level in a reserved lane on arterials. Where it crosses other roads it
  forms a level crossing that traffic and pedestrians obey.

### 6.4 The parcel model

1. Generate the road network and corridors as curves.
2. Compute their footprint polygon: carriageway, verge and pavement.
3. Subtract the footprint from the land. What remains are the parcels.
4. Each parcel is owned by exactly one thing: a building group, a park, a car park, a plaza, an
   under-structure, a beach, a body of water, or undeveloped ground cover.
5. Nothing is placed outside the polygon of the parcel that owns it. There is no second pass that
   finds collisions and nudges things apart.

Space is claimed once and never shared, so roads cannot overlap parks, parks cannot overlap car
parks, and grass cannot grow across a carriageway.

### 6.5 The road graph

The network is stored as a queryable graph — nodes, edges, tiers, lanes, direction, speed limits,
junction topology, grade separation, tram track and stops — that traffic, police, navigation, the
minimap and pathfinding all reason about. It is not just render geometry.

---

## 7. Terrain and water

### 7.1 Terrain

- A full heightfield with steep hills. Streets climb real gradients, which affects driving, chases,
  sightlines and the skyline.
- The heightfield is produced by three.js `TerrainGenerator`, driven by the world seed.
- Roads carve their corridor into the terrain: the ground beneath the network is flattened and cut,
  and cut/fill slopes blend back into the hillside. Roads are never draped on unmodified terrain.
- Ground cover (grass, scrub, gravel) is painted only onto parcels no road owns.

### 7.2 Water

- The world is an archipelago: a few large islands (three to five) close together, separated by
  narrow straits, with open sea around the map edge. The core sits on the largest island; the others
  carry suburbs, outskirts and wilderness.
- A seeded river cuts the main island from its interior to a harbour on the shore.
- One outer island is developed as the island district. Bridges or causeways link the islands at the
  narrowest points of the straits, and wherever else the road network crosses water.
- Boats are a drivable vehicle class.
- Water surfaces use the three.js water addons. Wet surfaces and reflections are central to the
  night look.

### 7.3 Beaches

- Where the coast meets gentle terrain, the shore becomes a beach parcel: sand grading into
  shallows, dunes with grass behind, palms or pines where the zone allows. Steep coast stays cliff
  or sea wall; harbour frontage stays quay.
- At least one long beach per seed lies outside the core — typically on the suburban or outskirts
  coast — with a boardwalk road along its back, a pier reaching into the water, and beach car parks.
- Sand is a driving surface: soft, low grip, dust plumes, and vehicles bog down on dunes.
- Beaches are launch points for boats and boat theft.

---

## 8. Districts and zoning

### 8.1 World size

The map is square and its side length is drawn from the seed, between 3 km and 6 km. Zone rings, the
islands, the straits, the river system and faction turfs scale with it, so a small seed is a
compact, dense city and a large seed has long drives and a wide wilderness.

### 8.2 Zones

The city grades outward through concentric zones:

| Zone | Character |
|---|---|
| Core | Dense downtown. Tall towers, tight blocks, heavy road and foot traffic. |
| Inner districts | Mid-rise, commercial strips, nightlife. Varied wealth and density. Home to the named neighbourhoods below. |
| Industrial | Warehouses, freight yards, wide service roads, freight traffic. |
| Suburban | Low buildings, gardens, quiet streets, driveways. On the coast: beachfront houses and the boardwalk. |
| Outskirts | Sparse development, filling stations, roadhouses, isolated properties. |
| Wilderness | Hills, forest and farmland threaded with dirt roads. |

Districts within a zone differ in density, wealth and character. Those three values drive building
selection, traffic volume, pedestrian type and density, police response time, contraband prices and
faction presence.

### 8.3 Neighbourhoods

Several inner and harbour districts are named neighbourhoods with a dominant culture that shows in
signage, shopfronts, food carts, music and building colour. They are the home turf of the
[factions](#17-factions-and-territory). The beach and boardwalk form their own neighbourhood — surf
shops, ice-cream stands, a fairground pier — laid-back by day and a party strip by night.

---

## 9. Streaming and performance

### 9.1 Streaming

- The world is generated and disposed in chunks around the player rather than held whole in memory.
- Chunk generation runs in a `WorkerPool` off the main thread and is frame-budgeted: a hard
  millisecond cap per frame, with work queued and spread across frames. If the budget is exceeded
  chunks arrive later; frame rate is never spent.
- Chunk boundaries are seamless by construction: the tensor field, heightfield and road graph are
  evaluated from continuous seeded functions, so a chunk's contents do not depend on which
  neighbours are loaded.
- Distant chunks drop to progressively simpler geometry rather than disappearing, so the skyline
  holds.

### 9.2 Rendering budget

- Aggressive batching: buildings, road segments, vegetation, parked cars, pedestrians and props go
  through `BatchedMesh` or instancing by type and chunk, so the visible city renders in a small
  number of draw calls and per-instance frustum culling happens on the GPU.
- Shadow work is sized to the small top-down view: one or two CSM cascades, never four.
- Per-instance near-camera fade (Bayer dither, no transparency sorting) so entities entering the
  streaming radius do not pop.
- LOD tiers for buildings, terrain and vegetation.
- Entity caps per category, enforced by distance-based culling and recycling.
- A quality-tier system: render scale, draw distance, shadow resolution, entity density and effect
  toggles step down automatically when frame time is missed.

---

## 10. Rendering and visual style

### 10.1 Direction

Stylised, lit, hard outlines. Tone: gritty crime drama with a satirical edge.

- Hard outlines on buildings, vehicles and characters keep silhouettes readable from above.
  Implemented as inverted-hull shells on instanced geometry, not as a post-process.
- Real lighting, shadows and material variation inside the outlines. Buildings have architectural
  detail; terrain has relief.
- Strong, saturated colour identity per district and per time of day. Neon and emissive windows
  after dark; warm sand, bright parasols and pastel beachfront on the coast.

### 10.2 Geometry and materials

- All geometry is generated in code.
- Textures are generated at runtime: noise, gradients, detail and roughness maps built in-engine.
- The deployed build contains no binary assets, loads instantly, and still has surface richness.

### 10.3 Buildings

- `SkyscraperGenerator` (three.js `generators/city/`) supplies variety: per-building seeds, varied
  heights and footprints, chamfered corners facing junctions, setbacks, string courses, varied bay
  and pier widths.
- `SidewalkGenerator` supplies rounded curbs and pavement slabs.
- Selection is driven by the parcel's district, zone, wealth and size. A suburban parcel never
  receives a tower.
- A handful of shop types are enterable; every other building is exterior only, with lit windows and
  moving silhouettes. No generated interiors beyond shops and safehouses. Inside, a `ClippingGroup`
  clips away the roof and front wall so the top-down camera can see in.
- three.js also ships `CityGenerator`, which composes the above on a rigid rectangular grid with no
  road graph — a layout this game does not want. Use its building generators; do not use its layout.

### 10.4 Vegetation

`TreeGenerator` and `ForestGenerator` for parks, street trees, palms along the beachfront, hillsides
and the wilderness; dune grass on beach parcels; `MeshSurfaceSampler` to scatter vegetation and
ground detail across parcel polygons and terrain.

### 10.5 Lighting

Sky addon for the day/night cycle; CSM shadows for the sun; clustered lighting for dense night
lighting; `ProjectorLightNode` cones for headlights and street lamps; `RectAreaLight` for signage
and neon.

### 10.6 Post-processing

Deliberately minimal:

- Bloom for neon, emissive windows and headlights.
- SMAA, with a render-scale tier for weak hardware.
- A subtle colour grade per time of day and weather, as a runtime-generated 3D LUT.

Visual richness comes from geometry, lighting and materials rather than screen-space effects.

### 10.7 Camera

Fixed tilted top-down. Pitch is locked and heading is fixed. The camera only translates: it leads
the vehicle at speed and pulls back as speed increases. It never rolls, banks or rotates. That is
the camera the game is played through; the developer free camera of `docs/dev-tooling.md` is a tool
and not a view of the game.

---

## 11. Player: character, controls, driving, on foot

### 11.1 Character

The player picks a character on the title screen: body type, skin tone, hair style and colour, and a
starting outfit, each from a small set. All of it is generated geometry and reads clearly from
above. Clothing shops add outfits and faction colours later. The choice is saved with the game and
is what other players see in multiplayer.

### 11.2 Controls

| Context | Actions |
|---|---|
| Driving | Accelerate, brake/reverse, steer, handbrake, horn |
| On foot | Move, sprint, jump, enter/exit vehicle, interact |
| Combat | Aim, fire, reload, cycle weapon, melee, take cover |
| Radio | Next/previous station, mute |
| Map | Open full map, cycle minimap zoom |
| System | Pause menu, quicksave |

The full binding list is shown in the pause menu and in the README.

### 11.3 Driving

Driving is the primary mechanic.

- Vehicle classes with genuinely different handling: compacts, saloons, sports cars, vans, trucks,
  buses, motorcycles, off-road vehicles, beach buggies, emergency vehicles, boats.
- Rapier `DynamicRayCastVehicleController`. Handbrake drifts leave skid-mark decals; weight
  transfer, grip loss on wet and dirt surfaces. Terrain gradient affects acceleration, braking and
  grip.
- Visible progressive damage: deformation, lost panels, smoke, fire, explosion.
- Cars can be set on fire, and fire spreads.

### 11.4 Vehicle theft

- Ordinary cars are instant: get in and go.
- Only alarmed, luxury or high-end vehicles trigger a short hotwire or lockpick minigame.
- The minigame never pauses the world. Police close in, traffic passes, pedestrians react while you
  work.
- Its length is capped so it is always winnable under pressure.

### 11.5 On foot

- A light cover mechanic, aimed and hip fire, melee with a range of weapons.
- Health regenerates only through pickups, food from shops or safehouse rest. No armour.
- Foot combat is a real alternative to driving; driving stays primary.

### 11.6 Weapons

A rich arsenal based on real weapons, under their real names, with calibre, capacity, rate of fire,
spread, recoil and reload time taken from the real thing and tuned for play. Every weapon is
generated geometry with a distinct top-down silhouette. Ammunition is per calibre and shared across
weapons of that calibre.

| Class | Weapons | Character |
|---|---|---|
| Melee | Fists, brass knuckles, baseball bat, crowbar, machete, katana, switchblade, combat knife, golf club, chainsaw | Silent, no ammo; heavy weapons stagger, blades bleed |
| Pistols | Glock 17 (9×19), Beretta 92FS (9×19), Colt M1911 (.45 ACP), SIG P226 (9×19), S&W Model 29 (.44 Mag), Desert Eagle (.50 AE) | Concealed, fast draw, usable from any vehicle seat |
| SMGs | Uzi (9×19), MAC-10 (.45 ACP), H&K MP5 (9×19), TEC-9 (9×19) | High rate, wide spread; drive-by staple |
| Shotguns | Remington 870 (12 ga), Mossberg 500 (12 ga), sawn-off double barrel (12 ga), SPAS-12 (12 ga) | Devastating close, useless at range; wrecks car doors |
| Rifles | AK-47 (7.62×39), M4A1 (5.56×45), FN FAL (7.62×51), Ruger Mini-14 (5.56×45) | Long gun; accurate, penetrates car bodies |
| Precision | Remington 700 (.308), Barrett M82 (.50 BMG) | Scoped; the M82 disables engines |
| Heavy | M249 (5.56×45), RPG-7, M79 grenade launcher, flamethrower | Rare, faction-only or robbed; heavy heat on sight |
| Thrown | Fragmentation grenade, Molotov cocktail, pipe bomb, smoke, tear gas | Molotovs start fires that spread |

Attachments, bought at weapon shops or faction dealers and fitted per weapon: suppressor (smaller
police-alert radius, less heat per shot), extended magazine, optic (longer aim range), laser
(tighter hip-fire), foregrip (less recoil). Attachments show on the model.

Sources

- Weapon shops with licence tiers. Pistols and shotguns sell openly. Rifles, SMGs and heavy weapons
  need faction standing or the shop's back room, unlocked by reputation or by a job for the owner.
- Faction exclusives. Each faction's arsenal is its own — Bratva rifles and the M82, Syndicate
  blades and MP5s, Iron Saints sawn-offs and pipe bombs, Los Reyes TEC-9s and MAC-10s, the Family's
  shotguns and 1911s, the Docklands Mob's FALs, Unit 13 service Glocks and M4s. Reputation unlocks
  their dealers.
- Looting and theft. Killed NPCs and police drop what they carried; police cars hold a shotgun or
  M4; gun-store robberies yield stock.
- Vehicle-mounted. Pistols and SMGs fire from any seat. A few vehicles (a technical pickup, a patrol
  boat, the police helicopter) carry mounted guns.

Carrying a visible long gun raises heat when police see it; concealed pistols do not. Suppressed
shots draw police from a smaller radius.

### 11.7 Death and arrest

- Death: respawn at the active safehouse, weapons lost, hospital fee deducted.
- Arrest: respawn at the nearest police station, weapons (with their attachments) and carried
  contraband lost, bribe deducted.
- The safehouse stash and garage are never touched by either.

---

## 12. User interface

DOM-based, overlaid on the canvas.

- Title screen: seed entry, seed randomisation, character creation, continue, controls.
- HUD: health, money, current weapon and ammo, heat level, current objective.
- Minimap with distinct, recognisable icons per POI type: each shop type, safehouses, metro
  stations, mission givers, faction territory, the clinic, police, objectives and the player.
  Rotating or fixed-north, player's choice.
- Full map: pan and zoom, territory overlay, waypoint setting.
- Trading panel: district prices, inventory, price history.
- Pause menu: resume, controls, save, load, export/import save, open game to others, seed display
  and copy, regenerate, quit.

---

## 13. Baseline city life

The city must feel inhabited, not populated.

### 13.1 Traffic and pedestrians

- Dense traffic on every tier, respecting lanes, direction and speed limits.
- Animated pedestrians with visibly moving arms and legs, varied gaits, appearance varied by
  district. Skinned meshes with generated walk cycles, instanced so crowds stay within the draw-call
  budget.
- Parked cars lining streets and filling car parks.
- Working traffic lights that traffic and pedestrians obey.
- Pigeons that scatter when driven at.
- Advertising: billboards, shop signage, neon.

### 13.2 Tram

A street-level tram on a fixed route through the core and inner districts, with stops, waiting
passengers and level crossings. It is a landmark, a chase hazard and an obstacle in equal measure.

### 13.3 Metro

An underground metro with a few stations in the core and inner districts and one at the edge of the
suburbs. Stations are parcels with a street entrance and their own minimap icon; the line itself is
underground and claims no land, so it needs no corridor. Entering a station you have visited lets
you fast-travel to any other visited station: a fade, a teleport and a short arrival at the far
entrance. Fast travel is refused while you have heat or are in a vehicle, and the tick does not
skip, so it is safe in multiplayer.

### 13.4 Day, night and weather

- Day/night cycle. Emissive windows, street lighting, headlights and neon come on after dark.
- Weather that bites. Wet roads reduce grip, fog cuts draw distance and helps lose police, storms
  empty the streets. Puddles and wind-blown litter.

---

## 14. Heat and police

- Crime-weighted heat. Each crime adds heat scaled to its severity: a punch barely registers,
  killing an officer escalates hard.
- Two valid exits: break line of sight and stay hidden until heat decays, or destroy your pursuers.
- Police are competent. They coordinate by radio, set roadblocks, cut you off using the road graph
  rather than chasing your exact path, escalate unit types, use helicopters at high heat, and search
  your last known position rather than knowing where you are.
- Response time varies by district wealth and zone: slow in the wilderness, immediate downtown.
- Police also police the world: pulling over NPC drivers and responding to street crime.

---

## 15. Audio

All synthesised at runtime with Tone.js.

- Music radio stations: several distinct synthesised stations, tuneable in any vehicle, persisting
  per vehicle. Station flavours mirror the neighbourhoods' cultures, including a laid-back beach
  station. No news or talk station.
- Radio PSAs between songs, carrying the [harm-reduction](#19-harm-reduction) content.
- Situational scoring layered over or replacing radio: chases, missions, faction combat and calm
  exploration each have a dynamic musical response.
- Engine audio modelled from RPM, load and vehicle class.
- Sirens, horns, tyre squeal, collisions, gunfire, explosions, footsteps, tram bells.
- Ambient beds by district, zone, weather and time of day: traffic hum downtown, surf and gulls on
  the beach, birdsong and wind in the wilderness, rain on metal.
- Positional audio with distance attenuation; the mix ducks for dialogue and key events.

---

## 16. Shops, economy and property

### 16.1 Enterable shops

Each has a distinct minimap icon.

| Shop | Function |
|---|---|
| Weapon shop | Firearms, melee, ammunition and attachments; licence tiers and a back room |
| Vehicle workshop | Repair, respray to shed heat, modification |
| Convenience store | Food and health; robbable |
| Clothing | Appearance; a change of clothes reduces recognition |
| Clinic / needle exchange | Health, and the harm-reduction content |
| Property broker | Safehouse purchase |

Storefronts you cannot enter still work as robbery targets and scenery.

### 16.2 Contraband trading

District-to-district trading is the economic spine, in the Chinatown Wars tradition.

- Prices drift per district over time, driven by wealth, character and demand.
- Dealers move; market shocks cause sudden swings.
- Faction reputation affects who will trade with you and at what price.
- Trading is one income stream alongside missions, theft, jobs and robberies.

### 16.3 Safehouses

- Purchasable properties across the map, priced by district.
- Each provides saving, a stash, a garage and a respawn point. The active safehouse is where you
  respawn after death or arrest.

### 16.4 Saving

- Local browser saves, one per seed, plus export and import via clipboard so a save moves between
  machines.
- No accounts, no backend.
- Saved: seed, character, time of day, money, health, position, visited metro stations, weapons,
  attachments and ammo, inventory, district market state, faction reputation, mission progress,
  safehouses and their contents, territory control.

---

## 17. Factions and territory

Eight factions. Each is defined first by what it trades, where it holds and how it fights; culture
is the flavour — names, architecture, signage, food, music, cars — never the whole character. Satire
is aimed evenly at all of them.

### 17.1 Roster

| Faction | Home turf | Business | Style | Offers the player |
|---|---|---|---|---|
| The Family (Italian) | Little Italy, inner district | Protection, waste hauling, restaurants, gambling, union graft | Saloons, suits, shotguns and pistols; slow to anger, ruthless once moved | Protection and collection work, respray discounts |
| The Syndicate (Chinatown) | Chinatown, inner district | Import/export, counterfeits, gambling dens, night markets | Vans and compacts, SMGs and blades; disciplined, numerous | The best contraband prices in the city |
| The Bratva (East European) | Freight yards, industrial zone | Car theft rings, chop shops, arms, export via the harbour | Stolen luxury cars, rifles; heavy and direct | Theft and export jobs, the widest weapon catalogue |
| Los Reyes (Latin American) | The Barrio, inner district bordering industrial | Street distribution, illegal racing, custom cars | Lowriders and tuned coupes, murals, pistols; fast and loud | Street races, courier runs, vehicle mods |
| The Crew (African-American) | The Blocks, inner district beside the core | Corner-level trade, music, cars | Saloons and SUVs, pistols and SMGs; territorial, mobile | Territory work, quick sales, tips on police movements |
| The Iron Saints (outlaw MC) | Outskirts roadhouses and filling stations, dirt roads | Meth, gun running, highway robbery | Motorcycles and pickups, shotguns; hit and run | Wilderness jobs, off-road vehicles |
| The Docklands Mob (Irish) | The docks and the island district | Port labour, smuggling, politics, "legitimate" property | Vans and older saloons, pistols and bats; connected and patient | Smuggling runs, cheaper property |
| Unit 13 (corrupt police) | None — operates city-wide | Bribes, protection, evidence, information | Unmarked cars, service weapons; untouchable until crossed | Heat reduction for cash, intel, dirty jobs |

Unit 13 holds no territory but has full reputation. High standing buys heat off; low standing turns
routine stops into ambushes.

### 17.2 Territory

- Territorial factions hold capturable, defendable territory with visible boundaries on the map,
  seeded from their home district and spreading over time.
- Capturing territory triggers retaliation waves.
- Held territory yields income, safe passage and access to that faction's shops and dealers.

### 17.3 Reputation

Per-faction reputation determines who shoots on sight, who trades and at what price, and who offers
work. Helping one faction against another moves both. Wearing a faction's colours (clothing shop)
shifts how its rivals react.

---

## 18. Missions

- An authored spine: a short hand-written main chain with multiple givers, branching and fail
  states, anchored to whatever the seed produced.
- Generated side work: an endless supply of procedurally assembled jobs built from the seeded world
  and the faction roster.
- Types: deliveries, thefts, pursuits, protection, sabotage, races, territory work.

---

## 19. Harm reduction

Real harm-reduction information delivered in-world, without pausing the game or breaking tone:

- Radio PSAs between songs.
- Posters and billboards in the appropriate districts.
- The clinic / needle exchange, with its own minimap icon.

The content is factual and non-judgemental and is presented as part of the world's texture — which,
in a genre normally silent on the subject, is the satire. Never a modal, never a lecture, never
blocks play.

---

## 20. The living city

### 20.1 Crowds and street life

- Crowds react: pedestrians flee gunfire, scatter from a car on the pavement, ring crashes and film
  them, shout at bad driving, jaywalk and misjudge gaps.
- Occupied corners: buskers with audible music, food carts with steam, market stalls, queues outside
  clubs, smokers outside bars, dog walkers, people on stoops. Corner culture follows the
  neighbourhood.
- Beach life: sunbathers on towels, swimmers, volleyball games, joggers and skaters on the
  boardwalk, lifeguard towers, ice-cream and cocktail stands, surfers when the swell is up, bonfires
  and parties after dark. All of it thins out in rain and empties in storms.
- Working shopfronts: silhouettes behind lit windows, shops opening and shuttering on schedule, neon
  that buzzes and flickers, TVs glowing in flats, laundry and AC units on facades.
- Daily routines: commuting, districts filling and emptying by time of day, nightlife after dark.

### 20.2 Traffic with character

- Drivers with personalities: indicators, honking, tailgating, running ambers, road rage, hesitation
  at junctions, self-inflicted accidents.
- Vehicles with jobs: buses on real routes with stops and passengers, taxis picking up fares,
  delivery trucks unloading with hazards on, garbage trucks, street sweepers, tow trucks removing
  your wrecks.
- Parking that behaves: cars parallel-park and pull out, car parks fill and empty by time of day,
  illegally parked cars are ticketed and towed, an abandoned car is still there when you return.

### 20.3 Emergency services and fire

- Police, ambulances and fire engines respond to what happens — crashes, fires, shootings — routing
  there over the road graph.
- Fire spreads from burning vehicles to nearby vehicles and flammable scenery.
- Smoke, embers and heat haze as instanced billboard particles.

### 20.4 Wildlife

Seagulls near water and swarming the beach for dropped food, crabs on the sand, stray cats in
alleys, rats at night, deer and hawks in the wilderness.

### 20.5 A world with its own life

- Emergent street crime: muggings you can interrupt, faction shootouts, drug deals you can rob,
  police pulling over drivers, shoplifters running from stores.
- Scheduled events: rush-hour gridlock, night markets in Chinatown, illegal street races after
  midnight from the Barrio, parades or protests that close roads, stadium crowds surging out,
  weekend beach crowds and a summer beach party on the pier.

Construction sites, roadworks and urban decay were considered and excluded.

---

## 21. Multiplayer

### 21.1 Requirements

- Peer-to-peer over WebRTC via Trystero.
- Signalling through Trystero's Nostr strategy, falling back to MQTT if no relay answers within a
  timeout. No server is deployed or paid for by anyone.
- Started from the pause menu with Open game to others.
- 4–6 players.

### 21.2 Flow

1. The host clicks Open game to others. A room code is generated and a copyable invite link
   containing both seed and room is shown.
2. Joiners open the link, which loads the seed and joins the room.
3. Seed mismatch is refused at handshake. Two players are never in different cities.
4. Single-player is fully offline: the networking module is lazily imported and nothing connects
   until the button is pressed.
5. If networking fails or every peer leaves, the game degrades to single-player without a reload.

### 21.3 Mode

Free roam plus optional competitive modes. Everyone drops into the same seeded city and sees each
other drive, fight and cause chaos. Each player keeps their own money, missions, reputation and
progress; the world is shared, careers are not. Any peer can start a race, deathmatch or territory
contest on the fly.

Territory in a session is one shared map, owned by the host. Captures are visible to everyone for
the duration of the session and are not written to anyone's save. When you leave, your single-player
territory state is as you left it.

### 21.4 Authority

Peers compute the world themselves from the shared seed and a shared tick. The network carries only
what cannot be derived.

- Shared clock. The host broadcasts the authoritative tick; joiners lock to it on handshake, so all
  peers evaluate `(seed, tick)` identically and see the same ambient world without any of it
  crossing the wire.
- The host owns divergence. Promoted actors, wrecks, fires, active police units and mission entities
  are authoritative on the host and replicated as deltas.
- Each player owns themselves. Every peer has final authority over its own vehicle and character, so
  your own driving never lags. Inputs are broadcast so others can predict between updates.
- Correction snapshots. The host periodically broadcasts compact checkpoints of divergence-prone
  state; a drifted peer snaps to them. Cheap, because the deterministic majority of the world never
  needs correcting.
- Host migration. If the host leaves, the peer with the lowest peer id takes over. Only the
  divergence set needs transferring; play continues without a visible break.

### 21.5 Budget

- The host's frame rate is protected. Simulation and broadcast load are capped; distant-entity
  detail is reduced before frame rate is.
- Interest management: peers receive detailed updates only for nearby entities.
- Player state at a fixed rate as compact typed arrays; world updates as deltas; one-shot events
  reliably.
- Remote players render through a short interpolation buffer with dead reckoning, so packet loss
  shows as smoothing, not teleporting.
- Friendly fire is on.

---

## 22. three.js addon adoption

Maximise coverage, subject to the veto that no feature exists purely to justify an addon.

### 22.1 In use

| Addon | Serves |
|---|---|
| `WebGPURenderer` | Rendering |
| `PostProcessing` with bloom, SMAA and `Lut3DNode` | Post-processing; the LUT carries the per-time-of-day and weather colour grade |
| `generators/city/SkyscraperGenerator`, `SidewalkGenerator` | Buildings, kerbs and pavements |
| `generators/TerrainGenerator`, `TreeGenerator`, `ForestGenerator` | Heightfield, trees, forests |
| `LoftGeometry` | Road surfaces, kerbs, tram rails, bridge decks and tunnels swept along the tensor-field curves |
| `MeshSurfaceSampler` | Scattering vegetation and ground detail across parcels |
| `BatchedMesh` and instancing | Draw-call budget, GPU-side per-instance culling |
| `SkinnedMesh` with `AnimationClipCreator`, instanced skinning | Animated pedestrians with moving limbs, in few draws |
| `DecalGeometry` | Skid marks, bullet holes, blood, road stains, graffiti |
| `ClippingGroup` | Enterable shops: roof and front wall clipped away when the player is inside |
| `Bayer` dither | Per-instance near-camera fade without transparency sorting |
| `Line2` | Road markings and map rendering |
| Water addons | River, harbour, sea |
| Sky addon | Day/night sky |
| CSM shadows | Sun shadows, one or two cascades |
| Clustered lighting | Dense night lighting under a hard light cap |
| `ProjectorLightNode` | Headlight and street-lamp cones |
| `RectAreaLight` | Signage and neon |
| `WoodNodeMaterial` | Pier, boardwalk, jetties, benches, bats |
| `SimplifyModifier`, geometry compression | LOD tiers |
| `CSS2DRenderer` | World-anchored labels |
| `SortUtils` | Stable sorting in simulation and render ordering |
| `WorkerPool` | Off-thread chunk generation |
| `BufferGeometryUtils` | Geometry merging and helpers |

### 22.2 To evaluate

| Addon | Question |
|---|---|
| `TRAANode` / `TAAUNode` | Does temporal AA with upscaling beat SMAA plus render scale on integrated graphics? |
| `TileShadowNode` | Does tiled shadowing beat CSM for the small fixed top-down view? |
| `Raymarching` with `curlNoise`, or `MarchingCubes` | Which gives volumetric smoke, fire and fog banks within budget? |
| `SSRNode` | Screen-space reflections for wet roads and puddles |
| `ImportanceSampledEnvironment` | Sky-driven reflections on wet roads and car paint, if SSR does not cover it |
| `TessellateModifier` | Vertex-displacement dents for progressive vehicle damage, if vertex counts fit the instancing plan |
| `CCDIKSolver` | Foot IK on slopes and kerbs for pedestrians, if the budget allows |
| `TransitionNode` | Metro fast-travel and death/arrest transitions |
| `CurveModifier` | Road-aligned geometry where `LoftGeometry` does not fit |
| `SceneOptimizer` | Automatic scene-level batching |

---

## Appendix A — WebGPU notes

Informational: platform constraints that shape the implementation.

- `ShaderMaterial`, `onBeforeCompile()` and `EffectComposer` do not work on `WebGPURenderer`. Custom
  shading uses TSL node materials; post-processing uses the `PostProcessing` class. The city and
  terrain generators are themselves written against `three/webgpu` and `three/tsl`.
- Chained TSL math can fail `tsc` even when it runs. Route TSL helpers through one loosely typed
  wrapper module to keep the typecheck gate green without weakening typing elsewhere.
- Ambient-occlusion passes need a non-multisampled depth buffer. Irrelevant unless post-processing
  is revisited.
