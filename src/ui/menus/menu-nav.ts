/**
 * The pure half of the title screen's menus: which item a key press moves to,
 * and how a binding from `controls.ts` is drawn as key caps. It needs no DOM,
 * so it is tested headless.
 */

/** The item `delta` steps from `current` in a list of `count`, wrapping at both ends. */
export function nextIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  // Nothing focused yet: down starts at the top, up starts at the bottom.
  if (current < 0 || current >= count) return delta < 0 ? count - 1 : 0;
  return (((current + delta) % count) + count) % count;
}

/** One piece of a binding: a key drawn as a cap, or a joining word drawn as text. */
export interface KeyPart {
  text: string;
  cap: boolean;
}

/** Words that join keys rather than name one. */
const JOINERS = new Set(['or', 'and', 'then', 'to']);

/**
 * Split a binding such as `W A S D or arrows` into its caps and joining words.
 * A mouse button is one cap: `Left click` is not two keys.
 */
export function keyParts(keys: string): KeyPart[] {
  const parts: KeyPart[] = [];
  for (const word of keys.split(/\s+/)) {
    if (word.length === 0) continue;
    const last = parts[parts.length - 1];
    if (word === 'click' && last?.cap) last.text += ' click';
    else parts.push({ text: word, cap: !JOINERS.has(word) });
  }
  return parts;
}
