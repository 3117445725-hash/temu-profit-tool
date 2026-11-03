'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const argv=process.argv.slice(2);function option(name,fallback){const i=argv.indexOf(name);return i<0?fallback:argv[i+1];}
const port=Number(option('--port','18746'));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
const dir=path.resolve(option('--config-dir',path.join(process.env.LOCALAPPDATA||process.env.HOME||'.','ProfitTool','bridge')));fs.mkdirSync(dir,{recursive:true,mode:0o700});
const configPath=path.join(dir,'config.json');let config;
try{config=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Invalid bridge config');config={token:crypto.randomBytes(32).toString('hex')};fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600,flag:'wx'});}
if(!/^[a-f0-9]{64}$/.test(config.token||''))throw Error('Invalid bridge token');
const actions=new Set(['diagnostic','list','capture','open_order','next_page','back','start','start_imported','start_platform','pause','resume','export']);
const jobs=new Map(),clients=new Map(),ttl=120000,maxJobs=500;
function id(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);}
function originOK(origin){return typeof origin==='string'&&/^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-zA-Z0-9-]{20,80})$/.test(origin);}
function expire(){const now=Date.now();for(const j of jobs.values())if(['queued','delivered'].includes(j.status)&&now-j.created>ttl){j.status='timeout';j.completed=now;}for(const [k,j]of jobs)if(j.completed&&now-j.completed>600000)jobs.delete(k);for(const [k,c]of clients)if(now-c.lastSeen>600000)clients.delete(k);}
function validArgs(action,args){
 if(!args||typeof args!=='object'||Array.isArray(args))return false;
 const schemas={diagnostic:['tabId'],list:['tabId'],capture:['tabId'],open_order:['order','tabId'],next_page:['tabId'],back:['tabId'],start:['orders','month','autoNext','tabId'],start_platform:['month','tabId'],start_imported:['orders','expectedSkus','month','tabId'],pause:[],resume:['tabId'],export:[]};
 if(Object.keys(args).some(k=>!schemas[action].includes(k)))return false;
 if(args.tabId!==undefined&&(!Number.isSafeInteger(args.tabId)||args.tabId<=0))return false;
 if(args.month!==undefined&&(typeof args.month!=='string'||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(args.month)))return false;
 if(args.autoNext!==undefined&&typeof args.autoNext!=='boolean')return false;
 if(action==='open_order')return typeof args.order==='string'&&/^PO-\d+-\d+$/.test(args.order)&&args.order.length<=80;
 if(action==='start_imported'){
  if(!args.month||!Array.isArray(args.orders)||!args.orders.length||args.orders.length>20000||!args.orders.every(o=>typeof o==='string'&&/^PO-\d+-\d+$/.test(o)&&o.length<=80))return false;
  if(!args.expectedSkus||typeof args.expectedSkus!=='object'||Array.isArray(args.expectedSkus))return false;
  return args.orders.every(o=>Array.isArray(args.expectedSkus[o])&&args.expectedSkus[o].length>0&&args.expectedSkus[o].length<=1000&&args.expectedSkus[o].every(s=>typeof s==='string'&&/^\d{1,30}$/.test(s)));
 }
 if(action==='start'&&args.orders!==undefined)return Array.isArray(args.orders)&&args.orders.length<=500&&args.orders.every(o=>typeof o==='string'&&/^PO-\d+-\d+$/.test(o)&&o.length<=80);
 return true;
}
function validMetadata(body){
 if(body.browserName!==undefined&&(typeof body.browserName!=='string'||body.browserName.length>180))return false;
 if(body.tabs!==undefined){
  if(!Array.isArray(body.tabs)||body.tabs.length>100)return false;
  for(const tab of body.tabs){
   if(!tab||!Number.isSafeInteger(tab.id)||tab.id<=0||typeof tab.title!=='string'||tab.title.length>180||typeof tab.url!=='string'||tab.url.length>2048)return false;
   try{const u=new URL(tab.url);if(u.protocol!=='https:'||u.username||u.password||u.port||!['agentseller.temu.com','agentseller-us.temu.com'].includes(u.hostname))return false;}catch{return false;}
  }
 }
 return true;
}
function authorized(req){const token=(req.headers.authorization||'').replace(/^Bearer /,'');const a=Buffer.from(token),b=Buffer.from(config.token);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
const extensionUpdater=require('./extension-updater.cjs');
let extensionUpdate={state:'idle',message:'尚未检查更新'},availableUpdate=null;
const extensionDir=path.join(process.env.USERPROFILE||process.env.HOME||'.','Desktop','Temu价格采集插件');
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 function send(code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
 if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return send(403,{error:'host'});
 if(origin&&!originOK(origin))return send(403,{error:'origin'});
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 if(req.method==='OPTIONS'){if(!origin)return send(403,{error:'origin'});res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');return send(204,{});}
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method==='GET'&&url.pathname==='/health')return send(200,{ok:true,service:'temu-local-bridge',version:1});
 if(!authorized(req))return send(401,{error:'authentication'});
 expire();let body={};
 if(req.method==='POST'){
  try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1048576){send(413,{error:'body too large'});return;}chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{return send(400,{error:'json'});}
 }
 if(req.method==='POST'&&url.pathname==='/extension-update'){
  if(!origin)return send(403,{error:'extension only'});
  if(!['check','apply','status'].includes(body.operation))return send(400,{error:'operation'});
  if(body.operation==='status')return send(200,extensionUpdate);
  if(extensionUpdate.state==='installing')return send(200,extensionUpdate);
  if(body.operation==='check'){
   try{const current=JSON.parse(fs.readFileSync(path.join(extensionDir,'manifest.json'),'utf8')).version;availableUpdate=await extensionUpdater.checkUpdate(current);extensionUpdate={state:'checked',available:availableUpdate?.version||null,message:availableUpdate?'发现新版本 '+availableUpdate.version:'当前已是最新版本'};return send(200,extensionUpdate);}catch(e){return send(200,{state:'error',message:e.message});}
  }
  if(!availableUpdate)return send(400,{error:'请先检查更新'});
  extensionUpdate={state:'installing',message:'下载并校验插件更新…'};
  extensionUpdater.installUpdate(availableUpdate,extensionDir).then(r=>{extensionUpdate={state:'done',message:'更新完成，重新加载插件',version:r.version};availableUpdate=null;},e=>{extensionUpdate={state:'error',message:e.message};});
  return send(202,extensionUpdate);
 }
 if(req.method==='POST'&&url.pathname==='/poll'){
  if(!origin||!id(body.browserId)||!validMetadata(body))return send(400,{error:'browser identity or metadata'});
  const old=clients.get(body.browserId);if(old&&old.origin!==origin)return send(403,{error:'identity origin mismatch'});
  clients.set(body.browserId,{browserId:body.browserId,origin,lastSeen:Date.now(),browserName:body.browserName||'',tabs:body.tabs||[]});
  const pending=[...jobs.values()].filter(j=>j.browserId===body.browserId&&j.status==='queued').slice(0,10);
  for(const j of pending){j.status='delivered';j.delivered=Date.now();j.origin=origin;}
  return send(200,{commands:pending.map(j=>({id:j.id,action:j.action,args:j.args,expiresAt:j.created+ttl}))});
 }
 if(req.method==='POST'&&url.pathname==='/command'){
  if(origin)return send(403,{error:'controller only'});
  if(!id(body.browserId)||!actions.has(body.action)||!validArgs(body.action,body.args||{}))return send(400,{error:'command scope'});
  if(!clients.has(body.browserId))return send(404,{error:'browser not connected'});
  if(jobs.size>=maxJobs)return send(429,{error:'queue full'});
  if(body.requestId!==undefined&&!id(body.requestId))return send(400,{error:'requestId'});
  if(body.requestId){const prior=[...jobs.values()].find(j=>j.requestId===body.requestId&&j.browserId===body.browserId);if(prior){if(prior.action!==body.action||JSON.stringify(prior.args)!==JSON.stringify(body.args||{}))return send(409,{error:'requestId conflict'});return send(200,{id:prior.id,status:prior.status});}}
  const job={id:crypto.randomUUID(),browserId:body.browserId,action:body.action,args:body.args||{},requestId:body.requestId,created:Date.now(),status:'queued'};jobs.set(job.id,job);return send(202,{id:job.id,status:job.status});
 }
 if(req.method==='POST'&&url.pathname==='/result'){
  const j=jobs.get(body.id);if(!j)return send(404,{error:'unknown command'});
  if(!origin||j.browserId!==body.browserId||j.origin!==origin)return send(403,{error:'result identity'});
  if(j.status!=='delivered')return send(409,{error:'command no longer pending'});
  if(typeof body.ok!=='boolean')return send(400,{error:'result schema'});
  const output=JSON.stringify(body.result===undefined?null:body.result);if(Buffer.byteLength(output)>524288)return send(413,{error:'result too large'});
  j.result=JSON.parse(output);j.ok=body.ok;j.status='completed';j.completed=Date.now();return send(200,{ok:true});
 }
 if(req.method==='GET'&&url.pathname==='/status'){
  if(origin)return send(403,{error:'controller only'});
  return send(200,{browsers:[...clients.values()].filter(c=>Date.now()-c.lastSeen<30000),commands:[...jobs.values()].map(j=>({id:j.id,browserId:j.browserId,action:j.action,status:j.status}))});
 }
 if(req.method==='GET'&&url.pathname==='/result'){
  const j=jobs.get(url.searchParams.get('id'));if(!j)return send(404,{error:'unknown command'});
  if(origin&&(j.origin!==origin||j.browserId!==url.searchParams.get('browserId')))return send(403,{error:'result identity'});
  return send(200,{id:j.id,browserId:j.browserId,status:j.status,ok:j.ok,result:j.result});
 }
 send(404,{error:'endpoint'});
});
server.requestTimeout=15000;server.headersTimeout=10000;server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,configPath})));

