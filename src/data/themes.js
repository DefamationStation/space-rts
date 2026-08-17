// ============================================================
// THEMES — THE ONLY PLACE COLOUR LIVES
// ============================================================
//
// Gospel rule 1: no colour literal exists anywhere else in this
// project. Renderers receive a resolved theme object and read
// from it. If you find yourself typing a `#` outside this file,
// stop and add a named slot here instead.
//
// ------------------------------------------------------------
// TWO THEMES, ONE STRUCTURE
// ------------------------------------------------------------
//
//   void   dark  — ships are light emitted onto darkness
//   paper  light — ships are ink pressed onto pale stock
//
// Both themes have identical shape, so every renderer is written
// once and works in both. What changes is not just the hex codes
// but the *light model* (see `fx` below), because glow and ink
// are physically opposite things and faking one with the other
// is exactly what makes a scene look cheap.
//
// ------------------------------------------------------------
// THE CONTRAST RULE
// ------------------------------------------------------------
//
// Within a faction, slots are ordered by distance from the
// ground colour:
//
//   plate   nearest the ground  — structural mass, recedes
//   hull    mid                 — the body, carries the identity
//   accent  furthest            — the stripe, reads first
//
// Stated that way the rule holds in both themes without
// inverting: on `void` accent is the *lightest* slot, on `paper`
// it is the *darkest*. Renderers never need to know which.

/** Layered-stroke recipe. Widths run outer→inner; the last entry is the core. */
const layers = (widths, alphas) => ({ widths, alphas });

