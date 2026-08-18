# start-brain.ps1 — 启动 Hermit 本地大脑（llama.cpp server，OpenAI 兼容）
# 双平台铁律：llama.cpp 为跨平台基线；Win=Vulkan/CUDA，Mac=Metal。模型进程外置，hermit-executors 走 HTTP 调用（03 §1.1/§4）。
param(
  [string]$Model = "$PSScriptRoot\..\models\Qwen3-8B-Q6_K.gguf",
  [int]$Port = 8080,
  [int]$CtxSize = 32768,
  [int]$GpuLayers = -1          # -1 = 全部卸载到 GPU（RTX 5070 Ti 16GB 容得下 Q6_K）
)
$exe = Join-Path $PSScriptRoot 'llama.cpp\llama-server.exe'
if (-not (Test-Path $exe)) { Write-Error "llama-server.exe 未找到：$exe" ; exit 1 }
if (-not (Test-Path $Model)) { Write-Error "模型未找到：$Model" ; exit 1 }
Write-Output "[hermit-brain] model=$Model port=$Port ctx=$CtxSize gpuLayers=$GpuLayers"
& $exe --model $Model --host 127.0.0.1 --port $Port --ctx-size $CtxSize --n-gpu-layers $GpuLayers --jinja
