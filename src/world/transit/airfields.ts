/**
 * The airfields of spec section 8.4: the airport every seed has, the rural
 * airstrips, the ground helipads and the seaplane dock.
 *
 * Each is a rectangle claimed before the roads are traced, the way the sea is
 * (spec section 1.1). The ground inside it is levelled once, here, so the
 * terrain every later stage reads is already flat there. The roads keep off it
 * (`road-route.ts`), the parcels are cut round it (`parcels.ts`), and one road
 * is laid from its gate to the network (`roads.ts`). Nothing is placed and then
 * moved off it.
 *
 * The search is a pure scan of the heightfield: no random stream, so the same
 * terrain always gives the same airfields. The layout of each kind is a table
 * of boxes in the airfield's own frame, `u` along the runway and `v` across it,
 * which is what the renderer draws and the physics reads.
 */
import { clamp, dist, smoothstep } from '../../core/math.ts';
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { ZONE_RADII, zoneAt, type ZoneLayout } from '../terrain/districts.ts';
import type { Heightfield } from '../terrain/heightfield.ts';
import { GradedLand } from '../carve/graded-land.ts';
import { LandMasses } from '../terrain/landmass.ts';
import { DRY_MARGIN } from '../roads/road-ground.ts';
import { TIERS } from '../roads/tiers.ts';
import type { AircraftClass, AircraftStand, Airfield, AirfieldKind, AirfieldPart, Point, WaterDescription, Zone } from '../types.ts';

export { airfieldAt, airfieldCorners, AirfieldMask, airfieldRamp } from './airfield-frame.ts';
import { fromLocal, toLocal } from './airfield-frame.ts';

/** Metres the ground at every sample of a site and its margin must stand over the sea. */
const SITE_DRY = 3;
/** Metres a site keeps from the edge of the map. */
const EDGE = 120;
/** Metres the levelled ground takes to blend back into the hillside past the rectangle. */
export const LEVEL_BLEND = 60;
/** The rise over run of the blend past an airfield that costs its site nothing. */
const BANK_GRADE = 0.2;
/** Metres between the height samples that judge a candidate, and the finer ones that confirm it. */
const COARSE = 80;
const FINE = 40;
/** Candidates kept from the coarse pass for the fine one. */
const SHORTLIST = 12;
/** Headings a runway is tried at, over half a turn. */
const HEADINGS = 8;
/**
 * Metres the gate stands off the rectangle: past the blend, on the ground as
 * it was, so the road that serves it climbs nothing the levelling made. The
 * ground between is the airfield's own ramp, which no road needs to climb.
 */
const GATE_OUT = LEVEL_BLEND + 8;
/** The steepest rise over run the ramp up to the gate may take. */
const RAMP_GRADE = 0.25;
/** Half the width of that ramp. */
export const RAMP_HALF = 9;
/** Metres the roads and the parcels keep from an airfield's rectangle. */
export const AIRFIELD_KEEP = 12;
/**
 * Metres the airport keeps from the middle of the core, margin and all, when
 * no site outside the core's disc is left. Levelled ground there tilts the
 * ground the whole city is built round.
 */
const CORE_CLEAR = 150;
/** Metres of clear ground between two airfields, margins and all. */
const APART = 300;

/** The shortest and longest runway of the airport, in metres; a larger map gets the longer one. */
const RUNWAY_MIN = 800;
const RUNWAY_MAX = 1100;
/** Half the airport across its runway: runway, taxiway, apron, terminal and forecourt. */
const AIRPORT_HALF_V = 150;
/** Metres of the airport past each end of its runway. */
const OVERRUN = 70;
/** Runway length and half widths of a rural airstrip. */
const STRIP_RUNWAY = 450;
const STRIP_HALF_V = 35;
/** Half the side of a ground helipad. */
const PAD_HALF = 22;
/** Metres of water the seaplane needs under it, and around it. */
const DOCK_DEPTH = 2.5;
const DOCK_ROOM = 30;
/** Longest walkway out to the mooring. */
const DOCK_REACH = 60;
/** Map size above which a second airstrip is laid. */
const SECOND_STRIP = 4500;