export const THEMES = {

    // ========================================================
    // VOID — dark
    // ========================================================
    void: {
        id: 'void',
        label: 'void',

        ground: '#0f1219',
        grid: '#191d28',

        hud: {
            text: '#8a94a6',
            dim: '#565f70',
        },

        neutral: {
            rock: '#39404f',      // asteroid body fill
            rockEdge: '#4e5566',  // asteroid rim
            vein: '#9fb0c0',      // exposed metal, the reason to mine it
            debris: '#3a4150',    // dead hull shards
        },

        factions: [
            {   // 0 — sea-glass
                plate: '#26313a',
                hull: '#6fc2b0',
                accent: '#a8ddd0',
                weapon: '#8fe0cc',
                flash: '#eafff8',   // hot core of a tracer; near-white only on void
                thruster: '#8fe0cc',
            },
            {   // 1 — warm sand
                plate: '#3a3129',
                hull: '#c89a7e',
                accent: '#e0c0a6',
                weapon: '#e8b48e',
                flash: '#fff4ea',
                thruster: '#e8b48e',
            },
            {   // 2 — the swarm: not a faction, a hazard
                //
                // Deliberately desaturated and cold. Gospel rule 7 caps
                // the screen at two *accent* hues, and this does not
                // spend a third — it is built from the neutral end of
                // the palette so the swarm reads as an absence of
                // colour among two coloured fleets. A thing with no
                // side.
                plate: '#1d2026',
                hull: '#59606b',
                accent: '#8d98a6',
                weapon: '#b6a6d6',
                flash: '#e6dcff',
                thruster: '#9b8cc4',
            },
            {   // 3 — the exchange: a third party, not a third side
                //
                // Gospel rule 7 caps the screen at two accent hues and
                // this does not spend one either. Where the swarm is
                // built from the cold neutral end, the exchange is
                // built from the warm neutral end — bone and lamp-
                // light rather than a colour with an allegiance. It
                // has to read as *not participating*, which means it
                // must not look like either fleet and must not look
                // like the hazard.
                //
                // `flash` carries the only bright note in it, and it
                // is spent on the banner rather than on a weapon,
                // because this is the one structure on the map that
                // never fires.
                plate: '#2b2721',
                hull: '#9a9184',
                accent: '#cfc4b0',
                weapon: '#cfc4b0',
                flash: '#fff6e2',
                thruster: '#cfc4b0',
            },
        ],

        // ----------------------------------------------------
        // LIGHT MODEL — additive
        // ----------------------------------------------------
        // On darkness, weapon fire genuinely *is* light, so it
        // composites additively and overlapping shots bloom into
        // each other the way real light does. The core layer is
        // drawn in `flash` (near-white) because anything hot
        // enough to see reads as white at its centre.
        fx: {
            composite: 'lighter',
            hotCore: true,
            intensity: 1.0,
            // Tracers are stamped from a pre-rendered comet sprite
            // rather than stroked; see the long note in render/draw.js
            // for why. `tracerScale` multiplies the weapon's own
            // length, `tracerGlow` its brightness.
            tracerScale: 1.15,
            tracerGlow: 1.0,
            muzzle: layers([9.0, 5.0, 2.2], [0.14, 0.26, 0.75]),
            impact: layers([3.4, 1.6, 0.9], [0.16, 0.34, 0.70]),
            beam: layers([4.6, 2.0, 0.9], [0.10, 0.20, 0.55]),
            sparkAlpha: 0.75,
        },
    },

    // ========================================================
    // PAPER — light
    // ========================================================
    paper: {
        id: 'paper',
        label: 'paper',

        ground: '#e8ead6',
        grid: '#d8dac6',

        hud: {
            text: '#6b7263',
            dim: '#9aa091',
        },

        neutral: {
            rock: '#c9cbb8',
            rockEdge: '#a5a894',
            vein: '#7d8470',
            debris: '#b4b7a4',
        },

        factions: [
            {   // 0 — sea-glass ink
                plate: '#b6c6bd',
                hull: '#3f8f7d',
                accent: '#1e4c40',
                weapon: '#2f8875',
                flash: '#2f8875',   // no white on paper — see the note below
                thruster: '#5aa896',
            },
            {   // 1 — warm sand ink
                plate: '#cdbcae',
                hull: '#a86a48',
                accent: '#5e3620',
                weapon: '#b06c42',
                flash: '#b06c42',
                thruster: '#c08056',
            },
            {   // 2 — the swarm, on paper
                plate: '#c2c4c8',
                hull: '#6b6f78',
                accent: '#4a4e57',
                weapon: '#6f5f96',
                flash: '#3b2f5c',
                thruster: '#6f5f96',
            },
            {   // 3 — the exchange: a third party, not a third side
                // See the note in the void palette. Warm neutrals,
                // no third accent hue, legible against paper without
                // competing with either fleet.
                plate: '#d9d2c4',
                hull: '#8a8274',
                accent: '#6d6558',
                weapon: '#6d6558',
                flash: '#4a443a',
                thruster: '#6d6558',
            },
        ],

        // ----------------------------------------------------
        // LIGHT MODEL — ink
        // ----------------------------------------------------
        // Additive blending is unusable here: adding light to a
        // pale ground moves it toward white, so every effect
        // would dissolve instead of appearing. So on paper we
        // invert the physics — a tracer is not light, it is a
        // saturated ink stroke with a soft same-hue halo bleeding
        // outward into the stock, the way a felt-tip pen wicks
        // into fibre. Contrast comes from darkness.
        //
        // `hotCore: false` is the important half of that: a white
        // core on pale paper is invisible, so the core layer
        // stays the faction's own ink at near-full alpha.
        fx: {
            composite: 'source-over',
            hotCore: false,
            intensity: 1.0,
            // Ink wicks a little further than light blooms, and needs
            // more of it to register against pale stock.
            tracerScale: 1.25,
            tracerGlow: 1.35,
            muzzle: layers([8.0, 4.4, 2.0], [0.12, 0.22, 0.62]),
            impact: layers([3.2, 1.6, 0.9], [0.14, 0.30, 0.68]),
            beam: layers([4.2, 1.9, 0.9], [0.11, 0.22, 0.60]),
            sparkAlpha: 0.72,
        },
    },
};

export const DEFAULT_THEME = 'void';
