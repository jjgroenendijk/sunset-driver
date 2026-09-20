# Framing a subject

What to run to see one thing. Every command writes a PNG; read it back with the Read tool.
`docs/dev-tooling.md` holds the full flag list and what each tool is for.

## Contents

- Where the camera stands
- A vehicle
- The player on foot
- A weapon
- People in the street
- A crash and the services
- A shop interior
- The tram
- Where in the world
- The hour, the night and the sky
- The map the player reads
- The world under the game
- Many seeds at once
- When it is slow

## Where the camera stands

Top down, the camera always stands south of what it frames, at greater `y`, and looks north. A
wall facing any other way is seen edge-on or not at all, so turn the subject with `--heading`
rather than looking for a flag that moves the camera round it. A chase view instead sits behind
the heading, so `--heading` swings the camera and the subject together and the framing does not
change.

- `--view=top-down|third-person|first-person` is the view of spec section 10.7. Default top-down.
- `--distance` is how far back it sits, `--heading` which way the player faces in degrees.
- `--look-at=x,y,height` frames a place instead of the player, keeping pitch, heading and distance.
- `--buildings=whole` stops a building in the way being ghosted, which is how the building the
  player stands at is looked at.
- `--width` and `--height` set the size of the picture, `--quality=full|high|medium|low` the tier.

## A vehicle

```
node scripts/render-preview.ts sunset car.png --vehicle=sports --view=third-person --distance=14
```

`--vehicle=<class>` is one of `compact`, `saloon`, `sports`, `van`, `truck`, `bus`, `motorcycle`,
`offroad`, `buggy`, `emergency`, `boat`. Add `--damage=dented|smoking|burning|burnt` to see it hurt,
`--skid` to lay a drift's marks into the road behind it, and `--speed` to set how fast it moves.

## The player on foot

`--on-foot` stands the player beside the vehicle rather than in it.

```
node scripts/render-preview.ts sunset walk.png --on-foot --stance=walk --distance=12
```

`--stance=stand|walk|air|swim` holds one stance for the still; the frame is taken a quarter of the
way through the cycle, where the swing is widest.

## A weapon

```
node scripts/render-preview.ts sunset gun.png --on-foot --weapon=ak-47 --aim --distance=10
```

Leave the view top-down for this. A chase view sits behind the player whatever `--heading` says,
so it draws their back and hides what is in their hands.

- `--weapon=<id>` puts it in the hands, `--attachments=suppressor+optic` fits what it takes.
- `--aim` holds it at the shoulder.
- `--swing=0.4` is the moment a melee blow lands; the swing runs 0 to 1 and lays over `--stance`.
- `--pickups` lays the whole arsenal in rows below the player, for comparing silhouettes, and
  `--hover=N` draws the N-th of them grown, as the pickup under the mouse is.
- `--shots` puts a shotgun blast and a pistol round in the air, with flash, streaks and impacts.

## People in the street

```
node scripts/render-preview.ts 7 people.png --bodies --heading=180 --distance=26
```

- `--bodies` lays casualties ahead: two dead, one with cash, and one each falling, rising,
  crawling, limping and thrown.
- `--police` lays a patrol pair, a SWAT officer aiming, an officer on a beat and one fallen.
- `--contacts` stands the seed's own mission contacts on their corners under their markers, and
  takes the picture at the nearest one. `--on-foot --distance=16` frames one.
- The traffic and the crowd need no flag. They are in every frame, and the run counts them.

## A crash and the services

```
node scripts/render-preview.ts 7 fire.png --emergency --junction=60
```

A blaze in the road, a fire engine hosing it, an ambulance behind the player. With `--bodies` the
medics kneel at the body nearest the ambulance. They are put down rather than driven to: a preview
is one frame and a call takes the best part of a minute.

## A shop interior

```
node scripts/render-preview.ts sunset shop.png --shop=weapons --distance=22
```

`--shop=weapons|workshop|convenience|clothing|clinic|broker|any` is the one way to see an interior.
It moves the frame off `--x` and `--y` to the nearest such shop, and the line it prints says where
it ended up. A room is about 7 m across, so `--distance=22` is the frame that holds it.

## The tram

`--tram` stands the player beside the first tram at the hour of the picture. `--stop=N` stands them
at the N-th stop, where the queue waits. Either overrides `--x`, `--y` and `--junction`.

## Where in the world

- `--x` and `--y` are where the player stands, in metres. The default is the spawn.
- `--junction=N` stands them at the N-th junction out from the core and prints what meets there.
  `--tiers=arterial+street` narrows that count to junctions of that mix.
- A new place costs 1 to 3 seconds of chunks; the same place again is a quarter of a second.

## The hour, the night and the sky

`--hour=0` to `24` lights the frame. `--hour=20` is lit windows, street lamps and headlights;
`--hour=12` is the shadow test. The game camera never looks at the sky, so `--look-up=<degrees>`
with `--view=third-person` is how the clouds and the bloom are judged.

## The map the player reads

```
node scripts/map-preview.ts sunset map.png --turf --day=8
```

It draws the map of spec section 12 on a 2D canvas, so it needs no WebGPU device.

- `--x`, `--y` are the middle, `--scale` metres to the pixel: 4 is the full map, 1.1 the minimap.
- `--minimap` draws the round minimap window instead, `--rotate` turns it so the player faces up,
  and `--heading` says which way that is.
- `--waypoint=x,y` marks a place. `--turf` washes the factions' turf over the land, and `--day=N`
  is the game day it is read on, since it spreads.

## The world under the game

- `node scripts/world-preview.ts <seed> out.png` draws the world description flat: roads by tier,
  corridors, beaches, parcels and building lots. `--tiers=highway+arterial` draws those tiers alone.
- `node scripts/landuse-preview.ts <seed> out.png` draws a few hundred metres close up and prints
  the shares of road, parcel and building the tests hold to a band. `--half`, `--x`, `--y` and
  `--width` say how much ground and where.

## Many seeds at once

- `node scripts/terrain-sheet.ts 24 sheet.png` — terrain only, no roads. 80 seeds in about 20 s.
- `node scripts/render-sheet.ts 4 sheet.png` — rendered frames, about 22 s for four tiles.
  `--seeds=7,9` names the seeds a failure named. A tile is too small to judge a shadow edge in;
  take a full frame for that.

## When it is slow

`--fast` waits for the near ring of chunks only, saving about a second of a new seed, at the cost
of the far edge of the view. `--quality=low` draws the cheapest tier. `--software` draws on
SwiftShader, which takes minutes, and is only for reproducing what CI sees.
