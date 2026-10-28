/**
 * Key to byte-sequence translation.
 *
 * Mirrors the tables in `src/conio/cterm.c` (ansi_keys and friends) and the
 * per-emulation overrides for PETSCII, ATASCII, VT52, Prestel and the BBC
 * Micro.
 */
import { type TermEmulationName } from './types.js';
/** Logical key identifiers used by the browser front end. */
export declare const Key: {
    readonly Up: "up";
    readonly Down: "down";
    readonly Left: "left";
    readonly Right: "right";
    readonly Home: "home";
    readonly End: "end";
    readonly PageUp: "pageUp";
    readonly PageDown: "pageDown";
    readonly Insert: "insert";
    readonly Delete: "delete";
    readonly Backspace: "backspace";
    readonly Tab: "tab";
    readonly BackTab: "backTab";
    readonly Enter: "enter";
    readonly Escape: "escape";
    readonly F1: "f1";
    readonly F2: "f2";
    readonly F3: "f3";
    readonly F4: "f4";
    readonly F5: "f5";
    readonly F6: "f6";
    readonly F7: "f7";
    readonly F8: "f8";
    readonly F9: "f9";
    readonly F10: "f10";
    readonly F11: "f11";
    readonly F12: "f12";
};
export type KeyName = (typeof Key)[keyof typeof Key];
/** Modifier keys. */
export interface Modifiers {
    shift?: boolean;
    alt?: boolean;
    ctrl?: boolean;
}
/** A key event as delivered by the browser. */
export interface KeyEvent {
    /** A printable character, if the key produced one. */
    char?: string;
    /** A named key (arrows, function keys, ...). */
    key?: KeyName;
    modifiers?: Modifiers;
    /** The raw KeyboardEvent code, used for physical key reporting. */
    code?: string;
}
/** Options that affect key translation. */
export interface KeyMapOptions {
    emulation?: TermEmulationName;
    /** DECBKM: backspace sends 0x08 rather than 0x7f. */
    decBkm?: boolean;
    /** Doorway mode sends `NUL <scancode>` for Alt combinations. */
    doorwayMode?: boolean;
}
/**
 * Translate a key event into the bytes to send to the host.
 */
export declare function encodeKey(event: KeyEvent, opts?: KeyMapOptions): Uint8Array;
/**
 * Build a mouse report in the format SyncTERM sends.
 *
 * @param mode The active mouse reporting mode.
 * @param button 0-based button number.
 * @param x 1-based column.
 * @param y 1-based row.
 * @param motion True when the event is a motion report.
 * @param release True when the button was released.
 */
export declare function encodeMouseReport(mode: {
    x10: boolean;
    sgr: boolean;
}, button: number, x: number, y: number, motion: boolean, release: boolean, mods?: {
    shift?: boolean;
    alt?: boolean;
    ctrl?: boolean;
}): Uint8Array;
/**
 * The SyncTERM local shortcut bindings (Wren `keys_default.wren`).
 *
 * These are handled by the application, not sent to the host.
 */
export declare const LOCAL_SHORTCUTS: Record<string, string>;
//# sourceMappingURL=keymap.d.ts.map