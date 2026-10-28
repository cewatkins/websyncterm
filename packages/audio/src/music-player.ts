/**
 * ANSI/BANSI music sequencer.
 *
 * Notes come from `@websyncterm/core`'s `parseMusic()`. Each note's `duration`
 * is the reciprocal of a whole note (4 = a quarter note, 2 = a half, 1 = a
 * whole), and the tempo is in quarter notes per minute.
 *
 * Duration arithmetic: one quarter note (a beat) lasts `60 / tempo` seconds, a
 * whole note is four beats, so a note of duration `d` lasts
 * `(4 / d) * (60 / tempo)` seconds. At tempo 120 a quarter note is 0.5 s, a
 * half note 1 s and a whole note 2 s. (Equivalently `240 / (d * tempo)`.)
 */

import { noteFrequency, type MusicNote } from '@websyncterm/core';
import { AudioEngine, supportsWorklet } from './engine.js';
import type { AudioBackendOptions, AudioState } from './types.js';

/** Options accepted by the {@link AnsiMusicPlayer} constructor. */
export interface AnsiMusicPlayerOptions extends AudioBackendOptions {
	/** Default tempo in quarter notes per minute. */
	tempo?: number;
	/** Oscillator waveform used for the fallback path. */
	waveform?: OscillatorType;
}

/** Where a new sequence goes relative to the one that is already playing. */
export type MusicQueueMode = 'background' | 'foreground';

/** Options accepted by {@link AnsiMusicPlayer.play}. */
export interface MusicPlayOptions {
	/** Tempo in quarter notes per minute; defaults to the player's tempo. */
	tempo?: number;
	/** Called once the sequence has played to the end. */
	onDone?: () => void;
	/** Called when playback could not be started. */
	onError?: (error: Error) => void;
	/**
	 * `background` (the default) stops the current sequence before starting;
	 * `foreground` queues this sequence behind the current one.
	 */
	mode?: MusicQueueMode;
}

/** Convert an ANSI music duration to seconds. */
export function noteDurationSeconds(duration: number, tempo: number): number {
	if (!Number.isFinite(duration) || duration <= 0) return 0;
	if (!Number.isFinite(tempo) || tempo <= 0) return 0;
	// See the arithmetic note at the top of the file.
	return (4 / duration) * (60 / tempo);
}

interface Sequence {
	notes: MusicNote[];
	tempo: number;
	onDone?: () => void;
	onError?: (error: Error) => void;
	cancelled: boolean;
}

