import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../../../src/sim/input.ts';
import { createPlayerState } from '../../../src/sim/player/on-foot.ts';
import {
  ALERT_RADIUS,
  alertRadius,
  ATTACHMENTS,
  createLoadout,
  currentSlot,
  currentWeapon,
  EXTENDED_MAG,
  fitAttachment,
  fits,
  fitsOf,
  fitted,
  FOREGRIP_RECOIL,
  giveWeapon,
  heatPerShot,
  LASER_HIP,
  normaliseAttachments,
  OPTIC_RANGE,
  poolOf,
  rangeOf,
  removeAttachment,
  showsLongGun,
  spreadOf,
  stepWeapons,
  SUPPRESSED_ALERT_RADIUS,
  WEAPON_IDS,
  weaponOf,
} from '../../../src/sim/weapons/weapon.ts';

/**
 * The attachments of spec section 11.6: what each one does to the numbers of
 * the weapon it is fitted to, and which weapons take which.
 */
describe('attachments', () => {
  it('fits nothing to melee, thrown or launcher weapons, and something to every gun of a magazine', () => {
    let complaint = '';
    for (const id of WEAPON_IDS) {
      const spec = weaponOf(id);
      const list = fitsOf(spec);
      const bare = spec.cls === 'melee' || spec.cls === 'thrown' || spec.projectile !== undefined || id === 'flamethrower';
      if (bare && list.length > 0) complaint ||= `${id} takes ${list.join(', ')}`;
      if (!bare && list.length === 0) complaint ||= `${id} takes nothing`;
      // A list is kept in the one order, so a save reads the same however it was fitted.
      if (list.join() !== ATTACHMENTS.filter((a) => list.includes(a)).join()) complaint ||= `${id} lists out of order`;
    }
    expect(complaint, complaint).toBe('');
    // The spec calls the precision rifles scoped, so they take no second optic.
    expect(fits(weaponOf('remington-700'), 'optic')).toBe(false);
    expect(fits(weaponOf('model-29'), 'suppressor')).toBe(false);
  });

  it('changes the one number each attachment is for', () => {
    const m4 = weaponOf('m4a1');
    const bare = fitted(m4, []);
    expect(bare).toBe(m4);

    const suppressed = fitted(m4, ['suppressor']);
    expect(heatPerShot(suppressed)).toBeLessThan(heatPerShot(m4));
    expect(alertRadius(m4)).toBe(ALERT_RADIUS);
    expect(alertRadius(suppressed)).toBe(SUPPRESSED_ALERT_RADIUS);

    expect(fitted(m4, ['extended-mag']).capacity).toBe(Math.round(m4.capacity * EXTENDED_MAG));

    const optic = fitted(m4, ['optic']);
    expect(rangeOf(optic, true)).toBeCloseTo(m4.range * OPTIC_RANGE);
    expect(rangeOf(optic, false)).toBe(m4.range);

    const laser = fitted(m4, ['laser']);
    expect(spreadOf(laser, false, 0)).toBeCloseTo(m4.spread * LASER_HIP);
    expect(spreadOf(laser, true, 0)).toBe(spreadOf(m4, true, 0));

    expect(fitted(m4, ['foregrip']).recoil).toBeCloseTo(m4.recoil * FOREGRIP_RECOIL);

    // Everything fitted at once is every change at once, and the row is shared.
    const all = fitted(m4, ['foregrip', 'laser', 'optic', 'extended-mag', 'suppressor']);
    expect(all.suppressed && all.sight > 1 && all.hipSpread < 1).toBe(true);
    expect(fitted(m4, [...ATTACHMENTS])).toBe(all);
    // The arsenal's own row is never written to.
    expect(weaponOf('m4a1').capacity).toBe(30);
  });

  it('ignores an attachment a weapon does not take', () => {
    const revolver = weaponOf('model-29');
    expect(fitted(revolver, ['suppressor', 'extended-mag'])).toBe(revolver);
    expect(normaliseAttachments(revolver, ['laser', 'suppressor', 'laser', 'nonsense'])).toEqual(['laser']);
  });
});

describe('fitting a carried weapon', () => {
  it('fires the fitted numbers from the hands', () => {
    const loadout = createLoadout();
    giveWeapon(loadout, 'mp5');
    expect(fitAttachment(loadout, 'mp5', 'extended-mag')).toBe(true);
    expect(fitAttachment(loadout, 'mp5', 'extended-mag')).toBe(true);
    expect(currentSlot(loadout).attachments).toEqual(['extended-mag']);
    expect(currentWeapon(loadout).capacity).toBe(45);
    // The larger magazine is filled by the reload, from the shared pool.
    const pool = poolOf(loadout, currentWeapon(loadout));
    loadout.reloadTick = -1;
    stepWeapons(loadout, { ...EMPTY_INPUT, reload: true }, createPlayerState(), 1, 10);
    stepWeapons(loadout, EMPTY_INPUT, createPlayerState(), 1, 10 + currentWeapon(loadout).reloadTicks);
    expect(currentSlot(loadout).loaded).toBe(45);
    expect(poolOf(loadout, currentWeapon(loadout))).toBe(pool - 15);

    // Taking the magazine off puts the rounds it held past thirty back.
    expect(removeAttachment(loadout, 'mp5', 'extended-mag')).toBe(true);
    expect(currentSlot(loadout).loaded).toBe(30);
    expect(poolOf(loadout, currentWeapon(loadout))).toBe(pool);
    expect(removeAttachment(loadout, 'mp5', 'extended-mag')).toBe(false);
  });

  it('refuses a weapon not carried, or an attachment it does not take', () => {
    const loadout = createLoadout();
    expect(fitAttachment(loadout, 'ak-47', 'optic')).toBe(false);
    giveWeapon(loadout, 'sawn-off');
    expect(fitAttachment(loadout, 'sawn-off', 'optic')).toBe(false);
    expect(currentSlot(loadout).attachments).toEqual([]);
  });

  it('shows a long gun on foot and hides a pistol', () => {
    const loadout = createLoadout();
    const player = createPlayerState();
    player.driving = false;
    giveWeapon(loadout, 'glock-17');
    expect(showsLongGun(loadout, player)).toBe(false);
    giveWeapon(loadout, 'remington-870');
    expect(showsLongGun(loadout, player)).toBe(true);
    player.driving = true;
    expect(showsLongGun(loadout, player)).toBe(false);
  });
});
