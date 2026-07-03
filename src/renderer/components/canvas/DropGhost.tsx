import { ADD_PAGE_WIDTH, BASE_PAGE_HEIGHT } from '../../canvas/layout';
import { DashedBorder } from './dashed-border';
import { PlusIcon } from './icons';

const ROW_PAD_Y = 52 + 14;

export interface GhostSize {
  width: number;
  height: number;
}

interface GhostPageProps extends GhostSize {
  grow?: boolean;
}

export function GhostPage({ width, height, grow }: GhostPageProps): React.JSX.Element {
  return (
    <div
      className={'page ghost' + (grow ? ' grow' : '')}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

interface AddDocGhostProps {
  width: number;
  onClick: () => void;
}

export function AddDocGhost({ width, onClick }: AddDocGhostProps): React.JSX.Element {
  const height = ROW_PAD_Y + BASE_PAGE_HEIGHT;
  return (
    <button
      type="button"
      className="add-doc-row"
      style={{ width, height }}
      title="Add document"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <DashedBorder width={width} height={height} radius={23} />
      <span
        className="add-ghost add-doc-page"
        style={{ width: ADD_PAGE_WIDTH, height: BASE_PAGE_HEIGHT }}
      >
        <DashedBorder width={ADD_PAGE_WIDTH} height={BASE_PAGE_HEIGHT} radius={9} dash="5 7" />
        <PlusIcon size={24} />
        <span className="add-label">Add document</span>
      </span>
    </button>
  );
}

interface GhostRowProps {
  width: number;
  pageHeight: number;
  pages: GhostSize[];
}

export function GhostRow({ width, pageHeight, pages }: GhostRowProps): React.JSX.Element {
  return (
    <div className="doc-row ghost" style={{ width }} aria-hidden="true">
      <div className="ghost-strip">
        {pages.map((p, i) => (
          <GhostPage key={i} width={p.width} height={pageHeight} />
        ))}
      </div>
    </div>
  );
}
