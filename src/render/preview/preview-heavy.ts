/**
 * The heavy weapons for `render-preview.ts --heavy` (spec section 11.6): a
 * flamethrower's stream, a rocket in the air, a grenade going off and a smoke
 * grenade's cloud, laid into the record as `gunfire.ts` would have written
 * them, so `weapon-fx.ts` draws them the way it does in play.
 */
import type { SimState } from '../../sim/simulation.ts';
import { MUZZLE_HEIGHT, MUZZLE_REACH, weaponOf } from '../../sim/weapons/weapon.ts';

/** Metres the stream reaches, and the ticks of it laid down. */
const STREAM_REACH = 11;
const STREAM_TICKS = 36;

/** What `--heavy` may show: all of it, or one weapon alone. */
export type HeavyShow = 'all' | 'flame' | 'rocket' | 'blast' | 'smoke';

/** Lay the heavy weapons into the record, around a player standing at `stand`. */
export function heavyFire(
  record: SimState,
  stand: { x: number; y: number; heading: number },
  groundAt: (x: number, y: number) => number,
  tick: number,
  show: HeavyShow = 'all',
): void {
  const shows = (what: HeavyShow): boolean => show === 'all' || show === what;
  const { x, y, heading } = stand;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const h = groundAt(x, y) + MUZZLE_HEIGHT;
  const mx = x + cos * MUZZLE_REACH;
  const my = y + sin * MUZZLE_REACH;
  // The flamethrower cycles at 600 a minute, so a tongue every sixth tick.
  for (let t = tick - STREAM_TICKS; shows('flame') && t <= tick; t += 6) {
    for (let pellet = 0; pellet < 3; pellet++) {
      const yaw = heading + (pellet - 1) * 0.08 + Math.sin(t * 0.3) * 0.04;
      record.tracers.push({
        tick: t,
        pellet,
        x: mx,
        y: my,
        h,
        ex: mx + Math.cos(yaw) * STREAM_REACH,
        ey: my + Math.sin(yaw) * STREAM_REACH,
        eh: h - 0.6,
        end: pellet === 1 ? 'hard' : 'none',
        by: 'player',
        flame: true,
      });
    }
  }
  // A rocket twenty metres out to the left, flying away from the player.
  const speed = weaponOf('rpg-7').projectile?.speed ?? 80;
  const rx = x + cos * 20 - sin * 8;
  const ry = y + sin * 20 + cos * 8;
  if (shows('rocket')) record.projectiles.push({
    weapon: 'rpg-7',
    x: rx,
    y: ry,
    h: groundAt(rx, ry) + 2,
    vx: cos * speed,
    vy: sin * speed,
    vh: 0,
    thrownTick: tick - 30,
  });
  // A grenade that went off a tenth of a second ago, out to the right.
  const bx = x + cos * 14 + sin * 9;
  const by = y + sin * 14 - cos * 9;
  if (shows('blast')) record.blasts.push({ tick: tick - 6, x: bx, y: by, h: groundAt(bx, by) + 0.2, weapon: 'grenade', radius: 8 });
  // And a smoke grenade pouring out behind, for three seconds now.
  const sx = x - cos * 16 + sin * 6;
  const sy = y - sin * 16 - cos * 6;
  if (shows('smoke')) record.blasts.push({ tick: tick - 180, x: sx, y: sy, h: groundAt(sx, sy) + 0.1, weapon: 'smoke-grenade', radius: 6 });
}
