# Audio

The gotchas of `src/audio`: the engine, the sirens, the impacts and the footsteps of spec section
15. Everything is synthesised with Tone.js at runtime, because spec section 1.2 forbids audio files.

## Contents

- The split, and why it is there
- The engine has a gearbox the physics does not
- Cues, and what a frame is allowed to fire
- The hurt: cries, thumps and falling bodies
- The radio, and how a bar gets played
- The score over the radio
- The ambient beds, and where a place comes from
- The buses and the duck
- The gesture and the mute
- Traps

## The split, and why it is there

- `src/audio` is two halves and one door. `plan.ts`, `engine.ts`, `space.ts`, `cue.ts`, `cry.ts`,
  `hurt.ts`, `police-ears.ts`, `ambience.ts` and `site.ts` hold no Tone.js and no DOM: they read the
  record and answer an `AudioPlan`. `voices.ts`, `one-shots.ts`, `cries.ts`, `beds.ts` and
  `mixer.ts` own the Web Audio node graph and play that plan. `game-audio.ts` is the door `main.ts`
  holds.
- The split is what lets `test/audio.test.ts` run in Node. A rule that decides whether a sound
  happens belongs in the pure half; a rule about how it sounds belongs in the other. When adding
  something, put the decision in `plan.ts` and let the mixer take it as given.
- `frame.ts` calls `audio.update(state, input, listener)` once a frame with the **drawn** player
  position, not the last tick's, so the mix stands where the picture does. A paused session gets
  `hush()` instead.

## The engine has a gearbox the physics does not

- `sim/vehicle.ts` has no RPM, and it should not: the drivetrain puts a force through the wheels and
  reads a speed back. `engine.ts` is where the gearbox lives, and it exists only to be heard.
  Nothing in it can reach the simulation.
- The box is geometric: first gear reaches `FIRST_GEAR` of the top speed and every gear after it is
  the same ratio longer, so each change sounds like the last. `GEARS` is a count per class of spec
  section 11.3, and a boat has one — direct drive.
- `enginePitch` shifts the whole note by the roster's own mass, so a bus rumbles and a buggy buzzes
  with nothing written down per class. Add a vehicle and its engine is already pitched.
- The engine is the player's own vehicle and nothing else. No ambient car has an engine of its own:
  the traffic is heard as the hum of the bed below, which is the whole street at once.

## Cues, and what a frame is allowed to fire

- A one-shot is decided by a **difference between two frames**, never by an event, because the
  simulation raises none. A collision is the vehicle's integrity falling by `IMPACT_MIN`, a shot is
  `loadout.shots` rising, an explosion is `damage.blownTick` changing. That means a record which
  jumps looks exactly like a crash and a volley: call `AudioPlanner.resync` after a load, a respawn
  or a metro trip. `frame.ts` already does, and forgetting it is the loudest bug in this directory.
- Footfalls are paced by the ground covered, not by the clock, so a sprint quickens on its own and
  standing still takes no step.
- A blow of a melee weapon is the one cue read off a list rather than off a difference: `state.hits`
  carries what a swing struck for a few ticks (`src/sim/melee.ts`), and the planner fires a cue for
  every hit newer than the tick it last heard. `HIT_CUES` maps what was struck onto the sound —
  `thud` for a body, `clang` for a panel, `knock` for a wall — and the place in the list is part of
  the stream the pitch is jittered from, so a swing through a crowd is a run of knocks and not one
  knock played over. `swing` is the whoosh of the weapon itself, and it is fired whether or not the
  blow landed.
- A tram's bell is the one cue that is not in the record at all: `TramLine.bells(tick)` is a
  function of the tick (spec section 13.2), so the planner is handed the line itself through
  `GameAudio.watch` and asks it about **every tick the frame stepped**. Asking only about the tick
  the frame landed on drops about half the bells at the frame rate the game is written for.
- `CUES_PER_FRAME` caps what one frame may fire, and `VOICE_CAP` caps what the bank holds. A cue
  that finds no free voice is **dropped, never stolen**: stealing would restart an oscillator that
  is still scheduled to stop, and Tone.js refuses a start before a pending stop.
- The cap is the CPU budget of spec section 15. `Mixer.dropped` counts what it cost.

