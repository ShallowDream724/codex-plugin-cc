import { EventEmitter } from 'node:events';
import { serve } from '../../runtime/bridge.mjs';

class FixtureClient extends EventEmitter {
  ready = false;
  async start() { this.ready = true; }
  async close() { this.ready = false; this.emit('closed'); }
}
class FixtureController extends EventEmitter {
  agents = new Map();
  closed = false;
  async init() {}
  async close() { this.closed = true; }
}
await serve('fixture', { directory: process.argv[2],
  clientFactory: () => new FixtureClient(), controllerFactory: () => new FixtureController() });
