// App.js
//
// The controller. It owns the state, drives the calibration, and keeps the DOM
// and the canvas in step. All of the mathematics lives in src/core — this file
// only decides *when* to ask for it.

import { clamp, DEG, RAD, dist, dot, sub, add, scale } from '../core/Geometry.js';
import {
  calibrate,
  calibrateFromWall,
  solveFromPitch,
  pitchDomain,
  wallContext,
  solveWallForDistance,
} from '../core/PerspectiveCalibration.js';
import { ElevationModel } from '../core/ElevationModel.js';
import { ElevationRuler } from '../core/ElevationRuler.js';
import { AnnotationManager } from '../core/AnnotationManager.js';
import { PhotoView } from './PhotoView.js';
import { OverlayRenderer } from './OverlayRenderer.js';
import { ExportManager } from './ExportManager.js';
import { SiteSurvey, STANDARD_POINTS } from '../core/SiteSurvey.js';
import { SitePlanView, PIN_COLOURS } from './SitePlanView.js';
import { TiltSensor } from './TiltSensor.js';

const STORAGE_KEY = 'perspective-elevation-ruler/v1';

/**
 * How big one step of a scale is, in world units. World units are feet or
 * metres depending on the app's unit setting, so the imperial and metric
 * preset tables are separate rather than converted between.
 */
const SIZE_IN_WORLD = { in: 1 / 12, ft: 1, mm: 0.001, cm: 0.01, m: 1 };

const SCALE_PRESETS = {
  ft: {
    vertical: [
      { id: 'ft1', label: '1 ft', size: 1, sizeUnit: 'ft', noun: '' },
      { id: 'in6', label: '6 in', size: 6, sizeUnit: 'in', noun: '' },
      { id: 'siding55', label: 'Siding course — 5½ in', size: 5.5, sizeUnit: 'in', noun: 'course' },
      { id: 'siding7', label: 'Siding course — 7 in', size: 7, sizeUnit: 'in', noun: 'course' },
      { id: 'block8', label: 'Block course — 8 in', size: 8, sizeUnit: 'in', noun: 'course' },
      { id: 'brick', label: 'Brick course — 2⅔ in', size: 8 / 3, sizeUnit: 'in', noun: 'course' },
    ],
    projected: [
      { id: 'ft1', label: '1 ft', size: 1, sizeUnit: 'ft', noun: '' },
      { id: 'in6', label: '6 in', size: 6, sizeUnit: 'in', noun: '' },
      { id: 'step75', label: 'Step riser — 7½ in', size: 7.5, sizeUnit: 'in', noun: 'step' },
      { id: 'step7', label: 'Step riser — 7 in', size: 7, sizeUnit: 'in', noun: 'step' },
      { id: 'step6', label: 'Step riser — 6 in', size: 6, sizeUnit: 'in', noun: 'step' },
      { id: 'tread', label: 'Timber tie — 5½ in', size: 5.5, sizeUnit: 'in', noun: 'tie' },
    ],
  },
  m: {
    vertical: [
      { id: 'm025', label: '0.25 m', size: 0.25, sizeUnit: 'm', noun: '' },
      { id: 'm01', label: '0.10 m', size: 0.1, sizeUnit: 'm', noun: '' },
      { id: 'course140', label: 'Course — 140 mm', size: 140, sizeUnit: 'mm', noun: 'course' },
      { id: 'block190', label: 'Block course — 190 mm', size: 190, sizeUnit: 'mm', noun: 'course' },
    ],
    projected: [
      { id: 'm025', label: '0.25 m', size: 0.25, sizeUnit: 'm', noun: '' },
      { id: 'm01', label: '0.10 m', size: 0.1, sizeUnit: 'm', noun: '' },
      { id: 'step175', label: 'Step riser — 175 mm', size: 175, sizeUnit: 'mm', noun: 'step' },
      { id: 'step190', label: 'Step riser — 190 mm', size: 190, sizeUnit: 'mm', noun: 'step' },
    ],
  },
};

