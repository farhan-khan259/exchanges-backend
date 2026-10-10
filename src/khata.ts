import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  receiptPDF,
  statementPDF,
  sendPDF,
  businessReportPDF,
} from "./print.js";
import ExcelJS from "exceljs";
import {
  db,
  D,
  money,
  check,
  permit,
  scope,
  atomic,
  audit,
  hash,
  type Tx,
  type Actor,
} from "./core.js";
import { reports } from "./reports.js";
export const api = Router();
const positive = (places: number) =>
  z
    .string()
    .regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${places}})?$`))
    .refine((v) => D(v).gt(0), "Enter a positive amount");
const note = z.string().trim().max(500).default("");
const partyInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    mobile: z.string().trim().max(30).default(""),
    notes: note,
    identityType: z.enum(["", "CNIC", "NICOP", "PASSPORT"]).default(""),
    identityNo: z.string().trim().max(30).default(""),
  })
  .refine((v) => !v.identityNo || !!v.identityType, "Choose an identity type");
const addInput = z.object({
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  quantity: positive(4),
  rate: positive(8),
  note,
});
const giveInput = z
  .object({
    partyId: z.string().optional(),
    newParty: partyInput.optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    quantity: positive(4),
    quotedRate: positive(8),
    saleRate: positive(8).optional(),
    paymentMode: z.enum(["CREDIT", "CASH"]).default("CREDIT"),
    note,
  })
  .refine((v) => !!v.partyId !== !!v.newParty, "Choose a party or create one");
const paymentInput = z.object({
  partyId: z.string(),
  amount: positive(2),
  note,
});
export function stockCalculation(
  quantity: string,
  cost: string,
  amount: string,
) {
  const q = D(quantity),
    c = D(cost),
    n = D(amount);
  check(n.gt(0) && q.gte(n), "Not enough currency in stock", 409);
  const rate = c.div(q).toDecimalPlaces(8);
  const carrying = n.eq(q) ? c : c.mul(n).div(q).toDecimalPlaces(8);
  const payable = D(money(n.mul(rate)));
  check(payable.gt(0) && carrying.gt(0), "Amount too small");
  return {
    rate: rate.toFixed(8),
    carrying: carrying.toFixed(8),
    payable: payable.toFixed(2),
    quantity: q.minus(n).toFixed(4),
    cost: c.minus(carrying).toFixed(8),
  };
}
async function workspace(tx: Tx, a: Actor) {
  const b = await tx.branch.findFirst({
    where: {
      tenantId: a.tenantId!,
      ...(a.branchId ? { id: a.branchId } : {}),
      active: true,
    },
    orderBy: { createdAt: "asc" },
  });
  check(b, "Workspace unavailable", 404);
  return b.id;
}
async function party(tx: Tx, a: Actor, id: string) {
  const p = await tx.customer.findFirst({ where: { id, ...scope(a) } });
  check(p, "Party not found", 404);
  return p;
}
async function balance(tx: Tx, a: Actor, id: string) {
  const x = await tx.khataEntry.aggregate({
    where: { ...scope(a), partyId: id },
    _sum: { pkrDelta: true },
  });
  return D(String(x._sum.pkrDelta || 0));
}
async function makeParty(
  tx: Tx,
  a: Actor,
  v: z.infer<typeof partyInput>,
  branchId: string,
) {
  const p = await tx.customer.create({
    data: {
      ...v,
      tenantId: a.tenantId!,
      branchId,
      customerNo: "P-" + (a.offlineKey || randomUUID()).slice(0, 12),
    },
  });
  await audit(tx, a, "PARTY_CREATED", "Customer", p.id, {}, branchId);
  return p;
}
async function stamp(tx: Tx, a: Actor) {
  if (a.offlineAt) return a.offlineAt;
  const e = await tx.khataEntry.findFirst({
    where: scope(a),
    orderBy: { createdAt: "desc" },
  });
  const s = await tx.khataStockEntry.findFirst({
    where: scope(a),
    orderBy: { createdAt: "desc" },
  });
  return new Date(
    Math.max(
      Date.now(),
      (e?.createdAt.getTime() || 0) + 1,
      (s?.createdAt.getTime() || 0) + 1,
    ),
  );
}
async function write(
  req: any,
  permission: string,
  input: unknown,
  fn: (tx: Tx, a: Actor) => Promise<any>,
) {
  const key = z.string().min(16).max(128).parse(req.headers["idempotency-key"]);
  return atomic(req.actor, permission, async (tx, fresh) => {
    const at = req.headers["x-offline-created-at"];
    const date = at ? new Date(String(at)) : undefined;
    check(!date || (!Number.isNaN(date.getTime()) && date.getTime() <= Date.now() + 300000 && date.getTime() >= Date.now() - 30 * 86400000), "Offline entry date is invalid or older than 30 days");
    const a: Actor = date ? { ...fresh, offlineAt: date, offlineKey: key } : fresh;
    const digest = hash(
      JSON.stringify({ route: req.path, actor: a.id, input }),
    );
    const old = await tx.idempotency.findUnique({
      where: { tenantId_key: { tenantId: a.tenantId!, key } },
    });
    if (old) {
      check(
        old.hash === digest,
        "Request key was used for different details",
        409,
      );
      return old.result;
    }
    const result = await fn(tx, a);
    await tx.idempotency.create({
      data: {
        tenantId: a.tenantId!,
        key,
        actorId: a.id,
        hash: digest,
        result: JSON.parse(JSON.stringify(result)),
      },
    });
    return result;
  });
}
async function optionalWrite(req: any, permission: string, input: unknown, fn: (tx: Tx, a: Actor) => Promise<any>) {
  return req.headers["idempotency-key"] ? write(req, permission, input, fn) : atomic(req.actor, permission, fn);
}
function paging(req: any) {
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  return { page, skip: (page - 1) * 20, take: 20 };
}
api.use((req, _res, next) => {
  permit(req.actor, "operations.read");
  next();
});
api.use(reports);
api.get("/bootstrap", async (req, res) => {
  res.json({
    settings: await db.settings.findUnique({
      where: { tenantId: req.actor.tenantId! },
    }),
    currencies: await db.currency.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
    }),
  });
});
api.get("/dashboard", async (req, res) => {
  const s = scope(req.actor);
  const due = await db.khataEntry.aggregate({
    where: s,
    _sum: { pkrDelta: true },
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const payments = await db.khataEntry.findMany({
    where: {
      ...s,
      OR: [{ kind: "PKR_RECEIVED" }, { kind: "FX_GIVEN", paymentMode: "CASH" }],
    },
    select: { id: true },
  });
  const netReceived = await db.khataEntry.aggregate({
    where: {
      ...s,
      createdAt: { gte: today },
      OR: [
        { kind: "PKR_RECEIVED" },
        { kind: "FX_GIVEN", paymentMode: "CASH" },
        { kind: "REVERSAL", originalId: { in: payments.map((p) => p.id) } },
      ],
    },
    _sum: { cashDelta: true },
  });
  res.json({
    cash: String(
      (
        await db.khataCashEntry.aggregate({
          where: s,
          _sum: { amountDelta: true },
        })
      )._sum.amountDelta || 0,
    ),
    due: String(due._sum.pkrDelta || 0),
    parties: await db.customer.count({ where: s }),
    stock: await db.khataPosition.findMany({
      where: s,
      orderBy: { currencyCode: "asc" },
    }),
    received: D(String(netReceived._sum.cashDelta || 0)).toFixed(2),
    recent: await db.khataEntry.findMany({
      where: s,
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  });
});
api.get("/stock", async (req, res) =>
  res.json(
    await db.khataPosition.findMany({
      where: scope(req.actor),
      orderBy: { currencyCode: "asc" },
    }),
  ),
);
api.post("/stock", async (req, res) => {
  const v = addInput.parse(req.body);
  res.status(201).json(
    await write(req, "transaction.create", v, async (tx, a) => {
      const branchId = await workspace(tx, a);
      check(
        await tx.currency.findFirst({
          where: { code: v.currencyCode, active: true },
        }),
        "Currency unavailable",
      );
      const old = await tx.khataPosition.findUnique({
        where: {
          branchId_currencyCode: { branchId, currencyCode: v.currencyCode },
        },
      });
      const q = D(String(old?.quantity || 0)).plus(v.quantity);
      const added = D(v.quantity).mul(v.rate).toDecimalPlaces(8);
      check(added.gt(0), "Stock cost is too small");
      const cost = D(String(old?.cost || 0)).plus(added);
      const p = await tx.khataPosition.upsert({
        where: {
          branchId_currencyCode: { branchId, currencyCode: v.currencyCode },
        },
        create: {
          tenantId: a.tenantId!,
          branchId,
          currencyCode: v.currencyCode,
          quantity: q.toFixed(4),
          cost: cost.toFixed(8),
        },
        update: { quantity: q.toFixed(4), cost: cost.toFixed(8) },
      });
      const e = await tx.khataStockEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId,
          currencyCode: v.currencyCode,
          kind: "STOCK_ADD",
          quantityDelta: v.quantity,
          costDelta: added.toFixed(8),
          quantityAfter: p.quantity,
          costAfter: p.cost,
          rate: v.rate,
          note: v.note,
          createdBy: a.id,
          createdAt: await stamp(tx, a),
        },
      });
      await audit(tx, a, "STOCK_ADDED", "KhataStockEntry", e.id, v, branchId);
      return e;
    }),
  );
});
api.get("/stock/history", async (req, res) => {
  const p = paging(req);
  const code = z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .parse(req.query.currencyCode);
  const where = {
    ...scope(req.actor),
    ...(code ? { currencyCode: code } : {}),
  };
  const rows = await db.khataStockEntry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: p.skip,
    take: p.take,
  });
  const reversed = await db.khataStockEntry.findMany({
    where: { ...scope(req.actor), originalId: { in: rows.map((x) => x.id) } },
    select: { originalId: true },
  });
  res.json({
    rows: rows.map((x) => ({
      ...x,
      reversed: reversed.some((r) => r.originalId === x.id),
    })),
    total: await db.khataStockEntry.count({ where }),
    page: p.page,
  });
});
api.post("/currencies", async (req, res) => {
  permit(req.actor, "settings.write");
  const v = z
    .object({
      code: z.string().regex(/^[A-Z]{3}$/),
      name: z.string().trim().min(2).max(80),
    })
    .parse(req.body);
  res.status(201).json(
    await optionalWrite(req, "settings.write", v, async (tx, a) => {
      const c = await tx.currency.create({
        data: { ...v, symbol: v.code, precision: 4 },
      });
      await audit(tx, a, "CURRENCY_CREATED", "Currency", c.code);
      return c;
    }),
  );
});
api.get("/parties", async (req, res) => {
  const p = paging(req);
  const search = z.string().max(100).default("").parse(req.query.search);
  const where = {
    ...scope(req.actor),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { mobile: { contains: search } },
          ],
        }
      : {}),
  };
  const rows = await db.customer.findMany({
    where,
    orderBy: { name: "asc" },
    skip: p.skip,
    take: p.take,
    select: {
      id: true,
      name: true,
      mobile: true,
      notes: true,
      identityType: true,
      identityNo: true,
    },
  });
  const totals = await db.khataEntry.groupBy({
    by: ["partyId"],
    where: { ...scope(req.actor), partyId: { in: rows.map((x) => x.id) } },
    _sum: { pkrDelta: true },
  });
  res.json({
    rows: rows.map((p) => ({
      ...p,
      balance: String(
        totals.find((t) => t.partyId === p.id)?._sum.pkrDelta || 0,
      ),
    })),
    total: await db.customer.count({ where }),
    page: p.page,
  });
});
api.post("/parties", async (req, res) => {
  const v = partyInput.parse(req.body);
  res
    .status(201)
    .json(
      await optionalWrite(req, "customer.write", v, async (tx, a) =>
        makeParty(tx, a, v, await workspace(tx, a)),
      ),
    );
});
api.patch("/parties/:id", async (req, res) => {
  const v = partyInput.parse(req.body);
  res.json(
    await optionalWrite(req, "customer.write", v, async (tx, a) => {
      const p = await party(tx, a, String(req.params.id));
      const result = await tx.customer.update({ where: { id: p.id }, data: v });
      await audit(tx, a, "PARTY_UPDATED", "Customer", p.id);
      return result;
    }),
  );
});
api.get("/parties/:id", async (req, res) => {
  const p = await party(db as any, req.actor, String(req.params.id));
  const page = paging(req);
  const where = { ...scope(req.actor), partyId: p.id };
  const rows = await db.khataEntry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: page.skip,
    take: page.take,
  });
  const reversed = await db.khataEntry.findMany({
    where: { ...scope(req.actor), originalId: { in: rows.map((x) => x.id) } },
    select: { originalId: true, id: true },
  });
  res.json({
    party: {
      id: p.id,
      name: p.name,
      mobile: p.mobile,
      notes: p.notes,
      identityType: p.identityType,
      identityNo: p.identityNo,
    },
    balance: (await balance(db as any, req.actor, p.id)).toFixed(2),
    rows: rows.map((x) => ({
      ...x,
      reversedBy: reversed.find((r) => r.originalId === x.id)?.id,
    })),
    total: await db.khataEntry.count({ where }),
    page: page.page,
  });
});
api.post("/give", async (req, res) => {
  const v = giveInput.parse(req.body);
  res.status(201).json(
    await write(req, "transaction.create", v, async (tx, a) => {
      const branchId = await workspace(tx, a);
      if (v.newParty) permit(a, "customer.write");
      const p = v.partyId
        ? await party(tx, a, v.partyId)
        : await makeParty(tx, a, v.newParty!, branchId);
      const position = await tx.khataPosition.findUnique({
        where: {
          branchId_currencyCode: { branchId, currencyCode: v.currencyCode },
        },
      });
      check(position, "No stock for this currency", 409);
      const c = stockCalculation(
        position.quantity.toString(),
        position.cost.toString(),
        v.quantity,
      );
      check(
        D(c.rate).eq(v.quotedRate),
        "Stock rate changed. Refresh and try again.",
        409,
      );
      const saleRate = v.saleRate || c.rate;
      const saleAmount = money(D(v.quantity).mul(saleRate));
      check(D(saleAmount).gt(0), "Sale amount too small");
      const debt = v.paymentMode === "CREDIT" ? saleAmount : "0.00";
      const cash = v.paymentMode === "CASH" ? saleAmount : "0.00";
      await tx.khataPosition.update({
        where: { id: position.id },
        data: { quantity: c.quantity, cost: c.cost },
      });
      const e = await tx.khataEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId,
          partyId: p.id,
          kind: "FX_GIVEN",
          reference: "KH-" + (a.offlineKey || randomUUID()).slice(0, 12).toUpperCase(),
          currencyCode: v.currencyCode,
          foreignAmount: v.quantity,
          rate: saleRate,
          stockCost: c.carrying,
          pkrAmount: saleAmount,
          paymentMode: v.paymentMode,
          cashDelta: cash,
          realizedProfit: money(D(saleAmount).minus(c.carrying)),
          pkrDelta: debt,
          balanceAfter: (await balance(tx, a, p.id)).plus(debt).toFixed(2),
          note: v.note,
          createdBy: a.id,
          actorName: a.name,
          createdAt: await stamp(tx, a),
        },
      });
      await tx.khataStockEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId,
          currencyCode: v.currencyCode,
          kind: "FX_GIVEN",
          quantityDelta: D(v.quantity).negated().toFixed(4),
          costDelta: D(c.carrying).negated().toFixed(8),
          quantityAfter: c.quantity,
          costAfter: c.cost,
          rate: c.rate,
          note: v.note,
          createdBy: a.id,
          khataEntryId: e.id,
          createdAt: e.createdAt,
        },
      });
      if (D(cash).gt(0)) await cashEntry(tx, a, e, "SALE");
      await audit(
        tx,
        a,
        "CURRENCY_GIVEN",
        "KhataEntry",
        e.id,
        { ...v, newParty: undefined },
        branchId,
      );
      return e;
    }),
  );
});
api.post("/payments", async (req, res) => {
  const v = paymentInput.parse(req.body);
  res.status(201).json(
    await write(req, "transaction.create", v, async (tx, a) => {
      const p = await party(tx, a, v.partyId);
      const b = await balance(tx, a, p.id);
      check(b.gte(v.amount), "Payment exceeds remaining PKR balance", 409);
      const e = await tx.khataEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId: p.branchId,
          partyId: p.id,
          kind: "PKR_RECEIVED",
          paymentMode: "CASH",
          pkrAmount: v.amount,
          cashDelta: v.amount,
          reference: "KH-" + (a.offlineKey || randomUUID()).slice(0, 12).toUpperCase(),
          pkrDelta: D(v.amount).negated().toFixed(2),
          balanceAfter: b.minus(v.amount).toFixed(2),
          note: v.note,
          createdBy: a.id,
          actorName: a.name,
          createdAt: await stamp(tx, a),
        },
      });
      await cashEntry(tx, a, e, "PAYMENT");
      await audit(
        tx,
        a,
        "PAYMENT_RECEIVED",
        "KhataEntry",
        e.id,
        { amount: v.amount },
        p.branchId,
      );
      return e;
    }),
  );
});
api.post("/entries/:id/reverse", async (req, res) => {
  const v = z
    .object({ reason: z.string().trim().min(5).max(500) })
    .parse(req.body);
  res.status(201).json(
    await write(req, "settings.write", v, async (tx, a) => {
      const original = await tx.khataEntry.findFirst({
        where: { id: String(req.params.id), ...scope(a) },
      });
      check(original && original.kind !== "REVERSAL", "Entry unavailable", 404);
      check(
        !(await tx.khataEntry.findFirst({
          where: { originalId: original.id },
        })),
        "Already reversed",
        409,
      );
      const b = (await balance(tx, a, original.partyId)).minus(
        original.pkrDelta.toString(),
      );
      check(
        b.gte(0),
        "Reverse the related PKR payment first to avoid a negative khata",
        409,
      );
      const e = await tx.khataEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId: original.branchId,
          partyId: original.partyId,
          kind: "REVERSAL",
          reference: "KR-" + (a.offlineKey || randomUUID()).slice(0, 12).toUpperCase(),
          currencyCode: original.currencyCode,
          foreignAmount: original.foreignAmount,
          rate: original.rate,
          stockCost: original.stockCost,
          pkrAmount: original.pkrAmount,
          paymentMode: original.paymentMode,
          cashDelta: D(original.cashDelta.toString()).negated().toFixed(2),
          realizedProfit: D(original.realizedProfit.toString())
            .negated()
            .toFixed(2),
          pkrDelta: D(original.pkrDelta.toString()).negated().toFixed(2),
          balanceAfter: b.toFixed(2),
          note: v.reason,
          originalId: original.id,
          createdBy: a.id,
          actorName: a.name,
          createdAt: await stamp(tx, a),
        },
      });
      if (original.kind === "FX_GIVEN") {
        const p = await tx.khataPosition.findUniqueOrThrow({
          where: {
            branchId_currencyCode: {
              branchId: original.branchId,
              currencyCode: original.currencyCode!,
            },
          },
        });
        const q = D(p.quantity.toString()).plus(
          original.foreignAmount!.toString(),
        );
        const c = D(p.cost.toString()).plus(original.stockCost!.toString());
        await tx.khataPosition.update({
          where: { id: p.id },
          data: { quantity: q.toFixed(4), cost: c.toFixed(8) },
        });
        const s = await tx.khataStockEntry.findUniqueOrThrow({
          where: { khataEntryId: original.id },
        });
        await tx.khataStockEntry.create({
          data: {
            tenantId: a.tenantId!,
            branchId: p.branchId,
            currencyCode: p.currencyCode,
            kind: "REVERSAL",
            quantityDelta: original.foreignAmount!,
            costDelta: original.stockCost!,
            quantityAfter: q.toFixed(4),
            costAfter: c.toFixed(8),
            rate: original.rate!,
            note: v.reason,
            originalId: s.id,
            khataEntryId: e.id,
            createdBy: a.id,
            createdAt: e.createdAt,
          },
        });
      }
      if (original.kind === "FX_PURCHASED") {
        const p = await tx.khataPosition.findUniqueOrThrow({
          where: {
            branchId_currencyCode: {
              branchId: original.branchId,
              currencyCode: original.currencyCode!,
            },
          },
        });
        const q = D(p.quantity.toString()).minus(
            original.foreignAmount!.toString(),
          ),
          cost = D(p.cost.toString()).minus(original.stockCost!.toString());
        check(
          q.gte(0) &&
            cost.gte(0) &&
            (!q.eq(0) || cost.eq(0)) &&
            (!q.gt(0) || cost.gt(0)),
          "Purchased stock has been used. Reverse sales first.",
          409,
        );
        await tx.khataPosition.update({
          where: { id: p.id },
          data: { quantity: q.toFixed(4), cost: cost.toFixed(8) },
        });
        const originalStock = await tx.khataStockEntry.findUniqueOrThrow({
          where: { khataEntryId: original.id },
        });
        await tx.khataStockEntry.create({
          data: {
            tenantId: a.tenantId!,
            branchId: p.branchId,
            currencyCode: p.currencyCode,
            kind: "REVERSAL",
            quantityDelta: D(original.foreignAmount!.toString())
              .negated()
              .toFixed(4),
            costDelta: D(original.stockCost!.toString()).negated().toFixed(8),
            quantityAfter: q.toFixed(4),
            costAfter: cost.toFixed(8),
            rate: original.rate!,
            note: v.reason,
            originalId: originalStock.id,
            khataEntryId: e.id,
            createdBy: a.id,
            createdAt: e.createdAt,
          },
        });
      }
      if (!D(e.cashDelta.toString()).eq(0))
        await cashEntry(tx, a, e, "REVERSAL");
      await audit(
        tx,
        a,
        "ENTRY_REVERSED",
        "KhataEntry",
        e.id,
        { originalId: original.id, reason: v.reason },
        original.branchId,
      );
      return e;
    }),
  );
});
api.post("/stock/:id/reverse", async (req, res) => {
  const v = z
    .object({ reason: z.string().trim().min(5).max(500) })
    .parse(req.body);
  res.status(201).json(
    await write(req, "settings.write", v, async (tx, a) => {
      const e = await tx.khataStockEntry.findFirst({
        where: { id: String(req.params.id), ...scope(a), kind: "STOCK_ADD" },
      });
      check(e, "Stock addition not found", 404);
      check(
        !(await tx.khataStockEntry.findFirst({ where: { originalId: e.id } })),
        "Already reversed",
        409,
      );
      const p = await tx.khataPosition.findUniqueOrThrow({
        where: {
          branchId_currencyCode: {
            branchId: e.branchId,
            currencyCode: e.currencyCode,
          },
        },
      });
      const q = D(p.quantity.toString()).minus(e.quantityDelta.toString()),
        c = D(p.cost.toString()).minus(e.costDelta.toString());
      check(
        q.gte(0) && c.gte(0) && (!q.eq(0) || c.eq(0)) && (!q.gt(0) || c.gt(0)),
        "Stock has been used. Reverse currency deliveries first.",
        409,
      );
      await tx.khataPosition.update({
        where: { id: p.id },
        data: { quantity: q.toFixed(4), cost: c.toFixed(8) },
      });
      const r = await tx.khataStockEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId: p.branchId,
          currencyCode: p.currencyCode,
          kind: "REVERSAL",
          quantityDelta: D(e.quantityDelta.toString()).negated().toFixed(4),
          costDelta: D(e.costDelta.toString()).negated().toFixed(8),
          quantityAfter: q.toFixed(4),
          costAfter: c.toFixed(8),
          rate: e.rate,
          note: v.reason,
          originalId: e.id,
          createdBy: a.id,
          createdAt: await stamp(tx, a),
        },
      });
      await audit(
        tx,
        a,
        "STOCK_REVERSED",
        "KhataStockEntry",
        r.id,
        { originalId: e.id, reason: v.reason },
        p.branchId,
      );
      return r;
    }),
  );
});
api.get("/settings", async (req, res) =>
  res.json(
    await db.settings.findUnique({ where: { tenantId: req.actor.tenantId! } }),
  ),
);
api.patch("/settings", async (req, res) => {
  const v = z
    .object({
      legalName: z.string().trim().min(2).max(100),
      address: z.string().max(300).default(""),
      phone: z.string().max(30).default(""),
      receiptFooter: z.string().max(200).default("Thank you."),
    })
    .parse(req.body);
  res.json(
    await optionalWrite(req, "settings.write", v, async (tx, a) => {
      const r = await tx.settings.update({
        where: { tenantId: a.tenantId! },
        data: v,
      });
      await audit(tx, a, "SETTINGS_UPDATED", "Settings", r.id);
      return r;
    }),
  );
});
api.get("/audit", async (req, res) => {
  permit(req.actor, "audit.read");
  const p = paging(req);
  const where = scope(req.actor);
  res.json({
    rows: await db.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: p.skip,
      take: p.take,
    }),
    total: await db.auditEvent.count({ where }),
    page: p.page,
  });
});
api.get("/entries/:id/receipt", async (req, res) => {
  const e = await db.khataEntry.findFirst({
    where: { id: String(req.params.id), ...scope(req.actor) },
  });
  check(e, "Entry unavailable", 404);
  const p = await party(db as any, req.actor, e.partyId);
  const settings = await db.settings.findUniqueOrThrow({
    where: { tenantId: req.actor.tenantId! },
  });
  const reverse = await db.khataEntry.findFirst({
    where: { originalId: e.id, ...scope(req.actor) },
  });
  const original = e.originalId
    ? await db.khataEntry.findFirst({
        where: { id: e.originalId, ...scope(req.actor) },
      })
    : null;
  sendPDF(
    res,
    receiptPDF(
      settings as any,
      p as any,
      { ...e, reversed: !!reverse } as any,
      {
        thermal: req.query.size === "thermal",
        originalReference: original?.reference,
      },
    ),
    e.reference,
  );
});
api.get("/parties/:id/export", async (req, res) => {
  permit(req.actor, "report.read");
  const p = await party(db as any, req.actor, String(req.params.id));
  const rows = await db.khataEntry.findMany({
    where: { ...scope(req.actor), partyId: p.id },
    orderBy: { createdAt: "asc" },
    take: 10001,
  });
  check(
    rows.length <= 10000,
    "Statement is too large; contact administrator",
    413,
  );
  const b = await balance(db as any, req.actor, p.id);
  const settings = await db.settings.findUniqueOrThrow({
    where: { tenantId: req.actor.tenantId! },
  });
  if (req.query.format === "xlsx") {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("Khata");
    sheet.addRow(["Party", p.name, "Due PKR", b.toFixed(2)]);
    sheet.addRow([
      "Date",
      "Reference",
      "Type",
      "Currency",
      "Quantity",
      "Rate PKR",
      "PKR amount",
      "Cash movement",
      "Profit/Loss",
      "Khata movement",
      "PKR balance",
      "Notes",
    ]);
    for (const e of rows)
      sheet.addRow([
        e.createdAt.toISOString(),
        e.reference,
        e.kind,
        e.currencyCode || "",
        e.foreignAmount?.toString() || "",
        e.rate?.toString() || "",
        e.pkrAmount.toString(),
        e.cashDelta.toString(),
        e.realizedProfit.toString(),
        e.pkrDelta.toString(),
        e.balanceAfter.toString(),
        e.note,
      ]);
    sheet.columns.forEach((c) => (c.width = 22));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="party-khata.xlsx"',
    );
    await book.xlsx.write(res);
    res.end();
  } else {
    const corrections = await db.khataEntry.findMany({
      where: { ...scope(req.actor), originalId: { in: rows.map((e) => e.id) } },
      select: { originalId: true },
    });
    sendPDF(
      res,
      statementPDF(
        settings as any,
        p as any,
        rows.map((e) => ({
          ...e,
          reversed: corrections.some((c) => c.originalId === e.id),
        })) as any,
        b.toFixed(2),
      ),
      "party-khata",
    );
  }
});
api.get("/stock/export", async (req, res) => {
  permit(req.actor, "report.read");
  const rows = await db.khataPosition.findMany({
    where: scope(req.actor),
    orderBy: { currencyCode: "asc" },
  });
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Currency Stock");
  sheet.addRow([
    "Currency",
    "Quantity",
    "Average stock rate PKR",
    "Stock cost PKR",
  ]);
  for (const p of rows)
    sheet.addRow([
      p.currencyCode,
      p.quantity.toString(),
      D(p.quantity.toString()).gt(0)
        ? D(p.cost.toString()).div(p.quantity.toString()).toFixed(8)
        : "0",
      p.cost.toString(),
    ]);
  sheet.columns.forEach((c) => (c.width = 25));
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="currency-stock.xlsx"',
  );
  await book.xlsx.write(res);
  res.end();
});

async function cashEntry(tx: Tx, a: Actor, e: any, kind: string) {
  return tx.khataCashEntry.create({
    data: {
      tenantId: a.tenantId!,
      branchId: e.branchId,
      kind,
      amountDelta: e.cashDelta,
      note: e.note || kind,
      createdBy: a.id,
      khataEntryId: e.id,
      createdAt: e.createdAt,
    },
  });
}
api.post("/buy", async (req, res) => {
  const v = z
    .object({
      partyId: z.string().optional(),
      newParty: partyInput.optional(),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
      quantity: positive(4),
      rate: positive(8),
      note,
    })
    .refine((v) => !!v.partyId !== !!v.newParty, "Choose a party or create one")
    .parse(req.body);
  res.status(201).json(
    await write(req, "transaction.create", v, async (tx, a) => {
      const branchId = await workspace(tx, a);
      if (v.newParty) permit(a, "customer.write");
      const p = v.partyId
        ? await party(tx, a, v.partyId)
        : await makeParty(tx, a, v.newParty!, branchId);
      check(
        await tx.currency.findFirst({
          where: { code: v.currencyCode, active: true },
        }),
        "Currency unavailable",
      );
      const amount = money(D(v.quantity).mul(v.rate));
      check(D(amount).gt(0), "Purchase amount too small");
      const cost = D(amount);
      const old = await tx.khataPosition.findUnique({
        where: {
          branchId_currencyCode: { branchId, currencyCode: v.currencyCode },
        },
      });
      const q = D(String(old?.quantity || 0)).plus(v.quantity),
        c = D(String(old?.cost || 0)).plus(cost);
      const pos = await tx.khataPosition.upsert({
        where: {
          branchId_currencyCode: { branchId, currencyCode: v.currencyCode },
        },
        create: {
          tenantId: a.tenantId!,
          branchId,
          currencyCode: v.currencyCode,
          quantity: q.toFixed(4),
          cost: c.toFixed(8),
        },
        update: { quantity: q.toFixed(4), cost: c.toFixed(8) },
      });
      const e = await tx.khataEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId,
          partyId: p.id,
          kind: "FX_PURCHASED",
          reference: "KB-" + (a.offlineKey || randomUUID()).slice(0, 12).toUpperCase(),
          currencyCode: v.currencyCode,
          foreignAmount: v.quantity,
          rate: v.rate,
          stockCost: cost.toFixed(8),
          pkrAmount: amount,
          cashDelta: D(amount).negated().toFixed(2),
          paymentMode: "CASH",
          pkrDelta: "0",
          balanceAfter: (await balance(tx, a, p.id)).toFixed(2),
          note: v.note,
          actorName: a.name,
          createdBy: a.id,
          createdAt: await stamp(tx, a),
        },
      });
      await tx.khataStockEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId,
          currencyCode: v.currencyCode,
          kind: "FX_PURCHASED",
          quantityDelta: v.quantity,
          costDelta: cost.toFixed(8),
          quantityAfter: pos.quantity,
          costAfter: pos.cost,
          rate: v.rate,
          note: v.note,
          createdBy: a.id,
          khataEntryId: e.id,
          createdAt: e.createdAt,
        },
      });
      await cashEntry(tx, a, e, "PURCHASE");
      await audit(
        tx,
        a,
        "CURRENCY_PURCHASED",
        "KhataEntry",
        e.id,
        { currency: v.currencyCode, amount },
        branchId,
      );
      return e;
    }),
  );
});
api.post("/cash", async (req, res) => {
  const v = z
    .object({
      kind: z.enum(["ADJUSTMENT", "EXPENSE"]),
      direction: z.enum(["IN", "OUT"]),
      amount: positive(2),
      reason: z.string().trim().min(5).max(500),
    })
    .parse(req.body);
  check(
    v.kind !== "EXPENSE" || v.direction === "OUT",
    "Expenses are cash outflows",
  );
  res.status(201).json(
    await write(req, "settings.write", v, async (tx, a) => {
      const branchId = await workspace(tx, a);
      const e = await tx.khataCashEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId,
          kind: v.kind,
          createdAt: a.offlineAt || new Date(),
          amountDelta:
            v.direction === "IN" ? v.amount : D(v.amount).negated().toFixed(2),
          note: v.reason,
          createdBy: a.id,
        },
      });
      await audit(
        tx,
        a,
        "CASH_" + v.kind,
        "KhataCashEntry",
        e.id,
        { amount: e.amountDelta, reason: v.reason },
        branchId,
      );
      return e;
    }),
  );
});

api.post("/cash/:id/reverse", async (req, res) => {
  const v = z
    .object({ reason: z.string().trim().min(5).max(500) })
    .parse(req.body);
  res.status(201).json(
    await write(req, "settings.write", v, async (tx, a) => {
      const e = await tx.khataCashEntry.findFirst({
        where: {
          id: String(req.params.id),
          ...scope(a),
          kind: { in: ["ADJUSTMENT", "EXPENSE"] },
        },
      });
      check(
        e,
        "Manual cash entry not found. Reverse linked transactions from customer history.",
        404,
      );
      check(
        !(await tx.khataCashEntry.findFirst({ where: { originalId: e.id } })),
        "Already reversed",
        409,
      );
      const r = await tx.khataCashEntry.create({
        data: {
          tenantId: a.tenantId!,
          branchId: e.branchId,
          kind: "REVERSAL",
          originalId: e.id,
          createdAt: a.offlineAt || new Date(),
          amountDelta: D(e.amountDelta.toString()).negated().toFixed(2),
          note: v.reason,
          createdBy: a.id,
        },
      });
      await audit(
        tx,
        a,
        "CASH_REVERSED",
        "KhataCashEntry",
        r.id,
        { originalId: e.id, reason: v.reason },
        e.branchId,
      );
      return r;
    }),
  );
});
