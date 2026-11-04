/**
 * **A FINISHED CALL HANDED TO THE SERVICE THE COMPANY HOSTS ITSELF**, which submits it to the chain. What it is
 * handed is the call with its fee already paid - by our fee sponsorship, or by the person's own DUST when
 * sponsorship cannot pay - finished and ready for the network: the very transaction the network is handed on the
 * chain path, so that service learns nothing the network does not, and pays nothing. The company's records still
 * go where they always go.
 *
 * The call was read and held to the one call the step makes before its fee was paid (`sentFromTheOwnWallet`), so
 * nothing else rides along to that address; and a redirect from that address is an error, so the call is never
 * sent on to an address the company did not choose.
 */
import { NotHandedOver, ServiceNotReached } from '../../../../packages/web-shared/src/hand-over.js';
import { serviceAddressRefusal } from '../../../../src/midnight/company-service-record.js';

/** Where on the company's own service a finished call is handed. */
export const COMPANY_SERVICE_ROUTE = '/relay';

const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');

/**
 * Hands one finished call, written out as base64, to the company's own service at `at`. An address the company's
 * choice could not have named is refused before anything leaves this device, carrying `nothingWasSent`; once the
 * request may have left, a failure is never said as not sent. A service that answered, in any way, is the answer
 * and the call is never sent again; one that gave no answer at all is `ServiceNotReached`, which may have taken the
 * call, so the wallet reads the chain for it before it sends that same call to the network itself.
 */
export const toTheCompanysService = (
  at: string, send: typeof fetch = (...a) => fetch(...a),
) => async (finished: string): Promise<void> => {
  const bad = serviceAddressRefusal(at);
  if (bad !== null) throw new NotHandedOver(`${bad}. Nothing was sent.`);
  let answered: Response;
  try {
    answered = await send(`${at}${COMPANY_SERVICE_ROUTE}`, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: finished }),
    });
  } catch (e) {
    throw new ServiceNotReached(`the company's own service at ${at} did not answer (${said(e)}); the call may have reached it`, false);
  }
  if (!answered.ok) {
    throw new Error(`the company's own service at ${at} answered ${answered.status}; the call may have reached it. `
      + 'Do not send it again: open it later, and it will say where it stands on the chain.');
  }
};
