// PerspectiveCalibration.js
//
// Turns the four things the user actually knows —
//
//   * where the origin is in the photograph,
//   * where a second known point is in the photograph,
//   * the elevation difference between them,
//   * the horizontal distance between them,
//
// — into a camera (pitch, height, distance to the origin) whose projection puts
// those two points back exactly where the user tapped them.
//
// ---------------------------------------------------------------------------
// THE SOLVE
// ---------------------------------------------------------------------------
//
// Both reference points lie in the measurement plane, which projects to the
// line of sight. So each one contributes a single number: its coordinate `t`
// along that line, i.e. an angle above the optical axis
//
//     alpha = atan(t / focalPx)
//
// With the camera pitched down by `theta`, the ray to a point makes a
// depression angle below horizontal of
//
//     beta = theta - alpha
//
// and simple trigonometry from the camera at height h gives
//
//     tan(beta_near) = (h - Y_near) / Z_near
//     tan(beta_far)  = (h - Y_far)  / Z_near + D
//
// where Y is elevation relative to the origin, so Y_origin is 0 by definition.
// Note "near" and "far", not "origin" and "known": either reference point may
// be the closer one. Photographing a house from its yard puts the foundation —
// the natural origin — at the FAR end of the sight line, so assuming the origin
// is nearest would make that whole workflow impossible to calibrate.
//
// Two equations. Three unknowns (theta, h, Z_near) — genuinely one short, which
// is why the app offers a fine-tune control rather than pretending it can solve
// everything. Fixing any ONE of the three closes the system.
//
// Fixing `theta` is the nicest case because it is linear:
//
//     (h - Y_far)*cot(beta_far) - (h - Y_near)*cot(beta_near) = D
//  => h = (D + Y_far*cot(beta_far) - Y_near*cot(beta_near))
//         / (cot(beta_far) - cot(beta_near))
//
// So `solveFromPitch` is closed form, and the other two modes ("I know roughly
// how high the camera was" / "I know roughly how far away the origin is") are
// found by root-finding on pitch over that same closed form. Every mode keeps
// both reference points pinned to the pixels the user tapped.

import { DEG, sub, dot, normalize, perp, add, scale, bisect } from './Geometry.js';
import { PerspectiveProjection } from './PerspectiveProjection.js';

/** Guard band keeping the solver away from the tan() poles. */
const EPS = 1e-4;

/**
 * Everything the solver needs that does not depend on the camera, derived once
 * per calibration attempt.
 */
export function calibrationContext({
  imageWidth,
  imageHeight,
  fovDeg,
  originPoint,
  knownPoint,
  deltaElevation,
  horizontalDistance,
  knownIsFarther = true,
}) {
  const focalPx = imageWidth / 2 / Math.tan((fovDeg * DEG) / 2);

  // The image frame runs from the near reference point to the far one, because
  // increasing distance must mean increasing `t`. Which of the two is which is
  // the user's call, not an assumption.
  const nearPoint = knownIsFarther ? originPoint : knownPoint;
  const farPoint = knownIsFarther ? knownPoint : originPoint;
  const nearY = knownIsFarther ? 0 : deltaElevation;
  const farY = knownIsFarther ? deltaElevation : 0;

  const d = normalize(sub(farPoint, nearPoint));
  const n = perp(d);
  const centre = { x: imageWidth / 2, y: imageHeight / 2 };
  const P0 = add(nearPoint, scale(d, dot(sub(centre, nearPoint), d)));
  const tNear = dot(sub(nearPoint, P0), d);
  const tFar = dot(sub(farPoint, P0), d);

  return {
    imageWidth,
    imageHeight,
    fovDeg,
    focalPx,
    d,
    n,
    P0,
    tNear,
    tFar,
    alphaNear: Math.atan2(tNear, focalPx),
    alphaFar: Math.atan2(tFar, focalPx),
    nearY,
    farY,
    knownIsFarther,
    deltaElevation,
    horizontalDistance,
    originPoint: { ...originPoint },
    knownPoint: { ...knownPoint },
    nearPoint: { ...nearPoint },
    farPoint: { ...farPoint },
  };
}

