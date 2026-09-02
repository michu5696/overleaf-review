import { config } from '../config';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: config.cookie, 'User-Agent': UA, Origin: config.baseUrl, ...extra };
}

/** Scrape the CSRF token from the editor page (needed for state-changing POSTs). */
export async function getCsrfToken(): Promise<string> {
  const res = await fetch(`${config.baseUrl}/project/${config.projectId}`, { headers: headers() });
  const html = await res.text();
  const m =
    html.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/) ??
    html.match(/"csrfToken"\s*:\s*"([^"]+)"/) ??
    html.match(/csrfToken\s*[:=]\s*["']([^"']+)["']/);
  if (!m) {
    throw new Error(
      `CSRF token not found (HTTP ${res.status}). If this is a login page, the ` +
        `session cookie is invalid/expired.`,
    );
  }
  return m[1];
}

/** All comment threads for the project: { [threadId]: { messages, resolved, ... } }. */
export async function getThreads(): Promise<Record<string, any>> {
  const res = await fetch(`${config.baseUrl}/project/${config.projectId}/threads`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`getThreads ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<Record<string, any>>;
}

export interface ThreadMessageLike {
  id?: unknown;
  _id?: unknown;
  content?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  [key: string]: unknown;
}

export interface PostThreadMessageResult {
  status: number;
  /** Present when Overleaf returned a message object/id in the response body. */
  messageId?: string;
  /** Parsed JSON response, or a short raw response when it was not JSON. */
  responseBody?: unknown;
}

/** A completed HTTP response that definitively rejected the requested mutation. */
export class RestRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'RestRequestError';
  }
}

export function threadMessages(thread: unknown): ThreadMessageLike[] {
  if (!thread || typeof thread !== 'object') return [];
  const messages = (thread as { messages?: unknown }).messages;
  return Array.isArray(messages)
    ? messages.filter((message): message is ThreadMessageLike => Boolean(message && typeof message === 'object'))
    : [];
}

export function threadMessageId(message: ThreadMessageLike | undefined): string | undefined {
  const value = message?.id ?? message?._id;
  return typeof value === 'string' && value ? value : undefined;
}

function timestampMs(message: ThreadMessageLike): number | undefined {
  const raw = message.timestamp ?? message.createdAt ?? message.created_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Some installations serialize Unix seconds, while current overleaf.com
    // uses milliseconds.
    return raw < 100_000_000_000 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && raw.trim()) {
      return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Find an exact-content message recent enough to plausibly be a retry. */
export function findRecentIdenticalMessage(
  thread: unknown,
  content: string,
  nowMs = Date.now(),
  windowMs = 5 * 60 * 1000,
): ThreadMessageLike | undefined {
  const earliest = nowMs - Math.max(0, windowMs);
  return threadMessages(thread)
    .filter((message) => {
      if (message.content !== content) return false;
      const timestamp = timestampMs(message);
      // Allow modest server clock skew, but do not let a wildly future-dated
      // message suppress replies indefinitely.
      return timestamp !== undefined && timestamp >= earliest && timestamp <= nowMs + 60_000;
    })
    .sort((a, b) => (timestampMs(b) ?? 0) - (timestampMs(a) ?? 0))[0];
}

/**
 * Match the newly observed exact-content message after a POST. Existing ids are
 * excluded so `--force` can still prove that it created an additional reply.
 */
export function findNewIdenticalMessage(
  beforeThread: unknown,
  afterThread: unknown,
  content: string,
  returnedMessageId?: string,
): ThreadMessageLike | undefined {
  const after = threadMessages(afterThread);
  if (returnedMessageId) {
    return after.find(
      (message) => threadMessageId(message) === returnedMessageId && message.content === content,
    );
  }

  const beforeIds = new Set(
    threadMessages(beforeThread).map(threadMessageId).filter((id): id is string => Boolean(id)),
  );
  const candidates = [...after].reverse().filter((message) => {
      if (message.content !== content) return false;
      const id = threadMessageId(message);
      return Boolean(id && !beforeIds.has(id));
    });
  // Without a response id, more than one new exact-content message is
  // indistinguishable from a collaborator race. Preserve ambiguity instead of
  // attributing an arbitrary message to this process.
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Extract a returned message id from the response shapes used by Overleaf variants. */
export function extractPostedMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ['message_id', 'messageId']) {
    if (typeof object[key] === 'string' && object[key]) return object[key];
  }
  for (const key of ['message', 'data']) {
    const nested = object[key];
    if (nested && typeof nested === 'object') {
      const nestedId = threadMessageId(nested as ThreadMessageLike) ?? extractPostedMessageId(nested);
      if (nestedId) return nestedId;
    }
  }
  // A top-level id is accepted last because some API variants return a message
  // object directly, while nested response objects may use `id` for other data.
  return threadMessageId(object as ThreadMessageLike);
}

export interface ObservePostedMessageResult {
  message?: ThreadMessageLike;
  thread?: unknown;
  attempts: number;
  lastError?: string;
}

/** Poll thread readback until the newly posted message can be identified. */
export async function observePostedThreadMessage(
  threadId: string,
  beforeThread: unknown,
  content: string,
  returnedMessageId?: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ObservePostedMessageResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5000);
  const intervalMs = Math.max(10, options.intervalMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastThread: unknown;
  let lastError: string | undefined;

  do {
    attempts += 1;
    try {
      lastThread = (await getThreads())[threadId];
      const message = findNewIdenticalMessage(
        beforeThread,
        lastThread,
        content,
        returnedMessageId,
      );
      if (message) return { message, thread: lastThread, attempts };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    thread: lastThread,
    attempts,
    ...(lastError ? { lastError } : {}),
  };
}

/** Post a message and retain any response payload useful for verification. */
export async function postThreadMessageDetailed(
  threadId: string,
  content: string,
  csrf: string,
): Promise<PostThreadMessageResult> {
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/thread/${threadId}/messages`,
    {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      body: JSON.stringify({ content }),
    },
  );
  const rawBody = await res.text();
  if (!res.ok) {
    throw new RestRequestError(
      `postThreadMessage ${res.status}: ${rawBody.slice(0, 300)}`,
      res.status,
      rawBody.slice(0, 1000),
    );
  }

  let responseBody: unknown;
  if (rawBody) {
    try {
      responseBody = JSON.parse(rawBody);
    } catch {
      responseBody = rawBody.slice(0, 1000);
    }
  }
  return {
    status: res.status,
    messageId: extractPostedMessageId(responseBody),
    ...(responseBody === undefined ? {} : { responseBody }),
  };
}

