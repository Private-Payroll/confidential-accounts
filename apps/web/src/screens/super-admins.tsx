import { useCallback, useEffect, useId, useState } from 'react';
import {
  Alert, AlertDescription, Button, CopyText, Field, FieldContent, FieldDescription, FieldLabel, PageHeader, Section, SectionRow, Textarea, useText,
} from 'vaults-ui';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { CommitteeChange } from '../actions/committee-change.js';
import { CountInput } from '../fields/form-fields.js';
import { ActRefused } from '../act-refused.js';
import { ACTED } from '../adapters/refusals.js';
import type { SuperAdminReach } from '../adapters/super-admin-doors.js';
import { READ } from '../adapters/reads.js';
import {
  approveChange, committeeAfter, countTyped, joinChange, notYetAdopted, raiseChange, reachOfTheCompany, readSuperAdmins, SUPER_ADMIN_WARNING, SUPER_ADMIN_WHY,
  type ChangeShown, type SuperAdminActed, type SuperAdminsRead, type SuperAdminWarning, type SuperAdminWhy,
} from '../adapters/super-admins.js';
import { PAGE } from '../pages.js';
import { addressOf, useCurrentPage } from '../router.js';
import { useSession } from '../session.js';

type Words = ReturnType<typeof useText>;
type Key = { readonly tag: string; readonly value: string };
type Act = (reach: SuperAdminReach) => Promise<SuperAdminActed>;
/** What the page shows before the chain is read, and before the company is named; compared by the code, never shown. */
const NOT_YET = { reading: 'reading', unnamed: 'unnamed' } as const;
type Read = SuperAdminsRead | { readonly of: typeof NOT_YET.reading };

/** A key as the page names it: its start and its end, which tell the keys of one company apart. */
const short = (t: Words, k: Key): string => t('superAdmins.key.short', { start: k.value.slice(0, 12), end: k.value.slice(-8) });
const KEY_TEXT = /^[0-9a-f]{64}$/u;

const WHY_SAYS = (t: Words): Record<SuperAdminWhy, string> => ({
  [SUPER_ADMIN_WHY.raiserLeaves]: t('superAdmins.why.raiser-leaves'), [SUPER_ADMIN_WHY.notASuperAdmin]: t('superAdmins.why.not-a-super-admin'),
  [SUPER_ADMIN_WHY.joinsMissing]: t('superAdmins.why.joins-missing'), [SUPER_ADMIN_WHY.noChange]: t('superAdmins.why.no-change'),
  [SUPER_ADMIN_WHY.notInstallable]: t('superAdmins.why.not-installable'), [SUPER_ADMIN_WHY.sameAsNow]: t('superAdmins.why.same-as-now'),
});
const WARNING_SAYS = (t: Words): Record<SuperAdminWarning, string> => ({
  [SUPER_ADMIN_WARNING.oneLeft]: t('superAdmins.warning.one-left'), [SUPER_ADMIN_WARNING.everyNeeded]: t('superAdmins.warning.every-needed'),
});

function Acted({ acted }: { acted: SuperAdminActed | null }) {
  const t = useText();
  if (acted === null) return null;
  if (acted.of === ACTED.done && acted.sent) return <p className="text-sm" data-acted="sent">{t('superAdmins.done.sent')}</p>;
  if (acted.of === ACTED.done && acted.held !== null) return <p className="text-sm" data-acted="held">{t('superAdmins.done.held', { held: acted.held })}</p>;
  if (acted.of === ACTED.done) return <p className="text-sm" data-acted="kept">{t('superAdmins.done.kept')}</p>;
  if (acted.why !== undefined) return <Alert data-super-admins-refused={acted.why}><AlertDescription>{WHY_SAYS(t)[acted.why]}</AlertDescription></Alert>;
  return <ActRefused why={acted.act} />;
}

function Warning({ warning }: { warning: SuperAdminWarning | null }) {
  const t = useText();
  return warning === null ? null : <Alert data-super-admins-warning={warning}><AlertDescription>{WARNING_SAYS(t)[warning]}</AlertDescription></Alert>;
}

