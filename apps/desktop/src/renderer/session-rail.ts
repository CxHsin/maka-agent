import type { SessionSummary } from '@maka/core';
import { projectRevisionLinkedSessionTree } from '@maka/core';

/**
 * Desktop sidebar rail projection.
 *
 * Linked children leave the rail: membership is exactly the roots of the
 * revision-aware linked tree (parent present → child nested off-rail; parent
 * missing → orphan stays a root). Nav / companion filters are flat — never
 * promote a linked child past a filtered ancestor.
 *
 * Active row shares that same tree: when a child is open, highlight the
 * ancestor that actually appears as a rail row (revision representatives
 * included via projectRevisionLinkedSessionTree aliases).
 */
export function deriveSessionRail(
  sessions: readonly SessionSummary[],
  activeId: string | undefined,
  include: (session: SessionSummary) => boolean,
): {
  sessions: SessionSummary[];
  activeRowId: string | undefined;
} {
  const tree = projectRevisionLinkedSessionTree(sessions, activeId);
  const parentByChildId = new Map<string, string>();
  for (const [parentId, children] of tree.childrenByParentId) {
    for (const child of children) {
      parentByChildId.set(child.id, parentId);
    }
  }

  const railSessions = tree.roots.filter(include);
  return {
    sessions: railSessions,
    activeRowId: resolveActiveRailRowId(activeId, railSessions, parentByChildId),
  };
}

function resolveActiveRailRowId(
  activeId: string | undefined,
  railSessions: readonly SessionSummary[],
  parentByChildId: ReadonlyMap<string, string>,
): string | undefined {
  if (!activeId) return undefined;
  const rowIds = new Set(railSessions.map((session) => session.id));
  let currentId = activeId;
  const visited = new Set<string>();
  while (!visited.has(currentId)) {
    visited.add(currentId);
    if (rowIds.has(currentId)) return currentId;
    const parentId = parentByChildId.get(currentId);
    if (!parentId) return undefined;
    currentId = parentId;
  }
  return undefined;
}
