/**
 * The crews of the fire engines at work (spec section 20.3), as the player
 * sees them: firefighters in helmets and turnout gear, holding the hoses.
 *
 * They are drawn in the crowd's own mesh, as the police on foot are
 * (`officers.ts`), so a crew costs no draw call of its own. Where each one
 * stands is `render/fire-crew.ts`, from the engine and the tick; the hoses and
 * the water are drawn with the engine (`render/emergency.ts`).
 *
 * The mesh reads one list of people, and each view that owns some of them
 * writes the list with everyone before it. The crews come after the police,
 * and end the list.
 */
import type { SimState } from '../sim/simulation.ts';
import { emptyFirefighter, fireCrew, firefighterLook, type Firefighter } from '../render/fire-crew.ts';
import type { StandingPerson } from '../render/pedestrians.ts';

export class FireCrews {
  /** The people the crowd mesh is to draw. The array is never replaced. */
  readonly standing: StandingPerson[] = [];
  private readonly crew: Firefighter[] = [];

  /**
   * Put every crew on the street where the record's engines have them.
   * `before` is whoever was already on it, copied every frame because its
   * owner rewrites it in place.
   */
  update(state: SimState, before: { standing: readonly StandingPerson[] }): void {
    this.standing.length = 0;
    for (const person of before.standing) this.standing.push(person);
    for (const unit of state.emergency.units) {
      const out = fireCrew(unit, state.tick, this.crew);
      for (let member = 0; member < out; member++) {
        // A fresh pose, since the crew's own is written over by the next engine.
        const pose = { ...(this.crew[member] ?? emptyFirefighter()).pose };
        this.standing.push({ pose, look: firefighterLook(unit.id, member) });
      }
    }
  }
}
