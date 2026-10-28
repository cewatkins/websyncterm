/**
 * A minimal fake Web Audio backend for the Node test environment.
 *
 * It records every oscillator that is created, along with its frequency
 * automation and start/stop times, which is enough to assert the schedules.
 */

export interface ParamEvent {
	type: 'set' | 'linear' | 'exponential' | 'cancel';
	value: number;
	time: number;
}

export class FakeAudioParam {
	value = 0;
	events: ParamEvent[] = [];

	setValueAtTime(value: number, time: number): this {
		this.value = value;
		this.events.push({ type: 'set', value, time });
		return this;
	}

	linearRampToValueAtTime(value: number, time: number): this {
		this.value = value;
		this.events.push({ type: 'linear', value, time });
		return this;
	}

	exponentialRampToValueAtTime(value: number, time: number): this {
		this.value = value;
		this.events.push({ type: 'exponential', value, time });
		return this;
	}

	cancelScheduledValues(time: number): this {
		this.events.push({ type: 'cancel', value: 0, time });
		return this;
	}
}

export class FakeOscillator {
	type: OscillatorType = 'sine';
	frequency = new FakeAudioParam();
	detune = new FakeAudioParam();
	startTime: number | null = null;
	stopTime: number | null = null;
	onended: ((event: Event) => void) | null = null;
	connected: unknown[] = [];

	connect<T>(node: T): T {
		this.connected.push(node);
		return node;
	}

	disconnect(): void {
		// No-op.
	}

	start(time = 0): void {
		this.startTime = time;
	}

	stop(time = 0): void {
		this.stopTime = time;
	}
}

export class FakeGain {
	gain = new FakeAudioParam();
	connected: unknown[] = [];

	connect<T>(node: T): T {
		this.connected.push(node);
		return node;
	}

	disconnect(): void {
		// No-op.
	}
}

export class FakeAudioContext {
	currentTime = 0;
	state: AudioContextState = 'suspended';
	sampleRate = 44100;
	destination = { name: 'destination' };
	oscillators: FakeOscillator[] = [];
	gains: FakeGain[] = [];
	resumeCalls = 0;
	suspendCalls = 0;
	closed = false;

	createOscillator(): FakeOscillator {
		const oscillator = new FakeOscillator();
		this.oscillators.push(oscillator);
		return oscillator;
	}

	createGain(): FakeGain {
		const gain = new FakeGain();
		this.gains.push(gain);
		return gain;
	}

	resume(): Promise<void> {
		this.resumeCalls++;
		this.state = 'running';
		return Promise.resolve();
	}

	suspend(): Promise<void> {
		this.suspendCalls++;
		this.state = 'suspended';
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.closed = true;
		this.state = 'closed';
		return Promise.resolve();
	}

	/** Cast for APIs that expect a real AudioContext. */
	asContext(): AudioContext {
		return this as unknown as AudioContext;
	}
}
