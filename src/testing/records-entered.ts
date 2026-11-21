/**
 * **THE ONE FILING CALL AS A TEST WATCHES IT**: every filing entered, in the
 * order it was entered, kept here and sent nowhere. For tests that mount no
 * manifest route; a test that does enters through the company's own source
 * over its call (`recordsEnteredFor` over `manifestServiceOf(serviceSource(...))`).
 */
import type { Filed, RecordsEntered } from 'vaults-web-shared/record-entered-here.js';

export const enteredHere = (): RecordsEntered & { readonly filed: Filed[][] } => {
  const filed: Filed[][] = [];
  return { filed, enter: async (f) => { filed.push([...f]); } };
};
