import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AnsiMusicPlayer,
	MUSIC_WORKLET_SOURCE,
	noteDurationSeconds,
	WORKLET_PROCESSOR_NAME,
} from '../src/index.js';
import { noteFrequency, parseMusic } from '../../core/src/music.js';
import { FakeAudioContext } from './fake-audio.js';

const players: AnsiMusicPlayer[] = [];

function setup(options: ConstructorParameters<typeof AnsiMusicPlayer>[0] = {}) {
	const fake = new FakeAudioContext();
	const player = new AnsiMusicPlayer({ audioContext: fake.asContext(), ...options });
	players.push(player);
	return { fake, player };
}

afterEach(() => {
	for (const player of players) player.stop();
	players.length = 0;
	vi.useRealTimers();
});

describe('AnsiMusicPlayer scheduling', () => {
	it('plays a note and treats a rest as silence', () => {
		const { fake, player } = setup();
		player.play(
			[
				{ note: 60, duration: 4 },
				{ note: -1, duration: 4 },
			],
			{ tempo: 120 },
		);

		expect(player.playing).toBe(true);
		expect(fake.oscillators).toHaveLength(1);
		const oscillator = fake.oscillators[0];
		expect(oscillator.frequency.value).toBeCloseTo(noteFrequency(60), 6);
		expect(oscillator.startTime).toBe(0);
		// A quarter note at 120 bpm lasts 60 / 120 = 0.5 s.
		expect(oscillator.stopTime).toBeCloseTo(0.5, 6);
	});

	it('schedules consecutive notes at 0 and 0.5 seconds', () => {
		const { fake, player } = setup();
		player.play(
			[
				{ note: 60, duration: 4 },
				{ note: 62, duration: 4 },
			],
			{ tempo: 120 },
		);

		expect(fake.oscillators).toHaveLength(2);
		expect(fake.oscillators[0].startTime).toBeCloseTo(0, 6);
		expect(fake.oscillators[1].startTime).toBeCloseTo(0.5, 6);
		expect(fake.oscillators[1].stopTime).toBeCloseTo(1, 6);
	});

	it('schedules parsed ANSI music', () => {
		const { fake, player } = setup();
		const notes = parseMusic('CDEF');
		expect(notes).toHaveLength(4);
		player.play(notes, { tempo: 120 });

		expect(fake.oscillators).toHaveLength(4);
		for (let i = 0; i < notes.length; i++) {
			expect(fake.oscillators[i].frequency.value).toBeCloseTo(noteFrequency(notes[i].note), 6);
			expect(fake.oscillators[i].startTime).toBeCloseTo(i * 0.5, 6);
		}
	});

	it('stops the current sequence in background mode', () => {
		const { fake, player } = setup();
		player.play([{ note: 60, duration: 1 }], { tempo: 120 });
		expect(fake.oscillators).toHaveLength(1);

		player.play([{ note: 64, duration: 4 }], { tempo: 120 });
		expect(fake.oscillators).toHaveLength(2);
		// The first sequence was stopped immediately.
		expect(fake.oscillators[0].stopTime).toBe(0);
		expect(player.playing).toBe(true);
	});

	it('queues sequences in foreground mode', () => {
		vi.useFakeTimers();
		const { fake, player } = setup();
		player.play([{ note: 60, duration: 4 }], { tempo: 120 });
		player.play([{ note: 64, duration: 4 }], { tempo: 120, mode: 'foreground' });

		expect(fake.oscillators).toHaveLength(1);
		vi.advanceTimersByTime(600);
		expect(fake.oscillators).toHaveLength(2);
	});

	it('reports a playback error when Web Audio is unavailable', () => {
		const player = new AnsiMusicPlayer({
			createContext: () => {
				throw new Error('no Web Audio');
			},
		});
		players.push(player);
		const onError = vi.fn();
		expect(() => player.play([{ note: 60, duration: 4 }], { onError })).not.toThrow();
		expect(onError).toHaveBeenCalledOnce();
		expect(player.playing).toBe(false);
	});

	it('applies volume and mute to the master gain', () => {
		const { fake, player } = setup();
		player.volume = 0.25;
		player.muted = true;
		player.play([{ note: 60, duration: 4 }], { tempo: 120 });

		const master = fake.gains[0];
		expect(master.gain.value).toBe(0);

		player.muted = false;
		expect(master.gain.value).toBeCloseTo(0.25, 6);
	});
});

describe('noteDurationSeconds', () => {
	it('converts durations at tempo 60', () => {
		expect(noteDurationSeconds(1, 60)).toBeCloseTo(4, 6);
		expect(noteDurationSeconds(2, 60)).toBeCloseTo(2, 6);
		expect(noteDurationSeconds(4, 60)).toBeCloseTo(1, 6);
	});

	it('converts durations at tempo 240', () => {
		expect(noteDurationSeconds(1, 240)).toBeCloseTo(1, 6);
		expect(noteDurationSeconds(2, 240)).toBeCloseTo(0.5, 6);
		expect(noteDurationSeconds(4, 240)).toBeCloseTo(0.25, 6);
	});

	it('honours the tempo when scheduling', () => {
		const { fake, player } = setup();
		player.play([{ note: 60, duration: 1 }], { tempo: 240 });
		expect(fake.oscillators[0].stopTime).toBeCloseTo(1, 6);
	});
});

describe('Audio state', () => {
	it('reports unavailable when no AudioContext can be constructed', () => {
		const player = new AnsiMusicPlayer({
			createContext: () => {
				throw new Error('unavailable');
			},
		});
		players.push(player);

		expect(player.state).toEqual({
			available: false,
			contextState: 'unavailable',
			sampleRate: 0,
			playing: false,
		});
	});

	it('reports the context state and unlocks it', async () => {
		const { fake, player } = setup();
		expect(player.state.available).toBe(true);
		expect(player.state.contextState).toBe('suspended');
		expect(player.state.sampleRate).toBe(44100);

		await player.unlock();
		expect(fake.state).toBe('running');
		expect(fake.resumeCalls).toBe(1);
		expect(player.state.contextState).toBe('running');
	});
});

describe('music worklet source', () => {
	it('registers the processor from an inline source string', () => {
		expect(MUSIC_WORKLET_SOURCE).toContain(`registerProcessor('${WORKLET_PROCESSOR_NAME}'`);
		expect(MUSIC_WORKLET_SOURCE).toContain('class WebSyncTermMusicProcessor extends AudioWorkletProcessor');
	});
});
