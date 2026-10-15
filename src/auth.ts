import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  db,
  check,
  hash,
  token,
  actorFor,
  liveTenant,
  audit,
  type Actor,
} from "./core.js";
declare global {
  namespace Express {
    interface Request {
      actor: Actor;
      authSession: { id: string; csrf: string };
    }
  }
}
export const auth = Router();
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const cookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: 8 * 60 * 60 * 1000,
};
export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    check(
      req.headers.origin === process.env.APP_ORIGIN,
      "Invalid request origin",
      403,
    );
  }
  next();
}
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const t = req.cookies.exchange_session;
  check(t, "Please sign in", 401);
  const s = await db.loadAuthenticatedSession(hash(t), new Date());
  check(s && s.active, "Session expired", 401);
  req.actor = {
    id: s.id,
    tenantId: s.tenantId,
    branchId: s.branchId,
    name: s.name,
    email: s.email,
    platformAdmin: s.platformAdmin,
    mustChangePassword: s.mustChangePassword,
    permissions: s.permissions || [],
    roleName: s.roleName || "Platform admin",
  };
  req.authSession = { id: s.sessionId, csrf: s.csrf };
  if (!req.actor.platformAdmin) {
    const subscription = s.subscription;
    check(
      s.tenantStatus === "ACTIVE" &&
        subscription?.status === "ACTIVE" &&
        subscription.startsAt <= new Date() &&
        subscription.expiresAt > new Date(),
      "Subscription inactive or expired",
      403,
    );
  }
  if (!["GET", "HEAD"].includes(req.method))
    check(
      req.headers["x-csrf-token"] === s.csrf,
      "Invalid security token",
      403,
    );
  next();
}
auth.post("/login", loginLimit, async (req, res) => {
  const { email, password } = z
    .object({ email: z.string().email(), password: z.string().min(1).max(128) })
    .parse(req.body);
  const u = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  const valid = await bcrypt.compare(
    password,
    u?.passwordHash ||
      "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5GdI7tw.UHAnZoPJ.eHTKO.CCwHWXAO",
  );
  check(u?.active && valid, "Invalid credentials", 401);
  const a = await actorFor(db, u.id);
  if (!a.platformAdmin) await liveTenant(db as any, a);
  const raw = token(),
    csrf = token();
  await db.transaction(async (tx) => {
    if (u.tenantId) await tx.lockTenant(u.tenantId);
    const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
    check(
      current.active && current.passwordHash === u.passwordHash,
      "Account access changed. Sign in again.",
      401,
    );
    if (!a.platformAdmin) await liveTenant(tx, a);
    await tx.authSession.create({
      data: {
        userId: u.id,
        tokenHash: hash(raw),
        csrf,
        expiresAt: new Date(Date.now() + cookie.maxAge),
      },
    });
    await audit(tx, a, "LOGIN", "User", u.id);
  });
  res.cookie("exchange_session", raw, cookie).json({ user: a, csrf });
});
auth.get("/me", authenticate, (req, res) =>
  res.json({ user: req.actor, csrf: req.authSession.csrf }),
);
auth.post("/logout", authenticate, async (req, res) => {
  await db.authSession.delete({ where: { id: req.authSession.id } });
  res.clearCookie("exchange_session", cookie).json({ ok: true });
});
auth.post("/change-password", authenticate, async (req, res) => {
  const v = z
    .object({
      currentPassword: z.string(),
      password: z.string().min(12).max(128),
    })
    .parse(req.body);
  const u = await db.user.findUniqueOrThrow({ where: { id: req.actor.id } });
  check(
    await bcrypt.compare(v.currentPassword, u.passwordHash),
    "Current password is incorrect",
  );
  await db.transaction(async (tx) => {
    if (u.tenantId) await tx.lockTenant(u.tenantId);
    await tx.user.update({
      where: { id: u.id },
      data: {
        passwordHash: await bcrypt.hash(v.password, 12),
        mustChangePassword: false,
      },
    });
    await tx.authSession.deleteMany({
      where: { userId: u.id, id: { not: req.authSession.id } },
    });
    await audit(tx, req.actor, "PASSWORD_CHANGED", "User", u.id);
  });
  res.json({ ok: true });
});
