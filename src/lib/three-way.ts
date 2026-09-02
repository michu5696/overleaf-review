import { diffChars } from 'diff';

/** A replacement of base[start:end] with text. Insertions have start === end. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface MergeConflict {
  local: TextEdit;
  live: TextEdit;
  reason: 'overlapping-edits' | 'ambiguous-local-anchor';
}

export interface AmbiguousEditAnchor {
  forward: TextEdit;
  reverse: TextEdit;
  envelopeStart: number;
  envelopeEnd: number;
}

export interface ThreeWayMergeResult {
  text?: string;
  localEdits: TextEdit[];
  liveEdits: TextEdit[];
  appliedLocalEdits: TextEdit[];
  alreadyAppliedLocalEdits: TextEdit[];
  conflicts: MergeConflict[];
}

/** Convert base→target into non-overlapping replacements in base coordinates. */
export function textEdits(base: string, target: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let basePos = 0;
  let pending: TextEdit | undefined;

  const flush = () => {
    if (!pending) return;
    if (pending.start !== pending.end || pending.text.length) edits.push(pending);
    pending = undefined;
  };

  for (const part of diffChars(base, target)) {
    if (!part.added && !part.removed) {
      flush();
      basePos += part.value.length;
      continue;
    }
    pending ??= { start: basePos, end: basePos, text: '' };
    if (part.removed) {
      pending.end += part.value.length;
      basePos += part.value.length;
    } else {
      pending.text += part.value;
    }
  }
  flush();
  return edits;
}

export function sameEdit(a: TextEdit, b: TextEdit): boolean {
  return a.start === b.start && a.end === b.end && a.text === b.text;
}

function reverseCodePoints(text: string): string {
  return Array.from(text).reverse().join('');
}

/**
 * Diffing from opposite ends exposes edits that can be anchored at multiple
 * identical substrings. Coordinates are mapped back to the original base.
 */
export function ambiguousEditAnchors(base: string, target: string): AmbiguousEditAnchor[] {
  const forward = textEdits(base, target);
  const reverse = textEdits(reverseCodePoints(base), reverseCodePoints(target))
    .map((edit) => ({
      start: base.length - edit.end,
      end: base.length - edit.start,
      text: reverseCodePoints(edit.text),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const ambiguities: AmbiguousEditAnchor[] = [];
  const count = Math.max(forward.length, reverse.length);
  for (let index = 0; index < count; index++) {
    const forwardEdit = forward[index] ?? reverse[index];
    const reverseEdit = reverse[index] ?? forward[index];
    if (sameEdit(forwardEdit, reverseEdit)) continue;
    ambiguities.push({
      forward: forwardEdit,
      reverse: reverseEdit,
      envelopeStart: Math.min(forwardEdit.start, reverseEdit.start),
      envelopeEnd: Math.max(
        forwardEdit.start,
        forwardEdit.end,
        reverseEdit.start,
        reverseEdit.end,
      ),
    });
  }
  return ambiguities;
}

function editTouchesEnvelope(edit: TextEdit, start: number, end: number): boolean {
  if (edit.start === edit.end) return edit.start >= start && edit.start <= end;
  return edit.start <= end && edit.end >= start;
}

/**
 * Whether two base-coordinate edits need a human choice. Adjacent edits are
 * intentionally compatible. Two insertions at the same boundary are not:
 * their ordering conveys intent and cannot safely be guessed.
 */
export function editsConflict(a: TextEdit, b: TextEdit): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start;
  if (aInsert) return a.start > b.start && a.start < b.end;
  if (bInsert) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function mapBasePosition(
  position: number,
  liveEdits: TextEdit[],
  includeInsertionAtPosition: boolean,
): number {
  let mapped = position;
  for (const edit of liveEdits) {
    if (edit.start === edit.end) {
      if (edit.start < position || (includeInsertionAtPosition && edit.start === position)) {
        mapped += edit.text.length;
      }
      continue;
    }
    if (edit.end <= position) mapped += edit.text.length - (edit.end - edit.start);
  }
  return mapped;
}

function applyEdits(source: string, edits: TextEdit[]): string {
  let result = source;
  // A live deletion can map two distinct base boundaries to the same point.
  // Apply the later local edit first so repeated insertion at that collapsed
  // point retains the original base ordering.
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort(
      (a, b) =>
        b.edit.start - a.edit.start ||
        b.edit.end - a.edit.end ||
        b.index - a.index,
    );
  for (const { edit } of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/**
 * Rebase Base→Local intent onto Live. The result is omitted when any edit
 * overlaps; callers must surface those conflicts rather than silently choosing.
 */
export function threeWayMerge(base: string, local: string, live: string): ThreeWayMergeResult {
  const localEdits = textEdits(base, local);
  const liveEdits = textEdits(base, live);
  const ambiguousAnchors = ambiguousEditAnchors(base, local);
  const conflicts: MergeConflict[] = [];
  const alreadyAppliedLocalEdits: TextEdit[] = [];
  const toApply: TextEdit[] = [];

  for (const localEdit of localEdits) {
    if (liveEdits.some((liveEdit) => sameEdit(localEdit, liveEdit))) {
      alreadyAppliedLocalEdits.push(localEdit);
      continue;
    }
    const ambiguity = ambiguousAnchors.find((candidate) => sameEdit(candidate.forward, localEdit));
    if (ambiguity) {
      const touching = liveEdits.filter((liveEdit) =>
        editTouchesEnvelope(liveEdit, ambiguity.envelopeStart, ambiguity.envelopeEnd),
      );
      if (touching.length) {
        for (const liveEdit of touching) {
          conflicts.push({ local: localEdit, live: liveEdit, reason: 'ambiguous-local-anchor' });
        }
        continue;
      }
    }
    const overlapping = liveEdits.filter((liveEdit) => editsConflict(localEdit, liveEdit));
    if (overlapping.length) {
      for (const liveEdit of overlapping) {
        conflicts.push({ local: localEdit, live: liveEdit, reason: 'overlapping-edits' });
      }
      continue;
    }

    if (localEdit.start === localEdit.end) {
      const point = mapBasePosition(localEdit.start, liveEdits, false);
      toApply.push({ start: point, end: point, text: localEdit.text });
    } else {
      // Keep a live insertion exactly at either edge: start after the leading
      // insertion and stop before the trailing insertion.
      const start = mapBasePosition(localEdit.start, liveEdits, true);
      const end = mapBasePosition(localEdit.end, liveEdits, false);
      toApply.push({ start, end, text: localEdit.text });
    }
  }

  return {
    text: conflicts.length ? undefined : applyEdits(live, toApply),
    localEdits,
    liveEdits,
    appliedLocalEdits: toApply,
    alreadyAppliedLocalEdits,
    conflicts,
  };
}
