const PAGE = { w: 612, h: 792 };

const WINANSI = {
  "\u2014": 0x97, "\u2013": 0x96, "\u2019": 0x92, "\u2018": 0x91,
  "\u201c": 0x93, "\u201d": 0x94, "\u2022": 0x95, "\u2026": 0x85,
  "\u00a7": 0xa7, "\u00b7": 0xb7, "\u00a9": 0xa9, "\u00ae": 0xae,
  "\u00a0": 0x20
};

const HELV = "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584";
const HELV_BOLD = "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584";
const WIDTHS = {
  regular: HELV.split(" ").map(Number),
  bold: HELV_BOLD.split(" ").map(Number)
};

function encode(value) {
  let out = "";
  const text = String(value == null ? "" : value);
  for (const ch of text) {
    if (WINANSI[ch]) out += String.fromCharCode(WINANSI[ch]);
    else {
      const code = ch.codePointAt(0);
      out += code <= 255 ? ch : "?";
    }
  }
  return out;
}

const escapePdf = (value) =>
  encode(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const textWidth = (text, size, bold = false) => {
  const table = bold ? WIDTHS.bold : WIDTHS.regular;
  let total = 0;
  for (const ch of encode(text)) {
    const code = ch.charCodeAt(0);
    total += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (total / 1000) * size;
};

const hex = (value) => {
  const clean = String(value || "#101828").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(num)) return [0.06, 0.09, 0.14];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
};

class Doc {
  constructor() {
    this.pages = [];
    this.ops = null;
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
  }

  text(value, x, top, opts = {}) {
    const size = opts.size || 10;
    const bold = !!opts.bold;
    const font = opts.mono ? "/F3" : bold ? "/F2" : "/F1";
    const color = hex(opts.color || "#101828");
    let drawX = x;
    if (opts.align === "right") drawX = x - textWidth(value, size, bold);
    if (opts.align === "center") drawX = x - textWidth(value, size, bold) / 2;
    const y = PAGE.h - (top + size * 0.82);
    this.ops.push(
      `BT ${color.map((v) => v.toFixed(3)).join(" ")} rg ${font} ${size} Tf 1 0 0 1 ${drawX.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdf(value)}) Tj ET`
    );
  }

  line(x1, top1, x2, top2, opts = {}) {
    const color = hex(opts.color || "#d0d5dd");
    this.ops.push(
      `${color.map((v) => v.toFixed(3)).join(" ")} RG ${opts.width || 0.6} w ${opts.dash ? `[${opts.dash.join(" ")}] 0 d` : "[] 0 d"} ` +
        `${x1} ${(PAGE.h - top1).toFixed(2)} m ${x2} ${(PAGE.h - top2).toFixed(2)} l S`
    );
  }

  rect(x, top, w, h, opts = {}) {
    if (opts.fill) {
      this.ops.push(
        `${hex(opts.fill).map((v) => v.toFixed(3)).join(" ")} rg ${x} ${(PAGE.h - top - h).toFixed(2)} ${w} ${h} re f`
      );
    }
    if (opts.stroke) {
      this.ops.push(
        `${hex(opts.stroke).map((v) => v.toFixed(3)).join(" ")} RG ${opts.width || 0.6} w ${opts.dash ? `[${opts.dash.join(" ")}] 0 d` : "[] 0 d"} ` +
          `${x} ${(PAGE.h - top - h).toFixed(2)} ${w} ${h} re S`
      );
    }
  }

  wrap(value, maxWidth, size, bold = false) {
    const lines = [];
    for (const paragraph of String(value || "").split(/\n/)) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(""); continue; }
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (textWidth(candidate, size, bold) <= maxWidth || !current) {
          current = candidate;
          while (textWidth(current, size, bold) > maxWidth && current.length > 1) {
            let cut = current.length;
            while (cut > 1 && textWidth(current.slice(0, cut), size, bold) > maxWidth) cut -= 1;
            lines.push(current.slice(0, cut));
            current = current.slice(cut);
          }
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
    }
    return lines;
  }

  bytes(title) {
    const objects = [];
    const push = (body) => { objects.push(body); return objects.length; };
    push("<< /Type /Catalog /Pages 2 0 R >>");
    push("");
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

    const kids = [];
    this.pages.forEach((ops, index) => {
      const pageId = 6 + index * 2;
      const contentId = pageId + 1;
      const stream = ops.join("\n");
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      kids.push(`${pageId} 0 R`);
    });

    objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${this.pages.length} >>`;
    const infoId = objects.length + 1;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    objects.push(
      `<< /Title (${escapePdf(title || "Clearpath document")}) /Producer (Clearpath by Denovo Credit) /CreationDate (D:${stamp}) >>`
    );

    let pdf = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
    const offsets = [];
    objects.forEach((body, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, "latin1");
  }
}

const BUREAUS = {
  tu: { name: "TransUnion", address: "TransUnion Consumer Solutions\nP.O. Box 2000\nChester, PA 19016" },
  ex: { name: "Experian", address: "Experian\nP.O. Box 4500\nAllen, TX 75013" },
  eq: { name: "Equifax", address: "Equifax Information Services LLC\nP.O. Box 740256\nAtlanta, GA 30374" }
};

const bureauName = (key) => (BUREAUS[key] || BUREAUS.tu).name;
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayLong = () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

function header(doc, tenant, title, reference) {
  doc.rect(0, 0, PAGE.w, 6, { fill: tenant.accent });
  doc.text(tenant.brand_name || tenant.name, 54, 46, { size: 15, bold: true });
  doc.text(tenant.tagline || "", 54, 64, { size: 8.5, color: "#667085" });
  doc.text(title, 558, 46, { size: 8, bold: true, color: tenant.accent, align: "right" });
  doc.text(reference || "", 558, 60, { size: 7.5, color: "#667085", align: "right" });
  doc.line(54, 80, 558, 80, { color: "#d0d5dd", width: 0.8 });
  return 96;
}

function footer(doc, tenant, note) {
  const total = doc.pages.length;
  doc.pages.forEach((ops, index) => {
    const keep = doc.ops;
    doc.ops = ops;
    doc.line(54, 744, 558, 744, { color: "#e4e7ec", width: 0.6 });
    doc.text(`${tenant.brand_name} · ${tenant.support_email || ""}`, 54, 752, { size: 7, color: "#98a2b3" });
    doc.text(note || "", 306, 752, { size: 7, color: "#98a2b3", align: "center" });
    doc.text(`Page ${index + 1} of ${total}`, 558, 752, { size: 7, color: "#98a2b3", align: "right" });
    doc.ops = keep;
  });
}

export function letterBlocks({ tenant, client, dispute, tradeline }) {
  const item = tradeline || {
    creditor: String(dispute.account).split("••")[0].trim(),
    mask: (String(dispute.account).split("••")[1] || "").trim(),
    type: "Collection",
    balance: 0,
    reason: dispute.issue,
    evidence: "[]"
  };
  const evidence = (() => {
    try { return JSON.parse(item.evidence || "[]"); } catch { return []; }
  })();
  const bureau = BUREAUS[dispute.bureau] || BUREAUS.tu;
  const paragraph =
    {
      Collection: "The collection is reported as an unpaid obligation, but the account is not verifiable as reported. I have not received validation of the debt from the furnisher, and the reported balance does not match the documentation I have.",
      "Late payment": "The late payment marker is inaccurate. The payment in question was made on time, and the reported status does not reflect the payment history on file.",
      "Charge-off": "The charge-off status and reported balance are inaccurate or incomplete. The date of first delinquency and the balance shown in my file do not match the records I have from the furnisher.",
      "Hard inquiry": "I did not authorize this hard inquiry and there was no permissible purpose for it. A single application does not justify multiple hard inquiries from the same creditor.",
      Repossession: "The repossession and the balance reported after the sale are inaccurate. The vehicle was sold and the proceeds were not applied as reported, leaving an incorrect balance on my file."
    }[item.type] ||
    "The information reported for this account is inaccurate or incomplete and does not reflect my records.";

  return {
    bureau,
    date: todayLong(),
    recipient: bureau.address.split("\n"),
    subject: `Re: Formal dispute of inaccurate information — ${item.creditor}, account ending ${item.mask}`,
    consumer: `Consumer: ${client.name}`,
    contact: `Contact: ${client.email}${client.phone ? " · " + client.phone : ""}`,
    salutation: "To Whom It May Concern:",
    body: [
      `I am writing to dispute information in my ${bureau.name} credit file that I believe is inaccurate or incomplete. Please conduct a reasonable reinvestigation of the item identified below and correct or delete it as the evidence supports.`,
      paragraph,
      "If the information cannot be verified as accurate and complete, please delete the tradeline and send me an updated copy of my file. I have attached documentation supporting this request; please retain it with the dispute record.",
      "Please send written results of the reinvestigation to the address on file within the 30-day period required by the FCRA. This letter is a request for correction and is not an admission of liability.",
      "This dispute is submitted under Section 611(a)(1)(A) of the Fair Credit Reporting Act, 15 U.S.C. §1681i, which requires a reasonable reinvestigation of disputed information. Please also review the furnisher's duties under FCRA §623 and, where applicable, 12 CFR 1022.43."
    ],
    meta: [
      ["Furnisher", item.creditor],
      ["Account", `•••• ${item.mask}`],
      ["Item type", item.type],
      ["Reported balance", money(item.balance)],
      ["Disputed issue", dispute.issue || item.reason]
    ],
    enclosures: ["Government-issued photo ID", "Proof of current address", ...evidence]
  };
}

export function letterText(input) {
  const b = letterBlocks(input);
  return [
    b.date,
    "",
    b.recipient.join("\n"),
    "",
    b.subject,
    b.consumer,
    b.contact,
    "",
    b.salutation,
    "",
    b.body[0],
    "",
    b.meta.map(([k, v]) => `  ${k}: ${v}`).join("\n"),
    "",
    b.body.slice(1).join("\n\n"),
    "",
    "Sincerely,",
    "",
    input.client.name,
    "",
    "Enclosures:",
    b.enclosures.map((e) => `  •  ${e}`).join("\n")
  ].join("\n");
}

function drawLetter(doc, input) {
  const { tenant, client, dispute } = input;
  const b = letterBlocks(input);
  doc.addPage();
  let top = header(doc, tenant, "DISPUTE LETTER", `${dispute.ref} · ROUND ${dispute.round}`);
  const width = 504;

  doc.text(b.date, 558, 98, { size: 9.5, color: "#475467", align: "right" });
  top = 112;
  doc.text("VIA CERTIFIED MAIL · RETURN RECEIPT REQUESTED", 54, top, { size: 7.5, bold: true, color: "#475467" });
  top += 16;
  b.recipient.forEach((line) => { doc.text(line, 54, top, { size: 10 }); top += 13; });

  top += 14;
  doc.wrap(b.subject, width, 10.5, true).forEach((line) => {
    doc.text(line, 54, top, { size: 10.5, bold: true });
    top += 14;
  });
  doc.text(b.consumer, 54, top + 2, { size: 9, color: "#475467" });
  doc.text(b.contact, 54, top + 14, { size: 9, color: "#475467" });
  top += 32;

  doc.text(b.salutation, 54, top, { size: 10.5 });
  top += 20;

  b.body.slice(0, 1).forEach((paragraph) => {
    doc.wrap(paragraph, width, 10.5).forEach((line) => { doc.text(line, 54, top, { size: 10.5 }); top += 15.5; });
    top += 8;
  });

  const boxTop = top - 4;
  const rowHeight = 13;
  doc.rect(54, boxTop, width, b.meta.length * rowHeight + 8, { fill: "#f8fafc", stroke: "#eaecf0", width: 0.5 });
  b.meta.forEach(([label, value], index) => {
    const y = top + index * rowHeight;
    doc.text(label, 62, y, { size: 8.5, bold: true, color: "#475467" });
    doc.text(value, 190, y, { size: 9 });
  });
  top = boxTop + b.meta.length * rowHeight + 18;

  const ensure = (needed) => {
    if (top + needed < 702) return;
    doc.addPage();
    top = header(doc, tenant, "DISPUTE LETTER", `${dispute.ref} · ROUND ${dispute.round}`);
  };

  b.body.slice(1).forEach((paragraph) => {
    ensure(40);
    doc.wrap(paragraph, width, 10.5).forEach((line) => {
      ensure(18);
      doc.text(line, 54, top, { size: 10.5 });
      top += 15.5;
    });
    top += 8;
  });

  ensure(130);
  top += 4;
  doc.text("Sincerely,", 54, top, { size: 10.5 });
  top += 34;
  doc.text(client.name, 54, top, { size: 10.5, bold: true });
  top += 12;
  doc.text(`Consumer · ${client.email}`, 54, top, { size: 8.5, color: "#667085" });
  top += 26;
  ensure(40);
  doc.text("ENCLOSURES", 54, top, { size: 7.5, bold: true, color: "#475467" });
  top += 13;
  b.enclosures.forEach((item) => {
    ensure(14);
    doc.text("•", 56, top, { size: 9, color: tenant.accent });
    doc.text(item, 68, top, { size: 9, color: "#344054" });
    top += 12;
  });

  return doc;
}

export function letterPdf(input) {
  const doc = new Doc();
  doc.pages = [];
  doc.ops = null;
  drawLetter(doc, input);
  footer(doc, input.tenant, `${input.dispute.ref} · ${bureauName(input.dispute.bureau)}`);
  return doc.bytes(`Dispute letter ${input.dispute.ref} — ${input.client.name}`);
}

const LABEL = { w: 258, h: 150, gapX: 24, gapY: 18, x: 36, y: 54, perPage: 8 };

function labelPages(doc, tenant, list, clients) {
  list.forEach((pkg, index) => {
    if (index % LABEL.perPage === 0) doc.addPage();
    const slot = index % LABEL.perPage;
    const x = LABEL.x + (slot % 2) * (LABEL.w + LABEL.gapX);
    const y = LABEL.y + Math.floor(slot / 2) * (LABEL.h + LABEL.gapY);
    const bureau = BUREAUS[pkg.bureau] || BUREAUS.tu;
    const client = clients[pkg.client_id];

    doc.rect(x, y, LABEL.w, LABEL.h, { stroke: "#98a2b3", width: 0.6, dash: [3, 2] });
    doc.text("FROM", x + 8, y + 8, { size: 5.5, bold: true, color: "#98a2b3" });
    doc.text(tenant.brand_name, x + 8, y + 17, { size: 7, bold: true, color: "#344054" });
    doc.text(tenant.address || "", x + 8, y + 26, { size: 6, color: "#667085" });
    doc.line(x + 8, y + 36, x + LABEL.w - 8, y + 36, { color: "#d0d5dd", width: 0.4 });

    doc.text("TO", x + 8, y + 44, { size: 5.5, bold: true, color: "#98a2b3" });
    [bureau.name].concat(bureau.address.split("\n").slice(1)).forEach((line, i) => {
      doc.text(line, x + 8, y + 55 + i * 15, { size: i === 0 ? 12 : 10.5, bold: i === 0 });
    });

    doc.line(x + 8, y + LABEL.h - 42, x + LABEL.w - 8, y + LABEL.h - 42, { color: "#d0d5dd", width: 0.4 });
    doc.text(`${pkg.method} · ${pkg.letters} letter${pkg.letters === 1 ? "" : "s"}`, x + 8, y + LABEL.h - 34, { size: 7, bold: true, color: "#344054" });
    doc.text(`${pkg.ref}${client ? " · " + client.name : ""}`, x + 8, y + LABEL.h - 24, { size: 6.5, color: "#667085" });
    doc.text(pkg.tracking || "Tracking assigned at induction", x + 8, y + LABEL.h - 14, { size: 6, mono: true, color: "#667085" });
    doc.text(tenant.support_email || "", x + LABEL.w - 8, y + LABEL.h - 14, { size: 5.5, color: "#98a2b3", align: "right" });
  });
}

export function labelsPdf(tenant, packages, clients) {
  const doc = new Doc();
  doc.pages = [];
  doc.ops = null;
  if (packages.length) {
    labelPages(doc, tenant, packages, clients);
  } else {
    doc.addPage();
    header(doc, tenant, "CERTIFIED LABELS", "READY TO PRINT");
    doc.text("No packages are marked ready to print.", 54, 116, { size: 11, color: "#667085" });
  }
  footer(doc, tenant, `Certified labels · ${packages.length}`);
  return doc.bytes("Certified mailing labels");
}

export function queuePdf(tenant, packages, letters, clients) {
  const doc = new Doc();
  let top = header(doc, tenant, "MAILING QUEUE", `${packages.length} LABELS · ${letters.length} LETTERS`);
  doc.text("Mail run cover sheet", 54, top + 6, { size: 19, bold: true });
  doc.text(`${todayLong()} · prepared by ${tenant.brand_name}`, 54, top + 32, { size: 9, color: "#667085" });
  top += 60;

  const tiles = [
    ["Certified packages", packages.length],
    ["Dispute letters", letters.length],
    ["Postage", money(packages.reduce((sum, pkg) => sum + Number(pkg.cost || 0), 0))]
  ];
  tiles.forEach(([label, value], index) => {
    const x = 54 + index * 170;
    doc.rect(x, top, 158, 54, { fill: "#f8fafc", stroke: "#eaecf0", width: 0.5 });
    doc.text(String(value), x + 10, top + 10, { size: 17, bold: true, color: tenant.accent });
    doc.text(label, x + 10, top + 34, { size: 7.5, color: "#667085" });
  });
  top += 74;

  doc.text("PACKAGES", 54, top, { size: 7.5, bold: true, color: "#475467" });
  top += 14;
  doc.line(54, top, 558, top, { color: "#d0d5dd", width: 0.6 });
  top += 8;
  packages.forEach((pkg) => {
    doc.text(pkg.ref, 54, top, { size: 8.5, mono: true, color: "#344054" });
    doc.text((clients[pkg.client_id] || {}).name || "", 118, top, { size: 8.5, color: "#344054" });
    doc.text(bureauName(pkg.bureau), 240, top, { size: 8.5, color: "#344054" });
    doc.text(`${pkg.letters} letter${pkg.letters === 1 ? "" : "s"}`, 340, top, { size: 8.5, color: "#344054" });
    doc.text(money(pkg.cost), 558, top, { size: 8.5, color: "#344054", align: "right" });
    top += 8;
    doc.line(54, top, 558, top, { color: "#f2f4f7", width: 0.5 });
    top += 8;
  });
  if (!packages.length) { doc.text("No packages are marked ready.", 54, top, { size: 9, color: "#667085" }); top += 18; }

  top += 14;
  doc.text("LETTERS", 54, top, { size: 7.5, bold: true, color: "#475467" });
  top += 14;
  doc.line(54, top, 558, top, { color: "#d0d5dd", width: 0.6 });
  top += 8;
  letters.forEach((letter) => {
    if (top > 690) { doc.addPage(); top = header(doc, tenant, "MAILING QUEUE"); }
    const client = clients[letter.client_id] || {};
    doc.text(letter.ref, 54, top, { size: 8.5, mono: true, color: "#344054" });
    doc.text(client.name || "", 118, top, { size: 8.5, color: "#344054" });
    doc.text(bureauName(letter.bureau), 240, top, { size: 8.5, color: "#344054" });
    doc.text(`Round ${letter.round}`, 340, top, { size: 8.5, color: "#344054" });
    doc.text(String(letter.issue).slice(0, 42), 558, top, { size: 8, color: "#667085", align: "right" });
    top += 8;
    doc.line(54, top, 558, top, { color: "#f2f4f7", width: 0.5 });
    top += 8;
  });

  if (packages.length) labelPages(doc, tenant, packages, clients);

  for (const letter of letters) {
    if (letter.__input) drawLetter(doc, letter.__input);
  }

  footer(doc, tenant, `Mailing queue · ${letters.length} letters · ${packages.length} labels`);
  return doc.bytes(`Mailing queue — ${tenant.brand_name}`);
}

export function summaryPdf(tenant, client, disputes) {
  const doc = new Doc();
  let top = header(doc, tenant, "CLIENT SUMMARY", client.name.toUpperCase());
  doc.text("Progress summary", 54, top + 4, { size: 18, bold: true });
  doc.text(`${todayLong()} · prepared for ${client.name}`, 54, top + 28, { size: 9, color: "#667085" });
  top += 58;

  const rows = [
    ["Client", client.name],
    ["Email", client.email],
    ["Phone", client.phone || "—"],
    ["Program stage", client.stage],
    ["Client since", client.joined],
    ["Points gained", `+${client.delta}`],
    ["TransUnion", String(client.tu)],
    ["Experian", String(client.ex)],
    ["Equifax", String(client.eq)]
  ];
  rows.forEach(([label, value], index) => {
    const y = top + index * 15;
    if (index % 2 === 0) doc.rect(54, y - 2, 504, 15, { fill: "#f8fafc" });
    doc.text(label, 62, y, { size: 8.5, bold: true, color: "#475467" });
    doc.text(value, 220, y, { size: 9 });
  });
  top += rows.length * 15 + 26;

  doc.text("DISPUTES", 54, top, { size: 7.5, bold: true, color: "#475467" });
  top += 14;
  doc.line(54, top, 558, top, { color: "#d0d5dd", width: 0.6 });
  top += 8;
  disputes.forEach((d) => {
    doc.text(d.ref, 54, top, { size: 8.5, mono: true, color: "#344054" });
    doc.text(bureauName(d.bureau), 120, top, { size: 8.5, color: "#344054" });
    doc.text(d.status, 230, top, { size: 8.5, color: "#344054" });
    doc.text(`Round ${d.round}`, 340, top, { size: 8.5, color: "#344054" });
    doc.text(d.mailed ? `Mailed ${d.mailed}` : "Not mailed", 558, top, { size: 8, color: "#667085", align: "right" });
    top += 8;
    doc.line(54, top, 558, top, { color: "#f2f4f7", width: 0.5 });
    top += 8;
  });
  if (!disputes.length) { doc.text("No disputes on file.", 54, top, { size: 9, color: "#667085" }); top += 18; }

  top += 18;
  doc.text("This summary is for the named consumer. It is not legal advice and does not guarantee any outcome.", 54, top, { size: 8, color: "#667085" });
  footer(doc, tenant, `${client.name} · client summary`);
  return doc.bytes(`Client summary — ${client.name}`);
}

export { BUREAUS, bureauName, money };
