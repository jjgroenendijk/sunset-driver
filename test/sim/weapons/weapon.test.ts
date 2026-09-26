import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { createPlayerState, type PlayerState } from '../../../src/sim/player/on-foot.ts';
import {
  addAmmo,
  AIM_TIGHTEN,
  AMMO_CAP,
  ARSENAL,
  beginReload,
  blastFalloff,
  bounceProjectile,
  BOUNCE,
  CALIBRES,
  createLoadout,
  currentSlot,
  currentWeapon,
  cycleWeapon,
  firesFromVehicle,
  giveWeapon,
  heatPerShot,
  MAX_RECOIL,
  poolOf,
  projectileDue,
  RECOIL_RECOVERY,
  RECOIL_SETTLE,
  reloading,
  roundSeverity,
  selectWeapon,
  shotInterval,
  SPARE_MAGAZINES,
  spreadOf,
  stepProjectile,
  stepWeapons,
  swingReaches,
  WEAPON_CLASSES,
  WEAPON_IDS,
  weaponOf,
  type LoadoutState,
  type Shot,
  type WeaponId,
} from '../../../src/sim/weapons/weapon.ts';
import { sweepSeeds } from '../../support/helpers.ts';

/**
 * The arsenal and the firing model of spec section 11.6, played headless. The
 * rules are pure, so what the spec asks of them is checked here rather than
 * through a Rapier world: `sim-sweep.test.ts` is where a shot is fired into one.
 */
const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 24 : 6);

/** A player standing still, on foot, at the origin facing along the map's `+x`. */
function standing(): PlayerState {
  const player = createPlayerState();
  player.driving = false;
  return player;
}

/** The trigger down, and whatever else the test is pressing. */
function pressing(keys: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, ...keys };
}

/**
 * Pull the trigger once at a tick: the key goes down and comes up again, so a
 * weapon that fires on the edge fires exactly once.
 */
function pull(loadout: LoadoutState, player: PlayerState, seed: number, tick: number): Shot | undefined {
  const shot = stepWeapons(loadout, pressing({ fire: true }), player, seed, tick);
  stepWeapons(loadout, EMPTY_INPUT, player, seed, tick);
  return shot;
}

/** Hold the trigger down for `ticks` ticks and answer every shot it got off. */
function hold(loadout: LoadoutState, player: PlayerState, seed: number, from: number, ticks: number): Shot[] {
  const shots: Shot[] = [];
  for (let tick = from; tick < from + ticks; tick++) {
    const shot = stepWeapons(loadout, pressing({ fire: true }), player, seed, tick);
    if (shot !== undefined) shots.push(shot);
  }
  return shots;
}

type Spec = ReturnType<typeof weaponOf>;

/** The first thing wrong with a melee weapon's entry in the table, or '' when nothing is. */
function meleeComplaint(spec: Spec): string {
  const id = spec.id;
  let complaint = '';
  if (spec.calibre !== undefined) complaint ||= `${id} is melee and takes ${spec.calibre}`;
  if (spec.capacity !== 0) complaint ||= `${id} is melee and holds ${spec.capacity}`;
  if (spec.reach <= 0 || spec.arc <= 0) complaint ||= `${id} swings at nothing`;
  return complaint;
}

/** The first thing wrong with a fired weapon's calibre and pool, or '' when nothing is. */
function firedComplaint(spec: Spec): string {
  const id = spec.id;
  let complaint = '';
  if (spec.calibre === undefined) complaint ||= `${id} fires nothing`;
  else if (!CALIBRES.includes(spec.calibre)) complaint ||= `${id} takes an unlisted ${spec.calibre}`;
  else if (AMMO_CAP[spec.calibre] < spec.capacity) complaint ||= `${id} holds more than ${spec.calibre} allows`;
  if (spec.capacity <= 0) complaint ||= `${id} has no magazine`;
  if (spec.reloadTicks <= 0) complaint ||= `${id} reloads in no time`;
  if (spec.rpm <= 0) complaint ||= `${id} cycles at no rate`;
  if (spec.damage < 0) complaint ||= `${id} heals what it hits`;
  if (spec.projectile === undefined && spec.range <= 0) complaint ||= `${id} carries nowhere`;
  if (spec.projectile !== undefined && spec.projectile.blastRadius <= 0) complaint ||= `${id} bursts over nothing`;
  return complaint;
}

