import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db, check, audit, seedRoles, token, roleDefaults } from "./core.js";
export const admin = Router();
admin.use((req, _res, next) => {
  check(req.actor.platformAdmin, "Platform administrator required", 403);
  if (req.method !== "GET")
    check(
      !req.actor.mustChangePassword,
      "Change your temporary password first",
      403,
    );
  next();
});
admin.get("/companies", async (_req, res) =>
  res.json(
    await db.tenant.findMany({
      include: {
        subscription: true,
        _count: { select: { branches: true, users: true, transactions: true } },
        users: {
          where: { role: { name: "Owner" } },
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ),
);
const sub = z
  .object({
    plan: z.string().min(1),
    startsAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    branchLimit: z.number().int().min(1).max(1000),
    userLimit: z.number().int().min(1).max(10000),
  })
  .refine((v) => v.expiresAt > v.startsAt, "Expiry must follow start");
admin.post("/companies", async (req, res) => {
  const v = z
    .object({
      name: z.string().min(2).max(100),
      ownerName: z.string().min(2),
      ownerEmail: z.string().email(),
      subscription: sub,
    })
    .parse(req.body);
  const password = token().slice(0, 24);
  const company = await db.transaction(async (tx) => {
    const t = await tx.tenant.create({ data: { name: v.name } });
    await tx.subscription.create({
      data: { tenantId: t.id, ...v.subscription },
    });
    await tx.settings.create({
      data: { tenantId: t.id, legalName: v.name, referencePrefix: "KH" },
    });
    const b = await tx.branch.create({
      data: { tenantId: t.id, name: "Workspace" },
    });
    await seedRoles(tx, t.id);
    const role = await tx.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: t.id, name: "Owner" } },
    });
    await tx.user.create({
      data: {
        tenantId: t.id,
        roleId: role.id,
        name: v.ownerName,
        email: v.ownerEmail.toLowerCase(),
        passwordHash: await bcrypt.hash(password, 12),
      },
    });
    await audit(tx, req.actor, "CREATE_COMPANY", "Tenant", t.id, {
      name: v.name,
      branch: b.id,
    });
    return t;
  });
  res.status(201).json({
    company,
    credentials: {
      email: v.ownerEmail.toLowerCase(),
      temporaryPassword: password,
    },
  });
});
admin.patch("/companies/:id", async (req, res) => {
  const v = z
    .object({ status: z.enum(["ACTIVE", "SUSPENDED"]), subscription: sub })
    .parse(req.body);
  const id = String(req.params.id);
  res.json(
    await db.transaction(async (tx) => {
      await tx.lockTenant(id);
      const old = await tx.tenant.findUniqueOrThrow({
        where: { id },
        include: { subscription: true },
      });
      const t = await tx.tenant.update({
        where: { id },
        data: { status: v.status },
      });
      await tx.subscription.update({
        where: { tenantId: id },
        data: v.subscription,
      });
      if (v.status === "SUSPENDED")
        await tx.authSession.deleteMany({ where: { user: { tenantId: id } } });
      await audit(tx, req.actor, "UPDATE_COMPANY", "Tenant", id, {
        before: old,
        after: v,
      });
      return t;
    }),
  );
});
admin.post("/users/:id/reset", async (req, res) => {
  const id = String(req.params.id),
    password = token().slice(0, 24);
  await db.transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id } });
    check(!u.platformAdmin, "Use the platform recovery runbook");
    await tx.lockTenant(u.tenantId);
    await tx.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        mustChangePassword: true,
      },
    });
    await tx.authSession.deleteMany({ where: { userId: id } });
    await audit(tx, req.actor, "RESET_ACCESS", "User", id);
  });
  res.json({ temporaryPassword: password });
});
admin.get("/plans", async (_req, res) =>
  res.json(await db.plan.findMany({ orderBy: { name: "asc" } })),
);
admin.post("/plans", async (req, res) => {
  const v = z
    .object({
      name: z.string().min(1),
      branchLimit: z.number().int().positive(),
      userLimit: z.number().int().positive(),
      monthlyPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
    })
    .parse(req.body);
  res.json(
    await db.transaction(async (tx) => {
      const p = await tx.plan.upsert({
        where: { name: v.name },
        update: v,
        create: v,
      });
      await audit(tx, req.actor, "SAVE_PLAN", "Plan", p.id, v);
      return p;
    }),
  );
});

