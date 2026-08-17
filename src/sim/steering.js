// ============================================================
// STEERING
// ============================================================
//
// Behaviours never write velocity or position directly. They add
// accelerations into `ship.ax/ay` and `applyMotion` integrates
// once, at the end of the step. That ordering matters: it means
// several urges can be in play at once — go there, but keep clear
// of that, and stay off the wall — and combine into one smooth
// result instead of fighting each other frame to frame.
//
// It is also what produces the project's motion signature. Nothing
// here can make a ship change direction instantly: thrust is
// finite, turn rate is finite, and — the part that matters most —
// a hull can only push hard in the one direction its engine faces.
// Gospel rule 5 falls out of the physics rather than being applied
// on top of it.
//
// An urge is a *request*, not a command. Every request is resolved
// against the ship's thrust envelope in `applyMotion` before any of
// it reaches the velocity, so an urge asking for something the hull
// cannot do gets as much of it as the engines can supply and no
// more. Behaviours are therefore free to ask for the ideal vector
// and stay readable; the physics does the arguing.
//
// All functions are allocation-free.

import {
    clamp, clamp01, damp, turnToward, TAU,
} from '../core/math.js';
import {
    WORLD_EDGE_MARGIN, WORLD_EDGE_PUSH,
    SEPARATION_RADIUS, SEPARATION_FORCE, EVADE_HORIZON, EVADE_MARGIN,
    BANK_MAX, BANK_RATE, THRUSTER_SMOOTH, RECOIL_DECAY,
    THRUST_PROFILE, SPACE_DRAG, FACE_LOOKAHEAD, COAST_SPEED, RCS_SMOOTH,
    ORBIT_STIFFNESS, ORBIT_DAMPING, ORBIT_TAN_GAIN, ORBIT_SPEED, ARRIVE_GAIN,
} from '../core/constants.js';

// ------------------------------------------------------------
// URGES
// ------------------------------------------------------------

/** Accelerate flat-out toward a point. */
/**
 * Push sideways out of the path of incoming fire.
 *
 * ------------------------------------------------------------
 * WHY IT IS A STEERING PRIMITIVE AND NOT A FIGHTER TRICK
 * ------------------------------------------------------------
 *
 * Because it is a fact about *rounds*, not about fighters, and the
 * weapons table is going to grow. A pulse round crosses a fighter's
 * hull in a twentieth of a second and is effectively undodgeable —
 * this will barely register against it, which is correct. A torpedo
 * or a heavy cannon shell at a third of that speed is a different
 * proposition entirely, and every hull that calls this gets the
 * benefit of dodging it without a line of new code. Writing it into
 * `fighter.js` would mean writing it again for the corvette.
 *
 * ------------------------------------------------------------
 * HOW IT PICKS WHAT TO DODGE
 * ------------------------------------------------------------
 *
 * A round is worth avoiding only if it is going to *arrive*: closing,
 * soon, and on a line that passes near this hull. All three matter —
 * scoring on proximity alone makes a ship flinch at rounds already
 * sailing past it, which reads as a twitch rather than as evasion.
 *
 * The dodge is perpendicular to the round's travel, away from
 * whichever side the hull already sits on, so it widens a miss rather
 * than crossing the line of fire to do it. And it is deliberately a
 * *nudge*: a fighter's flank jets are 16% of its main drive, so
 * evasion costs it almost nothing in speed and buys a few world units
 * of displacement. That is the honest amount for a hull with its
 * engines bolted to the back, and it is why this reads as jinking
 * rather than as sidestepping.
 */
