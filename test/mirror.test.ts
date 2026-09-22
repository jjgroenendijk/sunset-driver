/**
 * What the water's mirror draws (`src/render/mirror.ts`).
 *
 * The mirror is a second pass over the scene, so the cheapest thing it can do
 * is draw less of the scene than the view does. It draws a layer of its own,
 * and what is pinned here is the two halves of that: an object put on the layer
 * is drawn in both passes and never in the mirror alone, and a camera held to
 * the layer draws what was put there and nothing else.
 */
import { Camera, DirectionalLight, Group, Mesh, PerspectiveCamera, PointLight, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { BuildingScenery } from '../src/render/buildings.ts';
import { cellGrid } from '../src/render/cells.ts';
import { BuildingCutaway } from '../src/render/cutaway.ts';
import { EntityFade } from '../src/render/fade.ts';
import { LampScenery } from '../src/render/lamps.ts';
import { MIRROR_LAYER, pointAtMirror, reflected, reflectLights } from '../src/render/mirror.ts';
import { RoadScenery } from '../src/render/roads.ts';
import { SkyLighting } from '../src/render/sky.ts';
import { PlantScenery } from '../src/render/vegetation.ts';

/** A camera as the game draws with one: layer 0 and nothing else. */
function viewCamera(): Camera {
  return new PerspectiveCamera();
}

/** A reflector as three.js has one: it clones the camera it is handed, and keeps the clone. */
function stubReflector(): { getVirtualCamera(camera: Camera): Camera; made: number } {
  const clones = new Map<Camera, Camera>();
  return {
    made: 0,
    getVirtualCamera(camera: Camera): Camera {
      let clone = clones.get(camera);
      if (clone === undefined) {
        clone = camera.clone();
        clones.set(camera, clone);
        this.made++;
      }
      return clone;
    },
  };
}

describe('the mirror layer', () => {
  it('adds the layer without taking the object out of the view or the shadow pass', () => {
    const mesh = reflected(new Mesh());
    expect(mesh.layers.test(viewCamera().layers)).toBe(true);
    expect(mesh.layers.isEnabled(MIRROR_LAYER)).toBe(true);
  });

  it('draws what was put on the layer in the mirror, and nothing else', () => {
    const mirrored = reflected(new Mesh());
    const plain = new Mesh();

    const reflector = stubReflector();
    pointAtMirror(reflector);
    const camera = reflector.getVirtualCamera(viewCamera());

    expect(mirrored.layers.test(camera.layers)).toBe(true);
    expect(plain.layers.test(camera.layers)).toBe(false);
    // The view still draws both: the layer is added to the object, never moved.
    expect(plain.layers.test(viewCamera().layers)).toBe(true);
  });

  it('holds every camera the reflector is asked for to the layer, and keeps the clone', () => {
    const reflector = stubReflector();
    pointAtMirror(reflector);
    const view = viewCamera();
    const first = reflector.getVirtualCamera(view);
    expect(reflector.getVirtualCamera(view)).toBe(first);
    expect(reflector.made).toBe(1);

    // The preview draws with a camera of its own, and its clone is held too.
    const second = reflector.getVirtualCamera(viewCamera());
    expect(second).not.toBe(first);
    expect(second.layers.isEnabled(MIRROR_LAYER)).toBe(true);
    expect(second.layers.isEnabled(0)).toBe(false);
  });
});

describe('the sky of a mirrored scene', () => {
  it('draws the dome and the sun in the mirror, since the sky is most of what water gives back', () => {
    const scene = new Scene();
    const sky = new SkyLighting(scene, 10, 100);
    reflectLights(scene);

    const reflector = stubReflector();
    pointAtMirror(reflector);
    const camera = reflector.getVirtualCamera(viewCamera());
    const drawn = scene.children.filter((child) => child.layers.test(camera.layers));
    // The dome, the sun and the fill. The sun's target carries no light and is
    // read off the light itself, so it never has to be drawn.
    expect(drawn).toHaveLength(3);
    sky.dispose();
  });
});

describe('the sun of a mirrored scene', () => {
  it('holds its shadow camera to both layers, so the mirror cannot halve the map', () => {
    const scene = new Scene();
    const sky = new SkyLighting(scene, 10, 100);
    const sun = scene.children.find((child) => (child as DirectionalLight).isDirectionalLight === true);
    const shadow = (sun as DirectionalLight).shadow;

    // three.js hands a shadow camera that names layer 0 alone the layers of
    // whichever camera asks for the map, and the map is drawn for the first
    // pass of a frame that asks. A frame the mirror opens would then light the
    // whole view from a map the mirror's own layer cast, and the shadow pass of
    // each mask is a program of its own. Both layers named here pin the mask.
    expect(shadow.camera.layers.mask & 0xfffffffe).not.toBe(0);
    expect(shadow.camera.layers.isEnabled(0)).toBe(true);
    expect(shadow.camera.layers.isEnabled(MIRROR_LAYER)).toBe(true);
    sky.dispose();
  });
});

describe('the lights of a mirrored scene', () => {
  it('carries every light into the mirror and leaves the geometry to say for itself', () => {
    const scene = new Scene();
    const sun = new DirectionalLight();
    const group = new Group();
    const lamp = new PointLight();
    const mesh = new Mesh();
    group.add(lamp);
    scene.add(sun, group, mesh);

    reflectLights(scene);

    const reflector = stubReflector();
    pointAtMirror(reflector);
    const camera = reflector.getVirtualCamera(viewCamera());
    // A pass lit by a different set of lights than the view builds every
    // material's shader a second time, so the mirror carries all of them.
    expect(sun.layers.test(camera.layers)).toBe(true);
    expect(lamp.layers.test(camera.layers)).toBe(true);
    expect(mesh.layers.test(camera.layers)).toBe(false);
  });
});

/** One cell's worth of chunk, which is all a piece needs to answer for itself. */
const GRID = cellGrid({ minX: 0, minY: 0, maxX: 250, maxY: 250 }, 'near');
const EMPTY_PLANTS = { models: new Uint16Array(0), matrices: new Float32Array(0) };
const EMPTY_ROADS = {
  tier: 'street' as const,
  surface: [],
  markings: new Float32Array(0),
  markingNormals: new Float32Array(0),
  markingTints: new Float32Array(0),
};

describe('the pieces of a chunk', () => {
  it('draws the building shells and the lamp masts in the mirror, and not the rest', () => {
    const fade = new EntityFade(100);
    const buildings = new BuildingScenery(new BuildingCutaway());
    const lamps = new LampScenery(fade);
    const plants = new PlantScenery(fade);
    const roads = new RoadScenery();

    // A building is what a grazing eye sees in the water; a hull is a rim
    // 0.35 m wide around a shell the mirror draws anyway.
    expect(buildings.build('facade', []).mirrored).toBe(true);
    expect(buildings.build('block', []).mirrored).toBe(true);
    expect(buildings.build('outline', []).mirrored).not.toBe(true);
    expect(lamps.build(GRID, []).mirrored).toBe(true);

    // The ground and everything lying flat on it stays out of the second pass.
    expect(plants.build(GRID, EMPTY_PLANTS).mirrored).not.toBe(true);
    expect(roads.build(EMPTY_ROADS).mirrored).not.toBe(true);

    buildings.dispose();
    lamps.dispose();
    plants.dispose();
    roads.dispose();
  });
});
