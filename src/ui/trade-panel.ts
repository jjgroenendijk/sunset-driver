/**
 * The trading panel of spec section 12, for the contraband market of 16.2.
 *
 * The rules are in `src/sim/market.ts`, `src/sim/contraband.ts` and
 * `src/sim/dealer.ts`, and this draws them. It wears the shop counter's layout
 * (`shop-panel.ts`, `shop.css`), so a dealer reads like every other counter in
 * the game. A player at a dealer's corner is told which key opens the deal, or
 * why the dealer will not have one. A player in a deal is shown the district's
 * prices: the goods under their headings on the left, and on the right a card
 * for the good under the cursor, with a turning preview of it, what it costs
 * here against an ordinary day, the last half day of its price and what the
 * player's own holding would make.
 *
 * The cursor is the panel's own, not the record's. The mouse moves it by
 * clicking a row, the arrow keys by stepping. A trade always goes through the
 * record: the buy and sell buttons and `Enter` hand the good to `Keyboard`,
 * whose next frame of input carries it as `InputFrame.trade`, so a trade made
 * with the mouse replays as one made with the keys. A click on a row never
 * trades, because a buy takes all the money and the room allow.
 *
 * The history is drawn as a row of twelve small bars in the DOM rather than on
 * a canvas: a canvas would be a second surface to size and redraw for twelve
 * numbers nobody reads to the dollar. Bars in text were tried first, and the
 * block glyphs of the panel's font are not all one width.
 *
 * Only what changed is written, as the HUD does: a price that stands still
 * writes nothing.
 */
import type { WebGPURenderer } from 'three/webgpu';
import { ShopPreview } from '../render/shop-preview.ts';
import { TICKS_PER_HOUR } from '../sim/clock.ts';
import { GLUT, GOODS, priceRun, SPIKE, type Good } from '../sim/contraband.ts';
import { dealerAt, dealRefusal, type DealerPlace } from '../sim/dealer.ts';
import { FACTIONS, factionForCulture } from '../sim/faction.ts';
import { carrying, dealing, dollars, favourOf, tradeRows, STASH_UNITS, type TradeRow } from '../sim/market.ts';
import type { SimState } from '../sim/simulation.ts';
import type { ShopNav } from './shop-panel.ts';

/** The key that opens and ends a deal, as `controls.ts` lists it. */
const DEAL_KEY = 'E';

/** Prices drawn in the history, and the game hours between them: half a day. */
const HISTORY = 12;
const HISTORY_STEP = TICKS_PER_HOUR;

/** The least height a bar of the history is drawn at, as a share of the tallest, so a low price still shows. */
const LEAST_BAR = 0.12;

/** The rows the number keys reach, as `Keyboard` reads them. */
const NUMBERED = 9;

/** What the panel hands back to the input: a good traded, as `InputFrame.trade` counts it, and the leave key. */
export interface TradeActions {
  trade: (good: number) => void;
  leave: () => void;
}

const NO_NAV: ShopNav = { step: 0, enter: false };

/** The cells of one row of the list, made once and written after that. */
interface RowCells {
  line: HTMLElement;
  held: HTMLElement;
  price: HTMLElement;
}

