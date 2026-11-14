// Preloaded only into the explicitly enabled integration test's child processes.
// Reject network connections except loopback, including SDK/telemetry traffic.
const net = require('node:net');
const allowed = (host) => host === undefined || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' ? first.host ?? first.hostname
    : typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first)) ? args[1] : undefined;
  if (!allowed(host)) throw new Error('Offline integration blocked an external connection.');
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
if (originalFetch) globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) return Promise.reject(new Error('Offline integration blocked an external fetch.'));
  return originalFetch(input, init);
};
