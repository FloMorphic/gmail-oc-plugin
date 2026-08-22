// Command gmail-oc is a FloMorphic plugin node for Gmail, over OpenConnector.
//
// It exposes four actions on the workflow canvas — send an email, search
// messages, get a message, and modify a message's labels — but holds NO Gmail
// credentials and makes NO Google calls. A Gmail account is connected once,
// centrally, in FloMorphic → Connect (via OpenConnector / oomol). This plugin is
// a request builder: its settings dialog picks which connected account to act as
// (by alias), and every action asks the FloMorphic backend, over NATS, to run the
// matching OpenConnector action as that account. The backend holds the credential.
//
// Because it reaches FloMorphic's central services (the `flomorphic.svc.oc.*`
// subjects), this plugin must run with an OPEN (multi) runtime credential — a
// strict, plugin-scoped credential cannot publish there. See the README.

import { newPlugin, withDotEnv, withTimeout } from "@inflowenger/node-plugin-sdk";
import { Registry } from "./actions/registry.js";

// The proxy round-trip for a search (OC fetch_emails) is a list + up to 20
// per-message reads on the backend, well past the SDK's 5s default. Set the
// send deadline above the backend's 60s upstream ceiling so a slow reply
// arrives as a real result/error, not a bare NATS "TIMEOUT".
const SEND_TIMEOUT_SECONDS = 19;

const version = "v0.1.1";

async function main() {
  const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";

  // The dotenv carries the platform identity only — PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. No Gmail or Google configuration ever lives here.
  const p = await newPlugin(withDotEnv(envFile), withTimeout(SEND_TIMEOUT_SECONDS));

  // The registry sends its account/action requests over the plugin's NATS
  // connection (p.send: request/reply with retry).
  const registry = new Registry((subject, data) => p.send(subject, data));

  p.intro({
    name: "Gmail (OpenConnector)",
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
  console.log(`gmail-oc plugin ${version} ready with ${actions.length} actions: ${methods}`);
  console.log("gmail-oc: this node acts as a Gmail account connected in FloMorphic → Connect");
  console.log("gmail-oc: requests are proxied over flomorphic.svc.oc.* — needs an OPEN runtime credential");

  // start() only wires up subscriptions; the process has to stay alive to serve
  // them.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
