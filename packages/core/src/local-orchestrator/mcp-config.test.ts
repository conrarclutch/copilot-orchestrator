import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadLocalMcpConfig} from './mcp-config.ts';

async function config(value:unknown,run:(file:string)=>Promise<void>){
 const folder=await mkdtemp(path.join(tmpdir(),'local-mcp-config-'));const file=path.join(folder,'config.json');
 try{await writeFile(file,JSON.stringify(value));await run(file);}finally{await rm(file);await rmdir(folder);}
}
describe('local MCP configuration',()=>{
 it('loads local stdio tools with config-relative working directory',()=>config({mcpServers:{tools:{command:'python',args:['tools.py'],tools:['search'],workingDirectory:'worker'}}},async file=>{
  const result=await loadLocalMcpConfig(file);expect(result.tools).toMatchObject({type:'stdio',command:'python',args:['tools.py'],tools:['search'],workingDirectory:path.join(path.dirname(file),'worker')});
 }));
 it('allows an existing loopback app MCP endpoint',()=>config({mcpServers:{tools:{type:'http',url:'http://127.0.0.1:8765/mcp'}}},async file=>{expect((await loadLocalMcpConfig(file)).tools).toMatchObject({type:'http',url:'http://127.0.0.1:8765/mcp'});}));
 it('rejects remote servers without exposing their credentials',()=>config({mcpServers:{tools:{type:'http',url:'https://example.com/mcp',headers:{Authorization:'secret-example'}}}},async file=>{await expect(loadLocalMcpConfig(file)).rejects.toThrow('loopback');}));
 it('rejects malformed options and prototype names',async()=>{
  await config({mcpServers:JSON.parse('{"__proto__":{"command":"python"}}')},async file=>{await expect(loadLocalMcpConfig(file)).rejects.toThrow('reserved');});
  await config({mcpServers:{tools:{command:'python',args:'bad'}}},async file=>{await expect(loadLocalMcpConfig(file)).rejects.toThrow('args');});
 });
});