/** The change kept for the account now: what it installs, which joining keys have signed, and the press this key may make. */
function KeptChange({ change, iAmOne, busy, run }: { change: ChangeShown; iAmOne: boolean; busy: boolean; run: (act: Act) => void }) {
  const t = useText();
  const mineToSign = change.joining.some((j) => j.mine && !j.signed);
  const waiting = change.joining.some((j) => !j.signed);
  return (
    <div className="flex flex-col gap-3" data-kept-change={change.chainId}>
      <Section title={t('superAdmins.change.title')} description={t('superAdmins.change.after', { count: change.committee.length, threshold: change.threshold })} empty={null}>
        <SectionRow>
          <span className="text-sm" data-raised-by>{change.raisedByMine ? t('superAdmins.change.raised-by-you') : t('superAdmins.change.raised-by', { key: short(t, change.raisedBy) })}</span>
        </SectionRow>
        {change.committee.map((k) => <SectionRow key={k.value}><span className="font-mono text-sm">{short(t, k)}</span></SectionRow>)}
        {change.joining.map((j) => (
          <SectionRow key={j.key.value}>
            <span className="text-sm" data-joining={j.signed ? 'signed' : 'waiting'}>{j.signed ? t('superAdmins.change.joined', { key: short(t, j.key) }) : t('superAdmins.change.join-waits', { key: short(t, j.key) })}</span>
          </SectionRow>
        ))}
      </Section>
      <Warning warning={change.warning} />
      <div className="flex flex-wrap gap-3">
        {mineToSign ? <Button variant="outline" disabled={busy} onClick={() => run((reach) => joinChange(reach, change.chainId))} data-action="join">{t('superAdmins.join')}</Button> : null}
        {iAmOne ? <Button variant="outline" disabled={busy || waiting} onClick={() => run((reach) => approveChange(reach, change))} data-action="approve">{t('superAdmins.approve')}</Button> : null}
      </div>
      {iAmOne && waiting ? <p className="text-sm text-muted-foreground" data-joins-waiting>{t('superAdmins.why.joins-missing')}</p> : null}
    </div>
  );
}

/** Raise a change: which keys stay, which keys join, and how many must sign. Shown only to a key on the committee now. */
function RaiseForm({ now, busy, run }: { now: { committee: readonly Key[]; threshold: number }; busy: boolean; run: (act: Act) => void }) {
  const t = useText();
  const [kept, setKept] = useState<readonly string[]>(now.committee.map((k) => k.value));
  const [added, setAdded] = useState('');
  const [threshold, setThreshold] = useState<string | number>(now.threshold);
  const ids = { add: useId(), threshold: useId() };
  const adding = added.split(/\s+/u).map((v) => v.trim().toLowerCase()).filter((v) => v !== '');
  const unreadable = adding.filter((v) => !KEY_TEXT.test(v));
  const chosen = countTyped(threshold);
  const raise = (): void => {
    if (chosen === null) return;
    run((reach) => raiseChange(reach, { committee: committeeAfter(now.committee, kept, adding), threshold: chosen }, now));
  };
  return (
    <Section title={t('superAdmins.raise.title')} description={t('superAdmins.raise.what')} list={false} data-raise>
      {now.committee.map((k) => (
        <label key={k.value} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={kept.includes(k.value)} data-keep={k.value}
            onChange={(e) => setKept(e.target.checked ? [...kept, k.value] : kept.filter((v) => v !== k.value))} />
          <span className="font-mono">{short(t, k)}</span>
        </label>
      ))}
      <Field>
        <FieldLabel htmlFor={ids.add}>{t('superAdmins.raise.add')}</FieldLabel>
        <FieldContent>
          <Textarea id={ids.add} value={added} onChange={(e) => setAdded(e.target.value)} data-add-keys />
          <FieldDescription>{unreadable.length > 0 ? t('superAdmins.raise.unreadable') : t('superAdmins.raise.add.hint')}</FieldDescription>
        </FieldContent>
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.threshold}>{t('superAdmins.raise.threshold')}</FieldLabel>
        <FieldContent><CountInput id={ids.threshold} value={threshold} onChange={setThreshold} data-threshold /></FieldContent>
      </Field>
      <p className="text-sm" data-every-key-lost>{t('superAdmins.lastKey')}</p>
      <p className="text-sm" data-any-one-can>{t('superAdmins.raise.anyOne')}</p>
      <div><Button disabled={busy || unreadable.length > 0 || chosen === null} onClick={raise} data-action="raise">{t('superAdmins.raise.press')}</Button></div>
    </Section>
  );
}

/**
 * The vaults the company created that its account does not list yet, left out of every change until it does: named to a
 * signer from the company's own list; a super admin with no seat cannot read that list, and is told so.
 */
function NotYetAdopted({ accountId, contracts, member }: { accountId: string; contracts: readonly string[]; member: boolean }) {
  const t = useText();
  const [vaults, setVaults] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!member) return undefined;
    let alive = true;
    void notYetAdopted(accountId, contracts).then((v) => { if (alive) setVaults(v); }, () => { if (alive) setVaults([]); });
    return () => { alive = false; };
  }, [accountId, contracts, member]);
  if (!member) return <p className="text-sm text-muted-foreground" data-not-adopted-unseen>{t('superAdmins.notAdopted.unseen')}</p>;
  if (vaults.length === 0) return null;
  return (
    <Section title={t('superAdmins.notAdopted.title')} description={t('superAdmins.notAdopted.what')} empty={null} data-not-adopted>
      {vaults.map((v) => <SectionRow key={v}><span className="font-mono text-sm break-all">{v}</span></SectionRow>)}
    </Section>
  );
}

