import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type BufferGeometry, type Material } from 'three';
import {
  type CharacterAppearance,
  normaliseAppearance,
  resolveAppearance,
} from '../sim/character.ts';

/**
 * The player model, built from boxes at the proportions the chosen body type
 * asks for (spec section 11.1). The camera looks down, so the parts that read
 * from above — shoulders, hair, shoes — carry the colours the player picked.
 */
export class CharacterModel {
  readonly group = new Group();
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];
  private appearance: CharacterAppearance;

  constructor(appearance: CharacterAppearance) {
    this.appearance = normaliseAppearance(appearance);
    this.build();
  }

  /** Height of the model in metres, so the camera and the HUD can frame it. */
  get height(): number {
    return resolveAppearance(this.appearance).body.height;
  }

  /** Rebuild for a new look. Cheap enough to call on every click of the creator. */
  set(appearance: CharacterAppearance): void {
    const next = normaliseAppearance(appearance);
    this.appearance = next;
    this.clear();
    this.build();
  }

  /** Release the GPU resources of the current model. */
  dispose(): void {
    this.clear();
  }

  private clear(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries = [];
    this.materials = [];
  }

  /**
   * One part, sized and placed across the body, up, and along the way it faces.
   * The model faces local +x, the way a yaw of -heading turns along the heading,
   * so across is local z and along is local x.
   */
  private box(w: number, h: number, d: number, colour: number, x: number, y: number, z: number): void {
    const geometry = new BoxGeometry(d, h, w);
    const material = new MeshStandardMaterial({ color: colour, roughness: 0.7 });
    const mesh = new Mesh(geometry, material);
    mesh.position.set(z, y, x);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
  }

  private build(): void {
    const { body, skin, hair, hairColour, outfit } = resolveAppearance(this.appearance);
    const h = body.height;
    const shoeHeight = 0.06 * h * 0.6;
    const legTop = 0.52 * h;
    const shoulderTop = 0.82 * h;
    const headHeight = h - shoulderTop;
    const legWidth = body.hip * 0.44;
    const armWidth = body.shoulder * 0.16;
    const depth = body.shoulder * 0.52;

    // Feet first: the shoes stand under the legs, so the model starts at y = 0.
    for (const side of [-1, 1]) {
      const x = side * body.hip * 0.26;
      this.box(legWidth * 1.1, shoeHeight, depth * 1.2, outfit.shoe, x, shoeHeight / 2, depth * 0.1);
      this.box(legWidth, legTop - shoeHeight, depth * 0.8, outfit.bottom, x, (legTop + shoeHeight) / 2, 0);
    }

    const torsoHeight = shoulderTop - legTop;
    this.box(body.shoulder, torsoHeight, depth, outfit.top, 0, legTop + torsoHeight / 2, 0);

    for (const side of [-1, 1]) {
      const x = side * (body.shoulder / 2 + armWidth / 2);
      this.box(armWidth, torsoHeight * 0.86, depth * 0.7, outfit.top, x, legTop + torsoHeight * 0.52, 0);
      // Hands read as the skin tone from above, at the end of each arm.
      this.box(armWidth, torsoHeight * 0.14, depth * 0.7, skin.colour, x, legTop + torsoHeight * 0.09, 0);
    }

    const headWidth = h * 0.13;
    this.box(headWidth, headHeight, headWidth * 1.05, skin.colour, 0, shoulderTop + headHeight / 2, 0);

    // The hair sits on the crown and, when it is long enough, falls behind.
    const capHeight = headHeight * 0.34 + hair.volume;
    this.box(
      headWidth + hair.volume * 2,
      capHeight,
      headWidth * 1.05 + hair.volume * 2,
      hairColour.colour,
      0,
      h - capHeight / 2,
      0,
    );
    if (hair.length > 0.03) {
      this.box(
        headWidth + hair.volume,
        hair.length,
        headWidth * 0.3,
        hairColour.colour,
        0,
        h - capHeight - hair.length / 2,
        -headWidth * 0.5,
      );
    }
  }
}
