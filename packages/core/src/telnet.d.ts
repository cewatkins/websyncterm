/**
 * Telnet option negotiation.
 *
 * Mirrors `src/syncterm/telnet_io.c` and `src/syncterm/conn_telnet.c`:
 *
 *  - The client offers SGA and BINARY in both directions and asks the server
 *    to echo.
 *  - TERMINAL-TYPE is answered when the server requests it; NAWS is offered
 *    immediately afterwards.
 *  - Any other option is refused with WONT/DONT.
 *  - There is no RFC 1143 option queue: the last acknowledged command is
 *    remembered per option and a repeat of the same state is not re-sent.
 */
/** IAC and the command bytes. */
export declare const IAC = 255;
export declare const DONT = 254;
export declare const DO = 253;
export declare const WONT = 252;
export declare const WILL = 251;
export declare const SB = 250;
export declare const SE = 240;
/** Telnet option numbers. */
export declare const TelnetOption: {
    readonly Binary: 0;
    readonly Echo: 1;
    readonly SuppressGoAhead: 3;
    readonly Status: 5;
    readonly TimingMark: 6;
    readonly TerminalType: 24;
    readonly NAWS: 31;
    readonly TerminalSpeed: 32;
    readonly LineMode: 34;
    readonly NewEnviron: 39;
    readonly Charset: 42;
};
/** The terminal types SyncTERM reports. */
export declare const TERMINAL_TYPES: {
    readonly ansi: "syncterm";
    readonly petscii: "PETSCII";
    readonly atascii: "ATASCII";
    readonly prestel: "Prestel";
    readonly beeb: "Beeb7";
    readonly atariSt: "AtariST+VT52";
};
/** A callback invoked when the terminal should send bytes. */
export type TelnetSender = (data: Uint8Array) => void;
/** Options controlling the negotiator. */
export interface TelnetOptions {
    /** The terminal type to report. */
    terminalType?: string;
    /** Current screen size, for NAWS. */
    cols?: number;
    rows?: number;
    /** Do not offer the BINARY option. */
    noBinary?: boolean;
    /** Delay the initial negotiation until the first inbound command. */
    deferNegotiation?: boolean;
}
/** The state of one option. */
export interface OptionState {
    /** The last acknowledged command (WILL/WONT/DO/DONT), or 0 when unset. */
    local: number;
    remote: number;
}
/**
 * A Telnet negotiator.
 */
export declare class TelnetNegotiator {
    private readonly localOption;
    private readonly remoteOption;
    /** True when both sides agreed on BINARY. */
    binaryMode: boolean;
    /** True when the remote side has sent WILL BINARY. */
    remoteBinary: boolean;
    private readonly opts;
    private readonly send;
    private started;
    constructor(send: TelnetSender, opts?: TelnetOptions);
    /** The initial negotiation sent on connect. */
    start(): void;
    private sendInitialState;
    /**
     * Feed bytes and get the application payload.
     *
     * This variant keeps the negotiation state machine across calls.
     */
    process(data: Uint8Array): Uint8Array;
    private state;
    private command;
    private sb;
    private handleOption;
    private onDo;
    private onDont;
    private onWill;
    private onWont;
    private updateBinaryMode;
    private handleSubnegotiation;
    /** Send a NAWS subnegotiation with the current screen size. */
    sendWindowChange(): void;
    /**
     * Prepare bytes for transmission to the server.
     *
     * CR becomes CR LF unless binary mode is active, and 0xFF is doubled.
     */
    encodeOutgoing(data: Uint8Array): Uint8Array;
}
//# sourceMappingURL=telnet.d.ts.map