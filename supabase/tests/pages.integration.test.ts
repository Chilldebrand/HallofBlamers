import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,beforeEach,expect,test } from 'vitest';
import { generateSchema } from '../../migration/postgres-schema';
let db:PGlite;
const member='00000000-0000-4000-8000-000000000002';
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;`);
 await db.exec(generateSchema());
 for(const file of ['202609290002_auth.sql','202609290003_reads.sql','202609300003_pages.sql','202609300004_page_mutations.sql','202609300005_recap_versions.sql']) await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 await db.exec(`INSERT INTO hob_private.managers(id,name,role,invite_token) VALUES(2,'Member','manager','private-token');
 INSERT INTO hob_private.memberships(auth_user_id,manager_id) VALUES('${member}',2);
 INSERT INTO hob_private.leagues(id,espn_league_id,name,first_season) VALUES(1,1690915927,'Fixture',2025);
 INSERT INTO hob_private.seasons VALUES(2025,1,'{}','{}','{}',12,14,'active');
 INSERT INTO hob_private.recaps(season,week,style,status,facts_json,markdown_draft,markdown_final,created_at) VALUES(2025,1,'weekly','draft','{}','PRIVATE DRAFT',null,now()),(2025,2,'weekly','published','{}','PRIVATE OLD DRAFT','Published recap',now());`);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
 await db.exec('SET ROLE authenticated');
},30000);
afterEach(async()=>{await db?.close();});
test('public recap lists and detail show only the latest published version of each week',async()=>{
 await db.exec("RESET ROLE; INSERT INTO hob_private.recaps(season,week,style,status,facts_json,markdown_final,created_at) VALUES(2025,2,'weekly','published','{}','Replacement recap',now()); SET ROLE authenticated");
 for(const week of [null,2]){
  const result=await db.query('select public.hob_page(\'recaps\',2025,$1,null) as data',[week]);
  expect(JSON.stringify(result.rows)).toContain('Replacement recap');
  expect(JSON.stringify(result.rows)).not.toContain('Published recap');
 }
});
test('active routes return safe page data and published recaps only',async()=>{
 for(const route of ['home','matchups','history','franchises','h2h','seasons','records','belt','timeline','transactions','what-if','recaps']){
  const result=await db.query('select public.hob_page($1,2025,null,null) as data',[route]);
  expect(JSON.stringify(result.rows)).not.toMatch(/PRIVATE|private-token|raw_json|pin_hash/);
 }
 const result=await db.query('select public.hob_page(\'recaps\',2025,null,null) as data');
 expect(JSON.stringify(result.rows)).toContain('Published recap');
});
test('unknown and paused routes are rejected; member cannot read admin data',async()=>{
 for(const route of ['snapshots','pickem','admin','admin-recaps']) await expect(db.query('select public.hob_page($1,null,null,null)',[route])).rejects.toThrow();
});
test('revocation applies to all page reads even with an authenticated session',async()=>{
 await db.exec('RESET ROLE; UPDATE hob_private.memberships SET revoked_at=now(); SET ROLE authenticated');
 await expect(db.query("select public.hob_page('home',null,null,null)")).rejects.toThrow();
});
test('commissioner can read drafts without credentials or raw sync errors',async()=>{
 await db.exec("RESET ROLE; UPDATE hob_private.managers SET role='commissioner'; SET ROLE authenticated");
 const result=await db.query("select public.hob_page('admin-recaps',null,null,null) as data");
 expect(JSON.stringify(result.rows)).toContain('PRIVATE DRAFT');
 expect(JSON.stringify(result.rows)).not.toMatch(/private-token|pin_hash|password|espn_s2/);
});
test('member cannot change settings, managers or recaps',async()=>{
 for(const sql of ["select public.hob_save_setting('draft_date','2026-08-29')","select public.hob_add_manager('New',null)","select public.hob_save_recap(1,2025,1,'Changed','PRIVATE DRAFT','draft','publish')"])
  await expect(db.query(sql)).rejects.toThrow();
});
test('commissioner publication is validated and rejects stale draft edits',async()=>{
 await db.exec("RESET ROLE; UPDATE hob_private.managers SET role='commissioner'; SET ROLE authenticated");
 await expect(db.query("select public.hob_save_setting('espn_s2','forbidden')")).rejects.toThrow();
 await expect(db.query("select public.hob_save_recap(1,2025,1,'','PRIVATE DRAFT','draft','publish')")).rejects.toThrow();
 await db.query("select public.hob_save_recap(1,2025,1,'New published text','PRIVATE DRAFT','draft','publish')");
 await expect(db.query("select public.hob_save_recap(1,2025,1,'Stale overwrite','PRIVATE DRAFT','draft','save')")).rejects.toThrow();
 const result=await db.query("select public.hob_page('recaps',2025,1,null) as data");
 expect(JSON.stringify(result.rows)).toContain('New published text');
});
