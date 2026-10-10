import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import { MongoServerError } from "mongodb";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, Fault, check } from "./core.js";
import { auth, authenticate, originGuard } from "./auth.js";
import { admin } from "./admin.js";
import { api } from "./khata.js";
import { sync } from "./sync.js";
export const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);
app.use(express.json({ limit: "250kb" }));
app.use(cookieParser());
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use("/api", originGuard);
app.get("/api/health", async (_req, res) => {
  await db.ping();
  res.json({ ok: true });
});
app.use("/api/auth", auth);
app.use("/api", authenticate);
app.use("/api/admin", admin);
app.use("/api", sync);
app.use("/api", api);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint unavailable" }),
);
app.use(express.static(path.resolve("../frontend/dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.resolve("../frontend/dist/index.html")),
);
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
      return;
    }
    if (err instanceof Fault || err.status === 404) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof MongoServerError) {
      if (err.code === 11000) {
        res
          .status(409)
          .json({ error: "A record with these details already exists" });
        return;
      }
      if (err.code === -1) {
        res.status(404).json({ error: "Record unavailable" });
        return;
      }
    }
    console.error(
      JSON.stringify({
        level: "error",
        code: err.code || err.name || "INTERNAL",
      }),
    );
    res.status(500).json({
      error: "Operation failed. No partial financial changes were saved.",
    });
  },
);
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  check(process.env.APP_ORIGIN, "APP_ORIGIN is required");
  if (process.env.NODE_ENV === "production") {
    check(process.env.MONGODB_URI, "MONGODB_URI is required in production");
    check(
      process.env.APP_ORIGIN.startsWith("https://"),
      "Production requires HTTPS",
    );
  }
  await db.connect();
  const server = app.listen(Number(process.env.PORT) || 4001, "0.0.0.0", () =>
    console.log("Khata OS API ready"),
  );
  process.on("SIGTERM", () => server.close(() => void db.close()));
}
