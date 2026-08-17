// ============================================================
// HEADLESS RUN — THE REPORT
// ============================================================
//
// Runs the simulation with nobody watching and says what is wrong
// with it. It exists because the two ways to look at this project
// were, until now, `npm test` — which answers yes or no — and a tab,
// which answers only what you personally noticed while it was open.
// Neither tells you that drones spend forty-five percent of a run
// waiting to unload, and both of those are the kind of thing you are
// trying to find out.
//
// The whole simulation is browser-free, so this is a loop, a printer
// and a comparison.
//
//   npm run sim                                   one seed, five minutes
//   npm run sim -- --seeds=1..20 --minutes=10     a sweep, with an aggregate
//   npm run sim -- --seed=7 --detail              every audit for one run
//   npm run sim -- --seeds=1..8 --baseline=b.json record, then compare
//   npm run sim -- --seeds=1..4 --verify          re-run each seed, check replay
//   npm run sim -- --seed=7 --csv                 streams written to .captures/
//   npm run sim -- --seed=7 --motion              add the physics stream
//
// ------------------------------------------------------------
// WHAT IT PRINTS, AND WHAT IT DOES NOT
// ------------------------------------------------------------
//
// By default: the summary table, the diagnosis, and nothing else.
//
// That restraint is the point. The first version printed every audit
// for every seed and was, at about four hundred lines, precisely as
// unreadable as watching the tab it was meant to replace — a report
// nobody finishes reading is a report that found nothing. So the
// default output is the answer, `--detail` is the evidence, and
// `--csv` is the raw material.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { telemetry } from '../src/core/telemetry.js';
import { FIXED_DT } from '../src/core/constants.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ------------------------------------------------------------
// ARGUMENTS
// ------------------------------------------------------------

const USAGE = `
  --seed=N          one seed              --seeds=1..20 | 3,7,11
  --minutes=N       simulated minutes     --seconds=N
  --detail          print every audit     --motion  add the physics stream
  --csv             write streams to .captures/
  --baseline=FILE   compare against FILE, or write it if absent
  --verify          re-run each seed and check the replay matches
  --quiet           summary and diagnosis only

  scope — record less, when you are working on one thing
  --streams=LIST    motion,states,events,series,checks — unnamed ones are off
  --role=LIST       only these roles      --type=LIST   only these hull classes
  --faction=N       only one side         --watch=LIST  only these ship ids

  e.g. --type=gunship,fighter --streams=states,events,checks
`;

function parseArgs(argv) {
    const opts = {
        seeds: [1], minutes: 5, csv: false, detail: false,
        motion: false, quiet: false, baseline: null, verify: false,
        streams: null, role: null, type: null, faction: null, watch: null,
    };
    for (const arg of argv) {
        const [key, raw] = arg.replace(/^--/, '').split('=');
        const value = raw === undefined ? true : raw;
        switch (key) {
            case 'seed': opts.seeds = [Number(value)]; break;
            case 'seeds': opts.seeds = parseSeeds(String(value)); break;
            case 'minutes': opts.minutes = Number(value); break;
            case 'seconds': opts.minutes = Number(value) / 60; break;
            case 'csv': opts.csv = true; break;
            case 'detail': opts.detail = true; break;
            case 'motion': opts.motion = true; break;
            case 'quiet': opts.quiet = true; break;
            case 'verify': opts.verify = true; break;
            case 'baseline': opts.baseline = String(value); break;
            case 'streams': opts.streams = String(value); break;
            case 'role': opts.role = String(value); break;
            case 'type': opts.type = String(value); break;
            case 'faction': opts.faction = Number(value); break;
            case 'watch': opts.watch = String(value); break;
            case 'help': case 'h': console.log(USAGE); process.exit(0); break;
            default:
                console.error('unknown option: --' + key + '\n' + USAGE);
                process.exit(1);
        }
    }
    if (!opts.seeds.length || opts.seeds.some((s) => !Number.isFinite(s))) {
        console.error('bad --seed/--seeds\n' + USAGE);
        process.exit(1);
    }
    return opts;
}

/** `1..20`, `3,7,11`, or a single number. */
function parseSeeds(spec) {
    if (spec.includes('..')) {
        const [a, b] = spec.split('..').map(Number);
        return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
    }
    return spec.split(',').map(Number);
}

// ------------------------------------------------------------
// ONE RUN
// ------------------------------------------------------------

