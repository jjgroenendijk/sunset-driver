/**
 * The functions of `Math` that every engine rounds its own way, computed here
 * the same way everywhere.
 *
 * ECMAScript calls them implementation-approximated: an engine may round
 * `sin`, `cos`, `tan`, `atan`, `atan2`, `asin`, `acos`, `log`, `exp`, `pow`,
 * `hypot` and the rest as it likes. They do. Node 26 against the Chromium the
 * previews drive, over 20 000 arguments each:
 *
 * | engine | functions that differ from Node's |
 * | --- | --- |
 * | Chromium 141 | `sin`, `cos` |
 * | Chrome for Testing 153 | those two and `tan`, `exp`, `log`, `log2`, `log10`, `atan`, `asin`, `acos`, `atan2`, `cbrt`, `sinh`, `cosh` |
 *
 * The world is a pure function of its seed, so one of those last-place bits is
 * enough to turn a road tracer's step the other way, and the city the browser
 * builds then stops being the city Node builds. That was issue #243.
 *
 * Everything here is built from addition, subtraction, multiplication,
 * division, `Math.sqrt` and reading a double's bits. IEEE 754 defines all of
 * those exactly and ECMAScript requires them, so the same argument gives the
 * same bits in Node, in every browser, in a worker and on a peer's machine.
 *
 * The methods and the coefficients are fdlibm's. Accuracy is within about one
 * unit in the last place, which is what `Math` gives.
 *
 * `Math.abs`, `Math.min`, `Math.max`, `Math.floor`, `Math.ceil`, `Math.round`,
 * `Math.trunc`, `Math.sign`, `Math.imul` and `Math.sqrt` are exactly specified,
 * so they are left alone and the determinism lint allows them.
 */

/** 2/π, for counting quarter turns. */
const TWO_OVER_PI = 0.6366197723675814;

/**
 * π/2 as three doubles that sum to it far past double precision. The fold
 * subtracts them one at a time, so the bits of the argument that survive it
 * are not lost to rounding.
 */
const PIO2_HI = 1.5707963267948966;
const PIO2_MID = 6.123233995736766e-17;
const PIO2_LO = -1.4973849048591698e-33;

/** 2^27 + 1, the splitter Dekker's exact product uses. */
const SPLITTER = 134217729;

/** Coefficients of fdlibm's sine polynomial, for |r| within a quarter turn. */
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.7557313707070068e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

/** Coefficients of fdlibm's cosine polynomial, over the same range. */
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748e-9;
const C6 = -1.13596475577881948265e-11;

/**
 * What `a * b` lost to rounding, given the rounded `product`. Dekker's
 * splitting makes this exact, so `product + productError(a, b, product)` holds
 * the product to twice the precision one double carries. The fold needs that:
 * a plain `turns * π/2` loses one bit of the argument for every bit the turn
 * count carries.
 */
function productError(a: number, b: number, product: number): number {
  const ca = SPLITTER * a;
  const aHi = ca - (ca - a);
  const aLo = a - aHi;
  const cb = SPLITTER * b;
  const bHi = cb - (cb - b);
  const bLo = b - bHi;
  return aLo * bLo - (product - aHi * bHi - aLo * bHi - aHi * bLo);
}