export function evade(ship, world, horizon = EVADE_HORIZON, scale = 1) {
    const rounds = world.projectiles;
    let worstScore = Infinity;
    let bestPx = 0, bestPy = 0;

    for (let i = 0; i < rounds.length; i++) {
        const p = rounds[i];
        if (p.dead || p.factionId === ship.factionId) continue;

        const rx = ship.x - p.x, ry = ship.y - p.y;
        const speed2 = p.vx * p.vx + p.vy * p.vy;
        if (speed2 < 1e-6) continue;

        // Time until the round is at its closest to us. Negative means
        // it is already past, and there is nothing to dodge.
        const t = (rx * p.vx + ry * p.vy) / speed2;
        if (t <= 0 || t > horizon) continue;

        // How near it will pass. `missX/Y` is the offset from the
        // round's closest point to us — the direction to widen.
        const missX = rx - p.vx * t;
        const missY = ry - p.vy * t;
        const miss = Math.hypot(missX, missY);
        if (miss > ship.radius + EVADE_MARGIN) continue;

        // Soonest wins. A round arriving in a tenth of a second is the
        // one to answer; a later one may never be fired at us at all.
        if (t < worstScore) {
            worstScore = t;
            // Away from the line of fire, on the side we are already
            // on. A zero-length miss means dead-on, so break the tie
            // perpendicular to the round rather than dividing by zero.
            if (miss > 1e-4) {
                bestPx = missX / miss;
                bestPy = missY / miss;
            } else {
                const inv = 1 / Math.sqrt(speed2);
                bestPx = -p.vy * inv;
                bestPy = p.vx * inv;
            }
        }
    }

    if (worstScore === Infinity) return false;

    const a = ship.def.accel * scale;
    ship.ax += bestPx * a;
    ship.ay += bestPy * a;
    return true;
}

export function seek(ship, tx, ty, scale = 1) {
    const dx = tx - ship.x, dy = ty - ship.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) return;
    const a = ship.def.accel * scale;
    ship.ax += (dx / d) * a;
    ship.ay += (dy / d) * a;
}

/**
 * Seek, but shed speed on approach so the ship settles onto the
 * point instead of overshooting and circling back. Everything that
 * needs to *stop* somewhere uses this rather than `seek`.
 */
export function arrive(ship, tx, ty, slowRadius = 90, scale = 1, vx = 0, vy = 0) {
    const dx = tx - ship.x, dy = ty - ship.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) return;

    const desiredSpeed = ship.def.speed * (d < slowRadius ? d / slowRadius : 1);
    // Steer toward the velocity we want, accounting for target motion when relative.
    const dvx = (dx / d) * desiredSpeed + vx - ship.vx;
    const dvy = (dy / d) * desiredSpeed + vy - ship.vy;
    const dv = Math.hypot(dvx, dvy);
    if (dv < 1e-4) return;

    // Proportional, not bang-bang.
    //
    // Normalising every request to full thrust means the demand flips
    // sign the instant the ship crosses its desired speed, so a hull
    // on approach alternates full-ahead and full-astern from step to
    // step. It still arrives — the chatter is far faster than the
    // turn rate, so it averages out into a clean deceleration — but
    // it makes the *engines* incoherent: a braking miner was showing
    // a main plume at 0.46 and a retro pack at 0.50 in the same
    // frame, which reads as a ship accelerating and braking at once.
    //
    // Scaling the request by the size of the velocity error instead
    // means the demand goes quiet as it is satisfied, so one engine
    // is lit at a time and a deceleration looks like a deceleration.
    const a = ship.def.accel * scale;
    const mag = Math.min(a, dv * ARRIVE_GAIN);
    ship.ax += (dvx / dv) * mag;
    ship.ay += (dvy / dv) * mag;
}

