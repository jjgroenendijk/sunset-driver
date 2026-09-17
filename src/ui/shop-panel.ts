/**
 * The shop panel of spec section 16.1.
 *
 * The rules are in `src/sim/shop.ts` and `src/sim/shop-stock.ts`, and this
 * draws them. A player standing at a door is shown what the shop is and told
 * which key opens it, or why it will not open. A player inside one is shown its
 * counter: one line per row, numbered as the keys that buy them, with the price
 * and what the last purchase said.
 *
 * A row the player cannot afford is shown and marked rather than hidden, so the
 * counter reads the same however much money is in a pocket.
 *
 * Only what changed is written, as the HUD and the metro panel do: a panel
 * standing still writes nothing.
 */
import type { SafehousePlace } from '../sim/safehouse.ts';
import type { SimState } from '../sim/simulation.ts';
import { shopAt, shopOffers, shopRefusal, visiting, type ShopPlace } from '../sim/shop.ts';
import { CHOICE_KEYS } from './keyboard.ts';

/** The key that opens a shop door, as `controls.ts` lists it. */
const ENTER_KEY = 'E';

export class ShopPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'shop';
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'shop-title';
    this.list = document.createElement('div');
    this.list.className = 'shop-list';
    this.root.append(this.title, this.list);
    parent.append(this.root);
  }

  /**
   * Draw the panel for the shop the player is inside, or for the door they are
   * standing at. Nothing is drawn where they are neither.
   */
  update(state: SimState, places: readonly ShopPlace[], homes: readonly SafehousePlace[] = []): void {
    const inside = visiting(state, places);
    const place = inside ?? places[shopAt(places, state)];
    if (place === undefined) {
      this.hide();
      return;
    }
    const rows = inside === undefined ? [doorLine(state, place)] : counter(state, places, homes);
    const text = `${place.name}\n${rows.map((row) => row.text).join('\n')}`;
    if (text === this.shown) return;
    this.shown = text;
    this.root.hidden = false;
    this.title.textContent = place.name;
    this.list.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement('div');
        line.className = row.className;
        line.textContent = row.text;
        return line;
      }),
    );
  }

  destroy(): void {
    this.root.remove();
  }

  private hide(): void {
    this.root.hidden = true;
    this.shown = '';
  }
}

/** One line of the panel. */
interface Row {
  text: string;
  className: string;
}

/** What a player standing at the door is told: how to go in, or why they may not. */
function doorLine(state: SimState, place: ShopPlace): Row {
  const refusal = shopRefusal(state, place);
  if (refusal !== null) return { text: refusal, className: 'shop-refused' };
  return { text: `${ENTER_KEY} · go in`, className: 'shop-row' };
}

/**
 * The counter inside: one row per thing on sale, numbered as the key that buys
 * it, and the line the last purchase left. A counter with nothing on it says so,
 * because an empty panel says nothing at all.
 */
function counter(state: SimState, places: readonly ShopPlace[], homes: readonly SafehousePlace[]): Row[] {
  const offers = shopOffers(state, places, homes).slice(0, CHOICE_KEYS);
  const rows: Row[] = offers.map((offer, i) => ({
    text: `${i + 1} · ${offer.label} · $${offer.price}`,
    className: state.money >= offer.price ? 'shop-row' : 'shop-dear',
  }));
  if (rows.length === 0) rows.push({ text: 'Nothing for sale today.', className: 'shop-refused' });
  const said = state.shop?.said ?? '';
  if (said !== '') rows.push({ text: said, className: 'shop-said' });
  rows.push({ text: `${ENTER_KEY} · leave`, className: 'shop-row' });
  return rows;
}
