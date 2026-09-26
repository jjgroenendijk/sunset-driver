/**
 * How each spot on a beach lays out its people and its props (spec section
 * 20.1), in the frame of the spot: `out` towards the sea, `along` across it
 * with the sea ahead and `along` on the left, and `turn` in radians from
 * facing the sea.
 *
 * A person or a prop in the water carries `sea`, metres above sea level; the
 * rest stand on the sand, `up` metres above it. `beach-life.ts` puts them on
 * the map.
 */
import { cos, sin } from '../../core/libm.ts';
import type { Rng } from '../../core/rng.ts';
import type { Gait } from '../crowd/pedestrian-look.ts';
import type { BeachKind } from './beach-hours.ts';

/** The things drawn on a beach besides its people. */
export type BeachProp = 'towel' | 'parasol' | 'tower' | 'icecream' | 'cocktail' | 'net' | 'bonfire' | 'board';

/** The kinds laid out at one spot, rather than running along the dune line. */
export type SpotKind = Exclude<BeachKind, 'joggers' | 'skaters'>;

/** Where one person or prop of a spot is, in its frame. */
interface Laid {
  along: number;
  out: number;
  turn: number;
  /** Metres above sea level, for one in the water. */
  sea?: number;
  /** Metres above the sand, for one on a tower. */
  up?: number;
}

export interface LaidPerson extends Laid {
  gait: Gait;
}

export interface LaidProp extends Laid {
  kind: BeachProp;
  /** Drawn always, with anybody of the spot out, or with one person of it out, by index. */
  owner: 'always' | 'anyone' | number;
}

/** The people and the props of one spot. */
export interface Layout {
  people: LaidPerson[];
  props: LaidProp[];
}

/** Metres a swimmer's hips are under the surface, so the head and shoulders show. */
const SWIM_DEPTH = 0.95;

/** Metres a surfer stands above the water, on the board, and the board itself. */
const SURF_RISE = 0.12;
const BOARD_RISE = 0.03;

/** Metres up a lifeguard stands, on the tower's platform. */
const TOWER_DECK = 2;

/** Metres between two towels side by side. */
const TOWEL_GAP = 2.2;

/** A gait to stand about in. */
function idleGait(rng: Rng): Gait {
  return (['stand', 'phone', 'smoke', 'talk', 'fold'] as const)[rng.int(0, 4)] as Gait;
}

/** A ring of people round a point, facing it, `radius` metres out. */
function ring(layout: Layout, count: number, radius: readonly [number, number], gait: (rng: Rng) => Gait, rng: Rng): void {
  const start = rng.float() * 2 * Math.PI;
  for (let k = 0; k < count; k++) {
    const angle = start + (2 * Math.PI * k) / count + rng.range(-0.25, 0.25);
    const r = rng.range(radius[0], radius[1]);
    layout.people.push({ along: r * sin(angle), out: r * cos(angle), turn: angle + Math.PI + rng.range(-0.3, 0.3), gait: gait(rng) });
  }
}

const LAYOUTS: Record<SpotKind, (rng: Rng) => Layout> = {
  // A row of towels, most lain on and some sat on, and a parasol at one end.
  towels(rng) {
    const layout: Layout = { people: [], props: [] };
    const count = rng.int(1, 4);
    for (let k = 0; k < count; k++) {
      const along = (k - (count - 1) / 2) * TOWEL_GAP + rng.range(-0.3, 0.3);
      const out = rng.range(-1.5, 1.5);
      const turn = rng.range(-0.45, 0.45);
      layout.people.push({ along, out, turn, gait: rng.chance(0.65) ? 'lie' : 'sit' });
      layout.props.push({ kind: 'towel', along, out, turn, owner: k });
    }
    if (rng.chance(0.45)) layout.props.push({ kind: 'parasol', along: ((count + 1) / 2) * TOWEL_GAP, out: -1, turn: 0, owner: 'anyone' });
    return layout;
  },
  // Heads and shoulders in the shallows, swimming whichever way.
  swimmers(rng) {
    const layout: Layout = { people: [], props: [] };
    const count = rng.int(2, 5);
    for (let k = 0; k < count; k++) {
      layout.people.push({ along: rng.range(-10, 10), out: rng.range(6, 22), turn: rng.range(-Math.PI, Math.PI), sea: -SWIM_DEPTH, gait: 'swim' });
    }
    return layout;
  },
  // Out past the swimmers, riding in towards the beach.
  surfers(rng) {
    const layout: Layout = { people: [], props: [] };
    const count = rng.int(1, 4);
    for (let k = 0; k < count; k++) {
      const along = rng.range(-12, 12);
      const out = rng.range(18, 28);
      const turn = Math.PI + rng.range(-0.4, 0.4);
      layout.people.push({ along, out, turn, sea: SURF_RISE, gait: 'surf' });
      layout.props.push({ kind: 'board', along, out, turn, sea: BOARD_RISE, owner: k });
    }
    return layout;
  },
  // A net across the court and two players a side, each facing it.
  volleyball(rng) {
    const layout: Layout = { people: [], props: [{ kind: 'net', along: 0, out: 0, turn: 0, owner: 'always' }] };
    for (const side of [1, -1]) {
      for (const lane of [1.6, -1.6]) {
        layout.people.push({ along: lane + rng.range(-0.4, 0.4), out: side * rng.range(2, 4), turn: side > 0 ? Math.PI : 0, gait: 'volley' });
      }
    }
    return layout;
  },
  // A tower facing the sea, and the lifeguard on its deck.
  lifeguard(rng) {
    return {
      people: [{ along: 0, out: 0.2, turn: rng.range(-0.3, 0.3), up: TOWER_DECK, gait: rng.chance(0.5) ? 'fold' : 'stand' }],
      props: [{ kind: 'tower', along: 0, out: 0, turn: 0, owner: 'always' }],
    };
  },
  icecream: (rng) => stand('icecream', rng),
  cocktail: (rng) => stand('cocktail', rng),
  // A fire and a ring round it, sat on the sand or standing.
  bonfire(rng) {
    const layout: Layout = { people: [], props: [{ kind: 'bonfire', along: 0, out: 0, turn: 0, owner: 'anyone' }] };
    ring(layout, rng.int(3, 6), [1.7, 2.1], (r) => (r.chance(0.6) ? 'sit' : idleGait(r)), rng);
    return layout;
  },
  // A fire and a crowd dancing round it.
  party(rng) {
    const layout: Layout = { people: [], props: [{ kind: 'bonfire', along: 0, out: 0, turn: 0, owner: 'anyone' }] };
    ring(layout, rng.int(8, 14), [2.5, 6], (r) => (r.chance(0.75) ? 'dance' : idleGait(r)), rng);
    return layout;
  },
};

/** A stand facing the sea, the vendor behind its counter and a short queue in front. */
function stand(kind: 'icecream' | 'cocktail', rng: Rng): Layout {
  const layout: Layout = { people: [{ along: 0, out: -0.6, turn: 0, gait: 'stand' }], props: [{ kind, along: 0, out: 0, turn: 0, owner: 'always' }] };
  const queue = rng.int(0, 3);
  for (let k = 0; k < queue; k++) layout.people.push({ along: rng.range(-0.3, 0.3), out: 1.6 + k * 0.8, turn: Math.PI + rng.range(-0.3, 0.3), gait: idleGait(rng) });
  return layout;
}

/** The layout of one spot of a kind. */
export function layOut(kind: SpotKind, rng: Rng): Layout {
  return LAYOUTS[kind](rng);
}
