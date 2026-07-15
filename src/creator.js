/*
 * Vendor_Quotations — Creator link names (confirmed):
 *
 * Parent: RFQ, Vendor_Master, Submission_Date, Margin,
 *         Total_Amount (grand total), Delivery_Date, Currency
 *
 * Subform Quotation_Items: Description, Quantity, Available_Quantity, Unit_Price, GST (%),
 *         Total_Amount (line), Delivery_Date, Currency, Item_Master, Status (per line)
 *
 * Parent file uploads (multi): Attachment, DataSheet — uploaded after record create via v2.1 Upload File API.
 *
 * RFQ form RFQ_Products subform (qty source for vendor email): Product, Quantity (DECIMAL), Unit
 *
 * Parent Quotation_Version: v0 first submit per RFQ+vendor, then v1, v2, …
 */
import { getAccessToken } from "./zohoToken.js";
import {
  dueDateToIso,
  formatDueDateDisplay,
  isRfqDueDatePassed,
  readRfqDueDate,
} from "./rfqDeadline.js";
import axios from "axios";
import FormData from "form-data";

const DC = process.env.ZOHO_DC || "in";
const API_HOST = `https://www.zohoapis.${DC}`;

const owner = () => process.env.CREATOR_ACCOUNT_OWNER;
const app = () => process.env.CREATOR_APP_LINK_NAME;
const form = () => process.env.CREATOR_FORM_LINK_NAME || "Vendor_Quotations";
const subform = () => process.env.CREATOR_SUBFORM_LINK_NAME || "Quotation_Items";
const rfqField = () => process.env.CREATOR_RFQ_FIELD || "RFQ";
const vendorField = () => process.env.CREATOR_VENDOR_FIELD || "Vendor_Master";
const defaultStatus = () => process.env.CREATOR_DEFAULT_STATUS || "Pending Review";
const itemStatusField = () => process.env.CREATOR_ITEM_STATUS_FIELD || "Status";
const quotationVersionField = () =>
  process.env.CREATOR_QUOTATION_VERSION_FIELD || "Quotation_Version";
const availableQuantityField = () =>
  process.env.CREATOR_AVAILABLE_QUANTITY_FIELD || "Available_Quantity";

const QUOTATIONS_REPORT =
  process.env.CREATOR_QUOTATIONS_REPORT || "Vendor_Quotations_Report";

// Parent multi file-upload fields on Vendor_Quotations (not in subform).
const ATTACHMENT_FIELD = process.env.CREATOR_ATTACHMENT_FIELD || "Attachment";
const DATASHEET_FIELD = process.env.CREATOR_DATASHEET_FIELD || "DataSheet";

// Reports + match fields used to resolve the lookups.
const VENDOR_REPORT = process.env.CREATOR_VENDOR_REPORT || "Vendor_Master_Report";
const VENDOR_MATCH_FIELD = process.env.CREATOR_VENDOR_MATCH_FIELD || "Vendor_Name";
const VENDOR_CODE_FIELD = process.env.CREATOR_VENDOR_CODE_FIELD || "Vendor_Code";
const VENDOR_EMAIL_FIELD = process.env.CREATOR_VENDOR_EMAIL_FIELD || "email";
const RFQ_REPORT = process.env.CREATOR_RFQ_REPORT || "RFQ1";
const RFQ_MATCH_FIELD = process.env.CREATOR_RFQ_MATCH_FIELD || "RFQ_Number";
const ITEM_MASTER_REPORT = process.env.CREATOR_ITEM_MASTER_REPORT || "Items_Report";
const ITEM_MASTER_NAME_FIELD = process.env.CREATOR_ITEM_MASTER_NAME_FIELD || "Name";
const ITEM_MASTER_SKU_FIELD = process.env.CREATOR_ITEM_MASTER_SKU_FIELD || "SKU";
const ITEM_MASTER_CODE_FIELD = process.env.CREATOR_ITEM_MASTER_CODE_FIELD || "Product_Code";
const RFQ_FORM = process.env.CREATOR_RFQ_FORM || "RFQ";
const CREATOR_WORKSPACE = process.env.CREATOR_WORKSPACE || "airatrex959";
const MARK_RECEIVED_API =
  process.env.CREATOR_MARK_RECEIVED_API || "Mark_Vendor_Quote_Received";
const MARK_RECEIVED_PUBLIC_KEY = process.env.CREATOR_MARK_RECEIVED_PUBLIC_KEY || "";
const RFQ_DUE_DATE_FIELD = process.env.CREATOR_RFQ_DUE_DATE_FIELD || "Due_Date";
const QUOTATION_CONFIRM_API =
  process.env.CREATOR_QUOTATION_CONFIRM_API || "Send_Quotation_Confirmation";
const QUOTATION_CONFIRM_PUBLIC_KEY =
  process.env.CREATOR_QUOTATION_CONFIRM_PUBLIC_KEY || "";
const DUE_DATE_PASSED_API =
  process.env.CREATOR_DUE_DATE_PASSED_API || "Send_Due_Date_Passed_Notice";
const DUE_DATE_PASSED_PUBLIC_KEY = process.env.CREATOR_DUE_DATE_PASSED_PUBLIC_KEY || "";
const RFQ_PRODUCTS_SUBFORM = process.env.CREATOR_RFQ_PRODUCTS_SUBFORM || "RFQ_Products";

