/**
 * Shared types for `@websyncterm/audio`.
 *
 * Nothing in this package touches `AudioContext` at module scope: the context
 * is created on first use so the module can be imported in Node (tests, SSR).
 */

/** The state of the audio context, or `'unavailable'` when Web Audio is missing. */
export type AudioContextStateName = AudioContextState | 'unavailable';

/** Audio state as reported by SyncTERM's `CSI = 7 ... n` sequence. */
export interface AudioState {
	/** Whether an AudioContext could be created. */
	available: boolean;
	/** The underlying context state, or `'unavailable'`. */
	contextState: AudioContextStateName;
	/** The context sample rate, or 0 when unavailable. */
	sampleRate: number;
	/** Whether anything is currently being played. */
	playing: boolean;
}

/**
 * Options shared by everything that needs an audio backend.
 *
 * `audioContext` supplies an already-created context; `createContext` supplies
 * a factory (used by the tests to inject a fake backend). Neither is touched
 * until audio is actually needed.
 */
export interface AudioBackendOptions {
	/** A pre-existing audio context. */
	audioContext?: AudioContext;
	/** Factory used to create the audio context lazily. */
	createContext?: () => AudioContext;
	/** Master volume in the range 0..1. */
	volume?: number;
}