export class AnsiMusicPlayer {
	private readonly engine: AudioEngine;
	private readonly waveform: OscillatorType;
	private tempo: number;
	private current: Sequence | null = null;
	private queue: Sequence[] = [];
	private oscillators = new Set<OscillatorNode>();
	private workletNode: AudioWorkletNode | null = null;
	private doneTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: AnsiMusicPlayerOptions = {}) {
		this.engine = new AudioEngine(options);
		this.tempo = options.tempo ?? 120;
		this.waveform = options.waveform ?? 'sine';
	}

	/** Whether a sequence is currently scheduled. */
	get playing(): boolean {
		return this.current !== null;
	}

	get volume(): number {
		return this.engine.volume;
	}

	set volume(value: number) {
		this.engine.volume = value;
	}

	get muted(): boolean {
		return this.engine.muted;
	}

	set muted(value: boolean) {
		this.engine.muted = value;
	}

	/** Tempo in quarter notes per minute. */
	get defaultTempo(): number {
		return this.tempo;
	}

	set defaultTempo(value: number) {
		if (Number.isFinite(value) && value > 0) this.tempo = value;
	}

	/** Audio state for the `CSI = 7 ... n` report. */
	get state(): AudioState {
		return { ...this.engine.state, playing: this.playing };
	}

	/** Resume the context (call from a user gesture). */
	async unlock(): Promise<void> {
		await this.engine.unlock();
	}

	/** Start (or queue) a sequence of notes. */
	play(notes: MusicNote[], options: MusicPlayOptions = {}): void {
		if (!Array.isArray(notes) || notes.length === 0) {
			options.onDone?.();
			return;
		}
		const sequence: Sequence = {
			notes,
			tempo: options.tempo ?? this.tempo,
			onDone: options.onDone,
			onError: options.onError,
			cancelled: false,
		};
		const mode: MusicQueueMode = options.mode ?? 'background';
		if (mode === 'foreground' && this.current) {
			this.queue.push(sequence);
			return;
		}
		this.abortCurrent();
		this.queue = [];
		this.current = sequence;
		this.start(sequence);
	}

	/** Stop playback and discard anything that was queued. */
	stop(): void {
		this.queue = [];
		this.abortCurrent();
	}

	private start(sequence: Sequence): void {
		const context = this.engine.ensureContext();
		if (!context) {
			this.fail(sequence, new Error('Web Audio is not available'));
			return;
		}
		if (!supportsWorklet(context)) {
			this.startOscillators(sequence, context);
			return;
		}
		// Loading the module is async, so the worklet path begins a few
		// milliseconds late. If it cannot be loaded, fall back to oscillators.
		void this.engine.loadMusicWorklet(context).then(
			(ready) => {
				if (sequence.cancelled || this.current !== sequence) return;
				if (!ready) {
					this.startOscillators(sequence, context);
					return;
				}
				try {
					this.startWorklet(sequence, context);
				} catch {
					this.startOscillators(sequence, context);
				}
			},
			() => {
				if (sequence.cancelled || this.current !== sequence) return;
				this.startOscillators(sequence, context);
			},
		);
	}

	private startOscillators(sequence: Sequence, context: AudioContext): void {
		const master = this.engine.masterGain;
		if (!master) {
			this.fail(sequence, new Error('Web Audio is not available'));
			return;
		}
		try {
			let time = context.currentTime;
			for (const note of sequence.notes) {
				const duration = noteDurationSeconds(note.duration, sequence.tempo);
				if (note.note >= 0 && duration > 0) {
					const oscillator = context.createOscillator();
					const envelope = context.createGain();
					oscillator.type = this.waveform;
					oscillator.frequency.setValueAtTime(noteFrequency(note.note), time);

					const attack = Math.min(0.005, duration / 4);
					const release = Math.min(0.02, duration / 4);
					envelope.gain.setValueAtTime(0, time);
					envelope.gain.linearRampToValueAtTime(1, time + attack);
					envelope.gain.setValueAtTime(1, time + Math.max(attack, duration - release));
					envelope.gain.linearRampToValueAtTime(0, time + duration);

					oscillator.connect(envelope);
					envelope.connect(master);
					oscillator.start(time);
					oscillator.stop(time + duration);
					this.trackOscillator(oscillator);
				}
				time += duration;
			}
			this.scheduleDone(sequence, context, time);
		} catch (error) {
			this.fail(sequence, toError(error));
		}
	}

	private startWorklet(sequence: Sequence, context: AudioContext): void {
		const master = this.engine.masterGain;
		if (!master) throw new Error('Web Audio is not available');
		const node = this.engine.createMusicWorkletNode(context);
		let offset = 0;
		const events: Array<{ frequency: number; start: number; duration: number }> = [];
		for (const note of sequence.notes) {
			const duration = noteDurationSeconds(note.duration, sequence.tempo);
			if (note.note >= 0 && duration > 0) {
				events.push({ frequency: noteFrequency(note.note), start: offset, duration });
			}
			offset += duration;
		}
		node.port.onmessage = (event: MessageEvent) => {
			const data = event.data as { type?: string } | null;
			if (data?.type === 'done') this.finish(sequence);
		};
		node.connect(master);
		this.workletNode = node;
		node.port.postMessage({ type: 'schedule', events, total: offset });
		this.scheduleDone(sequence, context, context.currentTime + offset);
	}

	private scheduleDone(sequence: Sequence, context: AudioContext, endTime: number): void {
		if (this.doneTimer !== null) clearTimeout(this.doneTimer);
		const delay = Math.max(0, (endTime - context.currentTime) * 1000);
		this.doneTimer = setTimeout(() => {
			this.doneTimer = null;
			this.finish(sequence);
		}, delay + 1);
	}

	private trackOscillator(oscillator: OscillatorNode): void {
		this.oscillators.add(oscillator);
		oscillator.onended = () => {
			this.oscillators.delete(oscillator);
		};
	}

	private clearScheduled(): void {
		if (this.doneTimer !== null) {
			clearTimeout(this.doneTimer);
			this.doneTimer = null;
		}
		for (const oscillator of this.oscillators) {
			try {
				oscillator.stop();
			} catch {
				// Already stopped.
			}
		}
		this.oscillators.clear();
		if (this.workletNode) {
			try {
				this.workletNode.port.postMessage({ type: 'stop' });
				this.workletNode.disconnect();
			} catch {
				// Already disconnected.
			}
			this.workletNode = null;
		}
	}

	private abortCurrent(): void {
		const sequence = this.current;
		this.current = null;
		if (sequence) sequence.cancelled = true;
		this.clearScheduled();
	}

	private finish(sequence: Sequence): void {
		if (this.current !== sequence || sequence.cancelled) return;
		this.current = null;
		this.clearScheduled();
		try {
			sequence.onDone?.();
		} catch {
			// A broken callback must not break the queue.
		}
		this.next();
	}

	private fail(sequence: Sequence, error: Error): void {
		if (this.current !== sequence || sequence.cancelled) return;
		this.current = null;
		this.clearScheduled();
		try {
			sequence.onError?.(error);
		} catch {
			// Ignore callback errors.
		}
		this.next();
	}

	private next(): void {
		const sequence = this.queue.shift();
		if (!sequence) return;
		this.current = sequence;
		this.start(sequence);
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
