/**
 * DOES WebAuthn's PRF EXTENSION GIVE US A STABLE KEY? Measured, not assumed.
 *
 * The question A-3 hangs on: can a passkey WRAP the key bundle (it is a key),
 * or can it only GATE access to it (it is a door)? PRF — the WebAuthn surface
 * over CTAP2's hmac-secret — is the only mechanism that would let a passkey
 * produce key material at all.
 *
 * What this measures: whether the BROWSER implements it, whether the output is
 * stable across assertions, whether it is bound to the credential, and whether
 * it is bound to the salt. It uses a CDP virtual authenticator, so it does NOT
 * measure whether real platform authenticators (iCloud Keychain, Google
 * Password Manager, Windows Hello, a hardware key) support it. That is a
 * separate question and needs real hardware.
 */
import { chromium } from 'playwright';
import http from 'node:http';

const PORT = 8931;
const HTML = '<!doctype html><meta charset=utf-8><title>prf</title><body>ok</body>';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(HTML);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/`); // localhost is a secure context

const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');

const out = { browser: await browser.version() };

// Ask for a virtual authenticator that claims PRF. If the field is unknown to
// this build, the call errors — which is itself the answer.
let authenticatorId = null;
try {
  const r = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  authenticatorId = r.authenticatorId;
  out.virtualAuthenticator = 'created with hasPrf: true';
} catch (e) {
  out.virtualAuthenticator = 'hasPrf REFUSED: ' + String(e.message).split('\n')[0];
  const r = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  authenticatorId = r.authenticatorId;
}

const result = await page.evaluate(async () => {
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const saltA = new Uint8Array(32).fill(1);
  const saltB = new Uint8Array(32).fill(2);
  const report = {};

  const mkCred = async (name) => navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'prf probe', id: 'localhost' },
      user: { id: new TextEncoder().encode(name), name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
      extensions: { prf: {} },
    },
  });

  const cred1 = await mkCred('one');
  const cred2 = await mkCred('two');
  report.prfEnabledAtCreate = cred1.getClientExtensionResults()?.prf?.enabled ?? null;

  const assert = async (cred, salt) => {
    const a = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: 'localhost',
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    const r = a.getClientExtensionResults()?.prf?.results?.first;
    return r ? b64(r) : null;
  };

  report.cred1_saltA_run1 = await assert(cred1, saltA);
  report.cred1_saltA_run2 = await assert(cred1, saltA);
  report.cred1_saltB      = await assert(cred1, saltB);
  report.cred2_saltA      = await assert(cred2, saltA);
  return report;
});

Object.assign(out, result);
out.verdict = {
  supported: Boolean(result.cred1_saltA_run1),
  stableAcrossAssertions: result.cred1_saltA_run1 !== null
    && result.cred1_saltA_run1 === result.cred1_saltA_run2,
  boundToSalt: result.cred1_saltA_run1 !== result.cred1_saltB,
  boundToCredential: result.cred1_saltA_run1 !== result.cred2_saltA,
};
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.close();
