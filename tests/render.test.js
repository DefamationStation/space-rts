// ============================================================
// TESTS — RENDERER & GIZMOS
// ============================================================
//
// Zero-dependency headless testing of Canvas 2D renderers.
// Validates geometry emission, collision radius bounds tolerance,
// strict theme palette compliance, thrusters, build arcs, and
// spatial decision gizmos overlays under node --test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SHIP_TYPES } from '../src/data/ships.js';
import { THEMES } from '../src/data/themes.js';
import { HULL_RENDERERS, drawShip, drawBuildArc, drawThruster } from '../src/render/hulls.js';
import { drawScene } from '../src/render/scene.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { parseHex, mixHex, rgba } from '../src/core/color.js';
import { makeShip } from '../src/sim/entities.js';
import { World } from '../src/core/world.js';
import { createWorld, stepWorld } from '../src/sim/simulate.js';
import {
    FIXED_DT, MINING_RADIUS, ENGAGE_LEASH,
    FIELD_SCATTER, ESCORT_RADIUS, DRONE_DOCK_OFFSET,
    DRONE_DOCK_TOLERANCE, MINER_STANDOFF,
} from '../src/core/constants.js';
import { TAU } from '../src/core/math.js';

// ------------------------------------------------------------
// MOCK CONTEXT 2D & DOCUMENT STUB
// ------------------------------------------------------------

