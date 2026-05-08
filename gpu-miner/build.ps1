# Build the CUDA GPU miner (Windows / PowerShell).
#
# Requirements:
#   - NVIDIA CUDA Toolkit 11.x or 12.x installed (provides `nvcc.exe`)
#   - A supported NVIDIA GPU (compute capability >= 6.1 recommended)
#
# Usage:
#   .\build.ps1               # auto-detects GPU arch, builds Release
#   .\build.ps1 -Arch sm_86   # force a specific arch (sm_75 Turing, sm_86 Ampere, sm_89 Ada)
#   .\build.ps1 -Clean        # rebuild from scratch

param(
    [string]$Arch = '',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if ($Clean) {
    if (Test-Path 'rpow-miner-gpu.exe') { Remove-Item 'rpow-miner-gpu.exe' -Force }
}

# Locate nvcc. Try PATH first, then common CUDA install roots.
function Find-Nvcc {
    $fromPath = Get-Command nvcc -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }

    $candidates = @()
    if (Test-Path 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA') {
        $candidates += Get-ChildItem 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA' -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\nvcc.exe' }
    }
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

$nvcc = Find-Nvcc
if (-not $nvcc) {
    Write-Host ""
    Write-Host "nvcc.exe not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install the CUDA Toolkit first, then rerun:" -ForegroundColor Yellow
    Write-Host "  https://developer.nvidia.com/cuda-downloads"
    Write-Host ""
    Write-Host "After install, either restart this terminal or add the CUDA bin folder to PATH."
    exit 1
}

Write-Host "Using nvcc: $nvcc"

# Auto-detect arch via nvidia-smi if not provided.
# RTX 2050 is Ampere (sm_86). RTX 30-series = sm_86, RTX 40-series = sm_89,
# GTX 10-series = sm_61, RTX 20-series = sm_75.
if (-not $Arch) {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($smi) {
        $name = (& nvidia-smi --query-gpu=name --format=csv,noheader | Select-Object -First 1).Trim()
        Write-Host "Detected GPU: $name"
        switch -Regex ($name) {
            'RTX 50|B\d{3}\b'                      { $Arch = 'sm_89'; break }   # Ada-ish / newer
            'RTX 40|RTX\s*?40\d|L\d|H100|H200'     { $Arch = 'sm_89'; break }
            'RTX 30|RTX\s*?30\d|RTX 2050|A\d{3}|A100' { $Arch = 'sm_86'; break } # Ampere
            'RTX 20|GTX 16|Titan V|T4|Quadro RTX'  { $Arch = 'sm_75'; break }   # Turing
            'GTX 10|Titan Xp|P\d{3}'               { $Arch = 'sm_61'; break }   # Pascal
            'GTX 9|Titan X'                        { $Arch = 'sm_52'; break }   # Maxwell
            default                                 { $Arch = 'sm_75'; break }   # safe-ish default
        }
    } else {
        $Arch = 'sm_75'
    }
    Write-Host "Target arch: $Arch"
}

# Locate a C++ host compiler (MSVC via vswhere). nvcc needs cl.exe on Windows.
function Find-Cl {
    $fromPath = Get-Command cl -ErrorAction SilentlyContinue
    if ($fromPath) { return $null }  # already on PATH, no need to set -ccbin

    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return $null }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if (-not $vs) { return $null }
    $vcRoot = Join-Path $vs 'VC\Tools\MSVC'
    if (-not (Test-Path $vcRoot)) { return $null }
    $latest = Get-ChildItem $vcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    $clDir  = Join-Path $latest.FullName 'bin\Hostx64\x64'
    if (Test-Path (Join-Path $clDir 'cl.exe')) { return $clDir }
    return $null
}

$clDir = Find-Cl
$ccArg = @()
if ($clDir) {
    Write-Host "Using MSVC cl.exe from: $clDir"
    $ccArg = @('-ccbin', $clDir)
}

$out = Join-Path $here 'rpow-miner-gpu.exe'
$src = Join-Path $here 'main.cu'

$nvccArgs = @(
    '-O3',
    '-std=c++17',
    '-arch', $Arch,
    '-Xcompiler', '/O2',
    '-o', $out,
    $src
) + $ccArg

Write-Host ""
Write-Host "Building: nvcc $($nvccArgs -join ' ')"
& $nvcc @nvccArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Build OK -> $out" -ForegroundColor Green
Write-Host ""
Write-Host "Quick smoke test (mines a low-difficulty challenge):"
Write-Host "  .\rpow-miner-gpu.exe --prefix 3c5d81491a6d4fdee6d5787ffa8d64fc --difficulty 20"
