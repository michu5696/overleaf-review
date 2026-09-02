import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { openProject, joinDoc } from '../lib/session';
import { getThreads } from '../lib/rest';
import { offsetToLine, lineContext } from '../lib/anchors';
import { acquireMutationLock, type MutationLock } from '../lib/submission-lock';

interface Message {
  id: string;
  author: string;
  email?: string;
  content: string;
  timestamp?: number;
}

interface ReviewComment {
  doc: string;
  threadId: string;
  anchor: string;
  line: number;
  context: string;
  resolved: boolean;
  messages: Message[];
}

interface ReviewChange {
  doc: string;
  id: string;
  type: 'insert' | 'delete';
  text: string;
  line: number;
  context: string;
  author: string;
  ts?: string;
}

export interface ReviewData {
  project: string;
  projectId: string;
  pulledAt: string;
  comments: ReviewComment[];
  changes: ReviewChange[];
}

/** Map an Overleaf user_id → display name using the project membership. */
function buildMemberMap(project: any): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (u: any) => {
    if (!u?._id) return;
    map[u._id] = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u._id;
  };
  add(project?.owner);
  for (const m of project?.members ?? []) add(m);
  return map;
}

export async function pull(
  outDir = '.overleaf',
  options: { acquireLock?: boolean } = {},
): Promise<ReviewData> {
  let mutationLock: MutationLock | undefined;
  let opened: Awaited<ReturnType<typeof openProject>> | undefined;
  try {
    if (options.acquireLock !== false) mutationLock = acquireMutationLock(config.projectId);
    opened = await openProject();
    const { socket, project, docs } = opened;
    const members = buildMemberMap(project);
    const threads = await getThreads();

    const comments: ReviewComment[] = [];
    const changes: ReviewChange[] = [];

    for (const doc of docs) {
      const state = await joinDoc(socket, doc._id);

      for (const c of state.ranges.comments ?? []) {
        const line = offsetToLine(state.lines, c.op.p);
        const thread = threads[c.op.t] ?? {};
        comments.push({
          doc: doc.path,
          threadId: c.op.t,
          anchor: c.op.c,
          line: line + 1,
          context: lineContext(state.lines, line),
          resolved: Boolean(thread.resolved),
          messages: (thread.messages ?? []).map((m: any) => ({
            id: m.id,
            author: m.user?.first_name ?? members[m.user_id] ?? m.user_id,
            email: m.user?.email,
            content: m.content,
            timestamp: m.timestamp,
          })),
        });
      }

      for (const ch of state.ranges.changes ?? []) {
        const isInsert = typeof ch.op.i === 'string';
        const line = offsetToLine(state.lines, ch.op.p);
        changes.push({
          doc: doc.path,
          id: ch.id,
          type: isInsert ? 'insert' : 'delete',
          text: isInsert ? ch.op.i : ch.op.d,
          line: line + 1,
          context: lineContext(state.lines, line),
          author: members[ch.metadata?.user_id] ?? ch.metadata?.user_id ?? 'unknown',
          ts: ch.metadata?.ts,
        });
      }
    }

    const data: ReviewData = {
      project: project?.name ?? '(unknown)',
      projectId: config.projectId,
      pulledAt: new Date().toISOString(),
      comments,
      changes,
    };

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'reviews.json'), JSON.stringify(data, null, 2) + '\n');
    writeFileSync(join(outDir, 'reviews.md'), renderMarkdown(data));
    return data;
  } finally {
    try {
      opened?.socket.close();
    } finally {
      mutationLock?.release();
    }
  }
}

function renderMarkdown(d: ReviewData): string {
  const L: string[] = [];
  L.push(`# Overleaf review — ${d.project}`, '');
  L.push(`_Pulled ${d.pulledAt} from project \`${d.projectId}\`._`, '');
  L.push(`**${d.comments.length}** comment(s), **${d.changes.length}** tracked change(s).`, '');
  L.push(
    '_Act on these:_ `reply --thread <id> --message <text>` · `resolve --thread <id>` · ' +
      '`delete-comment --thread <id>` · `delete-message --message-id <id>` · ' +
      '`accept --change <id>` · `reject --change <id>`.',
    '',
  );

  const byDoc = <T extends { doc: string }>(items: T[]) => {
    const m = new Map<string, T[]>();
    for (const it of items) (m.get(it.doc) ?? m.set(it.doc, []).get(it.doc)!).push(it);
    return m;
  };

  if (d.comments.length) {
    L.push('## Comments', '');
    for (const [doc, items] of byDoc(d.comments)) {
      L.push(`### ${doc}`, '');
      for (const c of items) {
        const flag = c.resolved ? ' — ✅ resolved' : '';
        L.push(`#### 💬 “${c.anchor}” · line ${c.line}${flag}`);
        L.push(`\`thread ${c.threadId}\``);
        L.push('```', c.context, '```');
        for (const m of c.messages) {
          L.push(`- **${m.author}**: ${m.content}  \`msg ${m.id}\``);
        }
        if (!c.messages.length) L.push('- _(no message text)_');
        L.push('');
      }
    }
  }

  if (d.changes.length) {
    L.push('## Tracked changes', '');
    for (const [doc, items] of byDoc(d.changes)) {
      L.push(`### ${doc}`, '');
      for (const ch of items) {
        const verb = ch.type === 'insert' ? 'inserted' : 'deleted';
        L.push(
          `- **${verb}** at line ${ch.line} by ${ch.author} · \`change ${ch.id}\`: ` +
            `\`${ch.text.replace(/\n/g, '⏎')}\``,
        );
        L.push('  ```', ch.context.replace(/^/gm, '  '), '  ```');
      }
      L.push('');
    }
  }

  return L.join('\n');
}
