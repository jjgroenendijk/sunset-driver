# Weather

The gotchas of the weather of spec section 13.4: what it is, what it changes, and what the frames
caught that the code did not. `src/sim/weather.ts` is the model, `src/render/weather-look.ts` the
light it bends and `src/render/weather-fx.ts` the rain, the puddles and the litter.

## Contents

- The model
- The look
- What the frames caught

## The model

- `src/sim/weather.ts` is the weather of spec section 13.4, and it is a pure function of the seed
  and the tick: nothing is kept, nothing is saved, and a save carries the tick so it carries the
  weather. The day is cut into spells of `SPELL_TICKS` — two game hours — and each spell draws its
  kind and its strength from its own stream. A spell hands over to the next across `TURN_TICKS`, so
  nothing on screen or under the tyres jumps.
- Wetness is the one quantity with a memory, and it still holds no state: `wetnessAt` reads the rain
  of the last `WET_HORIZON` ticks backwards and weights each sample by how long ago it fell. So a
  session joined at any tick sees the same puddles as one that watched it rain, and a replay drives
  on the same water. Nothing integrates, which is what makes that true.
- `physics.ts` hands `weatherAt(seed, tick).wetness` to the wheels every step, and `gripOf` in
  `vehicle.ts` is where it lands: a road under standing water keeps `WET_GRIP` of what it had. That
  is the whole of what weather does to the handling; nothing else reads the wetness.
- A test that drives a car flat out over a hillside is now a test of the weather as well. Full
  throttle on a wet hill launches the car and the crash that follows is the rain doing its job, so
  a test about something else should drive at a speed that keeps the wheels down.
- `outInThis(id, share)` is the hook of "storms empty the streets". The ambient traffic and the
  ambient crowd are laid out once from the seed and never rebuilt, so weather cannot take anyone off
  the street; it decides who is drawn.

## The look

- `weather-look.ts` says what the weather looks like. `overcast(light, weather)` bends the
  `Daylight` the day gave — the sun drops behind cloud, the fill rises to take its place, the haze
  goes grey and the street lamps come on early — and `WorldScene.apply` hands the bent light to the
  sky, the water, the windows and the lamps. Nothing downstream knows the weather: it reads the
  same `Daylight` it always read.
- `fogRange(near, far, weather)` is how fog cuts the draw distance. The camera of spec section 10.7
  sees the ground from about 15 m in front of it out to about 60, and the far streaming ring stands
  at 750 m, so pulling the ring in by a share of itself cuts the distance where nobody is looking.
  The two ends are brought in geometrically instead, and only past `FOG_ONSET`, so a shower leaves
  the street alone and fog closes it to 15 m and 70 m.
- `WeatherFx` (`weather-fx.ts`) is the rain, the puddles and the litter: three instanced batches,
  three draw calls, every piece placed from its own index and the tick and nothing held between
  frames. The pieces stand on a lattice in world space rather than at an offset from the player, or
  the whole curtain slides along with the car and reads as a windscreen.
- `TrafficView.share` and `PedestrianView.share` are where `Weather.crowd` reaches the two views,
  and `outInThis` is what each of them asks per id.

## What the frames caught

- A puddle is placed at the height of the carve, and everything it is drawn on stands over that
  carve: the carriageway by `SURFACE_RAISE`, the kerb by `KERB_RISE` more. `PUDDLE_LIFT` clears the
  tallest of them. The first draft lifted a puddle 2.5 cm and every disc was inside the road, which
  looks exactly like a puddle nobody built.
- The scene carries no environment map, so a smooth metal disc reflects nothing and a puddle comes
  out black on black asphalt: three.js throws image-based light off an environment, and a hemisphere
  light is not one. A puddle reads from straight above by its colour, a pale sheet of sky over a
  dark road, and not by its reflection.
- Take the frame before judging any of this: `node scripts/render-preview.ts <seed> out.png
  --hour=N`, with an hour whose weather you have read off `weatherAt` first. Neither mistake above
  was visible in the code, and both cost a render each to find.
