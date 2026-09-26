/**
 * The scene `--emergency` lays into a preview (spec section 20.3): a blaze in
 * the road, a fire engine standing at it with its crew on the hose, and an
 * ambulance behind the player with its medics out of the back.
 *
 * Each is written into the record as `emergency.ts` and `emergency-crew.ts`
 * would have written them, so the frame draws them through the game's own
 * view. A still picture has no ticks to walk a crew out over, so `placeCrew`
 * stands them where a tick of work would have.
 */
import { WORK_TICKS, type EmergencyKind, type EmergencyUnit } from '../../sim/city/emergency.ts';
import { placeCrew } from '../../sim/city/emergency-crew.ts';
import { light } from '../../sim/vehicles/fire.ts';
import type { SimState } from '../../sim/simulation.ts';
import { EmergencyView } from '../services/emergency.ts';
import type { WorldScene } from '../world-scene.ts';

/**
 * Metres ahead of the player the preview's blaze burns, and where each unit
 * stands: the engine past the blaze and facing it, the ambulance behind the
 * player, so the one frame the game camera takes holds both.
 */
const FIRE_AHEAD = 11;
const ENGINE_AHEAD = FIRE_AHEAD + 8;

/**
 * Metres the blaze burns off the line, towards the camera. The crew work from
 * the flank of the engine nearer the scene, so this puts them on the side the
 * camera sees rather than behind the engine.
 */
const FIRE_ASIDE = 3;
const AMBULANCE_AHEAD = -11;


/**
 * The scene of spec section 20.3: a blaze in the road ahead of the player, a
 * fire engine standing at it and an ambulance behind the player, all written
 * into the record. {@link standCrews} then puts the crews out of the doors.
 */
export function callOut(record: SimState, scene: WorldScene, x: number, y: number, heading: number): void {
  const ahead = (metres: number): { x: number; y: number } => ({
    x: x + Math.cos(heading) * metres,
    y: y + Math.sin(heading) * metres,
  });
  // The camera stands at greater y, so the side of the line with +y is the one it sees.
  const aside = Math.cos(heading) >= 0 ? 1 : -1;
  const line = ahead(FIRE_AHEAD);
  const fire = { x: line.x - Math.sin(heading) * aside * FIRE_ASIDE, y: line.y + Math.cos(heading) * aside * FIRE_ASIDE };
  light(record, fire.x, fire.y);
  const stand = (id: number, kind: EmergencyKind, metres: number, facing: number): EmergencyUnit => {
    const at = ahead(metres);
    return {
      id,
      kind,
      task: 'work',
      call: 0,
      x: at.x,
      y: at.y,
      heading: facing,
      height: scene.heightAt(at.x, at.y),
      speed: 0,
      edges: [],
      distance: 0,
      stop: 0,
      planned: 0,
      goalX: fire.x,
      goalY: fire.y,
      homeX: at.x,
      homeY: at.y,
      // Well into the work, so the crew are at their places and not leaving.
      until: record.tick + WORK_TICKS[kind],
      doors: 1,
      deployed: false,
    };
  };
  record.emergency.units.push(stand(0, 'engine', ENGINE_AHEAD, heading + Math.PI), stand(1, 'ambulance', AMBULANCE_AHEAD, heading));
}

/**
 * The crews of the units on the record, standing at their places with the
 * doors open, and the view that draws them. It answers the view, so the caller
 * can keep it alive while the frame is drawn.
 */
export function standCrews(record: SimState, scene: WorldScene, x: number, y: number): EmergencyView {
  for (const unit of record.emergency.units) placeCrew(record, unit);
  const view = new EmergencyView();
  view.lamps = scene.lampsNow;
  scene.scene.add(view.group);
  view.update(record, x, y);
  return view;
}

