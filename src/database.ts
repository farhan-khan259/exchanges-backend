import {
  MongoClient,
  Decimal128,
  type ClientSession,
  type Db,
  type Document,
} from "mongodb";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
export type Row = Record<string, any>;
export const models = [
  "tenant",
  "plan",
  "subscription",
  "settings",
  "branch",
  "user",
  "role",
  "permission",
  "rolePermission",
  "authSession",
  "customer",
  "currency",
  "khataPosition",
  "khataStockEntry",
  "khataEntry",
  "khataCashEntry",
  "auditEvent",
  "idempotency",
] as const;
type Model = (typeof models)[number];
const decimalFields: Record<string, string[]> = {
  plan: ["monthlyPrice"],
  khataPosition: ["quantity", "cost"],
  khataStockEntry: [
    "quantityDelta",
    "costDelta",
    "quantityAfter",
    "costAfter",
    "rate",
  ],
  khataEntry: [
    "pkrAmount",
    "cashDelta",
    "realizedProfit",
    "foreignAmount",
    "rate",
    "stockCost",
    "pkrDelta",
    "balanceAfter",
  ],
  khataCashEntry: ["amountDelta"],
};
const defaults: Record<string, Row> = {
  tenant: { status: "ACTIVE", financeRevision: 0 },
  user: {
    tenantId: null,
    branchId: null,
    roleId: null,
    platformAdmin: false,
    active: true,
    mustChangePassword: true,
  },
  subscription: { status: "ACTIVE", branchLimit: 1, userLimit: 5 },
  branch: { active: true, address: "", phone: "" },
  customer: {
    mobile: "",
    notes: "",
    identityType: null,
    identityNo: null,
    status: "ACTIVE",
  },
  currency: { active: true, precision: 4 },
  settings: {
    logoUrl: "",
    address: "",
    phone: "",
    receiptFooter: "Thank you for your business.",
    referencePrefix: "KH",
    locale: "en",
  },
  khataPosition: { quantity: "0", cost: "0" },
  khataEntry: {
    pkrAmount: "0",
    cashDelta: "0",
    realizedProfit: "0",
    paymentMode: "CREDIT",
    currencyCode: null,
    foreignAmount: null,
    rate: null,
    stockCost: null,
    originalId: null,
    note: "",
  },
  khataStockEntry: { khataEntryId: null, originalId: null },
  khataCashEntry: { khataEntryId: null, originalId: null },
};
const immutable = new Set([
  "khataEntry",
  "khataStockEntry",
  "khataCashEntry",
  "auditEvent",
  "idempotency",
]);
const relation: Record<
  string,
  Record<string, [Model, string, string, boolean]>
