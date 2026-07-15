const MONTH_ABBR = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse Creator / widget date strings (dd-MMM-yyyy, ISO, etc.). */
export function parseCreatorDateValue(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const s = String(value).trim();
  if (!s) return null;

  let dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return dt;

  const m = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{4})$/);
  if (m) {
    const mon = MONTH_ABBR[m[2].toLowerCase()];
    if (mon != null) {
      dt = new Date(Number(m[3]), mon, Number(m[1]));
      if (!Number.isNaN(dt.getTime())) return dt;
    }
  }

  const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m2) {
    dt = new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]));
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  return null;
}

export function dueDateToIso(value) {
  const d = parseCreatorDateValue(value);
  if (!d) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDueDateDisplay(value) {
  const d = parseCreatorDateValue(value);
  if (!d) return String(value || "").trim() || null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

const istDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** True only after the due date day has ended (IST). Submissions on due date are allowed. */
export function isRfqDueDatePassed(dueDateValue, now = new Date()) {
  const due = parseCreatorDateValue(dueDateValue);
  if (!due) return false;
  const todayStr = istDayFormatter.format(now);
  const dueStr = istDayFormatter.format(due);
  return todayStr > dueStr;
}

export function readRfqDueDate(rfqRec, fieldName = "Due_Date") {
  if (!rfqRec) return null;
  const raw = rfqRec[fieldName] ?? rfqRec.Due_Date;
  if (raw == null || raw === "") return null;
  return String(raw).trim();
}
