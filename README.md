# rts-life

A calm, self-playing 2D space simulation. Two factions mine asteroids, build fleets, and fight over the ore. Nobody plays it — you put it on a screen and it runs.

Zero dependencies, no build step, every pixel drawn procedurally.

---
<img width="1872" height="1206" alt="image" src="https://github.com/user-attachments/assets/d02b0926-c970-453d-b510-f0c4bbe1d84a" />

## Run it

```bash
npm run dev
```

Then open <http://localhost:8123>.

The dev server is a ~90-line zero-dependency script; there is nothing to install.

To read a run instead of watching one:

```bash
npm run sim -- --seeds=1..20 --minutes=10
```

| | |
|---|---|
| `space` | pause |
| `.` or `N` | advance exactly one step, paused |
| `click` a hull | inspect it — full record, and the recorder narrows to it |
| `esc` | clear the selection |
| `G` | toggle the decision-geometry overlay |
| `T` | cycle theme — auto → void → paper |
| `1` `2` `3` `4` | simulation speed |
| `?seed=12345` | replay a run exactly |
| `?skip=420` | fast-forward 420 s before the first paint — about half a second of compute |
| `?until=anomaly` | fast-forward to the first fault the invariant scan finds, and stop on it |
| `?debug=1` | frame cost, per-state entity counts, what each station is building |
| `?debug=2` | the above plus decision geometry: tethers, leashes, targets, claims, berths |
| `?telemetry=1` | record flight, behaviour, events and world scalars to `window.telemetry` |
| `?motion=0` | with the above: skip the per-step physics stream, keep the cheap ones |
| `?streams=` `?type=` `?role=` `?faction=` `?watch=` | record only the streams and ships you care about |

---

## Features

- **Two light models, one codebase** — a dark theme where ships are light emitted onto darkness, and a light theme where they are ink pressed into pale stock. Additive glow is unusable on paper, so the light theme inverts the physics rather than faking it.
- **Ships fly rather than slide** — the main drive is bolted to the back of the hull, so it pushes hard one way and feebly in every other. Ships turn before they accelerate, coast on momentum they earned, and brake bow-first on a retro pack rather than pirouetting to park. Every plume is drawn from the engine that produced it, so the art can never claim thrust the physics did not apply.
- **A real economy** — asteroid ore → drone → miner → treasury → ships. Ore is conserved end to end, and there is a test that proves it.
- **Emergent conflict** — nothing is told to go looking for a fight. Miners follow ore, ore is clustered and contested, fighters escort miners; so the fighting happens where the value is.
- **Deterministic** — no `Math.random()` anywhere in the simulation. The same seed replays exactly, which is what makes a self-playing sim debuggable.
- **Runs forever** — point defence, escort leashes, fleeing miners and emergency production between them ensure a run never settles into one faction mining an empty map.
- **Procedural art** — no sprites, no image assets, no gradients. Every hull is a handful of polygons; role is communicated by silhouette and scale alone.

---

## Developing

```bash
npm test
```

333 tests covering determinism, economy conservation, swept collision, fire cadence, production policy, the thrust envelope, telemetry, behaviour, the renderer and the debugging tools. The entire simulation runs headless under Node with no DOM stubbing, because `src/sim` never imports from `src/render` — and the renderer runs headless too, against a mock 2D context. CI runs all of it plus a five-seed determinism check on every push.

**The guards.** `tests/guards.test.js` executes the project's own rules rather than trusting anyone to remember them: the sim's import closure never touches `render/`, no colour literal exists outside `themes.js`, no `Math.random()` exists at all, every ship class is registered in all four registries, every tunable in `constants.js` is actually read by something, ship objects never grow a field the factory did not declare, and a field's id is its index. Each one is an invariant the project had always claimed; two of them had quietly stopped being true.

**The flight recorder.** Motion bugs are the hardest class to see and the easiest to argue about, so `?telemetry=1` records what every ship is doing step by step — position, velocity, heading, state, all three engine loads, and the steering request that produced them. `telemetry.flight()` turns a run into a per-role motion audit: is anything turning round to brake, is any nose wandering off its flight path while slowing, is a plume lit for thrust that was never applied. It works identically headless under `node`, it is off unless asked for, and there is a test that a recorded run and an unrecorded one are bit-identical.