/**
 * Hold a circular station around a point at `radius`.
 * `dir` is +1 or -1 for orbit direction. `cvx/cvy` are the centre's
 * own velocity, so an escort can circle a moving charge. Used by
 * fighters holding their standoff and by patrols circling home.
 *
 * ------------------------------------------------------------
 * WHY THIS SOLVES THE CIRCLE INSTEAD OF POINTING AT IT
 * ------------------------------------------------------------
 *
 * The obvious version — steer along the tangent, lean inward in
 * proportion to how far off the ring you are — describes a circle
 * only for a ship that can push equally hard in every direction.
 * Give that request to a hull whose power is all out the back and
 * it comes apart: a fighter holding its nose on a target has the
 * ring's tangent across its flanks, so the whole tangential term
 * lands on the jets and pins them, while the inward lean that is
 * supposed to hold the radius arrives as whatever is left. Measured
 * over four runs, fighters flew engagements on 26% main drive and
 * saturated jets, sagging to 220 units from a target they were told
 * to hold at 273 and propping themselves off it with retro. A
 * hovering gun platform, not a fighter.
 *
 * So ask for the manoeuvre in the terms the manoeuvre is actually
 * made of. A circle needs exactly three things, and each one falls
 * on the engine that can supply it:
 *
 *   centripetal   v²/r inward — the force that makes it a circle
 *                 at all. Points at the centre, which is where the
 *                 nose already is, so the MAIN DRIVE pays for it.
 *   radius trim   a spring-damper closing the gap to the ring,
 *                 also radial, also on the main drive and retro.
 *   speed hold    keep the orbital speed against drag. Tangential,
 *                 so the JETS pay for it — and now they are only
 *                 topping up a speed the ship already has instead
 *                 of trying to generate the whole orbit.
 *
 * The controller therefore asks the strong engine for the big
 * force and the weak one for the small force, which is what makes
 * the same ring flyable. It also means the plume points at the
 * enemy while a fighter holds its standoff, because burning toward
 * the thing you are circling is genuinely how you circle it.
 */
export function orbit(ship, cx, cy, radius, dir, scale = 1, cvx = 0, cvy = 0) {
    const dx = ship.x - cx, dy = ship.y - cy;
    const d = Math.hypot(dx, dy) || 1e-4;

    const rx = dx / d, ry = dy / d;            // unit radial, outward
    const tx = -ry * dir, ty = rx * dir;       // unit tangent, way round

    // Velocity relative to the centre — an escort circling a miner
    // under way is holding a ring that is itself moving.
    const vx = ship.vx - cvx, vy = ship.vy - cvy;
    const vRad = vx * rx + vy * ry;            // + = climbing away
    const vTan = vx * tx + vy * ty;            // + = going round the right way

    // Radial: the centripetal term, the spring pulling onto the
    // ring, and damping so the approach settles rather than rings.
    const aRad = -(vTan * vTan) / radius
        - (d - radius) * ORBIT_STIFFNESS
        - vRad * ORBIT_DAMPING;

    // Tangential: hold the cruise fraction we want to circle at.
    const aTan = (ship.def.speed * ORBIT_SPEED - vTan) * ORBIT_TAN_GAIN;

    // Clamp the whole request to the authority the caller allowed,
    // so `scale` still means "orbit gently" as it always did.
    let ax = rx * aRad + tx * aTan;
    let ay = ry * aRad + ty * aTan;
    const mag = Math.hypot(ax, ay);
    const a = ship.def.accel * scale;
    if (mag > a) { ax = ax / mag * a; ay = ay / mag * a; }

    ship.ax += ax;
    ship.ay += ay;
}

/**
 * Personal space. Without this, ships heading for the same place
 * converge into a single stacked blob and the scene stops reading
 * as a fleet. Uses the broadphase, so it stays cheap.
 *
 * Force falls off linearly with distance, and scales with the
 * *sum* of radii so a mothership pushes harder than a drone.
 *
 * ------------------------------------------------------------
 * THE DOCKING EXEMPTION
 * ------------------------------------------------------------
 *
 * A ship never pushes away from the partner it is actively
 * transferring cargo with, its own parent miner, or sister drones
 * sharing the same parent. Without that exemption, separation and
 * docking are directly opposed goals and separation always wins:
 * a drone needs to close to unload, and gets shoved back out by
 * the miner or another drone, hovering just out of reach forever.
 */
export function separate(ship, world, scale = 1) {
    let px = 0, py = 0;
    const reach = SEPARATION_RADIUS + ship.radius;

    world.shipGrid.queryCircle(ship.x, ship.y, reach, (other) => {
        if (other === ship || other.dead) return;
        if (ship.transferId && other.id === ship.transferId) return;
        if (other.transferId && ship.id === other.transferId) return;
        if (ship.parentId && other.id === ship.parentId) return;
        if (other.parentId && ship.id === other.parentId) return;
        if (ship.parentId && other.parentId && ship.parentId === other.parentId) return;

        const dx = ship.x - other.x, dy = ship.y - other.y;
        const d2 = dx * dx + dy * dy;
        const want = SEPARATION_RADIUS + other.radius * 0.5 + ship.radius * 0.5;
        if (d2 >= want * want || d2 < 1e-6) return;
        const d = Math.sqrt(d2);
        const push = (1 - d / want) / d;
        px += dx * push;
        py += dy * push;
    });

    if (px === 0 && py === 0) return;
    ship.ax += px * SEPARATION_FORCE * scale;
    ship.ay += py * SEPARATION_FORCE * scale;
}

