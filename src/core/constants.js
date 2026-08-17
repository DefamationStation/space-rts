// ============================================================
// CONSTANTS — EVERY TUNABLE NUMBER
// ============================================================
//
// If a number changes how the simulation *feels*, it lives here.
// If it changes what a specific ship or weapon *is*, it lives in
// `src/data/`. Magic numbers inside sim or render code are a bug.
//
// Every value carries its unit. World units are arbitrary but
// consistent — read them as roughly "pixels at 1× zoom".
// `docs/03-SIMULATION.md` reproduces this as a tuning table with
// the reasoning behind each figure.

// ------------------------------------------------------------
// LOOP
// ------------------------------------------------------------

export const FIXED_DT = 1 / 60;            // s      — one logical step
export const MAX_STEPS_PER_FRAME = 5;      // steps  — spiral-of-death guard

// ------------------------------------------------------------
// WORLD
// ------------------------------------------------------------
//
// The world is a fixed size, and the viewport is a window onto it.
//
// It did not used to be. Through v1 the world's *height* was fixed
// and its *width* derived from the viewport aspect, so the whole
// battlefield always exactly filled the window — no bars, no
// cropping, and no camera to manage. That was the right call while
// the map was small enough to take in at a glance.
//
// It stopped being right the moment the map grew. A world that
// reshapes itself to the window is a world whose *geography* depends
// on the display it is watched on: two viewers see different distances
// between the same two stations, and a seed does not reproduce across
// monitors. At 2400×1400 that was a curiosity. At 7200×4200 the
// distance from a station to the contested middle is the single most
// important number in the simulation, and it cannot be allowed to
// depend on somebody's aspect ratio.
//
// So the world is now 7200×4200 in both places, always, and
// `render/canvas.js` owns a camera that decides which part of it you
// are looking at. See docs/05-ROADMAP.md on the cinematic camera.
// Height is fixed; width follows the display.
//
// This is a partial return to how v1 worked, and the reasoning has
// changed with the screen. A fixed 7200x4200 is 1.71:1 — fine on a
// 16:9 panel and badly wrong on an ultrawide, where fitting the whole
// world leaves a third of the glass empty on either side. The play
// area should fill the space it is given.
//
// The cost, stated plainly: a seed no longer produces an identical
// map on two differently-shaped displays, because the width it is
// generated against differs. Within one display it is exactly as
// reproducible as before, and the share link in render/controls.js
// carries the width so a link still lands on the frame it promised.
export const WORLD_HEIGHT = 4200;          // world units — fixed
export const WORLD_WIDTH_MIN = 7000;       // world units
export const WORLD_WIDTH_MAX = 13400;      // enough for 32:9

/** Default width, used headlessly where there is no display to ask. */
export const WORLD_WIDTH = 7200;           // world units
export const WORLD_EDGE_MARGIN = 110;      // world units — ships steer back inside this band
export const WORLD_EDGE_PUSH = 240;        // u/s²      — how hard the soft wall pushes

export const GRID_SPACING = 100;           // world units between grid lines
export const GRID_ALPHA = 1.0;             // multiplier on the theme's grid colour

// ------------------------------------------------------------
// BROADPHASE
// ------------------------------------------------------------

export const SPATIAL_CELL = 130;           // world units per uniform-grid cell

// ------------------------------------------------------------
// FLIGHT MODEL
// ------------------------------------------------------------
//
// A ship's engines are bolted to its hull, so what it can do
// depends on where its nose is pointing. `THRUST_PROFILE` is the
// envelope, as fractions of the hull's `accel`:
//
//        main 1.0
//     ◀━━━━━━━━━━━━━┓
//                   ┃ ▶     lateral 0.16   ── weak manoeuvring jets
//     ◀━━━━━━━━━━━━━┛       retro   0.22   ── weak retro pack
//
// A steering request is resolved against that envelope every step
// rather than applied as written. See `applyMotion` in
// sim/steering.js for why this is the whole flight model.

export const THRUST_PROFILE = {
    main: 1.00,                            // fraction of accel — the drive at the back
    retro: 0.22,                           // fraction of accel — braking, nose-forward
    lateral: 0.16,                         // fraction of accel — sideways translation
};

// Momentum. Space has no air in it, but a simulation with *zero*
// damping never settles: station-keeping turns into a permanent
// slow oscillation and a ship told to stop never quite does.
//
// This is the single number that decides whether ships feel like
// they are flying or swimming. At the 0.85 it used to sit at, a
// coasting hull lost more than half its speed in a second, so
// velocity tracked thrust almost instantly and heading barely
// mattered — which is exactly what made ships look like they were
// sliding sideways under power. At 0.20 a coast reads as a coast.
//
// Swept from 0.45 down to 0.10 across four seeds: the economy does
// not care at all (ore delivered varies by ~3%, well inside seed
// noise, and miners dock just as reliably), while a fight cares a
// lot — the share of an engaged fighter's thrust coming from its
// main drive climbs steadily as damping falls, because momentum it
// keeps is momentum its jets do not have to re-buy.
export const SPACE_DRAG = 0.20;            // 1/s exponential velocity damping

// How far ahead the facing rule looks, in seconds.
//
// A ship points at the velocity it is *trying* to have — its
// current velocity plus what its engines are asking for, over this
// long. That one line covers coasting, turning and braking without
// a branch between them, which matters more than it sounds: the
// version it replaced split the request into along-track and
// across-track halves, and every branch edge turned out to be
// somewhere a ship could sit and chatter. A miner parking reversed
// its turn rate ten times between +96 and -96 deg/s, the whole of
// its turning authority, shivering as it came to rest.
//
// The value trades momentum against intent. Too long and a braking
// ship decides it would rather be going the other way and turns
// round, which is the behaviour the bow thruster exists to avoid;
// too short and a stopped ship is slow to commit to leaving. At
// 0.15 s a hull holds its bow forward through any deceleration its
// approach actually asks for, because `arrive` is proportional and
// eases off as it converges — only a sustained full-power reverse
// request, which genuinely does mean "go the other way", turns it.
export const FACE_LOOKAHEAD = 0.15;        // s

// The speed below which a heading has no meaning worth chasing.
//
// It does double duty, and both uses are the same idea: when the
// vector you would take an angle from is this short, its direction
// is numerical residue rather than information. A drifting hull
// holds the heading it has instead of swinging to face noise, and
// so does one at the instant its momentum and its intent cancel.
export const COAST_SPEED = 6;              // u/s — threshold below which a stopped/drifting hull holds heading

export const RCS_SMOOTH = 12.0;            // 1/s — manoeuvring-jet plume response

// The orbit controller (see `orbit` in sim/steering.js) is a
// spring-damper on the radius, sitting on top of the centripetal
// term that makes a circle a circle. Read as a second-order system:
// stiffness is ω², damping is 2ζω, so these are ω ≈ 1.5 rad/s at
// critical — a ring settled onto in about a second and a half,
// without the overshoot that would swing a fighter through its own
// standoff and back out again.
export const ORBIT_STIFFNESS = 2.25;       // 1/s²
export const ORBIT_DAMPING = 3.0;          // 1/s

// The tangential term gets its own, much gentler gain, because it
// is the one spending the flank jets. At the radial gain a speed
// error of ten units already asks for more than a fighter's jets
// can produce, so they sit at full power for the whole engagement —
// correct arithmetic, but it renders as a side thruster welded on.
// A soft gain saturates only when a ship is genuinely spinning up
// to orbital speed, and trims quietly the rest of the time.
export const ORBIT_TAN_GAIN = 1.2;         // 1/s

// Fraction of cruise speed to circle at. Short of the ceiling on
// purpose: a ship pinned against its own speed cap has nothing left
// to steer with, and every radius correction has to fight the cap.
export const ORBIT_SPEED = 0.85;

// How hard `arrive` pulls on a given velocity error, in u/s² per
// u/s. Full thrust is still reached — a miner saturates at a 42 u/s
// error — but the demand now fades out as it is satisfied instead
// of slamming between full ahead and full astern either side of the
// target speed. Without it a braking ship lights both its main
// drive and its retro pack in the same frame.
export const ARRIVE_GAIN = 2.5;            // 1/s

