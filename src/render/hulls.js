// ============================================================
// HULLS — PROCEDURAL SHIP ART
// ============================================================
//
// Every ship in the game is a handful of polygons. No sprites, no
// image assets, no gradients.
//
// ------------------------------------------------------------
// THE SILHOUETTE GRAMMAR
// ------------------------------------------------------------
//
// All hulls share one language so the fleet reads as one fleet:
//
//   · symmetric about the local X axis, forward = +X
//   · three material slots, always used the same way —
//       plate   structural mass, nearest the ground colour
//       hull    the body, carries the faction identity
//       accent  one stripe, furthest from the ground, reads first
//   · no greebling, no panel lines, no decorative detail
//
// Role is communicated by *shape and scale only* (gospel rule 4).
// The test is simple and worth applying to anything new: fill the
// silhouette solid black. If you can still name the class, the
// design works. If you cannot, adding detail will not save it —
// change the outline.
//
//   drone    a fast little diamond
//   fighter  a narrow swept dart, all forward intent
//   corvette a blunt slab with its guns pushed forward
//   frigate  a long spine with a battery stepped down both flanks
//   miner    blunt and wide, with cargo pods that visibly fill
//   mothership  a station: concentric rings, quietly rotating
//
// ------------------------------------------------------------
// ADDING A HULL
// ------------------------------------------------------------
//
// Add a shape block and a renderer, then register it below. The
// renderer draws in local space at the origin; `drawShip` has
// already applied position, facing, bank and recoil.
// See docs/04-COOKBOOK.md.

import { traceRegular, traceRegularInto, fillPoly, softEllipse } from './draw.js';
import { mixHex, rgba } from '../core/color.js';
import { TAU, clamp01, lerp, lerpAngle } from '../core/math.js';
import { FACTIONS } from '../data/factions.js';

/**
 * The name on the exchange's sign.
 *
 * Resolved once from the faction table rather than per frame, and
 * read from data rather than written here — see `banner` in
 * data/factions.js for why it lives there.
 */
const EXCHANGE_BANNER = FACTIONS.find((f) => f.neutral)?.banner || '';

// ------------------------------------------------------------
// SHAPES  (flat [x,y,...] arrays, local space, forward = +X)
// ------------------------------------------------------------

const FIGHTER = {
    hull: [9.5, 0, 1.5, 3.0, -4.0, 6.8, -6.2, 5.2, -3.5, 1.6,
        -7.5, 1.4, -7.5, -1.4, -3.5, -1.6, -6.2, -5.2, -4.0, -6.8, 1.5, -3.0],
    plate: [-3.4, 2.1, -7.5, 1.5, -7.5, -1.5, -3.4, -2.1],
    accent: [9.0, 0, 3.2, 1.5, 0.8, 0, 3.2, -1.5],
};

// The corvette has to read as a *bigger warship* rather than as a
// fighter drawn larger, and at sixteen pixels the only thing you
// reliably perceive is proportion. So it inverts the fighter's:
// where the fighter is a dart — one long spine, swept wings well
// aft, everything raked back from a point — the corvette is a slab
// with a blunted prow and a wide squared stern. Same family, opposite
// build.
//
// The forward-swept sponsons are the tell that it is a gun platform.
// They carry the lance mount at the widest point of the hull, which
// puts the weapon where the eye already is, and they break the
// outline forward in a way nothing else in the fleet does — a shape
// you can name at a glance without resolving a single detail.
const CORVETTE = {
    hull: [16, 0, 11.5, 4.2, 6.0, 5.0, 4.5, 9.5, -1.0, 10.2, -3.0, 5.6,
        -12.0, 5.2, -14.5, 2.6, -14.5, -2.6, -12.0, -5.2, -3.0, -5.6,
        -1.0, -10.2, 4.5, -9.5, 6.0, -5.0, 11.5, -4.2],
    plate: [-5.0, 4.4, -14.0, 3.0, -14.0, -3.0, -5.0, -4.4],
    accent: [15.0, 0, 8.0, 2.4, 5.0, 0, 8.0, -2.4],
    /** Lance sponsons, mirrored in Y — the gun mount reads as the shape. */
    sponson: [4.8, 9.2, -0.6, 9.8, -2.4, 6.0, 5.4, 5.4],
};

// The frigate is a hull built around a battery.
//
// Where the corvette is a slab with its guns pushed forward, the
// frigate is a long spine with flak turrets stepped down both flanks
// — a broadside, not a prow. At twenty-two units the eye can finally
// resolve *rhythm*, so the repeated mounts do the identifying work
// that outline alone does for the smaller hulls: three paired blocks
// marching aft is a shape nothing else in the fleet has.
//
// Deliberately narrow for its length. A wide hull at this radius
// would read as a small mothership, and the one thing a frigate must
// never look like is a station.
const FRIGATE = {
    hull: [22, 0, 17.0, 3.4, 9.0, 5.2, -8.0, 6.0, -15.0, 5.0,
        -20.0, 3.2, -20.0, -3.2, -15.0, -5.0, -8.0, -6.0, 9.0, -5.2, 17.0, -3.4],
    plate: [-9.0, 5.2, -19.5, 3.4, -19.5, -3.4, -9.0, -5.2],
    accent: [21.0, 0, 12.0, 2.0, 8.0, 0, 12.0, -2.0],
    /** Flak mounts, stepped aft and mirrored in Y. */
    mounts: [
        [10.5, 5.0, 6.5, 5.0, 6.5, 8.6, 10.5, 8.6],
        [3.0, 5.6, -1.0, 5.6, -1.0, 9.2, 3.0, 9.2],
        [-4.5, 5.8, -8.5, 5.8, -8.5, 9.0, -4.5, 9.0],
    ],
};