/**
 * Closed-form camera for a given pitch.
 * @returns {{pitchRad,cameraHeight,originDistance,knownDistance}|null}
 */
export function solveFromPitch(pitchRad, ctx) {
  const { alphaNear, alphaFar, nearY, farY, horizontalDistance: D, knownIsFarther } = ctx;
  const betaNear = pitchRad - alphaNear;
  const betaFar = pitchRad - alphaFar;
  const tanNear = Math.tan(betaNear);
  const tanFar = Math.tan(betaFar);
  if (!Number.isFinite(tanNear) || !Number.isFinite(tanFar)) return null;
  if (Math.abs(tanNear) < EPS || Math.abs(tanFar) < EPS) return null; // ray at the horizon
  const cotNear = 1 / tanNear;
  const cotFar = 1 / tanFar;
  const den = cotFar - cotNear;
  if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return null;

  const h = (D + farY * cotFar - nearY * cotNear) / den;
  const zNear = (h - nearY) * cotNear;
  const zFar = (h - farY) * cotFar;
  if (![h, zNear, zFar].every(Number.isFinite)) return null;
  // Both reference points must be in front of the camera, and the far one must
  // really be farther — otherwise the solution is a mirror-image artefact.
  if (!(zNear > 1e-6) || !(zFar > 1e-6)) return null;
  if (Math.abs(zFar - (zNear + D)) > 1e-6 * Math.max(1, Math.abs(zFar))) return null;

  return {
    pitchRad,
    cameraHeight: h,
    originDistance: knownIsFarther ? zNear : zFar,
    knownDistance: knownIsFarther ? zFar : zNear,
    nearDistance: zNear,
    farDistance: zFar,
  };
}

/** The open interval of pitches for which a solution can exist. */
export function pitchDomain(ctx) {
  // beta_A must be a real depression angle strictly inside (-90, 90) degrees,
  // and the same for beta_B.
  const lo = Math.max(ctx.alphaNear, ctx.alphaFar) - Math.PI / 2 + EPS;
  const hi = Math.min(ctx.alphaNear, ctx.alphaFar) + Math.PI / 2 - EPS;
  return { lo, hi };
}

/**
 * Sample the pitch domain, keeping only pitches that yield a valid camera.
 * Returns runs of consecutive valid samples so callers can root-find inside a
 * single continuous branch instead of jumping across a pole.
 */
function validRuns(ctx, samples = 1400) {
  const { lo, hi } = pitchDomain(ctx);
  if (!(hi > lo)) return [];
  const runs = [];
  let current = null;
  for (let i = 0; i <= samples; i++) {
    const theta = lo + ((hi - lo) * i) / samples;
    const sol = solveFromPitch(theta, ctx);
    if (sol) {
      if (!current) {
        current = [];
        runs.push(current);
      }
      current.push({ theta, sol });
    } else {
      current = null;
    }
  }
  return runs;
}

/**
 * Root-find pitch so that `valueOf(solution)` equals `target`.
 * Searches every continuous branch and returns the closest match.
 */
function solveForValue(ctx, valueOf, target) {
  let best = null;
  for (const run of validRuns(ctx)) {
    for (let i = 1; i < run.length; i++) {
      const f0 = valueOf(run[i - 1].sol) - target;
      const f1 = valueOf(run[i].sol) - target;
      if (!Number.isFinite(f0) || !Number.isFinite(f1)) continue;
      if (f0 === 0) return run[i - 1].sol;
      if (f0 > 0 !== f1 > 0) {
        const theta = bisect(
          (th) => {
            const s = solveFromPitch(th, ctx);
            return s ? valueOf(s) - target : NaN;
          },
          run[i - 1].theta,
          run[i].theta,
        );
        if (theta != null) {
          const sol = solveFromPitch(theta, ctx);
          if (sol) {
            const err = Math.abs(valueOf(sol) - target);
            if (!best || err < best.err) best = { sol, err };
          }
        }
      }
    }
  }
  return best ? best.sol : null;
}

