// ============================================================
// COMBAT — FIRING, FLIGHT, DAMAGE
// ============================================================
//
// Rounds are real objects with real travel time. Nothing here is
// hitscan, which costs a little accuracy and buys the two things
// that make combat worth watching: a shot you can see crossing the
// gap, and the possibility of missing.
//
// ------------------------------------------------------------
// SWEPT COLLISION
// ------------------------------------------------------------
//
// A pulse round covers 620 u/s ÷ 60 steps ≈ 10.3 world units per
// step. A drone is 9 units across. Testing "is the round's current
// position inside a hull" would therefore miss a drone entirely
// about half the time, at random — rounds would visibly pass
// through ships.
//
// So each step we test the *segment* the round travelled, from its
// previous position to its new one, against each candidate hull
// circle. That is `segPointDist2` in core/math.js, and it is exact
// for the constant-velocity motion rounds actually have.
//
// ------------------------------------------------------------
// FIRE CONTROL
// ------------------------------------------------------------
//
// Bursts, not streams. A weapon fires `burst` rounds spaced
// `burstGapMs` apart, then goes quiet for `cooldownMs`. The
// silence is load-bearing — see the note in data/weapons.js.

import { makeProjectile, makeShip } from './entities.js';
import { EV } from '../core/events.js';
import { isHostile, inSanctuary } from './behaviors/common.js';
import { THREAT_WEIGHT } from '../core/constants.js';
import { WRECK_MIN, WRECK_LIFE, ALARM_MEMORY } from '../core/constants.js';
import { turnToward } from '../core/math.js';
import { segPointDist2 } from '../core/math.js';
import { weaponHeft } from '../data/weapons.js';
import { RECOIL_KICK } from '../core/constants.js';

/**
 * Fire if the weapon is ready. Callers are expected to have already
 * decided that shooting is a good idea and that the target is
 * inside the firing cone — this function owns cadence, not aim.
 *
 * @param {number} angle  the direction to fire, already led
 */
export function tryFire(world, ship, angle) {
    const w = ship.weapon;
    if (!w || (w.kind !== 'tracer' && w.kind !== 'seeker')) return false;

    // Between bursts.
    if (ship.burstLeft <= 0) {
        if (world.time < ship.readyAt) return false;
        ship.burstLeft = w.burst;
        ship.nextShotAt = world.time;
    }
    // Within a burst.
    if (world.time < ship.nextShotAt) return false;

    const spread = world.rng.spread(w.spread);
    const a = angle + spread + burstFan(w, ship.burstLeft);
    // Muzzle sits along the *firing* direction, not the hull's
    // facing. For a fighter the two are the same — it only fires
    // inside a narrow cone — but a station's turret ring covers
    // every bearing, and anchoring its shots to the hull angle
    // would have them leave from the wrong side of the building.
    const mx = ship.x + Math.cos(a) * w.muzzleOffset;
    const my = ship.y + Math.sin(a) * w.muzzleOffset;

    // Rounds inherit the shooter's velocity. Without this a fighter
    // firing across its own line of travel visibly lags its shots.
    world.addProjectile(makeProjectile(
        world, mx, my,
        Math.cos(a) * w.speed + ship.vx,
        Math.sin(a) * w.speed + ship.vy,
        w, ship.factionId, ship.id, w.kind === 'seeker' ? ship.targetId : 0,
    ));

    // The kick is the single detail that makes firing feel like it
    // costs the ship something — so it has to cost a destroyer more
    // than it costs a fighter. Scaled by the same number that drives
    // the muzzle bloom and the impact, so a heavy gun is heavy in
    // every direction at once rather than only in the flash.
    ship.recoil = RECOIL_KICK * weaponHeft(w);

    ship.burstLeft--;
    if (ship.burstLeft > 0) ship.nextShotAt = world.time + w.burstGapMs / 1000;
    else ship.readyAt = world.time + w.cooldownMs / 1000;

    // `id` is the shooter. Nothing draws with it — it is there so the
    // flight recorder can attribute a shot, and so accuracy is a
    // number per ship rather than a number per faction.
    world.events.emit(EV.SHOT_FIRED, {
        x: mx, y: my, angle: a, faction: ship.factionId, weapon: w, id: ship.id,
    });
    return true;
}

/**
 * Advance every round and resolve hits.
 *
 * Rounds are tested against the ship broadphase over the segment
 * they just travelled. The first hull found ends the round — no
 * penetration, no multi-hit.
 */
