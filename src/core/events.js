// ============================================================
// EVENTS
// ============================================================
//
// A ~30-line pub/sub, and the seam that keeps `src/sim` free of
// any knowledge of `src/render`.
//
// The sim announces facts — a shot was fired, a hull took a hit,
// a ship died. It does not know that anyone is drawing muzzle
// flashes or fracturing hulls into shards. That separation is
// what lets `npm test` run the entire simulation under Node with
// no DOM stubbing at all, and it is why adding a new visual
// flourish never means editing simulation code.
//
// Emission is synchronous: handlers run inside the sim step that
// emitted them. That is deliberate — FX spawned from an event
// need the exact position the event happened at, not the
// position one frame later.

export class EventBus {
    constructor() {
        /** @type {Map<string, Function[]>} */
        this.handlers = new Map();
    }

    /** Subscribe. Returns an unsubscribe function. */
    on(type, fn) {
        let list = this.handlers.get(type);
        if (!list) this.handlers.set(type, (list = []));
        list.push(fn);
        return () => this.off(type, fn);
    }

    off(type, fn) {
        const list = this.handlers.get(type);
        if (!list) return;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    }

    /**
     * Fire an event. `payload` is reused by callers between emits,
     * so handlers must read what they need immediately and never
     * retain the object.
     */
    emit(type, payload) {
        const list = this.handlers.get(type);
        if (!list) return;
        for (let i = 0; i < list.length; i++) list[i](payload);
    }

    clear() {
        this.handlers.clear();
    }
}

/**
 * The event vocabulary. Keeping it as a frozen table rather than
 * bare strings means a typo is a crash at import time instead of
 * a handler that silently never fires.
 */
export const EV = Object.freeze({
    SHOT_FIRED: 'shot:fired',       // { x, y, angle, faction, weapon, id }
    SHOT_HIT: 'shot:hit',           // { x, y, angle, faction, target, ownerId }
    SHOT_EXPIRED: 'shot:expired',   // { x, y, faction }
    SHIP_SPAWNED: 'ship:spawned',   // { ship }
    SHIP_DIED: 'ship:died',         // { ship, killerId }
    ORE_DEPLETED: 'ore:depleted',   // { asteroid }
    DEPOSIT: 'deposit',             // { ship, amount }
    // Decisions, not incidents. A state machine announces where it
    // went; these two announce where a *policy* went, which is the
    // other half of "why is this faction doing that".
    BUILD_STARTED: 'build:started', // { ship, type }
    BUILD_BLOCKED: 'build:blocked', // { ship, reason }  — on change only
    CLAIM_TAKEN: 'claim:taken',     // { ship, field }
    CLAIM_RELEASED: 'claim:released', // { ship, field }
    // A whole faction changed its mind about what it is doing. Fires
    // on change only — a posture holds for tens of seconds at a time,
    // and the rule two paragraphs down applies to it exactly.
    POSTURE_CHANGED: 'posture:changed', // { faction, from, to }
    // A hull dropped out of warp. Carries the *arrival* bearing so the
    // flash can be drawn along the direction of travel rather than as
    // a symmetrical puff.
    WARP_IN: 'warp:in',             // { ship, x, y, angle }
    // An incursion began. Nothing draws it; it is the timestamp for
    // the most consequential thing that happens in a run.
    INCURSION: 'incursion',         // { wave, index, x, y }
    SHIP_ERROR: 'ship:error',       // { ship, error }
});

// Most of these have no visual consequence at all, and for a while
// that made them look like dead weight. They are not: the bus is the
// simulation stating what it just did, and `core/telemetry.js`
// subscribes to every one of them. A shot that expires draws nothing
// and is exactly how you measure accuracy; a deposit draws nothing
// and is exactly how you measure a mining round trip. Anything worth
// announcing is worth announcing whether or not it is worth drawing.
//
// Two rules for adding one, both learned from `DEPOSIT`:
//
//   Announce facts, not frames. `DEPOSIT` fires per transfer, which
//   is per step while a miner is docked — seven thousand emissions
//   for seventy actual deliveries. It is not wrong, but a consumer
//   has to collapse it, so the recorder does (see the coalescing note
//   in core/telemetry.js). Prefer an event that fires once.
//
//   A repeating *condition* fires on change, not on tick.
//   `BUILD_BLOCKED` is true for minutes at a time and emits once,
//   when the reason changes. Anything else is a per-step allocation
//   in a hot loop for a fact that has not moved.
