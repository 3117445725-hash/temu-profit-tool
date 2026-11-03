'use strict';
// Updates extension files only; pairing secrets remain in the installed directory.
const https=require('node:https');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const MANIFEST_URL='https://raw.githubusercontent.com/3117445725-hash/temu-profit-tool/main/extension-latest.json';
const HOSTS=new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com','raw.githubusercontent.com','api.github.com','github.com']);
const FILES=new Set(['manifest.json','background.js','content.js','parser.js','popup.html','popup.js','order-import.js','bridge-client.js','bridge-config.js','安装使用说明.md']);
const REQUIRED=['manifest.json','background.js','content.js','parser.js','popup.html','popup.js','bridge-config.js'];
const MAX=20*1024*1024;
function version(value){
  if(typeof value!=='string'||!/^\d+(?:\.\d+){1,3}$/.test(value))throw Error('扩展版本格式错误');
  const p=value.split('.').map(Number);while(p.length<4)p.push(0);return p;
}
function newer(a,b){const x=version(a),y=version(b);for(let i=0;i<4;i++)if(x[i]!==y[i])return x[i]>y[i];return false;}
function safeURL(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password||(u.port&&u.port!=='443'))throw Error('扩展更新地址不可信');
  return u;
}
function validateManifest(m){
  if(!m||typeof m!=='object')throw Error('扩展更新清单无效');version(m.version);
  const u=safeURL(m.url);
  if(u.hostname!=='github.com'||!/^\/3117445725-hash\/temu-profit-tool\/releases\/download\/[^/]+\/[^/]+\.zip$/.test(u.pathname)||u.search||u.hash)throw Error('扩展安装包须来自指定仓库Release');
  if(!/^[a-f0-9]{64}$/i.test(m.sha256||''))throw Error('扩展更新缺少SHA256');return m;
}
function nodeFetch(url,limit=MAX,redirects=0){
  safeURL(url);if(redirects>5)return Promise.reject(Error('更新重定向过多'));
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'Temu-Extension-Updater'},rejectUnauthorized:true},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){
        res.resume();try{const next=new URL(res.headers.location,url).href;safeURL(next);resolve(nodeFetch(next,limit,redirects+1));}catch(e){reject(e);}return;
      }
      if(res.statusCode!==200){res.resume();reject(Error('更新下载HTTP '+res.statusCode));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>limit){req.destroy(Error('更新文件过大'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
    });
    req.setTimeout(30000,()=>req.destroy(Error('更新下载超时')));req.on('error',reject);
  });
}
function run(program,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',d=>{if(stdout.length<65536)stdout+=d;});child.stderr.on('data',d=>{if(stderr.length<65536)stderr+=d;});
    const timer=setTimeout(()=>{child.kill();reject(Error('更新辅助进程超时'));},120000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(stdout);else reject(Error('更新辅助进程失败 ('+code+')'));});
  });
}
async function fetchBuffer(url,limit=MAX){
  try{return await nodeFetch(url,limit);}catch(first){
    if(process.platform!=='win32')throw first;
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'Temu-extension-fetch-'));
    try{
      // Follow redirects one hop at a time so every destination is validated.
      let current=safeURL(url).href;
      for(let count=0;count<6;count++){
        const file=path.join(temporary,'download'),headers=path.join(temporary,'headers');
        const output=await run('curl.exe',['--silent','--show-error','--proto','=https','--proto-redir','=https','--max-time','45','--max-filesize',String(limit),'--output',file,'--dump-header',headers,'--write-out','%{http_code}',current]);
        const code=Number(output.trim());
        if([301,302,303,307,308].includes(code)){
          const raw=await fs.readFile(headers,'utf8');const locations=[...raw.matchAll(/^location:\s*(.+)\r?$/gim)];if(!locations.length)throw Error('重定向缺少地址');current=safeURL(new URL(locations.at(-1)[1].trim(),current).href).href;continue;
        }
        if(code!==200)throw Error('更新下载HTTP '+code);
        const stat=await fs.stat(file);if(stat.size>limit)throw Error('更新文件过大');return await fs.readFile(file);
      }
      throw Error('更新重定向过多');
    }finally{await fs.rm(temporary,{recursive:true,force:true});}
  }
}
async function checkUpdate(currentVersion,options={}){
  version(currentVersion);const bytes=await (options.fetchBuffer||fetchBuffer)(MANIFEST_URL,65536);
  if(bytes.length>65536)throw Error('更新清单过大');const m=validateManifest(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  return newer(m.version,currentVersion)?m:null;
}
function quotePS(value){return "'"+String(value).replace(/'/g,"''")+"'";}
async function extractArchive(archive,stage){
  if(process.platform!=='win32')throw Error('扩展安装解压仅支持Windows');
  const script=path.join(path.dirname(archive),'extract.ps1');
  const text=`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead(${quotePS(archive)})
$stage = [System.IO.Path]::GetFullPath(${quotePS(stage)})
$prefix = $stage.TrimEnd([char]92) + [char]92
$size = 0L
try {
 foreach ($entry in $archive.Entries) {
  $name = $entry.FullName.Replace('/', [char]92)
  $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($stage, $name))
  $size += $entry.Length
  if ($name.Contains(':') -or [System.IO.Path]::IsPathRooted($name) -or !$target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or $size -gt ${MAX}) { throw 'Unsafe ZIP entry' }
 }
 foreach ($entry in $archive.Entries) {
  $target = [System.IO.Path]::Combine($stage, $entry.FullName.Replace('/', [char]92))
  if ($entry.Name -eq '') { [System.IO.Directory]::CreateDirectory($target) | Out-Null }
  else { [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false) }
 }
} finally { $archive.Dispose() }
`;
  await fs.writeFile(script,'\uFEFF'+text,'utf8');
  await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script]);
}
function permissions(manifest){
  const result=new Set();
  for(const name of ['permissions','host_permissions','optional_permissions','optional_host_permissions']){
    if(manifest[name]!==undefined&&!Array.isArray(manifest[name]))throw Error('扩展权限格式无效');
    for(const entry of manifest[name]||[])result.add(name+':'+entry);
  }
  // Content scripts can gain site access without adding host_permissions.
  for(const script of manifest.content_scripts||[])for(const match of script.matches||[])result.add('content_script:'+match);
  return result;
}
async function installUpdate(manifest,extensionDir,options={}){
  const m=validateManifest(manifest),destination=path.resolve(extensionDir);
  const oldManifest=JSON.parse(await fs.readFile(path.join(destination,'manifest.json'),'utf8'));
  if(!newer(m.version,oldManifest.version))throw Error('扩展更新版本没有提升');
  const secret=await fs.readFile(path.join(destination,'bridge-config.js'));
  const folder=await fs.mkdtemp(path.join(path.dirname(destination),'.temu-extension-update-'));
  const stage=path.join(folder,'stage'),backup=path.join(folder,'backup'),archive=path.join(folder,'extension.zip');
  let installed=false;
  try{
    const bytes=await (options.fetchBuffer||fetchBuffer)(m.url,MAX);
    if(bytes.length>MAX||crypto.createHash('sha256').update(bytes).digest('hex')!==m.sha256.toLowerCase())throw Error('扩展安装包SHA256校验失败');
    await fs.writeFile(archive,bytes);await fs.mkdir(stage);
    await (options.extractArchive||extractArchive)(archive,stage);
    const entries=await fs.readdir(stage,{withFileTypes:true});
    if(entries.some(e=>!e.isFile()||e.isSymbolicLink()||!FILES.has(e.name)))throw Error('扩展包包含非白名单文件或目录');
    for(const name of REQUIRED)if(!entries.some(e=>e.name===name))throw Error('扩展包缺少 '+name);
    const next=JSON.parse(await fs.readFile(path.join(stage,'manifest.json'),'utf8'));
    if(next.version!==m.version||next.manifest_version!==3)throw Error('扩展清单版本不一致');
    const approved=permissions(oldManifest);for(const permission of permissions(next))if(!approved.has(permission))throw Error('扩展更新增加权限，须手动审阅安装');
    await fs.writeFile(path.join(stage,'bridge-config.js'),secret);
    await fs.rename(destination,backup);
    try{await fs.rename(stage,destination);installed=true;}catch(error){await fs.rename(backup,destination);throw error;}
    return {version:m.version,requiresReload:true};
  }finally{
    // Never remove a backup unless the installation completed or was rolled back.
    const backupExists=await fs.stat(backup).then(()=>true,()=>false);
    if(installed||!backupExists)await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});
  }
}
module.exports={checkUpdate,installUpdate};