> = {
  user: {
    role: ["role", "roleId", "id", false],
    tenant: ["tenant", "tenantId", "id", false],
  },
  role: { grants: ["rolePermission", "id", "roleId", true] },
  rolePermission: { permission: ["permission", "permissionId", "id", false] },
  tenant: {
    subscription: ["subscription", "id", "tenantId", false],
    settings: ["settings", "id", "tenantId", false],
    branches: ["branch", "id", "tenantId", true],
    users: ["user", "id", "tenantId", true],
    transactions: ["khataEntry", "id", "tenantId", true],
  },
  authSession: { user: ["user", "userId", "id", false] },
};
function unpack(value: any): any {
  if (value instanceof Decimal128)
    return new Decimal(value.toString()).toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "_id")
        .map(([k, v]) => [k, unpack(v)]),
    );
  }
  return value;
}
export function encodeRecord(model: string, data: Row): Row {
  const result: Row = { ...data };
  for (const k of decimalFields[model] || [])
    if (result[k] != null) result[k] = Decimal128.fromString(String(result[k]));
  for (const k of ["createdAt", "updatedAt", "startsAt", "expiresAt"])
    if (typeof result[k] === "string") result[k] = new Date(result[k]);
  return result;
}
function missing() {
  return Object.assign(new Error("Record unavailable"), { status: 404 });
}
export class Collection {
  constructor(
    public store: MongoStore,
    public model: Model,
  ) {}
  private async native() {
    await this.store.connect();
    return this.store.database.collection(this.model);
  }
  private async filter(where: Row = {}): Promise<Row> {
    const output: Row = {};
    for (const [key, value] of Object.entries(where)) {
      if (key === "AND" || key === "OR") {
        output[key === "AND" ? "$and" : "$or"] = await Promise.all(
          (Array.isArray(value) ? value : [value]).map((x: Row) =>
            this.filter(x),
          ),
        );
        continue;
      }
      if (key.includes("_") && !key.startsWith("$")) {
        Object.assign(output, await this.filter(value));
        continue;
      }
      const rel = relation[this.model]?.[key];
      if (rel) {
        const [target, local, foreign] = rel;
        const rows = await this.store[target].findMany({ where: value });
        output[local] = { $in: rows.map((r) => r[foreign]) };
        continue;
      }
      if (
        value &&
        typeof value === "object" &&
        !(value instanceof Date) &&
        !(value instanceof Decimal128)
      ) {
        if ("contains" in value) {
          output[key] = {
            $regex: String(value.contains).replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            ),
            ...(value.mode === "insensitive" ? { $options: "i" } : {}),
          };
          continue;
        }
        const operators: Row = {};
        for (const [op, v] of Object.entries(value)) {
          const mapped: Row = {
            in: "$in",
            notIn: "$nin",
            gte: "$gte",
            gt: "$gt",
            lte: "$lte",
            lt: "$lt",
            not: "$ne",
            equals: "$eq",
          };
          if (!mapped[op]) throw new Error("Unsupported query operator: " + op);
          operators[mapped[op]] = v;
        }
        output[key] = operators;
      } else output[key] = value;
    }
    return output;
  }
  private async shape(row: Row, args: Row): Promise<Row> {
    row = unpack(row);
    const requested = { ...(args.include || {}), ...(args.select || {}) };
    for (const [key, options] of Object.entries(requested)) {
      if (!options) continue;
      if (key === "_count") {
        row._count = {};
        for (const name of Object.keys((options as Row).select || {})) {
          const r = relation[this.model]?.[name];
          if (r)
            row._count[name] = await this.store[r[0]].count({
              where: { [r[2]]: row[r[1]] },
            });
        }
        continue;
      }
      const rel = relation[this.model]?.[key];
      if (rel) {
        const [target, local, foreign, many] = rel;
        const opts = options === true ? {} : (options as Row);
        const query = {
          ...opts,
          where: {
            ...(opts.where || {}),
            [foreign]: row[local] ?? "__missing__",
          },
        };
        row[key] = many
          ? await this.store[target].findMany(query)
          : await this.store[target].findFirst(query);
      }
    }
    if (args.select)
      return Object.fromEntries(
        Object.entries(args.select)
          .filter(([, v]) => v)
          .map(([k]) => [k, row[k]]),
      );
    return row;
  }
  async findMany(args: Row = {}): Promise<Row[]> {
    const c = await this.native();
    const cursor = c.find(await this.filter(args.where), {
      session: this.store.session,
    });
    const order = args.orderBy;
    if (order) {
      const entries = (Array.isArray(order) ? order : [order]).flatMap(
        (o: Row) => Object.entries(o),
      );
      cursor.sort(
        Object.fromEntries([
          ...entries.map(([k, v]) => [k, v === "desc" ? -1 : 1]),
          ["_id", 1],
        ]) as any,
      );
    }
    if (args.skip) cursor.skip(args.skip);
    if (args.take) cursor.limit(args.take);
    const records = (await cursor.toArray()).map(unpack);
    if (this.store.session) records.forEach((r) => this.store.rememberReference(this.model, r));
    return Promise.all(records.map((r) => this.shape(r, args)));
  }
  async findFirst(args: Row = {}): Promise<Row | null> {
    return (await this.findMany({ ...args, take: 1 }))[0] || null;
  }
  async findUnique(args: Row): Promise<Row | null> {
    return this.findFirst(args);
  }
  async findUniqueOrThrow(args: Row): Promise<Row> {
    const r = await this.findFirst(args);
    if (!r) throw missing();
    return r;
  }
  async count(args: Row = {}): Promise<number> {
    return (await this.native()).countDocuments(await this.filter(args.where), {
      session: this.store.session,
    });
  }
  async create(args: Row): Promise<Row> {
    const data = {
      ...defaults[this.model],
      id: randomUUID(),
      createdAt: new Date(),
      ...args.data,
    };
    if (this.model === "khataPosition") data.updatedAt = new Date();
    await this.validateReferences(data);
    await (
      await this.native()
    ).insertOne(encodeRecord(this.model, data), {
      session: this.store.session,
    });
    this.store.rememberReference(this.model, data);
    return this.shape(encodeRecord(this.model, data), args);
  }
  async update(args: Row): Promise<Row> {
    if (immutable.has(this.model))
      throw new Error("Financial and audit records are append-only");
    const current = await this.findUniqueOrThrow({ where: args.where });
    const data = {
      ...args.data,
      ...(this.model === "khataPosition" ? { updatedAt: new Date() } : {}),
    };
    await this.validateReferences({ ...current, ...data });
    await (
      await this.native()
    ).updateOne(
      await this.filter(args.where),
      { $set: encodeRecord(this.model, data) },
      { session: this.store.session },
    );
    this.store.forgetReference(this.model, current);
    this.store.rememberReference(this.model, { ...current, ...data });
    return this.shape(encodeRecord(this.model, { ...current, ...data }), args);
  }
  async updateMany(args: Row): Promise<{ count: number }> {
    if (immutable.has(this.model)) throw new Error("Records are append-only");
    const rows = await this.findMany({ where: args.where });
    for (const r of rows)
      await this.update({ where: { id: r.id }, data: args.data });
    return { count: rows.length };
  }
  async upsert(args: Row): Promise<Row> {
    const existing = await this.findUnique({ where: args.where });
    return existing
      ? this.update({ ...args, where: { id: existing.id }, data: args.update })
      : this.create({ ...args, data: args.create });
  }
  async delete(args: Row): Promise<Row> {
    if (immutable.has(this.model)) throw new Error("Records are append-only");
    const row = await this.findUniqueOrThrow(args);
    await (
      await this.native()
    ).deleteOne({ id: row.id }, { session: this.store.session });
    this.store.forgetReference(this.model, row);
    return row;
  }
  async deleteMany(args: Row = {}): Promise<{ count: number }> {
    if (immutable.has(this.model)) throw new Error("Records are append-only");
    return {
      count: (
        await (
          await this.native()
        ).deleteMany(await this.filter(args.where), {
          session: this.store.session,
        })
      ).deletedCount,
    };
  }
  async aggregate(args: Row): Promise<Row> {
    const c = await this.native();
    const sum = Object.fromEntries(
      Object.keys(args._sum || {}).map((k) => [k, { $sum: "$" + k }]),
    );
    const [row] = await c
      .aggregate(
        [
          { $match: await this.filter(args.where) },
          { $group: { _id: null, ...sum } },
        ],
        { session: this.store.session },
      )
      .toArray();
    return {
      _sum: Object.fromEntries(
        Object.keys(sum).map((k) => [k, row ? unpack(row[k]) : null]),
      ),
    };
  }
  async groupBy(args: Row): Promise<Row[]> {
    const sum = Object.fromEntries(
      Object.keys(args._sum || {}).map((k) => [k, { $sum: "$" + k }]),
    );
    return (
      await (
        await this.native()
      )
        .aggregate(
          [
            { $match: await this.filter(args.where) },
            {
              $group: {
                _id: Object.fromEntries(
                  args.by.map((k: string) => [k, "$" + k]),
                ),
                ...sum,
              },
            },
          ],
          { session: this.store.session },
        )
        .toArray()
    ).map((r) => ({
      ...r._id,
      _sum: Object.fromEntries(Object.keys(sum).map((k) => [k, unpack(r[k])])),
    }));
  }
  private async validateReferences(row: Row) {
    const ref = (model: Model, key: "id" | "code", value: string) => this.store.reference(model, key, value);
    if (row.tenantId != null && !(await ref("tenant", "id", row.tenantId)))
      throw new Error("Invalid tenant reference");
    for (const [field, target] of [["branchId", "branch"], ["partyId", "customer"], ["roleId", "role"]] as [string, Model][]) {
      if (row[field] != null && !(this.model === "rolePermission" && field === "roleId")) {
        const parent = await ref(target, "id", row[field]);
        if (!parent || parent.tenantId !== row.tenantId)
          throw new Error("Cross-tenant reference blocked");
        if (field === "partyId" && parent.branchId !== row.branchId)
          throw new Error("Cross-workspace reference blocked");
      }
    }
    if (row.createdBy) {
      const user = await ref("user", "id", row.createdBy);
      if (!user || user.tenantId !== row.tenantId)
        throw new Error("Invalid financial author");
    }
    if (row.currencyCode && !(await ref("currency", "code", row.currencyCode)))
      throw new Error("Invalid currency");
    if (row.originalId) {
      const original = await ref(this.model, "id", row.originalId);
      if (!original || original.tenantId !== row.tenantId || original.branchId !== row.branchId)
        throw new Error("Invalid correction reference");
    }
    if (row.khataEntryId) {
      const entry = await ref("khataEntry", "id", row.khataEntryId);
      if (!entry || entry.tenantId !== row.tenantId || entry.branchId !== row.branchId)
        throw new Error("Invalid ledger transaction");
    }
    if (this.model === "authSession" && !(await ref("user", "id", row.userId)))
      throw new Error("Invalid session user");
    if (this.model === "rolePermission" &&
      (!(await ref("role", "id", row.roleId)) || !(await ref("permission", "id", row.permissionId))))
      throw new Error("Invalid permission grant");
  }
}
export interface MongoStore {
  tenant: Collection;
  plan: Collection;
  subscription: Collection;
  settings: Collection;
  branch: Collection;
  user: Collection;
  role: Collection;
  permission: Collection;
  rolePermission: Collection;
  authSession: Collection;
  customer: Collection;
  currency: Collection;
  khataPosition: Collection;
  khataStockEntry: Collection;
  khataEntry: Collection;
  khataCashEntry: Collection;
  auditEvent: Collection;
  idempotency: Collection;
}
export class MongoStore {
  client: MongoClient;
  database: Db;
  private ready?: Promise<void>;
  private readonly referenceCache = new Map<string, Row | null>();
  constructor(
    uri: string,
    public session?: ClientSession,
    client?: MongoClient,
  ) {
    this.client =
      client || new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    this.database = this.client.db();
    for (const m of models) (this as any)[m] = new Collection(this, m);
    if (client) this.ready = Promise.resolve();
  }
  async connect() {
    if (!this.ready)
      this.ready = this.client.connect().then(async () => {
        const hello = await this.database.admin().command({ hello: 1 });
        if (!hello.setName && !hello.msg?.includes("isdbgrid"))
          throw new Error(
            "MongoDB replica set is required for atomic financial transactions",
          );
      });
    await this.ready;
  }
  rememberReference(model: string, row: Row | null) {
    if (!this.session || !row) return;
    if (row.id) this.referenceCache.set(`${model}:id:${row.id}`, row);
    if (row.code) this.referenceCache.set(`${model}:code:${row.code}`, row);
    if (row.email) this.referenceCache.set(`${model}:email:${row.email}`, row);
  }
  async reference(model: Model, key: "id" | "code", value: string): Promise<Row | null> {
    const cacheKey = `${model}:${key}:${value}`;
    if (this.session && this.referenceCache.has(cacheKey)) return this.referenceCache.get(cacheKey)!;
    const row = await this[model].findUnique({ where: { [key]: value } });
    this.rememberReference(model, row);
    return row;
  }
  forgetReference(model: Model, row: Row) {
    if (row.id) this.referenceCache.delete(`${model}:id:${row.id}`);
    if (row.code) this.referenceCache.delete(`${model}:code:${row.code}`);
    if (row.email) this.referenceCache.delete(`${model}:email:${row.email}`);
  }
  async loadActor(id: string): Promise<Row | null> {
    await this.connect();
    const [row] = await this.database.collection("user").aggregate([
      { $match: { id } },
      { $lookup: { from: "role", localField: "roleId", foreignField: "id", as: "_role" } },
      { $set: { _role: { $first: "$_role" } } },
      { $lookup: { from: "rolePermission", localField: "_role.id", foreignField: "roleId", as: "_grants" } },
      { $lookup: { from: "permission", localField: "_grants.permissionId", foreignField: "id", as: "_permissions" } },
      {
        $project: {
          id: 1,
          tenantId: 1,
          branchId: 1,
          name: 1,
          email: 1,
          platformAdmin: 1,
          active: 1,
          mustChangePassword: 1,
          roleName: { $ifNull: ["$_role.name", "Platform admin"] },
          permissions: {
            $map: {
              input: "$_grants",
              as: "g",
              in: {
                $let: {
                  vars: {
                    permission: {
                      $first: {
                        $filter: {
                          input: "$_permissions",
                          as: "p",
                          cond: { $eq: ["$$p.id", "$$g.permissionId"] },
                        },
                      },
                    },
                  },
                  in: "$$permission.key",
                },
              },
            },
          },
        },
      },
    ], { session: this.session }).toArray();
    return row ? unpack(row) : null;
  }
  async loadAuthenticatedSession(tokenHash: string, now: Date): Promise<Row | null> {
    await this.connect();
    const [row] = await this.database.collection("authSession").aggregate([
      { $match: { tokenHash, expiresAt: { $gt: now } } },
      { $lookup: { from: "user", localField: "userId", foreignField: "id", as: "_user" } },
      { $set: { _user: { $first: "$_user" } } },
      { $lookup: { from: "role", localField: "_user.roleId", foreignField: "id", as: "_role" } },
      { $set: { _role: { $first: "$_role" } } },
      { $lookup: { from: "rolePermission", localField: "_role.id", foreignField: "roleId", as: "_grants" } },
      { $lookup: { from: "permission", localField: "_grants.permissionId", foreignField: "id", as: "_permissions" } },
      { $lookup: { from: "tenant", localField: "_user.tenantId", foreignField: "id", as: "_tenant" } },
      { $set: { _tenant: { $first: "$_tenant" } } },
      { $lookup: { from: "subscription", localField: "_tenant.id", foreignField: "tenantId", as: "_subscription" } },
      {
        $project: {
          sessionId: "$id",
          csrf: 1,
          id: "$_user.id",
          tenantId: "$_user.tenantId",
          branchId: "$_user.branchId",
          name: "$_user.name",
          email: "$_user.email",
          platformAdmin: "$_user.platformAdmin",
          active: "$_user.active",
          mustChangePassword: "$_user.mustChangePassword",
          roleName: { $ifNull: ["$_role.name", "Platform admin"] },
          permissions: {
            $map: {
              input: "$_grants",
              as: "g",
              in: {
                $let: {
                  vars: {
                    permission: {
                      $first: {
                        $filter: {
                          input: "$_permissions",
                          as: "p",
                          cond: { $eq: ["$$p.id", "$$g.permissionId"] },
                        },
                      },
                    },
                  },
                  in: "$$permission.key",
                },
              },
            },
          },
          tenantStatus: "$_tenant.status",
          subscription: { $first: "$_subscription" },
        },
      },
    ]).toArray();
    return row ? unpack(row) : null;
  }
  async tenantWithSubscription(id: string): Promise<Row | null> {
    await this.connect();
    const [row] = await this.database.collection("tenant").aggregate([
      { $match: { id } },
      { $lookup: { from: "subscription", localField: "id", foreignField: "tenantId", as: "_subscription" } },
      { $set: { subscription: { $first: "$_subscription" } } },
      { $unset: "_subscription" },
    ], { session: this.session }).toArray();
    return row ? unpack(row) : null;
  }
  async ping() {
    await this.connect();
    await this.database.command({ ping: 1 });
  }
  async lockTenant(id: string) {
    await this.connect();
    const r = await this.database
      .collection("tenant")
      .updateOne(
        { id },
        { $inc: { financeRevision: 1 } },
        { session: this.session },
      );
    if (!r.matchedCount) throw missing();
    this.rememberReference("tenant", { id });
  }
  async transaction<T>(
    fn: (tx: MongoStore) => Promise<T>,
    _options?: Row,
  ): Promise<T> {
    await this.connect();
    if (this.session) return fn(this);
    const s = this.client.startSession();
    try {
      return (await s.withTransaction(
        () => fn(new MongoStore("", s, this.client)),
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
          maxCommitTimeMS: 15000,
          timeoutMS: 30000,
        },
      )) as T;
    } finally {
      await s.endSession();
    }
  }
  async close() {
    await this.client.close();
  }
}
export async function initializeDatabase(store: MongoStore) {
  await store.connect();
  for (const m of models) {
    const required: Record<string, string[]> = {
      tenant: ["name", "status"],
      user: ["name", "email", "passwordHash", "active"],
      subscription: ["tenantId", "startsAt", "expiresAt"],
      customer: ["tenantId", "branchId", "name"],
      khataPosition: [
        "tenantId",
        "branchId",
        "currencyCode",
        "quantity",
        "cost",
      ],
      khataEntry: [
        "tenantId",
        "branchId",
        "partyId",
        "kind",
        "reference",
        "pkrDelta",
        "cashDelta",
        "realizedProfit",
      ],
      khataStockEntry: [
        "tenantId",
        "branchId",
        "currencyCode",
        "quantityDelta",
        "costDelta",
        "quantityAfter",
        "costAfter",
      ],
      khataCashEntry: ["tenantId", "branchId", "kind", "amountDelta"],
      idempotency: ["tenantId", "key", "hash", "result"],
    };
    const properties: Row = {
      id: { bsonType: "string" },
      createdAt: { bsonType: "date" },
    };
    for (const k of decimalFields[m] || [])
      properties[k] = {
        bsonType:
          m === "khataEntry" &&
          ["foreignAmount", "rate", "stockCost"].includes(k)
            ? ["decimal", "null"]
            : "decimal",
      };
    const schema = {
      $jsonSchema: {
        bsonType: "object",
        required: ["id", "createdAt", ...(required[m] || [])],
        properties,
      },
    };
    const validator =
      m === "khataPosition"
        ? {
            $and: [
              schema,
              {
                $expr: {
                  $and: [
                    { $gte: ["$quantity", Decimal128.fromString("0")] },
                    { $gte: ["$cost", Decimal128.fromString("0")] },
                    {
                      $or: [
                        {
                          $and: [
                            { $eq: ["$quantity", Decimal128.fromString("0")] },
                            { $eq: ["$cost", Decimal128.fromString("0")] },
                          ],
                        },
                        {
                          $and: [
                            { $gt: ["$quantity", Decimal128.fromString("0")] },
                            { $gt: ["$cost", Decimal128.fromString("0")] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          }
        : schema;
    if (!(await store.database.listCollections({ name: m }).toArray()).length)
      await store.database
        .createCollection(m, {
          validator,
          validationLevel: "strict",
          validationAction: "error",
        })
        .catch((e) => {
          if (e.code !== 48) throw e;
        });
    else
      await store.database.command({
        collMod: m,
        validator,
        validationLevel: "strict",
        validationAction: "error",
      });
    await store.database.collection(m).createIndex({ id: 1 }, { unique: true });
  }
  const unique: Partial<Record<Model, string[][]>> = {
    user: [["email"]],
    currency: [["code"]],
    plan: [["name"]],
    permission: [["key"]],
    subscription: [["tenantId"]],
    settings: [["tenantId"]],
    branch: [["tenantId", "name"]],
    role: [["tenantId", "name"]],
    rolePermission: [["roleId", "permissionId"]],
    authSession: [["tokenHash"]],
    customer: [["tenantId", "customerNo"]],
    khataPosition: [["branchId", "currencyCode"]],
    khataEntry: [["reference"], ["originalId"]],
    khataStockEntry: [["khataEntryId"], ["originalId"]],
    khataCashEntry: [["khataEntryId"], ["originalId"]],
    idempotency: [["tenantId", "key"]],
  };
  for (const [name, indexes] of Object.entries(unique))
    for (const fields of indexes!) {
      const nullable = ["originalId", "khataEntryId"].includes(fields[0]);
      await store.database
        .collection(name)
        .createIndex(Object.fromEntries(fields.map((f) => [f, 1])), {
          unique: true,
          ...(nullable
            ? { partialFilterExpression: { [fields[0]]: { $type: "string" } } }
            : {}),
        });
    }
  for (const m of [
    "customer",
    "khataEntry",
    "khataStockEntry",
    "khataCashEntry",
    "auditEvent",
  ])
    await store.database
      .collection(m)
      .createIndex({ tenantId: 1, branchId: 1, createdAt: 1, id: 1 });
  await store.database
    .collection("khataEntry")
    .createIndex({ tenantId: 1, partyId: 1, createdAt: 1 });
  await store.database.collection("idempotency").createIndex({ tenantId: 1, actorId: 1 });
  await store.database
    .collection("authSession")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
