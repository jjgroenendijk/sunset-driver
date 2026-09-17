/**
 * The light a street lamp or a headlamp throws, and the shader that skips it
 * while it is off.
 *
 * A light in a scene is evaluated by every fragment it can reach, and its
 * intensity is a uniform, so a lamp dimmed to 0 by day costs as much as one at
 * full night. Taking the light out of the scene instead changes the light list,
 * which rebuilds the shader of every material. three.js does not keep the old
 * variant either: the render objects drop it as they rebuild, so every dusk and
 * every dawn would build the whole scene again.
 *
 * So the light stays and its shader branches. {@link LampLightNode} wraps the
 * whole light — the cone, the fall-off and the lighting model — in a test on
 * one uniform that says whether the light burns. By day, and for a light parked
 * with no lamp to stand on, every fragment fails the test and does none of it.
 * The shader and the light list never change, so dusk costs no build.
 */
import { ProjectorLight, ProjectorLightNode, type NodeBuilder, type NodeFrame, type WebGPURenderer } from 'three/webgpu';
import { If, renderGroup, uniform } from './tsl.ts';

/**
 * A projector light that {@link LampLightNode} draws. It adds nothing but its
 * class. `lamps.ts` throws the street lamps with it and `headlights.ts` the
 * beams of the player's vehicle; both are off by day, and this is what makes
 * that free.
 */
export class LampLight extends ProjectorLight {}

/** A projector light whose shader does nothing while the light is off. */
export class LampLightNode extends ProjectorLightNode {
  /** 1 while the light burns, 0 while its intensity is 0. */
  private readonly lit = uniform(0).setGroup(renderGroup);

  override update(frame: NodeFrame): boolean | undefined {
    const result = super.update(frame);
    this.lit.value = this.light !== null && this.light.intensity > 0 ? 1 : 0;
    return result;
  }

  override setup(builder: NodeBuilder): undefined {
    If(this.lit.greaterThan(0), () => {
      super.setup(builder);
    });
    return undefined;
  }
}

/** The part of a renderer's node library `@types/three` leaves out. */
interface LightLibrary {
  addLight(nodeClass: typeof LampLightNode, lightClass: typeof LampLight): void;
}

/**
 * Tell a renderer to draw a {@link LampLight} with {@link LampLightNode}. A
 * renderer that is not told finds no node for the class, warns once and draws
 * the lamp with no light.
 */
export function registerLampLight(renderer: WebGPURenderer): void {
  (renderer.library as unknown as LightLibrary).addLight(LampLightNode, LampLight);
}
