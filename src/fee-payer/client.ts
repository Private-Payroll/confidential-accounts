/**
 * THE WEB PROCESS'S SIDE OF THE FEE PAYER: A CLIENT, NOT A WALLET.
 *
 * It satisfies the same seam an in-process fee payer does, so nothing above it
 * changes, and it holds nothing that can spend. What it can make the fee payer
 * do is what the service allows: add a capped fee to a transaction the company
 * balanced, submit what the service built, or let it go.
 *
 * -- WHERE IT COMES FROM --------------------------------------------------
 *
 * Two settings, both or neither: where the fee payer answers, and the secret it
 * expects. Neither has a default. **One without the other is refused at start**
 * rather than at the first payment, because a deployment configured to pay and
 * unable to is a misconfiguration somebody made on purpose and should hear
 * about at once.
 *
 * **THE SECRET NEVER CROSSES A NETWORK IN THE CLEAR.** Plain HTTP is accepted
 * only for this machine's own loopback.
 */
import type { FeeSponsor } from '../midnight/ledger.js';
import type { TxRef } from '../core/ledger.js';
import { NothingWasSent } from '../core/jobs.js';
import type { TransactionCodec } from './service.js';

/** Where the fee payer answers. */
export const FEE_PAYER_URL_SETTING = 'MIDNIGHT_FEE_PAYER_URL';
/** The secret the fee payer expects. */
export const FEE_PAYER_SECRET_SETTING = 'MIDNIGHT_FEE_PAYER_SECRET';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The fee payer's address as a URL, or a refusal.
 *
 * Pure. HTTPS anywhere; HTTP only on loopback.
 */
export function feePayerAddress(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${FEE_PAYER_URL_SETTING} is not an address, so no fee payer was wired. Set it to `
      + 'the address the fee payer answers on, for example an https address.';
  }
  if (url.username || url.password || url.search || url.hash) {
    return `${FEE_PAYER_URL_SETTING} carries credentials, a query or a fragment, so no fee payer `
      + `was wired. The secret belongs in ${FEE_PAYER_SECRET_SETTING} and nowhere else.`;
  }
  /* The three calls are resolved under this address, not beside its last segment. */
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  return `${FEE_PAYER_URL_SETTING} is not https and not this machine's own loopback, so no fee `
    + 'payer was wired: the secret would cross a network in the clear. Serve the fee payer '
    + 'behind https, or on loopback beside this process.';
}

const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromBase64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The fee payer, over the wire.
 *
 * **ONE OPERATION AT A TIME, AS EVERY FEE PAYER IN THIS SYSTEM IS.** The company
 * a payment is for is told to this object before the balance, exactly as it is
 * told to an in-process one, and the caller's queue is what keeps two
 * operations from sharing it.
 */
export class RemoteFeeSponsor implements FeeSponsor {
  private company: string | null = null;
  /** The booking each returned transaction belongs to, keyed by its bytes. */
  private readonly bookings = new Map<string, string>();
  /** Every transaction this client has handed over to be submitted, keyed the same way. */
  private readonly sent = new Set<string>();

  constructor(
    private readonly url: URL,
    private readonly secret: string,
    private readonly codec: TransactionCodec,
    private readonly fetchImpl: Fetch = (i, init) => fetch(i, init),
  ) {}

