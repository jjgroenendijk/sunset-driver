# Shops

The gotchas of the shops of spec section 16: which building is a trade, how a player gets inside
one, what the counter holds and what a room looks like from the player's own eyes. Four
directories share the subject, which is why it has a page rather than a paragraph in each of them.
The record they all read and write is `src/sim/simulation.ts`; see `docs/sim-and-ui.md` for the
rest of it. The contraband market of spec section 16.2 is a different trade, out on the street
corners, and has its own page in `docs/market.md`.

## Contents

- Which building is a shop
- The room
- The door
- The counter and the prices
- Cafés and bars
- The panel and its preview
- The interior, drawn
- The map

## Which building is a shop

- `buildShops(world, buildings)` (`src/world/city/shops.ts`) deals the trades over the buildings.
  Only a `shop-row` can hold one — a storefront the player cannot enter is still scenery and still a
  robbery target — and the trades are dealt per district, because a district's own shop rows are its
  high street.
- `SHOP_ORDER` runs commonest first, and a district fills from the top of it: one shop row gets the
  convenience store, and only a long high street reaches the property broker. So a small district
  is never the only one with a gun shop, and no district is left with nothing.
- `tradesFor` then gives a long street one more café or bar for each `VENUE_ROWS` rows past the
  whole order, turn about, up to `MAX_EXTRA_VENUES`. A district has tens of shop rows, so most
  districts reach the whole order and several cafés and bars.
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
  target. A café or a bar takes `VENUE_FRONT` and `VENUE_ROOM_DEPTH` instead: tables and a way
  between them need more floor. A lot too narrow to stand in is grown to the least room a person
  fits, because a shop the player cannot be inside is not enterable.
- `facing` points out of the lot at its road, as `Building.facing` does. Everything here is in
  those terms: the door is at `+facing` of the room and the counter at `-facing`.

## The door

- `stepShops` (`src/sim/places/shop.ts`) runs before the physics, like the metro, because walking in
  moves the player and the physics has to stand them on the ground where they landed.
- It is also where the interact key is spent. A press that opens a door sets
  `player.held.interact`, so `SimPhysics.transfer` sees no edge on that tick and the car at the
  kerb stays shut. This hand-off is the whole reason the shops step before the physics and not
  after it.
- The vehicle wins the key wherever both could take it. A press the shop refuses is left alone, a
  player inside `ENTER_REACH` of their vehicle's body is opening its door and not the shop's, and a
  player working at a lock keeps the edge until it gives way. The door is reached from a metre and
  a shop from four, so a shop that took the press first would leave the car at the kerb unreachable
  along most of a high street.
- `entryOf(room)` is where a player who walks in stands: `ENTRY_STEP` inside the middle of the
  shopfront, facing the counter. The whole room is in front of them there. The door and the clear
  way to the counter are in the middle of the front for the same reason (`room-shell.ts`).
- Nothing in the city is a wall to the player, so they leave by pressing the key again — which puts
  them back on the pavement outside the door — or by simply walking out of the room, which leaves
  them wherever their feet took them.
- Two things refuse a door: a vehicle, and the police. `SHELTERS_WANTED` is the exception. The
  workshop and the clothing shop sell the two ways to shed recognition, so they open to a wanted
  player; without that both would be shut exactly when they are wanted.

## The counter and the prices

- `offersOf(state, place)` (`src/sim/places/shop-stock.ts`) is the counter: a line, a price, and
  what buying it does to the record. A row that cannot be taken is never offered, so a store sells
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
- What the last purchase said is in the record, on the visit, because `src/ui/panels/shop-panel.ts`
  draws the record and nothing else. A purchase is money out of `state.money` and then the offer's
  own `take`; nothing else in the project may move the money for a trade.
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

## Cafés and bars

- A café and a bar are trades like the rest, with a counter, but each has its own name and menu.
  `venueName` (`src/world/city/venue-names.ts`) names it, and `ShopPlace.title` carries the name.
- `menuOf` (`src/sim/places/venue-menu.ts`) deals the menu from the seed and the shop: a few rows
  of each section of `CAFE_MENU` or `BAR_MENU`, in the sections' order. The first row is the
  house's own drink, named after it. The district's wealth scales every price, from `CHEAPEST` to
  `DEAREST`, and each venue strays up to `WHIM` from that.
- A venue serves a player at full health, unlike the store: a drink at the bar is what the room is
  for. The health comes only to a player who is hurt, and the line says so.
- The drinks are props like the food (`shop-props.ts`). A prop is solid, so a glass is drawn as
  the drink with glass only above its level: a pale cylinder round the drink hides its colour.

## The panel and its preview

