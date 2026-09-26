/**
 * Where the job in hand is going, on both maps (spec sections 12, 18).
 *
 * The contacts themselves never move, so `maps.ts` marks them once with the
 * rest of the places. What moves is the objective: one mark on the leg being
 * worked on, which is the last thing written to the map's list and so the last
 * link of the chain that starts at the dealers and runs through the enforcers
 * (`dealers.ts`, `enforcers.ts`).
 *
 * A session carrying no job writes nothing at all, which is most of a session.
 */
import { activeLeg } from '../../sim/missions/mission.ts';
import type { SimState } from '../../sim/simulation.ts';
import type { MapPoi, MapPois } from './map.ts';

export class MissionMarks {
  private readonly pois: MapPois;
  /** The marks everything else had written when this last wrote, and the leg it marked. */
  private others: readonly MapPoi[] = [];
  private shown = '';

  constructor(pois: MapPois) {
    this.pois = pois;
    this.others = pois.extra;
  }

  /**
   * Move the objective's mark to the leg the record is on. `others` is the
   * list of everything marked before it, which this is written after.
   */
  update(state: SimState, others: { marks: readonly MapPoi[] }): void {
    const leg = activeLeg(state);
    const at = leg === undefined ? '' : `${leg.x},${leg.y},${leg.label}`;
    if (at === this.shown && others.marks === this.others) return;
    this.shown = at;
    this.others = others.marks;
    if (leg === undefined) {
      this.pois.extra = others.marks;
      return;
    }
    this.pois.extra = [...others.marks, { type: 'objective', x: leg.x, y: leg.y, name: leg.label }];
  }
}
