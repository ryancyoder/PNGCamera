// SiteSurvey.js
//
// A map-based grade survey: pins on a site plan give the horizontal distances,
// the iPad's tilt gives the angles, and the two together give elevations.
//
// This follows the model proven in the Upright field app — height above the
// device is `d·tan(θ)`, and distance comes from where the pins sit rather than
// from GPS, because a tapped pin against an aerial is far better than a 3–5 m
// fix. What it adds is the standard five-point set for shooting a house:
//
//   1  OBSERVATION   where you stand, across the street. Shoots nothing.
//   2  CURB          at the house, ASSUMED level with where you stand.
//   3  FOUNDATION    where the wall meets the ground.
//   4  EAVE          top of the wall.
//   5  PEAK          the ridge.
//
// Point 2 is the one that does the real work. Upright cancels the device height
// by taking two sightings from one position and differencing them, which gives
// elevations relative to an anchor but never the height itself. Here the curb is
// declared level with the ground you are standing on, so its sighting solves for
// the instrument height outright:
//
//     elevation of curb above the device = d_curb · tan(θ_curb)
//     elevation of curb above your feet  = 0            (the assumption)
//  => h = −d_curb · tan(θ_curb)
//
// and every other point then reads absolutely against the ground you stand on:
//
//     E_i = h + d_i · tan(θ_i)
//
// That matters because the photo ruler's calibration wants exactly the
// quantities this yields — camera height, wall height, distance to the wall and
// the grade below the foundation. Measured, rather than typed or dragged.
//
// The assumption is an assumption. Where the street is not level with where you
// stood, the instrument height can be entered by hand instead.

import { round, DEG } from './Geometry.js';

/** The standard set, in the order they are shot. */
export const STANDARD_POINTS = [
  {
    id: 'observation',
    name: 'Observation point',
    hint: 'Where you stand — across the street.',
    shoots: false,
  },
  {
    id: 'curb',
    name: 'Curb at the house',
    hint: 'Assumed level with where you stand. This shot is what measures your instrument height.',
    shoots: true,
  },
  {
    id: 'foundation',
    name: 'Foundation',
    hint: 'Where the wall meets the ground. This pin is the wall.',
    shoots: true,
  },
  {
    id: 'eave',
    name: 'Roof eave',
    hint: 'Top of the wall — directly above the foundation, so it shares that pin.',
    shoots: true,
    // An eave is by definition straight above the wall it caps, so it can never
    // have a plan position of its own.
    placedWith: 'foundation',
  },
  {
    id: 'peak',
    name: 'Roof peak',
    hint: 'The ridge. On a gable end it is above the wall; from the eave side it is set back, and then it needs its own pin.',
    shoots: true,
    // Shares the wall's pin until told otherwise, because that is right for a
    // gable end and roughly right for a shallow roof — but a ridge seen from the
    // gutter side stands well back, and pretending otherwise reads it too low.
    placedWith: 'foundation',
    canPlaceApart: true,
  },
];

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Half the spread of a set of readings — how steadily the iPad was held. */
export const halfRange = (xs) =>
  xs.length < 2 ? null : (Math.max(...xs) - Math.min(...xs)) / 2;

/**
 * The tilt of the device as an angle above horizontal, from a
 * DeviceOrientationEvent. Level reads 0, up is positive, down is negative.
 *
 * `acos(cos β · cos γ)` is the angle off vertical, which is the one combination
 * of beta and gamma that does not care how the iPad is rolled in your hands.
 */
export function angleFromOrientation(beta, gamma) {
  if (beta == null || Number.isNaN(beta)) return null;
  const b = beta * DEG;
  const g = (gamma ?? 0) * DEG;
  const cosTilt = Math.max(-1, Math.min(1, Math.cos(b) * Math.cos(g)));
  return (Math.acos(cosTilt) * 180) / Math.PI - 90;
}