/** sin(r) for |r| within a quarter turn. */
function sinCore(r: number): number {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

/** cos(r) for |r| within a quarter turn. */
function cosCore(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/**
 * What is left of `x` after `turns` quarter turns are taken off it.
 *
 * The product of the turn count and π/2 is taken exactly, in two halves, and
 * only then subtracted. Taken in one double instead it loses a bit of the
 * argument for every bit the turn count carries, which is how a large argument
 * drifts. The fold stays exact while the turn count does, which is every
 * argument under about 10^15 radians — far past any angle the game forms.
 */
function foldRest(x: number, turns: number): number {
  if (turns === 0) return x;
  const product = turns * PIO2_HI;
  // |x - product| is within a quarter turn of zero and the two share a sign,
  // so this subtraction is exact (Sterbenz) and none of x is lost here.
  let rest = x - product;
  rest -= productError(turns, PIO2_HI, product);
  rest -= turns * PIO2_MID;
  rest -= turns * PIO2_LO;
  return rest;
}

/**
 * Which quarter of the turn a fold landed in, 0 to 3. The turn count may be
 * larger than a 32-bit integer, so it is folded by hand rather than with a
 * bitwise and.
 */
function quarter(turns: number): number {
  return (((turns % 4) + 4) % 4);
}

/**
 * Sine, or cosine a quarter turn along, of `x` radians. The quarter turn the
 * fold lands in says which polynomial to evaluate and which sign it carries.
 */
function circle(x: number, quarterTurn: number): number {
  if (!Number.isFinite(x)) return NaN;
  const turns = Math.round(x * TWO_OVER_PI);
  const rest = foldRest(x, turns);
  switch (quarter(turns + quarterTurn)) {
    case 0:
      return sinCore(rest);
    case 1:
      return cosCore(rest);
    case 2:
      return -sinCore(rest);
    default:
      return -cosCore(rest);
  }
}

/** The sine of `x` radians, the same to the last bit on every engine. */
export function sin(x: number): number {
  // The polynomial turns a negative zero into a positive one, and the sign of
  // a zero reaches `Math.atan2`, so hand back the argument itself.
  return x === 0 ? x : circle(x, 0);
}

/** The cosine of `x` radians, the same to the last bit on every engine. */
export function cos(x: number): number {
  return circle(x, 1);
}

/** The tangent of `x` radians, the same to the last bit on every engine. */
export function tan(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x === 0) return x;
  const turns = Math.round(x * TWO_OVER_PI);
  const rest = foldRest(x, turns);
  // An odd quarter turn stands the tangent on its head. Taking it from the
  // folded remainder keeps the precision near a pole, where the remainder is
  // small and the answer is large.
  return quarter(turns) % 2 === 0 ? sinCore(rest) / cosCore(rest) : -cosCore(rest) / sinCore(rest);
}

/**
 * The four angles fdlibm's arc tangent folds towards — atan of 0.5, 1, 1.5 and
 * infinity — each as a double and the part of it a double cannot hold.
 */
const ATAN_FOLD = [
  [4.63647609000806093515e-1, 2.26987774529616870924e-17],
  [7.85398163397448278999e-1, 3.06161699786838301793e-17],
  [9.82793723247329054082e-1, 1.39033110312309984516e-17],
  [1.570796326794896558e0, 6.12323399573676603587e-17],
] as const;

/** Coefficients of fdlibm's arc tangent polynomial. */
const AT = [
  3.33333333333329318027e-1,
  -1.99999999998764832476e-1,
  1.42857142725034663711e-1,
  -1.1111110405462355788e-1,
  9.09088713343650656196e-2,
  -7.69187620504482999495e-2,
  6.66107313738753120669e-2,
  -5.83357013379057348645e-2,
  4.97687799461593236017e-2,
  -3.6531572744216915527e-2,
  1.62858201153657823623e-2,
] as const;

/** The arc tangent of `x`, in radians, the same to the last bit on every engine. */
export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? RIGHT_ANGLE : -RIGHT_ANGLE;
  const negative = x < 0 || Object.is(x, -0);
  let a = negative ? -x : x;
  let fold: readonly [number, number] | undefined;
  if (a < 0.4375) {
    // Below 2^-29 the polynomial is the argument itself, and squaring it would
    // underflow to nothing.
    if (a < 3.725290298461914e-9) return x;
  } else if (a < 0.6875) {
    fold = ATAN_FOLD[0];
    a = (2 * a - 1) / (2 + a);
  } else if (a < 1.1875) {
    fold = ATAN_FOLD[1];
    a = (a - 1) / (a + 1);
  } else if (a < 2.4375) {
    fold = ATAN_FOLD[2];
    a = (a - 1.5) / (1 + 1.5 * a);
  } else {
    fold = ATAN_FOLD[3];
    a = -1 / a;
  }
  const z = a * a;
  const w = z * z;
  const odd = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const even = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  const r = fold === undefined ? a - a * (odd + even) : fold[0] - (a * (odd + even) - fold[1] - a);
  return negative ? -r : r;
}

/** π, and the part of it a double cannot hold, as fdlibm splits them. */
const PI_HI = 3.141592653589793116e0;
const PI_LO = 1.2246467991473531772e-16;
const PI_HALF = 1.5707963267948966;
/** atan(∞), to the precision the arc tangent's own fold carries. */
const RIGHT_ANGLE = 1.570796326794896558 + 6.12323399573676603587e-17;
const PI_QUARTER = 0.7853981633974483;

