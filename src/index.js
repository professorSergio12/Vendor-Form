import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { createQuotationRecord } from "./creator.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// In-memory multipart parsing for the Attachment + Datasheet subform files.
// Creator file-upload fields accept up to 50 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 2 },
});
const quotationUpload = upload.fields([
  { name: "attachment", maxCount: 1 },
  { name: "datasheet", maxCount: 1 },
]);

// CORS — only allow the form origins listed in ALLOWED_ORIGINS.
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / server-to-server (no Origin header) and listed ones.
      if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`));
    },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true, service: "quotation-backend" }));

// Vendor submits the React form -> here -> Zoho Creator Vendor_Quotations.
// Accepts either multipart/form-data (with attachment/datasheet files) or JSON.
app.post("/api/quotations", quotationUpload, async (req, res) => {
  const p = req.body || {};
  const files = {
    attachment: req.files?.attachment?.[0],
    datasheet: req.files?.datasheet?.[0],
  };

  if (files.attachment || files.datasheet) {
    console.log("Files received:", {
      attachment: files.attachment?.originalname,
      datasheet: files.datasheet?.originalname,
    });
  }

  if (!p.rfqNumber || !p.itemId) {
    return res.status(400).json({ ok: false, message: "Missing rfqNumber or itemId." });
  }
  if (!(Number(p.price) > 0)) {
    return res.status(400).json({ ok: false, message: "A valid price is required." });
  }

  try {
    const result = await createQuotationRecord(p, files);
    if (result.ok) {
      const hadFiles = Boolean(files.attachment || files.datasheet);
      const uploadFailed = hadFiles && result.uploads?.attempted && !result.uploads?.allOk;
      return res.json({
        ok: true,
        uniqueId: p.uniqueId,
        recordId: result.recordId,
        uploads: result.uploads,
        uploadWarning: uploadFailed
          ? result.uploads.error ||
            "Quotation saved but one or more files could not be uploaded."
          : null,
      });
    }
    console.error("Creator rejected submission:", result.data);
    return res.status(502).json({
      ok: false,
      message: result.data?.message || "Zoho Creator rejected the submission.",
      detail: result.data,
    });
  } catch (err) {
    console.error("Submission error:", err);
    return res.status(500).json({ ok: false, message: err.message || "Server error." });
  }
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`quotation-backend listening on http://localhost:${port}`);
  if (allowed.length) console.log("CORS allowed origins:", allowed.join(", "));
});
