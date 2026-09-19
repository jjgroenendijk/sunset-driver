# Safehouses

The gotchas of spec section 16.3: the properties a player buys, what each one holds, and why the
garage works the way it does. The property broker that sells them is a shop like any other and is
in `docs/shops.md`; the respawn a safehouse is the point of is spec section 11.7, in
`docs/police.md`. The record all three write is `src/sim/simulation.ts`.

## Contents

- Where a property stands
- What it costs
- Buying one
- The door and its panel
- The stash
- The garage is an exchange
- Death, arrest and the save
- The map

## Where a property stands

- `safehousePlaces(seed, districts, snap)` (`src/sim/safehouse.ts`) is the whole list: one property
  per district. It is built on the main thread from the world's districts, the way the dealers of
  `docs/market.md` are, and not in the chunk workers. Nothing about a safehouse is a building, so
  nothing has to cross the worker boundary for one.
- A door is a point round the district's site, snapped to the nearest road, so it stands on a
  pavement a player can walk up to. `snap` is handed in rather than read here, which is what lets a
  simulation test stand a property on a bare hillside.
- Five angles are tried and the first that snaps within `DOOR_LIMIT` of the district's own site is
  taken. A district with no street near its middle gets no property; over the seeds measured that
  is the wilderness, which is the right answer.
- There is no room behind the door and no interior. A safehouse is a door and a record: the panel
  opens on the step, as a deal opens on a corner. The renderer therefore knows nothing about
  safehouses at all, and `src/render/interior.ts` still holds exactly one room — a shop's.

## What it costs

- `priceOf(district)` is the price, and the district is all of it: `PRICE_BASE` in the poorest,
  emptiest district, and up to about four times that where the district is both rich and busy. A
  door is the most expensive thing in the game on purpose — it is what a run of contraband is for.
- The price is a function of the district and nothing else, so two saves of one seed cannot
  disagree about what a door costs, and nothing in the record holds a second copy of it.

## Buying one

- The broker's counter is the only place a property is sold, and the money is taken by
  `src/sim/shop.ts` like any other shop row: nothing in `safehouse.ts` moves `state.money`.
- A counter shows `CHOICE_KEYS` rows, so an office sells the doors nearest it and not the whole
  city. A player who wants a door across town walks into the broker across town.
- `buySafehouse` writes the row into `SimState.property.owned` and fills its garage. The first
  property bought becomes the active one, because a player who has just bought a home has no other.
- The cars a property comes with are a function of the seed and the property id, so the same house
  of the same city always has the same car in its garage, and a richer district keeps a better one.
  A rich district's property comes with two slots rather than one.

## The door and its panel

- `stepHome` runs after the shops and before the market, and it takes the interact key in that
  order: a lock holds it first (spec section 11.4), then a shop door, then a front door, then a
  dealer. One press therefore never opens two panels. A press that opens a door is spent —
  `player.held.interact` is set — so the car at the kerb does not open on the same edge.
- The door opens only on a property the player owns. At one they do not own the panel says what it
  costs and who sells it, and the key does nothing.
- The police are no reason to refuse a door. A safehouse is where you go when they are looking for
  you, so unlike a shop counter it opens to a wanted player.
- The rows are `input.buy`, the same number keys a shop counter uses. The two are never read at
  once, because a player inside a shop is not standing on their own step.
- `stepHome` answers with a place, not a boolean: the place a car taken out of the garage is to be
  stood at, and null on every other tick. Nothing here moves the player, so unlike `stepShops` it
  has nothing else to tell the physics.

## The stash

- A safehouse keeps `HOME_UNITS` units, five times what a player can carry. The two stores have the
  same shape — units per good and dollars paid for them — because what was paid has to travel with
  the goods or a later sale cannot say what the run made.
- Both rows are all or nothing, as the dealer's panel is: stash everything, take everything. What
  does not fit stays where it was, and the dollars paid move in proportion to the units that moved.
  A player never counts units into a keyboard.

## The garage is an exchange

- The record carries exactly one vehicle and has no way to say the player has none
  (`SimState.vehicle`). So a garage cannot be a place you leave a car and walk away: taking one out
  puts the one the record holds into the slot it came from, and the number of cars a garage keeps
  never changes.
- That is why a property comes with its cars. Without them the first exchange would have nothing to
  exchange, and the garage would be dead until the player had somehow put a car in it.
- The car the record held goes into the garage wherever it was standing. That is the one liberty
  the feature takes, and it is the price of the one-vehicle record.
- `SimPhysics.settle` is what stands the car taken out on the ground outside the door. It keeps the
  vehicle the record carries rather than building a fresh one, as `spawn` does, because the dents,
  the paint, the station it was left on and its beaten lock are exactly what a garage kept.

## Death, arrest and the save

- `respawnPlace` sends a death to the active safehouse and an arrest to the nearest police station,
  falling back on `SimState.origin` — where the session started — for a player who owns none.
- An arrest takes the contraband in the player's hands (spec section 11.7). A safehouse stash is a
  store of its own, so neither fate can reach it: driving home before a job is what puts a run's
  takings out of the law's reach, and that is the whole point of the stash.
- `SAVE_VERSION` went to 7 for the record's new `property` field. A fresh record owns nothing, so
  the save's array conformer has no template element to check an owned property against
  (`src/sim/save.ts`): the stash lengths and the garage's vehicle classes are checked by hand
  instead.
- Saving itself is not a safehouse feature here. The pause menu saves anywhere (spec section 16.4),
  so a row that saved at a door would be a second way to do one thing.

## The map

- Every property is marked, owned or not, with the `safehouse` icon `POI_STYLES` already held, and
  named for its district. `maps.ts` writes them into `MapPois.extra` beside the shops, before
  `DealerMarks` is built: that class takes the list as it stands and writes the moving dealer marks
  after it, so anything added later would be lost.
- The marks are fixed for the life of a session, so the map does not say which door is the player's.
  The panel at the door does.
