import {
  MongoStore,
  models,
  initializeDatabase,
  encodeRecord,
  type Row,
} from "./database.js";
export async function importLegacy(store: MongoStore, payload: any) {
  if (payload?.format !== "khata-os-postgres-v1" || !payload.collections)
    throw new Error("Unsupported export format");
  for (const name of models) {
    if (name === "authSession") continue;
    if (!Array.isArray(payload.collections[name]))
      throw new Error("Missing exported collection: " + name);
  }
  await store.connect();
  for (const name of (await store.database.listCollections().toArray()).map(
    (c) => c.name,
  ))
    if (
      !name.startsWith("system.") &&
      (await store.database.collection(name).countDocuments())
    )
      throw new Error(
        "Import requires a completely empty destination database. Use a new MongoDB database name; existing records will not be overwritten.",
      );
  const data = payload.collections as Record<string, Row[]>;
  for (const records of Object.values(data))
    for (const r of records) {
      if (!r.id || (!r.createdAt && !r.updatedAt))
        throw new Error("Invalid exported record");
    }
  const find = (m: string, id: string) => data[m]?.find((x) => x.id === id);
  for (const m of models) {
    if (m === "authSession") continue;
    for (const r of data[m]) {
      if (r.tenantId && !find("tenant", r.tenantId))
        throw new Error("Missing tenant reference");
      for (const [key, target] of [
        ["branchId", "branch"],
        ["partyId", "customer"],
        ["roleId", "role"],
      ]) {
        if (r[key]) {
          const parent = find(target, r[key]);
          if (
            !parent ||
            (key !== "roleId" && parent.tenantId !== r.tenantId) ||
            (key === "roleId" && m === "user" && parent.tenantId !== r.tenantId)
          )
            throw new Error("Invalid scoped reference in import");
        }
      }
      if (r.partyId && find("customer", r.partyId)?.branchId !== r.branchId)
        throw new Error("Invalid customer workspace");
      if (m === "rolePermission" && !find("permission", r.permissionId))
        throw new Error("Invalid permission reference");
      if (
        r.currencyCode &&
        !data.currency.some((c) => c.code === r.currencyCode)
      )
        throw new Error("Invalid currency reference");
      if (
        r.createdBy &&
        (!find("user", r.createdBy) ||
          find("user", r.createdBy)?.tenantId !== r.tenantId)
      )
        throw new Error("Invalid ledger author");
      if (r.originalId) {
        const original = find(m, r.originalId);
        if (
          !original ||
          original.tenantId !== r.tenantId ||
          original.branchId !== r.branchId
        )
          throw new Error("Invalid reversal reference");
      }
      if (r.khataEntryId) {
        const parent = find("khataEntry", r.khataEntryId);
        if (
          !parent ||
          parent.tenantId !== r.tenantId ||
          parent.branchId !== r.branchId
        )
          throw new Error("Invalid ledger reference");
      }
    }
  }
  await initializeDatabase(store);
  await store.transaction(async (tx) => {
    for (const m of models) {
      if (m === "authSession") continue;
      const rows = data[m].map((r) => {
        const clean = { ...r };
        if (m === "settings") {
          delete clean.requireReviewedKyc;
          delete clean.largeThreshold;
        }
        if (m === "customer") {
          delete clean.reviewStatus;
          delete clean.tags;
        }
        if (m === "branch") delete clean.cash;
        return encodeRecord(m, {
          ...clean,
          createdAt: clean.createdAt || clean.updatedAt,
        });
      });
      if (rows.length)
        await tx.database
          .collection(m)
          .insertMany(rows, { session: tx.session });
    }
  });
  return Object.fromEntries(
    models.filter((m) => m !== "authSession").map((m) => [m, data[m].length]),
  );
}
