import {Client} from 'pg';
import {PGlite} from '@electric-sql/pglite';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {quote} from './postgres-schema';

// Application backup only: Supabase-managed Auth users remain managed by Supabase.
// Restore validation creates a disposable, isolated in-memory PostgreSQL database.
export async function backupPostgres(destination:string){
 const root=path.resolve('data/private-backups'),dir=path.resolve(destination);
 if(!dir.startsWith(root+path.sep))throw Error('Backup must stay in ignored private-backups directory');
 if(process.env.PGUSER!=='postgres.aridozcvdxlfnibcnejf'||process.env.PGHOST!=='aws-0-ca-central-1.pooler.supabase.com')throw Error('Unexpected project');
 await mkdir(root,{recursive:true});await mkdir(dir);
 const db=new Client({ssl:{rejectUnauthorized:true}});await db.connect();
 const manifest:{createdAt:string;tables:{name:string;count:number;hash:string}[];sequences:{name:string;last_value:string;is_called:boolean}[]}={createdAt:new Date().toISOString(),tables:[],sequences:[]};
 let bytes=0;
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query('SET LOCAL extra_float_digits=3');
  const names=(await db.query("select tablename from pg_tables where schemaname='hob_private' order by tablename")).rows;
  for(const {tablename:name} of names){
   const rows=(await db.query(`select row_to_json(t)::text as row from hob_private.${quote(name)} t`)).rows.map(r=>r.row as string);
   const raw=rows.join('\n'),compressed=gzipSync(raw);await writeFile(path.join(dir,name+'.jsonl.gz'),compressed,{mode:0o600});bytes+=compressed.length;
   manifest.tables.push({name,count:rows.length,hash:createHash('sha256').update(raw).digest('hex')});
  }
  for(const {sequencename:name} of (await db.query("select sequencename from pg_sequences where schemaname='hob_private'")).rows){
   const row=(await db.query(`select last_value::text,is_called from hob_private.${quote(name)}`)).rows[0];manifest.sequences.push({name,...row});
  }
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
 await mkdir(path.join(dir,'migrations'));
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')))await writeFile(path.join(dir,'migrations',file),await readFile(path.join('supabase/migrations',file)),{mode:0o600});
 await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 await verifyRestore(dir);
 return {path:dir,bytes,tables:manifest.tables.length,restoreVerified:true};
}
export async function verifyRestore(dir:string){
 const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')) as {tables:{name:string;count:number;hash:string}[];sequences:{name:string;last_value:string;is_called:boolean}[]};
 const restore=new PGlite();
 try{
  await restore.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  for(const file of (await readdir(path.join(dir,'migrations'))).sort())await restore.exec(await readFile(path.join(dir,'migrations',file),'utf8'));
  await restore.exec("BEGIN; SET CONSTRAINTS ALL DEFERRED; SET LOCAL extra_float_digits=3; SET LOCAL timezone='UTC';");
  const ordered=[...manifest.tables].sort((a,b)=>Number(['invites','memberships','cloud_snapshot_cache'].includes(a.name))-Number(['invites','memberships','cloud_snapshot_cache'].includes(b.name)));
  for(const table of ordered){
   console.log('Verifying private table: '+table.name);
   const raw=gunzipSync(await readFile(path.join(dir,table.name+'.jsonl.gz'))).toString('utf8');
   if(createHash('sha256').update(raw).digest('hex')!==table.hash)throw Error('Backup checksum mismatch');
   const rows=raw?raw.split('\n'):[];
   for(let i=0;i<rows.length;i+=100)await restore.query(`INSERT INTO hob_private.${quote(table.name)} SELECT * FROM json_populate_recordset(NULL::hob_private.${quote(table.name)},$1::json)`,['['+rows.slice(i,i+100).join(',')+']']);
   const restored=await restore.query<{row:string}>(`select row_to_json(t)::text as row from hob_private.${quote(table.name)} t`);
   // Compare canonical rows so object-key/column serialization order is irrelevant.
   const canonical=(s:string):string=>JSON.stringify(JSON.parse(s),(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
   const expected=rows.map(canonical).sort(),actual=restored.rows.map(r=>canonical(r.row)).sort();
   if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Restoration mismatch: '+table.name);
  }
  for(const seq of manifest.sequences)await restore.query('select setval($1::regclass,$2::bigint,$3)',[`hob_private.${quote(seq.name)}`,seq.last_value,seq.is_called]);
  await restore.exec('SET CONSTRAINTS ALL IMMEDIATE; COMMIT;');
  await writeFile(path.join(dir,'restore-verified.json'),JSON.stringify({verifiedAt:new Date().toISOString(),tables:manifest.tables.length,rows:manifest.tables.reduce((n,t)=>n+t.count,0)}),{mode:0o600});
 }finally{await restore.close();}
 return {tables:manifest.tables.length,restoreVerified:true};
}
if(process.argv[1]?.endsWith('backup-postgres.ts'))(process.argv.includes('--verify-only')?verifyRestore(process.argv[2]):backupPostgres(process.argv[2]??'')).then(r=>console.log(JSON.stringify(r))).catch((error)=>{console.error('Private backup or restore verification failed: '+(error.code??(String(error.message).startsWith('Restoration mismatch:')?error.message:'validation')));process.exitCode=1;});


