// InboxLedger pipeline: emails in, verified ledger out.
//
//   GEMINI_API_KEY=... node pipeline/run.js <folder of .eml files> <output folder>
//
// For each email: find invoice attachments -> extract with AI -> check the math ->
// detect duplicates -> route (booked / needs review / duplicate / skipped) -> ledger.
// Writes ledger.xlsx, ledger.csv and run.json (a full record of every decision).
import fs from "node:fs";
import path from "node:path";
import { simpleParser } from "mailparser";
import ExcelJS from "exceljs";
import { extractDocument } from "./extract.js";
import { mathChecks, docKey } from "./checks.js";

const [inDir = "samples/inbox", outDir = "out"] = process.argv.slice(2);
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || undefined;
const DOC_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const val = (o) => (o && typeof o === "object" ? o.value : o);

fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(inDir).filter((f) => f.endsWith(".eml")).sort();
const seen = new Map();          // docKey -> email id that booked it
const run = { started: new Date().toISOString(), model: model || "default", emails: [] };

for (const file of files) {
  const mail = await simpleParser(fs.readFileSync(path.join(inDir, file)));
  const rec = {
    id: path.basename(file, ".eml"),
    from: mail.from?.text, subject: mail.subject, date: mail.date?.toISOString(),
    attachments: mail.attachments.map((a) => ({ name: a.filename, type: a.contentType, bytes: a.size })),
    steps: [],
  };
  const docs = mail.attachments.filter((a) => DOC_TYPES.includes(a.contentType));
  if (!docs.length) {
    rec.status = "skipped"; rec.reason = "No PDF or image attached";
    rec.steps.push({ step: "filter", result: "no document attachment" });
    run.emails.push(rec); console.log(rec.id, rec.status, "-", rec.reason); continue;
  }
  const att = docs[0];
  rec.steps.push({ step: "filter", result: `document found: ${att.filename}` });

  let extracted;
  try {
    extracted = await extractDocument({ data: att.content.toString("base64"), mimeType: att.contentType }, { apiKey, model, timeoutMs: 120000 });
  } catch (e) {
    rec.status = "needs_review"; rec.reason = "Extraction failed: " + e.message;
    run.emails.push(rec); console.log(rec.id, rec.status, "-", rec.reason); continue;
  }
  const d = extracted.result;
  rec.extraction = { seconds: extracted.meta.seconds, model: extracted.meta.model };
  rec.data = d;
  rec.steps.push({ step: "extract", result: `${d.document_type} from ${d.vendor?.name}, total ${val(d.total)} ${d.currency}` });

  if (!["invoice", "receipt"].includes(d.document_type)) {
    rec.status = "skipped"; rec.reason = `Attachment is a ${d.document_type}, not an invoice`;
    run.emails.push(rec); console.log(rec.id, rec.status, "-", rec.reason); continue;
  }

  rec.checks = mathChecks(d);
  rec.steps.push({ step: "check", result: rec.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.check}`).join("; ") });

  const key = docKey(d);
  if (key && seen.has(key)) {
    rec.status = "duplicate"; rec.reason = `Same vendor and number as email ${seen.get(key)}`;
  } else if (rec.checks.some((c) => !c.ok)) {
    rec.status = "needs_review"; rec.reason = rec.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ");
  } else {
    rec.status = "booked"; rec.reason = "All checks passed";
    if (key) seen.set(key, rec.id);
  }
  rec.steps.push({ step: "route", result: rec.status });
  run.emails.push(rec);
  console.log(rec.id, rec.status, "-", rec.reason, `(${extracted.meta.seconds}s)`);
}
run.finished = new Date().toISOString();

// ---- ledger outputs ----
const COLS = [
  ["Status", (e) => e.status], ["Email date", (e) => e.date?.slice(0, 10)], ["From", (e) => e.from],
  ["Vendor", (e) => e.data?.vendor?.name], ["Document no.", (e) => val(e.data?.document_number)],
  ["Issue date", (e) => val(e.data?.issue_date)], ["Due date", (e) => val(e.data?.due_date)],
  ["Currency", (e) => e.data?.currency], ["Net", (e) => val(e.data?.subtotal)], ["Tax", (e) => val(e.data?.tax)],
  ["Total", (e) => val(e.data?.total)], ["Note", (e) => e.reason],
];
const rows = run.emails.filter((e) => e.data).map((e) => COLS.map(([, f]) => f(e) ?? ""));
const csv = [COLS.map(([h]) => h), ...rows].map((r) => r.map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")).join("\n");
fs.writeFileSync(path.join(outDir, "ledger.csv"), csv);

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Ledger");
ws.columns = COLS.map(([h]) => ({ header: h, width: h === "Note" ? 60 : h === "From" || h === "Vendor" ? 32 : 14 }));
const FILL = { booked: "FFE2F0D9", needs_review: "FFFCE4D6", duplicate: "FFEDEDED" };
for (const r of rows) {
  const row = ws.addRow(r);
  const fill = FILL[r[0]];
  if (fill) row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
}
ws.getRow(1).font = { bold: true };
ws.views = [{ state: "frozen", ySplit: 1 }];
["I", "J", "K"].forEach((c) => (ws.getColumn(c).numFmt = "#,##0.00"));
await wb.xlsx.writeFile(path.join(outDir, "ledger.xlsx"));

fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));
const count = (s) => run.emails.filter((e) => e.status === s).length;
console.log(`\n${files.length} emails: ${count("booked")} booked, ${count("needs_review")} need review, ${count("duplicate")} duplicate, ${count("skipped")} skipped`);