// ------------------------------------------------------------
// WORLDGEN
// ------------------------------------------------------------

// Contested fields — the ore both sides have to leave home for.
//
// 34 clusters over 30.24M square units is roughly *half* the areal
// density the 2400×1400 map ran at, and the thinning is the point.
// Ore that is far apart is ore worth travelling for, and travel is
// what turns a map into territory: a field is only yours while
// somebody is standing on it. Matching the old density would have
// produced a bigger map with the same local economics, which is a
// longer run of the same simulation rather than a different one.
//
// If the economy stalls, this is the first dial — see the note on
// MINER_CARGO, which was raised alongside it.
export const ASTEROID_FIELDS = 20;         // clusters placed at start
export const ASTEROIDS_PER_FIELD_MIN = 4;
export const ASTEROIDS_PER_FIELD_MAX = 8;
export const FIELD_SCATTER = 130;          // world units — cluster tightness
export const FIELD_MIN_SEPARATION = 520;   // world units between field centres

// No contested rocks anywhere near a station. Deliberately much
// wider than the defence battery's 430 reach, so that a *scattered*
// field can never happen to fall under someone's guns — the only ore
// inside a faction's own cover is the home field placed there on
// purpose (see worldgen). Before, 21% of fields landed inside battery
// range by luck, which meant the safety of an economy was a property
// of the seed rather than of the design.
export const FIELD_MOTHERSHIP_CLEARANCE = 900; // world units — no rocks on a doorstep

export const ASTEROID_ORE_MIN = 70;        // ore
export const ASTEROID_ORE_MAX = 155;       // ore
export const ASTEROID_RADIUS_MIN = 11;     // world units at full ore
export const ASTEROID_RADIUS_MAX = 26;     // world units at full ore
export const ASTEROID_RADIUS_FLOOR = 0.42; // fraction — how small a rock shrinks before it dies

// How long a stripped field stays gone, and it is the number the
// whole tempo of a run now hangs on.
//
// At 26 s ore was permanently everywhere. A field emptied, a miner
// turned around, and by the time it came back the rocks had returned
// — so no faction was ever pushed further than its nearest cluster,
// the frontier never moved, and the only thing that ever varied in a
// run was who was shooting whom. Scarcity that repairs itself in half
// a minute is not scarcity.
//
// At four minutes a stripped field is *gone* for long enough to
// matter. Miners work outward from home, exhaust what is close, and
// have to commit to something further out — which is what creates the
// need for a forward base, which is what gives the two factions
// something to fight over that is not simply each other.
export const ASTEROID_RESPAWN_DELAY = 240; // s after a field empties

// Below this a field is not worth crossing open space for, so miners
// ignore it and go to the next one out. Without it a miner would
// shuttle to the nearest cluster for its last eight ore and never
// discover that the frontier had moved.
export const FIELD_MIN_WORTH = 90;         // ore

// ...but "worth it" is a statement about the *trip*, not about the
// field, and reading it as a flat floor quietly broke the frontier.
//
// A miner fills its ninety-unit hold and goes home; next trip the
// field it was working has dropped under the floor, so nobody ever
// claims it again. Measured at thirty minutes, 38 of 88 fields sat
// stranded between 1 and 89 ore — drained to a husk and abandoned,
// still holding rocks, so `updateFields` never saw them empty and
// never relocated them. Nought fields ran dry in four runs. The map
// was not being consumed and re-drawn; it was silting up.
//
// So the floor scales with the distance to it: a field this close
// needs no ore at all to be worth finishing, and one further away
// needs the full amount. Dregs on the doorstep get swept up, the
// field empties, and it moves somewhere new.
export const FIELD_SCRAP_RANGE = 900;      // world units

// How far from a station ore has to be before it is as rich as ore
// gets, as a fraction of world width. Beyond this the gradient is
// flat, so the far half of the map is uniformly worth crossing for
// rather than having one perfect spot in it.
export const ORE_GRADIENT_REACH = 0.42;

// Rock count on a faction's own doorstep, as a fraction of what the
// same field would hold out in the middle. Low enough that home ore
// is visibly a floor rather than a living — the reason to leave home
// is the entire simulation.
export const ORE_GRADIENT_FLOOR = 0.45;

// What the respawn delay is multiplied by at maximum richness.
//
// Contested ore comes back in a little over half the time safe ore
// does, which is what turns "the middle is richer" into "the middle
// is worth holding" — the difference between a place you raid and a
// place you garrison.
export const ASTEROID_RESPAWN_CONTEST = 0.45;

// Fields are not all the same size.
//
// A multiplier on both rock count and ore per rock, so the map has
// landmarks: a few clusters genuinely worth crossing the map for, a
// lot of ordinary ones, and some barely worth the trip. Uniform
// fields make every mining decision equivalent, and a decision with
// no stakes is not a decision — this is what makes "which field" a
// question with a wrong answer.
export const FIELD_CAPACITY_MIN = 0.55;
export const FIELD_CAPACITY_MAX = 1.75;
export const ASTEROID_RESPAWN_FADE = 2.2;  // s fade-in, so nothing ever pops into being

export const MOTHERSHIP_EDGE_INSET = 620;  // world units from the left/right wall

// Where a faction's own field sits, as a fraction of its battery's
// reach. See the long note in worldgen.js — this is the home field,
// and the whole point of it is that it is *inside* the guns.
//
// 0.72 rather than something closer to 1.0 because a field has width:
// rocks scatter FIELD_SCATTER (130) around the centre, and a miner
// parks MINER_STANDOFF (120) short of them. At 0.72 × 430 ≈ 310 the
// far edge of the cluster still sits comfortably inside cover, so a
// miner working the outermost rock is defended rather than nearly
// defended. A home field that is only mostly covered is a home field
// that gets its miner killed at the far end.
export const HOME_FIELD_RANGE = 0.72;      // × battery range — where a home field is anchored
export const HOME_FIELD_ROCKS_MIN = 2;
export const HOME_FIELD_ROCKS_MAX = 3;

// ------------------------------------------------------------
// ECONOMY
// ------------------------------------------------------------
//
// The chain is: asteroid ore → drone → miner cargo → faction metal.
// Ore is conserved at every hop (there is a test for this).

// Ore moves in `rate × dt` slices, so a hold that is conceptually
// full or empty is almost never exactly `cargoMax` or exactly 0. Every
// "is it full", "is it empty" and "has it any room" test in the
// simulation is written against this tolerance, and they all have to
// agree: a miner that thinks it is full while its drones think it has
// room is a pair of state machines handing each other the same ship
// forever. One named number rather than fourteen copies of a literal.
export const CARGO_EPSILON = 1e-6;         // ore

export const MINING_RADIUS = 250;          // world units — drones only work this close to their miner
export const DRONES_PER_MINER = 2;         // drones a miner maintains
export const DRONE_LAUNCH_INTERVAL = 1.1;  // s between drone launches, so they leave in sequence

export const DRONE_CARGO = 12;             // ore per drone trip
export const DRONE_MINE_RATE = 1.5;        // ore/s pulled from a rock (≈8.0s of cutting beam per trip)
export const DRONE_UNLOAD_RATE = 10;       // ore/s transferred directly into parent miner while docked
export const DRONE_DOCK_OFFSET = 6;        // world units — distance from parent hull to drone berth
export const DRONE_DOCK_TOLERANCE = 10;    // world units — distance to berth required to count as docked

