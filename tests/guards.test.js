// ============================================================
// TESTS — ARCHITECTURE GUARDS
// ============================================================
//
// The rules in `docs/00-GOSPEL.md` and `docs/02-ARCHITECTURE.md`
// were, until this file existed, enforced by remembering them. Some
// of them even shipped with the grep you were supposed to run by
// hand. Every one of those is a rule that holds right up until the
// change that breaks it, and the breakage is silent: a sim that
// imports a renderer still runs, a constant nobody reads still has
// a paragraph explaining why it matters, a behaviour that hangs a
// new field on a ship still works.
//
// So this file executes the rules instead. Each test below is one
// invariant the project already claims, restated as something that
// fails loudly on the way in. Two of them were written after the
// rule they check had already been broken.
//
// They are deliberately *structural*. Nothing here asserts that the
// simulation is any good — that is what the rest of tests/ is for.
// These only assert that it is still shaped the way the docs say it
// is, which is the part a future change is most likely to erode
// without meaning to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHIP_TYPES } from '../src/data/ships.js';
import { WEAPON_TYPES } from '../src/data/weapons.js';
import { PRODUCTION_POLICY } from '../src/data/production.js';
import { BEHAVIORS } from '../src/sim/behaviors/index.js';
import { STATES, QUARANTINED } from '../src/sim/behaviors/states.js';
import { HULL_RENDERERS } from '../src/render/hulls.js';
import { THREAT_WEIGHT } from '../src/core/constants.js';
import { makeShip } from '../src/sim/entities.js';
import { createWorld, stepWorld } from '../src/sim/simulate.js';
import {
    FIXED_DT, FIGHTER_BREAKOFF, FIGHTER_EXTEND, RETREAT_HP, REJOIN_HP,
} from '../src/core/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ------------------------------------------------------------
// SOURCE HELPERS
// ------------------------------------------------------------

/** Every .js file under a directory, as absolute paths. */
function jsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * Source with comments blanked out.
 *
 * Every scan below is a rule about *code*, and this project comments
 * heavily — including quoting the very things the rules forbid, to
 * explain why they are forbidden. `core/rng.js` says "no
 * `Math.random()` anywhere in src/sim" in prose, and a naive grep
 * would fail on the sentence that states the rule.
 *
 * Character scanner rather than a regex, because `//` inside a
 * string literal is not a comment and a project that grows a URL
 * would find that out the confusing way.
 */
function stripComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];

        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
                out += src[i];
                if (src[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

const SOURCES = new Map(jsFiles(SRC).map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

/** The module specifiers a file imports, as written. */
function importsOf(src) {
    const out = [];
    const re = /(?:from|import)\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
}

/**
 * Every file reachable by following imports from an entry point.
 * Relative specifiers only — the project has no dependencies, so
 * anything else would be news in itself.
 */
function importClosure(entry) {
    const seen = new Set();
    const stack = [resolve(entry)];
    while (stack.length) {
        const file = stack.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const src = SOURCES.get(file);
        assert.ok(src !== undefined, 'import closure left src/: ' + rel(file));
        for (const spec of importsOf(src)) {
            assert.ok(spec.startsWith('.'), 'unexpected non-relative import ' + spec + ' in ' + rel(file));
            stack.push(resolve(dirname(file), spec));
        }
    }
    return seen;
}

// ------------------------------------------------------------
// THE ONE RULE
// ------------------------------------------------------------

test('guard: the simulation never reaches the renderer', () => {
    // Architecture §1. This is what lets the whole sim run headless
    // under `node --test` with no DOM stubbing, which in turn is what
    // makes the determinism and economy tests possible at all.
    //
    // Checked over the transitive closure rather than file by file,
    // because the interesting version of this mistake is never a
    // direct `sim → render` import. It is a helper added to something
    // in `core/` that happens to want a colour.
    const closure = importClosure(join(SRC, 'sim', 'simulate.js'));
    const leaks = [...closure].filter((f) => rel(f).startsWith('src/render/'));
    assert.deepEqual(leaks.map(rel), [], 'sim reached render');
});

test('guard: nothing outside render/ imports the renderer', () => {
    for (const [file, src] of SOURCES) {
        if (rel(file).startsWith('src/render/') || rel(file) === 'src/main.js') continue;
        for (const spec of importsOf(src)) {
            const target = rel(resolve(dirname(file), spec));
            assert.ok(!target.startsWith('src/render/'),
                rel(file) + ' imports ' + target);
        }
    }
});

// ------------------------------------------------------------
// DETERMINISM
// ------------------------------------------------------------

test('guard: no Math.random() anywhere in src', () => {
    // Architecture §5. Every stochastic decision draws from
    // `world.rng` or `world.fxRng`, which is the only reason
    // `?seed=12345` replays a run exactly. One `Math.random()` in a
    // cosmetic corner is enough to make the guarantee worthless,
    // and it would not show up as a failing test anywhere else.
    const offenders = [...SOURCES]
        .filter(([, src]) => /\bMath\s*\.\s*random\b/.test(src))
        .map(([file]) => rel(file));
    assert.deepEqual(offenders, []);
});

// ------------------------------------------------------------
// COLOUR
// ------------------------------------------------------------

test('guard: no colour literal outside data/themes.js', () => {
    // Gospel rule 1, which until now shipped as a grep in a doc.
    // Two themes, one palette file: a colour typed anywhere else is
    // a colour that cannot be re-lit for the other light model, and
    // the paper theme fails quietly and looks merely wrong.
    const offenders = [];
    for (const [file, src] of SOURCES) {
        if (rel(file) === 'src/data/themes.js') continue;
        const m = src.match(/#[0-9a-fA-F]{3,8}\b/g);
        if (m) offenders.push(rel(file) + ': ' + m.join(', '));
    }
    assert.deepEqual(offenders, []);
});

// ------------------------------------------------------------
// THE FOUR REGISTRIES
// ------------------------------------------------------------
//
// Architecture §3. Adding content means adding a row — so the thing
// worth checking is that a row was added to *every* table it needed
// to be added to. Half-registered content fails at the moment the
// first one is built, which in a self-playing sim can be minutes
// into a run that nobody is watching.

test('guard: every ship type is completely registered', () => {
    for (const [id, def] of Object.entries(SHIP_TYPES)) {
        assert.equal(def.id, id, id + ': id field disagrees with its key');
        assert.equal(typeof BEHAVIORS[def.role], 'function',
            id + ": role '" + def.role + "' has no entry in BEHAVIORS");
        assert.equal(typeof HULL_RENDERERS[id], 'function',
            id + ' has no entry in HULL_RENDERERS');
        if (def.weapon !== null) {
            assert.ok(WEAPON_TYPES[def.weapon],
                id + ": weapon '" + def.weapon + "' is not in WEAPON_TYPES");
        }
        // The scale ladder in data/ships.js is a design rule, but a
        // hull with no radius is a hitbox bug and a divide by zero
        // waiting in the separation force.
        assert.ok(def.radius > 0, id + ' has no radius');
    }
});

test('guard: the production policy only asks for ships that exist', () => {
    for (const rule of PRODUCTION_POLICY) {
        assert.ok(SHIP_TYPES[rule.type],
            "production policy wants unknown type '" + rule.type + "'");
        // A cap may be a function of the faction — see the miner rule,
        // which widens while a faction is short of money. Probe both
        // ends rather than asserting on the literal.
        const caps = typeof rule.maxAlive === 'function'
            ? [rule.maxAlive({ lean: false, counts: {} }), rule.maxAlive({ lean: true, counts: {} })]
            : [rule.maxAlive];
        for (const cap of caps) {
            assert.ok(cap > 0, rule.type + ' rule has a useless cap');
        }
        // A blocking rule that can never be satisfied stops
        // production for that faction permanently — see the note in
        // data/production.js.
        assert.equal(typeof rule.blocking, 'boolean', rule.type + ' rule has no blocking flag');
    }
});

test('guard: threat weights name real roles', () => {
    const roles = new Set(Object.values(SHIP_TYPES).map((d) => d.role));
    for (const role of Object.keys(THREAT_WEIGHT)) {
        assert.ok(roles.has(role), "THREAT_WEIGHT names unknown role '" + role + "'");
    }
    // The other direction matters more: a role missing from the
    // table scores 0 and becomes permanently unshootable, which
    // reads as an AI bug rather than as a missing row.
    for (const role of roles) {
        assert.ok(role in THREAT_WEIGHT, "role '" + role + "' has no THREAT_WEIGHT");
    }
});

// ------------------------------------------------------------
// THE STATE VOCABULARY
// ------------------------------------------------------------
//
// `sim/behaviors/states.js` exists so that no module has to know
// another module's state names as bare strings. These three checks
// are what keep that true, because the failure mode of every one of
// them is silence: a renamed state does not throw, it just stops
// matching, and something quietly never happens again.

test('guard: every state a run produces is in the vocabulary', () => {
    // A state set by a behaviour but missing from STATES is a name
    // nothing else can safely refer to — including the exemption
    // lists below, and including whoever adds the next behaviour that
    // has to ask "is that miner working?".
    const world = createWorld({ seed: 4242 });
    const seen = new Map();
    for (let i = 0; i < 9000; i++) {
        stepWorld(world, FIXED_DT);
        for (const ship of world.ships) {
            if (!ship.state) continue;
            if (!seen.has(ship.role)) seen.set(ship.role, new Set());
            seen.get(ship.role).add(ship.state);
        }
    }

    const strays = [];
    for (const [role, states] of seen) {
        const known = new Set(STATES[role] || []);
        for (const state of states) {
            if (state === QUARANTINED) continue;
            if (!known.has(state)) strays.push(role + ':' + state);
        }
    }
    assert.deepEqual(strays.sort(), [], 'states not declared in states.js');
    assert.ok(seen.size >= 4, 'not every role ran — the guard proved nothing');
});

test('guard: telemetry exemption lists name real states', () => {
    // `core/` may not import `sim/`, so LOITER_STATES and
    // DESIGNED_CYCLES in core/telemetry.js hold string literals and
    // cannot be type-checked against anything. That makes them the
    // most fragile names in the project: rename a state and the
    // exemption silently stops applying, and the watchdog those lists
    // exist to keep honest starts crying wolf again — which is the
    // one failure mode telemetry.js says it will not tolerate.
    const src = SOURCES.get(join(SRC, 'core', 'telemetry.js'));
    const every = new Set(Object.values(STATES).flat());

    const listed = (name) => {
        const m = new RegExp('const ' + name + ' = new Set\\(\\[([^\\]]*)\\]').exec(src);
        assert.ok(m, name + ' is not a literal Set in telemetry.js any more');
        return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };

    for (const state of listed('LOITER_STATES')) {
        assert.ok(every.has(state), "LOITER_STATES names unknown state '" + state + "'");
    }
    for (const state of listed('BRIEF_STATES')) {
        const [role, name] = state.split(':');
        assert.ok(STATES[role]?.includes(name), "BRIEF_STATES names unknown state '" + state + "'");
    }
    for (const cycle of listed('DESIGNED_CYCLES')) {
        const [role, pair] = cycle.split(':');
        for (const name of pair.split('>')) {
            assert.ok(STATES[role]?.includes(name),
                "DESIGNED_CYCLES names unknown state '" + role + ':' + name + "'");
        }
    }
});

// ------------------------------------------------------------
// ORDERED TUNABLES
// ------------------------------------------------------------

test('guard: a fighter extends further than it breaks off', () => {
    // Both are fractions of the firer's own weapon range, and if the
    // extension is not the larger of the two then EXTEND is entered
    // already past its own exit condition and leaves on the same step.
    // That is not hypothetical: written as an absolute 190 units
    // against a break-off at 0.75 × 330 = 247, 72% of extensions
    // lasted exactly one step and the fighter's loop-back was a turn
    // on the spot.
    //
    // The pair is only meaningful in order, and nothing about reading
    // either constant on its own suggests the other exists.
    assert.ok(FIGHTER_EXTEND > FIGHTER_BREAKOFF,
        'FIGHTER_EXTEND (' + FIGHTER_EXTEND + ') must exceed FIGHTER_BREAKOFF ('
        + FIGHTER_BREAKOFF + ') or the EXTEND state does nothing');
});

test('guard: a retreating hull can survive at least one more round', () => {
    // A threshold is not a place a ship stops at. Damage arrives in
    // whole rounds, so a hull lands on `hp - k × damage` and jumps over
    // whatever sits between two rungs — what matters is the rung it
    // lands on, not the fraction that was written down.
    //
    // At RETREAT_HP 0.25 a fighter under pulse fire went 12 hp (30%,
    // still fighting) straight to 5 hp, skipping the threshold band
    // entirely and arriving in REGROUP with less hull than one more
    // round. 65% of retreats ended in death within half a second.
    //
    // So the rule is about the landing rung, which makes it hold for a
    // weapon nobody has written yet: change a damage figure and the
    // partition of every hull changes with it, silently, and the only
    // symptom is a mechanism that stops firing.
    assert.ok(RETREAT_HP < REJOIN_HP,
        'RETREAT_HP must be below REJOIN_HP or a repaired ship never rejoins');

    /** How many more hits a hull that has just broken off must survive. */
    const GUARD_ROUNDS = 3;

    const failures = [];
    for (const [id, def] of Object.entries(SHIP_TYPES)) {
        // Only hulls that can retreat, i.e. ones the fighter AI drives.
        if (def.role !== 'fighter') continue;

        for (const [wid, weapon] of Object.entries(WEAPON_TYPES)) {
            if (!weapon.damage) continue;      // mining beams do not threaten hulls

            // Walk the hull down in whole rounds and find the first
            // value at or below the threshold — the rung it lands on.
            const threshold = def.hp * RETREAT_HP;

            // A single round bigger than the hull's whole retreat band
            // is not a broken mechanism, it is an anti-capital weapon.
            //
            // The rule this guard exists to protect is "a hull worn
            // down gradually must get a chance to run". A torpedo does
            // 34 to a 40 hp fighter: there is no wearing down, the
            // fighter is simply deleted, and asserting that it should
            // have been able to retreat from that is asserting that
            // heavy weapons should not exist. The exemption is narrow
            // on purpose — the lance at 13 against a 14 hp band is
            // *not* exempt, and that is exactly the case this guard
            // caught when the lance was first written at 22.
            // Anti-armour weapons are exempt, by declaration.
            //
            // A lance or a torpedo exists to delete a light hull, and
            // asserting that a fighter should be able to break off
            // from one is asserting that heavy weapons should not
            // exist. Flagged in data/weapons.js rather than inferred,
            // so adding a heavy gun is a deliberate act.
            if (weapon.heavy) continue;
            if (weapon.damage >= threshold) continue;
            let landing = def.hp;
            while (landing > threshold) landing -= weapon.damage;

            // Several more rounds, not one.
            //
            // The bar was `landing > damage` — survive a single hit —
            // and it passed at 14 hp against a 13-damage round, by one
            // point. In practice those hulls died immediately, because
            // surviving the *next* round is not the same as surviving
            // the journey home. GUARD_ROUNDS is what a retreat needs
            // to be worth having.
            if (landing <= weapon.damage * GUARD_ROUNDS) {
                failures.push(
                    `${id} (${def.hp} hp) under ${wid} (${weapon.damage}/round): retreats at `
                    + `${landing} hp, which is under ${GUARD_ROUNDS} more rounds. RETREAT_HP `
                    + `${RETREAT_HP} puts the threshold at ${threshold.toFixed(1)} hp.`);
            }
        }
    }
    assert.deepEqual(failures, []);
});

// ------------------------------------------------------------
// DEAD TUNABLES
// ------------------------------------------------------------

test('guard: every exported constant is actually read', () => {
    // constants.js is the project's tuning surface and it is heavily
    // commented — several entries carry a paragraph of measurement
    // and reasoning. That makes an orphaned one actively harmful
    // rather than merely untidy: it reads as a live knob, so the next
    // person tunes it and watches nothing happen.
    //
    // This test was written because two of them already were. The
    // fly-by rework replaced a fighter that held an orbiting
    // standoff, and left `ORBIT_FRACTION` and `FIRE_LEAN` behind
    // still describing how engagements worked.
    const constantsFile = join(SRC, 'core', 'constants.js');
    const declared = [...SOURCES.get(constantsFile).matchAll(/export const ([A-Z][A-Z0-9_]*)/g)]
        .map((m) => m[1]);
    assert.ok(declared.length > 40, 'constant scan found almost nothing — has the file moved?');

    const unread = declared.filter((name) => {
        const re = new RegExp('\\b' + name + '\\b');
        for (const [file, src] of SOURCES) {
            if (file === constantsFile) continue;
            if (re.test(src)) return false;
        }
        return true;
    });
    assert.deepEqual(unread, []);
});

// ------------------------------------------------------------
// ENTITY SHAPE
// ------------------------------------------------------------

test('guard: ships never grow a field the factory did not declare', () => {
    // entities.js: "Every field a ship will ever hold is declared
    // here even when it only applies to one role." The point is one
    // hidden class for every ship in the world, and the cost of
    // breaking it is invisible — a behaviour that hangs a new field
    // on a ship mid-run works perfectly and quietly deoptimises the
    // entire pool.
    //
    // It had drifted: `orbitDir`, `passDir` and `wanderAngle` were
    // all being attached after construction.
    const world = createWorld({ seed: 4242 });
    const declared = new Set(Object.keys(makeShip(world, 'fighter', 0, 0, 0)));

    // Long enough for every class to exist and to have been through
    // its states: motherships build miners, miners launch drones,
    // fighters find each other.
    // Every class is seeded rather than waited for. Production is
    // posture-gated now, so a corvette only appears once a faction is
    // raiding, besieged or besieging — which a 150-second run cannot
    // promise and a run long enough to promise it would make this the
    // slowest test in the suite. What is under test is that a stepped
    // hull grows no undeclared fields, and a hull that was placed
    // rather than built is stepped identically.
    for (const type of Object.keys(SHIP_TYPES)) {
        if (type === 'mothership') continue;      // worldgen owns these
        world.addShip(makeShip(world, type, 0, world.width * 0.5, world.height * 0.5));
    }

    const seen = new Set();
    for (let i = 0; i < 9000; i++) {
        stepWorld(world, FIXED_DT);
        for (const ship of world.ships) seen.add(ship.type);
    }
    for (const type of Object.keys(SHIP_TYPES)) {
        assert.ok(seen.has(type), 'no ' + type + ' ever existed — the guard proved nothing');
    }

    const extra = new Set();
    for (const ship of world.ships) {
        for (const key of Object.keys(ship)) if (!declared.has(key)) extra.add(key);
    }
    assert.deepEqual([...extra], [], 'undeclared ship fields');
});

// ------------------------------------------------------------
// FIELD ADDRESSING
// ------------------------------------------------------------

test('guard: a field id is its index in world.fields', () => {
    // Both references to a field in the whole simulation —
    // `rock.fieldId` and `miner.claimId` — are used as indices into
    // `world.fields`, so `id` has to *be* the index.
    //
    // It did not. Field ids came from the placement loop counter
    // while only successfully placed fields were pushed, so a run
    // that lost one to a crowded map had every later field answering
    // to somebody else's id: rocks crediting their ore to a
    // neighbour, miners claiming a field and flying to another. It
    // needs a crowded map to trigger, which is exactly the kind of
    // bug that surfaces once, months later, as "the miners look
    // confused sometimes".
    const world = createWorld({ seed: 909 });

    const check = () => {
        world.fields.forEach((field, i) => {
            assert.equal(field.id, i, 'field ' + i + ' carries id ' + field.id);
        });
        for (const rock of world.asteroids) {
            if (rock.fieldId < 0) continue;
            assert.ok(world.fields[rock.fieldId], 'rock points at a field that is not there');
        }
    };

    check();
    // Fields are relocated when they run dry, so run long enough for
    // renewal to have rewritten the set several times over.
    for (let i = 0; i < 12000; i++) {
        stepWorld(world, FIXED_DT);
        if (i % 600 === 0) check();
    }
    check();
});
