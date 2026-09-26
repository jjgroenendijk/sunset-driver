/**
 * The dealers of spec section 16.2, as the player sees them: a mark on both
 * maps and a body on the corner.
 *
 * A dealer works one corner for a few hours and then the next
 * (`src/sim/crime/dealer.ts`), so neither the mark nor the body can be written once
 * at the start of a session. Both are rewritten when the spell turns and left
 * alone on every other frame, because the marks are a list the maps walk and
 * the bodies are instances the crowd mesh uploads.
 *
 * The body is one of the crowd: the mesh that draws the city's pedestrians
 * draws these too, so a dealer costs no draw call of its own.
 *
 * The contacts of spec section 18 stand in front of them in the same list
 * (`givers.ts`). They never move, so they are handed over once rather than on
 * every turn of the spell.
 */
import { dealerLook, pitchOf, PITCH_TICKS, type DealerPlace } from '../../sim/crime/dealer.ts';
import type { PedestrianLook } from '../../sim/crowd/pedestrian-look.ts';
import type { StandingPerson } from '../../render/people/pedestrians.ts';
import type { MapPoi, MapPois } from '../map/map.ts';

export class DealerMarks {
  /** The people the crowd mesh is to stand on the corners. The array is never replaced. */
  readonly standing: StandingPerson[] = [];
  /**
   * The marks this last wrote to the map, which is everything else's plus the
   * dealers'. A system that marks places of its own after these reads it rather
   * than the map's list, which it is about to replace (`enforcers.ts`).
   */
  marks: readonly MapPoi[] = [];
  private readonly dealers: readonly DealerPlace[];
  private readonly looks: PedestrianLook[];
  private readonly pois: MapPois;
  /** The marks of everything else, which the dealers' are written after. */
  private readonly others: readonly MapPoi[];
  /** The people who were standing on the street before the dealers: the contacts. */
  private readonly before: readonly StandingPerson[];
  private spell = -1;

  /** `pois.extra` is taken as it stands: whatever is already marked stays marked. */
  constructor(seed: number, dealers: readonly DealerPlace[], pois: MapPois, before: readonly StandingPerson[] = []) {
    this.dealers = dealers;
    this.before = before;
    this.looks = dealers.map((dealer) => dealerLook(seed, dealer));
    this.pois = pois;
    this.others = pois.extra;
    this.marks = pois.extra;
  }

  /**
   * Move the marks and the bodies if the dealers have moved. `ground` answers
   * how high a corner is, since a dealer stands on it rather than at sea level.
   */
  update(tick: number, ground: { heightAt(x: number, y: number): number }): void {
    const spell = Math.floor(Math.max(0, tick) / PITCH_TICKS);
    if (spell === this.spell) return;
    this.spell = spell;
    this.standing.length = 0;
    for (const person of this.before) this.standing.push(person);
    const marks: MapPoi[] = [];
    for (let i = 0; i < this.dealers.length; i++) {
      const dealer = this.dealers[i] as DealerPlace;
      const pitch = pitchOf(dealer, tick);
      marks.push({ type: 'dealer', x: pitch.x, y: pitch.y, name: dealer.name });
      this.standing.push({
        look: this.looks[i] as PedestrianLook,
        // Facing the road they stand beside, which is the way a person
        // watching the street faces.
        pose: { x: pitch.x, y: pitch.y, height: ground.heightAt(pitch.x, pitch.y), heading: pitch.heading, speed: 0, cycle: 0, gait: 'stand' },
      });
    }
    this.marks = [...this.others, ...marks];
    this.pois.extra = this.marks;
  }
}
