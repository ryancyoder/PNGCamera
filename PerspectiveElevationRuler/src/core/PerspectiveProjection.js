// PerspectiveProjection.js
//
// The camera model. Pure maths — it knows about a photograph only as a width
// and a height in pixels, and never touches the DOM.
//
// ---------------------------------------------------------------------------
// WORLD COORDINATES
// ---------------------------------------------------------------------------
//
//   X = horizontal, across the line of sight (positive = image-right)
//   Y = elevation, relative to the origin's elevation (positive = up)
//   Z = horizontal distance from the camera, along the line of sight
//
// The camera sits at (0, cameraHeight, 0) and looks along +Z, tilted down by
// `pitch`. Because a real camera looking along a line of sight necessarily lies
// *in* the vertical plane containing that line of sight, the measurement plane
// is exactly the plane X = 0.
//
// That is the key simplification of this whole app: a plane that passes through
// the camera centre projects to a straight LINE in the image. So the vertical
// measurement plane appears in the photograph as the single "line of sight"
// line the user places in step 4, and every point of the ruler lands on it.
//
// ---------------------------------------------------------------------------
// IMAGE COORDINATES
// ---------------------------------------------------------------------------
//
// Rather than assume the photograph is level, we build an image-space frame
// from the user's line of sight:
//
//   d  unit vector along the line of sight, pointing away from the camera
//      (towards the horizon). Increasing distance always moves this way.
//   n  = perp(d), the image direction that world +X projects onto.
//   P0 the principal point: the foot of the perpendicular from the image
//      centre onto the line of sight. The optical axis of a camera inside the
//      measurement plane must lie on that line; where exactly it sits along the
//      line is a gauge freedom absorbed by `pitch`, so the closest point to the
//      image centre is both legal and the least surprising choice.
//
// A world point therefore lands at  P0 + t*d + s*n  with t and s from the usual
// pinhole division. `d` doubles as the image-space "up towards the horizon"
// axis, which is what lets the same code work on rolled/tilted photographs.

import { DEG, add, scale, sub, dot, perp, normalize, clipSegmentToRect } from './Geometry.js';

export class PerspectiveProjection {
  /**
   * @param {object} p
   * @param {number} p.imageWidth   photograph width in pixels
   * @param {number} p.imageHeight  photograph height in pixels
   * @param {number} p.fovDeg       horizontal field of view ("perspective strength")
   * @param {number} p.pitchRad     camera tilt, positive = aimed below horizontal
   * @param {number} p.cameraHeight camera height above the origin's elevation
   * @param {{x,y}}  p.losA         image point on the line of sight (the origin)
   * @param {{x,y}}  p.losB         a second image point, FARTHER from the camera
   */
  constructor({ imageWidth, imageHeight, fovDeg, pitchRad, cameraHeight, losA, losB }) {
    this.imageWidth = imageWidth;
    this.imageHeight = imageHeight;
    this.fovDeg = fovDeg;
    this.pitchRad = pitchRad;
    this.cameraHeight = cameraHeight;
    this.losA = { ...losA };
    this.losB = { ...losB };

    // Focal length in pixels from the horizontal field of view.
    this.focalPx = imageWidth / 2 / Math.tan((fovDeg * DEG) / 2);

    // Image-space frame. `d` points from the near reference point towards the
    // far one, which is always the "away from the camera" direction.
    this.d = normalize(sub(this.losB, this.losA));
    this.n = perp(this.d);

    // Principal point: the point of the line of sight closest to the image
    // centre.
    const centre = { x: imageWidth / 2, y: imageHeight / 2 };
    this.P0 = add(this.losA, scale(this.d, dot(sub(centre, this.losA), this.d)));

    this._sinP = Math.sin(pitchRad);
    this._cosP = Math.cos(pitchRad);
  }

  // --- forward projection -------------------------------------------------

  /**
   * Project a world point onto the photograph.
   * @returns {{x:number,y:number,depth:number}|null} null if behind the camera.
   */
  project(X, Y, Z) {
    const dy = Y - this.cameraHeight;
    // Camera basis: forward = (0, -sin, cos), up = (0, cos, sin), right = X.
    const yc = dy * this._cosP + Z * this._sinP;
    const zc = -dy * this._sinP + Z * this._cosP;
    if (!(zc > 1e-6)) return null;
    const t = (this.focalPx * yc) / zc;
    const s = (this.focalPx * X) / zc;
    return {
      x: this.P0.x + t * this.d.x + s * this.n.x,
      y: this.P0.y + t * this.d.y + s * this.n.y,
      depth: zc,
    };
  }

