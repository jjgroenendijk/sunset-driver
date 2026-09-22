/**
 * The pictures the map icons are drawn from (spec section 12). A glyph traces
 * a silhouette into the current path, inside a box `2 * r` across and centred
 * on the origin; the caller fills it, so the same drawing serves an icon filled
 * in its colour, one knocked out of a coloured disc, and one inside a pin.
 *
 * A glyph traces subpaths only. It never calls `beginPath`, `fill` or `stroke`,
 * and it never changes a style: whoever draws the icon owns those.
 *
 * Every solid part is wound clockwise and every hole anticlockwise, so the fill
 * is the default `nonzero` one: two solid parts that overlap join into one, and
 * only a hole cuts. An `evenodd` fill would cancel the overlap instead, which
 * is how an anchor loses its shank where the stock crosses it.
 */

/** Trace one silhouette into the current path of `ctx`, in a box of `2 * r`. */
export type GlyphPath = (ctx: CanvasRenderingContext2D, r: number) => void;

type Pt = readonly [number, number];

/** Twice the signed area of a ring. Positive is clockwise on screen, where y is down. */
function area(points: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i] as Pt;
    const [x1, y1] = points[(i + 1) % points.length] as Pt;
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

/** A ring, wound the way `clockwise` asks whichever way its points were listed. */
function ring(ctx: CanvasRenderingContext2D, r: number, points: readonly Pt[], clockwise: boolean): void {
  const ordered = area(points) > 0 === clockwise ? points : [...points].reverse();
  ordered.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * r, y * r);
    else ctx.lineTo(x * r, y * r);
  });
  ctx.closePath();
}

/** A solid polygon, in units of `r`. */
function poly(ctx: CanvasRenderingContext2D, r: number, points: readonly Pt[]): void {
  ring(ctx, r, points, true);
}

/** A polygon cut out of whatever it lies on. */
function cut(ctx: CanvasRenderingContext2D, r: number, points: readonly Pt[]): void {
  ring(ctx, r, points, false);
}

/** A solid rectangle, in units of `r`. */
function box(ctx: CanvasRenderingContext2D, r: number, x: number, y: number, w: number, h: number): void {
  poly(ctx, r, [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]);
}

/** A rectangle cut out of whatever it lies on. */
function cutBox(ctx: CanvasRenderingContext2D, r: number, x: number, y: number, w: number, h: number): void {
  cut(ctx, r, [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]);
}

/** A solid circle as a subpath of its own. */
function circle(ctx: CanvasRenderingContext2D, r: number, cx: number, cy: number, rad: number): void {
  ctx.moveTo((cx + rad) * r, cy * r);
  ctx.arc(cx * r, cy * r, rad * r, 0, Math.PI * 2);
  ctx.closePath();
}

/** A circle cut out of whatever it lies on. */
function cutCircle(ctx: CanvasRenderingContext2D, r: number, cx: number, cy: number, rad: number): void {
  ctx.moveTo((cx + rad) * r, cy * r);
  ctx.arc(cx * r, cy * r, rad * r, Math.PI * 2, 0, true);
  ctx.closePath();
}

/**
 * A band of a ring: out along the arc from `a0` to `a1` at `outer`, and back at
 * `inner`. This is how a stroke is drawn as a silhouette, so it can be knocked
 * out of a disc like the rest of the glyph.
 */
function band(
  ctx: CanvasRenderingContext2D,
  r: number,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  a0: number,
  a1: number,
): void {
  ctx.moveTo((cx + Math.cos(a0) * outer) * r, (cy + Math.sin(a0) * outer) * r);
  ctx.arc(cx * r, cy * r, outer * r, a0, a1);
  ctx.lineTo((cx + Math.cos(a1) * inner) * r, (cy + Math.sin(a1) * inner) * r);
  ctx.arc(cx * r, cy * r, inner * r, a1, a0, true);
  ctx.closePath();
}

/** A solid bar from one point to another, `w` wide. */
function bar(ctx: CanvasRenderingContext2D, r: number, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  poly(ctx, r, [
    [x0 + nx, y0 + ny],
    [x1 + nx, y1 + ny],
    [x1 - nx, y1 - ny],
    [x0 - nx, y0 - ny],
  ]);
}

/** A star of `points` points, solid, between the two radii. */
function star(ctx: CanvasRenderingContext2D, r: number, cx: number, cy: number, outer: number, inner: number, points: number): void {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 === 0 ? outer : inner;
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  poly(ctx, r, pts);
}

/** A star cut out of whatever it lies on. */
function cutStar(ctx: CanvasRenderingContext2D, r: number, cx: number, cy: number, outer: number, inner: number, points: number): void {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 === 0 ? outer : inner;
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  cut(ctx, r, pts);
}

