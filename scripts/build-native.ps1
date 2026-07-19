param(
  [ValidateSet('Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $repoRoot 'native/jlink-helper'
$buildDir = Join-Path $repoRoot 'out/native/jlink-helper-build'
$outputDir = Join-Path $repoRoot 'out/native/win32-x64'
$outputExe = Join-Path $outputDir 'orbit-jlink-helper.exe'
$mockOutputDir = Join-Path $outputDir 'test'

$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
if ($cmakeCommand) {
  $cmake = $cmakeCommand.Source
} else {
  $cmake = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio' -Recurse -Filter cmake.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*CommonExtensions*Microsoft*CMake*CMake*bin*' } |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $cmake) {
  throw 'CMake 3.20+ was not found. Install it or add cmake.exe to PATH.'
}

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vsMajor = $null
if (Test-Path -LiteralPath $vswhere) {
  $installationVersion = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion
  if ($installationVersion) { $vsMajor = [int]($installationVersion.Split('.')[0]) }
}
$generatorByMajor = @{
  16 = 'Visual Studio 16 2019'
  17 = 'Visual Studio 17 2022'
  18 = 'Visual Studio 18 2026'
}
$generator = if ($vsMajor) { $generatorByMajor[$vsMajor] } else { $null }
if ($generator) {
  & $cmake --fresh -S $sourceDir -B $buildDir -G $generator -A x64
} else {
  $gxx = Get-Command g++.exe -ErrorAction SilentlyContinue
  $mingwMake = Get-Command mingw32-make.exe -ErrorAction SilentlyContinue
  if (-not $gxx -or -not $mingwMake) {
    throw 'No supported C++ toolchain was found. Install Visual Studio C++ tools or x64 MinGW-w64.'
  }
  & $cmake --fresh -S $sourceDir -B $buildDir -G 'MinGW Makefiles' "-DCMAKE_BUILD_TYPE=$Configuration" "-DCMAKE_MAKE_PROGRAM=$($mingwMake.Source)" "-DCMAKE_CXX_COMPILER=$($gxx.Source)"
}
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed with exit code $LASTEXITCODE" }
& $cmake --build $buildDir --config $Configuration
if ($LASTEXITCODE -ne 0) { throw "Native build failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force $outputDir | Out-Null
New-Item -ItemType Directory -Force $mockOutputDir | Out-Null
$builtExe = Join-Path $buildDir 'bin/orbit-jlink-helper.exe'
$builtMockDll = Join-Path $buildDir 'bin/mock/JLink_x64.dll'
if (-not (Test-Path -LiteralPath $builtExe)) {
  throw "Native helper was not produced at $builtExe"
}
if (-not (Test-Path -LiteralPath $builtMockDll)) {
  throw "Mock J-Link DLL was not produced at $builtMockDll"
}
Copy-Item -LiteralPath $builtExe -Destination $outputExe -Force
Copy-Item -LiteralPath $builtMockDll -Destination (Join-Path $mockOutputDir 'JLink_x64.dll') -Force
Write-Host "Native helper: $outputExe"
