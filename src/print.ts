import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";
const fonts = path.resolve(process.cwd(), "assets/fonts");
function printDocument(options: PDFKit.PDFDocumentOptions) {
  const doc = new PDFDocument(options);
  doc.registerFont("PrintRegular", path.join(fonts, "Regular.ttf"));
  doc.registerFont("PrintBold", path.join(fonts, "Bold.ttf"));
  return doc;
}
import { D, money } from "./core.js";
type Brand = {
  legalName: string;
  address: string;
  phone: string;
  receiptFooter: string;
};
type Entry = {
  reference: string;
  createdAt: Date;
  kind: string;
  currencyCode: string | null;
  foreignAmount: any;
  rate: any;
  pkrDelta: any;
  balanceAfter: any;
  note: string;
  actorName: string;
  originalId: string | null;
  reversed?: boolean;
  pkrAmount?: any;
  cashDelta?: any;
  paymentMode?: string;
};
type Party = { name: string; mobile: string; customerNo?: string };
const color = {
  ink: "#183b3b",
  muted: "#708383",
  teal: "#13766c",
  light: "#edf5f1",
  line: "#dde7e2",
};
export function printNumber(v: any, places = 2) {
  const [integer, decimal] = D(String(v || 0))
    .toFixed(places)
    .split(".");
  const fraction = places === 2 ? decimal : decimal?.replace(/0+$/, "");
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? "." + fraction : "")
  );
}
const number = printNumber;
const date = (v: Date, time = false) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(time ? { hour: "2-digit", minute: "2-digit", hour12: true } : {}),
  }).format(v);
const label = (e: Entry) =>
  e.kind === "FX_GIVEN"
    ? "Currency given"
    : e.kind === "PKR_RECEIVED"
      ? "PKR payment received"
      : e.kind === "FX_PURCHASED"
        ? "Currency purchased"
        : "Correction / reversal";
