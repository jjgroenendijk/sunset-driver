/**
 * The city's own life on screen (spec section 20.5): the crowd an event has
 * drawn, the two people standing where a mugging is going on, and the marks
 * both put on the map.
 *
 * `src/sim/city-events.ts` says what is on and `src/sim/street-crime.ts` what
 * is going on; neither of them knows anything about a mesh. This turns both
 * into the people the crowd's own mesh draws, so a parade of forty-eight and
 * every incident in view cost no draw call of their own — exactly as the
 * dealers of spec section 16.2 and the enforcers of 17.2 do.
 *
 * The mesh reads one list of people, so this is the last link of the chain
 * that writes it: the dealers and the enforcers first (`enforcers.ts`), then
 * the event crowd, then the people in the incidents. The same goes for the
 * map: `marks` is everything else's plus these.
 *
 * A look is drawn once per person of an event and kept, because a face that
 * changes between two frames is not a face. Only what is near the player is
 * built at all, so a parade across town costs one distance check.
 */
import { genRng, Subsystem } from '../core/rng.ts';
import {
  eventAt,
  eventKey,
  eventPeople,
  eventsAt,
  type EventPerson,
  type LiveEvent,
  type Venues,
} from '../sim/city-events.ts';
import { lookOf, type PedestrianLook } from '../sim/pedestrian-look.ts';
import type { SimState } from '../sim/simulation.ts';
import { CRIMES, crimesAt, type CrimeGround, type StreetCrime } from '../sim/street-crime.ts';
import type { StandingPerson } from '../render/pedestrians.ts';
import type { MapPoi, MapPois } from './map.ts';

/** Metres from the player an event or an incident is built at all. */
export const STREET_LIFE_NEAR = 160;

/** Metres apart the two people of an incident stand, facing each other. */
const APART = 1.6;

/** The zone the people of an event and an incident are dressed for. */
const STREET_DRESS = 'inner';

/** Face keys each event is given room for, so two events never share one. */
const CROWD_KEYS = 256;

/** What is on and what is going on, as people on the street and marks on the map. */
export class StreetLife {
  /** The people the crowd mesh is to draw. The array is never replaced. */
  readonly standing: StandingPerson[] = [];
  /** The marks this last wrote: everything else's, plus the events' and the incidents'. */
  marks: readonly MapPoi[] = [];
  /** What the player is standing in the middle of, for the HUD to name. Empty while nothing is. */
  happening = '';
  /** What is on at the tick this last drew, for whoever else wants to ask. */
  live: readonly LiveEvent[] = [];
  private readonly seed: number;
  private readonly venues: Venues;
  private readonly grounds: readonly CrimeGround[];
  private readonly pois: MapPois;
  private readonly looks = new Map<number, PedestrianLook>();
  private readonly people: EventPerson[] = [];
  private drawn = 0;

  constructor(seed: number, venues: Venues, grounds: readonly CrimeGround[], pois: MapPois) {
    this.seed = seed;
    this.venues = venues;
    this.grounds = grounds;
    this.pois = pois;
    this.marks = pois.extra;
  }

  /**
   * Put the people and the marks where the tick leaves them. `ground` answers
   * how high a street is, because somebody at an event stands on it; `before`
   * is whatever was already standing on the street and already on the map.
   */
  update(
    state: SimState,
    ground: { heightAt(x: number, y: number): number },
    before: { standing: readonly StandingPerson[]; marks: readonly MapPoi[] },
  ): void {
    const at = state.player.driving
      ? { x: state.vehicle.x, y: state.vehicle.z }
      : { x: state.player.x, y: state.player.y };
    const live = eventsAt(state.seed, state.tick, this.venues);
    const crimes = crimesAt(state.seed, state.tick, this.grounds, state.crimes);
    this.live = live;
    const inside = eventAt(live, at.x, at.y);
    this.happening = inside === undefined ? '' : inside.name;
    this.standing.length = 0;
    for (const person of before.standing) this.standing.push(person);
    if (live.length === 0 && crimes.length === 0 && this.drawn === 0) {
      // Nothing is on and nothing is going on, which is most of a session.
      // Whoever was already on the street is carried through all the same:
      // this is the list the crowd mesh draws.
      this.marks = before.marks;
      return;
    }
    const marks: MapPoi[] = [];
    for (const event of live) {
      if (event.radius <= 0) continue;
      marks.push({ type: 'event', x: event.x, y: event.y, name: event.name });
      if (Math.hypot(event.x - at.x, event.y - at.y) > STREET_LIFE_NEAR + event.radius) continue;
      this.standEvent(state, event, ground);
    }
    for (const crime of crimes) {
      marks.push({ type: 'incident', x: crime.x, y: crime.y, name: CRIMES[crime.kind].name });
      if (Math.hypot(crime.x - at.x, crime.y - at.y) > STREET_LIFE_NEAR) continue;
      this.standCrime(state, crime, ground);
    }
    this.drawn = this.standing.length - before.standing.length;
    // Nobody is left at the event, so no face has to be kept for one.
    if (this.drawn === 0) this.looks.clear();
    this.marks = [...before.marks, ...marks];
    this.pois.extra = this.marks;
  }

  /** The crowd of one event, standing or marching where the tick leaves them. */
  private standEvent(
    state: SimState,
    event: LiveEvent,
    ground: { heightAt(x: number, y: number): number },
  ): void {
    const key = eventKey(event) * CROWD_KEYS;
    for (const [i, person] of eventPeople(event, state.seed, state.tick, this.people).entries()) {
      this.stand(person, ground, key + i);
    }
  }

  /** The two people of one incident: the one doing it and the one it is done to. */
  private standCrime(
    state: SimState,
    crime: StreetCrime,
    ground: { heightAt(x: number, y: number): number },
  ): void {
    const across = crime.heading + Math.PI / 2;
    for (const side of [1, -1]) {
      this.stand(
        {
          x: crime.x + Math.cos(across) * APART * side * 0.5,
          y: crime.y + Math.sin(across) * APART * side * 0.5,
          // They face each other, which is what makes two people an incident.
          heading: side > 0 ? across + Math.PI : across,
          speed: 0,
          cycle: 0,
        },
        ground,
        // The incidents key their faces below zero, so no face of one is ever
        // the face of somebody at an event.
        -1 - (crime.id * 2 + (side > 0 ? 0 : 1)),
      );
    }
  }

  /** Put one person on the street, with the face their key has always had. */
  private stand(
    person: EventPerson,
    ground: { heightAt(x: number, y: number): number },
    key: number,
  ): void {
    this.standing.push({
      look: this.lookFor(key),
      pose: {
        x: person.x,
        y: person.y,
        height: ground.heightAt(person.x, person.y),
        heading: person.heading,
        speed: person.speed,
        cycle: person.cycle,
        gait: person.speed > 0 ? 'stroll' : 'stand',
      },
    });
  }

  /** The face one key wears, drawn once and kept for as long as they are out. */
  private lookFor(key: number): PedestrianLook {
    const held = this.looks.get(key);
    if (held !== undefined) return held;
    const look = lookOf(STREET_DRESS, genRng(this.seed, Subsystem.Events, key));
    this.looks.set(key, look);
    return look;
  }
}
