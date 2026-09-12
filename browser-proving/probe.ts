/**
 * Does the zkir prover actually load in a BROWSER?
 *
 * M-77 answered "can we prove client-side" by proving in a Node process. That
 * is not the same question. A browser tab has a different module loader, a
 * 4 GB address-space ceiling on wasm32, no filesystem, and cross-origin
 * isolation rules that decide whether threads are even possible. The product is
 * web first, so the claim that matters is the browser one, and it had never
 * been executed.
 *
 * This deliberately stops short of producing a proof: a real proof needs a
 * serialised preimage, and a preimage only exists once a transaction has been
 * built against a live contract. What it does check is everything up to that
 * point, which is where the browser-specific failures live — module load,
 * threading, artefact parsing, and whether ~11 MB of structured reference
 * string plus the proving key can be held at once without the tab dying.
 */
const out = document.getElementById('out')!;
const lines: string[] = [];
const say = (s: string) => { lines.push(s); out.textContent = lines.join('\n'); };
const mb = (n: number) => (n / 1024 / 1024).toFixed(2) + ' MB';

const result: Record<string, unknown> = {};

/*
 * THE CIRCUIT NAME IS `amendSigner`, AND IT WAS `addSigner` UNTIL 12 Sep.
 *
 * The rename happened in the contract and reached fourteen shipping files; this
 * probe was not one of them, because nothing here had ever been run. Written
 * 27 Aug, first run 12 Sep, and it asked for an artefact that had not existed
 * for weeks - which arrived as a 404 body fed to the IR deserializer and read
 * as `expected header tag 'midnight:ir-source[v2]:'`.
 *
 * SO THE NAME BELOW IS NOT INCIDENTAL: it is the one circuit this probe proves,
 * and if the contract renames it again this file goes silent in exactly the
 * same way. What would stop that is asking the artefact directory what is in it
 * rather than naming a file.
 */
async function main() {
  say('user agent: ' + navigator.userAgent);

  /*
   * The threading question, asked of the RUNTIME rather than of the binary.
   *
   * `crossOriginIsolated` is what decides whether SharedArrayBuffer exists, and
   * therefore whether a threaded WASM build could run even if the Foundation
   * shipped one. We serve the app ourselves, so the headers are ours — this
   * confirms they took effect rather than assuming they did.
   */
  result.crossOriginIsolated = (globalThis as any).crossOriginIsolated === true;
  result.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  say(`crossOriginIsolated: ${result.crossOriginIsolated}`);
  say(`SharedArrayBuffer:   ${result.sharedArrayBuffer}`);

  const t0 = performance.now();
  const zkir: any = await import('@midnight-ntwrk/zkir-v2');
  result.moduleLoadMs = Math.round(performance.now() - t0);
  say(`zkir module loaded in ${result.moduleLoadMs}ms`);
  result.exports = Object.keys(zkir).filter((k) => typeof (zkir as any)[k] !== 'undefined');
  say('exports: ' + (result.exports as string[]).join(', '));

  // The compiled circuit, parsed by the prover itself. This is the first thing
  // that would fail if the browser build and the artefacts disagreed.
  const irBytes = new Uint8Array(await (await fetch('/artefacts/zkir/amendSigner.bzkir')).arrayBuffer());
  say(`IR fetched: ${mb(irBytes.length)}`);
  const t1 = performance.now();
  const ir = zkir.Zkir.deserialize(irBytes);
  const k = ir.getK();
  result.k = k;
  result.irParseMs = Math.round(performance.now() - t1);
  say(`IR deserialised in ${result.irParseMs}ms — k = ${k}, so the circuit is 2^${k} rows`);

  const proverKey = new Uint8Array(await (await fetch('/artefacts/keys/amendSigner.prover')).arrayBuffer());
  const verifierKey = new Uint8Array(await (await fetch('/artefacts/keys/amendSigner.verifier')).arrayBuffer());
  say(`prover key: ${mb(proverKey.length)}   verifier key: ${mb(verifierKey.length)}`);

  /*
   * The structured reference string. 6.3 MB at k=15, and the single largest
   * thing a first-time visitor has to download before they can approve
   * anything. Holding it and the proving key at the same time is the memory
   * question this probe exists to answer.
   */
  const t2 = performance.now();
  const params = new Uint8Array(await (await fetch(`/artefacts/params/bls_midnight_2p${k}`)).arrayBuffer());
  result.paramsFetchMs = Math.round(performance.now() - t2);
  result.paramsBytes = params.length;
  say(`SRS for k=${k}: ${mb(params.length)} in ${result.paramsFetchMs}ms`);

  const km = {
    lookupKey: async () => ({ proverKey, verifierKey, ir: irBytes }),
    getParams: async () => params,
  };
  const provider = zkir.provingProvider(km);
  result.provingProviderBuilt = typeof provider?.prove === 'function';
  say(`provingProvider built: ${result.provingProviderBuilt}`);

  const total = irBytes.length + proverKey.length + verifierKey.length + params.length;
  result.totalArtefactBytes = total;
  say(`total held at once: ${mb(total)}`);

  const memory = (performance as any).memory;
  if (memory) {
    result.jsHeapMB = +(memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
    say(`JS heap in use: ${result.jsHeapMB} MB`);
  }

  /*
   * The one thing that can be asked of `prove` without a real transaction:
   * that it rejects nonsense rather than crashing the tab. A prover that takes
   * a page down on bad input is a prover that cannot be driven from a Worker
   * with any confidence.
   */
  try {
    await provider.prove(new Uint8Array([0, 1, 2, 3]), 'contract:probe/amendSigner?vk=0');
    result.rejectsGarbage = 'no — it accepted a four-byte preimage, which is worse news than an error';
  } catch (e: any) {
    result.rejectsGarbage = 'yes';
    result.garbageError = String(e?.message ?? e).slice(0, 200);
  }
  say(`rejects a nonsense preimage: ${result.rejectsGarbage}`);

  result.ok = true;
}

main().then(
  () => { (window as any).__RESULT__ = result; say('\nDONE'); },
  (e) => {
    result.ok = false;
    result.error = String(e?.stack ?? e?.message ?? e);
    (window as any).__RESULT__ = result;
    say('\nFAILED: ' + result.error);
  },
);
