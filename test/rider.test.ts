import { Box3, Mesh, Quaternion, Vector3, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { CharacterModel } from '../src/render/character.ts';
import { seatRider } from '../src/render/rider.ts';
import { saddleOf, type Saddle } from '../src/render/vehicle-mesh.ts';
import { BODY_TYPES, resolveAppearance, type CharacterAppearance } from '../src/sim/character.ts';
import { createVehicleState, ROSTER, specOf } from '../src/sim/vehicle.ts';

/**
 * The rider of `rider.ts`: the player, drawn on the bike they are riding.
 *
 * What matters is that the body lands on the bike rather than near it, for
 * every build a player can choose, so the parts are measured where they end up
 * in the world and compared with the places `vehicle-mesh.ts` drew the seat,
 * the grips and the pegs.
 */

/** Metres a hand may sit off the grip it holds, and a boot off its peg. */
const HAND_SLACK = 0.08;
const BOOT_SLACK = 0.06;

const BIKE = ROSTER.motorcycle;

function lookOf(body: number): CharacterAppearance {
  return { body, skin: 0, hair: 0, hairColour: 0, outfit: 0 };
}

/** Where every mesh of a colour stands in the world, once the model is posed. */
function partsOf(model: CharacterModel, colour: number): Vector3[] {
  model.group.updateMatrixWorld(true);
  const found: Vector3[] = [];
  model.group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    if ((object.material as MeshStandardMaterial).color.getHex() !== colour) return;
    found.push(object.getWorldPosition(new Vector3()));
  });
  return found;
}

/** The model of a build, sat on a bike standing at the origin. */
function seated(body: number): { model: CharacterModel; saddle: Saddle } {
  const model = new CharacterModel(lookOf(body));
  expect(seatRider(model, createVehicleState(BIKE), BIKE)).toBe(true);
  return { model, saddle: saddleOf(BIKE) as Saddle };
}

describe('the rider of a motorcycle', () => {
  it('sits on a bike and on nothing else', () => {
    const model = new CharacterModel(lookOf(1));
    const car = specOf('saloon');
    expect(seatRider(model, createVehicleState(car, 4, 5, 6), car)).toBe(false);
    expect(seatRider(model, createVehicleState(BIKE, 4, 5, 6), BIKE)).toBe(true);
    model.dispose();
  });

  it('puts the hips on the saddle, whatever the build', () => {
    for (let body = 0; body < BODY_TYPES.length; body++) {
      const { model, saddle } = seated(body);
      // The rig hangs from the hips, so the model stands its own hip height
      // below the seat it is sat on.
      expect(model.group.position.y + model.hipsAt, `body ${body}`).toBeCloseTo(saddle.y, 6);
      expect(model.group.position.x, `body ${body}`).toBeCloseTo(saddle.x, 6);
      model.dispose();
    }
  });

  it('closes the hands on the grips and stands the boots on the pegs', () => {
    for (let body = 0; body < BODY_TYPES.length; body++) {
      const { model, saddle } = seated(body);
      const look = resolveAppearance(lookOf(body));
      // The hands are the two lowest parts in the skin tone; the head is the
      // highest, and it is the only other one.
      const skin = partsOf(model, look.skin.colour).sort((a, b) => a.y - b.y);
      const hands = skin.slice(0, 2);
      expect(hands.length).toBe(2);
      for (const hand of hands) {
        expect(Math.hypot(hand.x - saddle.gripX, hand.y - saddle.gripY), `body ${body}`).toBeLessThan(HAND_SLACK);
        expect(Math.abs(Math.abs(hand.z) - saddle.gripZ), `body ${body}`).toBeLessThan(HAND_SLACK);
      }
      for (const boot of partsOf(model, look.outfit.shoe)) {
        expect(Math.hypot(boot.x - saddle.pegX, boot.y - saddle.pegY), `body ${body}`).toBeLessThan(BOOT_SLACK);
      }
      model.dispose();
    }
  });

  it('keeps the whole rider over the bike and off the road', () => {
    const wheelBottom = -BIKE.suspensionRest - BIKE.wheelRadius + (BIKE.wheels[0] as { y: number }).y;
    for (let body = 0; body < BODY_TYPES.length; body++) {
      const { model } = seated(body);
      const bounds = new Box3().setFromObject(model.group);
      // A boot hanging through the tarmac is what a fixed pose gets wrong
      // first, so the lowest corner of the model is held above the contact
      // patch the bike stands on.
      expect(bounds.min.y, `body ${body}`).toBeGreaterThan(wheelBottom);
      // And the rider is the tallest thing on the bike, not a passenger
      // floating behind it.
      expect(bounds.min.x, `body ${body}`).toBeGreaterThan(-BIKE.halfLength);
      expect(bounds.max.x, `body ${body}`).toBeLessThan(BIKE.halfLength);
      model.dispose();
    }
  });

  it('leans with the bike and rides where it rides', () => {
    const model = new CharacterModel(lookOf(1));
    const state = createVehicleState(BIKE, 12, -30, 4);
    // A bike laid over into a corner: rolled about the way it faces.
    const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    state.qx = turn.x;
    state.qy = turn.y;
    state.qz = turn.z;
    state.qw = turn.w;
    seatRider(model, state, BIKE);
    expect(model.group.quaternion.angleTo(turn)).toBeCloseTo(0, 6);
    // The saddle is behind the middle of the bike and below the top of it, and
    // the roll swings it out to the side: the rider goes with it.
    const saddle = saddleOf(BIKE) as Saddle;
    const where = new Vector3(saddle.x, saddle.y - model.hipsAt, 0).applyQuaternion(turn);
    expect(model.group.position.x).toBeCloseTo(12 + where.x, 6);
    expect(model.group.position.y).toBeCloseTo(4 + where.y, 6);
    expect(model.group.position.z).toBeCloseTo(-30 + where.z, 6);
    expect(model.group.position.z).not.toBeCloseTo(-30, 3);
    model.dispose();
  });
});
