// Geometry.js
//
// Tiny 2D vector helpers plus a few numeric utilities. No DOM, no canvas — this
// file (and everything else in src/core) is pure mathematics so it can be unit
// tested under Node and reused by any renderer.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const vec = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function normalize(a, fallback = { x: 0, y: -1 }) {
  const l = Math.hypot(a.x, a.y);
  if (!(l > 1e-12)) return { ...fallback };
  return { x: a.x / l, y: a.y / l };
}

// Right-hand perpendicular of `d`. With `d` pointing "up" the image
// (0, -1) this returns (+1, 0), i.e. image-right. See PerspectiveProjection
// for why that particular handedness matters.
export const perp = (d) => ({ x: -d.y, y: d.x });

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Signed distance of `p` from the infinite line through `origin` with unit
// direction `dir`, split into the along-line and across-line components.
export function decompose(p, origin, dir) {
  const r = sub(p, origin);
  return { along: dot(r, dir), across: dot(r, perp(dir)) };
}

// Foot of the perpendicular from `p` onto the infinite line (origin, dir).
export function footOnLine(p, origin, dir) {
  const t = dot(sub(p, origin), dir);
  return add(origin, scale(dir, t));
}

// Shortest distance from `p` to the segment ab (used for hit testing).
export function distToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return dist(p, a);
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return dist(p, add(a, scale(ab, t)));
}

// Clip a segment against an axis-aligned rectangle (Liang–Barsky). Returns
// null when the segment misses the rectangle entirely. Used to keep long
// projected lines (horizon, ground line) inside the photograph.
export function clipSegmentToRect(a, b, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tests = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    a: { x: a.x + t0 * dx, y: a.y + t0 * dy },
    b: { x: a.x + t1 * dx, y: a.y + t1 * dy },
  };
}

// Bisection root finder. `f` must change sign across [lo, hi].
export function bisect(f, lo, hi, iterations = 80) {
  let flo = f(lo);
  let fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo > 0 === fhi > 0) return null;
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const m = 0.5 * (a + b);
    const fm = f(m);
    if (!Number.isFinite(fm)) return null;
    if (fm === 0) return m;
    if (fm > 0 === flo > 0) {
      a = m;
      flo = fm;
    } else {
      b = m;
      fhi = fm;
    }
  }
  return 0.5 * (a + b);
}

// Round to a fixed number of decimals, avoiding "-0.00".
export function round(value, decimals = 2) {
  const f = 10 ** decimals;
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r;
}