function runSeed(seed, opts) {
    // Effects are cosmetic and draw from a forked rng, so leaving them
    // off changes nothing about the run and saves the particle churn.
    telemetry.disable().clear();
    const world = createWorld({ seed, effects: false });
    telemetry.enable({
        streams: opts.streams,
        // `--motion` is the shorthand for the one stream that is off by
        // default; an explicit `--streams` list wins over it.
        motion: opts.streams ? undefined : opts.motion,
        role: opts.role,
        type: opts.type,
        faction: opts.faction,
        watch: opts.watch,
    });

    const steps = Math.round(opts.minutes * 60 / FIXED_DT);
    const started = process.hrtime.bigint();
    for (let i = 0; i < steps; i++) stepWorld(world, FIXED_DT);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Read the audits back before the buffers are cleared for the next
    // seed. They print themselves when asked from a console, which is
    // right in devtools and wrong here — this file has its own printer
    // and wants the rows, not the box drawing.
    const audits = readAudits(() => ({
        diagnose: telemetry.diagnose(),
        behaviour: telemetry.behaviour(),
        economy: telemetry.economy(),
        lifecycle: telemetry.lifecycle(),
        timeline: telemetry.timeline(60),
        ships: telemetry.ships(12),
        reasons: telemetry.reasons(),
        flight: opts.motion ? telemetry.flight() : [],
    }));

    return {
        seed, world, elapsedMs, audits,
        anomalies: telemetry.anomalies.slice(),
        // Sampled hashes, for --verify. Two runs of one seed must agree
        // at every sample, not merely at the end — a divergence that
        // heals is still a divergence.
        hashes: telemetry.seriesRows.map((r) => r.hash),
    };
}

/** Read the audits without letting them print. */
function readAudits(fn) {
    telemetry.quiet = true;
    try { return fn(); } finally { telemetry.quiet = false; }
}

/** Re-run a seed and find the first sample where the replay disagreed. */
function verifySeed(seed, opts, hashes) {
    const again = runSeed(seed, opts);
    const n = Math.min(hashes.length, again.hashes.length);
    if (again.hashes.length !== hashes.length) {
        return { ok: false, at: 'sample count: ' + hashes.length + ' vs ' + again.hashes.length };
    }
    for (let i = 0; i < n; i++) {
        if (hashes[i] !== again.hashes[i]) return { ok: false, at: 'sample ' + i + ' (~' + i + 's)' };
    }
    return { ok: true, at: '' };
}

// ------------------------------------------------------------
// THE SUMMARY ROW
// ------------------------------------------------------------
//
// One line per seed, and the same shape whether it is one run or
// twenty. Every column is a question the project already knows it
// wants answered — see docs/05-ROADMAP.md on faction snowball, which
// asks for exactly this.

function summarise(run) {
    const { world, audits } = run;
    const f = world.factions;
    const ecoOf = (id) => audits.economy.find((e) => e.faction === id) || {};

    // The stuck detector in aggregate: the longest any role sat in one
    // state. Tens of seconds is a behavioural deadlock that recovered,
    // which no end-state test would ever notice.
    let worst = { max: 0, label: '—' };
    for (const b of audits.behaviour) {
        const secs = parseFloat(b.max);
        if (secs > worst.max) worst = { max: secs, label: `${b.role}:${b.state} ${b.max}` };
    }

    const metal = f.map((x) => x.metal);
    const total = metal.reduce((s, v) => s + v, 0);

    return {
        seed: run.seed,
        metal: metal.map(Math.round).join(' / '),
        lead: total > 0 ? (Math.abs(metal[0] - metal[1]) / total).toFixed(2) : '0.00',
        built: f.map((x) => x.builtTotal).join(' / '),
        lost: f.map((x) => x.lostTotal).join(' / '),
        ore: Math.round(world.oreExtracted),
        lostOre: Math.round(world.oreLost),
        cycle: f.map((_, i) => ecoOf(i).cycle || '—').join(' / '),
        acc: f.map((_, i) => ecoOf(i).accuracy || '—').join(' / '),
        longestState: worst.label,
        flags: audits.diagnose.filter((d) => d.level === 'high').length,
        ms: Math.round(run.elapsedMs),
    };
}

/** The numeric slice of a summary, for baseline comparison. */
function metrics(run) {
    const s = summarise(run);
    let longest = 0;
    for (const b of run.audits.behaviour) longest = Math.max(longest, parseFloat(b.max) || 0);
    const totalSteps = Math.round((run.world.time || 300) / FIXED_DT) || 1;
    const msPerStep = run.elapsedMs / totalSteps;
    return {
        ore: Math.round(run.world.oreExtracted),
        oreLost: Math.round(run.world.oreLost),
        built: run.world.factions.reduce((t, f) => t + f.builtTotal, 0),
        lost: run.world.factions.reduce((t, f) => t + f.lostTotal, 0),
        lead: Number(s.lead),
        longestState: Math.round(longest),
        flags: s.flags,
        anomalies: run.anomalies.length,
        msPerStep: Math.round(msPerStep * 1000) / 1000,
    };
}