/** Who holds the company, read from the chain, with the person's own key and the change in progress. */
function SuperAdminsOf({ from, member }: { from: SuperAdminReach; member: boolean }) {
  const t = useText();
  const [reach, setReach] = useState(from);
  const [read, setRead] = useState<Read>({ of: NOT_YET.reading });
  const [busy, setBusy] = useState(false);
  const [acted, setActed] = useState<SuperAdminActed | null>(null);
  const again = useCallback(async () => { setRead(await readSuperAdmins(reach)); }, [reach]);
  useEffect(() => { void again(); }, [again]);
  const run = (act: Act): void => {
    if (busy) return;
    setBusy(true); setActed(null);
    void act(reach).then(async (r) => { setActed(r); await again(); }).finally(() => setBusy(false));
  };
  if (read.of === NOT_YET.reading) return <p className="text-sm" data-super-admins="reading">{t('superAdmins.reading')}</p>;
  if (read.of !== READ.read) return <ActRefused why={read.act} />;
  return (
    <div className="flex flex-col gap-6" data-super-admins="read">
      <Section title={t('superAdmins.held.title')} description={t('superAdmins.held.count', { count: read.committee.length, threshold: read.threshold })} empty={null} data-held>
        {read.committee.map((k) => (
          <SectionRow key={k.key.value}><span className="font-mono text-sm" data-key-mine={k.mine ? 'yes' : undefined}>{k.mine ? t('superAdmins.held.mine', { key: short(t, k.key) }) : short(t, k.key)}</span></SectionRow>
        ))}
      </Section>
      <Warning warning={read.warning} />
      {read.mine === null ? (
        <div><Button variant="outline" onClick={() => setReach({ ...reach, asSuperAdmin: true })} data-action="use-my-key">{t('superAdmins.mine.use')}</Button></div>
      ) : (
        <Section title={t('superAdmins.mine.title')} description={read.iAmOne ? t('superAdmins.mine.one') : t('superAdmins.mine.not-one')} list={false} data-my-key>
          <CopyText text={read.mine.value} label={t('superAdmins.mine.copy')} copied={t('invite.link.copied')} refused={t('superAdmins.mine.refused')} />
        </Section>
      )}
      {read.changes.map((c) => <KeptChange key={c.chainId} change={c} iAmOne={read.iAmOne} busy={busy} run={run} />)}
      <NotYetAdopted accountId={reach.company.accountId} contracts={read.contracts} member={member} />
      {read.iAmOne ? <RaiseForm now={{ committee: read.committee.map((k) => k.key), threshold: read.threshold }} busy={busy} run={run} /> : null}
      <Acted acted={acted} />
    </div>
  );
}

/**
 * SETTINGS > SUPER ADMINS: who holds the company's account and every vault, as the chain shows it; a change of them,
 * raised, joined and approved here; the link a super admin with no seat opens; and bringing a vault left behind
 * under the super admins who hold the account now.
 */
export function SuperAdmins() {
  const t = useText();
  const { company } = useSession();
  const [reach, setReach] = useState<SuperAdminReach | null | typeof NOT_YET.unnamed>(null);
  useEffect(() => {
    if (company === null) return undefined;
    let alive = true;
    void reachOfTheCompany(company).then((r) => { if (alive) setReach(r ?? NOT_YET.unnamed); }, () => { if (alive) setReach(NOT_YET.unnamed); });
    return () => { alive = false; };
  }, [company]);
  return (
    <div className="flex flex-col gap-6" data-screen="super-admins">
      <p className="text-sm text-muted-foreground">{t('superAdmins.intro')}</p>
      {reach === NOT_YET.unnamed ? <p className="text-sm" data-super-admins="unnamed">{t('superAdmins.unnamed')}</p> : null}
      {reach !== null && reach !== NOT_YET.unnamed ? (
        <>
          <SuperAdminsOf from={reach} member />
          <Section title={t('superAdmins.link.title')} description={t('superAdmins.link.what')} list={false} data-super-admin-link>
            <CopyText text={window.location.origin + addressOf(PAGE.superAdminsByLink, { id: reach.company.accountId, label: reach.company.label, account: reach.company.account })}
              label={t('superAdmins.link.copy')} copied={t('invite.link.copied')} refused={t('invite.link.refused')} />
          </Section>
        </>
      ) : null}
      <Section title={t('committeeChange.name')} list={false} data-hand-over><CommitteeChange /></Section>
    </div>
  );
}

/** The same page for a super admin with no seat, opened from a link that names the company; the wallet checks the name on the chain. */
export function SuperAdminsByLink() {
  const t = useText();
  const { params } = useCurrentPage();
  const label = readCompanyLabel(params.label);
  const account = readAccountAddress(params.account);
  const id = params.id ?? '';
  const [reach] = useState<SuperAdminReach | null>(() => (label === null || account === null || id === '' ? null : { company: { accountId: id, label, account }, asSuperAdmin: true }));
  return (
    <div className="flex flex-col gap-6" data-screen="super-admins-by-link">
      <PageHeader title={t('page.superAdminsByLink.name')} />
      <p className="text-sm text-muted-foreground">{t('superAdmins.intro')}</p>
      {reach === null ? <Alert data-super-admins="no-link"><AlertDescription>{t('superAdmins.noLink')}</AlertDescription></Alert> : <SuperAdminsOf from={reach} member={false} />}
    </div>
  );
}
