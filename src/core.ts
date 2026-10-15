import "dotenv/config";
import { MongoStore } from "./database.js";
import { Decimal } from "decimal.js";
import { createHash, randomBytes } from "node:crypto";
export let db = new MongoStore(
  process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27018/khata_os?replicaSet=rs0&directConnection=true",
);
export function setTestDatabase(client: MongoStore) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Test database injection requires NODE_ENV=test");
  db = client;
}
export const D = (v: Decimal.Value) => new Decimal(v);
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const money = (v: Decimal.Value) => D(v).toDecimalPlaces(2).toFixed(2);
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function check(v: unknown, message: string, status = 400): asserts v {
  if (!v) throw new Fault(status, message);
}
export type Tx = MongoStore;
export type Actor = {
  id: string;
  tenantId: string | null;
  branchId: string | null;
  name: string;
  email: string;
  platformAdmin: boolean;
  mustChangePassword: boolean;
  permissions: string[];
  roleName: string;
  offlineAt?: Date;
  offlineKey?: string;
};
export const permissions = [
  "operations.read",
  "transaction.create",
  "reversal.request",
  "customer.write",
  "settings.write",
  "report.read",
  "audit.read",
];
export const roleDefaults: Record<string, string[]> = {
  Owner: permissions,
  Manager: permissions.filter((p) => p !== "settings.write"),
  Cashier: [
    "operations.read",
    "transaction.create",
    "reversal.request",
    "customer.write",
  ],
  Auditor: ["operations.read", "report.read", "audit.read"],
};
export async function actorFor(
  client: Tx | MongoStore,
  id: string,
): Promise<Actor> {
  const u = await client.loadActor(id);
  check(u?.active, "Account unavailable", 401);
  client.rememberReference("user", {
    id: u.id,
    tenantId: u.tenantId,
    branchId: u.branchId,
    roleId: u.roleId,
  });
  return {
    id: u.id,
    tenantId: u.tenantId,
    branchId: u.branchId,
    name: u.name,
    email: u.email,
    platformAdmin: u.platformAdmin,
    mustChangePassword: u.mustChangePassword,
    permissions: u.permissions || [],
    roleName: u.roleName || "Platform admin",
  };
}
export function permit(a: Actor, key: string) {
  check(
    !a.platformAdmin && a.tenantId && a.permissions.includes(key),
    "Permission denied",
    403,
  );
}
export function scope(a: Actor, branchId?: string) {
  check(a.tenantId, "Exchange account required", 403);
  if (branchId && a.branchId)
    check(branchId === a.branchId, "Branch access denied", 403);
  return {
    tenantId: a.tenantId,
    ...(a.branchId ? { branchId: a.branchId } : branchId ? { branchId } : {}),
  };
}
export async function branch(tx: Tx, a: Actor, id: string) {
  scope(a, id);
  const b = await tx.branch.findFirst({
    where: { id, tenantId: a.tenantId!, active: true },
  });
  check(b, "Branch unavailable", 404);
  return b;
}
export async function audit(
  tx: Tx,
  a: Actor,
  action: string,
  entityType: string,
  entityId: string,
  metadata: unknown = {},
  branchId?: string,
) {
  return tx.auditEvent.create({
    data: {
      tenantId: a.tenantId,
      branchId: branchId || a.branchId,
      actorId: a.id,
      action,
      entityType,
      entityId,
      metadata: JSON.parse(JSON.stringify(a.offlineAt ? { ...(metadata as any), offlineOccurredAt: a.offlineAt.toISOString() } : metadata)),
    },
  });
}
export async function liveTenant(tx: Tx, a: Actor) {
  check(a.tenantId, "Tenant required", 403);
  const t = await tx.tenantWithSubscription(a.tenantId);
  const s = t?.subscription;
  check(
    t?.status === "ACTIVE" &&
      s?.status === "ACTIVE" &&
      s.startsAt <= new Date() &&
      s.expiresAt > new Date(),
    "Subscription inactive or expired",
    403,
  );
  return t!;
}
export async function atomic<T>(
  a: Actor,
  permission: string,
  fn: (tx: Tx, fresh: Actor) => Promise<T>,
): Promise<T> {
  check(a.tenantId, "Tenant required", 403);
  return db.transaction(
    async (tx) => {
      await tx.lockTenant(a.tenantId!);
      const fresh = await actorFor(tx, a.id);
      permit(fresh, permission);
      check(
        !fresh.mustChangePassword,
        "Change your temporary password first",
        403,
      );
      await liveTenant(tx, fresh);
      return fn(tx, fresh);
    },
    { maxWait: 15000, timeout: 20000 },
  );
}
export async function seedRoles(tx: Tx, tenantId: string) {
  for (const [name, keys] of Object.entries(roleDefaults)) {
    const r = await tx.role.create({ data: { tenantId, name } });
    for (const key of keys) {
      const p = await tx.permission.upsert({
        where: { key },
        update: {},
        create: { key },
      });
      await tx.rolePermission.create({
        data: { roleId: r.id, permissionId: p.id },
      });
    }
  }
}
