import { tChrome } from '../i18n';
import { baseName } from '../lib/create-pdf';

/** One line for each cut-off picture a run imported. `pages` is stated when the
 * pages of the written file are known. */
export function CutOffNotice({
  items,
  testId,
}: {
  items: readonly { path: string; pages?: string }[];
  testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <div role="alert">
      {items.map((item) => (
        <p
          key={`${item.path} ${item.pages ?? ''}`}
          className="text-xs text-amber-400 mt-1 [overflow-wrap:anywhere]"
          data-testid={testId}
        >
          {item.pages === undefined
            ? tChrome('dialog.imageImport.cutOff', { name: baseName(item.path) })
            : tChrome('dialog.imageImport.cutOffPages', { name: baseName(item.path), pages: item.pages })}
        </p>
      ))}
    </div>
  );
}
