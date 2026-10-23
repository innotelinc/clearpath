import { db } from "./db.js";
import { bureau as BUREAUS, money } from "./util.js";

/**
 * The drafting studio.
 *
 * Letters are assembled from the record itself — tradeline, evidence list,
 * prior rounds — by fixed, reviewable rules. There is no model call: every
 * sentence can be traced to a field on the case file, confidence is a measure
 * of evidence strength rather than a guess from a language model, and drafting
 * costs nothing per letter. That makes it safe to run inside a compliance
 * process where a specialist still reads and approves each one.
 */

export const STRATEGIES = {
  "fcra-611": {
    label: "FCRA §611 — bureau reinvestigation",
    short: "Reinvestigation",
    authority: "15 U.S.C. §1681i(a)(1)(A)",
    support: "15 U.S.C. §1681i(a)(2)(A), (a)(5)(A)",
    intro:
      "This is a request for a reasonable reinvestigation of an item I believe is inaccurate or incomplete, together with a correction or deletion of the item as the evidence supports.",
    ask: "Please have the furnisher verify the specific fields identified above — the balance, the status, the date of first delinquency and the ownership of the account — rather than confirming the item as a whole. If any of those fields cannot be verified as accurate and complete, delete the tradeline and send me an updated file disclosure."
  },
  "fcra-623": {
    label: "FCRA §623 — direct dispute to the furnisher",
    short: "Furnisher direct",
    authority: "15 U.S.C. §1681s-2(b)",
    support: "15 U.S.C. §1681s-2(a)(8); 12 CFR 1022.43",
    intro:
      "I am disputing this item directly with you as the furnisher. You have a duty to conduct an investigation of the disputed information, review all relevant information I have provided, and report the results to each consumer reporting agency.",
    ask: "Please investigate the item, correct any field that is inaccurate or incomplete, and notify every consumer reporting agency to which you furnished the information of the correction. If the item cannot be substantiated, please delete it from the agencies' files."
  },
  "fcra-605b": {
    label: "FCRA §605 — obsolete adverse information",
    short: "Obsolete item",
    authority: "15 U.S.C. §1681c(a)(4)",
    support: "15 U.S.C. §1681c(a)(2), (a)(5); §1681c-2",
    intro:
      "I am asking that this item be deleted as obsolete. Adverse information that is older than the reporting period permitted by the FCRA may not be included in a consumer report.",
    ask: "Please confirm the date of first delinquency you are relying on for this item and, if it falls outside the permitted reporting period, delete it and send me an updated file disclosure. Please also confirm that no re-aged date has been substituted for the original delinquency date."
  },
  "cfpb-1022-43": {
    label: "12 CFR 1022.43 — direct dispute",
    short: "Direct dispute",
    authority: "12 CFR 1022.43",
    support: "12 CFR 1022.43(c), (e)",
    intro:
      "This is a direct dispute submitted under Regulation V. I have identified the account, the specific information in dispute and the basis for the dispute, and I have enclosed the documentation that supports it.",
    ask: "Please conduct an investigation of the disputed information, review the attached documentation, and report the results to me in writing within the period Regulation V allows. If the information is inaccurate, please correct it with every consumer reporting agency that received it."
  }
};

export const TONES = {
  Professional: {
    label: "Professional",
    close: "Thank you for your attention to this matter.",
    opener: "I am writing to dispute information in my credit file that I believe is inaccurate or incomplete."
  },
  Firm: {
    label: "Firm",
    close: "I expect a written response within the statutory period and a corrected file disclosure.",
    opener: "I am writing to formally dispute information in my credit file that is inaccurate, and I am asking you to correct it now."
  },
  Concise: {
    label: "Concise",
    close: "Please send your written results to the address on file.",
    opener: "I dispute the item below as inaccurate or incomplete."
  }
};

const TYPE_PARAGRAPH = {
  Collection:
    "The collection is reported as an unpaid obligation, but the account is not verifiable as reported. I have not received validation of the debt from the furnisher, and the balance shown does not match the documentation I have.",
  "Late payment":
    "The late payment marker is inaccurate. The payment in question was made on time, and the reported status does not reflect the payment history on file.",
  "Charge-off":
    "The charge-off status and reported balance are inaccurate or incomplete. The date of first delinquency and the balance shown in my file do not match the records I have from the furnisher.",
  "Hard inquiry":
    "I did not authorize this hard inquiry and there was no permissible purpose for it. A single application does not justify multiple hard inquiries from the same creditor.",
  Repossession:
    "The repossession and the balance reported after the sale are inaccurate. The vehicle was sold and the proceeds were not applied as reported, leaving an incorrect balance on my file."
};

const TYPE_CITATION = {
  Collection: "15 U.S.C. §1681i(a)(1)(A); §1681s-2(a)(8)",
  "Late payment": "15 U.S.C. §1681i(a)(1)(A); §1681s-2(a)(8)",
  "Charge-off": "15 U.S.C. §1681i(a)(1)(A); §1681s-2(a)(8)",
  "Hard inquiry": "15 U.S.C. §1681b(f); §1681n",
  Repossession: "15 U.S.C. §1681i(a)(1)(A); §1681s-2(b)"
};