// A hold sized to the journey.
//
// On the old 2400-wide map a miner was never more than a few hundred
// units from its rocks, so 44 ore a trip was a steady rhythm. At 7200
// the round trip to the contested middle is around 100 s of pure
// travel, and a hold that small meant a miner spent most of its life
// commuting: ore mined across a run fell by 40% and both factions
// stalled on `cannot-afford-miner`.
//
// 90 is close to the point where travel and work take about the same
// share of a cycle, which is the right place for it to sit — much
// larger and a miner parks on a contested field for minutes at a
// time, which is not caution, it is a stationary target.
// How far an orphaned drone will look for a new parent before it
// gives up and fades.
//
// It lived as a bare `520` in behaviors/drone.js and is the third
// distance constant the map enlargement caught out — the others being
// ENGAGE_RADIUS and FIELD_SCORE_SOFTENING. Three to five miners now
// work fields spread over thirty million square units, so a radius
// tuned when the whole world was three million found nothing:
// `drone:orphan` became a state entered and never left, which
// `tests/sim.test.js` flags as a dead end, and every orphan in a run
// simply faded out.
//
// A drone crosses this in about eighteen seconds at cruise, against
// the roughly three seconds a fade takes — so a re-home is always the
// better outcome when one is available at all.
export const DRONE_REHOME_RADIUS = 1400;   // world units

// How fast a hauler empties a shed, and the smallest load worth
// sending one for. A trip made for fifty ore is a hull crossing the
// map to achieve nothing, which reads as busywork rather than logistics.
// How long a wreck drifts before its cargo is gone for good, and the
// smallest scrap worth diverting a hull for.
//
// Finite because a map slowly filling with permanent free ore removes
// the cost of losing a miner, and losing a miner is supposed to hurt.
// Ninety seconds is long enough that a hauler two thousand units away
// can still make it if it leaves now, which is the decision worth
// having.
export const WRECK_LIFE = 90;              // s before the ore is lost
export const WRECK_MIN = 25;               // ore below which nobody bothers

export const HAULER_LOAD_RATE = 90;        // ore/s out of an outpost
// Ore waiting before a run is called.
//
// This, and not the shed's capacity, is what decides how much a shed
// ever holds — a hauler launched at the old 140 emptied it before it
// could become anything, so a forward store sat at a mean of 97 ore
// against a 900 capacity and raising that capacity changed literally
// nothing (measured: identical numbers at 900, 1500, 2200 and 3000).
//
// At 400 a shed carries a mean of 281 and peaks past a thousand,
// which is the point: a forward store should be a *stockpile*, worth
// crossing the map to raid and a real loss when it burns. The cost is
// hauler traffic, and it is small — 21 runs per half hour became 18,
// because the ore still has to move either way. Pushing it to 700 is
// where it starts to hurt: 9 runs, and the route goes quiet.
export const HAULER_MIN_LOAD = 400;        // ore waiting before a run is called

// ------------------------------------------------------------
// THE EXCHANGE
// ------------------------------------------------------------
//
// A neutral station both sides trade at, inside a bubble nobody may
// shoot in. Placement is measured rather than chosen: the two
// stations sit on the horizontal midline, so anywhere on the
// perpendicular bisector is equidistant by construction, and the
// remaining question is how far off the axis to push it.
//
// At the exact centre a 700-unit no-fire bubble contained 13.5% of
// every shot fired in a run at 900 units, and 8.3% at 700 — the
// middle of the map is where the war is, and a sanctuary there
// quietly switches off an eighth of it. Off-axis is the whole
// finding, and the original 0.16 was measured against a map whose
// ore was richest at the *centre*.
//
// That gradient has since been rebased on distance from the nearest
// station, which moved the fighting into the horizontal middle band
// and left 0.16 in a dead corner: re-measured, the nearest round to
// land anywhere near the bubble was 1,130 units from its centre,
// 430 outside it. A sanctuary nothing ever approaches is not a
// sanctuary, it is scenery — the rule was correct and had stopped
// having any occasion to apply.
//
// 0.24 put it back on the shoulder of the war, and that turned out to
// be too close once warships started ranging properly: 1,368 rounds
// landed within half a radius of the boundary in three runs, so the
// market sat in the middle of a permanent brawl it was legally
// exempt from. A sanctuary should be somewhere apart that the war
// occasionally reaches, not a bunker in the centre of one.
//
// 0.13 is measured as the quietest of the candidates without making
// it unreachable — hits within half a radius fall to 495 and within
// one and a half radii nearly halve, while both fleets still trade
// there freely. Fighting near it did not need to be common for the
// no-fire rule to matter; it needed to be possible.
export const TRADE_HUB_INSET = 0.13;       // fraction of world height from the edge
export const SANCTUARY_RADIUS = 700;       // world units — no weapon fires inside this

// What a run to the exchange is worth.
//
// The premium is taken on at the hub and only becomes metal at home,
// which is the point: the return leg is flown by the most valuable
// hull on the map, outside the bubble, and everybody can see it
// leaving. A trade that paid out on arrival would be free money; this
// one is a decision with a journey attached.
//
// Capped by the hold, so a hauler that arrives full gains nothing and
// does not bother going. That is what keeps the rate self-limiting
// without a second constant to tune.
// A hauler arrives empty and leaves laden. There is no stake.
//
// Staking metal was the first design and the numbers killed it: a
// faction banks a median of 53 metal and spends it on hulls the
// moment it has it, so a caravan that had to put something up either
// never launched or competed with the fleet for it. Both are wrong —
// the exchange is meant to be a place a faction *gains* from, not
// another claim on a treasury that is already empty.
//
// So the market simply gives, out of a float that runs down and
// refills slowly. What makes it a contest rather than a fountain is
// that there is one float and two fleets drawing on it.
export const TRADE_RATE = 70;              // ore/s loaded while docked
export const TRADE_FLOAT = 16000;          // ore the market holds when full

// How fast the float recovers, and the number that decides what
// trade is *worth* relative to mining.
//
// Fast enough that the market is worth coming back to.
//
// It began at 0.6/s, sized so trade sat at about an eighth of the
// mining economy. In practice that made the float a one-shot: the
// first hauler to arrive emptied it and the next several crossed the
// map for nothing, which reads as a broken shop rather than a busy
// one. At 6/s it refills inside a minute, so the exchange is a place
// with stock rather than a race to be first.
export const TRADE_RESTOCK = 60;           // ore/s
export const TRADE_MIN_FLOAT = 150;        // below this, not worth the crossing

// The second ring a capital round leaves behind — see `spawnImpact`.
// Wider than the flash and lasting well past it, so a heavy hit is
// legible as a heavy hit after the sparks have died rather than only
// during the frame it landed.
export const SHOCKWAVE_RADIUS = 2.3;       // multiple of the impact ring
export const SHOCKWAVE_LIFE = 2.6;         // multiple of the impact ring's life
// A caravan is a *dedicated* run, not a stop on the way home.
//
// Routing haulers via the market on their way back from a shed was
// the obvious design and it never fired once: measured at the moment
// of loading, the trip home via the exchange had a median cost of
// 4.17x the direct one, and not a single run in three seeds came
// under 2.5x. Sheds sit on a faction's own frontier and its station
// sits behind them, so the market is never on the way and no
// threshold makes it so.
//
// What works instead is the first thing ever measured about haulers:
// they are idle 89% of the time. The crossing costs a faction
// nothing it was using.

// Where a forward store goes, and when.
//
// A faction plants one once its miners are consistently working
// beyond OUTPOST_TRIGGER of home — not at a chosen field, but at the
// *centroid of the far ones*, so the shed stays useful as individual
// clusters around it are stripped. Siting it on one field would
// strand it the moment that field ran dry, which is the failure the
// whole mechanism exists to answer.
// Taken from the measured frontier rather than guessed. Mean working
// distance runs 941u in the opening two minutes and reaches 1658u by
// twenty; at the 2100 this started at, the condition simply never
// became true and no shed was ever built. 1400 fires partway through
// a run, which is when a commute has actually become one.
export const OUTPOST_TRIGGER = 1400;       // world units of mean working distance
export const OUTPOST_MIN_HOME = 1000;      // never planted closer to home than this
// Nor closer than this to another shed.
//
// Down from 1600, which was a spacing for one depot rather than for
// a supply line: a station sits about three thousand units from the
// contested middle, so at 1600 there was room for exactly one shed
// between them and the second could never be sited anywhere legal.
export const OUTPOST_SPACING = 1150;

// How many miners must be commuting past everything this faction
// already has before it builds another shed — as a divisor, so 3
// means a third of them.
export const OUTPOST_SHARE = 3;