/** What is wrong with what a shot threw for the weapon that fired it, or '' when nothing is. */
function shotComplaint(spec: Spec, shot: Shot): string {
  const id = spec.id;
  if (spec.cls === 'melee') return shot.rays.length !== 0 || shot.projectile !== undefined ? `${id} swung a bullet` : '';
  if (spec.projectile !== undefined) return shot.projectile === undefined ? `${id} threw nothing` : '';
  return shot.rays.length === spec.pellets ? '' : `${id} threw ${shot.rays.length} of ${spec.pellets} pellets`;
}

describe('the arsenal', () => {
  it('lists every weapon once, in a class the spec names', () => {
    expect(WEAPON_IDS).toHaveLength(Object.keys(ARSENAL).length);
    const seen = new Set<string>();
    let complaint = '';
    for (const id of WEAPON_IDS) {
      const spec = weaponOf(id);
      if (spec.id !== id) complaint ||= `${id} carries the id ${spec.id}`;
      if (seen.has(spec.name)) complaint ||= `${spec.name} is listed twice`;
      seen.add(spec.name);
      if (!WEAPON_CLASSES.includes(spec.cls)) complaint ||= `${id} is in no class`;
    }
    expect(complaint, complaint).toBe('');
    // Every class of the spec's table has a weapon in it.
    for (const cls of WEAPON_CLASSES) {
      expect(WEAPON_IDS.some((id) => weaponOf(id).cls === cls), cls).toBe(true);
    }
  });

  it('gives every fired weapon a calibre with a pool, and every melee weapon neither', () => {
    let complaint = '';
    for (const id of WEAPON_IDS) {
      const spec = weaponOf(id);
      complaint ||= spec.cls === 'melee' ? meleeComplaint(spec) : firedComplaint(spec);
    }
    expect(complaint, complaint).toBe('');
  });

  it('cycles at the rate of fire the table gives it', () => {
    // A weapon of 600 rounds a minute is 10 a second, which is a shot every six
    // ticks of the simulation's 60 Hz.
    expect(shotInterval(weaponOf('ak-47'))).toBe(6);
    let complaint = '';
    for (const id of WEAPON_IDS) {
      const spec = weaponOf(id);
      const ticks = shotInterval(spec);
      if (ticks < 1) complaint ||= `${id} fires more than once a tick`;
      if (Math.abs(ticks - (60 * TICK_RATE) / spec.rpm) > 0.5) complaint ||= `${id} cycles off its own rate`;
    }
    expect(complaint, complaint).toBe('');
  });

  it('only a pistol or an SMG is any use from a seat', () => {
    for (const id of WEAPON_IDS) {
      const spec = weaponOf(id);
      expect(firesFromVehicle(spec), id).toBe(spec.cls === 'pistol' || spec.cls === 'smg');
    }
  });

  it('draws no attention with melee, and less with a concealed weapon than a long gun', () => {
    expect(heatPerShot(weaponOf('baseball-bat'))).toBe(0);
    expect(heatPerShot(weaponOf('glock-17'))).toBeGreaterThan(0);
    expect(heatPerShot(weaponOf('ak-47'))).toBeGreaterThan(heatPerShot(weaponOf('glock-17')));
  });

  it('costs a car more with a shotgun than with a pistol, and most with a rocket', () => {
    const pistol = roundSeverity(weaponOf('glock-17'));
    const shotgun = roundSeverity(weaponOf('remington-870')) * weaponOf('remington-870').pellets;
    const rocket = roundSeverity(weaponOf('rpg-7'));
    expect(shotgun).toBeGreaterThan(pistol);
    expect(rocket).toBeGreaterThan(shotgun);
    // A whole blast is worth a real share of a car, and a pistol round is not.
    expect(shotgun).toBeGreaterThan(0.2);
    expect(pistol).toBeLessThan(0.02);
  });
});

