import { useEffect, useId, useState } from 'react';
import {
  Alert, AlertDescription, AlertTitle, Button, Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet,
  CopyText, Input, RadioGroup, RadioGroupItem, useText,
} from 'vaults-ui';
import {
  addressIsPrivate, APPROVALS, approvalsSentence, CLASSIFICATIONS, emptyDraft, FIELD, FORM, INVITE_KIND, INVITE_WAY, INVITED, PROBLEM, payAssets, ROLE, SIGNER_ROLES, SIGNER_ROLES_LATER, sendInvite, SCOPE,
  TERMS, WHY, WORDS_OF_SENT, type InviteDraft, type InviteKind, type InviteProblem, type InviteWhy, type Invited,
} from '../adapters/invite.js';
import { OPENED } from '../adapters/reads.js';
import { ActRefused } from '../act-refused.js';
import { PayField, TermsChoice } from '../fields/form-fields.js';
import { useCalendarDay } from '../records/parts.js';
import { useCompanyRecords } from '../records/company-records.js';
import { useSession } from '../session.js';
import { usePanel } from '../shell/right-panel.js';
import type { StepProps } from '../setup/step-ids.js';

/** The kinds the wizard's People step offers: signers have a step of their own. */
const WIZARD_KINDS: readonly InviteKind[] = [INVITE_KIND.employee, INVITE_KIND.vendor];
const EVERY_KIND: readonly InviteKind[] = [INVITE_KIND.employee, INVITE_KIND.vendor, INVITE_KIND.signer, INVITE_KIND.superAdmin];

/** The words of every refusal the wallet can give, and of every problem the form can find, each by its code. */
function useWhySays(): Record<InviteWhy, string> {
  const t = useText();
  return {
    [WHY.notACompany]: t('invite.why.not-a-company'),
    [WHY.noSavedKeys]: t('invite.why.no-saved-keys'),
    [WHY.noSeat]: t('invite.why.no-seat'),
    [WHY.seatNotHeld]: t('invite.why.seat-not-held'),
    [WHY.notOnChain]: t('invite.why.not-on-chain'),
    [WHY.rosterNotOpened]: t('invite.why.roster-not-opened'),
    [WHY.notAToken]: t('invite.why.not-a-token'),
    [WHY.noName]: t('invite.why.no-name'),
    [WHY.notAnAsset]: t('invite.why.not-an-asset'),
    [WHY.noPay]: t('invite.why.no-pay'),
    [WHY.noClassification]: t('invite.why.no-classification'),
    [WHY.noStart]: t('invite.why.no-start'),
    [WHY.noTerms]: t('invite.why.no-terms'),
    [WHY.noRole]: t('invite.why.no-role'),
    [WHY.signerByAddress]: t('invite.why.signer-by-address'),
    [WHY.superAdmin]: t('invite.why.super-admin'),
    [WHY.notAKind]: t('invite.why.not-a-kind'),
    [WHY.noOpening]: t('invite.why.no-opening'),
    [WHY.ownAddress]: t('invite.why.own-address'),
    [WHY.widerScope]: t('invite.why.wider-scope'),
    [WHY.notMade]: t('invite.why.not-made'),
    [WHY.notFiled]: t('invite.why.not-filed'),
    [WHY.raisedNotFiled]: t('invite.why.raised-not-filed'),
    [WHY.mayBeSent]: t('invite.why.may-be-sent'),
    [WHY.filedNotEntered]: t('invite.why.filed-not-entered'),
    [WHY.offerNotRead]: t('invite.why.offer-not-read'),
    [WHY.stopped]: t('invite.why.stopped'),
    [WHY.other]: t('invite.why.other'),
  };
}

function useProblemSays(): Record<InviteProblem, string> {
  const t = useText();
  return {
    [PROBLEM.noName]: t('invite.problem.no-name'),
    [PROBLEM.noStart]: t('invite.problem.no-start'),
    [PROBLEM.badStart]: t('invite.problem.bad-start'),
    [PROBLEM.badEnd]: t('invite.problem.bad-end'),
    [PROBLEM.endBeforeStart]: t('invite.problem.end-before-start'),
    [PROBLEM.badEmail]: t('invite.problem.bad-email'),
    [PROBLEM.noAsset]: t('invite.problem.no-asset'),
    [PROBLEM.noAmount]: t('invite.problem.no-amount'),
    [PROBLEM.badAmount]: t('invite.problem.bad-amount'),
    [PROBLEM.zeroAmount]: t('invite.problem.zero-amount'),
    [PROBLEM.tooManyDecimals]: t('invite.problem.too-many-decimals'),
    [PROBLEM.noAddress]: t('invite.problem.no-address'),
    [PROBLEM.badAddress]: t('invite.problem.bad-address'),
    [PROBLEM.notPrivateAddress]: t('invite.problem.not-private-address'),
    [PROBLEM.noRole]: t('invite.problem.no-role'),
    [PROBLEM.roleLater]: t('invite.problem.role-later'),
    [PROBLEM.superAdmin]: t('invite.problem.super-admin'),
  };
}

