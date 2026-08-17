// ============================================================
// HUD
// ============================================================
//
// Two corner readouts and, on request, a debug block. That is all.
//
// The restraint is the design. This is something you watch, not
// something you operate, so an interface would be answering a
// question nobody asked — and every pixel of chrome is a pixel
// competing with the thing it is describing. What survives is the
// minimum needed to follow the story: how rich each side is, and
// how big its fleet is.
//
// The HUD lives in the DOM rather than on the canvas. It gets
// crisp text rendering and real font metrics for free, it does not
// consume canvas fill rate every frame, and it can be styled in
// `style.css` — which is also why `render/theme.js` publishes the
// palette as CSS custom properties.
//
// Text is only written when it changes. A `textContent` assignment
// invalidates layout even when the string is identical, and at
// 144 Hz that is a needless reflow per readout per frame.

import { FACTIONS, isPlayed } from '../data/factions.js';
import { EV } from '../core/events.js';

export class HUD {
    constructor(world, { debug = false } = {}) {
        this.world = world;
        this.debugOn = debug;
        this.selectedShipId = 0;
        this.deathRecord = null;

        this.rows = FACTIONS.map((def) => {
            const el = typeof document !== 'undefined' ? document.querySelector('.hud-faction[data-faction="' + def.id + '"]') : null;
            return {
                name: el?.querySelector('.hud-name') ?? null,
                stats: el?.querySelector('.hud-stats') ?? null,
                lastName: '',
                lastStats: '',
            };
        });

        this.debugEl = typeof document !== 'undefined' ? document.getElementById('debug') : null;
        if (this.debugEl) this.debugEl.hidden = !debug;

        this.statusEl = typeof document !== 'undefined' ? document.getElementById('hud-status') : null;
        if (this.statusEl) this.statusEl.hidden = true;

        this.inspectorEl = typeof document !== 'undefined' ? document.getElementById('inspector') : null;
        if (this.inspectorEl) this.inspectorEl.hidden = true;

        this.selectionEl = typeof document !== 'undefined' ? document.getElementById('selection') : null;
        if (this.selectionEl) this.selectionEl.hidden = true;

        /** Ids of a multi-hull selection. Empty when zero or one is picked. */
        this.selectedIds = [];

        this._debugAt = 0;
        this._lastInspectorText = '';
        this._lastSelectionText = '';

        // Subscribe to ship death to capture death records for inspected ship
        world.events.on(EV.SHIP_DIED, (e) => {
            if (this.selectedShipId && e.ship && e.ship.id === this.selectedShipId) {
                const s = e.ship;
                const k = e.killerId ? this.world.byId.get(e.killerId) : null;
                const f = this.world.faction(s.factionId);
                const kf = k ? this.world.faction(k.factionId) : null;
                this.deathRecord = {
                    id: s.id,
                    type: s.type,
                    role: s.role,
                    factionId: s.factionId,
                    factionName: f ? f.name : 'Faction ' + s.factionId,
                    time: this.world.time,
                    tick: this.world.tick,
                    killerId: e.killerId || 0,
                    killerType: k ? k.type : '',
                    killerRole: k ? k.role : '',
                    killerFactionName: kf ? kf.name : '',
                    lastState: s.state || '-',
                    lastStateTime: s.stateTime,
                    lastX: s.x,
                    lastY: s.y,
                    lastVx: s.vx,
                    lastVy: s.vy,
                    lastAngle: s.angle,
                    hpMax: s.maxHp,
                    lastCargo: s.cargo,
                    cargoMax: s.cargoMax,
                    lastTargetId: s.targetId,
                    lastParentId: s.parentId,
                    lastClaimId: s.claimId,
                    lastEscortId: s.escortId,
                    throttle: s.throttle,
                    rcsLat: s.rcsLat,
                    rcsRetro: s.rcsRetro,
                    quarantined: !!s.quarantined,
                    quarantineError: s.quarantineError || '',
                };
            }
        });
    }

