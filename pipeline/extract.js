// Core extraction logic: sends a document to Gemini and returns structured data.
// Used by the Vercel function in api/extract.js and by the local dev server.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "application/pdf"];

const num = { type: "NUMBER", nullable: true };
const str = { type: "STRING", nullable: true };
const box = {
  type: "ARRAY", nullable: true, items: { type: "INTEGER" },
  description: "Bounding box of the value on the first page: [ymin, xmin, ymax, xmax], each 0-1000.",
};

export const SCHEMA = {
  type: "OBJECT",
  properties: {
    document_type: { type: "STRING", enum: ["invoice", "receipt", "delivery_note", "purchase_order", "other"] },
    language: { type: "STRING", description: "ISO 639-1 code of the document language" },
    vendor: {
      type: "OBJECT", properties: { name: str, address: str, tax_id: str, email: str, phone: str, box_2d: box }, required: ["name", "box_2d"],
    },
    customer: { type: "OBJECT", nullable: true, properties: { name: str, address: str, box_2d: box } },
    document_number: { type: "OBJECT", properties: { value: str, box_2d: box }, required: ["value", "box_2d"] },
    issue_date: { type: "OBJECT", properties: { value: { ...str, description: "YYYY-MM-DD" }, box_2d: box }, required: ["value", "box_2d"] },
    due_date: { type: "OBJECT", nullable: true, properties: { value: { ...str, description: "YYYY-MM-DD" }, box_2d: box } },
    currency: { type: "STRING", description: "ISO 4217 code, e.g. EUR, USD" },
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" }, sku: str, quantity: num, unit: str, unit_price: num, amount: num,
          box_2d: { ...box, description: "Box around the whole row: [ymin, xmin, ymax, xmax], 0-1000." },
        },
        required: ["description", "amount", "box_2d"],
      },
    },
    subtotal: { type: "OBJECT", properties: { value: num, box_2d: box }, required: ["value", "box_2d"] },
    discount: { type: "OBJECT", nullable: true, properties: { value: num, box_2d: box } },
    tax: {
      type: "OBJECT",
      properties: { value: num, rate_percent: num, included_in_prices: { type: "BOOLEAN" }, box_2d: box },
    },
    shipping: { type: "OBJECT", nullable: true, properties: { value: num, box_2d: box } },
    total: { type: "OBJECT", properties: { value: num, box_2d: box }, required: ["value", "box_2d"] },
    payment_terms: str,
    summary: { type: "STRING", description: "One plain-English sentence describing the document." },
    warnings: {
      type: "ARRAY", items: { type: "STRING" },
      description: "Anything unreadable, ambiguous or inconsistent. Empty if none.",
    },
  },
  required: ["document_type", "vendor", "document_number", "issue_date", "currency", "line_items", "total", "tax", "summary", "warnings"],
};

const PROMPT = `You are a meticulous accounts-payable clerk. Extract the data from this business document.
Rules:
- Copy values exactly as printed; never invent a value. Use null when a field is not on the document.
- vendor.name: the seller's full legal company name if it is printed anywhere (address block, footer); otherwise the name shown in the logo.
- Convert numbers to plain decimals (e.g. "1.523,65" -> 1523.65). Discounts are positive numbers.
- Dates as YYYY-MM-DD. If only a payment period is given (e.g. "14 days"), compute the due date from the issue date.
- For receipts, the receipt/bon number is the document_number. If prices include VAT, set tax.included_in_prices=true and subtotal = net amount.
- line_items: one entry per product/service line, in printed order. amount is the line total.
- box_2d: where the value appears on the first page, as [ymin, xmin, ymax, xmax] scaled 0-1000.
- Write the summary and warnings in English, whatever the document language.`;

export async function extractDocument({ data, mimeType }, { apiKey, model = DEFAULT_MODEL, thinking = null, timeoutMs = 120000 } = {}) {
  if (!apiKey) throw httpError(500, "Server is missing GEMINI_API_KEY.");
  if (!ALLOWED_TYPES.includes(mimeType)) throw httpError(415, `Unsupported file type: ${mimeType}`);

  const body = {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mimeType, data } }, { text: PROMPT }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0,
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
    },
  };

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, payload;
  try {
    // One automatic retry when the model is briefly overloaded (HTTP 500/503).
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      payload = await res.json().catch(() => ({}));
      if (res.status !== 503 && res.status !== 500) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
  } catch (e) {
    throw httpError(504, e.name === "AbortError" ? "The AI model took too long to answer. Please try again." : "Could not reach the AI model.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const msg = payload?.error?.message || `Model error ${res.status}`;
    if (res.status === 429) throw httpError(429, "The AI quota is used up for now. Please try again in a minute.", msg);
    if (res.status === 503) throw httpError(503, "The AI model is busy right now. Please try again in a moment.", msg);
    throw httpError(502, "The AI model returned an error.", msg);
  }

  const cand = payload.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw httpError(502, "The AI answer could not be read. Please try again.", cand?.finishReason);
  }

  return {
    result,
    meta: {
      model,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      tokens: payload.usageMetadata?.totalTokenCount ?? null,
    },
  };
}

export function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.detail = detail;
  return e;
}
