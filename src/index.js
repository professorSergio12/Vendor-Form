import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  createQuotationRecord,
  formatCreatorError,
  parseQuotationFiles,
} from "./creator.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 40 },
});

const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`));
    },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true, service: "quotation-backend" }));

app.post("/api/quotations", upload.any(), async (req, res) => {
  const p = req.body || {};
  const files = parseQuotationFiles(req.files || []);

  if (!p.rfqNumber) {
    return res.status(400).json({ ok: false, message: "Missing rfqNumber." });
  }

  let items = [];
  if (p.items) {
    try {
      items = typeof p.items === "string" ? JSON.parse(p.items) : p.items;
    } catch {
      return res.status(400).json({ ok: false, message: "Invalid items JSON." });
    }
  }

  if (Array.isArray(items) && items.length) {
    const bad = items.find((line) => !(Number(line.price) > 0));
    if (bad) {
      return res.status(400).json({
        ok: false,
        message: "Each item must have a valid price.",
      });
    }
  } else {
    if (!p.itemId) {
      return res.status(400).json({ ok: false, message: "Missing itemId." });
    }
    if (!(Number(p.price) > 0)) {
      return res.status(400).json({ ok: false, message: "A valid price is required." });
    }
  }

  try {
    const result = await createQuotationRecord(p, files);
    if (result.ok) {
      const hadFiles =
        (files.attachment?.length || 0) > 0 || (files.datasheet?.length || 0) > 0;
      const uploadFailed =
        hadFiles && result.uploads?.attempted && result.uploads?.filesUploadedOk === false;
      const vendorStatusFailed =
        result.vendorStatus?.attempted && !result.vendorStatus?.ok;
      return res.json({
        ok: true,
        uniqueId: p.uniqueId,
        recordId: result.recordId,
        quotationVersion: result.quotationVersion,
        resolved: result.resolved,
        uploads: result.uploads,
        vendorStatus: result.vendorStatus,
        uploadWarning: uploadFailed
          ? result.uploads.error ||
            "Quotation saved but one or more files could not be uploaded."
          : null,
        vendorStatusWarning: vendorStatusFailed
          ? result.vendorStatus.error ||
            "Quotation saved but RFQ Vendor_Response_Status was not updated."
          : null,
      });
    }
    return res.status(502).json({
      ok: false,
      message: formatCreatorError(result.data),
      detail: result.data,
      resolved: result.resolved,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error." });
  }
});

const port = Number(process.env.PORT) || 8787;
app.listen(port);
