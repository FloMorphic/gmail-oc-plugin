// Rewrite {{$...}} tokens in free-text inputs against the flow scope, so a
// subject, recipient or query can reference upstream data the same way. The
// Node port of the Go plugin's vars.go.

import type { Job } from "@inflowenger/node-plugin-sdk";

// {{ $.a.b }} — capture the JSON path inside the mustaches.
const VAR_RE = /\{\{\s*(\$[^}]+?)\s*\}\}/g;

const decoder = new TextDecoder();

/**
 * Substitute every {{$...}} token in the string values of a decoded action
 * input against the flow context. Tokens the scope can't supply are left
 * verbatim so nothing is silently dropped. Each distinct path is fetched from
 * the runtime only once per call, however many fields reference it.
 *
 * Walks the top-level fields only — the flat shape every action's form produces
 * — rewriting `string` and `string[]` fields in place.
 */
export async function resolveInputVars<T extends Record<string, unknown>>(
  job: Job,
  input: T,
): Promise<void> {
  const cache = new Map<string, string>();

  const resolve = async (text: string): Promise<string> => {
    if (!text.includes("{{")) return text;
    // Collect each token's path, resolve (with caching), then splice back in.
    const matches = [...text.matchAll(VAR_RE)];
    let out = text;
    for (const m of matches) {
      const path = m[1].trim();
      let value = cache.get(path);
      if (value === undefined) {
        value = await fetch(job, path);
        cache.set(path, value);
      }
      out = out.replace(m[0], value);
    }
    return out;
  };

  for (const key of Object.keys(input)) {
    const value = input[key];
    if (typeof value === "string") {
      (input as Record<string, unknown>)[key] = await resolve(value);
    } else if (Array.isArray(value)) {
      const arr = value as unknown[];
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === "string") arr[i] = await resolve(arr[i] as string);
      }
    }
  }
}

// fetch reads a JSON path from the flow context. The reply is JSON: a JSON
// string is unwrapped to its value, anything else is returned raw so it can be
// inlined into the field.
async function fetch(job: Job, jsonPath: string): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = await job.cmdGetScope(jsonPath);
  } catch {
    return `{{${jsonPath}}}`; // leave the token in place
  }
  if (!raw || raw.length === 0) return `{{${jsonPath}}}`;
  const text = decoder.decode(raw);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON — return the raw bytes as text
  }
  return text;
}
