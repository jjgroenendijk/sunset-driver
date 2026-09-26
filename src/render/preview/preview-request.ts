/**
 * What a preview is asked for and what it answers (`preview.ts`). The scripts
 * that drive the preview import these through `preview.ts`.
 */
import type { FrameContents } from '../frame/frame-contents.ts';
import type { HeavyShow } from './preview-heavy.ts';

/** Where to stand, how far back to look from, and how big a picture to take. */
export interface PreviewRequest {
  seed: number;
  x: number;
  y: number;
  /**
   * Camera distance at rest, in metres. Left out, it is the game's own
   * `BASE_DISTANCE`, or what it takes to hold a gallery when one is laid.
   */
  distance?: number;
  /** Which way the player faces, in radians. The camera leads this direction. */
  heading: number;
  /** How fast the player moves, in metres per second. It pulls the camera back. */
  speed: number;
  width: number;
  height: number;
  /** The hour of the day to light the frame at, 0 to 24 (spec section 10.5). */
  hour: number;
  /**
   * The quality tier to draw at, by name (spec section 9.2). Left out, the
   * frame is the game at full quality; named, it is what a machine that
   * cannot hold the frame ends up looking at.
   */
  quality?: string;
  /**
   * What a building between the camera and the player does (spec section
   * 10.7): `see-through`, `pull-back`, `turn` or `whole`. Left out, it is
   * see-through, as the game starts.
   */
  buildings?: string;
  /**
   * The view to draw from (spec section 10.7): `top-down`, `third-person` or
   * `first-person`. Left out, it is top down, as the game starts.
   */
  view?: string;
  /**
   * Degrees to tilt a chase view up from where it looks, so the sky is in the
   * frame. The game camera never looks up this far; a preview of the sky has to.
   */
  lookUp?: number;
  /**
   * A place to frame instead of the player: a point on the map, and metres over
   * the ground there. The camera keeps its pitch, heading and distance and moves
   * so the place is where the player would be; the player stays where they stand.
   */
  lookAt?: { x: number; y: number; height: number };
  /**
   * The class of vehicle to stand the player in, by name (spec section 11.3).
   * Left out, or named something the roster does not hold, it is the class a
   * session starts in.
   */
  vehicle?: string;
  /**
   * Set to stand the player beside their vehicle rather than in it, which is
   * how the character of spec sections 11.1 and 11.5 is looked at.
   */
  onFoot?: boolean;
  /**
   * The stance to hold the player in, for looking at the movement of spec
   * sections 11.2 and 11.5 in a still frame: `stand`, `walk`, `air` or `swim`.
   * Left out, they stand. A cycle has no still of its own, so the frame is
   * taken a quarter of the way through, where the swing is widest.
   */
  stance?: string;
  /**
   * A moment of the player getting in or out (`boarding.ts`): `in:0.4` or
   * `out:0.7`, with `:1` after it to go through the far side. A move in starts
   * from two metres off the door and a little behind it.
   */
  board?: string;
  /**
   * How far through a swing of a melee weapon to hold the player, 0 to 1 (spec
   * section 11.6). Left out, nothing is being swung. The blow is thrown and
   * over in a fifth of a second, so a still is the only way to look at it.
   */
  swing?: number;
  /**
   * The damage state to show the vehicle in, by name (spec section 11.3):
   * `dented`, `smoking`, `burning` or `burnt`. Left out, the vehicle is
   * straight out of the showroom.
   */
  damage?: string;
  /** The leaves to draw open (spec section 11.3): `doors`, `bonnet` or `all`. */
  open?: string;
  /**
   * Set to lay a drift's worth of skid marks into the road behind the vehicle
   * (spec section 11.3), which is the one way to look at them in a still frame.
   */
  skid?: boolean;
  /**
   * Set to put the emergency services of spec section 20.3 in the picture: a
   * blaze in the road ahead, with a fire engine standing at it and an
   * ambulance behind. They are put down rather than driven to, because a
   * preview is one frame and a call takes the best part of a minute.
   */
  emergency?: boolean;
  /**
   * Set to show the rounds of spec section 11.6 in the air: a shotgun blast
   * the way the player faces, a tick old, and a pistol round two ticks before
   * it. What they meet is laid by hand, since a preview casts nothing.
   */
  shots?: boolean;
  /** Set to show the heavy weapons of spec section 11.6: a flame stream, a rocket, a blast and smoke. */
  heavy?: HeavyShow;
  /**
   * Set to lay casualties of spec section 11.6 in the road ahead: two dead,
   * and one each falling, rising, crawling, limping and thrown. With
   * {@link PreviewRequest.emergency} the ambulance's medics kneel at one.
   */
  bodies?: boolean;
  /**
   * Set to lay the police on foot of spec section 14 in the road ahead: a
   * patrol pair and a SWAT officer aiming at the player, an officer walking a
   * beat, and one who has been put down.
   */
  police?: boolean;
  /**
   * Set to stand the mission contacts of spec section 18 on their own corners,
   * with the marker over each head, and to take the picture at the one nearest
   * the place asked for. It overrides where the player stands, as `--shop` does.
   */
  contacts?: boolean;
  /**
   * The weapon to put in the player's hands, by id (spec section 11.6). It is
   * drawn only with {@link PreviewRequest.onFoot}, as in the game.
   */
  weapon?: string;
  /** The attachments to fit to that weapon and to the pickups, by name. */
  attachments?: string[];
  /** Set to hold the weapon at the shoulder rather than at the hip. */
  aim?: boolean;
  /**
   * Set to lay every weapon of the arsenal on the ground ahead of the player as
   * a pickup, in rows, which is how the silhouettes are compared.
   */
  pickups?: boolean;
  /** The index of the laid pickup to draw as the one under the mouse, grown to its full hover size. */
  hover?: number;
  /**
   * The trade of the shop to stand the player inside (spec section 16.1), by
   * name, or `any` for the nearest shop of any trade. It is the one way to look
   * at an interior: the frame is taken from inside the room, with the vehicle
   * left at the kerb, and it overrides {@link PreviewRequest.onFoot}.
   */
  shop?: string;
  /**
   * The subject of a gallery to lay in rows ahead of the player: `vehicles`,
   * `people` or `props` (`preview-gallery.ts`). The camera is pointed at the
   * middle of the grid and stood back far enough to hold it, unless
   * {@link PreviewRequest.lookAt} or {@link PreviewRequest.distance} says
   * otherwise.
   */
  gallery?: string;
  /**
   * Set to wait only for the chunks of the near ring before drawing, rather
   * than for both rings. The frame is ready in about half the time, and a
   * chunk of the far ring that has not landed yet is missing from it, so the
   * same request twice may not take the same picture.
   */
  fast?: boolean;
  /** `clear`, `rain`, `fog`, `storm`, or `seed` for the seed's own. Left out, clear. */
  weather?: string;
}

