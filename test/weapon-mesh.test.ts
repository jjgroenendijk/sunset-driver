import { describe, expect, it } from 'vitest';
import { weaponBoxes, type WeaponBox } from '../src/render/weapon-mesh.ts';
import { fitsOf, WEAPON_IDS, weaponOf } from '../src/sim/weapon.ts';

/**
 * The weapon models of spec section 11.6, measured headless: every weapon a
 * silhouette of its own from above, and every attachment something the camera
 * above can see.
 */

/** Metres a cell of the top-down picture covers. */
const CELL = 0.005;

/**
 * Cells two silhouettes must differ in, so no two weapons read as one: ten
 * square centimetres. The closest pair, a Glock and a 1911, differ in about 50.
 */
const MIN_SILHOUETTE = 40;

/** Cells an attachment must change from above: a quarter of a square centimetre and more. */
const MIN_ATTACHMENT = 10;

/**
 * The weapon seen from straight above: for each cell of a grid over its own
 * `x` and `z`, the height of the highest box over it, or nothing. A cell is
 * covered when its middle falls inside a box.
 */
function topDown(boxes: readonly WeaponBox[]): Map<string, number> {
  const picture = new Map<string, number>();
  for (const b of boxes) {
    const x0 = Math.ceil((b.x - b.length / 2) / CELL - 0.5);
    const x1 = Math.floor((b.x + b.length / 2) / CELL - 0.5);
    const z0 = Math.ceil((b.z - b.width / 2) / CELL - 0.5);
    const z1 = Math.floor((b.z + b.width / 2) / CELL - 0.5);
    const top = Math.round((b.y + b.height / 2) / CELL);
    for (let i = x0; i <= x1; i++) {
      for (let k = z0; k <= z1; k++) {
        const key = `${i},${k}`;
        picture.set(key, Math.max(picture.get(key) ?? -Infinity, top));
      }
    }
  }
  return picture;
}

/** Cells covered in one picture and not the other. */
function outlineDifference(a: Map<string, number>, b: Map<string, number>): number {
  let count = 0;
  for (const key of a.keys()) if (!b.has(key)) count++;
  for (const key of b.keys()) if (!a.has(key)) count++;
  return count;
}

/** Cells whose covering or height differs between two pictures. */
function viewDifference(a: Map<string, number>, b: Map<string, number>): number {
  let count = outlineDifference(a, b);
  for (const [key, top] of a) if (b.has(key) && b.get(key) !== top) count++;
  return count;
}

/** The first thing wrong with the boxes of a drawn weapon, or '' when nothing is. */
function modelComplaint(id: string, boxes: ReturnType<typeof weaponBoxes>): string {
  let complaint = '';
  if (boxes.length === 0) complaint ||= `${id} has no model`;
  for (const b of boxes) {
    const sizes = [b.length, b.height, b.width, b.x, b.y, b.z];
    if (!sizes.every(Number.isFinite)) complaint ||= `${id} has a box that is not a number`;
    if (b.length <= 0 || b.height <= 0 || b.width <= 0) complaint ||= `${id} has a flat box`;
    if (b.part !== undefined) complaint ||= `${id} is drawn with ${b.part} it was not given`;
  }
  // Nothing held in one hand is longer than a man is tall, or wider than a shoulder.
  const reach = Math.max(...boxes.map((b) => Math.abs(b.x) + b.length / 2));
  const side = Math.max(...boxes.map((b) => Math.abs(b.z) + b.width / 2));
  if (reach > 1.6 || side > 0.25) complaint ||= `${id} reaches ${reach.toFixed(2)} by ${side.toFixed(2)} m`;
  return complaint;
}

describe('the weapon models', () => {
  it('builds every weapon but bare fists from boxes of real size', () => {
    let complaint = '';
    for (const id of WEAPON_IDS) {
      const boxes = weaponBoxes(id);
      if (id === 'fists') {
        if (boxes.length > 0) complaint ||= 'fists are drawn';
        continue;
      }
      complaint ||= modelComplaint(id, boxes);
    }
    expect(complaint, complaint).toBe('');
  });

  it('gives no two weapons the same silhouette from above', () => {
    const drawn = WEAPON_IDS.filter((id) => id !== 'fists');
    const pictures = drawn.map((id) => topDown(weaponBoxes(id)));
    let complaint = '';
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const difference = outlineDifference(pictures[i] as Map<string, number>, pictures[j] as Map<string, number>);
        if (difference < MIN_SILHOUETTE) complaint ||= `${drawn[i]} and ${drawn[j]} differ in ${difference} cells`;
      }
    }
    expect(complaint, complaint).toBe('');
  });

  it('shows every attachment a weapon takes, from above', () => {
    let complaint = '';
    let checked = 0;
    for (const id of WEAPON_IDS) {
      const bare = topDown(weaponBoxes(id));
      for (const attachment of fitsOf(weaponOf(id))) {
        const boxes = weaponBoxes(id, [attachment]);
        if (!boxes.some((b) => b.part === attachment)) complaint ||= `${id} draws no ${attachment}`;
        const difference = viewDifference(bare, topDown(boxes));
        if (difference < MIN_ATTACHMENT) complaint ||= `${attachment} on ${id} changes ${difference} cells`;
        checked++;
      }
    }
    expect(complaint, complaint).toBe('');
    expect(checked).toBeGreaterThan(50);
  });
});