    selectShip(id) {
        this.selectedShipId = id || 0;
        if (!this.selectedShipId) {
            this.deathRecord = null;
            if (this.inspectorEl) this.inspectorEl.hidden = true;
        } else {
            const live = this.world.byId.get(this.selectedShipId);
            if (live && !live.dead) this.deathRecord = null;
            if (this.inspectorEl) this.inspectorEl.hidden = false;
        }
    }

    /**
     * Set a whole selection at once.
     *
     * One hull selected is not a small case of many — it is a
     * different question. "What is this ship doing" wants the full
     * dossier: state, target, escort, claim, engines. "What did I just
     * box-select" wants a roster you can scan. So one id drives the
     * existing `#inspector` unchanged, and two or more drive the
     * compact `#selection` board instead, never both.
     *
     * `selectShip` and `selectedShipId` are deliberately untouched by
     * this. They are the single-hull API that the tooling tests and
     * `telemetry.watch` are written against, and this is additive.
     */
    setSelection(ids) {
        const list = Array.isArray(ids) ? ids.filter(Boolean) : [];

        if (list.length > 1) {
            this.selectedIds = list;
            this.selectShip(0);
            if (this.selectionEl) this.selectionEl.hidden = false;
            return;
        }

        this.selectedIds = [];
        if (this.selectionEl) this.selectionEl.hidden = true;
        this.selectShip(list.length === 1 ? list[0] : 0);
    }

    /**
     * Turn the debug block on or off at runtime.
     *
     * It used to be settable only by `?debug=1` at load, which meant
     * the one readout that says what every station is deciding could
     * not be reached from inside a running tab. The controls panel
     * needs it, and so does anyone who notices something odd two
     * minutes into a run they do not want to restart.
     */
    setDebug(on) {
        this.debugOn = !!on;
        if (this.debugEl) this.debugEl.hidden = !this.debugOn;
    }

    setFastForward({ seconds, ticks }) {
        if (!this.statusEl) return;
        const text = 'FAST-FORWARD +' + seconds.toFixed(0) + 'S (TICK ' + ticks + ')';
        this.statusEl.textContent = text;
        this.statusEl.hidden = false;
    }

    setAnomaly({ found, time, tick, anomaly }) {
        if (!this.statusEl) return;
        const text = found
            ? 'ANOMALY AT ' + time.toFixed(1) + 'S (TICK ' + tick + '): ' + (anomaly?.what || 'anomaly')
            : 'NO ANOMALIES (SCANNED ' + time.toFixed(0) + 'S)';
        this.statusEl.textContent = text;
        this.statusEl.hidden = false;
    }

    update(loop, themes) {
        const world = this.world;

        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            const faction = world.factions[i];
            if (!faction || !row.stats) continue;

            if (row.lastName !== faction.name) {
                row.lastName = faction.name;
                if (row.name) row.name.textContent = faction.name;
            }

            const counts = faction.counts;
            const stats = Math.round(faction.metal)
                + ' · ' + (counts.miner || 0) + 'M'
                + ' · ' + (counts.fighter || 0) + 'F';

            if (row.lastStats !== stats) {
                row.lastStats = stats;
                row.stats.textContent = stats;
            }
        }

