import { webcrypto } from "node:crypto";
import { performance as nodePerformance } from "node:perf_hooks";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import { URL as NodeURL, URLSearchParams as NodeURLSearchParams } from "node:url";
import { Blob as NodeBlob, Buffer as NodeBuffer, atob as nodeAtob, btoa as nodeBtoa } from "node:buffer";
import { MessageChannel as NodeMessageChannel, MessagePort as NodeMessagePort } from "node:worker_threads";

// Ableton Live's embedded Node host runs without the web-platform globals that a
// normal Node bootstrap installs onto globalThis (URL, TextEncoder, performance,
// crypto, …). Code that assumes a standard Node runtime — the shared analysis
// code's `performance.now()`, the frame protocols' `TextEncoder`/`TextDecoder` —
// otherwise throws `ReferenceError: X is not defined`, surfacing as a 500 from
// the localhost RPC handler. Rather than discover each one via a failed request,
// restore the whole set up front from their canonical node: builtin modules,
// which remain reachable even when the global wasn't installed. Importing this
// module first in the host entry installs them before any request is served.
//
// Object.defineProperty (rather than `globalThis.x = …`) lets us install by name
// without an indexable cast of globalThis and without colliding with read-only
// global typings.
function installGlobal(name: string, value: unknown): void {
  if (name in globalThis) return;
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

const globals: ReadonlyArray<readonly [string, unknown]> = [
  ["performance", nodePerformance],
  ["TextEncoder", NodeTextEncoder],
  ["TextDecoder", NodeTextDecoder],
  ["URL", NodeURL],
  ["URLSearchParams", NodeURLSearchParams],
  ["Blob", NodeBlob],
  ["Buffer", NodeBuffer],
  ["atob", nodeAtob],
  ["btoa", nodeBtoa],
  ["crypto", webcrypto],
  ["MessageChannel", NodeMessageChannel],
  ["MessagePort", NodeMessagePort],
];

for (const [name, value] of globals) {
  installGlobal(name, value);
}
