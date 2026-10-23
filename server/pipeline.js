/**
 * Automated dispute pipeline.
 *
 * The deterministic drafter already turns a tradeline into a letter, so the
 * expensive human step is not writing — it is deciding what is safe to send.
 * This module makes that decision explicit:
 *
 *   scan()    reads every tradeline and sorts it into "ready to draft" or
 *             "needs a human", with the reason attached. The rules are the
 *             evidence floor, missing documents, onboarding gaps and data that
 *             contradicts itself.
 *   run()     drafts every ready item with the same rules the studio uses and
 *             parks each letter at status 'Ready' — never mailed.
 *   approve() turns those letters into disputes and mailroom packages, queued
 *             per client and bureau, so one person approves a batch and the
 *             mailroom prints it. Posting them stays a deliberate action.
 */
import { audit, db, nextRef } from "./db.js";
import { getClient } from "./data.js";
import { generateDraft } from "./studio.js";

export const EVIDENCE_FLOOR = 75;

const STRATEGY_BY_TYPE = {
  Collection: "fcra-611",
  "Late payment": "fcra-623",
  "Charge-off": "fcra-623",
  "Hard inquiry": "fcra-611"
};

const OPEN_STATES = ["Needs review", "Queued", "Mailed", "Awaiting response", "Escalated"];

