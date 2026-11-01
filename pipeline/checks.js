// Deterministic checks on extracted invoice data. No AI here: plain arithmetic.

const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const val = (o) => (o && typeof o === "object" ? o.value : o);
const r2 = (n) => Math.round(n * 100) / 100;
const close = (a, b) => a != null && b != null && Math.abs(a - b) < 0.015;

/** Returns a list of { ok, check, detail } results. */
export function mathChecks(d) {
  const out = [];
  const items = d.line_items || [];
  const sub = num(val(d.subtotal)), tax = num(val(d.tax)), tot = num(val(d.total));
  const disc = num(val(d.discount)) || 0, ship = num(val(d.shipping)) || 0;
  const incl = !!d.tax?.included_in_prices;

  const badLines = items.filter((i) => {
    const q = num(i.quantity), p = num(i.unit_price), a = num(i.amount);
    return q != null && p != null && a != null && !close(r2(q * p), a);
  });
  if (items.length) out.push({ ok: !badLines.length, check: "line totals", detail: badLines.length ? `${badLines.length} line(s): qty x price != amount` : "qty x price = amount on every line" });

  const lineSum = r2(items.reduce((s, i) => s + (num(i.amount) || 0), 0));
  const target = incl ? tot : sub;
  if (items.length && target != null) {
    out.push({ ok: close(lineSum, target), check: "lines vs " + (incl ? "total" : "subtotal"),
      detail: close(lineSum, target) ? `lines add up to ${target.toFixed(2)}` : `lines add up to ${lineSum.toFixed(2)}, document says ${target.toFixed(2)}` });
  }
  if (tot != null && tax != null && sub != null) {
    const calc = incl ? r2(sub + tax) : r2(sub - disc + tax + ship);
    out.push({ ok: close(calc, tot), check: "total", detail: close(calc, tot) ? "subtotal and tax add up to the total" : `components add up to ${calc.toFixed(2)}, document says ${tot.toFixed(2)}` });
  }
  return out;
}

/** A stable key for duplicate detection: vendor + document number. */
export function docKey(d) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const vendor = norm(d.vendor?.name).slice(0, 12);
  const number = norm(val(d.document_number));
  return vendor && number ? `${vendor}:${number}` : null;
}