// RFQ > Vendor_Selection subform — updated when vendor submits a quote.
const RFQ_VENDOR_SELECTION =
  process.env.CREATOR_RFQ_VENDOR_SELECTION || "Vendor_Selection";
const VS_PRODUCTS = "Products_Name1";
const VS_VENDOR = "Vendor_Master";
const VS_EMAIL_SENT = "RFQ_Email_Sent";
const VS_EMAIL_DATE = "Email_Sent_Date";
const VS_RESPONSE = "Vendor_Response_Status";
const VENDOR_RESPONSE_RECEIVED = "Received";

// Quotation_Items > Currency dropdown — must match Creator choice labels exactly.
const CREATOR_CURRENCY_CHOICES = {
  INR: "INR - Indian Rupee",
  USD: "USD - US Dollar",
  EUR: "EUR - Euro",
  AED: "AED - UAE Dirham",
  JPY: "JPY - Japanese Yen",
  GBP: "GBP - British Pound Sterling",
  SAR: "SAR - Saudi Riyal",
  SGD: "SGD - Singapore Dollar",
};

function mapCreatorCurrency(code) {
  const key = String(code || "INR").trim().toUpperCase();
  return CREATOR_CURRENCY_CHOICES[key] || CREATOR_CURRENCY_CHOICES.INR;
}

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

function parseQuotationVersionNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^v?(\d+)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isNaN(n) ? null : n;
}

function formatQuotationVersion(versionNumber) {
  return `v${Math.max(0, Number(versionNumber) || 0)}`;
}

/*
 * List prior Vendor_Quotations for the same RFQ + vendor (per-vendor revision chain).
 */
