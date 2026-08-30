// App.js
//
// The controller. It owns the state, drives the calibration, and keeps the DOM
// and the canvas in step. All of the mathematics lives in src/core — this file
// only decides *when* to ask for it.

import { clamp, DEG, RAD, dist, add, scale } from '../core/Geometry.js';
import { calibrate, solveFromPitch } from '../core/PerspectiveCalibration.js';
import { ElevationModel } from '../core/ElevationModel.js';
import { ElevationRuler } from '../core/ElevationRuler.js';
import { AnnotationManager } from '../core/AnnotationManager.js';
import { PhotoView } from './PhotoView.js';
import { OverlayRenderer } from './OverlayRenderer.js';
import { ExportManager } from './ExportManager.js';

const STORAGE_KEY = 'perspective-elevation-ruler/v1';

const STEP_TEXT = {
  1: ['STEP 1', 'Take or choose a photograph looking across the slope.'],
  2: ['STEP 2', 'Tap the <strong>origin</strong> — the point whose elevation you know.'],
  3: ['STEP 3', 'Tap <strong>Point B</strong>, farther along the same sight line.'],
  4: ['STEP 4', 'Check the <strong>line of sight</strong>. Drag either point to re-aim it.'],
  5: ['STEP 5', 'Fine-tune until the ruler sits on the ground, then measure.'],
};

export class App {
  constructor(root = document) {
    this.$ = (id) => root.getElementById(id);

    this.state = {
      originElevation: 100,
      knownElevation: 103,
      horizontalDistance: 40,
      increment: 1,
      range: 10,
      unit: 'ft',
      fovDeg: 60,
      solveMode: 'height',
      solveValue: 5.5,
      rulerStyle: 'slope',
      rungWidth: 10,
      staffDistance: null,
      opacity: 1,
      showRuler: true,
      showLabels: true,
      showSight: true,
      showHorizon: true,
      showCrosshair: false,
      showDistances: false,
      labelMode: 'elevation',
      tool: 'select',
      step: 1,
    };

    this.image = null;
    this.imageDataUrl = null;
    this.annotations = new AnnotationManager();
    this.renderer = new OverlayRenderer();
    this.exporter = new ExportManager(this.renderer);
    this.projection = null;
    this.solution = null;
    this.model = this._buildModel();
    this.ruler = null;
    this.calibrationError = null;
    this.selectionQueue = [];
    this.drag = null;
    this._snapNoticeShown = false;

    this._buildView();
    this._bindControls();
    this._restore();
    this._syncControls();
    this._recalculate();
    this._updateStep();
  }

  // ======================================================================
  // Wiring
  // ======================================================================

