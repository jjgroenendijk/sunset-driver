import { Box3, Mesh, Vector3, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { riderStruts } from '../src/render/bike-rider.ts';
import { strutOf, TrafficView } from '../src/render/traffic.ts';
import { saddleOf } from '../src/render/vehicle-mesh.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { PARKED_CLASSES } from '../src/sim/parked.ts';
import { AMBIENT_CLASSES } from '../src/sim/traffic.ts';
import { createVehicleState, rideHeight, specOf, VEHICLE_CLASSES } from '../src/sim/vehicle.ts';
import { sweepSeeds } from './helpers.ts';
import { gridTraffic } from './traffic-grid.ts';

/**
 * The rider on a bike of the traffic (issue #549): the figure of boxes merged
 * into the class's own geometry, so a bike driving past carries somebody.
 *
 * The figure is measured against the places `vehicle-mesh.ts` drew the seat,
 * the grips and the pegs, as the player's rider is in `rider.test.ts`.
 */

/** Metres a hand may sit off the grip it holds, and a boot off its peg. */
const HAND_SLACK = 0.09;
const BOOT_SLACK = 0.09;

function at(point: readonly [number, number, number]): Vector3 {
  return new Vector3(point[0], point[1], point[2]);
}

describe('the rider of a bike in the traffic', () => {
  it('sits on nothing but a class ridden astride', () => {
    for (const cls of VEHICLE_CLASSES) {
      const spec = specOf(cls);
      const ridden = saddleOf(spec) !== undefined;
      expect(riderStruts(spec).length > 0, cls).toBe(ridden);
    }
    // A parked car is empty, and a parked bike would be too.
    for (const cls of PARKED_CLASSES) expect(riderStruts(specOf(cls)), cls).toEqual([]);
  });

  it('puts the hips on the saddle, the hands on the grips and the boots on the pegs', () => {
    const spec = specOf('motorcycle');
    const saddle = saddleOf(spec) as NonNullable<ReturnType<typeof saddleOf>>;
    const struts = riderStruts(spec);
    const hips = at(struts[0]?.from as [number, number, number]);
    expect(hips.distanceTo(new Vector3(saddle.x, saddle.y, 0))).toBeLessThan(0.01);
    for (const side of [1, -1]) {
      const grip = new Vector3(saddle.gripX, saddle.gripY, side * saddle.gripZ);
      const peg = new Vector3(saddle.pegX, saddle.pegY, side * saddle.pegZ);
      const hand = struts.filter((strut) => at(strut.to).distanceTo(grip) < HAND_SLACK);
      const boot = struts.filter((strut) => at(strut.from).distanceTo(peg) < BOOT_SLACK);
      expect(hand.length, `hand at ${side}`).toBeGreaterThan(0);
      expect(boot.length, `boot at ${side}`).toBeGreaterThan(0);
    }
  });

  it('keeps the whole body on the bike, above the road and inside its length', () => {
    const spec = specOf('motorcycle');
    const ground = -rideHeight(spec);
    for (const strut of riderStruts(spec)) {
      for (const point of [strut.from, strut.to]) {
        expect(point[1], 'above the road').toBeGreaterThan(ground + strut.thickness / 2);
        expect(Math.abs(point[0]), 'within the wheelbase').toBeLessThanOrEqual(spec.halfLength);
        expect(Math.abs(point[2]), 'no wider than the bars').toBeLessThanOrEqual(spec.halfWidth);
      }
    }
    // The head is the tallest thing on the bike, which is why it is drawn.
    const top = Math.max(...riderStruts(spec).map((strut) => strut.to[1]));
    expect(top).toBeGreaterThan(spec.halfHeight * 2);
  });

  it('draws a strut as a box running from one end of it to the other', () => {
    const strut = { from: [0.2, 0.3, -0.4] as const, to: [-0.1, 0.9, 0.5] as const, thickness: 0.1, width: 0.1, colour: 0x445566 };
    const box = new Box3().setFromObject(new Mesh(strutOf(strut)));
    for (const end of [at(strut.from), at(strut.to)]) {
      // The box reaches each end, give or take half its own thickness.
      expect(box.distanceToPoint(end)).toBe(0);
      expect(box.min.distanceTo(end) * box.max.distanceTo(end)).toBeGreaterThan(0);
    }
    expect(box.getCenter(new Vector3()).distanceTo(at(strut.from).add(at(strut.to)).multiplyScalar(0.5))).toBeLessThan(1e-6);
  });
});

describe('the traffic drawn with its riders', () => {
  it('gives one instance of somebody to each vehicle on its tour, a bike among them', () => {
    const seed = sweepSeeds(1)[0] as number;
    const traffic = gridTraffic(seed);
    const view = new TrafficView(traffic);
    // Every class has a paint mesh and a mesh of whoever is in it: the rider
    // astride a bike, the driver behind the glass of a car (`occupant.ts`).
    const shadowed = view.group.children.filter((child) => (child as InstancedMesh).isInstancedMesh && child.castShadow);
    expect(shadowed.length).toBe(AMBIENT_CLASSES.length * 2);

    const state = createSimState(seed, undefined, 0);
    const tick = 4321.5;
    view.update(state, tick, 0, 0);
    const bikes = riderCount(view);
    expect(bikes).toBeGreaterThan(0);

    // A bike the player has touched has nobody on it, so it costs no instance.
    const id = ridingId(traffic, tick);
    expect(id).toBeGreaterThanOrEqual(0);
    state.traffic.promoted.push({
      id,
      paint: (traffic.vehicles[id] as (typeof traffic.vehicles)[number]).paint,
      vehicle: createVehicleState(specOf('motorcycle'), 5, 5, 1, 0),
    });
    view.update(state, tick, 0, 0);
    expect(riderCount(view)).toBe(bikes - 1);
    view.dispose();
  });
});

/** How many riders the last frame wrote: the instances of the one shadowed mesh with no paint on it. */
function riderCount(view: TrafficView): number {
  let count = 0;
  for (const child of view.group.children) {
    const mesh = child as InstancedMesh;
    if (mesh.isInstancedMesh && mesh.castShadow && mesh.instanceColor === null) count += mesh.count;
  }
  return count;
}

/** The id of a bike in view and on its tour, or -1 where the grid put none there. */
function ridingId(traffic: ReturnType<typeof gridTraffic>, tick: number): number {
  const pose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  for (const vehicle of traffic.vehicles) {
    if (vehicle.cls !== 'motorcycle') continue;
    const place = traffic.poseAt(vehicle.id, tick, pose);
    if (Math.abs(place.x) <= 180 && Math.abs(place.y) <= 180) return vehicle.id;
  }
  return -1;
}
