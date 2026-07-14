/*
 * Vendor_Quotations — Creator link names (confirmed):
 *
 * Parent: RFQ, Vendor_Master, Submission_Date, Margin,
 *         Total_Amount (grand total), Delivery_Date, Currency
 *
 * Subform Quotation_Items: Description, Quantity, Available_Quantity, Unit_Price, GST (%),
 *         Total_Amount (line), Delivery_Date, Currency (dropdown label),
 *         Item_Master, Attachment, Datasheet, Attachment_Filepath, Datasheet_Filepath (https download URLs),
 *         Status (per line → Pending Review)
 *
 * RFQ form RFQ_Products subform (qty source for vendor email): Product, Quantity (DECIMAL), Unit
 *
 * Parent Quotation_Version: v0 first submit per RFQ+vendor, then v1, v2, …
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
const vendorField = () => process.env.CREATOR_VENDOR_FIELD || "Vendor_Master";
const defaultStatus = () => process.env.CREATOR_DEFAULT_STATUS || "Pending Review";
const itemStatusField = () => process.env.CREATOR_ITEM_STATUS_FIELD || "Status";
const quotationVersionField = () =>
  process.env.CREATOR_QUOTATION_VERSION_FIELD || "Quotation_Version";
const availableQuantityField = () =>
  process.env.CREATOR_AVAILABLE_QUANTITY_FIELD || "Available_Quantity";
const attachmentFilepathField = () =>
  process.env.CREATOR_ATTACHMENT_FILEPATH_FIELD || "Attachment_Filepath";
const datasheetFilepathField = () =>
  process.env.CREATOR_DATASHEET_FILEPATH_FIELD || "Datasheet_Filepath";

function filepathFieldForUploadField(uploadFieldName) {
  if (uploadFieldName === ATTACHMENT_FIELD) return attachmentFilepathField();
  if (uploadFieldName === DATASHEET_FIELD) return datasheetFilepathField();
  return null;
}

function applyRowFieldUpdatesToPatchRow(row, rowId, rowFieldUpdates) {
  const updates = rowFieldUpdates?.[rowId];
  if (!updates || typeof updates !== "object") return;
  Object.entries(updates).forEach(([field, url]) => {
    if (url) row[field] = url;
  });
}

function rowFieldUpdatesHasEntries(rowFieldUpdates) {
  return Object.values(rowFieldUpdates || {}).some(
    (fields) => fields && typeof fields === "object" && Object.keys(fields).length > 0
  );
}

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
    } catch (e) {
      console.warn(`listVendorQuotationsForRfq criteria failed (${criteria}):`, e);
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Resolve Item_Master lookup from the item / product record id in the email link. */
async function resolveItemMasterId(p, token) {
  async function acceptIfValid(id) {
    if (!id) return null;
    const valid = await validateReportRecordId(ITEM_MASTER_REPORT, id, token);
    if (valid) return valid;
    if (isRecordId(id)) {
      console.warn(
        `Item_Master id ${id} not found in ${ITEM_MASTER_REPORT}; using as lookup anyway.`
      );
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

async function getQuotationRecordById(recordId, token) {
  const url =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}` +
    `/${recordId}?field_config=all`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 3000) {
    console.error("getQuotationRecordById failed:", data);
    return null;
  }
  const rec = Array.isArray(data.data) ? data.data[0] : data.data;
  return rec || null;
}

function fileFieldHasUpload(value) {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.some((entry) => fileFieldHasUpload(entry));
  if (typeof value === "object") {
    return Boolean(
      value.url ||
        value.file_url ||
        value.download_url ||
        value.filepath ||
        value.filename ||
        value.display_value ||
        value.zc_display_value ||
        value.value
    );
  }
  const text = String(value).trim();
  return text.length > 0 && !/^select file$/i.test(text);
}

function extractFileFieldReference(value) {
  if (!fileFieldHasUpload(value)) return "";

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractFileFieldReference(entry))
      .filter(Boolean)
      .join(",");
  }

  if (typeof value === "object") {
    const filepath = String(value.filepath ?? "").trim();
    if (filepath) return filepath;
    const filename = String(value.filename ?? "").trim();
    if (filename) return filename;
    const direct = value.url || value.file_url || value.download_url || value.value;
    if (direct && /^https?:\/\//i.test(String(direct))) return String(direct).trim();
    const label = value.display_value || value.zc_display_value;
    if (label && !/^select file$/i.test(String(label))) return String(label).trim();
    return "";
  }

  const text = String(value).trim();
  if (!text || /^select file$/i.test(text)) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return text;
}

function extractFileFieldUrl(value, { recordId, subRowId, fieldName }) {
  const reference = extractFileFieldReference(value);
  if (!reference) return "";
  if (/^https?:\/\//i.test(reference)) return reference;
  if (recordId && subRowId && fieldName) {
    return buildSubformDownloadUrl(recordId, subRowId, fieldName);
  }
  return reference;
}

function buildWidgetStyleSubformRows(apiRecord, rowFieldUpdates) {
  const sf = subform();
  const subRows = apiRecord?.[sf] || apiRecord?.Quotation_Items || [];
  const itemKey = "Item_Master";
  const skipKeys = new Set([
    "Added_Time",
    "Added_User",
    "Modified_Time",
    "Modified_User",
    "Record_Status",
    "zc_display_value",
    ATTACHMENT_FIELD,
    DATASHEET_FIELD,
  ]);

  return (Array.isArray(subRows) ? subRows : []).map((apiRow) => {
    const rowId = String(apiRow.ID || apiRow.id || "");
    const row = { ID: rowId };

    Object.keys(apiRow || {}).forEach((key) => {
      if (skipKeys.has(key)) return;
      if (key === "ID" || key === "id") return;
      const val = apiRow[key];
      if (val == null || val === "") return;
      if (key === "Currency") {
        const currency = normalizeCurrencyPatchValue(val);
        if (currency) row.Currency = currency;
        return;
      }
      if (typeof val === "object" && !Array.isArray(val)) {
        const scalar = val.display_value ?? val.zc_display_value ?? val.value;
        if (scalar != null && scalar !== "") row[key] = scalar;
        return;
      }
      row[key] = val;
    });

    const itemMasterId = lookupId(apiRow[itemKey] || apiRow.Item_Master);
    if (itemMasterId) row[itemKey] = itemMasterId;

    applyRowFieldUpdatesToPatchRow(row, rowId, rowFieldUpdates);

    return row;
  });
}

function buildSubformRowsForFileUrlUpdate(apiRecord, rowFieldUpdates) {
  return buildWidgetStyleSubformRows(apiRecord, rowFieldUpdates);
}

function buildZohoApiDownloadUrls(recordId, subRowIds, rowIndexes, filesByRow) {
  const fallback = {};
  (rowIndexes || []).forEach((idx) => {
    const subRowId = subRowIds[idx];
    const rowFiles = filesByRow?.[idx] || {};
    if (!subRowId) return;
    if (!fallback[subRowId]) fallback[subRowId] = {};
    if (rowFiles.attachment) {
      fallback[subRowId][attachmentFilepathField()] = buildSubformDownloadUrl(
        recordId,
        subRowId,
        ATTACHMENT_FIELD
      );
    }
    if (rowFiles.datasheet) {
      fallback[subRowId][datasheetFilepathField()] = buildSubformDownloadUrl(
        recordId,
        subRowId,
        DATASHEET_FIELD
      );
    }
  });
  return fallback;
}

function buildFilepathFallbackUrls(uploadResults, subRowIds) {
  const fallback = {};
  (uploadResults || []).forEach((result) => {
    if (!result?.ok || result.row == null || !result.field) return;
    const subRowId = subRowIds[result.row];
    if (!subRowId) return;
    const filepathField = filepathFieldForUploadField(result.field);
    if (!filepathField) return;
    const fp = extractUploadFileReference(result.data);
    if (!fp) return;
    if (!fallback[subRowId]) fallback[subRowId] = {};
    fallback[subRowId][filepathField] = fp;
  });
  return fallback;
}

function readSavedFilepaths(record, rowIds, expectedUpdates) {
  const subRows = record?.[subform()] || record?.Quotation_Items || [];
  const want = new Set((rowIds || []).map((id) => String(id)));
  const saved = {};

  subRows.forEach((row) => {
    const id = String(row.ID || row.id || "");
    if (!want.has(id)) return;
    const expected = expectedUpdates?.[id] || {};
    const rowSaved = {};

    for (const field of [attachmentFilepathField(), datasheetFilepathField()]) {
      if (!expected[field]) continue;
      const val = row[field];
      if (val != null && String(val).trim() !== "") {
        rowSaved[field] = String(val).trim();
      }
    }

    if (Object.keys(rowSaved).length) saved[id] = rowSaved;
  });

  return saved;
}

function verifySavedFilepaths(saved, targetRowIds, activeUpdates) {
  return targetRowIds.every((rowId) => {
    const expected = activeUpdates[rowId];
    if (!expected || typeof expected !== "object") return true;
    const savedRow = saved[rowId] || {};
    return Object.entries(expected).every(([field, url]) => {
      if (!url) return true;
      return Boolean(savedRow[field]);
    });
  });
}

function describePatchError(patchData) {
  const msg = formatCreatorError(patchData);
  const code = patchData?.code;
  if (code === 2945 || /invalid oauthscope|oauthscope|scope/i.test(String(msg))) {
    return `${msg} — regenerate refresh token with scope ZohoCreator.report.UPDATE (or report.ALL)`;
  }
  return msg;
}

function scalarPatchValue(val) {
  if (val == null || val === "") return "";
  if (typeof val === "object" && !Array.isArray(val)) {
    const nested = val.display_value ?? val.zc_display_value ?? val.value ?? val.ID ?? val.id;
    if (nested != null && nested !== "") return nested;
    return "";
  }
  return val;
}

function normalizeCurrencyPatchValue(val) {
  const text = String(scalarPatchValue(val) || "").trim();
  if (!text) return "";
  const upper = text.toUpperCase();
  for (const [code, label] of Object.entries(CREATOR_CURRENCY_CHOICES)) {
    if (text === label || upper === code || text.startsWith(code)) return label;
  }
  return text;
}

const QUOTATION_PATCH_SCALAR_FIELDS = [
  "Quantity",
  "Description",
  "Remarks",
  "Unit_Price",
  "GST",
  "Delivery_Date",
];

function buildMinimalSubformPatchRow(apiRow, rowFieldUpdates) {
  const rowId = String(apiRow?.ID || apiRow?.id || "");
  if (!rowId) return null;

  const row = { ID: rowId };
  const itemMasterId = lookupId(apiRow?.Item_Master);
  if (itemMasterId) row.Item_Master = itemMasterId;

  for (const field of QUOTATION_PATCH_SCALAR_FIELDS) {
    const raw = apiRow?.[field];
    if (raw == null || raw === "") continue;
    const val = scalarPatchValue(raw);
    if (val !== "" && val != null) row[field] = val;
  }

  const availField = availableQuantityField();
  const availRaw = apiRow?.[availField];
  if (availRaw != null && availRaw !== "") {
    const availVal = scalarPatchValue(availRaw);
    if (availVal !== "" && availVal != null) {
      row[availField] = Number(availVal);
    }
  }

  const currency = normalizeCurrencyPatchValue(apiRow?.Currency);
  if (currency) row.Currency = currency;

  const status = scalarPatchValue(apiRow?.[itemStatusField()]);
  if (status) row[itemStatusField()] = status;

  applyRowFieldUpdatesToPatchRow(row, rowId, rowFieldUpdates);

  return row;
}

function minimalPatchRowHasFilepathUpdate(row) {
  if (!row) return false;
  return Boolean(row[attachmentFilepathField()] || row[datasheetFilepathField()]);
}

async function patchQuotationSubformRows(recordId, rows, token, options = {}) {
  const target = options.useForm ? "form" : "report";
  const linkName = options.useForm ? form() : QUOTATIONS_REPORT;
  const patchUrl =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/${target}/${linkName}/${recordId}`;

  const body = { data: { [subform()]: rows } };
  if (options.skipWorkflow === "all") {
    body.skip_workflow = ["all"];
  } else if (!options.runWorkflow) {
    body.skip_workflow = ["form_workflow", "schedules"];
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
  const ok = patchRes.ok && patchData.code === 3000;
  return { ok, patchData, patchUrl, rows, strategy: options.strategy || "unknown" };
}

function buildFilepathOnlyPatchRows(rowFieldUpdates) {
  return Object.entries(rowFieldUpdates || {})
    .filter(([, fields]) => fields && typeof fields === "object" && Object.keys(fields).length > 0)
    .map(([rowId, fields]) => {
      const row = { ID: String(rowId) };
      Object.entries(fields).forEach(([field, url]) => {
        if (url) row[field] = url;
      });
      return row;
    })
    .filter((row) => minimalPatchRowHasFilepathUpdate(row));
}

async function runFileUrlPatchStrategies(recordId, record, rowFieldUpdates, token) {
  const subRows = record?.[subform()] || record?.Quotation_Items || [];
  const filepathOnlyRows = buildFilepathOnlyPatchRows(rowFieldUpdates);
  const widgetRows = buildWidgetStyleSubformRows(record, rowFieldUpdates);
  const minimalUpdated = subRows
    .map((apiRow) => buildMinimalSubformPatchRow(apiRow, rowFieldUpdates))
    .filter((row) => minimalPatchRowHasFilepathUpdate(row));
  const minimalAll = subRows
    .map((apiRow) => buildMinimalSubformPatchRow(apiRow, rowFieldUpdates))
    .filter(Boolean);

  const strategies = [];
  if (filepathOnlyRows.length) {
    strategies.push({
      strategy: "filepath-only-report-skip-all",
      rows: filepathOnlyRows,
      useForm: false,
      skipWorkflow: "all",
    });
    strategies.push({
      strategy: "filepath-only-report",
      rows: filepathOnlyRows,
      useForm: false,
      runWorkflow: false,
    });
  }
  if (widgetRows.length) {
    strategies.push({
      strategy: "widget-style-report-skip-all",
      rows: widgetRows,
      useForm: false,
      skipWorkflow: "all",
    });
    strategies.push({
      strategy: "widget-style-report",
      rows: widgetRows,
      useForm: false,
      runWorkflow: false,
    });
    strategies.push({
      strategy: "widget-style-form",
      rows: widgetRows,
      useForm: true,
      runWorkflow: false,
    });
  }
  if (minimalUpdated.length) {
    strategies.push({
      strategy: "minimal-updated-report",
      rows: minimalUpdated,
      useForm: false,
      runWorkflow: false,
    });
  }
  if (minimalAll.length) {
    strategies.push({
      strategy: "minimal-all-report",
      rows: minimalAll,
      useForm: false,
      runWorkflow: false,
    });
  }

  const attempts = [];
  for (const attempt of strategies) {
    const result = await patchQuotationSubformRows(recordId, attempt.rows, token, attempt);
    attempts.push({ ...attempt, ...result });
    if (result.ok) {
      return {
        ok: true,
        strategy: attempt.strategy,
        patchData: result.patchData,
        rows: attempt.rows,
        attempts,
      };
    }
    console.error("persistSubformFileUploadUrls attempt failed:", attempt.strategy, result.patchData);
  }

  const last = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    strategy: last.strategy,
    patchData: last.patchData,
    rows: widgetRows,
    attempts,
    error: describePatchError(last.patchData) || "Attachment_Filepath/Datasheet_Filepath patch failed.",
  };
}

async function collectUploadedFileUrls({
  recordId,
  subRowIds,
  rowIndexes,
  filesByRow,
  uploadResults,
  token,
}) {
  const rowFieldUpdates = {};

  (uploadResults || []).forEach((result) => {
    if (!result?.ok || result.row == null || !result.field) return;
    const subRowId = subRowIds[result.row];
    if (!subRowId) return;
    const filepathField = filepathFieldForUploadField(result.field);
    if (!filepathField) return;
    const downloadUrl = resolveFileUploadDownloadUrl(
      recordId,
      subRowId,
      result.field,
      result.data
    );
    if (!downloadUrl) return;
    if (!rowFieldUpdates[subRowId]) rowFieldUpdates[subRowId] = {};
    rowFieldUpdates[subRowId][filepathField] = downloadUrl;
  });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const record = await getQuotationRecordById(recordId, token);
    const subRows = record?.[subform()] || record?.Quotation_Items || [];
    let resolvedAny = false;

    rowIndexes.forEach((idx) => {
      const subRowId = subRowIds[idx];
      const rowFiles = filesByRow[idx] || {};
      if (!subRowId) return;

      const apiRow = subRows.find((row) => String(row.ID) === String(subRowId));
      if (!apiRow) return;

      if (!rowFieldUpdates[subRowId]) rowFieldUpdates[subRowId] = {};

      if (rowFiles.attachment) {
        rowFieldUpdates[subRowId][attachmentFilepathField()] = buildPublicFileDownloadUrl(
          recordId,
          subRowId,
          ATTACHMENT_FIELD
        );
        resolvedAny = true;
      }
      if (rowFiles.datasheet) {
        rowFieldUpdates[subRowId][datasheetFilepathField()] = buildPublicFileDownloadUrl(
          recordId,
          subRowId,
          DATASHEET_FIELD
        );
        resolvedAny = true;
      }
    });

    if (resolvedAny || attempt === 4) break;
    await wait(400 * attempt);
  }

  return rowFieldUpdates;
}

function publicApiBase() {
  const base =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "https://vendor-form-gpsx.onrender.com";
  return String(base).replace(/\/$/, "");
}

function buildPublicFileDownloadUrl(recordId, subRowId, fieldName) {
  return `${publicApiBase()}/api/quotation-files/${recordId}/${subRowId}/${encodeURIComponent(fieldName)}`;
}

function buildSubformDownloadUrl(recordId, subRowId, fieldName) {
  const base =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}`;
  const dotted = `${subform()}.${fieldName}`;
  return `${base}/${recordId}/${dotted}/${subRowId}/download`;
}

function resolveFileUploadDownloadUrl(recordId, subRowId, fieldName, uploadData) {
  if (!recordId || !subRowId || !fieldName) return "";
  return buildPublicFileDownloadUrl(recordId, subRowId, fieldName);
}

function buildUploadAttempts(recordId, subRowId, fieldName) {
  const base =
    `${API_HOST}/creator/v2.1/data/${owner()}/${app()}/report/${QUOTATIONS_REPORT}`;
  const dotted = `${subform()}.${fieldName}`;
  // v2.1 subform upload — same shape as parent upload, with subform row id segment.
  // skip_workflow as query param (v2.1 docs) avoids form workflow errors during upload.
  const skipWorkflow = encodeURIComponent(JSON.stringify(["form_workflow", "schedules"]));
  return [
    {
      label: "subform upload path",
      url: `${base}/${recordId}/${dotted}/${subRowId}/upload?skip_workflow=${skipWorkflow}`,
      extraFields: {},
    },
  ];
}

/*
 * v2.1 upload response: { code: 3000, filename, filepath, message }
 * Attachment_Filepath / Datasheet_Filepath store public download URLs.
 */
function extractUploadFileReference(data) {
  if (!data || typeof data !== "object") return "";

  const nested = data.data && typeof data.data === "object" ? data.data : null;
  const filepath = String(data.filepath ?? nested?.filepath ?? "").trim();
  if (filepath) return filepath;
  const filename = String(data.filename ?? nested?.filename ?? "").trim();
  if (filename) return filename;

  const candidates = [
    data.file_url,
    data.url,
    data.download_url,
    nested?.file_url,
    nested?.url,
    nested?.download_url,
  ];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text && /^https?:\/\//i.test(text)) return text;
  }

  return "";
}

/*
 * Builds an API download URL when only filepath is known (for logging / API consumers).
 */
function extractUploadedFileUrl(data, { recordId, subRowId, fieldName }) {
  const reference = extractUploadFileReference(data);
  if (!reference) return "";
  if (/^https?:\/\//i.test(reference)) return reference;
  if (recordId && subRowId && fieldName) {
    return buildSubformDownloadUrl(recordId, subRowId, fieldName);
  }
  return reference;
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
        const downloadUrl = resolveFileUploadDownloadUrl(recordId, subRowId, fieldName, data);
        return {
          ok: true,
          field: fieldName,
          status: res.status,
          data,
          fileRef: downloadUrl,
          fileUrl: downloadUrl,
          url: attempt.url,
        };
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
  return best || { ok: false, field: fieldName, status: 0, data: {}, raw: "", fileUrl: "" };
}

async function persistSubformFileUploadUrls(recordId, rowFieldUpdates, token, options = {}) {
  const uploadResults = options.uploadResults || [];
  const subRowIds = options.subRowIds || [];
  const rowIndexes = options.rowIndexes || [];
  const filesByRow = options.filesByRow || {};
  const entries = Object.entries(rowFieldUpdates || {}).filter(
    ([, fields]) => fields && typeof fields === "object" && Object.keys(fields).length > 0
  );
  if (!entries.length) {
    return { attempted: false, ok: true, rows: [] };
  }

  const targetRowIds = entries.map(([rowId]) => String(rowId));
  let activeUpdates = { ...rowFieldUpdates };

  for (let round = 1; round <= 3; round += 1) {
    if (round === 2) {
      const fallback = buildFilepathFallbackUrls(uploadResults, subRowIds);
      if (!rowFieldUpdatesHasEntries(fallback)) continue;
      console.warn(
        "Attachment_Filepath/Datasheet_Filepath public URL not verified; retrying with filepath."
      );
      activeUpdates = fallback;
    } else if (round === 3) {
      const zohoFallback = buildZohoApiDownloadUrls(recordId, subRowIds, rowIndexes, filesByRow);
      if (!rowFieldUpdatesHasEntries(zohoFallback)) break;
      console.warn(
        "Attachment_Filepath/Datasheet_Filepath filepath not verified; retrying with Zoho API download URL."
      );
      activeUpdates = zohoFallback;
    } else {
      await wait(600);
    }

    const record = await getQuotationRecordById(recordId, token);
    if (!record) {
      return {
        attempted: true,
        ok: false,
        error: "Could not read quotation record before filepath patch.",
        rows: [],
      };
    }

    const patchResult = await runFileUrlPatchStrategies(recordId, record, activeUpdates, token);
    if (!patchResult.ok) {
      if (round < 3) continue;
      return {
        attempted: true,
        ok: false,
        error: patchResult.error,
        patchData: patchResult.patchData,
        rows: patchResult.rows,
        rowFieldUpdates: entries,
        attempts: patchResult.attempts,
      };
    }

    await wait(500);
    const verifiedRecord = await getQuotationRecordById(recordId, token);
    const saved = readSavedFilepaths(verifiedRecord, targetRowIds, activeUpdates);
    const allSaved = verifySavedFilepaths(saved, targetRowIds, activeUpdates);

    console.log(
      "persistSubformFileUploadUrls ok:",
      patchResult.strategy,
      targetRowIds.map((rowId) => ({
        ID: rowId,
        ...(saved[rowId] || activeUpdates[rowId] || {}),
      }))
    );

    if (allSaved || round === 3) {
      return {
        attempted: true,
        ok: allSaved,
        verified: allSaved,
        strategy: patchResult.strategy,
        patchData: patchResult.patchData,
        rows: patchResult.rows,
        rowFieldUpdates: entries,
        saved,
        attempts: patchResult.attempts,
        error: allSaved
          ? null
          : "Filepath patch returned ok but Attachment_Filepath/Datasheet_Filepath is still empty in Creator.",
      };
    }
  }

  return {
    attempted: true,
    ok: false,
    error: "Attachment_Filepath/Datasheet_Filepath could not be saved after upload.",
    rows: [],
    rowFieldUpdates: entries,
  };
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

  const uploadResults = [];

  for (const idx of rowIndexes) {
    const rowFiles = filesByRow[idx] || {};
    const subRowId = subRowIds[idx];
    if (!subRowId) {
      uploadResults.push({ ok: false, row: idx, error: "Missing subform row id" });
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
        uploadResults.push({ ...r, row: idx, kind });
      } catch (e) {
        console.error(`Upload ${kind} row ${idx} threw:`, e);
        uploadResults.push({ ok: false, row: idx, field, kind, error: e.message });
      }
    }
  }

  const rowFieldUpdates = await collectUploadedFileUrls({
    recordId,
    subRowIds,
    rowIndexes,
    filesByRow,
    uploadResults,
    token,
  });

  const fileUrlPatch = await persistSubformFileUploadUrls(recordId, rowFieldUpdates, token, {
    uploadResults,
    subRowIds,
    rowIndexes,
    filesByRow,
  });

  const allOk =
    uploadResults.every((r) => r.ok || r.error === "Missing subform row id") &&
    (!fileUrlPatch.attempted || fileUrlPatch.ok);
  return {
    attempted: true,
    subRowIds,
    results: uploadResults,
    rowFieldUpdates,
    fileUrlPatch,
    allOk,
    error: allOk
      ? null
      : [
          ...uploadResults
            .filter((r) => !r.ok)
            .map((r) =>
              `row ${r.row ?? "?"} ${r.field || r.kind || ""}: ${describeUploadError(r.status, r.data, r.raw || r.error)}`
            ),
          fileUrlPatch.attempted && !fileUrlPatch.ok
            ? `Filepath patch failed: ${fileUrlPatch.error || describePatchError(fileUrlPatch.patchData)}`
            : null,
        ]
          .filter(Boolean)
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

  console.error("Custom API markVendorQuoteReceived failed:", lastFailure);
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
    console.error("fetchRfqRecord failed:", data);
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
  if (customResult.attempted) {
    console.warn("Custom API status update failed, trying REST PATCH…", customResult);
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
    console.warn(
      "REST Vendor_Selection patch failed, retrying status-only…",
      patchResult.patchUrl,
      patchResult.patchData
    );
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
    console.error("markVendorQuoteReceived patch failed:", patchData, "url:", patchUrl);
    console.error("PATCH payload:", JSON.stringify(body, null, 2));
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
    } catch (e) {
      console.error("Failed to parse items JSON:", e);
    }
  }

  if (!linePayloads.length) {
    linePayloads = [{ ...flatPayload, itemMasterId: flatPayload.itemMasterId || flatPayload.itemId }];
  }

  const subformRows = [];
  const resolvedItemMasters = [];

  for (const line of linePayloads) {
    const itemMasterId = await resolveItemMasterId(
      {
        ...line,
        rfqRecordId: flatPayload.rfqRecordId,
      },
      token
    );
    resolvedItemMasters.push(itemMasterId);
    if (!itemMasterId) {
      console.warn("Item_Master unresolved for line:", {
        itemId: line.itemId,
        product: line.product,
        rfqRecordId: flatPayload.rfqRecordId,
      });
    }
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

  // Step 2: upload per-row subform files
  let uploads = { attempted: false, results: [] };
  if (ok && recordId) {
    uploads = await uploadSubformFiles(recordId, created, files, token);
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

export async function streamQuotationSubformFile(recordId, subRowId, fieldName, res) {
  const allowed = new Set([ATTACHMENT_FIELD, DATASHEET_FIELD]);
  if (!allowed.has(fieldName)) {
    res.status(400).json({ ok: false, message: "Invalid file field." });
    return;
  }

  const token = await getAccessToken();
  const url = buildSubformDownloadUrl(recordId, subRowId, fieldName);
  const zohoRes = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  if (!zohoRes.ok) {
    const errText = await zohoRes.text().catch(() => "");
    res.status(zohoRes.status).json({
      ok: false,
      message: errText || "File not found in Creator.",
    });
    return;
  }

  const contentType = zohoRes.headers.get("content-type") || "application/octet-stream";
  const disposition = zohoRes.headers.get("content-disposition");
  res.setHeader("Content-Type", contentType);
  if (disposition) {
    res.setHeader("Content-Disposition", disposition);
  } else {
    res.setHeader("Content-Disposition", `attachment; filename="${fieldName}-file"`);
  }

  const buffer = Buffer.from(await zohoRes.arrayBuffer());
  res.send(buffer);
}
