/**
 * The debug picker of spec section 11.6: every weapon of the arsenal, loaded
 * and ready to fire.
 *
 * It is a development tool, not the game: the weapon shops, the faction dealers
 * and the looting of spec section 11.6 are what will hand weapons out, and
 * until they land this is what makes the table something to fire rather than
 * something to read. `G` opens and closes it, and picking a row puts that
 * weapon in the player's hands with a full magazine and spare ammunition behind
 * it. A row picked with Shift held drops the weapon on the ground in front of
 * the player instead, as a body that fell would, so a pickup can be walked
 * over. The attachments under the rows fit to and come off the weapon in hand;
 * one the weapon does not take is greyed out.
 *
 * The rows are grouped by class, in the spec's own order, and each one shows
 * what makes it different: its calibre, its magazine, its rate of fire and what
 * one hit is worth.
 */
import {
  ARSENAL,
  ATTACHMENTS,
  currentSlot,
  fits,
  WEAPON_CLASSES,
  WEAPON_IDS,
  weaponOf,
  type Attachment,
  type LoadoutState,
  type WeaponClass,
  type WeaponId,
  type WeaponSpec,
} from '../sim/weapon.ts';

/** The key that opens and closes the picker. Listed in `controls.ts`. */
export const WEAPON_PICKER_KEY = 'KeyG';

/** What the panel calls each class. */
const CLASS_NAMES: Readonly<Record<WeaponClass, string>> = Object.freeze({
  melee: 'Melee',
  pistol: 'Pistols',
  smg: 'SMGs',
  shotgun: 'Shotguns',
  rifle: 'Rifles',
  precision: 'Precision',
  heavy: 'Heavy',
  thrown: 'Thrown',
});

/** What the panel calls each attachment. */
const ATTACHMENT_NAMES: Readonly<Record<Attachment, string>> = Object.freeze({
  suppressor: 'Suppressor',
  'extended-mag': 'Extended magazine',
  optic: 'Optic',
  laser: 'Laser',
  foregrip: 'Foregrip',
});

/** What a row and an attachment button do. `pickers.ts` hands these to the record. */
export interface WeaponPickerActions {
  /** Put the weapon in the player's hands, loaded. */
  pick(id: WeaponId): void;
  /** Drop the weapon on the ground in front of the player, as a pickup. */
  drop(id: WeaponId): void;
  /** Fit the attachment to the weapon in hand, or take it off. */
  fit(attachment: Attachment): void;
}

export class WeaponPicker {
  private readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly fittings: HTMLButtonElement[] = [];
  /** The weapon and attachments the panel last showed, so it is written only when they change. */
  private shown = '';

  constructor(parent: HTMLElement, current: WeaponId, actions: WeaponPickerActions) {
    this.root = document.createElement('div');
    // The vehicle picker stands on the right, so this one stands on the left and
    // the two can be open together.
    this.root.className = 'picker picker-left';
    this.root.hidden = true;
    const heading = document.createElement('h2');
    heading.textContent = 'Weapon';
    this.root.append(heading);
    for (const cls of WEAPON_CLASSES) {
      const group = document.createElement('div');
      group.className = 'picker-group';
      group.textContent = CLASS_NAMES[cls];
      this.root.append(group);
      for (const id of WEAPON_IDS) {
        const spec = ARSENAL[id];
        if (spec.cls !== cls) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.weapon = id;
        const name = document.createElement('span');
        name.className = 'picker-name';
        name.textContent = spec.name;
        const stats = document.createElement('span');
        stats.className = 'picker-stats';
        stats.textContent = describeWeapon(id);
        button.append(name, stats);
        button.addEventListener('click', (event) => {
          // The canvas takes the keys, so the button must not keep the focus.
          button.blur();
          if (event.shiftKey) {
            actions.drop(id);
            return;
          }
          this.select(id);
          actions.pick(id);
        });
        this.buttons.push(button);
        this.root.append(button);
      }
    }
    const group = document.createElement('div');
    group.className = 'picker-group';
    group.textContent = 'Attachments';
    this.root.append(group);
    for (const attachment of ATTACHMENTS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.attachment = attachment;
      button.textContent = ATTACHMENT_NAMES[attachment];
      button.addEventListener('click', () => {
        button.blur();
        actions.fit(attachment);
      });
      this.fittings.push(button);
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

  /**
   * Show what the record has in the player's hands: its row, and which
   * attachments it takes and has fitted. Called once a frame; the panel is
   * written only when the weapon or its attachments change.
   */
  sync(loadout: LoadoutState): void {
    const slot = currentSlot(loadout);
    const fitted = slot.attachments ?? [];
    const key = `${slot.id}|${fitted.join(',')}`;
    if (key === this.shown) return;
    this.shown = key;
    this.select(slot.id);
    const spec = weaponOf(slot.id);
    for (const button of this.fittings) {
      const attachment = button.dataset.attachment as Attachment;
      button.disabled = !fits(spec, attachment);
      button.classList.toggle('picker-current', fitted.includes(attachment));
    }
  }

  /** Mark a row as the one in the player's hands. */
  select(id: WeaponId): void {
    for (const button of this.buttons) {
      button.classList.toggle('picker-current', button.dataset.weapon === id);
    }
  }

  destroy(): void {
    this.root.remove();
  }
}

/** One line of numbers for a row: what separates it from the row above. */
export function describeWeapon(id: WeaponId): string {
  const spec: WeaponSpec = ARSENAL[id];
  const parts: string[] = [];
  if (spec.cls === 'melee') {
    parts.push(`${spec.damage} dmg`, `${spec.reach.toFixed(1)} m reach`, `${spec.rpm} /min`);
    if (spec.effect !== 'none') parts.push(spec.effect);
    return parts.join(' · ');
  }
  if (spec.calibre !== undefined) parts.push(spec.calibre);
  parts.push(`${spec.capacity} rds`, `${spec.rpm} rpm`);
  parts.push(spec.pellets > 1 ? `${spec.pellets} × ${spec.damage} dmg` : `${spec.damage} dmg`);
  if (spec.projectile === undefined) parts.push(`${spec.range} m`);
  else parts.push(`${spec.projectile.blastRadius} m burst`);
  if (spec.automatic) parts.push('auto');
  if (spec.effect !== 'none' && spec.effect !== 'blast') parts.push(spec.effect);
  return parts.join(' · ');
}
