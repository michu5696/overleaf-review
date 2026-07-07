import { createInterface } from 'node:readline/promises';
import { saveCredentials } from '../lib/credentials';
import { validateSession } from '../lib/rest';

export interface LoginOptions {
  cookie?: string;
  baseUrl?: string;
  browser?: boolean;
}

export async function login(opts: LoginOptions): Promise<void> {
  const baseUrl = opts.baseUrl ?? 'https://www.overleaf.com';
  let cookie = opts.cookie ?? process.env.OVERLEAF_SESSION2;

  if (opts.browser) {
    cookie = await captureCookieViaBrowser(baseUrl);
  } else if (!cookie) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Log into Overleaf in your browser (institutional SSO is fine), then copy the');
    console.log('`overleaf_session2` cookie value:');
    console.log('  devtools → Application → Cookies → your Overleaf host → overleaf_session2\n');
    cookie = (await rl.question('Paste overleaf_session2: ')).trim();
    rl.close();
  }
  if (!cookie) throw new Error('No cookie provided.');

  // Validate before persisting so we never save a dead cookie.
  const account = await validateSession(baseUrl, cookie);
  const path = saveCredentials({ baseUrl, session2: cookie });
  console.log(`\n✅ Logged in as ${account}. Saved to ${path} (chmod 600).`);
}

/**
 * SSO-friendly capture: opens the user's real Chrome (no Chromium download),
 * waits for them to reach the dashboard, then reads the session cookie.
 * Playwright is an optional dependency, imported lazily.
 */
async function captureCookieViaBrowser(baseUrl: string): Promise<string> {
  let chromium: any;
  try {
    // Non-literal specifier: keeps `playwright` a truly optional dep (no type
    // resolution at build time when it isn't installed).
    const specifier = 'playwright';
    chromium = ((await import(specifier)) as any).chromium;
  } catch {
    throw new Error(
      'Browser login needs Playwright. Install it with:\n' +
        '  npm i -D playwright\n' +
        'It will drive your installed Chrome (no extra download).',
    );
  }
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/login`);
    console.log('A browser opened — log into Overleaf (SSO is fine). Waiting for the dashboard…');
    await page.waitForURL((url: URL) => url.pathname.startsWith('/project'), { timeout: 300_000 });
    const cookies = await ctx.cookies();
    const found = cookies.find((c: any) => c.name === 'overleaf_session2');
    if (!found) throw new Error('Logged in, but no overleaf_session2 cookie was found.');
    return found.value as string;
  } finally {
    await browser.close();
  }
}