/** The picture, and what the frame cost to build. */
export interface PreviewResult {
  width: number;
  height: number;
  /** Where the frame was taken from, which `--shop` moves off what was asked for. */
  x: number;
  y: number;
  /** The rows, top row first, three bytes a pixel, base64 encoded. */
  rgb: string;
  /** Milliseconds spent generating the world, 0 when the world was kept from the last request. */
  worldMs: number;
  /** True when the scene and its chunks were kept from the last request, of the same seed and tier. */
  kept: boolean;
  /** Milliseconds spent building the chunks around the player. */
  chunkMs: number;
  /** Milliseconds spent drawing and reading back the frame. */
  frameMs: number;
  /** Draw calls the dearest chunk built costs: ground, roads and buildings. */
  peakDrawCalls: number;
  /** Lights the scene holds: the sun, the sky fill and the street lamp pool. */
  lights: number;
  /** Shadow maps the sun is split into (spec section 10.5). */
  shadows: number;
  /** The quality tier the frame was drawn at (spec section 9.2). */
  quality: string;
  /** Vehicles of the traffic drawn round the player (spec section 13.1). */
  traffic: number;
  /** Parked cars drawn round the player (spec section 13.1). */
  parked: number;
  /** People of the crowd drawn round the player (spec section 13.1). */
  pedestrians: number;
  /** Buildings, street lamps and posters inside the view (`frame-contents.ts`). */
  holds: FrameContents;
  /** What a gallery laid, in the order it lies: the near row first, left to right. */
  gallery?: string[];
}