export function stepProjectiles(world, dt) {
    const list = world.projectiles;

    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.dead) continue;

        // Guidance, before the move.
        //
        // A seeker steers its *velocity* rather than teleporting its
        // heading, and it does so at a finite rate — which is the
        // whole character of the thing. A missile that turns instantly
        // is a hitscan weapon with extra steps; one that can be
        // out-turned is a threat you can answer by flying well, and it
        // is why a fighter rolling hard away from a salvo reads as an
        // escape rather than as luck.
        //
        // Nothing re-acquires. A missile is launched *at* something,
        // and if that something dies or shakes it off, the round flies
        // on and expires. Re-targeting mid-flight would make a salvo
        // an unavoidable death sentence for whatever happened to be
        // nearest at the end.
        if (p.weapon.kind === 'seeker' && armed(p)) {
            const target = world.ship(p.targetId);
            if (target) {
                const want = Math.atan2(target.y - p.y, target.x - p.x);
                const have = Math.atan2(p.vy, p.vx);
                const turn = turnToward(have, want, p.weapon.turnRate * dt);
                const speed = Math.hypot(p.vx, p.vy) || p.weapon.speed;
                p.vx = Math.cos(turn) * speed;
                p.vy = Math.sin(turn) * speed;
            }
        }

        p.prevX = p.x;
        p.prevY = p.y;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;

        // Query a circle covering the whole swept segment plus the
        // largest plausible hull radius, then do the exact test.
        const midX = (p.prevX + p.x) * 0.5;
        const midY = (p.prevY + p.y) * 0.5;
        const reach = Math.hypot(p.x - p.prevX, p.y - p.prevY) * 0.5 + 44;

        let hit = null;
        let bestT = Infinity;

        world.shipGrid.queryCircle(midX, midY, reach, (ship) => {
            // Ask `isHostile`, do not compare ids.
            //
            // This read `ship.factionId === p.factionId` — "skip my own
            // side" — which is the same thing as hostility only while
            // there are exactly two sides who always hate each other.
            // Under a truce it is not: rounds already in the air kept
            // hitting the faction that had just become an ally, and
            // twenty-one natives died at each other's hands during a
            // ceasefire that was otherwise working perfectly.
            if (ship.dead || ship.id === p.ownerId) return;
            if (!isHostile(world, p.factionId, ship.factionId)) return;
            // Nothing *aims* at debris, so nothing hits it either.
            //
            // THREAT_WEIGHT is zero for a wreck, which `pickTarget`
            // honours — but a round already in the air did not, so a
            // wreck that drifted into somebody else's firing line was
            // destroyed by a shot that was never meant for it, and the
            // ore in it was lost to a hit nobody took. Rare, and
            // exactly the kind of rare that reads as a bug: one wreck
            // in a twelve-minute run recorded a lifetime of zero
            // seconds and a cause of death.
            //
            // Zero here means "not a participant" rather than "not
            // worth much", and the exchange reads the same way.
            if ((THREAT_WEIGHT[ship.role] || 0) <= 0) return;
            // And nothing may be hit inside a sanctuary.
            //
            // `pickTarget` already refuses to *aim* at anything in
            // there, so this is for rounds that were already in the
            // air when the target crossed the line — the same class of
            // leak that let allied fire keep landing through the first
            // version of the truce. Without it the bubble protects you
            // from being shot at but not from being shot.
            // Measured against the *hull*, not its centre point.
            //
            // A round is reported as landing on the skin rather than
            // at the middle of the ship, so a hull straddling the
            // boundary could be hit legally — centre outside — while
            // the impact flashed inside the bubble. Two rounds in
            // 4,361 did exactly that once warships started ranging
            // widely enough to reach the market at all. The promise is
            // that nothing inside is shot, and a ship is inside the
            // moment any part of it is.
            if (inSanctuary(world, ship.x, ship.y, ship.radius)) return;
            const r = ship.radius;
            const d2 = segPointDist2(p.prevX, p.prevY, p.x, p.y, ship.x, ship.y);
            if (d2 > r * r) return;
            // Among overlapping candidates prefer the one nearest the
            // round's origin, so a shot stops at the first hull on its
            // path rather than at whichever the grid happened to yield.
            const t = (ship.x - p.prevX) ** 2 + (ship.y - p.prevY) ** 2;
            if (t < bestT) { bestT = t; hit = ship; }
        });

        if (hit) {
            const angle = Math.atan2(p.vy, p.vx);
            // Report the impact on the hull surface rather than at the
            // hull centre, so sparks come off the skin.
            const dx = p.x - hit.x, dy = p.y - hit.y;
            const d = Math.hypot(dx, dy) || 1;
            const ix = hit.x + (dx / d) * hit.radius;
            const iy = hit.y + (dy / d) * hit.radius;

            applyDamage(world, hit, p.damage, p.ownerId);
            // The weapon travels with the event so the effect can be
            // sized by what actually hit. Without it every impact
            // looked identical and a lance shell landed like a pulse
            // round — the single biggest reason heavy guns felt light.
            world.events.emit(EV.SHOT_HIT, {
                x: ix, y: iy, angle, faction: p.factionId, target: hit,
                ownerId: p.ownerId, weapon: p.weapon,
            });
            p.dead = true;
            continue;
        }

        if (p.life <= 0) {
            p.dead = true;
            world.events.emit(EV.SHOT_EXPIRED, { x: p.x, y: p.y, faction: p.factionId });
        }
    }
}

