// MeasurementAnnotation.js
//
// A single point the user has placed on the photograph, and the elevation the
// camera model reads back for it.
//
// The distinction the app has to keep honest: the origin and the second
// reference point are MEASURED — the user typed their elevations in and the
// app must never overwrite them. Everything else is PROJECTED: an estimate
// interpolated from the calibration, only as good as the calibration is.

export const MEASURED = 'measured';
export const PROJECTED = 'projected';

let nextId = 1;
export const newId = (prefix = 'p') => `${prefix}${nextId++}`;

export class MeasurementAnnotation {
  /**
   * @param {object} o
   * @param {{x,y}}  o.imagePoint  where the marker sits, in photo pixels
   * @param {'ground'|'depth'} o.mode how to turn the view ray into an elevation:
   *        'ground' intersects the calibrated grade, 'depth' reads the ray at a
   *        fixed distance along the line of sight (a virtual levelling staff).
   */
  constructor({
    id = newId(),
    imagePoint,
    kind = PROJECTED,
    mode = 'ground',
    fixedDistance = null,
    label = '',
    elevation = null,
    role = 'point',
    labelOffset = { x: 18, y: -18 },
    labelMoved = false,
    locked = false,
  }) {
    this.id = id;
    this.imagePoint = { ...imagePoint };
    this.kind = kind;
    this.mode = mode;
    this.fixedDistance = fixedDistance;
    this.label = label;
    this.role = role; // 'origin' | 'known' | 'point'
    this.labelOffset = { ...labelOffset };
    this.labelMoved = labelMoved;
    this.locked = locked;

    // Filled in by solve().
    this.elevation = elevation;
    this.offset = null;
    this.distance = null;
    this.offPlanePx = 0;
    this.valid = false;
    this.reason = '';
  }

  get isMeasured() {
    return this.kind === MEASURED;
  }

  /**
   * Recompute this point's elevation against the current camera and model.
   * Measured points keep the elevation the user typed; what gets solved for them
   * is only their distance along the line of sight, so dimensions still work.
   */
  solve(projection, model, originDistance) {
    this.valid = false;
    this.reason = '';
    if (!projection || !model) {
      this.reason = 'Not calibrated yet.';
      return this;
    }

    const { t, across } = projection.toLineCoords(this.imagePoint);
    this.offPlanePx = across;

    if (this.isMeasured) {
      // Elevation is a given; find where along the line of sight it sits.
      this.offset = model.offsetFor(this.elevation);
      const Z = projection.depthForElevation(t, this.offset);
      this.distance = Z;
      this.valid = Z != null;
      if (!this.valid) this.reason = 'Reference point is on the horizon.';
      return this;
    }

    const hit =
      this.mode === 'depth' && this.fixedDistance != null
        ? projection.elevationAtDepth(t, this.fixedDistance)
        : projection.intersectGround(t, model.slope, originDistance);

    if (!hit) {
      this.reason =
        this.mode === 'depth'
          ? 'No reading at that distance.'
          : 'That sight line never meets the calibrated grade — it is at or beyond the horizon.';
      return this;
    }

    this.offset = hit.Y;
    this.elevation = model.elevationFor(hit.Y);
    this.distance = hit.Z;
    this.valid = true;
    return this;
  }

  /** Distance from the origin along the line of sight (signed). */
  distanceFromOrigin(originDistance) {
    if (this.distance == null) return null;
    return this.distance - originDistance;
  }

  toJSON() {
    return {
      id: this.id,
      imagePoint: this.imagePoint,
      kind: this.kind,
      mode: this.mode,
      fixedDistance: this.fixedDistance,
      label: this.label,
      role: this.role,
      labelOffset: this.labelOffset,
      labelMoved: this.labelMoved,
      locked: this.locked,
      elevation: this.isMeasured ? this.elevation : null,
    };
  }

  static fromJSON(o) {
    const m = new MeasurementAnnotation(o);
    if (o.kind === MEASURED) m.elevation = o.elevation;
    return m;
  }
}

/**
 * A dimension drawn between two measurement points: the vertical rise, the
 * horizontal run, the elevation change, or the grade between them. These are
 * the annotation tools from the brief, all expressed as one linked pair so the
 * numbers can never drift out of step with the points they describe.
 */
export class DimensionAnnotation {
  constructor({
    id = newId('d'),
    fromId,
    toId,
    style = 'vertical', // 'vertical' | 'horizontal' | 'change' | 'grade'
    label = '',
    labelOffset = { x: 0, y: 0 },
  }) {
    this.id = id;
    this.fromId = fromId;
    this.toId = toId;
    this.style = style;
    this.label = label;
    this.labelOffset = { ...labelOffset };
  }

  /**
   * Compute the text and the anchor geometry for this dimension.
   * @returns {{ok:boolean, text?:string, from?:object, to?:object}}
   */
  resolve(points, model, projection, originDistance) {
    const a = points.get(this.fromId);
    const b = points.get(this.toId);
    if (!a || !b || !a.valid || !b.valid) return { ok: false };

    const rise = b.elevation - a.elevation;
    const run = b.distance != null && a.distance != null ? b.distance - a.distance : null;

    let text = this.label;
    if (!text) {
      switch (this.style) {
        case 'horizontal':
          text = run == null ? '—' : `${model.formatNumber(Math.abs(run))}${model.unitSuffix}`;
          break;
        case 'grade':
          text =
            run == null || Math.abs(run) < 1e-9
              ? '—'
              : `GRADE ${model.formatGrade(rise / run)}`;
          break;
        case 'change':
          text = model.formatChange(rise);
          break;
        case 'vertical':
        default:
          text = model.formatChange(rise);
          break;
      }
    }

    return {
      ok: true,
      text,
      rise,
      run,
      a,
      b,
      projection,
      originDistance,
    };
  }

  toJSON() {
    return {
      id: this.id,
      fromId: this.fromId,
      toId: this.toId,
      style: this.style,
      label: this.label,
      labelOffset: this.labelOffset,
    };
  }

  static fromJSON(o) {
    return new DimensionAnnotation(o);
  }
}
