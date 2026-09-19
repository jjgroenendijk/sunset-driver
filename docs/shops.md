# Shops

The gotchas of the shops of spec section 16: which building is a trade, how a player gets inside
one, what the counter holds and what a room looks like from a camera 30 m overhead. Four
directories share the subject, which is why it has a page rather than a paragraph in each of them.
The record they all read and write is `src/sim/simulation.ts`; see `docs/sim-and-ui.md` for the
rest of it. The contraband market of spec section 16.2 is a different trade, out on the street
corners, and has its own page in `docs/market.md`.

## Contents

- Which building is a shop
- The room
- The door
- The counter and the prices
- The panel and its preview
- The interior, drawn
- The map

## Which building is a shop

- `buildShops(world, buildings)` (`src/world/shops.ts`) deals the trades over the buildings. Only a
  `shop-row` can hold one — a storefront the player cannot enter is still scenery and still a
  robbery target — and the trades are dealt per district, because a district's own shop rows are
  its high street.
- `SHOP_ORDER` runs commonest first, and a district fills from the top of it: one shop row gets the
  convenience store, and only a long high street reaches the property broker. So a small district
  is never the only one with a gun shop, and no district is left with nothing.
- `spread` (`src/core/math.ts`) picks the buildings a stride apart down the street rather than in a
  run, so two shops are rarely neighbours. The stride is one trade's share of the street, which is
  what makes it impossible for two trades to land on one building.
- A weapon shop's `licence` comes from its district's wealth: the poorest third sells hardware over
  the counter and the richest third is licensed for rifles. What that licence covers is the
  simulation's, not the world's.
- It is built in the chunk workers beside the buildings and sent to the main thread on the same
  `ready` reply as the police and metro stations, because the main thread never builds the
  buildings. Nothing about a shop is stored in the world description.
- That same answer is handed to `chunkLookups` as `tradeOf`, so the fascia over a shopfront names
  the trade really behind it (spec section 13.1). Deal the shops once and pass them in: dealing
  them walks every building of the map. `docs/render-entities.md` has the signage.

## The room

- `roomOf(shop)` is the one place that cuts the room behind a shopfront, and both halves read it:
  the simulation to know when the player has walked out, the renderer to build the walls. Cutting
  it twice is how the walls a player leaves through stop being the walls they were shown.
- It stands `SHOP_WALL` inside the lot, no wider than `SHOP_FRONT` and no deeper than
  `SHOP_ROOM_DEPTH`, and sits in the middle of the row's frontage. A shop row is a row of
  storefronts and the enterable shop is one of them: an attached row in the core is 20 to 30 m
  wide, and a room that took all of it would be a hall. The rest stays scenery and a robbery
  target. A lot too narrow to stand in is grown to the least room a person fits, because a shop
  the player cannot be inside is not enterable.
- `facing` points out of the lot at its road, as `Building.facing` does. Everything here is in
  those terms: the door is at `+facing` of the room and the counter at `-facing`.

## The door

- `stepShops` (`src/sim/shop.ts`) runs before the physics, like the metro, because walking in moves
  the player and the physics has to stand them on the ground where they landed.
- It is also where the interact key is spent. A press that opens a door sets
  `player.held.interact`, so `SimPhysics.transfer` sees no edge on that tick and the car at the
  kerb stays shut. This hand-off is the whole reason the shops step before the physics and not
  after it.
- The vehicle wins the key wherever both could take it. A press the shop refuses is left alone, a
  player inside `ENTER_REACH` of their vehicle's body is opening its door and not the shop's, and a
  player working at a lock keeps the edge until it gives way. The door is reached from a metre and
  a shop from four, so a shop that took the press first would leave the car at the kerb unreachable
  along most of a high street.
- Nothing in the city is a wall to the player, so they leave by pressing the key again — which puts
  them back on the pavement outside the door — or by simply walking out of the room, which leaves
  them wherever their feet took them.
- Two things refuse a door: a vehicle, and the police. `SHELTERS_WANTED` is the exception. The
  workshop and the clothing shop sell the two ways to shed recognition, so they open to a wanted
  player; without that both would be shut exactly when they are wanted.

## The counter and the prices

- `offersOf(state, place)` (`src/sim/shop-stock.ts`) is the counter: a line, a price, and what
  buying it does to the record. A row that cannot be taken is never offered, so a store sells
  nothing to a player at full health and the panel says so.
- A clinic is the exception to that first rule. `CLINIC_SUPPLIES` — the naloxone, the test strips
  and the clean works of spec section 19 — is on the counter whatever the player's health, priced
  at nothing and changing no state: the factual line the row answers with is the thing the player
  leaves with. Treatment is the trade above it, and only when they are hurt.
