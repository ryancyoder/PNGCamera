// SightView.js
//
// The sighting half of a grade shot: a live camera preview with a crosshair to
// aim, and the tilt read off the device as you hold it there.
//
// The camera is not measuring anything — the angle comes from the tilt sensor.
// What the preview is for is aiming: a number with no picture behind it gives
// you no way to know you were on the eave rather than the gutter, and no way to
// tell afterwards which of five identical "Target 3" readings was which. Upright
// makes the same point the hard way; a yard full of unlabelled pins is
// impossible to place later.
//
// Shots fire on DWELL, as they do in Upright: hold the crosshair steady and it
// takes the shot itself, so you are not fumbling for a button while aiming a
// tablet at a roof. After a shot it disarms until you move off the target, or
// one long hold would machine-gun the same point.

import { PIN_COLOURS } from './SitePlanView.js';
import { SiteSurvey } from '../core/SiteSurvey.js';

/** Hold within this many degrees to count as steady. */
const DWELL_TOLERANCE_DEG = 0.6;
/** How long to hold before the shot fires. */
const DWELL_MS = 900;
/** Move off by this much to arm the next shot. */
const REARM_DEG = 1.5;

export class SightView {
  constructor(root, { survey, tilt, onShot, onClose } = {}) {
    this.root = root;
    this.survey = survey;
    this.tilt = tilt;
    this.onShot = onShot;
    this.onClose = onClose;

    this.video = root.querySelector('#sight-video');
    this.targetId = null;
    this.stream = null;
    this.armed = true;
    this._dwellFrom = null;
    this._dwellAngle = null;
    this._lastShotAngle = null;
    this._raf = null;

    root.querySelector('#sight-shoot').onclick = () => this.shoot();
    root.querySelector('#sight-done').onclick = () => this.close();
  }

  /**
   * Why the camera cannot run here, or null when it can be tried. Same two
   * gates as the motion sensor, and just as silent when they are unmet.
   */
  get blockedReason() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return 'This browser offers no camera.';
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return 'The camera needs https. Open the app at an https address.';
    }
    if (typeof window !== 'undefined' && window.top !== window.self) {
      return 'The camera is blocked inside an embedded page. Open the app at its own address.';
    }
    return null;
  }

  /**
   * Open the sight on a target.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async open(targetId) {
    const blocked = this.blockedReason;
    if (blocked) return { ok: false, reason: blocked };

    const tiltResult = await this.tilt.start();
    if (!tiltResult.ok) return tiltResult;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      return {
        ok: false,
        reason:
          err?.name === 'NotAllowedError'
            ? 'Camera access was declined. Allow it in Safari, or type the angle.'
            : 'The camera could not be opened. Type the angle instead.',
      };
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    try {
      await this.video.play();
    } catch {
      // Autoplay refusal is not fatal: the stream is attached and iOS starts it
      // on the first touch. Nothing here depends on the frames.
    }

    this.targetId = targetId;
    this.armed = true;
    this._dwellFrom = null;
    this._lastShotAngle = null;
    this.root.hidden = false;
    this._paint();
    this._loop();
    return { ok: true };
  }

  close() {
    cancelAnimationFrame(this._raf);
    this._raf = null;
    // Release the camera outright. iOS shows its recording indicator for an
    // open track whether or not anything is being read from it.
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.root.hidden = true;
    this.targetId = null;
    this.onClose?.();
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** Record the current reading against the open target. */
  shoot() {
    const reading = this.tilt.capture();
    if (!reading || this.targetId == null) return null;
    this.survey.addShot(this.targetId, reading.angle);
    this._lastShotAngle = reading.angle;
    this.armed = false;
    this._dwellFrom = null;
    this.onShot?.(this.targetId, reading);
    this._paint();
    return reading;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => {
      this._tick();
      if (this.isOpen) this._loop();
    });
  }

  _tick() {
    const angle = this.tilt.angle;
    if (angle == null) return;

    // Re-arm once you have moved off the point you just shot.
    if (!this.armed && this._lastShotAngle != null &&
        Math.abs(angle - this._lastShotAngle) > REARM_DEG) {
      this.armed = true;
    }

    if (!this.armed) {
      this._dwellFrom = null;
    } else if (this._dwellAngle == null || Math.abs(angle - this._dwellAngle) > DWELL_TOLERANCE_DEG) {
      // Drifted: start the hold again from here.
      this._dwellAngle = angle;
      this._dwellFrom = performance.now();
    } else if (this._dwellFrom != null && performance.now() - this._dwellFrom >= DWELL_MS) {
      this.shoot();
    }
    this._paint();
  }

  _paint() {
    const spec = this.targetId ? SiteSurvey.spec(this.targetId) : null;
    const colour = this.targetId ? PIN_COLOURS[this.targetId] : '#8fe9ff';
    const angle = this.tilt.angle;
    const shots = this.targetId ? this.survey.point(this.targetId).shots.length : 0;

    this.root.style.setProperty('--sight-colour', colour);
    this.root.querySelector('#sight-target').textContent = spec ? spec.name.toUpperCase() : '';
    this.root.querySelector('#sight-angle').textContent =
      angle == null ? '—' : `${angle >= 0 ? '+' : ''}${angle.toFixed(1)}°`;
    this.root.querySelector('#sight-shots').textContent =
      shots ? `${shots} shot${shots === 1 ? '' : 's'} taken` : 'hold steady to shoot';

    // A ring that fills while the hold counts down, so the automatic shot is
    // something you can see coming rather than a surprise.
    const progress =
      this.armed && this._dwellFrom != null
        ? Math.min(1, (performance.now() - this._dwellFrom) / DWELL_MS)
        : 0;
    this.root.querySelector('#sight-dwell').style.setProperty('--progress', String(progress));
    this.root.classList.toggle('is-armed', this.armed);
  }
}