function useKindSays(): Record<InviteKind, string> {
  const t = useText();
  return {
    [INVITE_KIND.employee]: t('invite.kind.employee'), [INVITE_KIND.vendor]: t('invite.kind.vendor'),
    [INVITE_KIND.signer]: t('invite.kind.signer'), [INVITE_KIND.superAdmin]: t('invite.kind.superAdmin'),
  };
}

function useClassSays(): Record<string, string> {
  const t = useText();
  return { [CLASSIFICATIONS[0]]: t('invite.classification.fullTime'), [CLASSIFICATIONS[1]]: t('invite.classification.partTime') };
}

function useRoleDoes(): Record<string, string> {
  const t = useText();
  return {
    [ROLE.admin]: t('invite.role.admin.says'), [ROLE.approver]: t('invite.role.approver.says'),
    [ROLE.initiator]: t('invite.role.initiator.says'), [ROLE.viewer]: t('invite.role.viewer.says'),
  };
}

function useRoleSays(): Record<string, string> {
  const t = useText();
  return {
    [ROLE.admin]: t('invite.role.admin'), [ROLE.approver]: t('invite.role.approver'), [ROLE.initiator]: t('invite.role.initiator'),
    [ROLE.viewer]: t('invite.role.viewer'), [ROLE.limited]: t('invite.role.limited'), [ROLE.accountant]: t('invite.role.accountant'),
  };
}

type Phase =
  | { readonly of: 'edit' }
  | { readonly of: 'busy'; readonly step: number; readonly steps: number }
  | { readonly of: 'sent'; readonly link: string; readonly already: boolean; readonly draft: InviteDraft };

/**
 * ONE INVITE PANEL FOR EVERY PLACE SOMEBODY IS INVITED. In the setup wizard's People step it is drawn in place (employees and
 * vendors); anywhere else it is a button that opens the form in the side panel, for the kinds the page gives (`kind` fixes one).
 */
export function InvitePeople({ leadTo, onChanged, kind, kinds, onInvited }: Partial<StepProps> & {
  kind?: InviteKind; kinds?: readonly InviteKind[]; onInvited?: () => void;
}) {
  const offered = kind !== undefined ? [kind] : kinds ?? (leadTo !== undefined ? WIZARD_KINDS : EVERY_KIND);
  if (leadTo !== undefined) return <div className="max-w-xl"><InviteForm kinds={offered} onInvited={() => { onInvited?.(); onChanged?.(); }} onHandedOver={() => { onChanged?.(); }} /></div>;
  return <InviteOpener kinds={offered} fixed={kind !== undefined} onInvited={onInvited} />;
}

function InviteOpener({ kinds, fixed, onInvited }: { kinds: readonly InviteKind[]; fixed: boolean; onInvited: (() => void) | undefined }) {
  const t = useText();
  const panel = usePanel();
  const { reload } = useCompanyRecords();
  const vendor = fixed && kinds[0] === INVITE_KIND.vendor;
  const open = (): void => panel.open({
    title: vendor ? t('invite.title.vendor') : t('invite.title'),
    description: t('invite.description'),
    body: <InviteForm kinds={kinds} onInvited={() => { reload(); onInvited?.(); }} onHandedOver={reload} />,
  });
  return <Button data-action="invite" onClick={open}>{vendor ? t('invite.open.vendor') : t('people.invite')}</Button>;
}

const atAddressOf = (d: InviteDraft): boolean => d.kind === INVITE_KIND.signer || ((d.kind === INVITE_KIND.employee || d.kind === INVITE_KIND.vendor) && d.way === INVITE_WAY.address);

