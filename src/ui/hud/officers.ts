/**
 * The police on foot of spec section 14, as the player sees them: people in
 * uniform on the street, and a blue mark on both maps.
 *
 * They are drawn in the crowd's own mesh, as the enforcers are (`enforcers.ts`),
 * so a squad costs no draw call of its own. The uniform is a look and a flag
 * (`render/services/uniform.ts`); an officer with their gun out is drawn in the `aim`
 * gait, arms out in front, and `render/services/officer-guns.ts` puts the gun in them.
 *
 * The mesh reads one list of people, and each view that owns some of them
 * writes the list with everyone before it. The officers come after the street
 * life (`street-life.ts`), because they move every tick like the enforcers,
 * and the objective of spec section 18 is marked after them.
 */
import type { Officer } from '../../sim/police/officer.ts';
import type { PedestrianLook } from '../../sim/crowd/pedestrian-look.ts';
import type { SimState } from '../../sim/simulation.ts';
import type { StandingPerson } from '../../render/people/pedestrians.ts';
import { officerLook, officerPerson } from '../../render/services/uniform.ts';
import type { MapPoi, MapPois } from '../map/map.ts';

export class OfficerMarks {
  /** The people the crowd mesh is to draw. The array is never replaced. */
  readonly standing: StandingPerson[] = [];
  /** The marks this last wrote to the map: everything else's, plus the officers'. */
  marks: readonly MapPoi[] = [];
  private readonly looks = new Map<number, PedestrianLook>();
  private readonly pois: MapPois;

  constructor(pois: MapPois) {
    this.pois = pois;
    this.marks = pois.extra;
  }

  /**
   * Move the bodies and the marks to where the record left them. `before` is
   * whatever was already on the street and already on the map. The list
   * before is rewritten in place by its owner, so it is copied every frame:
   * a few dozen references.
   */
  update(state: SimState, before: { standing: readonly StandingPerson[]; marks: readonly MapPoi[] }): void {
    const officers = state.police.officers;
    this.standing.length = 0;
    for (const person of before.standing) this.standing.push(person);
    if (officers.length === 0) {
      // The looks of the ones who have gone are dropped, or a long session
      // keeps a face for every officer it ever met.
      this.looks.clear();
      if (this.marks !== before.marks) {
        this.marks = before.marks;
        this.pois.extra = this.marks;
      }
      return;
    }
    const marks: MapPoi[] = [];
    for (const officer of officers) {
      marks.push({ type: 'officer', x: officer.x, y: officer.y, name: officer.kind === 'swat' ? 'SWAT' : 'Police officer' });
      this.standing.push(officerPerson(officer, this.lookFor(state.seed, officer)));
    }
    this.marks = [...before.marks, ...marks];
    this.pois.extra = this.marks;
  }

  /** The face one wears, drawn once off their own id and kept for as long as they are out. */
  private lookFor(seed: number, officer: Officer): PedestrianLook {
    const held = this.looks.get(officer.id);
    if (held !== undefined) return held;
    const look = officerLook(seed, officer.id, officer.kind);
    this.looks.set(officer.id, look);
    return look;
  }
}