/** How much a site in each zone is marked down, in metres of fall: the zones an airfield wants come first. */
type ZonePenalty = Partial<Record<Zone, number>>;
// The outer zones at every length first, and the edge of the city after them:
// an airport in the suburbs takes the ground the suburbs' streets grow over,
// and bends the arterials round it out to the shore.
const AIRPORT_OUTER: ZonePenalty = { outskirts: 0, wilderness: 4 };
const AIRPORT_ZONES: ZonePenalty = { ...AIRPORT_OUTER, suburban: 6, industrial: 8 };
const STRIP_ZONES: ZonePenalty = { wilderness: 0, outskirts: 2 };
// A pad in the dense grid of the inner ring cut its blocks apart, so both stand
// where the city thins out: the police one by the industrial yards.
const POLICE_PAD_ZONES: ZonePenalty = { industrial: 0, suburban: 4 };
const MEDICAL_PAD_ZONES: ZonePenalty = { suburban: 0, outskirts: 5 };

/** What one search asks for: the rectangle, its margin, and the zones it may stand in. */
interface SiteAsk {
  halfU: number;
  halfV: number;
  margin: number;
  zones: ZonePenalty;
  /** Metres between the centres tried. */
  step: number;
  /** Headings tried; one for a square. */
  headings: number;
  /** Where along the near side the gate stands, in the airfield's frame. */
  gateU: number;
  /** Metres the rectangle and its margin keep from the core, where set. */
  coreClear?: number;
  /** True to stand only on the land the core stands on. */
  mainland?: boolean;
}

/** A candidate site and how well it scored: the fall of the ground under it, marked down by its zone. */
interface Candidate {
  x: number;
  y: number;
  heading: number;
  score: number;
  level: number;
}

/** What every search reads. */
interface SiteGround {
  hf: Heightfield;
  seaLevel: number;
  size: number;
  zones: ZoneLayout;
  land: LandMasses;
  /** The ground a street can climb to from the core: where a gate can be served from. */
  graded: GradedLand;
}

/**
 * Plan every airfield of a world and level the ground under them. The terrain
 * is levelled in place, so call this before anything reads it for a height:
 * the districts, the beaches and the roads all stand on the levelled ground.
 */
export function planAirfields(hf: Heightfield, water: WaterDescription, zones: ZoneLayout): Airfield[] {
  const ground: SiteGround = {
    hf,
    seaLevel: water.seaLevel,
    size: zones.size,
    zones,
    // The land a road can walk on, not the higher ground a site must stand on:
    // on a low delta the mainland is one piece only at the road's own margin.
    land: new LandMasses(hf, water, water.seaLevel + DRY_MARGIN),
    graded: new GradedLand(hf, zones.core, TIERS.street.maxGrade, water.crossings),
  };
  const fields: Airfield[] = [];
  const runway = clamp(Math.round((zones.size * 0.2) / 50) * 50, RUNWAY_MIN, RUNWAY_MAX);
  const airport = findAirport(ground, runway, fields);
  fields.push(airportAt(fields.length, airport, airport.runway));
  const strips = zones.size >= SECOND_STRIP ? 2 : 1;
  for (let i = 0; i < strips; i++) {
    const site = findSite(ground, stripAsk(), fields);
    if (site !== undefined) fields.push(stripAt(fields.length, site, i));
  }
  for (const [zonesFor, police] of [[POLICE_PAD_ZONES, true], [MEDICAL_PAD_ZONES, false]] as const) {
    const site = findSite(ground, padAsk(zonesFor), fields);
    if (site !== undefined) fields.push(padAt(fields.length, site, police));
  }
  const dock = findDock(ground, fields[0] as Airfield, fields);
  if (dock !== undefined) fields.push(dock);
  for (const field of fields) if (field.kind !== 'dock') levelAirfield(hf, field);
  return fields;
}