/** Post the message body of a comment thread (status-only compatibility API). */
export async function postThreadMessage(
  threadId: string,
  content: string,
  csrf: string,
): Promise<number> {
  return (await postThreadMessageDetailed(threadId, content, csrf)).status;
}

/**
 * Resolve or reopen a comment thread. Note: unlike message-posting, this action
 * is DOC-scoped (`/project/:id/doc/:docId/thread/:threadId/resolve`).
 */
export async function setThreadResolved(
  docId: string,
  threadId: string,
  reopen: boolean,
  csrf: string,
): Promise<number> {
  const action = reopen ? 'reopen' : 'resolve';
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/doc/${docId}/thread/${threadId}/${action}`,
    { method: 'POST', headers: headers({ 'X-CSRF-Token': csrf }) },
  );
  if (!res.ok) {
    throw new Error(`${action} thread ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.status;
}

/** Accept tracked changes by id (doc-scoped). Rejecting has no endpoint — it's
 * done client-side via an inverse OT op (see the `reject` command). */
export async function acceptChanges(
  docId: string,
  changeIds: string[],
  csrf: string,
): Promise<number> {
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/doc/${docId}/changes/accept`,
    {
      method: 'POST',
      headers: headers({ 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }),
      body: JSON.stringify({ change_ids: changeIds }),
    },
  );
  if (!res.ok) throw new Error(`acceptChanges ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status;
}

/**
 * Upload a file into the project (figures, new .tex, any binary). Same endpoint
 * the web editor's uploader uses. Re-uploading the same name replaces the file.
 */
export async function uploadFile(
  folderId: string,
  name: string,
  bytes: Buffer,
  csrf: string,
): Promise<{ success: boolean; entity_id: string; entity_type: string }> {
  const form = new FormData();
  form.append('qqfile', new Blob([new Uint8Array(bytes)]), name);
  form.append('name', name);
  form.append('relativePath', 'null');
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/upload?folder_id=${folderId}`,
    // Deliberately no Content-Type — fetch sets the multipart boundary itself.
    { method: 'POST', headers: headers({ 'X-CSRF-Token': csrf }), body: form },
  );
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ success: boolean; entity_id: string; entity_type: string }>;
}

/** Delete a single message within a thread (flat path, like posting a message). */
export async function deleteMessage(
  threadId: string,
  messageId: string,
  csrf: string,
): Promise<number> {
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/thread/${threadId}/messages/${messageId}`,
    { method: 'DELETE', headers: headers({ 'X-CSRF-Token': csrf }) },
  );
  if (!res.ok) throw new Error(`deleteMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status;
}

/** Delete a comment thread (doc-scoped). */
export async function deleteThread(docId: string, threadId: string, csrf: string): Promise<number> {
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/doc/${docId}/thread/${threadId}`,
    { method: 'DELETE', headers: headers({ 'X-CSRF-Token': csrf }) },
  );
  if (!res.ok) throw new Error(`deleteThread ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status;
}

/**
 * Verify a session cookie is valid by loading the dashboard. Throws if it lands
 * on the login page. Returns the account email if it can be scraped, else a
 * generic label. Project-independent, so it works before `link`.
 */
export async function validateSession(baseUrl: string, session2: string): Promise<string> {
  const res = await fetch(`${baseUrl}/project`, {
    headers: { Cookie: `overleaf_session2=${session2}`, 'User-Agent': UA },
    redirect: 'follow',
  });
  const html = await res.text();
  const looksLikeLogin =
    res.url.includes('/login') || /name="ol-page"\s+content="login"/.test(html) || html.includes('id="loginForm"');
  if (looksLikeLogin) {
    throw new Error('Session cookie is invalid or expired (got the login page).');
  }
  const m =
    html.match(/name="ol-usersEmail"\s+content="([^"]+)"/) ??
    html.match(/"email":"([^"@]+@[^"]+)"/);
  return m ? m[1] : 'your Overleaf account';
}
