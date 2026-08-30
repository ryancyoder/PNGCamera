// Unit tests for the projection / calibration core.
//   node tests/run.mjs
//
// Strategy: build a synthetic camera whose parameters we know, project world
// points through it to get "taps", then hand only the taps and the user-facing
// measurements back to the calibrator and check it recovers the camera.

import { PerspectiveProjection } from '../src/core/PerspectiveProjection.js';
import { calibrate, solveFromPitch, calibrationContext } from '../src/core/PerspectiveCalibration.js';
import { ElevationModel } from '../src/core/ElevationModel.js';
import { ElevationRuler } from '../src/core/ElevationRuler.js';
import { DEG } from '../src/core/Geometry.js';

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function close(name, actual, expected, tol) {
  const delta = Math.abs(actual - expected);
  ok(name, delta <= tol, `got ${actual}, expected ${expected} (±${tol}), off by ${delta}`);
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

const IMAGE = { imageWidth: 4032, imageHeight: 3024 };

function makeCamera({ fovDeg = 60, pitchDeg = 10, cameraHeight = 6 } = {}) {
  // A provisional projection just to generate synthetic taps. The line of sight
  // is the vertical centre line, which is what an unrolled camera inside the
  // measurement plane produces.
  return new PerspectiveProjection({
    ...IMAGE,
    fovDeg,
    pitchRad: pitchDeg * DEG,
    cameraHeight,
    losA: { x: IMAGE.imageWidth / 2, y: IMAGE.imageHeight },
    losB: { x: IMAGE.imageWidth / 2, y: 0 },
  });
}

group('PerspectiveProjection — basic behaviour', () => {
  const cam = makeCamera({ pitchDeg: 0, cameraHeight: 6 });

  // Straight ahead at eye level lands on the principal point.
  const ahead = cam.project(0, 6, 100);
  close('point at eye level projects to the principal point (t)', cam.toLineCoords(ahead).t, 0, 1e-6);

  // Something farther away is nearer the horizon, i.e. larger t.
  const near = cam.project(0, 0, 20);
  const far = cam.project(0, 0, 200);
  ok('farther points sit closer to the horizon', cam.toLineCoords(far).t > cam.toLineCoords(near).t);

  // Equal elevation steps compress with distance — the whole point of the app.
  const g = (Z) => cam.toLineCoords(cam.projectPlane(0, Z)).t;
  const stepNear = Math.abs(g(20) - g(21));
  const stepFar = Math.abs(g(200) - g(201));
  ok('perspective compresses equal steps with distance', stepFar < stepNear * 0.05);

  // Behind the camera is rejected rather than mirrored into the frame.
  ok('points behind the camera are rejected', cam.project(0, 0, -10) === null);

  // World +X maps to image-right when the line of sight runs up the image.
  const right = cam.project(10, 0, 50);
  const centre = cam.project(0, 0, 50);
  ok('world +X projects to image-right', right.x > centre.x);
});

group('PerspectiveCalibration — recovers a known camera', () => {
  const truth = { fovDeg: 60, pitchDeg: 12, cameraHeight: 5.5 };
  const cam = makeCamera(truth);
  const originElevation = 100;
  const knownElevation = 103;
  const horizontalDistance = 40;
  const originDistanceTruth = 35;

  const originPoint = cam.projectPlane(0, originDistanceTruth);
  const knownPoint = cam.projectPlane(
    knownElevation - originElevation,
    originDistanceTruth + horizontalDistance,
  );

  const result = calibrate({
    ...IMAGE,
    fovDeg: truth.fovDeg,
    originPoint,
    knownPoint,
    originElevation,
    knownElevation,
    horizontalDistance,
    mode: 'height',
    value: truth.cameraHeight,
  });

  ok('calibration succeeds', result.ok, result.reason);
  close('recovers camera height', result.solution.cameraHeight, truth.cameraHeight, 1e-4);
  close('recovers pitch', result.solution.pitchRad / DEG, truth.pitchDeg, 1e-3);
  close('recovers origin distance', result.solution.originDistance, originDistanceTruth, 1e-3);

  // The acid test: the calibrated camera must put the taps back where they were.
  const reA = result.projection.projectPlane(0, result.solution.originDistance);
  const reB = result.projection.projectPlane(3, result.solution.originDistance + horizontalDistance);
  close('origin reprojects onto its tap (x)', reA.x, originPoint.x, 0.05);
  close('origin reprojects onto its tap (y)', reA.y, originPoint.y, 0.05);
  close('known point reprojects onto its tap (x)', reB.x, knownPoint.x, 0.05);
  close('known point reprojects onto its tap (y)', reB.y, knownPoint.y, 0.05);
});

group('PerspectiveCalibration — every solve mode pins the reference points', () => {
  const cam = makeCamera({ fovDeg: 55, pitchDeg: 8, cameraHeight: 5 });
  const originPoint = cam.projectPlane(0, 30);
  const knownPoint = cam.projectPlane(2.5, 70);
  const base = {
    ...IMAGE,
    fovDeg: 55,
    originPoint,
    knownPoint,
    originElevation: 100,
    knownElevation: 102.5,
    horizontalDistance: 40,
  };

  for (const [mode, value] of [
    ['height', 5],
    ['height', 12],
    ['distance', 30],
    ['distance', 60],
    ['pitch', 8 * DEG],
    ['pitch', 14 * DEG],
  ]) {
    const r = calibrate({ ...base, mode, value });
    if (!r.ok) {
      ok(`mode ${mode}=${value} solves`, false, r.reason);
      continue;
    }
    const p = r.projection;
    const s = r.solution;
    const a = p.projectPlane(0, s.originDistance);
    const b = p.projectPlane(2.5, s.originDistance + 40);
    const errA = Math.hypot(a.x - originPoint.x, a.y - originPoint.y);
    const errB = Math.hypot(b.x - knownPoint.x, b.y - knownPoint.y);
    ok(
      `mode ${mode}=${value} keeps both taps pinned`,
      errA < 0.1 && errB < 0.1,
      `origin off by ${errA.toFixed(4)}px, known off by ${errB.toFixed(4)}px`,
    );
    // And it actually honoured what the user asked for.
    if (mode === 'height') close(`  → height is ${value}`, s.cameraHeight, value, 1e-3);
    if (mode === 'distance') close(`  → distance is ${value}`, s.originDistance, value, 1e-3);
    if (mode === 'pitch') close(`  → pitch is ${value}`, s.pitchRad, value, 1e-9);
  }
});

group('PerspectiveCalibration — tolerates a rolled photograph', () => {
  // Roll the taps about the image centre. A camera inside the measurement plane
  // always has its principal point on the line of sight, so rolling must not
  // change the recovered geometry at all.
  const cam = makeCamera({ fovDeg: 60, pitchDeg: 12, cameraHeight: 5.5 });
  const rot = (p, deg) => {
    const c = { x: IMAGE.imageWidth / 2, y: IMAGE.imageHeight / 2 };
    const a = deg * DEG;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
  };
  const originPoint = rot(cam.projectPlane(0, 35), 17);
  const knownPoint = rot(cam.projectPlane(3, 75), 17);

  const r = calibrate({
    ...IMAGE,
    fovDeg: 60,
    originPoint,
    knownPoint,
    originElevation: 100,
    knownElevation: 103,
    horizontalDistance: 40,
    mode: 'height',
    value: 5.5,
  });
  ok('rolled calibration succeeds', r.ok, r.reason);
  close('rolled photo recovers the same pitch', r.solution.pitchRad / DEG, 12, 1e-3);
  close('rolled photo recovers the same distance', r.solution.originDistance, 35, 1e-3);
});

group('Inverse — reading an elevation back off the photograph', () => {
  const cam = makeCamera({ fovDeg: 60, pitchDeg: 12, cameraHeight: 5.5 });
  const originDistance = 35;
  const slope = 3 / 40; // +3 ft over 40 ft

  // Take points that genuinely lie on the calibrated ground line and check the
  // ray/ground intersection reads their elevation back.
  for (const Z of [20, 35, 55, 75, 120]) {
    const Y = slope * (Z - originDistance);
    const px = cam.projectPlane(Y, Z);
    const { t } = cam.toLineCoords(px);
    const hit = cam.intersectGround(t, slope, originDistance);
    ok(`ground intersection at Z=${Z} exists`, !!hit);
    if (hit) {
      close(`  elevation at Z=${Z}`, hit.Y, Y, 1e-6);
      close(`  distance at Z=${Z}`, hit.Z, Z, 1e-6);
    }
  }

  // And the staff reading: elevation on the ray at a fixed distance.
  const Zstaff = 60;
  const pxStaff = cam.projectPlane(4.25, Zstaff);
  const tStaff = cam.toLineCoords(pxStaff).t;
  close('staff reading at a known distance', cam.elevationAtDepth(tStaff, Zstaff).Y, 4.25, 1e-6);
});

group('ElevationModel', () => {
  const m = new ElevationModel({
    originElevation: 100,
    knownElevation: 103,
    horizontalDistance: 40,
    increment: 1,
    range: 10,
  });
  close('slope', m.slope, 0.075, 1e-12);
  close('grade percent', m.gradePercent, 7.5, 1e-12);
  close('elevation of +2.35', m.elevationFor(2.35), 102.35, 1e-12);
  close('offset of 98.80', m.offsetFor(98.8), -1.2, 1e-12);
  ok('formats elevation', m.formatElevation(102.345) === "102.35'");
  ok('formats a positive change with a sign', m.formatChange(2.35) === "+2.35'");
  ok('formats a negative change with a sign', m.formatChange(-1.2) === "-1.20'");

  const levels = m.levels();
  ok('generates 21 levels for ±10 at 1 ft', levels.length === 21);
  ok('brackets the origin', levels[0].elevation === 90 && levels[20].elevation === 110);
  ok('flags the origin level', levels.find((l) => l.offset === 0).isOrigin === true);

  const fine = new ElevationModel({
    originElevation: 100,
    knownElevation: 100,
    horizontalDistance: 40,
    increment: 0.25,
    range: 1,
  });
  ok('flat ground has zero slope', fine.slope === 0);
  ok('flat ground is flagged', fine.isFlat === true);
  ok('0.25 ft increment over ±1 ft gives 9 levels', fine.levels().length === 9);
});

group('ElevationRuler — perspective spacing', () => {
  const cam = makeCamera({ fovDeg: 60, pitchDeg: 12, cameraHeight: 5.5 });
  const model = new ElevationModel({
    originElevation: 100,
    knownElevation: 103,
    horizontalDistance: 40,
    increment: 1,
    range: 6,
  });
  const ruler = new ElevationRuler({ projection: cam, model, originDistance: 35 });

  const rungs = ruler.slopeRungs();
  ok('slope rungs are produced', rungs.length > 3, `got ${rungs.length}`);

  // Uphill rungs are farther away, so they must be shorter on screen and their
  // spacing must shrink. This is the "do not draw equally spaced lines" test.
  const withOrder = rungs.filter((r) => r.visible).sort((a, b) => a.Z - b.Z);
  let shrinkingWidth = true;
  let shrinkingGap = true;
  for (let i = 1; i < withOrder.length; i++) {
    if (withOrder[i].screenWidth >= withOrder[i - 1].screenWidth) shrinkingWidth = false;
  }
  const gaps = [];
  for (let i = 1; i < withOrder.length; i++) {
    gaps.push(Math.hypot(
      withOrder[i].centre.x - withOrder[i - 1].centre.x,
      withOrder[i].centre.y - withOrder[i - 1].centre.y,
    ));
  }
  for (let i = 1; i < gaps.length; i++) if (gaps[i] >= gaps[i - 1]) shrinkingGap = false;
  ok('rungs get shorter with distance', shrinkingWidth);
  ok('rung spacing compresses with distance', shrinkingGap, gaps.map((g) => g.toFixed(1)).join(', '));
  ok('spacing is genuinely non-uniform', gaps.length > 1 && gaps[0] / gaps[gaps.length - 1] > 1.1);

  // A vertical staff is graduated in equal elevation steps, but those steps must
  // NOT come out equally spaced in pixels: they converge on the vertical
  // vanishing point, which sits below the frame when the camera is tilted down
  // and above it when the camera is tilted up. So the direction of the
  // compression flips with the pitch, and that is what we assert.
  const staffSpacing = (pitchDeg) => {
    const c = makeCamera({ fovDeg: 60, pitchDeg, cameraHeight: 5.5 });
    const r = new ElevationRuler({ projection: c, model, originDistance: 35 });
    const rungs = r.staffRungs(35).filter((x) => x.visible).sort((a, b) => a.Y - b.Y);
    const gaps = [];
    for (let i = 1; i < rungs.length; i++) {
      gaps.push(Math.hypot(
        rungs[i].centre.x - rungs[i - 1].centre.x,
        rungs[i].centre.y - rungs[i - 1].centre.y,
      ));
    }
    return gaps;
  };

  const down = staffSpacing(12);
  const up = staffSpacing(-12);
  const monotonic = (g, sign) => g.every((v, i) => i === 0 || (v - g[i - 1]) * sign > 0);
  ok('staff graduations are not equally spaced', down.length > 2 && down[down.length - 1] / down[0] > 1.05);
  ok('tilted down, graduations open out away from the vanishing point below', monotonic(down, 1));
  ok('tilted up, graduations converge on the vanishing point above', monotonic(up, -1));
});

group('Guard rails', () => {
  const bad = calibrate({
    ...IMAGE,
    fovDeg: 60,
    originPoint: { x: 100, y: 100 },
    knownPoint: { x: 102, y: 101 },
    originElevation: 100,
    knownElevation: 103,
    horizontalDistance: 40,
  });
  ok('rejects reference points that are too close', !bad.ok, bad.reason);

  const zeroDistance = calibrate({
    ...IMAGE,
    fovDeg: 60,
    originPoint: { x: 2000, y: 2800 },
    knownPoint: { x: 2000, y: 1200 },
    originElevation: 100,
    knownElevation: 103,
    horizontalDistance: 0,
  });
  ok('rejects a zero horizontal distance', !zeroDistance.ok, zeroDistance.reason);

  const ctx = calibrationContext({
    ...IMAGE,
    fovDeg: 60,
    originPoint: { x: 2000, y: 2800 },
    knownPoint: { x: 2000, y: 1200 },
    deltaElevation: 3,
    horizontalDistance: 40,
  });
  ok('a pitch at the horizon has no solution', solveFromPitch(ctx.alphaA, ctx) === null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
