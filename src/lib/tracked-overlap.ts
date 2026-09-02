import type { TextEdit } from './three-way';

export interface TrackedChangeLike {
  id?: string;
  op?: { p?: number; i?: string; d?: string };
  metadata?: Record<string, unknown>;
}

export interface TrackedChangeOverlap {
  changeId: string;
  change: TrackedChangeLike;
  proposedEdit: TextEdit;
}

export interface CommentRangeLike {
  id?: string;
  op?: { p?: number; c?: string; t?: string };
  metadata?: Record<string, unknown>;
}

export interface CommentOverlap {
  threadId: string;
  position: number;
  anchor: string;
  comment: CommentRangeLike;
  proposedEdit: TextEdit;
}

function spanOverlapsEdit(start: number, end: number, edit: TextEdit): boolean {
  const editIsPoint = edit.start === edit.end;
  const rangeIsPoint = start === end;
  if (editIsPoint && rangeIsPoint) return edit.start === start;
  if (editIsPoint) return edit.start > start && edit.start < end;
  if (rangeIsPoint) return start >= edit.start && start < edit.end;
  return edit.start < end && start < edit.end;
}

function overlapsEdit(change: TrackedChangeLike, edit: TextEdit): boolean {
  const p = change.op?.p;
  if (typeof p !== 'number') return false;
  const inserted = typeof change.op?.i === 'string' ? change.op.i : undefined;
  const changeStart = p;
  const changeEnd = p + (inserted?.length ?? 0);
  return spanOverlapsEdit(changeStart, changeEnd, edit);
}

/** Locate every active tracked range touched by a proposed Live→Expected edit. */
export function findTrackedChangeOverlaps(
  changes: TrackedChangeLike[] | undefined,
  proposedEdits: TextEdit[],
): TrackedChangeOverlap[] {
  const out: TrackedChangeOverlap[] = [];
  for (const change of changes ?? []) {
    for (const proposedEdit of proposedEdits) {
      if (overlapsEdit(change, proposedEdit)) {
        out.push({ changeId: change.id ?? '(unknown)', change, proposedEdit });
      }
    }
  }
  return out;
}

/** Comment anchors are informational: return overlaps without blocking them. */
export function findCommentOverlaps(
  comments: CommentRangeLike[] | undefined,
  proposedEdits: TextEdit[],
): CommentOverlap[] {
  const out: CommentOverlap[] = [];
  for (const comment of comments ?? []) {
    const p = comment.op?.p;
    const anchor = comment.op?.c;
    if (typeof p !== 'number' || typeof anchor !== 'string') continue;
    for (const proposedEdit of proposedEdits) {
      if (spanOverlapsEdit(p, p + anchor.length, proposedEdit)) {
        out.push({
          threadId: comment.op?.t ?? comment.id ?? '(unknown)',
          position: p,
          anchor,
          comment,
          proposedEdit,
        });
      }
    }
  }
  return out;
}
