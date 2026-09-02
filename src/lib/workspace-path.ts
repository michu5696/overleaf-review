import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Normalize a user- or server-provided filename to a portable path beneath the
 * working tree. Absolute paths and explicit parent traversal are never valid.
 */
export function workspaceRelativePath(input: string, root = process.cwd()): string {
  if (typeof input !== 'string' || !input.length) throw new Error('workspace path is empty');
  if (isAbsolute(input) || /^[\\/]/.test(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    throw new Error(`Absolute paths are not allowed: ${input}`);
  }
  const portable = input.replace(/\\/g, '/');
  if (portable.split('/').includes('..')) {
    throw new Error(`Parent path traversal is not allowed: ${input}`);
  }
  const target = resolve(root, ...portable.split('/'));
  const absoluteRoot = resolve(root);
  if (isOutside(absoluteRoot, target) || target === absoluteRoot) {
    throw new Error(`Path must identify a file inside the working tree: ${input}`);
  }
  return relative(absoluteRoot, target).split(sep).join('/');
}

/** Resolve a repository-relative file for reading and reject symlink escapes. */
export function workspaceReadPath(input: string, root = process.cwd()): string {
  const rel = workspaceRelativePath(input, root);
  const realRoot = realpathSync(root);
  const lexicalTarget = resolve(root, ...rel.split('/'));
  const realTarget = realpathSync(lexicalTarget);
  if (isOutside(realRoot, realTarget) || realTarget === realRoot) {
    throw new Error(`Path resolves outside the working tree: ${input}`);
  }
  return lexicalTarget;
}

/** Resolve a repository-relative write target and reject symlinked ancestors. */
export function workspaceWritePath(input: string, root = process.cwd()): string {
  const rel = workspaceRelativePath(input, root);
  const lexicalTarget = resolve(root, ...rel.split('/'));
  const realRoot = realpathSync(root);

  if (existsSync(lexicalTarget)) {
    const target = realpathSync(lexicalTarget);
    if (isOutside(realRoot, target) || target === realRoot) {
      throw new Error(`Path resolves outside the working tree: ${input}`);
    }
    return lexicalTarget;
  }

  let ancestor = dirname(lexicalTarget);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve a safe parent for ${input}`);
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (isOutside(realRoot, realAncestor)) {
    throw new Error(`Path has an ancestor outside the working tree: ${input}`);
  }
  return lexicalTarget;
}
