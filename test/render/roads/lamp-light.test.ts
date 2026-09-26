import { Scene } from 'three';
import { LightsNode, type NodeFrame } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LampLight, LampLightNode } from '../../../src/render/roads/lamp-light.ts';
import { LampLights, LAMP_LIGHT_CAP } from '../../../src/render/roads/lamps.ts';

/** The pool's lights, as the scene holds them. */
function poolOf(scene: Scene): LampLight[] {
  return scene.children.filter((child): child is LampLight => child instanceof LampLight);
}

describe('lamp lights', () => {
  it('fills the pool with lights the gated node draws', () => {
    const scene = new Scene();
    expect(() => new LampLights(scene)).not.toThrow();
    expect(poolOf(scene)).toHaveLength(LAMP_LIGHT_CAP);
  });

  it('opens the gate only while the light burns', () => {
    const light = new LampLight(0xffffff, 0);
    const node = new LampLightNode(light);
    const lit = (node as unknown as { lit: { value: number } }).lit;
    node.update({} as NodeFrame);
    expect(lit.value).toBe(0);
    light.intensity = 130;
    node.update({} as NodeFrame);
    expect(lit.value).toBe(1);
  });

  it('keeps the shader key when the lamps come on at dusk', () => {
    const scene = new Scene();
    const lamps = new LampLights(scene);
    const pool = poolOf(scene);
    const key = (): number => new LightsNode().setLights(pool).getCacheKey();
    const day = key();
    lamps.aim(0, 0, [], 1);
    for (const light of pool) light.intensity = 130;
    expect(key()).toBe(day);
  });
});
