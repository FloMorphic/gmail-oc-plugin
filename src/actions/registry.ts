// Wires the plugin's node actions (send, search, get, modify) and the two settings
// meta RPCs (list accounts, test account) onto FloMorphic's OpenConnector service
// over NATS. This plugin is a pure request builder: it holds no Gmail credentials
// and makes no Google calls. Each action builds an input payload and asks the
// FloMorphic backend to run the corresponding OpenConnector action as the chosen
// connected account; the backend holds the credential (see ../oc/client.ts).

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
import type { Msg } from "nats";

import { Oc } from "../oc/client.js";
import { resolveInputVars } from "./vars.js";
import { getForm, modifyForm, searchForm, sendForm, settingsForm } from "./forms.js";

// The one thing the plugin binds per canvas action: the OpenConnector Gmail
// action name it proxies to (POST /v1/actions/gmail.<oc>). The action FORMS
// (forms.ts) use OpenConnector's own input field names, so input passes straight
// through. The REQUIRED SCOPES are NOT hardcoded here — they are read live from
// oomol's catalog (Oc.requiredScopes → GET /v1/actions/gmail.<oc>) and checked
// against the chosen account before executing, so oomol stays authoritative.
//
// Confirmed against GET /v1/actions?service=gmail: send→send_email,
// search→fetch_emails, get→get_message. TODO(modify): the label-modify action
// was past the truncated catalog — verify its name against your gateway.
type ActionKey = "send" | "search" | "get" | "modify";
const OC_ACTION: Record<ActionKey, string> = {
  send: "send_email",
  search: "fetch_emails",
  get: "get_message",
  modify: "modify_message_labels",
};

export class Registry {
  private readonly oc: Oc;

  constructor(send: (subject: string, data: Uint8Array) => Promise<Msg | undefined>) {
    this.oc = new Oc(send);
  }

  /** Every action this plugin exposes, in the order the canvas shows them. */
  all(): Action[] {
    return [this.send(), this.search(), this.get(), this.modify()];
  }

  /** The settings meta RPCs: list the connected accounts, and test an alias. */
  metas(): Meta[] {
    return [
      { method: "gmail.meta.account.list", requestHandler: (req) => this.metaAccountList(req) },
      { method: "gmail.meta.account.test", requestHandler: (req) => this.metaAccountTest(req) },
    ];
  }

