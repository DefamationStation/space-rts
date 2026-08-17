// ============================================================
// WEAPONS — REGISTRY
// ============================================================
//
// One entry per weapon. `kind` selects both the firing logic in
// `sim/combat.js` and the effect renderer in `render/weaponfx.js`,
// so adding a weapon of an existing kind is a single row here.
//
// ------------------------------------------------------------
// ON CADENCE
// ------------------------------------------------------------
//
// The timings below are the single biggest reason this reads calm
// rather than frantic, so they are worth defending.
//
// A weapon fires `burst` rounds `burstGapMs` apart, then waits
// `cooldownMs`. Two rounds every 900 ms is a slow weapon by any
// game's standards — and that is the point. Continuous fire turns
// combat into texture: a wash of moving pixels the eye stops
// resolving. Punctuated fire keeps every shot legible, gives the
// silence between bursts something to do, and makes a hit feel
// like an event.
//
// If combat ever feels empty, add more ships. Do not shorten the
// cooldown.

import { DRONE_MINE_RATE } from '../core/constants.js';

/** Milliseconds are the authoring unit; the sim converts once at fire time. */
export const WEAPON_TYPES = {

    // --------------------------------------------------------
    // PULSE CANNON — the fighter's gun
    // --------------------------------------------------------
    pulse: {
        id: 'pulse',
        kind: 'tracer',

        damage: 7,              // hp per round
        speed: 620,             // u/s — fast enough to need swept collision
        range: 660,             // world units before the round expires
        spread: 0.014,          // rad — just enough that a stream is not a laser-straight line

        burst: 2,               // rounds per burst
        burstGapMs: 110,        // between rounds within a burst
        cooldownMs: 900,        // after a burst completes

        muzzleOffset: 9,        // world units forward of hull centre
        tracerLength: 18,       // world units — the visible capsule, not the hitbox
    },

    // --------------------------------------------------------
    // DEFENCE BATTERY — the mothership's turret ring
    // --------------------------------------------------------
    //
    // Longer reach and a heavier punch than a fighter's gun, and a
    // slower rhythm to match the mass of the thing firing it.
    //
    // This is a *balance* mechanism as much as a weapon. Before the
    // stations could shoot back, whichever faction won the first
    // exchange parked its whole fleet on the loser's doorstep and
    // shot every replacement hull as it launched — permanently.
    // There was no safe ground anywhere on the map, so a beaten
    // faction could never rebuild an economy and no run ever
    // recovered.
    //
    // A defended core fixes that at the root: every faction always
    // has somewhere it is strong. Besieging a station now costs
    // hulls, attackers break off to repair, and the beaten side
    // gets the room it needs to put miners back out.
    battery: {
        id: 'battery',
        kind: 'tracer',

        damage: 9,
        speed: 560,
        range: 860,
        spread: 0.02,

        burst: 2,
        burstGapMs: 150,
        cooldownMs: 1150,

        muzzleOffset: 34,       // out at the ring, not the core
        tracerLength: 21,
    },

    // --------------------------------------------------------
    // LANCE — the corvette's gun
    // --------------------------------------------------------
    //
    // A heavy shell: nearly twice a pulse round's damage, at under
    // half its velocity, on a rhythm slow enough to count between
    // shots.
    //
    // The *slowness* is the design, not a drawback of being heavy. A
    // pulse round crosses an engagement in a blink and is effectively
    // undodgeable, so `evade` in sim/steering.js has almost nothing to
    // work with; a lance shell spends the better part of a second in
    // the air, which is long enough for a fighter's flank jets to move
    // it clear. That makes the corvette genuinely different to fly
    // against rather than merely bigger — you can see the shot coming,
    // and so can the AI.
    //
    // It also gives the two classes distinct silhouettes in *time*.
    // Fighters chatter; a corvette punctuates.
    lance: {
        id: 'lance',
        kind: 'tracer',

        // 13 rather than the 22 this started at, and the reason is a
        // guard rather than a feel judgement.
        //
        // Damage arrives in whole rounds, so a hull lands on
        // `hp - k x damage` and jumps over anything between two rungs.
        // At 22 a fighter went 40 -> 18 (still fighting) -> dead: its
        // RETREAT_HP band at 14 hp was unreachable, so REGROUP simply
        // stopped existing against corvettes. Nothing would have
        // crashed and no fighter would have looked wrong; a mechanism
        // would just have quietly switched off.
        // `tests/guards.test.js` checks every hull against every
        // weapon for exactly this, which is why it is 13 and why a
        // future heavy gun cannot reintroduce the problem unnoticed.
        //
        // The weight is carried by cadence and reach instead: two
        // shells a second and a half apart, at a range no fighter can
        // answer from.
        damage: 13,             // hp per round
        // Anti-armour. Declared, because a weapon this heavy is meant
        // to delete a fighter outright and the retreat guard must not
        // treat that as a bug — see tests/guards.test.js. A light hull
        // does not get to break off from a lance; it gets hit twice.
        heavy: true,
        speed: 250,             // u/s — slow enough to be dodged, and to be seen
        range: 920,             // the longest reach in the fleet
        spread: 0.008,          // tighter than a pulse: it is an aimed weapon

        burst: 3,
        burstGapMs: 150,
        cooldownMs: 1000,

        muzzleOffset: 16,
        tracerLength: 30,       // a longer, heavier streak than a pulse round
        // A capital bolt: half again as thick as a fighter's round, so
        // a lance reads as ordnance rather than as a long tracer.
        tracerGirth: 1.55,
    },

    // --------------------------------------------------------
    // FLAK — the frigate's battery
    // --------------------------------------------------------
    //
    // Small shells, fired fast, travelling fast, and not very far.
    // The exact opposite of the lance on every axis, and that is the
    // point: it is the answer to fighters.
    //
    // ------------------------------------------------------------
    // WHY THIS COUNTERS A FIGHTER WITHOUT A DAMAGE-TYPE TABLE
    // ------------------------------------------------------------
    //
    // Every gun in the game leads its target with the first-order
    // intercept solve in core/math.js, which assumes the target keeps
    // its current velocity. A fighter does not — it is the most agile
    // thing in the fleet — so the solve is only as good as it is
    // *fresh*, and freshness is flight time. A lance shell takes the
    // better part of two seconds to cross its own range, by which
    // point a fighter has been somewhere else for a while.
    //
    // Flak rounds arrive in a third of a second. There is no time for
    // the fighter to invalidate the solution and no time for `evade`
    // in sim/steering.js to move a hull meaningfully out of the way.
    // So the counter is not a rule anybody wrote down; it falls out of
    // projectile speed against target agility, and it can be measured
    // as a hit rate rather than asserted.
    //
    // The price is reach. At 260 it is the shortest-ranged weapon in
    // the game — a corvette can stand off at 420 and shell a frigate
    // that cannot answer, which closes the triangle.
    flak: {
        id: 'flak',
        kind: 'tracer',

        damage: 9,
        speed: 700,             // the fastest round in the game: no time to dodge
        // 370: longer than a pulse cannon's 330, shorter than a
        // lance's 420. The ordering *is* the counter-triangle, and
        // getting it wrong the first time inverted the whole design —
        // at 260 a fighter simply stood off at 330 and shot a frigate
        // that could not reply, so the hull built to kill fighters lost
        // to them 71/29 in equal-metal duels.
        //
        // The gaps matter as much as the order. At 370 the frigate led
        // a fighter by only 40 units and the matchup came out even; the
        // ladder needs room between its rungs before a range advantage
        // is an advantage at all.
        range: 800,
        spread: 0.03,           // a spraying weapon, not an aimed one

        burst: 5,
        burstGapMs: 80,
        cooldownMs: 520,
        // ~54 dps. A heavy hull needs *better* power per metal than a
        // cheap one, not equal power — a dozen fighters concentrating
        // fire lose their damage output gradually while two frigates
        // lose half of theirs the moment one dies. Parity on paper is
        // a loss in practice.

        muzzleOffset: 20,
        tracerLength: 12,       // short, quick streaks — visually the anti-lance
    },

    // --------------------------------------------------------
    // SWARM LAUNCHER — the station's missile battery
    // --------------------------------------------------------
    //
    // A salvo of eight guided rounds, thrown a long way, that chase
    // whatever they were launched at and burn out if they cannot
    // catch it.
    //
    // ------------------------------------------------------------
    // WHY THEY EXPIRE, AND WHY THAT IS THE FEATURE
    // ------------------------------------------------------------
    //
    // `range / speed` gives every round its lifetime, and at 900 over
    // 330 a missile lives about 2.7 seconds. That is long enough to
    // cross most of an engagement and much too short to pursue
    // anything that genuinely evades — so a salvo launched at a
    // fighter is a *question*, and flying well is the answer. A
    // missile that never expired would be an execution order with a
    // delay on it.
    //
    // `turnRate` is the other half. At 2.2 rad/s a missile out-turns a
    // corvette comfortably and cannot quite hold a fighter at full
    // burn, which is exactly the discrimination worth having: the
    // heavy things it is meant to kill cannot dodge, and the light
    // things it is not meant to kill can.
    //
    // Eight rounds fired 70 ms apart, so a launch reads as a ripple
    // leaving the rail rather than a single event with a big number.
    missile: {
        id: 'missile',
        kind: 'seeker',

        // 9 rather than 11, and the guard picked the number.
        //
        // At 11 a fighter's damage rungs ran 40, 29, 18, 7 — the first
        // value at or below its 14 hp retreat threshold was 7, which
        // one more missile deletes. The band was unreachable and
        // REGROUP would have quietly stopped existing under missile
        // fire. At 9 the rungs land on 13, which survives.
        damage: 9,
        speed: 330,
        range: 1800,             // the longest reach on the map
        // Fired with a little dispersion so a salvo leaves the rail
        // as a spread and closes into a stream — but only a little.
        // At 0.22 each round left up to 12.6 degrees off its solution
        // and spent most of its short life turning back rather than
        // closing: a salvo of eight at eight fighters scored nothing
        // at all in sixty seconds.
        spread: 0.07,

        // The salvo blooms before it converges.
        //
        // Eight rounds leaving one tube 70 ms apart on one bearing is a
        // *stream*, and that is exactly what it looked like: machine-gun
        // fire that happened to curve at the end. `spread` cannot fix it
        // — it is random jitter, so a wider value makes a messier stream
        // rather than a formation.
        //
        // `fan` is deterministic and alternates outward across the
        // burst — 0, +1, -1, +2, -2 — so the salvo opens symmetrically
        // like a hand of cards. `armTime` then holds guidance off for
        // the first half second, so the rounds *commit* to those
        // diverging bearings before turning in. Bloom, then converge:
        // the shape reads as one weapon firing eight missiles instead
        // of eight bullets that happen to steer.
        fan: 0.62,              // rad — bearing of the outermost round
        armTime: 0.55,          // s of unguided boost before guidance bites
        // 3.0 rather than 2.2. At 330 u/s a missile's turn radius is
        // speed over turn rate — 150 units at 2.2, 110 at 3.0 — and
        // the difference is whether it can still correct after a
        // target jinks late. It out-turns everything heavy and still
        // cannot hold a fighter that commits early, which is the
        // discrimination worth having.
        turnRate: 3.0,          // rad/s of guidance authority

        burst: 8,
        burstGapMs: 70,
        cooldownMs: 5200,       // a long silence between salvos

        muzzleOffset: 30,
        tracerLength: 14,
        // A missile is small, but it is under power and it manoeuvres,
        // so it gets a drive flare too. Eight of them leaving a
        // station in a salvo is the single most legible thing a
        // capital weapon does, and the flare is what makes the swarm
        // of them read as *powered* rather than as a spray of tracer.
        tracerGirth: 1.2,
        drive: true,
    },

    // --------------------------------------------------------
    // TORPEDO — the station's heavy tube
    // --------------------------------------------------------
    //
    // Enormous, slow, and completely unguided. It goes where it was
    // pointed and nowhere else.
    //
    // The whole appeal is that it can be *dodged by anything paying
    // attention* — at 140 u/s it takes nearly six seconds to cross its
    // own range, which is an eternity, and the velocity-inverse wake
    // in render/weaponfx.js gives it the longest trail in the game so
    // you can see it coming from across the map. Against a fighter it
    // is almost a joke. Against a frigate committed to a turn, or a
    // station that cannot move at all, it is the heaviest single blow
    // anything in the simulation can land.
    //
    // One tube, one shell, eight seconds. It should feel like an event.
    torpedo: {
        id: 'torpedo',
        kind: 'tracer',

        damage: 34,
        heavy: true,            // anti-capital; see the lance
        // Fast, and short.
        //
        // It was 140 u/s over 1,640 units — **11.7 seconds** of
        // unguided flight, during which a fighter covers fifteen
        // hundred units. It was not badly tuned, it was attempting
        // something arithmetically impossible, and it showed: 25 hits
        // from 385 shots, 6.5%, the worst weapon in the game by a
        // factor of three.
        //
        // At 430 over 760 the flight is 1.8 s. Deliberately just inside
        // the station battery's 860 reach, so the tube is the close-in
        // weapon and the ring guns are what greet you on approach.
        speed: 430,
        range: 820,
        spread: 0.004,          // aimed with great care and no ability to correct

        // And it only shoots at things a slow unguided round can
        // actually reach.
        //
        // The other half of the same finding. A torpedo is an
        // anti-capital weapon; pointing one at a fighter is a category
        // error the tube used to make constantly, because target
        // selection had no way to express "too nimble for this". Hull
        // radius is the honest proxy — it happens to select exactly the
        // slow, heavy classes: freighter, harvester, frigate,
        // destroyer, and every structure. Fighters, swarmers,
        // corvettes, miners, haulers and drones are somebody else's
        // problem.
        minTargetRadius: 18,    // world units — capitals and buildings only

        burst: 1,
        burstGapMs: 0,
        cooldownMs: 8000,

        muzzleOffset: 34,
        tracerLength: 46,       // a long, heavy slug
        // The fattest thing in the sky, and the only round carrying its
        // own engine. At 140 u/s over 820 units a torpedo is in flight
        // for the better part of six seconds — long enough that it is
        // not really a tracer at all, it is a vehicle, and it is drawn
        // like one.
        tracerGirth: 2.4,
        drive: true,
        // The only round in the game that leaves something behind.
        //
        // Everything else draws a tail that travels *with* it, which is
        // a highlight rather than a trail — so a torpedo looked like a
        // fat slow pulse round and nothing more. This drops a puff into
        // the world every `wake` seconds, and those puffs stay where
        // they were made and fade. The result is a visible line of
        // travel hanging in space after the round has gone past, which
        // is the single thing that makes it read as ordnance under
        // power rather than as a bullet.
        wake: 0.055,            // s between wake puffs
        segments: 3,            // body drawn as this many stacked stamps
    },

    // --------------------------------------------------------
    // POPGUN — the outpost's defence
    // --------------------------------------------------------
    //
    // A light machine gun on a storage shed. It is not meant to hold
    // anything off — it is meant to make an outpost cost *something*
    // to kill, so a lone fighter cannot casually strip a faction's
    // whole forward logistics on its way past.
    //
    // Deliberately the weakest weapon in the game. An outpost that
    // could defend itself would be a second mothership, and then the
    // frontier would stop being dangerous.
    popgun: {
        id: 'popgun',
        kind: 'tracer',

        damage: 4,
        speed: 540,
        range: 600,
        spread: 0.05,

        burst: 3,
        burstGapMs: 90,
        cooldownMs: 1000,

        muzzleOffset: 20,
        tracerLength: 14,
    },

    // --------------------------------------------------------
    // SPINE — the swarm's weapon
    // --------------------------------------------------------
    //
    // Slow, and that is the tell. Everything the natives field either
    // spits fast light rounds or lobs one heavy shell; the swarm
    // throws a slow, dim, rapid stream that arrives like sleet. It is
    // the most dodgeable weapon in the game and there is a great deal
    // of it, which is a different kind of dangerous and reads as one.
    spine: {
        id: 'spine',
        kind: 'tracer',

        damage: 6,
        // Faster, and the reason is screen time rather than ballistics.
        //
        // At 190 u/s over 680 units every round lived **3.6 seconds** —
        // more than three times a pulse round — so spine tracers
        // accumulated on screen instead of passing across it. Multiply
        // that by the swarm's numbers and an incursion peaked at 517
        // rounds in the air at once, 359 of them spine. It was 35% of
        // every shot fired in the game at 14.7% accuracy: a weapon
        // that dominated the frame and achieved almost nothing.
        //
        // At 380 the round lives 1.8 s. Same reach, same damage, half
        // the clutter — and the lead solve that was hopeless over four
        // seconds of flight becomes usable, so the spray also starts
        // connecting.
        speed: 380,
        range: 680,
        // 0.018 rather than 0.035. Three rounds a burst from four
        // independently-aimed mounts is already a spread; adding
        // scatter on top of it was what turned the swarm into a hull
        // firing everywhere at once rather than a lot of hulls firing.
        spread: 0.018,

        burst: 3,
        burstGapMs: 110,
        // A longer pause between bursts. The volume is meant to come
        // from how many of them there are — that is the swarm's whole
        // character — not from each hull firing without pause.
        cooldownMs: 1250,

        muzzleOffset: 10,
        tracerLength: 22,
    },

    // --------------------------------------------------------
    // MINING LASER — the drone's tool
    // --------------------------------------------------------
    //
    // Not a weapon: it cannot target ships and does no damage. It
    // shares the registry because it shares the FX pipeline, and
    // because a future cutting-beam warship should be able to reuse
    // `kind: 'beam'` without inventing a second system.
    mining: {
        id: 'mining',
        kind: 'beam',

        damage: 0,
        // Deliberately NOT doubled with the guns.
        //
        // This is the one row in the table whose `range` is not a
        // reach — it is how far a drone parks off a rock face while
        // cutting, and `behaviors/drone.js` uses it for the approach
        // point, the hold point and the "still in contact" test.
        // Doubling it moved drones back to 148 units from the rock,
        // which is most of the way to MINING_RADIUS, and the economy
        // test caught it immediately: miners stopped completing their
        // cycle. A mining laser is a tool with a working distance, and
        // that distance is set by the job rather than by how far the
        // fleet's guns happen to shoot.
        range: 74,              // world units — how close a drone must hold station

        // Extraction rate is an economy figure, so it is tuned in
        // constants.js alongside cargo sizes and deposit rates rather
        // than duplicated here. A future second mining tool would
        // override this with its own literal.
        rate: DRONE_MINE_RATE,  // ore/s

        // The beam breathes in alpha only. Wobbling its *position*
        // is the obvious way to make a beam look alive and it always
        // reads as cheap — real light does not wander.
        shimmerHz: 0.55,        // cycles/s
        shimmerDepth: 0.22,     // fraction of alpha the shimmer swings
        muzzleOffset: 3,
    },
};

/**
 * How heavy a weapon reads, as a multiplier on everything cosmetic
 * it causes: muzzle bloom, muzzle lifetime, impact ring, spark count
 * and the hull's own kick.
 *
 * One number derived from damage, so every visual consequence of a
 * gun scales together and a weapon added tomorrow needs no effect
 * authoring at all. A pulse round (7) sits at 1.0; a lance shell (13)
 * at ~1.4; a torpedo saturates the cap. Rooted at the pulse cannon
 * because that is the round the whole visual language was tuned
 * against.
 *
 * It lives here rather than in sim/effects.js because it is a
 * property *of a weapon*, and two callers need it: the effects layer
 * and `tryFire`, which uses it for recoil. Recoil was a flat 2.2
 * regardless of what was being fired, so a destroyer's broadside
 * shoved its hull exactly as far as a fighter's pulse cannon — the
 * one detail that makes firing feel like it costs the ship
 * something, saying the same thing about every gun in the game.
 */
export function weaponHeft(weapon) {
    const damage = weapon && weapon.damage ? weapon.damage : 7;
    return Math.min(2.2, 0.55 + damage / 15.5);
}
