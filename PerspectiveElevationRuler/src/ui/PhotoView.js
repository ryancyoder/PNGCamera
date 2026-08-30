// PhotoView.js
//
// The working canvas: holds the photograph, maps between screen and photo
// pixels, and turns touches into gestures. It knows nothing about elevations —
// it reports "the user touched photo pixel (x, y)" and lets the app decide.
//
// The photograph itself is never modified. It is drawn from the original
// HTMLImageElement on every frame and the overlay is composited on top.

import { clamp } from '../core/Geometry.js';

export class PhotoView {
  constructor(canvas, { onPointerDown, onPointerMove, onPointerUp, onViewChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.imageWidth = 0;
    this.imageHeight = 0;

    // View transform: photo pixel -> css pixel is  p * scale + offset
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.minScale = 0.05;
    this.maxScale = 40;

    this.onPointerDown = onPointerDown;
    this.onPointerMove = onPointerMove;
    this.onPointerUp = onPointerUp;
    this.onViewChange = onViewChange;

    this.drawOverlay = null; // set by the app: (ctx) => void
    this._pointers = new Map();
    this._gesture = null;
    this._dpr = 1;
    this._raf = null;

    this._bind();
  }

  // --- lifecycle ----------------------------------------------------------

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', this._down, { passive: false });
    c.addEventListener('pointermove', this._move, { passive: false });
    c.addEventListener('pointerup', this._up, { passive: false });
    c.addEventListener('pointercancel', this._up, { passive: false });
    c.addEventListener('pointerleave', this._up, { passive: false });
    c.addEventListener('wheel', this._wheel, { passive: false });
    // Safari on iPad still fires these for pinch on some surfaces.
    c.addEventListener('gesturestart', (e) => e.preventDefault());
    c.addEventListener('gesturechange', (e) => e.preventDefault());
  }

  setImage(image) {
    this.image = image;
    this.imageWidth = image ? image.naturalWidth || image.width : 0;
    this.imageHeight = image ? image.naturalHeight || image.height : 0;
    this.fit();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.render();
  }

  /** Scale and centre the photograph so the whole frame is visible. */
  fit(padding = 0) {
    if (!this.image || !this.cssWidth) return;
    const sx = (this.cssWidth - padding * 2) / this.imageWidth;
    const sy = (this.cssHeight - padding * 2) / this.imageHeight;
    this.scale = Math.min(sx, sy);
    this.minScale = this.scale * 0.5;
    this.offset = {
      x: (this.cssWidth - this.imageWidth * this.scale) / 2,
      y: (this.cssHeight - this.imageHeight * this.scale) / 2,
    };
    this._changed();
  }

  // --- coordinate conversion ---------------------------------------------

  toPhoto(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offset.x) / this.scale,
      y: (clientY - rect.top - this.offset.y) / this.scale,
    };
  }

  toScreen(p) {
    return { x: p.x * this.scale + this.offset.x, y: p.y * this.scale + this.offset.y };
  }

  /** A touch-sized tolerance in screen pixels, expressed in photo pixels. */
  photoTolerance(screenPx = 28) {
    return screenPx / this.scale;
  }

  inBounds(p) {
    return p.x >= 0 && p.y >= 0 && p.x <= this.imageWidth && p.y <= this.imageHeight;
  }

  // --- gestures -----------------------------------------------------------

  _down = (e) => {
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 2) {
      // A second finger always means transform, so cancel whatever the first
      // finger had started. Prevents a stray drag while pinching.
      if (this._gesture?.type === 'app') this.onPointerUp?.(null, { cancelled: true });
      this._gesture = this._startPinch();
      return;
    }
    if (this._pointers.size > 2) return;

    const photo = this.toPhoto(e.clientX, e.clientY);
    const handled = this.onPointerDown?.(photo, e);
    this._gesture = handled
      ? { type: 'app' }
      : { type: 'pan', last: { x: e.clientX, y: e.clientY } };
  };

  _move = (e) => {
    if (!this._pointers.has(e.pointerId)) return;
    e.preventDefault();
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._gesture?.type === 'pinch') {
      this._updatePinch();
      return;
    }
    if (this._gesture?.type === 'pan') {
      const dx = e.clientX - this._gesture.last.x;
      const dy = e.clientY - this._gesture.last.y;
      this._gesture.last = { x: e.clientX, y: e.clientY };
      this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
      this._changed();
      return;
    }
    if (this._gesture?.type === 'app') {
      this.onPointerMove?.(this.toPhoto(e.clientX, e.clientY), e);
    }
  };

  _up = (e) => {
    if (!this._pointers.has(e.pointerId)) return;
    e.preventDefault();
    this._pointers.delete(e.pointerId);
    this.canvas.releasePointerCapture?.(e.pointerId);

    if (this._gesture?.type === 'pinch') {
      // Drop back to a pan with whichever finger is still down.
      const remaining = [...this._pointers.values()][0];
      this._gesture = remaining ? { type: 'pan', last: { ...remaining } } : null;
      return;
    }
    if (this._gesture?.type === 'app') {
      this.onPointerUp?.(this.toPhoto(e.clientX, e.clientY), e);
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
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (g.startDist < 1) return;
    const factor = d / g.startDist;
    const scale = clamp(g.startScale * factor, this.minScale, this.maxScale);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rect = this.canvas.getBoundingClientRect();

    // Keep the photo point under the pinch midpoint anchored, and let the
    // midpoint itself carry the pan.
    const anchor = {
      x: (g.startMid.x - rect.left - g.startOffset.x) / g.startScale,
      y: (g.startMid.y - rect.top - g.startOffset.y) / g.startScale,
    };
    this.scale = scale;
    this.offset = {
      x: mid.x - rect.left - anchor.x * scale,
      y: mid.y - rect.top - anchor.y * scale,
    };
    this._changed();
  }

  _wheel = (e) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const anchor = this.toPhoto(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0016);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    this.offset = {
      x: e.clientX - rect.left - anchor.x * this.scale,
      y: e.clientY - rect.top - anchor.y * this.scale,
    };
    this._changed();
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
    this._changed();
  }

  _changed() {
    this.onViewChange?.();
    this.render();
  }

  // --- rendering ----------------------------------------------------------

  /** Coalesce redraws onto the next animation frame. */
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._paint();
    });
  }

  _paint() {
    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.scale, this.scale);

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, 0, 0, this.imageWidth, this.imageHeight);
    this.drawOverlay?.(ctx);

    ctx.restore();
  }
}
