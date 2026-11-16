import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import puppeteer from 'puppeteer-core';

const here=fileURLToPath(new URL('./',import.meta.url));
const iterations=40, warmups=5;
const output=path.join(here,process.env.BENCHMARK_OUTPUT ?? 'RESULTS.json');
const result={status:'running',syntheticOnly:true,startedAt:new Date().toISOString(),iterations,warmups,
  methodology:'One isolated Edge process; all clients connect over CDP; separate pages; identical three-evaluation query/readiness/batched-extraction sequence; randomized interleaving.',
  limitations:['No enterprise endpoints or authentication. No network/server query latency or model calls.',
    'Node bindings only, not Python Playwright. Playwright CDP attachment, not its native launch protocol.',
    'Programmatic DOM actions, not typing, locator auto-waits, accessibility snapshots or screenshot reasoning.',
    'Browser startup measured once; connect times are single observations, not statistical comparisons.'],
  queryCycle:{},extraction:{},failures:[]};
let child, exited, cdp, playwright, puppet;

class CDP {
  constructor(ws){
    this.ws=ws;this.id=0;this.pending=new Map();
    ws.addEventListener('message',event=>{
      const msg=JSON.parse(String(event.data));const job=this.pending.get(msg.id);if(!job)return;
      this.pending.delete(msg.id);clearTimeout(job.timer);
      msg.error ? job.reject(new Error(JSON.stringify(msg.error))) : job.resolve(msg.result);
    });
    ws.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP closed'));}this.pending.clear();});
  }
  send(method,params={},sessionId){
    return new Promise((resolve,reject)=>{
      const id=++this.id;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timed out: ${method}`));},10000);
      this.pending.set(id,{resolve,reject,timer});
      this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  async evaluate(expression,sessionId){
    const response=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if(response.exceptionDetails)throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
}

const invoke=(fn,arg)=>`(${fn})(${arg===undefined?'':JSON.stringify(arg)})`;
const run=String(value=>{const input=document.querySelector('#query');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click();});
const ready=String(value=>document.querySelector('#status').dataset.query===value && document.querySelector('#status').dataset.state==='done');
const extract=String(()=>Array.from(document.querySelectorAll('#results tbody tr'),tr=>Array.from(tr.cells,cell=>cell.textContent)));
const extractRow=String(index=>Array.from(document.querySelectorAll('#results tbody tr')[index].cells,cell=>cell.textContent));
const expected=query=>Array.from({length:100},(_,i)=>[`SYN-${String(i+1).padStart(3,'0')}`,`actor-${String(i%10).padStart(2,'0')}`,['open','review','closed'][i%3],(0.5+((i*7)%50)/100).toFixed(2),query]);
function verify(rows,query){if(JSON.stringify(rows)!==JSON.stringify(expected(query)))throw new Error(`Result mismatch for ${query}`);}
function summary(samples){const a=[...samples].sort((x,y)=>x-y);return {count:a.length,medianMs:(a[(a.length-1)>>1]+a[a.length>>1])/2,p95Ms:a[Math.ceil(a.length*.95)-1],minMs:a[0],maxMs:a.at(-1)};}
let seed=0xC0FFEE;
function shuffled(values){const a=[...values];for(let i=a.length-1;i>0;i--){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const j=(seed>>>0)%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
async function cycle(evaluate,query,rowByRow=false){
  const begin=performance.now();
  await evaluate(invoke(run,query));
  if(!await evaluate(invoke(ready,query)))throw new Error('Synthetic query did not complete synchronously');
  let rows;
  if(rowByRow){rows=[];for(let i=0;i<100;i++)rows.push(await evaluate(invoke(extractRow,i)));}
  else rows=await evaluate(invoke(extract));
  const elapsed=performance.now()-begin;
  verify(rows,query);
  return elapsed;
}

try {
  const candidates=[process.env.BROWSER_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe',process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
  let executable;
  for(const candidate of candidates){try{await fs.access(candidate);executable=candidate;break;}catch{}}
  if(!executable)throw new Error('Set BROWSER_EXECUTABLE_PATH to an installed Chromium/Edge executable');
  const profile=path.resolve(here,'../../.orchestrator/browser-benchmark-profiles',randomUUID());
  await fs.mkdir(profile,{recursive:true});
  result.profile=profile;result.profilePolicy='Unique empty profile retained; no personal browser profile read or deleted.';
  const start=performance.now();
  child=spawn(executable,['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--no-first-run','--no-default-browser-check','--window-size=1280,900','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let spawnError;child.once('error',error=>{spawnError=error;});
  exited=new Promise(resolve=>child.once('exit',resolve));
  let endpoint;
  for(let i=0;i<1000;i++){
    if(spawnError)throw spawnError;
    if(child.exitCode!==null)throw new Error(`Isolated browser exited: ${child.exitCode}`);
    try{const [port,route]=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);if(port&&route){endpoint=`ws://127.0.0.1:${port}${route}`;break;}}catch{}
    await delay(20);
  }
  if(!endpoint)throw new Error('Owned browser did not provide a DevTools endpoint');
  result.browserLaunchUntilDevToolsMs=performance.now()-start;
  const ws=new WebSocket(endpoint);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP connect timeout')),10000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true});});
  cdp=new CDP(ws);
  result.browser=await cdp.send('Browser.getVersion');
  result.environment={node:process.version,platform:process.platform,arch:process.arch,
    playwright:JSON.parse(await fs.readFile(path.join(here,'node_modules/playwright-core/package.json'),'utf8')).version,
    puppeteer:JSON.parse(await fs.readFile(path.join(here,'node_modules/puppeteer-core/package.json'),'utf8')).version};
  const fixture=`data:text/html;charset=utf-8,${encodeURIComponent(await fs.readFile(path.join(here,'fixture.html'),'utf8'))}`;
  result.connectMs={};
  let begin=performance.now();playwright=await chromium.connectOverCDP(endpoint);result.connectMs.playwright=performance.now()-begin;
  begin=performance.now();puppet=await puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:{width:1280,height:900}});result.connectMs.puppeteer=performance.now()-begin;
  const pwPage=await playwright.contexts()[0].newPage();await pwPage.setViewportSize({width:1280,height:900});await pwPage.goto(fixture);
  const ppPage=await puppet.newPage();await ppPage.goto(fixture);
  const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  await cdp.send('Page.enable',{},sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false},sessionId);
  await cdp.send('Page.navigate',{url:fixture},sessionId);
  for(let i=0;i<1000;i++){if(await cdp.evaluate('Boolean(document.querySelector("#run"))',sessionId))break;if(i===999)throw new Error('Raw CDP page did not load');await delay(5);}
  const clients={playwright:expression=>pwPage.evaluate(expression),puppeteer:expression=>ppPage.evaluate(expression),cdp:expression=>cdp.evaluate(expression,sessionId)};
  for(let i=0;i<warmups;i++)for(const [name,evaluate]of Object.entries(clients))await cycle(evaluate,`warm-${name}-${i}`);
  for(const name of Object.keys(clients))result.queryCycle[name]={samplesMs:[]};
  for(let i=0;i<iterations;i++)for(const name of shuffled(Object.keys(clients)))result.queryCycle[name].samplesMs.push(await cycle(clients[name],`query-${i}`));
  for(const entry of Object.values(result.queryCycle))entry.summary=summary(entry.samplesMs);
  const techniques={batched:[],rowByRow:[]};
  for(let i=0;i<warmups;i++)await cycle(clients.playwright,`row-warm-${i}`,true);
  for(let i=0;i<iterations;i++)for(const name of shuffled(Object.keys(techniques)))techniques[name].push(await cycle(clients.playwright,`extract-${i}`,name==='rowByRow'));
  for(const [name,samplesMs]of Object.entries(techniques))result.extraction[name]={samplesMs,summary:summary(samplesMs)};
  result.status='passed';
} catch(error){result.status='failed';result.failures.push(String(error.stack??error));process.exitCode=1;}
finally {
  if(puppet)await puppet.disconnect().catch(()=>{});
  if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.ws.close();}
  if(child){await Promise.race([exited,delay(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([exited,delay(3000)]);}}
  if(playwright)await playwright.close().catch(()=>{});
  result.completedAt=new Date().toISOString();
  await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,queryCycle:Object.fromEntries(Object.entries(result.queryCycle).map(([name,v])=>[name,v.summary])),extraction:Object.fromEntries(Object.entries(result.extraction).map(([name,v])=>[name,v.summary]))},null,2));
}
