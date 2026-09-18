/**
 * The light a neon sign throws on the street under it, and the shader that
 * skips it while the sign is dark.
 *
 * Spec section 10.5 asks for a `RectAreaLight` here, and a sign is the one
 * thing in the city that really is a lit rectangle: a cone would throw the
 * wrong shape and a point light would throw it in every direction. The addon's
 * BRDF tables have to be handed to the node before any material that reads them
 * is built, which is what {@link registerNeonLight} does.
 *
 * The rest is `lamp-light.ts`'s problem and `lamp-light.ts`'s answer. A light in
 * a scene is evaluated by every fragment it can reach whatever its intensity,
 * and taking it out of the scene rebuilds the shader of every material, so the
 * light stays and its shader branches: {@link NeonLightNode} wraps the whole
 * light in a test on one uniform that says whether it burns. By day, and for a
 * light parked with no sign to stand on, every fragment fails the test and does
 * none of it.
 */
import { RectAreaLight } from 'three';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';
import { RectAreaLightNode, type NodeBuilder, type NodeFrame, type WebGPURenderer } from 'three/webgpu';
import { If, renderGroup, uniform } from './tsl.ts';

/**
 * The area light a neon sign throws, which {@link NeonLightNode} draws. It adds
 * nothing but its class, which is what lets the node be registered for it
 * alone.
 */
export class NeonLight extends RectAreaLight {}

/** An area light whose shader does nothing while the sign is dark. */
export class NeonLightNode extends RectAreaLightNode {
  /** 1 while the sign burns, 0 while its intensity is 0. */
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
  addLight(nodeClass: typeof NeonLightNode, lightClass: typeof NeonLight): void;
}

/** The BRDF tables, built once: they are about 300 kB and every world shares them. */
let tables: ReturnType<typeof RectAreaLightTexturesLib.init> | undefined;

/**
 * Tell a renderer to draw a {@link NeonLight} with {@link NeonLightNode}, and
 * give the node its BRDF tables. Without the tables a material that reaches a
 * rect area light fails to build; without the registration the renderer finds
 * no node for the class, warns once and draws the sign with no light.
 */
export function registerNeonLight(renderer: WebGPURenderer): void {
  tables ??= RectAreaLightTexturesLib.init();
  RectAreaLightNode.setLTC(tables);
  (renderer.library as unknown as LightLibrary).addLight(NeonLightNode, NeonLight);
}
