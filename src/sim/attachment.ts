/**
 * The attachments of spec section 11.6: what each one does to a weapon, and
 * which weapons take which.
 *
 * An attachment changes the numbers of the weapon it is fitted to and nothing
 * else, so a fitted weapon is a {@link WeaponSpec} like any row of the arsenal:
 * the firing model, the reload and the HUD read it without knowing that
 * anything was fitted. What an attachment looks like on the model is
 * `src/render/weapon-mesh.ts`.
 *
 * The shops and faction dealers that sell attachments are spec section 16. The
 * record carries what is fitted as names, in the order of {@link ATTACHMENTS},
 * so a save reads the same whichever order they were fitted in.
 */
import type { WeaponClass, WeaponId, WeaponSpec } from './weapon.ts';

/** The attachments the spec lists. The name is what a save carries. */
export type Attachment = 'suppressor' | 'extended-mag' | 'optic' | 'laser' | 'foregrip';

/** Every attachment, in the order a slot keeps them. Nothing else should list them. */
export const ATTACHMENTS: readonly Attachment[] = ['suppressor', 'extended-mag', 'optic', 'laser', 'foregrip'];

/** How many more rounds an extended magazine holds, as a share of the standard one. */
export const EXTENDED_MAG = 1.5;

/** How much further an aimed shot carries through an optic. */
export const OPTIC_RANGE = 1.5;

/** How much of the hip-fire cone is left with a laser. Aimed fire is not changed. */
export const LASER_HIP = 0.65;

/** How much of the recoil is left with a foregrip. */
export const FOREGRIP_RECOIL = 0.65;

/** What each class takes. A weapon in {@link FITS_WEAPON} takes its own list instead. */
const FITS_CLASS: Readonly<Record<WeaponClass, readonly Attachment[]>> = {
  melee: [],
  pistol: ['suppressor', 'extended-mag', 'laser'],
  smg: ['suppressor', 'extended-mag', 'optic', 'laser', 'foregrip'],
  shotgun: ['extended-mag', 'optic', 'laser', 'foregrip'],
  rifle: ['suppressor', 'extended-mag', 'optic', 'laser', 'foregrip'],
  // A precision rifle is scoped already (spec section 11.6), so it takes no optic.
  precision: ['suppressor', 'extended-mag'],
  heavy: [],
  thrown: [],
};

/**
 * The weapons that differ from their class. A revolver has no magazine to
 * extend and a gap at the cylinder that no suppressor closes. A sawn-off has no
 * tube under its barrels and nothing to hold a grip or a sight. A suppressor on
 * a .50 BMG rifle is not a thing anyone carries. The M249 is the one heavy
 * weapon with a rail and a fore-end.
 */
const FITS_WEAPON: Readonly<Partial<Record<WeaponId, readonly Attachment[]>>> = {
  'model-29': ['laser'],
  'desert-eagle': ['extended-mag', 'laser'],
  'sawn-off': ['laser'],
  'barrett-m82': ['extended-mag'],
  m249: ['optic', 'foregrip'],
};

/** The attachments a weapon takes, in the order of {@link ATTACHMENTS}. */
export function fitsOf(spec: WeaponSpec): readonly Attachment[] {
  return FITS_WEAPON[spec.id] ?? FITS_CLASS[spec.cls];
}

/** True where the attachment can be fitted to the weapon. */
export function fits(spec: WeaponSpec, attachment: Attachment): boolean {
  return fitsOf(spec).includes(attachment);
}

/**
 * The attachments of a list that a weapon takes, once each, in the order of
 * {@link ATTACHMENTS}. This is how a slot keeps them, and how a list from a
 * save or a pickup is made one a slot can hold.
 */
export function normaliseAttachments(spec: WeaponSpec, list: readonly string[] | undefined): Attachment[] {
  if (list === undefined) return [];
  return fitsOf(spec).filter((attachment) => list.includes(attachment));
}

/**
 * Fitted rows, keyed on the weapon and what is fitted to it. The firing model
 * reads the weapon in hand several times a tick, so a fitted row is built once
 * and shared: a row is never written to after it is built.
 */
const FITTED = new Map<string, WeaponSpec>();

/**
 * The weapon as it fires with these attachments fitted (spec section 11.6).
 * An attachment the weapon does not take changes nothing. A bare weapon is its
 * own row of the arsenal.
 */
export function fitted(spec: WeaponSpec, attachments: readonly Attachment[]): WeaponSpec {
  const list = normaliseAttachments(spec, attachments);
  if (list.length === 0) return spec;
  const key = `${spec.id}|${list.join(',')}`;
  const known = FITTED.get(key);
  if (known !== undefined) return known;
  const row: WeaponSpec = { ...spec };
  for (const attachment of list) {
    switch (attachment) {
      case 'suppressor':
        row.suppressed = true;
        break;
      case 'extended-mag':
        row.capacity = Math.round(spec.capacity * EXTENDED_MAG);
        break;
      case 'optic':
        row.sight = OPTIC_RANGE;
        break;
      case 'laser':
        row.hipSpread = LASER_HIP;
        break;
      case 'foregrip':
        row.recoil = spec.recoil * FOREGRIP_RECOIL;
        break;
    }
  }
  FITTED.set(key, Object.freeze(row));
  return row;
}