// The swarm. Neither of these is symmetric about its nose, and that
// is the whole idea — see the note in data/ships.js. Every native
// hull is a mirror image of itself; these are lopsided, and among
// two dozen symmetric ships they read as *wrong* before you have
// resolved a single detail.
const SWARMER = {
    hull: [9.0, 0.6, 3.0, 4.6, -2.0, 3.2, -6.5, 5.4, -5.0, 0.4,
        -7.0, -2.6, -1.5, -2.0, 1.0, -5.2, 5.0, -3.0],
    accent: [8.4, 0.5, 3.6, 1.8, 2.0, -1.0],
};

const HARVESTER = {
    hull: [19, 1.0, 12.0, 6.4, 4.0, 5.0, 1.0, 9.6, -6.0, 8.8, -9.0, 4.2,
        -13.0, 2.0, -12.0, -3.4, -6.0, -4.0, -3.0, -7.6, 4.0, -6.0, 11.0, -4.0],
    plate: [-2.0, 5.6, -12.0, 2.4, -11.0, -3.0, -3.0, -4.2],
    accent: [18.0, 0.9, 10.0, 3.0, 7.0, 0.4],
};

// The outpost is a shed, and it must read as one from a great
// distance: a squat hexagonal drum with a docking collar. No prow,
// no symmetry axis you could mistake for a heading, nothing that
// suggests it can move. The one thing it shares with the mothership
// is roundness, because both are places rather than vehicles — but
// where a station is concentric rings, this is a single blunt mass.
// The destroyer: the frigate's language, one rung heavier.
//
// Same swept spine and the same stepped mounts down the flank, drawn
// longer and blunter — a class should be recognisable as a bigger
// version of the thing below it rather than a new idea, so the fleet
// reads as a family with a hierarchy in it. What marks it out at a
// glance is the prow: a solid wedge rather than the frigate's fine
// point, because this is the hull that goes *at* things.
const DESTROYER = {
    hull: [30, 0, 24.0, 5.0, 14.0, 8.0, -6.0, 9.0, -18.0, 7.6,
        -27.0, 4.6, -27.0, -4.6, -18.0, -7.6, -6.0, -9.0, 14.0, -8.0, 24.0, -5.0],
    plate: [-8.0, 7.6, -26.0, 4.6, -26.0, -4.6, -8.0, -7.6],
    /** The prow wedge — the silhouette's tell. */
    accent: [29.0, 0, 17.0, 3.4, 12.0, 0, 17.0, -3.4],
    /** Mounts stepped aft and mirrored in Y, as the frigate's are. */
    mounts: [
        [15.0, 7.4, 9.0, 7.4, 9.0, 12.4, 15.0, 12.4],
        [4.0, 8.4, -2.0, 8.4, -2.0, 13.4, 4.0, 13.4],
        [-9.0, 8.2, -15.0, 8.2, -15.0, 12.8, -9.0, 12.8],
    ],
};

// The factory: a yard, so an open frame rather than a hull.
//
// Two gantries with a slipway between them, and the ship under
// construction sits in the gap. It is the only structure on the board
// built from parallel lines, which is what keeps it distinct from the
// exchange's box and the outpost's drum at any zoom.
const FACTORY = {
    half: 30,
    gantry: 9,        // thickness of each arm
    slip: 11,         // half-height of the open bay between them
    spine: 5,
    lamp: 3.2,
};

const OUTPOST = {
    drum: 24,
    collar: 15,
    core: 8,
    gunLength: 11,
};

// The exchange: a station, not a ship.
//
// Everything else on the board is built to go somewhere or to stop
// something. This is a *place* — a squared-off block with a docking
// bay cut into one face and a lit sign over it, and no weapon
// anywhere on it. Every warship in both fleets is built from swept
// angles and a nose; a flat-sided box with a door reads as
// architecture before a viewer has consciously identified it.
//
// The bay faces the station's forward axis, and worldgen points that
// at the middle of the map — so the way in is always the side the
// traffic actually arrives from.
const EXCHANGE = {
    half: 30,          // half the square's side
    bayHalf: 10,       // half the entrance's width
    bayDepth: 13,      // how far the entrance is recessed
    inset: 6,          // the lit interior, inside the plate
    core: 11,          // the float readout
    lamp: 2.6,         // the approach lights either side of the bay
    // The sign is mounted on the roof rather than floating over it.
    //
    // `tests/render.test.js` measures drawn extent against the hull's
    // declared radius, and it is right to: ink that reaches well
    // outside the hitbox is a hull you cannot hit where you can see
    // it. So the sign sits on the top edge and the radius covers
    // both — signage is part of the silhouette even though it is not
    // part of the structure.
    signW: 48,
    signH: 12,
    signLift: 34,      // to the sign's centre, so it rests on the roof
};

