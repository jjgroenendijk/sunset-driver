import { describe, expect, it } from 'vitest';
import { CREW, emptyFirefighter, fireCrew, OUTLET_UP, type Firefighter } from '../src/render/fire-crew.ts';
import { unitShape } from '../src/render/emergency-mesh.ts';
import { DEPLOY_TICKS, HOSE_RANGE, hosing, STOW_TICKS, UNIT_BODY, WORK_TICKS, type EmergencyUnit } from '../src/sim/emergency.ts';

/** An engine at 0, 0 facing +x, that pulled up at a scene on tick `start`. */
function engineAt(start: number, goalX: number, goalY: number): EmergencyUnit {
  return {
    id: 3,
    kind: 'engine',
    task: 'work',
    call: 0,
    x: 0,
    y: 0,
    heading: 0,
    height: 5,
    speed: 0,
    edges: [],
    distance: 0,
    stop: 0,
    planned: 0,
    goalX,
    goalY,
    homeX: 0,
    homeY: 0,
    until: start + WORK_TICKS.engine,
  };
}

function crewAt(unit: EmergencyUnit, tick: number): Firefighter[] {
  const out = [emptyFirefighter(), emptyFirefighter()];
  expect(fireCrew(unit, tick, out)).toBe(CREW);
  return out;
}

describe('the crew of a fire engine (spec section 20.3)', () => {
  it('puts nobody on the street from an engine on the road or an ambulance', () => {
    const driving = engineAt(0, 10, 6);
    driving.task = 'respond';
    driving.until = -1;
    expect(fireCrew(driving, 100, [])).toBe(0);
    const ambulance = { ...engineAt(0, 10, 6), kind: 'ambulance' as const };
    expect(fireCrew(ambulance, 100, [])).toBe(0);
  });

  it('climbs down by the cab and runs the hose out to the scene before the water comes', () => {
    const unit = engineAt(1000, 6, 12);
    const first = crewAt(unit, 1000);
    for (const f of first) {
      // On the flank facing the scene, beside the cab, with no water on.
      expect(f.pose.y).toBeGreaterThan(UNIT_BODY.engine.halfWidth);
      expect(f.pose.x).toBeGreaterThan(0);
      expect(f.spraying).toBe(false);
    }
    const settled = crewAt(unit, 1000 + DEPLOY_TICKS - 1);
    for (const f of settled) {
      expect(f.pose.gait).toBe('aim');
      expect(f.spraying).toBe(false);
    }
    const working = crewAt(unit, 1000 + DEPLOY_TICKS);
    for (const f of working) {
      expect(f.spraying).toBe(true);
      // The nozzle is in reach of the engine, nearer the scene than the engine is, and faces it.
      expect(Math.hypot(f.nozzleX, f.nozzleY)).toBeLessThan(HOSE_RANGE);
      expect(Math.hypot(f.nozzleX - 6, f.nozzleY - 12)).toBeLessThan(Math.hypot(6, 12));
      const facing = Math.atan2(12 - f.pose.y, 6 - f.pose.x);
      expect(Math.abs(Math.atan2(Math.sin(f.pose.heading - facing), Math.cos(f.pose.heading - facing)))).toBeLessThan(0.01);
    }
    // Two people, not one in the other.
    expect(Math.hypot(working[0]!.pose.x - working[1]!.pose.x, working[0]!.pose.y - working[1]!.pose.y)).toBeGreaterThan(1);
  });

  it('runs each hose from the coupling on the engine to the nozzle, over the road', () => {
    const unit = engineAt(0, 6, -12);
    const coupling = unitShape('engine').couplings.find((c) => c.z < 0);
    expect(coupling).toBeDefined();
    for (const f of crewAt(unit, DEPLOY_TICKS + 30)) {
      const hose = f.hose;
      // The engine faces +x, so its own z is the map's y.
      expect(hose[0]).toBeCloseTo(coupling!.x, 5);
      expect(hose[1]).toBeCloseTo(unit.height + OUTLET_UP, 5);
      expect(hose[2]).toBeCloseTo(coupling!.z, 5);
      const end = hose.length - 3;
      expect([hose[end], hose[end + 1], hose[end + 2]]).toEqual([f.nozzleX, f.nozzleHeight, f.nozzleY]);
      // Between the two ends it lies on the road, on the side of the scene.
      for (let i = 3; i < end; i += 3) {
        expect(hose[i + 1]! - unit.height).toBeLessThan(0.1);
        expect(hose[i + 2]).toBeLessThan(-UNIT_BODY.engine.halfWidth);
      }
    }
  });

  it('turns the water off and carries the hose back before the engine leaves', () => {
    const unit = engineAt(0, 6, 12);
    expect(hosing(unit, unit.until - STOW_TICKS - 1)).toBe(true);
    expect(hosing(unit, unit.until - STOW_TICKS)).toBe(false);
    const placed = crewAt(unit, DEPLOY_TICKS + 60);
    const back = crewAt(unit, unit.until - 1);
    const out = crewAt(unit, 0);
    for (let member = 0; member < CREW; member++) {
      expect(back[member]!.spraying).toBe(false);
      expect(back[member]!.pose.x).toBeCloseTo(out[member]!.pose.x, 5);
      expect(back[member]!.pose.y).toBeCloseTo(out[member]!.pose.y, 5);
      expect(placed[member]!.pose.x).not.toBeCloseTo(out[member]!.pose.x, 1);
    }
  });
});