async function listVendorQuotationsForRfq(rfqId, vendorId, token) {
  if (!rfqId || !vendorId) return [];

  const criteriaAttempts = [
    `(${rfqField()} == ${rfqId}) && (${vendorField()} == ${vendorId})`,
    `(${rfqField()}.ID == ${rfqId}) && (${vendorField()}.ID == ${vendorId})`,
  ];

  for (const criteria of criteriaAttempts) {
    try {
      const url =
        `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}` +
        `?criteria=${encodeURIComponent(criteria)}&max_records=200&field_config=all`;
      const res = await fetch(url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (data.code === 3000 && Array.isArray(data.data) && data.data.length) {
        return data.data;
      }
    } catch {
      // try next criteria
    }
  }
  return [];
}

async function resolveNextQuotationVersion(rfqId, vendorId, token) {
  const rows = await listVendorQuotationsForRfq(rfqId, vendorId, token);
  let maxVersion = -1;
  const versionKey = quotationVersionField();

  rows.forEach((row) => {
    const parsed = parseQuotationVersionNumber(row[versionKey]);
    if (parsed != null && parsed > maxVersion) maxVersion = parsed;
  });

  return formatQuotationVersion(maxVersion + 1);
}

export function formatCreatorError(data) {
  if (Array.isArray(data?.error) && data.error.length) return data.error.join("; ");
  return data?.message || data?.description || "Zoho Creator rejected the submission.";
}

/* Resolve Item_Master lookup from the item / product record id in the email link. */
async function resolveItemMasterId(p, token) {
  async function acceptIfValid(id) {
    if (!id) return null;
    const valid = await validateReportRecordId(ITEM_MASTER_REPORT, id, token);
    if (valid) return valid;
    if (isRecordId(id)) {
      return String(id);
    }
    return null;
  }

  for (const candidate of [p.itemMasterId, p.itemId]) {
    const resolved = await acceptIfValid(candidate);
    if (resolved) return resolved;
  }

  for (const [field, value] of [
    [ITEM_MASTER_NAME_FIELD, p.product],
    [ITEM_MASTER_SKU_FIELD, p.sku],
    [ITEM_MASTER_CODE_FIELD, p.itemId],
  ]) {
    if (!value) continue;
    const id = await resolveRecordId(ITEM_MASTER_REPORT, field, value, token);
    const resolved = await acceptIfValid(id);
    if (resolved) return resolved;
  }

  if (p.rfqRecordId) {
    const rfqRec = await fetchRfqRecord(p.rfqRecordId, token);
    const rows = rfqRec?.[RFQ_PRODUCTS_SUBFORM];
    if (Array.isArray(rows) && rows.length) {
      const needle = String(p.product || "").trim().toLowerCase();
      for (const row of rows) {
        const im = row.Product || row.Item_Master;
        const label = String(
          (typeof im === "object" && (im.display_value || im.zc_display_value)) || ""
        )
          .trim()
          .toLowerCase();
        const id = lookupId(im);
        if (!id) continue;
        if (!needle || label === needle) {
          const resolved = await acceptIfValid(id);
          if (resolved) return resolved;
        }
      }
    }
  }

  return null;
}

export function buildSubformRow(p) {
  const qty = num(p.quantity, 1);
  const gstPct = num(p.gst, 18);
  const unitPrice = num(p.price);
  const lineSubtotal = unitPrice * qty;
  const gstAmount = Math.round(((lineSubtotal * gstPct) / 100) * 100) / 100;
  const lineTotal = Math.round((lineSubtotal + gstAmount) * 100) / 100;

  const row = {
    Quantity: qty,
    Currency: mapCreatorCurrency(p.currency),
    Unit_Price: unitPrice,
    GST: gstPct,
    Total_Amount: lineTotal,
    [itemStatusField()]: defaultStatus(),
  };

  if (p.description) {
    row.Description = p.description;
  }
  if (p.remarks) {
    row.Remarks = p.remarks;
  }

  const deliveryFormatted = formatCreatorDate(p.deliveryDate);
  if (deliveryFormatted) {
    row.Delivery_Date = `${deliveryFormatted} 00:00:00`;
  }

  if (p.itemMasterId) {
    row.Item_Master = p.itemMasterId;
  }

  const availQty = num(p.availableQuantity, NaN);
  if (!Number.isNaN(availQty) && availQty >= 0) {
    row[availableQuantityField()] = availQty;
  }

  return { row, lineSubtotal, gstAmount, lineTotal };
}



function logApiExchange(tag, config, response) {
  console.log(tag, JSON.stringify({ config, response }, null, 2));
}

function buildParentUploadUrl(recordId, fieldName) {
  const base =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}`;
  const skipWorkflow = encodeURIComponent(JSON.stringify(["form_workflow", "schedules"]));
  return `${base}/${recordId}/${fieldName}/upload?skip_workflow=${skipWorkflow}`;
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

async function uploadParentFieldFile(recordId, fieldName, file, token) {
  const url = buildParentUploadUrl(recordId, fieldName);
  const fd = new FormData();
  fd.append('file', file.buffer, {
    filename: file.originalname || 'upload.bin',
    contentType: file.mimetype || 'application/octet-stream',
  });

  try {
    const res = await axios.post(url, fd, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...fd.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const ok = res.status >= 200 && res.status < 300 && Number(data.code) === 3000;

    logApiExchange('[file-upload]', {
      method: 'POST',
      url,
      recordId,
      field: fieldName,
      fileName: file.originalname || 'upload.bin',
      contentType: file.mimetype || 'application/octet-stream',
      fileSize: file.buffer?.length || 0,
    }, {
      httpStatus: res.status,
      ok,
      ...(typeof data === 'object' && Object.keys(data).length ? data : { raw: res.data }),
    });

    return {
      ok,
      field: fieldName,
      status: res.status,
      data,
      fileName: file.originalname || 'upload.bin',
    };
  } catch (e) {
    logApiExchange('[file-upload]', {
      method: 'POST',
      url,
      recordId,
      field: fieldName,
      fileName: file.originalname || 'upload.bin',
      contentType: file.mimetype || 'application/octet-stream',
      fileSize: file.buffer?.length || 0,
    }, {
      ok: false,
      error: e.message,
    });
    return {
      ok: false,
      field: fieldName,
      status: 0,
      data: {},
      error: e.message,
      fileName: file.originalname || 'upload.bin',
    };
  }
}

async function uploadQuotationParentFiles(recordId, files, token) {
  const results = [];
  const attachmentFiles = files?.attachment || [];
  const datasheetFiles = files?.datasheet || [];
  const hasAny = attachmentFiles.length > 0 || datasheetFiles.length > 0;
  if (!hasAny) return { attempted: false, results };

  for (const file of attachmentFiles) {
    results.push(await uploadParentFieldFile(recordId, ATTACHMENT_FIELD, file, token));
  }
  for (const file of datasheetFiles) {
    results.push(await uploadParentFieldFile(recordId, DATASHEET_FIELD, file, token));
  }

  const filesUploadedOk = results.every((r) => r.ok);
  return {
    attempted: true,
    results,
    filesUploadedOk,
    allOk: filesUploadedOk,
    error: filesUploadedOk
      ? null
      : results
          .filter((r) => !r.ok)
          .map((r) => `${r.field}: ${describeUploadError(r.status, r.data, r.error)}`)
          .join('; '),
  };
}

export function parseQuotationFiles(reqFiles = []) {
  const files = { attachment: [], datasheet: [] };
  for (const file of reqFiles) {
    const name = String(file.fieldname || '').toLowerCase();
    if (name === 'attachment') files.attachment.push(file);
    else if (name === 'datasheet') files.datasheet.push(file);
  }
  return files;
}


function lookupId(val) {
  if (val == null || val === "") return "";
  if (typeof val === "object") {
    const id = val.ID ?? val.id;
    return id != null && id !== "" ? String(id) : "";
  }
  return String(val);
}

function extractPlainValue(val) {
  if (val == null || val === "") return "";
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return String(val).trim();
  }
  if (typeof val === "object") {
    return String(
      val.display_value ?? val.zc_display_value ?? val.value ?? val.name ?? ""
    ).trim();
  }
  return String(val).trim();
}

/*
 * Build a Creator-safe Vendor_Selection row for PATCH.
 * Only sends lookup IDs + status. Omits Email_Sent_Date / RFQ_Email_Sent —
 * round-tripping those API values causes Zoho error 2930.
 */
function buildVsRowForPatch(vsRow, responseStatus) {
  const rowMap = {};
  if (vsRow.ID != null) rowMap.ID = String(vsRow.ID);

  const productId = extractVsProductId(vsRow);
  const vendorIds = normalizeVendorIds(vsRow[VS_VENDOR]);

  if (productId) rowMap[VS_PRODUCTS] = productId;
  if (vendorIds.length) rowMap[VS_VENDOR] = vendorIds;

  rowMap[VS_RESPONSE] = responseStatus || extractPlainValue(vsRow[VS_RESPONSE]) || "Pending";
  return rowMap;
}

async function patchRfqVendorSelection(rfqRecordId, updatedRows, token, options = {}) {
  const account = owner();
  const appName = app();
  if (!account || !appName || !rfqRecordId) {
    return {
      ok: false,
      patchData: {
        code: 1000,
        description: `Invalid Creator URL — check CREATOR_ACCOUNT_OWNER (${account}) and CREATOR_APP_LINK_NAME (${appName})`,
      },
      body: {},
      patchUrl: "",
    };
  }

  const patchUrl =
    `${API_HOST}/creator/v2.1/data/${account}/${appName}/report/${RFQ_REPORT}/${rfqRecordId}`;
  const body = {
    data: { [RFQ_VENDOR_SELECTION]: updatedRows },
  };
  if (options.skipWorkflow) {
    body.skip_workflow = ["form_workflow", "schedules"];
  }
  if (options.resultFields?.length) {
    body.result = { fields: options.resultFields, message: false, tasks: false };
  }

  const patchRes = await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const patchData = await patchRes.json().catch(() => ({}));
  return { ok: patchRes.ok && patchData.code === 3000, patchData, body, patchUrl };
}

function joinItemIds(submittedItemIds) {
  return Array.from(submittedItemIds).filter(Boolean).join("|");
}

function parseDelugeMarkResponse(raw) {
  const text =
    typeof raw === "string"
      ? raw
      : raw?.result || raw?.message || raw?.description || JSON.stringify(raw || "");
  const rowsMatch = String(text).match(/(\d+)\s+row/i);
  const rowsUpdated = rowsMatch ? Number(rowsMatch[1]) : 0;
  const lowered = String(text).toLowerCase();
  const hasEmbeddedFailure =
    lowered.includes("json_parse_error") ||
    lowered.includes("error:") ||
    /"code"\s*:\s*(2945|2930)/.test(String(text));
  const ok =
    lowered.includes("success") &&
    rowsUpdated > 0 &&
    !hasEmbeddedFailure;
  return { ok, rowsUpdated, message: String(text).trim() };
}

/*
 * Invoke Creator Custom API (Deluge + zoho.creator.updateRecord).
 * Use Public Key auth (same as Send_Notification_to_vendor) — OAuth returns 2945.
 */
async function invokeMarkVendorQuoteReceivedCustomApi({
  rfqRecordId,
  vendorRecordId,
  itemIds,
  contactEmail,
  token,
}) {
  const payload = {
    rfqRecordId: String(rfqRecordId),
    vendorRecordId: String(vendorRecordId || ""),
    itemIds: String(itemIds || ""),
    contactEmail: String(contactEmail || ""),
  };

  const baseUrl = `${API_HOST}/creator/custom/${CREATOR_WORKSPACE}/${MARK_RECEIVED_API}`;
  const attempts = [];

  if (MARK_RECEIVED_PUBLIC_KEY) {
    const pkUrl = `${baseUrl}?publickey=${encodeURIComponent(MARK_RECEIVED_PUBLIC_KEY)}`;
    attempts.push({
      label: "public_key_json",
      url: pkUrl,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    attempts.push({
      label: "public_key_form",
      url: pkUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString(),
    });
  }

  if (token) {
    attempts.push({
      label: "oauth_json",
      url: baseUrl,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  if (!attempts.length) {
    return {
      attempted: false,
      ok: false,
      reason:
        "Set CREATOR_MARK_RECEIVED_PUBLIC_KEY on Render (switch Custom API auth to Public Key in Creator).",
    };
  }

  let lastFailure = null;

  for (const attempt of attempts) {
    const res = await fetch(attempt.url, {
      method: "POST",
      headers: attempt.headers,
      body: attempt.body,
    });
    const data = await res.json().catch(() => ({}));

    if (Number(data?.code) === 3000) {
      const parsed = parseDelugeMarkResponse(data.result ?? data.message ?? data);
      return {
        attempted: true,
        ok: parsed.ok,
        method: `custom_api_${attempt.label}`,
        rowsUpdated: parsed.rowsUpdated,
        message: parsed.message,
        detail: data,
        payload,
        url: attempt.url,
      };
    }

    if (Number(data?.code) === 2945) {
      lastFailure = {
        attempted: true,
        ok: false,
        method: `custom_api_${attempt.label}`,
        error:
          "OAuth scope invalid (2945). In Creator → Mark_Vendor_Quote_Received → change Authentication to Public Key, copy key to CREATOR_MARK_RECEIVED_PUBLIC_KEY on Render.",
        detail: data,
        payload,
        url: attempt.url,
      };
      continue;
    }

    if (Number(data?.code) === 9400) {
      lastFailure = {
        attempted: true,
        ok: false,
        method: `custom_api_${attempt.label}`,
        error:
          "Invalid HTTP method (9400). Custom API Mark_Vendor_Quote_Received must be Method: POST (not GET). Do not open the URL in a browser — backend already uses POST.",
        detail: data,
        payload,
        url: attempt.url,
      };
      continue;
    }

    const parsed = parseDelugeMarkResponse(data?.result ?? data?.message ?? data);
    lastFailure = {
      attempted: true,
      ok: false,
      method: `custom_api_${attempt.label}`,
      error: parsed.message || formatCreatorError(data),
      detail: data,
      payload,
      url: attempt.url,
    };
  }

  return lastFailure;
}

function normalizeVendorIds(vendorMaster) {
  if (vendorMaster == null) return [];
  if (Array.isArray(vendorMaster)) {
    return vendorMaster.map(lookupId).filter(Boolean);
  }
  if (typeof vendorMaster === "string") {
    const text = vendorMaster.trim();
    if (!text) return [];
    if (text.includes(",")) {
      return text
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    const one = lookupId(text);
    return one ? [one] : isRecordId(text) ? [text] : [];
  }
  const one = lookupId(vendorMaster);
  return one ? [one] : [];
}

function extractVsProductId(vsRow) {
  if (!vsRow || typeof vsRow !== "object") return "";
  const keys = [
    VS_PRODUCTS,
    `${VS_PRODUCTS}.ID`,
    "Products_Name1.ID",
    "Products_Name.ID",
  ];
  for (const key of keys) {
    const id = lookupId(vsRow[key]);
    if (id) return id;
  }
  return lookupId(vsRow[VS_PRODUCTS]);
}

function extractVsProductName(vsRow) {
  if (!vsRow || typeof vsRow !== "object") return "";
  const raw = vsRow[VS_PRODUCTS];
  if (raw && typeof raw === "object") {
    return String(
      raw.display_value || raw.zc_display_value || raw.Name || raw.name || ""
    ).trim();
  }
  for (const key of [`${VS_PRODUCTS}.display_value`, `${VS_PRODUCTS}.zc_display_value`]) {
    const val = vsRow[key];
    if (val) return String(val).trim();
  }
  return "";
}

async function fetchVendorIdsByEmail(email, token) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return [];

  const attempts = [normalized];
  if (normalized !== String(email || "").trim()) {
    attempts.push(String(email || "").trim());
  }

  const ids = new Set();
  for (const value of attempts) {
    const criteria = `${VENDOR_EMAIL_FIELD}=="${String(value).replace(/"/g, '\\"')}"`;
    const url =
      `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${VENDOR_REPORT}` +
      `?criteria=${encodeURIComponent(criteria)}&max_records=200`;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (data.code === 3000 && Array.isArray(data.data)) {
      data.data.forEach((row) => {
        const id = lookupId(row.ID ?? row.id);
        if (id) ids.add(id);
      });
    }
  }
  return Array.from(ids);
}

