/**
 * THE TWO THINGS PROBE 1 DID NOT ANSWER.
 *
 * 1. HOW DOES IT FAIL when the authenticator has no PRF? Loudly, or by silently
 *    returning nothing? This decides whether our code can detect the fallback,
 *    and a mechanism whose failure mode is to look like success is `C16`.
 * 2. Does PRF return key material at CREATE, or only on a subsequent GET? That
 *    decides whether enrolment is one ceremony or two.
 */
import { chromium } from 'playwright';
import http from 'node:http';

const PORT = 8932;
const server = http.createServer((_q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end('<!doctype html><meta charset=utf-8><body>ok</body>');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function probe(hasPrf) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, hasPrf,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  const r = await page.evaluate(async () => {
    const b64 = (b) => b ? btoa(String.fromCharCode(...new Uint8Array(b))) : null;
    const salt = new Uint8Array(32).fill(7);
    const rep = {};
    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'prf probe', id: 'localhost' },
          user: { id: new TextEncoder().encode('u'), name: 'u', displayName: 'u' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
          // Ask for the value at CREATE as well, which is the newer shape.
          extensions: { prf: { eval: { first: salt } } },
        },
      });
    } catch (e) {
      rep.createThrew = String(e.name) + ': ' + String(e.message).slice(0, 120);
      return rep;
    }
    const ext = cred.getClientExtensionResults();
    rep.createExtensions = JSON.stringify(ext, (_k, v) =>
      v instanceof ArrayBuffer ? '<' + v.byteLength + ' bytes>' : v);
    rep.prfEnabled = ext?.prf?.enabled ?? null;
    rep.prfResultAtCreate = b64(ext?.prf?.results?.first);

    try {
      const a = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: 'localhost',
          allowCredentials: [{ type: 'public-key', id: cred.rawId }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: salt } } },
        },
      });
      const ae = a.getClientExtensionResults();
      rep.assertExtensions = JSON.stringify(ae, (_k, v) =>
        v instanceof ArrayBuffer ? '<' + v.byteLength + ' bytes>' : v);
      rep.prfResultAtAssert = b64(ae?.prf?.results?.first);
      rep.assertSucceededAnyway = true;
    } catch (e) {
      rep.assertThrew = String(e.name) + ': ' + String(e.message).slice(0, 120);
    }
    return rep;
  });
  await context.close();
  return r;
}

console.log(JSON.stringify({
  'authenticator WITH prf': await probe(true),
  'authenticator WITHOUT prf': await probe(false),
}, null, 2));

await browser.close();
server.close();