export class TradePanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly purse: HTMLElement;
  private readonly door: HTMLElement;
  private readonly load: HTMLElement;
  private readonly loadText: HTMLElement;
  private readonly loadFill: HTMLElement;
  private readonly body: HTMLElement;
  private readonly list: HTMLElement;
  private readonly window: HTMLElement;
  private readonly name: HTMLElement;
  private readonly price: HTMLElement;
  private readonly blurb: HTMLElement;
  private readonly facts: HTMLElement;
  private readonly buyButton: HTMLButtonElement;
  private readonly sellButton: HTMLButtonElement;
  private readonly said: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly actions: TradeActions | undefined;
  private readonly renderer: WebGPURenderer | undefined;
  private preview: ShopPreview | undefined;
  /** One set of cells per good, in the order of `GOODS`, made on the first deal. */
  private readonly rows: RowCells[] = [];
  private rowsNow: TradeRow[] = [];
  /** The deal the cursor belongs to: a new deal starts it at the top. */
  private deal = -1;
  private cursor = 0;
  private shownSaid = '';
  private shownCard = '';

  constructor(parent: HTMLElement, renderer?: WebGPURenderer, actions?: TradeActions) {
    this.renderer = renderer;
    this.actions = actions;
    this.root = element('div', 'shop trade');
    this.root.hidden = true;
    const head = element('div', 'shop-head');
    this.title = element('div', 'shop-title');
    this.purse = element('div', 'shop-purse');
    head.append(this.title, this.purse);
    this.door = element('div', 'shop-door');
    // How much of the carrying the stash takes up, as a gauge under the heading.
    this.load = element('div', 'shop-fact trade-load');
    const loadLabel = element('span', 'shop-fact-label');
    loadLabel.textContent = 'Carrying';
    const gauge = element('span', 'shop-gauge');
    this.loadFill = element('span', 'shop-gauge-fill');
    gauge.append(this.loadFill);
    this.loadText = element('span', 'shop-fact-value');
    this.load.append(loadLabel, gauge, this.loadText);
    this.body = element('div', 'shop-body');
    this.list = element('div', 'shop-list');
    const card = element('div', 'shop-card');
    this.window = element('div', 'shop-window');
    this.name = element('div', 'shop-card-name');
    this.price = element('div', 'shop-card-price');
    this.blurb = element('div', 'shop-card-blurb');
    this.facts = element('div', 'shop-facts');
    const info = element('div', 'shop-card-info');
    info.append(this.name, this.price, this.blurb, this.facts);
    const buttons = element('div', 'trade-buttons');
    this.buyButton = button('shop-buy', () => this.act(false));
    this.sellButton = button('shop-buy trade-sell', () => this.act(true));
    buttons.append(this.buyButton, this.sellButton);
    card.append(this.window, info, buttons);
    this.body.append(this.list, card);
    this.said = element('div', 'shop-said');
    this.said.hidden = true;
    this.foot = element('div', 'shop-foot');
    const hint = element('span', 'shop-hint');
    hint.textContent = '↑ ↓ choose · Enter buys · Shift+Enter sells';
    const leave = button('shop-leave', () => this.actions?.leave());
    leave.textContent = `${DEAL_KEY} · walk away`;
    this.foot.append(hint, leave);
    this.root.append(head, this.door, this.load, this.body, this.said, this.foot);
    parent.append(this.root);
  }

  /**
   * Draw the panel for the deal the player has open, or for the corner they are
   * standing on. Nothing is drawn where they are neither. `nav` is the step,
   * the `Enter` and the sell key of the counter's keys this frame.
   */
  update(state: SimState, dealers: readonly DealerPlace[], nav: ShopNav = NO_NAV): void {
    const inside = dealing(state, dealers);
    const dealer = inside ?? dealers[dealerAt(dealers, state)];
    if (dealer === undefined) {
      this.hide();
      return;
    }
    show(this.root, true);
    write(this.title, dealer.name);
    if (inside === undefined) {
      this.showCorner(state, dealer);
      return;
    }
    this.root.classList.remove('shop-at-door');
    show(this.door, false);
    show(this.load, true);
    show(this.body, true);
    show(this.foot, true);
    const deal = state.market.deal?.started ?? -1;
    if (deal !== this.deal) {
      this.deal = deal;
      this.cursor = 0;
      this.shownSaid = '';
    }
    write(this.purse, dollars(state.money));
    const held = carrying(state.market);
    write(this.loadText, `${held} of ${STASH_UNITS}`);
    const share = `${Math.round((held / STASH_UNITS) * 100)}%`;
    if (this.loadFill.style.width !== share) this.loadFill.style.width = share;
    this.rowsNow = tradeRows(state, dealers);
    this.drawRows();
    if (nav.step !== 0) this.select(this.cursor + nav.step, true);
    if (nav.enter) this.act(nav.sell === true);
    this.drawCard(state, dealer);
    this.drawSaid(state.market.deal?.said ?? '');
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
    show(this.root, false);
    this.deal = -1;
    this.shownCard = '';
    this.preview?.show(undefined);
  }

  /** The panel at the corner: the dealer's name and how to deal, or why not. */
  private showCorner(state: SimState, dealer: DealerPlace): void {
    this.root.classList.add('shop-at-door');
    show(this.door, true);
    show(this.load, false);
    show(this.body, false);
    show(this.foot, false);
    show(this.said, false);
    write(this.purse, '');
    this.deal = -1;
    this.shownCard = '';
    this.shownSaid = '';
    const refusal = dealRefusal(state, dealer);
    write(this.door, refusal ?? `${DEAL_KEY} · deal`);
    const className = refusal === null ? 'shop-door' : 'shop-door shop-refused';
    if (this.door.className !== className) this.door.className = className;
  }

  /** The goods under their headings, built on the first deal and written after that. */
  private drawRows(): void {
    if (this.rows.length === 0) {
      let group = '';
      GOODS.forEach((good, i) => {
        if (good.group !== group) {
          group = good.group;
          const heading = element('div', 'shop-group');
          heading.textContent = group;
          this.list.append(heading);
        }
        this.rows.push(this.makeRow(good, i));
      });
    }
    this.rowsNow.forEach((row, i) => {
      const cells = this.rows[i];
      if (cells === undefined) return;
      write(cells.held, row.held > 0 ? `×${row.held}` : '');
      write(cells.price, `${moodMark(row.mood)}${dollars(row.buy)}`);
      const className = withTone('shop-price', row.mood);
      if (cells.price.className !== className) cells.price.className = className;
      cells.line.classList.toggle('shop-dear', row.room === 0 && row.held === 0);
      cells.line.classList.toggle('shop-current', i === this.cursor);
    });
  }

  private makeRow(good: Good, i: number): RowCells {
    const line = element('div', 'shop-row trade-row');
    const key = element('span', 'trade-key');
    key.textContent = i < NUMBERED ? String(i + 1) : '';
    const label = element('span', 'shop-label');
    label.textContent = good.name;
    const held = element('span', 'trade-held');
    const price = element('span', 'shop-price');
    line.append(key, label, held, price);
    line.addEventListener('click', () => this.select(i, false));
    this.list.append(line);
    return { line, held, price };
  }

  /** Move the cursor to a row, wrapping round the ends, and keep it in sight. */
  private select(index: number, scroll: boolean): void {
    const count = GOODS.length;
    this.cursor = ((index % count) + count) % count;
    this.rows.forEach((cells, i) => cells.line.classList.toggle('shop-current', i === this.cursor));
    if (scroll) this.scrollTo(this.cursor);
  }

  /** Bring a row into view below the sticky heading of its group. */
  private scrollTo(index: number): void {
    const row = this.rows[index]?.line;
    if (row === undefined) return;
    const list = this.list.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const heading = this.list.querySelector<HTMLElement>('.shop-group')?.offsetHeight ?? 0;
    if (box.top < list.top + heading) this.list.scrollTop -= list.top + heading - box.top;
    else if (box.bottom > list.bottom) this.list.scrollTop += box.bottom - list.bottom;
  }

  /** Hand the good under the cursor to the input, bought or sold on the next tick. */
  private act(sell: boolean): void {
    const row = this.rowsNow[this.cursor];
    if (row === undefined) return;
    this.actions?.trade(sell ? -(row.good + 1) : row.good + 1);
  }

  /** The card of the good under the cursor: the preview, the prices and the facts. */
  private drawCard(state: SimState, dealer: DealerPlace): void {
    const row = this.rowsNow[this.cursor];
    const good = GOODS[this.cursor];
    if (row === undefined || good === undefined) return;
    this.buyButton.textContent = row.room > 0 ? `Buy ${row.room} · ${dollars(row.room * row.buy)}` : cannotBuy(state, row);
    this.buyButton.disabled = row.room === 0;
    this.sellButton.textContent = row.held > 0 ? `Sell ${row.held} · ${dollars(row.held * row.sell)}` : 'Nothing to sell';
    this.sellButton.disabled = row.held === 0;
    const history = heights(priceRun(state.seed, state.tick, dealer.district, row.good, HISTORY, HISTORY_STEP));
    const facts = cardFacts(row, good, history, favourOf(state, dealer));
    const key = `${this.cursor}|${row.buy}|${row.sell}|${row.held}|${row.paid}|${history.join(',')}`;
    if (key === this.shownCard) return;
    const same = this.shownCard.split('|')[0] === String(this.cursor);
    this.shownCard = key;
    this.name.textContent = good.name;
    this.price.textContent = `${dollars(row.buy)} a unit · they pay ${dollars(row.sell)}`;
    this.blurb.textContent = good.blurb;
    this.facts.replaceChildren(...facts.map(fact));
    if (!same) this.ensurePreview()?.show({ kind: 'good', good: good.id });
  }

  /** The preview is made on the first deal a session opens, since most never open one. */
  private ensurePreview(): ShopPreview | undefined {
    if (this.preview === undefined && this.renderer !== undefined) {
      this.preview = new ShopPreview(this.renderer);
      this.window.append(this.preview.canvas);
    }
    return this.preview;
  }

  /** What the last trade said, flashed in again whenever it changes. */
  private drawSaid(said: string): void {
    if (said === this.shownSaid) return;
    this.shownSaid = said;
    this.said.hidden = said === '';
    this.said.textContent = said;
    const short = !said.startsWith('Bought') && !said.startsWith('Sold');
    this.said.classList.toggle('shop-said-short', short || said.includes('Down $'));
    this.said.classList.remove('shop-said-flash');
    // Reading the layout restarts the animation the class is about to add back.
    this.said.getBoundingClientRect();
    this.said.classList.add('shop-said-flash');
  }
}

