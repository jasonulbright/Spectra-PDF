import { processMetadata } from './metadata-process';
import type { MetadataRequest } from './metadata-process';

self.onmessage = async (event: MessageEvent<MetadataRequest>) => {
  try {
    const result = await processMetadata(event.data);
    self.postMessage({ ok: true, result });
  } catch {
    // Never send source XML, paths or parser exception text back to the UI.
    self.postMessage({ ok: false });
  }
};