const SIZE_UNITS = { ft: ['in', 'ft'], m: ['mm', 'cm', 'm'] };

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
      calibrationMethod: 'building',
      // Building method: the foundation is the datum, a known height up the
      // wall gives the scale, and the horizon — stored as the image point the
      // user put it on, not as an angle — gives the viewing angle. Keeping it
      // as a point means it stays put on the photograph when the field of view
      // changes, which is what someone who placed it on a visible line expects.
      foundationElevation: 0,
      wallHeight: 8,
      horizonPoint: null,
      gradeAwayPercent: 2,
      originElevation: 100,
      knownElevation: 103,
      horizontalDistance: 40,
      increment: 1,
      verticalScale: { preset: 'ft1', size: 1, sizeUnit: 'ft', noun: '' },
      projectedScale: { preset: 'ft1', size: 1, sizeUnit: 'ft', noun: '' },
      range: 10,
      unit: 'ft',
      fovDeg: 60,
      solveMode: 'height',
      solveValue: 5.5,
      rulerStyle: 'foundation', // follows calibrationMethod: 'building'
      knownIsFarther: true,
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

    this.survey = new SiteSurvey();
    this.tilt = new TiltSensor({ onReading: (a) => this._onTilt(a) });

    this._buildView();
    this._bindControls();
    this._buildSurvey();
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
    $('btn-set-foundation').onclick = () => this._arm('origin');
    $('btn-set-wall').onclick = () => this._arm('known');
    $('btn-reset-horizon').onclick = () => {
      this.state.horizonPoint = null; // fall back to an eye-height guess
      this._recalculate();
    };

    this._paintMethod = this._segmented('seg-method', (value) => {
      this.state.calibrationMethod = value;
      this._paintMethod(value);
      // Marks placed for one method mean something different under the other.
      this.annotations.clear();
      this.selectionQueue = [];
      this.state.horizonPoint = null;
      // The ruler that matches the method: a building is measured up its wall
      // and out across the grade; open ground is measured along the grade.
      this._setRulerStyle(value === 'building' ? 'foundation' : 'slope');
      this._syncMethodFields();
    this._syncScales();
      this._recalculate();
      this._arm('origin');
    });

    this._numberField('in-foundation-elev', 'foundationElevation');
    this._numberField('in-wall-height', 'wallHeight', (v) => (v > 0 ? v : null));
    $('in-grade-away').oninput = (e) => {
      this.state.gradeAwayPercent = Number(e.target.value);
      $('out-grade-away').textContent = `${this.state.gradeAwayPercent.toFixed(1)}%`;
      this._recalculate();
    };

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
    this._bindScale('vertical', 'verticalScale');
    this._bindScale('projected', 'projectedScale');
    $('in-range').oninput = (e) => {
      this.state.range = Number(e.target.value);
      $('out-range').textContent = `±${this.state.range}${this._suffix}`;
      this._recalculate();
    };
    this._paintStyle = this._segmented('seg-style', (value) => {
      this._setRulerStyle(value);
      this._recalculate();
    });
    this._paintKnownSide = this._segmented('seg-known-side', (value) => {
      this.state.knownIsFarther = value === 'farther';
      this._paintKnownSide(value);
      this._recalculate();
    });
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
      // Imperial and metric scales are different lists, not conversions of each
      // other, so switching units re-picks a sensible default for each half.
      const system = this.state.unit === 'm' ? 'm' : 'ft';
      for (const [which, key] of [['vertical', 'verticalScale'], ['projected', 'projectedScale']]) {
        if (!SCALE_PRESETS[system][which].some((x) => x.id === this.state[key].preset)) {
          const fallback = SCALE_PRESETS[system][which][0];
          this.state[key] = { ...fallback, preset: fallback.id };
        }
      }
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

    $('export-close').onclick = () => this._hideExport();
    $('export-sheet').onclick = (e) => {
      if (e.target === $('export-sheet')) this._hideExport();
    };
    $('export-open').onclick = () => {
      if (this._exportUrl) window.open(this._exportUrl, '_blank', 'noopener');
    };
    $('export-download').onclick = (e) => this._saveExport(e);
  }

  /**
   * Wire a segmented control. Returns a function that paints the current
   * selection, so the DOM is only ever written from state.
   */
  _segmented(id, onPick) {
    const root = this.$(id);
    const buttons = [...root.querySelectorAll('button[data-value]')];
    root.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-value]');
      if (button) onPick(button.dataset.value);
    });
    return (value) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
    };
  }

  // ======================================================================
  // Site survey — pins for distance, tilt for angle
  // ======================================================================

  _buildSurvey() {
    const $ = this.$;
    this.plan = new SitePlanView(this.$('plan-canvas'), {
      survey: this.survey,
      onChange: () => this._syncSurvey(),
    });

    $('btn-survey').onclick = () => this._openSurvey(true);
    $('survey-close').onclick = () => this._openSurvey(false);
    $('plan-in').onclick = () => this.plan.zoomBy(1.4);
    $('plan-out').onclick = () => this.plan.zoomBy(1 / 1.4);
    $('plan-fit').onclick = () => this.plan.fit();

    const aerial = $('file-aerial');
    $('btn-aerial').onclick = () => aerial.click();
    aerial.onchange = (e) => this._loadAerial(e.target.files?.[0]);
    $('btn-plan-clear').onclick = () => {
      this.plan.setBackdrop(null);
      this.plan.planWidth = 1000;
      this.plan.planHeight = 1000;
      this.plan.fit();
      this._syncSurvey();
    };

    const scaleField = $('in-scale-feet');
    const commitScale = () => {
      const parsed = Number.parseFloat(String(scaleField.value).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) this.plan.setScaleFromRuler(parsed);
      scaleField.value = this._fmt(this.plan.rulerFeet);
      this._syncSurvey();
    };
    scaleField.onchange = commitScale;
    scaleField.onblur = commitScale;

    $('btn-tilt').onclick = () => this._startTilt();
    $('btn-apply-survey').onclick = () => this._applySurvey();

    $('in-inst-mode').onchange = (e) => {
      this.survey.instrumentHeightMode = e.target.value;
      $('wrap-inst-manual').hidden = e.target.value !== 'manual';
      this._syncSurvey();
    };
    this._numberFieldOn('in-inst-height', (v) => {
      this.survey.manualInstrumentHeight = v;
      this._syncSurvey();
    });

    this._buildSurveyPoints();
  }

  /** One block per standard point: place it, shoot it, or type its angle. */
  _buildSurveyPoints() {
    const host = this.$('survey-points');
    host.textContent = '';
    this._pointRows = new Map();

    for (const spec of STANDARD_POINTS) {
      const row = document.createElement('div');
      row.className = 'spoint';

      const head = document.createElement('div');
      head.className = 'spoint-head';
      const dot = document.createElement('span');
      dot.className = 'spoint-dot';
      dot.style.background = PIN_COLOURS[spec.id];
      const name = document.createElement('span');
      name.className = 'spoint-name';
      name.textContent = spec.name;
      const elev = document.createElement('span');
      elev.className = 'spoint-elev';
      head.append(dot, name, elev);

      const controls = document.createElement('div');
      controls.className = 'spoint-row';

      const place = document.createElement('button');
      place.className = 'btn btn-tiny';
      place.onclick = () => {
        if (spec.canPlaceApart && this.survey.point(spec.id).plan) {
          // Second press puts it back on the wall's pin.
          this.survey.place(spec.id, null);
          this.plan.placing = null;
        } else {
          this.plan.placing = spec.id;
        }
        this._syncSurvey();
        this.plan.render();
      };

      const angle = document.createElement('input');
      angle.type = 'text';
      angle.inputMode = 'decimal';
      angle.placeholder = 'angle °';
      angle.onchange = () => {
        const parsed = Number.parseFloat(String(angle.value).replace(/[^0-9.+-]/g, ''));
        if (Number.isFinite(parsed)) {
          this.survey.clearShots(spec.id);
          this.survey.addShot(spec.id, parsed);
        }
        this._syncSurvey();
      };

      const shoot = document.createElement('button');
      shoot.className = 'btn btn-tiny';
      shoot.textContent = 'Shoot';
      shoot.onclick = () => this._shoot(spec.id);

      // A point stacked on another's pin has nothing of its own to place — an
      // eave is above its wall by definition. The ridge can break away, because
      // seen from the gutter side it stands back from the wall.
      if (spec.placedWith && !spec.canPlaceApart) controls.append(angle, shoot);
      else if (spec.shoots) controls.append(place, angle, shoot);
      else controls.append(place);

      const meta = document.createElement('p');
      meta.className = 'spoint-meta';
      meta.textContent = spec.hint;

      row.append(head, controls, meta);
      host.append(row);
      this._pointRows.set(spec.id, { row, place, angle, shoot, elev, meta });
    }
  }

  _openSurvey(open) {
    this.$('survey').hidden = !open;
    if (open) {
      requestAnimationFrame(() => {
        this.plan.resize();
        this.plan.fit();
        this._syncSurvey();
      });
    } else {
      this.tilt.stop();
    }
  }

  async _loadAerial(file) {
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('That image could not be read.'));
        img.src = url;
      });
      this.plan.setBackdrop(img);
      URL.revokeObjectURL(url);
      this._syncSurvey();
    } catch (err) {
      this._toast(err.message, true);
    }
  }

  async _startTilt() {
    const result = await this.tilt.start();
    if (!result.ok) {
      this.$('tilt-hint').textContent = result.reason;
      this._toast(result.reason, true);
      return;
    }
    this.$('btn-tilt').textContent = 'Reading tilt';
    this.$('btn-tilt').classList.add('is-armed');
  }

  _onTilt(angle) {
    const el = this.$('tilt-readout');
    el.textContent = `${angle >= 0 ? '+' : ''}${angle.toFixed(1)}°`;
    el.classList.add('is-live');
  }

  _shoot(id) {
    const reading = this.tilt.capture();
    if (!reading) {
      this._toast('No tilt reading yet — tap Read tilt, or type the angle.', true);
      return;
    }
    this.survey.addShot(id, reading.angle);
    this._syncSurvey();
    const spread = reading.spread == null ? '' : ` · ±${reading.spread.toFixed(2)}° hold`;
    this._toast(`${SiteSurvey.spec(id).name}: ${reading.angle.toFixed(1)}°${spread}`);
  }

  _syncSurvey() {
    if (this.$('survey').hidden && !this._surveyEverOpened) return;
    this._surveyEverOpened = true;
    const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}'`);

    this.$('out-scale').textContent = `${this.plan.rulerFeet.toFixed(1)}' bar`;
    this.$('in-scale-feet').value = this._fmt(this.plan.rulerFeet);

    for (const spec of STANDARD_POINTS) {
      const row = this._pointRows.get(spec.id);
      const point = this.survey.point(spec.id);
      const shared = this.survey.isShared(spec.id);
      row.place.textContent = spec.canPlaceApart
        ? (point.plan ? 'On the wall' : 'Place apart')
        : point.plan ? 'Move' : 'Place';
      row.row.classList.toggle('is-active', this.plan.placing === spec.id);
      const elev = this.survey.elevationOf(spec.id);
      row.elev.textContent = spec.id === 'observation'
        ? "0.00'"
        : elev ? `${elev.feet >= 0 ? '+' : ''}${elev.feet.toFixed(2)}'` : '—';
      if (spec.shoots) {
        const angle = this.survey.angleOf(spec.id);
        if (angle != null && document.activeElement !== row.angle) {
          row.angle.value = angle.toFixed(2);
        }
        const shots = point.shots.length;
        const spread = elev?.repeat;
        const where = shared ? ' · on the foundation pin' : '';
        row.meta.textContent = shots
          ? `${shots} shot${shots === 1 ? '' : 's'}${spread != null ? ` · ±${spread.toFixed(2)}' repeat` : ''}${where}`
          : spec.hint;
      }
    }

    const cal = this.survey.calibration();
    const elevations = this.survey.elevations();
    this.$('out-inst').textContent = f(this.survey.instrumentHeight()?.value);
    this.$('out-found').textContent = f(elevations.foundation?.feet);
    this.$('out-eave').textContent = f(elevations.eave?.feet);
    this.$('out-peak').textContent = f(elevations.peak?.feet);
    this.$('out-wall').textContent = f(cal.ok ? cal.wallHeight : null);
    this.$('out-wall-dist').textContent = f(cal.ok ? cal.distanceToWall : null);
    this.$('out-survey-grade').textContent =
      cal.ok && cal.gradeAwayPercent != null ? `${cal.gradeAwayPercent.toFixed(1)}% fall` : '—';

    const warn = this.$('survey-warn');
    const status = this.survey.status();
    if (!cal.ok && cal.reason) {
      warn.textContent = cal.reason;
      warn.hidden = false;
    } else if (!status.complete) {
      warn.textContent = `Still to do: ${status.missing.join(', ')}.`;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    this.$('btn-apply-survey').disabled = !(cal.ok && cal.wallHeight != null);
    this.$('survey-hud').innerHTML = this.plan.placing
      ? `Tap the plan to place <strong>${SiteSurvey.spec(this.plan.placing).name}</strong>.`
      : status.complete
        ? 'Survey complete — send it to the photo ruler.'
        : `Next: <strong>${status.missing[0]}</strong>.`;
  }

  /**
   * Hand the survey to the photo calibration. Everything the building method
   * asks for is measured here, including the pitch — so the horizon follows
   * from the geometry instead of being placed by eye.
   */
  _applySurvey() {
    const cal = this.survey.calibration();
    if (!cal.ok) {
      this._toast(cal.reason ?? 'The survey is not complete.', true);
      return;
    }
    this.state.calibrationMethod = 'building';
    this._paintMethod('building');
    this.state.foundationElevation = 0;
    this.state.wallHeight = cal.wallHeight;
    this.state.gradeAwayPercent = cal.gradeAwayPercent ?? this.state.gradeAwayPercent;
    this.surveyCalibration = cal;
    this._surveyMismatch = null;
    // Consumed by the next _recalculate, once the wall marks give it a sight line.
    this._pendingSurveyDistance = cal.distanceToWall;
    this.state.horizonPoint = null;
    this._setRulerStyle('foundation');
    this._syncControls();
    this._openSurvey(false);
    this._recalculate();
    this._toast(
      `Applied: wall ${cal.wallHeight.toFixed(2)}', ${cal.distanceToWall.toFixed(0)}' away.`,
    );
  }

  /** A number field that hands its value to a callback. */
  _numberFieldOn(id, apply) {
    const el = this.$(id);
    const commit = () => {
      const parsed = Number.parseFloat(String(el.value).replace(/[^0-9.+-]/g, ''));
      if (Number.isFinite(parsed)) apply(parsed);
      el.value = this._fmt(Number.parseFloat(el.value) || 0);
    };
    el.onchange = commit;
    el.onblur = commit;
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
      // Reference elevations are re-derived from state in _recalculate, so the
      // marks stay in step whichever field changed.
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
      // Name line, elevation, the change (except at the origin), and a count
      // line when the scale governing this point counts something.
      const hasChange = p.role !== 'origin';
      const hasCount = !!this._countLabelFor(p);
      const height =
        (13 * 1.34 + 19 * 1.34 + (hasChange ? 16 * 1.34 : 0) + (hasCount ? 15 * 1.34 : 0)) * unit;
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
      this.annotations.setReferencePoint(
        'origin',
        p,
        this._isBuilding ? this.state.foundationElevation : this.state.originElevation,
        this._defaultLabelOffset(),
      );
      this._arm(this.annotations.known ? 'select' : 'known');
      this._recalculate();
      this.drag = { id: this.annotations.origin.id, reference: true };
      return true;
    }
    if (this.state.tool === 'known') {
      this.annotations.setReferencePoint(
        'known',
        p,
        this._isBuilding
          ? this.state.foundationElevation + this.state.wallHeight
          : this.state.knownElevation,
        this._defaultLabelOffset(),
      );
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
        mode: this._measurementMode,
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

    // The horizon is checked after the points but before panning: it spans the
    // whole frame, so it must never win over something specific the user aimed at.
    if (this._horizonUnder(p, tol)) {
      this.drag = { horizon: true };
      if (!this._isBuilding) {
        // Dragging the horizon IS the pitch solve, so make the panel say so.
        this.state.solveMode = 'pitch';
        this.$('in-solve-mode').value = 'pitch';
      }
      this.view.render();
      return true;
    }
    return false; // let the view pan
  }

  /**
   * Is the pointer on the horizon? The horizon runs perpendicular to the sight
   * line, so its distance from any point is just the gap in the along-sight
   * coordinate — no line-segment maths needed.
   */
  _horizonUnder(p, tol) {
    if (!this.state.showHorizon || !this.projection) return false;
    if (!this.projection.horizonSegment()) return false; // off-screen
    const { t } = this.projection.toLineCoords(p);
    return Math.abs(t - this.projection.horizonT) < tol;
  }

  /**
   * Move the horizon to the pointer, which sets the camera's pitch outright.
   * Camera height and origin distance then follow in closed form, so this is
   * the one calibration control that needs no searching.
   *
   * Refuses to move where no camera exists rather than clamping to a guess: the
   * line simply stops, which reads as the limit it is.
   */
  _dragHorizon(pointer) {
    // Keep the pointer inside the photograph. The horizon then always passes
    // through a point that is inside the frame, so it stays visible and can be
    // grabbed again. Without this it can be flung off-screen, where nothing can
    // take hold of it and the handle is simply lost — with an absurd camera to
    // go with it. The horizon slider still covers the full range for the rare
    // photograph whose horizon genuinely falls outside the frame.
    const p = {
      x: clamp(pointer.x, 0, this.view.imageWidth),
      y: clamp(pointer.y, 0, this.view.imageHeight),
    };
    if (this._isBuilding) {
      // The horizon is an observed feature of the photograph, so it is stored
      // as the point it was placed on; the pitch is re-derived from it.
      this.state.horizonPoint = p;
      this._recalculate({ quiet: true });
      return;
    }

    const { t } = this.projection.toLineCoords(p);
    const pitchRad = Math.atan2(t, this.projection.focalPx);
    const domain = this._solveDomain();
    const degrees = domain ? clamp(pitchRad * RAD, domain.min, domain.max) : pitchRad * RAD;
    if (!solveFromPitch(degrees * DEG, this.context)) return;
    this.state.solveValue = degrees;
    this._recalculate({ quiet: true });
  }

  _pointerMove(p) {
    if (!this.drag) return;
    if (this.drag.horizon) {
      this._dragHorizon(p);
      return;
    }
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

  /** One step of a scale, expressed in world units. */
  _scaleSize(scale) {
    const world = Number(scale.size) * (SIZE_IN_WORLD[scale.sizeUnit] ?? 1);
    return world > 0 ? world : 1;
  }

  _presetsFor(which) {
    return SCALE_PRESETS[this.state.unit === 'm' ? 'm' : 'ft'][which];
  }

  /** Build the scale controls for one half of the ruler. */
  _bindScale(which, key) {
    const preset = this.$(`in-${which}-preset`);
    const size = this.$(`in-${which}-size`);
    const unit = this.$(`in-${which}-unit`);
    const noun = this.$(`in-${which}-noun`);

    preset.onchange = () => {
      const chosen = this._presetsFor(which).find((x) => x.id === preset.value);
      this.state[key] = chosen
        ? { preset: chosen.id, size: chosen.size, sizeUnit: chosen.sizeUnit, noun: chosen.noun }
        // Custom: keep what is already there and open the fields to edit.
        : { ...this.state[key], preset: 'custom' };
      this._syncScales();
      this._recalculate();
    };

    const commitCustom = () => {
      const parsed = Number.parseFloat(String(size.value).replace(/[^0-9.]/g, ''));
      this.state[key] = {
        preset: 'custom',
        size: Number.isFinite(parsed) && parsed > 0 ? parsed : this.state[key].size,
        sizeUnit: unit.value,
        noun: noun.value.trim(),
      };
      this._syncScales();
      this._recalculate();
    };
    size.onchange = commitCustom;
    size.onblur = commitCustom;
    unit.onchange = commitCustom;
    noun.onchange = commitCustom;
    noun.onblur = commitCustom;
    for (const el of [size, noun]) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur();
      });
    }
  }

  /** Repaint both scale blocks from state, including the preset lists. */
  _syncScales() {
    const system = this.state.unit === 'm' ? 'm' : 'ft';
    for (const [which, key] of [['vertical', 'verticalScale'], ['projected', 'projectedScale']]) {
      const scale = this.state[key];
      const presets = this._presetsFor(which);

      const select = this.$(`in-${which}-preset`);
      select.textContent = '';
      for (const preset of [...presets, { id: 'custom', label: 'Custom…' }]) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.label;
        select.append(option);
      }
      // A preset from the other unit system cannot be offered, so such a scale
      // falls back to custom, which still carries the size the user had.
      const known = presets.some((x) => x.id === scale.preset);
      select.value = known ? scale.preset : 'custom';

      const unitSelect = this.$(`in-${which}-unit`);
      unitSelect.textContent = '';
      for (const u of SIZE_UNITS[system]) {
        const option = document.createElement('option');
        option.value = u;
        option.textContent = u;
        unitSelect.append(option);
      }
      unitSelect.value = SIZE_UNITS[system].includes(scale.sizeUnit) ? scale.sizeUnit : system;

      this.$(`custom-${which}`).hidden = known;
      this.$(`in-${which}-size`).value = String(Math.round(Number(scale.size) * 1e4) / 1e4);
      this.$(`in-${which}-noun`).value = scale.noun ?? '';

      const world = this._scaleSize(scale);
      const perUnit = system === 'm' ? 'metre' : 'foot';
      this.$(`out-${which}-scale`).textContent = scale.noun
        ? `${this.model.formatNumber(world)}${this._suffix} per ${scale.noun} · ${
            Math.round((1 / world) * 10) / 10} ${scale.noun}s per ${perUnit}`
        : `${this.model.formatNumber(world)}${this._suffix} per line`;
    }
  }

  _setRulerStyle(value) {
    this.state.rulerStyle = value;
    this._paintStyle(value);
    this._syncStyleFields();
  }

  get _isBuilding() {
    return this.state.calibrationMethod === 'building';
  }

  /** How a tapped point should be turned into an elevation, given the ruler. */
  get _measurementMode() {
    return this.state.rulerStyle === 'foundation' ? 'foundation' : 'ground';
  }

  _buildModel() {
    const common = {
      increment: this.state.increment,
      verticalIncrement: this._scaleSize(this.state.verticalScale),
      projectedIncrement: this._scaleSize(this.state.projectedScale),
      verticalNoun: this.state.verticalScale.noun,
      projectedNoun: this.state.projectedScale.noun,
      range: this.state.range,
      unitSuffix: this.state.unit === 'm' ? 'm' : "'",
    };
    if (this._isBuilding) {
      return new ElevationModel({
        ...common,
        originElevation: this.state.foundationElevation,
        knownElevation: this.state.foundationElevation + this.state.wallHeight,
        // The wall observes nothing about the ground, so the grade is stated
        // rather than derived. Positive falls away from the wall, which is a
        // rise along the sight line since away from the wall is towards you.
        slopeOverride: this.state.gradeAwayPercent / 100,
      });
    }
    return new ElevationModel({
      ...common,
      originElevation: this.state.originElevation,
      knownElevation: this.state.knownElevation,
      horizontalDistance: this.state.horizontalDistance,
      knownIsFarther: this.state.knownIsFarther,
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

    if (this.image && origin && known && this._isBuilding) {
      // Where the user put the horizon, as a point on the photograph. Turning
      // it into a pitch needs the sight line, which the wall marks define.
      const ctx = wallContext({
        imageWidth: this.view.imageWidth,
        imageHeight: this.view.imageHeight,
        fovDeg: this.state.fovDeg,
        foundationPoint: origin.imagePoint,
        wallPoint: known.imagePoint,
        wallHeight: this.state.wallHeight,
      });
      let pitchRad = null;
      // A survey measured the distance to the wall, which is the one thing the
      // photograph leaves open — so use it to place the horizon rather than
      // asking for it by eye. Only once: after that the horizon is the user's.
      if (this._pendingSurveyDistance != null) {
        const solved = solveWallForDistance(ctx, this._pendingSurveyDistance);
        this._pendingSurveyDistance = null;
        if (solved) pitchRad = solved.pitchRad;
        else this._surveyMismatch = 'The photo cannot place the wall at the surveyed distance — check the field of view, and that the marks are on the same wall.';
      }
      if (pitchRad == null && this.state.horizonPoint) {
        const t = dot(sub(this.state.horizonPoint, ctx.P0), ctx.d);
        pitchRad = Math.atan2(t, ctx.focalPx);
      }

      const result = calibrateFromWall({
        imageWidth: this.view.imageWidth,
        imageHeight: this.view.imageHeight,
        fovDeg: this.state.fovDeg,
        foundationPoint: origin.imagePoint,
        wallPoint: known.imagePoint,
        wallHeight: this.state.wallHeight,
        pitchRad,
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
        // Pin the horizon to wherever the solve actually put it, so the stored
        // point and the drawn line can never drift apart.
        this.state.horizonPoint = this.projection.fromLineCoords(this.projection.horizonT);
        if (this.state.step < 5) this.state.step = 5;
      } else {
        this.calibrationError = result.reason;
      }
    } else if (this.image && origin && known) {
      const result = calibrate({
        imageWidth: this.view.imageWidth,
        imageHeight: this.view.imageHeight,
        fovDeg: this.state.fovDeg,
        originPoint: origin.imagePoint,
        knownPoint: known.imagePoint,
        originElevation: this.state.originElevation,
        knownElevation: this.state.knownElevation,
        horizontalDistance: this.state.horizontalDistance,
        knownIsFarther: this.state.knownIsFarther,
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
    for (const point of this.annotations.measurements) point.mode = this._measurementMode;
    // The origin is the foundation in that workflow; name it so on the drawing.
    if (origin) {
      origin.elevation = this._isBuilding ? this.state.foundationElevation : this.state.originElevation;
      origin.label = this._isBuilding || this.state.rulerStyle === 'foundation' ? 'FOUNDATION' : 'ORIGIN';
    }
    if (known) {
      known.elevation = this._isBuilding
        ? this.state.foundationElevation + this.state.wallHeight
        : this.state.knownElevation;
      known.label = this._isBuilding ? 'WALL' : 'POINT B';
    }
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
    const { lo, hi } = pitchDomain(ctx);
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
        countFor: (point) => this._countLabelFor(point),
        horizonActive: this.drag?.horizon === true,
        horizonHint: this.state.showHorizon && !this.annotations.measurements.length,
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
    $('in-range').value = String(s.range);
    $('out-range').textContent = `±${s.range}${this._suffix}`;
    this._paintStyle(s.rulerStyle);
    this._paintKnownSide(s.knownIsFarther ? 'farther' : 'nearer');
    this._paintMethod(s.calibrationMethod);
    $('in-foundation-elev').value = this._fmt(s.foundationElevation);
    $('in-wall-height').value = this._fmt(s.wallHeight);
    this._syncMethodFields();
    this._syncScales();
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

  static STYLE_INFO = {
    slope: ['GRADE RULER', 'Each increment is a rung where the calibrated grade reaches that elevation.'],
    foundation: [
      'FOUNDATION RULER',
      "Above the zero line the increments run straight up at the origin's own distance. Below it they project out across the grade.",
    ],
    staff: ['LEVELLING STAFF', 'A virtual rod at one distance, graduated in elevation increments.'],
    both: ['GRADE + STAFF', 'The grade staircase and an upright staff together.'],
  };

  _syncStyleFields() {
    const foundation = this.state.rulerStyle === 'foundation';
    const [modeName, note] = App.STYLE_INFO[this.state.rulerStyle] ?? App.STYLE_INFO.slope;
    this.$('style-note').textContent = note;
    this.$('plane-mode').textContent = modeName;
    // In foundation mode the upright half is pinned to the origin's own
    // distance — that is the whole point of it — so there is nothing to slide.
    const staff = !foundation && (this.state.rulerStyle !== 'slope' || this.model.isFlat);
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

  /** Show only the fields that belong to the chosen calibration method. */
  _syncMethodFields() {
    const building = this._isBuilding;
    this.$('method-building').hidden = !building;
    this.$('method-twopoint').hidden = building;
    // In building mode the pitch comes from the horizon, so the fine-tune
    // selector has nothing left to choose between.
    this.$('wrap-fine-tune').hidden = building;
    this.$('in-grade-away').value = String(this.state.gradeAwayPercent);
    this.$('out-grade-away').textContent = `${this.state.gradeAwayPercent.toFixed(1)}%`;
  }

  _syncDerived() {
    const m = this.model;
    const building = this._isBuilding;
    this.$('out-delta').textContent = m.formatChange(m.deltaElevation);
    this.$('out-grade').textContent = m.isFlat ? 'Level' : m.formatGrade();

    const set = (id, text) => {
      this.$(id).textContent = text;
    };
    if (building) {
      const s = this.solution;
      set('out-b-cam', s ? `${m.formatNumber(s.cameraHeight)}${this._suffix}` : '—');
      set('out-b-dist', s ? `${m.formatNumber(s.originDistance)}${this._suffix}` : '—');
      set('out-b-eye', s ? m.formatElevation(m.originElevation + s.cameraHeight) : '—');
      set('out-b-grade', m.formatGradeAway());
    }

    for (const [block, role] of [['ref-origin', 'origin'], ['ref-known', 'known'],
                                 ['ref-foundation', 'origin'], ['ref-wall', 'known']]) {
      this.$(block).classList.toggle('is-set', !!this.annotations.referencePoint(role));
    }
    this.$('ref-horizon').classList.toggle('is-set', !!this.state.horizonPoint);
    for (const [button, role] of [['btn-set-origin', 'origin'], ['btn-set-known', 'known'],
                                  ['btn-set-foundation', 'origin'], ['btn-set-wall', 'known']]) {
      this.$(button).textContent = this.annotations.referencePoint(role) ? 'Move' : 'Tap on photo';
    }

    if (this.solution) {
      set('out-cam-h', `${m.formatNumber(this.solution.cameraHeight)}${this._suffix}`);
      set('out-pitch', `${(this.solution.pitchRad * RAD).toFixed(1)}° down`);
      set('out-eye', m.formatElevation(m.originElevation + this.solution.cameraHeight));
      const survey = this.surveyCalibration;
      if (survey?.ok && survey.cameraHeightAboveFoundation != null) {
        // The survey measured the camera height from the ground; the photo
        // derives it from the geometry. They are independent, so the gap is a
        // real check on whether the photo was taken from the observation point.
        const gap = this.solution.cameraHeight - survey.cameraHeightAboveFoundation;
        set('out-check',
            `${m.formatNumber(survey.cameraHeightAboveFoundation)}${this._suffix} surveyed · ${
              gap >= 0 ? '+' : ''}${m.formatNumber(gap)}${this._suffix} off`);
      } else {
        set('out-check', '—');
      }
      set('out-origin-d', `${m.formatNumber(this.solution.originDistance)}${this._suffix}`);
      set('out-focal', `${Math.round(this.projection.focalPx)} px`);
    } else {
      for (const id of ['out-cam-h', 'out-pitch', 'out-origin-d', 'out-focal', 'out-eye', 'out-check']) set(id, '—');
    }

    const warn = this.$('cal-warning');
    if (this._surveyMismatch) {
      warn.textContent = this._surveyMismatch;
      warn.hidden = false;
    } else if (this.calibrationError) {
      warn.textContent = this.calibrationError;
      warn.hidden = false;
    } else if (!building && this.model.isFlat && this.annotations.known) {
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
    // The count is the answer people actually want out of a step scale — how
    // many risers from here up to the house — so it gets its own line whenever
    // the scale that governs this point has something to count.
    const countRow = this.$('readout-count-row');
    const scale = point.valid && point.offset > 0 ? this.state.verticalScale : this.state.projectedScale;
    const usesScale =
      this.state.rulerStyle === 'foundation'
        ? true
        : this.state.rulerStyle === 'staff'
          ? this.state.verticalScale.noun
          : this.state.projectedScale.noun;
    if (point.valid && scale.noun && usesScale) {
      const size = this._scaleSize(scale);
      const count = m.countFor(point.offset, size);
      countRow.hidden = false;
      this.$('readout-count-key').textContent = `${scale.noun}s`;
      this.$('readout-count').textContent = m.formatCount(count, scale.noun, count % 1 > 1e-6 ? 1 : 0);
    } else {
      countRow.hidden = true;
    }

    const tag = this.$('readout-tag');
    tag.textContent = point.valid ? (point.isMeasured ? 'MEASURED' : 'PROJECTED') : 'NO READING';
    tag.classList.toggle('measured', point.isMeasured);
  }

  /** "6 steps" for a point, when the scale governing it counts something. */
  _countLabelFor(point) {
    if (!point?.valid || point.offset == null) return null;
    const scale = point.offset > 0 ? this.state.verticalScale : this.state.projectedScale;
    if (!scale.noun) return null;
    if (this.state.rulerStyle === 'slope' && point.offset > 0) return null;
    const count = this.model.countFor(point.offset, this._scaleSize(scale));
    if (count == null || count < 1e-9) return null;
    return this.model.formatCount(count, scale.noun, count % 1 > 1e-6 ? 1 : 0);
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
    const button = this.$('btn-reset');
    // Confirm with a second tap rather than a modal dialog: an embedded page
    // may not be permitted to open one, and on a tablet this is less fiddly.
    if (!this._resetArmed) {
      this._resetArmed = true;
      button.textContent = 'Tap to confirm';
      button.classList.add('is-armed');
      clearTimeout(this._resetTimer);
      this._resetTimer = setTimeout(() => this._disarmReset(), 3500);
      return;
    }
    this._disarmReset();

    const keepPhoto = this.image != null;
    this.annotations.clear();
    this.selectionQueue = [];
    Object.assign(this.state, {
      foundationElevation: 0,
      wallHeight: 8,
      horizonPoint: null,
      gradeAwayPercent: 2,
      originElevation: 100,
      knownElevation: 103,
      horizontalDistance: 40,
      increment: 1,
      verticalScale: { preset: 'ft1', size: 1, sizeUnit: 'ft', noun: '' },
      projectedScale: { preset: 'ft1', size: 1, sizeUnit: 'ft', noun: '' },
      range: 10,
      fovDeg: 60,
      solveMode: 'height',
      solveValue: 5.5,
      rulerStyle: this._isBuilding ? 'foundation' : 'slope',
      knownIsFarther: true,
      rungWidth: 10,
      staffDistance: null,
      labelMode: 'elevation',
      step: keepPhoto ? 2 : 1,
    });
    this._syncControls();
    this._recalculate();
    if (keepPhoto) this._arm('origin');
    this._toast(keepPhoto ? 'Reset. The photograph is still loaded.' : 'Reset.');
  }

  _disarmReset() {
    clearTimeout(this._resetTimer);
    this._resetArmed = false;
    const button = this.$('btn-reset');
    button.textContent = 'Reset';
    button.classList.remove('is-armed');
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
      if (result.status === 'shared') this._toast('Shared.');
      else if (result.status === 'cancelled') this._toast('Export cancelled.');
      else await this._showExport(result.url, result.blob);
    } catch (err) {
      this._toast(err.message ?? 'Export failed.', true);
    }
  }

  async _showExport(url, blob) {
    const img = this.$('export-image');
    if (this._exportUrl) URL.revokeObjectURL(this._exportUrl);
    this._exportUrl = url;
    this._exportBlob = blob;
    img.src = url;
    this.$('export-sheet').hidden = false;

    // Offer whichever save route works here. Press-and-hold on the image works
    // everywhere and is the hint shown regardless.
    const link = this.$('export-download');
    const openTab = this.$('export-open');
    const saver = await this.exporter.hostSaver();
    if (saver) {
      // Embedded: the host mediates saving, and a plain link would do nothing.
      link.removeAttribute('href');
      link.removeAttribute('download');
      link.textContent = 'Save image';
      openTab.hidden = true;
    } else {
      link.href = url;
      link.setAttribute('download', 'elevation-ruler.png');
      link.textContent = 'Download';
      openTab.hidden = false;
    }
  }

  /** Save through the host when it mediates downloads; otherwise the link works. */
  async _saveExport(event) {
    const saver = await this.exporter.hostSaver();
    if (!saver) return; // the anchor's own download does the work
    event.preventDefault();
    if (!this._exportBlob) return;
    try {
      await saver.save({ filename: 'elevation-ruler.png', data: this._exportBlob });
      this._toast('Image saved.');
    } catch (err) {
      this._toast(ExportManager.saveErrorMessage(err), err?.code !== 'declined');
    }
  }

  _hideExport() {
    this.$('export-sheet').hidden = true;
    this.$('export-image').removeAttribute('src');
    this._exportBlob = null;
    if (this._exportUrl) {
      URL.revokeObjectURL(this._exportUrl);
      this._exportUrl = null;
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

    // A session saved before the building method existed holds origin/Point B
    // marks. Left to default to 'building' they would be silently reinterpreted
    // as a foundation and a wall, quietly changing what the numbers mean.
    const restored = payload.state ?? {};
    if (restored.calibrationMethod == null) restored.calibrationMethod = 'twoPoint';
    // A session saved before the ruler had two scales carries a single
    // increment. Carry it into both halves rather than silently resetting the
    // ruler to whole feet.
    if (restored.verticalScale == null && restored.increment > 0) {
      const carried = { preset: 'custom', size: restored.increment, sizeUnit: 'ft', noun: '' };
      restored.verticalScale = { ...carried };
      restored.projectedScale = { ...carried };
    }
    Object.assign(this.state, restored, { tool: 'select' });
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