/** The glyphs, by name. Several are alternates for one kind of place. */
export const GLYPHS = Object.freeze({
  /** The player: an arrow pointing the way they face. */
  arrow: (ctx, r) =>
    poly(ctx, r, [
      [1, 0],
      [-0.7, 0.7],
      [-0.35, 0],
      [-0.7, -0.7],
    ]),

  /** A waypoint: a teardrop with its point on the place, and a hole in it. */
  pin: (ctx, r) => {
    ctx.moveTo(0, r);
    ctx.bezierCurveTo(-0.62 * r, -0.1 * r, -0.78 * r, -0.4 * r, -0.62 * r, -0.66 * r);
    ctx.bezierCurveTo(-0.34 * r, -1.12 * r, 0.34 * r, -1.12 * r, 0.62 * r, -0.66 * r);
    ctx.bezierCurveTo(0.78 * r, -0.4 * r, 0.62 * r, -0.1 * r, 0, r);
    ctx.closePath();
    cutCircle(ctx, r, 0, -0.58, 0.27);
  },

  /** An objective: a five-pointed star. */
  star: (ctx, r) => star(ctx, r, 0, 0, 1, 0.45, 5),

  /** A tram stop: the front of a tram car, with its pole up to the wire. */
  tram: (ctx, r) => {
    bar(ctx, r, 0, -0.55, 0.5, -0.98, 0.15); // the pole
    poly(ctx, r, [
      [-0.74, -0.7],
      [0.74, -0.7],
      [0.74, 0.6],
      [0.52, 0.88],
      [-0.52, 0.88],
      [-0.74, 0.6],
    ]);
    cutBox(ctx, r, -0.54, -0.52, 1.08, 0.6); // the windscreen
    cutCircle(ctx, r, -0.36, 0.44, 0.17); // the lamps
    cutCircle(ctx, r, 0.36, 0.44, 0.17);
  },

  /** A metro station: the underground's own mark, a ring with a bar across. */
  roundel: (ctx, r) => {
    band(ctx, r, 0, 0, 0.82, 0.5, 0, Math.PI * 2);
    box(ctx, r, -1, -0.18, 2, 0.36);
  },

  /** A pier: a deck on its pilings, standing in the water. */
  pier: (ctx, r) => {
    box(ctx, r, -1, -0.72, 2, 0.3);
    for (const x of [-0.82, -0.12, 0.58] as const) box(ctx, r, x, -0.5, 0.24, 0.84);
    // The water it stands in, so the deck is not read as a roof on columns.
    poly(ctx, r, [
      [-1, 0.56],
      [-0.5, 0.36],
      [0, 0.56],
      [0.5, 0.36],
      [1, 0.56],
      [1, 0.86],
      [0.5, 0.66],
      [0, 0.86],
      [-0.5, 0.66],
      [-1, 0.86],
    ]);
  },

  /** A car park: the letter P. */
  parkingP: (ctx, r) => {
    box(ctx, r, -0.62, -0.92, 0.38, 1.84);
    band(ctx, r, -0.24, -0.44, 0.64, 0.26, -Math.PI / 2, Math.PI / 2);
  },

  /** A harbour: an anchor. */
  anchor: (ctx, r) => {
    band(ctx, r, 0, -0.74, 0.3, 0.13, 0, Math.PI * 2); // the ring
    box(ctx, r, -0.12, -0.62, 0.24, 1.5); // the shank
    box(ctx, r, -0.62, -0.38, 1.24, 0.22); // the stock
    band(ctx, r, 0, 0.14, 0.82, 0.58, 0.16, Math.PI - 0.16); // the arms
    poly(ctx, r, [
      [-0.98, 0.58],
      [-0.56, 0.86],
      [-0.62, 0.34],
    ]); // the flukes
    poly(ctx, r, [
      [0.98, 0.58],
      [0.56, 0.86],
      [0.62, 0.34],
    ]);
  },

  /** A safehouse: a house with a door. */
  house: (ctx, r) => {
    poly(ctx, r, [
      [0, -0.95],
      [0.98, -0.02],
      [0.72, -0.02],
      [0.72, 0.92],
      [-0.72, 0.92],
      [-0.72, -0.02],
      [-0.98, -0.02],
    ]);
    cutBox(ctx, r, -0.22, 0.28, 0.44, 0.64); // the door
  },

  /** A workshop: a spanner, laid across the box. */
  wrench: (ctx, r) => {
    ctx.save();
    ctx.rotate(-Math.PI / 4);
    band(ctx, r, 0, -0.52, 0.5, 0.24, Math.PI * 0.74, Math.PI * 0.26); // the open jaw
    box(ctx, r, -0.18, -0.6, 0.36, 1.55); // the handle
    ctx.restore();
  },

  /** A clinic: a cross. */
  cross: (ctx, r) => {
    box(ctx, r, -0.34, -0.95, 0.68, 1.9);
    box(ctx, r, -0.95, -0.34, 1.9, 0.68);
  },

  /** The police: a shield with a star cut out of it. */
  shieldStar: (ctx, r) => {
    ctx.moveTo(0, -0.95 * r);
    ctx.lineTo(0.85 * r, -0.62 * r);
    ctx.lineTo(0.85 * r, 0.14 * r);
    ctx.bezierCurveTo(0.85 * r, 0.62 * r, 0.44 * r, 0.9 * r, 0, 0.98 * r);
    ctx.bezierCurveTo(-0.44 * r, 0.9 * r, -0.85 * r, 0.62 * r, -0.85 * r, 0.14 * r);
    ctx.lineTo(-0.85 * r, -0.62 * r);
    ctx.closePath();
    cutStar(ctx, r, 0, -0.06, 0.5, 0.22, 5);
  },

  /** A contact with work: a speech bubble with a mark in it. */
  speech: (ctx, r) => {
    poly(ctx, r, [
      [-0.95, -0.88],
      [0.95, -0.88],
      [0.95, 0.32],
      [-0.16, 0.32],
      [-0.5, 0.95],
      [-0.56, 0.32],
      [-0.95, 0.32],
    ]);
    cutBox(ctx, r, -0.13, -0.66, 0.26, 0.62); // the stroke of the mark
    cutBox(ctx, r, -0.13, 0.06, 0.26, 0.2); // its dot
  },

  /** A dealer: a tied pouch. */
  pouch: (ctx, r) => {
    poly(ctx, r, [
      [-0.3, -0.66],
      [0.3, -0.66],
      [0.24, -0.26],
      [-0.24, -0.26],
    ]); // the neck
    ctx.moveTo(-0.26 * r, -0.3 * r);
    ctx.bezierCurveTo(-0.98 * r, 0.1 * r, -0.82 * r, 0.96 * r, 0, 0.96 * r);
    ctx.bezierCurveTo(0.82 * r, 0.96 * r, 0.98 * r, 0.1 * r, 0.26 * r, -0.3 * r);
    ctx.closePath();
    box(ctx, r, -0.56, -0.92, 1.12, 0.22); // the tie
  },

  /** An enforcer coming at the player: a muzzle burst. */
  burst: (ctx, r) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      bar(ctx, r, Math.cos(a) * 0.32, Math.sin(a) * 0.32, Math.cos(a), Math.sin(a), 0.24);
    }
    circle(ctx, r, 0, 0, 0.22);
  },

  /** An officer on foot: a star badge. */
  badge: (ctx, r) => {
    star(ctx, r, 0, 0, 0.98, 0.46, 6);
    cutCircle(ctx, r, 0, 0, 0.2);
  },

  /** A happening: pennants on a line. */
  bunting: (ctx, r) => {
    box(ctx, r, -1, -0.74, 2, 0.2);
    for (let i = 0; i < 3; i++) {
      const cx = -1 + ((i + 0.5) / 3) * 2;
      poly(ctx, r, [
        [cx - 0.31, -0.56],
        [cx + 0.31, -0.56],
        [cx, 0.72],
      ]);
    }
  },

  /** An incident: a bolt. */
  bolt: (ctx, r) =>
    poly(ctx, r, [
      [0.52, -0.98],
      [-0.52, 0.06],
      [0.02, 0.06],
      [-0.34, 0.98],
      [0.68, -0.12],
      [0.12, -0.12],
    ]),

  /** A gun shop: a pistol, its barrel to the right and its grip under the rear. */
  pistol: (ctx, r) => {
    box(ctx, r, -0.55, -0.72, 1.53, 0.42); // the slide
    poly(ctx, r, [
      [-0.62, -0.5],
      [-0.12, -0.5],
      [-0.34, 0.96],
      [-0.96, 0.96],
    ]); // the grip
    box(ctx, r, -0.2, -0.36, 0.16, 0.5); // the trigger
    band(ctx, r, 0.02, -0.3, 0.42, 0.28, Math.PI * 0.08, Math.PI * 0.92); // the guard
  },

  /** A clothes shop: a shirt. */
  shirt: (ctx, r) =>
    poly(ctx, r, [
      [-0.3, -0.8],
      [-0.94, -0.42],
      [-0.66, 0.04],
      [-0.56, 0.04],
      [-0.56, 0.92],
      [0.56, 0.92],
      [0.56, 0.04],
      [0.66, 0.04],
      [0.94, -0.42],
      [0.3, -0.8],
      [0.17, -0.52],
      [-0.17, -0.52],
    ]),

  /** A food shop: a basket. */
  basket: (ctx, r) => {
    band(ctx, r, 0, -0.16, 0.54, 0.34, Math.PI, Math.PI * 2); // the handle
    poly(ctx, r, [
      [-0.94, -0.18],
      [0.94, -0.18],
      [0.66, 0.92],
      [-0.66, 0.92],
    ]);
    for (const x of [-0.34, 0.06] as const) {
      cut(ctx, r, [
        [x, 0.06],
        [x + 0.26, 0.06],
        [x + 0.21, 0.66],
        [x + 0.05, 0.66],
      ]);
    }
  },

  /** A property broker: a key. */
  key: (ctx, r) => {
    band(ctx, r, -0.5, 0, 0.5, 0.22, 0, Math.PI * 2);
    box(ctx, r, -0.1, -0.14, 1.08, 0.28);
    box(ctx, r, 0.42, -0.14, 0.22, 0.58);
    box(ctx, r, 0.78, -0.14, 0.2, 0.44);
  },

} satisfies Readonly<Record<string, GlyphPath>>);

/** The name of one glyph in {@link GLYPHS}. */
export type GlyphName = keyof typeof GLYPHS;
