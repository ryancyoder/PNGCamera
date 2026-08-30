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
  } = {}) {
    this.originElevation = originElevation;
    this.knownElevation = knownElevation;
    this.horizontalDistance = horizontalDistance;
    this.increment = increment;
    this.range = range;
    this.unitSuffix = unitSuffix;
    this.decimals = decimals;
  }

  /** Elevation difference between the two measured points. */
  get deltaElevation() {
    return this.knownElevation - this.originElevation;
  }

  /** Rise over run along the line of sight. */
  get slope() {
    if (!(this.horizontalDistance > 0)) return 0;
    return this.deltaElevation / this.horizontalDistance;
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
    };
  }
}
