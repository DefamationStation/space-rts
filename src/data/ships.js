// ============================================================
// SHIPS — REGISTRY
// ============================================================
//
// One entry per hull class. This table plus a draw function in
// `render/hulls.js` plus a line in `data/production.js` is the
// entire cost of adding a ship. See docs/04-COOKBOOK.md.
//
// ------------------------------------------------------------
// THE SCALE LADDER
// ------------------------------------------------------------
//
// `radius` is not just a hitbox — it is the ship's place in the
// visual hierarchy, and the ladder is deliberately sparse so that
// two classes are never ambiguous at a glance:
//
//   drone 4.5 · fighter 9 · miner 12 · corvette 16 · frigate 22
//   · destroyer 30 · factory 34 · exchange 38 · mothership 40
//
// A new class picks an unoccupied rung. Two classes at the same
// radius must differ by silhouette alone, which is a much harder
// design problem than it sounds — prefer a free rung.
//
// ------------------------------------------------------------
// FIELDS
// ------------------------------------------------------------
//   role       which BEHAVIORS entry drives it
//   radius     world units, hull half-width; see ladder above
//   hp         hull points
//   speed      u/s cruise ceiling
//   accel      u/s² thrust from the main drive
//   thrust     where that thrust can point; see below
//   turnRate   rad/s — finite for everything; nothing snaps
//   cost       metal to build
//   buildMs    time in the bay
//   weapon     key into WEAPON_TYPES, or null
//   cargo      ore capacity, or 0
//   immobile   true for structures
//   escorts    0..1 — how readily this class is assigned to guard a
//              miner. Omit and the class never escorts one.
//
// ------------------------------------------------------------
// THE THRUST ENVELOPE
// ------------------------------------------------------------
//
// `accel` alone would describe a ship that pushes equally hard in
// every direction, which is what made the fleet look like it was
// sliding on ice. `thrust` says where the engines actually are, as
// fractions of `accel`: `main` out the back, `retro` at the nose,
// `lateral` on the flanks. Omit it and THRUST_PROFILE applies.
//
// It is a character sheet as much as a physics table. A wide
// envelope reads as nimble and machine-like; a narrow one reads as
// heavy and committed, because every course change has to be
// spent as a turn first. Warships get the narrowest envelope in
// the game on purpose — a fighter should look like it is *flying*.

import { MINER_CARGO, DRONE_CARGO, TRADE_FLOAT } from '../core/constants.js';

