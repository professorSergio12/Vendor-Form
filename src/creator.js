/*
 * Vendor_Quotations — Creator link names (confirmed):
 *
 * Parent: RFQ, Vendor_Master, Submission_Date, Status, Margin,
 *         Total_Amount (grand total), Delivery_Date, Currency
 *
 * Subform Quotation_Items: Description, Quantity, Unit_Price, GST,
 *         Total_Amount (line), Delivery_Date, Currency, Remarks,
 *         Item_Master, Attachment, Datasheet
 */
import { getAccessToken } from "./zohoToken.js";
import axios from "axios";
import FormData from "form-data";

const DC = process.env.ZOHO_DC || "in";
const API_HOST = `https://www.zohoapis.${DC}`;

const owner = () => process.env.CREATOR_ACCOUNT_OWNER;
const app = () => process.env.CREATOR_APP_LINK_NAME;
const form = () => process.env.CREATOR_FORM_LINK_NAME || "Vendor_Quotations";
const subform = () => process.env.CREATOR_SUBFORM_LINK_NAME || "Quotation_Items";
const rfqField = () => process.env.CREATOR_RFQ_FIELD || "RFQ";
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
const VENDOR_CODE_FIELD = process.env.CREATOR_VENDOR_CODE_FIELD || "Vendor_Code";
const RFQ_REPORT = process.env.CREATOR_RFQ_REPORT || "RFQ1";
const RFQ_MATCH_FIELD = process.env.CREATOR_RFQ_MATCH_FIELD || "RFQ_Number";
const ITEM_MASTER_REPORT = process.env.CREATOR_ITEM_MASTER_REPORT || "Items_Report";

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

/* dd-MMM-yyyy for Creator date / date-time fields. */
function formatCreatorDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return String(isoDate);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/* dd-MMM-yyyy HH:mm:ss in IST (matches the module's date-time format). */
function formatSubmissionDate(d = new Date()) {
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(ist.getDate())}-${MONTHS[ist.getMonth()]}-${ist.getFullYear()} ${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
}

/* Confirm a record id exists in a report before using it in a lookup field. */
async function validateReportRecordId(reportLink, recordId, token) {
  if (!isRecordId(recordId)) return null;
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${reportLink}` +
    `/${recordId}?field_config=all`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return data.code === 3000 ? String(recordId) : null;
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

/* Resolve the Vendor_Master lookup: validate explicit ids, else match by name/code. */
async function resolveVendorId(p, token) {
  for (const candidate of [p.vendorRecordId, p.vendorId]) {
    const valid = await validateReportRecordId(VENDOR_REPORT, candidate, token);
    if (valid) return valid;
  }

  for (const value of [p.vendorName, p.vendorId]) {
    const byName = await resolveRecordId(VENDOR_REPORT, VENDOR_MATCH_FIELD, value, token);
    if (byName) return byName;
    const byCode = await resolveRecordId(VENDOR_REPORT, VENDOR_CODE_FIELD, value, token);
    if (byCode) return byCode;
  }
  return null;
}

/* Resolve the RFQ_ID lookup: validate explicit id, else match by RFQ number. */
async function resolveRfqId(p, token) {
  const valid = await validateReportRecordId(RFQ_REPORT, p.rfqRecordId, token);
  if (valid) return valid;
  return resolveRecordId(RFQ_REPORT, RFQ_MATCH_FIELD, p.rfqNumber, token);
}

export function formatCreatorError(data) {
  if (Array.isArray(data?.error) && data.error.length) return data.error.join("; ");
  return data?.message || data?.description || "Zoho Creator rejected the submission.";
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Resolve Item_Master lookup from the item / product record id in the email link. */
async function resolveItemMasterId(p, token) {
  for (const candidate of [p.itemMasterId, p.itemId]) {
    const valid = await validateReportRecordId(ITEM_MASTER_REPORT, candidate, token);
    if (valid) return valid;
  }
  return null;
}

/* Pull all subform row IDs from an addRecords / getRecord response. */
function extractAllSubformRowIds(record) {
  if (!record) return [];
  const rows = record[subform()];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => (r && r.ID ? String(r.ID) : null)).filter(Boolean);
}

export function buildSubformRow(p) {
  const qty = num(p.quantity, 1);
  const gstPct = num(p.gst, 18);
  const unitPrice = num(p.price);
  const lineSubtotal = unitPrice * qty;
  const gstAmount = Math.round(((lineSubtotal * gstPct) / 100) * 100) / 100;
  const lineTotal = Math.round((lineSubtotal + gstAmount) * 100) / 100;

  const row = {
    Description: p.description || "",
    Quantity: qty,
    Currency: String(p.currency || "INR"),
    Unit_Price: unitPrice,
    GST: gstAmount,
    Total_Amount: lineTotal,
    Remarks: p.remarks || "",
  };

  const deliveryFormatted = formatCreatorDate(p.deliveryDate);
  if (deliveryFormatted) {
    row.Delivery_Date = `${deliveryFormatted} 00:00:00`;
  }

  if (p.itemMasterId) {
    row.Item_Master = p.itemMasterId;
  }

  return { row, lineSubtotal, gstAmount, lineTotal };
}

/*
 * After the record is created we need subform ROW ids for file upload.
 * Prefer IDs returned inline by addRecords; otherwise read the record back.
 */
async function resolveAllSubformRowIds(recordId, createResponseData, expectedCount, token) {
  const fromCreate = extractAllSubformRowIds(createResponseData);
  if (fromCreate.length >= expectedCount) return fromCreate;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const ids = await getAllSubformRowIds(recordId, token);
    if (ids.length >= expectedCount) return ids;
    if (attempt < 4) await wait(400 * attempt);
  }
  return fromCreate;
}

async function getAllSubformRowIds(recordId, token) {
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}` +
    `/${recordId}?field_config=all`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 3000) {
    console.error("getRecordById for subform rows failed:", data);
    return [];
  }
  const rec = Array.isArray(data.data) ? data.data[0] : data.data;
  return extractAllSubformRowIds(rec);
}