describe('what the player carries', () => {
  it('starts with fists and nothing else', () => {
    const loadout = createLoadout();
    expect(currentWeapon(loadout).id).toBe('fists');
    expect(loadout.slots).toHaveLength(1);
    for (const calibre of CALIBRES) expect(loadout.ammo[calibre], calibre).toBe(0);
  });

  it('fires every weapon of the arsenal from the picker', () => {
    // The done-when of the issue: a weapon handed out by the debug picker fires.
    let complaint = '';
    for (const id of WEAPON_IDS) {
      const loadout = createLoadout();
      const player = standing();
      giveWeapon(loadout, id);
      const spec = weaponOf(id);
      if (currentWeapon(loadout).id !== id) complaint ||= `${id} was not put in the hands`;
      if (spec.capacity > 0 && currentSlot(loadout).loaded !== spec.capacity) complaint ||= `${id} came empty`;
      const shot = pull(loadout, player, 0x51a, 1_000);
      if (shot === undefined) {
        complaint ||= `${id} did not fire`;
        continue;
      }
      if (shot.spec.id !== id) complaint ||= `${id} fired as ${shot.spec.id}`;
      complaint ||= shotComplaint(spec, shot);
    }
    expect(complaint, complaint).toBe('');
  });

  it('shares a calibre between every weapon that takes it', () => {
    const loadout = createLoadout();
    const player = standing();
    giveWeapon(loadout, 'glock-17');
    const glock = weaponOf('glock-17');
    const beretta = weaponOf('beretta-92fs');
    expect(glock.calibre).toBe(beretta.calibre);
    const pool = poolOf(loadout, glock);
    expect(pool).toBe(glock.capacity * SPARE_MAGAZINES);

    // Empty the Glock's magazine, then reload it out of the shared pool.
    let tick = 5_000;
    for (let i = 0; i < glock.capacity; i++) {
      expect(pull(loadout, player, 0x51a, tick), `shot ${i}`).toBeDefined();
      tick += shotInterval(glock);
    }
    expect(currentSlot(loadout).loaded).toBe(0);
    expect(beginReload(loadout, tick)).toBe(true);
    stepWeapons(loadout, EMPTY_INPUT, player, 0x51a, tick + glock.reloadTicks);
    expect(currentSlot(loadout).loaded).toBe(glock.capacity);
    expect(poolOf(loadout, glock)).toBe(pool - glock.capacity);

    // The Beretta, given with nothing of its own spare, draws on what is left of
    // the same 9×19: it comes loaded, is emptied, and fills from that pool.
    giveWeapon(loadout, 'beretta-92fs', 0);
    const shared = poolOf(loadout, beretta);
    tick += glock.reloadTicks + 1;
    for (let i = 0; i < beretta.capacity; i++) {
      expect(pull(loadout, player, 0x51a, tick), `beretta shot ${i}`).toBeDefined();
      tick += shotInterval(beretta);
    }
    expect(beginReload(loadout, tick)).toBe(true);
    stepWeapons(loadout, EMPTY_INPUT, player, 0x51a, tick + beretta.reloadTicks);
    expect(currentSlot(loadout).loaded).toBe(beretta.capacity);
    expect(poolOf(loadout, beretta)).toBe(shared - beretta.capacity);
  });

  it('carries only so much of a calibre', () => {
    const loadout = createLoadout();
    const cap = AMMO_CAP['9×19'];
    expect(addAmmo(loadout, '9×19', cap + 100)).toBe(cap);
    expect(loadout.ammo['9×19']).toBe(cap);
    expect(addAmmo(loadout, '9×19', 10)).toBe(0);
  });

  it('walks the weapons carried, and wraps round both ways', () => {
    const loadout = createLoadout();
    giveWeapon(loadout, 'glock-17');
    giveWeapon(loadout, 'ak-47');
    expect(currentWeapon(loadout).id).toBe('ak-47');
    cycleWeapon(loadout, 1);
    expect(currentWeapon(loadout).id).toBe('fists');
    cycleWeapon(loadout, -1);
    expect(currentWeapon(loadout).id).toBe('ak-47');
    cycleWeapon(loadout, -1);
    expect(currentWeapon(loadout).id).toBe('glock-17');
    expect(selectWeapon(loadout, 'fists')).toBe(true);
    expect(selectWeapon(loadout, 'katana')).toBe(false);
    expect(currentWeapon(loadout).id).toBe('fists');
  });
});

