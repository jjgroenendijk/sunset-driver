/**
 * What a police officer on foot looks like (spec section 14): the patrol in
 * navy with a navy cap, SWAT in black with a grey helmet. The crowd mesh draws
 * them, so a uniform is a {@link PedestrianLook} and a flag.
 *
 * The flag is the fourth value of the instance's `pedMotion`, which the crowd
 * leaves at zero. `pedestrian-material.ts` paints the tops of a patrol
 * officer's shoulders hi-vis where it reads 1, which is what makes them police
 * from a camera looking down on the street.
 */
import { genRng, Subsystem } from '../../core/rng.ts';
import { SKIN_TONES } from '../../sim/player/character.ts';
import type { Officer, OfficerKind } from '../../sim/police/officer.ts';
import type { PedestrianLook } from '../../sim/crowd/pedestrian-look.ts';
import type { StandingPerson } from '../people/pedestrians.ts';

/** The value of `pedMotion.w` each kind is drawn with. Zero is anybody else. */
export const UNIFORM_FLAG: Readonly<Record<OfficerKind, number>> = Object.freeze({ patrol: 1, swat: 2 });

/** The colours of each uniform: the cap or the helmet, the top and the trousers. */
const UNIFORMS: Readonly<Record<OfficerKind, { hair: number; top: number; legs: number }>> = Object.freeze({
  patrol: { hair: 0x141d33, top: 0x1d2c4f, legs: 0x172036 },
  swat: { hair: 0x55595d, top: 0x141516, legs: 0x1b1c1e },
});

/** The look of officer `id`: their own face and height, in their kind's uniform. */
export function officerLook(seed: number, id: number, kind: OfficerKind): PedestrianLook {
  const rng = genRng(seed, Subsystem.Officers, id);
  const skin = (SKIN_TONES[rng.int(0, SKIN_TONES.length - 1)] as { colour: number }).colour;
  const uniform = UNIFORMS[kind];
  return {
    skin,
    hair: uniform.hair,
    top: uniform.top,
    legs: uniform.legs,
    height: rng.range(1.74, 1.9),
    gait: 'brisk',
    speed: 1.45,
  };
}

/**
 * An officer as the crowd mesh draws them, in their uniform: arms out in the
 * `aim` gait with their gun out, else running, walking or standing by pace.
 */
export function officerPerson(officer: Officer, look: PedestrianLook): StandingPerson {
  return {
    look,
    uniform: UNIFORM_FLAG[officer.kind],
    pose: {
      x: officer.x,
      y: officer.y,
      height: officer.height,
      heading: officer.heading,
      speed: officer.speed,
      cycle: officer.cycle,
      gait: officerGait(officer),
    },
  };
}

/** The gait an officer is drawn in: aiming, else by pace. */
function officerGait(officer: Officer): StandingPerson['pose']['gait'] {
  if (officer.aiming) return 'aim';
  if (officer.speed > 2.5) return 'run';
  return officer.speed > 0 ? 'brisk' : 'stand';
}