/** The airfield with its road and the gate it was laid from, once the tracer has laid one. */
export function withAirfieldRoad(field: Airfield, road: number, gate: Point = field.gate): Airfield {
  return { ...field, road, gate };
}

/**
 * The places a road may serve an airfield from, best first: its own gate, then
 * the middle of each other side. A gate on a hillside no road can climb to
 * leaves the airfield another way in rather than none. Given the ground, a
 * gate whose ramp climbs steeper than a bank may goes behind the gentler ones.
 */
export function gateChoices(field: Airfield, heightAt?: (x: number, y: number) => number): Point[] {
  const out = GATE_OUT;
  const gates = [
    field.gate,
    fromLocal(field, 0, -field.halfV - out),
    fromLocal(field, field.halfU + out, 0),
    fromLocal(field, -field.halfU - out, 0),
  ];
  if (heightAt === undefined) return gates;
  const steep = (p: Point): number => Math.max(0, Math.abs(heightAt(p.x, p.y) - field.level) - out * BANK_GRADE);
  // A stable sort, so gates alike in climb keep the order above.
  return gates.map((p) => ({ p, steep: steep(p) })).sort((a, b) => a.steep - b.steep).map((g) => g.p);
}

// ------------------------------------------------------------------ search

/**
 * The airport's site. Every seed has one (spec section 8.4), so the search
 * gives ground away rather than giving up: a shorter runway in the outer
 * zones, then the edge of the city and the inner ring, then a narrower margin,
 * and the core only last.
 * An airport in the core takes the middle out of the city.
 */
function findAirport(ground: SiteGround, runway: number, taken: readonly Airfield[]): Candidate & { runway: number } {
  const lengths = [runway, RUNWAY_MIN, RUNWAY_MIN * 0.75, RUNWAY_MIN * 0.6];
  const ask = (length: number, zones: ZonePenalty, margin = LEVEL_BLEND, step = 100): SiteAsk => ({
    halfU: length / 2 + OVERRUN,
    halfV: AIRPORT_HALF_V,
    margin,
    step,
    headings: HEADINGS,
    gateU: 0,
    zones,
    coreClear: ZONE_RADII.core * ground.size,
  });
  const near = (each: SiteAsk): SiteAsk => ({ ...each, coreClear: CORE_CLEAR });
  // The core is the last resort: an airport there takes the city's middle out.
  // Every shorter runway anywhere else comes first, then the edge of the core.
  const asks: SiteAsk[] = [
    // The land the core stands on first: an island's airport hangs on the one
    // link to it, and a seed whose link failed left its airport with no road.
    ...lengths.map((length) => ({ ...ask(length, AIRPORT_OUTER), mainland: true })),
    ...lengths.map((length) => ask(length, AIRPORT_OUTER)),
    ...lengths.flatMap((length) => [ask(length, AIRPORT_ZONES), ask(length, { ...AIRPORT_ZONES, inner: 12 })]),
    ...lengths.map((length) => ask(length, { ...AIRPORT_ZONES, inner: 12 }, LEVEL_BLEND / 2, 60)),
    ...lengths.map((length) => near(ask(length, { ...AIRPORT_ZONES, inner: 12, core: 30 }, LEVEL_BLEND / 2, 60))),
    ...lengths.map((length) => ({ ...ask(length, { ...AIRPORT_ZONES, inner: 12, core: 30 }, LEVEL_BLEND / 2, 60), coreClear: undefined })),
  ];
  for (const each of asks) {
    const site = findSite(ground, each, taken);
    if (site !== undefined) {
      // The runway the site was judged for, which may be shorter than the one asked for.
      return { ...site, runway: 2 * (each.halfU - OVERRUN) };
    }
  }
  // No dry rectangle anywhere: take the driest one near the core, and level it.
  return { x: ground.zones.core.x, y: ground.zones.core.y, heading: 0, score: 0, level: ground.seaLevel + SITE_DRY, runway: RUNWAY_MIN * 0.6 };
}