## The hurt: cries, thumps and falling bodies

- `hurt.ts` reads the people of spec section 13.1 who are hurt, and `test/audio-hurt.test.ts`
  holds its rules. Every sound is read off a tick in the record, the way a blow is: a hit is the
  casualty's `since`, a round is its tracer's tick, a landing is `landingOf(record).tick`. So a
  frame hears the ticks it stepped over, and nothing twice.
- A record is replaced on every hit, so a new `since` is a new hit. The dying make a short `death`
  cry that is cut off, a person knocked down `scream`s, and a stagger is a short cry of `pain`.
  A body hit again makes a new record too, so `HurtEars` keeps the ids that were already dead.
- A thrown body lands on the first tick `casualtyPose` no longer calls it `air`. A body knocked
  over from standing lands at the end of its `fall`, at `FALL_STRENGTH`. A stagger never lands.
- A car strike writes a `person` hit like a fist does. Nobody swings from behind a wheel, so a
  `person` hit while the player drives is the car's: a `thump` and a `crunch`, not a `thud`.
- A round whose tracer ends in `person` is a `flesh` slap where it went in.
- `PANIC_MIN` people fleeing on one tick within `PANIC_REACH` make `PANIC_VOICES` quieter,
  duller `panic` cries, a moment apart. Which of them cry and when is drawn from the tick and the
  ids. The wounded on the ground `moan` at `MOAN_RATE`, drawn per tick as a bird's call is.
- Cries are not cues. They go into `AudioPlan.cries`, capped at `CRIES_PER_FRAME`, and `cries.ts`
  holds `CRY_VOICES` of them. A cry that finds no free voice is dropped, as a cue is.
- A cry is a formant voice (`cry.ts`): a sawtooth through three band-pass filters at the formants
  of 'a' or 'o', with pink noise for breath and a low-pass that dulls it with the distance. The
  pitch is a curve of the plan's making — contour, vibrato and wobble — laid on the oscillator with
  `setValueCurveAtTime`. An LFO connected to a Tone.js frequency would replace the value, not add.
- A person's voice is `voiceOf(seed, id)`: low or high, and its own pitch, vibrato and length. A
  scream strains that to two or three times the speaking pitch, as a real one does.

## The radio, and how a bar gets played

- The dial is one number per vehicle in the record (`VehicleState.station`) and nothing else. It is
  unbounded there on purpose: how many stations there are is no business of `src/sim`, so
  `dial.ts` wraps it and Off is a position on the dial after the last station, the way a car
  radio's is. A stolen car comes with its owner's station because the number belongs to the vehicle.
- `stations.ts` is the whole of what makes two stations sound unlike each other: the key, the mode,
  the tempo, the chords, the drum feel and the waveforms. Every culture of spec section 8.3 has a
  station and `Sunset FM` covers the rest. Adding a station is a row there and nothing else.
- `song.ts` turns a bar of a station's song into notes, seeded on the session, the station, the song
  and the bar — so a bar is a pure function of its number. The tune leans on a note of the chord on
  every strong beat and walks the mode between them, which is what keeps a generated melody from
  wandering into a wrong note.
- **A station's bar is read off the simulation tick** (`dialAt`), so every station is always
  playing: tuning away and back finds the station where it would have been, and a paused game stops
  the music with the city rather than running on under it.
- The band is scheduled, not played now. `plan.ts` says which bar is next and how many seconds away
  it is; `radio.ts` hands the whole bar to the instruments at absolute context times once it is
  within `LOOKAHEAD`. That is the one place in `src/audio` where the audio clock and the game clock
  meet, and `dial.ts` is what keeps them from drifting.
- `programme.ts` is the schedule: a song, then a break of the station's ident, and every
  `PSA_EVERY` songs one of the harm-reduction announcements of spec section 19 (`psa.ts`). Nothing
  synthesises a voice, so an announcement is a line on the HUD over a bed of the station's chords
  and drums. The posters of section 19 are `src/render/poster-art.ts` and what the clinic hands
  out free is `src/sim/shop-stock.ts`.

## The score over the radio

- `score.ts` reads the heat of spec section 14 and how near the nearest unit is, and answers a mood.
  Calm leaves the radio alone, a chase lays a pulse over it and pulls it down to `RADIO_UNDER`, and
  a fight takes the radio off altogether — the "layered over or replacing" of spec section 15.