// How far inboard of its station a faction plants its yard. Inside
// the station's own battery cover on purpose — a factory is a thing
// you defend by keeping it behind you, not by arming it.
export const FACTORY_OFFSET = 420;         // world units

export const MINER_CARGO = 90;             // ore before returning to base
export const MINER_DEPOSIT_RATE = 17;      // ore/s transferred into the mothership (≈5.3s deposit)
export const MINER_STANDOFF = 120;         // world units — how far a miner parks from its field
export const MINER_DOCK_RANGE = 90;        // world units — close enough to unload

// A miner that has claimed a field holds it, so two miners do not
// pile onto the same rocks while others sit untouched.
export const CLAIM_TIMEOUT = 50;           // s before an unvisited claim lapses


// Miners run for home when armed enemies come near.
//
// Without this a miner simply stands at its rocks and is shot, and
// the simulation has no way back from a bad exchange: the losing
// faction's every replacement miner walks into the same raiders,
// so it never rebuilds an economy, never affords escorts, and
// stays pinned for the rest of the run. Observed play had one side
// on five miners and twelve fighters while the other held zero of
// each for fifteen minutes.
//
// A miner that flees turns that into a cycle instead. Raiders
// arrive, the miners scatter home, the raiders have nothing left
// to shoot and their leash pulls them back to their own convoy,
// and the miners come out again. The front line breathes.
export const MINER_FLEE_RADIUS = 340;      // world units — how far a miner watches for hostiles
export const MINER_FLEE_CHECK = 0.4;       // s between threat scans
export const MINER_SAFE_TIME = 7;          // s clear of threats before going back to work

// ------------------------------------------------------------
// PRODUCTION
// ------------------------------------------------------------

export const START_METAL = 70;             // metal each faction opens with

// The hulls each faction is given at t=0, placed rather than bought.
//
// Two miners so the economy is already turning, and two light haulers
// so there is freight on the map from the first second — a hauler
// with no shed to serve runs a caravan to the exchange, so the run
// opens with traffic rather than with a station saving up.
export const OPENING_FLEET = Object.freeze(['miner', 'miner', 'hauler', 'hauler']);
export const OPENING_STANDOFF = 110;       // world units off the station's hull
export const LAUNCH_SPEED = 70;            // u/s outward impulse when a hull leaves the bay
export const BUILD_ARC_FADE = 0.5;         // s the completed progress arc lingers

// Passive income at the mothership — salvage and drifting dust.
//
// This exists to make the simulation unkillable, not to matter.
// Without it a faction that loses its last miner while holding
// less than a miner's cost can never build anything again: the
// production policy blocks on the miner rule, no metal arrives,
// and that faction is a permanent inert hexagon for the rest of
// the run. At this rate a full recovery takes roughly two
// minutes, while a single healthy miner delivers more in one trip
// than this yields in that whole time — so it is a floor under a
// dead economy, and invisible to a live one.
export const MOTHERSHIP_TRICKLE = 0.35;    // metal/s

// Motherships knit themselves back together between assaults, so a
// raid that fails to finish the job achieves nothing lasting. The
// delay is what makes a *sustained* siege different from a passing
// skirmish: keep the pressure on and the repair never starts.
export const MOTHERSHIP_REPAIR = 9;        // hp/s
export const MOTHERSHIP_REPAIR_DELAY = 6;  // s without damage before repair begins

// If a faction does lose its station, a replacement arrives. The
// simulation is meant to be watched indefinitely, and a permanent
// one-faction end state is not a simulation, it is a screensaver
// of someone mining alone. Losing a mothership is a catastrophe
// that costs a faction its entire fleet and most of a minute —
// which is dramatic enough without being terminal.
export const FACTION_RESPAWN_DELAY = 45;   // s

// ------------------------------------------------------------
// COMBAT
// ------------------------------------------------------------

// How far a fighter looks for work.
//
// Raised with the map, and the reason is worth stating because the
// number itself did not become wrong — what it *means* did.
//
// A sensor range reads as a property of the ship, so the instinct is
// to leave it alone when the world grows. But how often two fleets
// meet is decided by the fraction of the map a hull can see, not by
// the figure in world units: 620 was 26% of the old 2400-wide world
// and became 8.6% of a 7200-wide one. Measured at the old value on
// the new map, six of twelve seeds ran seven minutes without a shot
// fired, and the ones that did fight took until 170–290 s to start.
// The fighters were not behaving differently; they had simply gone
// blind relative to the distances now involved.
export const ENGAGE_RADIUS = 1000;         // world units — how far a fighter looks for work
export const PATROL_RADIUS = 300;          // world units — idle orbit around own mothership
export const ESCORT_RADIUS = 155;          // world units — base station distance from the charge

// ------------------------------------------------------------
// ESCORT STATIONS
// ------------------------------------------------------------
//
// Escorts used to hold a trailing wedge: berths alternating left and
// right, each pair further back, exact to the world unit. It read as
// a *diagram*. Three things were wrong with it and all three are
// fixed by the same idea — a station is a region a hull is loosely
// responsible for, not a coordinate it sits on.
//
// It was behind. An escort's job is to meet trouble before it reaches
// the thing it is guarding, and trouble arrives from wherever the
// charge is going. Stations are now spread across a forward-weighted
// arc, so the screen sits ahead of and around a miner rather than
// trailing it like a tail.
//
// It was identical for every hull. Now there are three posts — see
// ESCORT_POSTS — and a squadron is a close guard, a picket well
// ahead, and outriders ranging wide.
//
// And it was perfectly still. Every station now drifts on its own
// slow cycle, keyed off the ship's id, so no two hulls breathe
// together and the formation never resolves into geometry.

/** Where each post sits, as multiples of ESCORT_RADIUS, and how it drifts. */
export const ESCORT_POSTS = {
    // Tucked in close, covering the charge itself.
    close: { radius: 1.0, arc: 1.5, drift: 0.16, rate: 0.23 },
    // Well ahead on the charge's heading: the early warning, and the
    // hull that meets anything coming the other way first.
    picket: { radius: 2.9, arc: 0.7, drift: 0.30, rate: 0.17 },
    // Ranging wide. Sweeps a broad arc off the flanks, so a threat
    // approaching from the side is met rather than noticed.
    outrider: { radius: 2.1, arc: 2.5, drift: 0.45, rate: 0.11 },
};

// How far forward the arc is weighted. At 1 the stations spread over
// the full circle; at 0.62 they crowd the forward two-thirds and
// nothing sits directly astern.
export const ESCORT_FORWARD_BIAS = 0.62;

// How far a picket or outrider will leave its station to look at
// something, and how long it may spend doing it.
//
// This is the difference between a screen and a wall. Every escort
// holding its post means a threat is only ever met at the charge; one
// hull going to *look* at something, deciding, and coming back is
// what makes a squadron read as a squadron with a scout rather than a
// formation with a gap in it.
//
// The leash still applies — an investigation is a detour, not a
// departure — and the timeout is what guarantees it ends. A picket
// that chases something interesting forever is just a fighter that
// left.
export const SCOUT_RANGE = 1500;           // world units from the charge worth looking at
export const SCOUT_TIMEOUT = 14;           // s before it gives up and rejoins
export const ESCORT_REFRESH = 4;           // s between re-picking who to escort

// What a miner's existing escorts are worth, in world units of extra
// distance, when another fighter is deciding who to guard.
//
// This is the number that spreads an escort force out. At zero every
// fighter picks the nearest miner and they pile onto whichever one is
// central; large, they scatter to miners they cannot reach in time.
// 900 says "a miner with one escort already is worth crossing another
// 900 units to avoid", which on this map splits a squadron across the
// two or three miners that are actually out working.
export const ESCORT_CROWDING = 900;        // world units per escort already assigned

// How much a miner's distance from home discounts its escort score —
// the surviving form of "guard the most exposed miner".
//
// It is a weight rather than a rule because as a rule every fighter
// in a faction computed the same maximum and the whole screen chased
// one hull. As a weight it biases the screen outward into contested
// space without stacking it, which is what keeps the two sides
// meeting: at 0.35 a miner three thousand units out is worth crossing
// an extra thousand to reach.
export const ESCORT_EXPOSURE = 0.8;       // fraction of distance-from-home

