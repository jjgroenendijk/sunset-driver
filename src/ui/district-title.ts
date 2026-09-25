/**
 * The name of a district, shown large in the middle of the screen as the
 * player crosses into it, over a one-line subtitle, and faded out again
 * (`docs/art-style.md`). Streets get no title.
 *
 * {@link DistrictWatch} decides when a title is due and reads nothing but the
 * tick and the district underfoot, so the tests run it without a page. The
 * fade itself is a CSS animation (`hud.css`).
 */
import type { SimState } from '../sim/simulation.ts';
import { districtAt, layoutZones } from '../world/districts.ts';
import type { District, WorldDescription, Zone } from '../world/types.ts';

/**
 * Ticks the player has to stay in a district before its name is shown: under a
 * second. A car running along a border crosses it back and forth, and a title
 * for every crossing would flicker.
 */
export const TITLE_SETTLE = 45;

/**
 * Ticks after one title before the next may show: ten seconds. The name of a
 * district is a welcome, not a readout, so a drive across three small ones
 * shows the first and the last rather than all three in a row.
 */
export const TITLE_GAP = 600;

/** The line under a district's name: what kind of place it is. */
const ZONE_LINES: Record<Zone, string> = {
  core: 'Downtown',
  inner: 'Inner city',
  industrial: 'Industrial district',
  suburban: 'Suburbs',
  outskirts: 'Outskirts',
  wilderness: 'The wild',
};

/** The subtitle a district is shown with. */
function districtLine(district: District): string {
  return ZONE_LINES[district.zone];
}

/**
 * When a district's name is due. {@link step} is given the tick and the
 * district underfoot, and answers the id of the district to title, or -1.
 */
export class DistrictWatch {
  private under = -1;
  private since = 0;
  private shown = -1;
  private shownAt = -Infinity;

  step(tick: number, district: number): number {
    if (district !== this.under) {
      this.under = district;
      this.since = tick;
    }
    if (district === this.shown || tick - this.since < TITLE_SETTLE || tick - this.shownAt < TITLE_GAP) return -1;
    this.shown = district;
    this.shownAt = tick;
    return district;
  }
}

export class DistrictTitle {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly line: HTMLElement;
  private readonly watch = new DistrictWatch();
  private readonly districtAt: (x: number, y: number) => District;

  constructor(parent: HTMLElement, world: WorldDescription) {
    const zones = layoutZones(world.size, world.core, world.water);
    this.districtAt = (x, y) => districtAt(world.districts, zones, x, y);
    this.root = document.createElement('div');
    this.root.className = 'district-title';
    this.name = document.createElement('div');
    this.name.className = 'district-title-name';
    this.line = document.createElement('div');
    this.line.className = 'district-title-sub';
    this.root.append(this.name, this.line);
    parent.append(this.root);
  }

  /** Show the name of the district the player stands in, if one is due. */
  update(state: SimState): void {
    const district = this.districtAt(state.player.x, state.player.y);
    if (this.watch.step(state.tick, district.id) < 0) return;
    this.name.textContent = district.name;
    this.line.textContent = districtLine(district);
    // Taking the class off and reading the layout restarts the fade.
    this.root.classList.remove('district-title-on');
    void this.root.offsetWidth;
    this.root.classList.add('district-title-on');
  }
}
