import { spawn } from "node:child_process";
import { MongoMemoryReplSet } from "mongodb-memory-server";
let replica;
const env = {
  ...process.env,
  NODE_ENV: "test",
  APP_ORIGIN: "http://localhost:5174",
};
try {
  if (!env.TEST_MONGODB_URI) {
    replica = await MongoMemoryReplSet.create({
      binary: { version: "7.0.14" },
      replSet: {
        count: 1,
        storageEngine: "wiredTiger",
        args: ["--nounixsocket"],
      },
    });
    env.TEST_MONGODB_URI = replica.getUri("khata_test");
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "tests/accounting.test.ts",
      "tests/print.test.ts",
      "tests/integration.test.ts",
      "tests/database.test.ts",
      "tests/import.test.ts",
      "tests/frontend.test.ts",
      "tests/offline.test.ts",
    ],
    { stdio: "inherit", env },
  );
  process.exitCode = await new Promise((resolve) =>
    child.on("exit", (code) => resolve(code ?? 1)),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (replica) await replica.stop();
}
