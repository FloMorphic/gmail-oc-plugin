// Wires the Gmail client onto the plugin's node actions — send, search, get and
// modify — plus the meta RPCs the forms use (a connection test and a label
// lister). The registry owns what the actions share: the pool that turns each
// call's settings profile into an authenticated client. The plugin holds no
// Gmail configuration of its own.

import {
  castRequestTo,
  formkit,
  type Action,
  type Job,
  type Meta,
  type Request,
  type Response,
  type Settings,
} from "@inflowenger/node-plugin-sdk";

import { Pool, parseApp } from "../gmail/settings.js";
import { buildConsentUrl, exchangeCode, generatePkce } from "../gmail/oauth.js";
import type { GmailClient } from "../gmail/client.js";
import type { Outgoing } from "../gmail/mime.js";
import { resolveInputVars } from "./vars.js";
import {
  getForm,
  modifyForm,
  searchForm,
  sendForm,
  settingsForm,
} from "./forms.js";

export class Registry {
  private readonly pool = new Pool();

  /** Every action this plugin exposes, in the order the canvas shows them. */
  all(): Action[] {
    return [this.send(), this.search(), this.get(), this.modify()];
  }

  /** The synchronous helper RPCs the forms call outside the job lifecycle. */
  metas(): Meta[] {
    return [
      { method: "gmail.meta.oauth.url", requestHandler: (req) => this.metaOAuthUrl(req) },
      { method: "gmail.meta.oauth.exchange", requestHandler: (req) => this.metaOAuthExchange(req) },
      { method: "gmail.meta.ping.check", requestHandler: (req) => this.metaPingCheck(req) },
      { method: "gmail.meta.labels.pick", requestHandler: (req) => this.metaLabelsPick(req) },
    ];
  }

  /** The settings profile: the form plus the submit handler that validates it. */
  settings(): Settings {
    return {
      ...settingsForm,
      submitHandler: async (req) => this.settingsSubmit(req),
    };
  }

  /** The same form for PluginIntro.settings — the plugin set-up dialog reads it. */
  settingsForm() {
    return settingsForm;
  }

  // ------------------------------------------------------------- actions --

  private send(): Action {
    return {
      method: "gmail.send",
      title: "Send email",
      description: "Send an email from the connected Gmail account.",
      icon: { icon: "mdi-email-send" },
      form: sendForm,
      requestHandler: this.run<Outgoing>("Sending email", async (job, client, input) => {
        if (!input.to?.trim()) throw new Error('"To" is required');
        const res = await client.send(input);
        return { sent: true, id: res.id, threadId: res.threadId, labelIds: res.labelIds };
      }),
    };
  }

  private search(): Action {
    return {
      method: "gmail.search",
      title: "Search messages",
      description: "Find messages with Gmail search syntax; returns lightweight summaries.",
      icon: { icon: "mdi-email-search" },
      form: searchForm,
      requestHandler: this.run<{ q?: string; maxResults?: number }>(
        "Searching messages",
        async (job, client, input) => {
          const results = await client.search(input.q ?? "", input.maxResults ?? 25);
          return { count: results.length, messages: results };
        },
      ),
    };
  }

  private get(): Action {
    return {
      method: "gmail.get",
      title: "Get message",
      description: "Fetch one message in full — headers and a text body.",
      icon: { icon: "mdi-email-open" },
      form: getForm,
      requestHandler: this.run<{ id: string }>("Fetching message", async (job, client, input) => {
        if (!input.id?.trim()) throw new Error('"Message id" is required');
        const message = await client.get(input.id.trim());
        return { message } as unknown as Record<string, unknown>;
      }),
    };
  }

  private modify(): Action {
    return {
      method: "gmail.modify",
      title: "Modify labels",
      description: "Add and/or remove labels on a message (mark read, archive, star, trash).",
      icon: { icon: "mdi-label" },
      form: modifyForm,
      requestHandler: this.run<{ id: string; addLabelIds?: string[]; removeLabelIds?: string[] }>(
        "Modifying labels",
        async (job, client, input) => {
          if (!input.id?.trim()) throw new Error('"Message id" is required');
          const res = await client.modify(
            input.id.trim(),
            input.addLabelIds ?? [],
            input.removeLabelIds ?? [],
          );
          return { id: res.id, labelIds: res.labelIds };
        },
      ),
    };
  }

  // run adapts a typed handler into an SDK job handler: decode the body and the
  // connection that came with it, resolve the client, resolve {{$...}} tokens,
  // report progress, and terminate the job exactly once on every path.
  private run<T extends object>(
    title: string,
    fn: (job: Job, client: GmailClient, input: T) => Promise<Record<string, unknown>>,
  ): (job: Job) => Promise<void> {
    return async (job: Job) => {
      let input: T;
      let client: GmailClient;
      try {
        const req = castRequestTo<T & { settings?: Record<string, unknown> }>(job.req.data);
        input = req.body;
        client = this.pool.client(req.body?.settings);
      } catch (e) {
        await job.doneWithError(errText(e));
        return;
      }

      try {
        // Rewrite {{$...}} tokens in every string/[]string field against scope.
        await resolveInputVars(job, input as Record<string, unknown>);
        await job.progress(20, { title, content: "on " + client.connInfo() });
        const out = await fn(job, client, input);
        await job.progress(90, { title, content: "done" });
        await job.done(out);
      } catch (e) {
        await job.doneWithError(errText(e));
      }
    };
  }

  // --------------------------------------------------------------- metas --