/**
 * A soft wall. Ships are turned back inside the play area by a
 * force that ramps up through the margin band rather than by a
 * hard clamp — bouncing off an invisible box looks like a bug even
 * when it is intentional.
 */
export function avoidEdges(ship, world) {
    const m = WORLD_EDGE_MARGIN;
    if (ship.x < m) ship.ax += WORLD_EDGE_PUSH * (1 - ship.x / m);
    else if (ship.x > world.width - m) ship.ax -= WORLD_EDGE_PUSH * (1 - (world.width - ship.x) / m);
    if (ship.y < m) ship.ay += WORLD_EDGE_PUSH * (1 - ship.y / m);
    else if (ship.y > world.height - m) ship.ay -= WORLD_EDGE_PUSH * (1 - (world.height - ship.y) / m);
}

/**
 * Lazy directional drift, used by miners holding station and by
 * idle patrols. The heading is stored on the ship and nudged, so
 * the wander is a slow curve rather than per-frame jitter.
 */
export function wander(ship, world, dt, strength = 0.35) {
    ship.wanderAngle = (ship.wanderAngle ?? world.rng.angle()) + world.rng.spread(1.6) * dt;
    ship.ax += Math.cos(ship.wanderAngle) * ship.def.accel * strength;
    ship.ay += Math.sin(ship.wanderAngle) * ship.def.accel * strength;
}

// ------------------------------------------------------------
// INTEGRATION
// ------------------------------------------------------------
//
// THE FLIGHT MODEL, IN ONE PLACE
// ------------------------------------------------------------
//
// A ship's main drive is bolted to the back of its hull. It can
// therefore push hard in exactly one direction — the way its nose
// is pointing — and only feebly in any other, through a retro pack
// at the front and manoeuvring jets on the flanks:
//
//                    main 1.00
//                 ◀━━━━━━━━━━━┓
//     retro 0.22            ▲ ┃ ▲   lateral 0.16
//                 ◀━━━━━━━━━━━┛
//
// This replaced an isotropic model where `accel` applied equally in
// every direction, and the difference is the single most visible
// thing about how the sim moves. Under the old model a fighter
// holding its nose on a target could still accelerate sideways at
// full power, so it slid around the fight like a puck on ice with
// its engine flaring at the back for motion the engine was not
// producing. Ships appeared to be shoved by something off-screen.
//
// Three pieces make it work, and all three are needed:
//
//   1  THE ENVELOPE. A steering request is decomposed into the
//      ship's own axes and each component clamped to its own
//      budget. Requests are not scaled to fit — the forward part is
//      granted in full and the sideways part is granted whatever
//      the jets have, so a ship pushed toward a place it cannot go
//      still makes the progress it can.
//
//   2  THE NOSE LEADS. Heading now follows *intent* — the direction
//      the ship wants to thrust — rather than the velocity it
//      already has. Under an anisotropic envelope, velocity-follows
//      -heading and heading-follows-velocity is a deadlock: a ship
//      wanting to go left while pointing right can barely push
//      left, so its velocity never turns, so its nose never turns.
//      Pointing at the intent first and thrusting second is what a
//      pilot actually does, and it makes every course change a
//      visible turn. With one exception, which is `faceFor` below:
//      slowing down is not a change of course, and a ship with a
//      bow thruster has no business turning round to use it.
//
//   3  MOMENTUM. Damping is light (`SPACE_DRAG`), so a ship that
//      stops thrusting keeps going. Sideways motion is now almost
//      always *inherited* rather than powered: a fighter builds
//      speed nose-first on the approach, swings its nose onto the
//      target, and carries that momentum around the arc while its
//      jets bend the path. It still strafes — it just has to have
//      earned the strafe first.
//
// The order below matters. The ship turns, and only then is thrust
// projected onto the heading it now has, so power ramps up as the
// nose comes round instead of arriving all at once.

