/*
 * Builds the Zoho Creator v2.1 "Add Records" payload from the flat quotation
 * fields the React form submits, and posts it to the Vendor_Quotations form.
 *
 * RFQ_ID and Vendor_Master are LOOKUP fields — they need the linked record's
 * numeric ID, not a text code. We resolve them:
 *   - if a numeric record id is supplied, use it directly;
 *   - otherwise look the record up by name / number via a report (report.READ).
 */
import { getAccessToken } from "./zohoToken.js";

const DC = process.env.ZOHO_DC || "in";
const API_HOST = `https://www.zohoapis.${DC}`;

const owner = () => process.env.CREATOR_ACCOUNT_OWNER;
const app = () => process.env.CREATOR_APP_LINK_NAME;
const form = () => process.env.CREATOR_FORM_LINK_NAME || "Vendor_Quotations";
const subform = () => process.env.CREATOR_SUBFORM_LINK_NAME || "Quotation_Items";
const defaultStatus = () => process.env.CREATOR_DEFAULT_STATUS || "Pending Review";

// Report that displays Vendor_Quotations records — used to read back the
// subform row IDs after a record is created (needed for subform file upload).
const QUOTATIONS_REPORT =
  process.env.CREATOR_QUOTATIONS_REPORT || "Vendor_Quotations_Report";

// File-upload field link names inside the Quotation_Items subform.
const ATTACHMENT_FIELD = process.env.CREATOR_ATTACHMENT_FIELD || "Attachment";
const DATASHEET_FIELD = process.env.CREATOR_DATASHEET_FIELD || "Datasheet";

// Reports + match fields used to resolve the lookups.
const VENDOR_REPORT = process.env.CREATOR_VENDOR_REPORT || "Vendor_Master_Report";
const VENDOR_MATCH_FIELD = process.env.CREATOR_VENDOR_MATCH_FIELD || "Vendor_Name";
const RFQ_REPORT = process.env.CREATOR_RFQ_REPORT || "RFQ1";
const RFQ_MATCH_FIELD = process.env.CREATOR_RFQ_MATCH_FIELD || "RFQ_Number";

/* Extracts a numeric value from mixed text (e.g. "Ex-works / 500" -> 500). */
function num(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) ? fallback : n;
}

/* A Zoho record ID is a long run of digits (16+). */
function isRecordId(v) {
  return typeof v === "string" ? /^\d{6,}$/.test(v) : typeof v === "number";
}

