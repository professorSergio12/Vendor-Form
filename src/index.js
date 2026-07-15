import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  createQuotationRecord,
  formatCreatorError,
  fetchRfqLineItemsForForm,
  parseQuotationFiles,
  sendDueDatePassedNoticeEmail,
  sendQuotationConfirmationEmail,
  validateRfqSubmissionDeadline,
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

app.get("/api/rfq-deadline", async (req, res) => {
  const rfqNumber = String(req.query.rfq_no || "").trim();
  const rfqRecordId = String(req.query.rfq_rid || "").trim();

  if (!rfqNumber && !rfqRecordId) {
    return res.status(400).json({ ok: false, message: "Missing rfq_no or rfq_rid." });
  }

  try {
    const deadline = await validateRfqSubmissionDeadline({ rfqRecordId, rfqNumber });
    return res.json({
      ok: true,
      allowed: deadline.allowed,
      dueDate: deadline.dueDateIso || null,
      dueDateDisplay: deadline.dueDateDisplay || null,
      rfqNumber: deadline.rfqNumber || rfqNumber,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error." });
  }
});

app.get("/api/rfq-line-items", async (req, res) => {
  const rfqNumber = String(req.query.rfq_no || "").trim();
  const rfqRecordId = String(req.query.rfq_rid || "").trim();

  if (!rfqNumber && !rfqRecordId) {
    return res.status(400).json({ ok: false, message: "Missing rfq_no or rfq_rid." });
  }

  try {
    const result = await fetchRfqLineItemsForForm({ rfqRecordId, rfqNumber });
    if (!result.ok) {
      return res.status(404).json({
        ok: false,
        message: "RFQ line items not found.",
        reason: result.reason || null,
      });
    }
    return res.json({
      ok: true,
      rfqNumber: result.rfqNumber || rfqNumber,
      items: result.items || [],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error." });
  }
});

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
    const deadline = await validateRfqSubmissionDeadline({
      rfqRecordId: p.rfqRecordId,
      rfqNumber: p.rfqNumber,
    });

    if (!deadline.allowed) {
      const dueLabel = deadline.dueDateDisplay || deadline.dueDate || "the due date";
      let overdueEmail = { attempted: false, ok: false };
      try {
        overdueEmail = await sendDueDatePassedNoticeEmail({
          contactEmail: p.contactEmail,
          vendorName: p.vendorName,
          rfqNumber: p.rfqNumber,
          dueDate: deadline.dueDate,
          dueDateDisplay: deadline.dueDateDisplay,
        });
      } catch (emailErr) {
        overdueEmail = { attempted: true, ok: false, error: emailErr.message };
      }

      return res.status(403).json({
        ok: false,
        code: "DUE_DATE_PASSED",
        message: `The quotation due date (${dueLabel}) has passed. Your submission was not saved.`,
        dueDate: deadline.dueDateIso || null,
        dueDateDisplay: deadline.dueDateDisplay || null,
        overdueEmail,
      });
    }

    const result = await createQuotationRecord(p, files);
    if (result.ok) {
      const hadFiles =
        (files.attachment?.length || 0) > 0 || (files.datasheet?.length || 0) > 0;
      const uploadFailed =
        hadFiles && result.uploads?.attempted && result.uploads?.filesUploadedOk === false;
      const vendorStatusFailed =
        result.vendorStatus?.attempted && !result.vendorStatus?.ok;

      let confirmationEmail = { attempted: false, ok: false };
      try {
        confirmationEmail = await sendQuotationConfirmationEmail({
          contactEmail: p.contactEmail,
          vendorName: p.vendorName,
          rfqNumber: p.rfqNumber,
          quotationVersion: result.quotationVersion,
        });
      } catch (emailErr) {
        confirmationEmail = { attempted: true, ok: false, error: emailErr.message };
      }

      return res.json({
        ok: true,
        uniqueId: p.uniqueId,
        recordId: result.recordId,
        quotationVersion: result.quotationVersion,
        resolved: result.resolved,
        uploads: result.uploads,
        vendorStatus: result.vendorStatus,
        confirmationEmail,
        uploadWarning: uploadFailed
          ? result.uploads.error ||
            "Quotation saved but one or more files could not be uploaded."
          : null,
        vendorStatusWarning: vendorStatusFailed
          ? result.vendorStatus.error ||
            "Quotation saved but RFQ Vendor_Response_Status was not updated."
          : null,
        confirmationEmailWarning: confirmationEmail.attempted && !confirmationEmail.ok
          ? confirmationEmail.error ||
            "Quotation saved but confirmation email could not be sent."
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