  /** Project a point that lies in the measurement plane (X = 0). */
  projectPlane(Y, Z) {
    return this.project(0, Y, Z);
  }

  // --- image space <-> ray ------------------------------------------------

  /**
   * Split an image point into its along-the-line-of-sight coordinate `t` and
   * its perpendicular offset `across`. Any point with a non-zero `across` is
   * off the measurement plane; the app reports that to the user rather than
   * silently pretending the tap was on the plane.
   */
  toLineCoords(p) {
    const r = sub(p, this.P0);
    return { t: dot(r, this.d), across: dot(r, this.n) };
  }

  /** Image point for a coordinate along the line of sight. */
  fromLineCoords(t, across = 0) {
    return add(this.P0, add(scale(this.d, t), scale(this.n, across)));
  }

  /** Angle of a line-of-sight coordinate above the optical axis. */
  alphaFor(t) {
    return Math.atan2(t, this.focalPx);
  }

  /**
   * Depression angle below horizontal of the view ray through `t`.
   * Positive = the ray heads downwards.
   */
  depressionFor(t) {
    return this.pitchRad - this.alphaFor(t);
  }

  /**
   * Intersect the view ray through image coordinate `t` with a straight ground
   * line running along the measurement plane. The ground line is defined by the
   * calibration: elevation 0 at distance `originDistance`, rising with `slope`
   * (rise over run).
   * @returns {{Y:number,Z:number}|null}
   */
  intersectGround(t, slope, originDistance) {
    const tanB = Math.tan(this.depressionFor(t));
    if (!Number.isFinite(tanB)) return null;
    const den = slope + tanB;
    if (Math.abs(den) < 1e-9) return null; // ray parallel to the ground line
    const Z = (this.cameraHeight + slope * originDistance) / den;
    if (!(Z > 1e-6) || !Number.isFinite(Z)) return null;
    return { Z, Y: slope * (Z - originDistance) };
  }

  /**
   * Elevation of the view ray through `t` at a known distance `Z`. Used when
   * the user measures against a vertical staff instead of the ground.
   */
  elevationAtDepth(t, Z) {
    if (!(Z > 1e-6)) return null;
    const tanB = Math.tan(this.depressionFor(t));
    if (!Number.isFinite(tanB)) return null;
    return { Z, Y: this.cameraHeight - Z * tanB };
  }

  /**
   * Distance along the line of sight at which the measurement plane reaches
   * elevation `Y` on the ray through `t`. Inverse of the above.
   */
  depthForElevation(t, Y) {
    const tanB = Math.tan(this.depressionFor(t));
    if (!Number.isFinite(tanB) || Math.abs(tanB) < 1e-9) return null;
    const Z = (this.cameraHeight - Y) / tanB;
    return Z > 1e-6 ? Z : null;
  }

  // --- horizon / vanishing point -----------------------------------------

  /** Line-of-sight coordinate of the horizon (points at infinite distance). */
  get horizonT() {
    return this.focalPx * Math.tan(this.pitchRad);
  }

  /** The vanishing point of the line of sight, in image pixels. */
  get vanishingPoint() {
    return this.fromLineCoords(this.horizonT);
  }

  /**
   * The horizon as a segment clipped to the photograph. Every horizontal world
   * plane vanishes on this line, so it runs perpendicular to `d`.
   */
  horizonSegment(margin = 0) {
    const vp = this.vanishingPoint;
    const span = (this.imageWidth + this.imageHeight) * 2;
    const a = add(vp, scale(this.n, -span));
    const b = add(vp, scale(this.n, span));
    return clipSegmentToRect(a, b, {
      x: -margin,
      y: -margin,
      width: this.imageWidth + margin * 2,
      height: this.imageHeight + margin * 2,
    });
  }

  /** True when the whole model is finite and usable. */
  get isFinite() {
    return (
      Number.isFinite(this.focalPx) &&
      Number.isFinite(this.pitchRad) &&
      Number.isFinite(this.cameraHeight) &&
      Number.isFinite(this.P0.x) &&
      Number.isFinite(this.P0.y)
    );
  }
}
