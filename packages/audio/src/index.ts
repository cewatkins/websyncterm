/**
 * `@websyncterm/audio` - ANSI music playback and SyncTERM's RIP sound effects.
 *
 * Everything is lazy: importing this package never creates an `AudioContext`,
 * so it can be loaded in Node for tests and only touches Web Audio when a sound
 * is actually played.
 */

export * from './types.js';
export * from './engine.js';
export * from './music-player.js';
export * from './effects.js';
export * from './tone.js';
export * from './worklet.js';