function stripAsk(): SiteAsk {
  const halfU = STRIP_RUNWAY / 2 + 30;
  return { halfU, halfV: STRIP_HALF_V, margin: LEVEL_BLEND, zones: STRIP_ZONES, step: 80, headings: HEADINGS, gateU: halfU - 40 };
}

function padAsk(zones: ZonePenalty): SiteAsk {
  return { halfU: PAD_HALF, halfV: PAD_HALF, margin: LEVEL_BLEND / 2, zones, step: 50, headings: 1, gateU: 0 };
}

/**
 * The best site for a rectangle: dry all over, margin and all, on land the
 * roads can reach, clear of the airfields already placed, in a zone it may
 * stand in, and on the flattest ground those leave. A coarse pass scores every
 * candidate and a fine one confirms the best few.
 */
function findSite(ground: SiteGround, ask: SiteAsk, taken: readonly Airfield[]): Candidate | undefined {
  const { size } = ground;
  const reach = hypot(ask.halfU + ask.margin, ask.halfV + ask.margin);
  const limit = size / 2 - EDGE - reach;
  const shortlist: Candidate[] = [];
  const clear = taken.map((field) => reach + hypot(field.halfU, field.halfV) + APART);
  const mainland = ground.land.massAt(ground.zones.core.x, ground.zones.core.y);
  for (let y = -limit; y <= limit; y += ask.step) {
    for (let x = -limit; x <= limit; x += ask.step) {
      const penalty = placePenalty(ground, ask, taken, clear, mainland, x, y);
      if (penalty === undefined) continue;
      for (let k = 0; k < ask.headings; k++) {
        const candidate = coarseCandidate(ground, ask, x, y, (k * Math.PI) / ask.headings, penalty);
        if (candidate !== undefined) keepBest(shortlist, candidate);
      }
    }
  }
  return confirmBest(ground, ask, shortlist);
}

/** The best of a short list that the fine pass confirms, at the level that pass finds; undefined where none is. */
function confirmBest(ground: SiteGround, ask: SiteAsk, shortlist: readonly Candidate[]): Candidate | undefined {
  for (const candidate of shortlist) {
    const judged = judge(ground, ask, candidate.x, candidate.y, candidate.heading, FINE);
    if (judged !== undefined) return { ...candidate, level: judged.level };
  }
  return undefined;
}

/**
 * The zone penalty of a place for a site, or undefined where the site may not
 * stand there: a zone it may not stand in, land the roads cannot reach, off
 * the mainland when it asks for it, or too near an airfield already placed.
 */
function placePenalty(ground: SiteGround, ask: SiteAsk, taken: readonly Airfield[], clear: readonly number[], mainland: number, x: number, y: number): number | undefined {
  const penalty = ask.zones[zoneAt(ground.zones, x, y)];
  if (penalty === undefined || !ground.land.reaches(x, y)) return undefined;
  if (ask.mainland === true && ground.land.massAt(x, y) !== mainland) return undefined;
  if (taken.some((field, i) => dist(field.x, field.y, x, y) < (clear[i] as number))) return undefined;
  return penalty;
}

/** A site at a place and a heading, judged on the coarse pass, or undefined where it fails. */
function coarseCandidate(ground: SiteGround, ask: SiteAsk, x: number, y: number, turn: number, penalty: number): Candidate | undefined {
  const heading = facingCore(ground.zones.core, x, y, turn);
  if (ask.coreClear !== undefined && offCore(ground.zones.core, ask, x, y, heading) < ask.coreClear) return undefined;
  const judged = judge(ground, ask, x, y, heading, COARSE);
  if (judged === undefined) return undefined;
  // A gate no street can climb to from the city is a gate no road reaches.
  if (!ground.graded.near(fromLocal({ x, y, heading }, ask.gateU, ask.halfV + GATE_OUT))) return undefined;
  return { x, y, heading, score: judged.fall + penalty, level: judged.level };
}