**The behaviour recorder.** Physics is only half of "what is that ship doing". The recorder also captures every state transition and why it happened — hooked into `setState`, which every behaviour change in the project passes through, so the stream is complete by construction — plus the simulation's own event bus, plus the two *decisions* a run makes (what a station chose to build or what is blocking it, and which field a miner claimed), plus world scalars on an interval, plus a continuous invariant scan that timestamps things the end-of-run tests would never see.

**The debugging session.** Three things that compose into one workflow: *get to the moment, point at the ship, see the rule.* `?skip=420` fast-forwards seven simulated minutes in about half a second, so a late-run bug no longer costs seven minutes of watching per attempt — and `?until=anomaly` finds the fault for you and stops on it. Paused, `.` advances one step at a time. Clicking a hull pins its full record — state and dwell, target, parent, claim, cargo, all three engine loads — and points the recorder at it; if it dies while selected, the panel keeps the record and names what killed it. `G` draws the rules the simulation is actually obeying: tethers, leashes, escort and target lines, claim links, berth rings. Every fault found in the first telemetry sweep was spatial, and every one of them would have been obvious with that overlay on.

**Nothing fails silently.** A behaviour that throws is caught, its hull quarantined, and the fault reported with ship, role, state and tick — instead of taking down the animation loop with an error nobody has a console open to see. CI runs the suite and a five-seed determinism check on every push.

**It records only what you ask for.** Two dials: which *streams* (`motion`, `states`, `events`, `series`, `checks`) and which *ships* (by role, hull class, faction or id). Building a new ship class, `--type=gunship,fighter --streams=states,events` records that class and what it fights, and nothing else. Whatever you narrow, the diagnosis says so — a miners-only capture shows zero shots, which is indistinguishable from a fleet that never fires unless the tool admits what it ignored.

**It folds its own repetition, as it records.** The floods a log produces are exactly the conditions you opened it to investigate, so identical rows collapse in flight — one row per delivery instead of per transfer, one row per burst of state-flipping instead of per flip, one line per fault instead of per sighting. Each keeps a count and a window: `miner in 'work' for 500s — 60.5s→180s ×134`. It is time-bounded rather than keyed on equality alone, because a drone docking eighty-five times over ten minutes is eighty-five facts and the same drone flipping twice a second is one; and `burstGap = 0` switches it off when the folding is what you suspect. A test proves both settings produce identical audits.

**The diagnosis.** Six tables of numbers is not the same thing as knowing what is wrong, so `telemetry.diagnose()` reads them for you: ranked findings, each carrying the figure it fired on. The rules are shapes rather than specifics — a state with no recorded exit, a worst-case dwell many times its mean, two states trading places, hundreds of visits averaging under half a second — so they catch the next instance rather than the last one. It also reports when *its own numbers* should not be trusted, because a filtered recording showing zero shots is indistinguishable from a fleet that never fires.

**The report.** A self-playing simulation should be readable without watching it, so:

```
npm run sim -- --seeds=1..20 --minutes=10
```

runs twenty seeds headless in about seventeen seconds and prints forty lines: a summary row per seed, then the diagnosis merged across all of them. `--detail` adds every audit for a single seed, `--baseline=file.json` compares against a recorded run so you can tell whether a change helped, `--verify` re-runs each seed and checks the replay is identical, `--csv` writes each stream to `.captures/`.

Its first sweep found five faults, none of which crashed anything, failed a test, or looked wrong on screen: a mothership that never left the `building` state after its first hull; drones "unloading" for two minutes while riding along with a full parent; orphaned drones working five hundred units out on a two-hundred-and-fifty-unit tether; fighters acquiring a target and abandoning it one step later, 540 times out of 744, without ever flying home; and two factions fighting over a single field-claim slot, 1,662 re-claims for 37 deliveries.

Fixing those moved the numbers the tool reports on itself — **high findings 10 → 0, anomalies 6.2 → 0 per seed, longest state 600 s → 162 s**, all twenty seeds still replaying exactly — and cost 6% of ore throughput, which is miners that now genuinely avoid each other spreading across more fields. That trade is a design question; the point is that it is now a question with numbers attached.

Two inspection pages, both served by `npm run dev`:

| | |
|---|---|
| [`/dev/hulls.html`](dev/hulls.html) | Every hull, large, in both themes, plus a solid-black silhouette test |
| [`/dev/fx.html`](dev/fx.html) | A looping duel and a mining beam at true game scale and magnified |

Adding a ship class costs three data edits and one draw function. See the cookbook.
