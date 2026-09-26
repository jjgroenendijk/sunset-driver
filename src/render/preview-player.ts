/**
 * The player of a preview, for the preview alone: the stance they are held in,
 * the weapons in their hands and on the ground, a moment of getting into their
 * vehicle, and the rounds `--shots` lays. The game gets there by being played;
 * this is how one moment of it is looked at.
 */
import { Vector3 } from 'three';
import { createBoarding, startBoarding } from '../sim/boarding.ts';
import { createPlayerState, exitPlace, JUMP_SPEED, SPRINT_SPEED, SWIM_DEPTH } from '../sim/on-foot.ts';
import type { PickupState } from '../sim/pickup.ts';
import type { SimState } from '../sim/simulation.ts';
import type { TracerEnd } from '../sim/tracer.ts';
import type { VehicleSpec, VehicleState } from '../sim/vehicle.ts';
import {
  ATTACHMENTS,
  createLoadout,
  type LoadoutState,
  fitAttachment,
  giveWeapon,
  MUZZLE_HEIGHT,
  MUZZLE_REACH,
  normaliseAttachments,
  WEAPON_IDS,
  weaponOf,
  type Attachment,
} from '../sim/weapon.ts';
import { placeBoarder } from './boarder.ts';
import { gripOf } from './character-hold.ts';
import { poseFor } from './character-pose.ts';
import type { PreviewRequest } from './preview-request.ts';
import type { WorldScene } from './world-scene.ts';

/** Where the player stands, and which way they face. */
interface Stand {
  x: number;
  y: number;
  heading: number;
}

/** A quarter through a cycle, where a leg is furthest forward and the other furthest back. */
const POSE_PHASE = Math.PI / 2;

/**
 * Hold the player in one stance of spec sections 11.2 and 11.5, so a still
 * frame shows the walk, the jump or the stroke that a running game shows over
 * time. Left unasked, the model keeps the standing pose it was built in.
 */
export function hold(scene: WorldScene, request: PreviewRequest): void {
  const asked = request.stance;
  const swing = request.swing ?? -1;
  const weapon = WEAPON_IDS.find((id) => id === request.weapon);
  if (asked === undefined && swing < 0 && weapon === undefined) return;
  const stance = (['stand', 'walk', 'air', 'swim'] as const).find((name) => name === (asked ?? 'stand'));
  if (stance === undefined) throw new Error(`no stance named ${String(asked)}`);
  const stature = scene.character.height;
  // A gun is held in the arms as the game holds it, at the hip or aimed.
  const grip = weapon === undefined || swing >= 0 || stance === 'swim' ? 'none' : gripOf(weaponOf(weapon).cls);
  scene.character.pose(
    poseFor(stance, POSE_PHASE, {
      speed: stance === 'walk' ? SPRINT_SPEED : 0,
      grounded: stance !== 'air',
      vy: stance === 'air' ? JUMP_SPEED : 0,
      // A swimmer is drawn where they stand, so the water is only as deep as
      // the stroke needs: the body lies on the ground rather than in the sea.
      depth: stance === 'swim' ? SWIM_DEPTH * stature * 1.1 : 0,
      stature,
      swing,
    }),
    { grip, aim: request.aim === true ? 1 : 0, kick: 0 },
  );
}

/** Metres between two pickups `--pickups` lays, and how many lie in a row. */
const PICKUP_GRID = 3;
const PICKUP_ROW = 8;

/**
 * The weapons of spec section 11.6, for the preview alone: the one in the
 * player's hands, and with `--pickups` every weapon of the arsenal lying in
 * rows ahead of them.
 */