- Each `ShopOffer` carries what the panel shows beside its price: a `group` heading, a `look` for
  the preview, a `blurb` and a list of `facts`. The tables behind them — the foods, the care, the
  paints and the weapon gauges — are `src/sim/places/shop-goods.ts`. They are plain data, so the
  simulation stays free of the renderer.
- The cursor belongs to `src/ui/panels/shop-panel.ts`, not to the record. Hover, the arrow keys and
  a tap move it. Buying always goes through `InputFrame.buy`, so a click replays like a number key.
- While a counter is open, `Keyboard.menu` gives the up and down arrows to the cursor. `W` and `S`
  still walk, so a player can still walk out of the room.
- `ShopPreview` (`src/render/shops/shop-preview.ts`) draws the look with the game's own renderer,
  through a `CanvasTarget` on the panel's canvas. It swaps the target in for one draw and back,
  after the post chain. A second `WebGPURenderer` would be a second GPU device and would compile
  every shader twice.
- The preview reuses the city's models: `WeaponArt`, `VehicleModel` and `CharacterModel`. The food,
  the kits, the ammunition, the house and the wrench are the primitives of `shop-props.ts`. Each
  look is scaled to fill the window, so the props have no real size.
- `shop-frame.ts` places the camera. It turns the corners of the model's box and the rim of the
  plinth through every angle the model will take, and stands back just far enough to hold all of
  them. A bounding sphere would leave a figure a sixth of the window high. A weapon sways about a
  side view rather than spinning: a full turn shows a long gun end on for half the time.
- The panel is sized in `--u`, one unit that grows with the screen, not in `rem`. It stands at the
  right, under the HUD's status stack, so the room stays in sight in the middle of the frame. Below
  52rem wide it becomes a sheet across the bottom, with the card over the rows.
- A group heading is sticky, and `scrollIntoView` does not know it covers the top of the list, so
  `ShopPanel.scrollTo` scrolls a row clear of it by hand.

## The interior, drawn

- `ShopInterior` (`src/render/shops/interior.ts`) holds exactly one room: the one the player is
  standing in. Nothing here streams and nothing is batched, because no second interior ever exists —
  every other building is exterior only (spec section 10.3).
- Inside a shop the camera is first person, whatever the View setting: `Frame.follow` passes
  `first-person` while `inShop`. The counter keeps the pointer, so the mouse does not look; the
  view turns after the player as they walk, and they walk in facing the counter.
- The room is closed: a floor, four walls, a ceiling and a shopfront with a door and glass.
  `WorldScene.seeThrough` is given whether the player is inside a shop, and cuts away the building
  over them, so the street shows through the glass.
- `WorldScene.floorUnder` stands the floor on the highest ground under the room. At the height of
  its middle, a sloping street comes up through the back half of the floor.
- `roomStyleOf` (`room-style.ts`) deals the look from the seed and the shop. A café and a bar pick
  a theme from their own list, weighed by district wealth: a diner or a dive in a poor district, a
  cocktail lounge or a Parisian café in a rich one. Every other trade picks a plain theme and keeps
  its trade colour on the back wall. Each theme is a set of choices, and every colour is moved off
  its swatch, so two rooms of one theme still differ.
- `room-shell.ts` builds the floor, wall finish, ceiling, lamps and shopfront from the style.
  `venue-fit.ts` furnishes a café or a bar: a counter at the back or down one side, then strips of
  floor either side of the way in, each seated as the style prefers and has room for. Every other
  trade keeps its counter, shelves and goods (`interior-goods.ts`).
- `RoomKit` (`room-kit.ts`) merges every part of one material into one mesh. A furnished bar is
  several hundred boxes, and a mesh each would be a draw call each. The furniture of
  `furniture.ts` is written in a `Spot`'s frame, `dz` out of its front, so a piece stands against
  any wall.
- The surfaces carry their own glow, tinted by the style's light, and a lamp glows hard enough for
  the bloom. A real light in the room would be the first point light in the scene, and the
  clustered lighting would then rebuild every lit shader in the city on the first step through a
  door.
- `render-preview.ts --shop=cafe --nth=2` draws the third nearest café, from where the player walks
  in. `--heading=180` looks back out of the door.

## The map

- `SHOP_POIS` (`src/ui/map/map.ts`) is the icon each trade is marked with: a workshop is the garage
  mark and a clinic the clinic mark, since that is what they are, and the broker has a key of its
  own. A café is a cup and a bar a cocktail glass. Every type of `POI_STYLES` has a shape and a
  colour no other type uses, and `test/ui/map/map.test.ts` pins that, so a new trade needs a new
  shape rather than a second use of one.
- `maps.ts` writes them into `MapPois.extra`, which is the one slot a system that owns places
  writes; both maps read it.