export const SHIP_TYPES = {

    // --------------------------------------------------------
    // MOTHERSHIP — the faction itself
    // --------------------------------------------------------
    // Static, tough, and the only thing that can build.
    //
    // The hull pool is deliberately enormous — a fighter's pulse
    // cannon needs well over three hundred hits — because a
    // mothership has to be a *siege*, not a target. At 900 hp a
    // fleet of eight fighters levelled one in about twelve seconds,
    // which turned every run into a single decisive rush; at 2600,
    // combined with the self-repair in behaviors/mothership.js,
    // cracking one takes a sustained committed assault and a raid
    // that gets driven off heals away. That is the difference
    // between a simulation with tides in it and one with a winner.
    mothership: {
        id: 'mothership',
        role: 'mothership',
        label: 'mothership',
        radius: 40,
        hp: 2600,
        speed: 0,
        accel: 0,
        turnRate: 0,
        cost: 0,
        buildMs: 0,
        // The ring battery stays as the hull weapon: it bears in every
        // direction with no traverse at all, which is right for a
        // building and is what makes a station dangerous to *approach*
        // rather than dangerous to be in front of.
        weapon: 'battery',
        cargo: 0,
        immobile: true,

        // ------------------------------------------------------
        // THE FORTRESS
        // ------------------------------------------------------
        //
        // Six emplacements around the ring, and they are what turn a
        // station from a thing with a lot of hit points into a place
        // you do not go.
        //
        // The composition is deliberate. Four missile rails cover
        // overlapping arcs, so anything approaching from any bearing
        // is inside at least two of them and a committed run eats
        // several salvos on the way in. Two torpedo tubes face out
        // along the axis the enemy actually comes from — they are the
        // punishment for flying straight at a station, which is what a
        // siege necessarily does.
        //
        // A station cannot turn, so unlike a frigate it can never
        // unmask a battery by manoeuvring. Its arcs are its arcs
        // forever, and the overlap is how it compensates.
        mounts: [
            { x: 30, y: 12, rest: 0.35, arc: 1.5, traverse: 1.1, weapon: 'missile' },
            { x: 30, y: -12, rest: -0.35, arc: 1.5, traverse: 1.1, weapon: 'missile' },
            { x: -30, y: 12, rest: 2.79, arc: 1.5, traverse: 1.1, weapon: 'missile' },
            { x: -30, y: -12, rest: -2.79, arc: 1.5, traverse: 1.1, weapon: 'missile' },
            // Tubes forward-oblique, not abeam.
            //
            // These were at rest ±1.57 with a 1.2 arc — pointing
            // squarely off the beam, unable to reach the axis the
            // enemy actually arrives along. Against eight fighters
            // pressing an attack they fired *zero* torpedoes in
            // seventy seconds, which is a weapon that exists only in
            // the data table. Stations sit on the left and right walls
            // and everything comes at them from inboard; the tubes
            // face that way now.
            { x: 26, y: 22, rest: 0.70, arc: 1.30, traverse: 0.8, weapon: 'torpedo' },
            { x: 26, y: -22, rest: -0.70, arc: 1.30, traverse: 0.8, weapon: 'torpedo' },
        ],
    },

    // --------------------------------------------------------
    // MINER — the economy
    // --------------------------------------------------------
    // Slow, blunt, defenceless. Carries drones out to a field,
    // holds station while they work, hauls the load home. Its
    // cargo pods fill visibly as it works.
    //
    // A working tug: enough jet authority to hold a berth against a
    // drifting station, not enough to dodge anything.
    //
    // The retro pack is the fraction that matters most here, because
    // a miner spends its life stopping — on a rock field, on a
    // berth, on its station with a full hold. Nothing in the fleet
    // turns around to brake (see FACE_LOOKAHEAD), so this number alone
    // decides whether a laden miner can stop in the distance its
    // approach gives it. At 0.30 it comes in level and settles; it
    // is the class that leans on its bow thruster hardest, lighting
    // it on four fifths of every deceleration it makes.
    miner: {
        id: 'miner',
        role: 'miner',
        label: 'miner',
        radius: 12,
        hp: 70,
        speed: 62,
        accel: 105,
        thrust: { main: 1.0, retro: 0.30, lateral: 0.20 },
        turnRate: 1.7,
        cost: 40,
        buildMs: 6000,
        weapon: null,
        cargo: MINER_CARGO,
    },

    // --------------------------------------------------------
    // DRONE — free, disposable, everywhere
    // --------------------------------------------------------
    // Spawned by miners rather than by a mothership, so it has no
    // cost and never appears in the production policy. Quick and
    // twitchy — the only thing in the project allowed to look busy,
    // because a swarm of small fast things around a slow big thing
    // is what makes the slow big thing read as heavy.
    //
    // The widest envelope in the game, and the only one that is a
    // gameplay requirement rather than a character note: a drone
    // spends its life creeping onto a rock face and settling into a
    // berth on a moving parent, and both are pure translation at
    // walking pace. Give it a warship's envelope and it can neither
    // dock nor hold station. Being visibly holonomic also sells it
    // as a machine among crewed ships.
    drone: {
        id: 'drone',
        role: 'drone',
        label: 'drone',
        radius: 4.5,
        hp: 12,
        speed: 78,
        accel: 190,
        thrust: { main: 1.0, retro: 0.55, lateral: 0.50 },
        turnRate: 3.8,
        cost: 0,
        buildMs: 0,
        weapon: 'mining',
        cargo: DRONE_CARGO,
    },

    // --------------------------------------------------------
    // FIGHTER — the escort
    // --------------------------------------------------------
    // The narrowest envelope in the game, and the class the flight
    // model was rebuilt for. All of a fighter's power is out the
    // back, so while it holds its nose on a target it has nothing
    // but flank jets to steer with and must fly the fight on
    // momentum it built before the shooting started. That is the
    // difference between a dart and a hovering gun platform.
    fighter: {
        id: 'fighter',
        role: 'fighter',
        label: 'fighter',
        radius: 9,
        // 110, up from 40, and the number came from solving the
        // retreat guard rather than from taste.
        //
        // At 40 a fighter's retreat band sat at 14 hp while the
        // routine weapons had grown to 9 damage a round — so a hull
        // that broke off died to the next hit. Measured on one seed:
        // thirty-five fighters entered REGROUP over twenty minutes and
        // *one* came out. The mechanism was not misfiring; it was
        // firing into a journey nobody survives.
        //
        // 110 puts the landing rung at 38 against the heaviest routine
        // weapon, which is three more rounds plus eleven hp of slack.
        // The value is picked from the passing set rather than rounded
        // to something tidy: the rung is modular arithmetic, so 90
        // fails where 82 and 110 pass, and a "nicer" number is not
        // safer. See tests/guards.test.js.
        hp: 110,
        speed: 132,
        accel: 235,
        thrust: { main: 1.0, retro: 0.22, lateral: 0.16 },
        turnRate: 3.3,
        cost: 25,
        buildMs: 3500,
        weapon: 'pulse',
        cargo: 0,
        // The escort, and the only class that always is one.
        escorts: 1.0,
    },

    // --------------------------------------------------------
    // CORVETTE — the line ship
    // --------------------------------------------------------
    // The first hull on a reserved rung of the scale ladder, and the
    // first that is a *decision* rather than an addition: it costs
    // nearly three fighters to build and nearly three to keep, so a
    // faction fielding corvettes is fielding fewer fighters.
    //
    // It reuses the fighter's behaviour wholesale — `role: 'fighter'`
    // — which is the claim `docs/04-COOKBOOK.md` makes about what a
    // new class should cost, tested here for the first time. What
    // makes it feel different is not new code but the numbers: it
    // accelerates and turns appreciably worse than a fighter, so it
    // commits to an attack run much earlier and cannot re-aim
    // mid-pass, and its lance is a slow heavy shell rather than a
    // stream of light ones.
    //
    // The envelope is a shade wider than a fighter's in retro and
    // flank, and that is not a contradiction of the "warships get the
    // narrowest envelope" rule — a bigger hull carries more
    // manoeuvring thrusters. It is still nowhere near a drone's, so a
    // corvette reads as heavy and committed, which is the whole point
    // of putting it on a different rung.
    corvette: {
        id: 'corvette',
        role: 'fighter',
        label: 'corvette',
        radius: 16,
        hp: 190,
        speed: 96,
        accel: 150,
        thrust: { main: 1.0, retro: 0.28, lateral: 0.20 },
        turnRate: 2.0,
        cost: 70,
        buildMs: 9000,
        // The lance stays fixed and forward. A corvette is still a
        // ship that *aims itself* — that is its character, and the
        // reason it commits to an attack run the way it does.
        weapon: 'lance',
        cargo: 0,
        // Occasionally, and no more than that. A corvette on escort
        // duty is a corvette not holding a line somewhere, and its
        // fixed forward lance is poorly suited to defending something
        // that is being circled.
        escorts: 0.22,

        // Two light turrets in the sponsons, and they exist for what
        // the lance cannot do: a fighter that has slipped inside the
        // corvette's turn is untouchable by a fixed gun and is
        // precisely what these are for. Wide arcs, quick traverse,
        // covering the flanks the main gun has given up on.
        mounts: [
            { x: 6.0, y: 6.4, rest: -0.9, arc: 1.6, traverse: 2.6, weapon: 'flak' },
            { x: 6.0, y: -6.4, rest: 0.9, arc: 1.6, traverse: 2.6, weapon: 'flak' },
        ],
    },

    // --------------------------------------------------------
    // FRIGATE — the escort killer
    // --------------------------------------------------------
    // The third rung, and the one that closes a triangle rather than
    // extending a line. A ladder where each rung simply beats the one
    // below is not a ladder, it is a queue — whoever can afford the
    // top of it wins, and the classes underneath become a tax you pay
    // on the way there.
    //
    //   fighter  → corvette   agile enough that a slow lance shell's
    //                         lead solution is stale before it lands
    //   frigate  → fighter    flak arrives too fast to dodge or
    //                         out-manoeuvre
    //   corvette → frigate    outranges it by 160 units and can shell
    //                         it from outside flak's reach
    //
    // None of that is written down as a rule anywhere. It falls out of
    // projectile speed against target agility, and out of one gun
    // reaching further than another — which means it can be *measured*
    // as a hit rate rather than asserted, and a future hull slots into
    // the same physics instead of needing a new table.
    //
    // Slow, heavily built, and the widest turn in the fleet: a frigate
    // that has committed to a direction is committed for a while. It
    // is a hull you position rather than one you fly.
    frigate: {
        id: 'frigate',
        role: 'fighter',
        label: 'frigate',
        radius: 22,
        hp: 360,
        speed: 78,
        accel: 120,
        thrust: { main: 1.0, retro: 0.32, lateral: 0.22 },
        turnRate: 1.5,
        cost: 150,
        buildMs: 15000,
        // No nose gun at all. Everything a frigate has is on a mount,
        // which is what makes it read as a warship rather than a large
        // fighter — it never needs to point at what it is killing.
        weapon: null,
        cargo: 0,
        // Rare. A frigate exists to hold ground, and a miner does not
        // hold ground — it wanders off to the next rock. Anything
        // heavier than this never escorts at all, simply by having no
        // `escorts` entry: the ladder's top is for the line, not for
        // babysitting.
        escorts: 0.06,

        // Six flak mounts, three a side, resting splayed outboard.
        //
        // `rest` is the bearing a gun returns to when idle and `arc`
        // is how far either side of it the mount can traverse — both
        // hull-local, so they turn with the ship. A port mount cannot
        // bear to starboard at all, which is the entire reason a
        // frigate has a *broadside* rather than a firepower number:
        // catch it beam-on and half its guns are pointing at empty
        // space until it turns.
        //
        // The forward pair sit closer to the centreline and cover a
        // wider arc, so a frigate driving at something still has
        // guns on it; the after pairs are progressively more lateral.
        mounts: [
            { x: 8.5, y: 7.0, rest: -0.55, arc: 1.35, traverse: 2.2, weapon: 'flak' },
            { x: 8.5, y: -7.0, rest: 0.55, arc: 1.35, traverse: 2.2, weapon: 'flak' },
            { x: 1.0, y: 7.4, rest: -1.35, arc: 1.25, traverse: 2.0, weapon: 'flak' },
            { x: 1.0, y: -7.4, rest: 1.35, arc: 1.25, traverse: 2.0, weapon: 'flak' },
            { x: -6.5, y: 7.4, rest: -2.05, arc: 1.20, traverse: 1.9, weapon: 'flak' },
            { x: -6.5, y: -7.4, rest: 2.05, arc: 1.20, traverse: 1.9, weapon: 'flak' },
        ],
    },

    // --------------------------------------------------------
    // SWARMER — the incursion's rank and file
    // --------------------------------------------------------
    // Everything the natives build is bilaterally symmetric about its
    // nose. `render/hulls.js` states that as a rule of the silhouette
    // grammar, and it is what makes the fleet read as one fleet.
    //
    // The swarm breaks it, and breaking it is the entire design. An
    // asymmetric hull among two dozen symmetric ones does not read as
    // "another ship type" — it reads as *wrong*, immediately, before
    // anyone has resolved a single detail. That is a much stronger
    // signal than a third colour would be, and it costs no accent hue.
    //
    // Fast and frail: a thing you kill easily and there are too many
    // of. It reuses the fighter AI, so it flies attack runs.
    swarmer: {
        id: 'swarmer',
        role: 'fighter',
        label: 'swarmer',
        radius: 8,
        // 95, from the same solve as the fighter. The swarm never
        // retreats, so the retreat band is academic for it — but a
        // hull whose damage rungs straddle a threshold is a trap for
        // whoever reuses these numbers later, and a swarmer that dies
        // in three hits while a fighter takes twelve would make an
        // incursion a formality.
        hp: 95,
        speed: 124,
        accel: 210,
        thrust: { main: 1.0, retro: 0.30, lateral: 0.34 },
        turnRate: 3.6,
        cost: 0,
        buildMs: 0,
        weapon: 'spine',
        cargo: 0,
    },

    // --------------------------------------------------------
    // HARVESTER — what the swarm sends when it means it
    // --------------------------------------------------------
    // The heavy, on a rung of its own between corvette and frigate,
    // and turreted — so the first thing the natives' new turret
    // doctrine meets is something that also has it.
    harvester: {
        id: 'harvester',
        role: 'fighter',
        label: 'harvester',
        radius: 19,
        hp: 260,
        speed: 70,
        accel: 110,
        thrust: { main: 1.0, retro: 0.30, lateral: 0.26 },
        turnRate: 1.4,
        cost: 0,
        buildMs: 0,
        weapon: null,
        cargo: 0,

        // Four mounts, deliberately *not* mirrored — two to port, one
        // to starboard, one aft. The asymmetry is the point again: a
        // native frigate's battery is a matched broadside, and this
        // thing's is a growth.
        // Arcs narrowed from 1.7 to 1.0, and the rest bearings pulled
        // toward the nose.
        //
        // Four mounts each swinging through a hundred degrees and each
        // choosing its own target meant one harvester fired in four
        // unrelated directions at once — which is the "shooting
        // everywhere in a fan" the swarm was doing. The asymmetry is
        // still the characterisation; what it no longer does is point
        // every gun at a different part of the sky.
        mounts: [
            { x: 6.0, y: 7.5, rest: -0.55, arc: 1.0, traverse: 1.9, weapon: 'spine' },
            { x: -3.0, y: 8.5, rest: -0.95, arc: 1.0, traverse: 1.9, weapon: 'spine' },
            { x: 4.0, y: -6.5, rest: 0.65, arc: 1.0, traverse: 1.9, weapon: 'spine' },
            { x: -9.0, y: 1.5, rest: 3.0, arc: 1.1, traverse: 1.7, weapon: 'spine' },
        ],
    },

    // --------------------------------------------------------
    // DESTROYER — the line ship
    // --------------------------------------------------------
    // The rung the scale ladder has been holding open since the
    // beginning, and the first hull a faction cannot simply decide to
    // build: it needs a yard standing first.
    //
    // Slow, heavily armed, and built to hold a position rather than
    // to chase anything. It carries a spinal lance so it can commit
    // to an attack run like a warship — a turret-only heavy never
    // leaves station-keeping, which is right for a frigate sitting in
    // a line and wrong for the thing meant to break one.
    destroyer: {
        id: 'destroyer',
        role: 'fighter',
        label: 'destroyer',
        radius: 30,
        hp: 620,
        speed: 50,
        accel: 62,
        // The narrowest envelope in the fleet. Every course change is
        // spent as a turn first, so a destroyer commits to a heading
        // the way something of its mass ought to — you can see it
        // decide, and you can see it be unable to change its mind.
        thrust: { main: 1.0, retro: 0.22, lateral: 0.16 },
        turnRate: 0.75,
        cost: 260,
        buildMs: 22000,
        weapon: 'lance',
        cargo: 0,
        // Never escorts a miner. A destroyer tied to a mining barge is
        // the most expensive hull in the fleet doing a fighter's job.
        escorts: 0,

        // Six mounts, matched in pairs and mostly broadside — this is
        // a hull that wants to present its flank, unlike the frigate's
        // deliberately unmatched battery. Two flak mounts astern so
        // it is not helpless to a swarm that gets behind it.
        // Torpedo tubes, not batteries.
        //
        // The tube was a station weapon and stations do not go
        // anywhere, so it fired about four times a run from behind a
        // narrow forward arc — the least-seen weapon in the game by an
        // order of magnitude. A destroyer *carries* it to the fight,
        // which is the whole reason an anti-capital weapon belongs on
        // a capital ship rather than bolted to a building.
        mounts: [
            { x: 12, y: 11, rest: 0.85, arc: 1.4, traverse: 0.9, weapon: 'torpedo' },
            { x: 12, y: -11, rest: -0.85, arc: 1.4, traverse: 0.9, weapon: 'torpedo' },
            { x: -2, y: 13, rest: 1.4, arc: 1.6, traverse: 1.1, weapon: 'missile' },
            { x: -2, y: -13, rest: -1.4, arc: 1.6, traverse: 1.1, weapon: 'missile' },
            { x: -17, y: 8, rest: 2.5, arc: 1.5, traverse: 1.6, weapon: 'flak' },
            { x: -17, y: -8, rest: -2.5, arc: 1.5, traverse: 1.6, weapon: 'flak' },
        ],
    },

    // --------------------------------------------------------
    // FACTORY — the yard
    // --------------------------------------------------------
    // A second place a faction can build, and the only place a
    // destroyer can come from.
    //
    // It exists to make the heaviest hull a *decision with a
    // precondition* rather than another line in the production list.
    // A faction that wants destroyers has to stop building warships
    // long enough to pay for the yard, plant it, and keep it alive —
    // and because it is a structure with hit points sitting behind the
    // line, taking one out is a strategic act rather than a kill.
    factory: {
        id: 'factory',
        role: 'factory',
        label: 'factory',
        radius: 34,
        hp: 1500,
        speed: 0,
        accel: 0,
        turnRate: 0,
        cost: 300,
        buildMs: 18000,
        weapon: null,
        cargo: 0,
        immobile: true,

        // Two flak mounts, and that is all. Enough that a single
        // fighter cannot idly dismantle it, nowhere near enough to
        // defend itself against anything that means it — a yard is
        // something you garrison, not something that holds itself.
        mounts: [
            { x: 16, y: 14, rest: 0.8, arc: 1.8, traverse: 1.6, weapon: 'flak' },
            { x: 16, y: -14, rest: -0.8, arc: 1.8, traverse: 1.6, weapon: 'flak' },
        ],
    },

    // --------------------------------------------------------
    // EXCHANGE — the neutral market
    // --------------------------------------------------------
    // The only structure on the map that belongs to nobody, and the
    // only one that never shoots. Both fleets dock at it; neither may
    // fire inside its bubble.
    //
    // Big, and deliberately bigger than a mothership. It is the one
    // landmark on the board that is not a threat and not a prize, so
    // it has to read as *architecture* rather than as a warship —
    // something that was here before the war and expects to be here
    // after it.
    exchange: {
        id: 'exchange',
        role: 'exchange',
        label: 'exchange',
        // Its own rung, just under the mothership's 40. Big enough to
        // read as the largest thing on the map that is not a station,
        // and distinguished from one by silhouette anyway: this is the
        // only flat-sided box in the game.
        radius: 38,
        // Effectively indestructible. Nothing can shoot it — the
        // sanctuary refuses targets inside itself — so this number
        // exists to keep the hull bar and the damage maths honest
        // rather than because anything is expected to test it.
        hp: 20000,
        speed: 0,
        accel: 0,
        turnRate: 0,
        cost: 0,
        buildMs: 0,
        weapon: null,
        // Its float — what visiting haulers are paid out of. Runs
        // down as they draw on it and refills at TRADE_RESTOCK, so
        // the market is worth checking periodically rather than
        // continuously, and two fleets drawing on one float are in
        // competition without ever exchanging fire.
        cargo: TRADE_FLOAT,
        immobile: true,
    },

    // --------------------------------------------------------
    // OUTPOST — the forward store
    // --------------------------------------------------------
    // A shed at the frontier, and the answer to a map that empties
    // from the middle outward.
    //
    // Once the near fields are stripped a miner's round trip is mostly
    // travel, and the fix is not a faster miner — it is a shorter
    // trip. An outpost is somewhere to put ore *now*, out where the
    // work is, and haulers move it home in bulk afterwards. One long
    // journey by something built for it, instead of every miner making
    // the same journey with a fifth of the load.
    //
    // It is deliberately fragile for its bulk. It has one light gun
    // and no ability to repair itself, so it costs something to kill
    // and cannot hold anyone off — losing one strands an entire mining
    // operation and pushes a faction back to the frontier it had
    // already finished with, which is what makes it worth raiding and
    // worth escorting.
    outpost: {
        id: 'outpost',
        role: 'outpost',
        label: 'outpost',
        radius: 26,
        hp: 780,
        speed: 0,
        accel: 0,
        turnRate: 0,
        cost: 150,
        buildMs: 11000,
        weapon: 'popgun',
        // Its storage. Large, because the whole point is that a miner
        // can empty a full hold into it and go straight back to work —
        // and large enough to absorb a *backlog*, which is when the
        // number actually matters. A shed only fills when its haulers
        // are dead or busy, and that is exactly the moment it must not
        // start turning miners away and sending them the long way home.
        // At the old 900 the peak observed hold was already 689.
        cargo: 1800,
        immobile: true,
    },

    // --------------------------------------------------------
    // HAULER — the short run
    // --------------------------------------------------------
    // The small one. Quick, cheap, and sent when an outpost has a
    // moderate amount waiting — a faction should not scramble its
    // heavy freighter for two hundred ore.
    hauler: {
        id: 'hauler',
        role: 'hauler',
        label: 'hauler',
        radius: 10,
        hp: 55,
        speed: 96,
        accel: 130,
        thrust: { main: 1.0, retro: 0.32, lateral: 0.24 },
        turnRate: 2.0,
        cost: 30,
        buildMs: 4500,
        weapon: null,
        cargo: 200,
    },

    // --------------------------------------------------------
    // FREIGHTER — the long haul
    // --------------------------------------------------------
    // Slow, fat and completely defenceless: the most valuable thing
    // either faction ever puts on the map, and the best possible
    // reason to be somewhere with a fighter.
    freighter: {
        id: 'freighter',
        role: 'hauler',
        label: 'freighter',
        radius: 18,
        hp: 130,
        speed: 62,
        accel: 88,
        thrust: { main: 1.0, retro: 0.34, lateral: 0.22 },
        turnRate: 1.3,
        cost: 70,
        buildMs: 9000,
        weapon: null,
        cargo: 620,
    },

    // --------------------------------------------------------
    // WRECK — what is left when a laden hull dies
    // --------------------------------------------------------
    // Not a ship. A drifting hold with no engine, no gun and no
    // opinion, holding whatever its owner was carrying.
    //
    // It is *modelled* as a ship for one reason and it is a good one:
    // the conservation ledger sums `cargo` over `world.ships`, so ore
    // sitting in a wreck is counted as in-transit automatically and
    // the books balance without a single new term. Modelled as its own
    // entity pool it would have needed the ledger, the broadphase and
    // the sweep all taught about it.
    //
    // Faction is inherited from whoever died, but anybody may collect
    // it — which is the point. A miner killed on the way home is now a
    // prize sitting in open space, and the side that killed it has a
    // reason to still be there when the salvage hauler arrives.
    wreck: {
        id: 'wreck',
        role: 'wreck',
        label: 'wreck',
        radius: 7,
        hp: 1,
        speed: 0,
        accel: 0,
        turnRate: 0,
        cost: 0,
        buildMs: 0,
        weapon: null,
        cargo: 0,
        immobile: true,
    },
};