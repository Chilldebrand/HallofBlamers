import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { generateSchema } from "../../migration/postgres-schema";

let db: PGlite;
const commissioner = "00000000-0000-4000-8000-000000000001";
const member = "00000000-0000-4000-8000-000000000002";
async function login(id: string | null) {
  await db.exec("RESET ROLE");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.exec(id ? "SET ROLE authenticated" : "SET ROLE anon");
}
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;`);
  await db.exec(generateSchema());
  await db.exec(readFileSync("supabase/migrations/202609290002_auth.sql", "utf8"));
  await db.exec(`INSERT INTO hob_private.managers(id,name,role,invite_token) VALUES (1,'Commissioner','commissioner','legacy-1'),(2,'Member','manager','legacy-2');
    INSERT INTO hob_private.memberships(auth_user_id,manager_id) VALUES ('${commissioner}',1);`);
}, 30000);
afterEach(async () => { await db?.close(); });

test("anonymous and uninvited users cannot read private source data or create invites", async () => {
  await login(null);
  await expect(db.query("select * from hob_private.managers")).rejects.toThrow();
  expect((await db.query("select public.hob_viewer() as viewer")).rows).toEqual([{ viewer: null }]);
  await login(member);
  expect((await db.query("select public.hob_viewer() as viewer")).rows).toEqual([{ viewer: null }]);
  await expect(db.query("select public.hob_create_invite(2)")).rejects.toThrow();
});

test("invite redemption grants one manager identity and rejects replay", async () => {
  await login(commissioner);
  const created = await db.query<{ token: string }>("select public.hob_create_invite(2) as token");
  const token = created.rows[0].token;
  await login(member);
  const result = await db.query("select public.hob_redeem_invite($1) as viewer", [token]);
  expect(result.rows).toEqual([{ viewer: { authUserId: member, managerId: 2, role: "member" } }]);
  await expect(db.query("select public.hob_redeem_invite($1)", [token])).rejects.toThrow();
  await expect(db.query("select * from hob_private.snapshots")).rejects.toThrow();
});

test("expired invites fail and revocation takes effect despite a still-valid JWT", async () => {
  await login(commissioner);
  const { rows } = await db.query<{ token: string }>("select public.hob_create_invite(2) as token");
  await db.exec("RESET ROLE; UPDATE hob_private.invites SET expires_at=now()-interval '1 second'");
  await login(member);
  await expect(db.query("select public.hob_redeem_invite($1)", [rows[0].token])).rejects.toThrow();
  await db.exec(`RESET ROLE; INSERT INTO hob_private.memberships(auth_user_id,manager_id) VALUES ('${member}',2)`);
  await login(commissioner);
  await db.query("select public.hob_revoke_member(2)");
  await login(member);
  expect((await db.query("select public.hob_viewer() as viewer")).rows).toEqual([{ viewer: null }]);
});

test("member cannot revoke others and commissioner cannot remove their own access", async () => {
  await db.exec(`INSERT INTO hob_private.memberships(auth_user_id,manager_id) VALUES ('${member}',2)`);
  await login(member);
  await expect(db.query("select public.hob_revoke_member(1)")).rejects.toThrow();
  await login(commissioner);
  await expect(db.query("select public.hob_revoke_member(1)")).rejects.toThrow();
});
