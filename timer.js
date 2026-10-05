/* ============================================================
   timer.js  —  CHESS CLOCK
   ------------------------------------------------------------
   A tiny, UI-free clock for two players. It only knows about
   milliseconds and colours ("w" / "b"); game.js decides what to
   show on screen and what to do when someone runs out of time.

   Usage:
     const clock = new ChessTimer({
       onTick: (times, active) => { ... },   // ~10x per second
       onFlag: (color)         => { ... }    // that colour ran out of time
     });
     clock.configure(5);     // 5 minutes each  (0 = no timer)
     clock.start("w");       // White's clock starts running
     clock.switchTo("b");    // after White moves
     clock.pause();          // e.g. menu opened
     clock.resume();
     clock.stop();           // game over

   Accuracy: elapsed time is measured with performance.now(), not by
   counting interval ticks, so the clock stays correct even if the
   browser throttles timers (background tab, slow phone).
   ============================================================ */

class ChessTimer {
  constructor(handlers = {}) {
    this.onTick = handlers.onTick || (() => {});
    this.onFlag = handlers.onFlag || (() => {});
    this._interval = null;
    this.configure(0);
  }

  /* ---------- setup ---------- */

  // minutes = 0 turns the timer off ("No timer").
  configure(minutes) {
    this._clearInterval();
    this.minutes = minutes;
    this.enabled = minutes > 0;
    this.total = minutes * 60 * 1000;
    this.times = { w: this.total, b: this.total };   // remaining ms per colour
    this.active = null;                              // whose clock is ticking
    this.running = false;
    this.flagged = null;                             // colour that ran out, if any
    this._last = 0;
    this._emit();
  }

  /* ---------- controls ---------- */

  // Begin counting down `color`'s clock.
  start(color) {
    if (!this.enabled || this.flagged) return;
    this.active = color;
    this._last = performance.now();
    this.running = true;
    this._ensureInterval();
    this._emit();
  }

  // The player who just moved stops; the other player's clock starts.
  switchTo(color) {
    if (!this.enabled || this.flagged) return;
    if (this.running) this._account();      // bank the time used so far
    if (this.flagged) return;               // (that bank may have flagged them)
    this.active = color;
    this._last = performance.now();
    this._emit();
  }

  // Freeze (menu opened, tab hidden by the game, etc.).
  pause() {
    if (!this.running) return;
    this._account();
    this._clearInterval();
    this.running = false;
  }

  // Continue after pause().
  resume() {
    if (!this.enabled || this.running || !this.active || this.flagged) return;
    this._last = performance.now();
    this.running = true;
    this._ensureInterval();
  }

  // Stop for good (game over). Times stay readable.
  stop() {
    if (this.running) this._account();
    this._clearInterval();
    this.running = false;
  }

  /* ---------- helpers ---------- */

  remaining(color) { return this.times[color]; }

  // Below this a clock is "getting low" (amber): 20% of the game, max 30 s.
  get lowThreshold() { return Math.min(30000, this.total * 0.2); }

  // Below this it is "critical" (red, pulsing, ticking sound).
  get criticalThreshold() { return 10000; }

  // 65000 -> "1:05"   |   under 10 s -> "0:07.4"
  static format(ms) {
    ms = Math.max(0, ms);
    if (ms < 10000) {
      const tenths = Math.floor(ms / 100) % 10;
      return `0:0${Math.floor(ms / 1000)}.${tenths}`;
    }
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  /* ---------- internals ---------- */

  // Subtract the time since the last check from the active clock.
  _account() {
    if (!this.active) return;
    const now = performance.now();
    this.times[this.active] -= now - this._last;
    this._last = now;

    if (this.times[this.active] <= 0) {
      this.times[this.active] = 0;
      this.flagged = this.active;
      this._clearInterval();
      this.running = false;
      this._emit();
      this.onFlag(this.flagged);
    }
  }

  _tick() {
    if (!this.running) return;
    this._account();
    if (!this.flagged) this._emit();
  }

  _emit() { this.onTick({ ...this.times }, this.active); }

  _ensureInterval() {
    if (!this._interval) this._interval = setInterval(() => this._tick(), 100);
  }

  _clearInterval() {
    clearInterval(this._interval);
    this._interval = null;
  }
}
