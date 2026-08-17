// ============================================================
// LOOP — FIXED TIMESTEP, INTERPOLATED RENDER
// ============================================================
//
// The simulation advances in fixed 1/60 s steps regardless of
// display refresh rate; the renderer draws between the last two
// steps using an interpolation factor. This is the classic
// accumulator pattern and it buys three things this project
// needs:
//
//   1. Determinism. Physics that depends on frame timing cannot
//      be replayed from a seed. Ours can.
//   2. Stability. Steering and separation forces integrated with
//      a variable dt visibly wobble; with a fixed dt they do not.
//   3. Smoothness on any display. A 144 Hz monitor renders 144
//      interpolated views of a 60 Hz simulation, and motion looks
//      correct on both that and a 60 Hz panel.
//
// The cost is that every entity must keep `prevX/prevY/prevAngle`
// and the renderer must remember to interpolate. `sim/entities.js`
// handles the first; `render/scene.js` the second.

import { FIXED_DT, MAX_STEPS_PER_FRAME } from './constants.js';

export class Loop {
    /**
     * @param {(dt:number)=>void} step    advance the sim by exactly dt seconds
     * @param {(alpha:number)=>void} draw  render, blending prev→current by alpha
     */
    constructor(step, draw) {
        this.step = step;
        this.draw = draw;

        this.running = false;
        this.paused = false;
        this.speed = 1;              // simulation rate multiplier
        this.accumulator = 0;        // s of unsimulated time carried between frames
        this.lastTime = 0;           // ms, from rAF
        this.frameId = 0;

        // Rolling perf figures for the ?debug=1 overlay.
        this.simMs = 0;
        this.drawMs = 0;
        this.stepsLastFrame = 0;

        this._tick = this._tick.bind(this);
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.lastTime = performance.now();
        this.accumulator = 0;
        this.frameId = requestAnimationFrame(this._tick);
    }

    stop() {
        this.running = false;
        cancelAnimationFrame(this.frameId);
    }

    togglePause() {
        this.paused = !this.paused;
        // Drop banked time, or the sim fast-forwards through the pause.
        this.accumulator = 0;
        return this.paused;
    }

    /**
     * Advance the simulation by exactly one fixed step (1/60s) and render with alpha = 1.
     * Keeps the loop paused and clears any accumulated time debt.
     */
    stepOnce() {
        this.paused = true;
        this.accumulator = 0;

        const simStart = performance.now();
        this.step(FIXED_DT);
        this.simMs = performance.now() - simStart;
        this.stepsLastFrame = 1;

        const drawStart = performance.now();
        this.draw(1);
        this.drawMs = performance.now() - drawStart;
    }

    _tick(now) {
        if (!this.running) return;
        this.frameId = requestAnimationFrame(this._tick);

        let elapsed = (now - this.lastTime) / 1000;
        this.lastTime = now;

        // A backgrounded tab or a breakpoint can hand us an enormous
        // delta. Clamp it: better to lose simulated time than to run
        // hundreds of catch-up steps and stall the frame.
        if (elapsed > 0.25) elapsed = 0.25;

        if (!this.paused) this.accumulator += elapsed * this.speed;

        const simStart = performance.now();
        let steps = 0;
        while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
            this.step(FIXED_DT);
            this.accumulator -= FIXED_DT;
            steps++;
        }
        // If we hit the ceiling we are running behind. Shed the backlog
        // rather than accumulating a debt we can never repay.
        if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

        this.stepsLastFrame = steps;
        this.simMs = performance.now() - simStart;

        const drawStart = performance.now();
        this.draw(this.paused ? 1 : this.accumulator / FIXED_DT);
        this.drawMs = performance.now() - drawStart;
    }
}
