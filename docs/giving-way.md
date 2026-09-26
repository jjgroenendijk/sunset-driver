# Giving way

The gotchas of how the cars of the traffic and the people of the crowd keep out of each other near
the player: holding them back on their loops, steering a car round what stands in its lane, and
stepping a person out of a car's way. Spec sections 13.1 and 20.2 ask for it. How a car drives its
tour is in `docs/city-life.md`, and how a person walks their loop in `docs/crowd.md`.

## Contents

- Holding back
- What a car stops for
- Steering round
- A bumped car
- What a person does
- Measuring it

## Holding back

- `src/sim/traffic/give-way.ts` keeps the cars and the people within `GIVE_WAY_REACH` of the player
  off each other and off the player, their car and the wrecks. It holds a car or a person back on
  their loop: `hold.ts` keeps each one's lag, in `state.traffic.held` and `state.pedestrians.held`.
  Everyone else keeps a lag of 0.
- The file is the cars' half. `give-way-people.ts` is the people's half, `swerve.ts` steers a car
  round what stands in its lane, and `detour.ts` steps a person off their loop. `give-way-scene.ts`
  holds the records all four read, and `give-way-grid.ts` the box and its buckets.
- **Read a car through `heldPose`, and a person through `crowdPoseOf`, never at the bare tick.** The
  physics (`traffic-bodies.ts`), the renderers and the tests do. `heldPose` applies the lag and the
  swerve. A reader that forgets it draws a car on top of the one it waits behind, or in the lane it
  has already steered out of. A reader that steps a cursor calls `swerveOnto` on the pose it read.
- A car that comes into the box on top of another is moved back along its tour until it stands
  clear. The box is wider than the view, so nobody sees the jump. On the first tick of a session
  every car counts as new. That is why `createHolds` starts at tick -1.
- The step costs about 2 ms a tick in the core of seed 1. Most of it is reading poses. The
  candidates are looked up again only when the player moves to another `NEAR_SNAP` of the map.
- Each peer of a multiplayer room gives way round its own player, so `applyWorld` keeps the local
  holds when it writes the host's traffic and crowd.

## What a car stops for

- A car stops for what is in the lane ahead of it and slows for what is further ahead. It also
  stops when its next step meets a car coming in from the side. When cars stop for each other in a
  ring, the car with the lowest id goes. Two cars that already touch may only move apart.
- A car coming the other way is in its own lane and is not looked at, unless one of the two has
  steered out of its lane. Then the two see each other.
- Besides the player, their car and the wrecks, a car stops for the police cars, the fire engines
  and the ambulances. It ignores any of these whose middle is behind its own: an engine is longer
  than a car, so one that comes up from behind reaches past its nose.
- Against these a car checks its whole next footprint with `OTHER_ROOM`, not only the lane ahead.
  The lane ahead is 80 % of the car's width, so a car parked half in the lane was clipped by a
  corner, and the touch promoted the car that clipped it.
- **No car drives into anything on purpose.** A car once waited `PATIENCE` for the player's car and
  then drove into it. The touch promoted it, a promoted car has nobody driving it, and the next car
  did the same: a car left in the street filled its lane with dead cars. A car now steers round,
  or waits.
- A car with a lag can meet a light its tour was timed to pass on green, so it stops at the line
  when the light is not green. It makes up the lag during its tour's next wait.
- A car that nobody sees also makes up lag while the road ahead is clear: `catchUp`, one tick in
  `CATCH_EVERY`, beyond `UNSEEN` of the player. `UNSEEN` must stay past `TRAFFIC_VIEW`, which a
  test checks, or a car jumps on screen. Without it a lag built behind the player's car was kept
  until the next red light.
- `junction-clear.ts`: a car does not cross the stop line of a signalled junction while a car of
  the traffic stands where it will stand past the junction. It runs its own tour on to find that
  spot. A wreck there does not hold it, or it would wait at the line for ever.
- `give-way-junction.ts`: at a junction without lights, a car waits at the mouth while its path
  meets another car's: one already inside, or one with the right of way. The car on the faster
  road has it, then the car that arrives first, then the lower id. So one car of a junction can
  always go, and a ring never releases a car that waits at a mouth. Issue #360 asked for it: on
  the first sweep seeds, cross traffic drove through itself at every busy junction without lights.
