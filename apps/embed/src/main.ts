/**
 * The embed bundle entry point.
 *
 * Importing this module registers the `<web-syncterm>` custom element.
 */

import { defineWebSyncTerm } from './element.js';

defineWebSyncTerm();

export { WebSyncTermElement, defineWebSyncTerm } from './element.js';