function line(doc: PDFKit.PDFDocument, y: number, x = 44, width = 507) {
  doc
    .moveTo(x, y)
    .lineTo(x + width, y)
    .strokeColor(color.line)
    .lineWidth(0.7)
    .stroke();
}
function txt(
  doc: PDFKit.PDFDocument,
  value: any,
  x: number,
  y: number,
  width: number,
  size = 10,
  bold = false,
  align: "left" | "right" = "left",
) {
  doc
    .font(bold ? "PrintBold" : "PrintRegular")
    .fontSize(size)
    .fillColor(color.ink)
    .text(String(value ?? ""), x, y, { width, align, lineGap: 3 });
}
function header(
  doc: PDFKit.PDFDocument,
  brand: Brand,
  title: string,
  subtitle: string,
) {
  doc.rect(0, 0, 595.28, 7).fill(color.teal);
  txt(doc, "KHATA OS", 44, 31, 150, 9, true);
  const businessHeight = Math.max(
    30,
    doc
      .font("PrintBold")
      .fontSize(23)
      .heightOfString(brand.legalName, { width: 330 }),
  );
  txt(doc, brand.legalName, 44, 54, 330, 23, true);
  const titleHeight = doc
    .font("PrintBold")
    .fontSize(10)
    .heightOfString(title, { width: 161, lineGap: 3 });
  txt(doc, title, 390, 34, 161, 10, true, "right");
  const subtitleY = 34 + titleHeight + 8;
  txt(doc, subtitle, 380, subtitleY, 171, 9, false, "right");
  let y = 54 + businessHeight + 7;
  const contact = [brand.address, brand.phone].filter(Boolean).join("  |  ");
  if (contact) {
    txt(doc, contact, 44, y, 507, 9);
    y +=
      doc
        .font("PrintRegular")
        .fontSize(9)
        .heightOfString(contact, { width: 507 }) + 10;
  }
  y = Math.max(
    y,
    subtitleY +
      doc
        .font("PrintRegular")
        .fontSize(9)
        .heightOfString(subtitle, { width: 171, lineGap: 3 }) +
      12,
  );
  line(doc, y);
  return y + 22;
}
function footers(doc: PDFKit.PDFDocument, brand: Brand, reference: string) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    line(doc, 785);
    doc
      .font("PrintRegular")
      .fontSize(8)
      .fillColor(color.muted)
      .text(brand.receiptFooter || "Thank you for your business.", 44, 796, {
        width: 410,
        height: 14,
        ellipsis: true,
      });
    txt(doc, `${i + 1} / ${pages.count}`, 478, 796, 73, 8, false, "right");
    txt(doc, `Khata OS  |  ${reference}`, 44, 816, 480, 7);
    doc.page.margins.bottom = bottom;
  }
}
function panel(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  accent = false,
) {
  doc.roundedRect(x, y, w, 73, 8).fill(accent ? color.teal : color.light);
  doc
    .font("PrintRegular")
    .fontSize(9)
    .fillColor(accent ? "#d8eee6" : color.muted)
    .text(label, x + 15, y + 14, { width: w - 30 });
  doc.font("PrintBold");
  let size = 18;
  while (size > 9 && doc.fontSize(size).widthOfString(value) > w - 30) size--;
  doc
    .fontSize(size)
    .fillColor(accent ? "#ffffff" : color.ink)
    .text(value, x + 15, y + 37, { width: w - 30, align: "left" });
}
export function receiptPDF(
  brand: Brand,
  party: Party,
  e: Entry,
  options: { thermal?: boolean; originalReference?: string } = {},
) {
  if (options.thermal)
    return thermalPDF(brand, party, e, options.originalReference);
  const doc = printDocument({
    size: "A4",
    margin: 44,
    bufferPages: true,
    info: { Title: `${label(e)} - ${e.reference}`, Author: brand.legalName },
  });
  let y = header(
    doc,
    brand,
    e.kind === "FX_GIVEN"
      ? "CURRENCY DELIVERY NOTE"
      : e.kind === "PKR_RECEIVED"
        ? "PAYMENT RECEIPT"
        : e.kind === "FX_PURCHASED"
          ? "CURRENCY PURCHASE RECEIPT"
          : "CORRECTION NOTE",
    e.reference,
  );
  txt(doc, "PARTY DETAILS", 44, y, 250, 9, true);
  txt(doc, "RECORD DETAILS", 330, y, 221, 9, true);
  y += 20;
  const partyHeight = doc
    .font("PrintBold")
    .fontSize(16)
    .heightOfString(party.name, { width: 255 });
  txt(doc, party.name, 44, y, 255, 16, true);
  txt(doc, date(e.createdAt, true) + " PKT", 330, y, 221, 10, false, "right");
  y += Math.max(partyHeight, 17) + 9;
  txt(doc, party.mobile || "Mobile not provided", 44, y, 255, 10);
  txt(doc, "Recorded by: " + e.actorName, 300, y, 251, 9, false, "right");
  y += 29;
  if (e.reversed) {
    doc.roundedRect(44, y, 507, 31, 5).fill("#fff1e8");
    txt(
      doc,
      "REVERSED - retained for historical reference",
      57,
      y + 9,
      480,
      9,
      true,
    );
    y += 46;
  }
  txt(doc, label(e).toUpperCase(), 44, y, 507, 10, true);
  y += 24;
  const columns = e.currencyCode
    ? [
        { title: "CURRENCY", value: e.currencyCode, width: 90 },
        {
          title: "FOREIGN AMOUNT",
          value: number(e.foreignAmount, 4),
          width: 160,
        },
        { title: "RATE / PKR", value: number(e.rate, 8), width: 257 },
      ]
    : [
        { title: "PAYMENT CURRENCY", value: "PKR", width: 170 },
        {
          title: "PAYMENT AMOUNT",
          value: number(D(String(e.pkrDelta)).abs()),
          width: 337,
        },
      ];
  let x = 44;
  doc.roundedRect(44, y, 507, 76, 7).fill("#f6f8f7");
  for (const c of columns) {
    txt(doc, c.title, x + 15, y + 13, c.width - 30, 8, true);
    txt(doc, c.value, x + 15, y + 37, c.width - 30, 14, true);
    x += c.width;
  }
  y += 98;
  const movement = D(String(e.cashDelta || 0)).eq(0)
    ? D(String(e.pkrDelta))
    : D(String(e.cashDelta));
  const movementTitle =
    e.kind === "FX_PURCHASED"
      ? "PKR PAID TO CUSTOMER"
      : e.kind === "PKR_RECEIVED" ||
          (e.kind === "FX_GIVEN" && e.paymentMode === "CASH")
        ? "PKR CASH RECEIVED"
        : movement.gte(0)
          ? "PKR ADDED TO KHATA"
          : "PKR REDUCED FROM KHATA";
  panel(doc, 44, y, 246, movementTitle, "PKR " + number(movement.abs()));
  panel(
    doc,
    305,
    y,
    246,
    "CUSTOMER KHATA BALANCE",
    "PKR " + number(e.balanceAfter),
    true,
  );
  y += 95;
  const explanation =
    e.kind === "FX_PURCHASED"
      ? "Currency has been purchased from this customer. PKR payment has been recorded as cash paid, and currency has been added to stock."
      : e.kind === "FX_GIVEN" && e.paymentMode === "CASH"
        ? "Currency has been sold and PKR cash received. This sale is fully paid; no customer receivable is added."
        : e.kind === "FX_GIVEN"
          ? "Currency has been delivered. The PKR amount above is payable by the party; this record does not confirm PKR payment."
          : e.kind === "PKR_RECEIVED"
            ? "PKR payment has been recorded against the party's balance. Foreign currency stock is unchanged."
            : "This is a linked correction. The original record remains in the permanent transaction history.";
  txt(doc, explanation, 44, y, 507, 10);
  y +=
    doc
      .font("PrintRegular")
      .fontSize(10)
      .heightOfString(explanation, { width: 507 }) + 24;
  if (options.originalReference) {
    txt(doc, "ORIGINAL REFERENCE", 44, y, 507, 8, true);
    y += 17;
    txt(doc, options.originalReference, 44, y, 507, 10);
    y += 30;
  }
  if (e.note) {
    txt(doc, "NOTES", 44, y, 507, 8, true);
    y += 18;
    const noteHeight = doc
      .font("PrintRegular")
      .fontSize(10)
      .heightOfString(e.note, { width: 507, lineGap: 3 });
    if (y + noteHeight > 720) {
      doc.addPage();
      y = 60;
    }
    txt(doc, e.note, 44, y, 507, 10);
    y += noteHeight + 30;
  }
  if (y > 692) {
    doc.addPage();
    y = 60;
  }
  line(doc, y + 27, 44, 190);
  line(doc, y + 27, 361, 190);
  txt(doc, "Recorded by / signature", 44, y + 37, 190, 9);
  txt(doc, "Party / signature", 361, y + 37, 190, 9, false, "right");
  footers(doc, brand, e.reference);
  return doc;
}
export function statementPDF(
  brand: Brand,
  party: Party,
  rows: Entry[],
  balance: string,
) {
  const doc = printDocument({
    size: "A4",
    margin: 44,
    bufferPages: true,
    info: { Title: `Party statement - ${party.name}`, Author: brand.legalName },
  });
  let y = header(
    doc,
    brand,
    "PARTY STATEMENT",
    "Generated " + date(new Date()),
  );
  txt(doc, party.name, 44, y, 507, 18, true);
  y +=
    doc
      .font("PrintBold")
      .fontSize(18)
      .heightOfString(party.name, { width: 507 }) + 9;
  txt(doc, party.mobile || "Mobile not provided", 44, y, 507, 9);
  y += 23;
  txt(
    doc,
    rows.length
      ? `${date(rows[0].createdAt)} to ${date(rows[rows.length - 1].createdAt)}  |  ${rows.length} entries  |  All amounts in PKR`
      : "No entries  |  All amounts in PKR",
    44,
    y,
    507,
    9,
  );
  y += 25;
  let added = D(0),
    reduced = D(0);
  for (const e of rows) {
    const v = D(String(e.pkrDelta));
    if (v.gt(0)) added = added.plus(v);
    else reduced = reduced.minus(v);
  }
  const sums = [
    ["TOTAL INCREASES", number(added)],
    ["TOTAL REDUCTIONS", number(reduced)],
    ["PKR TO RECEIVE", number(balance)],
  ];
  sums.forEach(([k, v], i) => {
    doc
      .roundedRect(44 + i * 173, y, 161, 66, 6)
      .fill(i === 2 ? color.teal : color.light);
    doc
      .fillColor(i === 2 ? "#dcf1e8" : color.muted)
      .font("PrintRegular")
      .fontSize(8)
      .text(k, 56 + i * 173, y + 13, { width: 137 });
    doc
      .fillColor(i === 2 ? "white" : color.ink)
      .font("PrintBold")
      .fontSize(15)
      .text(v, 56 + i * 173, y + 34, { width: 137 });
  });
  y += 87;
  const widths = [102, 165, 80, 80, 80],
    starts = [44, 146, 311, 391, 471];
  const tableHead = () => {
    doc.rect(44, y, 507, 29).fill(color.teal);
    ["DATE / REF", "DETAILS", "ADDED", "REDUCED", "BALANCE"].forEach((v, i) => {
      doc
        .font("PrintBold")
        .fontSize(8)
        .fillColor("white")
        .text(v, starts[i] + 7, y + 10, {
          width: widths[i] - 14,
          align: i >= 2 ? "right" : "left",
        });
    });
    y += 29;
  };
  tableHead();
  if (!rows.length) {
    txt(doc, "No records in this party khata.", 54, y + 20, 487, 10);
    y += 65;
  }
  rows.forEach((e, index) => {
    const detail = [
      label(e) + (e.reversed ? " (REVERSED)" : ""),
      e.currencyCode
        ? `${number(e.foreignAmount, 4)} ${e.currencyCode} @ ${number(e.rate, 8)}`
        : "",
      e.cashDelta && !D(String(e.cashDelta)).eq(0)
        ? (D(String(e.cashDelta)).lt(0)
            ? "Cash paid PKR "
            : "Cash received PKR ") + number(D(String(e.cashDelta)).abs())
        : "",
      e.note,
    ]
      .filter(Boolean)
      .join("\n");
    const left = date(e.createdAt) + "\n" + e.reference;
    const h = Math.max(
      48,
      doc
        .font("PrintRegular")
        .fontSize(8)
        .heightOfString(detail, { width: 151, lineGap: 3 }) + 20,
      doc.heightOfString(left, { width: 88, lineGap: 3 }) + 20,
    );
    if (y + h > 743) {
      doc.addPage();
      y = 45;
      txt(doc, brand.legalName + " | " + party.name, 44, y, 507, 10, true);
      y += 28;
      tableHead();
    }
    doc.rect(44, y, 507, h).fill(index % 2 === 0 ? "#f6f9f7" : "#ffffff");
    txt(doc, left, 51, y + 10, 88, 8);
    txt(doc, detail, 153, y + 10, 151, 8);
    const v = D(String(e.pkrDelta));
    txt(doc, v.gt(0) ? number(v) : "-", 318, y + 10, 66, 8, false, "right");
    txt(
      doc,
      v.lt(0) ? number(v.abs()) : "-",
      398,
      y + 10,
      66,
      8,
      false,
      "right",
    );
    txt(doc, number(e.balanceAfter), 478, y + 10, 66, 8, true, "right");
    line(doc, y + h);
    y += h;
  });
  if (y > 680) {
    doc.addPage();
    y = 50;
  }
  y += 22;
  txt(doc, "CLOSING BALANCE / PKR TO RECEIVE", 44, y, 320, 10, true);
  txt(doc, "PKR " + number(balance), 365, y, 186, 15, true, "right");
  y += 35;
  txt(
    doc,
    "Increases add to the amount due. Reductions include payments and correcting entries. Reversed records are retained; the linked correction offsets their financial effect.",
    44,
    y,
    507,
    9,
  );
  footers(doc, brand, "Party statement");
  return doc;
}
function thermalPDF(
  brand: Brand,
  party: Party,
  e: Entry,
  originalReference?: string,
) {
  const width = 226.77,
    inner = width - 28;
  type Part = {
    value: string;
    size: number;
    bold?: boolean;
    center?: boolean;
  } | null;
  const parts: Part[] = [
    { value: brand.legalName, size: 15, bold: true, center: true },
  ];
  if (brand.address)
    parts.push({ value: brand.address, size: 8, center: true });
  if (brand.phone) parts.push({ value: brand.phone, size: 9, center: true });
  parts.push(
    null,
    { value: label(e).toUpperCase(), size: 10, bold: true, center: true },
    { value: e.reference, size: 9, bold: true, center: true },
    { value: date(e.createdAt, true) + " PKT", size: 8, center: true },
  );
  if (e.reversed)
    parts.push({
      value: "REVERSED - HISTORY COPY",
      size: 9,
      bold: true,
      center: true,
    });
  parts.push({ value: "Party: " + party.name, size: 11, bold: true });
  if (party.mobile) parts.push({ value: "Mobile: " + party.mobile, size: 9 });
  if (e.currencyCode)
    parts.push(
      { value: "Currency: " + e.currencyCode, size: 9 },
      { value: "Quantity: " + number(e.foreignAmount, 4), size: 9 },
      { value: "Rate PKR: " + number(e.rate, 8), size: 9 },
    );
  parts.push(
    null,
    {
      value:
        (e.kind === "FX_PURCHASED"
          ? "Paid: PKR "
          : e.paymentMode === "CASH"
            ? "Cash: PKR "
            : D(String(e.pkrDelta)).gte(0)
              ? "Added: PKR "
              : "Reduced: PKR ") +
        number(D(String(e.pkrAmount || e.pkrDelta)).abs()),
      size: 11,
      bold: true,
    },
    {
      value: "Balance after: PKR " + number(e.balanceAfter),
      size: 11,
      bold: true,
    },
    { value: "Recorded by: " + e.actorName, size: 8 },
  );
  if (originalReference)
    parts.push({ value: "Original: " + originalReference, size: 8 });
  if (e.note) parts.push({ value: "Notes: " + e.note, size: 9 });
  if (e.kind === "FX_PURCHASED")
    parts.push({
      value:
        "Purchased currency added to stock. PKR payment recorded as cash paid.",
      size: 8,
    });
  if (e.kind === "FX_GIVEN" && e.paymentMode !== "CASH")
    parts.push({
      value:
        "PKR payment is due. This delivery note is not a payment confirmation.",
      size: 8,
    });
  parts.push(
    { value: brand.receiptFooter || "Thank you.", size: 8, center: true },
    { value: "Khata OS | Ahmed Solutions", size: 7, center: true },
  );
  const probe = printDocument({ size: [width, 10000], margin: 14 });
  const heights = parts.map((p) =>
    p
      ? probe
          .font(p.bold ? "PrintBold" : "PrintRegular")
          .fontSize(p.size)
          .heightOfString(p.value, { width: inner, lineGap: 3 }) + 8
      : 13,
  );
  probe.end();
  const height = Math.max(200, 36 + heights.reduce((a, b) => a + b, 0));
  const doc = printDocument({
    size: [width, height],
    margin: 14,
    info: { Title: e.reference, Author: brand.legalName },
  });
  let y = 18;
  parts.forEach((p, i) => {
    if (!p) {
      line(doc, y, 14, inner);
    } else {
      doc
        .font(p.bold ? "PrintBold" : "PrintRegular")
        .fontSize(p.size)
        .fillColor("#111")
        .text(p.value, 14, y, {
          width: inner,
          align: p.center ? "center" : "left",
          lineGap: 3,
        });
    }
    y += heights[i];
  });
  return doc;
}
export function sendPDF(res: any, doc: PDFKit.PDFDocument, filename: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}.pdf"`);
  doc.pipe(res);
  doc.end();
}

