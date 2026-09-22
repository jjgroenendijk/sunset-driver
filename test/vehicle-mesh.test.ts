import { BackSide, Box3, Mesh, type Material, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createVehicleState, ROSTER, specOf, VEHICLE_CLASSES, type VehicleClass } from '../src/sim/vehicle.ts';
import { VehicleModel, VEHICLE_OUTLINE_WIDTH } from '../src/render/vehicle.ts';
import {
  LAMP,
  SEAT,
  saddleOf,
  TAIL,
  vehicleBoxes,
  type Saddle,
  type VehicleBox,
} from '../src/render/vehicle-mesh.ts';

/**
 * The models of spec sections 10.1 and 11.3: one silhouette per class, and the
 * outline round it.
 *
 * Nothing here needs a renderer, so the shapes are measured the way the
 * building meshes are: build the model and read the geometry back.
 */

/** Metres a detail may stand outside the body the physics collides with. */
const MAX_OVERHANG = 0.8;

function meshes(model: VehicleModel): Mesh[] {
  const found: Mesh[] = [];
  model.group.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}

/** The dark shells drawn back faces only: the outline of spec section 10.1. */
function outlines(model: VehicleModel): Mesh[] {
  return meshes(model).filter((mesh) => (mesh.material as Material).side === BackSide);
}