async function resolveSubmittingVendorIds(
  { vendorRecordId, vendorId, contactEmail, linePayloads },
  token
) {
  const ids = new Set();

  for (const candidate of [vendorRecordId, vendorId]) {
    const valid = await validateReportRecordId(VENDOR_REPORT, candidate, token);
    if (valid) ids.add(valid);
    else if (candidate && isRecordId(candidate)) ids.add(String(candidate));
  }

  (linePayloads || []).forEach((line) => {
    for (const candidate of [line.vendorRecordId, line.vendorId]) {
      if (candidate && isRecordId(candidate)) ids.add(String(candidate));
    }
  });

  const emailIds = await fetchVendorIdsByEmail(contactEmail, token);
  emailIds.forEach((id) => ids.add(id));

  return ids;
}

function collectSubmittedItemIds(linePayloads, resolvedItemMasters) {
  const ids = new Set();
  resolvedItemMasters.forEach((id) => {
    if (id) ids.add(String(id));
  });
  linePayloads.forEach((line) => {
    for (const candidate of [line.itemMasterId, line.itemId]) {
      if (candidate) ids.add(String(candidate));
    }
  });
  return ids;
}

function collectSubmittedProductNames(linePayloads) {
  const names = new Set();
  (linePayloads || []).forEach((line) => {
    const name = String(line.product || "").trim().toLowerCase();
    if (name) names.add(name);
  });
  return names;
}