export class MockContext2D {
    constructor(canvas = null) {
        this.canvas = canvas || {
            width: 2400,
            height: 1350,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 2400, height: 1350 }),
        };
        this.reset();
    }

    reset() {
        this.fillStyle = '#000000';
        this.strokeStyle = '#000000';
        this.lineWidth = 1;
        this.lineCap = 'butt';
        this.lineJoin = 'miter';
        this.globalAlpha = 1;
        this.globalCompositeOperation = 'source-over';
        this.font = '10px sans-serif';
        this.textAlign = 'start';
        this.textBaseline = 'alphabetic';
        this.lineDash = [];

        // 2D affine transform matrix [a, b, c, d, e, f]
        // (x', y') = (a*x + c*y + e, b*x + d*y + f)
        this.matrix = [1, 0, 0, 1, 0, 0];
        this.matrixStack = [];

        this._currentPath = [];
        this._subpathStart = null;

        this.operations = [];
        this.fills = [];
        this.strokes = [];
        this.allPoints = [];
        this.emittedColors = new Set();
        this.calls = [];
        this.paths = [];
        this.styles = new Set();
    }

    save() {
        this.matrixStack.push({
            matrix: [...this.matrix],
            fillStyle: this.fillStyle,
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            lineCap: this.lineCap,
            lineJoin: this.lineJoin,
            globalAlpha: this.globalAlpha,
            globalCompositeOperation: this.globalCompositeOperation,
            font: this.font,
            textAlign: this.textAlign,
            textBaseline: this.textBaseline,
            lineDash: [...this.lineDash],
        });
        this.calls.push({ op: 'save' });
        this.operations.push({ op: 'save' });
    }

    restore() {
        if (this.matrixStack.length === 0) return;
        const state = this.matrixStack.pop();
        this.matrix = state.matrix;
        this.fillStyle = state.fillStyle;
        this.strokeStyle = state.strokeStyle;
        this.lineWidth = state.lineWidth;
        this.lineCap = state.lineCap;
        this.lineJoin = state.lineJoin;
        this.globalAlpha = state.globalAlpha;
        this.globalCompositeOperation = state.globalCompositeOperation;
        this.font = state.font;
        this.textAlign = state.textAlign;
        this.textBaseline = state.textBaseline;
        this.lineDash = state.lineDash;
        this.calls.push({ op: 'restore' });
        this.operations.push({ op: 'restore' });
    }

    translate(tx, ty) {
        const [a, b, c, d, e, f] = this.matrix;
        this.matrix[4] = a * tx + c * ty + e;
        this.matrix[5] = b * tx + d * ty + f;
        this.calls.push({ op: 'translate', tx, ty });
        this.operations.push({ op: 'translate', tx, ty });
    }

    rotate(angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const [a, b, c, d, e, f] = this.matrix;
        this.matrix[0] = a * cos + c * sin;
        this.matrix[1] = b * cos + d * sin;
        this.matrix[2] = -a * sin + c * cos;
        this.matrix[3] = -b * sin + d * cos;
        this.calls.push({ op: 'rotate', angle });
        this.operations.push({ op: 'rotate', angle });
    }

    scale(sx, sy) {
        const y = sy ?? sx;
        this.matrix[0] *= sx;
        this.matrix[1] *= sx;
        this.matrix[2] *= y;
        this.matrix[3] *= y;
        this.calls.push({ op: 'scale', sx, sy: y });
        this.operations.push({ op: 'scale', sx, sy: y });
    }

    transform(a, b, c, d, e, f) {
        const [a0, b0, c0, d0, e0, f0] = this.matrix;
        this.matrix[0] = a0 * a + c0 * b;
        this.matrix[1] = b0 * a + d0 * b;
        this.matrix[2] = a0 * c + c0 * d;
        this.matrix[3] = b0 * c + d0 * d;
        this.matrix[4] = a0 * e + c0 * f + e0;
        this.matrix[5] = b0 * e + d0 * f + f0;
        this.calls.push({ op: 'transform', a, b, c, d, e, f });
        this.operations.push({ op: 'transform', a, b, c, d, e, f });
    }

    setTransform(a, b, c, d, e, f) {
        if (Array.isArray(a)) {
            this.matrix = [...a];
        } else if (typeof a === 'object' && a !== null) {
            this.matrix = [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0];
        } else {
            this.matrix = [a, b, c, d, e, f];
        }
        this.calls.push({ op: 'setTransform', matrix: [...this.matrix] });
        this.operations.push({ op: 'setTransform', matrix: [...this.matrix] });
    }

    resetTransform() {
        this.matrix = [1, 0, 0, 1, 0, 0];
        this.calls.push({ op: 'resetTransform' });
        this.operations.push({ op: 'resetTransform' });
    }

    setLineDash(dash) {
        this.lineDash = [...dash];
        this.calls.push({ op: 'setLineDash', dash: [...dash] });
        this.operations.push({ op: 'setLineDash', dash: [...dash] });
    }

    getLineDash() {
        return [...this.lineDash];
    }

    _transformPoint(x, y) {
        const [a, b, c, d, e, f] = this.matrix;
        return {
            x: a * x + c * y + e,
            y: b * x + d * y + f,
        };
    }

    beginPath() {
        this._currentPath = [];
        this._subpathStart = null;
        this.calls.push({ op: 'beginPath' });
        this.operations.push({ op: 'beginPath' });
    }

    moveTo(x, y) {
        const p = this._transformPoint(x, y);
        this._currentPath.push(p);
        this._subpathStart = p;
        this.calls.push({ op: 'moveTo', x, y, transformed: p });
        this.operations.push({ op: 'moveTo', x, y, transformed: p });
    }

    lineTo(x, y) {
        const p = this._transformPoint(x, y);
        this._currentPath.push(p);
        this.calls.push({ op: 'lineTo', x, y, transformed: p });
        this.operations.push({ op: 'lineTo', x, y, transformed: p });
    }

    closePath() {
        if (this._subpathStart) {
            this._currentPath.push({ ...this._subpathStart });
        }
        this.calls.push({ op: 'closePath' });
        this.operations.push({ op: 'closePath' });
    }

    arc(cx, cy, radius, startAngle, endAngle, counterclockwise = false) {
        const step = Math.PI / 16;
        let angleSpan = endAngle - startAngle;
        if (counterclockwise && angleSpan > 0) angleSpan -= Math.PI * 2;
        if (!counterclockwise && angleSpan < 0) angleSpan += Math.PI * 2;
        const numSteps = Math.max(8, Math.ceil(Math.abs(angleSpan) / step));
        for (let i = 0; i <= numSteps; i++) {
            const t = startAngle + (angleSpan * i) / numSteps;
            const px = cx + radius * Math.cos(t);
            const py = cy + radius * Math.sin(t);
            const p = this._transformPoint(px, py);
            this._currentPath.push(p);
            if (i === 0 && !this._subpathStart) this._subpathStart = p;
        }
        this.calls.push({ op: 'arc', cx, cy, radius, startAngle, endAngle, counterclockwise });
        this.operations.push({ op: 'arc', cx, cy, radius, startAngle, endAngle, counterclockwise });
    }

    fill(fillRule = 'nonzero') {
        const points = [...this._currentPath];
        const record = {
            op: 'fill',
            points,
            color: this.fillStyle,
            style: this.fillStyle,
            alpha: this.globalAlpha,
            fillRule,
        };
        this.fills.push(record);
        for (const p of points) this.allPoints.push(p);
        if (this.fillStyle) {
            this.emittedColors.add(this.fillStyle);
            this.styles.add(this.fillStyle);
        }
        this.calls.push(record);
        this.operations.push(record);
        this.paths.push({ type: 'fill', rule: fillRule, style: this.fillStyle, alpha: this.globalAlpha, points });
    }

    stroke() {
        const points = [...this._currentPath];
        const record = {
            op: 'stroke',
            points,
            color: this.strokeStyle,
            style: this.strokeStyle,
            alpha: this.globalAlpha,
            lineWidth: this.lineWidth,
        };
        this.strokes.push(record);
        for (const p of points) this.allPoints.push(p);
        if (this.strokeStyle) {
            this.emittedColors.add(this.strokeStyle);
            this.styles.add(this.strokeStyle);
        }
        this.calls.push(record);
        this.operations.push(record);
        this.paths.push({ type: 'stroke', style: this.strokeStyle, alpha: this.globalAlpha, points });
    }

    fillRect(x, y, w, h) {
        const corners = [
            this._transformPoint(x, y),
            this._transformPoint(x + w, y),
            this._transformPoint(x + w, y + h),
            this._transformPoint(x, y + h),
        ];
        const record = {
            op: 'fillRect',
            x, y, w, h,
            points: corners,
            color: this.fillStyle,
            style: this.fillStyle,
            alpha: this.globalAlpha,
        };
        this.fills.push(record);
        for (const p of corners) this.allPoints.push(p);
        if (this.fillStyle) {
            this.emittedColors.add(this.fillStyle);
            this.styles.add(this.fillStyle);
        }
        this.calls.push(record);
        this.operations.push(record);
    }

    strokeRect(x, y, w, h) {
        const corners = [
            this._transformPoint(x, y),
            this._transformPoint(x + w, y),
            this._transformPoint(x + w, y + h),
            this._transformPoint(x, y + h),
        ];
        const record = {
            op: 'strokeRect',
            x, y, w, h,
            points: corners,
            color: this.strokeStyle,
            style: this.strokeStyle,
            alpha: this.globalAlpha,
            lineWidth: this.lineWidth,
        };
        this.strokes.push(record);
        for (const p of corners) this.allPoints.push(p);
        if (this.strokeStyle) {
            this.emittedColors.add(this.strokeStyle);
            this.styles.add(this.strokeStyle);
        }
        this.calls.push(record);
        this.operations.push(record);
    }

    clearRect(x, y, w, h) {
        this.calls.push({ op: 'clearRect', x, y, w, h });
        this.operations.push({ op: 'clearRect', x, y, w, h });
    }

    fillText(text, x, y) {
        if (this.fillStyle) {
            this.emittedColors.add(this.fillStyle);
            this.styles.add(this.fillStyle);
        }
        this.calls.push({ op: 'fillText', text, x, y });
        this.operations.push({ op: 'fillText', text, x, y });
    }

    strokeText(text, x, y) {
        if (this.strokeStyle) {
            this.emittedColors.add(this.strokeStyle);
            this.styles.add(this.strokeStyle);
        }
        this.calls.push({ op: 'strokeText', text, x, y });
        this.operations.push({ op: 'strokeText', text, x, y });
    }

    clip(rule = 'nonzero') {
        this.calls.push({ op: 'clip', rule });
        this.operations.push({ op: 'clip', rule });
    }

    drawImage(img, ...args) {
        this.calls.push({ op: 'drawImage', img, args });
        this.operations.push({ op: 'drawImage', args });
    }

    createRadialGradient(x0, y0, r0, x1, y1, r1) {
        return {
            addColorStop: (offset, color) => {
                if (color) {
                    this.emittedColors.add(color);
                    this.styles.add(color);
                }
            },
        };
    }

    createLinearGradient(x0, y0, x1, y1) {
        return {
            addColorStop: (offset, color) => {
                if (color) {
                    this.emittedColors.add(color);
                    this.styles.add(color);
                }
            },
        };
    }

    getBounds() {
        if (!this.allPoints.length) {
            return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, maxRadius: 0 };
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxRadius = 0;
        for (const p of this.allPoints) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
            maxRadius = Math.max(maxRadius, Math.hypot(p.x, p.y));
        }
        return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, maxRadius };
    }
}

