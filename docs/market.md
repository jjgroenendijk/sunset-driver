# The contraband market

The gotchas of spec section 16.2: what a good is worth in a district, where the dealers are
standing, and what a deal does to the record. The shops the player walks into are a different
trade, in `docs/shops.md`; the record both of them write is `src/sim/simulation.ts`, in
`docs/sim-and-ui.md`.

## Contents

- Nothing about a price is stored
- The goods
- What moves a price
- The dealers and their corners
- The deal
- The panel
- The map and the crowd
- The factions

## Nothing about a price is stored

- `priceAt(seed, tick, district, good)` (`src/sim/contraband.ts`) is the only price there is. It is
  a pure function, like the traffic and the crowd of spec section 5.3, so no table of prices is
  kept, stepped or saved.
- Two things follow, and both are the reason it is built this way. A save cannot disagree with the
  market it was saved in, because there is nothing in it to disagree with. And the history the
  panel draws is read rather than remembered: `priceRun` asks what the price was an hour ago, and
  the answer is the same function of the same seed it was an hour ago.
- What the record does carry is `SimState.market`: the stash, what was paid for it, and the deal
  the player has open. A price never goes in there. Nothing the player does moves a price either —
  the market is the city's, not theirs.

## The goods

- `GOODS` (`src/sim/goods.ts`) is the list: twelve goods in three groups, each with a name, a
  blurb for the panel's card and the numbers its price is made of. `contraband.ts` hands the same
  names on, so callers that ask for a price import the list from there.
- The record stores a holding per good in the order of `GOOD_IDS`. A good added or moved changes
  the shape of every stash, so it raises `SAVE_VERSION`; version 20 is the move from six to twelve.
- The panel draws the list in its own order, under the headings of `GOOD_GROUPS`. So a group has to
  be one run of the list, and the test in `test/market.test.ts` holds that, cheapest first inside
  a run.
- The number keys reach the first nine goods only. The rest are traded with the cursor and `Enter`
  or the buttons, as a shop's rows past the ninth are.
- A price's random streams are keyed on `district.id * GOODS.length + good`, so a longer list
  moves every price of every seed. That is fine once, with the save version raised, and it is why
  a good is never added without a reason.

## What moves a price

- `tasteOf` is the standing price of a good in a district: what it costs there on an ordinary day.
  Three things set it, which are the three the spec names — the district's wealth, its character
  and the crowd on its streets — and a little of the district's own taste, so that two districts of
  the same numbers are still worth driving between.
- Each good names the culture that trades it at home (`Good.home`, spec section 17.1). That
  district is where it comes into the city, so that is where it is cheap: `HOME_DISCOUNT` off. This
  is the one rule a player learns first, and the reason the goods are worth telling apart.
- `driftAt` is a slow wave with a corner every `DRIFT_TICKS` and a smooth ride between them. It is
  smooth on purpose: a price a player has just read is still the price when they turn round.
- `shockAt` is the sudden swing. A spell of `SHOCK_TICKS` either holds a shock or it does not, and
  where it does, the swing is widest the moment it lands and gone by the end of the spell. A player
  who sees one has the rest of the spell to get there, and never arrives at a price that vanished
  the tick they walked up.
- `Good.volatility` scales both, so a carton of cigarettes is worth much the same all week and a
  street drug is not. `SPIKE` and `GLUT` are how far over or under the standing price counts as
  worth saying out loud; the panel marks the row.

## The dealers and their corners

- One dealer works each district. `dealerPlaces(seed, districts, snap)` (`src/sim/dealer.ts`) picks
  `PITCHES` corners spread round the district's site and hands each to `snap`. The snap is handed
  in rather than imported so that a simulation test can put a dealer on a hillside with no roads on
  it.
- In the game the snap is `kerbsidePlace` (`src/world/kerbside.ts`), not `nearestRoadPlace`. The
  second answers the middle of the carriageway, which is where a car stands; a dealer put there
  stood in the traffic. The kerbside answer is the middle of the pavement on the side the point was
  asked from, turned to face the road. A road with a pavement is preferred over a nearer one
  without, and a place that lands on any carriageway, as at a junction, tries the far side and then
  gives up. `test/seed-places.test.ts` checks no pitch of the sweep stands in a road.
- A district `snap` answers nothing for gets no dealer at all, which is how the wilderness is left
  alone.
