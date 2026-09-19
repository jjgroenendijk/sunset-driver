/**
 * The Rapier half of the arsenal (spec section 11.6): what a shot, a swing and
 * a thrown thing do to the world.
 *
 * `weapon.ts` holds the model and decides whether the weapon fires; this casts
 * the ray per pellet, sweeps the melee arc and carries everything in the air a
 * tick at a time. `physics.ts` owns the world and hands in what can be hit: the
 * player's vehicle, the police cars of spec section 14, the faction enforcers
 * of spec section 17.2 and the cars of the city, which a hit promotes (spec
 * section 5.3).
 */
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { crowdFeelsBlast, crowdHearsShot } from './crowd-reaction.ts';
import { callAmbulance } from './emergency.ts';
import { damageVehicle, disableEngine, ignite } from './damage.ts';
import { unrotate } from './frame.ts';
import { aimYaw } from './aim.ts';
import type { InputFrame } from './input.ts';
import { hurt, SKIN, vehicleGap } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import type { PromotedVehicle } from './traffic.ts';
import { specOf, type VehicleSpec, type VehicleState } from './vehicle.ts';
import { blastEnforcers, hurtEnforcer } from './enforcer.ts';
import { blastOfficers, hurtOfficer } from './officer.ts';
import { PERSON_CAPSULE } from './person-bodies.ts';
import { blastUnits, report, shootUnit } from './police.ts';
import { blowStrength, forgetHits, markHit, SWING_HEIGHT, type CrowdSource, type HitSurface } from './melee.ts';
import type { PedestrianPose } from './pedestrians.ts';
import { hurtPerson, type CasualtyGround } from './casualty.ts';
import { SHUNS_RAGDOLL } from './collision-groups.ts';
import { peopleNear, personOnRay } from './crowd-contact.ts';
import { forgetTracers, markTracer, type TracerEnd } from './tracer.ts';
import {
  blastFalloff,
  bounceProjectile,
  projectileDue,
  roundSeverity,
  VEHICLE_SHARE_PER_POINT,
  stepProjectile,
  stepWeapons,
  swingReaches,
  weaponOf,
  type ProjectileState,
  type ShotRay,
  type WeaponSpec,
} from './weapon.ts';

/** What a shot may hit, and whose body it may not. */
export interface ShotTarget {
  /** The roster row of the vehicle, which is what the damage is read against. */
  spec: VehicleSpec;
  /** The vehicle's collider, and undefined while it carries none. */
  body: RAPIER.Collider | undefined;
  /**
   * The shooter's own collider, left out of every cast: a driver firing from a
   * seat would otherwise shoot their own door, and a player on foot their own
   * chest.
   */
  shooter: RAPIER.Collider | undefined;
  /**
   * The police cars standing in the world (spec section 14), which is how a
   * round that went into one finds the unit it hit. A ground with no police
   * leaves it out.
   */
  police?: { unitAt(handle: number): number | undefined };
  /**
   * The faction enforcers standing in the world (spec section 17.2), which is
   * how a round that went into one finds the person it hit. A ground with no
   * factions leaves it out.
   */
  enforcers?: { unitAt(handle: number): number | undefined };
  /**
   * The police officers on foot standing in the world (spec section 14), for
   * the same reason. A ground with no police leaves it out.
   */
  officers?: { unitAt(handle: number): number | undefined };
  /**
   * The crowd of spec section 13.1, so a swing can reach the people on the
   * pavement. They walk loops rather than stand in the physics world, so they
   * are found off the loop and never by a cast. A ground with no crowd leaves
   * it out and the street is empty.
   */
  crowd?: CrowdSource;
  /**
   * How far a person a hit pushes can be carried before a wall stops them, and
   * how high the ground is where they land (`casualty.ts`). A ground with no
   * physics leaves it out.
   */
  ground?: CasualtyGround;
  /**
   * The cars of the city standing in the world (spec section 13.1): the traffic
   * and the parked. A hit promotes the car it met (spec section 5.3) and
   * answers its record, which the damage is then written into. A ground with no
   * roads leaves it out.
   */
  cars?: {
    strike(state: SimState, collider: number): PromotedVehicle | undefined;
    strikeNear(state: SimState, x: number, h: number, y: number, radius: number): void;
  };
}

