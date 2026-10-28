/**
 * General-purpose tone helper used by the RIP layer.
 *
 * The module keeps a lazily-created shared engine, so importing this file does
 * not touch `AudioContext` (important for Node tests). Tests may pass their own
 * context, in which case a per-context engine is reused.
 */

import { AudioEngine } from './engine.js';
import type { AudioBackendOptions } from './types.js';

export interface PlayToneOptions extends AudioBackendOptions {
	/** Oscillator waveform. Defaults to `'sine'`. */
	type?: OscillatorType;
	/** Peak volume in the range 0..1. Defaults to 1. */
	volume?: number;
	/** Attack time in seconds. Defaults to 5 ms. */
	attack?: number;
	/** Release time in seconds. Defaults to 10 ms. */
	release?: number;
}

const enginesByContext = new WeakMap<AudioContext, AudioEngine>();
let sharedEngine: AudioEngine | null = null;

function engineFor(options: PlayToneOptions): AudioEngine {
	if (options.audioContext) {
		let engine = enginesByContext.get(options.audioContext);
		if (!engine) {
			engine = new AudioEngine({ audioContext: options.audioContext });
			enginesByContext.set(options.audioContext, engine);
		}
		return engine;
	}
	if (!sharedEngine) sharedEngine = new AudioEngine(options.createContext ? { createContext: options.createContext } : {});
	return sharedEngine;
}

/** Play a single tone of `durationMs` milliseconds. */
export function playTone(frequency: number, durationMs: number, options: PlayToneOptions = {}): void {
	const engine = engineFor(options);
	const context = engine.ensureContext();
	if (!context) return;
	const master = engine.masterGain;
	if (!master) return;

	const duration = Math.max(0, durationMs) / 1000;
	if (duration === 0) return;

	const level = Math.min(1, Math.max(0, options.volume ?? 1));
	const attack = Math.min(Math.max(0, options.attack ?? 0.005), duration / 2);
	const release = Math.min(Math.max(0, options.release ?? 0.01), duration / 2);
	const time = context.currentTime;

	try {
		const oscillator = context.createOscillator();
		const envelope = context.createGain();
		oscillator.type = options.type ?? 'sine';
		oscillator.frequency.setValueAtTime(frequency, time);
		envelope.gain.setValueAtTime(0, time);
		envelope.gain.linearRampToValueAtTime(level, time + attack);
		envelope.gain.setValueAtTime(level, time + Math.max(attack, duration - release));
		envelope.gain.linearRampToValueAtTime(0, time + duration);
		oscillator.connect(envelope);
		envelope.connect(master);
		oscillator.start(time);
		oscillator.stop(time + duration);
	} catch {
		// Ignore a backend that refuses the schedule.
	}
}