function buildUploadAttempts(recordId, subRowId, fieldName) {
  const base =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}`;
  const dotted = `${subform()}.${fieldName}`;
  // Mirror of "Download File from Subform" — replace /download with /upload.
  // Do NOT send parent_id; that param is JS-SDK-only and rejected by REST (code 1060).
  return [
    {
      label: "subform upload path",
      url: `${base}/${recordId}/${dotted}/${subRowId}/upload`,
      extraFields: {},
    },
  ];
}

function describeUploadError(status, data, raw) {
  const code = data?.code;
  const msg =
    data?.message ||
    data?.description ||
    data?.error ||
    (typeof raw === "string" && raw.trim() ? raw : "") ||
    "upload failed";
  if (code === 2945 || /invalid oauthscope|oauthscope|scope/i.test(String(msg))) {
    return `${msg} — regenerate refresh token with scope ZohoCreator.report.CREATE`;
  }
  if (status) return `HTTP ${status}: ${msg}`;
  return msg;
}

/*
 * Uploads one file into a file-upload field inside a subform row.
 * Tries the URL shapes Zoho documents/uses for subform file fields.
 * Requires the ZohoCreator.report.CREATE scope on the refresh token.
 */
async function uploadSubformFile(recordId, subRowId, fieldName, file, token) {
  const attempts = buildUploadAttempts(recordId, subRowId, fieldName);
  const failures = [];

  for (const attempt of attempts) {
    const fd = new FormData();
    Object.entries(attempt.extraFields).forEach(([key, value]) => {
      fd.append(key, String(value));
    });
    fd.append("file", file.buffer, {
      filename: file.originalname || "upload.bin",
      contentType: file.mimetype || "application/octet-stream",
    });

    try {
      const res = await axios.post(attempt.url, fd, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          ...fd.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });

      const data = res.data && typeof res.data === "object" ? res.data : {};
      const raw = typeof res.data === "string" ? res.data : JSON.stringify(data);
      const ok = res.status >= 200 && res.status < 300 && Number(data.code) === 3000;

      if (ok) {
        return { ok: true, field: fieldName, status: res.status, data, url: attempt.url };
      }

      const failure = {
        ok: false,
        field: fieldName,
        status: res.status,
        data,
        raw,
        url: attempt.url,
        label: attempt.label,
      };
      failures.push(failure);
      console.error(
        `Upload to ${fieldName} failed (${attempt.label}) via ${attempt.url}:`,
        data || raw
      );
    } catch (e) {
      failures.push({
        ok: false,
        field: fieldName,
        status: 0,
        data: {},
        raw: "",
        url: attempt.url,
        label: attempt.label,
        error: e.message,
      });
      console.error(`Upload to ${fieldName} threw (${attempt.label}) via ${attempt.url}:`, e);
    }
  }

  const best = failures.find((f) => f.data?.description || f.data?.message) || failures[0];
  return best || { ok: false, field: fieldName, status: 0, data: {}, raw: "" };
}

/*
 * Uploads per-row Attachment + Datasheet files into matching subform rows.
 * filesByRow: { 0: { attachment?, datasheet? }, 1: { ... } }
 * Legacy: { attachment, datasheet } uploads to row 0 only.
 */
async function uploadSubformFiles(recordId, createResponseData, filesByRow, token) {
  const results = [];
  const rowIndexes = Object.keys(filesByRow || {})
    .map((k) => Number(k))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const hasAnyFile = rowIndexes.some((idx) => {
    const row = filesByRow[idx] || {};
    return row.attachment || row.datasheet;
  });
  if (!hasAnyFile) return { attempted: false, results };

  const subRowIds = await resolveAllSubformRowIds(
    recordId,
    createResponseData,
    rowIndexes.length ? Math.max(...rowIndexes) + 1 : 1,
    token
  );

  if (!subRowIds.length) {
    return {
      attempted: true,
      subRowIds: [],
      results,
      error: "Could not resolve Quotation_Items row IDs after create. Files were not uploaded.",
    };
  }

  for (const idx of rowIndexes) {
    const rowFiles = filesByRow[idx] || {};
    const subRowId = subRowIds[idx];
    if (!subRowId) {
      results.push({ ok: false, row: idx, error: "Missing subform row id" });
      continue;
    }
    for (const [kind, field] of [
      ["attachment", ATTACHMENT_FIELD],
      ["datasheet", DATASHEET_FIELD],
    ]) {
      const file = rowFiles[kind];
      if (!file) continue;
      try {
        const r = await uploadSubformFile(recordId, subRowId, field, file, token);
        results.push({ ...r, row: idx });
      } catch (e) {
        console.error(`Upload ${kind} row ${idx} threw:`, e);
        results.push({ ok: false, row: idx, field, error: e.message });
      }
    }
  }

  const allOk = results.every((r) => r.ok);
  return {
    attempted: true,
    subRowIds,
    results,
    allOk,
    error: allOk
      ? null
      : results
          .filter((r) => !r.ok)
          .map((r) =>
            `row ${r.row ?? "?"} ${r.field || ""}: ${describeUploadError(r.status, r.data, r.raw || r.error)}`
          )
          .join("; "),
  };
}

export function parseFilesByRow(reqFiles = []) {
  const byRow = {};
  for (const file of reqFiles) {
    const m = String(file.fieldname || "").match(/^(attachment|datasheet)_(\d+)$/);
    if (!m) continue;
    const idx = Number(m[2]);
    if (!byRow[idx]) byRow[idx] = {};
    byRow[idx][m[1]] = file;
  }
  return byRow;
}

export async function createQuotationRecord(flatPayload, files = {}) {
  const token = await getAccessToken();

  const [vendorId, rfqId] = await Promise.all([
    resolveVendorId(flatPayload, token),
    resolveRfqId(flatPayload, token),
  ]);

  let linePayloads = [];
  if (flatPayload.items) {
    try {
      const parsed =
        typeof flatPayload.items === "string"
          ? JSON.parse(flatPayload.items)
          : flatPayload.items;
      if (Array.isArray(parsed) && parsed.length) {
        linePayloads = parsed.map((line) => ({
          ...flatPayload,
          itemId: line.itemId,
          itemMasterId: line.itemMasterId || line.itemId,
          product: line.product,
          quantity: line.quantity,
          unit: line.unit,
          description: line.description,
          deliveryDate: line.deliveryDate,
          totalAmount: line.totalAmount,
          price: line.price,
          gst: line.gst,
          remarks: line.remarks,
          uniqueId: line.uniqueId || flatPayload.uniqueId,
        }));
      }
    } catch (e) {
      console.error("Failed to parse items JSON:", e);
    }
  }

  if (!linePayloads.length) {
    linePayloads = [{ ...flatPayload, itemMasterId: flatPayload.itemMasterId || flatPayload.itemId }];
  }

  const subformRows = [];
  const resolvedItemMasters = [];
  let parentTotal = 0;
  let parentDeliveryDate = null;

  for (const line of linePayloads) {
    const itemMasterId = await resolveItemMasterId(line, token);
    resolvedItemMasters.push(itemMasterId);
    const built = buildSubformRow({
      ...line,
      itemMasterId: itemMasterId || null,
    });
    subformRows.push(built.row);
    parentTotal += built.lineTotal;
    if (!parentDeliveryDate && line.deliveryDate) {
      parentDeliveryDate = line.deliveryDate;
    }
  }

  const data = {
    Submission_Date: formatSubmissionDate(),
    [subform()]: subformRows,
    Total_Amount: Math.round(parentTotal * 100) / 100,
    Margin: 0,
    Status: defaultStatus(),
  };

  if (flatPayload.currency) {
    data.Currency = String(flatPayload.currency);
  }
  const parentDeliveryFormatted = formatCreatorDate(parentDeliveryDate);
  if (parentDeliveryFormatted) {
    data.Delivery_Date = `${parentDeliveryFormatted} 00:00:00`;
  }

  // Only set lookups we could resolve (avoids "Invalid column value").
  if (vendorId) data.Vendor_Master = vendorId;
  if (rfqId) data[rfqField()] = rfqId;

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
  const created = Array.isArray(respData.data) ? respData.data[0] : respData.data;
  const recordId = created?.ID;

  // Step 2: upload per-row subform files
  let uploads = { attempted: false, results: [] };
  if (ok && recordId) {
    uploads = await uploadSubformFiles(recordId, created, files, token);
  }

  return {
    ok,
    status: res.status,
    data: respData,
    recordId,
    resolved: { vendorId, rfqId, itemMasters: resolvedItemMasters },
    uploads,
  };
}
