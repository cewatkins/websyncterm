/**
 * The embed page entry point.
 *
 * The page reads `?bbs=host:port&proto=…` and mounts the `<web-syncterm>`
 * element, adding the ftelnet-style controls.
 */

import './element.js';

function readTarget(): { host: string; port: number; proto: string } | null {
	const params = new URLSearchParams(location.search);
	const bbs = params.get('bbs');
	if (!bbs) return null;
	const [host, port] = bbs.split(':');
	return { host: host ?? '', port: port ? Number(port) : 23, proto: params.get('proto') ?? 'telnet' };
}

const target = readTarget();
const root = document.getElementById('app');

if (root) {
	const element = document.createElement('web-syncterm');
	if (target) {
		element.setAttribute('host', target.host);
		element.setAttribute('port', String(target.port));
		element.setAttribute('proto', target.proto);
	}
	const mode = new URLSearchParams(location.search).get('mode');
	if (mode) element.setAttribute('mode', mode);
	const gateway = new URLSearchParams(location.search).get('gateway');
	if (gateway) element.setAttribute('gateway', gateway);
	root.append(element);
}
