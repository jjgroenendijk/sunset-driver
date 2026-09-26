/**
 * What the water's mirror draws (spec sections 7.2, 9.2).
 *
 * The mirror of `water-surface.ts` is a second pass over the scene, and the
 * dearest single thing a frame with water in view pays for: it drew the whole
 * city again, for about a quarter of the render slice of spec section 2.4.
 *
 * It does not have to. The camera of spec section 10.7 looks down from a few
 * tens of metres, so the water fills the middle of the frame at a steep angle,
 * where a surface gives back two per cent of what falls on it. The mirror is
 * read at the grazing edges of the sheet, and what a grazing eye sees in water
 * is the sky and whatever stands tall behind it. The ground, the roads, their
 * markings, the plants, the traffic and the crowd lie flat against the shore
 * and never reach that part of the picture.
 *
 * So the mirror draws a layer of its own, and only what is put on that layer
 * reaches it: the sky dome, the building shells and the lamps of
 * `world-scene.ts`, and the lights that shade them. Every other object keeps
 * layer 0 alone and is drawn in the view, in the shadow cascades, and not in
 * the mirror. On seed `1`, on the road beside the river at (-295, 115), that
 * takes the second pass from 68 draw calls to 19 and from 1.38 M triangles to
 * 1.22 M: most of what it drew was draw calls for things the picture never
 * showed.
 *
 * {@link reflected} adds the layer rather than setting it, so an object stays
 * in the view and in the shadow pass. Nothing is ever on the mirror's layer
 * alone. A new object that says nothing is left out of the mirror, which costs
 * a reflection nobody asked for and never a frame.
 */
import type { Camera, Object3D, Scene } from 'three';

/**
 * The layer the mirror's camera draws, and nothing else does. Layer 0 is what
 * every camera of the game draws, so this is the first one free.
 */
export const MIRROR_LAYER = 1;

/** Draw this object in the water's mirror as well as in the view. */
export function reflected<T extends Object3D>(object: T): T {
  object.layers.enable(MIRROR_LAYER);
  return object;
}

/** What {@link pointAtMirror} needs of a reflector: the camera it renders with. */
export interface MirrorReflector {
  getVirtualCamera(camera: Camera): Camera;
}

/**
 * Hold a reflector to the mirror's layer, so its pass draws that and nothing
 * else.
 *
 * A reflector renders with a camera cloned from the one the frame is drawn
 * with, which draws layer 0 like every camera of the game, so the clone has to
 * be told. It is made the first time each camera is drawn with and kept, and
 * the game draws with more than one — the view and the preview — so the layer
 * is set on the way out of the maker rather than once here.
 */
export function pointAtMirror(reflector: MirrorReflector): void {
  const make = reflector.getVirtualCamera.bind(reflector);
  reflector.getVirtualCamera = (camera: Camera): Camera => {
    const mirrored = make(camera);
    mirrored.layers.set(MIRROR_LAYER);
    return mirrored;
  };
}

/**
 * Draw every light of a scene in the mirror too.
 *
 * A light is an object like any other and is left out of a pass whose camera
 * does not draw its layer, so a mirror lit by a different set of lights than
 * the view would shade the same material with a different shader — and building
 * that shader is the stall of tens of milliseconds `docs/rendering.md` warns
 * about. The mirror therefore carries the whole of the scene's lighting, which
 * costs it no draw call at all.
 *
 * Called once, after the scene holds its lights. The light pools of `lamps.ts`,
 * `headlights.ts` and `signs.ts` are built to a fixed size and never grow, for
 * the same reason, so there is never a later light to catch.
 */
export function reflectLights(scene: Scene): void {
  scene.traverse((object) => {
    if ((object as { isLight?: boolean }).isLight === true) reflected(object);
  });
}
