/**
 * The lettering on the trams and their stops, drawn (spec section 13.2): the
 * route number and destination on each tram's boards, and the stop's name with
 * the countdown to the next tram on the panel in each shelter.
 *
 * Every line of text a world can show is one cell of one atlas
 * (`tram-sign-art.ts`), so all of this is one material and one mesh. The lines
 * change from frame to frame — a tram passes a stop and its board turns over,
 * a countdown runs down — which instancing cannot express without a per-
 * instance attribute, so the mesh is written out fresh each frame instead: a
 * few dozen quads, four vertices each, into buffers allocated once. That is one
 * draw call for the lot.
 *
 * The quads stand just proud of the boxes they letter, which `tram-mesh.ts` and
 * `tram-stops.ts` own and export the places of. They are drawn on both sides,
 * because a quad this thin at this distance shows its back to a camera that has
 * barely moved.
 *
 * The letters burn with the lamps the rest of the tram lights by, so
 * {@link TramSignView.lamps} takes the same number as the fleet's.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { TRAM_CARS, type TramLine } from '../../sim/transit/tram.ts';
import { boardPlace } from './tram-mesh.ts';
import { TIMETABLE, TRAM_STOP_VIEW } from './tram-stops.ts';
import { countdownCell, destinationCell, stopNameCell, tramSignAtlas } from './tram-sign-art.ts';
import { TRAFFIC_VIEW } from '../vehicles/traffic.ts';
import { texture, uniform, uv } from '../tsl.ts';

/** How hard the lettering burns once the lamps are full on. */
const SIGN_GLOW = 2.4;

/** Metres the lettering stands proud of the box it is written on. */
const PROUD = 0.031;

/** The two lines of the panel on a shelter: the stop's name over the countdown. */
const PANEL_LINE = 0.145;
const PANEL_WIDTH = TIMETABLE.width - 0.16;
const PANEL_HEIGHT = 0.2;

export class TramSignView {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly line: TramLine;
  private readonly map: DataTexture;
  private readonly material: MeshStandardNodeMaterial;
  private readonly lit = uniform(0);
  private readonly cells: number;
  private readonly position: Float32Array;
  private readonly normal: Float32Array;
  private readonly coord: Float32Array;
  private readonly geometry: BufferGeometry;
  private quads = 0;

