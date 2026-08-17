// ============================================================
// RNG — SEEDED, DETERMINISTIC
// ============================================================
//
// The simulation must be reproducible. A self-playing sim that
// cannot be replayed is undebuggable: "a fighter did something
// odd around minute three" is unactionable unless you can get
// the exact same minute three back.
//
// So: no `Math.random()` anywhere in `src/sim`. Every stochastic
// decision draws from a Rng instance carried on the world, and
// `?seed=12345` replays a run exactly.
//
// mulberry32 — 32-bit state, passes gjrand, ~2^32 period. Far
// better than we need and about as small as a decent generator
// gets.

export class Rng {
    constructor(seed = 1) {
        // Reject 0 (mulberry32's fixed point) and coerce to uint32.
        this.state = (seed >>> 0) || 0x9e3779b9;
    }

    /** Uniform in [0, 1). */
    next() {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Uniform in [lo, hi). */
    range(lo, hi) {
        return lo + this.next() * (hi - lo);
    }

    /** Uniform integer in [lo, hi]. */
    int(lo, hi) {
        return Math.floor(this.range(lo, hi + 1));
    }

    /** Uniform in [-m, m]. */
    spread(m) {
        return (this.next() * 2 - 1) * m;
    }

    /** Uniform angle in [0, TAU). */
    angle() {
        return this.next() * Math.PI * 2;
    }

    /** True with probability p. */
    chance(p) {
        return this.next() < p;
    }

    /** Uniform choice from a non-empty array. */
    pick(arr) {
        return arr[Math.floor(this.next() * arr.length)];
    }

    /**
     * A fresh generator deterministically derived from this one.
     * Useful for giving a subsystem its own stream so that adding
     * a draw in one place does not shift every later draw
     * everywhere else.
     */
    fork() {
        return new Rng((this.next() * 4294967296) >>> 0);
    }
}

/**
 * Read the seed from `?seed=`, falling back to a time-derived one.
 *
 * The fallback is the *only* place a non-reproducible number
 * enters the project, and it is logged so any interesting run can
 * be pinned afterwards.
 */
export function seedFromLocation(search) {
    const raw = new URLSearchParams(search).get('seed');
    if (raw !== null && raw !== '' && Number.isFinite(Number(raw))) {
        return Number(raw) >>> 0;
    }
    return (Date.now() ^ (performance.now() * 1000)) >>> 0;
}