  _buildView() {
    this.view = new PhotoView(this.$('photo-canvas'), {
      onPointerDown: (p, e) => this._pointerDown(p, e),
      onPointerMove: (p, e) => this._pointerMove(p, e),
      onPointerUp: (p, e) => this._pointerUp(p, e),
    });
    this.view.drawOverlay = (ctx) => this._drawOverlay(ctx);

    const resize = () => this.view.resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 220));
    requestAnimationFrame(resize);

    this.$('zoom-in').onclick = () => this.view.zoomBy(1.4);
    this.$('zoom-out').onclick = () => this.view.zoomBy(1 / 1.4);
    this.$('zoom-fit').onclick = () => this.view.fit(12);
  }

  _bindControls() {
    const $ = this.$;

    // --- photograph -------------------------------------------------------
    const camera = $('file-camera');
    const library = $('file-library');
    camera.onchange = (e) => this._loadFile(e.target.files?.[0]);
    library.onchange = (e) => this._loadFile(e.target.files?.[0]);
    const take = () => camera.click();
    const choose = () => library.click();
    $('btn-take').onclick = take;
    $('btn-choose').onclick = choose;
    $('empty-take').onclick = take;
    $('empty-choose').onclick = choose;

    // --- drawer -----------------------------------------------------------
    $('drawer-toggle').onclick = () => this._setDrawer(true);
    $('panel-close').onclick = () => this._setDrawer(false);

    // --- reference points -------------------------------------------------
    $('btn-set-origin').onclick = () => this._arm('origin');
    $('btn-set-known').onclick = () => this._arm('known');

    this._numberField('in-origin-elev', 'originElevation');
    this._numberField('in-known-elev', 'knownElevation');
    this._numberField('in-distance', 'horizontalDistance', (v) => (v > 0 ? v : null));

    // --- calibration ------------------------------------------------------
    $('in-fov').oninput = (e) => {
      this.state.fovDeg = Number(e.target.value);
      $('out-fov').textContent = `${this.state.fovDeg}°`;
      this._recalculate();
    };

    $('in-solve-mode').onchange = (e) => {
      this.state.solveMode = e.target.value;
      // Carry the current geometry across so nothing jumps when the mode flips.
      if (this.solution) {
        this.state.solveValue =
          this.state.solveMode === 'height'
            ? this.solution.cameraHeight
            : this.state.solveMode === 'distance'
              ? this.solution.originDistance
              : this.solution.pitchRad * RAD;
      }
      this._syncSolveSlider();
      this._recalculate();
    };

    $('in-solve').oninput = (e) => {
      this.state.solveValue = Number(e.target.value);
      this._recalculate();
    };

    // --- ruler ------------------------------------------------------------
    $('in-increment').onchange = (e) => {
      this.state.increment = Number(e.target.value);
      this._recalculate();
    };
    $('in-range').oninput = (e) => {
      this.state.range = Number(e.target.value);
      $('out-range').textContent = `±${this.state.range}${this._suffix}`;
      this._recalculate();
    };
    $('in-style').onchange = (e) => {
      this.state.rulerStyle = e.target.value;
      this._syncStyleFields();
      this._recalculate();
    };
    $('in-rung-width').oninput = (e) => {
      this.state.rungWidth = Number(e.target.value);
      $('out-rung-width').textContent = `${this.state.rungWidth}${this._suffix}`;
      this._recalculate();
    };
    $('in-staff-distance').oninput = (e) => {
      this.state.staffDistance = Number(e.target.value);
      $('out-staff-distance').textContent = `${this.state.staffDistance}${this._suffix}`;
      this._recalculate();
    };
    $('in-label-mode').onchange = (e) => {
      this.state.labelMode = e.target.value;
      this._recalculate();
    };

    // --- display ----------------------------------------------------------
    $('in-opacity').oninput = (e) => {
      this.state.opacity = Number(e.target.value) / 100;
      $('out-opacity').textContent = `${e.target.value}%`;
      this.view.render();
      this._persist();
    };
    const toggle = (id, key) => {
      $(id).onchange = (e) => {
        this.state[key] = e.target.checked;
        this.view.render();
        this._persist();
      };
    };
    toggle('tg-ruler', 'showRuler');
    toggle('tg-labels', 'showLabels');
    toggle('tg-sight', 'showSight');
    toggle('tg-horizon', 'showHorizon');
    toggle('tg-crosshair', 'showCrosshair');
    toggle('tg-distances', 'showDistances');

    $('in-units').onchange = (e) => {
      this.state.unit = e.target.value;
      this._recalculate();
      this._syncControls();
    };

    // --- measurements -----------------------------------------------------
    $('btn-dim-vertical').onclick = () => this._addDimension('vertical');
    $('btn-dim-horizontal').onclick = () => this._addDimension('horizontal');
    $('btn-dim-grade').onclick = () => this._addDimension('grade');
    $('btn-clear-points').onclick = () => {
      this.annotations.clearMeasurements();
      this.selectionQueue = [];
      this._recalculate();
    };

    // --- actions ----------------------------------------------------------
    $('btn-calibrate').onclick = () => this._startCalibration();
    $('btn-add-point').onclick = () => this._arm('add');
    $('btn-reset').onclick = () => this._reset();
    $('btn-export').onclick = () => this._export();
  }

  /** A text field that parses a number and rejects nonsense without nagging. */
  _numberField(id, key, validate = (v) => v) {
    const el = this.$(id);
    const commit = () => {
      const parsed = Number.parseFloat(String(el.value).replace(/[^0-9.+-]/g, ''));
      const value = Number.isFinite(parsed) ? validate(parsed) : null;
      if (value == null) {
        el.value = this._fmt(this.state[key]);
        return;
      }
      this.state[key] = value;
      el.value = this._fmt(value);
      const ref = key === 'originElevation' ? 'origin' : key === 'knownElevation' ? 'known' : null;
      if (ref) {
        const point = this.annotations.referencePoint(ref);
        if (point) point.elevation = value;
      }
      this._recalculate();
    };
    el.onchange = commit;
    el.onblur = commit;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
    });
  }

  get _suffix() {
    return this.state.unit === 'm' ? 'm' : "'";
  }

  _fmt(v) {
    return Number(v).toFixed(2);
  }

  // ======================================================================
  // Photograph
  // ======================================================================

  async _loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this._toast('That file is not an image.', true);
      return;
    }
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('The image could not be decoded.'));
        img.src = url;
      });
      // Modern Safari and Chrome apply EXIF orientation to <img> by default, so
      // what we draw matches what the user saw in Photos.
      this._setImage(img);
      URL.revokeObjectURL(url);
      this.imageDataUrl = await this._toDataUrl(file);
      this._persist();
    } catch (err) {
      this._toast(err.message ?? 'Could not open that photograph.', true);
    }
  }

  _setImage(img) {
    this.image = img;
    this.view.setImage(img);
    this.$('empty-state').hidden = true;
    this.$('hud').hidden = false;
    this.$('zoom-cluster').hidden = false;
    this.$('plane-note').hidden = false;
    this.$('photo-info').textContent =
      `${img.naturalWidth} × ${img.naturalHeight} px. Tap the origin to begin.`;
    // A fresh photograph invalidates the old geometry.
    this.annotations.clear();
    this.selectionQueue = [];
    this.state.step = 2;
    this._arm('origin');
    this._recalculate();
  }

  _toDataUrl(file) {
    // Only worth keeping if it will actually fit in local storage.
    if (file.size > 5.5 * 1024 * 1024) return Promise.resolve(null);
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }

  // ======================================================================
  // Tools and pointer handling
  // ======================================================================

  _arm(tool) {
    this.state.tool = tool;
    for (const [id, name] of [
      ['btn-set-origin', 'origin'],
      ['btn-set-known', 'known'],
      ['btn-add-point', 'add'],
    ]) {
      this.$(id).classList.toggle('is-armed', tool === name);
    }
    if (tool !== 'select') {
      this._setDrawer(false);
      if (tool === 'origin') this.state.step = 2;
      if (tool === 'known') this.state.step = 3;
    }
    this._updateStep();
  }

  /**
   * Where a callout sits by default: clear of the sight line, on the opposite
   * side from the rung numbers, which always run off the right-hand end of the
   * ruler. Callouts the user has dragged are left alone.
   */
  _defaultLabelOffset() {
    if (!this.projection) return { x: 20, y: -26 };
    const n = this.projection.n; // image direction of world +X
    return { x: -n.x * 34 - 4, y: -n.y * 34 - 14 };
  }

  /**
   * Lay the callouts out so they do not bury each other. Points that are far
   * apart on the slope can still project within a few pixels of one another
   * near the horizon, so a fixed stagger is not enough: the blocks are sorted
   * down the image and each is pushed clear of the one above it.
   *
   * Callouts the user has dragged are fixed points that the others flow around.
   */
  _relayoutLabels() {
    if (!this.projection) return;
    const unit = this.view.imageWidth / 1000;
    const off = this._defaultLabelOffset();
    const gap = 8 * unit;

    const blocks = [];
    for (const p of this.annotations.points.values()) {
      // Name line, elevation, and (except at the origin) the change.
      const rows = p.role === 'origin' ? 2 : 3;
      const height = (13 * 1.34 + 19 * 1.34 + (rows > 2 ? 16 * 1.34 : 0)) * unit;
      const top = p.imagePoint.y + (p.labelMoved ? p.labelOffset.y : off.y) * unit;
      blocks.push({ point: p, height, top });
    }
    blocks.sort((a, b) => a.top - b.top);

    let floor = -Infinity;
    for (const b of blocks) {
      if (b.point.labelMoved) {
        floor = Math.max(floor, b.top + b.height + gap);
        continue;
      }
      const top = Math.max(b.top, floor);
      b.point.labelOffset = { x: off.x, y: (top - b.point.imagePoint.y) / unit };
      floor = top + b.height + gap;
    }
  }

  /** Constrain a point onto the line of sight — the only place a reading is valid. */
  _snapToSight(p) {
    if (!this.projection) return p;
    const { t } = this.projection.toLineCoords(p);
    return this.projection.fromLineCoords(t);
  }

  _pointerDown(p, e) {
    if (!this.image) return false;
    const tol = this.view.photoTolerance(30);

    if (this.state.tool === 'origin') {
      this.annotations.setReferencePoint('origin', p, this.state.originElevation, this._defaultLabelOffset());
      this._arm(this.annotations.known ? 'select' : 'known');
      this._recalculate();
      this.drag = { id: this.annotations.origin.id, reference: true };
      return true;
    }
    if (this.state.tool === 'known') {
      this.annotations.setReferencePoint('known', p, this.state.knownElevation, this._defaultLabelOffset());
      this._arm('select');
      this.state.step = 4;
      this._recalculate();
      this.drag = { id: this.annotations.known.id, reference: true };
      return true;
    }
    if (this.state.tool === 'add') {
      if (!this.projection) {
        this._toast('Set both known points first.', true);
        return false;
      }
      const snapped = this._snapToSight(p);
      if (!this._snapNoticeShown && dist(snapped, p) > tol * 0.7) {
        this._toast('Measurement points snap to the line of sight.');
        this._snapNoticeShown = true;
      }
      const point = this.annotations.addPoint({
        imagePoint: snapped,
        label: `POINT ${String.fromCharCode(67 + this.annotations.measurements.length)}`,
        labelOffset: this._defaultLabelOffset(),
      });
      this._select(point.id);
      this._arm('select');
      this._recalculate();
      this.drag = { id: point.id };
      return true;
    }

    // Labels are checked before the markers, so a label sitting over a point
    // can still be picked up and moved out of the way.
    const unit = this.view.imageWidth / 1000;
    const dimHit = this.annotations.hitTestDimension(p, tol, unit);
    if (dimHit) {
      const anchor = this.annotations.dimensionAnchor(dimHit, unit);
      this.drag = {
        dimension: dimHit.id,
        grab: { x: (p.x - anchor.x) / unit, y: (p.y - anchor.y) / unit },
      };
      return true;
    }

    const labelHit = this.annotations.hitTestLabel(p, tol, unit);
    if (labelHit) {
      this._select(labelHit.id);
      this.drag = {
        id: labelHit.id,
        label: true,
        grab: {
          x: (p.x - labelHit.imagePoint.x) / unit - labelHit.labelOffset.x,
          y: (p.y - labelHit.imagePoint.y) / unit - labelHit.labelOffset.y,
        },
      };
      this.view.render();
      return true;
    }

    // Select / drag an existing point.
    const hit = this.annotations.hitTest(p, tol);
    if (hit) {
      this._select(hit.id);
      this.drag = { id: hit.id, reference: hit.isMeasured };
      this.view.render();
      return true;
    }
    return false; // let the view pan
  }

  _pointerMove(p) {
    if (!this.drag) return;
    if (this.drag.dimension) {
      this.annotations.moveDimensionLabel(
        this.drag.dimension,
        p,
        this.view.imageWidth / 1000,
        this.drag.grab,
      );
      this.view.render();
      return;
    }
    const point = this.annotations.points.get(this.drag.id);
    if (!point) return;
    if (this.drag.label) {
      this.annotations.moveLabel(this.drag.id, p, this.view.imageWidth / 1000, this.drag.grab);
      this.view.render();
      return;
    }
    const target = this.drag.reference ? p : this._snapToSight(p);
    this.annotations.movePoint(this.drag.id, target);
    // Moving a reference point re-aims the line of sight, so the whole camera
    // has to be re-solved — that is the "adjust the line of sight" control.
    this._recalculate({ quiet: true });
  }

  _pointerUp() {
    if (!this.drag) return;
    this.drag = null;
    this._recalculate();
  }

  _select(id) {
    this.annotations.select(id);
    this.selectionQueue = [id, ...this.selectionQueue.filter((x) => x !== id)].slice(0, 2);
    this._syncDimensionButtons();
    this._updateReadout();
  }

  // ======================================================================
  // Calibration
  // ======================================================================

  _buildModel() {
    return new ElevationModel({
      originElevation: this.state.originElevation,
      knownElevation: this.state.knownElevation,
      horizontalDistance: this.state.horizontalDistance,
      increment: this.state.increment,
      range: this.state.range,
      unitSuffix: this.state.unit === 'm' ? 'm' : "'",
    });
  }

  /**
   * The single point where everything is brought back into agreement: rebuild
   * the model, re-solve the camera, re-derive every annotation, redraw.
   */
  _recalculate({ quiet = false } = {}) {
    this.model = this._buildModel();

    const origin = this.annotations.origin;
    const known = this.annotations.known;
    this.projection = null;
    this.solution = null;
    this.ruler = null;
    this.calibrationError = null;

    if (this.image && origin && known) {
      const result = calibrate({
        imageWidth: this.view.imageWidth,
        imageHeight: this.view.imageHeight,
        fovDeg: this.state.fovDeg,
        originPoint: origin.imagePoint,
        knownPoint: known.imagePoint,
        originElevation: this.state.originElevation,
        knownElevation: this.state.knownElevation,
        horizontalDistance: this.state.horizontalDistance,
        mode: this.state.solveMode,
        value: this.state.solveMode === 'pitch' ? this.state.solveValue * DEG : this.state.solveValue,
      });

      if (result.ok) {
        this.projection = result.projection;
        this.solution = result.solution;
        this.context = result.context;
        this.ruler = new ElevationRuler({
          projection: this.projection,
          model: this.model,
          originDistance: this.solution.originDistance,
          rungWidth: this.state.rungWidth,
        });
        if (this.state.step < 5) this.state.step = 5;
      } else {
        this.calibrationError = result.reason;
      }
    }

    this._relayoutLabels();
    this.annotations.solveAll(this.projection, this.model, this.solution?.originDistance ?? 0);
    if (!quiet) this._syncSolveSlider();
    this._syncDerived();
    this._syncPointList();
    this._updateReadout();
    this._updateStep();
    this.view.render();
    if (!quiet) this._persist();
  }

  /**
   * Work out what the fine-tune slider can reach for the current mode by
   * sampling the camera solutions that actually exist for this photograph.
   */
  _solveDomain() {
    const mode = this.state.solveMode;
    if (!this.context) return null;
    const ctx = this.context;
    const lo = Math.max(ctx.alphaA, ctx.alphaB) - Math.PI / 2 + 1e-4;
    const hi = Math.min(ctx.alphaA, ctx.alphaB) + Math.PI / 2 - 1e-4;
    if (!(hi > lo)) return null;

    // Slider values are snapped onto a hundredths grid so the user can land on
    // round numbers — a range input can only reach min + k*step, so an
    // arbitrary float minimum would put 6.00 ft permanently out of reach.
    const grid = (rawMin, rawMax, step) => {
      const q = 1 / step;
      const min = Math.floor(rawMin * q) / q;
      const max = Math.ceil(rawMax * q) / q;
      return max > min ? { min, max, step } : null;
    };

    if (mode === 'pitch') {
      return grid(lo * RAD, hi * RAD, 0.01);
    }

    // Practical windows keep the slider usable: the true domain runs off to
    // infinity as the sight line approaches the horizon.
    const window = mode === 'height' ? [-20, 150] : [0.5, 1500];
    const values = [];
    const N = 900;
    for (let i = 0; i <= N; i++) {
      const sol = solveFromPitch(lo + ((hi - lo) * i) / N, ctx);
      if (!sol) continue;
      const v = mode === 'height' ? sol.cameraHeight : sol.originDistance;
      if (v >= window[0] && v <= window[1]) values.push(v);
    }
    if (values.length < 2) return null;
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    // A coarse step over a long span would make the slider jump; a fine step
    // over a short one keeps fine-tuning usable. Both stay on a decimal grid.
    const step = rawMax - rawMin > 400 ? 0.1 : 0.01;
    return grid(rawMin, rawMax, step);
  }

  _syncSolveSlider() {
    const slider = this.$('in-solve');
    const domain = this._solveDomain();
    const mode = this.state.solveMode;

    const labels = {
      height: ['Camera height', 'How high the camera was above the origin.'],
      distance: ['Line-of-sight distance', 'How far the origin was from the camera.'],
      pitch: ['Viewing angle', 'Tilt below horizontal. Moves the horizon and the vanishing point.'],
    };
    const [name, hint] = labels[mode];

    if (!domain) {
      slider.disabled = true;
      this.$('lbl-solve').innerHTML = `${name} <em id="out-solve">—</em>`;
      this.$('hint-solve').textContent = hint;
      return;
    }

    slider.disabled = false;
    slider.min = domain.min;
    slider.max = domain.max;
    slider.step = domain.step;

    const current =
      this.solution == null
        ? this.state.solveValue
        : mode === 'height'
          ? this.solution.cameraHeight
          : mode === 'distance'
            ? this.solution.originDistance
            : this.solution.pitchRad * RAD;
    this.state.solveValue = clamp(current, domain.min, domain.max);
    slider.value = String(this.state.solveValue);

    const shown =
      mode === 'pitch'
        ? `${this.state.solveValue.toFixed(1)}°`
        : `${this.state.solveValue.toFixed(2)}${this._suffix}`;
    this.$('lbl-solve').innerHTML = `${name} <em>${shown}</em>`;
    this.$('hint-solve').textContent = hint;
  }

  _startCalibration() {
    if (!this.image) {
      this._toast('Load a photograph first.');
      this.$('file-library').click();
      return;
    }
    this._setDrawer(false);
    this._arm('origin');
    this._toast('Tap the origin, then tap Point B.');
  }

  // ======================================================================
  // Rendering
  // ======================================================================

  _scene() {
    if (!this.projection || !this.ruler || !this.solution) return null;
    return {
      projection: this.projection,
      model: this.model,
      ruler: this.ruler,
      annotations: this.annotations,
      solution: this.solution,
      originDistance: this.solution.originDistance,
      imageWidth: this.view.imageWidth,
      imageHeight: this.view.imageHeight,
      options: {
        opacity: this.state.opacity,
        showRuler: this.state.showRuler,
        showLabels: this.state.showLabels,
        showSight: this.state.showSight,
        showHorizon: this.state.showHorizon,
        showCrosshair: this.state.showCrosshair,
        showDistances: this.state.showDistances,
        rulerStyle: this.state.rulerStyle,
        labelMode: this.state.labelMode,
        staffDistance: this.state.staffDistance,
        fovDeg: this.state.fovDeg,
      },
    };
  }

  _drawOverlay(ctx) {
    const scene = this._scene();
    if (scene) {
      this.renderer.draw(ctx, scene);
      return;
    }
    // Not calibrated yet — still show whichever reference points exist so the
    // user can see what they have placed.
    const u = this.view.imageWidth / 1000;
    for (const p of this.annotations.points.values()) {
      const colour = p.role === 'origin' ? '#3ddc84' : p.role === 'known' ? '#ffa726' : '#ff5cae';
      this.renderer._marker(ctx, p.imagePoint, u, { color: colour, size: 8.5 });
      this.renderer._label(
        ctx,
        p.label || 'POINT',
        add(p.imagePoint, scale({ x: 18, y: -18 }, u)),
        u,
        { size: 18, plate: true, weight: '700' },
      );
    }
    if (this.annotations.origin && this.annotations.known) {
      this.renderer._line(ctx, this.annotations.origin.imagePoint, this.annotations.known.imagePoint, {
        color: '#ffb300',
        width: 1.8 * u,
        alpha: 0.7,
        dash: [16 * u, 10 * u],
      });
    }
  }

  // ======================================================================
  // DOM sync
  // ======================================================================

  _syncControls() {
    const s = this.state;
    const $ = this.$;
    $('in-origin-elev').value = this._fmt(s.originElevation);
    $('in-known-elev').value = this._fmt(s.knownElevation);
    $('in-distance').value = this._fmt(s.horizontalDistance);
    $('in-fov').value = String(s.fovDeg);
    $('out-fov').textContent = `${s.fovDeg}°`;
    $('in-solve-mode').value = s.solveMode;
    $('in-increment').value = String(s.increment);
    $('in-range').value = String(s.range);
    $('out-range').textContent = `±${s.range}${this._suffix}`;
    $('in-style').value = s.rulerStyle;
    $('in-rung-width').value = String(s.rungWidth);
    $('out-rung-width').textContent = `${s.rungWidth}${this._suffix}`;
    $('in-label-mode').value = s.labelMode;
    $('in-opacity').value = String(Math.round(s.opacity * 100));
    $('out-opacity').textContent = `${Math.round(s.opacity * 100)}%`;
    $('in-units').value = s.unit;
    $('tg-ruler').checked = s.showRuler;
    $('tg-labels').checked = s.showLabels;
    $('tg-sight').checked = s.showSight;
    $('tg-horizon').checked = s.showHorizon;
    $('tg-crosshair').checked = s.showCrosshair;
    $('tg-distances').checked = s.showDistances;
    this._syncStyleFields();
  }

  _syncStyleFields() {
    const staff = this.state.rulerStyle !== 'slope' || this.model.isFlat;
    this.$('wrap-staff-distance').hidden = !staff;
    this.$('wrap-rung-width').hidden = this.state.rulerStyle === 'staff';
    if (staff && this.solution) {
      const slider = this.$('in-staff-distance');
      const maxD = Math.max(10, this.solution.originDistance * 4);
      slider.min = '1';
      slider.max = String(Math.round(maxD));
      slider.step = '0.5';
      const value = this.state.staffDistance ?? this.solution.originDistance;
      slider.value = String(clamp(value, 1, maxD));
      this.$('out-staff-distance').textContent = `${Number(slider.value).toFixed(1)}${this._suffix}`;
    }
  }

  _syncDerived() {
    const m = this.model;
    this.$('out-delta').textContent = m.formatChange(m.deltaElevation);
    this.$('out-grade').textContent = m.isFlat ? 'Level' : m.formatGrade();

    this.$('ref-origin').classList.toggle('is-set', !!this.annotations.origin);
    this.$('ref-known').classList.toggle('is-set', !!this.annotations.known);
    this.$('btn-set-origin').textContent = this.annotations.origin ? 'Move' : 'Tap on photo';
    this.$('btn-set-known').textContent = this.annotations.known ? 'Move' : 'Tap on photo';

    const set = (id, text) => {
      this.$(id).textContent = text;
    };
    if (this.solution) {
      set('out-cam-h', `${m.formatNumber(this.solution.cameraHeight)}${this._suffix}`);
      set('out-pitch', `${(this.solution.pitchRad * RAD).toFixed(1)}° down`);
      set('out-origin-d', `${m.formatNumber(this.solution.originDistance)}${this._suffix}`);
      set('out-focal', `${Math.round(this.projection.focalPx)} px`);
    } else {
      for (const id of ['out-cam-h', 'out-pitch', 'out-origin-d', 'out-focal']) set(id, '—');
    }

    const warn = this.$('cal-warning');
    if (this.calibrationError) {
      warn.textContent = this.calibrationError;
      warn.hidden = false;
    } else if (this.model.isFlat && this.annotations.known) {
      warn.textContent =
        'Both known points are at the same elevation, so the grade is level. The ruler is shown as a levelling staff instead of a staircase.';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
    this._syncStyleFields();
  }

  _syncPointList() {
    const list = this.$('point-list');
    const points = this.annotations.measurements;
    list.textContent = '';
    if (!points.length) {
      const p = document.createElement('p');
      p.className = 'hint empty-list';
      p.textContent = 'No measurement points yet.';
      list.append(p);
      this._syncDimensionButtons();
      return;
    }
    for (const point of points) {
      const row = document.createElement('div');
      row.className = 'point-row';
      row.classList.toggle('is-selected', this.annotations.selectedId === point.id);

      const swatch = document.createElement('span');
      swatch.className = 'swatch';

      const name = document.createElement('span');
      name.className = 'pt-name';
      name.textContent = point.label || 'Point';

      const value = document.createElement('span');
      value.className = 'pt-val';
      value.textContent = point.valid ? this.model.formatElevation(point.elevation) : '—';

      const del = document.createElement('button');
      del.className = 'pt-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Delete ${point.label}`);
      del.onclick = (e) => {
        e.stopPropagation();
        this.annotations.removePoint(point.id);
        this.selectionQueue = this.selectionQueue.filter((x) => x !== point.id);
        this._recalculate();
      };

      row.onclick = () => {
        this._select(point.id);
        this._syncPointList();
        this.view.render();
      };

      row.append(swatch, name, value, del);
      list.append(row);
    }
    this._syncDimensionButtons();
  }

  _syncDimensionButtons() {
    const ready = this.selectionQueue.length === 2;
    for (const id of ['btn-dim-vertical', 'btn-dim-horizontal', 'btn-dim-grade']) {
      this.$(id).disabled = !ready;
    }
    this.$('dim-hint').textContent = ready
      ? 'Dimension will be drawn between the last two points you selected.'
      : 'Select two points to draw a dimension between them.';
  }

  _addDimension(style) {
    if (this.selectionQueue.length !== 2) return;
    const [b, a] = this.selectionQueue;
    const added = this.annotations.addDimension(a, b, style);
    if (!added) {
      this._toast('Those two points cannot be dimensioned.', true);
      return;
    }
    this._recalculate();
    this._toast('Dimension added.');
  }

  _updateReadout() {
    const box = this.$('readout');
    const point = this.annotations.selected;
    if (!point || !this.model) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const m = this.model;
    this.$('readout-elev').textContent = point.valid ? m.formatElevation(point.elevation) : '—';
    this.$('readout-change').textContent = point.valid ? m.formatChange(point.offset) : '—';
    this.$('readout-dist').textContent =
      point.valid && point.distance != null
        ? `${m.formatNumber(point.distance)}${this._suffix}`
        : '—';
    const tag = this.$('readout-tag');
    tag.textContent = point.valid ? (point.isMeasured ? 'MEASURED' : 'PROJECTED') : 'NO READING';
    tag.classList.toggle('measured', point.isMeasured);
  }

  _updateStep() {
    let step = this.state.step;
    if (!this.image) step = 1;
    else if (!this.annotations.origin) step = 2;
    else if (!this.annotations.known) step = 3;
    else if (this.state.step < 4) step = 4;
    this.state.step = step;

    const [tag, text] = STEP_TEXT[step];
    this.$('hud-step').textContent = tag;
    this.$('hud-text').innerHTML = text;

    for (const card of document.querySelectorAll('.card[data-step]')) {
      const s = Number(card.dataset.step);
      card.classList.toggle('is-active', s === step || (step === 3 && s === 2));
    }
  }

  _setDrawer(open) {
    document.getElementById('app').classList.toggle('drawer-open', open);
  }

  // ======================================================================
  // Actions
  // ======================================================================

  _reset() {
    const keepPhoto = this.image != null;
    const message = keepPhoto
      ? 'Clear the calibration, points and annotations? The photograph stays loaded.'
      : 'Reset everything?';
    if (!window.confirm(message)) return;

    this.annotations.clear();
    this.selectionQueue = [];
    Object.assign(this.state, {
      originElevation: 100,
      knownElevation: 103,
      horizontalDistance: 40,
      increment: 1,
      range: 10,
      fovDeg: 60,
      solveMode: 'height',
      solveValue: 5.5,
      rulerStyle: 'slope',
      rungWidth: 10,
      staffDistance: null,
      labelMode: 'elevation',
      step: keepPhoto ? 2 : 1,
    });
    this._syncControls();
    this._recalculate();
    if (keepPhoto) this._arm('origin');
    this._toast('Reset.');
  }

  async _export() {
    const scene = this._scene();
    if (!scene || !this.image) {
      this._toast('Calibrate the photograph before exporting.', true);
      return;
    }
    try {
      this._toast('Preparing image…');
      const canvas = this.exporter.compose(scene, { image: this.image });
      const result = await this.exporter.deliver(canvas, 'elevation-ruler.png');
      if (result === 'shared') this._toast('Shared.');
      else if (result === 'downloaded') this._toast('Image saved.');
      else this._toast('Export cancelled.');
    } catch (err) {
      this._toast(err.message ?? 'Export failed.', true);
    }
  }

  _toast(message, isError = false) {
    const el = this.$('toast');
    el.textContent = message;
    el.classList.toggle('is-error', isError);
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.hidden = true;
    }, isError ? 4200 : 2400);
  }

  // ======================================================================
  // Persistence
  // ======================================================================

  _persist() {
    try {
      const payload = {
        state: { ...this.state, tool: 'select' },
        annotations: this.annotations.toJSON(),
        image: this.imageDataUrl,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full or unavailable (private browsing). The app still works;
      // it just will not remember the session.
    }
  }

  _restore() {
    let payload = null;
    try {
      payload = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      payload = null;
    }
    if (!payload) return;

    Object.assign(this.state, payload.state ?? {}, { tool: 'select' });
    this.model = this._buildModel();

    if (payload.image) {
      const img = new Image();
      img.onload = () => {
        this.image = img;
        this.imageDataUrl = payload.image;
        this.view.setImage(img);
        this.$('empty-state').hidden = true;
        this.$('hud').hidden = false;
        this.$('zoom-cluster').hidden = false;
        this.$('plane-note').hidden = false;
        this.$('photo-info').textContent = `${img.naturalWidth} × ${img.naturalHeight} px.`;
        this.annotations.loadJSON(payload.annotations);
        this._recalculate();
      };
      img.onerror = () => {};
      img.src = payload.image;
    }
  }
}
