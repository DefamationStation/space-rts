// ============================================================
// CONTROLS — THE PANEL
// ============================================================
//
// Every binding this project has was a keyboard shortcut nobody
// could discover. That was defensible while the whole thing fit on
// one screen and the only controls were pause and theme; it stopped
// being defensible once there was a camera, a selection, three
// overlays and four simulation speeds.
//
// So the panel is not a replacement for the shortcuts — it is where
// you *learn* them. Every row carries its key next to it, and every
// action here does exactly what the key does, by calling the same
// function. There is deliberately no control that has no shortcut.
//
// ------------------------------------------------------------
// WHY IT IS COLLAPSED
// ------------------------------------------------------------
//
// Gospel: the simulation is the subject, not the interface. An
// always-open toolbar in the corner of a piece you are supposed to
// leave running is a permanent tax on the thing it is describing, so
// the resting state is one 26-pixel button at 45% opacity and
// everything else is behind it.
//
// ------------------------------------------------------------
// WHY THIS FILE OWNS NO STATE
// ------------------------------------------------------------
//
// It holds no truth of its own. Theme lives in ThemeManager, speed
// and pause in Loop, camera in Stage, overlay flags in main.js — and
// this reads all of them back every frame through `sync()` rather
// than tracking them.
//
// That is what keeps the panel honest when something changes behind
// its back. Press `T` and the theme row updates; press `2` and the
// speed row follows; pause with the spacebar and the button lights.
// A panel that cached its own copy would drift the first time a
// shortcut was used, and a control that lies about the current state
// is worse than no control.

/** Which buttons are radio groups, and how to read the live value. */
const GROUPS = {
    theme: (ctx) => ctx.themes.mode,
    speed: (ctx) => String(ctx.loop.speed),
    side: (ctx) => String(ctx.flags.spawnSide),
    wave: (ctx) => String(ctx.flags.waveSize),
};

