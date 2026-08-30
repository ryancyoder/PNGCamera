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
import { MeasurementAnnotation } from '../src/core/MeasurementAnnotation.js';
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

group('Grade direction', () => {
  const base = { originElevation: 100, knownElevation: 97, horizontalDistance: 40 };
  const farther = new ElevationModel({ ...base, knownIsFarther: true });
  const nearer = new ElevationModel({ ...base, knownIsFarther: false });

  // Both describe the same pair of points: the known point is 3 ft lower.
  close('displayed grade is the same either way', farther.slope, nearer.slope, 1e-12);
  ok('displayed grade falls towards the known point', farther.slope < 0);

  // But along the line of sight they are opposites: if the lower point is
  // nearer the camera, the ground RISES as it goes away.
  close('sight grade falls away when the known point is farther', farther.slopeAlongSight, -0.075, 1e-12);
  close('sight grade rises away when the known point is nearer', nearer.slopeAlongSight, 0.075, 1e-12);

  // The ruler must follow the sight grade, or it climbs the wrong way.
  const cam = makeCamera({ fovDeg: 60, pitchDeg: 10, cameraHeight: 5.5 });
  const uphill = new ElevationRuler({ projection: cam, model: nearer, originDistance: 70 });
  ok('a level below the origin sits nearer the camera', uphill.distanceForOffset(-2) < 70);
  ok('a level above the origin sits farther away', uphill.distanceForOffset(2) > 70);

  const downhill = new ElevationRuler({ projection: cam, model: farther, originDistance: 30 });
  ok('and the other way round when the known point is farther',
     downhill.distanceForOffset(-2) > 30 && downhill.distanceForOffset(2) < 30);
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

group('Calibration — the origin may be the FARTHER point', () => {
  // Standing in the yard photographing a house: the foundation (the natural
  // origin) is the far thing, and the known grade shot is nearer the camera.
  const truth = { fovDeg: 62, pitchDeg: 9, cameraHeight: 5.5 };
  const cam = makeCamera(truth);
  const originDistance = 70;      // the foundation, up the slope and away
  const knownDistance = 30;       // a grade shot out in the yard, nearer
  const originElevation = 100;
  const knownElevation = 97;      // 3 ft below the foundation
  const horizontalDistance = 40;

  const originPoint = cam.projectPlane(0, originDistance);
  const knownPoint = cam.projectPlane(knownElevation - originElevation, knownDistance);

  const base = {
    ...IMAGE,
    fovDeg: truth.fovDeg,
    originPoint,
    knownPoint,
    originElevation,
    knownElevation,
    horizontalDistance,
  };

  // Declaring the wrong order must not quietly invent a plausible camera.
  const wrongWay = calibrate({ ...base, knownIsFarther: true, mode: 'height', value: truth.cameraHeight });
  const wrongOk =
    wrongWay.ok &&
    Math.abs(wrongWay.solution.originDistance - originDistance) < 1 &&
    Math.abs(wrongWay.solution.cameraHeight - truth.cameraHeight) < 0.1;
  ok('declaring the wrong near/far order does not reproduce the scene', !wrongOk);

  const r = calibrate({ ...base, knownIsFarther: false, mode: 'height', value: truth.cameraHeight });
  ok('calibrates with the origin as the far point', r.ok, r.reason);
  close('recovers camera height', r.solution.cameraHeight, truth.cameraHeight, 1e-3);
  close('recovers pitch', r.solution.pitchRad / DEG, truth.pitchDeg, 1e-3);
  close('recovers the origin distance', r.solution.originDistance, originDistance, 1e-2);
  close('recovers the known point distance', r.solution.knownDistance, knownDistance, 1e-2);
  ok('the known point really is nearer', r.solution.knownDistance < r.solution.originDistance);

  // Both taps still have to land back exactly where the user put them.
  const a = r.projection.projectPlane(0, r.solution.originDistance);
  const b = r.projection.projectPlane(-3, r.solution.knownDistance);
  ok(
    'both taps stay pinned when the origin is farthest',
    Math.hypot(a.x - originPoint.x, a.y - originPoint.y) < 0.1 &&
      Math.hypot(b.x - knownPoint.x, b.y - knownPoint.y) < 0.1,
  );
});

group('Foundation ruler — vertical above the datum, grade below', () => {
  const cam = makeCamera({ fovDeg: 62, pitchDeg: 9, cameraHeight: 5.5 });
  const originDistance = 70;
  const model = new ElevationModel({
    originElevation: 100,
    knownElevation: 97,
    horizontalDistance: 40,
    increment: 1,
    range: 8,
    knownIsFarther: false, // the yard shot is nearer than the foundation
  });
  const ruler = new ElevationRuler({ projection: cam, model, originDistance });
  const { vertical, grade } = ruler.foundationRungs();

  ok('produces an upright half', vertical.length > 3, `got ${vertical.length}`);
  ok('produces a grade half', grade.length > 3, `got ${grade.length}`);

  ok('everything upright is above the datum', vertical.every((r) => r.Y > 0));
  ok('everything on the grade is at or below the datum', grade.every((r) => r.Y <= 0));
  ok('the datum belongs to the grade half exactly once',
     grade.filter((r) => r.Y === 0).length === 1);

  // The whole point: above the datum the horizontal distance does not change.
  ok(
    'upright rungs all stay at the foundation distance',
    vertical.every((r) => Math.abs(r.Z - originDistance) < 1e-9),
    vertical.map((r) => r.Z.toFixed(3)).join(', '),
  );
  // ...and below it they march out across the grade.
  ok(
    'grade rungs sit where the ground reaches each level',
    grade.every((r) => Math.abs(r.Z - (originDistance + r.Y / model.slopeAlongSight)) < 1e-6),
  );
  ok('the grade half recedes, it does not stack', new Set(grade.map((r) => r.Z.toFixed(4))).size === grade.length);

  // Holding the horizontal distance fixed keeps the apparent width nearly
  // constant, but not exactly: a camera tilted down is fractionally closer to
  // the top of a wall than its foot, so the rungs widen going up. The grade
  // half, actually receding, changes width by far more.
  const widths = vertical.map((r) => r.screenWidth);
  const spread = (a) => (Math.max(...a) - Math.min(...a)) / (a.reduce((x, y) => x + y, 0) / a.length);
  ok('upright rungs hold their width', spread(widths) < 0.05, `spread ${(spread(widths) * 100).toFixed(1)}%`);
  ok('upright rungs widen towards the top, as a tilted camera sees a wall',
     widths.every((w, i) => i === 0 || w > widths[i - 1]));
  const gradeWidths = grade.map((r) => r.screenWidth);
  ok('grade rungs change width a lot, because they really recede',
     spread(gradeWidths) > 0.5, `spread ${(spread(gradeWidths) * 100).toFixed(1)}%`);

  // Equal steps up a wall are still projected, never evenly spaced in pixels.
  const gaps = [];
  for (let i = 1; i < vertical.length; i++) {
    gaps.push(Math.hypot(
      vertical[i].centre.x - vertical[i - 1].centre.x,
      vertical[i].centre.y - vertical[i - 1].centre.y,
    ));
  }
  ok('the wall is projected, not evenly divided', Math.max(...gaps) / Math.min(...gaps) > 1.02);

  // The two halves must meet, or the ruler visibly breaks at the zero line.
  const datum = cam.projectPlane(0, originDistance);
  const post = ruler.foundationPost(vertical);
  ok('the upright post starts on the datum',
     Math.hypot(post.a.x - datum.x, post.a.y - datum.y) < 1e-6);
  const zeroRung = grade.find((r) => r.Y === 0);
  ok('both halves meet at the datum',
     Math.hypot(zeroRung.centre.x - datum.x, zeroRung.centre.y - datum.y) < 1e-6);

  // The ground line must stop at the foundation — above it is the building.
  const ground = ruler.groundLine({ maxOffset: 0 });
  ok('the ground line stops at the datum',
     ground.every((pt) => ruler.offsetAtDistance(pt.Z) <= 1e-9));
  ok('the ground line still exists below the datum', ground.length > 5);
});

group('Foundation measurements agree with the foundation ruler', () => {
  const cam = makeCamera({ fovDeg: 62, pitchDeg: 9, cameraHeight: 5.5 });
  const originDistance = 70;
  const model = new ElevationModel({
    originElevation: 100,
    knownElevation: 97,
    horizontalDistance: 40,
    increment: 1,
    range: 8,
    knownIsFarther: false, // the yard shot is nearer than the foundation
  });

  const read = (imagePoint) =>
    new MeasurementAnnotation({ imagePoint, mode: 'foundation' })
      .solve(cam, model, originDistance);

  // A point up the wall: 6 ft above the foundation, at the foundation distance.
  const wall = read(cam.projectPlane(6, originDistance));
  ok('a wall point reads', wall.valid, wall.reason);
  close('  elevation up the wall', wall.elevation, 106, 1e-6);
  close('  stays at the foundation distance', wall.distance, originDistance, 1e-6);

  // A point out in the yard, on the grade, 2 ft below the foundation.
  const yardZ = originDistance + -2 / model.slopeAlongSight;
  const yard = read(cam.projectPlane(-2, yardZ));
  ok('a yard point reads', yard.valid, yard.reason);
  close('  elevation on the grade', yard.elevation, 98, 1e-6);
  close('  distance out across the grade', yard.distance, yardZ, 1e-6);
  ok('the yard point is nearer than the foundation', yard.distance < originDistance);

  // The rule must be continuous where the two halves meet.
  const datum = read(cam.projectPlane(0, originDistance));
  close('the datum itself reads zero change', datum.elevation, 100, 1e-6);
  close('the datum sits at the foundation distance', datum.distance, originDistance, 1e-6);

  // And 'ground' mode must still ignore the wall, or the modes are the same.
  const asGround = new MeasurementAnnotation({
    imagePoint: cam.projectPlane(6, originDistance),
    mode: 'ground',
  }).solve(cam, model, originDistance);
  ok(
    'ground mode reads the same pixel differently',
    !asGround.valid || Math.abs(asGround.elevation - 106) > 0.5,
    `ground mode gave ${asGround.elevation}`,
  );
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
  ok('a pitch at the horizon has no solution', solveFromPitch(ctx.alphaNear, ctx) === null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
