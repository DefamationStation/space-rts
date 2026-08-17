// ============================================================
// THEME — RESOLUTION AND CSS BRIDGE
// ============================================================
//
// Decides which palette from `data/themes.js` is active and keeps
// the DOM in step with it.
//
// Two consumers need the palette and they consume it differently:
// canvas renderers read the theme object directly, while the HUD
// is styled in CSS and cannot import JavaScript. Rather than
// duplicate hex codes into `style.css` — which would break gospel
// rule 1 the moment one of them drifted — this module writes the
// handful of colours the chrome needs onto `:root` as custom
// properties. `data/themes.js` stays the only source.
//
// Mode is tri-state: 'auto' follows the OS, 'void' and 'paper'
// pin it. Auto is the default because a wallpaper-ish thing that
// ignores the user's own light/dark preference is rude.

import { THEMES, DEFAULT_THEME } from '../data/themes.js';

const MODES = ['auto', 'void', 'paper'];

export class ThemeManager {
    /** @param {(theme:object)=>void} [onChange] fired whenever the active theme changes */
    constructor(onChange) {
        this.onChange = onChange || null;
        this.mode = 'auto';
        this.media = window.matchMedia('(prefers-color-scheme: light)');
        this.current = null;

        this._onMediaChange = () => {
            if (this.mode === 'auto') this._apply();
        };
        this.media.addEventListener('change', this._onMediaChange);

        this._apply();
    }

    /** @param {'auto'|'void'|'paper'} mode */
    setMode(mode) {
        if (!MODES.includes(mode)) return;
        this.mode = mode;
        this._apply();
    }

    /** Cycle auto → void → paper → auto. Bound to the `T` key. */
    cycle() {
        this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
        return this.mode;
    }

    _resolveId() {
        if (this.mode !== 'auto') return this.mode;
        return this.media.matches ? 'paper' : DEFAULT_THEME;
    }

    _apply() {
        const theme = THEMES[this._resolveId()] || THEMES[DEFAULT_THEME];
        if (theme === this.current) return;
        this.current = theme;

        // Let CSS style the chrome without ever naming a colour itself.
        const root = document.documentElement;
        root.dataset.theme = theme.id;
        root.style.setProperty('--c-ground', theme.ground);
        root.style.setProperty('--c-grid', theme.grid);
        root.style.setProperty('--c-hud-text', theme.hud.text);
        root.style.setProperty('--c-hud-dim', theme.hud.dim);
        for (let i = 0; i < theme.factions.length; i++) {
            root.style.setProperty('--c-faction-' + i, theme.factions[i].hull);
        }

        if (this.onChange) this.onChange(theme);
    }
}
