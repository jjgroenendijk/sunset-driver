/**
 * The turning preview of the shop panel (spec section 16.1): the thing the
 * selected row sells, on a plinth, slowly turning, in a small window of the
 * panel.
 *
 * It is drawn by the game's own renderer onto a canvas of its own, through a
 * `CanvasTarget` (`three/webgpu`). A second renderer would be a second GPU
 * device and every shader compiled twice. The target is swapped in for the one
 * draw and swapped back, so the frame of the city never sees it.
 *
 * What it draws comes from `ShopLook` (`src/sim/shop-goods.ts`), which names a
 * weapon, a vehicle and its paint, an outfit or a prop. The models are the
 * ones the city draws — `weapon.ts`, `vehicle.ts`, `character.ts` — and the
 * props of `shop-props.ts`. Whatever it is, it is framed to fill the window.
 */
import {
  Box3,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import { CanvasTarget, type WebGPURenderer } from 'three/webgpu';
import { DEFAULT_APPEARANCE, type CharacterAppearance } from '../sim/character.ts';
import { specOf } from '../sim/roster.ts';
import type { ShopLook } from '../sim/shop-goods.ts';
import { createVehicleState } from '../sim/vehicle.ts';
import { CharacterModel } from './character.ts';
import { buildProp } from './shop-props.ts';
import { VehicleModel } from './vehicle.ts';
import { WeaponArt } from './weapon.ts';

/** Radians a second the plinth turns: one turn in about twelve seconds. */
const SPIN = 0.52;

/** The camera's field of view, and how far above the plinth it looks down from. */
const FOV = 28;
const TILT = 0.3;

/** How much room the model leaves round itself in the window. */
const MARGIN = 1.04;

/** The colour behind the thing on show: a warm grey a black gun still stands out on. */
const BACKDROP = 0x4a3c33;

/** What was built for one look, and how to let it go. */
interface Shown {
  object: Object3D;
  dispose: () => void;
}

export class ShopPreview {
  /** The canvas the preview is drawn on. The panel puts it in its window. */
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGPURenderer;
  private readonly target: CanvasTarget;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  /** The plinth and what stands on it, turned together. */
  private readonly turntable = new Group();
  private readonly plinth: Mesh;
  private readonly weapons = new WeaponArt();
  private shown: Shown | undefined;
  private key = '';
  /** The size of what is on show, which {@link ShopPreview.aim} keeps in sight. */
  private fit = { radius: 1, half: 0.5 };
  private width = 0;
  private height = 0;

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'shop-preview';
    this.target = new CanvasTarget(this.canvas);
    this.scene.background = new Color(BACKDROP);
    this.scene.add(new HemisphereLight(0xfff1dc, 0x5a4636, 3.4));
    const key = new DirectionalLight(0xfff4e6, 4.2);
    key.position.set(2.5, 4, 3);
    const rim = new DirectionalLight(0xffb070, 3.2);
    rim.position.set(-3, 2, -3);
    this.scene.add(key, rim);
    this.plinth = new Mesh(
      new CylinderGeometry(0.92, 0.98, 0.1, 48),
      new MeshStandardMaterial({ color: 0xc19a53, roughness: 0.35, metalness: 0.6 }),
    );
    this.turntable.add(this.plinth);
    this.scene.add(this.turntable);
  }

  /**
   * Put a look on the plinth. `appearance` is the player's own, which an
   * outfit is tried on over. The same look twice builds nothing.
   */
  show(look: ShopLook | undefined, appearance: CharacterAppearance = DEFAULT_APPEARANCE): void {
    const key = look === undefined ? '' : JSON.stringify(look);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (look === undefined) return;
    const shown = this.build(look, appearance);
    if (shown === undefined) return;
    this.shown = shown;
    this.frame(shown.object);
    this.turntable.add(shown.object);
  }

  /**
   * Draw the preview, turned to where `seconds` of wall-clock time puts it.
   * The preview is render state, so the clock it turns by is the page's.
   */
  draw(seconds: number): void {
    if (this.shown === undefined) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.target.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.target.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.aim();
    }
    this.turntable.rotation.y = seconds * SPIN;
    const before = this.renderer.getCanvasTarget();
    this.renderer.setCanvasTarget(this.target);
    try {
      void this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.setCanvasTarget(before);
    }
  }

  dispose(): void {
    this.clear();
    this.weapons.dispose();
    this.plinth.geometry.dispose();
    (this.plinth.material as MeshStandardMaterial).dispose();
    this.target.dispose();
    this.canvas.remove();
  }

  private clear(): void {
    if (this.shown === undefined) return;
    this.turntable.remove(this.shown.object);
    this.shown.dispose();
    this.shown = undefined;
  }

  private build(look: ShopLook, appearance: CharacterAppearance): Shown | undefined {
    switch (look.kind) {
      case 'weapon': {
        const geometry = this.weapons.geometry(look.id, look.attachments);
        if (geometry === undefined) return undefined;
        // The geometry belongs to the art, which keeps it for the next time.
        // A weapon stands on the plinth with its muzzle tipped up, as one on a
        // shop's wall does: laid flat it would show only its top.
        const mesh = new Mesh(geometry, this.weapons.material);
        mesh.rotation.set(0, 0, 0.3);
        const held = new Group();
        held.add(mesh);
        return { object: held, dispose: () => {} };
      }
      case 'vehicle': {
        const model = new VehicleModel(look.cls);
        const state = createVehicleState(specOf(look.cls));
        state.paint = look.paint;
        model.set(state);
        model.group.position.set(0, 0, 0);
        return { object: model.group, dispose: () => model.dispose() };
      }
      case 'outfit': {
        const model = new CharacterModel({ ...appearance, outfit: look.outfit });
        return { object: model.group, dispose: () => model.dispose() };
      }
      case 'prop': {
        const prop = buildProp(look.prop, look.colour);
        return { object: prop.group, dispose: () => prop.dispose() };
      }
    }
  }

  /**
   * Scale and centre a model to stand on the plinth and fill the window, and
   * put the camera where it sees all of it whichever way it has turned.
   */
  private frame(object: Object3D): void {
    object.position.set(0, 0, 0);
    object.scale.setScalar(1);
    object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(object);
    const sphere = box.getBoundingSphere(new Sphere());
    const scale = sphere.radius > 0 ? 1 / sphere.radius : 1;
    object.scale.setScalar(scale);
    // Centred over the axis the plinth turns about, feet on its top.
    const top = 0.06;
    const centre = box.getCenter(new Vector3());
    object.position.set(-centre.x * scale, top - box.min.y * scale, -centre.z * scale);
    // What the camera has to keep in sight whichever way the model turns: the
    // circle its corners sweep, and its height.
    const across = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    const tall = box.max.y - box.min.y;
    this.fit = { radius: Math.max(across * scale, 0.95), half: (tall * scale + top) / 2 };
    this.aim();
  }

  /**
   * Put the camera back from the plinth far enough to see the whole of the
   * model at the window's shape: a wide window is filled by a long weapon, a
   * tall one by a figure standing.
   */
  private aim(): void {
    const { radius, half } = this.fit;
    const vertical = Math.tan(((FOV / 2) * Math.PI) / 180);
    const horizontal = vertical * this.camera.aspect;
    // The height seen from above is its own plus the depth of the circle behind it.
    const seen = half * Math.cos(TILT) + radius * Math.sin(TILT);
    const distance = MARGIN * Math.max(seen / vertical, radius / horizontal) + radius * 0.3;
    this.camera.position.set(0, half + distance * Math.sin(TILT), distance * Math.cos(TILT));
    this.camera.lookAt(0, half, 0);
  }
}