admin.patch("/companies/:id/access", async (req, res) => {
  const id = String(req.params.id),
    v = z
      .object({
        status: z.enum(["ACTIVE", "SUSPENDED"]),
        reason: z.string().trim().min(3).max(300),
      })
      .parse(req.body);
  res.json(
    await db.transaction(async (tx) => {
      await tx.lockTenant(id);
      const before = await tx.tenant.findUniqueOrThrow({ where: { id } });
      const result = await tx.tenant.update({
        where: { id },
        data: { status: v.status },
      });
      if (v.status === "SUSPENDED")
        await tx.authSession.deleteMany({ where: { user: { tenantId: id } } });
      await audit(tx, req.actor, "COMPANY_ACCESS_CHANGED", "Tenant", id, {
        before: before.status,
        after: v.status,
        reason: v.reason,
      });
      return result;
    }),
  );
});
admin.get("/companies/:id/users", async (req, res) => {
  const tenantId = String(req.params.id);
  const company = await db.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { subscription: true },
  });
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(1)
    .parse(req.query.page);
  const search = z.string().max(100).default("").parse(req.query.search);
  const where = {
    tenantId,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const rows = await db.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      active: true,
      mustChangePassword: true,
      createdAt: true,
      role: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 20,
    take: 20,
  });
  res.json({
    company,
    rows,
    total: await db.user.count({ where }),
    page,
    roles: Object.keys(roleDefaults),
    activeUsers: await db.user.count({ where: { tenantId, active: true } }),
  });
});
admin.post("/companies/:id/users", async (req, res) => {
  const tenantId = String(req.params.id),
    v = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z.string().trim().email().max(254),
        role: z.enum(["Owner", "Manager", "Cashier", "Auditor"]),
      })
      .parse(req.body);
  const password = token().slice(0, 24),
    passwordHash = await bcrypt.hash(password, 12);
  const user = await db.transaction(async (tx) => {
    await tx.lockTenant(tenantId);
    const company = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { subscription: true },
    });
    check(company.subscription, "Subscription unavailable");
    check(
      (await tx.user.count({ where: { tenantId, active: true } })) <
        company.subscription.userLimit,
      "User limit reached. Increase the subscription limit first.",
      409,
    );
    const role = await tx.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: v.role } },
    });
    const branch = await tx.branch.findFirst({
      where: { tenantId, active: true },
      orderBy: { createdAt: "asc" },
    });
    check(branch, "Workspace unavailable", 404);
    const u = await tx.user.create({
      data: {
        tenantId,
        branchId: v.role === "Owner" ? null : branch.id,
        roleId: role.id,
        name: v.name,
        email: v.email.toLowerCase(),
        passwordHash,
        mustChangePassword: true,
      },
      select: { id: true, name: true, email: true, active: true },
    });
    await audit(tx, req.actor, "USER_PROVISIONED", "User", u.id, {
      tenantId,
      role: v.role,
    });
    return u;
  });
  res
    .status(201)
    .json({
      user,
      credentials: { email: user.email, temporaryPassword: password },
    });
});
admin.patch("/companies/:companyId/users/:id/access", async (req, res) => {
  const tenantId = String(req.params.companyId),
    id = String(req.params.id),
    v = z
      .object({
        active: z.boolean(),
        reason: z.string().trim().min(3).max(300),
      })
      .parse(req.body);
  res.json(
    await db.transaction(async (tx) => {
      await tx.lockTenant(tenantId);
      const u = await tx.user.findFirst({
        where: { id, tenantId, platformAdmin: false },
        include: { role: true },
      });
      check(u, "User unavailable", 404);
      if (v.active && !u.active) {
        const subscription = await tx.subscription.findUniqueOrThrow({
          where: { tenantId },
        });
        check(
          (await tx.user.count({ where: { tenantId, active: true } })) <
            subscription.userLimit,
          "User limit reached",
          409,
        );
      }
      const result = await tx.user.update({
        where: { id },
        data: { active: v.active },
        select: { id: true, name: true, email: true, active: true },
      });
      if (!v.active) await tx.authSession.deleteMany({ where: { userId: id } });
      await audit(tx, req.actor, "USER_ACCESS_CHANGED", "User", id, {
        tenantId,
        before: u.active,
        after: v.active,
        reason: v.reason,
      });
      return result;
    }),
  );
});
admin.get("/activity", async (req, res) => {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(1)
    .parse(req.query.page);
  const where = { actorId: req.actor.id };
  res.json({
    rows: await db.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 20,
      take: 20,
    }),
    total: await db.auditEvent.count({ where }),
    page,
  });
});
