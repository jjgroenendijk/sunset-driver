/**
 * The material the advertising of spec section 13.1 is drawn with.
 *
 * One material and one texture for a whole world. The texture is the atlas
 * `sign-art.ts` draws in code, uploaded once; every board samples its own cell
 * of it through the texture coordinates `sign-mesh.ts` writes, so the signs of
 * a chunk are one batch however many trades and cultures they carry.
 *
 * The neon is the printed colours themselves, burning. A lit board's emission
 * is what the board already shows — bright letters on a dark fascia — scaled by
 * how far into the night it is, so the letters glow and the board behind them
 * stays dark. Which boards light and which are paint is the `neon` attribute,
 * and a failing tube's own place in its cycle is `flicker`: both are per vertex,
 * because a batch has merged a chunk's boards into one mesh by the time this
 * runs. The light such a board throws on its street is `signs.ts`, and only a
 * few boards get one.
 *
 * No mipmaps, for the reason `poster-material.ts` gives: the atlas is a grid of
 * cells with no gutter, and a mipmap of it mixes one board into the next along
 * the seam.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about shader
 * nodes.
 */
import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { signAtlas } from './sign-art.ts';
import { attribute, float, fract, mix, step, texture, time, uniform, uv } from './tsl.ts';

/** How hard a lit board burns when the neon is full on. */
const NEON_GLOW = 3;

/** Cycles a second a failing tube stutters at, and the share of each cycle it is out for. */
const FLICKER_RATE = 2.7;
const FLICKER_BLINK = 0.14;

/** How much of its light a failing tube keeps while it is out. Never nothing: a dead tube is not a flicker. */
const FLICKER_LOW = 0.15;

/** The signs of one world: one material, and the switch every chunk shares. */
export interface SignMaterials {
  sign: MeshStandardNodeMaterial;
  /** How far on the neon is, 0 by day and 1 after dark. */
  neon: { value: number };
  dispose(): void;
}

export function createSignMaterials(): SignMaterials {
  const atlas = signAtlas();
  const map = new DataTexture(atlas.data, atlas.width, atlas.height, RGBAFormat, UnsignedByteType);
  // The atlas is drawn in the colours a board is painted in, so it is read as
  // sRGB and not as the working space the renderer computes in.
  map.colorSpace = SRGBColorSpace;
  map.generateMipmaps = false;
  map.minFilter = LinearFilter;
  map.magFilter = LinearFilter;
  map.needsUpdate = true;
  const neon = uniform(0);
  // Painted board: it takes the light of the street, and what it throws back is
  // the emission below and nothing else.
  const sign = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.8 });
  const paint = texture(map).sample(uv());
  sign.colorNode = paint;
  sign.emissiveNode = paint.rgb.mul(attribute('neon', 'float')).mul(neon).mul(flicker()).mul(float(NEON_GLOW));
  return {
    sign,
    neon,
    dispose(): void {
      sign.dispose();
      map.dispose();
    },
  };
}

/**
 * How much of its light a board is throwing this instant: 1 for a sound tube,
 * and a stutter for one that has failed. The phase is the sign's own, so the
 * street does not blink in unison.
 */
function flicker(): ReturnType<typeof float> {
  const phase = attribute('flicker', 'float');
  // A sound tube carries phase 0, which is the one value `sign-mesh.ts` never
  // gives a failing one.
  const fails = step(float(1 / 1024), phase);
  const beat = fract(time.mul(float(FLICKER_RATE)).add(phase));
  const blink = mix(float(FLICKER_LOW), float(1), step(float(FLICKER_BLINK), beat));
  return mix(float(1), blink, fails);
}
