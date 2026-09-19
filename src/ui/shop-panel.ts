/**
 * The shop panel of spec section 16.1.
 *
 * The rules are in `src/sim/shop.ts` and `src/sim/shop-stock.ts`, and this
 * draws them. A player standing at a door is shown what the shop is and told
 * which key opens it, or why it will not open. A player inside one is shown its
 * counter: the rows under their headings, a card for the row the cursor is on,
 * with a slowly turning preview of the thing itself, and what the last purchase
 * said.
 *
 * The cursor is the panel's own, not the record's. The mouse moves it by
 * hovering, the arrow keys by stepping, and a tap on a touch screen by
 * choosing. Buying always goes through the record: a click, `Enter` or a
 * number key hands the row to `Keyboard`, whose next frame of input carries it
 * as `InputFrame.buy`. So a purchase made with the mouse replays as one made
 * with the keys.
 *
 * A row the player cannot afford is shown and marked rather than hidden, so the
 * counter reads the same however much money is in a pocket.
 *
 * Only what changed is written, as the HUD and the metro panel do: a panel
 * standing still writes nothing.
 */
import type { WebGPURenderer } from 'three/webgpu';
import { ShopPreview } from '../render/shop-preview.ts';
import type { SafehousePlace } from '../sim/safehouse.ts';
import type { SimState } from '../sim/simulation.ts';
import { shopAt, shopOffers, shopRefusal, visiting, type ShopPlace } from '../sim/shop.ts';
import type { ShopOffer } from '../sim/shop-stock.ts';
import { CHOICE_KEYS } from './keyboard.ts';

/** The key that opens a shop door, as `controls.ts` lists it. */
const ENTER_KEY = 'E';

/** What the panel hands back to the input: a row bought, counted from 1, and a press of the leave key. */
export interface ShopActions {
  choose: (row: number) => void;
  leave: () => void;
}

/** The keys the counter reads beside the number keys, as `Keyboard.menuKeys` answers them. */
export interface ShopNav {
  step: number;
  enter: boolean;
}

const NO_NAV: ShopNav = { step: 0, enter: false };

