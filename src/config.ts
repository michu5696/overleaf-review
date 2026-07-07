import 'dotenv/config';
import { loadCredentials } from './lib/credentials';
import { loadProjectConfig } from './lib/project-config';

/**
 * Resolves configuration from three layers, in priority order:
 *   1. Environment variables (OVERLEAF_* — handy for dev / CI)
 *   2. Per-repo project config (`.overleaf/config.json`, from `link`)
 *   3. Per-user credential store (`~/.config/overleaf-review/`, from `login`)
 */
function resolveBaseUrl(): string {
  return (
    process.env.OVERLEAF_BASE_URL ??
    loadProjectConfig().baseUrl ??
    loadCredentials().baseUrl ??
    'https://www.overleaf.com'
  );
}

function resolveSession2(): string {
  const value = process.env.OVERLEAF_SESSION2 || loadCredentials().session2;
  if (!value) {
    throw new Error('Not authenticated — run `overleaf-review login` (or set OVERLEAF_SESSION2).');
  }
  return value;
}

function resolveProjectId(): string {
  const value = process.env.OVERLEAF_PROJECT_ID || loadProjectConfig().projectId;
  if (!value) {
    throw new Error(
      'No project linked — run `overleaf-review link --project <id>` (or set OVERLEAF_PROJECT_ID).',
    );
  }
  return value;
}

export const config = {
  get baseUrl(): string {
    return resolveBaseUrl();
  },
  get session2(): string {
    return resolveSession2();
  },
  get projectId(): string {
    return resolveProjectId();
  },
  /** Cookie header value used for both HTTP and the websocket handshake. */
  get cookie(): string {
    return `overleaf_session2=${this.session2}`;
  },
};