/**
 * A heading, or the one opposite, whichever puts the left side — where the
 * gate, the terminal and the forecourt stand — toward the core, so the road in
 * comes from the city.
 */
function facingCore(core: Point, x: number, y: number, heading: number): number {
  const toward = -sin(heading) * (core.x - x) + cos(heading) * (core.y - y);
  return toward >= 0 ? heading : heading + Math.PI;
}

/** Metres from the core to a rectangle grown by its margin; zero with the core inside it. */
function offCore(core: Point, ask: SiteAsk, x: number, y: number, heading: number): number {
  const at = toLocal({ x, y, heading }, core.x, core.y, { u: 0, v: 0 });
  const du = Math.max(0, Math.abs(at.u) - ask.halfU - ask.margin);
  const dv = Math.max(0, Math.abs(at.v) - ask.halfV - ask.margin);
  return hypot(du, dv);
}

/** Insert a candidate into a short list kept sorted by score, dropping the worst past its length. */
function keepBest(list: Candidate[], candidate: Candidate): void {
  let i = list.length;
  while (i > 0 && (list[i - 1] as Candidate).score > candidate.score) i--;
  if (i >= SHORTLIST) return;
  list.splice(i, 0, candidate);
  if (list.length > SHORTLIST) list.pop();
}

/**
 * The fall of the ground under a rectangle and the level it would be cut to,
 * or undefined where any sample of it or its margin is wet, off the map, or on
 * land the roads cannot reach.
 */
function judge(ground: SiteGround, ask: SiteAsk, x: number, y: number, heading: number, spacing: number): { fall: number; level: number } | undefined {
  const { hf, seaLevel, size } = ground;
  const c = cos(heading);
  const s = sin(heading);
  const outU = ask.halfU + ask.margin;
  const outV = ask.halfV + ask.margin;
  const nu = Math.max(1, Math.ceil((2 * outU) / spacing));
  const nv = Math.max(1, Math.ceil((2 * outV) / spacing));
  let lo = Infinity;
  let hi = -Infinity;
  let edgeLo = Infinity;
  let edgeHi = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = 0; i <= nu; i++) {
    const u = -outU + (2 * outU * i) / nu;
    for (let j = 0; j <= nv; j++) {
      const v = -outV + (2 * outV * j) / nv;
      const px = x + u * c - v * s;
      const py = y + u * s + v * c;
      if (Math.abs(px) > size / 2 - EDGE || Math.abs(py) > size / 2 - EDGE) return undefined;
      const h = hf.sample(px, py);
      if (h < seaLevel + SITE_DRY) return undefined;
      edgeLo = Math.min(edgeLo, h);
      edgeHi = Math.max(edgeHi, h);
      if (Math.abs(u) > ask.halfU || Math.abs(v) > ask.halfV) continue;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
      count++;
    }
  }
  if (count === 0 || !ground.land.reaches(x, y)) return undefined;
  const level = Math.max(seaLevel + SITE_DRY, sum / count);
  // The margin is where the level blends back into the hillside, so ground
  // there far off the level is an embankment or a cutting round the field.
  const bank = Math.max(edgeHi - level, level - edgeLo) - ask.margin * BANK_GRADE;
  // The ramp out to the gate climbs from the level to the ground as it was,
  // and a car has to drive it: a steep one costs twice what a bank does.
  const gate = hf.sample(x + ask.gateU * c - (ask.halfV + GATE_OUT) * s, y + ask.gateU * s + (ask.halfV + GATE_OUT) * c);
  const ramp = Math.abs(gate - level) - GATE_OUT * BANK_GRADE;
  // A ramp no road can climb is a gate no road reaches.
  if (Math.abs(gate - level) > GATE_OUT * RAMP_GRADE) return undefined;
  return { fall: hi - lo + Math.max(0, bank) + 2 * Math.max(0, ramp), level };
}

// ----------------------------------------------------------------- layouts

