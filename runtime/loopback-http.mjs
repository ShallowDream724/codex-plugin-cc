import { request } from 'node:http';

export function postLoopbackJson(port, body, { token, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid local bridge port.');
    const payload = JSON.stringify(body);
    signal?.throwIfAborted();
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;

    const fail = error => reject(signal?.aborted ? signal.reason : error);
    // A one-use agent connects directly even when the global agent uses an environment proxy.
    const req = request({ hostname: '127.0.0.1', port, path: '/', method: 'POST', agent: false, headers, signal }, async res => {
      try {
        res.setEncoding('utf8');
        let text = '';
        for await (const chunk of res) text += chunk;
        resolve({ status: res.statusCode, text });
      } catch (error) { fail(error); }
    });
    req.on('error', fail);
    req.end(payload);
  });
}
