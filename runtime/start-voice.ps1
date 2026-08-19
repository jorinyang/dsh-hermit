# start-voice.ps1 — 启动 Hermit 语音引擎进程（26 契约 C；仿 start-brain.ps1 模式：模型进程外置）
# 双平台铁律：Win 本脚本；Mac/Linux 用 start-voice.sh（D2 起提供）。仅绑定回环。
param(
  [int]$Port = 8300,
  [switch]$SkipInstall   # 跳过依赖检查（离线环境）
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$venvPy = Join-Path $here '.venv\Scripts\python.exe'

# 1) venv + 依赖
if (-not (Test-Path $venvPy)) {
  Write-Output "[hermit-voice] creating venv ..."
  python -m venv (Join-Path $here '.venv')
}
if (-not $SkipInstall) {
  & $venvPy -m pip install -q -r (Join-Path $here 'requirements.txt') 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Warning "[hermit-voice] pip install 失败（离线？）——用 --skip-install 复用现有环境" }
}

# 2) 端口占用检查（回环独占）
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) { Write-Error "[hermit-voice] 端口 $Port 已被占用（引擎已在跑？）" ; exit 1 }

# 3) 启动（前台运行；Ctrl+C 退出。DSH 侧 hermit-voice 插件会自动连上）
Write-Output "[hermit-voice] engine starting on ws://127.0.0.1:$Port/voice ..."
& $venvPy (Join-Path $here 'server.py')
