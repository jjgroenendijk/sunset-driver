/**
 * The trading panel of spec section 12, for the contraband market of 16.2.
 *
 * The rules are in `src/sim/market.ts`, `src/sim/contraband.ts` and
 * `src/sim/dealer.ts`, and this draws them. A player at a dealer's corner is
 * told which key opens the deal, or why the dealer will not have one. A player
 * in a deal is shown the district's prices: one line per good, numbered as the
 * key that buys it, with what the dealer pays for it, what the player is
 * carrying and where the price has been over the last half day.
 *
 * The history is drawn as a line of bars in text rather than on a canvas. The
 * panel is one small grid, and a canvas here would be a second surface to size,
 * to scale and to redraw for eight numbers nobody reads to the dollar.
 *
 * The cells are made once and written only when their own text changes, as the
 * HUD does: a price that stands still writes nothing, and a panel of six rows
 * never lays the overlay out for a good whose price did not move.
 */
import { TICKS_PER_HOUR } from '../sim/clock.ts';
import { priceRun } from '../sim/contraband.ts';
import { dealerAt, dealRefusal, type DealerPlace } from '../sim/dealer.ts';
import { carrying, dealing, dollars, tradeRows, STASH_UNITS, type TradeRow } from '../sim/market.ts';
import type { SimState } from '../sim/simulation.ts';

/** The key that opens a deal, as `controls.ts` lists it. */
const DEAL_KEY = 'E';

/** Prices drawn in the history, and the game hours between them: half a day. */
const HISTORY = 12;
const HISTORY_STEP = TICKS_PER_HOUR;

/** The bars the history is drawn with, lowest first. */
const BARS = '▁▂▃▄▅▆▇█';

/** The cells one row of the panel holds, in the order they are drawn. */
const CELLS = ['name', 'buy', 'sell', 'held', 'history'] as const;

export class TradePanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly purse: HTMLElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private readonly said: HTMLElement;
  private readonly foot: HTMLElement;
  /** One row of cells per good, made on the first draw and written after that. */
  private readonly rows: HTMLElement[][] = [];
  private shownTitle = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'trade';
    this.root.hidden = true;
    this.title = element('trade-title');
    this.purse = element('trade-purse');
    this.list = element('trade-list');
    this.note = element('trade-note');
    this.said = element('trade-said');
    this.foot = element('trade-foot');
    this.foot.textContent = `${DEAL_KEY} · walk away · number buys all you can carry · shift+number sells the lot`;
    this.root.append(this.title, this.purse, this.list, this.note, this.said, this.foot);
    parent.append(this.root);
  }

  /**
   * Draw the panel for the deal the player has open, or for the corner they are
   * standing on. Nothing is drawn where they are neither.
   */
  update(state: SimState, dealers: readonly DealerPlace[]): void {
    const inside = dealing(state, dealers);
    const dealer = inside ?? dealers[dealerAt(dealers, state)];
    if (dealer === undefined) {
      show(this.root, false);
      return;
    }
    show(this.root, true);
    write(this.title, dealer.name);
    show(this.note, inside === undefined);
    show(this.list, inside !== undefined);
    show(this.purse, inside !== undefined);
    show(this.foot, inside !== undefined);
    if (inside === undefined) {
      const refusal = dealRefusal(state);
      show(this.said, false);
      const className = refusal === null ? 'trade-note' : 'trade-refused';
      if (this.note.className !== className) this.note.className = className;
      write(this.note, refusal ?? `${DEAL_KEY} · deal`);
      return;
    }
    write(this.purse, `${dollars(state.money)} · carrying ${carrying(state.market)} of ${STASH_UNITS}`);
    const said = state.market.deal?.said ?? '';
    show(this.said, said !== '');
    write(this.said, said);
    const rows = tradeRows(state, dealers);
    for (let i = 0; i < rows.length; i++) this.row(state, dealer, rows[i] as TradeRow, i);
  }

  destroy(): void {
    this.root.remove();
  }

  /** Write one good's line, making its cells the first time it is drawn. */
  private row(state: SimState, dealer: DealerPlace, row: TradeRow, at: number): void {
    let cells = this.rows[at];
    if (cells === undefined) {
      const line = element('trade-row');
      cells = CELLS.map((cell) => {
        const span = element(`trade-${cell}`);
        line.append(span);
        return span;
      });
      this.rows[at] = cells;
      this.list.append(line);
    }
    const [name, buy, sell, held, history] = cells as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    write(name, `${at + 1} · ${row.name}`);
    // The price, and how many of them this key would buy: a buy takes as many
    // as the money and the carrying allow, so that count is what the key does.
    write(buy, `${dollars(row.buy)} ×${row.room}`);
    buy.className = `trade-buy${row.mood === '' ? '' : ` trade-${row.mood}`}`;
    write(sell, `sell ${dollars(row.sell)}`);
    write(held, row.held > 0 ? `hold ${row.held}` : '');
    write(history, bars(priceRun(state.seed, state.tick, dealer.district, row.good, HISTORY, HISTORY_STEP)));
  }
}

function element(className: string): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

/** Show or hide a node only where that is a change, for the reason `write` has. */
function show(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible;
}

/** Write a node only where its text has changed, because a write lays the overlay out again. */
function write(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * A run of prices as a line of bars, scaled between the lowest and the highest
 * of the run. A flat run draws flat: what the player needs from it is the shape
 * of the last few hours, not the dollars, which the row already gives them.
 */
export function bars(run: readonly number[]): string {
  let low = Infinity;
  let high = -Infinity;
  for (const price of run) {
    low = Math.min(low, price);
    high = Math.max(high, price);
  }
  const span = high - low;
  let out = '';
  for (const price of run) {
    const step = span <= 0 ? 0 : Math.round(((price - low) / span) * (BARS.length - 1));
    out += BARS[step];
  }
  return out;
}