/** A box of an airfield's layout. */
function part(kind: AirfieldPart['kind'], u0: number, u1: number, v0: number, v1: number, height = 0): AirfieldPart {
  return { kind, u: (u0 + u1) / 2, v: (v0 + v1) / 2, halfU: Math.abs(u1 - u0) / 2, halfV: Math.abs(v1 - v0) / 2, height };
}

/** An aircraft on a stand, placed in the airfield's frame and facing `turn` off its heading. */
function stand(field: Pick<Airfield, 'x' | 'y' | 'heading' | 'level'>, cls: AircraftClass, u: number, v: number, turn: number, military = false): AircraftStand {
  const at = fromLocal(field, u, v);
  return { cls, x: at.x, y: at.y, heading: field.heading + turn, height: field.level, military };
}

/** The frame of an airfield before its parts and stands are laid in it. */
function frame(id: number, kind: AirfieldKind, site: Candidate, halfU: number, halfV: number, gateU: number): Omit<Airfield, 'parts' | 'stands'> {
  const base = { id, kind, x: site.x, y: site.y, heading: site.heading, halfU, halfV, level: site.level, road: -1 };
  return { ...base, gate: fromLocal(base, gateU, halfV + GATE_OUT) };
}

/**
 * The airport: a runway along the far side, a taxiway beside it, the apron,
 * the terminal and the forecourt the gate opens on. The hangars stand at one
 * end of the apron and the fenced military compound at the other.
 */
function airportAt(id: number, site: Candidate, runway: number): Airfield {
  const halfU = runway / 2 + OVERRUN;
  const halfV = AIRPORT_HALF_V;
  const base = frame(id, 'airport', site, halfU, halfV, 0);
  const r = runway / 2;
  const apron = Math.min(260, r - 120);
  const military = -halfU + 20;
  const parts: AirfieldPart[] = [
    part('runway', -r, r, -halfV + 30, -halfV + 70),
    part('taxiway', -r + 40, r - 40, -45, -25),
    part('taxiway', -r + 30, -r + 50, -halfV + 60, -35),
    part('taxiway', r - 50, r - 30, -halfV + 60, -35),
    part('taxiway', -10, 10, -halfV + 60, -35),
    part('apron', -apron, apron, -25, 75),
    part('apron', military, military + 180, -25, 75),
    part('apron', apron, halfU - 20, -25, 75),
    part('pad', apron - 70, apron - 40, 10, 40),
    part('pad', apron - 130, apron - 100, 10, 40),
    part('terminal', -110, 110, 82, 112, 14),
    part('tower', 140, 154, 88, 102, 32),
    part('forecourt', -130, 130, 118, halfV),
    part('hangar', apron + 10, apron + 60, -5, 60, 16),
    part('hangar', apron + 75, apron + 125, -5, 60, 16),
    // The ground the military keeps behind its fence (spec section 14).
    part('compound', military, military + 180, -25, 78),
    part('fence', military, military + 180, 76, 78, 3),
    part('fence', military + 179, military + 181, -25, 78, 3),
    part('windsock', r - 20, r - 18, -halfV + 12, -halfV + 14, 7),
  ];
  const stands = [
    stand(base, 'bizjet', -apron + 60, 30, -Math.PI / 2),
    stand(base, 'plane-light', -apron + 130, 35, -Math.PI / 2),
    stand(base, 'biplane', -apron + 180, 35, -Math.PI / 2),
    stand(base, 'heli-light', apron - 115, 25, 0),
    stand(base, 'heli-transport', apron - 55, 25, 0),
    stand(base, 'heli-police', 40, 40, 0),
    stand(base, 'fighter', military + 50, 25, -Math.PI / 2, true),
    stand(base, 'heli-attack', military + 125, 25, 0, true),
  ];
  return { ...base, parts, stands };
}

