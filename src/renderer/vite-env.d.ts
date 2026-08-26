/// <reference types="vite/client" />

// `pdfjs-dist` ships no types for its scripting sandbox entry point. The shape
// the worker uses is declared where it is used (`lib/field-js.worker.ts`); this
// only tells the compiler the module resolves.
declare module 'pdfjs-dist/build/pdf.sandbox.mjs' {
  export function QuickJSSandbox(wasmUrl?: string): Promise<unknown>;
}
