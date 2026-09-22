import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { README, readmeWithControls } from '../scripts/readme-controls.ts';
import { CONTROLS } from '../src/ui/controls.ts';

/**
 * The README's control table is generated from `CONTROLS`. Written by hand it
 * drifted: it named a binding the code had changed and missed three the code
 * had grown. This fails the moment the file on disk stops matching the table,
 * and `node scripts/readme-controls.ts` writes it again.
 */
describe('the README control table', () => {
  const text = fs.readFileSync(README, 'utf8');

  it('is what the generator would write', () => {
    expect(readmeWithControls(text)).toBe(text);
  });

  it('holds every binding', () => {
    for (const binding of CONTROLS) expect(text).toContain(`| ${binding.action} | ${binding.keys} |`);
  });
});
