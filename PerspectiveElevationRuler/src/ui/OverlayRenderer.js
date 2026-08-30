// OverlayRenderer.js
//
// Draws the ruler and the annotations. Everything is drawn in PHOTO PIXEL
// coordinates; the caller sets a transform beforehand. That is what makes the
// export byte-for-byte the same picture as the screen — the export just uses
// the identity transform at full resolution instead of the fit-to-screen one.
//
// Line weights and type sizes are derived from the photograph's own width, so
// the overlay scales with the image rather than with the viewport.

import { add, scale, sub, dot, normalize, perp, dist, clipSegmentToRect } from '../core/Geometry.js';

export const PALETTE = {
  rung: '#8fe9ff',
  rungMajor: '#ffffff',
  origin: '#3ddc84',
  known: '#ffa726',
  sight: '#ffb300',
  measure: '#ff5cae',
  ground: '#7cf7c4',
  horizon: '#c9d6e2',
  dimension: '#ffffff',
  halo: 'rgba(0, 0, 0, 0.72)',
  text: '#ffffff',
};

export class OverlayRenderer {
  constructor() {
    this.opacity = 1;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx transformed into photo pixel space
   * @param {object} scene everything to draw
   */
  draw(ctx, scene) {
    const {
      projection,
      model,
      ruler,
      annotations,
      options,
      originDistance,
      imageWidth,
      imageHeight,
    } = scene;

    if (!projection || !model || !ruler) return;

    const u = imageWidth / 1000; // one "design unit"
    ctx.save();
    ctx.globalAlpha = options.opacity;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'middle';

    const geo = ruler.build({
      style: options.rulerStyle,
      staffDistance: options.staffDistance ?? originDistance,
    });

    if (options.showHorizon) this._horizon(ctx, u, geo.sight.horizon);
    if (options.showRuler) {
      this._groundLine(ctx, u, geo.ground, imageWidth, imageHeight);
      this._slopeRungs(ctx, u, geo.slope, model, options);
      this._staff(ctx, u, geo.staff, geo.staffPost, model, options);
    }
    if (options.showSight) this._lineOfSight(ctx, u, projection, geo.sight, imageWidth, imageHeight);

    this._dimensions(ctx, u, annotations, model, projection, originDistance);
    this._points(ctx, u, annotations, model, options);
    if (options.showCrosshair) this._crosshair(ctx, u, projection, imageWidth, imageHeight);

    ctx.restore();
  }

  // --- primitives ---------------------------------------------------------

  _stroke(ctx, path, { color, width, halo = true, alpha = 1, dash = null }) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (dash) ctx.setLineDash(dash);
    if (halo) {
      ctx.strokeStyle = PALETTE.halo;
      ctx.lineWidth = width * 2.6;
      path();
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    path();
    ctx.stroke();
    ctx.restore();
  }

  _line(ctx, a, b, style) {
    this._stroke(
      ctx,
      () => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      },
      style,
    );
  }