// Haulers are miners with the mining taken out: the same blunt,
// wide, unthreatening proportion, but a single uninterrupted hold
// instead of cargo bays that fill. The freighter is the same shape
// again at nearly twice the size, so the pair read as a family and as
// a hierarchy without needing two designs.
const HAULER = {
    hull: [10.0, 0, 6.0, 5.4, -5.0, 6.2, -9.5, 3.6, -9.5, -3.6, -5.0, -6.2, 6.0, -5.4],
    plate: [-5.0, 4.6, -9.0, 2.6, -9.0, -2.6, -5.0, -4.6],
    accent: [8.6, 0, 5.4, 2.2, 5.4, -2.2],
};

// The miner is the fighter's opposite in every dimension that
// matters: short and broad where the fighter is long and narrow,
// blunt where it is pointed, one heavy mass where it is all swept
// edges. That contrast is the whole design — at twelve pixels
// across you will never read a detail, but you always read a
// proportion.
//
// Cargo bays are cut *into* the hull rather than bolted onto it.
// External pods were the first attempt and they broke the
// silhouette into a cross; inset bays show the same information
// without costing an outline.
const MINER = {
    hull: [9.2, 0, 4.2, 8.0, -6.0, 9.6, -9.2, 5.6, -9.2, -5.6, -6.0, -9.6, 4.2, -8.0],
    plate: [-6.0, 5.0, -9.6, 3.4, -9.6, -3.4, -6.0, -5.0],
    accent: [7.4, 0, 4.6, 2.6, 4.6, -2.6],
    /** Inset cargo bays, mirrored in Y. */
    bay: { x0: -4.8, x1: 3.2, y: 5.6, h: 1.9 },
};

const DRONE = {
    hull: [4.6, 0, 0, 2.5, -3.2, 0, 0, -2.5],
    accent: [4.6, 0, 1.4, 0.8, 1.4, -0.8],
};

// A station, not a diagram.
//
// The first version was two stroked hexagons and some dots, and it
// read as an icon — thin outlines have no mass, and mass is the
// one thing a mothership has to communicate. So the ring is now a
// solid annulus of dark structural plate, heavy and quiet, with
// the faction's colour concentrated in a bright core at the
// centre. Weight on the outside, life in the middle.
const MOTHERSHIP = {
    ringOuter: 38,
    ringInner: 30,
    spokeInner: 13,
    spokeOuter: 31,
    spokeWidth: 6,
    spokes: 3,
    orbitRadius: 34,
    orbitDots: 6,
    coreRadius: 16,
    innerRadius: 9,
    pipRadius: 3.6,
    buildArcRadius: 44,
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

/**
 * Damage is shown in the material, not in a bar.
 *
 * A hurt hull desaturates toward the theme's debris colour — it
 * reads as scorched rather than as an interface element, and it
 * stays legible at drone scale where a health bar would be larger
 * than the ship. Capped at 55% so a nearly-dead ship still shows
 * whose side it is on.
 */
function hullColour(ship, pal, theme) {
    const wear = 1 - clamp01(ship.hp / ship.maxHp);
    const worn = wear < 0.01 ? pal.hull : mixHex(pal.hull, theme.neutral.debris, wear * 0.55);

    // A struck hull flashes toward its faction's brightest tone.
    //
    // Damage was previously visible only as accumulated scorch, which
    // says how a ship is *doing* and nothing about what just happened
    // to it — so a hull taking fire and a hull sitting quietly at the
    // same hp looked identical. The flash is the moment; the scorch is
    // the history. Toward the faction's own flash colour rather than
    // white, so a hit never costs you the ability to tell whose ship
    // it was.
    const flash = clamp01(ship.hitFlash);
    return flash < 0.01 ? worn : mixHex(worn, pal.flash, flash * 0.75);
}

// ------------------------------------------------------------
// RENDERERS
// ------------------------------------------------------------

function drawFighter(ctx, ship, pal, theme) {
    fillPoly(ctx, FIGHTER.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, FIGHTER.plate, pal.plate);
    fillPoly(ctx, FIGHTER.accent, pal.accent);
}

function drawCorvette(ctx, ship, pal, theme) {
    fillPoly(ctx, CORVETTE.hull, hullColour(ship, pal, theme));

    // Sponsons before the plating, so the engine block reads as the
    // rearmost thing on the hull rather than as a layer over it.
    const s = CORVETTE.sponson;
    for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(s[0], s[1] * side);
        for (let i = 2; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1] * side);
        ctx.closePath();
        ctx.fillStyle = pal.plate;
        ctx.fill();
    }

    fillPoly(ctx, CORVETTE.plate, pal.plate);
    fillPoly(ctx, CORVETTE.accent, pal.accent);
    drawTurrets(ctx, ship, pal);
}

function drawFrigate(ctx, ship, pal, theme) {
    fillPoly(ctx, FRIGATE.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, FRIGATE.plate, pal.plate);
    fillPoly(ctx, FRIGATE.accent, pal.accent);
    drawTurrets(ctx, ship, pal);
}

/**
 * Gun mounts, each drawn at its own live bearing.
 *
 * This is the payoff for the whole turret system and it is worth
 * being deliberate about. The barrel is drawn *rotated by the mount's
 * own angle*, which is hull-local, so the hull's own transform
 * carries it — a frigate steaming east with its port battery tracking
 * something north needs no special case anywhere.
 *
 * Three pieces, in the order they read:
 *
 *   base    a squat block in plate, fixed to the hull. It never
 *           moves, so the eye has a still thing to measure the
 *           moving thing against — without it a rotating barrel just
 *           looks like a glitching hull.
 *   barrel  the part that swings. Long and thin, because at this
 *           scale *length* is the only property that survives, and a
 *           barrel you cannot see the direction of is a barrel that
 *           communicates nothing.
 *   heat    a single accent pip that brightens as the gun leaves its
 *           rest bearing, so a battery straining against its arc
 *           stops reading as decoration and starts reading as effort.
 */