export function arm(scene: WorldScene, request: PreviewRequest, stand: Stand, tick: number): LoadoutState {
  const attachments = ATTACHMENTS.filter((name: Attachment) => request.attachments?.includes(name) === true);
  const loadout = createLoadout();
  const weapon = WEAPON_IDS.find((id) => id === request.weapon);
  if (weapon !== undefined) {
    giveWeapon(loadout, weapon);
    for (const attachment of attachments) fitAttachment(loadout, weapon, attachment);
  }
  loadout.aiming = request.aim === true;
  const player = createPlayerState();
  player.driving = request.onFoot !== true;
  const ground = scene.heightAt(stand.x, stand.y);
  const grip = scene.character.grip(new Vector3());
  scene.held.set(loadout, player, { ...stand, height: ground }, scene.character.height, request.swing ?? -1, grip);
  if (request.pickups !== true) return loadout;
  const laid: PickupState[] = WEAPON_IDS.filter((id) => id !== 'fists').map((weapon, i) => {
    const x = stand.x + ((i % PICKUP_ROW) - (PICKUP_ROW - 1) / 2) * PICKUP_GRID;
    const y = stand.y + (2 + Math.floor(i / PICKUP_ROW)) * PICKUP_GRID;
    const fits = normaliseAttachments(weaponOf(weapon), attachments);
    return { id: i, weapon, attachments: fits, loaded: 0, rounds: 0, x, y, h: scene.heightAt(x, y), droppedTick: tick };
  });
  scene.pickups.hovered = laid[request.hover ?? -1]?.id;
  // A second of frames at once is long enough for the hover to grow all the way.
  scene.pickups.update(laid, tick, 1);
  return loadout;
}

/** Metres the rounds of `--shots` carry before they stop, and the spread of the blast. */
const VOLLEY_REACH = 14;
const VOLLEY_SPREAD = 0.09;

/** Lay the rounds `--shots` shows into the record, as `gunfire.ts` would have. */
export function volley(record: SimState, stand: Stand, ground: number, tick: number): void {
  const h = ground + MUZZLE_HEIGHT;
  const round = (at: number, pellet: number, yaw: number, reach: number, end: TracerEnd): void => {
    const x = stand.x + Math.cos(stand.heading) * MUZZLE_REACH;
    const y = stand.y + Math.sin(stand.heading) * MUZZLE_REACH;
    const ex = x + Math.cos(yaw) * reach;
    const ey = y + Math.sin(yaw) * reach;
    record.tracers.push({ tick: at, pellet, x, y, h, ex, ey, eh: h - 0.3, end, by: 'player' });
  };
  round(tick - 2, 0, stand.heading + 0.5, VOLLEY_REACH * 0.7, 'vehicle');
  for (let i = 0; i < 8; i++) {
    const yaw = stand.heading + ((i - 3.5) / 3.5) * VOLLEY_SPREAD;
    round(tick - 1, i, yaw, VOLLEY_REACH * (0.8 + 0.05 * (i % 4)), i % 3 === 0 ? 'none' : 'hard');
  }
}

/** Stand the player at a moment of getting into `vehicle` or out of it, as `--board` asks. */
export function boardAt(scene: WorldScene, vehicle: VehicleState, spec: VehicleSpec, asked: string): void {
  const [way, share, far] = asked.split(':');
  const side = far === '1' ? 1 : -1;
  const out = exitPlace(vehicle, spec);
  // Two metres further out than the door, and a metre behind it.
  const dx = out.x - vehicle.x;
  const dy = out.y - vehicle.z;
  const feet = {
    x: vehicle.x - dx * side * 2.2 - Math.cos(out.heading),
    y: vehicle.z - dy * side * 2.2 - Math.sin(out.heading),
    height: scene.heightAt(out.x, out.y),
    heading: out.heading,
  };
  const player = { ...createPlayerState(), x: feet.x, y: feet.y, heading: feet.heading };
  const state = way === 'out' ? createBoarding('out', 0, -1) : startBoarding(player, vehicle, spec, 0);
  const frame = placeBoarder(scene.character, vehicle, spec, state, Number(share ?? 0.5), feet);
  scene.vehicle.openDoor(state.side, frame.door);
  scene.character.group.visible = true;
}
