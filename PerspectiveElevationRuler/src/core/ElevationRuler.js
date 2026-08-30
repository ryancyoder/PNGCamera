// ElevationRuler.js
//
// Builds the ruler's geometry in world coordinates and projects it. It returns
// plain data — arrays of image-space points with a depth attached — so the
// renderer stays dumb and the geometry stays testable.
//
// Two ruler styles, both fully three dimensional:
//
//   SLOPE  the ruler follows the calibrated grade along the line of sight. Each
//          elevation increment is a rung placed where the ground reaches that
//          elevation, so climbing the ruler walks you into the distance. This is
//          the staircase look — rungs get shorter and bunch up as they recede.
//
//   STAFF  a virtual levelling rod planted at one distance, graduated in
//          elevation increments. Nothing recedes, but the graduations still
//          compress towards the horizon because they are projected, not drawn.
//
// Neither style implies anything about the landscape left or right of the
// measurement plane, which is why the rungs are a deliberately finite width.

export class ElevationRuler {
  constructor({ projection, model, originDistance, rungWidth = 10, staffWidth = 1.5 }) {
    this.projection = projection;
    this.model = model;
    this.originDistance = originDistance;
    this.rungWidth = rungWidth;
    this.staffWidth = staffWidth;
  }

  /** Distance along the line of sight at which the ground reaches `offset`. */
  distanceForOffset(offset) {
    const s = this.model.slope;
    if (Math.abs(s) < 1e-9) return offset === 0 ? this.originDistance : null;
    return this.originDistance + offset / s;
  }

  /** Ground elevation offset at a distance along the line of sight. */
  offsetAtDistance(Z) {
    return this.model.slope * (Z - this.originDistance);
  }

  /**
   * Build one rung: a horizontal bar of `width` centred on the measurement
   * plane at (Y, Z), plus the projected metadata the renderer needs.
   */
  _rung(level, Y, Z, width) {
    const p = this.projection;
    const half = width / 2;
    const left = p.project(-half, Y, Z);
    const right = p.project(half, Y, Z);
    const centre = p.project(0, Y, Z);
    if (!left || !right || !centre) {
      return { level, Y, Z, visible: false };
    }
    const screenWidth = Math.hypot(right.x - left.x, right.y - left.y);
    return {
      level,
      Y,
      Z,
      left,
      right,
      centre,
      depth: centre.depth,
      screenWidth,
      visible: true,
    };
  }

  /**
   * Drop rungs that have collapsed into each other near the horizon, and rungs
   * that have wandered far outside the photograph. Without this the top of the
   * ruler turns into an unreadable smear of overlapping labels.
   */
  _prune(rungs, { minSpacing = 5, minWidth = 6, margin = 0.6 } = {}) {
    const { imageWidth: w, imageHeight: h } = this.projection;
    const mx = w * margin;
    const my = h * margin;
    const inFrame = (pt) => pt.x > -mx && pt.x < w + mx && pt.y > -my && pt.y < h + my;

    const kept = [];
    const ordered = rungs.filter((r) => r.visible).sort((a, b) => a.depth - b.depth);
    for (const r of ordered) {
      if (r.screenWidth < minWidth) continue;
      if (!inFrame(r.centre)) continue;
      const last = kept[kept.length - 1];
      if (last) {
        const gap = Math.hypot(r.centre.x - last.centre.x, r.centre.y - last.centre.y);
        // Always keep the origin rung, it is the datum.
        if (gap < minSpacing && !r.level.isOrigin) continue;
      }
      kept.push(r);
    }
    return kept;
  }

  /** Ruler following the calibrated grade. Empty when the grade is flat. */
  slopeRungs(options = {}) {
    if (this.model.isFlat) return [];
    const out = [];
    for (const level of this.model.levels()) {
      const Z = this.distanceForOffset(level.offset);
      if (Z == null || !(Z > 1e-6)) continue;
      out.push(this._rung(level, level.offset, Z, this.rungWidth));
    }
    return this._prune(out, options);
  }

  /** Ruler as a levelling rod standing at `Z`. */
  staffRungs(Z = this.originDistance, options = {}) {
    if (!(Z > 1e-6)) return [];
    const out = [];
    for (const level of this.model.levels()) {
      out.push(this._rung(level, level.offset, Z, level.isOrigin ? this.staffWidth * 2 : this.staffWidth));
    }
    // A staff is one object at one distance: spacing shrinks but nothing
    // recedes, so prune on screen spacing alone.
    return this._prune(out, { minSpacing: 2, minWidth: 0, ...options }).sort((a, b) => a.Y - b.Y);
  }

  /** The vertical post of the staff, from the lowest to the highest rung. */
  staffPost(Z = this.originDistance) {
    const rungs = this.staffRungs(Z);
    if (rungs.length < 2) return null;
    return { a: rungs[0].centre, b: rungs[rungs.length - 1].centre };
  }

  /**
   * The calibrated ground line along the measurement plane, sampled so the
   * renderer can draw it as a polyline (it is straight in the world, and
   * therefore straight in the image, but sampling keeps clipping simple).
   */
  groundLine({ from = null, to = null, samples = 48 } = {}) {
    const p = this.projection;
    const near = from ?? Math.max(0.5, this.originDistance * 0.15);
    const far = to ?? this.originDistance + this.model.horizontalDistance * 6;
    const pts = [];
    for (let i = 0; i <= samples; i++) {
      const Z = near + ((far - near) * i) / samples;
      const proj = p.projectPlane(this.offsetAtDistance(Z), Z);
      if (proj) pts.push({ ...proj, Z });
    }
    return pts;
  }

  /**
   * The line of sight as the user placed it, extended to the vanishing point so
   * it reads as a direction in the scene rather than a segment between two taps.
   */
  lineOfSight() {
    const p = this.projection;
    return {
      near: p.losA,
      far: p.losB,
      vanishing: p.vanishingPoint,
      horizon: p.horizonSegment(),
    };
  }

  /** Everything the renderer needs, in one call. */
  build({ style = 'slope', staffDistance = null } = {}) {
    const useSlope = style === 'slope' || style === 'both';
    const useStaff = style === 'staff' || style === 'both' || this.model.isFlat;
    return {
      style,
      slope: useSlope ? this.slopeRungs() : [],
      staff: useStaff ? this.staffRungs(staffDistance ?? this.originDistance) : [],
      staffPost: useStaff ? this.staffPost(staffDistance ?? this.originDistance) : null,
      ground: this.groundLine(),
      sight: this.lineOfSight(),
    };
  }
}