function evidenceOf(tradeline) {
  try {
    const parsed = JSON.parse(tradeline.evidence || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  } catch {
    return [];
  }
}

export function tradelineSignals(tradeline, { clientId, tenantId }) {
  const signals = [];
  const evidence = evidenceOf(tradeline);

  if (tradeline.balance > 0) {
    signals.push(`Balance of ${money(tradeline.balance)} is still reported on this item.`);
  }
  if (tradeline.opened) {
    signals.push(`Reported as opened ${tradeline.opened}.`);
  }
  signals.push(
    evidence.length
      ? `${evidence.length} supporting document${evidence.length === 1 ? "" : "s"} on file: ${evidence.join(", ")}.`
      : "No supporting documents are attached to this tradeline yet."
  );

  const sameFurnisher = db
    .prepare(
      "SELECT COUNT(DISTINCT bureau) AS bureaus FROM tradelines WHERE tenant_id = ? AND client_id = ? AND lower(creditor) = lower(?)"
    )
    .get(tenantId, clientId, tradeline.creditor);
  if (Number(sameFurnisher?.bureaus) > 1) {
    signals.push(`${tradeline.creditor} appears on ${sameFurnisher.bureaus} bureau files for this client.`);
  }

  const priorRounds = db
    .prepare("SELECT COUNT(*) AS n, MAX(round) AS round FROM disputes WHERE tenant_id = ? AND tradeline_id = ?")
    .get(tenantId, tradeline.id);
  if (Number(priorRounds?.n) > 0) {
    signals.push(`Round ${Number(priorRounds.round) || 1} of this dispute is already on file — this draft would be a follow-up.`);
  }

  if (tradeline.type === "Hard inquiry" && !evidence.length) {
    signals.push("Hard inquiries score lower without a written authorization or a credit report excerpt.");
  }
  return signals;
}

export function confidenceFor(tradeline) {
  const evidence = evidenceOf(tradeline);
  let score = Number(tradeline.strength) || 70;
  score += Math.min(9, evidence.length * 3);
  if (tradeline.type === "Hard inquiry" && !evidence.length) score -= 10;
  if (tradeline.type === "Collection" && !tradeline.balance) score += 2;
  return Math.max(40, Math.min(98, Math.round(score)));
}

export function generateDraft({ tenant, client, tradeline, strategy = "fcra-611", tone = "Professional", includeEvidence = true, includeCitations = true }) {
  const plan = STRATEGIES[strategy] || STRATEGIES["fcra-611"];
  const voice = TONES[tone] || TONES.Professional;
  const bureau = BUREAUS[tradeline.bureau] || BUREAUS.tu;
  const evidence = evidenceOf(tradeline);

  const paragraphs = [
    voice.opener,
    `On my ${bureau.name} file, ${tradeline.creditor} is reported with account number ending ${tradeline.mask}, listed as a ${tradeline.type.toLowerCase()}${tradeline.balance > 0 ? ` with a balance of ${money(tradeline.balance)}` : ""}${tradeline.opened ? `, opened ${tradeline.opened}` : ""}. The basis of this dispute is: ${tradeline.reason}.`,
    TYPE_PARAGRAPH[tradeline.type] || "The information reported for this account is inaccurate or incomplete and does not reflect my records.",
    plan.intro,
    plan.ask
  ];

  if (includeEvidence && evidence.length) {
    paragraphs.push(
      `I have enclosed the following documentation: ${evidence.join(", ")}. Please review it as part of the investigation rather than verifying the item from your own records alone.`
    );
  }

  if (includeCitations) {
    paragraphs.push(
      `This request is made under ${plan.authority}${plan.support ? `, and the related requirements of ${plan.support}` : ""}. Please send written results of the investigation to the address on file within the period the statute allows. This letter is a request for correction and is not an admission of liability.`
    );
  } else {
    paragraphs.push(
      "Please send written results of the investigation to the address on file within the period the statute allows."
    );
  }

  paragraphs.push(voice.close);

  const citations = [
    plan.authority,
    ...(plan.support ? plan.support.split("; ") : []),
    ...(TYPE_CITATION[tradeline.type] ? TYPE_CITATION[tradeline.type].split("; ") : [])
  ].filter((value, index, all) => all.indexOf(value) === index);

  return {
    strategy,
    strategyLabel: plan.label,
    tone,
    subject: `Formal dispute — ${tradeline.creditor} account ending ${tradeline.mask} (${bureau.name})`,
    body: paragraphs.join("\n\n"),
    confidence: confidenceFor(tradeline),
    signals: tradelineSignals(tradeline, { clientId: client.id, tenantId: tenant.id }),
    citations,
    evidence,
    bureau: bureau.name
  };
}

export function listDrafts(tenantId, limit = 20) {
  return db
    .prepare(
      `SELECT d.*, c.name AS client_name, t.creditor, t.mask
       FROM drafts d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN tradelines t ON t.id = d.tradeline_id
       WHERE d.tenant_id = ? ORDER BY d.id DESC LIMIT ?`
    )
    .all(tenantId, limit);
}

export function getDraft(tenantId, id) {
  return db
    .prepare(
      `SELECT d.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
              t.creditor, t.mask, t.type AS tradeline_type, t.balance, t.bureau, t.reason, t.opened, t.evidence, t.strength
       FROM drafts d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN tradelines t ON t.id = d.tradeline_id
       WHERE d.id = ? AND d.tenant_id = ?`
    )
    .get(Number(id), tenantId);
}

export function parseList(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
