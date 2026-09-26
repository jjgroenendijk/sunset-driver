/**
 * What burns on a vehicle after dark (spec sections 10.5, 13.4).
 *
 * A vehicle's lamps are boxes like the rest of it (`vehicle-mesh.ts`), so what
 * makes one a lamp is the colour it is painted: {@link LAMP} at the nose,
 * {@link TAIL} at the tail. This file is the one place that reads that, and the
 * one place that says how hard each burns.
 *
 * The traffic and the police draw every vehicle's trim — the glass, the lamps
 * and the tyres — as one instanced mesh with the colour on the vertices, so a
 * lamp cannot be a material of its own. A `glow` attribute carries how hard
 * each vertex burns instead, and one uniform says how far on the lamps are; a
 * lamp is emissive by night and plain paint by day, and the whole traffic
 * switches together off that one number, with no shader rebuilt at dusk.
 *
 * The glow is the lamp seen, not the light thrown. The beams on the road are
 * the projector cones of `headlights.ts`, which only the player's vehicle gets:
 * a light is paid for by every fragment it reaches, and the light budget of
 * spec section 10.5 has no room for two per car in view. From a camera 60 m up
 * a lit lens is what reads anyway, which is the same bargain `lamps.ts` strikes
 * for the street lamps.
 *
 * An indicator ({@link INDICATOR}) is not a lamp of the night: it flashes by
 * day as well. Its vertices carry a `flash` of 1 on the right of the vehicle
 * and -1 on the left, and each vehicle of the traffic an instanced `signal`
 * that says which side is lit this frame (`sim/traffic/indicator.ts`). Where
 * the two agree the amber burns, so one mesh flashes each car on its own side.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { INDICATOR, LAMP, SPARK, TAIL } from './vehicle-mesh.ts';
import { attribute, max, uniform } from '../tsl.ts';

/**
 * How hard a headlamp and a tail light burn at full night, as a multiple of
 * the colour they are painted. A headlamp is near white and a tail light a dark
 * red, so the tail takes the larger multiple to read as lit at all.
 */
export const HEAD_GLOW = 6;
export const TAIL_GLOW = 9;
/** How hard a lit indicator burns, by day or night. */
const INDICATOR_GLOW = 5;
/** How hard the arc at a tram's pantograph burns. It is a spark, so it burns harder than a lamp. */
const SPARK_GLOW = 14;

/** How hard the vertices of a box painted `colour` burn, and 0 on everything else. */
export function glowOf(colour: number): number {
  if (colour === LAMP) return HEAD_GLOW;
  if (colour === TAIL) return TAIL_GLOW;
  if (colour === SPARK) return SPARK_GLOW;
  return 0;
}

/**
 * The `flash` of the vertices of a box painted `colour` and standing `z`
 * across the vehicle: the side of an indicator, 1 right and -1 left, and 0 on
 * everything else.
 */
export function flashOf(colour: number, z: number): number {
  return colour === INDICATOR ? Math.sign(z) : 0;
}

/** The trim of a whole traffic: one material, and the switch every vehicle in it shares. */
export interface VehicleTrim {
  material: MeshStandardNodeMaterial;
  /** How far on the lamps are, 0 by day and 1 after dark. */
  lamps: { value: number };
  dispose(): void;
}

/**
 * The material the glass, lamps and tyres of an instanced vehicle are drawn
 * with. The colour is on the vertices, as it was before; what is new is that
 * the vertices of a lamp also carry a `glow`, and that glow times the switch is
 * the emissive. With `indicators` the vertices must also carry a `flash` and
 * the mesh an instanced `signal`, and a lit indicator adds its own burn.
 */
export function createVehicleTrim(indicators = false): VehicleTrim {
  const lamps = uniform(0);
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
  const colour = attribute('color', 'vec3');
  const night = colour.mul(attribute('glow', 'float')).mul(lamps);
  // flash times signal is 1 only where the lit side is this indicator's side.
  const lit = max(0, attribute('flash', 'float').mul(attribute('signal', 'float')));
  material.emissiveNode = indicators ? night.add(colour.mul(lit).mul(INDICATOR_GLOW)) : night;
  return {
    material,
    lamps,
    dispose(): void {
      material.dispose();
    },
  };
}
