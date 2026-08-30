// ElevationModel.js
//
// The elevation bookkeeping, kept deliberately separate from the camera. It
// knows the two measured elevations, the horizontal distance between them, and
// how finely the user wants the ruler divided. Everything is unit-agnostic —
// `unitSuffix` is cosmetic only, so feet and metres both work without touching
// the maths.

import { round } from './Geometry.js';

export class ElevationModel {
  constructor({
    originElevation = 100,
    knownElevation = 103,
    horizontalDistance = 40,
    increment = 1,
    range = 10,
    unitSuffix = "'",
    decimals = 2,
    knownIsFarther = true,
    slopeOverride = null,
  } = {}) {
    this.originElevation = originElevation;
    this.knownElevation = knownElevation;
    this.horizontalDistance = horizontalDistance;
    this.increment = increment;
    this.range = range;
    this.unitSuffix = unitSuffix;
    this.decimals = decimals;
    this.knownIsFarther = knownIsFarther;
    // Set when the grade is stated outright rather than derived from two known
    // points — calibrating against a building observes the wall, not the ground,
    // so nothing there can imply a grade and it has to be given.
    this.slopeOverride = slopeOverride;
  }

  /** Elevation difference between the two measured points. */
  get deltaElevation() {
    return this.knownElevation - this.originElevation;
  }

  /**
   * Rise over run walking from the origin towards the known point. Positive
   * means the known point is the higher of the two. This is the grade the user
   * entered and the one shown on screen.
   */
  get slope() {
    if (this.slopeOverride != null) return this.slopeOverride;
    if (!(this.horizontalDistance > 0)) return 0;
    return this.deltaElevation / this.horizontalDistance;
  }

  /**
   * Rise per unit of distance AWAY FROM THE CAMERA, which is what the
   * projection needs. It is the negative of `slope` whenever the known point is
   * the nearer of the two — walking towards the known point then walks towards
   * the camera. Getting this wrong builds the ruler backwards, running it
   * uphill where the ground falls.
   */
  get slopeAlongSight() {
    // A stated grade is already expressed along the sight line, so it needs no
    // direction correction.
    if (this.slopeOverride != null) return this.slopeOverride;
    return this.knownIsFarther ? this.slope : -this.slope;
  }

  get gradePercent() {
    return this.slope * 100;
  }

  /** Slope expressed the way a landscaper reads it: "1 in 13.3". */
  get slopeRatio() {
    const s = Math.abs(this.slope);
    if (s < 1e-9) return null;
    return 1 / s;
  }

  get isFlat() {
    return Math.abs(this.slope) < 1e-9;
  }

  /** Convert an offset above the origin into an absolute elevation. */
  elevationFor(offset) {
    return this.originElevation + offset;
  }

  /** Convert an absolute elevation into an offset above the origin. */
  offsetFor(elevation) {
    return elevation - this.originElevation;
  }

  /**
   * The elevation increments to draw, from -range to +range around the origin.
   * Offsets are snapped onto exact multiples of the increment so floating point
   * accumulation never drifts the labels.
   */
  levels() {
    const inc = this.increment > 0 ? this.increment : 1;
    const steps = Math.floor(this.range / inc + 1e-9);
    const out = [];
    for (let k = -steps; k <= steps; k++) {
      const offset = round(k * inc, 6);
      out.push({
        index: k,
        offset,
        elevation: round(this.elevationFor(offset), 6),
        isOrigin: k === 0,
        isMajor: Math.abs(round((k * inc) % 1, 6)) < 1e-9,
        label: this.formatElevation(this.elevationFor(offset)),
        change: this.formatChange(offset),
      });
    }
    return out;
  }

  // --- formatting ---------------------------------------------------------

  formatNumber(value) {
    return round(value, this.decimals).toFixed(this.decimals);
  }

  formatElevation(elevation) {
    return `${this.formatNumber(elevation)}${this.unitSuffix}`;
  }

  formatChange(offset) {
    const v = round(offset, this.decimals);
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    return `${sign}${this.formatNumber(Math.abs(v))}${this.unitSuffix}`;
  }

  formatDistance(distance) {
    return `${this.formatNumber(distance)}${this.unitSuffix}`;
  }

  /**
   * The grade as a landscaper states it at a building: what the ground does as
   * you walk AWAY from the wall. Away from the wall is towards the camera, so a
   * fall away from the house is a rise along the sight line.
   */
  formatGradeAway(slope = this.slopeAlongSight) {
    const pct = Math.abs(slope) * 100;
    if (pct < 0.05) return 'level';
    return `${round(pct, 1).toFixed(1)}% ${slope > 0 ? 'fall' : 'rise'} away from the wall`;
  }

  formatGrade(slope = this.slope) {
    const pct = slope * 100;
    const ratio = Math.abs(slope) > 1e-9 ? ` (1:${round(1 / Math.abs(slope), 1).toFixed(1)})` : '';
    return `${round(pct, 1).toFixed(1)}%${ratio}`;
  }

  toJSON() {
    return {
      originElevation: this.originElevation,
      knownElevation: this.knownElevation,
      horizontalDistance: this.horizontalDistance,
      increment: this.increment,
      range: this.range,
      unitSuffix: this.unitSuffix,
      decimals: this.decimals,
      knownIsFarther: this.knownIsFarther,
      slopeOverride: this.slopeOverride,
    };
  }
}