// How far a fighter will operate from whatever it is escorting.
//
// This one number is the difference between a simulation with
// tides and one with a winner. Without a leash nothing ever sends
// a victorious fleet home: it parks on the loser's doorstep and
// shoots each replacement hull as it launches, forever. Observed
// runs had one side sitting on fourteen fighters and a thousand
// unspent metal while the other never fielded a single escort for
// fifteen straight minutes.
//
// Leashing escorts to their charge fixes it at the root. Fighters
// defend what their faction is actually doing rather than chasing
// a beaten enemy home, so combat stays where the ore is, a broken
// faction gets the room to rebuild, and the front line moves back
// and forth instead of collapsing once.
// Scaled with ENGAGE_RADIUS above — see the note there. The ratio
// between the two is what matters: a leash shorter than the sensor
// range means a fighter routinely acquires targets it is not allowed
// to chase, which is the dithering `patrol` was rewritten to avoid.
export const ENGAGE_LEASH = 1300;          // world units from the escort anchor

// How far a swarm hull may stray from its squadron leader.
//
// Much tighter than a native escort's leash, and that difference is
// the characterisation. A faction's escorts are individuals with a
// job, free to chase a long way from the miner they are guarding; a
// swarm is a *thing*, and it should move like one body rather than
// like twelve ships that arrived together.
//
// At the native 1300 a wave dispersed from 434 units of spread to
// over 2,000 within thirty-five seconds — technically in formation,
// visibly a scatter. 520 keeps a squadron readable as a squadron
// while still letting individual hulls peel onto targets.
export const SQUAD_LEASH = 520;            // world units from the squad leader
// How closely a turret must be on its solution before it shoots.
// Tighter than a fighter's FIRE_CONE because a mount can actually
// aim — and because the half-beat where a gun settles before it
// fires is most of what makes a turret look like a turret.
export const TURRET_FIRE_CONE = 0.06;      // rad

// How far off the nose a firing solution may be before a hull stops
// trying to track it and simply flies the pass.
//
// A fighter holds its nose on a lead point that is recomputed every
// step against a moving target, and the bearing to that point sweeps
// faster and faster as the range closes — a pursuit curve. Inside the
// last few hundred units it sweeps faster than the hull can turn, so
// the demand saturates the turn rate and then *reverses* as the
// target crosses: measured in ENGAGE, 12.5% of steps pinned at the
// limit and 2.5% reversing direction, at 48 deg/s. That is the jerk.
// The hull was not fighting badly; it was being asked, every step,
// for something it could not do.
//
// Past this angle the hull gives up the solution and flies. Which is
// also what a pilot does, and what the fly-by was always supposed to
// look like: you track, you shoot, and then you are past it and you
// stop trying to look backwards.
export const AIM_TRACK_CONE = 0.85;        // rad

export const FIRE_CONE = 0.30;             // rad — half-angle the target must be inside to fire

// The numbers that shape an attack run.
//
// A fighter does not stop at its target; it aims at a point offset
// to one side of the gun solution, so the pass is a slice past the
// hull rather than a collision, and it keeps going until it is clear
// before turning back for another. The offset is small on purpose —
// wide enough that the two hulls never touch, tight enough that the
// whole pass stays inside weapon range.
export const FIGHTER_PASS_OFFSET = 24;     // world units — lateral offset of the pass point
export const FIGHTER_POINT_BLANK = 16;     // world units past the hull that counts as a pass, however it ended

// Break-off and extension, both as fractions of the *firer's own*
// weapon range — and the order between them is the whole point.
//
// A run ends once the fighter is opening and inside this fraction of
// its range; the extension then flies out until the target is beyond
// that one. Written as absolute world units the two drifted apart and
// nobody noticed: break-off sat at 0.75 × 330 = 247 while the
// extension asked for 190, so a fighter arrived in EXTEND already
// past the distance EXTEND existed to reach. Measured on seed 2: 72%
// of extensions ended on the step they began, median dwell one step.
// The state was entered 657 times in ten minutes and did nothing 473
// of them — a fighter that was supposed to zoom clear and loop back
// instead turned on the spot and re-entered the run.
//
// Range-relative rather than absolute because the alternative is a
// pair of numbers that hold for the pulse cannon and quietly stop
// holding for the first warship given a longer gun. The invariant —
// FIGHTER_EXTEND > FIGHTER_BREAKOFF — is checked in
// tests/guards.test.js, because it is exactly the kind of rule that
// is obvious once stated and invisible once violated.
export const FIGHTER_BREAKOFF = 0.75;      // × weapon range — closer than this, opening, and the pass is over
export const FIGHTER_EXTEND = 1.0;               // × weapon range — separation to reach before turning back

// Ceilings on the two legs, so neither can hang on a target that
// never behaves. A run that hits its ceiling never actually got
// there, which is why the transition records *which* limit ended it.
export const FIGHTER_RUN_TIMEOUT = 2.5;    // s — longest a single attack run may last
export const FIGHTER_EXTEND_TIMEOUT = 1.1; // s — longest a fighter spends gaining separation

// How far past ENGAGE_RADIUS a target may get before the chase is
// abandoned. Slack rather than a second radius: a target hovering on
// the boundary would otherwise be acquired and dropped every step.
export const PURSUE_DROP = 1.35;           // × ENGAGE_RADIUS

// How often each gun reconsiders who it is shooting at. Throttled
// because it is a broadphase query per hull, and because anything
// re-picking every step flip-flops between two equally scored
// targets and commits to neither.
export const FIGHTER_RETARGET = 0.55;      // s
export const BATTERY_RETARGET = 0.7;       // s — a station has more reach, so it can afford to look less often

// When a fighter breaks off to repair.
//
// Damage arrives in whole rounds, so a hull only ever *lands* on
// `hp - k × damage` — for a fighter under pulse fire that is
// 40, 33, 26, 19, 12, 5, dead. A threshold is therefore not a place a
// ship stops at, it is a place a ship jumps over, and the only figure
// that matters is which rung it lands on.
//
// At 0.25 the threshold was 10 hp, and 10 hp is unreachable: a fighter
// goes 12 (30%, still fighting) straight to 5 (12.5%), skipping the
// band entirely, and 5 hp is less than one more round. So the retreat
// began already dead. Measured over 20 seeds: median hull at the
// moment of entry 13% rather than the nominal 25%, and 65% of the 940
// retreats ended in death within half a second — median dwell 0.08 s.
// REGROUP was not a retreat that failed, it was a state hulls entered
// on the way to the floor, and docs/03-SIMULATION.md §3 described a
// mechanism that was firing at a tenth of its intended rate.
//
// 0.35 is 14 hp, which catches the 12 hp rung: two rounds of margin
// instead of none. Instant deaths fell 65% → 35% and retreats that
// actually got home rose 13% → 23%, at flat throughput (ore +0.4%,
// cargo lost in transit −6.6%). Hulls built rose 4.3% and hulls lost
// 3.7%: fighters that survive a retreat come back and fight again, so
// the fleet turns over faster. That is the mechanism working, not a
// regression to chase — the figure to watch is losses per engagement,
// not losses per run.
//
// The next rung up (0.50, catching 19 hp) buys 30% survival and makes
// things worse elsewhere: a faction that has lost every miner ends the
// run still at zero 89% of the time rather than 79%, because longer-
// lived fighters mostly extend the winner's reach. Preserving damaged
// hulls does not rescue a losing faction — see §5.
//
// `tests/guards.test.js` asserts the landing rung survives a round, so
// a new weapon whose damage re-partitions the hull cannot quietly put
// this back where it was.
// ------------------------------------------------------------
// INCURSION
// ------------------------------------------------------------
//
// How often something comes through, and how long the tear takes.
//
// The timings are the drama. RIFT_OPEN is dead time on purpose — the
// rift is visible and empty for six seconds before the first hull
// appears, which is the window the two fleets have to notice it,
// break off from each other and turn. Cut it and the swarm arrives
// into a battle nobody has reacted to; the moment worth watching is
// the reaction, not the arrival.
export const INCURSION_FIRST = 260;        // s before the first one
export const INCURSION_EVERY = 300;        // s between them thereafter
export const INCURSION_VARIANCE = 60;      // s either side, so it is never a metronome

