// Compose an RFC 2822 message and read one back. Gmail's REST API takes and
// returns messages as base64url of the raw wire bytes, so send() builds a header
// block + body here and get() decodes the headers Gmail parsed back out.

/** Fields the Send action collects. Recipients may be a single address or a
 * comma-separated list. */
export interface Outgoing {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Send the body as text/html rather than text/plain. */
  html?: boolean;
}

/** Build the raw RFC 2822 bytes of an outgoing message, base64url-encoded the
 * way Gmail's `messages.send` wants them. */
export function buildRawMessage(msg: Outgoing): string {
  const headers: string[] = [];
  if (msg.from && msg.from.trim() !== "") headers.push(`From: ${msg.from.trim()}`);
  headers.push(`To: ${msg.to.trim()}`);
  if (msg.cc && msg.cc.trim() !== "") headers.push(`Cc: ${msg.cc.trim()}`);
  if (msg.bcc && msg.bcc.trim() !== "") headers.push(`Bcc: ${msg.bcc.trim()}`);
  headers.push(`Subject: ${encodeHeaderWord(msg.subject)}`);
  headers.push("MIME-Version: 1.0");
  const contentType = msg.html ? "text/html" : "text/plain";
  headers.push(`Content-Type: ${contentType}; charset="UTF-8"`);
  headers.push("Content-Transfer-Encoding: base64");

  // Body is base64 in 76-char lines so a long line can't break the SMTP wire.
  const body = wrap(Buffer.from(msg.body, "utf-8").toString("base64"), 76);
  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  return base64url(Buffer.from(raw, "utf-8"));
}

// encodeHeaderWord makes a header value safe when it carries non-ASCII (a
// subject with an accent or emoji), per RFC 2047 encoded-word. Pure-ASCII
// values are left as-is so common subjects stay readable on the wire.
function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines.join("\r\n");
}

/** base64url, no padding — the alphabet Gmail's `raw` field uses. */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(data: string): Buffer {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

/** A Gmail message payload, as the REST API returns it under `payload`. */
interface Payload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: Payload[];
}

/** A parsed, human-shaped view of a fetched message. */
export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  headers: Record<string, string>;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

/** Flatten Gmail's `format=full` message into headers + a best-effort text body. */
export function parseMessage(raw: Record<string, unknown>): ParsedMessage {
  const payload = (raw.payload ?? {}) as Payload;
  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) {
    // Header names are case-insensitive; lower-case keys make lookup predictable.
    headers[h.name.toLowerCase()] = h.value;
  }
  return {
    id: String(raw.id ?? ""),
    threadId: String(raw.threadId ?? ""),
    labelIds: Array.isArray(raw.labelIds) ? (raw.labelIds as string[]) : [],
    snippet: String(raw.snippet ?? ""),
    headers,
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    subject: headers["subject"] ?? "",
    date: headers["date"] ?? "",
    body: extractText(payload),
  };
}

// extractText walks the MIME tree for the first text/plain part, falling back to
// text/html, then to whatever body the top level carries. Good enough to surface
// the message content in the flow; not a full MIME parser.
function extractText(payload: Payload): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return plain;
  const html = findPart(payload, "text/html");
  if (html) return html;
  if (payload.body?.data) return base64urlDecode(payload.body.data).toString("utf-8");
  return "";
}

function findPart(payload: Payload, mimeType: string): string {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return base64urlDecode(payload.body.data).toString("utf-8");
  }
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return "";
}
