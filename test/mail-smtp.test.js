import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SMTP is the Stalwart transport, so the suite needs a submission server it
 * can talk to. This stub answers EHLO, offers AUTH PLAIN/LOGIN, accepts one
 * message and keeps whatever it was handed, which is enough to prove the
 * transport authenticates, addresses and delivers through the outbox.
 */
function startSmtpStub({ rejectAuth = false } = {}) {
  const messages = [];
  const transcript = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.write("220 stub.local ESMTP Clearpath test\r\n");

    let buffer = "";
    let inData = false;
    let data = "";
    let expecting = null;

    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(data);
            data = "";
            socket.write("250 2.0.0 queued as stub1\r\n");
          } else {
            // Undo dot-stuffing exactly as a real server would.
            data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        transcript.push(line);

        if (expecting === "user") {
          expecting = "pass";
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (expecting === "pass") {
          expecting = null;
          if (rejectAuth) {
            socket.write("535 5.7.8 Authentication credentials invalid\r\n");
          } else {
            socket.write("235 2.7.0 Authentication successful\r\n");
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-stub.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) {
          socket.write(rejectAuth ? "535 5.7.8 Authentication credentials invalid\r\n" : "235 2.7.0 Authentication successful\r\n");
        } else if (upper.startsWith("AUTH LOGIN")) {
          expecting = "user";
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM")) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          socket.write("250 2.1.5 Ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else if (upper === "RSET" || upper === "NOOP") {
          socket.write("250 2.0.0 Ok\r\n");
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });

    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        messages,
        transcript,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          })
      });
    });
  });
}

// The outbox lives in SQLite, so point it at a scratch file before the mail
// module (and db.js behind it) is imported for the first time.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-smtp-test-"));
process.env.DATA_DIR = dataDir;
process.env.DB_PATH = path.join(dataDir, "test.db");
process.env.SEED_DEMO = "0";

/**
 * Point the mail module at a stub. Must run before each import of mail.js;
 * the transport is resolved at module scope, so every case loads its own copy
 * with a query string to get a fresh evaluation.
 */
function useStub(port, overrides = {}) {
  Object.assign(process.env, {
    MAIL_TRANSPORT: "smtp",
    MAIL_FROM: "Clearpath <clearpath@example.test>",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(port),
    SMTP_SECURE: "0",
    SMTP_STARTTLS: "0",
    SMTP_USER: "clearpath@example.test",
    SMTP_PASS: "app-password",
    ...overrides
  });
}

test("the SMTP transport authenticates, delivers and records the message as sent", async () => {
  const stub = await startSmtpStub();
  useStub(stub.port);
  try {
    const mail = await import("../server/mail.js?smtp-delivery");
    assert.equal(mail.transport, "smtp", "SMTP_HOST should select the SMTP transport");
    assert.equal(mail.mailConfigured, true);

    const status = mail.mailStatus();
    assert.equal(status.server, `127.0.0.1:${stub.port}`);
    assert.equal(status.security, "no TLS");
    assert.equal(status.auth, "SMTP AUTH as clearpath@example.test");

    const row = await mail.sendMail({
      to: "jordan.alvarez@example.com",
      subject: "Your Clearpath invitation",
      kind: "credentials",
      text: "Temporary password: Sunrise!2026"
    });

    assert.equal(row.status, "sent");
    assert.equal(row.provider, "smtp");
    assert.equal(row.error, null);
    assert.ok(row.sent_at, "a delivered message records when it went out");

    assert.equal(stub.messages.length, 1, "the stub should receive exactly one message");
    const wire = stub.messages[0];
    assert.match(wire, /^From: Clearpath <clearpath@example\.test>/m);
    assert.match(wire, /^To: jordan\.alvarez@example\.com/m);
    assert.match(wire, /^Subject: Your Clearpath invitation/m);
    assert.match(wire, /Temporary password: Sunrise!2026/);
    assert.ok(
      stub.transcript.some((line) => /^MAIL FROM:<clearpath@example\.test>/.test(line)),
      "the envelope sender should be the authorised address"
    );
    assert.ok(
      stub.transcript.some((line) => /^AUTH /i.test(line)),
      "the transport should authenticate before sending"
    );
  } finally {
    await stub.close();
  }
});

test("a rejected SMTP login leaves the message failed in the outbox with the provider error", async () => {
  const stub = await startSmtpStub({ rejectAuth: true });
  useStub(stub.port, { SMTP_PASS: "wrong-password" });
  try {
    const mail = await import("../server/mail.js?smtp-auth-failure");
    const row = await mail.sendMail({
      to: "marcus@example.com",
      subject: "Reset your password",
      kind: "password-reset",
      text: "Use the link below."
    });

    assert.equal(row.status, "failed");
    assert.equal(row.provider, "smtp");
    assert.match(row.error, /Authentication|535|credentials/i);
    assert.equal(row.attempts, 1);
    assert.equal(stub.messages.length, 0, "nothing should be accepted after a rejected login");
  } finally {
    await stub.close();
  }
});
