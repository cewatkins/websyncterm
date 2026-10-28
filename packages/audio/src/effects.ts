/**
 * SyncTERM RIP sound effects.
 *
 * Reimplements the effects triggered by `rv_sound()` in upstream
 * `src/syncterm/ripper.c`:
 *
 *   ALARM     3 x (320 Hz 200 ms, 160 Hz 425 ms), sine
 *   BEEP      1000 Hz for 75 ms, then 75 ms of silence
 *   BLIP      50 Hz for 25 ms
 *   MUSIC     1300 -> 700 -> 850 -> 1300 Hz, 30 + 60 + 30 + 240 ms (360 ms)
 *   PHASER    2500 -> 50 Hz over 10760 frames
 *   REVPHASER 50 -> 2500 Hz over 10760 frames
 */

import { AudioEngine } from './engine.js';
import type { AudioBackendOptions, AudioState } from './types.js';

export type SoundEffectName = 'ALARM' | 'BEEP' | 'BLIP' | 'MUSIC' | 'PHASER' | 'REVPHASER';

interface EffectSegment {
	/** Starting frequency in Hz (ignored for silent segments). */
	frequency: number;
	/** Duration in milliseconds. */
	duration: number;
	/** Optional target frequency for a sweep. */
	toFrequency?: number;
	/** A silent gap: advances the clock without sounding. */
	silent?: boolean;
}

/** The phase sweep used by PHASER/REVPHASER (10760 frames at 44.1 kHz). */
const PHASER_FRAMES = 10760;

const ALARM_SEGMENTS: EffectSegment[] = [];
for (let i = 0; i < 3; i++) {
	ALARM_SEGMENTS.push({ frequency: 320, duration: 200 });
	ALARM_SEGMENTS.push({ frequency: 160, duration: 425 });
}

const MUSIC_SEGMENTS: EffectSegment[] = [
	{ frequency: 1300, duration: 30 },
	{ frequency: 700, duration: 60 },
	{ frequency: 850, duration: 30 },
	{ frequency: 1300, duration: 240 },
];

/** Build the segments for an effect; PHASER duration depends on the sample rate. */
function segmentsFor(name: SoundEffectName, sampleRate: number): EffectSegment[] {
	switch (name) {
		case 'ALARM':
			return ALARM_SEGMENTS;
		case 'BEEP':
			return [
				{ frequency: 1000, duration: 75 },
				{ frequency: 0, duration: 75, silent: true },
			];
		case 'BLIP':
			return [{ frequency: 50, duration: 25 }];
		case 'MUSIC':
			return MUSIC_SEGMENTS;
		case 'PHASER':
			return [
				{
					frequency: 2500,
					toFrequency: 50,
					duration: (PHASER_FRAMES / (sampleRate || 44100)) * 1000,
				},
			];
		case 'REVPHASER':
			return [
				{
					frequency: 50,
					toFrequency: 2500,
					duration: (PHASER_FRAMES / (sampleRate || 44100)) * 1000,
				},
			];
		default:
			return [];
	}
}

export class SoundEffects {
	private readonly engine: AudioEngine;
	private oscillators = new Set<OscillatorNode>();

	constructor(options: AudioBackendOptions = {}) {
		this.engine = new AudioEngine(options);
	}

	/** Master volume in the range 0..1. */
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

	/** Audio state for the `CSI = 7 ... n` report. */
	get state(): AudioState {
		return { ...this.engine.state, playing: this.oscillators.size > 0 };
	}

	/** Resume the context (call from a user gesture). */
	async unlock(): Promise<void> {
		await this.engine.unlock();
	}

	/** Play one of the upstream RIP sound effects. */
	play(name: SoundEffectName, volume = 1): void {
		const context = this.engine.ensureContext();
		if (!context) return;
		const master = this.engine.masterGain;
		if (!master) return;

		const level = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
		const segments = segmentsFor(name, context.sampleRate);
		let time = context.currentTime;
		try {
			for (const segment of segments) {
				const duration = Math.max(0, segment.duration) / 1000;
				if (segment.silent || duration === 0) {
					time += duration;
					continue;
				}
				const oscillator = context.createOscillator();
				const envelope = context.createGain();
				oscillator.type = 'sine';
				oscillator.frequency.setValueAtTime(segment.frequency, time);
				if (segment.toFrequency !== undefined) {
					oscillator.frequency.exponentialRampToValueAtTime(
						Math.max(1, segment.toFrequency),
						time + duration,
					);
				}

				const attack = Math.min(0.003, duration / 2);
				const release = Math.min(0.005, duration / 2);
				envelope.gain.setValueAtTime(0, time);
				envelope.gain.linearRampToValueAtTime(level, time + attack);
				envelope.gain.setValueAtTime(level, time + Math.max(attack, duration - release));
				envelope.gain.linearRampToValueAtTime(0, time + duration);

				oscillator.connect(envelope);
				envelope.connect(master);
				oscillator.start(time);
				oscillator.stop(time + duration);
				this.oscillators.add(oscillator);
				oscillator.onended = () => {
					this.oscillators.delete(oscillator);
				};
				time += duration;
			}
		} catch {
			// If the backend rejects the schedule there is nothing useful to do;
			// make sure we do not leak partially scheduled sources.
			this.stopAll();
		}
	}

	/** Stop every effect that is still scheduled. */
	stopAll(): void {
		for (const oscillator of this.oscillators) {
			try {
				oscillator.stop();
			} catch {
				// Already stopped.
			}
		}
		this.oscillators.clear();
	}
}
