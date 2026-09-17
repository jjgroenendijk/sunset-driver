/**
 * A saved session (spec section 16.4): the record of `simulation.ts` and the
 * seed text it was started from, as JSON for the browser's own storage and as
 * one line of text for the clipboard.
 *
 * The record is plain data by design, so a save is the record itself. What the
 * spec lists — the seed, the character, the time of day, the money, the health,
 * the position, the weapons, their attachments and the ammunition — are fields
 * of it already. The systems still to come add their fields to the record, and
 * a save carries them without a change here.
 *
 * A save is read against a fresh record: every field a new session has must be
 * there with the same type, and a field the record does not know is dropped.
 * A save from a different version is refused rather than guessed at. Pure: no
 * DOM, no storage, so the round trip is tested headless.
 */
import { seedFromString } from '../core/rng.ts';
import { sortedKeys } from '../core/sort.ts';
import { cloneSimState, createSimState, type SimState } from './simulation.ts';
import { VEHICLE_CLASSES } from './vehicle.ts';
import { WEAPON_IDS } from './weapon.ts';

/** The name every save carries, so a stray piece of text is not read as one. */
export const SAVE_FORMAT = 'sunset-driver-save';

/**
 * The version of the record a save holds. Raise it when a field of
 * {@link SimState} changes meaning, and when one is added that an older save
 * cannot have: the record is read against a fresh one, so a save without the
 * new field is refused either way, and the version is what says so in words a
 * player understands. A save of another version is refused.
 *
 * Version 2 added the metro of spec section 13.3, version 3 the police of spec
 * section 14, version 4 the radio dial of spec section 15, and version 5 the
 * shops of spec section 16.1 with the paint a respray leaves on a vehicle.
 */
export const SAVE_VERSION = 5;

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  /** The seed as the player typed it. `state.seed` is the number it hashes to. */
  seed: string;
  state: SimState;
}

/** Why a save could not be read, in words the pause menu shows. */
export class SaveError extends Error {}

/** A save of the record as it stands. It is a copy: the session goes on without changing it. */
export function createSave(seed: string, state: SimState): SaveFile {
  return { format: SAVE_FORMAT, version: SAVE_VERSION, seed, state: cloneSimState(state) };
}

/** The save as one line of text for the clipboard: the format, the version and the JSON in base64. */
export function saveToText(save: SaveFile): string {
  return `${SAVE_FORMAT}.${save.version}.${toBase64(JSON.stringify(save))}`;
}

/** Read a save from the clipboard text {@link saveToText} wrote. Throws a {@link SaveError}. */
export function saveFromText(text: string): SaveFile {
  // A save pasted through a chat or a mail picks up line breaks and spaces.
  const compact = text.replace(/\s+/g, '');
  const prefix = `${SAVE_FORMAT}.`;
  if (!compact.startsWith(prefix)) throw new SaveError('This is not a Sunset Driver save.');
  const dot = compact.indexOf('.', prefix.length);
  if (dot < 0) throw new SaveError('The save is cut short.');
  let json: string;
  try {
    json = fromBase64(compact.slice(dot + 1));
  } catch {
    throw new SaveError('The save is damaged.');
  }
  return saveFromJson(json);
}

/** Read a save from the JSON the browser's storage holds. Throws a {@link SaveError}. */
export function saveFromJson(json: string): SaveFile {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SaveError('The save is damaged.');
  }
  return checkSave(value);
}

/**
 * Put a save into a live record, in place, so everything holding the record
 * holds the loaded one. The physics has to be told afterwards: `SimPhysics.load`.
 */
export function restoreSimState(target: SimState, save: SaveFile): void {
  Object.assign(target, cloneSimState(save.state));
}

/** Check a parsed value is a save this version can play, and answer with a clean copy of it. */
function checkSave(value: unknown): SaveFile {
  if (!isObject(value) || value.format !== SAVE_FORMAT) throw new SaveError('This is not a Sunset Driver save.');
  if (value.version !== SAVE_VERSION) {
    throw new SaveError(`The save is from version ${String(value.version)}; this game reads version ${SAVE_VERSION}.`);
  }
  if (typeof value.seed !== 'string' || value.seed.length === 0) throw new SaveError('The save has no seed.');
  const seed = value.seed;
  const template = cloneSimState(createSimState(seedFromString(seed)));
  const state = conform(template, value.state, 'state') as SimState;
  if (state.seed !== template.seed) throw new SaveError('The save does not belong to its own seed.');
  if (!Number.isInteger(state.tick) || state.tick < 0) throw new SaveError('The save has no valid time.');
  if (!VEHICLE_CLASSES.includes(state.vehicle.cls)) throw new SaveError('The save names a vehicle this game does not have.');
  for (const slot of state.loadout.slots) {
    if (!WEAPON_IDS.includes(slot.id)) throw new SaveError('The save names a weapon this game does not have.');
  }
  return { format: SAVE_FORMAT, version: SAVE_VERSION, seed, state };
}

/**
 * A copy of `value` with the shape of `template`: the same fields, each of the
 * same type. A field the template holds as null may be null or anything else,
 * because null is how the record says a thing is absent. An array is checked
 * element by element against the template's first element, where it has one.
 */
function conform(template: unknown, value: unknown, path: string): unknown {
  if (template === null) return value === undefined ? null : value;
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw damaged(path);
    const element: unknown = template[0];
    return value.map((item, i) => (element === undefined ? item : conform(element, item, `${path}[${i}]`)));
  }
  if (isObject(template)) {
    if (!isObject(value)) throw damaged(path);
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys(template)) out[key] = conform(template[key], value[key], `${path}.${key}`);
    return out;
  }
  if (typeof template === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw damaged(path);
    return value;
  }
  if (typeof value !== typeof template) throw damaged(path);
  return value;
}

function damaged(path: string): SaveError {
  return new SaveError(`The save is damaged at ${path}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Base64 of the UTF-8 of a string. `btoa` alone takes only Latin-1, and a seed may be any text. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // In pieces, because spreading a whole save into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
