// SitePlanView.js
//
// The map half of the survey: a plan you can drop the five standard pins onto,
// with a scale, so distances come from where things actually are.
//
// It draws on a canvas rather than pulling map tiles, for two reasons. Tiles are
// blocked outright in some hosts (a published Artifact will not load an image
// from a tile server), and an imported aerial screenshot is what a landscaper
// has to hand anyway — it can be zoomed to the property before capture, which
// beats fighting a live map on an iPad in the sun. A plan with no backdrop still
// works: pins on a grid with a typed scale measure just as well.
//
// Plan coordinates are the backdrop image's own pixels when there is one, and an
// arbitrary unit space when there is not. The scale turns them into feet, so
// nothing downstream cares which.

import { clamp, dist } from '../core/Geometry.js';
import { STANDARD_POINTS } from '../core/SiteSurvey.js';

export const PIN_COLOURS = {
  observation: '#3ddc84',
  curb: '#8fe9ff',
  foundation: '#ffb300',
  eave: '#ff5cae',
  peak: '#c9a2ff',
};

const SHORT = { observation: 'OBS', curb: 'CURB', foundation: 'FDN', eave: 'EAVE', peak: 'PEAK' };

export class SitePlanView {
  constructor(canvas, { survey, onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.survey = survey;
    this.onChange = onChange;

    this.backdrop = null;
    this.planWidth = 1000;
    this.planHeight = 1000;

    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.minScale = 0.02;
    this.maxScale = 60;

    // The scale bar: two draggable ends and the distance between them.
    this.ruler = { a: { x: 300, y: 700 }, b: { x: 700, y: 700 } };
    this.showRuler = true;

    /** Which point the next tap on empty plan will place. */
    this.placing = null;

    this._pointers = new Map();
    this._gesture = null;
    this._raf = null;
    this._dpr = 1;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', this._down, { passive: false });
    c.addEventListener('pointermove', this._move, { passive: false });
    c.addEventListener('pointerup', this._up, { passive: false });
    c.addEventListener('pointercancel', this._up, { passive: false });
    c.addEventListener('wheel', this._wheel, { passive: false });
  }

  setBackdrop(image) {
    this.backdrop = image;
    if (image) {
      this.planWidth = image.naturalWidth || image.width;
      this.planHeight = image.naturalHeight || image.height;
      // Park the scale bar across the middle of a fresh aerial.
      this.ruler = {
        a: { x: this.planWidth * 0.3, y: this.planHeight * 0.7 },
        b: { x: this.planWidth * 0.7, y: this.planHeight * 0.7 },
      };
    }
    this.fit();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.render();
  }

  fit(padding = 24) {
    if (!this.cssWidth) return;
    const sx = (this.cssWidth - padding * 2) / this.planWidth;
    const sy = (this.cssHeight - padding * 2) / this.planHeight;
    this.scale = Math.min(sx, sy);
    this.minScale = this.scale * 0.3;
    this.offset = {
      x: (this.cssWidth - this.planWidth * this.scale) / 2,
      y: (this.cssHeight - this.planHeight * this.scale) / 2,
    };
    this.render();
  }

  toPlan(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offset.x) / this.scale,
      y: (clientY - rect.top - this.offset.y) / this.scale,
    };
  }

  toScreen(p) {
    return { x: p.x * this.scale + this.offset.x, y: p.y * this.scale + this.offset.y };
  }

  planTolerance(screenPx = 26) {
    return screenPx / this.scale;
  }

  /** Feet per plan unit, from the scale bar and its stated length. */
  setScaleFromRuler(knownFeet) {
    const px = dist(this.ruler.a, this.ruler.b);
    if (!(px > 1e-6) || !(knownFeet > 0)) return false;
    this.survey.scaleFeetPerUnit = knownFeet / px;
    this.onChange?.();
    this.render();
    return true;
  }

  get rulerFeet() {
    return dist(this.ruler.a, this.ruler.b) * this.survey.scaleFeetPerUnit;
  }

  // --- gestures -----------------------------------------------------------

  _hitPin(plan, tol) {
    let best = null;
    let bestDist = Infinity;
    for (const spec of STANDARD_POINTS) {
      const p = this.survey.point(spec.id);
      if (!p?.plan) continue; // a shared point has no pin of its own to grab
      const d = dist(p.plan, plan);
      if (d <= tol && d < bestDist) {
        bestDist = d;
        best = spec.id;
      }
    }
    return best;
  }

  _hitRuler(plan, tol) {
    if (!this.showRuler) return null;
    if (dist(this.ruler.a, plan) <= tol) return 'a';
    if (dist(this.ruler.b, plan) <= tol) return 'b';
    return null;
  }

  _down = (e) => {
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 2) {
      this._gesture = this._startPinch();
      return;
    }
    if (this._pointers.size > 2) return;

    const plan = this.toPlan(e.clientX, e.clientY);
    const tol = this.planTolerance();

    const rulerEnd = this._hitRuler(plan, tol);
    if (rulerEnd) {
      this._gesture = { type: 'ruler', end: rulerEnd };
      return;
    }
    const pin = this._hitPin(plan, tol);
    if (pin) {
      this._gesture = { type: 'pin', id: pin };
      return;
    }
    if (this.placing) {
      // Placing is one tap: drop it, then fall straight into dragging so it can
      // be nudged without lifting a finger.
      this.survey.place(this.placing, plan);
      this._gesture = { type: 'pin', id: this.placing };
      this.placing = null;
      this.onChange?.();
      this.render();
      return;
    }
    this._gesture = { type: 'pan', last: { x: e.clientX, y: e.clientY } };
  };

  _move = (e) => {
    if (!this._pointers.has(e.pointerId)) return;
    e.preventDefault();
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this._gesture;
    if (!g) return;

    if (g.type === 'pinch') {
      this._updatePinch();
      return;
    }
    if (g.type === 'pan') {
      this.offset = {
        x: this.offset.x + (e.clientX - g.last.x),
        y: this.offset.y + (e.clientY - g.last.y),
      };
      g.last = { x: e.clientX, y: e.clientY };
      this.render();
      return;
    }
    const plan = this.toPlan(e.clientX, e.clientY);
    if (g.type === 'ruler') this.ruler[g.end] = plan;
    else if (g.type === 'pin') this.survey.place(g.id, plan);
    this.onChange?.();
    this.render();
  };

  _up = (e) => {
    if (!this._pointers.has(e.pointerId)) return;
    e.preventDefault();
    this._pointers.delete(e.pointerId);
    this.canvas.releasePointerCapture?.(e.pointerId);
    if (this._gesture?.type === 'pinch') {
      const remaining = [...this._pointers.values()][0];
      this._gesture = remaining ? { type: 'pan', last: { ...remaining } } : null;
      return;
    }
    if (this._pointers.size === 0) this._gesture = null;
  };

  _startPinch() {
    const [a, b] = [...this._pointers.values()];
    return {
      type: 'pinch',
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      startScale: this.scale,
      startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      startOffset: { ...this.offset },
    };
  }

  _updatePinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const g = this._gesture;
    if (g.startDist < 1) return;
    const scale = clamp((g.startScale * Math.hypot(a.x - b.x, a.y - b.y)) / g.startDist,
                        this.minScale, this.maxScale);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rect = this.canvas.getBoundingClientRect();
    const anchor = {
      x: (g.startMid.x - rect.left - g.startOffset.x) / g.startScale,
      y: (g.startMid.y - rect.top - g.startOffset.y) / g.startScale,
    };
    this.scale = scale;
    this.offset = { x: mid.x - rect.left - anchor.x * scale, y: mid.y - rect.top - anchor.y * scale };
    this.render();
  }

  _wheel = (e) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const anchor = this.toPlan(e.clientX, e.clientY);
    this.scale = clamp(this.scale * Math.exp(-e.deltaY * 0.0016), this.minScale, this.maxScale);
    this.offset = {
      x: e.clientX - rect.left - anchor.x * this.scale,
      y: e.clientY - rect.top - anchor.y * this.scale,
    };
    this.render();
  };

  zoomBy(factor) {
    const anchor = {
      x: (this.cssWidth / 2 - this.offset.x) / this.scale,
      y: (this.cssHeight / 2 - this.offset.y) / this.scale,
    };
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    this.offset = {
      x: this.cssWidth / 2 - anchor.x * this.scale,
      y: this.cssHeight / 2 - anchor.y * this.scale,
    };
    this.render();
  }

  // --- drawing ------------------------------------------------------------

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._paint();
    });
  }

  _paint() {
    const ctx = this.ctx;
    if (!this.cssWidth) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.scale(this._dpr, this._dpr);
    ctx.fillStyle = '#0a1017';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.scale, this.scale);

    if (this.backdrop) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.backdrop, 0, 0, this.planWidth, this.planHeight);
    } else {
      this._grid(ctx);
    }

    // Screen-space line weights: the plan zooms, the furniture should not.
    const u = 1 / this.scale;
    this._sightLines(ctx, u);
    if (this.showRuler) this._rulerBar(ctx, u);
    this._pins(ctx, u);
    ctx.restore();
  }

  _grid(ctx) {
    ctx.fillStyle = '#0d141c';
    ctx.fillRect(0, 0, this.planWidth, this.planHeight);
    ctx.strokeStyle = 'rgba(143,233,255,0.10)';
    ctx.lineWidth = 1 / this.scale;
    const step = 50;
    ctx.beginPath();
    for (let x = 0; x <= this.planWidth; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.planHeight);
    }
    for (let y = 0; y <= this.planHeight; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.planWidth, y);
    }
    ctx.stroke();
  }

  _text(ctx, text, at, u, { size = 12, color = '#e8eef5', align = 'center', weight = '700' } = {}) {
    ctx.save();
    ctx.font = `${weight} ${size * u}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = size * u * 0.34;
    ctx.strokeText(text, at.x, at.y);
    ctx.fillStyle = color;
    ctx.fillText(text, at.x, at.y);
    ctx.restore();
  }

  /** Lines from where you stood to each target, labelled with the distance. */
  _sightLines(ctx, u) {
    const obs = this.survey.planOf('observation');
    if (!obs) return;
    for (const spec of STANDARD_POINTS) {
      if (spec.id === 'observation') continue;
      if (this.survey.isShared(spec.id)) continue; // rides the line of the pin it shares
      const at = this.survey.planOf(spec.id);
      if (!at) continue;
      ctx.save();
      ctx.strokeStyle = PIN_COLOURS[spec.id];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5 * u;
      ctx.setLineDash([6 * u, 5 * u]);
      ctx.beginPath();
      ctx.moveTo(obs.x, obs.y);
      ctx.lineTo(at.x, at.y);
      ctx.stroke();
      ctx.restore();
      const feet = this.survey.distanceFromObservation(spec.id);
      if (feet != null) {
        const mid = { x: (obs.x + at.x) / 2, y: (obs.y + at.y) / 2 };
        this._text(ctx, `${feet.toFixed(1)}'`, mid, u, { size: 11, color: PIN_COLOURS[spec.id] });
      }
    }
  }

  _rulerBar(ctx, u) {
    const { a, b } = this.ruler;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5 * u;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const end of [a, b]) {
      ctx.beginPath();
      ctx.arc(end.x, end.y, 7 * u, 0, Math.PI * 2);
      ctx.fillStyle = '#0a1017';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this._text(ctx, `SCALE ${this.rulerFeet.toFixed(1)}'`, { x: mid.x, y: mid.y - 16 * u }, u, {
      size: 12,
    });
  }

  _pins(ctx, u) {
    for (const spec of STANDARD_POINTS) {
      if (this.survey.isShared(spec.id)) continue; // drawn on the pin it shares
      const at = this.survey.planOf(spec.id);
      if (!at) continue;
      const p = this.survey.point(spec.id);
      const colour = PIN_COLOURS[spec.id];
      const r = 9 * u;

      ctx.save();
      ctx.lineWidth = 2.4 * u;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2 * u;
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * 0.42, 0, Math.PI * 2);
      ctx.fill();
      // Where you stood gets a ring, so the one station reads apart from the
      // four targets without a legend.
      if (spec.id === 'observation') {
        ctx.beginPath();
        ctx.arc(at.x, at.y, r * 1.8, 0, Math.PI * 2);
        ctx.setLineDash([4 * u, 4 * u]);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.4 * u;
        ctx.stroke();
      }
      ctx.restore();

      const elev = this.survey.elevationOf(spec.id);
      const shots = p.shots.length;
      const line2 =
        spec.id === 'observation'
          ? "0.00' datum"
          : elev
            ? `${elev.feet >= 0 ? '+' : ''}${elev.feet.toFixed(2)}'`
            : shots
              ? 'needs scale'
              : 'not shot';
      // Name every shot this one pin carries, so a stacked wall reads as one thing.
      const riders = STANDARD_POINTS.filter(
        (o) => o.id !== spec.id && this.survey.isShared(o.id) && this.survey.planOf(o.id) === at,
      ).map((o) => SHORT[o.id]);
      this._text(ctx, [SHORT[spec.id], ...riders].join('·'), { x: at.x, y: at.y - 20 * u }, u,
                 { size: 11, color: colour });
      this._text(ctx, line2, { x: at.x, y: at.y + 21 * u }, u, { size: 12 });
    }
  }
}
