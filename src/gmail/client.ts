// A thin Gmail REST client: OAuth token handling plus the handful of endpoints
// this plugin's actions need. One client is cached per connection (see Pool), so
// the access token it fetches is reused across jobs until it nears expiry.

import type { Config } from "./settings.js";
import { buildRawMessage, parseMessage, type Outgoing, type ParsedMessage } from "./mime.js";

const API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** A message header pair as `messages.list` metadata / `messages.get` return. */
export interface MessageSummary {
  id: string;
  threadId: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

/** A Gmail label as `labels.list` returns it. */
export interface Label {
  id: string;
  name: string;
  type?: string;
}

export class GmailClient {
  private readonly cfg: Config;
  private cachedToken = "";
  private tokenExpiresAt = 0; // epoch ms; 0 means "none cached"

  constructor(cfg: Config) {
    this.cfg = cfg;
    // A directly supplied access token is used as-is; it has no known expiry
    // here, so it is never refreshed (the refresh grant fields would be absent).
    if (cfg.accessToken) {
      this.cachedToken = cfg.accessToken;
      this.tokenExpiresAt = Number.MAX_SAFE_INTEGER;
    }
  }

  /** A short label for the mailbox this client acts on, for progress frames. */
  connInfo(): string {
    return this.cfg.user;
  }

  // --------------------------------------------------------------- OAuth --

  /** A valid bearer token, exchanging the refresh token when the cache is cold
   * or within a minute of expiry. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }
    if (!this.cfg.refreshToken) {
      // No refresh grant and the supplied token is stale/absent — nothing to do.
      throw new Error(
        "Gmail access token is expired or missing and no refresh token is set; " +
          "update the settings profile with a valid OAuth client and refresh token",
      );
    }

    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
      grant_type: "refresh_token",
    });

    const resp = await fetch(this.cfg.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`OAuth token exchange failed (${resp.status}): ${describeError(text)}`);
    }
    const token = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!token.access_token) {
      throw new Error("OAuth token exchange returned no access_token");
    }
    this.cachedToken = token.access_token;
    this.tokenExpiresAt = now + (token.expires_in ?? 3600) * 1000;
    return this.cachedToken;
  }

  // Every call goes through here: attach the bearer token, decode JSON, and turn
  // a non-2xx into an Error carrying Google's own message.
  private async api(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const resp = await fetch(`${API_BASE}/users/${encodeURIComponent(this.cfg.user)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Gmail API ${resp.status}: ${describeError(text)}`);
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  // ------------------------------------------------------------- endpoints --

  /** Read the authenticated user's profile — used to prove a connection works. */
  async getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number }> {
    const p = await this.api("/profile");
    return {
      emailAddress: String(p.emailAddress ?? ""),
      messagesTotal: Number(p.messagesTotal ?? 0),
      threadsTotal: Number(p.threadsTotal ?? 0),
    };
  }

  /** Send an email; returns the created message's id and threadId. */
  async send(msg: Outgoing): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const raw = buildRawMessage(msg);
    const res = await this.api("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    return {
      id: String(res.id ?? ""),
      threadId: String(res.threadId ?? ""),
      labelIds: Array.isArray(res.labelIds) ? (res.labelIds as string[]) : [],
    };
  }

  /**
   * Search messages with a Gmail query (the same `q` syntax as the Gmail search
   * box). Returns lightweight summaries — id, thread, and the key headers —
   * fetched with a metadata read per hit so the flow gets a usable list without
   * downloading whole bodies.
   */
  async search(q: string, maxResults: number, labelIds?: string[]): Promise<MessageSummary[]> {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    query.set("maxResults", String(Math.max(1, Math.min(maxResults || 25, 500))));
    for (const id of labelIds ?? []) query.append("labelIds", id);

    const list = await this.api(`/messages?${query.toString()}`);
    const ids = (Array.isArray(list.messages) ? list.messages : []) as { id: string }[];

    const summaries: MessageSummary[] = [];
    for (const { id } of ids) {
      const meta = await this.api(
        `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      const headers = new Map<string, string>();
      for (const h of (meta.payload as { headers?: { name: string; value: string }[] })?.headers ?? []) {
        headers.set(h.name.toLowerCase(), h.value);
      }
      summaries.push({
        id,
        threadId: String(meta.threadId ?? ""),
        from: headers.get("from"),
        subject: headers.get("subject"),
        date: headers.get("date"),
        snippet: String(meta.snippet ?? ""),
      });
    }
    return summaries;
  }

  /** Fetch one message in full and flatten it to headers + a text body. */
  async get(id: string): Promise<ParsedMessage> {
    const raw = await this.api(`/messages/${encodeURIComponent(id)}?format=full`);
    return parseMessage(raw);
  }

  /** Add and/or remove labels on a message (mark read, archive, star, …). */
  async modify(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<{ id: string; labelIds: string[] }> {
    const res = await this.api(`/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
    return {
      id: String(res.id ?? id),
      labelIds: Array.isArray(res.labelIds) ? (res.labelIds as string[]) : [],
    };
  }

  /** List the mailbox's labels — powers the modify form's label picker. */
  async labels(): Promise<Label[]> {
    const res = await this.api("/labels");
    const labels = (Array.isArray(res.labels) ? res.labels : []) as Label[];
    return labels.map((l) => ({ id: l.id, name: l.name, type: l.type }));
  }
}

// describeError pulls Google's own message out of a JSON error envelope, so the
// node shows "Invalid grant" rather than a wall of JSON. Falls back to the raw
// text when the body isn't the shape we expect.
function describeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.message) return parsed.error.message;
    if (parsed.error_description) return parsed.error_description;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.trim() || "(no response body)";
}