function drawTurrets(ctx, ship, pal) {
    const mounts = ship.mounts;
    if (!mounts || !mounts.length) return;

    for (let i = 0; i < mounts.length; i++) {
        const m = mounts[i];
        const d = m.def;

        ctx.save();
        ctx.translate(d.x, d.y);

        // The fixed base, before the rotation.
        ctx.fillStyle = pal.plate;
        ctx.beginPath();
        ctx.arc(0, 0, 2.6, 0, TAU);
        ctx.fill();

        ctx.rotate(m.angle);

        // Barrel.
        ctx.fillStyle = pal.plate;
        ctx.fillRect(0, -0.9, 6.4, 1.8);

        // Muzzle tip, in the faction accent so the business end of
        // every gun on the field shares one colour.
        ctx.fillStyle = pal.accent;
        ctx.fillRect(5.0, -0.7, 1.6, 1.4);

        ctx.restore();

        // Effort. Sits on the base, unrotated, so it reads as a lamp
        // on the mount rather than as part of the barrel.
        if (m.load > 0.05) {
            ctx.fillStyle = rgba(pal.accent, 0.25 + m.load * 0.65);
            ctx.beginPath();
            ctx.arc(d.x, d.y, 1.3, 0, TAU);
            ctx.fill();
        }
    }
}

function drawSwarmer(ctx, ship, pal, theme) {
    fillPoly(ctx, SWARMER.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, SWARMER.accent, pal.accent);
}

function drawHarvester(ctx, ship, pal, theme) {
    fillPoly(ctx, HARVESTER.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, HARVESTER.plate, pal.plate);
    fillPoly(ctx, HARVESTER.accent, pal.accent);
    drawTurrets(ctx, ship, pal);
}

function drawOutpost(ctx, ship, pal, theme) {
    const O = OUTPOST;
    const body = hullColour(ship, pal, theme);

    // The drum, in plate — structural mass, not faction colour.
    ctx.fillStyle = pal.plate;
    ctx.beginPath();
    traceRegularInto(ctx, 6, O.drum, ship.spin * 0.35);
    ctx.fill();

    // Docking collar in the faction's own tone, so whose shed it is
    // reads before any detail does.
    ctx.fillStyle = body;
    ctx.beginPath();
    traceRegularInto(ctx, 6, O.collar, ship.spin * 0.35);
    ctx.fill();

    // The store itself, brightening as it fills — the same idea as a
    // miner's cargo bays, so "how much is in there" is legible from
    // across the map without a number, and a full shed visibly *asks*
    // for a hauler.
    const load = ship.cargoMax > 0 ? clamp01(ship.cargo / ship.cargoMax) : 0;
    ctx.fillStyle = rgba(pal.accent, 0.25 + load * 0.7);
    ctx.beginPath();
    ctx.arc(0, 0, O.core * (0.5 + load * 0.5), 0, TAU);
    ctx.fill();

    // The popgun. Stubby and obviously inadequate, which is the point.
    ctx.fillStyle = pal.plate;
    ctx.fillRect(O.collar - 2, -1.6, O.gunLength, 3.2);
}


/**
 * The line ship.
 *
 * Drawn through the same helpers as the frigate so the two stay a
 * family: hull, aft plate, prow accent, then the flank mounts. The
 * only thing that makes it read as heavier is that every number is
 * bigger, which is exactly how the scale ladder is supposed to work.
 */
function drawDestroyer(ctx, ship, pal, theme) {
    fillPoly(ctx, DESTROYER.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, DESTROYER.plate, pal.plate);
    fillPoly(ctx, DESTROYER.accent, pal.accent);

    ctx.fillStyle = pal.plate;
    for (const m of DESTROYER.mounts) {
        fillPoly(ctx, m, pal.plate);
        // Mirrored rather than listed twice — a matched broadside is
        // the characterisation, against the harvester's deliberate
        // asymmetry.
        fillPoly(ctx, m.map((v, i) => (i % 2 ? -v : v)), pal.plate);
    }
}

/**
 * The yard.
 *
 * Two gantry arms with an open slipway between them, and a hull under
 * construction in the gap whenever one is being built. That last part
 * is the whole reason this is not just another box: a factory that
 * looks the same whether or not it is working tells you nothing, and
 * "they are building something big" is the single most useful fact
 * this structure can communicate from across the map.
 */
