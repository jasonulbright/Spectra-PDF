import { memo } from 'react';
import { DOC_SLOT } from '../../canvas/layout';
import { DocHeader } from './DocHeader';
import type { DocPlacement } from '../../canvas/layout';

const HEADER_OFFSET_X = 16;
const HEADER_OFFSET_Y = 10;

interface HeaderLayerProps {
  items: DocPlacement[];
  betweenIndex: number;
  onMove: (docId: string, direction: -1 | 1) => void;
  onRemove: (docId: string) => void;
  onRename: (docId: string, name: string) => void;
}

function HeaderLayerImpl({
  items,
  betweenIndex,
  onMove,
  onRemove,
  onRename,
}: HeaderLayerProps): React.JSX.Element {
  return (
    <>
      {items.map((item, index) => (
        <div
          key={item.doc.id}
          className="overlay-header-slot"
          style={{
            left: item.x + HEADER_OFFSET_X,
            top: item.y + HEADER_OFFSET_Y,
            transform:
              betweenIndex !== -1 && index >= betweenIndex
                ? `translateY(${DOC_SLOT}px)`
                : undefined,
          }}
        >
          <DocHeader
            doc={item.doc}
            index={index}
            total={items.length}
            onMove={onMove}
            onRemove={onRemove}
            onRename={onRename}
          />
        </div>
      ))}
    </>
  );
}

export const HeaderLayer = memo(HeaderLayerImpl);
