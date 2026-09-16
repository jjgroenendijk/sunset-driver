# Audio

The gotchas of `src/audio`: how the record is turned into sound, what a voice costs, and why the
levels are the numbers they are. `spec.md` section 15 is the design. Read the section the work
touches, not the file.

## Contents

- The shape of it
- What the record sounds like
- The mix
- The voices and their levels
- Starting, muting and the volume
- Measuring it

## The shape of it

Five files, in the order a frame goes through them:

1. `cues.ts` reads one frame of `SimState` into an `AudioScene`: the engine note, the loops that
   hold, the sounds that start. Pure, and it writes nothing back into the record.
2. `engine-model.ts` is the gearbox and the timbre of each class of vehicle.
3. `mix.ts` places a sound at the ear: its gain, its pan, how far the bed ducks and how many voices
   the mixer will pay for.
4. `director.ts` puts those together and talks to an `AudioSink` in four calls: hold a loop, let one
   go, fire a one-shot, duck the bed.
5. `tone-sink.ts` is the sink that makes a sound, with `tone-mixer.ts` (the buses), `tone-loops.ts`
   (engine, siren, rotor, squeal, fire, horn) and `tone-shots.ts` (gunshot, swing, impact,
   explosion, footfall, landing, bell) under it.

`audio.ts` is the door: the gesture, the volume and the tear-down. `session-audio.ts` is the
bookkeeping one frame needs around it, so `main.ts` says one line about sound.

Everything down to `director.ts` is arithmetic on plain numbers and is tested headless
(`test/audio-cues.test.ts`, `test/audio-mix.test.ts`, `test/audio-director.test.ts`). Nothing below
it is imported by a test, because Tone.js needs a browser. Keep that line where it is: a rule that
moves into a Tone.js file stops being checked.

## What the record sounds like

- A one-shot is the difference between this frame's record and the last, which `CueMemory` holds.
  Shots come from `loadout.shots`, a collision from the speed the vehicle lost in the tick (the
  floor is `IMPACT_FLOOR` from `damage.ts`, so one rule says what a crash is), an explosion from
  `damage.blownTick`, and a footfall from the distance walked. A frame that falls between two ticks
  starts nothing; the loops still follow what moved.
- A respawn and a metro trip put the player down somewhere else, so no collision is believed on
  that frame: without that, every death is a crash (spec sections 11.7, 13.3).
- The tram bells are not in the record. `TramLine.bells(tick)` is a function of the tick, so
  `session-audio.ts` asks it for every tick the frame stepped.
- The throttle comes from the input frame the last tick was stepped with, which `main.ts` keeps. The
  horn is a key, not state: it is a loop that holds while `input.horn` does.
- Randomness is `rngFor(seed, tick, Subsystem.Audio, n)`, like everywhere else, so a replay of a
  session sounds the way it did when it was played.

## The mix

- The ear is the player, or the free camera while it is flying. The camera looks straight down and
  never turns, so the map's `x` is the pan and the distance on the map is the distance to the ear.
- `attenuation` holds a sound at full gain within `NEAR` metres, falls with the distance after that,
  and takes it to nothing at the kind's reach. Nothing past its reach is asked for at all: a voice
  that merely became quiet would be paid for for ever.
- `VOICE_CAP` loops and `SHOTS_PER_FRAME` one-shots are all a frame may start, and what is dropped
  is what would have been heard least. A browser's audio thread that runs out of time drops the
  whole mix, not one sound.
- The bed ducks by the loudest key event, not by their sum. The radio of spec section 15 and the
  ambient beds have not landed; they ride `ToneMixer.music`, which is already on that bus.

## The voices and their levels

- A loop is built once and left running, with its gain, its pan and its parameters set each frame.
  Nothing is started and stopped per frame. A one-shot is a small ring of voices per kind, triggered
  again and again; the ring is what lets a burst of fire overlap rather than cut itself off.
- **A voice's gain is not its loudness.** A band of noise through a filter comes out far under an
  oscillator at the same gain, and a `MembraneSynth` under a `NoiseSynth` is louder than both. Every
  level in `tone-loops.ts` and `tone-shots.ts` is a number `scripts/audio-check.ts` measured, not a
  number anybody reasoned out. Change one and measure again.
- The kind's own level sits on the noise and the drum, not on the voice's output gain: what the mix
  hands over is between 0 and 1, and a level of its own on top of that is how a loud kind came to
  clip.
- **Tone's `Limiter` does not stop a transient.** It is a compressor with a 3 ms attack, so a
  gunshot, a crash and an explosion on one frame go straight through it. The mix therefore ends in a
  soft clip — halve, `tanh`, double — which is a straight line for anything quiet and bends over as
  it grows. Nothing leaves over 0.96 of full scale.

## Starting, muting and the volume

- A browser gives no audio until the player has touched the page, so `GameAudio.arm` waits for the
  first key or click. Tone.js is imported there and nowhere else: a session that never makes a sound
  never fetches it, and the build puts it in its own chunk.
- Off is not a gain of zero. The graph is torn down, so a muted session synthesises nothing, which
  is what spec section 15 asks for. Turning the sound back on builds it again; the click that chose
  the setting is the gesture that allows it.
- The level is in the settings of `src/ui/settings.ts`, so it holds for every seed, and the Sound
  page (`title-sound.ts`) is on both the title screen and the pause menu.

## Measuring it

`node scripts/audio-check.ts` renders a made-up moment of each kind through an offline audio context
in a headless Chromium and prints what came out: the peak, the loudness and how much of it was
silence. It is how a change to a voice is judged, because a headless run has no ears, and it fails
on a case that should make a sound and is silent, or one that clips.

The cases live in `src/audio/offline.ts`, and each drives the real director and the real voices. A
voice that was never connected, an option Tone.js did not understand and a gain left at zero all
come out as a silent case.