function drawFactory(ctx, ship, pal, theme) {
    const F = FACTORY;
    const body = hullColour(ship, pal, theme);

    // The two arms.
    ctx.fillStyle = pal.plate;
    ctx.fillRect(-F.half, -F.slip - F.gantry, F.half * 2, F.gantry);
    ctx.fillRect(-F.half, F.slip, F.half * 2, F.gantry);

    // The spine joining them at the back, so it is a frame rather
    // than two unrelated bars.
    ctx.fillRect(-F.half, -F.slip, F.spine, F.slip * 2);

    // Faction colour on the arms' inner faces, where it reads as the
    // structure being *somebody's* without competing with the hull in
    // the slipway.
    ctx.fillStyle = body;
    ctx.fillRect(-F.half + F.spine, -F.slip - 2.5, F.half * 2 - F.spine, 2.5);
    ctx.fillRect(-F.half + F.spine, F.slip, F.half * 2 - F.spine, 2.5);

    // What is on the slipway. Grows along the bay as the build runs,
    // so a yard visibly fills up and then empties.
    if (ship.buildType && ship.buildEnd > ship.buildStart) {
        // `stateTime` rather than world time, because a hull renderer
        // is handed no clock — and it is the right number anyway: the
        // yard enters BUILDING when the build starts and stays there
        // until the hull leaves, so time-in-state *is* time-in-build.
        const t = clamp01(ship.stateTime / (ship.buildEnd - ship.buildStart));
        const len = (F.half * 1.6) * (0.25 + t * 0.75);
        ctx.fillStyle = rgba(pal.accent, 0.35 + t * 0.5);
        ctx.fillRect(-F.half + F.spine + 2, -F.slip * 0.45, len, F.slip * 0.9);
    }

    // Working lights at the mouth of the slipway.
    ctx.fillStyle = rgba(pal.flash, 0.5);
    ctx.fillRect(F.half - F.lamp, -F.slip - F.gantry, F.lamp, F.gantry);
    ctx.fillRect(F.half - F.lamp, F.slip, F.lamp, F.gantry);
}

/**
 * The neutral market.
 *
 * Drawn in its own faction's palette like everything else, which is
 * how it stays inside gospel rule 7 — the exchange's row in
 * `data/themes.js` is warm neutrals rather than a third accent hue,
 * so this adds a landmark without adding a colour.
 *
 * ------------------------------------------------------------
 * THE SIGN, AND WHY IT IS THE ONLY TEXT IN THE WORLD
 * ------------------------------------------------------------
 *
 * Nothing else in this project draws a glyph in world space. The HUD
 * is DOM, deliberately, and the restraint is a lot of why the frame
 * reads as calm rather than as a dashboard.
 *
 * This is the exception and it is a considered one: the station
 * belongs to somebody, and a name is the only way to say so. It is
 * counter-rotated out of the hull's own spin so it stays upright — a
 * sign you have to tilt your head to read is a decal, not a sign —
 * and it is drawn at the station's scale rather than at a fixed pixel
 * size, so it grows and shrinks with the map instead of floating over
 * it like an annotation. Zoomed out it is a lit bar; go and look at
 * it and it is a name.
 */
function drawExchange(ctx, ship, pal, theme) {
    const E = EXCHANGE;
    const stock = ship.cargoMax > 0 ? clamp01(ship.cargo / ship.cargoMax) : 0;

    // The block, with the bay recessed into its forward face. One
    // path, so the doorway is genuinely an absence of hull rather
    // than a darker rectangle painted on top of one.
    ctx.fillStyle = pal.plate;
    ctx.beginPath();
    ctx.moveTo(E.half, -E.half);
    ctx.lineTo(E.half, -E.bayHalf);
    ctx.lineTo(E.half - E.bayDepth, -E.bayHalf);
    ctx.lineTo(E.half - E.bayDepth, E.bayHalf);
    ctx.lineTo(E.half, E.bayHalf);
    ctx.lineTo(E.half, E.half);
    ctx.lineTo(-E.half, E.half);
    ctx.lineTo(-E.half, -E.half);
    ctx.closePath();
    ctx.fill();

    // The interior, inset so the plate reads as a wall with depth.
    ctx.fillStyle = hullColour(ship, pal, theme);
    ctx.fillRect(-E.half + E.inset, -E.half + E.inset,
        (E.half - E.inset) * 2 - E.bayDepth, (E.half - E.inset) * 2);

    // The float, as light in the middle — the same readout as an
    // outpost's store and a miner's bays: how much is in there,
    // without a number, from across the map.
    ctx.fillStyle = rgba(pal.accent, 0.2 + stock * 0.6);
    ctx.beginPath();
    ctx.arc(-E.bayDepth * 0.4, 0, E.core * (0.45 + stock * 0.55), 0, TAU);
    ctx.fill();

    // Approach lights either side of the doorway, so the way in is
    // marked rather than merely present.
    ctx.fillStyle = rgba(pal.flash, 0.45 + stock * 0.4);
    ctx.fillRect(E.half - E.lamp, -E.bayHalf - E.lamp, E.lamp, E.lamp);
    ctx.fillRect(E.half - E.lamp, E.bayHalf, E.lamp, E.lamp);

    drawSign(ctx, ship, pal, stock);
}

/**
 * The lit sign above the station.
 *
 * Counter-rotated out of the hull's transform so it reads upright at
 * any station heading. Brightness follows the float, which makes the
 * sign the same readout as everything else on the structure: lit
 * means there is something here worth the crossing.
 */
