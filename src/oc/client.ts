// The plugin's bridge to OpenConnector, over FloMorphic's central credential.
//
// The FloMorphic backend is a GENERIC proxy: it stores the OpenConnector
// connection (an access token) and forwards a request verbatim over the single
// NATS subject `flomorphic.svc.oc.proxy`. It knows nothing about Gmail, accounts,
// actions or capabilities — ALL of that lives here, in the plugin. This plugin
// holds no Google credentials and makes no Google calls; it builds OpenConnector
// requests and lets the backend execute them.
//
// Reaching the proxy needs an OPEN (multi) runtime credential — a strict,
// plugin-scoped credential cannot publish on `flomorphic.>`. See the README.

import type { Msg } from "nats";

/** The OpenConnector app this plugin targets. */
export const APP = "gmail";

const PROXY_SUBJECT = "flomorphic.svc.oc.proxy";

/** One connected account, from OpenConnector's GET /v1/connections. `scopes` is
 * what the plugin checks an action's required capability against. */
export interface OcAccount {
  id: string;
  service: string;
  status: string;
  accountLabel: string;
  alias: string;
  authType: string;
  isDefault: boolean;
  scopes: string[];
}

interface ProxyReply {
  status: number;
  body?: unknown;
  error?: string;
}

type Send = (subject: string, data: Uint8Array) => Promise<Msg>;

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v ?? {}));
function dec<T>(data: Uint8Array): T {
  const text = new TextDecoder().decode(data).trim();
  return (text ? JSON.parse(text) : {}) as T;
}

/** A generic OpenConnector client that runs every request through the FloMorphic
 * NATS proxy. All Gmail knowledge is in the helpers below, not the backend. */
export class Oc {
  // Cache of an action's required scopes, keyed by OC action name — the catalog
  // is stable for a running plugin, so fetch each action's definition once.
  private readonly scopeCache = new Map<string, string[]>();

  constructor(private readonly send: Send) {}

  /** Forward one gateway request and return its (unwrapped) response body. */
  async proxy(
    method: string,
    path: string,
    opts?: { query?: Record<string, string>; body?: unknown; connection?: string },
  ): Promise<any> {
    const msg = await this.send(
      PROXY_SUBJECT,
      enc({ connection: opts?.connection, method, path, query: opts?.query, body: opts?.body }),
    );
    const reply = dec<ProxyReply>(msg.data);
    if (reply.error) throw new Error(reply.error);
    if (reply.status >= 400) throw new Error(`OpenConnector ${path} returned ${reply.status}`);
    return reply.body;
  }

  /** The connected Gmail accounts (GET /v1/connections, filtered to this app). */
  async accounts(connection?: string): Promise<OcAccount[]> {
    const body = await this.proxy("GET", "/v1/connections", { connection });
    const list = (body?.data ?? []) as Array<Record<string, unknown>>;
    return list.filter((c) => c.service === APP).map(toAccount);
  }

  /** Resolve one account by alias (or the default when alias is empty). */
  async resolve(alias?: string, connection?: string): Promise<OcAccount | undefined> {
    const list = await this.accounts(connection);
    if (list.length === 0) return undefined;
    const wanted = (alias ?? "").trim();
    if (wanted === "") return list.find((a) => a.isDefault) ?? list[0];
    return list.find((a) => a.alias === wanted || a.accountLabel === wanted);
  }

  /**
   * The scopes OpenConnector says an action needs — read live from the gateway's
   * own catalog (GET /v1/actions/gmail.<action> → `requiredScopes`), so the
   * requirement is authoritative, not hardcoded. Returns [] when it can't be
   * determined (the caller then skips enforcement and lets oomol be the gate).
   */
  async requiredScopes(action: string, connection?: string): Promise<string[]> {
    const cached = this.scopeCache.get(action);
    if (cached) return cached;
    try {
      const body = await this.proxy("GET", `/v1/actions/${APP}.${action}`, { connection });
      const def = (body?.data ?? body) as Record<string, unknown>;
      const raw = def?.requiredScopes;
      const scopes = Array.isArray(raw) ? raw.map(String) : [];
      this.scopeCache.set(action, scopes);
      return scopes;
    } catch {
      return [];
    }
  }

  /** Run one Gmail action as `alias` — POST /v1/actions/gmail.<action> {input}. */
  async run(action: string, alias: string, input: unknown, connection?: string): Promise<unknown> {
    const query = alias ? { alias } : undefined;
    const body = await this.proxy("POST", `/v1/actions/${APP}.${action}`, {
      query,
      body: { input },
      connection,
    });
    return body?.data ?? body;
  }
}

function toAccount(c: Record<string, unknown>): OcAccount {
  const scopes = Array.isArray(c.scopes) ? (c.scopes as unknown[]).map(String) : [];
  return {
    id: String(c.id ?? ""),
    service: String(c.service ?? ""),
    status: String(c.status ?? ""),
    accountLabel: String(c.accountLabel ?? ""),
    alias: String(c.alias ?? ""),
    authType: String(c.authType ?? ""),
    isDefault: c.isDefault === true,
    scopes,
  };
}
