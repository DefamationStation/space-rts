// ============================================================
// COLOUR
// ============================================================
//
// Small helpers for turning the hex strings in `data/themes.js`
// into something a canvas context will accept. Parsing is cached
// because these run inside per-frame draw loops and `#rrggbb`
// strings are a fixed, tiny set.
//
// This file knows how to *manipulate* colour. It never *defines*
// any — see gospel rule 1.

/** @type {Map<string, {r:number, g:number, b:number}>} */
const _parsed = new Map();

/**
 * Parse `#rgb` or `#rrggbb` into channel values. Results are memoised
 * on the string, so repeat calls in a draw loop are a map lookup.
 */
export function parseHex(hex) {
    let rgb = _parsed.get(hex);
    if (rgb) return rgb;

    let h = hex.charCodeAt(0) === 35 /* # */ ? hex.slice(1) : hex;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];

    const n = parseInt(h, 16);
    rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    _parsed.set(hex, rgb);
    return rgb;
}

/** `#6fc2b0` + 0.24 → `rgba(111,194,176,0.24)`. */
export function rgba(hex, alpha) {
    const { r, g, b } = parseHex(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/**
 * Blend two hex colours in sRGB. Crude but correct enough for the
 * places we use it (fading debris toward the ground colour, tinting
 * a hull toward its plate). t=0 → a, t=1 → b.
 */
export function mixHex(a, b, t) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    const r = Math.round(ca.r + (cb.r - ca.r) * t);
    const g = Math.round(ca.g + (cb.g - ca.g) * t);
    const bl = Math.round(ca.b + (cb.b - ca.b) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

/** As `mixHex`, but the result carries an alpha channel too. */
export function mixRgba(a, b, t, alpha) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    const r = Math.round(ca.r + (cb.r - ca.r) * t);
    const g = Math.round(ca.g + (cb.g - ca.g) * t);
    const bl = Math.round(ca.b + (cb.b - ca.b) * t);
    return 'rgba(' + r + ',' + g + ',' + bl + ',' + alpha + ')';
}
