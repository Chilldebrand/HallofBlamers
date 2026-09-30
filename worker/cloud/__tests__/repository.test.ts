import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, test } from 'vitest';
import { generateSchema } from '../../../migration/postgres-schema';
import { publishGeneration, DERIVED_TABLES } from '../repository';
let db:PGlite;
afterEach(async()=>{await db?.close();});
async function fixture(){
 db=new PGlite();await db.exec(generateSchema());
 await db.exec(`INSERT INTO hob_private.stat_builds(id,started_at,input_hash,status) VALUES(1,now(),'old','ok');
 INSERT INTO hob_private.franchise_elo(id,build_id,franchise_id,current,peak,peak_season,peak_week,trough,weeks_at_no1) VALUES(1,1,1,1500,1500,2025,1,1500,1);
 INSERT INTO hob_private.sync_runs(id,started_at,tier,status) VALUES(1,now(),'daily','running');`);
 const rows=Object.fromEntries(DERIVED_TABLES.map(t=>[t,[]])) as Record<string,Record<string,unknown>[]>;
 rows.stat_builds=[{id:2,started_at:Date.now(),finished_at:Date.now(),input_hash:'new',status:'ok',duration_ms:1,error_text:null}];
 rows.franchise_elo=[{id:1,build_id:2,franchise_id:1,current:1520,peak:1520,peak_season:2026,peak_week:1,trough:1500,weeks_at_no1:2}];
 return rows;
}
test('publishes every derived table and success marker together',async()=>{
 const rows=await fixture();await publishGeneration(db,{season:2026,rows,runId:1,viewsFetched:3,snapshotsNew:0});
 expect((await db.query('SELECT current,build_id FROM hob_private.franchise_elo')).rows).toEqual([{current:1520,build_id:2}]);
 expect((await db.query('SELECT status FROM hob_private.sync_runs WHERE id=1')).rows).toEqual([{status:'ok'}]);
},30000);
test('failed publication leaves the previous generation and timestamp untouched',async()=>{
 const rows=await fixture();rows.franchise_elo[0].build_id=999;
 await expect(publishGeneration(db,{season:2026,rows,runId:1,viewsFetched:3,snapshotsNew:0})).rejects.toThrow();
 expect((await db.query('SELECT current,build_id FROM hob_private.franchise_elo')).rows).toEqual([{current:1500,build_id:1}]);
 expect((await db.query('SELECT status FROM hob_private.sync_runs WHERE id=1')).rows).toEqual([{status:'running'}]);
},30000);
