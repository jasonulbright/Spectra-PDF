import { useEffect, useState } from 'react';
import type { PageAnnotation } from '../../state/types';
import { OWN_TEXT_SIZE } from '../../lib/free-text-redraw';
import {
  TEXT_BOX_PAD, bodyPlanOf, displayLine, engineLayout, engineLayoutUnavailable, isLayoutAnswer, knownEngineLayout, layoutRetryDelay, standardLayout,
} from '../../lib/text-box-layout';
import type { BodyLayout } from '../../lib/text-box-layout';

interface TextBoxBodyProps {
  annotation: PageAnnotation;
  /** The width of the text box in points, in the frame the commit draws in. */
  boxWidthPt: number;
  /** The display size of the text of a box this editor creates, in px. */
  fontPx: number;
  className: string;
  style?: React.CSSProperties;
}

const ALIGN = ['left', 'center', 'right'] as const;

/**
 * The text of a text box that is not committed yet, in the lines the commit
 * will write. A line is one block that never wraps; the browser shapes it and
 * orders it by the base direction the layout states. A line that ends with a
 * drawn soft hyphen shows a hyphen: a browser draws a soft hyphen only where
 * it breaks a line itself. While the engine has
 * not answered, and for a text in a font of the file, the browser wraps the
 * text itself. A call that gets no answer is made again a bounded number of
 * times (`layoutRetryDelay`). A call the engine answers with an error is not
 * made again: the browser wraps that text.
 */
export function TextBoxBody({ annotation, boxWidthPt, fontPx, className, style }: TextBoxBodyProps): React.JSX.Element {
  const text = annotation.note ?? '';
  const plan = bodyPlanOf(annotation);
  const width = Math.max(1, boxWidthPt - TEXT_BOX_PAD * 2);
  const known = plan.via === 'standard' ? standardLayout(text, plan.size, width, plan.align)
    : plan.via === 'engine' ? knownEngineLayout(text, plan, width) ?? null : null;
  const [answered, setAnswered] = useState<{ key: string; layout: BodyLayout | null } | null>(null);
  const key = `${plan.via}\n${plan.size}\n${plan.style.family}\n${plan.style.bold === true}\n${plan.style.italic === true}\n${plan.align ?? ''}\n${width}\n${text}`;
  useEffect(() => {
    if (plan.via !== 'engine' || known || engineLayoutUnavailable(text, plan, width)) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const ask = (): void => {
      engineLayout(text, plan, width).then((layout) => {
        if (!stale) setAnswered({ key, layout });
      }, (error: unknown) => {
        if (stale || isLayoutAnswer(error)) return;
        failures += 1;
        const wait = layoutRetryDelay(failures);
        if (wait !== null) timer = setTimeout(ask, wait);
      });
    };
    ask();
    return () => {
      stale = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `plan` is a function of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, known === null]);
  const layout = known ?? (answered?.key === key ? answered.layout : null);
  const fontSize = fontPx * (plan.size / OWN_TEXT_SIZE);
  if (!layout) {
    return (
      <span
        className={className}
        dir="auto"
        data-text-lines="natural"
        style={{ ...style, fontSize, ...(plan.align !== undefined ? { textAlign: ALIGN[plan.align] } : {}) }}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      className={`${className} page-annot-text-lines`}
      dir={layout.rtl ? 'rtl' : 'ltr'}
      data-text-lines={layout.lines.length}
      data-text-via={plan.via}
      style={{ ...style, fontSize, textAlign: ALIGN[layout.align] }}
    >
      {layout.lines.map((line, index) => (
        <span key={index} className="page-annot-text-line">{displayLine(line, layout.hyphens?.includes(index) === true)}</span>
      ))}
    </span>
  );
}
