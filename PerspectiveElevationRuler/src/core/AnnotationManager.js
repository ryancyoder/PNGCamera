// AnnotationManager.js
//
// Owns the measurement points and the dimensions between them, keeps them in
// step with the current calibration, and answers "what did the user just touch?".
// No rendering, no DOM.

import {
  MeasurementAnnotation,
  DimensionAnnotation,
  MEASURED,
  PROJECTED,
} from './MeasurementAnnotation.js';

export class AnnotationManager {
  constructor() {
    /** @type {Map<string, MeasurementAnnotation>} */
    this.points = new Map();
    /** @type {Map<string, DimensionAnnotation>} */
    this.dimensions = new Map();
    this.selectedId = null;
  }

  // --- points -------------------------------------------------------------

  addPoint(options) {
    const p = new MeasurementAnnotation(options);
    this.points.set(p.id, p);
    return p;
  }

  /** The origin and the second known point are singletons, replaced not stacked. */
  setReferencePoint(role, imagePoint, elevation, labelOffset = null) {
    const existing = this.referencePoint(role);
    for (const [id, p] of this.points) {
      if (p.role === role) this.points.delete(id);
    }
    return this.addPoint({
      imagePoint,
      elevation,
      kind: MEASURED,
      role,
      label: role === 'origin' ? 'ORIGIN' : 'POINT B',
      // Keep a callout the user has already positioned by hand.
      labelOffset:
        existing?.labelMoved
          ? existing.labelOffset
          : (labelOffset ?? (role === 'origin' ? { x: 20, y: 26 } : { x: 20, y: -26 })),
      labelMoved: existing?.labelMoved ?? false,
    });
  }

  referencePoint(role) {
    for (const p of this.points.values()) if (p.role === role) return p;
    return null;
  }

  get origin() {
    return this.referencePoint('origin');
  }

  get known() {
    return this.referencePoint('known');
  }

  /** Measurement points only — the ones the user added with ADD POINT. */
  get measurements() {
    return [...this.points.values()].filter((p) => p.role === 'point');
  }

  removePoint(id) {
    const removed = this.points.delete(id);
    // A dimension without both ends is meaningless.
    for (const [dId, d] of this.dimensions) {
      if (d.fromId === id || d.toId === id) this.dimensions.delete(dId);
    }
    if (this.selectedId === id) this.selectedId = null;
    return removed;
  }

  movePoint(id, imagePoint) {
    const p = this.points.get(id);
    if (!p || p.locked) return null;
    p.imagePoint = { ...imagePoint };
    return p;
  }

  // --- dimensions ---------------------------------------------------------

  addDimension(fromId, toId, style = 'vertical') {
    if (!this.points.has(fromId) || !this.points.has(toId) || fromId === toId) return null;
    // Several dimensions can describe the same pair of points (rise, run,
    // grade). They all anchor on the same midpoint, so stack them rather than
    // letting the second one land on top of the first.
    const sharing = [...this.dimensions.values()].filter(
      (x) =>
        (x.fromId === fromId && x.toId === toId) || (x.fromId === toId && x.toId === fromId),
    ).length;
    const d = new DimensionAnnotation({
      fromId,
      toId,
      style,
      labelOffset: { x: 0, y: -22 - sharing * 28 },
    });
    this.dimensions.set(d.id, d);
    return d;
  }

  /** Midpoint anchor of a dimension's label, in photo pixels. */
  dimensionAnchor(dimension, unit) {
    const a = this.points.get(dimension.fromId);
    const b = this.points.get(dimension.toId);
    if (!a || !b) return null;
    return {
      x: (a.imagePoint.x + b.imagePoint.x) / 2 + dimension.labelOffset.x * unit,
      y: (a.imagePoint.y + b.imagePoint.y) / 2 + dimension.labelOffset.y * unit,
    };
  }

  /** Nearest dimension label under the touch, so it can be dragged clear. */
  hitTestDimension(imagePoint, tolerance, unit) {
    let best = null;
    let bestDist = Infinity;
    for (const d of this.dimensions.values()) {
      const anchor = this.dimensionAnchor(d, unit);
      if (!anchor) continue;
      // Dimension labels are centred on their anchor.
      const dx = Math.max(Math.abs(imagePoint.x - anchor.x) - 90 * unit, 0);
      const dy = Math.max(Math.abs(imagePoint.y - anchor.y) - 15 * unit, 0);
      const dd = Math.hypot(dx, dy);
      if (dd <= tolerance * 0.5 && dd < bestDist) {
        bestDist = dd;
        best = d;
      }
    }
    return best;
  }

