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
 * What it draws comes from `ShopLook` (`src/sim/places/shop-goods.ts`), which names a
 * weapon, a vehicle and its paint, an outfit or a prop. The models are the
 * ones the city draws — `weapon.ts`, `vehicle.ts`, `character.ts` — and the
 * props of `shop-props.ts`. The dealer's panel shows the goods of the
 * contraband trade in it too, from `contraband-props.ts`. Whatever it is, it is framed to fill the window:
 * `shop-frame.ts` finds where the camera stands, and why a weapon sways rather
 * than spins.
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
  Vector3,
  type Object3D,
} from 'three';
import { CanvasTarget, type WebGPURenderer } from 'three/webgpu';
import { aimAt, SPIN, SWAY, type Bounds, type Motion } from './shop-frame.ts';
import { DEFAULT_APPEARANCE, type CharacterAppearance } from '../../sim/player/character.ts';
import { specOf } from '../../sim/vehicles/roster.ts';
import type { ShopLook } from '../../sim/places/shop-goods.ts';
import { createVehicleState } from '../../sim/vehicles/vehicle.ts';
import { CharacterModel } from '../people/character.ts';
import { buildGood } from '../crime/contraband-props.ts';
import { basePixelRatioFor } from '../renderer.ts';
import { buildProp } from './shop-props.ts';
import { VehicleModel } from '../vehicles/vehicle.ts';
import { WeaponArt } from '../weapons/weapon.ts';

/** Radians a second the plinth turns: one turn in about twelve seconds. */
const TURN = 0.52;

/** Radians a second through the sway of a weapon: there and back in about ten seconds. */
const SWAY_RATE = 0.6;

/** The camera's field of view, and how far it looks down on the plinth. */
const FOV = 26;
const TILT = 0.32;

/** How much room the model leaves round itself in the window. */
const MARGIN = 1.06;

/** The plinth: its height, and the least radius it keeps under a narrow model. */
const PLINTH_HEIGHT = 0.06;
const PLINTH_LEAST = 0.3;

/** How far a weapon's muzzle is tipped up, as one on a shop's wall is: laid flat it shows only its top. */
const WEAPON_TIP = 0.2;

/** The colour behind the thing on show: a warm grey a black gun still stands out on. */
const BACKDROP = 0x4a3c33;

/** What was built for one look, and how to let it go. */
interface Shown {
  object: Object3D;
  dispose: () => void;
  /** Whether it spins or sways (`shop-frame.ts`). */
  motion: Motion;
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
  /** The box of what is on show, in the plinth's frame, which {@link ShopPreview.aim} keeps in sight. */
  private bounds: Bounds = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  private width = 0;
  private height = 0;
  private ratio = 0;
  /** Set once a draw has thrown, so a broken preview says so once rather than every frame. */
  private failed = false;

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
    // A unit disc, scaled to each model's footprint, its top at the origin.
    const disc = new CylinderGeometry(0.96, 1, PLINTH_HEIGHT, 48);
    disc.translate(0, -PLINTH_HEIGHT / 2, 0);
    this.plinth = new Mesh(
      disc,
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
    if (this.shown === undefined || this.failed) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    // The ratio is read every frame: a window dragged to another screen changes it.
    const ratio = basePixelRatioFor(window.devicePixelRatio);
    if (width !== this.width || height !== this.height || ratio !== this.ratio) {
      this.width = width;
      this.height = height;
      this.ratio = ratio;
      this.target.setPixelRatio(ratio);
      this.target.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.aim();
    }
    const { rest, swing } = this.shown.motion;
    this.turntable.rotation.y =
      swing >= Math.PI ? rest + seconds * TURN : rest + swing * Math.sin(seconds * SWAY_RATE);
    const before = this.renderer.getCanvasTarget();
    this.renderer.setCanvasTarget(this.target);
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (error) {
      // The preview is a picture of the row, not the row: the counter still
      // works without it, so it is let go rather than thrown every frame.
      this.failed = true;
      console.error('shop preview: the draw failed, and the window stays empty', error);
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
        const mesh = new Mesh(geometry, this.weapons.material);
        mesh.rotation.set(0, 0, WEAPON_TIP);
        const held = new Group();
        held.add(mesh);
        return { object: held, dispose: () => {}, motion: SWAY };
      }
      case 'vehicle': {
        const model = new VehicleModel(look.cls);
        const state = createVehicleState(specOf(look.cls));
        state.paint = look.paint;
        model.set(state);
        model.group.position.set(0, 0, 0);
        return { object: model.group, dispose: () => model.dispose(), motion: SPIN };
      }
      case 'outfit': {
        const model = new CharacterModel({ ...appearance, outfit: look.outfit });
        return { object: model.group, dispose: () => model.dispose(), motion: SPIN };
      }
      case 'prop': {
        const prop = buildProp(look.prop, look.colour);
        return { object: prop.group, dispose: () => prop.dispose(), motion: SPIN };
      }
      case 'good': {
        const prop = buildGood(look.good);
        return { object: prop.group, dispose: () => prop.dispose(), motion: SPIN };
      }
    }
  }

  /**
   * Scale a model so its longest side is one unit, stand it on the plinth
   * over the axis it turns about, and size the plinth to its footprint.
   */
  private frame(object: Object3D): void {
    object.position.set(0, 0, 0);
    object.scale.setScalar(1);
    object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(object);
    const size = box.getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    const scale = longest > 0 ? 1 / longest : 1;
    object.scale.setScalar(scale);
    const centre = box.getCenter(new Vector3());
    object.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
    const half = [(size.x * scale) / 2, (size.z * scale) / 2] as const;
    this.bounds = { min: [-half[0], 0, -half[1]], max: [half[0], size.y * scale, half[1]] };
    // A long gun rests on a small stand under its middle; anything else
    // stands on a disc a little wider than itself.
    const footprint = Math.hypot(half[0], half[1]);
    const radius = this.shown?.motion === SWAY ? PLINTH_LEAST : Math.max(footprint * 1.05, PLINTH_LEAST);
    this.plinth.scale.set(radius, 1, radius);
    this.aim();
  }

  /** Stand the camera where it holds the model and its plinth at every angle they turn through. */
  private aim(): void {
    if (this.shown === undefined) return;
    const radius = this.plinth.scale.x;
    const { target, distance } = aimAt(
      this.bounds,
      { radius, top: 0, bottom: -PLINTH_HEIGHT },
      this.shown.motion,
      { fov: FOV, aspect: this.camera.aspect, tilt: TILT, margin: MARGIN },
    );
    this.camera.position.set(0, target + distance * Math.sin(TILT), distance * Math.cos(TILT));
    this.camera.lookAt(0, target, 0);
  }
}
