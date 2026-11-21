/*
 * THE COMPANY'S SERVICE IN MEMORY, AS AN ADAPTER'S TEST ANSWERS IT. A test answers the service's read of one record,
 * one vault record and one hand-over at a time (its stand-in for the page's requests, `api`); `withTheView` makes of
 * that the service the page's one transport (`serviceCall`) reaches too, which answers each read of many at once the
 * company's view sends from those single reads, one for each asked and in the order asked. A company the test files no
 * directory for holds an empty one; nothing is entered in any company's records, so the newest version entered of
 * every record is 0. It imports none of the page's code, so a test's stand-in for the page's
 * transport can be made of it.
 */
import type { ServiceCall } from 'vaults-web-shared/records-source.js';

type Answer = (path: string, init?: RequestInit) => Promise<unknown>;
type Asked = { readonly kind?: string; readonly id?: string; readonly vault?: string; readonly record?: string; readonly every?: boolean };

const READ_OF_MANY = /^\/api\/accounts\/([^/]+)\/(records\/read|vault-records\/read|handovers|manifest\/newest|directory)$/u;

/** Each read of many, answered from the single reads the test answers, one for each asked and in the order asked. */
const readOfMany = async (answer: Answer, company: string, route: string, init?: RequestInit): Promise<unknown> => {
  const at = (rest: string): string => `/api/accounts/${company}${rest}`;
  const body = JSON.parse(String(init?.body ?? '{}')) as { records?: Asked[]; people?: string[]; vendors?: string[] };
  const each = <T>(items: readonly T[], path: (item: T) => string) => Promise.all(items.map((item) => answer(path(item))));
  switch (route) {
    case 'records/read':
      return { records: await each(body.records ?? [], (r) => at(`/records/${r.kind}/${encodeURIComponent(r.id ?? '')}${r.every === true ? '/versions' : ''}`)) };
    case 'vault-records/read':
      return { records: await each(body.records ?? [], (r) => `/api/vaults/${r.vault}/records/${r.record}${r.every === true ? '/versions' : ''}`) };
    case 'handovers':
      return { handovers: body.vendors !== undefined
        ? await each(body.vendors, (v) => at(`/vendors/${encodeURIComponent(v)}/handover`))
        : await each(body.people ?? [], (p) => `/api/employees/${encodeURIComponent(p)}/handover`) };
    case 'manifest/newest':
      return { versions: (body.records ?? []).map(() => 0) };
    default:
      return answer(at('/directory'), init).catch(() => ({ filings: [] }));
  }
};

/** The service the page's one transport reaches in a test whose stand-in for the page's requests is `answer`. */
export const answeringTheView = (answer: Answer): { readonly api: Answer; readonly serviceCall: ServiceCall } => ({
  api: answer,
  serviceCall: (path, init) => {
    const many = READ_OF_MANY.exec(path.split('?')[0]!);
    return many === null ? answer(path, init) : readOfMany(answer, decodeURIComponent(many[1]!), many[2]!, init);
  },
});

/** A test's stand-in for the page's transport, `transport`, with the page's one transport (`serviceCall`) answered over its `api`. */
export const withTheView = <T extends { readonly api: Answer }>(transport: T): T & { readonly serviceCall: ServiceCall } =>
  ({ ...transport, ...answeringTheView(transport.api) });
