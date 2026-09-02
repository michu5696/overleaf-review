import { OverleafSocket } from '../overleaf-socket';
import { config } from '../config';

export interface Doc {
  _id: string;
  /** Basename, e.g. "intro.tex". */
  name: string;
  /** Full project path, e.g. "sections/intro.tex". */
  path: string;
}

export interface OpenedProject {
  socket: OverleafSocket;
  /** This client's public id — used as `meta.source` on outgoing updates. */
  publicId: string;
  project: any;
  docs: Doc[];
}

export interface DocState {
  version: number;
  lines: string[];
  ranges: { comments?: any[]; changes?: any[] };
}

export interface OtUpdate {
  doc: string;
  op: unknown[];
  v: number;
  meta?: Record<string, unknown>;
  hash?: string;
}

function collectDocs(rootFolder: any[] | undefined): Doc[] {
  const out: Doc[] = [];
  const walk = (folders: any[], prefix: string) => {
    for (const f of folders ?? []) {
      // The top-level folder is always named "rootFolder"; keep it out of paths.
      const dir = f.name && f.name !== 'rootFolder' ? (prefix ? `${prefix}/${f.name}` : f.name) : prefix;
      for (const d of f.docs ?? []) {
        out.push({ _id: d._id, name: d.name, path: dir ? `${dir}/${d.name}` : d.name });
      }
      walk(f.folders ?? [], dir);
    }
  };
  walk(rootFolder ?? [], '');
  return out;
}

/** Connect and receive the project (auto-pushed as joinProjectResponse). */
export async function openProject(opts: { debug?: boolean } = {}): Promise<OpenedProject> {
  const socket = new OverleafSocket(config.baseUrl, config.cookie, { debug: opts.debug ?? false });
  const pushed = new Promise<any[]>((resolve) => socket.on('joinProjectResponse', resolve));
  await socket.connect(config.projectId);

  const first = await Promise.race([
    pushed,
    new Promise<null>((r) => setTimeout(() => r(null), 6000)),
  ]);

  let publicId = '';
  let project: any;
  if (first) {
    publicId = first[0]?.publicId ?? '';
    project = first[0]?.project;
  } else {
    const r = (await socket.emit('joinProject', [{ project_id: config.projectId }])) as any[];
    project = r[1];
  }
  return { socket, publicId, project, docs: collectDocs(project?.rootFolder) };
}

/** Join a doc and return its current version, lines, and ranges. */
export async function joinDoc(socket: OverleafSocket, docId: string): Promise<DocState> {
  const res = (await socket.emit('joinDoc', [docId, { encodeRanges: true }])) as any[];
  const [err, lines, version, , ranges] = res;
  if (err) throw new Error(`joinDoc error: ${JSON.stringify(err)}`);
  return { version, lines: lines ?? [], ranges: ranges ?? {} };
}

/**
 * Queue an OT update and wait for Overleaf's later `otUpdateApplied` event.
 * The socket acknowledgement only confirms that real-time accepted the update
 * into its queue; it is not proof that document-updater applied it.
 */
export async function applyOtUpdateAndWait(
  socket: OverleafSocket,
  docId: string,
  update: OtUpdate,
  timeoutMs = 30000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopApplied = () => {};
  let stopError = () => {};

  const applied = new Promise<void>((resolve, reject) => {
    stopApplied = socket.on('otUpdateApplied', (args) => {
      const event = args[0] as { doc?: string; v?: number; op?: unknown } | undefined;
      // The sender acknowledgement is the terse { doc, v } shape. Full events
      // containing `op` are collaborator updates broadcast on the same room and
      // must not be mistaken for confirmation of our own write.
      if (
        event?.doc === docId &&
        Number.isSafeInteger(event.v) &&
        event.v! >= update.v &&
        !Object.prototype.hasOwnProperty.call(event, 'op')
      ) {
        resolve();
      }
    });
    stopError = socket.on('otUpdateError', (args) => {
      const metadata = args[1] as { doc_id?: string } | undefined;
      if (metadata?.doc_id && metadata.doc_id !== docId) return;
      reject(new Error(`Overleaf failed to apply the OT update: ${JSON.stringify(args)}`));
    });
    timer = setTimeout(
      () => reject(new Error(`OT update for ${docId} was queued but not confirmed within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  // The server can report an asynchronous failure before its queue ack arrives.
  // Attach a handler immediately; the original promise is still awaited below.
  void applied.catch(() => {});

  try {
    const ack = (await socket.emit('applyOtUpdate', [docId, update], timeoutMs)) as any[];
    if (ack?.[0]) throw new Error(`Overleaf rejected the OT update: ${JSON.stringify(ack[0])}`);
    await applied;
  } finally {
    if (timer) clearTimeout(timer);
    stopApplied();
    stopError();
  }
}
