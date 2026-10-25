import nodemailer from "nodemailer";
import { db } from "./db.js";
import { openSecret, sealSecret } from "./secrets.js";

/**
 * Outbound mail.
 *
 * Every message is written to the `emails` outbox first, then handed to the
 * transport that applies to that workspace. A workspace can configure its own
 * SMTP submission server from Settings → Email server; until it does, the
 * deployment's environment configuration is used. With neither, the message
 * stays in the outbox with status `queued`, so the product still works end to
 * end in a demo or air-gapped install and an operator can inspect exactly what
 * would have been sent. Supported transports:
 *
 *   smtp      SMTP_HOST (Stalwart, Postfix, any submission server) or the
 *             workspace's own row in tenant_mail
 *   resend    RESEND_API_KEY
 *   postmark  POSTMARK_TOKEN
 *   sendgrid  SENDGRID_API_KEY
 *
 * `MAIL_TRANSPORT` forces one of them (`smtp`/`stalwart`, `resend`, `postmark`,
 * `sendgrid`) or `outbox` to disable delivery. Without it a configured
 * `SMTP_HOST` wins, then the HTTPS providers in the order listed above.
 */

const FROM = process.env.MAIL_FROM || "Clearpath <no-reply@denovocredit.com>";
const REPLY_TO = process.env.MAIL_REPLY_TO || "";
const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 4;
const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ""));
const falsy = (value) => /^(0|false|no|off)$/i.test(String(value || ""));

/**
 * Deployment-level settings. Stalwart's defaults are mirrored here: implicit
 * TLS on 465 (`SMTP_SECURE=1`) or STARTTLS on 587 (the default).
 * `SMTP_STARTTLS=0` exists for a trusted local relay only — it lets the
 * password cross the wire in the clear.
 */
const ENV_CONFIG = (() => {
  const secure = truthy(process.env.SMTP_SECURE);
  const smtp = {
    host: String(process.env.SMTP_HOST || "").trim(),
    port: Number(process.env.SMTP_PORT || 0) || (secure ? 465 : 587),
    secure,
    starttls: !falsy(process.env.SMTP_STARTTLS),
    user: String(process.env.SMTP_USER || "").trim(),
    pass: String(process.env.SMTP_PASS || "")
  };
  const smtpConfigured = Boolean(smtp.host);
  const forced = String(process.env.MAIL_TRANSPORT || "").toLowerCase();
  let transport = "outbox";
  if (forced === "outbox" || forced === "none") transport = "outbox";
  else if ((forced === "smtp" || forced === "stalwart") && smtpConfigured) transport = "smtp";
  else if (forced === "resend" && process.env.RESEND_API_KEY) transport = "resend";
  else if (forced === "postmark" && process.env.POSTMARK_TOKEN) transport = "postmark";
  else if (forced === "sendgrid" && process.env.SENDGRID_API_KEY) transport = "sendgrid";
  else if (smtpConfigured) transport = "smtp";
  else if (process.env.RESEND_API_KEY) transport = "resend";
  else if (process.env.POSTMARK_TOKEN) transport = "postmark";
  else if (process.env.SENDGRID_API_KEY) transport = "sendgrid";
  return { transport, source: "environment", smtp, from: FROM };
})();

/** Kept for boot logging and callers that only look at the deployment. */
export const transport = ENV_CONFIG.transport;
export const mailConfigured = transport !== "outbox";

/** The workspace's saved row, whether or not it is switched on. */
export function tenantMailRow(tenantId) {
  if (!tenantId) return null;
  return db.prepare("SELECT * FROM tenant_mail WHERE tenant_id = ?").get(Number(tenantId)) || null;
}

function workspaceConfig(row) {
  if (!row || !row.enabled) return null;
  return {
    transport: "smtp",
    source: "workspace",
    smtp: {
      host: String(row.host || "").trim(),
      port: Number(row.port) || 587,
      secure: Boolean(row.secure),
      starttls: Boolean(row.starttls),
      user: String(row.username || "").trim(),
      pass: openSecret(row.password_sealed)
    },
    from: String(row.from_address || "").trim() || FROM
  };
}

const configCache = new Map();

/** Resolve the transport for one workspace, falling back to the deployment. */
export function mailConfigFor(tenantId) {
  if (!tenantId) return ENV_CONFIG;
  const row = tenantMailRow(tenantId);
  if (!row) return ENV_CONFIG;
  const stamp = [
    row.updated_at, row.enabled, row.host, row.port, row.secure, row.starttls,
    row.username, row.password_sealed, row.from_address
  ].join("|");
  const key = Number(tenantId);
  const hit = configCache.get(key);
  if (hit && hit.stamp === stamp) return hit.config;
  const config = workspaceConfig(row) || ENV_CONFIG;
  configCache.set(key, { stamp, config });
  return config;
}

export function mailConfiguredFor(tenantId) {
  return mailConfigFor(tenantId).transport !== "outbox";
}

