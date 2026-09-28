import { ComingSoon, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, useText } from 'vaults-ui';
import { EVERY_SHORTCUT } from '../shortcuts.js';
import { ShortcutKeys } from './shortcut-keys.js';

/** EVERY SHORTCUT, READ FROM THE ONE TABLE: what it does, its keys, and Coming soon for one whose page is not built yet. */
export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useText();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-shortcuts-help>
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
          {EVERY_SHORTCUT.map((s) => (
            <div key={s.id} className="contents" data-shortcut-line={s.id}>
              <dt className="flex flex-wrap items-center gap-2">
                <span>{s.does(t)}</span>
                {s.soon === undefined ? null : <ComingSoon explanation={s.soon(t)} />}
              </dt>
              <dd><ShortcutKeys id={s.id} /></dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
