/**
 * The models of the game laid out in rows for one picture, for the preview
 * alone: every vehicle of the roster (spec section 11.3), every look the
 * character creator builds (spec section 11.1), every good a counter sells
 * (spec section 16.1), and every good a dealer trades (spec section 16.2).
 *
 * `--pickups` already lays the arsenal out this way, and the gallery does for
 * the rest what it does for the weapons: a change to a mesh is judged against
 * its neighbours in one frame, rather than one picture at a time. The models
 * are the ones the game draws — `vehicle.ts`, `character.ts`, `shop-props.ts`,
 * `contraband-props.ts` —
 * so what the row shows is what the game shows.
 *
 * A prop is modelled at the scale of the shop panel's window, where a coffee
 * cup is a metre tall, so props alone are scaled down onto the ground. Nothing
 * here is simulated and nothing is written into the record: the gallery is
 * built, drawn and let go inside one request.
 */
import { Box3, Group, Vector3 } from 'three';
import {
  BODY_TYPES,
  HAIR_COLOURS,
  HAIR_STYLES,
  OUTFITS,
  SKIN_TONES,
  type CharacterAppearance,
} from '../../sim/player/character.ts';
import { CARE, FOODS, type PropId } from '../../sim/places/shop-goods.ts';
import { createVehicleState, rideHeight, specOf, VEHICLE_CLASSES } from '../../sim/vehicles/vehicle.ts';
import { CharacterModel } from '../people/character.ts';
import { GOOD_IDS } from '../../sim/crime/goods.ts';
import { buildGood } from '../crime/contraband-props.ts';
import { buildProp, type Prop } from '../shops/shop-props.ts';
import { VehicleModel } from '../vehicles/vehicle.ts';

/** The subjects a gallery lays out. */
export type GallerySubject = 'vehicles' | 'people' | 'props' | 'goods';

export const GALLERY_SUBJECTS: readonly GallerySubject[] = ['vehicles', 'people', 'props', 'goods'];

/** How a subject is laid out: the grid it fills, and the room each model is given. */
interface Layout {
  /** Models in a row, across the picture. */
  columns: number;
  /** Metres between two columns, and between two rows. */
  across: number;
  along: number;
}

const LAYOUTS: Readonly<Record<GallerySubject, Layout>> = {
  // A bus is 12 m long and a truck nearly as wide as two cars, so the roster
  // is given the room of the longest of them rather than of the average.
  vehicles: { columns: 4, across: 7, along: 14 },
  // A person is half a metre across and a prop a metre: both are given about
  // three times their own width, and a grid as square as the count allows, so
  // the camera stands as close as it can.
  people: { columns: 4, across: 1.6, along: 2.2 },
  props: { columns: 5, across: 1.4, along: 1.8 },
  goods: { columns: 4, across: 1.4, along: 1.8 },
};

/** Metres ahead of the player the near row of a gallery lies. */
const AHEAD = 6;

/** Metres the longest side of a prop is scaled to, so a row of them reads at human scale. */
const PROP_SIZE = 1;

/**
 * How the clear ground under a gallery is looked for: rings this far apart,
 * out to this far, with this many places tried on each ring. The rings stay
 * inside the chunks already built round the player, so nothing is laid on
 * ground that has not landed yet.
 */
const SEARCH_STEP = 12;
const SEARCH_REACH = 96;
const SEARCH_ROUND = 12;

/** Metres of room a laid model is given clear of a building, so nothing stands under an eave. */
const ROOF_MARGIN = 2;

/** One thing laid out: what it is called, the model standing for it, and how it is stood somewhere. */
interface Piece {
  label: string;
  object: Group;
  /** Stand the model on the ground at a place, turned to face `facing`. */
  place: (x: number, y: number, ground: number, facing: number) => void;
  dispose: () => void;
}

/** A gallery standing in the scene, until the request that laid it lets it go. */
export interface Gallery {
  /** The group the models hang from. The caller adds it to the scene and removes it again. */
  group: Group;
  /** The middle of the grid, in metres, which is what the camera is pointed at. */
  x: number;
  y: number;
  /** Metres from that middle to the far corner of the grid, which is what the camera has to hold. */
  reach: number;
  /** What was laid, in the order it lies: the near row first, left to right. */
  labels: string[];
  dispose: () => void;
}

/**
 * Lay the models of one subject in rows before a place facing `heading`, each
 * standing on the ground under it and turned back towards the player, so the
 * camera behind the player sees the front of every one.
 */
