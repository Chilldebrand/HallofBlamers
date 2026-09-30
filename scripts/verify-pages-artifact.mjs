import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {join,relative} from 'node:path';
const root='web/dist';
let files=0;
function check(dir){for(const name of readdirSync(dir)){
 const path=join(dir,name),stat=lstatSync(path);
 if(stat.isSymbolicLink())throw Error('Symlink in website artifact');
 if(stat.isDirectory()){check(path);continue;}
 if(!/\.(?:html|js|css|woff2?|png|svg|ico|webp|jpg|jpeg|txt)$/.test(name))throw Error('Unexpected artifact file: '+relative(root,path));
 if(/\.env|backup|\.db|snapshot|fixture/i.test(name))throw Error('Private file in artifact');
 if(/\.(html|js|css|txt)$/.test(name)){
  const text=readFileSync(path,'utf8');
  if(/sb_secret_[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\/|postgres\.aridozcvdxlfnibcnejf|BEGIN (?:RSA )?PRIVATE KEY|better-sqlite3|node:fs/.test(text))throw Error('Private/server configuration in artifact');
 }
 files++;
}}
check(root);
const html=readFileSync(join(root,'index.html'),'utf8');
if(!html.includes('/HallofBlamers/assets/'))throw Error('Incorrect GitHub Pages asset base');
console.log(`Website artifact verified: ${files} public files.`);
