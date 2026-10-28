/**
 * The AudioWorklet processor used by the music sequencer.
 *
 * The source is kept as a string so the package ships without a separate asset
 * file: it is turned into a Blob URL and loaded with `audioWorklet.addModule()`
 * at runtime. This file only exports a string, so importing it in Node is safe.
 *
 * Message protocol:
 *   { type: 'schedule', events: [{ frequency, start, duration }], total }
 *   { type: 'stop' }
 * `start` and `duration` are seconds relative to the start of the sequence.
 * The processor posts `{ type: 'done' }` when the sequence has played out.
 */
export const WORKLET_PROCESSOR_NAME = 'websyncterm-music';

export const MUSIC_WORKLET_SOURCE = `
class WebSyncTermMusicProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.events = [];
		this.index = 0;
		this.frame = 0;
		this.totalFrames = 0;
		this.active = false;
		this.phase = 0;
		this.port.onmessage = (event) => {
			const data = event.data || {};
			if (data.type === 'schedule') {
				this.events = [];
				for (const note of data.events || []) {
					this.events.push({
						frequency: note.frequency,
						startFrame: Math.round((note.start || 0) * sampleRate),
						endFrame: Math.round(((note.start || 0) + (note.duration || 0)) * sampleRate),
					});
				}
				this.index = 0;
				this.frame = 0;
				this.phase = 0;
				this.totalFrames = Math.round((data.total || 0) * sampleRate);
				this.active = this.events.length > 0;
			} else if (data.type === 'stop') {
				this.active = false;
				this.events = [];
			}
		};
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		const channel = output && output[0];
		if (!channel) return true;
		if (!this.active) {
			channel.fill(0);
			return true;
		}

		const attack = 0.005;
		const release = 0.01;
		for (let i = 0; i < channel.length; i++) {
			let event = this.events[this.index];
			while (event && this.frame >= event.endFrame) {
				this.index++;
				event = this.events[this.index];
			}
			let sample = 0;
			if (event && this.frame >= event.startFrame) {
				const elapsed = (this.frame - event.startFrame) / sampleRate;
				const remaining = (event.endFrame - this.frame) / sampleRate;
				let envelope = 1;
				if (elapsed < attack) envelope = elapsed / attack;
				else if (remaining < release) envelope = Math.max(0, remaining / release);
				sample = Math.sin(this.phase * 2 * Math.PI) * envelope * 0.5;
				this.phase += event.frequency / sampleRate;
				if (this.phase >= 1) this.phase -= 1;
			}
			channel[i] = sample;
			this.frame++;
		}

		if (this.frame >= this.totalFrames) {
			this.active = false;
			this.port.postMessage({ type: 'done' });
		}
		return true;
	}
}

registerProcessor('${WORKLET_PROCESSOR_NAME}', WebSyncTermMusicProcessor);
`;
