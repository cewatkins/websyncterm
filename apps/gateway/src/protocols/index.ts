import type { ConnectFunction, ProtocolName } from './types.js';
import { connect as connectTelnet } from './telnet.js';
import { connect as connectTelnets } from './telnets.js';
import { connect as connectSsh } from './ssh.js';
import { connect as connectRlogin } from './rlogin.js';
import { connect as connectRaw } from './raw.js';

export const connectors: Record<ProtocolName, ConnectFunction> = {
	telnet: connectTelnet,
	telnets: connectTelnets,
	ssh: connectSsh,
	rlogin: connectRlogin,
	raw: connectRaw,
};

export { DEFAULT_PORTS } from './util.js';
export * from './types.js';
