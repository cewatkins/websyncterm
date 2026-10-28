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
export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;
/** Telnet option numbers. */
export const TelnetOption = {
    Binary: 0,
    Echo: 1,
    SuppressGoAhead: 3,
    Status: 5,
    TimingMark: 6,
    TerminalType: 24,
    NAWS: 31,
    TerminalSpeed: 32,
    LineMode: 34,
    NewEnviron: 39,
    Charset: 42,
};
/** The terminal types SyncTERM reports. */
export const TERMINAL_TYPES = {
    ansi: 'syncterm',
    petscii: 'PETSCII',
    atascii: 'ATASCII',
    prestel: 'Prestel',
    beeb: 'Beeb7',
    atariSt: 'AtariST+VT52',
};
/**
 * A Telnet negotiator.
 */
export class TelnetNegotiator {
    localOption = new Uint8Array(256);
    remoteOption = new Uint8Array(256);
    /** True when both sides agreed on BINARY. */
    binaryMode = false;
    /** True when the remote side has sent WILL BINARY. */
    remoteBinary = false;
    opts;
    send;
    started = false;
    constructor(send, opts = {}) {
        this.send = send;
        this.opts = opts;
    }
    /** The initial negotiation sent on connect. */
    start() {
        if (this.started)
            return;
        this.started = true;
        this.sendInitialState();
    }
    sendInitialState() {
        const out = [];
        out.push(IAC, WILL, TelnetOption.SuppressGoAhead);
        out.push(IAC, DO, TelnetOption.SuppressGoAhead);
        if (!this.opts.noBinary) {
            out.push(IAC, WILL, TelnetOption.Binary);
            out.push(IAC, DO, TelnetOption.Binary);
        }
        out.push(IAC, DO, TelnetOption.Echo);
        this.send(Uint8Array.from(out));
    }
    /**
     * Feed bytes and get the application payload.
     *
     * This variant keeps the negotiation state machine across calls.
     */
    process(data) {
        const out = [];
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            if (this.state === 'data') {
                if (b === IAC) {
                    this.state = 'iac';
                    continue;
                }
                out.push(b);
                continue;
            }
            if (this.state === 'iac') {
                if (b === IAC) {
                    out.push(IAC);
                    this.state = 'data';
                    continue;
                }
                if (b === WILL || b === WONT || b === DO || b === DONT) {
                    this.command = b;
                    this.state = 'option';
                    continue;
                }
                if (b === SB) {
                    this.state = 'sb';
                    this.sb = [b];
                    continue;
                }
                // Other commands (GA, NOP, AYT, ...) are consumed.
                this.state = 'data';
                continue;
            }
            if (this.state === 'option') {
                this.handleOption(this.command, b);
                this.state = 'data';
                continue;
            }
            if (this.state === 'sb') {
                this.sb.push(b);
                if (b === IAC) {
                    this.state = 'sb-iac';
                    continue;
                }
                if (this.sb.length > 1024) {
                    this.state = 'data';
                    this.sb = [];
                }
                continue;
            }
            if (this.state === 'sb-iac') {
                if (b === SE) {
                    this.sb.push(b);
                    this.handleSubnegotiation(this.sb);
                    this.sb = [];
                    this.state = 'data';
                    continue;
                }
                if (b === IAC) {
                    this.sb.push(IAC, IAC);
                    this.state = 'sb';
                    continue;
                }
                this.sb.push(IAC, b);
                this.state = 'sb';
                continue;
            }
        }
        return Uint8Array.from(out);
    }
    state = 'data';
    command = 0;
    sb = [];
    handleOption(command, option) {
        switch (command) {
            case DO:
                this.onDo(option);
                break;
            case DONT:
                this.onDont(option);
                break;
            case WILL:
                this.onWill(option);
                break;
            case WONT:
                this.onWont(option);
                break;
            default:
                break;
        }
    }
    onDo(option) {
        switch (option) {
            case TelnetOption.Binary:
                if (this.opts.noBinary) {
                    this.send(Uint8Array.from([IAC, WONT, option]));
                    return;
                }
                this.localOption[option] = DO;
                this.send(Uint8Array.from([IAC, WILL, option]));
                return;
            case TelnetOption.SuppressGoAhead:
                this.localOption[option] = DO;
                this.send(Uint8Array.from([IAC, WILL, option]));
                return;
            case TelnetOption.TerminalType:
                this.localOption[option] = DO;
                this.send(Uint8Array.from([IAC, WILL, option]));
                return;
            case TelnetOption.NAWS:
                this.localOption[option] = DO;
                this.send(Uint8Array.from([IAC, WILL, option]));
                this.sendWindowChange();
                return;
            default:
                this.send(Uint8Array.from([IAC, WONT, option]));
                return;
        }
    }
    onDont(option) {
        this.localOption[option] = DONT;
        if (option === TelnetOption.Binary)
            this.binaryMode = false;
    }
    onWill(option) {
        switch (option) {
            case TelnetOption.Binary:
                this.remoteOption[option] = WILL;
                this.remoteBinary = true;
                this.send(Uint8Array.from([IAC, DO, option]));
                this.updateBinaryMode();
                return;
            case TelnetOption.Echo:
                this.remoteOption[option] = WILL;
                this.send(Uint8Array.from([IAC, DO, option]));
                return;
            case TelnetOption.TerminalType:
                this.remoteOption[option] = WILL;
                this.send(Uint8Array.from([IAC, DO, option]));
                return;
            case TelnetOption.SuppressGoAhead:
                this.remoteOption[option] = WILL;
                this.send(Uint8Array.from([IAC, DO, option]));
                return;
            case TelnetOption.NAWS:
                this.remoteOption[option] = WILL;
                this.send(Uint8Array.from([IAC, DO, option]));
                return;
            default:
                this.send(Uint8Array.from([IAC, DONT, option]));
                return;
        }
    }
    onWont(option) {
        this.remoteOption[option] = WONT;
        if (option === TelnetOption.Binary) {
            this.remoteBinary = false;
            this.updateBinaryMode();
        }
    }
    updateBinaryMode() {
        this.binaryMode =
            this.remoteOption[TelnetOption.Binary] === WILL && this.localOption[TelnetOption.Binary] === DO;
    }
    handleSubnegotiation(payload) {
        // payload = [IAC, SB, <option>, <data...>, IAC, SE]
        if (payload.length < 4)
            return;
        const option = payload[2];
        const data = payload.slice(3, payload.length - 2);
        if (option === TelnetOption.TerminalType && data[0] === 1) {
            // SEND request: reply with IS <name>.
            const name = this.opts.terminalType ?? TERMINAL_TYPES.ansi;
            const out = [IAC, SB, TelnetOption.TerminalType, 0];
            for (const ch of new TextEncoder().encode(name))
                out.push(ch);
            out.push(IAC, SE);
            this.send(Uint8Array.from(out));
            // Offer NAWS right after answering the terminal type.
            this.send(Uint8Array.from([IAC, WILL, TelnetOption.NAWS]));
            this.sendWindowChange();
        }
    }
    /** Send a NAWS subnegotiation with the current screen size. */
    sendWindowChange() {
        if (this.localOption[TelnetOption.NAWS] !== DO)
            return;
        const cols = Math.max(0, Math.min(0xffff, this.opts.cols ?? 80));
        const rows = Math.max(0, Math.min(0xffff, this.opts.rows ?? 25));
        const out = [IAC, SB, TelnetOption.NAWS, (cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff, IAC, SE];
        this.send(Uint8Array.from(out));
    }
    /**
     * Prepare bytes for transmission to the server.
     *
     * CR becomes CR LF unless binary mode is active, and 0xFF is doubled.
     */
    encodeOutgoing(data) {
        const expandCr = !this.binaryMode;
        const out = [];
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            if (b === 0xff) {
                out.push(0xff, 0xff);
                continue;
            }
            if (b === 0x0d && expandCr) {
                out.push(0x0d, 0x0a);
                continue;
            }
            if (b === 0x0a && expandCr && i > 0 && data[i - 1] === 0x0d)
                continue;
            out.push(b);
        }
        return Uint8Array.from(out);
    }
}
//# sourceMappingURL=telnet.js.map