  moveDimensionLabel(id, imagePoint, unit, grab = { x: 0, y: 0 }) {
    const d = this.dimensions.get(id);
    const a = this.points.get(d?.fromId);
    const b = this.points.get(d?.toId);
    if (!d || !a || !b) return null;
    const midX = (a.imagePoint.x + b.imagePoint.x) / 2;
    const midY = (a.imagePoint.y + b.imagePoint.y) / 2;
    d.labelOffset = {
      x: (imagePoint.x - midX) / unit - grab.x,
      y: (imagePoint.y - midY) / unit - grab.y,
    };
    return d;
  }

  removeDimension(id) {
    return this.dimensions.delete(id);
  }

  // --- solving ------------------------------------------------------------

  /** Re-derive every point against a new calibration. Call after any change. */
  solveAll(projection, model, originDistance) {
    for (const p of this.points.values()) p.solve(projection, model, originDistance);
    return this;
  }

  resolveDimensions(model, projection, originDistance) {
    const out = [];
    for (const d of this.dimensions.values()) {
      const r = d.resolve(this.points, model, projection, originDistance);
      if (r.ok) out.push({ dimension: d, ...r });
    }
    return out;
  }

  // --- hit testing --------------------------------------------------------

  /**
   * Nearest point within `tolerance` image pixels. Measurement points win ties
   * against reference points, because reference points are the ones you least
   * want to nudge by accident.
   */
  /**
   * Nearest point whose CALLOUT was touched. Checked before the markers so a
   * label can be dragged clear of whatever it is covering.
   */
  hitTestLabel(imagePoint, tolerance, unit) {
    let best = null;
    let bestDist = Infinity;
    for (const p of this.points.values()) {
      const anchor = {
        x: p.imagePoint.x + p.labelOffset.x * unit,
        y: p.imagePoint.y + p.labelOffset.y * unit,
      };
      // The callout hangs down and to whichever side the offset points, so the
      // hit box is offset from its anchor rather than centred on it.
      const w = 150 * unit;
      const h = 66 * unit;
      const x0 = p.labelOffset.x < 0 ? anchor.x - w : anchor.x;
      const dx = Math.max(x0 - imagePoint.x, 0, imagePoint.x - (x0 + w));
      const dy = Math.max(anchor.y - imagePoint.y, 0, imagePoint.y - (anchor.y + h));
      const d = Math.hypot(dx, dy);
      if (d <= tolerance * 0.5 && d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  moveLabel(id, imagePoint, unit, grab = { x: 0, y: 0 }) {
    const p = this.points.get(id);
    if (!p) return null;
    p.labelOffset = {
      x: (imagePoint.x - p.imagePoint.x) / unit - grab.x,
      y: (imagePoint.y - p.imagePoint.y) / unit - grab.y,
    };
    p.labelMoved = true;
    return p;
  }

  hitTest(imagePoint, tolerance) {
    let best = null;
    let bestScore = Infinity;
    for (const p of this.points.values()) {
      const d = Math.hypot(p.imagePoint.x - imagePoint.x, p.imagePoint.y - imagePoint.y);
      if (d > tolerance) continue;
      const score = d + (p.role === 'point' ? 0 : tolerance * 0.35);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  select(id) {
    this.selectedId = this.points.has(id) ? id : null;
    return this.selected;
  }

  get selected() {
    return this.selectedId ? this.points.get(this.selectedId) ?? null : null;
  }

  clearMeasurements() {
    for (const p of this.measurements) this.removePoint(p.id);
  }

  clear() {
    this.points.clear();
    this.dimensions.clear();
    this.selectedId = null;
  }

  // --- persistence --------------------------------------------------------

  toJSON() {
    return {
      points: [...this.points.values()].map((p) => p.toJSON()),
      dimensions: [...this.dimensions.values()].map((d) => d.toJSON()),
    };
  }

  loadJSON(data) {
    this.clear();
    for (const p of data?.points ?? []) {
      const point = MeasurementAnnotation.fromJSON(p);
      this.points.set(point.id, point);
    }
    for (const d of data?.dimensions ?? []) {
      const dim = DimensionAnnotation.fromJSON(d);
      this.dimensions.set(dim.id, dim);
    }
    return this;
  }
}

export { MEASURED, PROJECTED };