- `pitchOf(dealer, tick)` is the corner they are on. The pitches are shuffled once at build time
  and walked one per spell of `PITCH_TICKS`, so a dealer moves every spell and works every corner,
  and which one is a function of the tick alone.

## The deal

- `stepMarket` (`src/sim/market.ts`) runs after `stepShops` and before the physics. It takes the
  interact key only after the shops have had it, so a press that opened a shop door does not also
  open a deal, and the vehicle still wins the key wherever both could take it.
- A deal is refused from a vehicle and refused while the police want the player, and an open deal
  is broken off by either — a dealer does not stand on a corner with a siren coming. Walking more
  than `DEAL_MARGIN` past the pitch ends it too.
- While a deal is open the metro is handed an empty frame (`stepSim`). The number keys are the
  trading panel's, and a dealer may well be standing at a station entrance.
- A trade is all or nothing. `InputFrame.trade` is the good counted from 1 to buy and the same
  number negative to sell; a buy takes as many units as the money and `STASH_UNITS` allow, and a
  sale is the whole holding. Two keys are the whole loop of the trade, and a player never counts
  units into a keyboard.
- `MarketState.paid` is what was paid for the units held, which is what lets a sale say what it
  made. A sale is all of a good, so the arithmetic is exact and no average cost is ever carried.

## The panel

- `src/ui/trade-panel.ts` is built on the shop counter's layout and classes (`shop.css`), with the
  parts a trade adds in `trade.css`. Keep the two alike, so a dealer reads like every other
  counter in the game.
- It draws the record and nothing else. The cursor is the panel's own. A click on a row only moves
  the cursor and never trades, because a buy takes everything the money and the room allow.
- The buy and sell buttons and `Enter` go through `Keyboard.trade`, which the next frame of input
  carries as `InputFrame.trade`. So a trade made with the mouse replays like one made with a key.
- `Keyboard.menuKeys` spends the arrow keys and `Enter` as it reads them. The frame reads them once
  and hands the same answer to the shop panel and this one; only one of the two is ever open.
- While a deal is open the arrow keys are the list's (`Keyboard.menu`) and the chase view lets the
  pointer go, as it does in a shop.
- The preview is the shop's `ShopPreview`, with a look of kind `good`. The props are in
  `src/render/contraband-props.ts`, and `--gallery=goods` lays them all out in one picture.
- The history is twelve bars drawn as DOM elements. Block glyphs in text were tried first, and the
  panel's font does not draw them all at one width.
- `dollars()` (`src/sim/market.ts`) groups the digits by hand. `toLocaleString` reads the machine's
  own locale, and two machines would then write two different records.

## The map and the crowd

- `DealerMarks` (`src/ui/dealers.ts`) owns both of the dealers' bodies on screen: the `dealer` mark
  on the maps and the person standing on the corner. It rewrites them when the spell turns and
  leaves them alone every other frame.
- The body is one instance of the crowd's own mesh (`PedestrianView.standing`), so a dealer costs
  no draw call. They are dressed as the district they work in, from `lookOf`.
- That list is not written here, though. `EnforcerMarks` (`src/ui/enforcers.ts`) writes it for the
  dealers and the faction enforcers of spec section 17.2 together, because the mesh reads one list
  and the enforcers move every tick. `DealerMarks.marks` is what it reads the dealers' own marks
  off, and not `MapPois.extra`, which it is about to replace.
- The minimap redraws only when the player has moved, so a dealer who moves while the player stands
  still is marked at their last corner until the player takes a step. It is the map that is late,
  never the deal: `dealerAt` reads `pitchOf` on the tick.

## The factions

- `favourOf` is where the faction reputation of spec section 17.3 enters a price, and the only place
  it does: it moves the dealer's cut, so standing with the faction whose district this is is worth
  money on its corners. A dealer in a district nobody runs has no opinion. `docs/factions.md` is the
  rest of it.
- Every trade credits that faction a hundredth of the range (`credit`), which through
  `shiftStanding` costs their rivals half as much. Business is how a stranger becomes a name, and
  until the missions of spec section 18 land it is the only way the player builds a reputation at
  all.
- `dealRefusal` takes the dealer as well as the record, because the third reason they will not trade
  is who the player has crossed. Call it without one and you get the two old reasons only.