describe('firing', () => {
  it('holds an automatic weapon to its rate of fire, and fires a semi-automatic once a press', () => {
    const player = standing();
    const auto = createLoadout();
    giveWeapon(auto, 'mp5', 10);
    const mp5 = weaponOf('mp5');
    const ticks = 60;
    const shots = hold(auto, player, 0x51a, 2_000, ticks);
    // A magazine of 30 at 800 rounds a minute is gone in well under a second.
    expect(shots).toHaveLength(Math.min(mp5.capacity, Math.floor((ticks - 1) / shotInterval(mp5)) + 1));

    const semi = createLoadout();
    giveWeapon(semi, 'colt-m1911');
    expect(hold(semi, player, 0x51a, 2_000, ticks)).toHaveLength(1);
  });

  it('spends a round on a shot and nothing on a swing', () => {
    const player = standing();
    const gun = createLoadout();
    giveWeapon(gun, 'ak-47');
    const loaded = currentSlot(gun).loaded;
    expect(pull(gun, player, 0x51a, 3_000)).toBeDefined();
    expect(currentSlot(gun).loaded).toBe(loaded - 1);

    const bat = createLoadout();
    giveWeapon(bat, 'baseball-bat');
    const swing = pull(bat, player, 0x51a, 3_000);
    expect(swing?.heat).toBe(0);
    expect(currentSlot(bat).loaded).toBe(0);
    for (const calibre of CALIBRES) expect(bat.ammo[calibre], calibre).toBe(0);
  });

  it('starts a reload when the trigger is pulled on an empty magazine', () => {
    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'sawn-off');
    const spec = weaponOf('sawn-off');
    let tick = 4_000;
    for (let i = 0; i < spec.capacity; i++) {
      expect(pull(loadout, player, 0x51a, tick), `shell ${i}`).toBeDefined();
      tick += shotInterval(spec);
    }
    expect(pull(loadout, player, 0x51a, tick)).toBeUndefined();
    expect(reloading(loadout)).toBe(true);
    // The reload takes exactly what the table says, and the shot before it lands
    // is refused.
    for (let i = 1; i < spec.reloadTicks; i++) {
      expect(pull(loadout, player, 0x51a, tick + i), `tick ${i}`).toBeUndefined();
    }
    const shot = pull(loadout, player, 0x51a, tick + spec.reloadTicks);
    expect(shot).toBeDefined();
    expect(currentSlot(loadout).loaded).toBe(spec.capacity - 1);
  });

  it('refuses a reload with nothing to reload', () => {
    const loadout = createLoadout();
    // Fists: nothing to reload at all.
    expect(beginReload(loadout, 0)).toBe(false);
    giveWeapon(loadout, 'mp5', 0);
    // A full magazine and an empty pool: there is nowhere for a round to come from.
    expect(beginReload(loadout, 0)).toBe(false);
    const player = standing();
    expect(pull(loadout, player, 0x51a, 100)).toBeDefined();
    expect(beginReload(loadout, 101)).toBe(false);
    addAmmo(loadout, '9×19', 5);
    expect(beginReload(loadout, 101)).toBe(true);
    expect(beginReload(loadout, 101)).toBe(false);
    stepWeapons(loadout, EMPTY_INPUT, player, 0x51a, 101 + weaponOf('mp5').reloadTicks);
    // A pool shorter than the magazine fills what it can.
    expect(currentSlot(loadout).loaded).toBe(weaponOf('mp5').capacity);
    expect(poolOf(loadout, weaponOf('mp5'))).toBe(4);
  });

  it('drops the reload when the weapon is swapped', () => {
    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'ak-47');
    expect(pull(loadout, player, 0x51a, 500)).toBeDefined();
    expect(beginReload(loadout, 501)).toBe(true);
    stepWeapons(loadout, pressing({ cycle: 1 }), player, 0x51a, 502);
    expect(reloading(loadout)).toBe(false);
    expect(currentWeapon(loadout).id).not.toBe('ak-47');
  });

  it('refuses everything but a pistol or an SMG from a seat', () => {
    const driver = createPlayerState();
    expect(driver.driving).toBe(true);
    const loadout = createLoadout();
    giveWeapon(loadout, 'ak-47');
    expect(pull(loadout, driver, 0x51a, 700)).toBeUndefined();
    giveWeapon(loadout, 'uzi');
    expect(pull(loadout, driver, 0x51a, 700)).toBeDefined();
  });

  it('aims tighter than it hip fires, and recoil widens the shot after', () => {
    const spec = weaponOf('m4a1');
    expect(spreadOf(spec, true, 0)).toBeCloseTo(spec.spread * AIM_TIGHTEN);
    expect(spreadOf(spec, true, 0)).toBeLessThan(spreadOf(spec, false, 0));
    expect(spreadOf(spec, false, 0.05)).toBeGreaterThan(spreadOf(spec, false, 0));

    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'm249');
    const shots = hold(loadout, player, 0x51a, 8_000, 40);
    const built = loadout.recoil;
    // The muzzle climbs while the trigger is held: a burst sprays wider than its
    // first round did.
    expect(shots.length).toBeGreaterThan(1);
    expect(built).toBeGreaterThan(0);
    expect(built).toBeLessThanOrEqual(MAX_RECOIL);

    // Nothing comes back while the shooting is still fresh.
    const last = loadout.firedTick;
    for (let tick = 8_040; tick < last + RECOIL_SETTLE; tick++) {
      stepWeapons(loadout, EMPTY_INPUT, player, 0x51a, tick);
    }
    expect(loadout.recoil).toBe(built);
    // Then it settles at its own rate, until there is nothing left of it.
    stepWeapons(loadout, EMPTY_INPUT, player, 0x51a, last + RECOIL_SETTLE);
    expect(loadout.recoil).toBeCloseTo(built - RECOIL_RECOVERY / TICK_RATE, 6);
    for (let tick = last + RECOIL_SETTLE + 1; tick < last + 200; tick++) {
      stepWeapons(loadout, EMPTY_INPUT, player, 0x51a, tick);
    }
    expect(loadout.recoil).toBe(0);
  });

  it('throws the same pellets for the same seed and tick, and different ones at another tick', () => {
    const player = standing();
    let complaint = '';
    for (const seed of SEEDS) {
      const first = createLoadout();
      const second = createLoadout();
      giveWeapon(first, 'spas-12');
      giveWeapon(second, 'spas-12');
      const a = pull(first, player, seed, 9_000);
      const b = pull(second, player, seed, 9_000);
      if (JSON.stringify(a?.rays) !== JSON.stringify(b?.rays)) complaint ||= `seed ${seed} threw two patterns`;
      const c = pull(first, player, seed, 9_000 + shotInterval(weaponOf('spas-12')));
      if (JSON.stringify(a?.rays) === JSON.stringify(c?.rays)) complaint ||= `seed ${seed} threw one pattern twice`;
      // Every pellet leaves within the cone, as a unit direction.
      for (const ray of a?.rays ?? []) {
        const length = Math.hypot(ray.dx, ray.dy, ray.dh);
        if (Math.abs(length - 1) > 1e-9) complaint ||= `seed ${seed} threw a pellet of length ${length}`;
        const cone = spreadOf(weaponOf('spas-12'), false, 0);
        const yaw = Math.abs(Math.atan2(ray.dy, ray.dx) - player.heading);
        if (yaw > cone + 1e-9) complaint ||= `seed ${seed} threw a pellet ${yaw} off the aim`;
      }
    }
    expect(complaint, complaint).toBe('');
  });
});

