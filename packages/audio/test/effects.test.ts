import { describe, expect, it } from 'vitest';
import { SoundEffects } from '../src/index.js';
import { FakeAudioContext } from './fake-audio.js';

function setup() {
	const fake = new FakeAudioContext();
	const effects = new SoundEffects({ audioContext: fake.asContext() });
	return { fake, effects };
}

function frequencies(fake: FakeAudioContext): number[] {
	return fake.oscillators.map((oscillator) => oscillator.frequency.value);
}

describe('SoundEffects', () => {
	it('plays ALARM as three 320/160 Hz pairs', () => {
		const { fake, effects } = setup();
		effects.play('ALARM');

		expect(fake.oscillators).toHaveLength(6);
		expect(frequencies(fake)).toEqual([320, 160, 320, 160, 320, 160]);
		expect(fake.oscillators.map((oscillator) => oscillator.startTime)).toEqual([
			0, 0.2, 0.625, 0.825, 1.25, 1.45,
		]);
		expect(effects.state.playing).toBe(true);
		effects.stopAll();
		expect(effects.state.playing).toBe(false);
	});

	it('plays BEEP with a trailing silence', () => {
		const { fake, effects } = setup();
		effects.play('BEEP');

		expect(fake.oscillators).toHaveLength(1);
		expect(fake.oscillators[0].frequency.value).toBe(1000);
		expect(fake.oscillators[0].stopTime).toBeCloseTo(0.075, 6);
	});

	it('plays BLIP as a short 50 Hz tone', () => {
		const { fake, effects } = setup();
		effects.play('BLIP');

		expect(fake.oscillators).toHaveLength(1);
		expect(fake.oscillators[0].frequency.value).toBe(50);
		expect(fake.oscillators[0].stopTime).toBeCloseTo(0.025, 6);
	});

	it('plays MUSIC as a four-stage sweep', () => {
		const { fake, effects } = setup();
		effects.play('MUSIC');

		expect(fake.oscillators).toHaveLength(4);
		expect(frequencies(fake)).toEqual([1300, 700, 850, 1300]);
		expect(fake.oscillators.map((oscillator) => oscillator.startTime)).toEqual([
			0, 0.03, 0.09, 0.12,
		]);
	});

	it('plays PHASER as a 2500 -> 50 Hz sweep', () => {
		const { fake, effects } = setup();
		effects.play('PHASER');

		expect(fake.oscillators).toHaveLength(1);
		const oscillator = fake.oscillators[0];
		expect(oscillator.frequency.events[0].value).toBe(2500);
		const ramp = oscillator.frequency.events.find((event) => event.type === 'exponential');
		expect(ramp?.value).toBe(50);
		expect(ramp?.time).toBeCloseTo(10760 / 44100, 6);
	});

	it('plays REVPHASER as a 50 -> 2500 Hz sweep', () => {
		const { fake, effects } = setup();
		effects.play('REVPHASER');

		expect(fake.oscillators).toHaveLength(1);
		const oscillator = fake.oscillators[0];
		const events = oscillator.frequency.events;
		expect(events[0].value).toBe(50);
		const ramp = events.find((event) => event.type === 'exponential');
		expect(ramp?.value).toBe(2500);
	});

	it('stops every scheduled oscillator with stopAll', () => {
		const { fake, effects } = setup();
		effects.play('ALARM');
		effects.stopAll();

		for (const oscillator of fake.oscillators) expect(oscillator.stopTime).toBe(0);
	});

	it('reports unavailable when no AudioContext can be constructed', () => {
		const effects = new SoundEffects({
			createContext: () => {
				throw new Error('unavailable');
			},
		});
		expect(effects.state.available).toBe(false);
		expect(() => effects.play('BEEP')).not.toThrow();
	});
});
