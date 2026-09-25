import { describe, expect, it } from 'vitest';
import { airfieldBoxes, airfieldMesh } from '../src/render/airfield-mesh.ts';
import type { Airfield } from '../src/world/types.ts';

/** The airfields, drawn (spec section 8.4): an airport and an airstrip on a slope. */

const AIRPORT: Airfield = {
  id: 0,
  kind: 'airport',
  x: 100,
  y: -50,
  heading: 0.3,
  halfU: 500,
  halfV: 150,
  level: 12,
  gate: { x: 100 - 218 * Math.sin(0.3), y: -50 + 218 * Math.cos(0.3) },
  road: 0,
  parts: [
    { kind: 'runway', u: 0, v: -100, halfU: 450, halfV: 20, height: 0 },
    { kind: 'taxiway', u: 0, v: -35, halfU: 410, halfV: 10, height: 0 },
    { kind: 'pad', u: 200, v: 25, halfU: 15, halfV: 15, height: 0 },
    { kind: 'terminal', u: 0, v: 97, halfU: 110, halfV: 15, height: 14 },
    { kind: 'compound', u: -390, v: 26, halfU: 90, halfV: 52, height: 0 },
  ],
  stands: [],
};

const STRIP: Airfield = { ...AIRPORT, kind: 'airstrip', parts: [AIRPORT.parts[0] as Airfield['parts'][number]] };

describe('the airfield mesh (spec section 8.4)', () => {
  it('paints a paved runway and leaves an airstrip bare', () => {
    const paved = airfieldBoxes(AIRPORT);
    const bare = airfieldBoxes(STRIP);
    expect(bare).toHaveLength(1);
    // The runway, its thresholds and its centreline, the taxiway and its line, the pad and its H, the terminal.
    expect(paved.length).toBeGreaterThan(20);
    // The compound is ground the police guard, not a thing drawn.
    expect(paved.every((b) => Math.abs(b.u + 390) > 1 || Math.abs(b.v - 26) > 1)).toBe(true);
    expect(Math.max(...paved.map((b) => b.y1))).toBe(14);
  });

  it('stands every airfield on its level, and lays the ramp up the hill to the gate', () => {
    const hill = (_x: number, y: number): number => 12 + Math.max(0, (y - 90) * 0.1);
    const mesh = airfieldMesh([AIRPORT], hill);
    const position = mesh.geometry.getAttribute('position');
    const normal = mesh.geometry.getAttribute('normal');
    let top = -Infinity;
    for (let i = 0; i < position.count; i++) {
      expect(Number.isFinite(position.getY(i))).toBe(true);
      top = Math.max(top, position.getY(i));
    }
    expect(top).toBeCloseTo(26, 3);
    // The last vertices are the ramp's, and every one of its faces looks up.
    const ramp = 6 * Math.ceil(68 / 4);
    for (let i = position.count - ramp; i < position.count; i++) expect(normal.getY(i)).toBeGreaterThan(0.9);
  });
});