export const solveForCameraHeight = (ctx, height) =>
  solveForValue(ctx, (s) => s.cameraHeight, height);

export const solveForOriginDistance = (ctx, distance) =>
  solveForValue(ctx, (s) => s.originDistance, distance);

/**
 * Pick a sensible camera when the user has not fine-tuned anything yet: aim for
 * `preferredHeight` (eye level) and, failing that, take the middle of the widest
 * valid branch so the user always gets *something* to drag.
 */
export function initialSolution(ctx, preferredHeight = 5.5) {
  const wanted = solveForCameraHeight(ctx, preferredHeight);
  if (wanted) return wanted;
  const runs = validRuns(ctx);
  if (!runs.length) return null;
  let widest = runs[0];
  for (const run of runs) if (run.length > widest.length) widest = run;
  // Prefer a plausible standing height inside this branch if one exists.
  let best = widest[Math.floor(widest.length / 2)].sol;
  let bestErr = Infinity;
  for (const { sol } of widest) {
    const err = Math.abs(sol.cameraHeight - preferredHeight);
    if (sol.cameraHeight > 0 && err < bestErr) {
      bestErr = err;
      best = sol;
    }
  }
  return best;
}

/** Range of camera heights reachable for this photograph and reference pair. */
export function solutionRanges(ctx) {
  const runs = validRuns(ctx);
  const heights = [];
  const distances = [];
  for (const run of runs) {
    for (const { sol } of run) {
      heights.push(sol.cameraHeight);
      distances.push(sol.originDistance);
    }
  }
  if (!heights.length) return null;
  return {
    height: { min: Math.min(...heights), max: Math.max(...heights) },
    distance: { min: Math.min(...distances), max: Math.max(...distances) },
  };
}

/**
 * The user-facing entry point.
 *
 * @param {object} input
 * @param {'pitch'|'height'|'distance'} input.mode which quantity the user is holding fixed
 * @param {number} input.value the value of that quantity (pitch in radians)
 * @returns {{ok:boolean, reason?:string, projection?:PerspectiveProjection, solution?:object, context?:object}}
 */
export function calibrate(input) {
  const {
    imageWidth,
    imageHeight,
    fovDeg,
    originPoint,
    knownPoint,
    originElevation,
    knownElevation,
    horizontalDistance,
    knownIsFarther = true,
    mode = 'height',
    value = 5.5,
  } = input;

  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    return { ok: false, reason: 'No photograph loaded.' };
  }
  if (!originPoint || !knownPoint) {
    return { ok: false, reason: 'Set the origin and the second known point.' };
  }
  const separation = Math.hypot(knownPoint.x - originPoint.x, knownPoint.y - originPoint.y);
  if (separation < 8) {
    return { ok: false, reason: 'The two reference points are too close together in the photo.' };
  }
  if (!(horizontalDistance > 0)) {
    return { ok: false, reason: 'Horizontal distance must be greater than zero.' };
  }

  const ctx = calibrationContext({
    imageWidth,
    imageHeight,
    fovDeg,
    originPoint,
    knownPoint,
    deltaElevation: knownElevation - originElevation,
    horizontalDistance,
    knownIsFarther,
  });

  let solution = null;
  if (mode === 'pitch') solution = solveFromPitch(value, ctx);
  else if (mode === 'distance') solution = solveForOriginDistance(ctx, value);
  else solution = solveForCameraHeight(ctx, value);

  if (!solution) solution = initialSolution(ctx);
  if (!solution) {
    return {
      ok: false,
      reason:
        'No camera fits those numbers. Try a different field of view, or check the distance and elevations.',
      context: ctx,
    };
  }

  const projection = new PerspectiveProjection({
    imageWidth,
    imageHeight,
    fovDeg,
    pitchRad: solution.pitchRad,
    cameraHeight: solution.cameraHeight,
    // The sight line always runs near -> far, so `d` points away from camera.
    losA: ctx.nearPoint,
    losB: ctx.farPoint,
  });

  return { ok: true, projection, solution, context: ctx };
}
