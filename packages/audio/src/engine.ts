/**
 * Thin, lazily-created wrapper around `AudioContext`.
 *
 * The context is never created at module scope. `ensureContext()` is called on
 * the first operation that needs audio and caches either the context or the
 * fact that it could not be created, which is what `state.available` reports.
 */

import type { AudioBackendOptions, AudioState } from './types.js';
import { MUSIC_WORKLET_SOURCE, WORKLET_PROCESSOR_NAME } from './worklet.js';

/** Clamp a number to the 0..1 range. */
export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Create the platform's AudioContext, preferring the standard name. */
export function defaultCreateContext(): AudioContext {
	const scope = globalThis as unknown as {
		AudioContext?: new () => AudioContext;
		webkitAudioContext?: new () => AudioContext;
	};
	const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
	if (!Ctor) throw new Error('Web Audio is not available');
	return new Ctor();
}

/** Whether this context can load and run our AudioWorklet. */
export function supportsWorklet(context: AudioContext): boolean {
	return (
		typeof AudioWorkletNode !== 'undefined' &&
		typeof context.audioWorklet?.addModule === 'function' &&
		typeof Blob !== 'undefined' &&
		typeof URL !== 'undefined' &&
		typeof URL.createObjectURL === 'function'
	);
}

export class AudioEngine {
	private readonly explicitContext: AudioContext | undefined;
	private readonly createContext: () => AudioContext;
	private contextValue: AudioContext | null = null;
	private masterValue: GainNode | null = null;
	private failed = false;
	private volumeValue: number;
	private mutedValue = false;
	private workletLoad: Promise<boolean> | null = null;

	constructor(options: AudioBackendOptions = {}) {
		this.explicitContext = options.audioContext;
		this.createContext = options.createContext ?? defaultCreateContext;
		this.volumeValue = clamp01(options.volume ?? 1);
	}

	/** The context, creating it on first access. `null` when unavailable. */
	ensureContext(): AudioContext | null {
		if (this.contextValue) return this.contextValue;
		if (this.failed) return null;
		try {
			const context = this.explicitContext ?? this.createContext();
			if (!context) throw new Error('Web Audio is not available');
			this.contextValue = context;
		} catch {
			this.failed = true;
			return null;
		}
		try {
			this.masterValue = this.contextValue.createGain();
			this.masterValue.gain.setValueAtTime(this.effectiveGain(), this.contextValue.currentTime);
			this.masterValue.connect(this.contextValue.destination);
		} catch {
			this.masterValue = null;
		}
		return this.contextValue;
	}

	/** The master gain node, creating the context if needed. */
	get masterGain(): GainNode | null {
		this.ensureContext();
		return this.masterValue;
	}

	get volume(): number {
		return this.volumeValue;
	}

	set volume(value: number) {
		this.volumeValue = clamp01(value);
		this.applyGain();
	}

	get muted(): boolean {
		return this.mutedValue;
	}

	set muted(value: boolean) {
		this.mutedValue = value;
		this.applyGain();
	}

	/** Current context time, or 0 when there is no context. */
	get currentTime(): number {
		return this.contextValue?.currentTime ?? 0;
	}

	get state(): AudioState {
		const context = this.ensureContext();
		return {
			available: context !== null,
			contextState: context ? context.state : 'unavailable',
			sampleRate: context ? context.sampleRate : 0,
			playing: false,
		};
	}

	/** Resume the context after a user gesture. No-op when unavailable. */
	async unlock(): Promise<void> {
		const context = this.ensureContext();
		if (!context) return;
		if (context.state !== 'running') {
			try {
				await context.resume();
			} catch {
				// Browsers may refuse to resume without a gesture; ignore.
			}
		}
	}

	/**
	 * Load the music AudioWorklet from a Blob URL.
	 *
	 * Returns true when the processor is ready. The module is only added once;
	 * concurrent calls share the same promise.
	 */
	loadMusicWorklet(context: AudioContext): Promise<boolean> {
		if (!supportsWorklet(context)) return Promise.resolve(false);
		if (!this.workletLoad) {
			this.workletLoad = (async () => {
				const url = URL.createObjectURL(new Blob([MUSIC_WORKLET_SOURCE], { type: 'application/javascript' }));
				try {
					await context.audioWorklet.addModule(url);
					return true;
				} catch {
					return false;
				} finally {
					URL.revokeObjectURL(url);
				}
			})();
		}
		return this.workletLoad;
	}

	private effectiveGain(): number {
		return this.mutedValue ? 0 : this.volumeValue;
	}

	private applyGain(): void {
		const context = this.ensureContext();
		if (!context || !this.masterValue) return;
		this.masterValue.gain.setValueAtTime(this.effectiveGain(), context.currentTime);
	}

	/** Create an AudioWorkletNode using the already-loaded processor. */
	createMusicWorkletNode(context: AudioContext): AudioWorkletNode {
		return new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [1],
		});
	}
}
