import type { Doc } from './session';

export class AmbiguousDocumentError extends Error {
  constructor(identifier: string, matches: Doc[]) {
    super(
      `Document name "${identifier}" is ambiguous (${matches.map((doc) => doc.path).join(', ')}); ` +
        'use the exact project path.',
    );
    this.name = 'AmbiguousDocumentError';
  }
}

/** Exact project path first; otherwise a basename is usable only when unique. */
export function matchDocument(identifier: string, docs: readonly Doc[]): Doc | undefined {
  const exact = docs.filter((doc) => doc.path === identifier);
  if (exact.length > 1) throw new AmbiguousDocumentError(identifier, exact);
  if (exact.length === 1) return exact[0];

  // A slash-bearing identifier claims to be a project path. Falling back to
  // its basename would silently map a typo or mismatched directory.
  if (identifier.includes('/') || identifier.includes('\\')) return undefined;
  const basename = identifier.replace(/\\/g, '/').split('/').pop() ?? identifier;
  const matches = docs.filter((doc) => doc.name === basename);
  if (matches.length > 1) throw new AmbiguousDocumentError(identifier, matches);
  return matches[0];
}