if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement(tag) {
            if (tag === 'canvas') {
                const canvas = {
                    width: 64,
                    height: 64,
                    getContext: () => new MockContext2D(canvas),
                };
                return canvas;
            }
            return {};
        },
    };
}

/** Mock Stage for headless tests */
export function createMockStage(width = 2400, height = 1350) {
    const canvas = {
        width,
        height,
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    };
    const ctx = new MockContext2D(canvas);
    return {
        canvas,
        ctx,
        pixel: 1,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        worldWidth: width,
        worldHeight: height,
        begin() { ctx.setTransform(1, 0, 0, 1, 0, 0); },
        toWorld(cx, cy) { return { x: cx, y: cy }; },
    };
}

// ------------------------------------------------------------
// PALETTE VALIDATION HELPERS
// ------------------------------------------------------------

function extractRgb(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const str = colorStr.trim();
    if (str.startsWith('#')) {
        const c = parseHex(str);
        return [c.r, c.g, c.b];
    }
    const match = str.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/);
    if (match) {
        return [Math.round(Number(match[1])), Math.round(Number(match[2])), Math.round(Number(match[3]))];
    }
    return null;
}

function isValidColorForTheme(colorStr, theme, factionId = 0) {
    const rgb = extractRgb(colorStr);
    if (!rgb) return false;

    // Collect all theme hex tokens
    const themeHexes = [
        theme.ground,
        theme.grid,
        theme.hud?.text,
        theme.hud?.dim,
        theme.neutral?.rock,
        theme.neutral?.rockEdge,
        theme.neutral?.vein,
        theme.neutral?.debris,
    ].filter((h) => typeof h === 'string' && h.startsWith('#'));

    for (const fac of theme.factions) {
        for (const k of ['plate', 'hull', 'accent', 'weapon', 'flash', 'thruster']) {
            if (typeof fac[k] === 'string' && fac[k].startsWith('#')) {
                themeHexes.push(fac[k]);
            }
        }
    }

    const themeRgbs = themeHexes.map((hex) => {
        const c = parseHex(hex);
        return [c.r, c.g, c.b];
    });

    // 1. Direct match with any theme color
    for (const [tr, tg, tb] of themeRgbs) {
        if (Math.abs(rgb[0] - tr) <= 2 && Math.abs(rgb[1] - tg) <= 2 && Math.abs(rgb[2] - tb) <= 2) {
            return true;
        }
    }

    // 2. Hull damage wear interpolation (mixHex(pal.hull, theme.neutral.debris, wear * 0.55))
    for (const fac of theme.factions) {
        const hullC = parseHex(fac.hull);
        const debC = parseHex(theme.neutral.debris);
        for (let t = 0; t <= 0.6; t += 0.005) {
            const mr = Math.round(hullC.r + (debC.r - hullC.r) * t);
            const mg = Math.round(hullC.g + (debC.g - hullC.g) * t);
            const mb = Math.round(hullC.b + (debC.b - hullC.b) * t);
            if (Math.abs(rgb[0] - mr) <= 2 && Math.abs(rgb[1] - mg) <= 2 && Math.abs(rgb[2] - mb) <= 2) {
                return true;
            }
        }
    }

    // 3. rgba(0, 0, 0, a) from rgba(rgb(...), a) on damaged station stroke
    if (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) {
        return true;
    }

    return false;
}

