# The contraband market

The gotchas of spec section 16.2: what a good is worth in a district, where the dealers are
standing, and what a deal does to the record. The shops the player walks into are a different
trade, in `docs/shops.md`; the record both of them write is `src/sim/simulation.ts`, in
`docs/sim-and-ui.md`.

## Contents

- Nothing about a price is stored
- What moves a price
- The dealers and their corners
- The deal
- The panel
- The map and the crowd

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
  `PITCHES` corners spread round the district's site and hands each to `snap`, which is
  `nearestRoadPlace` in the game: a dealer stands on a street, not in the middle of a block. The
  snap is handed in rather than imported so that a simulation test can put a dealer on a hillside
  with no roads on it.
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
- `favourOf` is the seam for the faction reputation of spec section 17.3: it moves the dealer's
  cut, and it is the only place a reputation will enter a price. Nothing carries one yet, so it
  answers 0 for everybody.

## The panel

- `src/ui/trade-panel.ts` draws the record and nothing else, as the shop panel does. Its cells are
  made once and written only when their own text changes: six rows of prices that move every few
  ticks would otherwise lay the whole overlay out again for a dollar.
- The history is a line of bars in text. A canvas here would be a second surface to size, to scale
  and to redraw for twelve numbers nobody reads to the dollar.
- `dollars()` (`src/sim/market.ts`) groups the digits by hand. `toLocaleString` reads the machine's
  own locale, and two machines would then write two different records.

## The map and the crowd

- `DealerMarks` (`src/ui/dealers.ts`) owns both of the dealers' bodies on screen: the `dealer` mark
  on the maps and the person standing on the corner. It rewrites them when the spell turns and
  leaves them alone every other frame.
- The body is one instance of the crowd's own mesh (`PedestrianView.standing`), so a dealer costs
  no draw call. They are dressed as the district they work in, from `lookOf`.
- The minimap redraws only when the player has moved, so a dealer who moves while the player stands
  still is marked at their last corner until the player takes a step. It is the map that is late,
  never the deal: `dealerAt` reads `pitchOf` on the tick.