- The mouth is the junction's `cut` on each road. A car inside one junction that its tour takes
  straight into the next, over an edge shorter than the two cuts, never waits at the second mouth:
  it is already past it.

## Steering round

- `swerve.ts`: a car that has stood `START` behind something standing still in its lane picks a
  side to pass on. That is the player, their car, a wreck, a unit, a car facing it that stands, or
  a person who stands in the road. It takes the side that goes least far off the lane and that the
  carriageway has room for, up to `SWERVE_MOST`. It keeps a side once chosen. Past a car facing
  it, it keeps right.
- `AmbientTraffic.kerbsOf` says where the kerbs are, right of the middle of the car's lane. A
  two-way road gives the oncoming half too. A one-way run that is not a ramp gives only its own.
- It sets off only when the ground it passes over is clear, with every car near it run on
  `PASS_TIME` at its speed. A car standing behind it the same way round is left out: that one
  queues behind it and follows it out. Counting it once stood every queue still.
- It does not start at a red light: `queuedAtRed` stands a car within `QUEUE_REACH` of a stop line
  that is not green, or in a wait of its tour. Without it a car overtook a queue at a light.
- A car that has waited `MOUNT_WAIT` and still finds no room on the carriageway may put two
  wheels on the pavement, as far as `kerbs.pavement` allows. A narrow street with a car parked in
  it had no room to pass otherwise.
- The side is metres right of the lane, the sign the lane's own offset uses: a car in the oncoming
  lane stands at a negative side. It lives in the hold as `Swerve`, beside the lag, with the turn
  of the body (`yaw`) and what the side changed by on the last tick (`drift`), which the renderer
  reads between two ticks.
- A step sideways or a turn that would put a corner against something is not taken. A car turned
  in place next to the player on foot and promoted itself on them before this rule.

## A bumped car

- `rejoin.ts`: a promoted car of the traffic that stands still, upright, whole or dented, and
  `ROOM` clear of the player and their car goes back to its tour. Each is looked at once a second.
- Its tour is searched back up to `SEARCH_BACK` seconds for the moment nearest where it stands.
  That moment is its lag, and what is left over is a `Swerve` of side and yaw. So its pose does not
  jump, and the steering takes it back into its lane.
- The player's own car, left under an id when they took another, carries `left` and never rejoins.
  A parked car has no tour and stays. So does a car whose lock the player is working.
- Out of sight, `tow.ts` does the same job: a car that was only bumped and is not on fire is
  dropped once the player is `TOW_REACH` away. Its tour or its bay takes it back.

## What a person does

- A person holds before stepping into a car, or into the road just ahead of a moving one. A person
  off their loop is moved aside with `stepAside` after `NUDGE`. The player, their car and a wreck
  get `PATIENCE`, and then the person walks on regardless.
- `detour.ts`: a person a car waits for steps out of its path, to the side they already stand on.
  A person whose next step meets something standing still walks round it. The step is metres east
  and north, `dodgeX` and `dodgeY` in their `Aside` record. Giving way asks for it each tick with
  `wantDodge`, and `make-way.ts` walks it at `DODGE_PACE` and back once nobody asks.
- The old answer to a car waiting for a person was to walk the person back along their loop. A
  person standing still in their own plan, at a kerb or a window, moves nowhere when walked back,
  and the car waited for ever. That was the largest group of stuck cars.
- A person who crosses the path of the car waiting for them walks on across it (`crossing`), with
  no dodge and no walk back. A dodge sideways against their own walk left them treading on the
  spot in front of the car.
- A moving car that meets a person all the same hits them (`city-strike.ts`), with a `Blow` marked
  `city`: it is no crime of the player's. With the rules above, this happens only to someone
  running.

## Measuring it

- `node scripts/traffic-stuck.ts <seed>` stands the player's car in the street at a few places and
  counts the cars held, the stuck episodes by what they wait for, the cars that get past, and the
  cars promoted. `--nopark` runs the same streets without the car, which is the baseline. `--dump`
  prints the chain a stuck car waits along.
- A queue at a red light counts as an episode too. Read the roots, not the total.