describe('melee arcs', () => {
  it('reaches what stands in front and nothing behind', () => {
    const bat = weaponOf('baseball-bat');
    // Straight ahead and within reach.
    expect(swingReaches(bat, 0, bat.reach - 0.1, 0)).toBe(true);
    // Within reach, and at the edge of the arc.
    expect(swingReaches(bat, 0, 0.5, bat.arc - 0.01)).toBe(true);
    expect(swingReaches(bat, 0, 0.5, bat.arc + 0.01)).toBe(false);
    // Behind the player, whichever way round the angle is written.
    expect(swingReaches(bat, 0, 0.5, Math.PI)).toBe(false);
    expect(swingReaches(bat, Math.PI, 0.5, 0)).toBe(false);
    // Too far away.
    expect(swingReaches(bat, 0, bat.reach + 0.01, 0)).toBe(false);
    // The arc wraps: facing just past -π and swinging at just under π is ahead.
    expect(swingReaches(bat, -Math.PI + 0.05, 0.5, Math.PI - 0.05)).toBe(true);
  });

  it('reaches further with a katana than with fists', () => {
    expect(weaponOf('katana').reach).toBeGreaterThan(weaponOf('fists').reach);
  });
});

describe('thrown things', () => {
  it('leaves the hand on the line it was thrown and falls', () => {
    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'grenade');
    const shot = pull(loadout, player, 0x51a, 6_000);
    const p = shot?.projectile;
    expect(p).toBeDefined();
    if (p === undefined) return;
    expect(p.weapon).toBe('grenade');
    expect(p.vh).toBeGreaterThan(0);
    const rising = p.vh;
    stepProjectile(p);
    expect(p.vh).toBeLessThan(rising);
    expect(p.x).toBeGreaterThan(0);
    // It is still climbing on the first tick, so it is higher than it started.
    expect(p.h).toBeGreaterThan(player.height);
  });

  it('goes off on its fuse, and a Molotov waits for what it lands on', () => {
    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'grenade');
    const fuse = weaponOf('grenade').projectile?.fuse as number;
    const grenade = pull(loadout, player, 0x51a, 7_000)?.projectile;
    expect(grenade).toBeDefined();
    if (grenade === undefined) return;
    expect(projectileDue(grenade, 7_000 + fuse - 1)).toBe(false);
    expect(projectileDue(grenade, 7_000 + fuse)).toBe(true);

    giveWeapon(loadout, 'molotov');
    const molotov = pull(loadout, player, 0x51a, 7_100)?.projectile;
    expect(molotov).toBeDefined();
    if (molotov === undefined) return;
    expect(weaponOf('molotov').projectile?.burstOnImpact).toBe(true);
    // No fuse, so only an impact or the end of its life sets it off.
    expect(projectileDue(molotov, 7_100 + 500)).toBe(false);
    expect(projectileDue(molotov, 7_100 + 600)).toBe(true);
  });

  it('flies a rocket flat and a grenade in an arc', () => {
    const player = standing();
    const launcher = createLoadout();
    giveWeapon(launcher, 'rpg-7');
    const rocket = pull(launcher, player, 0x51a, 6_500)?.projectile;
    expect(rocket).toBeDefined();
    if (rocket === undefined) return;
    const level = rocket.vh;
    stepProjectile(rocket);
    // Gravity is nothing to a rocket: it holds the line it was launched on.
    expect(rocket.vh).toBe(level);
    expect(Math.hypot(rocket.vx, rocket.vy)).toBeCloseTo(weaponOf('rpg-7').projectile?.speed as number, 3);
  });

  it('loses most of its speed on a bounce', () => {
    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'grenade');
    const p = pull(loadout, player, 0x51a, 6_700)?.projectile;
    expect(p).toBeDefined();
    if (p === undefined) return;
    p.vh = -10;
    const across = Math.hypot(p.vx, p.vy);
    bounceProjectile(p, 0, 1, 0);
    // It comes back up off the ground, at a fraction of the speed it came down.
    expect(p.vh).toBeGreaterThan(0);
    expect(p.vh).toBeLessThan(10 * BOUNCE + 1e-9);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(across);
  });

  it('falls away to nothing at the edge of a blast', () => {
    expect(blastFalloff(0, 8)).toBe(1);
    expect(blastFalloff(8, 8)).toBe(0);
    expect(blastFalloff(20, 8)).toBe(0);
    expect(blastFalloff(4, 8)).toBeGreaterThan(0);
    expect(blastFalloff(6, 8)).toBeLessThan(blastFalloff(4, 8));
  });
});

describe('the record', () => {
  it('survives a round trip through JSON, mid-reload and mid-flight', () => {
    const player = standing();
    const loadout = createLoadout();
    giveWeapon(loadout, 'ak-47');
    pull(loadout, player, 0x51a, 400);
    beginReload(loadout, 401);
    const projectiles = [pull(createLoadoutWith('grenade'), player, 0x51a, 402)?.projectile];
    const copy = JSON.parse(JSON.stringify({ loadout, projectiles })) as {
      loadout: LoadoutState;
      projectiles: unknown[];
    };
    expect(copy.loadout).toEqual(loadout);
    expect(copy.projectiles).toEqual(projectiles);
  });
});

/** A loadout holding one weapon, loaded. */
function createLoadoutWith(id: WeaponId): LoadoutState {
  const loadout = createLoadout();
  giveWeapon(loadout, id);
  return loadout;
}