function InviteForm({ kinds, onInvited, onHandedOver }: { kinds: readonly InviteKind[]; onInvited: () => void; onHandedOver: () => void }) {
  const t = useText();
  const whySays = useWhySays();
  const problemSays = useProblemSays();
  const kindSays = useKindSays();
  const roleSays = useRoleSays();
  const roleDoes = useRoleDoes();
  const classSays = useClassSays();
  const day = useCalendarDay();
  const { person, company } = useSession();
  const ids = { wayLink: useId(), wayAddress: useId(), scopeAll: useId(), scopeChosen: useId(), name: useId(), email: useId(), title: useId(), start: useId(), end: useId(), amount: useId(), termsAmount: useId(), address: useId(), asset: useId(), termsAsset: useId() };
  const first = kinds.find((k) => k !== INVITE_KIND.superAdmin) ?? INVITE_KIND.employee;
  const [draft, setDraft] = useState<InviteDraft>(() => emptyDraft(first));
  const [phase, setPhase] = useState<Phase>({ of: FORM.edit });
  const [wrong, setWrong] = useState<{ field: keyof InviteDraft; problem: InviteProblem } | null>(null);
  const [stopped, setStopped] = useState<Extract<Invited, { of: 'stopped' }> | null>(null);
  const [refused, setRefused] = useState<Extract<Invited, { of: 'refused' }>['why'] | null>(null);
  /* The token of an invitation that may already be part made: the same press again carries on that one, and the form is held still. */
  const [token, setToken] = useState<string | undefined>(undefined);
  const held = token !== undefined;
  const busy = phase.of === 'busy';
  const locked = busy || held;
  const linkToCopy = (link: string) => <CopyText text={link} label={t('invite.link.copy')} copied={t('invite.link.copied')} refused={t('invite.link.refused')} />;
  const set = (patch: Partial<InviteDraft>): void => { setDraft((d) => ({ ...d, ...patch })); setWrong(null); };
  const problemOf = (field: keyof InviteDraft): string | null => (wrong?.field === field ? problemSays[wrong.problem] : null);
  const assets = payAssets();
  const signer = draft.kind === INVITE_KIND.signer;
  const person0 = draft.kind === INVITE_KIND.employee || draft.kind === INVITE_KIND.vendor;
  const atAddress = atAddressOf(draft);

  const idOfField: Partial<Record<keyof InviteDraft, string>> = {
    [FIELD.name]: ids.name, [FIELD.email]: ids.email, [FIELD.startDate]: ids.start, [FIELD.endDate]: ids.end, [FIELD.amount]: ids.amount,
    [FIELD.termsAmount]: ids.termsAmount, [FIELD.address]: ids.address, [FIELD.asset]: ids.asset,
  };
  useEffect(() => { if (wrong !== null) document.getElementById(idOfField[wrong.field] ?? '')?.focus(); }, [wrong]);

  const send = async (): Promise<void> => {
    if (company === null || busy) return;
    setWrong(null); setStopped(null); setRefused(null);
    setPhase({ of: FORM.busy, step: 0, steps: 0 });
    const ended = await sendInvite(person.id, company, draft, token, (step, steps) => setPhase({ of: FORM.busy, step, steps }));
    if (ended.of === INVITED.done) {
      setToken(undefined);
      setPhase({ of: FORM.sent, link: ended.link, already: ended.already, draft });
      onInvited();
      return;
    }
    setPhase({ of: FORM.edit });
    if (ended.of === INVITED.problem) setWrong({ field: ended.field, problem: ended.problem });
    else if (ended.of === INVITED.refused) setRefused(ended.why);
    else {
      setStopped(ended); setToken(ended.keeps ? ended.token : undefined);
      if (ended.handedOver) onHandedOver();
    }
  };

  if (phase.of === 'sent') {
    const d = phase.draft;
    const person = d.kind === INVITE_KIND.employee || d.kind === INVITE_KIND.vendor;
    const toHolder = d.kind === INVITE_KIND.signer || (d.way === INVITE_WAY.address && person);
    const atPrivate = person && d.way === INVITE_WAY.address && addressIsPrivate(d.address);
    const name = d.name.trim();
    const symbolOf = (code: string): string => assets.find((a) => a.code === code)?.symbol ?? code;
    const pay = d.kind === INVITE_KIND.employee ? { what: t('invite.pay'), amount: d.amount.trim(), asset: symbolOf(d.asset) }
      : d.kind === INVITE_KIND.vendor && d.terms === TERMS.monthly ? { what: t('invite.monthlyAmount'), amount: d.termsAmount.trim(), asset: symbolOf(d.termsAsset) } : null;
    return (
      <div className="flex flex-col gap-4 text-sm" data-invite="sent">
        <Alert data-invite-sent>
          <AlertTitle>{phase.already ? t('invite.done.already') : t('invite.done.title')}</AlertTitle>
          <AlertDescription>{atPrivate ? t('invite.done.link.privateAddress', { name }) : toHolder ? t('invite.done.link.holder', { name }) : t('invite.done.link.anyone', { name })}</AlertDescription>
        </Alert>
        {linkToCopy(phase.link)}
        <p className="text-muted-foreground" data-invite-link-once>{t('invite.done.linkOnce')}</p>
        {d.kind === INVITE_KIND.signer ? (
          <>
            <SignerSent name={name} />
            <SignerApprovals />
          </>
        ) : null}
        {d.kind !== INVITE_KIND.signer && day(d.startDate) !== '' ? <p className="text-muted-foreground" data-invite-starts>{t('invite.done.starts', { date: day(d.startDate) })}</p> : null}
        {d.kind !== INVITE_KIND.signer && day(d.endDate) !== '' ? <p className="text-muted-foreground" data-invite-ends>{t('invite.done.ends', { date: day(d.endDate) })}</p> : null}
        {pay !== null ? <p className="text-muted-foreground" data-invite-pay>{t('invite.done.pay', pay)}</p> : null}
        {atAddressOf(d) ? <p className="text-muted-foreground break-all" dir="ltr" data-invite-address>{t('invite.done.address', { address: d.address.trim() })}</p> : null}
        <div><Button variant="outline" data-action="invite-another" onClick={() => { setDraft(emptyDraft(first)); setPhase({ of: FORM.edit }); }}>{t('invite.again')}</Button></div>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-5 text-sm" data-invite="form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {kinds.length > 1 ? (
        <FieldSet disabled={locked}>
          <FieldLegend variant="label">{t('invite.kind.label')}</FieldLegend>
          <RadioGroup value={draft.kind} onValueChange={(v) => set({ kind: v as InviteKind })} data-field="kind">
            {kinds.map((k) => (
              <Field key={k} orientation="horizontal">
                <RadioGroupItem value={k} id={ids.name + k} disabled={locked || k === INVITE_KIND.superAdmin} data-kind={k} className={k === INVITE_KIND.superAdmin ? 'disabled:opacity-70' : undefined} />
                {k === INVITE_KIND.superAdmin ? (
                  <FieldContent>
                    <FieldLabel htmlFor={ids.name + k} className="opacity-80 peer-disabled:opacity-80 group-data-[disabled=true]/field:opacity-80">{kindSays[k]}</FieldLabel>
                    <FieldDescription data-invite-refused-kind="super-admin">{t('invite.kind.superAdmin.why')}</FieldDescription>
                  </FieldContent>
                ) : <FieldLabel htmlFor={ids.name + k}>{kindSays[k]}</FieldLabel>}
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
      ) : null}

      <FieldGroup>
        <Field data-invalid={problemOf(FIELD.name) !== null || undefined}>
          <FieldLabel htmlFor={ids.name}>{t('invite.name')}</FieldLabel>
          <Input id={ids.name} data-field="name" value={draft.name} disabled={locked} aria-invalid={problemOf(FIELD.name) !== null} onChange={(e) => set({ name: e.target.value })} />
          {problemOf(FIELD.name) === null ? null : <FieldError data-problem="name">{problemOf(FIELD.name)}</FieldError>}
        </Field>

        {person0 ? (
          <FieldSet disabled={locked}>
            <FieldLegend variant="label">{t('invite.way.label')}</FieldLegend>
            <RadioGroup value={draft.way} onValueChange={(v) => set({ way: v as typeof draft.way })} data-field="way">
              <Field orientation="horizontal"><RadioGroupItem value={INVITE_WAY.link} id={ids.wayLink} disabled={locked} data-way="link" /><FieldLabel htmlFor={ids.wayLink}>{t('invite.way.link')}</FieldLabel></Field>
              <Field orientation="horizontal"><RadioGroupItem value={INVITE_WAY.address} id={ids.wayAddress} disabled={locked} data-way="address" /><FieldLabel htmlFor={ids.wayAddress}>{t('invite.way.address')}</FieldLabel></Field>
            </RadioGroup>
          </FieldSet>
        ) : null}

        {atAddress ? (
          <Field data-invalid={problemOf(FIELD.address) !== null || undefined}>
            <FieldLabel htmlFor={ids.address}>{signer ? t('invite.address.signer') : t('invite.address.person')}</FieldLabel>
            <Input id={ids.address} data-field="address" dir="ltr" value={draft.address} disabled={locked} aria-invalid={problemOf(FIELD.address) !== null} onChange={(e) => set({ address: e.target.value })} />
            <FieldDescription>{signer ? t('invite.address.signer.hint') : t('invite.address.person.hint')}</FieldDescription>
            {problemOf(FIELD.address) === null ? null : <FieldError data-problem="address">{problemOf(FIELD.address)}</FieldError>}
          </Field>
        ) : null}

        {person0 ? (
          <>
            <Field data-invalid={problemOf(FIELD.email) !== null || undefined}>
              <FieldLabel htmlFor={ids.email}>{t('invite.email')}</FieldLabel>
              <Input id={ids.email} data-field="email" type="email" value={draft.email} disabled={locked} aria-invalid={problemOf(FIELD.email) !== null} onChange={(e) => set({ email: e.target.value })} />
              {problemOf(FIELD.email) === null ? null : <FieldError data-problem="email">{problemOf(FIELD.email)}</FieldError>}
            </Field>
            {draft.kind === INVITE_KIND.employee ? (
              <Field>
                <FieldLabel htmlFor={ids.title}>{t('invite.title.field')}</FieldLabel>
                <Input id={ids.title} data-field="title" value={draft.title} disabled={locked} onChange={(e) => set({ title: e.target.value })} />
              </Field>
            ) : null}
            <Field data-invalid={problemOf(FIELD.startDate) !== null || undefined}>
              <FieldLabel htmlFor={ids.start}>{t('invite.start')}</FieldLabel>
              <Input id={ids.start} data-field="start-date" type="date" value={draft.startDate} disabled={locked} aria-invalid={problemOf(FIELD.startDate) !== null} onChange={(e) => set({ startDate: e.target.value })} />
              {problemOf(FIELD.startDate) === null ? null : <FieldError data-problem="startDate">{problemOf(FIELD.startDate)}</FieldError>}
            </Field>
            <Field data-invalid={problemOf(FIELD.endDate) !== null || undefined}>
              <FieldLabel htmlFor={ids.end}>{t('invite.end')}</FieldLabel>
              <Input id={ids.end} data-field="end-date" type="date" value={draft.endDate} disabled={locked} aria-invalid={problemOf(FIELD.endDate) !== null} onChange={(e) => set({ endDate: e.target.value })} />
              {problemOf(FIELD.endDate) === null ? null : <FieldError data-problem="endDate">{problemOf(FIELD.endDate)}</FieldError>}
            </Field>
          </>
        ) : null}

        {draft.kind === INVITE_KIND.employee ? (
          <>
            <FieldSet disabled={locked}>
              <FieldLegend variant="label">{t('invite.classification')}</FieldLegend>
              <RadioGroup value={draft.classification} onValueChange={(v) => set({ classification: v })} data-field="classification">
                {CLASSIFICATIONS.map((c) => (
                  <Field key={c} orientation="horizontal">
                    <RadioGroupItem value={c} id={ids.title + c} disabled={locked} data-classification={c} />
                    <FieldLabel htmlFor={ids.title + c}>{classSays[c]}</FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            <PayField idAsset={ids.asset} idAmount={ids.amount} asset={draft.asset} amount={draft.amount} locked={locked}
              field={FIELD.amount} assetField={FIELD.asset} problem={problemOf(FIELD.amount) ?? problemOf(FIELD.asset)} fieldName={t('invite.pay')} onAsset={(asset) => set({ asset })} onAmount={(amount) => set({ amount })} />
          </>
        ) : null}

        {draft.kind === INVITE_KIND.vendor ? (
          <TermsChoice terms={draft.terms} onTerms={(terms) => set({ terms })} idAmount={ids.termsAmount} idAsset={ids.termsAsset} asset={draft.termsAsset} amount={draft.termsAmount} locked={locked}
            amountField={FIELD.termsAmount} assetField={FIELD.termsAsset} problem={problemOf(FIELD.termsAmount) ?? problemOf(FIELD.asset)}
            onAsset={(termsAsset) => set({ termsAsset })} onAmount={(termsAmount) => set({ termsAmount })} />
        ) : null}

        {signer ? (
          <>
            <FieldSet disabled={locked}>
              <FieldLegend variant="label">{t('invite.role.label')}</FieldLegend>
              <RadioGroup value={draft.role} onValueChange={(v) => set({ role: v })} data-field="role">
                {[...SIGNER_ROLES, ...SIGNER_ROLES_LATER].map((r) => {
                  const later = (SIGNER_ROLES_LATER as readonly string[]).includes(r);
                  return (
                    <Field key={r} orientation="horizontal">
                      <RadioGroupItem value={r} id={ids.title + r} disabled={locked || later} data-role={r} className={later ? 'disabled:opacity-70' : undefined} />
                      <FieldContent>
                        <FieldLabel htmlFor={ids.title + r} className={later ? 'opacity-80 peer-disabled:opacity-80 group-data-[disabled=true]/field:opacity-80' : undefined}>{roleSays[r]!}</FieldLabel>
                        {later ? null : <FieldDescription data-role-says={r}>{roleDoes[r]!}</FieldDescription>}
                      </FieldContent>
                    </Field>
                  );
                })}
              </RadioGroup>
              <FieldDescription data-invite-later="roles">{t('invite.role.later')}</FieldDescription>
            </FieldSet>
            <FieldSet disabled>
              <FieldLegend variant="label">{t('invite.scope.label')}</FieldLegend>
              <RadioGroup value={SCOPE.all} data-field="scope">
                <Field orientation="horizontal"><RadioGroupItem value={SCOPE.all} id={ids.scopeAll} data-scope="all" /><FieldLabel htmlFor={ids.scopeAll}>{t('invite.scope.all')}</FieldLabel></Field>
                <Field orientation="horizontal"><RadioGroupItem value={SCOPE.chosen} id={ids.scopeChosen} disabled data-scope="chosen" className="disabled:opacity-70" /><FieldLabel htmlFor={ids.scopeChosen} className="opacity-80 peer-disabled:opacity-80 group-data-[disabled=true]/field:opacity-80">{t('invite.scope.chosen')}</FieldLabel></Field>
              </RadioGroup>
              <FieldDescription data-invite-later="scope">{t('invite.scope.chosen.why')}</FieldDescription>
            </FieldSet>
            <SignerApprovals />
          </>
        ) : null}
      </FieldGroup>

      {stopped !== null ? (
        <Alert data-invite-stopped={stopped.why} variant={stopped.keeps || stopped.handedOver ? 'default' : 'destructive'}>
          <AlertTitle>{t('invite.stopped.title')}</AlertTitle>
          <AlertDescription>{stopped.handedOver && !WORDS_OF_SENT.has(stopped.why) ? t('invite.sent') : whySays[stopped.why]}</AlertDescription>
          {stopped.keeps ? (
            <AlertDescription data-invite-closing>
              {draft.kind === INVITE_KIND.signer && stopped.why !== WHY.offerNotRead ? t('invite.stopped.closingSigner') : t('invite.stopped.closing')}
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      {stopped?.link != null ? linkToCopy(stopped.link) : null}
      {refused === null ? null : <ActRefused why={refused} />}
      {busy ? <p role="status" className="text-muted-foreground" data-invite-working>{phase.steps > 0 ? t('invite.working.step', { step: phase.step, steps: phase.steps }) : t('invite.working')}</p> : null}
      <p className="text-muted-foreground">{t('invite.walletNote')}</p>
      <div>
        <Button type="submit" disabled={busy || company === null} data-action={held ? 'invite-press-again' : 'send-invite'}>{held ? t('invite.pressAgain') : t('invite.send')}</Button>
      </div>
    </form>
  );
}

/** What a sent signer invitation leaves to do: at a bar of 1 the raise is the approval, so the person takes the seat next; above 1 the proposal waits for the other signers. */
function SignerSent({ name }: { name: string }) {
  const t = useText();
  const { company } = useCompanyRecords();
  const open = company?.of === OPENED.open ? company : null;
  const complete = approvalsSentence(open?.approvalsForSigners)?.values.count === 1;
  const page = t('page.settingsSigners.name');
  return <p data-invite-signer-pending={complete ? 'complete' : 'waiting'}>{complete ? t('invite.done.signerComplete', { name, page }) : t('invite.done.signer', { name, page })}</p>;
}

/** What the signers' approvals need, said before the wallet is asked; nothing when it could not be read. */
function SignerApprovals() {
  const t = useText();
  const { company } = useCompanyRecords();
  const open = company?.of === OPENED.open ? company : null;
  const says = approvalsSentence(open?.approvalsForSigners);
  if (says === null) return null;
  const words = says.code === APPROVALS.account ? t('invite.approvals.account', says.values)
    : says.code === APPROVALS.raised ? t('invite.approvals.raised', says.values) : t('invite.approvals.raisedUnnamed', says.values);
  return <p className="text-muted-foreground" data-approvals-needed={says.code}>{words}</p>;
}