function rowMatchesSubmittedItems(vsRow, submittedItemIds, submittedProductNames) {
  const productId = extractVsProductId(vsRow);
  if (productId && submittedItemIds.has(productId)) return true;

  const productName = extractVsProductName(vsRow).toLowerCase();
  if (productName && submittedProductNames.has(productName)) return true;

  return submittedItemIds.size === 0 && submittedProductNames.size === 0;
}

async function fetchRfqRecord(rfqRecordId, token) {
  if (!isRecordId(rfqRecordId)) return null;
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${RFQ_REPORT}` +
    `/${rfqRecordId}?field_config=all`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 3000) {
    return null;
  }
  return Array.isArray(data.data) ? data.data[0] : data.data;
}

/*
 * After a vendor quotation is saved, mark matching RFQ Vendor_Selection rows
 * as Vendor_Response_Status = "Received".
 */
export async function markVendorQuoteReceived({
  rfqRecordId,
  vendorRecordId,
  vendorId,
  contactEmail,
  linePayloads,
  resolvedItemMasters,
  token,
}) {
  if (!rfqRecordId) {
    return { attempted: false, ok: false, reason: "missing rfqRecordId" };
  }

  const rfqRec = await fetchRfqRecord(rfqRecordId, token);
  if (!rfqRec) {
    return { attempted: true, ok: false, error: "Could not read RFQ record." };
  }

  const existingRows = rfqRec[RFQ_VENDOR_SELECTION];
  if (!Array.isArray(existingRows) || !existingRows.length) {
    return { attempted: true, ok: false, error: "RFQ has no Vendor_Selection rows." };
  }

  const submittingVendorIds = await resolveSubmittingVendorIds(
    { vendorRecordId, vendorId, contactEmail, linePayloads },
    token
  );

  if (!submittingVendorIds.size) {
    return {
      attempted: true,
      ok: false,
      error: "Could not resolve submitting vendor id(s).",
    };
  }

  const submittedItemIds = collectSubmittedItemIds(linePayloads, resolvedItemMasters);
  const submittedProductNames = collectSubmittedProductNames(linePayloads);
  let rowsUpdated = 0;
  const matchDebug = [];

  const updatedRows = existingRows.map((vsRow) => {
    const productId = extractVsProductId(vsRow);
    const vendorIds = normalizeVendorIds(vsRow[VS_VENDOR]);

    const vendorInRow = vendorIds.some((id) => submittingVendorIds.has(String(id)));
    const itemQuoted = rowMatchesSubmittedItems(
      vsRow,
      submittedItemIds,
      submittedProductNames
    );

    const nextStatus =
      vendorInRow && itemQuoted
        ? VENDOR_RESPONSE_RECEIVED
        : extractPlainValue(vsRow[VS_RESPONSE]) || "Pending";

    if (vendorInRow && itemQuoted) {
      rowsUpdated += 1;
    } else {
      matchDebug.push({
        rowId: vsRow.ID,
        productId,
        vendorIds,
        vendorInRow,
        itemQuoted,
      });
    }

    return buildVsRowForPatch(vsRow, nextStatus);
  });

  if (!rowsUpdated) {
    return {
      attempted: true,
      ok: false,
      error: "No Vendor_Selection row matched vendor + quoted items.",
      debug: {
        submittingVendorIds: Array.from(submittingVendorIds),
        submittedItemIds: Array.from(submittedItemIds),
        submittedProductNames: Array.from(submittedProductNames),
        rows: matchDebug,
      },
    };
  }

  const itemIds = joinItemIds(submittedItemIds);
  const primaryVendorId = Array.from(submittingVendorIds)[0] || String(vendorRecordId || "");

  // 1) Custom API + Deluge (OAuth2 or Public Key — avoids REST error 2930)
  const customResult = await invokeMarkVendorQuoteReceivedCustomApi({
    rfqRecordId,
    vendorRecordId: primaryVendorId,
    itemIds,
    contactEmail,
    token,
  });
  if (customResult.ok) {
    return {
      attempted: true,
      ok: true,
      rowsUpdated: customResult.rowsUpdated || rowsUpdated,
      method: "custom_api",
      detail: customResult.detail,
      message: customResult.message,
    };
  }

  // 2) REST PATCH fallback (report/RFQ1 only — form path caused error 1000)
  const restAttempts = [
    { label: "report", skipWorkflow: false },
    { label: "report+skip_workflow", skipWorkflow: true },
  ];

  let patchResult = null;
  for (const attempt of restAttempts) {
    patchResult = await patchRfqVendorSelection(rfqRecordId, updatedRows, token, {
      skipWorkflow: attempt.skipWorkflow,
    });
    if (patchResult.ok) {
      return {
        attempted: true,
        ok: true,
        rowsUpdated,
        method: `rest_${attempt.label}`,
        detail: patchResult.patchData,
      };
    }
    if (patchResult.patchData?.code !== 2930 && patchResult.patchData?.code !== 1000) break;
  }

  // 3) Status-only REST fallback
  if (patchResult && !patchResult.ok) {
    const statusOnlyRows = existingRows.map((vsRow) => {
      const productId = extractVsProductId(vsRow);
      const vendorIds = normalizeVendorIds(vsRow[VS_VENDOR]);
      const vendorInRow = vendorIds.some((id) => submittingVendorIds.has(String(id)));
      const itemQuoted = rowMatchesSubmittedItems(
        vsRow,
        submittedItemIds,
        submittedProductNames
      );
      const status =
        vendorInRow && itemQuoted
          ? VENDOR_RESPONSE_RECEIVED
          : extractPlainValue(vsRow[VS_RESPONSE]) || "Pending";
      return {
        ID: String(vsRow.ID),
        [VS_RESPONSE]: status,
      };
    });
    patchResult = await patchRfqVendorSelection(rfqRecordId, statusOnlyRows, token, {
      skipWorkflow: false,
      resultFields: [VS_RESPONSE],
    });
  }

  const { ok, patchData, body, patchUrl } = patchResult || {
    ok: false,
    patchData: {},
    body: {},
    patchUrl: "",
  };

  if (!ok) {
    return {
      attempted: true,
      ok: false,
      rowsUpdated,
      error:
        formatCreatorError(patchData) +
        " — Custom API also failed; check Render logs for custom_api response.",
      detail: patchData,
    };
  }

  return { attempted: true, ok: true, rowsUpdated, method: "rest", detail: patchData };
}

function parseDelugeCustomApiResponse(raw) {
  const text =
    typeof raw === "string"
      ? raw
      : raw?.result || raw?.message || raw?.description || JSON.stringify(raw || "");
  const trimmed = String(text).trim();
  const lowered = trimmed.toLowerCase();
  const hasEmbeddedFailure =
    lowered.includes("json_parse_error") ||
    lowered.startsWith("error:") ||
    /"code"\s*:\s*(2945|2930)/.test(trimmed);
  const ok =
    (lowered.startsWith("success:") ||
      lowered.includes("email sent") ||
      lowered.includes("success")) &&
    !hasEmbeddedFailure;
  return { ok, message: trimmed };
}

async function invokeCreatorCustomApi({ apiName, publicKey, payload, token }) {
  if (!apiName) {
    return { attempted: false, ok: false, reason: "missing api name" };
  }

  const baseUrl = `${API_HOST}/creator/custom/${CREATOR_WORKSPACE}/${apiName}`;
  const attempts = [];
  const envHint = `Set CREATOR_*_PUBLIC_KEY for ${apiName} in .env / Render (Creator → Microservices → ${apiName} → Public Key auth).`;

  if (publicKey) {
    const pkUrl = `${baseUrl}?publickey=${encodeURIComponent(publicKey)}`;
    attempts.push({
      label: "public_key_json",
      url: pkUrl,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    attempts.push({
      label: "public_key_form",
      url: pkUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(
        Object.fromEntries(
          Object.entries(payload).map(([k, v]) => [k, v == null ? "" : String(v)])
        )
      ).toString(),
    });
  }

  if (token) {
    attempts.push({
      label: "oauth_json",
      url: baseUrl,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  if (!attempts.length) {
    return {
      attempted: false,
      ok: false,
      reason: `No public key or OAuth token available for Custom API ${apiName}. ${envHint}`,
    };
  }

  let lastFailure = null;
  for (const attempt of attempts) {
    const res = await fetch(attempt.url, {
      method: "POST",
      headers: attempt.headers,
      body: attempt.body,
    });
    const data = await res.json().catch(() => ({}));
    const parsed = parseDelugeCustomApiResponse(data.result ?? data.message ?? data);

    if (Number(data?.code) === 3000 && parsed.ok) {
      return {
        attempted: true,
        ok: true,
        method: `custom_api_${attempt.label}`,
        message: parsed.message,
        detail: data,
      };
    }

    if (Number(data?.code) === 3000 && !parsed.message.toLowerCase().includes("error:")) {
      return {
        attempted: true,
        ok: true,
        method: `custom_api_${attempt.label}`,
        message: parsed.message,
        detail: data,
      };
    }

    if (Number(data?.code) === 2945) {
      lastFailure = {
        attempted: true,
        ok: false,
        method: `custom_api_${attempt.label}`,
        error:
          attempt.label.startsWith("public_key")
            ? `Custom API ${apiName} rejected the public key (2945). Re-copy the key from Creator → Microservices → ${apiName}.`
            : `OAuth scope invalid (2945) for ${apiName}. Use Public Key auth in Creator and set the matching CREATOR_*_PUBLIC_KEY. ${envHint}`,
        detail: data,
      };
      continue;
    }

    lastFailure = {
      attempted: true,
      ok: false,
      method: `custom_api_${attempt.label}`,
      error: parsed.message || formatCreatorError(data) || "Custom API call failed.",
      detail: data,
    };
  }

  if (!publicKey && lastFailure?.method === "custom_api_oauth_json") {
    lastFailure.error = `${lastFailure.error} ${envHint}`;
  }

  return (
    lastFailure || {
      attempted: true,
      ok: false,
      error: `Custom API ${apiName} failed. ${envHint}`,
    }
  );
}

/**
 * RFQ line items for vendor form — quantity/unit from RFQ_Products when URL params are missing.
 */
export async function fetchRfqLineItemsForForm({ rfqRecordId, rfqNumber }) {
  const token = await getAccessToken();
  const rfqId = await resolveRfqId({ rfqRecordId, rfqNumber }, token);
  if (!rfqId) {
    return { ok: false, items: [], reason: "rfq_not_found" };
  }

  const rfqRec = await fetchRfqRecord(rfqId, token);
  if (!rfqRec) {
    return { ok: false, items: [], reason: "rfq_not_found" };
  }

  const rows = rfqRec[RFQ_PRODUCTS_SUBFORM];
  if (!Array.isArray(rows) || !rows.length) {
    return {
      ok: true,
      items: [],
      rfqNumber: rfqRec.RFQ_Number || rfqNumber,
    };
  }

  const items = rows.map((row) => {
    const productField = row.Product ?? row.Item_Master;
    const itemMasterId = lookupId(productField);
    const rowId = lookupId(row.ID ?? row.id);
    const product = extractPlainValue(productField);
    const qtyRaw = row.Quantity ?? row.quantity;
    const quantity =
      qtyRaw === null || qtyRaw === undefined || qtyRaw === ""
        ? ""
        : String(qtyRaw).trim();
    const unit = extractPlainValue(row.Unit ?? row.unit);
    return {
      itemId: itemMasterId || rowId,
      rowId,
      product,
      quantity,
      unit,
    };
  });

  return {
    ok: true,
    rfqNumber: rfqRec.RFQ_Number || rfqNumber,
    items,
  };
}

/**
 * Check RFQ Due_Date before accepting a vendor submission.
 * Only submissions after the due date (IST) are blocked.
 */
export async function validateRfqSubmissionDeadline({ rfqRecordId, rfqNumber }) {
  const token = await getAccessToken();
  const rfqId = await resolveRfqId({ rfqRecordId, rfqNumber }, token);
  if (!rfqId) {
    return { allowed: true, dueDate: null, dueDateIso: null, reason: "rfq_not_resolved" };
  }

  const rfqRec = await fetchRfqRecord(rfqId, token);
  if (!rfqRec) {
    return { allowed: true, dueDate: null, dueDateIso: null, reason: "rfq_not_found" };
  }

  const dueDate = readRfqDueDate(rfqRec, RFQ_DUE_DATE_FIELD);
  if (!dueDate) {
    return {
      allowed: true,
      dueDate: null,
      dueDateIso: null,
      rfqId,
      rfqNumber: rfqRec.RFQ_Number || rfqNumber,
    };
  }

  const passed = isRfqDueDatePassed(dueDate);
  return {
    allowed: !passed,
    dueDate,
    dueDateIso: dueDateToIso(dueDate),
    dueDateDisplay: formatDueDateDisplay(dueDate),
    rfqId,
    rfqNumber: rfqRec.RFQ_Number || rfqNumber,
    passed,
  };
}

export async function sendDueDatePassedNoticeEmail(payload) {
  const token = await getAccessToken();
  const email = String(payload.contactEmail || "").trim();
  if (!email) {
    return { attempted: false, ok: false, reason: "missing vendor email" };
  }

  return invokeCreatorCustomApi({
    apiName: DUE_DATE_PASSED_API,
    publicKey: DUE_DATE_PASSED_PUBLIC_KEY,
    token,
    payload: {
      vendorEmail: email,
      vendorName: String(payload.vendorName || "").trim(),
      rfqNumber: String(payload.rfqNumber || "").trim(),
      dueDate: String(payload.dueDateDisplay || payload.dueDate || "").trim(),
    },
  });
}

export async function sendQuotationConfirmationEmail(payload) {
  const token = await getAccessToken();
  const email = String(payload.contactEmail || "").trim();
  if (!email) {
    return { attempted: false, ok: false, reason: "missing vendor email" };
  }

  return invokeCreatorCustomApi({
    apiName: QUOTATION_CONFIRM_API,
    publicKey: QUOTATION_CONFIRM_PUBLIC_KEY,
    token,
    payload: {
      vendorEmail: email,
      vendorName: String(payload.vendorName || "").trim(),
      rfqNumber: String(payload.rfqNumber || "").trim(),
      quotationVersion: String(payload.quotationVersion || "").trim(),
      submissionDate: formatSubmissionDate(),
    },
  });
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
          vendorRecordId: line.vendorRecordId || flatPayload.vendorRecordId,
          vendorId: line.vendorId || flatPayload.vendorId,
          description: line.description,
          deliveryDate: line.deliveryDate,
          totalAmount: line.totalAmount,
          price: line.price,
          gst: line.gst,
          remarks: line.remarks,
          availableQuantity: line.availableQuantity,
          uniqueId: line.uniqueId || flatPayload.uniqueId,
        }));
      }
    } catch {
      // invalid items JSON — fall through to single-item payload
    }
  }

  if (!linePayloads.length) {
    linePayloads = [{ ...flatPayload, itemMasterId: flatPayload.itemMasterId || flatPayload.itemId }];
  }

  const subformRows = [];
  const resolvedItemMasters = [];

  for (let i = 0; i < linePayloads.length; i += 1) {
    const line = linePayloads[i];
    const itemMasterId = await resolveItemMasterId(
      {
        ...line,
        rfqRecordId: flatPayload.rfqRecordId,
      },
      token
    );
    resolvedItemMasters.push(itemMasterId);
    const built = buildSubformRow({
      ...line,
      itemMasterId,
    });
    subformRows.push(built.row);
  }

  const data = {
    Submission_Date: formatSubmissionDate(),
    [subform()]: subformRows,
    Margin: 0,
  };

  // Only set lookups we could resolve (avoids "Invalid column value").
  if (vendorId) data[vendorField()] = vendorId;
  if (rfqId) data[rfqField()] = rfqId;

  let quotationVersion = formatQuotationVersion(0);
  if (rfqId && vendorId) {
    quotationVersion = await resolveNextQuotationVersion(rfqId, vendorId, token);
  }
  data[quotationVersionField()] = quotationVersion;

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

  // Step 2: upload files to parent Attachment / DataSheet fields
  let uploads = { attempted: false, results: [] };
  if (ok && recordId) {
    uploads = await uploadQuotationParentFiles(recordId, files, token);
  }

  // Step 3: mark RFQ Vendor_Selection as Received for this vendor + items
  let vendorStatus = { attempted: false, ok: false };
  if (ok) {
    vendorStatus = await markVendorQuoteReceived({
      rfqRecordId: flatPayload.rfqRecordId || rfqId,
      vendorRecordId: flatPayload.vendorRecordId || vendorId,
      vendorId: flatPayload.vendorId || vendorId,
      contactEmail: flatPayload.contactEmail,
      linePayloads,
      resolvedItemMasters,
      token,
    });
  }

  return {
    ok,
    status: res.status,
    data: respData,
    recordId,
    quotationVersion,
    resolved: { vendorId, rfqId, itemMasters: resolvedItemMasters },
    uploads,
    vendorStatus,
  };
}

