/**
 * Transfer handshake guard.
 *
 * A remote host can start a file transfer at any moment by sending a ZMODEM
 * or X/YMODEM request. Those bytes must not appear on the screen, but every
 * other byte must appear immediately — a terminal that delays its output is
 * not a terminal.
 *
 * This guard withholds only the bytes that could *begin* a handshake:
 *
 *  - ZMODEM: `ZDLE ZHEX '0' '0'` (a download) or `ZDLE ZHEX '0' '1'` (an
 *    upload). Only the four-byte prefix is matched, exactly as upstream's
 *    `feed_zmodem_detect()` does.
 *  - X/YMODEM: two identical consecutive request bytes — `NAK` (0x15),
 *    `C` (0x43) or `G` (0x47).
 *
 * Everything else is passed straight through.
 */

/** The ZMODEM prefix, minus the final byte. */
const ZMODEM_PREFIX = [0x18, 0x42, 0x30];

/** The X/YMODEM request bytes. */
const XMODEM_BYTES = [0x15, 0x43, 0x47];

/** What a completed handshake was. */
export type Handshake =
	| 'zmodem-download'
	| 'zmodem-upload'
	| 'xmodem-crc'
	| 'xmodem-chksum'
	| 'ymodem-g';

/** The result of feeding one byte to the guard. */
export interface GuardResult {
	/** The bytes that may be displayed. */
	display: number[];
	/** The handshake that just completed, if any. */
	handshake: Handshake | null;
}

/** The guard's internal state. */
type GuardState = 'none' | 'zm1' | 'zm2' | 'zm3' | 'xm1';

export class TransferHandshakeGuard {
	private hold: number[] = [];
	private state: GuardState = 'none';

	/** The bytes currently withheld. */
	get pending(): readonly number[] {
		return this.hold;
	}

	/**
	 * Feed one byte.
	 *
	 * When a handshake completes, the withheld bytes are returned in
	 * `display` as well so that the caller can decide whether to show them;
	 * the caller normally suppresses them.
	 */
	push(byte: number): GuardResult {
		switch (this.state) {
			case 'none':
				if (byte === 0x18) {
					this.state = 'zm1';
					this.hold = [byte];
					return { display: [], handshake: null };
				}
				if (XMODEM_BYTES.includes(byte)) {
					this.state = 'xm1';
					this.hold = [byte];
					return { display: [], handshake: null };
				}
				return { display: [byte], handshake: null };

			case 'zm1': {
				if (byte === 0x42) {
					this.state = 'zm2';
					this.hold.push(byte);
					return { display: [], handshake: null };
				}
				return this.flushAndRestart(byte);
			}

			case 'zm2': {
				if (byte === 0x30) {
					this.state = 'zm3';
					this.hold.push(byte);
					return { display: [], handshake: null };
				}
				return this.flushAndRestart(byte);
			}

			case 'zm3': {
				if (byte === 0x30 || byte === 0x31) {
					this.hold.push(byte);
					const held = this.hold;
					this.hold = [];
					this.state = 'none';
					return {
						display: held,
						handshake: byte === 0x31 ? 'zmodem-upload' : 'zmodem-download',
					};
				}
				return this.flushAndRestart(byte);
			}

			case 'xm1': {
				if (byte === this.hold[0]) {
					const held = this.hold;
					this.hold = [];
					this.state = 'none';
					const handshake: Handshake =
						byte === 0x43 ? 'xmodem-crc' : byte === 0x47 ? 'ymodem-g' : 'xmodem-chksum';
					return { display: held.concat(byte), handshake };
				}
				return this.flushAndRestart(byte);
			}

			default:
				return { display: [byte], handshake: null };
		}
	}

	/**
	 * Release the withheld bytes (used when the connection ends or the
	 * transfer is cancelled).
	 */
	flush(): number[] {
		const held = this.hold;
		this.hold = [];
		this.state = 'none';
		return held;
	}

	/** Forget the withheld bytes without displaying them. */
	reset(): void {
		this.hold = [];
		this.state = 'none';
	}

	/**
	 * Release the withheld bytes and re-examine `byte` as a fresh start.
	 *
	 * `byte` is not included in the returned display bytes when it starts a
	 * new candidate handshake.
	 */
	private flushAndRestart(byte: number): GuardResult {
		const held = this.hold;
		this.hold = [];
		this.state = 'none';
		if (byte === 0x18) {
			this.state = 'zm1';
			this.hold = [byte];
			return { display: held, handshake: null };
		}
		if (XMODEM_BYTES.includes(byte)) {
			this.state = 'xm1';
			this.hold = [byte];
			return { display: held, handshake: null };
		}
		return { display: held.concat(byte), handshake: null };
	}
}
