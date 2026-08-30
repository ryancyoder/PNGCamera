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
   * Why the tilt cannot be read here, or null when it can be tried.
   *
   * Both of these are silent otherwise: an embedded page never sees a prompt
   * and simply gets no events, and an insecure origin has the API present but
   * permanently refusing. Saying which it is turns "the button does nothing"
   * into something the user can act on.
   */
  get blockedReason() {
    if (!this.available) {
      return 'This device does not report its tilt. Type the angles instead.';
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return 'Motion sensors need https. Open the app at an https address, or type the angles.';
    }
    // Motion is only delegated to an embedded page when the embedder asks for
    // it, which most do not — including a published artifact.
    if (typeof window !== 'undefined' && window.top !== window.self) {
      return 'Motion is blocked inside an embedded page. Open the app at its own address to shoot with the iPad, or type the angles here.';
    }
    return null;
  }

  /**
   * Ask for access and begin listening. Must be called from a user gesture on
   * iOS, or the request is rejected without ever prompting.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async start() {
    const blocked = this.blockedReason;
    if (blocked) return { ok: false, reason: blocked };
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
