import { Router } from "express";
import { db, permit, scope, check } from "./core.js";
export const sync = Router();
sync.use((req, _res, next) => {
  const target = req.headers["x-offline-account"];
  if (target || req.headers["x-offline-created-at"]) check(target === `${req.actor.tenantId}:${req.actor.id}`, "Offline entries belong to a different account", 403);
  next();
});
// Consistent, branch-scoped read snapshot. No passwords, sessions or other tenants.
sync.get("/sync/snapshot", async (req, res) => {
  permit(req.actor, "operations.read");
  const result = await db.transaction(async (tx) => {
    const s = scope(req.actor);
    const rows: Record<string, any[]> = {};
    for (const name of ["branch", "customer", "khataPosition", "khataEntry", "khataStockEntry", "khataCashEntry"] as const)
      rows[name] = await tx[name].findMany({ where: name === "branch" ? { tenantId: s.tenantId, ...(req.actor.branchId ? { id: req.actor.branchId } : {}) } : s });
    rows.auditEvent = req.actor.permissions.includes("audit.read") ? await tx.auditEvent.findMany({ where: s }) : [];
    rows.settings = await tx.settings.findMany({ where: { tenantId: s.tenantId } });
    rows.currency = await tx.currency.findMany({ where: { active: true } });
    const tenant = await tx.tenantWithSubscription(s.tenantId);
    rows.tenant = [{ id: tenant!.id, name: tenant!.name, status: tenant!.status }];
    rows.subscription = [tenant!.subscription];
    const completed = await tx.idempotency.findMany({ where: { tenantId: s.tenantId, actorId: req.actor.id } });
    const completedOperations = completed.map(o => ({ key: o.key, id: o.result?.id, partyId: o.result?.partyId, khataEntryId: o.result?.khataEntryId }));
    const expiresAt = new Date(Math.min(Date.now() + 7 * 86400000, tenant!.subscription.expiresAt.getTime())).toISOString();
    return { schema: 1, tenantId: s.tenantId, userId: req.actor.id, branchId: req.actor.branchId, actor: req.actor, savedAt: new Date().toISOString(), offlineUntil: expiresAt, completedOperations, rows };
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(result);
});
