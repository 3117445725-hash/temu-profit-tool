param([string]$ExtensionDirectory = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Temu价格采集插件'))
$ErrorActionPreference = 'Stop'
$ShowStatus=$true
$bridgeDirectory = Join-Path $env:LOCALAPPDATA 'ProfitTool\bridge'
New-Item -ItemType Directory -Path $bridgeDirectory -Force | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $PSScriptRoot 'server.cjs'
try { $health = Invoke-RestMethod 'http://127.0.0.1:18746/health' -TimeoutSec 2 } catch { $health = $null }
if ($health -and $health.service -ne 'temu-local-bridge') { throw '18746端口被其他服务占用' }
if (-not $health) {
    $arguments = '"' + $server + '" --config-dir "' + $bridgeDirectory + '"'
    Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $bridgeDirectory 'server.log') -RedirectStandardError (Join-Path $bridgeDirectory 'server-error.log') | Out-Null
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try { $health = Invoke-RestMethod 'http://127.0.0.1:18746/health' -TimeoutSec 1;break } catch { Start-Sleep -Milliseconds 200 }
    }
}
if (-not $health) { throw '本机桥接启动失败，请检查server-error.log' }
$config = Get-Content -LiteralPath (Join-Path $bridgeDirectory 'config.json') -Raw | ConvertFrom-Json
if ($config.token -notmatch '^[a-f0-9]{64}$') { throw '配对配置无效' }
$source = Join-Path (Split-Path $PSScriptRoot) 'temu-price-extension'
New-Item -ItemType Directory -Path $ExtensionDirectory -Force | Out-Null
# Preserve newer cloud-installed extension files when restarting bridge.
$copySource=$true
$installedManifest=Join-Path $ExtensionDirectory 'manifest.json'
if(Test-Path -LiteralPath $installedManifest){
 $installedVersion=[version]((Get-Content -LiteralPath $installedManifest -Raw|ConvertFrom-Json).version)
 $sourceVersion=[version]((Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw|ConvertFrom-Json).version)
 $copySource=$sourceVersion -gt $installedVersion
}
if($copySource){Get-ChildItem -LiteralPath $source -File | Where-Object Name -ne 'bridge-config.js' | Copy-Item -Destination $ExtensionDirectory -Force}
$pair = @{url='http://127.0.0.1:18746';token=$config.token} | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $ExtensionDirectory 'bridge-config.js'),('globalThis.TEMU_LOCAL_BRIDGE=' + $pair + ';'),[Text.UTF8Encoding]::new($false))
Write-Output '本机桥接已启动，扩展目录已配对。请在浏览器中重新加载该扩展。配对目录含本机密钥，请勿分享。'

if ($ShowStatus) {
 Add-Type -AssemblyName System.Windows.Forms
 Add-Type -AssemblyName System.Drawing
 $form=New-Object Windows.Forms.Form
 $form.Text='Temu订单采集桥接状态';$form.Size=New-Object Drawing.Size(610,320);$form.StartPosition='CenterScreen'
 $label=New-Object Windows.Forms.Label
 $label.Location=New-Object Drawing.Point(22,20);$label.Size=New-Object Drawing.Size(550,175);$label.Font=New-Object Drawing.Font('Microsoft YaHei UI',11)
 $form.Controls.Add($label)
 $hint=New-Object Windows.Forms.Label
 $hint.Location=New-Object Drawing.Point(22,205);$hint.Size=New-Object Drawing.Size(550,65)
 $hint.Text='关闭本窗口不会停止后台桥接。未连接时请重载采集扩展，并打开Temu页面。此窗口不执行发货、付款等操作。'
 $form.Controls.Add($hint)
 $timer=New-Object Windows.Forms.Timer;$timer.Interval=2000
 $refresh={
  try {
   $status=Invoke-RestMethod 'http://127.0.0.1:18746/status' -Headers @{Authorization=('Bearer '+$config.token)} -TimeoutSec 2
   $count=@($status.browsers).Count
   $label.ForeColor=if($count -gt 0){[Drawing.Color]::DarkGreen}else{[Drawing.Color]::DarkOrange}
   $label.Text="本机服务：运行中（仅127.0.0.1:18746）`r`n已连接浏览器：$count`r`n扩展版本：0.4.0`r`n扩展目录：$ExtensionDirectory"
  } catch {$label.ForeColor=[Drawing.Color]::Red;$label.Text='无法连接本机桥接：'+$_.Exception.Message}
 }
 $timer.Add_Tick($refresh);&$refresh;$timer.Start()
 $form.Add_FormClosed({$timer.Stop();$timer.Dispose()})
 [void]$form.ShowDialog()
}