function drawSign(ctx, ship, pal, stock) {
    const E = EXCHANGE;
    const name = EXCHANGE_BANNER;
    if (!name) return;

    ctx.save();
    ctx.rotate(-ship.angle);

    const y = -E.signLift;

    // The housing, then the tube inside it. Two layers rather than
    // one, because a neon sign is a bright line held in a dark frame
    // and a single bright rectangle just reads as a blank panel.
    ctx.fillStyle = pal.plate;
    ctx.fillRect(-E.signW * 0.5, y - E.signH * 0.5, E.signW, E.signH);

    ctx.fillStyle = rgba(pal.accent, 0.30 + stock * 0.35);
    ctx.fillRect(-E.signW * 0.5 + 1.5, y - E.signH * 0.5 + 1.5, E.signW - 3, E.signH - 3);

    // The name itself, in the palette's brightest tone — the one
    // near-white on the structure, spent here rather than on a muzzle
    // flash because this is the one thing on the map that never fires.
    ctx.fillStyle = rgba(pal.flash, 0.65 + stock * 0.35);
    ctx.font = `600 ${E.signH - 5}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 0, y);

    ctx.restore();
}

function drawHauler(ctx, ship, pal, theme) {
    // One shape at two scales. `radius` carries the difference, so the
    // freighter is the hauler seen from closer up — a family, and a
    // hierarchy, from a single outline.
    const k = ship.radius / 10;
    ctx.save();
    ctx.scale(k, k);

    fillPoly(ctx, HAULER.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, HAULER.plate, pal.plate);

    // The hold, filling as it loads.
    const load = ship.cargoMax > 0 ? clamp01(ship.cargo / ship.cargoMax) : 0;
    if (load > 0.001) {
        ctx.fillStyle = pal.accent;
        ctx.fillRect(-4.4, -3.4, 9.0 * load, 6.8);
    }
    fillPoly(ctx, HAULER.accent, pal.accent);

    ctx.restore();
}

/**
 * A wreck: a broken container, not a ship.
 *
 * Deliberately the only asymmetric *native* silhouette in the fleet,
 * and jagged where everything else is smooth — it should read as
 * debris at a glance, never as a hull somebody is flying. The ore
 * inside glows through the split, brightest when it is full, so a
 * valuable wreck is visibly worth crossing space for.
 */
function drawWreck(ctx, ship, pal, theme) {
    const load = ship.cargoMax > 0 ? clamp01(ship.cargo / ship.cargoMax) : 0;

    // The theme's debris tone, unmixed. Gospel rule 1 is that every
    // colour on screen comes from the palette, and `debris` is the
    // entry that exists for exactly this — dead matter. Blending it
    // with the faction plate produced a shade in neither theme, which
    // the palette guard caught.
    fillPoly(ctx, [6.5, -1.0, 2.0, 5.5, -4.0, 4.5, -6.0, -1.5, -1.5, -5.5, 4.0, -4.0],
        theme.neutral.debris);

    // The split, and the ore showing through it.
    ctx.fillStyle = rgba(pal.accent, 0.30 + load * 0.6);
    ctx.beginPath();
    ctx.moveTo(3.4, -0.6);
    ctx.lineTo(0.0, 2.6);
    ctx.lineTo(-2.8, -0.4);
    ctx.lineTo(0.2, -2.6);
    ctx.closePath();
    ctx.fill();
}

function drawMiner(ctx, ship, pal, theme) {
    const { bay } = MINER;
    const body = hullColour(ship, pal, theme);

    fillPoly(ctx, MINER.hull, body);

    // Bays fill from the rear as ore comes aboard, so a miner's
    // cargo state is legible from across the map without a single
    // number on screen — empty and outbound reads dark, laden and
    // homeward reads as the brightest thing in its faction's colour.
    const load = ship.cargoMax > 0 ? clamp01(ship.cargo / ship.cargoMax) : 0;
    const bayW = bay.x1 - bay.x0;

    for (let s = -1; s <= 1; s += 2) {
        const y = bay.y * s - bay.h;
        ctx.fillStyle = pal.plate;
        ctx.fillRect(bay.x0, y, bayW, bay.h * 2);
        if (load > 0.001) {
            ctx.fillStyle = pal.accent;
            ctx.fillRect(bay.x0, y, bayW * load, bay.h * 2);
        }
    }

    fillPoly(ctx, MINER.plate, pal.plate);
    fillPoly(ctx, MINER.accent, pal.accent);
}

function drawDrone(ctx, ship, pal, theme) {
    fillPoly(ctx, DRONE.hull, hullColour(ship, pal, theme));
    fillPoly(ctx, DRONE.accent, pal.accent);
}

function drawMothership(ctx, ship, pal, theme) {
    const M = MOTHERSHIP;
    const body = hullColour(ship, pal, theme);
    // Emplacements are drawn at the end, in drawTurrets — see the call
    // at the bottom of this function.

    ctx.lineJoin = 'round';

    // --- outer ring: a solid annulus, the station's mass ---
    // Traced as two hexagons filled with the even-odd rule, which
    // punches the hole in one fill rather than needing a second
    // ground-coloured pass over the middle.
    ctx.beginPath();
    traceRegularInto(ctx, 6, M.ringOuter, 0);
    traceRegularInto(ctx, 6, M.ringInner, 0);
    ctx.fillStyle = pal.plate;
    ctx.fill('evenodd');

    // A defined outer edge, so the dark mass reads as an object
    // against a dark ground rather than as a smudge.
    traceRegular(ctx, 6, M.ringOuter, 0);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = rgba(body, 0.6);
    ctx.stroke();

    // --- spokes ---
    // Rotate against the pips. The station's only motion is kept
    // well below the speed at which the eye tracks it, so it reads
    // as *alive* rather than as *spinning*.
    ctx.strokeStyle = pal.plate;
    ctx.lineWidth = M.spokeWidth;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let i = 0; i < M.spokes; i++) {
        const a = -ship.spin * 0.4 + (i / M.spokes) * TAU;
        const c = Math.cos(a), s = Math.sin(a);
        ctx.moveTo(c * M.spokeInner, s * M.spokeInner);
        ctx.lineTo(c * M.spokeOuter, s * M.spokeOuter);
    }
    ctx.stroke();

    // --- core: where the faction colour lives ---
    traceRegular(ctx, 6, M.coreRadius, Math.PI / 6);
    ctx.fillStyle = body;
    ctx.fill();

    traceRegular(ctx, 6, M.innerRadius, Math.PI / 6);
    ctx.fillStyle = pal.plate;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, M.pipRadius, 0, TAU);
    ctx.fillStyle = pal.accent;
    ctx.fill();

    // --- orbiting pips ---
    for (let i = 0; i < M.orbitDots; i++) {
        const a = ship.spin + (i / M.orbitDots) * TAU;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * M.orbitRadius, Math.sin(a) * M.orbitRadius, 2.2, 0, TAU);
        ctx.fillStyle = pal.accent;
        ctx.fill();
    }

    drawTurrets(ctx, ship, pal);
}

/**
 * Build progress, drawn as an arc outside the station's rings.
 *
 * Deliberately not a progress *bar*: a bar is a piece of user
 * interface and would be the only rectangle in the scene. An arc
 * concentric with the hull reads as part of the object.
 */
export function drawBuildArc(ctx, ship, pal, world) {
    if (!ship.buildType && ship.buildDoneAt < 0) return;

    let progress = 1;
    let alpha = 1;

    if (ship.buildType) {
        const span = ship.buildEnd - ship.buildStart;
        progress = span > 0 ? clamp01((world.time - ship.buildStart) / span) : 1;
    } else {
        // Just completed: hold a full ring and fade it out.
        alpha = clamp01(1 - (world.time - ship.buildDoneAt) / 0.5);
        if (alpha <= 0) return;
    }

    const r = MOTHERSHIP.buildArcRadius;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + TAU * progress);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(pal.accent, 0.55 * alpha);
    ctx.stroke();
}

// ------------------------------------------------------------
// REGISTRY
// ------------------------------------------------------------

export const HULL_RENDERERS = {
    fighter: drawFighter,
    corvette: drawCorvette,
    frigate: drawFrigate,
    destroyer: drawDestroyer,
    factory: drawFactory,
    outpost: drawOutpost,
    exchange: drawExchange,
    hauler: drawHauler,
    freighter: drawHauler,
    wreck: drawWreck,
    swarmer: drawSwarmer,
    harvester: drawHarvester,
    miner: drawMiner,
    drone: drawDrone,
    mothership: drawMothership,
};

/** Hull radius used for the thruster plume anchor, per class. */
const THRUSTER_ANCHOR = {
    fighter: -7.5,
    corvette: -14.0,
    frigate: -19.5,
    destroyer: -26.5,
    hauler: -9.2,
    freighter: -16.5,
    swarmer: -6.5,
    harvester: -12.5,
    miner: -9.8,
    drone: -3.2,
};

/**
 * Where the manoeuvring jets sit, per class, in hull-local space.
 *
 * `fore`/`aft` are the X positions of the flank pair and `y` its
 * distance off the centreline — all placed on actual hull edge, so
 * a jet fires from structure rather than out of empty space.
 * `nose` is the forwardmost point of the hull, where the retro pack
 * exhausts; its plume is drawn entirely *ahead* of that, because a
 * braking flare that overlaps the hull it is meant to be slowing
 * disappears into the silhouette. That was the whole reason miners
 * looked as though they had no braking thruster at all.
 *
 * The flanks fire as a *pair* because one jet off the centreline is
 * a torque, not a translation: a ship sliding sideways on a single
 * puff would be visibly spinning itself while refusing to turn.
 */
const RCS_ANCHOR = {
    fighter: { fore: 2.6, aft: -3.4, y: 2.4, nose: 9.5 },
    miner: { fore: 3.0, aft: -5.0, y: 8.4, nose: 9.2 },
    drone: { fore: 0.8, aft: -1.2, y: 1.5, nose: 4.6 },
};

/** Below this share of a jet's budget, nothing is drawn. */
const RCS_FLOOR = 0.12;

/**
 * The retro pack gets a lower floor and a square-root response.
 *
 * The flank jets trim more or less constantly, so a hard floor is
 * what keeps them from speckling; braking is the opposite — an
 * occasional, deliberate act that the eye should catch every time.
 *
 * It also needs the curve because of how little force stopping
 * actually takes. A laden miner shedding 62 u/s over its approach
 * needs about 10 u/s², and light damping already supplies most of
 * that, so the pack genuinely runs at a fifth of its budget. Linear
 * alpha renders that as nothing at all, and a ship that visibly
 * slows with no visible brake is exactly the thing this is here to
 * fix. Square root lifts the quiet end without touching the loud
 * one, so a gentle brake reads as a gentle brake instead of as
 * silence.
 */
const RETRO_FLOOR = 0.05;

// ------------------------------------------------------------
// ENTRY POINTS
// ------------------------------------------------------------

/**
 * Draw one ship, interpolated between its previous and current
 * simulation transform.
 *
 * Bank is applied as a vertical squash. In a top-down view a ship
 * rolling into a turn foreshortens, and squashing is both the
 * cheapest and the most legible way to say that — it costs one
 * scale call and it is the difference between ships that turn and
 * ships that pivot like cursors.
 */
export function drawShip(ctx, ship, theme, alpha, world) {
    const render = HULL_RENDERERS[ship.type];
    if (!render) return;

    const pal = theme.factions[ship.factionId];
    const x = lerp(ship.prevX, ship.x, alpha);
    const y = lerp(ship.prevY, ship.y, alpha);
    const a = lerpAngle(ship.prevAngle, ship.angle, alpha);

    ctx.save();
    ctx.globalAlpha = ship.fade;
    ctx.translate(x, y);

    if (ship.role === 'mothership') {
        drawBuildArc(ctx, ship, pal, world);
    }

    ctx.rotate(a);
    if (ship.recoil > 0.01) ctx.translate(-ship.recoil, 0);
    const squash = 1 - Math.abs(ship.bank) * 0.5;
    if (squash < 0.999) ctx.scale(1, squash);

    render(ctx, ship, pal, theme);

    ctx.restore();
    ctx.globalAlpha = 1;
}

/**
 * Engine plumes. Drawn during the additive/ink FX pass rather than
 * with the hull, so they composite as light on `void` and as ink on
 * `paper` like every other emissive thing.
 *
 * ------------------------------------------------------------
 * ONE PLUME PER ENGINE, AND NEVER MORE
 * ------------------------------------------------------------
 *
 * A ship carries three engines and each gets its own plume, drawn
 * from that engine's own load: `throttle` for the main bell,
 * `rcsLat` for the flank jets, `rcsRetro` for the retro pack. None
 * of them is inferred from how the ship is moving.
 *
 * That is the whole point, and it is worth stating because the old
 * version got it wrong in a way that was hard to see and impossible
 * to unsee: it lit the main bell from the *magnitude* of the
 * steering request, so a fighter translating sideways showed a
 * bright tail flare while travelling ninety degrees away from it.
 * The art was claiming thrust the physics never applied, which is
 * most of why ships read as being shoved around by something
 * off-screen rather than flying. Now the burn you can see is the
 * burn that moved the ship: sideways translation shows jets,
 * braking shows the retro pack, and a coast shows nothing at all.
 */
export function drawThruster(ctx, ship, theme, alpha) {
    const anchor = THRUSTER_ANCHOR[ship.type];
    if (anchor === undefined) return;

    const jets = RCS_ANCHOR[ship.type];
    const lat = jets ? ship.rcsLat : 0;
    const retro = jets ? ship.rcsRetro : 0;
    if (ship.throttle < 0.04 && Math.abs(lat) < RCS_FLOOR && retro < RCS_FLOOR) return;

    const pal = theme.factions[ship.factionId];
    const x = lerp(ship.prevX, ship.x, alpha);
    const y = lerp(ship.prevY, ship.y, alpha);
    const a = lerpAngle(ship.prevAngle, ship.angle, alpha);
    const hot = theme.fx.hotCore ? pal.flash : pal.thruster;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);

    // ----- main drive -------------------------------------
    const t = ship.throttle;
    if (t >= 0.04) {
        // Long behind the ship, narrow across it — a plume, not a halo.
        const len = ship.radius * (0.55 + t * 1.15);
        const width = ship.radius * 0.34;
        softEllipse(ctx, anchor - len * 0.45, 0, len, width,
            pal.thruster, t * 0.7 * ship.fade);
        // A small hot point right at the nozzle, so the plume has a source.
        softEllipse(ctx, anchor - 0.5, 0, ship.radius * 0.3, ship.radius * 0.22,
            hot, t * 0.55 * ship.fade);
    }

    // ----- manoeuvring jets -------------------------------
    //
    // Stubby and dim next to the main plume, and deliberately so:
    // these are the engines that barely move the ship, and a jet
    // that flared like the main bell would misreport the physics
    // just as badly in the other direction. They are here to make a
    // slide legible, not to be looked at.
    if (Math.abs(lat) >= RCS_FLOOR) {
        const m = Math.min(1, Math.abs(lat));
        // Thrust toward +Y means exhaust toward -Y: the puff shows on
        // the side the ship is pushing away from.
        const side = lat > 0 ? -1 : 1;
        const len = ship.radius * (0.24 + m * 0.32);
        const off = jets.y + len * 0.45;
        softEllipse(ctx, jets.fore, side * off, len * 0.85, len,
            pal.thruster, m * 0.45 * ship.fade);
        softEllipse(ctx, jets.aft, side * off, len * 0.85, len,
            pal.thruster, m * 0.45 * ship.fade);
    }

    if (retro >= RETRO_FLOOR) {
        // Braking. The pack at the nose exhausts forward, so this is
        // the one plume on any ship in the project that points the
        // way the ship is going — which is exactly what makes a
        // deceleration readable at a glance, and why it is drawn
        // clear of the bow rather than on it.
        const m = Math.sqrt(Math.min(1, retro));
        const len = ship.radius * (0.30 + m * 0.42);
        softEllipse(ctx, jets.nose + len, 0, len, ship.radius * 0.22,
            pal.thruster, m * 0.55 * ship.fade);
        // A hot point at the nozzle, matching the main bell's, so the
        // flare reads as coming *from* the hull.
        softEllipse(ctx, jets.nose + 0.5, 0, ship.radius * 0.24, ship.radius * 0.18,
            hot, m * 0.4 * ship.fade);
    }

    ctx.restore();
}
