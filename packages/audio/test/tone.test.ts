import { describe, expect, it } from 'vitest';
import { playTone } from '../src/index.js';
import { FakeAudioContext } from './fake-audio.js';

describe('playTone', () => {
	it('schedules a single tone with the requested waveform', () => {
		const fake = new FakeAudioContext();
		playTone(440, 100, { audioContext: fake.asContext(), type: 'square', volume: 0.5 });

		expect(fake.oscillators).toHaveLength(1);
		const oscillator = fake.oscillators[0];
		expect(oscillator.type).toBe('square');
		expect(oscillator.frequency.value).toBe(440);
		expect(oscillator.startTime).toBe(0);
		expect(oscillator.stopTime).toBeCloseTo(0.1, 6);
	});

	it('does nothing when Web Audio is unavailable', () => {
		expect(() =>
			playTone(440, 100, {
				createContext: () => {
					throw new Error('unavailable');
				},
			}),
		).not.toThrow();
	});
});