  /** The settings profile: the form plus the submit handler that validates it. */
  settings(): Settings {
    return { ...settingsForm, submitHandler: async (req) => this.settingsSubmit(req) };
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
      description: "Send an email from the connected Gmail account (via OpenConnector).",
      icon: { icon: "mdi-email-send" },
      form: sendForm,
      requestHandler: this.run("Sending email", "send"),
    };
  }

  private search(): Action {
    return {
      method: "gmail.search",
      title: "Search messages",
      description: "Find messages with Gmail search syntax (via OpenConnector).",
      icon: { icon: "mdi-email-search" },
      form: searchForm,
      requestHandler: this.run("Searching messages", "search"),
    };
  }

  private get(): Action {
    return {
      method: "gmail.get",
      title: "Get message",
      description: "Fetch one message in full (via OpenConnector).",
      icon: { icon: "mdi-email-open" },
      form: getForm,
      requestHandler: this.run("Fetching message", "get"),
    };
  }

  private modify(): Action {
    return {
      method: "gmail.modify",
      title: "Modify labels",
      description: "Add and/or remove labels on a message (via OpenConnector).",
      icon: { icon: "mdi-label" },
      form: modifyForm,
      requestHandler: this.run("Modifying labels", "modify"),
    };
  }

  // run adapts an action into an SDK job handler: decode the body + its bound
  // settings profile (which carries the account alias), resolve {{$...}} tokens,
  // RESOLVE the chosen account and CHECK it has the capability this action needs,
  // then ask the backend to run the OpenConnector action as that account. The
  // plugin builds and vets the request; FloMorphic only proxies it.
  private run(title: string, key: ActionKey): (job: Job) => Promise<void> {
    const ocAction = OC_ACTION[key];
    return async (job: Job) => {
      let input: Record<string, unknown>;
      let alias: string;
      let connection: string;
      try {
        const req = castRequestTo<Record<string, unknown> & { settings?: Record<string, unknown> }>(job.req.data);
        input = { ...(req.body ?? {}) };
        const settings = (input.settings as Record<string, unknown>) ?? {};
        alias = str(settings.alias);
        connection = str(settings.connection);
        delete input.settings; // the account travels separately, not as action input
      } catch (e) {
        await job.doneWithError(errText(e));
        return;
      }

      try {
        await resolveInputVars(job, input);

        // Resolve the account and verify it can do this action, in the plugin —
        // a wrong or under-scoped account fails here with a clear message rather
        // than a raw gateway error.
        const account = await this.oc.resolve(alias || undefined, connection || undefined);
        if (!account) {
          throw new Error(
            alias
              ? `no connected Gmail account with alias "${alias}" — pick one in the node's settings`
              : "no Gmail account connected in FloMorphic → Connect",
          );
        }
        // Ask oomol what this action requires, then check the account has it.
        // Skip only when neither side is known (empty), leaving oomol as the gate.
        const requiredScopes = await this.oc.requiredScopes(ocAction, connection || undefined);
        if (account.scopes.length > 0 && requiredScopes.length > 0) {
          const missing = requiredScopes.filter((s) => !account.scopes.includes(s));
          if (missing.length > 0) {
            throw new Error(
              `the account "${account.accountLabel}" lacks the ${missing.map((s) => `"${s}"`).join(", ")} capability needed to ${title.toLowerCase()} — reconnect it in FloMorphic → Connect with that scope`,
            );
          }
        }

        await job.progress(20, { title, content: `as ${account.accountLabel || account.alias}` });
        const data = await this.oc.run(ocAction, account.alias, input, connection || undefined);
        await job.progress(90, { title, content: "done" });
        await job.done((data as Record<string, unknown>) ?? { ok: true });
      } catch (e) {
        await job.doneWithError(errText(e));
      }
    };
  }

  // --------------------------------------------------------------- metas --

  // metaAccountList backs the settings form's "Load accounts" button: it asks the
  // backend for the Gmail accounts connected in FloMorphic → Connect and REBUILDS
  // the "alias" field into a drop-down of them (value = alias, label = the email).
  // The user picks — nothing to type.
  private async metaAccountList(req: Request): Promise<unknown> {
    const body = decodeMeta(req.data);
    const connection = str(pick(body, "connection"));
    try {
      const accounts = await this.oc.accounts(connection || undefined);
      if (accounts.length === 0) {
        return formkit
          .warning("No Gmail account connected. Connect one in FloMorphic → Connect, then retry.")
          .about("alias")
          .patch(null);
      }
      const options = accounts.map((a) => ({
        value: a.alias,
        label: `${a.accountLabel || a.service}${a.isDefault ? "  (default)" : ""}`,
      }));
      // Rebuild the dialog with `alias` as a drop-down of the connected accounts.
      return formkit.choose(
        settingsForm,
        "alias",
        options,
        formkit.formData(body),
        formkit.success("%s connected Gmail account(s) — pick one:", accounts.length).about("alias"),
      );
    } catch (e) {
      return formkit.failure("%s", errText(e)).about("alias").patch(null);
    }
  }

  // metaAccountTest backs "Test account" and the submit validation: it resolves
  // the alias (or the default account) so a wrong alias is caught in the dialog.
  private async metaAccountTest(req: Request): Promise<unknown> {
    const body = connFrom(decodeMeta(req.data));
    const alias = str(body.alias);
    const connection = str(body.connection);
    try {
      const acc = await this.oc.resolve(alias || undefined, connection || undefined);
      if (!acc) {
        return formkit
          .failure(alias ? `No connected Gmail account with alias "${alias}".` : "No Gmail account connected.")
          .patch(null);
      }
      return formkit
        .success("Resolved %s (alias %s)%s.", acc.accountLabel || acc.service, acc.alias, acc.isDefault ? " — default" : "")
        .patch(null);
    } catch (e) {
      return formkit.failure("%s", errText(e)).patch(null);
    }
  }

  // settingsSubmit validates a profile on save: the chosen account must resolve.
  private async settingsSubmit(req: Request): Promise<Response> {
    const body = connFrom(decodeMeta(req.data));
    const alias = str(body.alias);
    const connection = str(body.connection);
    try {
      const acc = await this.oc.resolve(alias || undefined, connection || undefined);
      if (!acc) {
        return {
          error: alias
            ? `No connected Gmail account with alias "${alias}". Press List accounts.`
            : "No Gmail account connected in FloMorphic → Connect.",
        };
      }
      return { data: { ok: true, account: acc.accountLabel, alias: acc.alias } };
    } catch (e) {
      return { error: errText(e) };
    }
  }
}

// connFrom pulls the profile values out of a meta/submit call. On an action's
// drawer the bound profile is under "settings"; the set-up dialog has no bound
// profile and sends the edited values at the top level, alongside host keys.
function connFrom(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body["settings"];
  if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
    return nested as Record<string, unknown>;
  }
  const conn = { ...body };
  for (const hostKey of ["settings", "value", "targetField", "form"]) delete conn[hostKey];
  return conn;
}

// decodeMeta reads a meta RPC's arguments, tolerating the {_registry, body}
// envelope or a bare object, and treating anything unreadable as "no arguments".
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

function pick(body: Record<string, unknown>, key: string): unknown {
  const nested = body["settings"];
  if (nested && typeof nested === "object" && key in (nested as object)) {
    return (nested as Record<string, unknown>)[key];
  }
  return body[key];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
