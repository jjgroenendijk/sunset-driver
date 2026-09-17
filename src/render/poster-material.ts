/**
 * The material the harm-reduction posters are drawn with (spec section 19).
 *
 * One material and one texture for a whole world. The texture is the atlas
 * `poster-art.ts` draws in code, uploaded once; every board samples its own
 * cell of it through the texture coordinates `poster-mesh.ts` writes, so the
 * posters of a chunk are one batch however many designs they carry.
 *
 * No mipmaps. The atlas is a row of cells with no gutter between them, and a
 * mipmap of it mixes one poster into the next along the seam. A board is small
 * on screen and fades out with the rest of the street furniture, so the sharper
 * sampling is the cheaper trade.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about
 * shader nodes.
 */
import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { posterAtlas } from './poster-art.ts';
import { texture, uv } from './tsl.ts';

/** The posters of one world: one material, and the texture every chunk shares. */
export interface PosterMaterials {
  poster: MeshStandardNodeMaterial;
  dispose(): void;
}

export function createPosterMaterials(): PosterMaterials {
  const atlas = posterAtlas();
  const map = new DataTexture(atlas.data, atlas.width, atlas.height, RGBAFormat, UnsignedByteType);
  // The atlas is drawn in the colours a poster is printed in, so it is read as
  // sRGB and not as the working space the renderer computes in.
  map.colorSpace = SRGBColorSpace;
  map.generateMipmaps = false;
  map.minFilter = LinearFilter;
  map.magFilter = LinearFilter;
  map.needsUpdate = true;
  // Paper: it takes the light of the street and throws none of its own.
  const poster = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.9 });
  poster.colorNode = texture(map).sample(uv());
  return {
    poster,
    dispose(): void {
      poster.dispose();
      map.dispose();
    },
  };
}
