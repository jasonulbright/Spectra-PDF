// Tree reorder for the canvas outline sidebar (2n.2). Bookmarks form a tree,
// so "drag-reorder" must support both re-sequencing siblings AND reparenting
// (nesting / un-nesting). This is the projected-depth model dnd-kit's sortable
// tree uses, but implemented over plain index paths with no per-node ids and
// no dependency (dnd-kit is being retired — see PUNCHLIST 2o).
//
// The algorithm avoids fragile post-removal index math: it flattens the tree
// to a pre-order list, LIFTS the dragged node's whole subtree out, re-depths
// that subtree by the drop delta, splices it back into the flat list at the
// drop gap, then rebuilds the tree from (node, depth) pairs. Rebuilding is
// always valid because the dragged node's projected depth is clamped so it can
// never exceed "one deeper than the row above it".
//
// OutlineNode carries opaque `action`/`dest`/`action_lossy` fields (2l action
// preservation) beyond {title, page, children}; every node is cloned by spread
// so those ride along untouched through a reorder.

export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
  // Opaque 2l action-preservation payloads — never inspected here, only
  // preserved. Indexed access keeps them through the `{ ...node }` clones.
  [key: string]: unknown;
}

export interface FlatNode {
  node: OutlineNode;
  path: number[]; // index path from the roots
  depth: number; // path.length - 1
}

/** Pre-order flatten to a flat list carrying each node's index path + depth. */
export function flattenOutline(nodes: OutlineNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (list: OutlineNode[], parentPath: number[]): void => {
    list.forEach((node, i) => {
      const path = [...parentPath, i];
      out.push({ node, path, depth: path.length - 1 });
      walk(node.children, path);
    });
  };
  walk(nodes, []);
  return out;
}

/** True when `prefix` is a path-prefix of `path` (i.e. `path` is `prefix` or a
 * descendant of it). */
export function isPathPrefix(prefix: number[], path: number[]): boolean {
  return prefix.length <= path.length && prefix.every((v, i) => v === path[i]);
}

/** The flattened rows with the dragged node's subtree removed — the rows that
 * stay visible during a drag, and the coordinate space the drop gap indexes. */
export function restRows(flat: FlatNode[], draggedPath: number[]): FlatNode[] {
  return flat.filter((f) => !isPathPrefix(draggedPath, f.path));
}

/** Clamp a desired drop depth to what the neighbours allow: at most one deeper
 * than the row above the gap, at least the row below's depth (so the node
 * can't orphan the row below it). Roots are depth 0. */
export function clampDropDepth(rest: FlatNode[], overIndex: number, desiredDepth: number): number {
  const prev = rest[overIndex - 1];
  const next = rest[overIndex];
  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  return Math.max(minDepth, Math.min(desiredDepth, maxDepth));
}

/** Rebuild a tree from a valid pre-order (node, depth) sequence. Each node is
 * cloned (fresh `children`) so the source tree is never mutated; opaque fields
 * survive via spread. Requires every item's depth ≤ previous depth + 1. */
function buildTree(items: { node: OutlineNode; depth: number }[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  // childrenAtDepth[d] = the children array new nodes at depth d push into.
  const childrenAtDepth: OutlineNode[][] = [roots];
  for (const { node, depth } of items) {
    const clone: OutlineNode = { ...node, children: [] };
    const bucket = childrenAtDepth[depth] ?? roots;
    bucket.push(clone);
    childrenAtDepth[depth + 1] = clone.children;
    childrenAtDepth.length = depth + 2; // deeper buckets are now stale
  }
  return roots;
}

/**
 * Move the node at `draggedPath` (with its subtree) to the drop gap `overIndex`
 * (an index into `restRows`, 0..rest.length) at `desiredDepth`. Returns a new
 * tree; the input is not mutated. A no-op drop returns a structurally-equal
 * tree (callers can compare to skip a save).
 */
export function moveOutlineNode(
  nodes: OutlineNode[],
  draggedPath: number[],
  overIndex: number,
  desiredDepth: number,
): OutlineNode[] {
  if (draggedPath.length === 0) return nodes;
  const flat = flattenOutline(nodes);
  const dragged = flat.filter((f) => isPathPrefix(draggedPath, f.path));
  if (dragged.length === 0) return nodes; // stale path — reject
  const baseDepth = dragged[0].depth;
  const rest = flat.filter((f) => !isPathPrefix(draggedPath, f.path));
  const clampedIndex = Math.max(0, Math.min(overIndex, rest.length));
  const depth = clampDropDepth(rest, clampedIndex, desiredDepth);
  const delta = depth - baseDepth;
  // Re-depth the whole lifted subtree by the same delta so its internal
  // structure is preserved and the dragged node lands at `depth`.
  const lifted = dragged.map((f) => ({ node: f.node, depth: f.depth + delta }));
  const merged = [
    ...rest.slice(0, clampedIndex).map((f) => ({ node: f.node, depth: f.depth })),
    ...lifted,
    ...rest.slice(clampedIndex).map((f) => ({ node: f.node, depth: f.depth })),
  ];
  return buildTree(merged);
}
