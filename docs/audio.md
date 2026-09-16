# Audio

The gotchas of `src/audio`: the engine, the sirens, the impacts and the footsteps of spec section
15. Everything is synthesised with Tone.js at runtime, because spec section 1.2 forbids audio files.

## Contents

- The split, and why it is there
- The engine has a gearbox the physics does not
- Cues, and what a frame is allowed to fire
- The buses and the duck
- The gesture and the mute
- Traps

## The split, and why it is there

- `src/audio` is two halves and one door. `plan.ts`, `engine.ts`, `space.ts` and `cue.ts` hold no
  Tone.js and no DOM: they read the record and answer an `AudioPlan`. `voices.ts`, `one-shots.ts`
  and `mixer.ts` own the Web Audio node graph and play that plan. `game-audio.ts` is the door
  `main.ts` holds.
- The split is what lets `test/audio.test.ts` run in Node. A rule that decides whether a sound
  happens belongs in the pure half; a rule about how it sounds belongs in the other. When adding
  something, put the decision in `plan.ts` and let the mixer take it as given.
- `main.ts` calls `audio.update(state, input, listener)` once a frame with the **drawn** player
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
- The engine is the player's own vehicle and nothing else. Ambient traffic makes no sound yet; that
  belongs with the ambient beds of spec section 15.

## Cues, and what a frame is allowed to fire

- A one-shot is decided by a **difference between two frames**, never by an event, because the
  simulation raises none. A collision is the vehicle's integrity falling by `IMPACT_MIN`, a shot is
  `loadout.shots` rising, an explosion is `damage.blownTick` changing. That means a record which
  jumps looks exactly like a crash and a volley: call `AudioPlanner.resync` after a load, a respawn
  or a metro trip. `main.ts` already does, and forgetting it is the loudest bug in this directory.
- Footfalls are paced by the ground covered, not by the clock, so a sprint quickens on its own and
  standing still takes no step.
- A tram's bell is the one cue that is not in the record at all: `TramLine.bells(tick)` is a
  function of the tick (spec section 13.2), so the planner is handed the line itself through
  `GameAudio.watch` and asks it about **every tick the frame stepped**. Asking only about the tick
  the frame landed on drops about half the bells at the frame rate the game is written for.
- `CUES_PER_FRAME` caps what one frame may fire, and `VOICE_CAP` caps what the bank holds. A cue
  that finds no free voice is **dropped, never stolen**: stealing would restart an oscillator that
  is still scheduled to stop, and Tone.js refuses a start before a pending stop.
- The cap is the CPU budget of spec section 15. `Mixer.dropped` counts what it cost.

## The buses and the duck

- Three buses meet at the master: `music` — empty until the radio stations land — `effects`, and the
  player's engine on its own. A limiter sits on the master, so nothing a stacked explosion does can
  clip the output.
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
- The setting lives in `ui/settings.ts` beside the camera one, and `ui/title-sound.ts` is the page
  the title screen and the pause menu both show.

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