export class SiteSurvey {
  constructor({ scaleFeetPerUnit = 1, instrumentHeightMode = 'curb', instrumentHeight = 5.5 } = {}) {
    /** @type {Map<string, {id, plan: {x,y}|null, shots: number[]}>} */
    this.points = new Map();
    for (const spec of STANDARD_POINTS) {
      this.points.set(spec.id, { id: spec.id, plan: null, shots: [] });
    }
    // Plan units are whatever the plan view uses (pixels of an imported
    // aerial); the scale converts them to feet.
    this.scaleFeetPerUnit = scaleFeetPerUnit;
    this.instrumentHeightMode = instrumentHeightMode;
    this.manualInstrumentHeight = instrumentHeight;
  }

  static spec(id) {
    return STANDARD_POINTS.find((p) => p.id === id) ?? null;
  }

  point(id) {
    return this.points.get(id) ?? null;
  }

  place(id, plan) {
    const p = this.points.get(id);
    if (!p) return null;
    p.plan = plan ? { ...plan } : null;
    return p;
  }

  /**
   * Where a point sits on the plan, following `placedWith` when it has no pin
   * of its own. Points stacked on one wall share one position — three pins on
   * the same spot would be three ways to get the same distance wrong.
   */
  planOf(id) {
    const own = this.points.get(id);
    if (own?.plan) return own.plan;
    const spec = SiteSurvey.spec(id);
    return spec?.placedWith ? this.planOf(spec.placedWith) : null;
  }

  /** True when this point is riding on another's pin rather than its own. */
  isShared(id) {
    const spec = SiteSurvey.spec(id);
    return !!spec?.placedWith && !this.points.get(id)?.plan;
  }

  addShot(id, angleDeg) {
    const p = this.points.get(id);
    if (!p || !Number.isFinite(angleDeg)) return null;
    p.shots.push(angleDeg);
    return p;
  }

  clearShots(id) {
    const p = this.points.get(id);
    if (p) p.shots = [];
    return p;
  }

  angleOf(id) {
    const p = this.points.get(id);
    return p && p.shots.length ? mean(p.shots) : null;
  }

  /** Horizontal distance between two placed points, in feet. */
  distance(fromId, toId) {
    const a = this.planOf(fromId);
    const b = this.planOf(toId);
    if (!a || !b) return null;
    return Math.hypot(b.x - a.x, b.y - a.y) * this.scaleFeetPerUnit;
  }

  /** Distance from where you stand to a target, in feet. */
  distanceFromObservation(id) {
    return this.distance('observation', id);
  }

  /**
   * Height of the device above the ground you are standing on.
   * @returns {{value:number, from:'curb'|'manual', reason?:string}|null}
   */
  instrumentHeight() {
    if (this.instrumentHeightMode === 'manual') {
      return { value: this.manualInstrumentHeight, from: 'manual' };
    }
    const d = this.distanceFromObservation('curb');
    const angle = this.angleOf('curb');
    if (d == null) return null;
    if (angle == null) return null;
    // Looking level at the curb says nothing about how high the device is: the
    // sighting has to have some fall in it to solve for a height.
    if (Math.abs(angle) < 0.05) {
      return {
        value: null,
        from: 'curb',
        reason: 'The curb shot is level, so it cannot measure how high the iPad was held.',
      };
    }
    return { value: -d * Math.tan(angle * DEG), from: 'curb' };
  }

  /**
   * Elevation of a point above the ground you are standing on.
   * @returns {{feet:number, distance:number, angle:number, shots:number, repeat:number|null}|null}
   */
  elevationOf(id) {
    if (id === 'observation') {
      return { feet: 0, distance: 0, angle: null, shots: 0, repeat: null, isStation: true };
    }
    const h = this.instrumentHeight();
    if (!h || h.value == null) return null;
    const d = this.distanceFromObservation(id);
    const p = this.points.get(id);
    if (d == null || !p?.shots.length) return null;

    // Every shot gets its own elevation, so the spread reports how steadily the
    // iPad was held rather than being hidden inside an averaged angle.
    const each = p.shots.map((a) => h.value + d * Math.tan(a * DEG));
    return {
      feet: mean(each),
      distance: d,
      angle: mean(p.shots),
      shots: each.length,
      repeat: halfRange(each),
    };
  }