        if (this.debugOn) this.updateDebug(loop, themes);
        if (this.selectedShipId) this.updateInspector(loop, themes);
        if (this.selectedIds.length > 1) this.updateSelection();
    }

    /**
     * The compact board: one line per selected hull.
     *
     * Capped, and the cap is visible. A drag across a busy middle can
     * catch forty hulls, and forty lines of nine-pixel type is not a
     * readout, it is a wall — the same argument `tools/sim.mjs` makes
     * about a report nobody finishes reading. So it lists the first
     * few and says how many it did not.
     */
    updateSelection() {
        if (!this.selectionEl) return;

        const LIMIT = 14;
        const world = this.world;
        const live = [];
        for (const id of this.selectedIds) {
            const s = world.byId.get(id);
            if (s && !s.dead) live.push(s);
        }

        const lines = [`SELECTED ${live.length}`];
        for (let i = 0; i < Math.min(LIMIT, live.length); i++) {
            const s = live[i];
            const faction = world.faction(s.factionId);
            const hp = Math.max(0, Math.round((s.hp / s.maxHp) * 100));
            lines.push(
                ('#' + s.id).padEnd(6)
                + String(s.type).padEnd(11)
                + String(faction ? faction.name : s.factionId).padEnd(11)
                + (hp + '%').padStart(4) + '  '
                + (s.state || '-'),
            );
        }
        if (live.length > LIMIT) lines.push(`… ${live.length - LIMIT} more`);

        const text = lines.join('\n');
        if (this._lastSelectionText !== text) {
            this._lastSelectionText = text;
            this.selectionEl.textContent = text;
        }
    }

    /**
     * Refreshed a few times a second rather than every frame — the
     * numbers are unreadable faster than that, and formatting them
     * is more expensive than anything else the HUD does.
     */
    updateDebug(loop, themes) {
        if (!this.debugEl) return;
        const world = this.world;
        if (world.time - this._debugAt < 0.2) return;
        this._debugAt = world.time;

        const states = Object.create(null);
        for (const ship of world.ships) {
            if (ship.role === 'mothership') continue;
            const key = ship.role + ':' + (ship.state || '-');
            states[key] = (states[key] || 0) + 1;
        }

        const lines = [
            'seed    ' + world.seed,
            'theme   ' + themes.current.id + ' (' + themes.mode + ')',
            'time    ' + world.time.toFixed(1) + 's   tick ' + world.tick,
            'speed   ' + loop.speed + '×   steps/frame ' + loop.stepsLastFrame,
            'sim     ' + loop.simMs.toFixed(2) + ' ms',
            'draw    ' + loop.drawMs.toFixed(2) + ' ms',
            'ships   ' + world.ships.length
                + '   rocks ' + world.asteroids.length
                + '   shots ' + world.projectiles.length
                + '   fx ' + world.particles.length,
            'ore     ' + world.oreExtracted.toFixed(0) + ' extracted'
                + (world.oreLost > 0 ? '   ' + world.oreLost.toFixed(0) + ' lost' : ''),
            '',
        ];

        if (world.errors && world.errors.length > 0) {
            lines.push('! ERRORS  ' + world.errors.length + ' quarantined');
            const lastErr = world.errors[world.errors.length - 1];
            lines.push('  last:   ' + lastErr.type + '#' + lastErr.id + ' "' + lastErr.error + '"');
            lines.push('');
        }

        // What each station is doing about production. A faction
        // sitting on a treasury and building nothing is the economy's
        // most common wrong-looking-but-fine state, and until this line
        // existed the only way to tell it from a stall was to read the
        // policy table and do the arithmetic yourself.
        for (const ship of world.ships) {
            if (ship.role !== 'mothership') continue;
            const faction = world.factions[ship.factionId];
            const doing = ship.buildType
                ? 'building ' + ship.buildType
                    + ' ' + Math.max(0, ship.buildEnd - world.time).toFixed(1) + 's'
                : (ship.buildBlocked || 'idle');
            lines.push('  ' + (faction ? faction.name : '?').padEnd(11) + doing);
        }
        lines.push('');

        // Strategy. The highest-level decision each faction is making
        // and the strength ratio that justifies it — without both, a
        // posture on screen is an assertion you cannot check.
        for (const faction of world.factions) {
            // Only factions that actually hold a strategy. The swarm
            // has no posture and the exchange has no war, so both
            // would print a row of blanks and an infinite ratio —
            // which reads as a bug in the posture layer rather than
            // as two factions that were never in it.
            if (!isPlayed(faction)) continue;
            const ratio = faction.hostileStrength > 0
                ? (faction.strength / faction.hostileStrength).toFixed(2)
                : '∞';
            lines.push('  ' + faction.name.padEnd(11)
                + String(faction.posture).padEnd(9)
                + 'str ' + String(faction.strength).padStart(4)
                + '  ×' + ratio);
        }
        lines.push('');

        for (const key of Object.keys(states).sort()) {
            lines.push('  ' + key.padEnd(18) + states[key]);
        }

        this.debugEl.textContent = lines.join('\n');
    }

    updateInspector(loop, themes) {
        if (!this.inspectorEl || !this.selectedShipId) return;

        const ship = this.world.byId.get(this.selectedShipId);
        const lines = [];

        if (ship && !ship.dead) {
            const faction = this.world.faction(ship.factionId);
            const factionName = faction ? faction.name : 'Faction ' + ship.factionId;
            const speed = Math.hypot(ship.vx, ship.vy);
            const rawDeg = (ship.angle * 180) / Math.PI;
            const heading = ((rawDeg % 360) + 360) % 360;
            const hpPct = Math.max(0, Math.round((ship.hp / ship.maxHp) * 100));

            lines.push(`SHIP #${ship.id} · ${ship.type} (${factionName})`);
            if (ship.quarantined) {
                lines.push(`STATUS    QUARANTINED: ${ship.quarantineError || 'error'}`);
            }
            lines.push(`state     ${ship.state || '-'} (${ship.stateTime.toFixed(1)}s)`);
            lines.push(`target    ${ship.targetId ? '#' + ship.targetId : '-'}   escort  ${ship.escortId ? '#' + ship.escortId : '-'}`);
            lines.push(`parent    ${ship.parentId ? '#' + ship.parentId : '-'}   claim   ${ship.claimId >= 0 ? 'field' + ship.claimId : '-'}`);
            lines.push(`hull      ${ship.hp.toFixed(1)}/${ship.maxHp} (${hpPct}%)`);
            lines.push(`cargo     ${ship.cargo.toFixed(1)}/${ship.cargoMax}`);
            lines.push(`pos       ${ship.x.toFixed(1)}, ${ship.y.toFixed(1)}`);
            lines.push(`speed     ${speed.toFixed(1)} u/s   heading ${heading.toFixed(1)}°`);
            lines.push(`engines   thr ${ship.throttle.toFixed(2)}  lat ${ship.rcsLat.toFixed(2)}  ret ${ship.rcsRetro.toFixed(2)}`);
        } else if (this.deathRecord) {
            const d = this.deathRecord;
            const speed = Math.hypot(d.lastVx, d.lastVy);
            const rawDeg = (d.lastAngle * 180) / Math.PI;
            const heading = ((rawDeg % 360) + 360) % 360;

            lines.push(`SHIP #${d.id} · ${d.type} (${d.factionName}) [DESTROYED]`);
            lines.push(`killed at ${d.time.toFixed(1)}s (tick ${d.tick})`);
            if (d.killerId) {
                const kDesc = d.killerType ? `${d.killerType} (${d.killerFactionName})` : 'unknown';
                lines.push(`killer    #${d.killerId} ${kDesc}`);
            } else {
                lines.push(`killer    none (attrition/self)`);
            }
            lines.push(`state     ${d.lastState} (lasted ${d.lastStateTime.toFixed(1)}s)`);
            lines.push(`target    ${d.lastTargetId ? '#' + d.lastTargetId : '-'}   escort  ${d.lastEscortId ? '#' + d.lastEscortId : '-'}`);
            lines.push(`parent    ${d.lastParentId ? '#' + d.lastParentId : '-'}   claim   ${d.lastClaimId >= 0 ? 'field' + d.lastClaimId : '-'}`);
            lines.push(`hull      0.0/${d.hpMax} (0%)`);
            lines.push(`cargo     ${d.lastCargo.toFixed(1)}/${d.cargoMax}`);
            lines.push(`pos       ${d.lastX.toFixed(1)}, ${d.lastY.toFixed(1)}`);
            lines.push(`speed     ${speed.toFixed(1)} u/s   heading ${heading.toFixed(1)}°`);
            lines.push(`engines   thr 0.00  lat 0.00  ret 0.00`);
        } else {
            lines.push(`SHIP #${this.selectedShipId} [NOT FOUND / DESTROYED]`);
        }

        const text = lines.join('\n');
        if (this._lastInspectorText !== text) {
            this._lastInspectorText = text;
            this.inspectorEl.textContent = text;
        }
    }
}