// ------------------------------------------------------------
// THE ARRIVAL
// ------------------------------------------------------------
//
// There is no portal and no tear. A hull *drops out of warp*: it is
// simply there, already travelling several times faster than it can
// fly, and it sheds that speed over the next second and a half.
//
// The first version of this was a lens-shaped rip in space that
// widened, held and sealed. It was elaborate, it was carefully
// commented, and it looked terrible — a decorated hole is still a
// hole sitting on the map doing nothing, and the drama it was
// supposed to carry was all in the *geometry of the portal* rather
// than in the ships. Arrival is a thing ships do, not a thing a
// location does.
//
// The whole effect is now three numbers and it reads instantly: a
// flash, a streak that is long because the hull is genuinely moving
// that fast, and a hard deceleration you can watch bleed off. The
// speed is real — it is on the velocity, not on a shader — so the
// hull overshoots slightly, settles, and only then starts behaving.
export const WARP_SPEED = 5.2;             // × the hull's own cruise, at the instant it arrives
export const WARP_ARREST = 3.4;            // 1/s — how hard it sheds that speed
export const WARP_STREAK = 1.1;            // s the arrival streak and flash live for

// How the wave lands: a gap between hulls, and a ceiling on how long
// the whole arrival may take.
//
// The gap alone was the bug. At a flat 0.45 s a five-hull wave was in
// within two seconds and an eighty-hull wave took thirty-six — the
// same event playing out at wildly different tempos, and the big one
// dribbling in so slowly that its first arrivals were fighting before
// its last had left. A wave should read as one thing happening, so
// the gap is whatever fits the wave inside ARRIVAL_WINDOW, and the
// flat spacing survives only as the ceiling for small ones.
export const ARRIVAL_SPACING = 0.45;       // s between hulls, at most
export const ARRIVAL_WINDOW = 6.5;         // s the whole wave lands within
export const ARRIVAL_SPREAD = 420;         // world units the drop points scatter over

// The formation itself: how far apart hulls sit across the bearing,
// and how far back each rank is.
//
// Ranks are the other half of the same bug. The along-track offset
// was linear in arrival order — `-260 - spawned * 90` — so a wave of
// eighty trailed 7,460 units behind its drop point, most of a map,
// and the tail arrived somewhere else entirely. A wave now forms a
// *block*: it widens far faster than it deepens, so eighty hulls
// occupy a broad front about a thousand units deep instead of a
// queue stretching off the board.
export const ARRIVAL_FILE = 105;           // world units between hulls in a rank
export const ARRIVAL_RANK = 135;           // world units between ranks

// How much of a rank's spacing each hull is nudged by. A perfect
// lattice is the second way a wave reads as extruded rather than
// flown — the first being a single unbroken stream, which is what
// echelons below are for.
export const ARRIVAL_JITTER = 0.45;

// A wave arrives in echelons: a screen, then the heavies, then the
// rest. `GAP` is the pause between them, `DEPTH` how far behind the
// screen the heavies come through, and `SCREEN` what share of the
// light hulls lead rather than follow.
//
// Both were larger — a 2.4-3.6 s pause and 560 units of depth — and
// that read as the capitals being *late* rather than as following on.
// The beat only has to be long enough to see; past that it stops
// being one event with a shape and becomes two arrivals that happen
// to share a bearing.
export const ECHELON_GAP = 1.2;            // s between echelons
export const ECHELON_DEPTH = 290;          // world units further back
export const ECHELON_SCREEN = 0.65;        // share of the light hulls that lead

// How much of a wave is the heavy hull. Deliberately low: a swarm
// should read as a swarm, and the harvester is the exception that
// makes the rest look small rather than the backbone of the force.
export const HARVESTER_SHARE = 0.17;

export const INCURSION_WAVE = 6;           // hulls in the first wave
export const INCURSION_GROWTH = 3;         // more hulls each time

// How wildly a wave's size varies, and how much of it answers what is
// already on the board.
//
// A predictable ramp is a difficulty curve, and a difficulty curve is
// something a viewer learns and then stops watching. The range is
// deliberately lopsided — a wave can come in at a third of nominal or
// at twice it — so that "small raid" and "that is a lot of ships" are
// both things that happen, and neither is the one you expect.
//
// The upper end widens as the run goes on, because a late incursion
// arriving at early-game size is the swarm turning up to a battle it
// cannot affect.
export const INCURSION_MIN_SCALE = 0.35;
export const INCURSION_MAX_SCALE = 1.7;
export const INCURSION_MAX_GROWTH = 0.22;  // added to the upper scale per incursion

// How much of the *defenders'* strength a wave answers.
//
// Measured in metal-cost of every warship currently alive, both sides
// together — the swarm is everyone's enemy, so what it has to get
// through is the whole board. Without this a late incursion runs into
// two mature fleets and evaporates, which is the opposite of the
// moment it exists to create.
export const INCURSION_RESPONSE = 0.0055;  // hulls per metal of fleet on the board

// How long the natives stay friendly after the last alien dies.
// Ending a truce on the same step as the last kill reads as a switch
// being thrown; a pause reads as a ceasefire holding, then breaking.
export const TRUCE_GRACE = 12;             // s

// ------------------------------------------------------------
// UPKEEP
// ------------------------------------------------------------
//
// Metal per second, per metal of a hull's build cost, to keep it
// flying. A fighter costs 25 to build and 0.2/s to own.
//
// ------------------------------------------------------------
// WHY A FLEET HAS A PRICE AT ALL
// ------------------------------------------------------------
//
// Because without one, being ahead was free, and `maxAlive` was the
// only thing in the simulation deciding how large a fleet could get.
//
// A population cap is a bad ceiling for two reasons. It does not move
// with the economy, so a faction that has won the map and one that is
// scraping by are allowed exactly the same fleet — measured, the
// leader sat at its twelve-fighter cap 27% of the time with a median
// 342 metal it had nothing to spend on. And it makes every new hull
// class *additive*: give the corvette its own cap and a leader simply
// builds corvettes on top of a full wing of fighters, so a wider
// ladder is strictly more fleet rather than a choice between rungs.
//
// Upkeep replaces it with a ceiling that follows income. It is what
// makes "one corvette or three fighters" a real question — they cost
// nearly the same to keep — and what turns a surplus into something
// to spend rather than something to bank.
//
// `maxAlive` survives in the policy as a *safety* ceiling well above
// anything an economy can afford, so a runaway cannot spawn hulls
// until the frame budget dies.
export const UPKEEP_PER_COST = 0.004;      // metal/s per metal of build cost

// Seconds of current wages a faction must hold *on top of* a hull's
// price before it will build one. See the note in
// behaviors/mothership.js — this is what stops upkeep collapsing into
// a poverty trap where fleets grow until income is entirely consumed.
// Seconds of its own wages a faction must hold before it stops
// counting as poor. Below this it prioritises income and protecting
// income over adding to the fleet — see `faction.lean`.
export const LEAN_RUNWAY = 20;             // s of upkeep

// What the garrison and raiding shares are multiplied by while a
// faction is lean. The hulls that would have taken those duties
// become escorts instead.
export const LEAN_DUTY_SHIFT = 0.5;

// How near a fight has to be before a hull breaks off to join it.
//
// Measured from the ship, not from its station. Deliberately larger
// than ENGAGE_RADIUS — the point is to reach hulls that cannot yet
// see the fight themselves — and well short of the map, so a battle
// draws in the neighbourhood rather than the whole fleet.
export const ASSIST_RANGE = 2400;          // world units

export const UPKEEP_RUNWAY = 45;           // s of upkeep held in reserve

