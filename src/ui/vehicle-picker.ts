/**
 * The debug picker of spec section 11.3: every class of the roster, drivable.
 *
 * It is a development tool, not the game. Spec section 11.4 is how a player
 * gets into a vehicle; until that lands this is what makes the handling roster
 * something to drive rather than a table to read. `V` opens and closes it, and
 * picking a row puts that vehicle down under the player.
 *
 * The panel shows the numbers that make each row different — mass, power, top
 * speed and the tyres — so what is felt on the road can be read against what
 * the table says.
 */
import { ROSTER, VEHICLE_CLASSES, wheelbaseOf, type VehicleClass } from '../sim/vehicle.ts';

/** The key that opens and closes the picker. Listed in `controls.ts`. */
export const PICKER_KEY = 'KeyV';

export class VehiclePicker {
  private readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private current: VehicleClass;

  constructor(parent: HTMLElement, current: VehicleClass, onPick: (cls: VehicleClass) => void) {
    this.current = current;
    this.root = document.createElement('div');
    this.root.className = 'picker';
    this.root.hidden = true;
    const heading = document.createElement('h2');
    heading.textContent = 'Vehicle';
    this.root.append(heading);
    for (const cls of VEHICLE_CLASSES) {
      const spec = ROSTER[cls];
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.cls = cls;
      const name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = spec.name;
      const stats = document.createElement('span');
      stats.className = 'picker-stats';
      stats.textContent = describe(cls);
      button.append(name, stats);
      button.addEventListener('click', () => {
        // The canvas takes the keys, so the button must not keep the focus.
        button.blur();
        this.select(cls);
        onPick(cls);
      });
      this.buttons.push(button);
      this.root.append(button);
    }
    this.select(current);
    parent.append(this.root);
  }

  /** True while the panel is on screen. */
  get open(): boolean {
    return !this.root.hidden;
  }

  /** Show the panel, or take it away again. */
  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  /** Mark a row as the one being driven. */
  select(cls: VehicleClass): void {
    this.current = cls;
    for (const button of this.buttons) {
      button.classList.toggle('picker-current', button.dataset.cls === cls);
    }
  }

  /** The row currently marked. */
  get picked(): VehicleClass {
    return this.current;
  }

  destroy(): void {
    this.root.remove();
  }
}

/** One line of numbers for a row: what separates it from the row above. */
export function describe(cls: VehicleClass): string {
  const spec = ROSTER[cls];
  const top = Math.round((spec.hull?.topSpeed ?? spec.topSpeed) * 3.6);
  const power = Math.round((spec.hull?.thrust ?? spec.enginePower) / 1000);
  const parts = [`${spec.mass} kg`, `${power} kN`, `${top} km/h`];
  if (spec.hull === undefined) parts.push(`${wheelbaseOf(spec).toFixed(2)} m base`);
  else parts.push('hull');
  if (spec.tyres.loose > 1) parts.push('knobbly');
  if (spec.luxury) parts.push('luxury');
  else if (spec.alarm) parts.push('alarm');
  return parts.join(' · ');
}
