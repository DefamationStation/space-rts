// ============================================================
// TESTS — CAMERA
// ============================================================
//
// The world is a fixed 7200×4200 and the viewport is a window onto
// it. Everything below is about that window behaving like a window.
//
// ------------------------------------------------------------
// WHY THESE ARE THE PROPERTIES WORTH ASSERTING
// ------------------------------------------------------------
//
// A camera has one job that a viewer can feel and no screenshot can
// prove: the world point under the cursor must not move unless the
// viewer moves it. Both interactions are that same claim in different
// clothes — a pan is "the grabbed point stays under the hand", a zoom
// is "the pointed-at point stays under the point" — so both are
// tested as invariants over a spread of scales and offsets rather
// than as one happy-path example.
//
// The clamp is tested for the case that is easy to get wrong: not
// "does it stop at the edge", but what it does when the viewport is
// showing *more* than the world has on an axis, where there is no
// legal range to clamp into and the only correct answer is to centre.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Stage } from '../src/render/canvas.js';
import { WORLD_HEIGHT } from '../src/core/constants.js';

// The world's width now follows the viewport aspect, so a test that
// asserted against the WORLD_WIDTH constant was asserting against a
// default the stage no longer uses. Every bound below is taken from
// the stage itself, which is the thing under test anyway.

/**
 * A Stage over a fake canvas.
 *
 * `Stage` touches the DOM in exactly three places — `getContext`,
 * `getBoundingClientRect` and the `width`/`height` backing store — so
 * a literal covers it and the whole camera runs under `node --test`
 * with no browser and no stubbing library.
 */
function makeStage({ w = 1600, h = 900, dpr = 1, left = 0, top = 0 } = {}) {
    global.window = { devicePixelRatio: dpr, innerWidth: w, innerHeight: h };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ setTransform() {} }),
        getBoundingClientRect: () => ({ left, top, width: w, height: h }),
    };
    const stage = new Stage(canvas);
    stage.resize();
    return stage;
}

test('camera: a fresh stage frames the middle of the world', () => {
    const stage = makeStage();
    assert.equal(stage.camX, stage.worldWidth * 0.5);
    assert.equal(stage.camY, WORLD_HEIGHT * 0.5);
    assert.ok(stage.scale > 0, 'scale never established');
});

test('camera: panning moves the world by exactly the cursor movement', () => {
    // The property, not an example: whatever the zoom, dragging the
    // cursor N css pixels must move the world under it by N css
    // pixels. If this drifts with scale the map feels like it is on
    // ice at one zoom and glued down at another.
    for (const zoom of [0.4, 1, 2.5]) {
        const stage = makeStage();
        stage.zoom = zoom;
        stage.applyCamera();

        const before = stage.toWorld(800, 450);
        stage.panByPixels(120, -75);
        const after = stage.toWorld(800 + 120, 450 - 75);

        assert.ok(Math.abs(after.x - before.x) < 1e-6,
            `x drifted at zoom ${zoom}: ${after.x} vs ${before.x}`);
        assert.ok(Math.abs(after.y - before.y) < 1e-6,
            `y drifted at zoom ${zoom}: ${after.y} vs ${before.y}`);
    }
});

test('camera: zooming holds the world point under the cursor still', () => {
    // Zooming about the viewport centre instead of the cursor is one
    // line shorter and immediately, obviously wrong to use — the thing
    // you are pointing at is the thing you meant to look closer at.
    const points = [[800, 450], [120, 80], [1500, 860]];
    for (const [cx, cy] of points) {
        for (const factor of [1.25, 0.8, 2.0]) {
            const stage = makeStage();
            const before = stage.toWorld(cx, cy);
            stage.zoomAt(cx, cy, factor);
            const after = stage.toWorld(cx, cy);

            // Tolerance in world units: the clamp may legitimately
            // refuse a zoom that would push the view off the world,
            // and then the point is allowed to move.
            const clamped = stage.zoom <= stage.minZoom + 1e-9
                || stage.zoom >= stage.maxZoom - 1e-9;
            if (clamped) continue;

            assert.ok(Math.abs(after.x - before.x) < 0.5,
                `x moved at (${cx},${cy})×${factor}: ${after.x} vs ${before.x}`);
            assert.ok(Math.abs(after.y - before.y) < 0.5,
                `y moved at (${cx},${cy})×${factor}: ${after.y} vs ${before.y}`);
        }
    }
});

test('camera: the view never leaves the world', () => {
    const stage = makeStage();
    stage.zoom = stage.maxZoom;
    stage.applyCamera();

    // Shove it hard in every direction and check the visible rect is
    // still inside the world on both axes.
    for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [1e6, 1e6]]) {
        stage.panByPixels(dx, dy);
        const halfW = stage.cssWidth / (2 * stage.scale);
        const halfH = stage.cssHeight / (2 * stage.scale);
        assert.ok(stage.camX - halfW >= -1e-6, `left edge escaped: ${stage.camX - halfW}`);
        assert.ok(stage.camX + halfW <= stage.worldWidth + 1e-6, 'right edge escaped');
        assert.ok(stage.camY - halfH >= -1e-6, 'top edge escaped');
        assert.ok(stage.camY + halfH <= WORLD_HEIGHT + 1e-6, 'bottom edge escaped');
    }
});