/** One line of the card: a label, a gauge where it has one, and the value. */
interface Fact {
  label: string;
  text: string;
  bar?: number;
  /** A run of heights 0..1, drawn as a row of bars in place of the text. */
  spark?: readonly number[];
  /** The colour of the value: a spike or a glut of the price, or a sale up or down. */
  tone?: 'spike' | 'glut' | 'up' | 'down';
}

/**
 * The facts of one good at this corner. The price gauge runs from a glut to a
 * spike, with an ordinary day in the middle of it.
 */
export function cardFacts(row: TradeRow, good: Good, history: readonly number[], favour: number): Fact[] {
  const against = row.buy / row.standing;
  const change = Math.round((against - 1) * 100);
  const facts: Fact[] = [
    { label: 'Here', text: priceText(row.mood, change), bar: (against - GLUT) / (SPIKE - GLUT), tone: moodTone(row.mood) },
    { label: '12 hours', text: '', spark: history },
    { label: 'Cheapest', text: homeOf(good) },
  ];
  if (row.held > 0) facts.push(...holdingFacts(row));
  if (favour !== 0) facts.push({ label: 'Terms', text: favour > 0 ? 'They like you' : 'They do not trust you', bar: (favour + 1) / 2 });
  return facts;
}

/** The price here against the usual one, as `change` percent over it. */
function priceText(mood: string, change: number): string {
  if (mood === 'spike') return `Spike, +${change}%`;
  if (mood === 'glut') return `Glut, ${change}%`;
  if (change === 0) return 'Usual price';
  const sign = change > 0 ? '+' : '';
  return `${sign}${change}% on usual`;
}