describe('the vehicle models', () => {
  it('gives every class a shape that stands on its own numbers', () => {
    for (const cls of VEHICLE_CLASSES) {
      const spec = ROSTER[cls];
      const model = new VehicleModel(cls);
      const bounds = new Box3().setFromObject(model.group);
      // Nothing hangs far off the body the physics collides with: a light bar,
      // a roll cage and a set of handlebars stand a little proud of it, and
      // nothing stands a metre away from the vehicle it belongs to.
      expect(bounds.max.x - spec.halfLength, cls).toBeLessThan(MAX_OVERHANG);
      expect(-spec.halfLength - bounds.min.x, cls).toBeLessThan(MAX_OVERHANG);
      expect(bounds.max.z - spec.halfWidth, cls).toBeLessThan(MAX_OVERHANG);
      expect(bounds.max.y - spec.halfHeight, cls).toBeLessThan(MAX_OVERHANG);
      // The model straddles the middle of the body, which is where the pose is.
      expect(bounds.min.y, cls).toBeLessThan(0);
      expect(bounds.max.y, cls).toBeGreaterThan(0);
      model.dispose();
      expect(model.group.children.length, cls).toBe(0);
    }
  });

  it('draws a silhouette no two classes share', () => {
    const shapes = VEHICLE_CLASSES.map((cls) => {
      const model = new VehicleModel(cls);
      const bounds = new Box3().setFromObject(model.group);
      model.dispose();
      // What a player reads from 60 m up is the footprint and how tall it is.
      return `${(bounds.max.x - bounds.min.x).toFixed(2)}x${(bounds.max.z - bounds.min.z).toFixed(2)}x${(bounds.max.y - bounds.min.y).toFixed(2)}`;
    });
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('rims each mass with an outline and leaves the detail inside it alone', () => {
    for (const cls of VEHICLE_CLASSES) {
      const model = new VehicleModel(cls);
      const masses = vehicleBoxes(ROSTER[cls]).filter((part) => part.outlined);
      const rims = outlines(model);
      expect(rims.length, cls).toBe(masses.length);
      expect(rims.length, cls).toBeGreaterThan(0);
      // Every outline is its mass grown by the width of the line, so it rims
      // the mass rather than hiding it; a hull the same size would z-fight.
      for (let i = 0; i < masses.length; i++) {
        const mass = masses[i] as (typeof masses)[number];
        const rim = new Box3().setFromObject(rims[i] as Mesh);
        expect(rim.max.x - rim.min.x, cls).toBeCloseTo(mass.length + 2 * VEHICLE_OUTLINE_WIDTH, 5);
        expect(rim.max.y - rim.min.y, cls).toBeCloseTo(mass.height + 2 * VEHICLE_OUTLINE_WIDTH, 5);
        expect(rim.max.z - rim.min.z, cls).toBeCloseTo(mass.width + 2 * VEHICLE_OUTLINE_WIDTH, 5);
      }
      model.dispose();
    }
  });

  it('paints every class in the colour its row picked', () => {
    for (const cls of VEHICLE_CLASSES) {
      const model = new VehicleModel(cls);
      const used = new Set(
        meshes(model).map((mesh) => (mesh.material as MeshStandardMaterial).color.getHex()),
      );
      expect(used.has(ROSTER[cls].paint), cls).toBe(true);
      model.dispose();
    }
  });

  it('draws a motorcycle on the two wheels it rides on, not the four it stands on', () => {
    const bike = new VehicleModel('motorcycle');
    // The physics needs a track to have any roll stiffness at all; the rider
    // sees one wheel at each end, on the centreline.
    expect(ROSTER.motorcycle.wheels.length).toBe(4);
    const wheels = bike.group.children.filter((child) => child.children.length > 0);
    expect(wheels.length).toBe(2);
    for (const wheel of wheels) expect(wheel.position.z).toBe(0);
    bike.dispose();

    // A boat has neither.
    const boat = new VehicleModel('boat');
    expect(boat.group.children.filter((child) => child.children.length > 0).length).toBe(0);
    boat.dispose();
  });

  it('rebuilds for the class the record names, and keeps nothing of the last one', () => {
    const model = new VehicleModel('saloon');
    expect(model.vehicle.cls).toBe('saloon');
    const before = new Box3().setFromObject(model.group);

    model.set(createVehicleState(specOf('bus'), 12, 34, 5));
    expect(model.vehicle.cls).toBe('bus');
    const after = new Box3().setFromObject(model.group);
    expect(after.max.x - after.min.x).toBeGreaterThan(before.max.x - before.min.x);
    expect(model.group.position.x).toBe(12);
    expect(model.group.position.z).toBe(34);
    const used = new Set(meshes(model).map((mesh) => (mesh.material as MeshStandardMaterial).color.getHex()));
    expect(used.has(ROSTER.bus.paint)).toBe(true);
    expect(used.has(ROSTER.saloon.paint)).toBe(false);
    model.dispose();
  });

  it('hangs each wheel where its suspension left it', () => {
    const model = new VehicleModel('saloon');
    const spec = ROSTER.saloon;
    const state = createVehicleState(spec);
    const wheel = state.wheels[0] as (typeof state.wheels)[number];
    wheel.suspension = spec.suspensionRest + 0.1;
    model.set(state);
    // The wheels are the groups with something in them that are not a door on its hinge.
    const drawn = model.group.children.filter((child) => child.children.length > 0 && child.name !== 'door');
    const mount = spec.wheels[0] as (typeof spec.wheels)[number];
    expect((drawn[0] as { position: { y: number } }).position.y).toBeCloseTo(mount.y - wheel.suspension, 6);
    model.dispose();
  });
});

describe('the motorcycle', () => {
  const spec = ROSTER.motorcycle;

  it('builds the bike round the rider it carries', () => {
    const saddle = saddleOf(spec) as Saddle;
    const boxes = vehicleBoxes(spec);
    // The seat is drawn with its top at the saddle, so the rider of
    // `rider.ts` sits on the seat and not through it.
    const seat = boxes.filter((part) => part.colour === SEAT && part.z === 0);
    expect(seat.length).toBe(1);
    const top = (seat[0] as VehicleBox).y + (seat[0] as VehicleBox).height / 2;
    expect(top).toBeCloseTo(saddle.y, 6);
    // A grip at each end of the bars, and a peg for each boot.
    const at = (x: number, y: number): VehicleBox[] =>
      boxes.filter((part) => Math.abs(part.x - x) < 1e-6 && Math.abs(part.y - y) < 1e-6 && part.z !== 0);
    expect(at(saddle.gripX, saddle.gripY).length).toBeGreaterThanOrEqual(2);
    expect(at(saddle.pegX, saddle.pegY).length).toBe(2);
  });

  it('reads as a bike from above: a lamp at the nose, a tail light behind, bars across', () => {
    const boxes = vehicleBoxes(spec);
    const lamp = boxes.find((part) => part.colour === LAMP) as VehicleBox;
    const tail = boxes.find((part) => part.colour === TAIL) as VehicleBox;
    expect(lamp.x).toBeGreaterThan(spec.halfLength * 0.5);
    expect(tail.x).toBeLessThan(-spec.halfLength * 0.5);
    // The bars are the one part of a bike wider than the bike, which is what
    // tells a bike from a box at the far end of a street.
    const widest = Math.max(...boxes.map((part) => Math.abs(part.z) + part.width / 2));
    expect(widest).toBeGreaterThan(spec.halfWidth * 1.3);
  });

  it('has no roof to lose, and ends that can go', () => {
    const panels = new Set(vehicleBoxes(spec).map((part) => part.panel));
    // A blow from above finds nothing on a bike to tear off; the nose and the
    // tail are what a bike loses, and the middle of it always stays.
    expect(panels.has('roof')).toBe(false);
    expect(panels.has('front')).toBe(true);
    expect(panels.has('rear')).toBe(true);
    expect(panels.has(undefined)).toBe(true);
  });
});

/** A silhouette a class does not build is a class the picker cannot show. */
describe('the shape table', () => {
  it('answers boxes for every class', () => {
    for (const cls of VEHICLE_CLASSES as readonly VehicleClass[]) {
      const boxes = vehicleBoxes(ROSTER[cls]);
      expect(boxes.length, cls).toBeGreaterThan(2);
      for (const part of boxes) {
        expect(part.length, cls).toBeGreaterThan(0);
        expect(part.height, cls).toBeGreaterThan(0);
        expect(part.width, cls).toBeGreaterThan(0);
      }
    }
  });
});
