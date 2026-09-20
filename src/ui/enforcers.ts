/**
 * The enforcers of spec section 17.2, as the player sees them: people walking
 * up the street, and a mark on both maps.
 *
 * They are drawn in the crowd's own mesh, like the dealers of spec section 16.2
 * (`dealers.ts`), so a wave of five costs no draw call of its own. Their look is
 * drawn once per enforcer and kept, because a person who changes face between
 * two frames is not a person.
 *
 * The mesh reads one list of people somebody else owns, so this writes it for
 * both: the dealers first, then the enforcers. The dealers move once every few
 * hours and the enforcers every tick, so the merge is here, on the side that
 * has to rewrite anyway, and the dealers' own list is left alone.
 *
 * A session with no wave out writes no marks at all, which is almost every
 * frame of almost every session. The people are copied even then, because the
 * list is the one the crowd mesh draws and the dealers and the contacts are
 * already standing in it.
 */
import { genRng, Subsystem } from '../core/rng.ts';
import type { EnforcerUnit } from '../sim/enforcer.ts';
import { FACTIONS } from '../sim/faction.ts';
import { lookOf, type PedestrianLook } from '../sim/pedestrian-look.ts';
import type { SimState } from '../sim/simulation.ts';
import type { StandingPerson } from '../render/pedestrians.ts';
import type { DealerMarks } from './dealers.ts';
import type { MapPoi, MapPois } from './map.ts';

/**
 * The zone an enforcer is dressed for. They are muscle rather than office
 * workers, so they wear what the inner ring wears wherever they are sent.
 */
const ENFORCER_DRESS = 'inner';

export class EnforcerMarks {
  /** The people the crowd mesh is to draw. The array is never replaced. */
  readonly standing: StandingPerson[] = [];
  /**
   * The marks this last wrote to the map, which is everything else's plus the
   * enforcers'. The objective of spec section 18 is marked after these, and
   * reads this rather than the map's list, which it is about to replace
   * (`missions.ts`).
   */
  marks: readonly MapPoi[] = [];
  private readonly looks = new Map<number, PedestrianLook>();
  private readonly pois: MapPois;
  private drawn = 0;

  constructor(pois: MapPois) {
    this.pois = pois;
    this.marks = pois.extra;
  }

  /**
   * Move the bodies and the marks to where the record left them. `ground`
   * answers how high a street is, because an enforcer walks on it rather than
   * at sea level, and `dealers` is what was on the street before them.
   */
  update(state: SimState, ground: { heightAt(x: number, y: number): number }, dealers: DealerMarks): void {
    const units = state.enforcers.units;
    this.standing.length = 0;
    for (const person of dealers.standing) this.standing.push(person);
    if (units.length === 0 && this.drawn === 0) {
      // Nobody is out, but the dealers may have moved on to the next corner,
      // and this is the list the objective's own mark is written after.
      this.marks = dealers.marks;
      return;
    }
    const marks: MapPoi[] = [];
    for (const unit of units) {
      marks.push({ type: 'enforcer', x: unit.x, y: unit.y, name: nameOf(unit) });
      this.standing.push({
        look: this.lookFor(state.seed, unit),
        pose: {
          x: unit.x,
          y: unit.y,
          height: ground.heightAt(unit.x, unit.y),
          heading: unit.heading,
          speed: unit.speed,
          cycle: unit.cycle,
          gait: unit.speed > 0 ? 'run' : 'stand',
        },
      });
    }
    // The looks of the ones who have gone are dropped, or a long session keeps
    // a face for every enforcer it ever met.
    if (units.length === 0) this.looks.clear();
    this.drawn = units.length;
    this.marks = [...dealers.marks, ...marks];
    this.pois.extra = this.marks;
  }

  /** The face one wears, drawn once off their own id and kept for as long as they are out. */
  private lookFor(seed: number, unit: EnforcerUnit): PedestrianLook {
    const held = this.looks.get(unit.id);
    if (held !== undefined) return held;
    const look = lookOf(ENFORCER_DRESS, genRng(seed, Subsystem.Enforcers, unit.id));
    this.looks.set(unit.id, look);
    return look;
  }
}

/** What the map calls one: the faction, so the player knows who they have crossed. */
function nameOf(unit: EnforcerUnit): string {
  return FACTIONS[unit.faction]?.name ?? 'Enforcer';
}
