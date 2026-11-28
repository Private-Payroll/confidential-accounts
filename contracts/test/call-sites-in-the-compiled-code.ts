/**
 * Each place a compiled circuit calls a derivation, read from the contract's own JavaScript: the method it sits in and
 * the arguments it passes, in order. An argument that reads the contract's own address off the circuit's context is
 * written `self`; any other ledger read is written as such; a local's compiled suffix is dropped. A derivation keyed
 * on the contract's address at a call site is frozen by its arguments' order there, which no pure circuit shows.
 */
import { listAt, methodsOf } from './writes-in-the-compiled-code.js';

const SELF =
  /^_descriptor_\d+\.fromValue\(__compactRuntime\.queryLedgerState\(context,[\s\S]*toValue\(0n\)[\s\S]*\)\.value\)\.bytes$/u;

/** The arguments of one call, split at their own commas. */
function argumentsOf(call: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 1;
  for (let i = 1; i < call.length - 1; i += 1) {
    const c = call[i]!;
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(call.slice(from, i));
      from = i + 1;
    }
  }
  out.push(call.slice(from, call.length - 1));
  return out.map((a) => a.trim()).filter((a) => a !== '');
}

/** One argument as the record writes it. */
function argumentNamed(text: string): string {
  if (SELF.test(text)) return 'self';
  if (text.includes('queryLedgerState(')) return 'a ledger read';
  return text.replace(/\s+/gu, '').replace(/_\d+\b/gu, '');
}

/** Every call of the compiled `_<derivation>_0` inside a circuit's method, in the order the code holds them. */
export function callSitesOf(js: string, derivation: string): { in: string; args: string[] }[] {
  const callee = `this._${derivation}_0(`;
  const out: { in: string; args: string[] }[] = [];
  for (const [method, body] of methodsOf(js)) {
    for (let at = body.indexOf(callee); at >= 0; at = body.indexOf(callee, at + 1)) {
      out.push({
        in: method.replace(/^_|_\d+$/gu, ''),
        args: argumentsOf(listAt(body, at + callee.length - 1)).map(argumentNamed)
      });
    }
  }
  return out;
}
