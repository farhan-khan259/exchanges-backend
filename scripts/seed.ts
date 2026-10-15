import "dotenv/config";
import bcrypt from "bcryptjs";
import { db, check, seedRoles } from "../src/core.js";
check(
  process.env.ADMIN_EMAIL &&
    process.env.ADMIN_PASSWORD &&
    process.env.ADMIN_PASSWORD.length >= 12,
  "Set ADMIN_EMAIL and a unique ADMIN_PASSWORD (12+ characters) before seeding",
);
for (const [code, name, symbol] of [
  ["USD", "US Dollar", "$"],
  ["EUR", "Euro", "€"],
  ["GBP", "Pound Sterling", "£"],
  ["AED", "UAE Dirham", "د.إ"],
  ["SAR", "Saudi Riyal", "﷼"],
])
  await db.currency.upsert({
    where: { code },
    update: {},
    create: { code, name, symbol, precision: 2 },
  });
await db.plan.upsert({
  where: { name: "Standard" },
  update: {},
  create: { name: "Standard", branchLimit: 1, userLimit: 5, monthlyPrice: "0" },
});
const existing = await db.user.findUnique({
  where: { email: process.env.ADMIN_EMAIL.toLowerCase() },
});
if (!existing) {
  await db.user.create({
    data: {
      name: "Ahmed Solutions Admin",
      email: process.env.ADMIN_EMAIL.toLowerCase(),
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
      platformAdmin: true,
      mustChangePassword: true,
    },
  });
  console.log("Platform administrator created.");
} else console.log("Existing administrator preserved; password unchanged.");
if (process.env.LOCAL_OWNER_EMAIL && process.env.LOCAL_OWNER_PASSWORD) {
  check(
    process.env.LOCAL_OWNER_PASSWORD.length >= 12,
    "Local owner password must be 12+ characters",
  );
  const email = process.env.LOCAL_OWNER_EMAIL.toLowerCase();
  if (!(await db.user.findUnique({ where: { email } }))) {
    const passwordHash = await bcrypt.hash(
      process.env.LOCAL_OWNER_PASSWORD,
      12,
    );
    await db.transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name: process.env.LOCAL_COMPANY_NAME || "My Currency Business",
        },
      });
      await tx.subscription.create({
        data: {
          tenantId: t.id,
          plan: "Standard",
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 86400000),
          branchLimit: 1,
          userLimit: 5,
        },
      });
      await tx.settings.create({
        data: { tenantId: t.id, legalName: t.name, referencePrefix: "KH" },
      });
      await tx.branch.create({ data: { tenantId: t.id, name: "Workspace" } });
      await seedRoles(tx, t.id);
      const role = await tx.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: t.id, name: "Owner" } },
      });
      await tx.user.create({
        data: {
          tenantId: t.id,
          roleId: role.id,
          name: "Business Owner",
          email,
          passwordHash,
          mustChangePassword: true,
        },
      });
    });
    console.log("Local business owner created.");
  } else console.log("Existing business owner preserved.");
}
await db.close();
