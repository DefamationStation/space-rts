// ============================================================
// YARD — CHOOSING WHAT TO BUILD
// ============================================================
//
// One function, in a module of its own, because two things build
// now: the station works through PRODUCTION_POLICY, and the factory
// works through FACTORY_POLICY. The rule for *whether a faction can
// afford the next thing on its list* is identical for both and must
// stay that way — the upkeep runway, the catch-up subsidy and the
// blocking-rule semantics are subtle enough that a second copy would
// drift within a session and the drift would be invisible.
//
// The policy is the parameter. Everything else here is the same
// argument it always was, moved rather than rewritten.

import { SHIP_TYPES } from '../data/ships.js';
import { CATCHUP_COST, UPKEEP_RUNWAY } from '../core/constants.js';

/** Reused, never allocated per call — this runs once per yard per step. */
const _choice = { type: null, blocked: '' };

/** Per-policy reason strings, built once so the hot path allocates nothing. */
export function reasonMaps(policy) {
    return {
        saving: new Map(policy.map((r) => [r.type, 'saving-for-' + r.type])),
        cannot: new Map(policy.map((r) => [r.type, 'cannot-afford-' + r.type])),
    };
}

/**
 * Walk the policy top-down and decide what to build.
 *
 * `blocking` is what stops a faction from spending its way out of
 * an economy: if a blocking rule still wants a ship it cannot
 * afford, production stops and metal accumulates rather than
 * leaking into whatever happens to be cheap. See the long note in
 * data/production.js.
 *
 * It returns *why* as well as *what*, because "nothing" is three
 * different situations that look identical from outside: saving up
 * for something the policy insists on, having everything the policy
 * asks for, or being too poor for even the cheapest rule. A station
 * sitting on a thousand metal is one of those and the treasury alone
 * cannot say which.
 */
export function chooseBuild(faction, world, policy, saving, cannot) {
    _choice.type = null;
    _choice.blocked = 'policy-satisfied';

    for (let i = 0; i < policy.length; i++) {
        const rule = policy[i];
        if (rule.when && !rule.when(faction, world)) continue;

        const alive = faction.counts[rule.type] || 0;
        // A cap may be a number or a function of the faction, so a
        // rule can widen when the situation calls for it without
        // needing a second near-identical row alongside it.
        const cap = typeof rule.maxAlive === 'function' ? rule.maxAlive(faction, world) : rule.maxAlive;
        if (alive >= cap) continue;

        const def = SHIP_TYPES[rule.type];
        const price = def.cost * (faction.mobilised ? CATCHUP_COST : 1);
        // Buy it, and be able to keep it.
        //
        // Upkeep alone is not a ceiling on fleet size — it is a
        // ceiling on *affordable* fleet size, and a policy that spends
        // down to the last coin never notices the difference. Left to
        // itself it grew every fleet until wages consumed the entire
        // income, then sat there: measured across twelve seeds, every
        // faction ended under fifty metal, all twelve stalled on
        // `saving-for-fighter`, and ore mined fell by a fifth. Two
        // sides in permanent poverty is not a balance, it is a
        // treadmill.
        //
        // Requiring a runway turns it into the soft ceiling it was
        // meant to be. A faction must hold enough to pay its current
        // wages for `UPKEEP_RUNWAY` seconds *beyond* the price of the
        // hull, so a fleet stops growing well before it eats its own
        // economy, and a richer faction can carry a bigger one. That
        // is what "fleet size follows income" has to mean if it is to
        // mean anything.
        // A mobilised yard pays no wages, so it needs no runway
        // either — requiring one would be asking a destitute faction
        // to save for an expense it is exempt from.
        // ...scaled per rule, because the runway is a rule about
        // *fleet* growth and not everything on this list is fleet.
        //
        // A miner is income. Requiring a faction to bank forty-five
        // seconds of wages before it may buy the thing that earns the
        // wages is precisely the treadmill the paragraph above
        // describes, one level down — and it made the lean miner slot
        // unreachable by construction: a faction counts as lean below
        // twenty seconds of upkeep, and the cheapest miner needed
        // forty-five plus its price. The extra slot opened exactly
        // when it could never be used. Measured: the fourth miner was
        // built zero times in four half-hour runs.
        const need = rule.runway === undefined ? 1 : rule.runway;
        const runway = faction.mobilised ? 0 : faction.upkeep * UPKEEP_RUNWAY * need;
        if (faction.metal >= price + rule.reserve + runway) {
            _choice.type = rule.type;
            _choice.blocked = '';
            return _choice;
        }
        if (rule.blocking) {
            _choice.blocked = saving.get(rule.type);
            return _choice;
        }
        _choice.blocked = cannot.get(rule.type);
    }
    return _choice;
}