/** The colour a price's mood gives its value: a spike, a glut or none. */
function moodTone(mood: string): Fact['tone'] {
  if (mood === 'spike') return 'spike';
  return mood === 'glut' ? 'glut' : undefined;
}

/** What the player holds of a good, and what selling it now would make or lose. */
function holdingFacts(row: TradeRow): Fact[] {
  const each = Math.round(row.paid / row.held);
  const made = row.held * row.sell - row.paid;
  const sale = made >= 0 ? `Up ${dollars(made)}` : `Down ${dollars(-made)}`;
  return [
    { label: 'Holding', text: `${row.held} at ${dollars(each)}` },
    { label: 'Sale now', text: sale, tone: made >= 0 ? 'up' : 'down' },
  ];
}

/** A class name with the trade colour of `tone` added, where there is one. */
function withTone(className: string, tone: string | undefined): string {
  return tone === undefined || tone === '' ? className : `${className} trade-${tone}`;
}

/** Where a good is cheap: the turf of the faction whose people trade it at home. */
function homeOf(good: Good): string {
  if (good.home === 'beach') return 'By the beach';
  if (good.home === 'none') return 'On unclaimed streets';
  const faction = FACTIONS[factionForCulture(good.home)];
  return faction === undefined ? 'Anywhere' : `${faction.name} turf`;
}

/** What the buy button says when it can take nothing, and why. */
function cannotBuy(state: SimState, row: TradeRow): string {
  if (carrying(state.market) >= STASH_UNITS) return 'Carrying all you can';
  return state.money < row.buy ? 'Not enough money' : 'Cannot buy';
}

/** A spike is marked up and a glut down, so the list can be read at a glance. */
function moodMark(mood: string): string {
  if (mood === 'spike') return '▲ ';
  return mood === 'glut' ? '▼ ' : '';
}

function fact(item: Fact): HTMLElement {
  const line = element('div', 'shop-fact');
  const label = element('span', 'shop-fact-label');
  label.textContent = item.label;
  const gauge = element('span', 'shop-gauge');
  if (item.bar !== undefined) {
    const fill = element('span', 'shop-gauge-fill');
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, item.bar)) * 100)}%`;
    gauge.append(fill);
  } else gauge.classList.add('shop-gauge-none');
  const value = element('span', withTone('shop-fact-value', item.tone));
  value.textContent = item.text;
  if (item.spark !== undefined) {
    value.classList.add('trade-spark');
    for (const height of item.spark) {
      const bar = element('span', 'trade-spark-bar');
      bar.style.height = `${Math.round(height * 100)}%`;
      value.append(bar);
    }
  }
  line.append(label, gauge, value);
  return line;
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(className: string, click: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.addEventListener('click', click);
  return node;
}

/** Show or hide a node only where that is a change, because a change lays the overlay out again. */
function show(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible;
}

/** Write a node only where its text has changed, for the same reason. */
function write(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * A run of prices as the heights of its bars, 0..1, scaled between the lowest
 * and the highest of the run. A flat run draws flat: what the player needs from
 * it is the shape of the last few hours, not the dollars, which the card
 * already gives them.
 */
export function heights(run: readonly number[]): number[] {
  let low = Infinity;
  let high = -Infinity;
  for (const price of run) {
    low = Math.min(low, price);
    high = Math.max(high, price);
  }
  const span = high - low;
  return run.map((price) => (span <= 0 ? LEAST_BAR : LEAST_BAR + ((price - low) / span) * (1 - LEAST_BAR)));
}