export function businessReportPDF(
  brand: Brand,
  title: string,
  subtitle: string,
  summary: [string, string][],
  headers: string[],
  rows: string[][],
  note = "",
) {
  const doc = printDocument({
    size: "A4",
    margin: 44,
    bufferPages: true,
    info: { Title: title, Author: brand.legalName },
  });
  let y = header(doc, brand, title, subtitle);
  for (const [key, value] of summary) {
    if (y > 720) {
      doc.addPage();
      y = 45;
    }
    txt(doc, key, 44, y, 330, 10);
    txt(
      doc,
      /^-?\d+(\.\d+)?$/.test(value)
        ? printNumber(value, key.includes("PKR") ? 2 : 0)
        : value,
      374,
      y,
      177,
      10,
      true,
      "right",
    );
    y += 24;
  }
  y += 18;
  const widths =
    headers.length === 2
      ? [330, 177]
      : headers.length === 4
        ? [90, 125, 145, 147]
        : headers.length === 6
          ? [90, 117, 66, 78, 78, 78]
          : headers.length === 5
            ? [95, 150, 108, 74, 80]
            : Array(headers.length).fill(507 / headers.length);
  const tableHead = () => {
    doc.rect(44, y, 507, 30).fill(color.teal);
    let x = 44;
    headers.forEach((h, i) => {
      doc
        .font("PrintBold")
        .fontSize(8)
        .fillColor("white")
        .text(h, x + 7, y + 9, { width: widths[i] - 14 });
      x += widths[i];
    });
    y += 30;
  };
  tableHead();
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n];
    const heights = row.map((v, i) =>
      doc
        .font("PrintRegular")
        .fontSize(8)
        .heightOfString(v, { width: widths[i] - 14, lineGap: 3 }),
    );
    const h = Math.max(42, ...heights.map((v) => v + 20));
    if (y + h > 743) {
      doc.addPage();
      y = 45;
      txt(doc, title + " | " + brand.legalName, 44, y, 507, 10, true);
      y += 28;
      tableHead();
    }
    doc.rect(44, y, 507, h).fill(n % 2 === 0 ? "#f6f9f7" : "white");
    let x = 44;
    row.forEach((v, i) => {
      txt(
        doc,
        v,
        x + 7,
        y + 10,
        widths[i] - 14,
        8,
        false,
        /^-?[\d,]+(\.\d+)?$/.test(v) ? "right" : "left",
      );
      x += widths[i];
    });
    line(doc, y + h);
    y += h;
  }
  if (!rows.length) {
    txt(doc, "No records for the selected filters.", 54, y + 20, 487, 10);
    y += 55;
  }
  if (note) {
    y += 20;
    const h = doc
      .font("PrintRegular")
      .fontSize(9)
      .heightOfString(note, { width: 507, lineGap: 3 });
    if (y + h > 743) {
      doc.addPage();
      y = 50;
    }
    txt(doc, note, 44, y, 507, 9);
  }
  footers(doc, brand, title);
  return doc;
}