/**
 * The angle from the positive x axis to (`x`, `y`), in radians, the same to
 * the last bit on every engine. The argument order is `Math.atan2`'s.
 */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const edge = atan2Edge(y, x);
  if (edge !== undefined) return edge;
  const z = atan(Math.abs(y / x));
  if (x > 0) return y > 0 ? z : -z;
  return y > 0 ? PI_HI - (z - PI_LO) : z - PI_LO - PI_HI;
}

/**
 * `atan2` where a side is zero or infinite, which the arc tangent is never
 * asked; undefined where both sides are finite and neither is zero.
 */
function atan2Edge(y: number, x: number): number | undefined {
  if (!Number.isFinite(x) && !Number.isFinite(y)) {
    const q = x > 0 ? PI_QUARTER : 3 * PI_QUARTER;
    return y > 0 ? q : -q;
  }
  if (y === 0) return atan2OnXAxis(y, x);
  if (x === 0 || !Number.isFinite(y)) return y > 0 ? PI_HALF : -PI_HALF;
  if (!Number.isFinite(x)) return atan2InfiniteX(y, x);
  return undefined;
}

/** `atan2` of a zero `y`, whose sign decides the answer. */
function atan2OnXAxis(y: number, x: number): number {
  // The sign of a zero decides the answer, so ask for it rather than compare.
  if (x > 0 || Object.is(x, 0)) return y;
  return Object.is(y, -0) ? -PI_HI : PI_HI;
}

/** `atan2` of an infinite `x` and a finite, non-zero `y`. */
function atan2InfiniteX(y: number, x: number): number {
  if (x > 0) return y > 0 ? 0 : -0;
  return y > 0 ? PI_HI + PI_LO : -(PI_HI + PI_LO);
}

/**
 * The arc sine of `x`, in radians, the same to the last bit on every engine.
 * Taken through the arc tangent, which keeps its accuracy at both ends: the
 * two square roots stay apart where `1 - x²` alone would cancel.
 */
export function asin(x: number): number {
  if (Number.isNaN(x) || x < -1 || x > 1) return NaN;
  if (x === 0) return x;
  return atan2(x, Math.sqrt(1 - x) * Math.sqrt(1 + x));
}

/** The arc cosine of `x`, in radians, the same to the last bit on every engine. */
export function acos(x: number): number {
  if (Number.isNaN(x) || x < -1 || x > 1) return NaN;
  return 2 * atan2(Math.sqrt(1 - x), Math.sqrt(1 + x));
}

/**
 * The length of the hypotenuse of (`x`, `y`), the same to the last bit on
 * every engine. The smaller side is divided by the larger before squaring, so
 * a pair a square root would overflow or underflow on still answers.
 */
export function hypot(x: number, y: number, z = 0): number {
  const a = Math.abs(x);
  const b = Math.abs(y);
  const c = Math.abs(z);
  // An infinite side wins even beside a NaN one, which is what `Math.hypot`
  // does, so it is asked for before the largest side — `Math.max` of anything
  // and a NaN is a NaN.
  if (a === Infinity || b === Infinity || c === Infinity) return Infinity;
  const most = Math.max(a, b, c);
  if (Number.isNaN(most)) return NaN;
  if (most === 0) return 0;
  // Every side is divided by the largest before squaring, so a pair a plain
  // square root would overflow or underflow on still answers, and the three
  // sides are summed once rather than folded in pairs.
  const ra = a / most;
  const rb = b / most;
  const rc = c / most;
  return most * Math.sqrt(ra * ra + rb * rb + rc * rc);
}

/**
 * A double taken apart and put back together. Reading the bits is exact and
 * every engine reads the same ones; the explicit big-endian flag means the
 * high word is the sign, the exponent and the top of the mantissa whatever the
 * machine stores them in.
 */
const bits = new DataView(new ArrayBuffer(8));

/** The high 32 bits of `x`: its sign, exponent and the top of its mantissa. */
function highWord(x: number): number {
  bits.setFloat64(0, x, false);
  return bits.getUint32(0, false);
}

