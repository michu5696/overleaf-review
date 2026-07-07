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

/** Post the message body of a comment thread. */
export async function postThreadMessage(
  threadId: string,
  content: string,
  csrf: string,
): Promise<number> {
  const res = await fetch(
    `${config.baseUrl}/project/${config.projectId}/thread/${threadId}/messages`,
    {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) {
    throw new Error(`postThreadMessage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status;
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