// ------------------------------------------------------------
// TEST SUITES
// ------------------------------------------------------------

test('render: all registered hull renderers emit geometry', () => {
    const world = new World({ seed: 1 });
    const theme = THEMES.void;

    for (const typeId of Object.keys(SHIP_TYPES)) {
        const render = HULL_RENDERERS[typeId];
        assert.ok(typeof render === 'function', `missing hull renderer for ${typeId}`);

        const ctx = new MockContext2D();
        const ship = makeShip(world, typeId, 0, 0, 0);
        ship.fade = 1;

        // Render in local space
        render(ctx, ship, theme.factions[0], theme);

        assert.ok(ctx.operations.length > 0, `${typeId} emitted 0 canvas operations`);
        assert.ok(ctx.allPoints.length >= 3, `${typeId} emitted fewer than 3 vertices`);
        assert.ok(ctx.fills.length >= 1, `${typeId} emitted 0 fill operations`);
    }
});

test('render: drawShip applies transformations with balanced save/restore', () => {
    const world = new World({ seed: 1 });
    const theme = THEMES.void;

    for (const typeId of Object.keys(SHIP_TYPES)) {
        const ctx = new MockContext2D();
        const ship = makeShip(world, typeId, 0, 100, 200, Math.PI / 4);
        ship.prevX = 100;
        ship.prevY = 200;
        ship.prevAngle = Math.PI / 4;
        ship.fade = 1;

        drawShip(ctx, ship, theme, 1, world);

        assert.equal(ctx.matrixStack.length, 0, `${typeId} left unbalanced save/restore matrix stack`);
        assert.ok(ctx.allPoints.length >= 3, `${typeId} drawShip emitted no points`);
    }
});