/** `x` with its high 32 bits replaced. */
function withHighWord(x: number, high: number): number {
  bits.setFloat64(0, x, false);
  bits.setUint32(0, high >>> 0, false);
  return bits.getFloat64(0, false);
}

/** Exactly two to the power -1000, for stepping the exponential into the subnormals. */
const TWO_TO_MINUS_1000 = 9.33263618503218878990e-302;

/** ln 2, split so the product of it and a whole number keeps its low bits. */
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;

/** Coefficients of fdlibm's logarithm polynomial. */
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** The natural logarithm of `x`, the same to the last bit on every engine. */
export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return x;
  let value = x;
  let k = 0;
  let high = highWord(value);
  if (high < 0x0010_0000) {
    // Subnormal: scale it up by 2^54 and take the exponent off the answer.
    value *= 18014398509481984;
    k -= 54;
    high = highWord(value);
  }
  k += (high >> 20) - 1023;
  high &= 0x000f_ffff;
  // Put the mantissa either side of 1 rather than either side of √2, which is
  // what keeps the polynomial's argument small.
  const over = (high + 0x95f64) & 0x10_0000;
  value = withHighWord(value, high | (over ^ 0x3ff0_0000));
  k += over >> 20;
  const f = value - 1;
  const dk = k;
  // |f| is under 2^-20, where the polynomial is two terms.
  if ((0x000f_ffff & (2 + high)) < 3) return logNearOne(f, k);
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  if ((high - 0x6147a) | (0x6b851 - high)) {
    const half = 0.5 * f * f;
    return k === 0 ? f - (half - s * (half + r)) : dk * LN2_HI - (half - (s * (half + r) + dk * LN2_LO) - f);
  }
  return k === 0 ? f - s * (f - r) : dk * LN2_HI - (s * (f - r) - dk * LN2_LO - f);
}

/** `log` of `f + 1` times two to the `k`, where |f| is under 2^-20. */
function logNearOne(f: number, k: number): number {
  const dk = k;
  if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
  const r = f * f * (0.5 - 0.3333333333333333 * f);
  return k === 0 ? f - r : dk * LN2_HI - (r - dk * LN2_LO - f);
}

/** 1 / ln 2, for counting powers of two in the exponential. */
const INV_LN2 = 1.4426950408889634;

/** Where the exponential leaves the range of a double. */
const EXP_OVERFLOW = 709.782712893384;
const EXP_UNDERFLOW = -745.1332191019411;

/** Coefficients of fdlibm's exponential polynomial. */
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465239e-6;
const P5 = 4.13813679705723846039e-8;

/** How many powers of two `exp` takes out of `x`, whose size is `a`, over half of ln 2. */
function wholePowersOfTwo(x: number, a: number): number {
  if (a < 1.0397207708399179) return x > 0 ? 1 : -1;
  return Math.round(INV_LN2 * x);
}

/** Euler's number raised to `x`, the same to the last bit on every engine. */
export function exp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return x;
  if (x === -Infinity) return 0;
  if (x > EXP_OVERFLOW) return Infinity;
  if (x < EXP_UNDERFLOW) return 0;
  const a = Math.abs(x);
  let k = 0;
  let hi = 0;
  let lo = 0;
  let r = x;
  if (a > 0.34657359027997264) {
    // Over half of ln 2: take out whole powers of two and work on the rest.
    k = wholePowersOfTwo(x, a);
    hi = x - k * LN2_HI;
    lo = k * LN2_LO;
    r = hi - lo;
  } else if (a < 3.725290298461914e-9) {
    // Under 2^-28 the answer is 1 + x to the last bit.
    return 1 + x;
  }
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const y = k === 0 ? 1 - ((r * c) / (c - 2) - r) : 1 - (lo - (r * c) / (2 - c) - hi);
  if (k === 0) return y;
  // The power of two goes straight into the exponent rather than through a
  // multiplication: `y` is between 0.5 and 2, so a `k` of 1024 still leaves a
  // number a double can hold, where multiplying by 2^1024 would not. Below the
  // subnormal edge it is added in two steps for the same reason.
  if (k >= -1021) return withHighWord(y, highWord(y) + (k << 20));
  return withHighWord(y, highWord(y) + ((k + 1000) << 20)) * TWO_TO_MINUS_1000;
}
