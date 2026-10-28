import type { TimerHandle, Timers } from './types.js';

/** Real timers, using the host's `setTimeout`. */
export const systemTimers: Timers = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Deterministic timers for tests (and for callers that want to drive
 * timeouts from their own event loop).
 *
 * ```ts
 * const timers = new ManualTimers();
 * const rx = new XModemReceiver({ sink, timers });
 * timers.advance(3000);       // fire the first retry
 * rx.poll();                  // -> [0x43] again
 * ```
 */
export class ManualTimers implements Timers {
	private current = 0;
	private nextId = 1;
	private readonly pending = new Map<number, { at: number; handler: () => void }>();

	now(): number {
		return this.current;
	}

	setTimeout(handler: () => void, ms: number): TimerHandle {
		const id = this.nextId++;
		this.pending.set(id, { at: this.current + Math.max(0, ms), handler });
		return id;
	}

	clearTimeout(handle: TimerHandle): void {
		this.pending.delete(handle as number);
	}

	/** Milliseconds until the next scheduled timer, or `Infinity`. */
	get nextDue(): number {
		let due = Infinity;
		for (const t of this.pending.values()) due = Math.min(due, t.at);
		return due === Infinity ? Infinity : due - this.current;
	}

	/** Number of timers currently scheduled. */
	get size(): number {
		return this.pending.size;
	}

	/** Advance the clock, firing every timer that comes due (in time order). */
	advance(ms: number): void {
		const target = this.current + Math.max(0, ms);
		for (;;) {
			let nextId = -1;
			let nextAt = Infinity;
			for (const [id, t] of this.pending) {
				if (t.at <= target && t.at < nextAt) {
					nextAt = t.at;
					nextId = id;
				}
			}
			if (nextId < 0) break;
			const t = this.pending.get(nextId)!;
			this.pending.delete(nextId);
			this.current = Math.max(this.current, t.at);
			t.handler();
		}
		this.current = target;
	}
}
