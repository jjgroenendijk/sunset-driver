# Missions

The gotchas of spec section 18: who hands work out, how one job is built from the seed, and the
four states a job can be in. The factions behind the contacts are `docs/factions.md`, the turf a
territory job is aimed at is in the same place, and the record all of it is written into is
`src/sim/simulation.ts`, in `docs/sim-and-ui.md`.

## Contents

- Four files, four subjects
- Where a contact stands
- The board is a function, not a list
- A job is legs and a clock
- The seven kinds
- Taking, finishing and losing
- The authored chain
- What the chain does not ask for
- A territory job is permission to take the block
- The panel and the marks

## Four files, four subjects

- `src/sim/giver.ts` is where the contacts stand and whether one will talk.
- `src/sim/job.ts` is what a job is made of and how one is drawn from the seed. It keeps nothing.
- `src/sim/chain.ts` is the authored spine: the chapters as they are written, and how one is built
  against a seeded world. It keeps nothing either.
- `src/sim/mission.ts` is the state machine: the board, the job on the record, and the objective
  line the HUD reads.

Nothing else writes `SimState.missions`, and nothing else writes `SimState.objective`.

## Where a contact stands

- `giverPlaces(seed, districts, snap)` is the whole list: one contact per home district of every
  territorial faction. A faction's home districts are the ones whose culture matches it
  (`faction.ts`), so a faction has as many contacts as the seed gave it neighbourhoods, and the
  seed that leaves a faction without a district leaves it without work to offer.
- Unit 13 is not territorial, so it has no home district and no contact. Its work waits on a giver
  that is not a piece of turf.
- A contact is a point round the district's site snapped to the nearest road, the way a dealer's
  corner and a front door are. Five angles are tried; a district with no street near its middle
  gets nobody.
- They do not move. A dealer walks their pitches through the day (`docs/market.md`); a contact
  stands where the seed put them for the whole session, which is what makes the work something to
  come back to.
- There is no body on the street yet. A contact is a mark on the map and a panel at a corner, as a
  safehouse is a door and a record. Issue #350 is that gap.

## The board is a function, not a list

- `offerFor(state, world, giver)` builds a job from `(seed, offerIndex, giver.id)` every time it is
  asked, and nothing is kept between two calls. The panel and the simulation both call it on the
  same tick, so they cannot disagree about what is on the board.
- `offerIndex` is the tick over `OFFER_TICKS` plus the jobs finished and the jobs lost. So a board
  turns over every two game hours, and again the moment any job ends — which is what stops a player
  taking the same job twice and what makes the stream endless.
- The counter is the whole session's, not the contact's, so finishing a job in one district turns
  over every board in the city. That is the price of keeping no per-contact row on the record.
- A world with fewer than two corners to send anybody to offers nothing at all, and the panel says
  so rather than handing out a job with nowhere to go.

## A job is legs and a clock

- A job is an ordered list of legs and the ticks it allows from the moment it was taken. A leg is a
  place and one of four things to do there: `go` (be within `LEG_REACH`, on foot or at the wheel),
  `drive` (be there driving the class the job names), `hold` (stand there on foot until the leg's
  ticks are up) and `take` (hold the block the place stands in).
- The record carries the leg being worked on and the ticks already stood, so a save catches a job
  halfway through a leg and a replay walks the same one.
- Walking off a `hold` leg puts the standing back to zero rather than losing the job: a player
  driven off a corner by the people they were hired against has not failed, they have to go back.
- The clock is the run between the legs at a pace — a hurried one for a race and a chase, a steady
  one for everything else — plus every `hold` and a fixed grace. The pay is what the kind is worth
  plus what the ground between the legs adds.

## The seven kinds

| Kind | Legs | What it asks |
|---|---|---|
| delivery | `go`, `go` | Collect a package and take it across town |
| theft | `go`, `drive` | Bring a named class of vehicle to a yard |
| pursuit | `go`, `go` | Pick up a trail and cut a runner off, on a tight clock |
| protection | `hold` | Stand over a corner while the rival's enforcers come |
| sabotage | `hold` | Set a charge at a rival's stash, who then come after you |
| race | four `drive` legs | Through the checkpoints in order, on a tight clock |
| territory | `take` | Take a block off a rival (spec section 17.2) |

- Protection, sabotage and territory are all aimed at a rival of the contact's faction, so a
  contact with no rival hands out a delivery instead of work nobody could do.
- Protection calls the wave on the first tick of the stand, not when the job is taken: the people
  it hires the player against arrive at the corner, not at wherever the player happened to be.