export function layGallery(
  subject: GallerySubject,
  stand: { x: number; y: number; heading: number },
  heightAt: (x: number, y: number) => number,
  appearance: CharacterAppearance,
): Gallery {
  const layout = LAYOUTS[subject];
  const cos = Math.cos(stand.heading);
  const sin = Math.sin(stand.heading);
  const at = (ahead: number, beside: number): { x: number; y: number } => ({
    x: stand.x + cos * ahead - sin * beside,
    y: stand.y + sin * ahead + cos * beside,
  });
  const facing = stand.heading + Math.PI;
  const pieces = piecesOf(subject, appearance);

  const group = new Group();
  const rows = Math.max(1, Math.ceil(pieces.length / layout.columns));
  const columns = Math.min(layout.columns, pieces.length);
  pieces.forEach((piece, i) => {
    const ahead = AHEAD + Math.floor(i / layout.columns) * layout.along;
    const beside = ((i % layout.columns) - (layout.columns - 1) / 2) * layout.across;
    const place = at(ahead, beside);
    piece.place(place.x, place.y, heightAt(place.x, place.y), facing);
    group.add(piece.object);
  });
  const middle = at(AHEAD + ((rows - 1) * layout.along) / 2, 0);
  const halfWidth = (columns * layout.across) / 2;
  const halfDepth = (rows * layout.along) / 2;
  return {
    group,
    x: middle.x,
    y: middle.y,
    reach: Math.hypot(halfWidth, halfDepth),
    labels: pieces.map((piece) => piece.label),
    dispose: () => {
      for (const piece of pieces) piece.dispose();
      group.clear();
    },
  };
}

function piecesOf(subject: GallerySubject, appearance: CharacterAppearance): Piece[] {
  if (subject === 'vehicles') return VEHICLE_CLASSES.map(vehiclePiece);
  if (subject === 'people') return appearancesFrom(appearance).map(peoplePiece);
  if (subject === 'goods') return GOOD_IDS.map((id) => groundPiece(id, buildGood(id)));
  return GALLERY_PROPS.map((entry) => groundPiece(entry.prop, buildProp(entry.prop, entry.colour)));
}

/** Stand a model that hangs from its own group: on the ground, turned to face the camera. */
function standGroup(object: Group, x: number, y: number, ground: number, facing: number): void {
  object.position.set(x, ground, y);
  object.rotation.y = -facing;
}

/**
 * One of every class of the roster, standing on the ground at its own ride
 * height. A boat is laid on the ground with the rest: the gallery is a shelf
 * of models, not a place in the city.
 */
function vehiclePiece(cls: (typeof VEHICLE_CLASSES)[number]): Piece {
  const spec = specOf(cls);
  const model = new VehicleModel(cls);
  return {
    label: cls,
    object: model.group,
    // A vehicle is put where its state says it is, rather than by its group.
    place: (x, y, ground, facing) => model.set(createVehicleState(spec, x, y, ground + rideHeight(spec), facing)),
    dispose: () => model.dispose(),
  };
}

function peoplePiece(look: { label: string; appearance: CharacterAppearance }): Piece {
  const model = new CharacterModel(look.appearance);
  return {
    label: look.label,
    object: model.group,
    place: (x, y, ground, facing) => standGroup(model.group, x, y, ground, facing),
    dispose: () => model.dispose(),
  };
}

function groundPiece(label: string, prop: Prop): Piece {
  // The panel frames a prop to fill its window; the ground has no window, so
  // the longest side is brought to a metre and the model stood on its own base.
  const box = new Box3().setFromObject(prop.group);
  const size = box.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const scale = longest > 0 ? PROP_SIZE / longest : 1;
  const centre = box.getCenter(new Vector3());
  const object = new Group();
  prop.group.scale.setScalar(scale);
  prop.group.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
  object.add(prop.group);
  return {
    label,
    object,
    place: (x, y, ground, facing) => standGroup(object, x, y, ground, facing),
    dispose: () => prop.dispose(),
  };
}

/**
 * The looks the people gallery wears. Every table of the creator is stepped
 * through at once, so a row as long as the longest table shows every option of
 * every table at least once.
 */