// ------------------------------------------------------------
// PRINTING
// ------------------------------------------------------------
//
// Hand-rolled rather than `console.table`, because the report is meant
// to be read in a terminal and pasted into an issue, and box drawing
// does neither well.

function printTable(rows, title, limit = 40) {
    if (!rows || !rows.length) return;
    console.log('\n' + title);
    const shown = rows.slice(0, limit);
    const cols = Object.keys(shown[0]);
    const width = (c) => Math.max(c.length, ...shown.map((r) => String(r[c] ?? '').length));
    const widths = cols.map(width);
    const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    console.log(line(cols));
    console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of shown) console.log(line(cols.map((c) => r[c])));
    if (rows.length > shown.length) console.log(`  … ${rows.length - shown.length} more`);
}

/**
 * The diagnosis, merged across seeds.
 *
 * A finding that fires on eighteen of twenty seeds is one finding
 * about the simulation; printed per seed it is eighteen findings and
 * a wall of text. So identical `what` values collapse, carrying the
 * seed count and one example detail.
 */
function printDiagnosis(runs) {
    const byWhat = new Map();
    for (const run of runs) {
        for (const d of run.audits.diagnose) {
            const key = d.level + '' + d.what;
            let a = byWhat.get(key);
            if (!a) byWhat.set(key, a = { level: d.level, what: d.what, seeds: new Set(), example: d.detail });
            a.seeds.add(run.seed);
        }
    }
    if (!byWhat.size) {
        console.log('\ndiagnosis  nothing to report');
        return;
    }
    const rank = { high: 0, medium: 1, note: 2 };
    const rows = [...byWhat.values()]
        .sort((a, b) => (rank[a.level] - rank[b.level]) || (b.seeds.size - a.seeds.size))
        .map((a) => ({
            level: a.level,
            seeds: `${a.seeds.size}/${runs.length}`,
            what: a.what,
            example: a.example,
        }));
    printTable(rows, 'diagnosis', 30);
}

function printAnomalies(runs) {
    const byKind = new Map();
    let total = 0;
    for (const r of runs) {
        for (const a of r.anomalies) {
            total++;
            let k = byKind.get(a.what);
            if (!k) {
                byKind.set(a.what, k = {
                    what: a.what, sites: 0, times: 0, seeds: new Set(), first: a.t, last: a.lastT,
                });
            }
            k.sites++;
            k.times += a.count;
            k.seeds.add(r.seed);
            k.first = Math.min(k.first, a.t);
            k.last = Math.max(k.last, a.lastT);
        }
    }
    if (!total) {
        console.log('\nanomalies  none');
        return;
    }
    // One line per kind, with the window it spanned rather than a
    // hundred lines of the same sentence. `entities` is how many
    // distinct ships or fields it happened to, `occurrences` how many
    // times in total — a fault that hits one hull repeatedly and one
    // that hits fifty hulls once are different problems.
    printTable([...byKind.values()].map((k) => ({
        what: k.what,
        entities: k.sites,
        occurrences: k.times,
        seeds: `${k.seeds.size}/${runs.length}`,
        window: k.first === k.last ? k.first + 's' : `${k.first}s→${k.last}s`,
    })), 'anomalies');
}

// ------------------------------------------------------------
// BASELINE
// ------------------------------------------------------------
//
// The tool answers "what is it doing". Without this it can never
// answer "did my change help", which is the question a tuning session
// is actually made of — and comparing two terminal scrollbacks by eye
// is exactly the manual, error-prone reading this whole exercise
// exists to remove.

function baselinePath(name) {
    return isAbsolute(name) ? name : join(ROOT, name);
}

async function loadBaseline(name) {
    try {
        return JSON.parse(await readFile(baselinePath(name), 'utf8'));
    } catch {
        return null;
    }
}

async function saveBaseline(name, opts, runs) {
    const body = {
        minutes: opts.minutes,
        seeds: opts.seeds,
        runs: Object.fromEntries(runs.map((r) => [r.seed, metrics(r)])),
    };
    await mkdir(join(ROOT, '.captures'), { recursive: true });
    await writeFile(baselinePath(name), JSON.stringify(body, null, 2));
}