- The score holds rather than being scheduled, so it is a drone with an LFO beating on its gain:
  the faster and brighter it beats, the worse the trouble. A fight adds a tritone, which is the
  interval that agrees with nothing.
- The mood is read fresh every frame off the record, so nothing has to be told when a chase starts
  or ends.

## The ambient beds, and where a place comes from

- A bed is the place itself: the hum of a city, surf, wind and rain (spec section 15). Nothing in
  the record says what a place sounds like, so `ambience.ts` reads it off three numbers — how built
  up, how green and how near the sea it is — with the weather of spec section 13.4 and the hour.
  `site.ts` answers those three from the world description; `beds.ts` is the noise.
- The beds crossfade over `BED_RAMP`, which is far longer than the `RAMP` the rest of the mix uses.
  That is the crossfade on movement: walking downtown to the beach takes about a second and a half,
  so neither bed is heard to switch.
- Birds and gulls are **not** beds. A call is a one-shot with silence after it, so `plan.ts` draws
  one per tick from a rate `ambience.ts` gives it, over every tick the frame stepped — the same rule
  the tram bells follow, and for the same reason. Calls are pushed last, so a frame at
  `CUES_PER_FRAME` drops a bird rather than a gunshot.
- Sampling a site walks every beach point of the map, so `WorldSites` keeps its last answer until
  the player has moved `RESAMPLE` metres. The beds ramp over more than a second either way, so the
  step is never heard.
- A session whose audio was never given a world has no place, and so no beds at all. That is what
  `GameAudio.survey` is for, and forgetting it in `main.ts` is a silent city with working gunfire.

## The buses and the duck

- Four buses meet at the master: `music` — the radio and the score — `effects`, the player's engine
  on its own, and the ambient beds. A limiter sits on the master, so nothing a stacked explosion
  does can clip the output.
- The beds are on their own bus because they must not duck: a city does not stop humming because
  somebody fired a gun in it.
- `music` is what ducks. A cue whose row in `CUES` says `ducks` pulls it down by `DUCK_DEPTH` and it
  climbs back over `DUCK_RECOVER`, so a run of shots holds one hole open instead of reopening it.
- Siren voices follow **units**, not places in the list. A voice keeps the unit it was given while
  that unit is still one of the nearest, so a second car joining a chase does not make the first
  one's siren change pitch.
- Every parameter is ramped over `RAMP`, never set. A jump between two frames' values is a click.

## The gesture and the mute

- A browser gives no audio context until the player has touched the page, so `GameAudio.arm` waits
  for a `pointerdown` or a `keydown` and calls Tone's `start` from inside it. The listener stays
  attached until a gesture really starts the context.
- Muted means **no graph at all**, not a gain of zero: the mixer is disposed of and rebuilt on the
  next unmuted frame. Spec section 15 asks that nothing be synthesised when muted, and a silent
  oscillator is still an oscillator.
- The setting lives in `ui/settings.ts` beside the camera one. It is the Sound checkbox of the
  Options column (`ui/title-settings.ts`), which the title screen and the pause menu both show.

## Traps

- Tone's `Oscillator` and `Noise` are sources with a state timeline. Starting one before a stop that
  is already scheduled throws, which is why `one-shots.ts` only lends out a voice whose `busyUntil`
  has passed.
- `exponentialRampToValueAtTime` may not touch zero and may not start from zero. Envelopes here ramp
  from and to `FLOOR`, not to silence.
- The camera of spec section 10.7 never yaws, so the screen's right is the map's `+x` and the pan is
  the sideways offset alone. If the camera ever turns, `space.ts` is the one file that has to know.
- Checking this directory by ear needs a browser, so check it by meter instead:
  `node scripts/audio-check.ts` renders a made-up moment of each kind through an offline audio
  context in a headless Chromium and prints the peak, the loudness and the silence of each. Run it
  after changing a voice or a level. The full game on software WebGPU takes far too long to reach
  the street to be useful for this.
- A voice's gain is not its loudness. A band of noise through a closing filter comes out well under
  an oscillator at the same gain, so a level is read off that meter rather than reasoned about.