/**
 * Where the nose should point, given what the ship wants to do.
 *
 * ------------------------------------------------------------
 * SLOWING DOWN IS NOT A CHANGE OF COURSE
 * ------------------------------------------------------------
 *
 * A steering request is a desired *change in velocity*, so a ship
 * that wants to slow down asks for a vector pointing backwards
 * along its own track. Face that vector literally — which is what
 * "point where you want to thrust" does if taken at its word — and
 * the hull swings right round to aim its main drive against its own
 * travel. Ships braked by spinning end-over-end and burning: nose
 * past ninety degrees on 18% of a miner's decelerating steps, 39%
 * of a fighter's, with full 180° flips in every class.
 *
 * That is defensible physics for a craft with one engine. It is the
 * wrong answer for these, because they have a bow thruster, and the
 * entire point of carrying one is that you do not have to turn
 * around to stop. It also looks wrong — a fleet that pirouettes to
 * park reads as busy and mechanical, which is the opposite of what
 * this simulation is for.
 *
 * ------------------------------------------------------------
 * POINT AT THE VELOCITY YOU ARE TRYING TO HAVE
 * ------------------------------------------------------------
 *
 * Which is the whole rule, and it says all of the above by itself.
 * A ship braking still wants to be going *this* way, only slower,
 * so the answer comes out as the flight path and the bow stays
 * forward. A ship that has stopped and wants to leave the other way
 * has no velocity left to preserve, so the answer comes out as the
 * new direction and it turns. Brake, turn, go — in that order,
 * without anywhere in the code that says so.
 *
 * It replaced a version that split the request into along-track and
 * across-track halves and treated them differently. That version
 * was right about the *behaviour* and wrong in a way that took a
 * flight recorder to see: reading the two halves separately needs a
 * branch, the branch has an edge, and a ship loitering on that edge
 * flips between two very different answers step after step. Two
 * edges existed — one where the request crossed from with-travel to
 * against it, one at the speed below which the rule switched off —
 * and hulls sat on both. The recorder showed the miner's turn rate
 * slamming between +96 and −96°/s, its entire turning authority,
 * reversing ten times on a single trip home. On screen that is a
 * ship shivering as it parks.
 *
 * Adding the velocity to the request scaled by a short lookahead has
 * no branch to sit on, so there is no edge to chatter across. The
 * two terms trade off smoothly: momentum wins while there is
 * momentum, intent wins once there is not.
 *
 * The one place it has no answer is the instant those two cancel
 * exactly — a ship whose engines could null its velocity inside the
 * lookahead. There is genuinely no meaningful heading there, so it
 * holds the one it has, which is also the calmest thing it could do.
 */
function faceFor(ship, wantX, wantY) {
    const fx = ship.vx + wantX * FACE_LOOKAHEAD;
    const fy = ship.vy + wantY * FACE_LOOKAHEAD;
    return Math.hypot(fx, fy) > COAST_SPEED ? Math.atan2(fy, fx) : ship.angle;
}

/**
 * Turn accumulated steering requests into motion, then derive the
 * cosmetic state (bank, thruster, jets, recoil) from what the
 * engines actually did — never from what was asked for.
 */