/**
 * Rays one swing fans through its arc to find the world it met. One down the
 * middle and one to each edge is enough for a lamp post at arm's length, and it
 * is three casts rather than a shape sweep, which Rapier would charge far more
 * for on every punch.
 */
export const SWING_RAYS: number = 3;

/**
 * Metres of a person's width a swing counts as reach, so a blow is measured to
 * somebody's body rather than to the line down their middle.
 */
export const PERSON_RADIUS = 0.3;


/** Metres per second a round or a blow knocks a person back at, from the damage it does. */
export function shotPush(damage: number): number {
  return Math.min(3.5, 0.8 + damage * 0.03);
}

/** The casts and the flights of one session. It owns no state but its scratch. */
export class Gunfire {
  private readonly world: RAPIER.World;
  /** Scratch vectors, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly from = { x: 0, y: 0, z: 0 };
  private readonly along = { x: 0, y: 0, z: 0 };
  /** The one ray every shot and every projectile step is cast with. */
  private readonly ray: RAPIER.Ray;
  /** Reused by the swing that looks for the crowd, so a punch allocates nothing. */
  private readonly ids: number[] = [];
  /** Metres the last {@link Gunfire.scan} carried before it stopped. */
  private reach = 0;
  private readonly pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };

  constructor(world: RAPIER.World) {
    this.world = world;
    this.ray = new RAPIER.Ray(this.from, this.along);
  }

  /**
   * Fire the weapon in the player's hands for a tick (spec section 11.6).
   *
   * The rules are in `weapon.ts` and this is the Rapier half of them: a gun
   * casts a ray per pellet, a melee weapon sweeps its arc, and a thrown weapon
   * or a launcher puts something in the air for {@link Gunfire.fly} to carry.
   * Nothing here decides whether the weapon fires; `stepWeapons` does, and it
   * also raises the heat a shot is worth (spec section 14).
   *
   * The player's vehicle, the police cars of spec section 14, the faction
   * enforcers of spec section 17.2 and the cars of the city can be hit.
   */
  step(state: SimState, input: InputFrame, target: ShotTarget): void {
    // A blow is remembered for a few ticks and no longer: what reads one has
    // had every frame of those ticks to see it (`melee.ts`).
    forgetHits(state.hits, state.tick);
    forgetTracers(state.tracers, state.tick);
    const yaw = aimYaw(state, input);
    const shot = stepWeapons(state.loadout, input, state.player, state.seed, state.tick, yaw);
    if (shot === undefined) return;
    // A player on foot turns square to the aim as the shot goes, so a swing
    // sweeps toward the pointer and the body is drawn facing the shot.
    if (yaw !== undefined && !state.player.driving) state.player.heading = yaw;
    report(state, shot.heat);
    // A gun going off clears the pavement around the player (spec section
    // 20.1). A swing is quiet, so only the loud weapons are heard.
    if (shot.spec.cls !== 'melee' && target.crowd !== undefined) {
      crowdHearsShot(state, target.crowd, state.player.x, state.player.y, this.ids);
    }
    // Somebody calls a shooting in, and an ambulance comes (spec section 20.3).
    // Every round of one firefight is the one call, so the service is not
    // emptied over a street it is already on its way to.
    if (shot.spec.cls !== 'melee') callAmbulance(state, state.player.x, state.player.y);
    if (shot.projectile !== undefined) {
      state.projectiles.push(shot.projectile);
      return;
    }
    if (shot.spec.cls === 'melee') {
      this.swing(state, shot.spec, target);
      return;
    }
    for (let i = 0; i < shot.rays.length; i++) {
      const ray = shot.rays[i] as ShotRay;
      const end = this.scan(state, shot.spec, ray, shot.range, target);
      const reach = this.reach;
      markTracer(state.tracers, {
        tick: state.tick,
        pellet: i,
        x: ray.x,
        y: ray.y,
        h: ray.h,
        ex: ray.x + ray.dx * reach,
        ey: ray.y + ray.dy * reach,
        eh: ray.h + ray.dh * reach,
        end,
        by: 'player',
      });
    }
  }

  /**
   * One pellet, cast against the world. The shooter's own body is left out of
   * the cast: a driver firing from a seat would otherwise shoot their own door,
   * and a player on foot their own chest. It answers what the round met and
   * leaves how far it carried in {@link Gunfire.reach}.
   */
  private scan(state: SimState, spec: WeaponSpec, ray: ShotRay, range: number, target: ShotTarget): TracerEnd {
    this.from.x = ray.x;
    this.from.y = ray.h;
    this.from.z = ray.y;
    this.along.x = ray.dx;
    this.along.y = ray.dh;
    this.along.z = ray.dy;
    const mine = target.shooter;
    const hit = this.world.castRay(this.ray, range, true, undefined, SHUNS_RAGDOLL, mine);
    this.reach = hit === null ? range : hit.timeOfImpact;
    // The people on the pavement stand in no physics, so the round is measured
    // against them up to whatever solid thing it met (spec section 13.1).
    if (this.shootPerson(state, spec, ray, target)) return 'person';
    if (hit === null) return 'none';
    // A round that went into a police car is taken off that car (spec section
    // 14), and shooting at officers is what it costs the player.
    const unit = target.police?.unitAt(hit.collider.handle);
    if (unit !== undefined) {
      shootUnit(state, unit, roundSeverity(spec) * VEHICLE_SHARE_PER_POINT);
      return 'vehicle';
    }
    // A round that went into an enforcer is taken off them, on the health scale
    // people are measured in rather than the share a panel takes (spec section
    // 17.2). Enough of them puts the wave down.
    const enforcer = target.enforcers?.unitAt(hit.collider.handle);
    if (enforcer !== undefined) {
      hurtEnforcer(state, enforcer, spec.damage);
      return 'person';
    }
    // A round that went into an officer on foot is taken off them the same way,
    // and they fall the way it was flying.
    const officer = target.officers?.unitAt(hit.collider.handle);
    if (officer !== undefined) {
      hurtOfficer(state, officer, spec.damage, atan2(ray.dy, ray.dx), target.ground);
      return 'person';
    }
    // The round pushes the vehicle the way it was flying, which is the direction
    // the panel rule reads, exactly as a crash pushes it away from the wall.
    if (target.body !== undefined && hit.collider.handle === target.body.handle) {
      this.hit(state, spec, state.vehicle, target.spec, ray.dx, ray.dh, ray.dy, roundSeverity(spec));
      return 'vehicle';
    }
    // A round that went into a car of the city takes it off its tour (spec
    // section 5.3) and is taken off the car.
    const car = target.cars?.strike(state, hit.collider.handle)?.vehicle;
    if (car === undefined) return 'hard';
    this.hit(state, spec, car, specOf(car.cls), ray.dx, ray.dh, ray.dy, roundSeverity(spec));
    return 'vehicle';
  }

  /**
   * The person of the crowd a round meets before {@link Gunfire.reach}, if
   * anybody, and the round taken off them. It stops in them: a round that has
   * gone through somebody is not followed any further.
   */
  private shootPerson(state: SimState, spec: WeaponSpec, ray: ShotRay, target: ShotTarget): boolean {
    const crowd = target.crowd;
    if (crowd === undefined) return false;
    const peds = state.pedestrians;
    const met = personOnRay(crowd, peds, state.tick, ray.x, ray.h, ray.y, ray.dx, ray.dh, ray.dy, this.reach, this.ids);
    if (met === undefined) return false;
    this.reach = met.t;
    const blow = { cause: 'shot' as const, damage: spec.damage, dir: atan2(ray.dy, ray.dx), push: shotPush(spec.damage), lift: 0 };
    hurtPerson(state, crowd, met.id, met, blow, target.ground);
    return true;
  }

  /**
   * One swing of a melee weapon (spec section 11.6). A swing is an arc rather
   * than a line, so it is a reach and a half-angle and not a ray: whatever
   * stands inside it is hit, which is everybody and not one thing. Nobody
   * swings at the vehicle they are sitting in.
   *
   * Four things can be met, and a blow may meet several at once. The enforcers
   * of spec section 17.2 and the crowd of spec section 13.1 are swept off the
   * record rather than out of the world, because an arc is not a cast: so a bat
   * reaches an enforcer who has just walked into the physics box, and a person
   * on the pavement, who stands in no physics at all. The player's own vehicle
   * is measured to its panels as a round is. Everything else — a police car, a
   * parked car, the traffic, a kerb — is what the fan of rays finds.
   *
   * Every blow that lands is written into the record by {@link land}, which is
   * what the burst and the knock are drawn and played from.
   */
  private swing(state: SimState, spec: WeaponSpec, target: ShotTarget): void {
    const p = state.player;
    if (p.driving) return;
    const h = p.height + SWING_HEIGHT;
    let met = false;
    // The list is copied because one put down is taken out of it.
    for (const unit of [...state.enforcers.units]) {
      const dx = unit.x - p.x;
      const dy = unit.y - p.y;
      // The reach is measured to their body rather than to the line down their
      // middle, exactly as the vehicle's is measured to its panels.
      const gap = Math.max(0, hypot(dx, dy) - PERSON_CAPSULE.radius);
      if (!swingReaches(spec, p.heading, gap, atan2(dy, dx))) continue;
      hurtEnforcer(state, unit.id, spec.damage);
      this.land(state, spec, 'person', unit.x, unit.y, unit.height + SWING_HEIGHT);
      met = true;
    }
    // The officers on foot are swept the same way, and fall away from the blow.
    for (const officer of [...state.police.officers]) {
      const dx = officer.x - p.x;
      const dy = officer.y - p.y;
      const gap = Math.max(0, hypot(dx, dy) - PERSON_CAPSULE.radius);
      const bearing = atan2(dy, dx);
      if (!swingReaches(spec, p.heading, gap, bearing)) continue;
      hurtOfficer(state, officer.id, spec.damage, bearing, target.ground);
      this.land(state, spec, 'person', officer.x, officer.y, officer.height + SWING_HEIGHT);
      met = true;
    }
    if (this.strike(state, spec, target)) met = true;
    const v = state.vehicle;
    const bearing = atan2(v.z - p.y, v.x - p.x);
    if (swingReaches(spec, p.heading, vehicleGap(p, v, target.spec), bearing)) {
      this.hit(state, spec, v, target.spec, cos(bearing), 0, sin(bearing), roundSeverity(spec));
      this.land(state, spec, 'vehicle', v.x, v.z, v.y);
      met = true;
    }
    this.sweep(state, spec, h, target, met);
  }

  /**
   * The person of the crowd a swing reaches, if any (spec section 13.1). They
   * walk a loop rather than stand in the world, so the nearest of the loops
   * passing through the reach is read at the tick and measured against the arc.
   *
   * A blow puts them to flight and it is a brawl, which the police weigh (spec
   * section 14). Somebody already in flight is left alone: they are drawn from
   * their own record rather than from their loop, so the loop no longer says
   * where they are.
   */
  private strike(state: SimState, spec: WeaponSpec, target: ShotTarget): boolean {
    const crowd = target.crowd;
    if (crowd === undefined) return false;
    const p = state.player;
    const reach = spec.reach + PERSON_RADIUS;
    let nearest: { id: number; x: number; y: number; height: number; heading: number } | undefined;
    let closest = Infinity;
    peopleNear(crowd, state.pedestrians, state.tick, p.x, p.y, reach, (id, pose) => {
      const dx = pose.x - p.x;
      const dy = pose.y - p.y;
      const gap = Math.max(0, hypot(dx, dy) - PERSON_RADIUS);
      if (gap >= closest) return;
      if (!swingReaches(spec, p.heading, gap, atan2(dy, dx))) return;
      closest = gap;
      nearest = { id, x: pose.x, y: pose.y, height: pose.height, heading: pose.heading };
    }, this.ids);
    const struck = nearest as { id: number; x: number; y: number; height: number; heading: number } | undefined;
    if (struck === undefined) return false;
    const dir = atan2(struck.y - p.y, struck.x - p.x);
    const blow = { cause: 'blow' as const, damage: spec.damage, dir, push: shotPush(spec.damage), lift: 0 };
    if (hurtPerson(state, crowd, struck.id, struck, blow, target.ground) === undefined) return false;
    this.land(state, spec, 'person', struck.x, struck.y, struck.height + SWING_HEIGHT);
    return true;
  }

  /**
   * The world a swing met: a police car, a car of the city, a kerb.
   * These stand in the physics world, so the arc is fanned into
   * {@link SWING_RAYS} rays and the nearest thing any of them met is what was
   * struck. `met` says the swing has already landed on something the record
   * knows, in which case only a police car is worth taking further: the rest
   * would be the ground behind a body that has already been hit.
   */
  private sweep(state: SimState, spec: WeaponSpec, h: number, target: ShotTarget, met: boolean): void {
    const p = state.player;
    const mine = target.shooter;
    let nearest: RAPIER.RayColliderHit | null = null;
    let angle = 0;
    for (let i = 0; i < SWING_RAYS; i++) {
      const turn = SWING_RAYS === 1 ? 0 : (2 * i) / (SWING_RAYS - 1) - 1;
      const yaw = p.heading + turn * spec.arc;
      this.from.x = p.x;
      this.from.y = h;
      this.from.z = p.y;
      this.along.x = cos(yaw);
      this.along.y = 0;
      this.along.z = sin(yaw);
      const hit = this.world.castRay(this.ray, spec.reach, true, undefined, SHUNS_RAGDOLL, mine);
      if (hit === null || (nearest !== null && hit.timeOfImpact >= nearest.timeOfImpact)) continue;
      nearest = hit;
      angle = yaw;
    }
    if (nearest === null) return;
    const handle = nearest.collider.handle;
    // An enforcer and an officer have already been swept off the record, and
    // so has the player's own vehicle: none is hit twice for one swing.
    if (target.enforcers?.unitAt(handle) !== undefined) return;
    if (target.officers?.unitAt(handle) !== undefined) return;
    if (target.body !== undefined && handle === target.body.handle) return;
    const at = nearest.timeOfImpact;
    const x = p.x + cos(angle) * at;
    const y = p.y + sin(angle) * at;
    const unit = target.police?.unitAt(handle);
    if (unit !== undefined) {
      // What a blow takes off a police car is what a round of the same weapon
      // would take off the player's own (spec section 14), and swinging at
      // officers costs the player what shooting at them does. `scan` scales the
      // same share a second time, which is #405 and not this.
      shootUnit(state, unit, roundSeverity(spec));
      this.land(state, spec, 'vehicle', x, y, h);
      return;
    }
    if (met) return;
    // A car of the city is taken off its tour or out of its bay by the blow
    // (spec section 5.3), and takes the dent.
    const car = target.cars?.strike(state, handle)?.vehicle;
    if (car === undefined) {
      this.land(state, spec, 'hard', x, y, h);
      return;
    }
    this.hit(state, spec, car, specOf(car.cls), cos(angle), 0, sin(angle), roundSeverity(spec));
    this.land(state, spec, 'vehicle', x, y, h);
  }

  /** Write one landed blow into the record, for the burst and the knock to read. */
  private land(state: SimState, spec: WeaponSpec, surface: HitSurface, x: number, y: number, h: number): void {
    markHit(state.hits, { tick: state.tick, x, y, h, surface, strength: blowStrength(spec) });
  }

  /**
   * Put one hit into a vehicle: the dent, what it costs the vehicle, and what
   * the round does beyond that. The direction comes in world axes and is read in
   * the vehicle's own frame, so the panel that takes it is the panel that was
   * facing the shot. `row` is the roster row of the vehicle `v`.
   */
  private hit(
    state: SimState,
    spec: WeaponSpec,
    v: VehicleState,
    row: VehicleSpec,
    dx: number,
    dh: number,
    dy: number,
    severity: number,
  ): void {
    unrotate(this.point, v, dx, dh, dy);
    // `unrotate` answers the vehicle's own axes: `x` along it, `y` up and `z`
    // across it, which is the order the panel rule reads them in.
    damageVehicle(
      v.damage,
      row,
      severity,
      this.point.x,
      this.point.z,
      this.point.y,
      state.seed,
      state.tick,
      state.loadout.shots,
    );
    if (spec.effect === 'fire') ignite(v.damage, state.tick);
    if (spec.effect === 'engine') disableEngine(v.damage);
  }

  /**
   * Carry everything in the air one tick further (spec section 11.6).
   *
   * A step is a straight line between two places, so what the step ran into is
   * a ray over it. A thing that goes off on impact goes off there; anything else
   * bounces and carries on until its fuse burns through. The thrower's own body
   * is left out, so a grenade does not go off in the hand that threw it.
   */
  fly(state: SimState, target: ShotTarget): void {
    const live = state.projectiles;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i] as ProjectileState;
      const flight = weaponOf(p.weapon).projectile;
      if (flight === undefined) {
        live.splice(i, 1);
        continue;
      }
      this.from.x = p.x;
      this.from.y = p.h;
      this.from.z = p.y;
      stepProjectile(p);
      const dx = p.x - this.from.x;
      const dh = p.h - this.from.y;
      const dy = p.y - this.from.z;
      const step = hypot(dx, dh, dy);
      if (step > 0) {
        this.along.x = dx / step;
        this.along.y = dh / step;
        this.along.z = dy / step;
        const mine = target.shooter;
        const hit = this.world.castRayAndGetNormal(this.ray, step, true, undefined, SHUNS_RAGDOLL, mine);
        if (hit !== null) {
          // A thing that meets a car of the city takes it off its tour, whether
          // it goes off there or bounces away (spec section 5.3).
          target.cars?.strike(state, hit.collider.handle);
          // Stand it on the surface it met rather than inside it, so the next
          // step starts outside the ground and not under it.
          p.x = this.from.x + this.along.x * hit.timeOfImpact + hit.normal.x * SKIN;
          p.h = this.from.y + this.along.y * hit.timeOfImpact + hit.normal.y * SKIN;
          p.y = this.from.z + this.along.z * hit.timeOfImpact + hit.normal.z * SKIN;
          if (flight.burstOnImpact) {
            this.burst(state, p, target);
            live.splice(i, 1);
            continue;
          }
          bounceProjectile(p, hit.normal.x, hit.normal.y, hit.normal.z);
        }
      }
      if (!projectileDue(p, state.tick)) continue;
      this.burst(state, p, target);
      live.splice(i, 1);
    }
  }

  /**
   * Set off one projectile where it stands (spec section 11.6). A blast is felt
   * over its radius and falls away to nothing at the edge of it; a Molotov sets
   * what it lands on alight, which is the fire that spreads of spec section
   * 11.3. Smoke and tear gas leave a cloud that nothing reads yet: it is the
   * pedestrians and the police of spec sections 13.1 and 14 that will.
   */
  private burst(state: SimState, p: ProjectileState, target: ShotTarget): void {
    const spec = weaponOf(p.weapon);
    const flight = spec.projectile;
    if (flight === undefined || spec.effect === 'smoke') return;
    // Heard well past the ring it is felt in, so the street empties around it
    // (spec section 20.1).
    if (target.crowd !== undefined) {
      crowdFeelsBlast(state, target.crowd, p.x, p.y, flight.blastRadius, this.ids);
      this.blastPeople(state, spec, p, flight.blastRadius, target);
    }
    // A blast is called in as well as heard (spec section 20.3).
    callAmbulance(state, p.x, p.y);
    const player = state.player;
    const reach = blastFalloff(hypot(player.x - p.x, player.y - p.y, player.height - p.h), flight.blastRadius);
    if (reach > 0) hurt(player, spec.damage * reach);
    const v = state.vehicle;
    const dx = v.x - p.x;
    const dh = v.y - p.h;
    const dy = v.z - p.y;
    const distance = hypot(dx, dh, dy);
    // A blast is felt by every police car inside it, wherever the player's own
    // car stands (spec section 14).
    blastUnits(state, p.x, p.y, roundSeverity(spec) * VEHICLE_SHARE_PER_POINT, (gap) => blastFalloff(gap, flight.blastRadius));
    // And by every enforcer inside it, who feel it as people rather than as
    // panels (spec section 17.2).
    blastEnforcers(state, p.x, p.y, spec.damage, (gap) => blastFalloff(gap, flight.blastRadius));
    blastOfficers(state, p.x, p.y, spec.damage, (gap) => blastFalloff(gap, flight.blastRadius));
    this.blast(state, spec, v, specOf(v.cls), dx, dh, dy, distance, flight.blastRadius);
    // Every car of the city inside it is taken off its tour, and then feels it
    // as the player's own car does.
    target.cars?.strikeNear(state, p.x, p.h, p.y, flight.blastRadius);
    for (const record of state.traffic.promoted) {
      const car = record.vehicle;
      const cx = car.x - p.x;
      const ch = car.y - p.h;
      const cy = car.z - p.y;
      this.blast(state, spec, car, specOf(car.cls), cx, ch, cy, hypot(cx, ch, cy), flight.blastRadius);
    }
  }

  /**
   * What a blast does to the people round it (spec section 13.1): each is hurt
   * by the share of it they feel, and thrown away from it, off their feet
   * where they were near.
   */
  private blastPeople(state: SimState, spec: WeaponSpec, p: ProjectileState, radius: number, target: ShotTarget): void {
    const crowd = target.crowd;
    if (crowd === undefined) return;
    const hit: { id: number; x: number; y: number; height: number; heading: number; share: number }[] = [];
    peopleNear(crowd, state.pedestrians, state.tick, p.x, p.y, radius, (id, pose) => {
      const share = blastFalloff(hypot(pose.x - p.x, pose.y - p.y, pose.height + 1 - p.h), radius);
      if (share > 0) hit.push({ id, x: pose.x, y: pose.y, height: pose.height, heading: pose.heading, share });
    }, this.ids);
    for (const person of hit) {
      const dir = atan2(person.y - p.y, person.x - p.x);
      const lift = person.share > 0.3 ? 5 * person.share : 0;
      const blow = { cause: 'blast' as const, damage: spec.damage * person.share, dir, push: 1 + 7 * person.share, lift };
      hurtPerson(state, crowd, person.id, person, blow, target.ground);
    }
  }

  /** What a blast does to one vehicle standing `distance` from it, along `(dx, dh, dy)`. */
  private blast(
    state: SimState,
    spec: WeaponSpec,
    v: VehicleState,
    row: VehicleSpec,
    dx: number,
    dh: number,
    dy: number,
    distance: number,
    radius: number,
  ): void {
    const share = blastFalloff(distance, radius);
    if (share === 0) return;
    const length = Math.max(distance, 1e-6);
    this.hit(state, spec, v, row, dx / length, dh / length, dy / length, roundSeverity(spec) * share);
  }

}
