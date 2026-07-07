import WebSocket from 'ws';

type Args = unknown[];
type Handler = (args: Args) => void;

/**
 * Overleaf's socket.io 0.9 UTF-8-encodes *outgoing* message payloads at the
 * application layer — each UTF-8 byte becomes one Latin-1 char — so a non-ASCII
 * character (e.g. an em-dash) reaches us as its multi-byte mojibake
 * (— → â\x80\x94), inflating its length and shifting every OT position after it.
 * We reverse that on receive. (The reverse direction is not needed: Overleaf
 * stores exactly the string we send.) ASCII is a no-op, which is why ASCII-only
 * docs always worked.
 */
function utf8Decode(binary: string): string {
  return Buffer.from(binary, 'latin1').toString('utf8');
}

/**
 * Minimal socket.io 0.9 client for Overleaf's real-time service.
 *
 * Overleaf (ShareLaTeX heritage) has long pinned an old socket.io 0.9 protocol
 * that the modern `socket.io-client` cannot speak, so we implement the minimal
 * framing over a raw WebSocket.
 *
 * ⚠️  FIRST HYPOTHESIS: the handshake URL, frame format, and event/ack shapes
 * below reflect the documented ShareLaTeX-era protocol. The very first live run
 * against a real overleaf.com project is where we confirm or adjust them — keep
 * the verbose logging on until the three probes are green.
 *
 * Frame format:  <type>:<id>:<endpoint>:<data>
 *   0 disconnect · 1 connect · 2 heartbeat · 3 message · 4 json · 5 event · 6 ack
 */
export class OverleafSocket {
  private ws!: WebSocket;
  private ackId = 1;
  private pendingAcks = new Map<number, (args: Args) => void>();
  private handlers = new Map<string, Handler[]>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly debug: boolean;
  private readonly cookies = new Map<string, string>();

  /** Browser-like headers — Overleaf's proxy can 502 non-browser upgrades. */
  private get browserHeaders(): Record<string, string> {
    return {
      Cookie: this.cookieHeader,
      Origin: this.baseUrl,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
  }

  private get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Merge Set-Cookie values — notably the GCLB load-balancer affinity cookie. */
  private absorbCookies(setCookies: string[]): void {
    for (const sc of setCookies) {
      const pair = sc.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  constructor(
    private readonly baseUrl: string,
    cookie: string,
    opts: { debug?: boolean } = {},
  ) {
    this.debug = opts.debug ?? true;
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  /** Subscribe to a server-pushed event (e.g. otUpdateApplied). */
  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async connect(projectId: string): Promise<void> {
    // 1) Handshake — obtain a transport session id. Overleaf binds the socket
    //    session to a project here, so projectId must be on the handshake URL.
    const handshakeUrl = `${this.baseUrl}/socket.io/1/?projectId=${projectId}&t=${Date.now()}`;
    const res = await fetch(handshakeUrl, { headers: this.browserHeaders });
    const setCookies =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    this.absorbCookies(setCookies);
    if (this.debug) console.log(`[socket] cookies now: ${[...this.cookies.keys()].join(', ')}`);
    if (!res.ok) {
      throw new Error(
        `socket.io handshake failed: ${res.status} ${res.statusText}. ` +
          `Check the session cookie and that the account is logged in.`,
      );
    }
    const body = await res.text(); // "<sid>:<hbTimeout>:<connTimeout>:<transports>"
    const [sid, hbTimeout, , transports] = body.split(':');
    if (this.debug) console.log(`[socket] handshake ok: ${body}`);

    // 2) Upgrade to a websocket bound to that session.
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/socket.io/1/websocket/${sid}`;
    if (this.debug) console.log(`[socket] transports=${transports}; ws=${wsUrl}`);
    this.ws = new WebSocket(wsUrl, { headers: this.browserHeaders });

    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, response) => {
        let errBody = '';
        response.on('data', (chunk: Buffer) => (errBody += chunk.toString()));
        response.on('end', () =>
          reject(
            new Error(
              `ws upgrade rejected: ${response.statusCode} ${response.statusMessage}\n` +
                `  headers: ${JSON.stringify(response.headers)}\n` +
                `  body: ${errBody.slice(0, 800)}`,
            ),
          ),
        );
      });
    });
    this.ws.on('message', (data) => this.onFrame(utf8Decode(data.toString())));

    // Heartbeat a little faster than the server's timeout so it never drops us.
    const intervalMs = (Number(hbTimeout) || 30) * 800;
    this.heartbeat = setInterval(() => this.send('2::'), intervalMs);
    if (this.debug) console.log('[socket] websocket open');
  }

  /** Emit an event and resolve with the server's ack payload (array of args). */
  emit(name: string, args: Args, timeoutMs = 15000): Promise<Args> {
    const id = this.ackId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error(`emit('${name}') timed out after ${timeoutMs}ms with no ack`));
      }, timeoutMs);
      this.pendingAcks.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      // The trailing "+" on the id requests an ack.
      this.send(`5:${id}+::${JSON.stringify({ name, args })}`);
    });
  }

  private onFrame(frame: string): void {
    if (this.debug) console.log('[socket] <-', frame.slice(0, 200));
    const type = frame[0];
    // Split off the first three colon-delimited fields; DATA may contain ':'.
    const c1 = frame.indexOf(':');
    const c2 = frame.indexOf(':', c1 + 1);
    const c3 = frame.indexOf(':', c2 + 1);
    const data = c3 === -1 ? '' : frame.slice(c3 + 1);

    switch (type) {
      case '2': // heartbeat -> echo
        this.send('2::');
        break;
      case '5': { // event
        try {
          const { name, args } = JSON.parse(data) as { name: string; args: Args };
          for (const h of this.handlers.get(name) ?? []) h(args);
        } catch {
          /* non-JSON event payload — ignore for now */
        }
        break;
      }
      case '6': { // ack:  data looks like "<id>+<jsonArgs>"
        const plus = data.indexOf('+');
        const ackId = Number(plus === -1 ? data : data.slice(0, plus));
        const payload =
          plus === -1 ? [] : (JSON.parse(data.slice(plus + 1)) as Args);
        this.pendingAcks.get(ackId)?.(payload);
        this.pendingAcks.delete(ackId);
        break;
      }
    }
  }

  private send(frame: string): void {
    if (this.debug && !frame.startsWith('2')) console.log('[socket] ->', frame.slice(0, 200));
    // Send raw: Overleaf stores exactly the string we send (the WebSocket layer
    // already UTF-8s the wire). It only utf8-encodes in the *other* direction,
    // which is why onFrame applies utf8Decode. See the utf8Encode/Decode note.
    this.ws.send(frame);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
