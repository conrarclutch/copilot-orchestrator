import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {MCPServerConfig} from '@github/copilot-sdk';

const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
const stringMap=(value:unknown):value is Record<string,string>=>object(value)&&Object.values(value).every(item=>typeof item==='string');

/** Host-owned configuration. It is loaded before any model turn, never from an agent tool. */
export async function loadLocalMcpConfig(file:string):Promise<Record<string,MCPServerConfig>> {
  const location=path.resolve(file);
  let input:unknown;
  try {input=JSON.parse(await readFile(location,'utf8'));} catch {throw new Error('Unable to read MCP configuration as JSON.');}
  if(!object(input)||!object(input.mcpServers))throw new Error('MCP configuration must contain an mcpServers object.');
  const servers:Record<string,MCPServerConfig>={};
  for(const [name,value]of Object.entries(input.mcpServers)) {
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)||['constructor','prototype','__proto__','t3-code'].includes(name))throw new Error('Invalid or reserved MCP server name.');
    if(!object(value))throw new Error(`Invalid MCP server configuration: ${name}`);
    const allowed=['type','command','args','workingDirectory','env','url','headers','tools','timeout'];
    if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error(`Unknown MCP configuration field for ${name}`);
    if(value.tools!==undefined&&!strings(value.tools))throw new Error(`Invalid tools list for ${name}`);
    if(value.timeout!==undefined&&(typeof value.timeout!=='number'||!Number.isFinite(value.timeout)||value.timeout<=0))throw new Error(`Invalid timeout for ${name}`);
    const common={...(value.tools===undefined?{}:{tools:value.tools as string[]}),...(value.timeout===undefined?{}:{timeout:value.timeout as number})};
    const type=value.type??'stdio';
    if(type==='stdio'||type==='local') {
      if(typeof value.command!=='string'||!value.command.trim())throw new Error(`Missing stdio command for ${name}`);
      if(value.args!==undefined&&!strings(value.args))throw new Error(`Invalid args for ${name}`);
      if(value.env!==undefined&&!stringMap(value.env))throw new Error(`Invalid env for ${name}`);
      if(value.workingDirectory!==undefined&&typeof value.workingDirectory!=='string')throw new Error(`Invalid workingDirectory for ${name}`);
      if(value.url!==undefined||value.headers!==undefined)throw new Error(`Unexpected network configuration for stdio server ${name}`);
      servers[name]={type:'stdio',command:value.command,...common,
        ...(value.args===undefined?{}:{args:value.args as string[]}),
        ...(value.env===undefined?{}:{env:value.env as Record<string,string>}),
        workingDirectory:path.resolve(path.dirname(location),(value.workingDirectory as string|undefined)??'.')};
    } else if(type==='http'||type==='sse') {
      let url:URL;
      try {url=new URL(String(value.url));}catch{throw new Error(`Invalid MCP URL for ${name}`);}
      if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error(`MCP server ${name} must use a loopback HTTP(S) URL without embedded credentials.`);
      if(value.headers!==undefined&&!stringMap(value.headers))throw new Error(`Invalid headers for ${name}`);
      if(value.command!==undefined||value.args!==undefined||value.env!==undefined||value.workingDirectory!==undefined)throw new Error(`Unexpected process configuration for HTTP server ${name}`);
      servers[name]={type,url:url.href,...common,...(value.headers===undefined?{}:{headers:value.headers as Record<string,string>})};
    } else throw new Error(`Unsupported MCP server type for ${name}`);
  }
  return servers;
}
