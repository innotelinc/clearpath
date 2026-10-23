import { db } from "./db.js";

/**
 * Outbound mail.
 *
 * Every message is written to the `emails` outbox first, then handed to the
 * configured transport. With no provider configured the message stays in the
 * outbox with status `queued`, so the product still works end to end in a
 * demo or air-gapped install and an operator can inspect exactly what would
 * have been sent. Supported transports:
 *
 *   resend    RESEND_API_KEY
 *   postmark  POSTMARK_TOKEN
 *   sendgrid  SENDGRID_API_KEY
 *
 * `MAIL_TRANSPORT` forces one of them (or `outbox` to disable delivery).
 */

const FROM = process.env.MAIL_FROM || "Clearpath <no-reply@denovocredit.com>";
const REPLY_TO = process.env.MAIL_REPLY_TO || "";
const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 4;

export const transport = (() => {
  const forced = String(process.env.MAIL_TRANSPORT || "").toLowerCase();
  if (forced === "outbox" || forced === "none") return "outbox";
  if (forced === "resend" && process.env.RESEND_API_KEY) return "resend";
  if (forced === "postmark" && process.env.POSTMARK_TOKEN) return "postmark";
  if (forced === "sendgrid" && process.env.SENDGRID_API_KEY) return "sendgrid";
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.POSTMARK_TOKEN) return "postmark";
  if (process.env.SENDGRID_API_KEY) return "sendgrid";
  return "outbox";
})();

export const mailConfigured = transport !== "outbox";

export function mailStatus() {
  return { transport, from: FROM, configured: mailConfigured };
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlShell(bodyText) {
  const paragraphs = String(bodyText)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 14px">${htmlEscape(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#101828;font-size:15px;line-height:1.55">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:28px">
    ${paragraphs}
    <p style="margin:24px 0 0;color:#98a2b3;font-size:12px">Clearpath · sent automatically, please do not reply unless a reply address is shown above.</p>
  </div></body></html>`;
}

async function postJson(url, headers, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`provider responded ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

async function deliverWithProvider({ to, subject, text, html }) {
  const reply = REPLY_TO ? { "reply-to": REPLY_TO } : {};
  if (transport === "resend") {
    await postJson(
      "https://api.resend.com/emails",
      { authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      { from: FROM, to: [to], subject, text, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}) }
    );
    return "resend";
  }
  if (transport === "postmark") {
    await postJson(
      "https://api.postmarkapp.com/email",
      { "x-postmark-server-token": process.env.POSTMARK_TOKEN },
      {
        From: FROM,
        To: to,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
        MessageStream: process.env.POSTMARK_STREAM || "outbound",
        ...(REPLY_TO ? { ReplyTo: REPLY_TO } : {})
      }
    );
    return "postmark";
  }
  if (transport === "sendgrid") {
    await postJson(
      "https://api.sendgrid.com/v3/mail/send",
      { authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: (FROM.match(/<([^>]+)>/)?.[1] || FROM).trim(), name: FROM.replace(/<[^>]+>/, "").trim() || "Clearpath" },
        ...(REPLY_TO ? { reply_to: { email: REPLY_TO } } : {}),
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html }
        ]
      }
    );
    return "sendgrid";
  }
  return null;
}

/** Attempt delivery for one outbox row. Never throws. */
export async function deliver(id) {
  const row = db.prepare("SELECT * FROM emails WHERE id = ?").get(Number(id));
  if (!row || row.status === "sent") return row;
  const attempts = row.attempts + 1;
  const stamp = new Date().toISOString();

  if (!mailConfigured) {
    // No transport: keep it queued and countable, but do not burn retries.
    db.prepare("UPDATE emails SET status = 'queued', provider = NULL, error = NULL WHERE id = ?").run(row.id);
    return db.prepare("SELECT * FROM emails WHERE id = ?").get(row.id);
  }

  try {
    const provider = await deliverWithProvider({
      to: row.to_email,
      subject: row.subject,
      text: row.body_text,
      html: htmlShell(row.body_text)
    });
    db.prepare(
      "UPDATE emails SET status = 'sent', provider = ?, error = NULL, attempts = ?, last_attempt_at = ?, sent_at = ? WHERE id = ?"
    ).run(provider, attempts, stamp, stamp, row.id);
  } catch (err) {
    db.prepare(
      "UPDATE emails SET status = 'failed', provider = ?, error = ?, attempts = ?, last_attempt_at = ? WHERE id = ?"
    ).run(transport, String(err?.message || err).slice(0, 400), attempts, stamp, row.id);
    console.error(`Clearpath mail: ${row.to_email} failed — ${err?.message || err}`);
  }
  return db.prepare("SELECT * FROM emails WHERE id = ?").get(row.id);
}

/**
 * Queue and (when a transport exists) send a message.
 * Returns the stored row so callers can tell the user whether it went out.
 */
export async function sendMail({ tenantId = null, userId = null, to, subject, kind = "notice", text, link = null, html = null }) {
  const cleanTo = String(to || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanTo)) {
    throw new Error("A valid recipient email is required");
  }
  const bodyText = String(text || "").trim();
  if (!bodyText) throw new Error("A message body is required");

  const info = db
    .prepare(
      `INSERT INTO emails (tenant_id, user_id, to_email, subject, kind, body_text, link, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`
    )
    .run(tenantId, userId, cleanTo, String(subject || "Clearpath notification").slice(0, 180), kind, bodyText, link);

  const id = Number(info.lastInsertRowid);
  const row = await deliver(id);
  if (!mailConfigured) {
    console.log(`Clearpath mail queued (no transport configured): ${cleanTo} · ${kind}${link ? ` · ${link}` : ""}`);
  }
  return row;
}

/** Retry failures with a simple linear backoff. Called on boot and on an interval. */
export async function retryPending(limit = 25) {
  if (!mailConfigured) return 0;
  const rows = db
    .prepare(
      `SELECT * FROM emails
       WHERE status = 'failed' AND attempts < ?
         AND (last_attempt_at IS NULL OR last_attempt_at < ?)
       ORDER BY id LIMIT ?`
    )
    .all(MAX_ATTEMPTS, new Date(Date.now() - 60_000).toISOString(), limit);
  for (const row of rows) await deliver(row.id);
  return rows.length;
}

export { MAX_ATTEMPTS };