// ------------------------------------------------------------
// POSTURE
// ------------------------------------------------------------
//
// What a whole faction is trying to do. See sim/posture.js for the
// rules; these are the numbers they play by.
//
// The two ratio pairs are *bands*, and the gap between entry and exit
// is the entire reason they are pairs. A single threshold means a
// faction sitting on it oscillates, and a fighter's anchor changes
// with posture — so oscillation is not a cosmetic wobble, it is a
// fleet flying back and forth across the map without arriving.

// Fleet strength ratio (own ÷ everyone hostile) to commit to a siege,
// and the slacker ratio it must fall below to break one off. Entry is
// deliberately high: throwing a fleet at a defended station is the
// most expensive thing a faction can do, and it should take a real
// advantage rather than a marginal one.
//
// ------------------------------------------------------------
// WHY SIEGE_EXIT MUST NOT EQUAL RAID_ENTER
// ------------------------------------------------------------
//
// They were both 1.4, and that single coincidence was why the
// strategy layer had five postures and used two. Measured over six
// seeds and half an hour each: siege 63%, expand 22%, rebuild 8%,
// defend 6%, **raid 1%**.
//
// The bands were touching. A faction breaking off a siege at 1.39 was
// below RAID_ENTER on the same step, so it fell straight past raiding
// into EXPAND — the entire raid band sat inside the siege's hold, and
// the only way into RAID was climbing through 1.4 from below without
// overshooting 2.0, which a fleet exchange almost never does.
//
// Now they are separated, so a decaying siege lands in a raid: the
// faction stops throwing itself at the station and goes back to
// hunting miners, which is the natural way for an offensive to wind
// down rather than to switch off.
//
// SIEGE_ENTER also moved 2.0 → 2.6. At 2.0 a run's ordinary
// lopsidedness — fleet counts of 13v46 and 10v61 are routine — put a
// faction over the line most of the time, so "besieging" stopped
// meaning anything. A siege should be what a decisive advantage buys,
// and everything short of decisive is a raid.
export const SIEGE_ENTER = 2.6;
export const SIEGE_EXIT = 1.9;

// The same for pushing out to hunt miners. Much lower, because
// raiding is what a faction with any advantage at all should be
// doing — it is the ordinary business of being ahead, and it now owns
// the whole wide middle of the range from a slight edge to a
// commanding one.
export const RAID_ENTER = 1.25;
export const RAID_EXIT = 1.05;

// What share of a fleet joins the strike detachment — the hulls that
// go after the enemy's miners in RAID while the rest keep escorting
// their own. Rolled per hull at spawn, so a squadron's composition is
// fixed for its life.
//
// At 1.0 (every fighter raids) both economies collapse: ore extracted
// falls 22%, ore destroyed in transit triples to 11% of everything
// mined, and every faction ends every seed under eighty metal. The
// disruption is real and it is mutual, which is not a war, it is a
// famine. Half keeps the pressure and leaves an economy to pressure.
// ------------------------------------------------------------
// WAR FOOTING — THE WAY BACK
// ------------------------------------------------------------
//
// A faction that has held *no warships at all* for this long is not
// losing a war, it is being held under water — the exact failure
// docs/03-SIMULATION.md §5 spent so long measuring. Every mechanism
// aimed at it so far protects the rebuild (the home field, the
// battery, wings); this one pays for it.
//
// It is a *subsidy*, not a gift. No hulls appear from nowhere: the
// yard simply works faster and cheaper, and stops paying wages, while
// the faction is destitute. So a comeback is still something the
// faction does — it still has to mine, still has to survive the
// build, and still has to hold what it makes — and the run gets a
// visible turn rather than a slow suffocation.
//
// The exit is hysteretic like every other band in the project: it
// takes zero warships to start and several to stop, so a faction that
// builds one hull and loses it does not lose the subsidy with it.
export const CATCHUP_DELAY = 100;          // s at zero warships before it engages
export const CATCHUP_EXIT = 4;             // warships held before it lifts
export const CATCHUP_COST = 0.55;          // × build cost while mobilised
export const CATCHUP_BUILD = 0.45;         // × time in the bay

// ------------------------------------------------------------
// DUTY — WHAT A WARSHIP IS *FOR*
// ------------------------------------------------------------
//
// Every armed hull is rolled into one of three standing duties when
// it is built, and it keeps that duty for life.
//
// Before this, posture moved the *entire* fleet at once: a faction
// that decided to besiege sent everything it owned across the map,
// and its stations, its miners and its home field were left with
// nothing at all. That is not a strategy, it is an all-in bet made
// several times a run — and it is why a counter-raid against a
// committed besieger was so devastating that the besieger usually
// lost more than it gained.
//
// Splitting the fleet by duty makes an offensive a *commitment of
// part of a force* rather than an evacuation. A garrison that never
// leaves means a station is never naked; an escort screen that never
// joins a siege means the economy keeps running while the war is
// away. What a posture now moves is the striking half.
//
// The three shares are rolled independently per hull rather than
// balanced exactly, so a fleet's composition drifts a little — which
// reads as an organisation making do rather than as a formation
// assembled from a table.
export const GARRISON_SHARE = 0.25;        // never leaves the station

// How long a home-guard hull holds one post before moving to the
// next. Long enough that it is clearly *stationed* there rather than
// passing through, short enough that the circuit reads as a circuit.
// How close counts as being *at* a post. The dwell below starts when
// a hull gets inside this, not when it was told to go.
export const GARRISON_ARRIVE = 420;        // world units

// How many guards a station is worth relative to a forward store.
// Above 1 because a station is the bigger prize and has more approach
// bearings to cover; low enough that sheds are genuinely posted to
// rather than visited.
export const GARRISON_HOME_SHARE = 1.6;

export const GARRISON_DWELL = 26;          // s

// The alarm: how long a battle stays "current", and how far a home
// guard will travel to join one.
//
// A garrison that never leaves is a garrison that watches its fleet
// die within sight of its post. A garrison that leaves for anything
// is not a garrison. The response radius is what separates the two —
// far enough to reach a fight over the home field or a nearby shed,
// short enough that a raid on the far frontier does not strip the
// station bare.
export const ALARM_MEMORY = 14;            // s a battle stays worth answering
export const GARRISON_RESPONSE = 2600;     // world units a guard will travel to it
export const RAID_SHARE = 0.18;            // hunts enemy miners; the rest escort

// How many hulls a hunting party wants before it stops recruiting,
// and how strongly they pull together to get there.
//
// Crowding and cohesion are the same term with opposite signs, and
// which one applies is the whole difference between a screen and a
// squadron. Escorts *spread* — a second guard on an already-guarded
// miner is worth less than a first guard on an unguarded one. Hunters
// must do the reverse: a lone fighter sent at an escorted miner is a
// donation. Measured with the escort rule applied to both, 82% of
// hunting "squadrons" were a single hull.
//
// So a prey target that already has hunters is *more* attractive
// until it has SQUADRON_SIZE of them, and repellent after — which
// forms parties of about three and then starts another one somewhere
// else, without anybody counting hulls into groups.
export const SQUADRON_SIZE = 3;            // hulls a hunting party recruits to
export const HUNT_COHESION = 1400;         // world units of pull toward a party still forming

// How long a posture must hold before it may change again. Emergencies
// (DEFEND, REBUILD) ignore this; a station under fire cannot wait out
// a timer. Everything else waits, so one bad exchange cannot swing a
// faction's whole strategy and then swing it back.
export const POSTURE_DWELL = 8;            // s

