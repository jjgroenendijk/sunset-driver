/**
 * The crews of the emergency units at work (spec section 20.3), as the player
 * sees them: firefighters in helmets and turnout gear holding the hoses, and
 * medics walking from the back of an ambulance to whoever is down.
 *
 * They are drawn in the crowd's own mesh, as the police on foot are
 * (`officers.ts`), so a crew costs no draw call of its own. Where each one
 * stands is the record's (`sim/city/emergency-crew.ts`); the hoses and the water
 * are drawn with the unit (`render/services/emergency.ts`), and a medic knelt at a
 * body in `render/people/casualties.ts`, which is the only mesh with a kneel in it.
 *
 * The mesh reads one list of people, and each view that owns some of them
 * writes the list with everyone before it. The crews come after the police,
 * and end the list.
 */
import type { CrewMember } from '../../sim/city/emergency-crew.ts';
import type { SimState } from '../../sim/simulation.ts';
import { crewLook } from '../../render/services/emergency-crew.ts';
import type { PedestrianLook } from '../../sim/crowd/pedestrian-look.ts';
import type { StandingPerson } from '../../render/people/pedestrians.ts';

export class EmergencyCrews {
  /** The people the crowd mesh is to draw. The array is never replaced. */
  readonly standing: StandingPerson[] = [];
  private readonly looks = new Map<number, PedestrianLook>();

  /**
   * Put every crew on the street where the record has them. `before` is
   * whoever was already on it, copied every frame because its owner rewrites
   * it in place.
   */
  update(state: SimState, before: { standing: readonly StandingPerson[] }): void {
    this.standing.length = 0;
    for (const person of before.standing) this.standing.push(person);
    const crew = state.emergency.crew;
    if (crew.length === 0) {
      // The looks of the ones who have gone are dropped, or a long session
      // keeps a face for every crew it ever met.
      this.looks.clear();
      return;
    }
    for (const member of crew) {
      // A medic knelt at a body is drawn in the casualties' mesh, which is the
      // one that can kneel: drawing them here as well would stand them up too.
      if (member.kneeling) continue;
      const pose = {
        x: member.x,
        y: member.y,
        height: member.height,
        heading: member.heading,
        speed: member.speed,
        cycle: member.cycle,
        gait: member.gait,
      };
      this.standing.push({ pose, look: this.lookFor(member) });
    }
  }

  /** The face one wears, drawn once off their own id and kept while they are out. */
  private lookFor(member: CrewMember): PedestrianLook {
    const held = this.looks.get(member.id);
    if (held !== undefined) return held;
    const look = crewLook(member.id, member.role);
    this.looks.set(member.id, look);
    return look;
  }
}