function appearancesFrom(base: CharacterAppearance): { label: string; appearance: CharacterAppearance }[] {
  const count = appearanceCount();
  const looks: { label: string; appearance: CharacterAppearance }[] = [];
  for (let i = 0; i < count; i++) {
    const appearance: CharacterAppearance = {
      body: (base.body + i) % BODY_TYPES.length,
      skin: (base.skin + i) % SKIN_TONES.length,
      hair: (base.hair + i) % HAIR_STYLES.length,
      hairColour: (base.hairColour + i) % HAIR_COLOURS.length,
      outfit: (base.outfit + i) % OUTFITS.length,
    };
    const outfit = OUTFITS[appearance.outfit];
    const body = BODY_TYPES[appearance.body];
    looks.push({ label: `${outfit?.label ?? ''} on ${body?.label.toLowerCase() ?? ''}`, appearance });
  }
  return looks;
}

/** Looks the people gallery lays: as many as the longest table of the creator holds. */
function appearanceCount(): number {
  return Math.max(OUTFITS.length, BODY_TYPES.length, SKIN_TONES.length, HAIR_STYLES.length, HAIR_COLOURS.length);
}

/**
 * Every prop a counter shows, in the colour that counter gives it. The food
 * and the care carry their colour in their own tables; the rest are priced
 * rows of `shop-stock.ts`, whose colours are named here.
 * `test/render/preview/preview-gallery.test.ts` holds this list to every prop there is.
 */
export const GALLERY_PROPS: readonly { prop: PropId; colour: number }[] = [
  ...FOODS.map((good) => ({ prop: good.prop, colour: good.colour })),
  ...CARE.map((good) => ({ prop: good.prop, colour: good.colour })),
  { prop: 'ammo', colour: 0xc19a53 },
  { prop: 'wrench', colour: 0x9aa0a6 },
  { prop: 'house', colour: 0xc8a96a },
  { prop: 'naloxone', colour: 0xe45a3c },
  { prop: 'strips', colour: 0x3f7fbf },
  { prop: 'works', colour: 0xd8a544 },
];

/**
 * The nearest place a gallery stands clear of every building, the place asked
 * for when it is already clear, and that place again when nothing within
 * {@link SEARCH_REACH} is. A shelf of models behind a wall is not a picture,
 * and a city block is wider than the grid, so the gallery is moved rather than
 * laid where it cannot be seen.
 */
export function clearPlaceFor(
  subject: GallerySubject,
  stand: { x: number; y: number; heading: number },
  roofed: (x: number, y: number) => boolean,
): { x: number; y: number } {
  const cells = cellsOf(subject);
  const cos = Math.cos(stand.heading);
  const sin = Math.sin(stand.heading);
  for (let ring = 0; ring * SEARCH_STEP <= SEARCH_REACH; ring++) {
    const places = ring === 0 ? 1 : SEARCH_ROUND;
    for (let i = 0; i < places; i++) {
      const angle = (i / places) * Math.PI * 2;
      const x = stand.x + Math.cos(angle) * ring * SEARCH_STEP;
      const y = stand.y + Math.sin(angle) * ring * SEARCH_STEP;
      const clear = cells.every((cell) => !roofed(x + cos * cell.ahead - sin * cell.beside, y + sin * cell.ahead + cos * cell.beside));
      if (clear) return { x, y };
    }
  }
  return { x: stand.x, y: stand.y };
}

/** Where every model of a subject stands, before the place it is laid from, and the room round it. */
function cellsOf(subject: GallerySubject): { ahead: number; beside: number }[] {
  const layout = LAYOUTS[subject];
  const count = piecesCount(subject);
  const cells: { ahead: number; beside: number }[] = [];
  for (let i = 0; i < count; i++) {
    const ahead = AHEAD + Math.floor(i / layout.columns) * layout.along;
    const beside = ((i % layout.columns) - (layout.columns - 1) / 2) * layout.across;
    // The corners of the cell as well as its middle: a model is as wide as
    // the room it is given, and an eave over one corner is over the model.
    for (const side of [-1, 1]) {
      cells.push({ ahead: ahead + (side * layout.along) / 2 - ROOF_MARGIN * side, beside: beside + (side * layout.across) / 2 });
      cells.push({ ahead: ahead + (side * layout.along) / 2 - ROOF_MARGIN * side, beside: beside - (side * layout.across) / 2 });
    }
    cells.push({ ahead, beside });
  }
  return cells;
}

/** How many models a subject lays, without building any of them. */
function piecesCount(subject: GallerySubject): number {
  if (subject === 'vehicles') return VEHICLE_CLASSES.length;
  if (subject === 'people') return appearanceCount();
  return GALLERY_PROPS.length;
}