  // metaOAuthUrl backs the settings form's "Get consent URL" button. It resolves
  // the OAuth client (the built-in shared client, or the one the user pasted — no
  // token needed yet), generates a fresh PKCE pair, and builds the consent link.
  // It patches the link into authUrl and the verifier into pkceVerifier, so the
  // verifier round-trips in the form to the Authorize step that must present it.
  private async metaOAuthUrl(req: Request): Promise<unknown> {
    const conn = connFrom(decodeMeta(req.data));
    try {
      const app = parseApp(conn);
      const pkce = generatePkce();
      const url = buildConsentUrl(app, pkce.challenge);
      return formkit
        .success("Open this URL, grant access, then paste the code below:\n%s", url)
        .about("authUrl")
        .patch({ authUrl: url, pkceVerifier: pkce.verifier });
    } catch (e) {
      return formkit.failure("%s", errText(e)).about("authUrl").patch(null);
    }
  }

  // metaOAuthExchange backs the "Authorize" button. It trades the pasted
  // authorization code (or the whole redirected URL) for a refresh token,
  // presenting the PKCE verifier generated in the Get-consent-URL step, and
  // patches the token into the profile's refreshToken field — the plugin obtains
  // the token so the user never has to.
  private async metaOAuthExchange(req: Request): Promise<unknown> {
    const body = connFrom(decodeMeta(req.data));
    // The button posts the field's own contents as `value`; fall back to authCode.
    const raw = strField(body, "value") || strField(body, "authCode");
    const code = extractCode(raw);
    if (code === "") {
      return formkit
        .warning("paste the authorization code (or the http://localhost/?code=… URL) first")
        .about("authCode")
        .patch(null);
    }
    const verifier = strField(body, "pkceVerifier");
    if (verifier === "") {
      return formkit
        .warning("press Get consent URL first — the PKCE verifier from that step is missing")
        .about("authCode")
        .patch(null);
    }
    try {
      const app = parseApp(body);
      const tokens = await exchangeCode(app, code, verifier);
      // Clear the one-time code and verifier; write the refresh token in.
      return formkit
        .success("Authorized — refresh token stored. Press Test connection to confirm.")
        .about("authCode")
        .patch({ refreshToken: tokens.refreshToken, authCode: "", pkceVerifier: "" });
    } catch (e) {
      return formkit.failure("%s", errText(e)).about("authCode").patch(null);
    }
  }

  // metaPingCheck backs the settings form's "Test connection" button and its
  // submit validation. It reads the mailbox profile and asks Gmail for it, so a
  // wrong credential is reported in the dialog instead of failing every node.
  private async metaPingCheck(req: Request): Promise<unknown> {
    const body = decodeMeta(req.data);
    const conn = connFrom(body);
    try {
      const client = this.pool.client(conn);
      const profile = await client.getProfile();
      return formkit
        .success("Connected as %s — %s messages.", profile.emailAddress, profile.messagesTotal)
        .patch(null);
    } catch (e) {
      return formkit.failure("%s", errText(e)).patch(null);
    }
  }

  // metaLabelsPick backs the modify form's "Load labels" button. It lists the
  // mailbox's labels as a message so the user can copy the ids into the add /
  // remove fields — writing no value itself.
  private async metaLabelsPick(req: Request): Promise<unknown> {
    const body = decodeMeta(req.data);
    const conn = connFrom(body);
    try {
      const client = this.pool.client(conn);
      const labels = await client.labels();
      if (labels.length === 0) {
        return formkit.warning("no labels found for this mailbox").about("addLabelIds").patch(null);
      }
      const listed = labels
        .slice(0, 40)
        .map((l) => `${l.id} — ${l.name}`)
        .join("\n");
      return formkit
        .success("%s labels — copy an id into Add or Remove:\n%s", labels.length, listed)
        .about("addLabelIds")
        .patch(null);
    } catch (e) {
      return formkit.failure("%s", errText(e)).about("addLabelIds").patch(null);
    }
  }

  // settingsSubmit validates a profile on save: it authenticates and reads the
  // mailbox profile, so a wrong credential is reported in the set-up dialog.
  private async settingsSubmit(req: Request): Promise<Response> {
    const submitted = connFrom(decodeMeta(req.data));
    try {
      const client = this.pool.client(submitted);
      const profile = await client.getProfile();
      return { data: { ok: true, connectedAs: profile.emailAddress } };
    } catch (e) {
      return { error: errText(e) };
    }
  }
}

// connFrom pulls the Gmail credentials out of a meta/submit call. On an action's
// drawer the bound profile is under "settings"; the plugin set-up dialog has no
// bound profile and sends the values being edited at the top level, alongside
// the keys the host adds (which are stripped).
function connFrom(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body["settings"];
  if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
    return nested as Record<string, unknown>;
  }
  const conn = { ...body };
  for (const hostKey of ["settings", "value", "targetField", "form"]) delete conn[hostKey];
  return conn;
}

// decodeMeta reads a meta RPC's arguments. Meta calls come from the form renderer
// rather than the job pipeline, so the payload may or may not be wrapped in the
// {_registry, body} envelope — try both, and treat anything unreadable as "no
// arguments" rather than an error.
function decodeMeta(data: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(data).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed.body === "object" && parsed.body !== null) {
      return parsed.body as Record<string, unknown>;
    }
    return parsed;
  } catch {
    return {};
  }
}

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v.trim() : "";
}

// extractCode pulls the authorization code out of what the user pasted: a bare
// code, or the whole redirected URL (http://localhost/?code=…&scope=…), from
// which the `code` query parameter is read.
function extractCode(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";
  if (text.includes("://") || text.includes("?") || text.includes("code=")) {
    try {
      const url = new URL(text.includes("://") ? text : `http://localhost/${text.startsWith("?") ? text : "?" + text}`);
      const code = url.searchParams.get("code");
      if (code) return code;
    } catch {
      // fall through to treating the whole string as the code
    }
  }
  return text;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