function evidenceOf(tradeline) {
  try {
    const parsed = JSON.parse(tradeline.evidence || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Why this item cannot go out without a person looking at it. */
function exceptionReasons(tradeline) {
  const reasons = [];
  const strength = Number(tradeline.strength) || 0;
  if (strength < EVIDENCE_FLOOR) {
    reasons.push(`Evidence strength ${strength}% is under the ${EVIDENCE_FLOOR}% automation floor`);
  }
  if (!evidenceOf(tradeline).length) {
    reasons.push("No supporting document is attached to this item");
  }
  if (String(tradeline.client_stage) === "Onboarding") {
    reasons.push("Client is still onboarding — agreement or identity documents may be missing");
  }
  if (Number(tradeline.balance) > 0 && !String(tradeline.opened || "").trim()) {
    reasons.push("A balance is reported without an open date");
  }
  if (String(tradeline.reason || "").trim().length < 25) {
    reasons.push("The dispute basis is too thin to cite in a letter");
  }
  return reasons;
}

export function scanPipeline(tenantId) {
  const tradelines = db
    .prepare(
      `SELECT tr.*, c.name AS client_name, c.ref AS client_ref, c.stage AS client_stage
       FROM tradelines tr JOIN clients c ON c.id = tr.client_id
       WHERE tr.tenant_id = ? ORDER BY c.name, tr.id`
    )
    .all(tenantId);

  const candidates = [];
  const exceptions = [];
  const covered = [];

  for (const tradeline of tradelines) {
    const open = db
      .prepare(
        `SELECT id, ref, status FROM disputes
         WHERE tenant_id = ? AND tradeline_id = ? AND status IN (${OPEN_STATES.map(() => "?").join(",")})
         ORDER BY id DESC LIMIT 1`
      )
      .get(tenantId, tradeline.id, ...OPEN_STATES);
    if (open) {
      covered.push({ tradeline, label: `${open.ref} ${open.status.toLowerCase()}`, href: `/app/disputes/${open.id}` });
      continue;
    }

    const pendingDraft = db
      .prepare(
        "SELECT id, status FROM drafts WHERE tenant_id = ? AND tradeline_id = ? AND status IN ('Draft','Ready') ORDER BY id DESC LIMIT 1"
      )
      .get(tenantId, tradeline.id);
    if (pendingDraft) {
      covered.push({
        tradeline,
        label: pendingDraft.status === "Ready" ? "Letter drafted, waiting for approval" : "Draft in progress",
        href: `/app/studio/${pendingDraft.id}`
      });
      continue;
    }

    const reasons = exceptionReasons(tradeline);
    if (reasons.length) {
      exceptions.push({ tradeline, reasons });
      continue;
    }
    candidates.push({
      tradeline,
      strategy: STRATEGY_BY_TYPE[tradeline.type] || "fcra-611",
      confidence: Number(tradeline.strength) || EVIDENCE_FLOOR
    });
  }

  return {
    candidates,
    exceptions,
    covered,
    stats: {
      scanned: tradelines.length,
      ready: candidates.length,
      needsHuman: exceptions.length,
      covered: covered.length
    }
  };
}

/** Draft everything the scan cleared. Letters land as 'Ready'; nothing is mailed. */
export function runPipeline(tenant, actor) {
  const scan = scanPipeline(tenant.id);
  const created = [];
  for (const item of scan.candidates) {
    const client = getClient(tenant.id, item.tradeline.client_id);
    if (!client) continue;
    const result = generateDraft({
      tenant,
      client,
      tradeline: item.tradeline,
      strategy: item.strategy,
      tone: "Professional",
      includeEvidence: true,
      includeCitations: true
    });
    const draftId = Number(
      db
        .prepare(
          `INSERT INTO drafts (tenant_id, client_id, tradeline_id, strategy, tone, confidence, subject, body, citations, signals, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ready', ?)`
        )
        .run(
          tenant.id,
          client.id,
          item.tradeline.id,
          result.strategy,
          result.tone,
          result.confidence,
          result.subject,
          result.body,
          JSON.stringify(result.citations),
          JSON.stringify(result.signals),
          actor
        ).lastInsertRowid
    );
    created.push({ draftId, client });
  }
  if (created.length) {
    audit(
      tenant.id,
      actor,
      "Auto-drafted letters for",
      `${created.length} item${created.length === 1 ? "" : "s"} cleared by the pipeline`
    );
  }
  return { created: created.length, scan };
}

/**
 * Approve every auto-drafted letter and group the new disputes into mailroom
 * packages — one envelope per client and bureau, exactly like the manual flow.
 */
export function approvePipeline(tenant, actor) {
  const drafts = db
    .prepare(
      `SELECT d.*, c.name AS client_name FROM drafts d JOIN clients c ON c.id = d.client_id
       WHERE d.tenant_id = ? AND d.status = 'Ready' ORDER BY c.name, d.id`
    )
    .all(tenant.id);

  const createdDisputes = [];
  for (const draft of drafts) {
    const tradeline = db
      .prepare("SELECT * FROM tradelines WHERE id = ? AND tenant_id = ?")
      .get(Number(draft.tradeline_id), tenant.id);
    if (!tradeline) continue;

    const prior = db
      .prepare("SELECT MAX(round) AS round FROM disputes WHERE tenant_id = ? AND tradeline_id = ?")
      .get(tenant.id, tradeline.id);
    const round = Math.min(5, (Number(prior?.round) || 0) + 1);
    const ref = nextRef(tenant.id, "disputes", "DSP");
    const disputeId = Number(
      db
        .prepare(
          `INSERT INTO disputes (tenant_id, client_id, tradeline_id, ref, bureau, account, issue, round, status, confidence, letter_body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Needs review', ?, ?)`
        )
        .run(
          tenant.id,
          draft.client_id,
          tradeline.id,
          ref,
          tradeline.bureau,
          `${tradeline.creditor} ••${tradeline.mask}`,
          tradeline.reason,
          round,
          draft.confidence,
          draft.body
        ).lastInsertRowid
    );
    db.prepare("UPDATE drafts SET status = 'Approved', dispute_id = ? WHERE id = ? AND tenant_id = ?").run(
      disputeId,
      draft.id,
      tenant.id
    );
    createdDisputes.push({ ...draft, dispute_id: disputeId, ref, bureau: tradeline.bureau, client_id: draft.client_id });
  }

  const groups = new Map();
  createdDisputes.forEach((letter) => {
    const key = `${letter.client_id}:${letter.bureau}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(letter);
  });

  const packages = [];
  for (const [key, letters] of groups) {
    const [clientId, bureauKey] = key.split(":");
    const ref = nextRef(tenant.id, "packages", "PKG");
    const packageId = Number(
      db
        .prepare(
          `INSERT INTO packages (tenant_id, client_id, ref, bureau, letters, method, status, cost)
           VALUES (?, ?, ?, ?, ?, 'Certified mail', 'Ready', ?)`
        )
        .run(tenant.id, Number(clientId), ref, bureauKey, letters.length, 8.2).lastInsertRowid
    );
    const addItem = db.prepare("INSERT OR IGNORE INTO package_items (package_id, dispute_id) VALUES (?, ?)");
    const queue = db.prepare("UPDATE disputes SET status = 'Queued' WHERE id = ? AND tenant_id = ?");
    letters.forEach((letter) => {
      addItem.run(packageId, letter.dispute_id);
      queue.run(letter.dispute_id, tenant.id);
    });
    packages.push({ ref, letters: letters.length });
  }

  if (createdDisputes.length) {
    audit(
      tenant.id,
      actor,
      "Approved the automated batch",
      `${createdDisputes.length} disputes · ${packages.length} package${packages.length === 1 ? "" : "s"} queued`
    );
  }
  return { disputes: createdDisputes.length, packages };
}
