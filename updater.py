"""Opt-in HTTPS release updates. No user workbook data is transmitted."""
import hashlib,json,os,re,subprocess,sys,tempfile,zipfile,shutil
import time,io
from urllib.error import URLError
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler,Request,build_opener

MANIFEST_URL = 'https://github.com/3117445725-hash/temu-profit-tool/releases/latest/download/latest.json'
HOSTS={'github.com','api.github.com','release-assets.githubusercontent.com','raw.githubusercontent.com','objects.githubusercontent.com'}
MAX_BINARY=300*1024*1024

def version_tuple(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d+(?:\.\d+){1,3}',value): raise ValueError('版本号格式错误')
    parts=tuple(int(x) for x in value.split('.'))
    return parts+(0,)*(4-len(parts))

def validate_url(url):
    p=urlsplit(url)
    if p.scheme!='https' or p.hostname not in HOSTS or p.username or p.password or p.port not in (None,443): raise ValueError('更新地址不在可信 HTTPS 主机列表')
    return url

class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        validate_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def fetch(url):
    validate_url(url)
    for attempt in range(3):
        try:
            return build_opener(SafeRedirect()).open(Request(url,headers={'User-Agent':'ProfitTool-Updater','Connection':'close'}),timeout=30)
        except (URLError,TimeoutError,ConnectionError) as e:
            if attempt==2:
                if os.name=='nt':
                    folder=Path(tempfile.mkdtemp(prefix='ProfitTool-https-'));target=folder/'response.bin'
                    try:
                        result=subprocess.run(['curl.exe','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-redirs','5','--max-time','90','--max-filesize',str(MAX_BINARY),'--output',str(target),'--write-out','%{url_effective}',url],capture_output=True,timeout=100,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                        if result.returncode:raise RuntimeError('Windows HTTPS 下载失败：'+result.stderr.decode('utf8',errors='replace'))
                        validate_url(result.stdout.decode('utf8').strip())
                        if target.stat().st_size>MAX_BINARY:raise ValueError('更新文件过大')
                        return io.BytesIO(target.read_bytes())
                    finally:
                        target.unlink(missing_ok=True);folder.rmdir()
                raise RuntimeError('无法连接云端更新服务器，当前程序和业务数据未被修改。请稍后重试，或从发布页手动下载。连接原因：'+str(e)) from e
            time.sleep(attempt+1)

def validate_manifest(m):
    if not isinstance(m,dict): raise ValueError('更新清单格式错误')
    version_tuple(m.get('version'))
    validate_url(m.get('url',''))
    if m.get('format','exe') not in ('exe','zip'):raise ValueError('不支持的更新格式')
    if not isinstance(m.get('sha256'),str) or not re.fullmatch('[0-9a-fA-F]{64}',m['sha256']): raise ValueError('更新文件缺少有效 SHA256')
    return m

def check_update(current_version):
    if not MANIFEST_URL:return None
    with fetch(MANIFEST_URL) as response:
        raw=response.read(65537)
    if len(raw)>65536:raise ValueError('更新清单过大')
    m=validate_manifest(json.loads(raw.decode('utf-8-sig')))
    return m if version_tuple(m['version'])>version_tuple(current_version) else None

def download_update(manifest):
    m=validate_manifest(manifest)
    folder=Path(tempfile.mkdtemp(prefix='ProfitTool-update-'));target=folder/('ProfitTool.zip' if m.get('format')=='zip' else 'ProfitTool.exe')
    digest=hashlib.sha256();size=0
    try:
        with fetch(m['url']) as response,target.open('wb') as output:
            while True:
                chunk=response.read(1024*1024)
                if not chunk:break
                size+=len(chunk)
                if size>MAX_BINARY:raise ValueError('更新文件过大')
                digest.update(chunk);output.write(chunk)
        if digest.hexdigest().lower()!=m['sha256'].lower():raise ValueError('更新文件 SHA256 校验失败')
        if m.get('format')=='zip':
            if not zipfile.is_zipfile(target):raise ValueError('更新文件不是 ZIP')
        else:
            with target.open('rb') as stream:
                if stream.read(2)!=b'MZ':raise ValueError('更新文件不是 Windows 可执行文件')
        return target
    except BaseException:
        target.unlink(missing_ok=True)
        raise

def ps_quote(value):return "'"+str(value).replace("'","''")+"'"

def extract_bundle(source,destination):
    destination=Path(destination).resolve()
    with zipfile.ZipFile(source) as archive:
        if sum(i.file_size for i in archive.infolist())>1024*1024*1024:raise ValueError('更新包展开后过大')
        for info in archive.infolist():
            name=info.filename.replace('\\','/')
            target=(destination/name).resolve()
            if ':' in name or target==destination or destination not in target.parents or (info.external_attr>>16)&0o170000==0o120000:raise ValueError('更新包含不安全路径')
        if not {'ProfitTool.exe','_internal/python312.dll'}.issubset(set(archive.namelist())):raise ValueError('更新包缺少程序或 Python DLL')
        archive.extractall(destination)
    return destination

def install_update(path):
    """Launch hidden helper; caller must then close the application normally."""
    if not getattr(sys,'frozen',False):raise RuntimeError('仅打包后的程序支持安装更新')
    source=Path(path).resolve();destination=Path(sys.executable).resolve()
    if not source.is_file() or source==destination:raise ValueError('无效更新文件')
    if source.suffix.lower()=='.zip':
        internal=(destination.parent/'_internal').resolve()
        if Path(getattr(sys,'_MEIPASS','')).resolve()!=internal:raise RuntimeError('旧单文件版本请先手动解压便携版，再使用自动更新')
        appdir=destination.parent
        stage=Path(tempfile.mkdtemp(prefix=appdir.name+'.staging-',dir=appdir.parent))
        try:extract_bundle(source,stage)
        except BaseException:
            shutil.rmtree(stage);raise
        helper=source.parent/'install.ps1';backup=appdir.with_name(appdir.name+'.previous-'+str(os.getpid()))
        script=f'''$ErrorActionPreference = 'Stop'
$destination = {ps_quote(appdir)}
$stage = {ps_quote(stage)}
$backup = {ps_quote(backup)}
$moved = $false
try {{
 $process = Get-Process -Id {os.getpid()} -ErrorAction SilentlyContinue
 if ($process) {{ $process.WaitForExit() }}
 [System.IO.Directory]::Move($destination, $backup)
 $moved = $true
 [System.IO.Directory]::Move($stage, $destination)
 $env:PYINSTALLER_RESET_ENVIRONMENT = '1'
 Start-Process -FilePath (Join-Path $destination 'ProfitTool.exe') -WorkingDirectory $destination -WindowStyle Hidden
}} catch {{
 $_ | Out-String | Set-Content -LiteralPath {ps_quote(str(source)+'.error.txt')}
 if ($moved) {{
  if (Test-Path -LiteralPath $destination) {{ [System.IO.Directory]::Move($destination, $stage + '.failed') }}
  [System.IO.Directory]::Move($backup, $destination)
 }}
 $env:PYINSTALLER_RESET_ENVIRONMENT = '1'
 if (Test-Path -LiteralPath $destination) {{ Start-Process -FilePath (Join-Path $destination 'ProfitTool.exe') -WorkingDirectory $destination -WindowStyle Hidden }}
}}
'''
        helper.write_text(script,encoding='utf-8-sig')
        subprocess.Popen(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',str(helper)],creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),close_fds=True)
        return helper
    helper=source.parent/'install.ps1';pid=os.getpid()
    script=f'''$ErrorActionPreference = 'Stop'
$targetPid = {pid}
$source = {ps_quote(source)}
$destination = {ps_quote(destination)}
$backup = $destination + '.previous'
$staged = $destination + '.updating'
try {{
    $env:PYINSTALLER_RESET_ENVIRONMENT = '1'
    $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($process) {{ $process.WaitForExit() }}
    Copy-Item -LiteralPath $source -Destination $staged -Force
    if (Test-Path -LiteralPath $backup) {{ Remove-Item -LiteralPath $backup -Force }}
    $replaced = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {{
        try {{ [System.IO.File]::Replace($staged, $destination, $backup); $replaced = $true; break }}
        catch {{ Start-Sleep -Milliseconds 500 }}
    }}
    if (-not $replaced) {{ throw '无法替换程序，旧版仍保留' }}
    Start-Process -FilePath $destination -WorkingDirectory ([System.IO.Path]::GetDirectoryName($destination)) -WindowStyle Hidden
}} catch {{
    $_ | Out-String | Set-Content -LiteralPath ($source + '.error.txt')
    if (Test-Path -LiteralPath $destination) {{ Start-Process -FilePath $destination -WindowStyle Hidden }}
}}
'''
    helper.write_text(script,encoding='utf-8-sig')
    subprocess.Popen(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',str(helper)],creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),close_fds=True)
    return helper