test('camera: an axis showing more than the world has is centred, not clamped', () => {
    // The case a naive clamp gets wrong. Zoomed all the way out the
    // viewport is wider than the world on at least one axis; there is
    // no legal range to clamp into, and jamming the world against one
    // edge would leave dead space at the other.
    const stage = makeStage();
    stage.fitAll();
    stage.panByPixels(5000, 5000);

    const halfW = stage.cssWidth / (2 * stage.scale);
    const halfH = stage.cssHeight / (2 * stage.scale);
    if (halfW * 2 >= stage.worldWidth) {
        assert.equal(stage.camX, stage.worldWidth * 0.5, 'wide axis was not centred');
    }
    if (halfH * 2 >= WORLD_HEIGHT) {
        assert.equal(stage.camY, WORLD_HEIGHT * 0.5, 'tall axis was not centred');
    }
});

test('camera: fitAll shows the entire world and is the zoom floor', () => {
    const stage = makeStage();
    stage.fitAll();

    const halfW = stage.cssWidth / (2 * stage.scale);
    const halfH = stage.cssHeight / (2 * stage.scale);
    assert.ok(halfW * 2 >= stage.worldWidth - 1e-6, 'world wider than the fitted view');
    assert.ok(halfH * 2 >= WORLD_HEIGHT - 1e-6, 'world taller than the fitted view');
    assert.ok(Math.abs(stage.zoom - stage.minZoom) < 1e-9, 'fit is not the zoom floor');

    // And you cannot go further out than the whole world.
    stage.zoomAt(800, 450, 0.1);
    assert.ok(stage.zoom >= stage.minZoom - 1e-9, 'zoomed out past the world');
});

test('camera: toWorld stays the exact inverse of the composed transform', () => {
    // `begin()` and `toWorld()` are the two definitions of what a
    // world coordinate means, and the camera writes into the three
    // fields they share rather than participating in either. This
    // asserts that arrangement actually holds: reconstruct a screen
    // point from a world point using scale/offset the way `begin`
    // does, and `toWorld` must invert it.
    for (const cfg of [
        { w: 1920, h: 1080, dpr: 1, left: 0, top: 0 },
        { w: 800, h: 600, dpr: 2, left: 45.5, top: 80.25 },
        { w: 2560, h: 1440, dpr: 1.5, left: 12.3, top: 4.6 },
    ]) {
        const stage = makeStage(cfg);
        stage.zoom = 1.7;
        stage.camX = 2600;
        stage.camY = 1900;
        stage.applyCamera();

        for (const [wx, wy] of [[0, 0], [3600, 2100], [stage.worldWidth, 4200], [1234.5, 987.25]]) {
            const screenX = wx * stage.scale + stage.offsetX + cfg.left;
            const screenY = wy * stage.scale + stage.offsetY + cfg.top;
            const back = stage.toWorld(screenX, screenY);
            assert.ok(Math.abs(back.x - wx) < 1e-6, `x inversion ${back.x} vs ${wx}`);
            assert.ok(Math.abs(back.y - wy) < 1e-6, `y inversion ${back.y} vs ${wy}`);
        }
    }
});

test('camera: resize keeps the camera pointed where it was', () => {
    // A window resize must not teleport the view — but "where it was"
    // is now a *fraction* of the map rather than a coordinate, because
    // a reshaped window reshapes the world under the camera. Holding
    // the absolute x would slide the view toward one end every time
    // the window changed shape.
    const stage = makeStage({ w: 1600, h: 900 });
    stage.zoom = 1.4;
    stage.camX = 2200;
    stage.camY = 1500;
    stage.applyCamera();
    const at = { fx: stage.camX / stage.worldWidth, y: stage.camY };

    stage.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 700 });
    global.window.innerWidth = 1200;
    global.window.innerHeight = 700;
    stage.resize();

    assert.ok(Math.abs(stage.camX / stage.worldWidth - at.fx) < 1e-6,
        'camera slid along the map on resize');
    assert.ok(Math.abs(stage.camY - at.y) < 1e-6, 'camera y moved on resize');
});

test('camera: resizing the window does not reshape the world under the fleet', () => {
    // The bug this pins down was not visible as a camera fault at all.
    // World width followed the viewport aspect on *every* resize, so
    // dragging the window edge moved the simulation's bounds under a
    // running fleet — hulls that were in open space were suddenly
    // outside it, and `avoidEdges` shepherded everything back inside
    // the new box. On screen that reads as the ships being unable to
    // leave the visible area, which is nowhere near where the cause
    // actually was.
    //
    // The world takes its shape from the window it opened in, and
    // after that a resize is a bigger or smaller *window onto* it.
    const stage = makeStage({ w: 2560, h: 1080 });     // ultrawide at load
    const opened = stage.worldWidth;
    assert.ok(opened > 0);

    for (const [w, h] of [[1200, 900], [800, 1400], [3440, 1440], [640, 480]]) {
        stage.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h });
        global.window.innerWidth = w;
        global.window.innerHeight = h;
        stage.resize();
        assert.equal(stage.worldWidth, opened,
            `world reshaped to ${stage.worldWidth} when the window became ${w}x${h}`);
        assert.equal(stage.worldHeight, WORLD_HEIGHT, 'world height moved');
    }
});

test('camera: the world still takes its shape from the window it opened in', () => {
    // The other half — locking must not flatten every display to the
    // same battlefield. A wide window still opens a wide world; it
    // just stops renegotiating afterwards.
    const wide = makeStage({ w: 3440, h: 1440 });
    const narrow = makeStage({ w: 1024, h: 1280 });
    assert.ok(wide.worldWidth > narrow.worldWidth,
        `ultrawide got ${wide.worldWidth} and portrait got ${narrow.worldWidth}`);
});
