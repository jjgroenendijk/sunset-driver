/**
 * The panel at a safehouse's front door (spec section 16.3).
 *
 * The rules are in `src/sim/safehouse.ts` and this draws them. A player at a
 * door they do not own is told what the property costs and who sells it; a
 * player at their own is told which key opens it; a player with it open is
 * shown what the house does — the respawn point, the stash and the garage —
 * one line per row, numbered as the keys that choose them.
 *
 * It is the shop panel's twin and stands where the shop panel stands, because
 * the two are never on screen at once: a player inside a shop is not standing
 * on their own step.
 *
 * Only what changed is written, as the HUD and the other panels do: a panel
 * standing still writes nothing.
 */
import { dollars } from '../sim/market.ts';
import {
  homeOffers,
  ownedAt,
  safehouseAt,
  visitingHome,
  type SafehousePlace,
} from '../sim/safehouse.ts';
import type { SimState } from '../sim/simulation.ts';
import { CHOICE_KEYS } from './keyboard.ts';

/** The key that opens a front door, as `controls.ts` lists it. */
const ENTER_KEY = 'E';

export class HomePanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'home';
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'home-title';
    this.list = document.createElement('div');
    this.list.className = 'home-list';
    this.root.append(this.title, this.list);
    parent.append(this.root);
  }

  /**
   * Draw the panel for the safehouse whose door is open, or for the door the
   * player is standing at. Nothing is drawn where they are neither.
   */
  update(state: SimState, places: readonly SafehousePlace[]): void {
    const inside = visitingHome(state, places);
    // A shop room can stand within reach of a front door, and the shop panel
    // draws where this one does: the counter the player is at wins.
    const place = state.shop === null ? (inside ?? places[safehouseAt(places, state)]) : undefined;
    if (place === undefined) {
      this.hide();
      return;
    }
    const rows = inside === undefined ? [doorLine(state, place)] : panel(state, place);
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

/** What a player standing at the door is told: how to go in, or what it costs. */
function doorLine(state: SimState, place: SafehousePlace): Row {
  if (ownedAt(state, place.id) === undefined) {
    return { text: `For sale · ${dollars(place.price)} · at a property broker`, className: 'home-price' };
  }
  if (state.player.driving) return { text: 'Not with a vehicle.', className: 'home-price' };
  return { text: `${ENTER_KEY} · go in`, className: 'home-row' };
}

/** What the house does, inside: one row per thing, and the line the last one left. */
function panel(state: SimState, place: SafehousePlace): Row[] {
  const rows: Row[] = homeOffers(state, place)
    .slice(0, CHOICE_KEYS)
    .map((offer, i) => ({ text: `${i + 1} · ${offer.label}`, className: 'home-row' }));
  if (state.property.active === place.id) rows.unshift({ text: 'You come back here.', className: 'home-here' });
  const said = state.property.visit?.said ?? '';
  if (said !== '') rows.push({ text: said, className: 'home-said' });
  rows.push({ text: `${ENTER_KEY} · leave`, className: 'home-row' });
  return rows;
}
