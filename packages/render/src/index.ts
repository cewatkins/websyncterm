/**
 * `@websyncterm/render` - bitmap fonts, scaling and the Canvas2D/DOM renderer
 * for WebSyncTERM.
 *
 * The package is DOM-optional: font parsing, the video-mode table, scaling
 * maths and CP437 mapping are pure functions that run in Node, while the
 * renderer and CRT effects only touch the DOM inside their constructors.
 */

export * from './font.js';
export * from './scaler.js';
export * from './crt.js';
export * from './renderer.js';
