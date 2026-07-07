import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} — copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  baseUrl: process.env.OVERLEAF_BASE_URL ?? 'https://www.overleaf.com',
  get session2(): string {
    return required('OVERLEAF_SESSION2');
  },
  get projectId(): string {
    return required('OVERLEAF_PROJECT_ID');
  },
  /** Cookie header value used for both HTTP and the websocket handshake. */
  get cookie(): string {
    return `overleaf_session2=${this.session2}`;
  },
};