  payingFor(accountId: string): void {
    this.company = accountId;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(new URL(path, this.url).toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.secret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private static async said(res: Response): Promise<{ error?: string; nothingWasSent?: boolean } & Record<string, unknown>> {
    try {
      return await res.json() as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async addFeeAndFinalise(customerFinalised: unknown, ttl: Date): Promise<unknown> {
    if (this.company === null) {
      throw new NothingWasSent(
        'the fee payer was asked to pay without being told which company the transaction is '
        + 'for, and a fee is never paid without that record. Nothing was booked.');
    }
    const tx = toBase64(await this.codec.write(customerFinalised));
    let res: Response;
    try {
      res = await this.call('POST', 'fee', { company: this.company, tx, ttl: ttl.toISOString() });
    } catch (e) {
      /*
       * **A FEE REQUEST THAT DID NOT ARRIVE, OR WHOSE ANSWER DID NOT, SENT
       * NOTHING TO THE CHAIN** - the service never submits on this call. What
       * may be left is a booking the deadline releases.
       */
      throw new NothingWasSent(
        `the fee payer could not be reached, so no fee was added and nothing was sent: ${String((e as Error)?.message ?? e)}`);
    }
    const body = await RemoteFeeSponsor.said(res);
    if (!res.ok || typeof body.booking !== 'string' || typeof body.tx !== 'string') {
      throw new NothingWasSent(
        typeof body.error === 'string' ? body.error
          : `the fee payer answered ${res.status} and added no fee. Nothing was sent.`);
    }
    this.bookings.set(body.tx, body.booking);
    return this.codec.read(fromBase64(body.tx));
  }

  async submit(finalisedTransaction: unknown): Promise<TxRef> {
    const key = toBase64(await this.codec.write(finalisedTransaction));
    if (this.sent.has(key)) {
      /* Not "nothing was sent": the first attempt may have landed. */
      throw new Error(
        'this transaction was already handed to the fee payer to submit, and it was not sent '
        + 'again. It may have landed: check the chain before building it again.');
    }
    const booking = this.bookings.get(key);
    if (booking === undefined) {
      throw new NothingWasSent(
        'this transaction was not given its fee by this fee payer, so it was not sent. Nothing '
        + 'was submitted.');
    }
    this.bookings.delete(key);
    this.sent.add(key);
    /*
     * **FROM HERE A FAILURE IS AN UNKNOWN OUTCOME** unless the service says
     * otherwise: a request that left may have been submitted.
     */
    const res = await this.call('POST', 'submit', { booking });
    const body = await RemoteFeeSponsor.said(res);
    if (!res.ok || typeof body.ref !== 'string') {
      const why = typeof body.error === 'string' ? body.error
        : `the fee payer answered ${res.status} to a submission`;
      if (body.nothingWasSent === true) throw new NothingWasSent(why);
      throw new Error(why);
    }
    return { ref: body.ref, at: typeof body.at === 'string' ? body.at : new Date().toISOString() };
  }

  async release(booking: unknown): Promise<void> {
    const key = toBase64(await this.codec.write(booking));
    const id = this.bookings.get(key);
    /* Nothing this client was handed back, so nothing of ours is booked for it. */
    if (id === undefined) return;
    const res = await this.call('POST', 'release', { booking: id });
    const body = await RemoteFeeSponsor.said(res);
    if (!res.ok) {
      throw new Error(typeof body.error === 'string' ? body.error
        : `the fee payer answered ${res.status} to a release`);
    }
    this.bookings.delete(key);
  }

  async capacity(): Promise<{ dust: bigint; night: bigint }> {
    const res = await this.call('GET', 'capacity');
    const body = await RemoteFeeSponsor.said(res);
    if (!res.ok || typeof body.dust !== 'string' || typeof body.night !== 'string') {
      throw new Error(typeof body.error === 'string' ? body.error
        : `the fee payer answered ${res.status} when asked what it holds`);
    }
    return { dust: BigInt(body.dust), night: BigInt(body.night) };
  }
}

/**
 * The finalised transaction's wire form, read with the ledger's own markers.
 *
 * Loaded when first used, so a process that never pays never loads the ledger
 * for this.
 */
export const finalisedTransactionCodec = (): TransactionCodec => {
  let ledger: Promise<any> | null = null;
  const load = () => (ledger ??= import('@midnightntwrk/ledger-v9'));
  return {
    async read(bytes) {
      const l = await load();
      return l.Transaction.deserialize('signature', 'proof', 'binding', bytes);
    },
    async write(tx) {
      return (tx as { serialize(): Uint8Array }).serialize();
    },
  };
};

/**
 * The fee payer this deployment's settings name, or `null` when they name none.
 *
 * **BOTH SETTINGS OR NEITHER.** One without the other throws, naming both.
 */
export function feePayerFrom(
  env: Readonly<Record<string, string | undefined>>,
  codec: TransactionCodec = finalisedTransactionCodec(),
  fetchImpl?: Fetch,
): FeeSponsor | null {
  const raw = env[FEE_PAYER_URL_SETTING]?.trim() ?? '';
  const secret = env[FEE_PAYER_SECRET_SETTING] ?? '';
  if (raw === '' && secret === '') return null;
  if (raw === '' || secret === '') {
    throw new Error(
      `${raw === '' ? FEE_PAYER_SECRET_SETTING : FEE_PAYER_URL_SETTING} is set and `
      + `${raw === '' ? FEE_PAYER_URL_SETTING : FEE_PAYER_SECRET_SETTING} is not, so this `
      + 'deployment did not start: it was configured to pay fees and could not. Set both, or '
      + 'neither for a deployment that only reads.');
  }
  const address = feePayerAddress(raw);
  if (typeof address === 'string') throw new Error(address);
  return new RemoteFeeSponsor(address, secret, codec, fetchImpl);
}