export function mailStatus(tenantId = null) {
  const config = mailConfigFor(tenantId);
  const smtp = config.smtp || {};
  const row = tenantMailRow(tenantId);
  return {
    transport: config.transport,
    from: config.from,
    configured: config.transport !== "outbox",
    source: config.source,
    server: config.transport === "smtp" ? `${smtp.host}:${smtp.port}` : "",
    security:
      config.transport === "smtp" ? (smtp.secure ? "implicit TLS" : smtp.starttls ? "STARTTLS" : "no TLS") : "",
    auth: config.transport === "smtp" ? (smtp.user ? `SMTP AUTH as ${smtp.user}` : "no SMTP AUTH") : "",
    workspace: row
      ? {
          host: row.host,
          port: row.port,
          secure: Boolean(row.secure),
          starttls: Boolean(row.starttls),
          username: row.username || "",
          from: row.from_address || "",
          enabled: Boolean(row.enabled),
          hasPassword: Boolean(row.password_sealed),
          updated_at: row.updated_at,
          updated_by: row.updated_by || ""
        }
      : null
  };
}

/**
 * Save the workspace's SMTP server. A blank password keeps the one already on
 * file, so the form never has to round-trip a secret through the browser.
 */
export function saveMailSettings({
  tenantId,
  host,
  port,
  secure = false,
  starttls = true,
  username = "",
  password = "",
  from = "",
  enabled = true,
  updatedBy = "agency owner"
}) {
  const existing = tenantMailRow(tenantId);
  const sealed = password ? sealSecret(password) : existing?.password_sealed || "";
  db.prepare(
    `INSERT INTO tenant_mail
       (tenant_id, host, port, secure, starttls, username, password_sealed, from_address, enabled, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       host = excluded.host, port = excluded.port, secure = excluded.secure,
       starttls = excluded.starttls, username = excluded.username,
       password_sealed = excluded.password_sealed, from_address = excluded.from_address,
       enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(
    Number(tenantId),
    String(host).trim().slice(0, 160),
    Number(port),
    secure ? 1 : 0,
    starttls ? 1 : 0,
    String(username || "").trim().slice(0, 160),
    sealed,
    String(from || "").trim().slice(0, 180),
    enabled ? 1 : 0,
    new Date().toISOString(),
    String(updatedBy || "").slice(0, 80)
  );
  configCache.delete(Number(tenantId));
}

export function clearMailSettings(tenantId) {
  db.prepare("DELETE FROM tenant_mail WHERE tenant_id = ?").run(Number(tenantId));
  configCache.delete(Number(tenantId));
}

const smtpClients = new Map();

function smtpTransporter(smtp) {
  const key = [smtp.host, smtp.port, smtp.secure, smtp.starttls, smtp.user, smtp.pass].join("|");
  let client = smtpClients.get(key);
  if (!client) {
    client = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.secure ? {} : smtp.starttls ? { requireTLS: true } : { ignoreTLS: true }),
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
      tls: { minVersion: "TLSv1.2" },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS
    });
    smtpClients.set(key, client);
  }
  return client;
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

async function deliverWithProvider(config, { to, subject, text, html }) {
  if (config.transport === "smtp") {
    await smtpTransporter(config.smtp).sendMail({
      from: config.from,
      to,
      subject,
      text,
      html,
      ...(REPLY_TO ? { replyTo: REPLY_TO } : {})
    });
    return "smtp";
  }
  if (config.transport === "resend") {
    await postJson(
      "https://api.resend.com/emails",
      { authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      { from: config.from, to: [to], subject, text, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}) }
    );
    return "resend";
  }
  if (config.transport === "postmark") {
    await postJson(
      "https://api.postmarkapp.com/email",
      { "x-postmark-server-token": process.env.POSTMARK_TOKEN },
      {
        From: config.from,
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
  if (config.transport === "sendgrid") {
    await postJson(
      "https://api.sendgrid.com/v3/mail/send",
      { authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      {
        personalizations: [{ to: [{ email: to }] }],
        from: {
          email: (config.from.match(/<([^>]+)>/)?.[1] || config.from).trim(),
          name: config.from.replace(/<[^>]+>/, "").trim() || "Clearpath"
        },
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
  const config = mailConfigFor(row.tenant_id);
  const attempts = row.attempts + 1;
  const stamp = new Date().toISOString();

  if (config.transport === "outbox") {
    // No transport: keep it queued and countable, but do not burn retries.
    db.prepare("UPDATE emails SET status = 'queued', provider = NULL, error = NULL WHERE id = ?").run(row.id);
    return db.prepare("SELECT * FROM emails WHERE id = ?").get(row.id);
  }

  try {
    const provider = await deliverWithProvider(config, {
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
    ).run(config.transport, String(err?.message || err).slice(0, 400), attempts, stamp, row.id);
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
  if (!mailConfiguredFor(tenantId)) {
    console.log(`Clearpath mail queued (no transport configured): ${cleanTo} · ${kind}${link ? ` · ${link}` : ""}`);
  }
  return row;
}

/** Retry failures with a simple linear backoff. Called on boot and on an interval. */
export async function retryPending(limit = 25) {
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
