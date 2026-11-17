import React, { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { tChrome } from '../i18n';
import {
  guideOutline,
  parseGuide,
  type GuideBlock,
  type GuideInline,
} from '../lib/guide-markdown';
// The guide is one Markdown file kept in docs/. Vite inlines it at build time,
// so the dialog works offline and the text always matches the build.
import guideSource from '../../../docs/USER-GUIDE.md?raw';

// Help ▸ User Guide. The guide text is English only; the dialog's own labels
// follow the app language. The reader returns data and this file builds React
// elements from it, so no string from the guide becomes markup.

interface HelpDialogProps {
  onClose: () => void;
}

const ID_PREFIX = 'guide-';

function renderInline(
  nodes: GuideInline[],
  jump: (id: string) => void,
): React.ReactNode {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <React.Fragment key={i}>{node.text}</React.Fragment>;
      case 'bold':
        return <strong key={i}>{renderInline(node.children, jump)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(node.children, jump)}</em>;
      case 'code':
        return (
          <code key={i} className="px-1 rounded bg-neutral-800 text-[0.92em]">
            {node.text}
          </code>
        );
      case 'jump':
        return (
          <button
            key={i}
            type="button"
            className="underline text-blue-400 hover:text-blue-300"
            onClick={() => jump(node.target)}
          >
            {renderInline(node.children, jump)}
          </button>
        );
    }
  });
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'text-2xl font-semibold mt-2 mb-3',
  2: 'text-xl font-semibold mt-8 mb-2 border-b border-neutral-800 pb-1',
  3: 'text-base font-semibold mt-6 mb-2',
  4: 'text-sm font-semibold mt-4 mb-1',
};

function renderBlock(
  block: GuideBlock,
  key: number,
  jump: (id: string) => void,
): React.ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4';
      return (
        <Tag key={key} id={ID_PREFIX + block.id} className={HEADING_CLASS[block.level]}>
          {renderInline(block.inline, jump)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="my-2 leading-relaxed">
          {renderInline(block.inline, jump)}
        </p>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          key={key}
          className={`my-2 ps-6 space-y-1 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item, jump)}</li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className="my-3 ps-3 border-s-2 border-neutral-600 text-neutral-300">
          {renderInline(block.inline, jump)}
        </blockquote>
      );
    case 'code':
      return (
        <pre key={key} className="my-3 p-3 rounded bg-neutral-800 overflow-x-auto text-[12px]">
          <code>{block.text}</code>
        </pre>
      );
    case 'table':
      return (
        <div key={key} className="my-3 overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} className="border border-neutral-700 px-2 py-1 bg-neutral-800">
                    {renderInline(cell, jump)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className="border border-neutral-700 px-2 py-1 align-top">
                      {renderInline(cell, jump)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr key={key} className="my-4 border-neutral-700" />;
  }
}

export function HelpDialog({ onClose }: HelpDialogProps): React.ReactElement {
  // Re-render on language change; labels resolve via tChrome.
  useTranslation();
  const shellRef = useAppModal(onClose);
  const bodyRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => parseGuide(guideSource), []);
  const outline = useMemo(() => guideOutline(blocks), [blocks]);

  const jump = (id: string): void => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(ID_PREFIX + id)}`);
    el?.scrollIntoView({ block: 'start' });
  };

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
      data-testid="help-dialog"
      data-app-text
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.help.aria')}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[min(960px,94vw)] h-[min(720px,90vh)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h2 className="text-base font-semibold">{tChrome('dialog.help.title')}</h2>
          <span className="text-xs text-neutral-500">{tChrome('dialog.help.englishOnly')}</span>
        </div>
        <div className="flex flex-1 min-h-0">
          <nav
            aria-label={tChrome('dialog.help.contents')}
            lang="en"
            dir="ltr"
            className="w-60 shrink-0 overflow-y-auto border-e border-neutral-800 p-3 text-[13px]"
            data-testid="help-contents"
          >
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
              {tChrome('dialog.help.contents')}
            </div>
            <ul className="space-y-1">
              {outline.map((entry) => (
                <li key={entry.id} className={entry.level === 3 ? 'ps-3' : ''}>
                  <button
                    type="button"
                    className="text-start w-full hover:text-white text-neutral-300"
                    onClick={() => jump(entry.id)}
                  >
                    {entry.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div
            ref={bodyRef}
            lang="en"
            dir="ltr"
            className="flex-1 overflow-y-auto px-6 py-4 text-sm"
            data-testid="help-body"
          >
            {blocks.map((block, i) => renderBlock(block, i, jump))}
          </div>
        </div>
        <div className="flex justify-end px-5 py-3 border-t border-neutral-800">
          <button
            onClick={onClose}
            className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