/** A rural airstrip: a dirt runway, a windsock at one end and a shed at the other (spec section 8.4). */
function stripAt(id: number, site: Candidate, index: number): Airfield {
  const halfU = STRIP_RUNWAY / 2 + 30;
  const halfV = STRIP_HALF_V;
  const base = frame(id, 'airstrip', site, halfU, halfV, halfU - 40);
  const r = STRIP_RUNWAY / 2;
  const parts: AirfieldPart[] = [
    part('runway', -r, r, -11, 11),
    part('apron', halfU - 70, halfU - 10, 14, halfV),
    part('shed', halfU - 45, halfU - 20, 22, halfV - 1, 5),
    part('windsock', -r + 10, -r + 12, 16, 18, 6),
  ];
  const stands = [stand(base, index % 2 === 0 ? 'plane-light' : 'biplane', halfU - 58, 23, Math.PI)];
  return { ...base, parts, stands };
}

/** A ground helipad: the police heliport in the inner city, or the medical one in the suburbs. */
function padAt(id: number, site: Candidate, police: boolean): Airfield {
  const base = frame(id, 'heliport', site, PAD_HALF, PAD_HALF, 0);
  const parts: AirfieldPart[] = [
    part('apron', -PAD_HALF, PAD_HALF, -PAD_HALF, PAD_HALF),
    part('pad', -12, 12, -14, 10),
    part('shed', -PAD_HALF + 2, -PAD_HALF + 12, PAD_HALF - 8, PAD_HALF - 1, 4),
  ];
  const stands = [stand(base, police ? 'heli-police' : 'heli-light', 0, -2, 0)];
  return { ...base, parts, stands };
}

/**
 * The seaplane dock: a walkway from the shore out to deep water, with the
 * seaplane moored beside its end. It is the water nearest the airport that is
 * deep and open enough, off a shore the roads reach. It levels no ground and
 * claims none: the roads never go on the water anyway.
 */
function findDock(ground: SiteGround, airport: Airfield, taken: readonly Airfield[]): Airfield | undefined {
  const { hf, seaLevel } = ground;
  const n = hf.gridSize;
  // Every node deep enough, nearest the airport first: most of them fail the
  // later tests, and those are the dear ones, so they run in that order and
  // stop at the first that passes.
  const { deep, far } = deepNodes(ground, airport);
  const order = deep.map((_, i) => i).sort((a, b) => (far[a] as number) - (far[b] as number) || a - b);
  const clear = taken.map((field) => hypot(field.halfU, field.halfV) + LEVEL_BLEND + DOCK_REACH);
  for (const i of order) {
    const node = deep[i] as number;
    const x = hf.worldX(node % n);
    const y = hf.worldY(Math.floor(node / n));
    if (taken.some((field, k) => dist(field.x, field.y, x, y) < (clear[k] as number))) continue;
    if (!nearShore(hf, seaLevel, x, y) || !openWater(hf, seaLevel, x, y)) continue;
    const root = shoreNear(ground, x, y);
    if (root !== undefined) return dockAt(taken.length, seaLevel, root, { x, y });
  }
  return undefined;
}

/** Every grid node on the map deep enough for a dock, in grid order, with its distance from the airport. */
function deepNodes(ground: SiteGround, airport: Airfield): { deep: number[]; far: number[] } {
  const { hf, seaLevel } = ground;
  const n = hf.gridSize;
  const deep: number[] = [];
  const far: number[] = [];
  for (let iy = 0; iy < n; iy++) {
    const y = hf.worldY(iy);
    for (let ix = 0; ix < n; ix++) {
      const x = hf.worldX(ix);
      if (Math.abs(x) > ground.size / 2 - EDGE || Math.abs(y) > ground.size / 2 - EDGE) continue;
      if (seaLevel - hf.at(ix, iy) < DOCK_DEPTH) continue;
      deep.push(iy * n + ix);
      far.push(dist(x, y, airport.x, airport.y));
    }
  }
  return { deep, far };
}

