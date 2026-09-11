import { Box3, BufferAttribute, InstancedMesh, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { createDamageState, explode, ignite, PANELS, type Panel } from '../src/sim/damage.ts';
import { createVehicleState, ROSTER, specOf, type VehicleState } from '../src/sim/vehicle.ts';
import { DamageFx, FLAME_CAP, SMOKE_CAP } from '../src/render/damage-fx.ts';
import { SKID_STEP, SkidMarks } from '../src/render/skid.ts';
import { panelAt, vehicleBoxes } from '../src/render/vehicle-mesh.ts';
import { VehicleModel } from '../src/render/vehicle.ts';

/**
 * The damage of spec section 11.3, drawn. Nothing here needs a renderer: the
 * model, the puffs and the marks are all read back off their geometry, the way
 * the building meshes are.
 */

/** The saloon, dented on one panel by a given amount. */
function dented(panel: Panel, dent: number, lost = false): VehicleState {
  const v = createVehicleState(specOf('saloon'));
  const index = PANELS.indexOf(panel);
  v.damage.dents[index] = dent;
  v.damage.lost[index] = lost;
  v.damage.stage = 'dented';
  return v;
}

function meshes(model: VehicleModel): Mesh[] {
  const found: Mesh[] = [];
  model.group.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}

/** Every vertex of a model, so two poses of it can be compared. */
function vertices(model: VehicleModel): number[] {
  const out: number[] = [];
  for (const mesh of meshes(model)) {
    const position = mesh.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (position === undefined) continue;
    for (let i = 0; i < position.count * 3; i++) out.push((position.array as Float32Array)[i] as number);
  }
  return out;
}

describe('the panels of a shape', () => {
  it('gives every class a panel at each end and a roof over it', () => {
    for (const cls of ['compact', 'saloon', 'sports', 'emergency', 'van', 'offroad'] as const) {
      const boxes = vehicleBoxes(ROSTER[cls]);
      const panels = new Set(boxes.map((part) => part.panel));
      for (const panel of PANELS) expect(panels.has(panel), `${cls} ${panel}`).toBe(true);
      // The shell in the middle belongs to no panel, so a vehicle always has a
      // middle left however much of it has been torn off.
      expect(panels.has(undefined), cls).toBe(true);
    }
  });

  it('reads the panel off where the box stands', () => {
    const spec = ROSTER.saloon;
    const at = (x: number, y: number, z: number): Panel | undefined =>
      panelAt(spec, { length: 0.1, height: 0.1, width: 0.1, x, y, z, colour: 0, outlined: false, panel: undefined });
    expect(at(spec.halfLength * 0.9, -0.2, 0)).toBe('front');
    expect(at(-spec.halfLength * 0.9, -0.2, 0)).toBe('rear');
    expect(at(0, spec.halfHeight * 0.6, 0)).toBe('roof');
    expect(at(0, -0.2, spec.halfWidth * 0.9)).toBe('left');
    expect(at(0, -0.2, -spec.halfWidth * 0.9)).toBe('right');
    expect(at(0, -0.2, 0)).toBeUndefined();
  });
});

describe('a damaged vehicle model', () => {
  it('leaves an undamaged car exactly as it was built', () => {
    const model = new VehicleModel('saloon');
    const before = vertices(model);
    model.set(createVehicleState(specOf('saloon')));
    expect(vertices(model)).toEqual(before);
    model.dispose();
  });

  it('pushes the struck face in and leaves the far one alone', () => {
    const model = new VehicleModel('saloon');
    const spec = ROSTER.saloon;
    /** Vertices standing at one end of the body, in the model's own frame. */
    const atEnd = (sign: number): number => {
      let count = 0;
      for (const mesh of meshes(model)) {
        if (!mesh.visible) continue;
        const position = mesh.geometry.getAttribute('position') as BufferAttribute | undefined;
        if (position === undefined) continue;
        for (let i = 0; i < position.count; i++) {
          if (sign * (position.getX(i) + mesh.position.x) > spec.halfLength * 0.9) count++;
        }
      }
      return count;
    };
    model.set(createVehicleState(spec));
    const nose = atEnd(1);
    const tail = atEnd(-1);
    expect(nose).toBeGreaterThan(0);

    model.set(dented('front', 1));
    // The nose has been pushed back out of the end of the body, and the tail
    // is exactly where it was: nothing hit it.
    expect(atEnd(1)).toBeLessThan(nose);
    expect(atEnd(-1)).toBe(tail);
    model.dispose();
  });

  it('takes a lost panel out of the model, with the outline round it', () => {
    const model = new VehicleModel('saloon');
    const shown = (): number => meshes(model).filter((mesh) => mesh.visible).length;
    model.set(createVehicleState(specOf('saloon')));
    const whole = shown();
    model.set(dented('roof', 1, true));
    expect(shown()).toBeLessThan(whole);
    // A vehicle put back together shows everything again.
    model.set(createVehicleState(specOf('saloon')));
    expect(shown()).toBe(whole);
    model.dispose();
  });

  it('scorches a burnt-out shell and paints it back when the record is fresh', () => {
    const model = new VehicleModel('saloon');
    const paint = ROSTER.saloon.paint;
    const painted = (): boolean =>
      meshes(model).some((mesh) => (mesh.material as { color?: { getHex(): number } }).color?.getHex() === paint);
    model.set(createVehicleState(specOf('saloon')));
    expect(painted()).toBe(true);
    const burnt = createVehicleState(specOf('saloon'));
    explode(burnt.damage, 10);
    model.set(burnt);
    expect(painted()).toBe(false);
    model.set(createVehicleState(specOf('saloon')));
    expect(painted()).toBe(true);
    model.dispose();
  });

  it('dents every class without anything leaving the body it belongs to', () => {
    for (const cls of Object.keys(ROSTER) as (keyof typeof ROSTER)[]) {
      const spec = ROSTER[cls];
      const model = new VehicleModel(cls);
      const v = createVehicleState(spec);
      for (let i = 0; i < PANELS.length; i++) v.damage.dents[i] = 1;
      v.damage.stage = 'smoking';
      model.set(v);
      const bounds = new Box3().setFromObject(model.group);
      expect(bounds.max.x - spec.halfLength, cls).toBeLessThan(0.8);
      expect(bounds.max.z - spec.halfWidth, cls).toBeLessThan(0.8);
      model.dispose();
    }
  });
});

describe('the smoke and the flames', () => {
  const spec = ROSTER.saloon;

  /** How many puffs each batch is drawing. */
  function counts(fx: DamageFx): { smoke: number; flame: number } {
    const found: InstancedMesh[] = [];
    fx.group.traverse((object) => {
      if (object instanceof InstancedMesh) found.push(object);
    });
    return { smoke: (found[0] as InstancedMesh).count, flame: (found[1] as InstancedMesh).count };
  }

  function run(v: VehicleState, ticks: number, from = 0): DamageFx {
    const fx = new DamageFx();
    fx.reset(from);
    for (let tick = from; tick < from + ticks; tick++) fx.update(v, spec, 3, tick);
    return fx;
  }

  it('draws nothing over a car that has only been dented', () => {
    const fx = run(dented('front', 0.4), 120);
    expect(counts(fx)).toEqual({ smoke: 0, flame: 0 });
    fx.dispose();
  });

  it('trails smoke off a smoking car and no flames', () => {
    const v = createVehicleState(spec);
    v.damage.stage = 'smoking';
    const fx = run(v, 120);
    expect(counts(fx).smoke).toBeGreaterThan(0);
    expect(counts(fx).flame).toBe(0);
    fx.dispose();
  });

  it('stands a burning car in flames and holds both pools to their caps', () => {
    const v = createVehicleState(spec);
    ignite(v.damage, 0);
    const fx = run(v, 2000);
    const seen = counts(fx);
    expect(seen.flame).toBeGreaterThan(0);
    expect(seen.smoke).toBeGreaterThan(0);
    expect(seen.flame).toBeLessThanOrEqual(FLAME_CAP);
    expect(seen.smoke).toBeLessThanOrEqual(SMOKE_CAP);
    fx.dispose();
  });

  it('throws a burst out on the tick it explodes, and only once', () => {
    const v = createVehicleState(spec);
    explode(v.damage, 100);
    const quiet = run(v, 1, 99);
    expect(counts(quiet).flame).toBe(0);
    quiet.dispose();

    const fx = new DamageFx();
    fx.reset(99);
    fx.update(v, spec, 3, 99);
    fx.update(v, spec, 3, 100);
    const burst = counts(fx).flame;
    expect(burst).toBeGreaterThan(5);
    fx.update(v, spec, 3, 101);
    // The second frame ages the burst; it does not throw a second one.
    expect(counts(fx).flame).toBeLessThanOrEqual(burst);
    fx.dispose();
  });

  it('puts the same fire in the same place at the same tick', () => {
    const v = createVehicleState(spec);
    ignite(v.damage, 0);
    const places = (): string => {
      const fx = run(v, 300);
      const found: InstancedMesh[] = [];
      fx.group.traverse((object) => {
        if (object instanceof InstancedMesh) found.push(object);
      });
      const out = found.map((mesh) => Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)));
      fx.dispose();
      return JSON.stringify(out);
    };
    expect(places()).toBe(places());
  });
});

