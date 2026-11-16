import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const checkout=process.argv[2]??process.env.T3_SOURCE_ROOT;
if(!checkout)throw new Error('Pass a checkout of https://github.com/pingdotgg/t3code as the first argument or T3_SOURCE_ROOT.');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'packages/core/.extract-manifest.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n','\n')).digest('hex');
let verified=0;
for(const [file,record]of Object.entries(manifest.files)){
  if(!record.upstreamPath)continue;
  const source=execFileSync('git',['-C',checkout,'show',`${manifest.sourceCommit}:${record.upstreamPath}`],{maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
  if(hash(source)!==record.upstreamSha256)throw new Error(`Upstream provenance mismatch: ${file}`);
  verified++;
}
console.log(`Verified ${verified} public upstream source records at ${manifest.sourceCommit}.`);
