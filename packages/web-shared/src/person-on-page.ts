/**
 * **THE PERSON'S OWN ASKS, BOUND TO THE PAGE'S ONE TRANSPORT.** Each ask and its path is named in `person-asks.ts`;
 * this file only binds them to the page, and loads none of the company's records' code.
 */
import { personAsks, type PersonAsks } from './person-asks.js';
import { serviceAnswered, serviceCall, type PageSend } from './service-transport.js';

/** The person's own asks, each answered as the page's `api` answers: a refusal thrown, the sign-in told when it ended. */
export const personOnPage: PersonAsks<unknown> = personAsks(serviceCall);

/** The person's own asks for a tab that reads each answer's status itself, saying it was prepared for `signedInAs`. */
export const personAnsweredOnPage = (signedInAs: () => string | null): PersonAsks<Awaited<ReturnType<PageSend>>> => {
  const send = serviceAnswered(signedInAs);
  return personAsks((path, init) => send(path, {
    method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: init.body }), ...(init?.signal === undefined ? {} : { signal: init.signal }),
  }));
};
