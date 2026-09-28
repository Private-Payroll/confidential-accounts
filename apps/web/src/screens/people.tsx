import { Amount, Badge, useText } from 'vaults-ui';
import { STANDING, type PersonRow, type PersonStanding } from '../adapters/company-records.js';
import { Day, PaidWords, ReadOf, SoonAction, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';

/**
 * PEOPLE: everyone the company pays, each with their title, where they stand,
 * their pay and whether they are paid privately or publicly. A row opens the
 * person's panel. Inviting someone is shown, and is Coming soon.
 */
export function People() {
  const t = useText();
  const panel = usePanel();
  return (
    <div className="flex flex-col gap-4" data-screen="people">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('page.people.name')}</h1>
        <SoonAction label={t('people.invite')} soon={t('people.invite.soon')} data-action="invite" />
      </div>
      <WithRecords>
        {(records) => (
          <ReadOf read={records.people}>
            {(rows) => rows.length === 0 ? <p className="text-sm text-muted-foreground" data-empty>{t('people.none')}</p> : (
              <table className="w-full text-sm" data-people>
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="py-2 text-start font-normal">{t('people.column.name')}</th><th className="text-start font-normal">{t('people.column.title')}</th><th className="text-start font-normal">{t('people.column.standing')}</th><th className="text-start font-normal">{t('people.column.pay')}</th><th className="text-start font-normal">{t('people.column.paid')}</th></tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="cursor-pointer border-t hover:bg-accent" onClick={() => panel.open({ title: p.name, body: <PersonPanel person={p} /> })} data-person={p.id}>
                      <td className="py-2 font-medium">{p.name}</td>
                      <td>{p.title}</td>
                      <td><StandingBadge standing={p.standing} /></td>
                      <td>{p.pay === null ? t('records.unrecognisedOne') : <Amount value={p.pay} kind="to-be-paid" />}</td>
                      <td className="text-muted-foreground"><PaidWords paid={p.paid} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}

function StandingBadge({ standing }: { standing: PersonStanding }) {
  const t = useText();
  const says: Record<PersonStanding, string> = {
    [STANDING.invited]: t('people.standing.invited'),
    [STANDING.waitingForCheck]: t('people.standing.waitingForCheck'),
    [STANDING.active]: t('people.standing.active'),
    [STANDING.leaver]: t('people.standing.left'),
  };
  return <Badge variant="outline" data-standing={standing}>{says[standing]}</Badge>;
}

/** A person's panel: their details and pay. Their payslips are Coming soon. */
function PersonPanel({ person }: { person: PersonRow }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-4 text-sm" data-person-panel={person.id}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">{t('people.column.title')}</dt><dd>{person.title}</dd>
        <dt className="text-muted-foreground">{t('people.column.standing')}</dt><dd><StandingBadge standing={person.standing} /></dd>
        <dt className="text-muted-foreground">{t('people.started')}</dt><dd><Day at={person.startedAt} /></dd>
        <dt className="text-muted-foreground">{t('people.column.pay')}</dt><dd>{person.pay === null ? t('records.unrecognisedOne') : <Amount value={person.pay} kind="to-be-paid" />}</dd>
        <dt className="text-muted-foreground">{t('people.column.paid')}</dt><dd><PaidWords paid={person.paid} /></dd>
      </dl>
      <SoonAction label={t('people.payslips')} soon={t('people.payslips.soon')} data-action="payslips" />
    </div>
  );
}