export function applyMotion(ship, dt) {
    if (ship.def.immobile) {
        ship.ax = ship.ay = 0;
        ship.recoil *= RECOIL_DECAY;
        return;
    }

    // ----- 1. what the ship wants -------------------------
    const wantX = ship.ax, wantY = ship.ay;
    const accel = ship.def.accel || 1;

    // ----- 2. where the nose goes -------------------------
    //
    // The velocity it is trying to have, with `aimAngle` over the top.
    //
    // That override is what makes orbiting combat work at all. A
    // fighter holding a circular standoff has its velocity
    // tangential to its target, so a nose that follows the flight
    // path is permanently about ninety degrees off the shot — well
    // outside any sane firing cone — and two fighters will circle
    // each other indefinitely without ever pulling a trigger.
    //
    // It is also the one case where a ship deliberately gives up
    // its main drive: a fighter aiming across its own course has
    // only the flank jets to steer with, which is precisely why an
    // engagement now reads as a wide coasting arc rather than as a
    // ship being dragged round a circle.
    const before = ship.angle;
    const rate = ship.def.turnRate * dt;

    if (ship.aimAngle !== null) {
        ship.angle = turnToward(ship.angle, ship.aimAngle, rate);
    } else {
        // One rule, no branches — see faceFor. A coasting hull trails
        // along its flight path, a manoeuvring one leads into the
        // turn, and a braking one keeps its bow forward, all as the
        // same arithmetic rather than as three cases.
        ship.angle = turnToward(ship.angle, faceFor(ship, wantX, wantY), rate);
    }

    // ----- 3. what the engines can deliver ----------------
    const cos = Math.cos(ship.angle), sin = Math.sin(ship.angle);
    const profile = ship.def.thrust || THRUST_PROFILE;

    // Decompose the request into the ship's own axes, clamp each to
    // its own budget, and rebuild. Clamping per-axis rather than
    // scaling the whole vector is deliberate: a request that is
    // mostly forward with a little sideways in it should get all of
    // the forward.
    const fwd = clamp(wantX * cos + wantY * sin,
        -accel * profile.retro, accel * profile.main);
    const lat = clamp(wantY * cos - wantX * sin,
        -accel * profile.lateral, accel * profile.lateral);

    ship.ax = fwd * cos - lat * sin;
    ship.ay = fwd * sin + lat * cos;

    // ----- 4. integrate -----------------------------------
    ship.vx += ship.ax * dt;
    ship.vy += ship.ay * dt;

    // Cruise ceiling, plus the light damping that stands in for
    // everything a real vacuum does not have — see SPACE_DRAG.
    //
    // A hull still shedding warp speed is exempt from the ceiling,
    // and that exemption is the entire arrival effect. Without it the
    // 5.2x velocity a ship drops in with is erased on its very first
    // step — the hull appears at ordinary cruise, there is nothing to
    // decelerate from, and the flash reads as a hull being teleported
    // rather than as one arriving. `arrestWarp` in sim/incursion.js
    // owns bringing it back down, and hands control here the moment
    // it reaches cruise.
    const speed = Math.hypot(ship.vx, ship.vy);
    const max = ship.warpT > 0 ? Infinity : ship.def.speed;
    if (speed > max) {
        const k = max / speed;
        ship.vx *= k;
        ship.vy *= k;
    }
    const drag = Math.exp(-SPACE_DRAG * dt);
    ship.vx *= drag;
    ship.vy *= drag;

    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;

    // ----- 5. the look ------------------------------------
    //
    // Roll into the turn, proportional to how fast the heading is
    // actually changing. This is the single cheapest thing that
    // makes 2D ships read as physical objects.
    let turned = ship.angle - before;
    if (turned > Math.PI) turned -= TAU;
    else if (turned < -Math.PI) turned += TAU;
    const wantBank = clamp(-turned / (rate || 1), -1, 1) * BANK_MAX;
    ship.bank = damp(ship.bank, wantBank, BANK_RATE, dt);

    // Each plume is driven by the engine that produces it, so the
    // art can never claim thrust the physics did not apply. The main
    // bell lights only on forward power — a ship translating
    // sideways on its jets now shows jets, and a ship braking shows
    // the retro pack at its nose.
    ship.throttle = damp(ship.throttle,
        clamp01(fwd / (accel * profile.main)), THRUSTER_SMOOTH, dt);
    ship.rcsLat = damp(ship.rcsLat,
        clamp(lat / (accel * profile.lateral), -1, 1), RCS_SMOOTH, dt);
    ship.rcsRetro = damp(ship.rcsRetro,
        clamp01(-fwd / (accel * profile.retro)), RCS_SMOOTH, dt);

    ship.recoil *= RECOIL_DECAY;
    ship.ax = ship.ay = 0;
}
