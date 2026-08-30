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
    // The two halves of a foundation ruler measure different things, so they
    // get their own scales: courses up a wall, risers out across the grade.
    // `increment` sets both, which is what a single-scale ruler wants.
    verticalIncrement = null,
    projectedIncrement = null,
    verticalNoun = '',
    projectedNoun = '',
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
    this.verticalIncrement = verticalIncrement ?? increment;
    this.projectedIncrement = projectedIncrement ?? increment;
    this.verticalNoun = verticalNoun;
    this.projectedNoun = projectedNoun;
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
   * Build the increments for one scale. Offsets are snapped onto exact
   * multiples so floating point accumulation never drifts the labels, and each
   * level carries every wording the renderer might want.
   *
   * @param {number} increment  step size in world units
   * @param {object} o
   * @param {number} o.fromIndex first multiple to emit (inclusive)
   * @param {number} o.toIndex   last multiple to emit (inclusive)
   * @param {string} o.noun      what one step of this scale is called, if anything
   */
  levelsFor(increment, { fromIndex, toIndex, noun = '' } = {}) {
    const inc = increment > 0 ? increment : 1;
    const span = Math.floor(this.range / inc + 1e-9);
    const lo = fromIndex ?? -span;
    const hi = toIndex ?? span;
    const out = [];
    for (let k = lo; k <= hi; k++) {
      const offset = round(k * inc, 6);
      const count = Math.abs(k);
      out.push({
        index: k,
        offset,
        elevation: round(this.elevationFor(offset), 6),
        isOrigin: k === 0,
        // A counted scale makes every line meaningful — one course, one riser —
        // so none of them is a minor tick.
        isMajor: noun ? true : Math.abs(round((k * inc) % 1, 6)) < 1e-9,
        label: this.formatElevation(this.elevationFor(offset)),
        change: this.formatChange(offset),
        count,
        noun,
        countLabel: noun ? this.formatCount(count, noun) : null,
      });
    }
    return out;
  }

  /** The whole ruler on one scale, for the styles that do not split at zero. */
  levels() {
    return this.levelsFor(this.increment);
  }

  /** Above the datum: measured straight up, so the vertical scale. */
  levelsAbove() {
    const inc = this.verticalIncrement > 0 ? this.verticalIncrement : 1;
    return this.levelsFor(inc, {
      fromIndex: 1,
      toIndex: Math.floor(this.range / inc + 1e-9),
      noun: this.verticalNoun,
    });
  }

  /** The datum and below: projected across the grade, so the projected scale. */
  levelsBelow() {
    const inc = this.projectedIncrement > 0 ? this.projectedIncrement : 1;
    return this.levelsFor(inc, {
      fromIndex: -Math.floor(this.range / inc + 1e-9),
      toIndex: 0,
      noun: this.projectedNoun,
    });
  }

  /** How many whole units of a scale fit into an offset. */
  countFor(offset, increment) {
    if (!(increment > 0)) return null;
    return Math.abs(offset) / increment;
  }

  formatCount(count, noun, decimals = 0) {
    const n = round(count, decimals);
    const shown = decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
    return `${shown} ${noun}${Math.abs(n - 1) < 1e-9 ? '' : 's'}`;
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
      verticalIncrement: this.verticalIncrement,
      projectedIncrement: this.projectedIncrement,
      verticalNoun: this.verticalNoun,
      projectedNoun: this.projectedNoun,
      unitSuffix: this.unitSuffix,
      decimals: this.decimals,
      knownIsFarther: this.knownIsFarther,
      slopeOverride: this.slopeOverride,
    };
  }
}
