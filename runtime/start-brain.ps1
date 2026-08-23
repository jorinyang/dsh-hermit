# start-brain.ps1 - start Hermit local brain (llama.cpp server, OpenAI compatible)
# GPU-only rule (2026-08-23): --device Vulkan0 locks the GPU backend (RTX 5070 Ti),
# CPU does no inference; -ngl -1 offloads every layer to VRAM.
# Brain model: Qwen3.5-9B-Q6_K + mmproj-F16 (vision) (2026-08-23 switch, 27 §四; Qwen3-8B kept for rollback)
# Thinking: Qwen3.5 hybrid-thinking defaults ON; llama.cpp b10595 uses --reasoning off
#   (request-level enable_thinking does NOT work; --chat-template-kwargs deprecated in b10595).
# NOTE: never name the cmd-array $args - that is a PowerShell automatic variable.
$ErrorActionPreference = 'Stop'
$Model     = Join-Path $PSScriptRoot '..\models\Qwen3.5-9B-Q6_K.gguf'
$Mmproj    = Join-Path $PSScriptRoot '..\models\mmproj-F16.gguf'   # 视觉投影（02：大脑自带视觉，日常看图免独立 VLM）
$Port      = 8080
$CtxSize   = 32768
$GpuLayers = -1          # -1 = all layers to GPU (RTX 5070 Ti 16GB fits Q6_K; DeltaNet KV 更省)
$Device    = 'Vulkan0'   # GPU-only: explicit Vulkan device (see llama-server --list-devices)
$exe = Join-Path $PSScriptRoot 'llama.cpp\llama-server.exe'
if (-not (Test-Path $exe)) { Write-Error "llama-server.exe not found: $exe"; exit 1 }
if (-not (Test-Path $Model)) { Write-Error "model not found: $Model"; exit 1 }
Write-Output "[hermit-brain] model=$Model mmproj=$Mmproj port=$Port ctx=$CtxSize gpuLayers=$GpuLayers device=$Device"
$cmdArgs = @('--model', $Model, '--host', '127.0.0.1', '--port', "$Port", '--ctx-size', "$CtxSize", '--n-gpu-layers', "$GpuLayers", '--device', $Device, '--jinja', '--reasoning', 'off')
if (Test-Path $Mmproj) { $cmdArgs += @('--mmproj', $Mmproj) }
& $exe @cmdArgs