export class ShopPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly purse: HTMLElement;
  private readonly door: HTMLElement;
  private readonly body: HTMLElement;
  private readonly list: HTMLElement;
  private readonly card: HTMLElement;
  private readonly window: HTMLElement;
  private readonly name: HTMLElement;
  private readonly price: HTMLElement;
  private readonly blurb: HTMLElement;
  private readonly facts: HTMLElement;
  private readonly buy: HTMLButtonElement;
  private readonly said: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly actions: ShopActions | undefined;
  private readonly renderer: WebGPURenderer | undefined;
  private preview: ShopPreview | undefined;
  /** One element per row of the counter, in the order of the offers. */
  private rows: HTMLElement[] = [];
  private offers: ShopOffer[] = [];
  /** What the rows were last built from, so a counter standing still builds nothing. */
  private shownRows = '';
  private shownDoor = '';
  private shownSaid = '';
  private shownMoney = -1;
  /** The visit the cursor belongs to: a new visit starts it at the top. */
  private visit = -1;
  private cursor = 0;
  /** The row the card was last written for, and that row's label. */
  private carded = -1;
  private cardFor: string | undefined;
  /** The kind of pointer that last went down on the panel: a tap chooses, a click buys. */
  private pointer = 'mouse';
  private state: SimState | undefined;

  constructor(parent: HTMLElement, renderer?: WebGPURenderer, actions?: ShopActions) {
    this.renderer = renderer;
    this.actions = actions;
    this.root = element('div', 'shop');
    this.root.hidden = true;
    const head = element('div', 'shop-head');
    this.title = element('div', 'shop-title');
    this.purse = element('div', 'shop-purse');
    head.append(this.title, this.purse);
    this.door = element('div', 'shop-door');
    this.body = element('div', 'shop-body');
    this.list = element('div', 'shop-list');
    this.card = element('div', 'shop-card');
    this.window = element('div', 'shop-window');
    this.name = element('div', 'shop-card-name');
    this.price = element('div', 'shop-card-price');
    this.blurb = element('div', 'shop-card-blurb');
    this.facts = element('div', 'shop-facts');
    this.buy = document.createElement('button');
    this.buy.type = 'button';
    this.buy.className = 'shop-buy';
    this.buy.addEventListener('click', () => this.choose(this.cursor));
    // The words scroll under the window and over the button, which stay put.
    const info = element('div', 'shop-card-info');
    info.append(this.name, this.price, this.blurb, this.facts);
    this.card.append(this.window, info, this.buy);
    this.body.append(this.list, this.card);
    this.said = element('div', 'shop-said');
    this.said.hidden = true;
    this.foot = element('div', 'shop-foot');
    const hint = element('span', 'shop-hint');
    hint.textContent = `↑ ↓ choose · Enter or click buys · 1–${CHOICE_KEYS} buy`;
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'shop-leave';
    leave.textContent = `${ENTER_KEY} · leave`;
    leave.addEventListener('click', () => this.actions?.leave());
    this.foot.append(hint, leave);
    this.root.append(head, this.door, this.body, this.said, this.foot);
    this.root.addEventListener('pointerdown', (e) => {
      this.pointer = e.pointerType;
    });
    parent.append(this.root);
  }

  /**
   * Draw the panel for the shop the player is inside, or for the door they are
   * standing at. Nothing is drawn where they are neither. `nav` is the step and
   * the `Enter` of the counter's keys this frame.
   */
  update(
    state: SimState,
    places: readonly ShopPlace[],
    homes: readonly SafehousePlace[] = [],
    nav: ShopNav = NO_NAV,
  ): void {
    this.state = state;
    const inside = visiting(state, places);
    const place = inside ?? places[shopAt(places, state)];
    if (place === undefined) {
      this.hide();
      return;
    }
    this.root.hidden = false;
    this.title.textContent = place.name;
    if (inside === undefined) {
      this.showDoor(state, place);
      return;
    }
    this.root.classList.remove('shop-at-door');
    this.door.hidden = true;
    this.body.hidden = false;
    this.foot.hidden = false;
    const visit = state.shop?.started ?? -1;
    if (visit !== this.visit) {
      this.visit = visit;
      this.cursor = 0;
      this.shownSaid = '';
    }
    this.offers = shopOffers(state, places, homes);
    this.drawRows(state);
    if (nav.step !== 0 && this.offers.length > 0) this.select(this.cursor + nav.step, true);
    if (nav.enter) this.choose(this.cursor);
    this.drawCard(state);
    this.drawSaid(state.shop?.said ?? '');
    if (state.money !== this.shownMoney) {
      this.shownMoney = state.money;
      this.purse.textContent = `$${state.money.toLocaleString('en-US')}`;
    }
  }

  /** Turn and draw the preview. Called after the city is drawn, once a frame. */
  drawPreview(seconds: number): void {
    if (this.root.hidden || this.body.hidden) return;
    this.preview?.draw(seconds);
  }

  destroy(): void {
    this.preview?.dispose();
    this.root.remove();
  }

  private hide(): void {
    this.root.hidden = true;
    this.shownDoor = '';
    this.shownRows = '';
    this.visit = -1;
    this.preview?.show(undefined);
  }

  /** The panel at the door: the shop's name and how to go in, or why not. */
  private showDoor(state: SimState, place: ShopPlace): void {
    this.root.classList.add('shop-at-door');
    this.body.hidden = true;
    this.foot.hidden = true;
    this.said.hidden = true;
    this.door.hidden = false;
    this.shownRows = '';
    this.visit = -1;
    this.purse.textContent = '';
    this.shownMoney = -1;
    const refusal = shopRefusal(state, place);
    const text = refusal ?? `${ENTER_KEY} · go in`;
    if (text === this.shownDoor) return;
    this.shownDoor = text;
    this.door.textContent = text;
    this.door.className = refusal === null ? 'shop-door' : 'shop-door shop-refused';
  }

  /**
   * The rows under their headings. They are built again only when the counter
   * changes, and only the marks of what the player can afford when the money
   * does.
   */
  private drawRows(state: SimState): void {
    const key = this.offers.map((offer) => `${offer.group}|${offer.label}|${offer.price}`).join('\n');
    if (key !== this.shownRows) {
      this.shownRows = key;
      this.carded = -1;
      this.rows = [];
      const children: HTMLElement[] = [];
      let group = '';
      this.offers.forEach((offer, i) => {
        if (offer.group !== group) {
          group = offer.group;
          const heading = element('div', 'shop-group');
          heading.textContent = group;
          children.push(heading);
        }
        const row = this.row(offer, i);
        this.rows.push(row);
        children.push(row);
      });
      if (children.length === 0) {
        const empty = element('div', 'shop-empty');
        empty.textContent = 'Nothing for sale today.';
        children.push(empty);
      }
      this.list.replaceChildren(...children);
      this.card.hidden = this.offers.length === 0;
      this.cursor = Math.min(this.cursor, Math.max(0, this.offers.length - 1));
      this.mark();
    }
    this.offers.forEach((offer, i) => {
      this.rows[i]?.classList.toggle('shop-dear', state.money < offer.price);
    });
  }

  private row(offer: ShopOffer, i: number): HTMLElement {
    const row = element('div', 'shop-row');
    const keyCap = element('span', 'shop-key');
    keyCap.textContent = i < CHOICE_KEYS ? `${i + 1}` : '';
    const label = element('span', 'shop-label');
    label.textContent = offer.label.replace(' · back room', '');
    const price = element('span', 'shop-price');
    price.textContent = priceText(offer.price);
    row.append(keyCap, label, price);
    row.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') this.select(i, false);
    });
    row.addEventListener('click', () => {
      // A tap on a touch screen has no hover before it, so the first tap
      // chooses and a second on the same row buys; a mouse click buys at once.
      if (this.pointer !== 'mouse' && this.cursor !== i) this.select(i, false);
      else this.choose(i);
    });
    return row;
  }

  /** Move the cursor to a row, wrapping round the ends, and keep it in sight. */
  private select(index: number, scroll: boolean): void {
    const count = this.offers.length;
    if (count === 0) return;
    this.cursor = ((index % count) + count) % count;
    this.mark();
    if (this.state !== undefined) this.drawCard(this.state);
    // After the card: a card of another length can change the height of the
    // list, and a row scrolled into view before that is left cut off.
    if (scroll) this.scrollTo(this.cursor);
  }

  /**
   * Bring a row into view below the sticky heading of its group, which
   * `scrollIntoView` does not know covers the top of the list.
   */
  private scrollTo(index: number): void {
    const row = this.rows[index];
    if (row === undefined) return;
    const list = this.list.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const heading = this.list.querySelector<HTMLElement>('.shop-group')?.offsetHeight ?? 0;
    if (box.top < list.top + heading) this.list.scrollTop -= list.top + heading - box.top;
    else if (box.bottom > list.bottom) this.list.scrollTop += box.bottom - list.bottom;
  }

  private mark(): void {
    this.rows.forEach((row, i) => row.classList.toggle('shop-current', i === this.cursor));
  }

  /** Hand a row to the input, to be bought on the next tick. */
  private choose(index: number): void {
    if (this.offers[index] === undefined) return;
    this.select(index, false);
    this.actions?.choose(index + 1);
  }

  /** The card of the row the cursor is on: the preview, the name, the price and the facts. */
  private drawCard(state: SimState): void {
    const offer = this.offers[this.cursor];
    const dear = offer !== undefined && state.money < offer.price;
    this.buy.disabled = offer === undefined;
    this.buy.textContent = offer === undefined ? '' : dear ? 'Not enough money' : `Buy · ${priceText(offer.price)}`;
    this.buy.classList.toggle('shop-buy-dear', dear);
    if (this.carded === this.cursor && this.cardFor === offer?.label) return;
    this.carded = this.cursor;
    this.cardFor = offer?.label;
    if (offer === undefined) {
      this.preview?.show(undefined);
      return;
    }
    this.name.textContent = offer.label.replace(' · back room', '');
    this.price.textContent = priceText(offer.price);
    this.blurb.textContent = offer.blurb;
    this.facts.replaceChildren(...offer.facts.map(fact));
    this.card.classList.toggle('shop-card-back', offer.group === 'Back room');
    this.ensurePreview()?.show(offer.look, state.character);
  }

  /** The preview is made on the first counter a session opens, since most never open one. */
  private ensurePreview(): ShopPreview | undefined {
    if (this.preview === undefined && this.renderer !== undefined) {
      this.preview = new ShopPreview(this.renderer);
      this.window.append(this.preview.canvas);
    }
    return this.preview;
  }

  /** What the last purchase said, flashed in again whenever it changes. */
  private drawSaid(said: string): void {
    if (said === this.shownSaid) return;
    this.shownSaid = said;
    this.said.hidden = said === '';
    this.said.textContent = said;
    this.said.classList.toggle('shop-said-short', said === 'Not enough money.');
    this.said.classList.remove('shop-said-flash');
    // Reading the width restarts the animation the class is about to add back.
    void this.said.offsetWidth;
    this.said.classList.add('shop-said-flash');
  }
}

function priceText(price: number): string {
  return price === 0 ? 'Free' : `$${price.toLocaleString('en-US')}`;
}

/** One line of the card: a label, a gauge where the fact has one, and the value. */
function fact(item: ShopOffer['facts'][number]): HTMLElement {
  const line = element('div', 'shop-fact');
  const label = element('span', 'shop-fact-label');
  label.textContent = item.label;
  const gauge = element('span', 'shop-gauge');
  if (item.bar !== undefined) {
    const fill = element('span', 'shop-gauge-fill');
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, item.bar)) * 100)}%`;
    gauge.append(fill);
  } else gauge.classList.add('shop-gauge-none');
  const value = element('span', 'shop-fact-value');
  value.textContent = item.text;
  line.append(label, gauge, value);
  return line;
}

function element(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}
