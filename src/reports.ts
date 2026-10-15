import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import { db, D, money, check, scope, permit, type Actor } from "./core.js";
import type { MongoStore } from "./database.js";
import { businessReportPDF, sendPDF, printNumber } from "./print.js";
export const reports = Router();
const input = z.object({
  type: z.enum(["PNL", "POSITION", "PURCHASE", "SALE"]).default("PNL"),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  partyId: z.string().max(100).optional(),
});
function dates(v: { from?: string; to?: string }) {
  for (const d of [v.from, v.to])
    if (d) {
      const x = new Date(d + "T00:00:00Z");
      check(
        !Number.isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d,
        "Invalid calendar date",
      );
    }
  const from = v.from ? new Date(v.from + "T00:00:00+05:00") : null,
    to = v.to ? new Date(v.to + "T23:59:59.999+05:00") : null;
  check(!from || !to || from <= to, "From date must be before the end date");
  return {
    from,
    to,
    where:
      from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {},
  };
}
const titles = {
  PNL: "Profit & Loss",
  POSITION: "Currency Inventory",
  PURCHASE: "Currency Purchases",
  SALE: "Currency Sales",
};
export async function reportData(a: Actor, query: any) {
  return db.transaction((tx) => buildReport(tx, a, query));
}
async function buildReport(store: MongoStore, a: Actor, query: any) {
  const db = store;
  const v = input.parse(query),
    period = dates(v),
    s = scope(a);
  if (v.type === "POSITION") {
    check(!v.partyId, "Inventory cannot be filtered by customer");
    const position = await db.khataPosition.findMany({
      where: {
        ...s,
        ...(v.currencyCode ? { currencyCode: v.currencyCode } : {}),
      },
      orderBy: { currencyCode: "asc" },
    });
    return {
      type: v.type,
      filters: { type: v.type, currencyCode: v.currencyCode },
      asOf: new Date().toISOString(),
      summary: {
        stockValue: money(
          position.reduce<import("decimal.js").Decimal>(
            (sum, p) => sum.plus(p.cost),
            D(0),
          ),
        ),
        currencies: position.length,
      },
      rows: position.map((p) => ({
        id: p.id,
        currencyCode: p.currencyCode,
        quantity: p.quantity,
        averageRate: D(p.quantity).gt(0)
          ? D(p.cost).div(p.quantity).toFixed(8)
          : "0",
        cost: p.cost,
      })),
    };
  }
  const where = {
    ...s,
    ...period.where,
    ...(v.currencyCode ? { currencyCode: v.currencyCode } : {}),
    ...(v.partyId ? { partyId: v.partyId } : {}),
  };
  const entries = await db.khataEntry.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 10001,
  });
  check(
    entries.length <= 10000,
    "Choose a shorter range (maximum 10,000 records)",
    413,
  );
  const originals = await db.khataEntry.findMany({
    where: {
      ...s,
      id: { in: entries.map((e) => e.originalId).filter(Boolean) },
    },
  });
  const parties = await db.customer.findMany({
    where: { ...s, id: { in: entries.map((e) => e.partyId) } },
    select: { id: true, name: true },
  });
  const corrections = await db.khataEntry.findMany({
    where: { ...s, originalId: { in: entries.map((e) => e.id) } },
    select: { originalId: true },
  });
  let purchases = D(0),
    sales = D(0),
    cost = D(0),
    profit = D(0);
  const rows = entries.flatMap((e) => {
    const source = e.originalId
      ? originals.find((o) => o.id === e.originalId)
      : e;
    if (!source || !["FX_GIVEN", "FX_PURCHASED"].includes(source.kind))
      return [];
    const sign = e.originalId ? -1 : 1,
      type = source.kind === "FX_PURCHASED" ? "PURCHASE" : "SALE",
      amount = D(e.pkrAmount).mul(sign);
    if (type === "PURCHASE") purchases = purchases.plus(amount);
    else {
      sales = sales.plus(amount);
      cost = cost.plus(D(e.stockCost).mul(sign));
      profit = profit.plus(e.realizedProfit);
    }
    return [
      {
        id: e.id,
        createdAt: e.createdAt,
        reference: e.reference,
        partyName: parties.find((p) => p.id === e.partyId)?.name || "",
        type,
        currencyCode: e.currencyCode,
        foreignAmount: D(e.foreignAmount).mul(sign).toFixed(4),
        rate: e.rate,
        amount: money(amount),
        paymentMode: e.paymentMode,
        isCorrection: !!e.originalId,
        reversed: corrections.some((c) => c.originalId === e.id),
      },
    ];
  });
  if (v.type === "PURCHASE" || v.type === "SALE") {
    const selected = rows.filter((e) => e.type === v.type);
    return {
      type: v.type,
      filters: v,
      summary: {
        total: money(v.type === "PURCHASE" ? purchases : sales),
        transactions: selected.filter((e) => !e.isCorrection).length,
        corrections: selected.filter((e) => e.isCorrection).length,
      },
      rows: selected,
    };
  }
  const expenseIds = await db.khataCashEntry.findMany({
    where: { ...s, kind: "EXPENSE" },
    select: { id: true },
  });
  const partial = !!(v.currencyCode || v.partyId);
  const expenses = partial
    ? D(0)
    : D(
        String(
          (
            await db.khataCashEntry.aggregate({
              where: {
                ...s,
                ...period.where,
                OR: [
                  { kind: "EXPENSE" },
                  {
                    kind: "REVERSAL",
                    originalId: { in: expenseIds.map((e) => e.id) },
                  },
                ],
              },
              _sum: { amountDelta: true },
            })
          )._sum.amountDelta || 0,
        ),
      ).negated();
  return {
    type: v.type,
    filters: v,
    summary: {
      sales: money(sales),
      costOfSales: money(cost),
      tradingProfit: money(profit),
      expenses: money(expenses),
      netProfit: money(profit.minus(expenses)),
    },
    note: partial
      ? "Filtered trading margin. General business expenses are not allocated to a currency/customer and are excluded."
      : "Profit uses weighted-average cost of currency sold. Unsold inventory is an asset; credit sales are recognized when sold.",
    rows: [],
  };
}
function page(req: any) {
  const n = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .default(1)
    .parse(req.query.page);
  return { page: n, skip: (n - 1) * 20 };
}
reports.get("/reports", async (req, res) => {
  permit(req.actor, "report.read");
  const data = await reportData(req.actor, req.query),
    p = page(req);
  res.json({
    ...data,
    rows: data.rows.slice(p.skip, p.skip + 20),
    total: data.rows.length,
    page: p.page,
  });
});
function reportLayout(data: any) {
  if (data.type === "PNL")
    return {
      summary: [] as [string, string][],
      headers: ["Profit & Loss / PKR", "Amount"],
      rows: [
        ["Sales revenue", data.summary.sales],
        ["Cost of sales", money(D(data.summary.costOfSales).negated())],
        ["Gross trading profit / loss", data.summary.tradingProfit],
        ["Operating expenses", money(D(data.summary.expenses).negated())],
        ["Net profit / loss", data.summary.netProfit],
      ],
    };
  if (data.type === "POSITION")
    return {
      summary: [
        ["Total inventory value / PKR", data.summary.stockValue],
        ["Currencies", String(data.summary.currencies)],
      ] as [string, string][],
      headers: [
        "Currency",
        "Available Quantity",
        "Avg. Cost / PKR",
        "Stock Value / PKR",
      ],
      rows: data.rows.map((p: any) => [
        p.currencyCode,
        p.quantity,
        p.averageRate,
        p.cost,
      ]),
    };
  return {
    summary: [
      [
        data.type === "PURCHASE" ? "Net purchases / PKR" : "Net sales / PKR",
        data.summary.total,
      ],
      ["Transactions", String(data.summary.transactions)],
      ["Corrections", String(data.summary.corrections)],
    ] as [string, string][],
    headers: [
      "Date / Reference",
      "Customer / Status",
      "Currency / Quantity",
      "Rate / PKR",
      "Amount / PKR",
    ],
    rows: data.rows.map((e: any) => [
      date(e.createdAt) + "\n" + e.reference,
      e.partyName +
        "\n" +
        (e.isCorrection
          ? "Correction"
          : e.reversed
            ? "Reversed"
            : e.paymentMode === "CASH"
              ? "Paid"
              : "Credit"),
      e.currencyCode + "\n" + e.foreignAmount,
      e.rate,
      e.amount,
    ]),
  };
}
const date = (v: Date) =>
  v.toLocaleDateString("en-GB", { timeZone: "Asia/Karachi" });
