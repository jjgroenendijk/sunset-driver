/**
 * The metro station panel and the fade of a trip (spec section 13.3).
 *
 * The rules are in `src/sim/transit/metro.ts` and this draws them. A player standing at
 * a station entrance is shown which station they are at and where they may go:
 * one line per station they have visited, numbered as the keys that take them
 * there. A trip that is refused says why instead, so a player who cannot travel
 * knows whether to park the car or to lose the police first.
 *
 * The fade is a black sheet over everything, at the strength the record says
 * the trip has reached. It is drawn here rather than in the renderer because
 * nothing about it belongs to the scene: the city carries on being drawn behind
 * it, tick for tick, which is what the spec asks the fast travel to be.
 *
 * Only what changed is written, as the HUD does: a panel standing still writes
 * nothing.
 */
import { destinations, travelFade, travelRefusal, type MetroPlace } from '../../sim/transit/metro.ts';
import type { SimState } from '../../sim/simulation.ts';
import { CHOICE_KEYS } from '../input/keyboard.ts';

export class TravelPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private readonly sheet: HTMLElement;
  private shown = '';
  private shownFade = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'travel';
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'travel-title';
    this.list = document.createElement('div');
    this.list.className = 'travel-list';
    this.root.append(this.title, this.list);

    this.sheet = document.createElement('div');
    this.sheet.className = 'travel-fade';
    this.sheet.hidden = true;
    parent.append(this.root, this.sheet);
  }

  /**
   * Draw the panel for the station the player is standing at, and the fade of
   * the trip they are on. `at` is the station under them, or -1 for none, which
   * is what `stationAt` answers.
   */
  update(state: SimState, places: readonly MetroPlace[], at: number, tick: number): void {
    const fade = travelFade(state, tick);
    if (fade !== this.shownFade) {
      this.shownFade = fade;
      this.sheet.hidden = fade <= 0;
      this.sheet.style.opacity = String(fade);
    }

    const here = places[at];
    if (here === undefined || state.metro.travel !== null) {
      this.root.hidden = true;
      this.shown = '';
      return;
    }
    const refusal = travelRefusal(state);
    const rows = refusal !== null ? [refusal] : lines(state, places, at);
    const text = `${here.name}\n${rows.join('\n')}`;
    if (text === this.shown) return;
    this.shown = text;
    this.root.hidden = false;
    this.title.textContent = `Metro · ${here.name}`;
    // A row a trip may take is numbered as its key, which a tap presses.
    const numbered = refusal === null && destinations(state, at).length > 0;
    this.list.replaceChildren(
      ...rows.map((row, i) => {
        const line = document.createElement('div');
        line.className = refusal !== null ? 'travel-refused' : 'travel-row';
        line.textContent = row;
        if (numbered) line.dataset.key = `Digit${i + 1}`;
        return line;
      }),
    );
  }

  destroy(): void {
    this.root.remove();
    this.sheet.remove();
  }
}

/**
 * One line per station a trip may go to, numbered as the key that takes it. A
 * player who has been nowhere else is told to go and find another station,
 * because an empty panel says nothing at all.
 */
function lines(state: SimState, places: readonly MetroPlace[], at: number): string[] {
  const to = destinations(state, at).slice(0, CHOICE_KEYS);
  if (to.length === 0) return ['No other station visited yet.'];
  return to.map((id, i) => `${i + 1} · ${places[id]?.name ?? 'Metro'}`);
}
