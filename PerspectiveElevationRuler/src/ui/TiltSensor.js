// TiltSensor.js
//
// The iPad's tilt, as an angle above horizontal. Level reads 0, up is positive,
// down is negative — the convention the survey maths expects.
//
// iOS gates DeviceOrientationEvent behind a permission call that only works from
// a user gesture, so this is started by a button press and never on load.
//
// Shots are averaged over a short dwell rather than sampled once. A single frame
// catches whatever wobble your hands were doing at that instant, and the spread
// across the dwell is itself the useful number: it says how steadily you held
// the thing, which is the difference between a reading you can trust and five
// that agree beautifully and are all wrong.

import { angleFromOrientation, mean, halfRange } from '../core/SiteSurvey.js';

export class TiltSensor {
  constructor({ onReading } = {}) {
    this.onReading = onReading;
    this.angle = null;
    this.available = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
    this.granted = false;
    this.listening = false;
    this._samples = [];
  }

  /** Whether this device wants an explicit permission grant (iOS does). */
  get needsPermission() {
    return (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    );
  }

  /**
   * Ask for access and begin listening. Must be called from a user gesture on
   * iOS, or the request is rejected without ever prompting.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async start() {
    if (!this.available) {
      return { ok: false, reason: 'This device does not report its tilt. Enter angles by hand.' };
    }
    if (this.needsPermission && !this.granted) {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== 'granted') {
          return { ok: false, reason: 'Motion access was declined. Enter angles by hand.' };
        }
      } catch {
        return {
          ok: false,
          reason: 'Motion access could not be requested. Open the page in Safari over https.',
        };
      }
    }
    this.granted = true;
    if (!this.listening) {
      window.addEventListener('deviceorientation', this._handle);
      this.listening = true;
    }
    return { ok: true };
  }

  stop() {
    if (this.listening) {
      window.removeEventListener('deviceorientation', this._handle);
      this.listening = false;
    }
    this._samples = [];
    this.angle = null;
  }

  _handle = (event) => {
    const angle = angleFromOrientation(event.beta, event.gamma);
    if (angle == null) return;
    this.angle = angle;
    const now = Date.now();
    this._samples.push({ t: now, angle });
    // Keep a couple of seconds; anything older is not this shot.
    const cutoff = now - 2500;
    while (this._samples.length && this._samples[0].t < cutoff) this._samples.shift();
    this.onReading?.(angle);
  };

  /**
   * The reading for a shot: the mean over the last `windowMs`, with the spread
   * that produced it.
   *
   * Taking a shot CONSUMES its samples. Without that, two targets shot inside
   * the dwell window average into each other — aim at the curb, shoot, swing up
   * to the eave, shoot, and the second reading is a blend of the two. It is
   * silent, it looks plausible, and it is wrong by however far you swung.
   *
   * @returns {{angle:number, spread:number|null, samples:number}|null}
   */
  capture(windowMs = 700) {
    if (this.angle == null) return null;
    const cutoff = Date.now() - windowMs;
    const recent = this._samples.filter((s) => s.t >= cutoff).map((s) => s.angle);
    this._samples = [];
    if (!recent.length) return { angle: this.angle, spread: null, samples: 1 };
    return { angle: mean(recent), spread: halfRange(recent), samples: recent.length };
  }
}
