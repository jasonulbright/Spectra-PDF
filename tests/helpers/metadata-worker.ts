import { build } from 'vite';
import { Worker as NodeWorker } from 'node:worker_threads';
import { resolve } from 'node:path';

let bundled: string | undefined;
export async function prepareMetadataWorker() {
  if (bundled) return;
  const built = await build({ configFile: false, logLevel: 'error', build: {
    write: false, emptyOutDir: false, minify: false,
    lib: { entry: resolve('src/renderer/lib/metadata.worker.ts'), formats: ['iife'], name: 'MetadataTestEntry' },
  } });
  const result = Array.isArray(built) ? built[0] : built;
  if (!('output' in result)) throw new Error('metadata worker test requires a complete build');
  const chunk = result.output.find(item => item.type === 'chunk' && item.isEntry);
  if (!chunk || chunk.type !== 'chunk') throw new Error('missing metadata worker entry');
  bundled = chunk.code;
}
/** Run the ACTUAL browser worker entry and its dependencies in an isolated
 * Node worker for unit tests. The bridge executes trusted build output only;
 * document bytes travel exclusively through postMessage. Live tests exercise
 * the browser's worker constructor/origin separately. No filesystem output. */
export class MetadataTestWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly worker: NodeWorker;
  constructor() {
    if (!bundled) throw new Error('call prepareMetadataWorker before using the test bridge');
    this.worker = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.self = { postMessage: data => parentPort.postMessage(data) };
      ${bundled}
      parentPort.on('message', data => self.onmessage({ data }));
    `, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => { console.error('Metadata test worker failed:', error); this.onerror?.(error); });
    this.worker.on('messageerror', error => this.onmessageerror?.(error));
  }
  postMessage(data: unknown) { this.worker.postMessage(data); }
  terminate() { void this.worker.terminate(); }
}
