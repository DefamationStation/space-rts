// ============================================================
// OUTPOSTS — WHERE A FORWARD STORE GOES
// ============================================================
//
// One function, in a module of its own, because two callers need it
// and they must never disagree: `data/production.js` asks whether
// there is anywhere worth building a shed, and
// `behaviors/mothership.js` asks where to put the one it just
// finished. If those two answers could differ, a faction could save
// up for a structure that turns out to have nowhere to stand.
//
// It lives here rather than in either of them because production is
// data and the mothership is a behaviour, and a shared answer that
// sits inside one of the two makes them import each other — which is
// exactly the cycle this file was created to break.

import { dist } from '../core/math.js';
import { inSanctuary } from './behaviors/common.js';
import {
    OUTPOST_TRIGGER, OUTPOST_MIN_HOME, OUTPOST_SPACING, OUTPOST_SHARE,
} from '../core/constants.js';

/**
 * Where a faction's next forward store should stand.
 *
 * The centroid of the fields its miners are actually having to reach,
 * not any one of them. Siting a shed *on* a field looks obviously
 * right and strands it the moment that cluster runs dry — which,
 * with a four-minute respawn, is the normal case rather than the edge
 * one. Sited among them it stays useful as they empty around it, and
 * only becomes worthless when the whole frontier has moved past.
 *
 * Returns null when there is nothing far enough away to be worth it,
 * which is also the answer to "should we build one at all".
 */
export function outpostSite(world, faction) {
    const home = world.ship(faction.motherships[0]);
    if (!home) return null;

    // Where this faction's miners are *actually working*, not where
    // ore happens to exist.
    //
    // Keyed on claimed fields because the first version keyed on the
    // map: any field beyond the trigger distance counted, so a shed
    // went up at 107 s in the middle of nowhere while every miner was
    // still working nine hundred units from home. They all preferred
    // the station, the shed never received a single ore, and its
    // haulers sat idle for the entire run. An outpost is a response to
    // a commute, and only the miners know whether they have one.
    //
    // And that commute is to the nearest *deposit point*, not to the
    // station — the whole reason a shed exists is that it is closer
    // than home. Measuring against home alone is why a faction built
    // exactly one: the first shed went up at the centroid of every
    // claimed field, that centroid barely moved as the frontier
    // advanced, and OUTPOST_SPACING refused a second one forever.
    //
    // So the fields that already have somewhere to unload are not
    // counted at all, and the centroid is taken over the ones that do
    // not. What that centroid points at is precisely the part of the
    // frontier nothing serves yet, which is where the next shed goes.
    let sx = 0, sy = 0, n = 0, far = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const m = world.ships[i];
        if (m.dead || m.role !== 'miner' || m.factionId !== faction.id) continue;
        const f = world.fields[m.claimId];
        if (!f || f.home) continue;

        n++;
        if (nearestDrop(world, faction, f.x, f.y) < OUTPOST_TRIGGER) continue;

        far++;
        sx += f.x; sy += f.y;
    }

    // A third of the fleet commuting is enough to justify the next
    // shed, not half.
    //
    // Half was right when there was only ever going to be one: it
    // asked "is this faction's whole operation too far from home".
    // For a *chain* it asks the wrong thing — once the first shed
    // stands, the miners it serves are no longer far from anything,
    // so they count against the very extension the miners past it
    // need. A third is the share that still reads as a frontier
    // rather than as one wanderer.
    //
    // `far` is also the divisor below, so this doubles as the guard
    // against a centroid of 0/0 on an empty frontier.
    if (far === 0 || far * OUTPOST_SHARE < n) return null;

    let x = sx / far, y = sy / far;

    // Never plant one on the doorstep — a shed inside the station's
    // own reach is a shed that saves nobody a journey.
    const d = dist(x, y, home.x, home.y);
    if (d < OUTPOST_MIN_HOME) {
        if (d < 1) return null;
        x = home.x + (x - home.x) / d * OUTPOST_MIN_HOME;
        y = home.y + (y - home.y) / d * OUTPOST_MIN_HOME;
    }

    // Nor inside the market's no-fire bubble.
    //
    // A forward store in there could never be defended and could never
    // be attacked, which is not a safe shed so much as a shed removed
    // from the game — and it would quietly make the sanctuary a
    // strategic asset to squat in rather than a neutral place to
    // trade. Pushed to the rim rather than rejected outright, because
    // the frontier that produced the site is still real.
    if (inSanctuary(world, x, y, OUTPOST_SPACING * 0.5)) {
        const s = nearestSanctuary(world, x, y);
        if (s) {
            const dx = x - s.x, dy = y - s.y;
            const d = Math.hypot(dx, dy) || 1;
            const push = s.r + OUTPOST_SPACING * 0.5;
            x = s.x + (dx / d) * push;
            y = s.y + (dy / d) * push;
        }
    }

    // Nor next to one we already have.
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.role !== 'outpost' || s.factionId !== faction.id) continue;
        if (dist(x, y, s.x, s.y) < OUTPOST_SPACING) return null;
    }
    return { x, y };
}

/** Distance to the nearest place this faction can already unload. */
function nearestDrop(world, faction, x, y) {
    let best = Infinity;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== faction.id) continue;
        if (s.role !== 'mothership' && s.role !== 'outpost') continue;
        const d = dist(x, y, s.x, s.y);
        if (d < best) best = d;
    }
    return best;
}

/** The bubble whose centre is nearest this point, or null. */
function nearestSanctuary(world, x, y) {
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < world.sanctuaries.length; i++) {
        const s = world.sanctuaries[i];
        const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
}