// A siege is a commitment, and these two numbers are what make it one.
//
// SIEGE_RALLY_SHARE is how much of a faction's own strength must be
// gathered at its station before the fleet sets out. Without it every
// hull left from wherever it happened to be standing and arrived
// alone: measured across four seeds, a besieging "fleet" was spread a
// median 1,131 units from its own centroid, and a corvette
// intercepted halfway across the map had no support because there was
// no fleet, only a queue.
//
// SIEGE_COMMIT is the minimum a siege lasts once under way. It exists
// because the crossing takes longer than the posture did: a corvette
// needs about fifty seconds to cross the map and the median siege
// lasted twenty-two, so attrition en route dropped the strength ratio
// below SIEGE_EXIT and cancelled the assault before anyone arrived.
// Nine of twenty-five sieges reached the station at all. Losses that
// buy nothing are the worst possible trade, and a fleet that turns
// back at the halfway point has paid for a siege without having one.
//
// DEFEND still overrides both — a station being attacked at home
// outranks an attack being made abroad.
export const SIEGE_RALLY_SHARE = 0.45;     // fraction of own strength gathered before departure
// 120 s, because the rally and the crossing both have to fit inside
// it. At 75 the fleet could spend up to MUSTER_TIMEOUT gathering and
// then had less time left than the crossing takes, so sieges expired
// in transit even more often than before the rally existed — three of
// twenty-five arrived, against nine without it.
export const SIEGE_COMMIT = 120;           // s a siege runs before it may be reconsidered

// And how long a faction must do something else before it may mount
// another one.
//
// Separating the bands took RAID from 1% of faction-time to 12%, and
// then the thresholds stopped helping: pushing SIEGE_ENTER from 2.6
// to 3.2 and 3.8 *raised* the siege share to 56% and 57%, because a
// winning faction's strength ratio runs at three to six and clears
// any threshold you can reasonably set. The band was never the thing
// keeping it there.
//
// What keeps it there is that nothing stops a siege following a
// siege. A fleet that has just spent two committed minutes throwing
// itself at a station has taken losses, is scattered across the map
// and is a long way from home — "immediately do that again" is the
// one thing it plausibly cannot do. So it raids instead, which is
// what a fleet in that state actually would do: stay out, hunt the
// soft targets, and rebuild the advantage before committing again.
export const SIEGE_COOLDOWN = 100;         // s after a siege before another may begin

// What counts as trouble at the front door.
export const DEFEND_RANGE = 900;           // world units around a station
export const DEFEND_MEMORY = 8;            // s since the station was last hit

// How close a besieging fighter orbits the station it is attacking.
//
// Inside a pulse cannon's 330 reach, because a siege that cannot hurt
// the thing it is besieging is a parade. That also puts it inside the
// battery's 430, which is the point: pressing the advantage is meant
// to cost hulls, and a station is meant to be the one place its owner
// is strong.
export const SIEGE_STANDOFF = 300;         // world units

// ------------------------------------------------------------
// WINGS
// ------------------------------------------------------------
//
// New hulls wait at the station until enough of the fleet has
// gathered, then leave together. The reasoning is in `fleetBalance`
// in sim/simulate.js and in the MUSTER note in behaviors/fighter.js;
// these are the four numbers it plays by.
//
// All strengths are metal-cost, so a fighter is 25 and every future
// hull class is whatever `data/ships.js` says it is worth.

// How much of the strength deficit a wing tries to cover before it
// sorties. A faction 100 behind masses 60 — enough to arrive as a
// formation rather than a queue, and short of the full deficit on
// purpose, because a wing that waits to reach parity never launches
// at all while the enemy is still building.
export const MUSTER_DEFICIT_SHARE = 0.6;

// The ceiling on that, whatever the deficit. Four fighters. A faction
// being crushed must still commit something: a hull held back for a
// reinforcement that is never coming is worth strictly less than one
// defending the station badly.
export const MUSTER_MAX = 100;             // metal-cost of gathered strength

// Nobody waits forever. A wing that has not reached its target by
// this point leaves anyway, and the transition records that it was
// the clock rather than the muster that released it — so a run where
// this fires constantly is legible as one where the rule is not
// working, instead of looking like the rule working.
export const MUSTER_TIMEOUT = 28;          // s

// Station under fire releases the wing immediately, wherever it had
// got to. Mustering hulls are already in the right place to defend —
// standing in formation while the thing you are standing on is being
// shot is the one behaviour this rule must never produce.
export const MUSTER_ALERT_RANGE = 520;     // world units around the station

export const RETREAT_HP = 0.35;            // fraction of max hp that sends a fighter home
export const REJOIN_HP = 0.6;              // fraction it must recover past before re-engaging
export const HULL_REPAIR_RATE = 2.4;       // hp/s while docked at own mothership

// Threat weights drive target selection: score = weight / distance.
// Drones are cheap, miners are the economy, motherships are the
// win condition but take a fleet to crack — so fighters swat
// escorts first and only commit to the big target when nothing
// else is in reach.
export const THREAT_WEIGHT = {
    fighter: 1.0,
    miner: 0.85,
    // A laden hauler is the most valuable thing on the map and cannot
    // fight back, so it outranks even a miner. That single number is
    // what turns a freight route into a reason to be somewhere.
    hauler: 0.95,
    drone: 0.35,
    // Nothing shoots at debris. Zero rather than absent so the guard
    // that every role carries a weight still passes, and so a future
    // reader does not wonder whether it was forgotten.
    wreck: 0,
    // A yard is worth more than a shed and less than a station: it
    // cannot repair itself, and killing one takes a faction's heavy
    // hulls off the board for as long as it takes to build another.
    factory: 0.75,
    // The exchange is not a target. Zero for the same reason as a
    // wreck — the guard wants every role to carry a weight — but it
    // is belt and braces here, because `pickTarget` refuses anything
    // inside a sanctuary before it ever consults this table.
    exchange: 0,
    // Above a station, below a ship. A shed cannot repair itself and
    // strands a whole mining operation when it dies, so it is worth
    // stopping for — but not worth ignoring a live escort to reach.
    outpost: 0.7,
    mothership: 0.5,
};

// ------------------------------------------------------------
// FEEL
// ------------------------------------------------------------

export const RECOIL_KICK = 2.2;            // world units the hull slides back on firing
export const RECOIL_DECAY = 0.82;          // per step — springs home in ~15 steps
export const BANK_MAX = 0.34;              // rad — visual roll into a turn
export const BANK_RATE = 6.0;              // 1/s — how quickly roll follows turn rate
export const THRUSTER_SMOOTH = 9.0;        // 1/s — plume responsiveness

// ------------------------------------------------------------
// EVASION
// ------------------------------------------------------------
//
// How far ahead a hull looks for incoming fire, and how near a round
// has to be passing before it bothers.
//
// The horizon is in *seconds to closest approach*, not in distance,
// which is the whole point: it makes evasion a property of how long
// you have rather than of how far away the round is. A pulse round at
// 620 u/s covers its own engagement in a blink and this will scarcely
// move a hull — correct, a bullet that fast is not dodgeable. A
// future torpedo at 180 u/s spends over a second in the same window
// and gets jinked away from properly, with no new code and no entry
// in a table of what-dodges-what.
export const EVADE_HORIZON = 0.55;         // s to closest approach
export const EVADE_MARGIN = 26;            // world units past the hull that still counts as a near miss

export const SEPARATION_RADIUS = 34;       // world units — personal space between hulls
export const SEPARATION_FORCE = 230;       // u/s²

// ------------------------------------------------------------
// PARTICLES
// ------------------------------------------------------------

export const SPARKS_PER_HIT = 4;
export const SPARK_LIFE_MIN = 0.22;        // s
export const SPARK_LIFE_MAX = 0.46;        // s
export const SPARK_SPEED_MIN = 55;         // u/s
export const SPARK_SPEED_MAX = 165;        // u/s
export const SPARK_DRAG = 2.6;             // 1/s exponential damping

export const DEBRIS_SHARDS_MIN = 2;
export const DEBRIS_SHARDS_MAX = 4;
export const DEBRIS_LIFE = 2.4;            // s
export const DEBRIS_DRIFT = 34;            // u/s
export const DEBRIS_SPIN = 1.5;            // rad/s

export const MUZZLE_LIFE = 0.07;           // s
export const IMPACT_LIFE = 0.18;           // s
export const IMPACT_RADIUS = 9;            // world units at full expansion
export const DEATH_RING_LIFE = 0.55;       // s
export const DEATH_RING_RADIUS = 2.6;      // multiplier on hull radius

// Hard ceilings. The sim degrades by dropping the oldest effect
// rather than by dropping frames.
export const MAX_PARTICLES = 900;
export const MAX_PROJECTILES = 500;