export class Controls {
    /**
     * @param {object} ctx wiring to everything the panel reflects
     *   loop, themes, stage — read for state and driven for actions
     *   flags   — mutable overlay state owned by main.js
     *   actions — callbacks for things only main.js can do
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.root = document.getElementById('controls');
        this.toggle = document.getElementById('controls-toggle');
        this.panel = document.getElementById('controls-panel');
        this.note = document.getElementById('controls-note');
        if (!this.root || !this.toggle || !this.panel) return;

        this._noteUntil = 0;

        this.toggle.addEventListener('click', () => this.setOpen(this.panel.hidden));
        this.panel.addEventListener('click', (e) => this.onClick(e));

        // Escape closes the panel, but only when it is open — otherwise
        // it would swallow the deselect binding.
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Escape' && !this.panel.hidden) this.setOpen(false);
        });

        this.setOpen(false);
    }

    setOpen(open) {
        this.panel.hidden = !open;
        this.root.dataset.open = open ? '1' : '0';
        this.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        // Fill it in *now* rather than on the next frame. `sync` skips
        // a hidden panel, so opening it and waiting for the render loop
        // showed a panel with nothing selected for one frame — and on a
        // paused run, where the draw callback still fires, for one
        // frame that the eye lands on precisely because it just moved.
        if (open) this.sync();
    }

    onClick(e) {
        const btn = e.target.closest('button');
        if (!btn) return;
        const { loop, themes, stage, flags, actions } = this.ctx;

        const group = btn.parentElement?.dataset.group;
        if (group === 'theme') themes.setMode(btn.dataset.value);
        else if (group === 'speed') loop.speed = Number(btn.dataset.value);
        else if (group === 'side') flags.spawnSide = Number(btn.dataset.value);
        else if (group === 'wave') flags.waveSize = Number(btn.dataset.value);

        // Sandbox. Hulls appear at the middle of the *view* rather
        // than the middle of the world, so whatever you spawn is
        // already on screen — the entire point is looking at it.
        if (btn.dataset.spawn) {
            // Alien hulls ignore the A/B side selector — the swarm is
            // its own faction and spawning one "for A" is meaningless.
            const side = btn.dataset.alien ? actions.swarmFaction() : flags.spawnSide;
            const n = actions.spawn(btn.dataset.spawn, side, stage.camX, stage.camY);
            this.say('spawned ' + btn.dataset.spawn + ' #' + n);
        }

        switch (btn.dataset.action) {
            case 'pause':
                document.body.classList.toggle('is-paused', loop.togglePause());
                break;
            case 'step':
                loop.stepOnce();
                document.body.classList.add('is-paused');
                break;
            case 'fit': stage.fitAll(); break;
            case 'link': this.copyLink(); break;
            case 'heal': this.say(actions.healSelected() + ' repaired'); break;
            case 'kill': this.say(actions.killSelected() + ' destroyed'); break;
            case 'clear': this.say(actions.clearShips() + ' hulls removed'); break;
            case 'incursion': {
                // `auto` (0) sends whatever the schedule would have
                // sent at this point in the run, so the button and the
                // real thing agree unless a size is asked for.
                const n = actions.incursion(stage.camX, stage.camY, flags.waveSize);
                this.say('incursion inbound — ' + n + ' hulls'
                    + (flags.waveSize ? ' (forced)' : ' (auto)'));
                break;
            }
            case 'warp': this.say(actions.warpSelected() + ' dropping in'); break;
            case 'truce': this.say(actions.toggleTruce() ? 'truce ON' : 'truce off'); break;
            case 'mobilise': this.say(actions.mobilise() + ' on war footing'); break;
            case 'metal': actions.grantMetal(500); this.say('+500 metal to both'); break;
        }

        switch (btn.dataset.toggle) {
            case 'gizmos': flags.gizmos = !flags.gizmos; break;
            case 'debug': actions.setDebug(!flags.debug); break;
            case 'hud':
                flags.hudHidden = !flags.hudHidden;
                document.body.classList.toggle('hud-hidden', flags.hudHidden);
                break;
            case 'follow':
                // Following nothing is not a mode worth being in.
                if (!flags.follow && !actions.selectedId()) {
                    this.say('select a ship first');
                    return;
                }
                flags.follow = !flags.follow;
                break;
        }

        this.sync();
    }

    /**
     * A link that replays this exact moment.
     *
     * The one control here with no keyboard equivalent, and it earns
     * the exception because it is not really a control — it is the
     * determinism guarantee made usable. A run is a pure function of
     * its seed, and `?skip=` fast-forwards before the first paint, so
     * seed plus elapsed time *is* the frame on screen. Nothing else in
     * the project lets you hand somebody what you are looking at.
     */
    copyLink() {
        const { world } = this.ctx;
        const url = new URL(location.href);
        url.searchParams.set('seed', String(world.seed));
        url.searchParams.set('skip', world.time.toFixed(1));
        // The world's width follows the display, so a link that
        // carried only the seed would reproduce a differently-shaped
        // map on a differently-shaped screen — same seed, different
        // geography, and the promise of "this exact moment" quietly
        // broken.
        url.searchParams.set('w', String(Math.round(world.width)));
        const text = url.toString();

        // Clipboard access can be refused, and a button that silently
        // does nothing is worse than one that tells you where the
        // value went.
        const ok = () => this.say('link copied · seed ' + world.seed
            + ' @ ' + world.time.toFixed(0) + 's');
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(ok, () => {
                console.log(text);
                this.say('clipboard blocked — link in console');
            });
        } else {
            console.log(text);
            this.say('link in console');
        }
    }

    /** A transient line under the panel. Cleared by `sync`. */
    say(message) {
        if (!this.note) return;
        this.note.textContent = message;
        this.note.dataset.show = '1';
        this._noteUntil = (this.ctx.world?.time ?? 0) + 4;
    }

    /**
     * Push live state into the panel. Called every frame from the
     * render callback — it is a handful of dataset writes on a dozen
     * elements, and only while the panel is open.
     */
    sync() {
        if (!this.panel || this.panel.hidden) return;
        const { loop, flags, world } = this.ctx;

        for (const seg of this.panel.querySelectorAll('.ctl-seg[data-group]')) {
            const current = GROUPS[seg.dataset.group]?.(this.ctx);
            for (const btn of seg.children) {
                btn.dataset.active = btn.dataset.value === current ? '1' : '0';
            }
        }

        const state = {
            gizmos: flags.gizmos,
            debug: flags.debug,
            hud: flags.hudHidden,
            follow: flags.follow,
        };
        for (const btn of this.panel.querySelectorAll('button[data-toggle]')) {
            btn.dataset.active = state[btn.dataset.toggle] ? '1' : '0';
        }

        const pause = this.panel.querySelector('button[data-action="pause"]');
        if (pause) pause.dataset.active = loop.paused ? '1' : '0';

        if (this.note && this.note.dataset.show === '1'
            && (world?.time ?? 0) > this._noteUntil) {
            this.note.dataset.show = '0';
        }
    }
}
