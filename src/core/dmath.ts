// Deterministic math. Math.sin/cos/atan2/hypot are allowed to differ in the
// last bit between JS engines, and the layout makes accept/reject decisions on
// geometry, so a one-ulp difference could move a building. These use only
// + - * / and sqrt, which IEEE 754 requires to be correctly rounded.

export const PI = 3.141592653589793;
export const TAU = 2 * PI;

function reduce(x: number): number {
  // to [-PI, PI]
  x = x - TAU * Math.floor(x / TAU);
  if (x > PI) x -= TAU;
  return x;
}

/** Sine by a short series, the same on every engine (Math.sin may round differently). */
export function sin(x: number): number {
  x = reduce(x);
  // fold into [-PI/2, PI/2]
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  // Taylor to x^15; error < 1e-12 on [-PI/2, PI/2]
  let t = x, s = x;
  for (let n = 1; n <= 7; n++) {
    t *= -x2 / ((2 * n) * (2 * n + 1));
    s += t;
  }
  return s;
}

/** Cosine, from sin. */
export function cos(x: number): number {
  return sin(x + PI / 2);
}

/** The length of (x, y): a plain square root, which every engine rounds alike. */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Round to a centimetre grid so tiny float noise never reaches a decision. */
export function q(x: number): number {
  return Math.round(x * 100) / 100;
}

/** atan for any x, by halving the angle twice and a short series. */
function atan(x: number): number {
  if (x < 0) return -atan(-x);
  if (x > 1) return PI / 2 - atan(1 / x);
  // atan(x) = 2 atan(x / (1 + sqrt(1 + x^2))); twice brings x under 0.2.
  const h1 = x / (1 + Math.sqrt(1 + x * x));
  const h2 = h1 / (1 + Math.sqrt(1 + h1 * h1));
  const x2 = h2 * h2;
  let t = h2, s = h2;
  for (let n = 1; n <= 9; n++) {
    t *= -x2;
    s += t / (2 * n + 1);
  }
  return 4 * s;
}

/** The angle of (x, y), in (-PI, PI]. */
export function atan2(y: number, x: number): number {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : 0;
}