  constructor(line: TramLine) {
    this.line = line;
    const names = line.calls.map((_, stop) => line.stopName(stop));
    const atlas = tramSignAtlas(names);
    this.cells = atlas.cells;
    this.map = new DataTexture(atlas.data, atlas.width, atlas.height, RGBAFormat, UnsignedByteType);
    // The atlas is drawn in the colours the letters are printed in, so it is
    // read as sRGB. No mipmaps: the cells have no gutter between them, and a
    // mipmap would mix one line of text into the next along the seam.
    this.map.colorSpace = SRGBColorSpace;
    this.map.generateMipmaps = false;
    this.map.minFilter = LinearFilter;
    this.map.magFilter = LinearFilter;
    this.map.needsUpdate = true;
    this.material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.7, side: DoubleSide });
    const ink = texture(this.map).sample(uv());
    this.material.colorNode = ink;
    this.material.emissiveNode = ink.rgb.mul(this.lit).mul(SIGN_GLOW);
    const cap = Math.max(4, line.trams * 2 + line.stopPlaces().length * 2);
    this.position = new Float32Array(cap * 12);
    this.normal = new Float32Array(cap * 12);
    this.coord = new Float32Array(cap * 8);
    const index = new Uint16Array(cap * 6);
    for (let q = 0; q < cap; q++) {
      index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    }
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.position, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normal, 3));
    this.geometry.setAttribute('uv', new BufferAttribute(this.coord, 2));
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.mesh = new Mesh(this.geometry, this.material);
    // The quads are written in world space, so the mesh never leaves the origin
    // and its bounds cannot be worked out once.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.group.add(this.mesh);
  }

  /** How far on the lettering is, 0 by day and 1 after dark. */
  set lamps(amount: number) {
    this.lit.value = amount;
  }

  get lamps(): number {
    return this.lit.value;
  }

  /** How many lines of text the last frame drew. */
  get drawn(): number {
    return this.quads;
  }

  /** Letter every board and every panel round a place at a moment. */
  update(time: number, x: number, y: number): void {
    this.quads = 0;
    this.writeBoards(time, x, y);
    this.writePanels(time, x, y);
    this.geometry.setDrawRange(0, this.quads * 6);
    this.mesh.visible = this.quads > 0;
    for (const name of ['position', 'normal', 'uv']) {
      (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
    }
  }

  /**
   * The destination board at each end of every tram in view. The leading end of
   * the first car and the trailing end of the last carry it, and a board at the
   * trailing end is the same box read facing the other way.
   */
  private writeBoards(time: number, x: number, y: number): void {
    const pose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    for (let tram = 0; tram < this.line.trams; tram++) {
      const design = this.line.design(tram);
      const cell = destinationCell(this.line.nextCall(tram, time), design);
      const place = boardPlace(design);
      for (const end of [0, TRAM_CARS - 1]) {
        const at = this.line.carPose(tram, end, time, pose);
        if (Math.abs(at.x - x) > TRAFFIC_VIEW || Math.abs(at.y - y) > TRAFFIC_VIEW) continue;
        const heading = at.heading + (end === 0 ? 0 : Math.PI);
        const forwardX = Math.cos(heading);
        const forwardZ = Math.sin(heading);
        this.quad(
          at.x + forwardX * place.x,
          at.height + place.y,
          at.y + forwardZ * place.x,
          forwardX,
          forwardZ,
          place.width / 2,
          place.height / 2,
          cell,
        );
      }
    }
  }

  /** The stop's name over the minutes to the next tram, on the panel in every shelter in view. */
  private writePanels(time: number, x: number, y: number): void {
    const stops = this.line.calls.length;
    for (const place of this.line.stopPlaces()) {
      if (Math.abs(place.x - x) > TRAM_STOP_VIEW || Math.abs(place.y - y) > TRAM_STOP_VIEW) continue;
      // The panel faces across the platform, which is the stop's own `+z`.
      const outX = -Math.sin(place.heading);
      const outZ = Math.cos(place.heading);
      const alongX = Math.cos(place.heading);
      const alongZ = Math.sin(place.heading);
      const depth = TIMETABLE.z + PROUD;
      const centreX = place.x + alongX * TIMETABLE.x + outX * depth;
      const centreZ = place.y + alongZ * TIMETABLE.x + outZ * depth;
      const lines = [
        { rise: PANEL_LINE, cell: stopNameCell(stops, place.stop) },
        { rise: -PANEL_LINE, cell: countdownCell(stops, this.line.minutesTo(place.stop, time)) },
      ];
      for (const line of lines) {
        this.quad(centreX, place.height + TIMETABLE.y + line.rise, centreZ, outX, outZ, PANEL_WIDTH / 2, PANEL_HEIGHT / 2, line.cell);
      }
    }
  }

  /**
   * One quad facing `(outX, outZ)`, centred on a world point, showing one cell
   * of the atlas. Its own up is the world's, because nothing lettered here ever
   * rolls.
   */
  private quad(cx: number, cy: number, cz: number, outX: number, outZ: number, halfWide: number, halfTall: number, cell: number): void {
    if (this.quads * 4 >= this.position.length / 3) return;
    // Right of the face, which is the world's up turned into it.
    const rightX = outZ;
    const rightZ = -outX;
    const at = this.quads * 12;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const top = cell / this.cells;
    const bottom = (cell + 1) / this.cells;
    for (let i = 0; i < 4; i++) {
      const [side, rise] = corners[i] as [number, number];
      this.position[at + i * 3] = cx + rightX * side * halfWide;
      this.position[at + i * 3 + 1] = cy + rise * halfTall;
      this.position[at + i * 3 + 2] = cz + rightZ * side * halfWide;
      this.normal[at + i * 3] = outX;
      this.normal[at + i * 3 + 1] = 0;
      this.normal[at + i * 3 + 2] = outZ;
      this.coord[this.quads * 8 + i * 2] = side > 0 ? 1 : 0;
      this.coord[this.quads * 8 + i * 2 + 1] = rise > 0 ? top : bottom;
    }
    this.quads++;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.map.dispose();
    this.group.clear();
  }
}
