// Command gmail-plugin is an Inflowenger plugin node for Gmail.
//
// It exposes four actions on the workflow canvas — send an email, search
// messages, get a message, and modify a message's labels — over a Gmail account
// the platform ships with every call as a settings profile (body.settings).
//
// The plugin holds no Gmail configuration. It declares what an account needs
// (see the settings form), and the platform stores that as a named settings
// profile and folds the values into every call — so one running plugin can serve
// many mailboxes and rotating a token needs no redeploy.

import { newPlugin, withDotEnv } from "@inflowenger/node-plugin-sdk";
import { Registry } from "./actions/registry.js";
import { hasBuiltinApp } from "./gmail/settings.js";

const version = "v0.1.0";

async function main() {
  const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";

  // The dotenv carries the platform identity only — PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. Gmail credentials never live here.
  const p = await newPlugin(withDotEnv(envFile));

  const registry = new Registry();

  p.intro({
    name: "GMAIL",
    author: "FloMorphic",
    version,
    settings: registry.settingsForm(),
  });
  p.requiredParams(registry.settings());

  const actions = registry.all();
  p.addAction(...actions);
  p.addMeta(...registry.metas());

  p.start();

  const methods = actions.map((a) => a.method).join(", ");
  console.log(`gmail plugin ${version} ready with ${actions.length} actions: ${methods}`);
  console.log("gmail plugin: each call brings its own account in body.settings — bind a settings profile to the node");
  console.log(
    hasBuiltinApp()
      ? "gmail plugin: built-in Google OAuth client configured — users just Sign in with Google (PKCE)"
      : "gmail plugin: no built-in Google client (GOOGLE_OAUTH_CLIENT_ID unset) — each profile must paste its own credentials JSON",
  );

  // start() only wires up subscriptions; the process has to stay alive to serve
  // them.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
