import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { generateSchema } from "../../migration/postgres-schema";
let db: PGlite;
const user = "00000000-0000-4000-8000-000000000002";
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;`);
  await db.exec(generateSchema());
  await db.exec(readFileSync("supabase/migrations/202609290002_auth.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/202609290003_reads.sql", "utf8"));
  await db.exec(`INSERT INTO hob_private.managers(id,name,role,invite_token) VALUES(2,'Member','manager','never-expose-me');
    INSERT INTO hob_private.memberships(auth_user_id,manager_id) VALUES('${user}',2);
    INSERT INTO hob_private.leagues(id,espn_league_id,name,first_season) VALUES(1,1690915927,'Fixture',2025);
    INSERT INTO hob_private.seasons VALUES(2025,1,'{}','{}','{}',12,14,'complete');`);
},30000);
afterEach(async()=>{await db?.close();});
async function login() {await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]); await db.exec("SET ROLE authenticated");}
test("authenticated league reads expose only the page data and safe shell fields", async()=>{
  await login();
  const result = await db.query<{data: {seasonOptions: unknown[]; teamSeasons: unknown[]}}>("select public.hob_standings_source(2025) as data");
  expect(result.rows[0].data.seasonOptions).toEqual([{season:2025,status:"complete"}]);
  expect(result.rows[0].data.teamSeasons).toEqual([]);
  const shell = await db.query("select public.hob_shell() as data");
  expect(JSON.stringify(shell.rows)).not.toContain("never-expose-me");
  expect(JSON.stringify(shell.rows)).not.toContain("invite_token");
});
test("uninvited and revoked sessions cannot retrieve standings",async()=>{
  await db.exec("SET ROLE anon");
  await expect(db.query("select public.hob_standings_source(null)")).rejects.toThrow();
  await db.exec("RESET ROLE; UPDATE hob_private.memberships SET revoked_at=now()");
  await login();
  await expect(db.query("select public.hob_standings_source(null)")).rejects.toThrow();
});