/* Integer from a mixed string, digits only (e.g. "IT-001" -> 1). */
function intOnly(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const digits = String(v).replace(/\D/g, "");
  const n = parseInt(digits, 10);
  return Number.isNaN(n) ? fallback : n;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* dd-MMM-yyyy HH:mm:ss in IST (matches the module's date-time format). */
function formatSubmissionDate(d = new Date()) {
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(ist.getDate())}-${MONTHS[ist.getMonth()]}-${ist.getFullYear()} ${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
}

/* Look up a record ID from a report where matchField == value. */
async function resolveRecordId(reportLink, matchField, value, token) {
  if (!value) return null;
  const criteria = `${matchField}=="${String(value).replace(/"/g, '\\"')}"`;
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${reportLink}` +
    `?criteria=${encodeURIComponent(criteria)}&max_records=200`;

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (data.code === 3000 && Array.isArray(data.data) && data.data.length) {
    return data.data[0].ID;
  }
  return null;
}

/* Resolve the Vendor_Master lookup: prefer explicit id, else match by name. */
async function resolveVendorId(p, token) {
  if (isRecordId(p.vendorRecordId)) return String(p.vendorRecordId);
  if (isRecordId(p.vendorId)) return String(p.vendorId);
  const byName = await resolveRecordId(VENDOR_REPORT, VENDOR_MATCH_FIELD, p.vendorName, token);
  if (byName) return byName;
  // Some links pass the code in vendorId; try matching that too.
  return resolveRecordId(VENDOR_REPORT, VENDOR_MATCH_FIELD, p.vendorId, token);
}

/* Resolve the RFQ_ID lookup: prefer explicit id, else match by RFQ number. */
async function resolveRfqId(p, token) {
  if (isRecordId(p.rfqRecordId)) return String(p.rfqRecordId);
  return resolveRecordId(RFQ_REPORT, RFQ_MATCH_FIELD, p.rfqNumber, token);
}

export function buildSubformRow(p) {
  const unitPrice = num(p.price);
  const qty = num(p.quantity);
  const gstPct = num(p.gst);
  const freight = num(p.freight);
  const lineTotal = unitPrice * qty;
  const gstAmount = (lineTotal * gstPct) / 100;
  const totalAmount = Math.round((lineTotal + gstAmount + freight) * 100) / 100;

  // Fold Validity + Lead Time into Remarks since the subform's Validity column
  // is a DATE field (the form collects them as free text like "30 days").
  const extras = [
    p.validity ? `Validity: ${p.validity}` : "",
    p.leadTime ? `Lead time: ${p.leadTime}` : "",
    p.remarks || "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    RFQ_Item_ID: intOnly(p.itemId), // subform field is Number
    Product: p.product || "",
    Quantity: qty,
    Currency: p.currency || "INR",
    Freight: freight,
    Unit_Price: unitPrice,
    GST: gstPct,
    Total_Amount: totalAmount,
    Remarks: extras,
  };
}

/*
 * After the record is created we only know the parent record ID. To upload a
 * file into a subform file field we also need the subform ROW id. We read the
 * record back from a report (report.READ) and pick the first Quotation_Items
 * row's ID.
 */
async function getFirstSubformRowId(recordId, token) {
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}` +
    `/${recordId}?field_config=all`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  const rec = data && data.data;
  const rows = rec && rec[subform()];
  if (Array.isArray(rows) && rows.length) return rows[0].ID;
  return null;
}

/*
 * Uploads one file into a file-upload field inside a subform row.
 * URL: .../report/<report>/<recordId>/<subform>.<field>/<subformRowId>/upload
 * Requires the ZohoCreator.report.CREATE scope on the refresh token.
 */
async function uploadSubformFile(recordId, subRowId, fieldName, file, token) {
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}` +
    `/${recordId}/${subform()}.${fieldName}/${subRowId}/upload`;

  const fd = new FormData();
  const blob = new Blob([file.buffer], {
    type: file.mimetype || "application/octet-stream",
  });
  fd.append("file", blob, file.originalname || "upload.bin");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.code === 3000, field: fieldName, data };
}

/*
 * Uploads Attachment + Datasheet files (if any) into the created subform row.
 * Failures here are non-fatal: the quotation record already exists, so we log
 * and report per-file status rather than failing the whole submission.
 */
async function uploadSubformFiles(recordId, files, token) {
  const results = [];
  const mapping = [
    { field: ATTACHMENT_FIELD, file: files.attachment },
    { field: DATASHEET_FIELD, file: files.datasheet },
  ].filter((m) => m.file);

  if (!mapping.length) return { attempted: false, results };

  const subRowId = await getFirstSubformRowId(recordId, token);
  if (!subRowId) {
    return {
      attempted: true,
      subRowId: null,
      results,
      error: "Could not resolve subform row ID for file upload.",
    };
  }

  for (const m of mapping) {
    try {
      const r = await uploadSubformFile(recordId, subRowId, m.field, m.file, token);
      results.push(r);
      if (!r.ok) console.error(`Upload to ${m.field} failed:`, r.data);
    } catch (e) {
      console.error(`Upload to ${m.field} threw:`, e);
      results.push({ ok: false, field: m.field, error: e.message });
    }
  }
  return { attempted: true, subRowId, results };
}

export async function createQuotationRecord(flatPayload, files = {}) {
  const token = await getAccessToken();

  const [vendorId, rfqId] = await Promise.all([
    resolveVendorId(flatPayload, token),
    resolveRfqId(flatPayload, token),
  ]);

  const data = {
    Submission_Date: formatSubmissionDate(),
    [subform()]: [buildSubformRow(flatPayload)],
    Margin: 0,
    Status: defaultStatus(),
  };
  // Only set lookups we could resolve (avoids "Invalid column value").
  if (vendorId) data.Vendor_Master = vendorId;
  if (rfqId) data.RFQ_ID = rfqId;

  const url = `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/form/${form()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data }),
  });

  const respData = await res.json().catch(() => ({}));
  const ok = res.ok && respData.code === 3000;
  const recordId = respData?.data?.ID;

  // Step 2: upload the subform files onto the freshly-created row.
  let uploads = { attempted: false, results: [] };
  if (ok && recordId) {
    uploads = await uploadSubformFiles(recordId, files, token);
  }

  return { ok, status: res.status, data: respData, recordId, resolved: { vendorId, rfqId }, uploads };
}
