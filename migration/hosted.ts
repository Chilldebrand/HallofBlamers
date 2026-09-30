import { Client } from "pg";
import { applyMigrations } from "./apply";
import { importInto } from "./import-sqlite";
import { reconcileInto } from "./reconcile";

// This deployment tool deliberately refuses the DWS project or an unexpected host.
const project = "aridozcvdxlfnibcnejf";
async function main() {
  if (process.env.PGUSER !== `postgres.${project}` || process.env.PGHOST !== "aws-0-ca-central-1.pooler.supabase.com") throw new Error("Connection must target the verified HallofBlamers project");
  if (!process.env.PGPASSWORD) throw new Error("The local database password has not been configured");
  const mode = process.argv[2] ?? "check";
  if (!["check", "migrate", "import", "reconcile"].includes(mode)) throw new Error("Use check, migrate, import, or reconcile");
  const client = new Client({ ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    if (mode === "check") {
      const result = await client.query("select current_database() as database, pg_database_size(current_database())::text as bytes");
      console.log(JSON.stringify({ project, connected: true, ...result.rows[0] }));
    } else if (mode === "migrate") {
      console.log(JSON.stringify({ applied: await applyMigrations(client, "supabase/migrations") }));
    } else {
      const source = process.argv[3];
      if (!source) throw new Error("A consistent SQLite backup path is required");
      if (mode === "import") console.log(JSON.stringify(await importInto(source, client, { dryRun: !process.argv.includes("--apply") })));
      else console.log(JSON.stringify(await reconcileInto(source, client)));
    }
  } finally { await client.end(); }
}
main().catch((error: unknown) => {
  // Do not print driver details, SQL parameters, passwords, or row contents.
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "CONFIG_OR_MIGRATION";
  console.error(`Hosted operation failed (${code}). No credentials or private rows are logged.`);
  process.exitCode = 1;
});