describe('the skid marks', () => {
  const spec = ROSTER.saloon;
  const flat = (): number => 0;

  /** A car sliding along, every tyre skidding, at a place on the map. */
  function sliding(x: number): VehicleState {
    const v = createVehicleState(spec, x, 0, spec.halfHeight);
    for (const wheel of v.wheels) {
      wheel.contact = true;
      wheel.skid = true;
      wheel.suspension = spec.suspensionRest;
    }
    return v;
  }

  function drawn(marks: SkidMarks): number {
    return marks.mesh.geometry.drawRange.count;
  }

  it('lays nothing while the tyres are rolling', () => {
    const marks = new SkidMarks();
    for (let i = 0; i < 20; i++) {
      const v = sliding(i * 2);
      for (const wheel of v.wheels) wheel.skid = false;
      marks.update(v, spec, flat);
    }
    expect(drawn(marks)).toBe(0);
    marks.dispose();
  });

  it('lays rubber under a sliding car, on the ground it stands on', () => {
    const marks = new SkidMarks();
    for (let i = 0; i < 20; i++) marks.update(sliding(i * SKID_STEP), spec, flat);
    expect(drawn(marks)).toBeGreaterThan(0);
    const position = marks.mesh.geometry.getAttribute('position') as BufferAttribute;
    let highest = -Infinity;
    for (let i = 0; i < drawn(marks); i++) highest = Math.max(highest, position.getY(i));
    // Just clear of the ground: high enough that the road does not hide it and
    // low enough that it is still lying on the road.
    expect(highest).toBeGreaterThan(0);
    expect(highest).toBeLessThan(0.1);
    marks.dispose();
  });

  it('lays a mark a step of ground apart, however often the frame asks', () => {
    const metres = 12;
    const run = (steps: number): number => {
      const marks = new SkidMarks();
      for (let i = 0; i <= steps; i++) marks.update(sliding((i * metres) / steps), spec, flat);
      const laid = marks.marks;
      marks.dispose();
      return laid;
    };
    // Ground covered is what decides, so a tyre can leave no more marks than
    // there are steps in the ground it covered.
    const cap = (Math.floor(metres / SKID_STEP) + 1) * spec.wheels.length;
    const often = run(96);
    expect(often).toBeLessThanOrEqual(cap);
    expect(often).toBeGreaterThan(cap / 2);
    // A frame ten times as often does not lay ten times the rubber.
    expect(often).toBeLessThanOrEqual(run(12) * 2);
  });

  it('never grows past the buffer it was given', () => {
    const marks = new SkidMarks(600);
    for (let i = 0; i < 400; i++) marks.update(sliding(i * SKID_STEP), spec, flat);
    expect(drawn(marks)).toBeLessThanOrEqual(600);
    expect(drawn(marks)).toBeGreaterThan(0);
    marks.clear();
    expect(drawn(marks)).toBe(0);
    marks.dispose();
  });

  it('follows a hill rather than standing over it', () => {
    const hill = (x: number): number => x * 0.2;
    const marks = new SkidMarks();
    for (let i = 0; i < 12; i++) {
      const v = sliding(i * SKID_STEP);
      v.y = hill(i * SKID_STEP) + spec.halfHeight;
      marks.update(v, spec, hill);
    }
    const position = marks.mesh.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < drawn(marks); i++) {
      expect(Math.abs(position.getY(i) - hill(position.getX(i)))).toBeLessThan(0.3);
    }
    marks.dispose();
  });
});