/** The dock from a place on the shore out to its mooring. */
function dockAt(id: number, seaLevel: number, root: Point, mooring: Point): Airfield {
  const heading = atan2(mooring.y - root.y, mooring.x - root.x);
  const length = dist(root.x, root.y, mooring.x, mooring.y);
  const base = {
    id,
    kind: 'dock' as const,
    x: (mooring.x + root.x) / 2,
    y: (mooring.y + root.y) / 2,
    heading,
    halfU: length / 2 + 10,
    halfV: 10,
    level: seaLevel,
    road: -1,
    gate: root,
  };
  const parts: AirfieldPart[] = [part('deck', -length / 2 - 4, length / 2, -1.5, 1.5, 1)];
  const stands = [stand(base, 'seaplane', length / 2 - 4, -7, 0)];
  return { ...base, parts, stands };
}

/** Unit steps round a circle, worked out once: sixteen, and every other one of them for eight. */
const ROUND: readonly Point[] = Array.from({ length: 16 }, (_, k) => ({ x: cos((k * Math.PI) / 8), y: sin((k * Math.PI) / 8) }));

/** True where the water is deep all round a point, so a moored seaplane floats clear of the bottom. */
function openWater(hf: Heightfield, seaLevel: number, x: number, y: number): boolean {
  for (let k = 0; k < ROUND.length; k += 2) {
    const d = ROUND[k] as Point;
    if (seaLevel - hf.sample(x + d.x * DOCK_ROOM, y + d.y * DOCK_ROOM) < DOCK_DEPTH * 0.6) return false;
  }
  return true;
}

/** True where some dry ground stands within a walkway of a point: the cheap test before {@link shoreNear}. */
function nearShore(hf: Heightfield, seaLevel: number, x: number, y: number): boolean {
  for (const d of ROUND) {
    if (hf.sample(x + d.x * (DOCK_REACH - 5), y + d.y * (DOCK_REACH - 5)) >= seaLevel + 1) return true;
  }
  return false;
}

/** The nearest dry ground the roads reach within a walkway of a point, or undefined. */
function shoreNear(ground: SiteGround, x: number, y: number): Point | undefined {
  let best: Point | undefined;
  let bestD = DOCK_REACH;
  for (const d of ROUND) {
    for (let r = 10; r < bestD; r += 5) {
      const px = x + d.x * r;
      const py = y + d.y * r;
      if (ground.hf.sample(px, py) < ground.seaLevel + 1) continue;
      if (ground.land.reaches(px, py)) {
        best = { x: px, y: py };
        bestD = r;
      }
      break;
    }
  }
  return best;
}

// ----------------------------------------------------------------- levelling

/**
 * Level the ground under an airfield to its level, blending back into the
 * hillside over {@link LEVEL_BLEND} past the rectangle. The sites keep their
 * margins dry and apart, so no blend reaches the water or another airfield.
 */
function levelAirfield(hf: Heightfield, field: Airfield): void {
  const reach = hypot(field.halfU, field.halfV) + LEVEL_BLEND;
  const c = cos(field.heading);
  const s = sin(field.heading);
  const i0 = Math.max(0, Math.floor((field.x - reach - hf.originX) / hf.cellSize));
  const i1 = Math.min(hf.gridSize - 1, Math.ceil((field.x + reach - hf.originX) / hf.cellSize));
  const j0 = Math.max(0, Math.floor((field.y - reach - hf.originY) / hf.cellSize));
  const j1 = Math.min(hf.gridSize - 1, Math.ceil((field.y + reach - hf.originY) / hf.cellSize));
  for (let j = j0; j <= j1; j++) {
    const dy = hf.worldY(j) - field.y;
    for (let i = i0; i <= i1; i++) {
      const dx = hf.worldX(i) - field.x;
      const u = Math.abs(dx * c + dy * s) - field.halfU;
      const v = Math.abs(-dx * s + dy * c) - field.halfV;
      const out = hypot(Math.max(0, u), Math.max(0, v));
      if (out >= LEVEL_BLEND) continue;
      const t = smoothstep(0, LEVEL_BLEND, out);
      const h = hf.at(i, j);
      hf.set(i, j, field.level + (h - field.level) * t);
    }
  }
}
