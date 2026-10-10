# 弹幕直播间 · 安装脚本 (Windows PowerShell)
#
# 作用：把本文件夹装成 TauriTavern / SillyTavern 的扩展。
# 用法：右键本文件 →「使用 PowerShell 运行」；或在本文件夹打开 PowerShell 后执行：
#         powershell -ExecutionPolicy Bypass -File .\安装.ps1
#
# 可重复执行：第二次运行就是"更新"，会自动覆盖旧版本（不顺带删你自己的东西）。
# 它不碰酒馆的其它目录，只往 extensions\third-party\ 下放一个 ST-Danmaku 文件夹。

[CmdletBinding()]
param(
    # 手动指定酒馆数据目录（一般不用填，脚本会自己找）
    [string]$DataDir,
    # 只显示将要做什么，不实际复制
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = 'ST-Danmaku'
$Source = $PSScriptRoot

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Ok($msg)   { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!] $msg"    -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "  [X] $msg"    -ForegroundColor Red }

Write-Host ""
Write-Host "=== 弹幕直播间 $PluginName 安装器 ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. 校验源文件夹 ─────────────────────────────────────────────
foreach ($f in @('manifest.json', 'index.js', 'style.css')) {
    if (-not (Test-Path (Join-Path $Source $f))) {
        Write-Err2 "源文件夹里缺少 $f，请确认本脚本和插件文件在一起。"
        exit 1
    }
}

# ── 2. 找出酒馆数据目录 ─────────────────────────────────────────
function Test-DataDir($p) {
    if (-not $p) { return $false }
    if (-not (Test-Path $p)) { return $false }
    return (Test-Path (Join-Path $p 'default-user')) -or (Test-Path (Join-Path $p 'extensions'))
}

$candidates = @()
if ($DataDir) { $candidates += $DataDir }

# TauriTavern 客户端的标准位置
$candidates += (Join-Path $env:APPDATA 'com.tauritavern.client\data')
# 有些版本会带版本号后缀，扫一遍同级目录
Get-ChildItem $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'com.tauritavern*' } |
    ForEach-Object { $candidates += (Join-Path $_.FullName 'data') }
# 常见的自建 SillyTavern
$candidates += @(
    'E:\SillyTavern\data',
    'D:\SillyTavern\data',
    'C:\SillyTavern\data',
    (Join-Path $env:USERPROFILE 'SillyTavern\data')
)

$found = $null
foreach ($c in ($candidates | Select-Object -Unique)) {
    if (Test-DataDir $c) { $found = (Resolve-Path $c).Path; break }
}

if (-not $found) {
    Write-Warn2 "没能自动找到酒馆的数据目录。"
    Write-Host ""
    Write-Host "  请手动运行一次，把数据目录告诉本脚本，例如：" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -DataDir `"C:\路径\到\data`"" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  数据目录的特征：里面能看到 default-user 或 extensions 文件夹。" -ForegroundColor Yellow
    exit 1
}
Write-Ok "找到酒馆数据目录：$found"

# ── 3. 目标路径 ─────────────────────────────────────────────────
$target = Join-Path $found "extensions\third-party\$PluginName"
Write-Step "安装目标：$target"

if ($DryRun) {
    Write-Host ""
    Write-Warn2 "DryRun：仅预览，未做任何改动。"
    exit 0
}

# ── 4. 检查酒馆是不是还开着 ─────────────────────────────────────
$running = Get-Process -Name 'tauritavern', 'SillyTavern' -ErrorAction SilentlyContinue
if ($running) {
    Write-Warn2 "检测到酒馆正在运行。复制文件本身没问题，但要刷新页面（Ctrl+R）才会生效。"
    Write-Warn2 "如果刷新后没出现悬浮球，就完全退出酒馆再启动一次。"
}

# ── 5. 备份旧版本（如果有） ─────────────────────────────────────
if (Test-Path $target) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $found "extensions\third-party\_backup_${PluginName}_$stamp"
    Write-Step "发现旧版本，先备份到：_backup_${PluginName}_$stamp"
    Copy-Item $target $backup -Recurse -Force
    Write-Ok "备份完成"
}

# ── 6. 复制 ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Path $target -Force | Out-Null
$exclude = @('.git', 'node_modules', 'test', '.github', '.gitignore')
Get-ChildItem $Source -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName -Destination $target -Recurse -Force
}
Write-Ok "文件已复制"

# 顺手清理旧版本可能留下的多余文件：只保留本次复制进去的（其余的已备份）
Get-ChildItem $target -Force | Where-Object {
    $name = $_.Name
    -not (Test-Path (Join-Path $Source $name))
} | ForEach-Object {
    Write-Step "移除旧版本残留：$($_.Name)（备份里还有）"
    Remove-Item $_.FullName -Recurse -Force
}

# ── 7. 结果 ─────────────────────────────────────────────────────
$ver = (Get-Content (Join-Path $Source 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "=== 安装完成（版本 $ver）===" -ForegroundColor Green
Write-Host ""
Write-Host "接下来："
Write-Host "  1. 打开酒馆，按 Ctrl+R 刷新页面"
Write-Host "  2. 右下角会出现一个「弹」字小球，点它打开设置"
Write-Host "  3. 先到【连接】页点「测试连接」，确认能通"
Write-Host "  4. 再到【世界书】页点「扫描世界书」（这一步会调用一次 API）"
Write-Host "  5. 之后每轮正文生成完就会自动出一批弹幕"
Write-Host ""
Write-Host "想卸载：直接删掉这个文件夹即可：" -ForegroundColor DarkGray
Write-Host "  $target" -ForegroundColor DarkGray
Write-Host ""