/** Mean of a metric across runs, then the same metric in the baseline. */
function compareBaseline(base, runs, opts) {
    if (base.minutes !== opts.minutes) {
        console.log(`\nbaseline was recorded at ${base.minutes} min, this run is ${opts.minutes} — not comparable`);
        return;
    }
    const shared = runs.filter((r) => base.runs[r.seed]);
    if (!shared.length) {
        console.log('\nbaseline shares no seeds with this run — not comparable');
        return;
    }

    const keys = Object.keys(metrics(shared[0]));
    const rows = keys.map((key) => {
        const now = mean(shared.map((r) => metrics(r)[key]));
        const was = mean(shared.map((r) => base.runs[r.seed][key]));
        const delta = now - was;
        // A percentage of a near-zero baseline is noise dressed as a
        // finding, so small absolute bases report the raw change.
        const rel = Math.abs(was) > 1 ? ((delta / was) * 100).toFixed(1) + '%' : '—';
        return {
            metric: key,
            baseline: round2(was),
            now: round2(now),
            change: (delta >= 0 ? '+' : '') + round2(delta),
            pct: rel,
        };
    });
    printTable(rows, `versus baseline · ${shared.length} shared seed(s)`);
}

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const round2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------

async function writeStreams(seed, opts) {
    const dir = join(ROOT, '.captures');
    await mkdir(dir, { recursive: true });

    const kinds = ['states', 'events', 'series'];
    if (opts.motion) kinds.push('motion');

    const written = [];
    for (const kind of kinds) {
        const name = `run-${seed}-${kind}.csv`;
        // `telemetry.csv()` returns a string and never touches a
        // filesystem — that is what lets the same recorder run in a
        // browser tab. Writing is this file's job.
        await writeFile(join(dir, name), telemetry.csv(kind));
        written.push(name);
    }
    return written;
}

// ------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    console.log(`rts-life  ·  ${opts.seeds.length} seed(s) × ${opts.minutes} min`
        + (opts.motion ? '  ·  motion stream on' : ''));

    const runs = [];
    const verdicts = [];

    for (const seed of opts.seeds) {
        const run = runSeed(seed, opts);

        if (opts.csv) {
            const files = await writeStreams(seed, opts);
            if (!opts.quiet) console.log(`  seed ${seed}  →  .captures/${files.join(', ')}`);
        }
        // Verify after the CSVs, because it clears the buffers.
        if (opts.verify) verdicts.push({ seed, ...verifySeed(seed, opts, run.hashes) });

        runs.push(run);
    }

    printTable(runs.map(summarise), 'per seed');
    printDiagnosis(runs);
    printAnomalies(runs);

    if (opts.verify) {
        const bad = verdicts.filter((v) => !v.ok);
        if (!bad.length) console.log(`\nreplay    all ${verdicts.length} seed(s) reproduced exactly`);
        else printTable(bad.map((v) => ({ seed: v.seed, divergedAt: v.at })), 'replay DIVERGED');
    }

    // The detail, only when asked for, and only for a single seed —
    // twenty seeds' worth of audits is not a report, it is a wall.
    if (opts.detail && runs.length === 1) {
        const a = runs[0].audits;
        printTable(a.timeline, 'over time');
        printTable(a.behaviour, 'where the time goes');
        printTable(a.economy, 'economy and combat');
        printTable(a.lifecycle, 'hull lifecycle');
        printTable(a.ships, 'busiest hulls · churn is transitions per minute of life');
        printTable(a.reasons, 'why states ended', 25);
        if (opts.motion) printTable(a.flight, 'flight model');
    } else if (opts.detail) {
        console.log('\n--detail needs a single seed; showing the summary only');
    }

    if (runs.length > 1) {
        const s = runs.map(summarise);
        console.log(`\nacross ${s.length} seeds`);
        console.log('  mean ore extracted       ' + Math.round(mean(s.map((r) => r.ore))));
        console.log('  mean ore lost            ' + Math.round(mean(s.map((r) => r.lostOre))));
        console.log('  mean anomalies           ' + mean(runs.map((r) => r.anomalies.length)).toFixed(1));
        console.log('  mean metal lopsidedness  '
            + (mean(s.map((r) => Number(r.lead))) * 100).toFixed(1) + '%');
    }

    if (opts.baseline) {
        const base = await loadBaseline(opts.baseline);
        if (base) {
            compareBaseline(base, runs, opts);
        } else {
            await saveBaseline(opts.baseline, opts, runs);
            console.log(`\nbaseline  written to ${opts.baseline} — re-run after a change to compare`);
        }
    }

    telemetry.disable().clear();
    console.log('');
}

main();