  /** Every point that can currently be resolved. */
  elevations() {
    const out = {};
    for (const spec of STANDARD_POINTS) out[spec.id] = this.elevationOf(spec.id);
    return out;
  }

  /**
   * What the photo ruler needs, worked out from the survey.
   *
   * The foundation becomes the datum, which is what the building calibration
   * expects, so everything is re-expressed against it.
   *
   * @returns {{ok:boolean, reason?:string, ...}}
   */
  calibration() {
    const h = this.instrumentHeight();
    if (!h) {
      return { ok: false, reason: 'Place the observation point and the curb, and shoot the curb.' };
    }
    if (h.value == null) return { ok: false, reason: h.reason };

    const foundation = this.elevationOf('foundation');
    if (!foundation) {
      return { ok: false, reason: 'Place and shoot the foundation.' };
    }

    const eave = this.elevationOf('eave');
    const peak = this.elevationOf('peak');
    const curbRun = this.distance('foundation', 'curb');

    const out = {
      ok: true,
      instrumentHeight: h.value,
      instrumentHeightFrom: h.from,
      // The foundation is the datum the photo ruler measures from.
      foundationElevation: foundation.feet,
      distanceToWall: foundation.distance,
      cameraHeightAboveFoundation: h.value - foundation.feet,
      wallHeight: eave ? eave.feet - foundation.feet : null,
      roofRise: eave && peak ? peak.feet - eave.feet : null,
      peakAboveFoundation: peak ? peak.feet - foundation.feet : null,
      // Walking from the wall out to the curb the ground loses the foundation's
      // own height, since the curb is the datum the survey is built on.
      gradeAwayPercent:
        curbRun != null && curbRun > 1e-6 ? (100 * foundation.feet) / curbRun : null,
      curbRun,
    };

    if (out.wallHeight != null && !(out.wallHeight > 0)) {
      // An eave below its own foundation means a mis-placed pin or a shot taken
      // at the wrong target, and it would calibrate to nonsense.
      out.ok = false;
      out.reason = 'The eave came out at or below the foundation — check those two pins and shots.';
    }
    return out;
  }

  /** A short, plain-language account of what has been done and what is missing. */
  status() {
    const missing = [];
    for (const spec of STANDARD_POINTS) {
      const p = this.points.get(spec.id);
      // A point riding on another's pin needs no placing of its own.
      if (!this.planOf(spec.id)) missing.push(`place ${spec.name.toLowerCase()}`);
      else if (spec.shoots && !p.shots.length) missing.push(`shoot ${spec.name.toLowerCase()}`);
    }
    return { complete: missing.length === 0, missing };
  }

  toJSON() {
    return {
      scaleFeetPerUnit: this.scaleFeetPerUnit,
      instrumentHeightMode: this.instrumentHeightMode,
      manualInstrumentHeight: this.manualInstrumentHeight,
      points: [...this.points.values()].map((p) => ({ id: p.id, plan: p.plan, shots: p.shots })),
    };
  }

  loadJSON(data) {
    if (!data) return this;
    this.scaleFeetPerUnit = data.scaleFeetPerUnit ?? this.scaleFeetPerUnit;
    this.instrumentHeightMode = data.instrumentHeightMode ?? this.instrumentHeightMode;
    this.manualInstrumentHeight = data.manualInstrumentHeight ?? this.manualInstrumentHeight;
    for (const saved of data.points ?? []) {
      const p = this.points.get(saved.id);
      if (!p) continue;
      p.plan = saved.plan ? { ...saved.plan } : null;
      p.shots = Array.isArray(saved.shots) ? [...saved.shots] : [];
    }
    return this;
  }

  /** Formatting helper shared by the panel and the plan view. */
  static format(feet, decimals = 2) {
    if (feet == null || !Number.isFinite(feet)) return '—';
    const v = round(feet, decimals);
    return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}'`;
  }
}