  _polyline(ctx, pts, style) {
    if (pts.length < 2) return;
    this._stroke(
      ctx,
      () => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      },
      style,
    );
  }

  /**
   * Text with a dark halo so it stays readable over any photograph, plus an
   * optional filled plate for the labels that carry numbers.
   */
  _label(ctx, text, at, u, opts = {}) {
    const {
      size = 22,
      color = PALETTE.text,
      align = 'left',
      weight = '600',
      plate = false,
      plateColor = 'rgba(8, 14, 20, 0.66)',
      alpha = 1,
      angle = 0,
    } = opts;

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(at.x, at.y);
    if (angle) ctx.rotate(angle);
    const px = size * u;
    ctx.font = `${weight} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';

    if (plate) {
      const w = ctx.measureText(text).width;
      const padX = px * 0.45;
      const padY = px * 0.36;
      const x = align === 'right' ? -w - padX : align === 'center' ? -w / 2 - padX : -padX;
      ctx.fillStyle = plateColor;
      const r = px * 0.28;
      const bw = w + padX * 2;
      const bh = px + padY * 2;
      const by = -bh / 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, by, bw, bh, r);
      else ctx.rect(x, by, bw, bh);
      ctx.fill();
    } else {
      ctx.strokeStyle = PALETTE.halo;
      ctx.lineWidth = px * 0.24;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, 0, 0);
    }

    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  _marker(ctx, at, u, { color, size = 9, filled = true, ring = false }) {
    const r = size * u;
    ctx.save();
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = PALETTE.halo;
    ctx.lineWidth = 3.2 * u;
    ctx.stroke();
    if (filled) {
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2 * u;
    ctx.stroke();
    if (ring) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * 2, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 * u;
      ctx.setLineDash([4 * u, 4 * u]);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- scene elements -----------------------------------------------------

  _horizon(ctx, u, segment) {
    if (!segment) return;
    this._line(ctx, segment.a, segment.b, {
      color: PALETTE.horizon,
      width: 1.6 * u,
      alpha: 0.5,
      dash: [10 * u, 9 * u],
    });
    const dir = normalize(sub(segment.b, segment.a));
    const at = add(segment.a, scale(dir, dist(segment.a, segment.b) * 0.06));
    this._label(ctx, 'HORIZON', add(at, scale(perp(dir), -10 * u)), u, {
      size: 13,
      color: PALETTE.horizon,
      alpha: 0.75,
    });
  }

  _groundLine(ctx, u, pts, w, h) {
    const inside = pts.filter(
      (p) => p.x > -w * 0.5 && p.x < w * 1.5 && p.y > -h * 0.5 && p.y < h * 1.5,
    );
    if (inside.length < 2) return;
    this._polyline(ctx, inside, {
      color: PALETTE.ground,
      width: 2 * u,
      alpha: 0.55,
      dash: [7 * u, 7 * u],
    });
  }

  /**
   * The staircase. Each rung is a real horizontal bar in the scene, so it
   * shortens and the gaps close up as the ruler climbs into the distance.
   * Rungs are faded by depth, which is what sells the "it is standing in the
   * photograph" effect more than anything else.
   */
  _slopeRungs(ctx, u, rungs, model, options) {
    if (!rungs.length) return;
    const depths = rungs.map((r) => r.depth);
    const near = Math.min(...depths);
    const far = Math.max(...depths);
    const fade = (d) => {
      if (far - near < 1e-6) return 1;
      const k = (d - near) / (far - near);
      return 1 - 0.55 * k; // never fully transparent
    };

    // Risers: connect consecutive rungs down the centre of the measurement
    // plane so the ruler reads as one continuous object.
    const ordered = [...rungs].sort((a, b) => a.Z - b.Z);
    for (let i = 1; i < ordered.length; i++) {
      this._line(ctx, ordered[i - 1].centre, ordered[i].centre, {
        color: PALETTE.rung,
        width: 1.4 * u,
        alpha: 0.35 * fade(ordered[i].depth),
      });
    }

    // Labels are culled independently of the rungs. The rungs themselves may
    // crowd together near the horizon — that reads correctly, like a real
    // ruler — but overlapping numbers do not, so a label is only drawn once
    // there is room for it clear of the last one.
    const minLabelGap = 26 * u;
    let lastLabel = null;

    for (const r of ordered) {
      const a = fade(r.depth);
      const major = r.level.isOrigin;
      this._line(ctx, r.left, r.right, {
        color: major ? PALETTE.origin : r.level.isMajor ? PALETTE.rungMajor : PALETTE.rung,
        width: (major ? 3.4 : r.level.isMajor ? 2.3 : 1.5) * u * (0.6 + 0.4 * a),
        alpha: major ? 1 : a,
      });

      if (!options.showLabels) continue;
      if (!r.level.isMajor && r.screenWidth < 60 * u) continue;
      const dir = normalize(sub(r.right, r.left));
      const at = add(r.right, scale(dir, 10 * u));
      // The origin is the datum: it is always labelled, whatever else is culled.
      if (!major && lastLabel && dist(at, lastLabel) < minLabelGap) continue;
      lastLabel = at;
      const text = options.labelMode === 'change' ? r.level.change : r.level.label;
      this._label(ctx, text, at, u, {
        size: major ? 20 : 17,
        color: major ? PALETTE.origin : PALETTE.text,
        alpha: Math.max(0.55, a),
        plate: true,
        angle: Math.atan2(dir.y, dir.x),
      });
    }
  }

  _staff(ctx, u, rungs, post, model, options) {
    if (!rungs.length) return;
    if (post) {
      this._line(ctx, post.a, post.b, { color: PALETTE.rung, width: 2.4 * u, alpha: 0.8 });
    }
    const minStaffGap = 24 * u;
    let lastStaffLabel = null;
    for (const r of rungs) {
      const major = r.level.isOrigin;
      this._line(ctx, r.left, r.right, {
        color: major ? PALETTE.origin : r.level.isMajor ? PALETTE.rungMajor : PALETTE.rung,
        width: (major ? 3.2 : r.level.isMajor ? 2.2 : 1.3) * u,
        alpha: major ? 1 : r.level.isMajor ? 0.95 : 0.7,
      });
      if (!options.showLabels || !r.level.isMajor) continue;
      const dir = normalize(sub(r.right, r.left));
      const at = add(r.right, scale(dir, 8 * u));
      if (!major && lastStaffLabel && dist(at, lastStaffLabel) < minStaffGap) continue;
      lastStaffLabel = at;
      const text = options.labelMode === 'change' ? r.level.change : r.level.label;
      this._label(ctx, text, at, u, {
        size: major ? 19 : 16,
        color: major ? PALETTE.origin : PALETTE.text,
        plate: true,
        angle: Math.atan2(dir.y, dir.x),
      });
    }
  }

  _lineOfSight(ctx, u, projection, sight, w, h) {
    // Extend the user's line all the way to the vanishing point: the line of
    // sight is a direction in the scene, not a segment between two taps.
    const dir = projection.d;
    const span = (w + h) * 1.5;
    const seg = clipSegmentToRect(
      add(sight.near, scale(dir, -span)),
      add(sight.near, scale(dir, span)),
      { x: 0, y: 0, width: w, height: h },
    );
    if (seg) {
      this._line(ctx, seg.a, seg.b, {
        color: PALETTE.sight,
        width: 1.8 * u,
        alpha: 0.65,
        dash: [16 * u, 10 * u],
      });
      // Ride the label down near the camera end of the sight line, where the
      // scene is emptiest — the middle is where the ruler and the callouts are.
      const nearEnd = dot(sub(seg.a, seg.b), dir) < 0 ? seg.a : seg.b;
      const farEnd = nearEnd === seg.a ? seg.b : seg.a;
      const at = add(nearEnd, scale(sub(farEnd, nearEnd), 0.16));
      const angle = Math.atan2(dir.y, dir.x);
      this._label(ctx, 'LINE OF SIGHT', add(at, scale(perp(dir), -14 * u)), u, {
        size: 14,
        color: PALETTE.sight,
        align: 'center',
        angle: Math.abs(angle) > Math.PI / 2 ? angle + Math.PI : angle,
      });
    }

    const vp = sight.vanishing;
    if (vp.x > -w && vp.x < w * 2 && vp.y > -h && vp.y < h * 2) {
      this._marker(ctx, vp, u, { color: PALETTE.sight, size: 4, filled: false, ring: true });
    }
  }

  _crosshair(ctx, u, projection, w, h) {
    const c = { x: w / 2, y: h / 2 };
    const arm = Math.min(w, h) * 0.06;
    const gap = arm * 0.25;
    const style = { color: PALETTE.text, width: 1.4 * u, alpha: 0.55 };
    this._line(ctx, { x: c.x - arm, y: c.y }, { x: c.x - gap, y: c.y }, style);
    this._line(ctx, { x: c.x + gap, y: c.y }, { x: c.x + arm, y: c.y }, style);
    this._line(ctx, { x: c.x, y: c.y - arm }, { x: c.x, y: c.y - gap }, style);
    this._line(ctx, { x: c.x, y: c.y + gap }, { x: c.x, y: c.y + arm }, style);
  }

  _points(ctx, u, annotations, model, options) {
    for (const p of annotations.points.values()) {
      const colour =
        p.role === 'origin'
          ? PALETTE.origin
          : p.role === 'known'
            ? PALETTE.known
            : PALETTE.measure;
      const selected = annotations.selectedId === p.id;

      this._marker(ctx, p.imagePoint, u, {
        color: colour,
        size: p.role === 'point' ? 7 : 8.5,
        ring: selected,
      });

      if (!options.showLabels) continue;

      const at = add(p.imagePoint, scale(p.labelOffset, u));
      // Rung numbers always sit off the right-hand end of the ruler, so point
      // callouts default to the other side. Once the user drags a callout, the
      // side it ends up on decides how its text is aligned.
      const align = p.labelOffset.x < 0 ? 'right' : 'left';

      // The measured/projected distinction is what stops an estimate being read
      // as a survey, so it rides on the name line rather than being an extra
      // line that could get cropped or overlooked.
      const tag = !p.valid ? 'NO READING' : p.isMeasured ? 'MEASURED' : 'PROJECTED';
      const lines = [
        { text: `${p.label || 'POINT'} · ${tag}`, size: 13, color: p.isMeasured ? PALETTE.origin : colour, weight: '700' },
      ];
      if (p.valid) {
        lines.push({ text: model.formatElevation(p.elevation), size: 19, color: PALETTE.text, weight: '700' });
        if (p.role !== 'origin') {
          lines.push({ text: model.formatChange(p.offset), size: 16, color: PALETTE.text, weight: '600' });
        }
        if (options.showDistances && p.distance != null) {
          lines.push({
            text: `@ ${model.formatNumber(p.distance)}${model.unitSuffix}`,
            size: 14,
            color: PALETTE.horizon,
            weight: '600',
          });
        }
      }

      // Leader line from the marker to its label block.
      this._line(ctx, p.imagePoint, at, { color: colour, width: 1.2 * u, alpha: 0.6 });

      let y = at.y;
      for (const line of lines) {
        const lh = line.size * u * 1.34;
        this._label(ctx, line.text, { x: at.x, y: y + lh / 2 }, u, {
          size: line.size,
          color: line.color,
          weight: line.weight,
          align,
          plate: true,
        });
        y += lh;
      }
    }
  }

  _dimensions(ctx, u, annotations, model, projection, originDistance) {
    const resolved = annotations.resolveDimensions(model, projection, originDistance);
    for (const r of resolved) {
      const a = r.a.imagePoint;
      const b = r.b.imagePoint;

      if (r.dimension.style === 'horizontal') {
        this._line(ctx, a, b, { color: PALETTE.dimension, width: 1.8 * u, alpha: 0.85 });
        this._arrowHead(ctx, u, b, normalize(sub(b, a)));
        this._arrowHead(ctx, u, a, normalize(sub(a, b)));
      } else {
        // A vertical dimension is drawn as a true vertical in the scene: from
        // the lower point straight up to the elevation of the higher one.
        const lower = r.rise >= 0 ? r.a : r.b;
        const upper = r.rise >= 0 ? r.b : r.a;
        const top = projection.projectPlane(upper.offset, lower.distance ?? originDistance);
        const foot = projection.projectPlane(lower.offset, lower.distance ?? originDistance);
        if (top && foot) {
          this._line(ctx, foot, top, { color: PALETTE.dimension, width: 1.8 * u, alpha: 0.9 });
          this._arrowHead(ctx, u, top, normalize(sub(top, foot)));
          this._arrowHead(ctx, u, foot, normalize(sub(foot, top)));
          // Tie line across to the upper point so the reader sees what is being
          // compared with what.
          this._line(ctx, top, upper.imagePoint, {
            color: PALETTE.dimension,
            width: 1 * u,
            alpha: 0.5,
            dash: [6 * u, 6 * u],
          });
        }
      }

      const mid = add(a, scale(sub(b, a), 0.5));
      this._label(ctx, r.text, add(mid, scale(r.dimension.labelOffset, u)), u, {
        size: 18,
        align: 'center',
        plate: true,
        weight: '700',
      });
    }
  }

  _arrowHead(ctx, u, at, dir) {
    const size = 9 * u;
    const p = perp(dir);
    const back = sub(at, scale(dir, size));
    const l = add(back, scale(p, size * 0.42));
    const r = sub(back, scale(p, size * 0.42));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.lineTo(l.x, l.y);
    ctx.lineTo(r.x, r.y);
    ctx.closePath();
    ctx.fillStyle = PALETTE.dimension;
    ctx.strokeStyle = PALETTE.halo;
    ctx.lineWidth = 2 * u;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}