test('render: drawn silhouettes match circular hitbox radius within tolerance', () => {
    const world = new World({ seed: 1 });
    const theme = THEMES.void;

    for (const [typeId, def] of Object.entries(SHIP_TYPES)) {
        const ctx = new MockContext2D();
        const ship = makeShip(world, typeId, 0, 0, 0, 0);
        ship.fade = 1;
        ship.recoil = 0;
        ship.bank = 0;

        // Draw at origin
        drawShip(ctx, ship, theme, 1, world);

        assert.ok(ctx.allPoints.length > 0, `no points emitted for ${typeId}`);

        const bounds = ctx.getBounds();
        const minExpected = def.radius * 0.75;
        const maxExpected = def.radius * 1.25;

        assert.ok(
            bounds.maxRadius >= minExpected && bounds.maxRadius <= maxExpected,
            `${typeId} drawn radius (${bounds.maxRadius.toFixed(2)}) out of tolerance [${minExpected.toFixed(2)}, ${maxExpected.toFixed(2)}] for def.radius=${def.radius}`,
        );

        assert.ok(bounds.width > 0, `${typeId} width <= 0`);
        assert.ok(bounds.height > 0, `${typeId} height <= 0`);
    }
});

test('render: all emitted colors strictly comply with active theme palette', () => {
    const world = new World({ seed: 1 });
    const themeKeys = ['void', 'paper'];

    for (const themeKey of themeKeys) {
        const theme = THEMES[themeKey];

        for (const factionId of [0, 1]) {
            for (const typeId of Object.keys(SHIP_TYPES)) {
                const variations = [
                    { hpPct: 1.0, cargoPct: 0.0 },
                    { hpPct: 0.75, cargoPct: 0.5 },
                    { hpPct: 0.25, cargoPct: 1.0 },
                    { hpPct: 0.05, cargoPct: 0.0 },
                ];

                for (const v of variations) {
                    const ctx = new MockContext2D();
                    const ship = makeShip(world, typeId, factionId, 0, 0, 0);
                    ship.fade = 1;
                    ship.hp = ship.maxHp * (typeId === 'mothership' ? 1.0 : v.hpPct);
                    ship.cargo = ship.cargoMax * v.cargoPct;

                    if (ship.role === 'mothership') {
                        ship.buildType = 'fighter';
                        ship.buildStart = 0;
                        ship.buildEnd = 10;
                    }

                    drawShip(ctx, ship, theme, 1, world);

                    for (const color of ctx.emittedColors) {
                        const valid = isValidColorForTheme(color, theme, factionId);
                        assert.ok(
                            valid,
                            `Invalid/unthemed color "${color}" emitted for ${typeId} (faction ${factionId}, theme ${themeKey})`,
                        );
                    }
                }
            }
        }
    }
});

test('render: build arc draws and complies with theme palette', () => {
    const world = new World({ seed: 1 });
    world.time = 5;
    const theme = THEMES.void;
    const ctx = new MockContext2D();

    const station = makeShip(world, 'mothership', 0, 0, 0, 0);
    station.buildType = 'fighter';
    station.buildStart = 0;
    station.buildEnd = 10;

    drawBuildArc(ctx, station, theme.factions[0], world);

    assert.ok(ctx.strokes.length > 0, 'drawBuildArc emitted no strokes');
    for (const color of ctx.emittedColors) {
        assert.ok(isValidColorForTheme(color, theme, 0), `build arc used unthemed color: ${color}`);
    }
});

