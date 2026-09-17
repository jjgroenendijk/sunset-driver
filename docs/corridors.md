# Corridors

The corridors of spec section 6.3, the piers under the decks and the tram of spec section 13.2: how
they are laid in `src/world`, and how `src/render` draws them.

## Laying them

- `buildCorridors(world, roads, graph)` (`corridors.ts`) lays the corridors and the tram route. It
  is the last step of `generateWorld`, and the only place that builds the graph during generation.
  A corridor claims its ground at the moment it is laid (`corridor-claims.ts`): a strip is claimed
  segment by segment, ground within `CLAIM_CLEARANCE` of a claimed strip is not free, and a run
  that meets claimed ground is cut and continues past it. Two corridors therefore cannot overlap,
  and the sweep only confirms it. The tram claims first, so a deck over its lane gives way. A line
  that turns more than `MAX_BEND` is cut at the turn, because a strip carried round a corner that
  sharp folds over itself.
- A corridor claims no ground where its centreline stands over water, whatever its kind: there is
  nothing under it to claim. The tram is what needs that rule, since its lane runs down the middle
  of an arterial and an arterial crosses a strait on a deck.
- An elevated corridor is the ground under a deck that stands over land; a deck over water owns
  nothing. A tram corridor is the reserved lane, down the middle of an arterial from one stop to
  the next. `TRAM_LANE` (`tiers.ts`) is its width and the track inside it. `world.tram` holds the
  line the tram drives, its stops, and the level crossings where another road meets it.
- One stop per core and inner district, at the nearest junction of the largest run of arterial. Two
  districts never share a stop: the second of them goes without. Where the districts crowd round one
  or two junctions that leaves fewer stops than a loop needs, and the seed gets no tram at all, so
  the districts are asked a second time, each taking the nearest junction still free (issue #373).
- The ground under a deck is not footprint. `buildFootprint` takes only the tram's lane, and
  `buildParcels` splits the land the roads leave by the elevated corridors first. What falls inside
  one is an `under-structure` parcel, kept whole. A road that passes under the deck is footprint,
  and it cuts the strip into a parcel each side of it. A parcel no road reaches is dropped, as
  everywhere.

## Piers

- `deckPiers(world)` (`piers.ts`) is every pier, built on demand like the footprint. Over land a
  foot is one of the `pillars` of the deck's elevated corridor, which `corridors.ts` places when it
  claims the strip; over water `deckPiers` places the feet itself, where the natural ground is
  under the sea. Both use `pierFeet`: a pair across the deck at each bay of about 25 m, drawn in
  towards the centreline until the foot stands.
- No foot stands on the ground a road claims (`RoadGround`), other than the deck's own curve. A pier
  in the middle of the street that passes under a deck is one the traffic drives into.
- A pier carries the segment it stands under and how far `across` that segment it stands, measured
  as a road frame measures across. The renderer needs both to find the underside of the deck.

## The tram track

- `tramTrack(world, graph)` (`tram-track.ts`) marks the curve segments the graph runs of
  `world.tram.edges` cover. Each level crossing is given the direction of the track through it, from
  the run that arrives at its node and the run that leaves it.
- `ChunkSource` cuts the track into `chunk.tram` the way it cuts the roads, but with no junction
  gaps: the rails carry on across a junction. `chunk.tramCrossings` and `chunk.piers` are the ones
  whose point stands in the chunk, and a pier carries the carved ground under its foot.

## Drawing them

- `buildChunkCorridors` (`corridor-mesh.ts`) builds the corridor parts of a chunk, and
  `buildChunkRoads` puts each part into the tier batch it belongs to: a pier into the tier of its
  deck, the track and a crossing into the tier of the road under them. So the corridors cost no draw
  call of their own. `roadDrawCalls` still counts a tier that holds only a pier or a track, so
  `chunkDrawCalls` stays the most a chunk can cost.
- The material tells the parts apart by `kind` (`road-section.ts`): `SURFACE_STRUCTURE` for a pier,
  `SURFACE_TRAM_LANE`, `SURFACE_RAIL` and `SURFACE_CROSSING`. The kinds are whole numbers and
  `road-material.ts` picks each out with a pair of steps; a `mix` on the raw kind would blend the
  colours of two kinds.
- A pier is a column from `PIER_FOOTING` under the carved ground up into the deck: the frame height
  at the foot, less `SKIRT` and `DECK_DEPTH`, which is where `road-mesh.ts` sweeps the underside of
  the deck. A deck too low over the ground for a column, at the foot of a ramp, draws none.
- The lane and the rails are swept in the frames of the road under them (`piecesOf`), so they lie
  on the road on the ground, through a junction and over a deck alike. The lane stands over the
  paint, and `buildChunkRoads` lays no marking inside the lane on a segment the track runs down:
  a `LineSegments2` line shows through a surface a few millimetres over it.
- The far ring keeps the piers of its own tiers and draws no track.
- The game camera is pitched at 58°, so a pier under a wide deck shows only near the top of the
  frame. Stand the player about 30 m from a deck on its +y side, with `--distance=55`, to look at
  one: the camera looks towards -y.
- A strait deck stands about 1 m over the sea, so its underside is under the water and the piers
  below it cannot be seen (#304). The elevated highways stand high enough to show theirs.