async function workbook(
  res: any,
  brand: any,
  title: string,
  subtitle: string,
  summary: [string, string][],
  headers: string[],
  rows: string[][],
  filename: string,
  note = "",
) {
  const book = new ExcelJS.Workbook();
  book.creator = brand.legalName;
  book.created = new Date();
  const sheet = book.addWorksheet(title.slice(0, 31), {
    views: [{ state: "frozen", ySplit: 5 + summary.length + (note ? 1 : 0) }],
    pageSetup: {
      paperSize: 9,
      orientation: headers.length > 4 ? "landscape" : "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  sheet.addRow([brand.legalName]);
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.getRow(1).font = {
    name: "Calibri",
    size: 18,
    bold: true,
    color: { argb: "FF13766C" },
  };
  sheet.addRow([title]);
  sheet.mergeCells(2, 1, 2, headers.length);
  sheet.getRow(2).font = { size: 14, bold: true };
  sheet.addRow([subtitle]);
  sheet.mergeCells(3, 1, 3, headers.length);
  sheet.addRow([]);
  for (const [label, value] of summary) sheet.addRow([label, value]);
  if (note) {
    const row = sheet.addRow([note]);
    sheet.mergeCells(row.number, 1, row.number, headers.length);
    row.height = 36;
    row.alignment = { wrapText: true, vertical: "middle" };
  }
  const head = sheet.addRow(headers);
  head.height = 28;
  head.eachCell((c) => {
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF13766C" },
    };
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
  sheet.autoFilter = {
    from: { row: head.number, column: 1 },
    to: { row: head.number, column: headers.length },
  };
  for (const values of rows) {
    const row = sheet.addRow(
      values.map((v) => {
        if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
        const n = Number(v);
        return Number.isSafeInteger(n) ||
          String(v).replace(/[-.]/g, "").length <= 15
          ? n
          : v;
      }),
    );
    row.height = values.some((v) => v.includes("\n")) ? 40 : 26;
    row.eachCell((c, i) => {
      c.alignment = {
        vertical: "middle",
        wrapText: true,
        horizontal: typeof c.value === "number" ? "right" : "left",
      };
      if (typeof c.value === "number")
        c.numFmt = headers[i - 1].includes("Quantity")
          ? "#,##0.0000"
          : headers[i - 1].includes("Rate") || headers[i - 1].includes("Avg.")
            ? "#,##0.00000000"
            : "#,##0.00";
      if (row.number % 2 === 0)
        c.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF0F6F3" },
        };
    });
  }
  sheet.columns.forEach((c, i) => (c.width = i === 1 ? 34 : 25));
  sheet.headerFooter.oddFooter = "&L" + brand.legalName + "&RPage &P of &N";
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.xlsx"`,
  );
  await book.xlsx.write(res);
  res.end();
}
reports.get("/reports/export", async (req, res) => {
  permit(req.actor, "report.read");
  const data = await reportData(req.actor, req.query),
    brand = await db.settings.findUniqueOrThrow({
      where: { tenantId: req.actor.tenantId! },
    }),
    layout = reportLayout(data),
    title = titles[data.type];
  const subtitle =
    data.type === "POSITION"
      ? "Current stock as of " + date(new Date())
      : (data.filters.from || "All dates") +
        " to " +
        (data.filters.to || "present");
  const filename = data.type.toLowerCase() + "-report";
  if (req.query.format === "xlsx")
    await workbook(
      res,
      brand,
      title,
      subtitle,
      layout.summary,
      layout.headers,
      layout.rows,
      filename,
      "note" in data ? data.note : "",
    );
  else
    sendPDF(
      res,
      businessReportPDF(
        brand as any,
        title,
        subtitle,
        layout.summary,
        layout.headers,
        layout.rows.map((r: string[]) =>
          r.map((v, i) =>
            /^-?\d+(\.\d+)?$/.test(v)
              ? printNumber(
                  v,
                  data.type === "PNL"
                    ? 2
                    : data.type === "POSITION"
                      ? i === 2
                        ? 8
                        : i === 1
                          ? 4
                          : 2
                      : i === 3
                        ? 8
                        : 2,
                )
              : v,
          ),
        ),
        "note" in data ? data.note : "",
      ),
      filename,
    );
});
export async function cashData(a: Actor, query: any) {
  return db.transaction((tx) => buildCash(tx, a, query));
}
async function buildCash(store: MongoStore, a: Actor, query: any) {
  const db = store;
  const v = input.pick({ from: true, to: true }).parse(query),
    p = dates(v),
    s = scope(a);
  const opening = p.from
    ? D(
        String(
          (
            await db.khataCashEntry.aggregate({
              where: { ...s, createdAt: { lt: p.from } },
              _sum: { amountDelta: true },
            })
          )._sum.amountDelta || 0,
        ),
      )
    : D(0);
  const rows = await db.khataCashEntry.findMany({
    where: { ...s, ...p.where },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 10001,
  });
  check(
    rows.length <= 10000,
    "Choose a shorter cash ledger range (maximum 10,000 records)",
    413,
  );
  const ids = rows.map((r) => r.khataEntryId).filter(Boolean),
    transactions = await db.khataEntry.findMany({
      where: { ...s, id: { in: ids } },
    });
  const reversals = await db.khataCashEntry.findMany({
    where: { ...s, originalId: { in: rows.map((r) => r.id) } },
    select: { originalId: true },
  });
  let running = opening,
    inflow = D(0),
    outflow = D(0);
  const result = rows.map((r): import("./database.js").Row => {
    const delta = D(r.amountDelta);
    if (delta.gt(0)) inflow = inflow.plus(delta);
    else outflow = outflow.minus(delta);
    running = running.plus(delta);
    return {
      ...r,
      reference:
        transactions.find((e) => e.id === r.khataEntryId)?.reference ||
        "CS-" + r.id.slice(0, 8).toUpperCase(),
      cashIn: delta.gt(0) ? money(delta) : "0.00",
      cashOut: delta.lt(0) ? money(delta.abs()) : "0.00",
      balanceAfter: money(running),
      reversed: reversals.some((x) => x.originalId === r.id),
    };
  });
  return {
    filters: v,
    summary: {
      opening: money(opening),
      cashIn: money(inflow),
      cashOut: money(outflow),
      closing: money(running),
    },
    balance: money(running),
    rows: result,
  };
}
reports.get("/cash", async (req, res) => {
  const data = await cashData(req.actor, req.query),
    p = page(req);
  res.json({
    ...data,
    rows: data.rows
      .slice()
      .reverse()
      .slice(p.skip, p.skip + 20),
    total: data.rows.length,
    page: p.page,
  });
});
reports.get("/cash/export", async (req, res) => {
  permit(req.actor, "report.read");
  const data = await cashData(req.actor, req.query),
    brand = await db.settings.findUniqueOrThrow({
      where: { tenantId: req.actor.tenantId! },
    });
  const summary: [string, string][] = [
    ["Opening balance / PKR", data.summary.opening],
    ["Cash in / PKR", data.summary.cashIn],
    ["Cash out / PKR", data.summary.cashOut],
    ["Closing balance / PKR", data.summary.closing],
  ];
  const headers = [
    "Date / Reference",
    "Description",
    "Type",
    "Cash In",
    "Cash Out",
    "Balance",
  ];
  const rows = data.rows.map((r) => [
    date(r.createdAt) + "\n" + r.reference,
    r.note + (r.reversed ? "\n(Reversed)" : ""),
    r.kind
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/^./, (c: string) => c.toUpperCase()),
    r.cashIn,
    r.cashOut,
    r.balanceAfter,
  ]);
  const subtitle =
    (data.filters.from || "All dates") +
    " to " +
    (data.filters.to || "present") +
    " · PKR";
  if (req.query.format === "xlsx")
    await workbook(
      res,
      brand,
      "PKR Cash Ledger",
      subtitle,
      summary,
      headers,
      rows,
      "cash-ledger",
    );
  else
    sendPDF(
      res,
      businessReportPDF(
        brand as any,
        "PKR Cash Ledger",
        subtitle,
        summary,
        headers,
        rows.map((row) =>
          row.map((v) => (/^-?\d+(\.\d+)?$/.test(v) ? printNumber(v) : v)),
        ),
      ),
      "cash-ledger",
    );
});