test('render: thruster plumes emit for throttle, rcsLat, and rcsRetro', () => {
    const world = createWorld({ seed: 306, effects: false });
    const theme = THEMES.void;

    const ctx = new MockContext2D();
    const ship = makeShip(world, 'fighter', 0, 0, 0);
    ship.fade = 1;
    ship.throttle = 0.9;
    ship.rcsLat = 0.5;
    ship.rcsRetro = 0.8;

    drawThruster(ctx, ship, theme, 1);

    assert.ok(ctx.calls.length > 0, 'thruster plumes did not emit drawing calls');
});

test('render: thruster plumes suppressed when engines are idle', () => {
    const world = createWorld({ seed: 307, effects: false });
    const theme = THEMES.void;

    const ctx = new MockContext2D();
    const ship = makeShip(world, 'fighter', 0, 0, 0);
    ship.fade = 1;
    ship.throttle = 0;
    ship.rcsLat = 0;
    ship.rcsRetro = 0;

    drawThruster(ctx, ship, theme, 1);
    assert.equal(ctx.calls.length, 0, 'idle thruster should emit zero draw calls');
});

test('render: drawGizmos emits tether circles, leash circles, claim links, and berth rings', () => {
    const world = createWorld({ seed: 401, effects: false });
    const stage = createMockStage(2400, 1350);
    const theme = THEMES.void;

    for (let i = 0; i < 300; i++) stepWorld(world, FIXED_DT);

    const ctx = stage.ctx;
    ctx.reset();

    drawGizmos(ctx, world, theme, stage, 1, 0);

    const arcs = ctx.calls.filter((c) => c.op === 'arc');
    const lines = ctx.calls.filter((c) => c.op === 'lineTo');

    assert.ok(arcs.length >= world.fields.length, 'expected field scatter boundary arcs');
    assert.ok(lines.length > 0, 'expected gizmo lines for vectors/links');
});

test('render: drawGizmos uses theme palette colors exclusively', () => {
    const world = createWorld({ seed: 402, effects: false });
    const stage = createMockStage(2400, 1350);

    for (let i = 0; i < 300; i++) stepWorld(world, FIXED_DT);

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        const ctx = stage.ctx;
        ctx.reset();

        drawGizmos(ctx, world, theme, stage, 1, 0);

        assert.ok(ctx.emittedColors.size > 0, `no styles captured in ${themeKey} gizmos`);
        for (const style of ctx.emittedColors) {
            assert.ok(
                isValidColorForTheme(style, theme),
                `unthemed style "${style}" emitted in ${themeKey} gizmos`,
            );
        }
    }
});

test('render: drawGizmos produces zero state mutations and zero PRNG drift', () => {
    const world = createWorld({ seed: 403, effects: false });
    const stage = createMockStage(2400, 1350);
    const theme = THEMES.void;

    for (let i = 0; i < 200; i++) stepWorld(world, FIXED_DT);

    const initialHash = world.hash();
    const initialRngState = world.rng.state;
    const initialFxState = world.fxRng.state;

    for (let i = 0; i < 50; i++) {
        drawGizmos(stage.ctx, world, theme, stage, 1, world.ships[0]?.id || 0);
    }

    assert.equal(world.hash(), initialHash, 'drawGizmos mutated world state');
    assert.equal(world.rng.state, initialRngState, 'drawGizmos advanced world.rng');
    assert.equal(world.fxRng.state, initialFxState, 'drawGizmos advanced world.fxRng');
});

test('render: full scene rendering (drawScene) executes cleanly under void and paper themes', () => {
    const world = createWorld({ seed: 406, effects: false });
    const stage = createMockStage(2400, 1350);

    for (let i = 0; i < 180; i++) stepWorld(world, FIXED_DT);

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        const ctx = stage.ctx;
        ctx.reset();

        assert.doesNotThrow(() => {
            drawScene(ctx, world, theme, stage, 1, true, { debugLevel: 2, gizmos: true });
        }, `drawScene crashed under ${themeKey} theme`);

        assert.ok(ctx.calls.length > 50, 'drawScene emitted insufficient canvas calls');
    }
});