- A pursuit has no runner on the street to chase. It is a place to be at before a tight clock runs
  out, which is an interception and not a chase. Issue #351 is the mark that should be running.

## Taking, finishing and losing

- One job at a time. A contact refuses a second one, and the only row on the board of the contact
  who handed the current one over is the way out of it.
- A contact will not talk from a vehicle, will not talk while the police want the player, and will
  not talk to a player their faction has crossed off (`HOSTILE`, spec section 17.3).
- Finishing pays, moves the standing with the faction that paid by `JOB_STANDING`, and counts one
  done. Losing pays nothing, moves it back by the smaller `JOB_FAILURE`, and counts one failed.
  `shiftStanding` is the one door onto the standing, so the rivals move the other way for free.
- A job is lost when the clock runs out, and when the player dies or is taken in carrying it: the
  respawn record is what says so, because it carries the tick it happened on.
- Handing a job back counts as a job lost, which is how the board moves on.

## The authored chain

- The spine of spec section 18 is eight chapters over six slots in `chain.ts`: three every player
  walks, a fork of two, and two more on each side of it. A chapter is an ordinary `MissionJob` with
  a `chapter` field naming it, so the state machine, the HUD, the panel and the save all carry one
  without knowing it is written rather than drawn.
- It is written between two sides, a patron and a rival, which are two factions of spec section
  17.1. `chainSides` resolves each to a contact: their own faction's where the seed gave it a
  district, else the first contact of the world for the patron and the contact furthest from it for
  the rival. A city of one contact runs both sides through them.
- A chapter's legs are placed on the same corners the side work uses. `{where}` in a written label
  is replaced with the district the corner landed in, so the HUD names a real place on every seed.
  The clock is read off the ground the legs cover, as a drawn job's is; the pay is written.
- The fork is two chapters sharing one slot, held out at once by the two sides' contacts.
  **Finishing** one writes the branch, not taking it: a chapter handed back leaves the fork open.
  `chainLost` is told which of the two happened, and hands a back a chapter without counting it.
- Losing the last chapter of either side ends the chain: `ended` becomes `burned` and nothing more
  is offered. Every earlier chapter is offered again by the same contact.
- A chapter is offered above the contact's side work rather than instead of it, so the spine never
  shuts the endless stream off. Both go through `jobOffers`, and `jobRows` is that list in order,
  which is what the number keys count.
- The chain stalls, without ending, for a player the side's faction has crossed off: `giverRefusal`
  shuts the whole board, chapter and side work together (spec section 17.3).

## What the chain does not ask for

- No chapter carries a `take` leg. A block is takeable only where a faction holds it, and which
  faction holds which block is a function of the districts a seed laid out — so a seed could put
  the spine's climax on ground nobody runs. The territory work of spec section 18 is the side
  stream's, where a job that cannot be built is simply not offered.
- No chapter asks for a vehicle class the roster does not park in the street. `plates` asks for a
  van, which every city has.
- `test/sim-chain.test.ts` walks both sides end to end on three worlds, and `seed-places.ts` builds
  every chapter against real cities in the sweep. A chapter that cannot be built on a seed fails the
  sweep rather than stranding a player.

## A territory job is permission to take the block

- `stepTerritory` will only start a takeover on a block whose holder is hostile to the player. A
  territory job names a block held by a faction the player may be on perfectly good terms with, so
  the job itself is what makes that block takeable: `hired` in `territory.ts` reads
  `state.missions.active.block` directly.
- It reads the field rather than importing `mission.ts`, because `mission.ts` reads `territory.ts`
  and two files may not read each other.
- `stepMissions` therefore runs before `stepTerritory` in `stepSim`: a job taken this tick has to be
  on the record before the block the player is standing on is read.

## The panel and the marks

- `src/ui/job-panel.ts` draws the board where the shop counter and the safehouse panel draw, and
  hides itself while either of those or a deal has the screen — which is also when the simulation
  shuts the board. What it does not do is move out of the way of a front door standing within four
  metres of a contact, which no seed measured has produced and which would draw one panel over the
  other if one did.
- The contacts are marked on both maps once, with the rest of the places, because they never move.
- The objective is marked by `src/ui/missions.ts`, which is the last link of the chain that runs
  from the dealers through the enforcers: each of them writes `MapPois.extra` and hands the list it
  wrote to the next. That is why `EnforcerMarks.marks` is kept up to date even on the frames when
  no enforcer is out.
