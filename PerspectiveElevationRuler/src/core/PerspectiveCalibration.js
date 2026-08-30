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

/**
 * The open interval of pitches for which a solution can exist: every ray must
 * be a real depression angle strictly inside (-90, 90) degrees.
 */
export function pitchDomainForAlphas(a, b) {
  return {
    lo: Math.max(a, b) - Math.PI / 2 + EPS,
    hi: Math.min(a, b) + Math.PI / 2 - EPS,
  };
}

/** The open interval of pitches for which a solution can exist. */
export function pitchDomain(ctx) {
  return ctx.wallHeight != null
    ? pitchDomainForAlphas(ctx.alphaFoundation, ctx.alphaWall)
    : pitchDomainForAlphas(ctx.alphaNear, ctx.alphaFar);
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

// ---------------------------------------------------------------------------
// CALIBRATING AGAINST A BUILDING
// ---------------------------------------------------------------------------
//
// A better set of inputs when there is a building in the shot, because none of
// them is a horizontal distance — the one number that is genuinely hard to know
// standing in a yard. Instead:
//
//   * the foundation, where the wall meets the ground,
//   * a point up the wall at a height you DO know (a course of siding, a door
//     head, a story pole),
//   * the horizon, which you can usually see.
//
// The two wall points sit at the same distance and differ only in elevation, so
// with the horizon fixing the pitch the system closes exactly:
//
//     tan(beta_foundation) = h / Z
//     tan(beta_wall)       = (h - W) / Z
//  => Z = W / (tan beta_foundation - tan beta_wall)
//     h = Z * tan beta_foundation
//
// Closed form, no searching, and nothing under-determined: the scale comes from
// the wall height and the shape from the field of view.
//
// The sight line runs UP the wall, which is consistent: raising a point's
// elevation always raises its along-sight coordinate (dt/dY = f*Z/zc^2 > 0),
// just as moving it farther away does.
//
// What this does NOT give you is the grade below the foundation. Both reference
// points are on the wall, so nothing here observes the ground; that grade is a
// separate input rather than something the app can pretend to derive.

/** Everything the wall solver needs that does not depend on the camera. */
export function wallContext({
  imageWidth,
  imageHeight,
  fovDeg,
  foundationPoint,
  wallPoint,
  wallHeight,
}) {
  const focalPx = imageWidth / 2 / Math.tan((fovDeg * DEG) / 2);
  // Up the wall is the direction of increasing elevation, and of increasing
  // distance too, so this is the same sight-line axis the projection uses.
  const d = normalize(sub(wallPoint, foundationPoint));
  const n = perp(d);
  const centre = { x: imageWidth / 2, y: imageHeight / 2 };
  const P0 = add(foundationPoint, scale(d, dot(sub(centre, foundationPoint), d)));
  const tFoundation = dot(sub(foundationPoint, P0), d);
  const tWall = dot(sub(wallPoint, P0), d);

  return {
    imageWidth,
    imageHeight,
    fovDeg,
    focalPx,
    d,
    n,
    P0,
    tFoundation,
    tWall,
    alphaFoundation: Math.atan2(tFoundation, focalPx),
    alphaWall: Math.atan2(tWall, focalPx),
    wallHeight,
    foundationPoint: { ...foundationPoint },
    wallPoint: { ...wallPoint },
  };
}

/**
 * Closed-form camera for a given pitch, which the horizon sets directly.
 * @returns {{pitchRad,cameraHeight,originDistance,knownDistance}|null}
 */
export function solveWallFromPitch(pitchRad, ctx) {
  const betaFoundation = pitchRad - ctx.alphaFoundation;
  const betaWall = pitchRad - ctx.alphaWall;
  const limit = Math.PI / 2 - EPS;
  // Both rays must point forwards. Without this a pitch that wraps past the
  // vertical produces a tangent with the right sign and a mirror-image camera.
  if (Math.abs(betaFoundation) > limit || Math.abs(betaWall) > limit) return null;

  const tanFoundation = Math.tan(betaFoundation);
  const tanWall = Math.tan(betaWall);
  const den = tanFoundation - tanWall;
  if (!Number.isFinite(den) || !(den > 1e-9)) return null;

  const Z = ctx.wallHeight / den;
  const cameraHeight = Z * tanFoundation;
  if (!(Z > 1e-6) || !Number.isFinite(cameraHeight)) return null;

  // The camera may sit below the foundation (looking up at a house on a rise),
  // so a negative height is legitimate and deliberately not rejected.
  return { pitchRad, cameraHeight, originDistance: Z, knownDistance: Z };
}

/** A starting pitch that puts the camera at about eye height, to be dragged from. */
export function initialWallSolution(ctx, preferredHeight = 5.5) {
  const { lo, hi } = pitchDomainForAlphas(ctx.alphaFoundation, ctx.alphaWall);
  if (!(hi > lo)) return null;
  const N = 1400;
  let best = null;
  let previous = null;
  for (let i = 0; i <= N; i++) {
    const theta = lo + ((hi - lo) * i) / N;
    const sol = solveWallFromPitch(theta, ctx);
    if (!sol) {
      previous = null;
      continue;
    }
    if (previous) {
      const f0 = previous.sol.cameraHeight - preferredHeight;
      const f1 = sol.cameraHeight - preferredHeight;
      if (f0 === 0) return previous.sol;
      if (f0 > 0 !== f1 > 0) {
        const root = bisect(
          (th) => {
            const s = solveWallFromPitch(th, ctx);
            return s ? s.cameraHeight - preferredHeight : NaN;
          },
          previous.theta,
          theta,
        );
        const exact = root == null ? null : solveWallFromPitch(root, ctx);
        if (exact) return exact;
      }
    }
    const err = Math.abs(sol.cameraHeight - preferredHeight);
    if (!best || err < best.err) best = { err, sol };
    previous = { theta, sol };
  }
  return best ? best.sol : null;
}

/**
 * Find the pitch that puts the wall at a known distance.
 *
 * A site survey measures that distance from pins on a plan, which pins down the
 * one degree of freedom the photograph leaves open — so the horizon can be
 * placed by measurement instead of by eye. Z is monotonic in pitch within a
 * branch, so a scan and a bisection find it.
 *
 * @returns {object|null} the solution, or null if no camera puts the wall there
 */
export function solveWallForDistance(ctx, targetDistance) {
  if (!(targetDistance > 0)) return null;
  const { lo, hi } = pitchDomainForAlphas(ctx.alphaFoundation, ctx.alphaWall);
  if (!(hi > lo)) return null;

  const N = 1400;
  let previous = null;
  let best = null;
  for (let i = 0; i <= N; i++) {
    const theta = lo + ((hi - lo) * i) / N;
    const sol = solveWallFromPitch(theta, ctx);
    if (!sol) {
      previous = null;
      continue;
    }
    if (previous) {
      const f0 = previous.sol.originDistance - targetDistance;
      const f1 = sol.originDistance - targetDistance;
      if (f0 === 0) return previous.sol;
      if (f0 > 0 !== f1 > 0) {
        const root = bisect(
          (th) => {
            const x = solveWallFromPitch(th, ctx);
            return x ? x.originDistance - targetDistance : NaN;
          },
          previous.theta,
          theta,
        );
        const exact = root == null ? null : solveWallFromPitch(root, ctx);
        if (exact) return exact;
      }
    }
    const err = Math.abs(sol.originDistance - targetDistance);
    if (!best || err < best.err) best = { err, sol };
    previous = { theta, sol };
  }
  // Only accept a near miss; a wall the photograph cannot put there at all is
  // a disagreement worth reporting, not one to paper over.
  return best && best.err < targetDistance * 0.02 ? best.sol : null;
}

/**
 * Calibrate from a building: foundation, a known height up the wall, and the
 * horizon. `pitchRad` comes straight from where the horizon is placed.
 */
export function calibrateFromWall(input) {
  const {
    imageWidth,
    imageHeight,
    fovDeg,
    foundationPoint,
    wallPoint,
    wallHeight,
    pitchRad = null,
  } = input;

  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    return { ok: false, reason: 'No photograph loaded.' };
  }
  if (!foundationPoint || !wallPoint) {
    return { ok: false, reason: 'Mark the foundation and a known height up the wall.' };
  }
  if (!(wallHeight > 0)) {
    return { ok: false, reason: 'Wall height must be greater than zero.' };
  }
  const separation = Math.hypot(wallPoint.x - foundationPoint.x, wallPoint.y - foundationPoint.y);
  if (separation < 8) {
    return { ok: false, reason: 'The foundation and wall marks are too close together in the photo.' };
  }

  const ctx = wallContext({ imageWidth, imageHeight, fovDeg, foundationPoint, wallPoint, wallHeight });

  let solution = pitchRad == null ? null : solveWallFromPitch(pitchRad, ctx);
  if (!solution) solution = initialWallSolution(ctx);
  if (!solution) {
    return {
      ok: false,
      reason: 'No camera fits that wall. Check the wall height, or try a different field of view.',
      context: ctx,
    };
  }

  const projection = new PerspectiveProjection({
    imageWidth,
    imageHeight,
    fovDeg,
    pitchRad: solution.pitchRad,
    cameraHeight: solution.cameraHeight,
    // The sight line runs up the wall: increasing elevation and increasing
    // distance are the same direction along it.
    losA: foundationPoint,
    losB: wallPoint,
  });

  return { ok: true, projection, solution, context: ctx };
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