/**
 * Apply damage, and kill the ship if it runs out of hull.
 *
 * `killerId` is carried purely so a kill can be attributed. It has no
 * effect on the simulation, and it defaults to nobody — attrition,
 * a test, or anything else that kills a hull without shooting it.
 */
export function applyDamage(world, ship, amount, killerId = 0) {
    if (ship.dead) return;
    ship.hp -= amount;
    // Stamped for repair logic: anything that heals waits out a
    // quiet period first, so sustained fire suppresses it.
    ship.lastHitAt = world.time;
    // A cosmetic flash, scaled by how hard the blow was relative to
    // the hull taking it. A pulse round on a frigate barely registers;
    // the same round on a fighter is a quarter of its life. Sized that
    // way rather than absolutely, so every hull reads its own damage
    // in its own terms and a future capital ship does not strobe.
    ship.hitFlash = Math.min(1, ship.hitFlash + amount / Math.max(1, ship.maxHp) * 4);
    if (ship.hp <= 0) killShip(world, ship, killerId);
}

/**
 * Destroy a ship.
 *
 * Emits SHIP_DIED before flagging it dead, so handlers still see a
 * coherent entity — position, velocity and faction are all needed
 * to throw debris that carries the victim's momentum.
 */
export function killShip(world, ship, killerId = 0) {
    if (ship.dead) return;
    ship.hp = 0;
    world.events.emit(EV.SHIP_DIED, { ship, killerId });
    ship.dead = true;

    // A laden hull leaves its cargo behind.
    //
    // The ore moves from one hold to another rather than vanishing, so
    // the ledger needs no new term — `world.compact` only counts cargo
    // as *lost* on a hull it is actually removing, and this one has
    // handed its load over first. What was a silent write-off is now a
    // prize sitting in open space, and the side that made the kill has
    // a reason to still be there when somebody comes for it.
    if (ship.cargo > WRECK_MIN && ship.role !== 'wreck') {
        const wreck = makeShip(world, 'wreck', ship.factionId, ship.x, ship.y, ship.angle);
        wreck.cargo = ship.cargo;
        wreck.cargoMax = ship.cargo;
        wreck.vx = ship.vx * 0.25;
        wreck.vy = ship.vy * 0.25;
        wreck.fade = 1;
        wreck.spawnAt = world.time;
        world.addShip(wreck);
        // Announced like any other arrival. The lifecycle audit pairs
        // spawns with deaths to work out what a hull's life was worth,
        // and a wreck that dies without ever having been born gives it
        // a death with no birth to match — which reads as a zero
        // lifetime rather than as a missing event.
        world.events.emit(EV.SHIP_SPAWNED, { ship: wreck });
        ship.cargo = 0;
    }

    const faction = world.faction(ship.factionId);
    if (faction) {
        faction.lostTotal++;
        // Drives the emergency rule in data/production.js.
        faction.lastLossAt = world.time;

        // Raise the alarm where it happened.
        //
        // Weighted by what was lost and decayed by how long ago, so a
        // running battle pulls the alarm toward wherever the fighting
        // is heaviest rather than to wherever the last unlucky drone
        // died. A garrison answers *this* point — see `patrol`.
        if (!ship.def.immobile && ship.role !== 'wreck') {
            const w = Math.max(1, ship.def.cost);
            const stale = world.time - faction.alarmAt > ALARM_MEMORY;
            const prior = stale ? 0 : faction.alarmWeight;
            const total = prior + w;
            faction.alarmX = (faction.alarmX * prior + ship.x * w) / total;
            faction.alarmY = (faction.alarmY * prior + ship.y * w) / total;
            faction.alarmWeight = Math.min(total, 400);
            faction.alarmAt = world.time;
        }
        if (ship.role === 'mothership') {
            const i = faction.motherships.indexOf(ship.id);
            if (i >= 0) faction.motherships.splice(i, 1);
        }
    }
}

/**
 * Where in the fan this round of a burst goes.
 *
 * Alternates outward from the aim point — 0, +1, -1, +2, -2 — rather
 * than sweeping across, so a salvo opens symmetrically about the
 * bearing it was aimed on instead of walking off to one side. Scaled
 * so the outermost pair sits at exactly `w.fan`.
 *
 * Takes `burstLeft` *before* it is decremented, which is what makes
 * the first round of a burst the centre one.
 */
export function burstFan(w, burstLeft) {
    const n = w.burst || 1;
    if (!w.fan || n < 2) return 0;

    const i = n - burstLeft;                 // 0-based index into the burst
    const rank = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const half = Math.max(1, Math.ceil((n - 1) / 2));
    return (rank / half) * w.fan;
}

/**
 * Has this round's guidance woken up yet?
 *
 * A seeker flies its launch bearing for `armTime` before it starts
 * steering, which is what lets a salvo diverge visibly before it
 * closes. Rounds with no `armTime` are guided from the muzzle, as
 * they always were.
 */
export function armed(p) {
    const w = p.weapon;
    if (!w.armTime) return true;
    return (w.range / w.speed) - p.life >= w.armTime;
}
