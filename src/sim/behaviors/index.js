// ============================================================
// BEHAVIOURS — REGISTRY
// ============================================================
//
// Maps a ship's `role` to the function that drives it. This is one
// of the project's four extension points: a new kind of ship that
// thinks like an existing one costs nothing here, and a genuinely
// new kind of thinking costs one file and one line.
//
// A behaviour is called once per fixed step with
// `(ship, world, dt)`. It reads the world, adds steering
// accelerations, and sets state — it must never write position or
// velocity directly, and it must never draw anything.
//
// See docs/04-COOKBOOK.md.

import { mothershipBehavior } from './mothership.js';
import { minerBehavior } from './miner.js';
import { droneBehavior } from './drone.js';
import { fighterBehavior } from './fighter.js';
import { outpostBehavior } from './outpost.js';
import { haulerBehavior } from './hauler.js';
import { wreckBehavior } from './wreck.js';
import { exchangeBehavior } from './exchange.js';
import { factoryBehavior } from './factory.js';

export const BEHAVIORS = {
    mothership: mothershipBehavior,
    miner: minerBehavior,
    drone: droneBehavior,
    fighter: fighterBehavior,
    outpost: outpostBehavior,
    hauler: haulerBehavior,
    wreck: wreckBehavior,
    exchange: exchangeBehavior,
    factory: factoryBehavior,
};