- No price is written down twice. A weapon costs what its licence and its own damage say and a
  round costs what the pool a player may carry of it says, so the arsenal (`arsenal.ts`) keeps the
  only copy of those numbers and a new weapon is priced the moment it is added.
- `CLASS_LICENCE` is what a class needs to be sold over a counter. Nothing is licensed for the
  heavy and the thrown weapons, so those are only ever sold out of a back room, at `BACK_ROOM`
  times the price. A shop stocks `COUNTER_ROWS` weapons and `BACK_ROOM_ROWS` behind the counter,
  picked from what its licence covers; the pick is a pure function of the seed and the shop id, so
  the panel a player buys off is the panel the record replays.
- The row bought is `InputFrame.buy`, the same edge of the same number keys as `InputFrame.travel`.
  The two are never read at once, because `travelRefusal` refuses a trip from inside a shop. The
  number keys reach the first `CHOICE_KEYS` rows. A longer counter is fine: a click or `Enter`
  hands any row to `Keyboard.choose`, and the next input frame carries it as `buy`.
- What the last purchase said is in the record, on the visit, because `src/ui/shop-panel.ts` draws
  the record and nothing else. A purchase is money out of `state.money` and then the offer's own
  `take`; nothing else in the project may move the money for a trade.
- A respray writes `VehicleState.paint`, which starts as the colour of the vehicle's row of the
  roster, and takes the heat to nothing: the radio is looking for the colour it was. A change of
  clothes takes `CLOTHES_HEAT` off instead. The workshop works on the vehicle of the record, which
  is the one the player arrived in and left at the door — the record carries one vehicle, and that
  is it.
- The property broker sells the safehouses of spec section 16.3. Its counter is the
  `BROKER_ROWS` properties still for sale nearest this office, so one office sells the doors
  round it and a player who wants one across the city walks into the
  broker there. `docs/safehouses.md` is what a property then does. This is the one counter whose
  rows come from outside the record: `offersOf` takes the city's properties as an argument, because
  a price and a door both belong to the world.

## The panel and its preview

- Each `ShopOffer` carries what the panel shows beside its price: a `group` heading, a `look` for
  the preview, a `blurb` and a list of `facts`. The tables behind them — the foods, the care, the
  paints and the weapon gauges — are `src/sim/shop-goods.ts`. They are plain data, so the
  simulation stays free of the renderer.
- The cursor belongs to `src/ui/shop-panel.ts`, not to the record. Hover, the arrow keys and a tap
  move it. Buying always goes through `InputFrame.buy`, so a click replays like a number key.
- While a counter is open, `Keyboard.menu` gives the up and down arrows to the cursor. `W` and `S`
  still walk, so a player can still walk out of the room.
- `ShopPreview` (`src/render/shop-preview.ts`) draws the look with the game's own renderer,
  through a `CanvasTarget` on the panel's canvas. It swaps the target in for one draw and back,
  after the post chain. A second `WebGPURenderer` would be a second GPU device and would compile
  every shader twice.
- The preview reuses the city's models: `WeaponArt`, `VehicleModel` and `CharacterModel`. The food,
  the kits, the ammunition, the house and the wrench are the primitives of `shop-props.ts`. Each
  look is scaled to fill the window, so the props have no real size.

## The interior, drawn

- `ShopInterior` (`src/render/interior.ts`) holds exactly one room: the one the player is standing
  in. Nothing here streams and nothing is batched, because no second interior ever exists — every
  other building is exterior only (spec section 10.3).
- The room is a closed box and a `ClippingGroup` (`three/webgpu`) cuts the roof and the front wall
  away, so the camera overhead sees in. The two planes are in world space and are rebuilt on every
  `show`, so a room is built the same way whichever way its door faces. Clipping planes keep what
  is on their positive side, and a `ClippingGroup` clips the union of its planes' far sides.
- `WorldScene.seeThrough` is given whether the player is inside a shop, and cuts away the shell over
  them rather than the one the camera stands in. Without it the room the clip opened is roofed over
  again by the building's own batch, which the clip cannot reach.
- The surfaces carry their own glow. A shop stands in the shadow of its own building, and the
  shadow pass does not read the cut of `cutaway.ts`, so a room lit only by the sun would be a dark
  box. The back wall carries the trade's colour, which is how a player reads what they walked into.

## The map

- `SHOP_POIS` (`src/ui/map.ts`) is the icon each trade is marked with: a workshop is the garage
  mark and a clinic the clinic mark, since that is what they are, and the broker has a key of its
  own. Every type of `POI_STYLES` has a shape and a colour no other type uses, and
  `test/map.test.ts` pins that, so a new trade needs a new shape rather than a second use of one.
- `maps.ts` writes them into `MapPois.extra`, which is the one slot a system that owns places
  writes; both maps read it.
