param(
  [ValidateSet('Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel')]
  [string]$Configuration = 'Release',
  [ValidateSet('jlink', 'cmsis-dap', 'all')]
  [string]$Project = 'all'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoRoot 'out/native/win32-x64'

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

function Invoke-CMakeConfigure {
  param([string]$SourceDir, [string]$BuildDir)
  if ($generator) {
    & $cmake --fresh -S $SourceDir -B $BuildDir -G $generator -A x64
  } else {
    $gxx = Get-Command g++.exe -ErrorAction SilentlyContinue
    $mingwMake = Get-Command mingw32-make.exe -ErrorAction SilentlyContinue
    if (-not $gxx -or -not $mingwMake) {
      throw 'No supported C++ toolchain was found. Install Visual Studio C++ tools or x64 MinGW-w64.'
    }
    & $cmake --fresh -S $SourceDir -B $BuildDir -G 'MinGW Makefiles' "-DCMAKE_BUILD_TYPE=$Configuration" "-DCMAKE_MAKE_PROGRAM=$($mingwMake.Source)" "-DCMAKE_CXX_COMPILER=$($gxx.Source)"
  }
  if ($LASTEXITCODE -ne 0) { throw "CMake configure failed for $SourceDir with exit code $LASTEXITCODE" }
}

function Build-NativeProject {
  param(
    [string]$Name,
    [string]$SourceDir,
    [string]$ExeName,
    [bool]$HasMockDll
  )
  $buildDir = Join-Path $repoRoot "out/native/$Name-build"
  $outputExe = Join-Path $outputDir $ExeName
  $mockOutputDir = Join-Path $outputDir 'test'

  Invoke-CMakeConfigure -SourceDir $SourceDir -BuildDir $BuildDir
  & $cmake --build $buildDir --config $Configuration
  if ($LASTEXITCODE -ne 0) { throw "Native build failed for $Name with exit code $LASTEXITCODE" }

  New-Item -ItemType Directory -Force $outputDir | Out-Null
  if ($HasMockDll) { New-Item -ItemType Directory -Force $mockOutputDir | Out-Null }
  $builtExe = Join-Path $buildDir "bin/$ExeName"
  if (-not (Test-Path -LiteralPath $builtExe)) {
    throw "Native helper was not produced at $builtExe"
  }
  Copy-Item -LiteralPath $builtExe -Destination $outputExe -Force
  if ($HasMockDll) {
    $builtMockDll = Join-Path $buildDir 'bin/mock/JLink_x64.dll'
    if (-not (Test-Path -LiteralPath $builtMockDll)) {
      throw "Mock J-Link DLL was not produced at $builtMockDll"
    }
    Copy-Item -LiteralPath $builtMockDll -Destination (Join-Path $mockOutputDir 'JLink_x64.dll') -Force
  }
  Write-Host "Native helper: $outputExe"
}

function Find-ArmGnuTool {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $knownRoots = @(
    'C:\CLionToolchains',
    'C:\Program Files\GNU Arm Embedded Toolchain',
    'C:\Program Files (x86)\GNU Arm Embedded Toolchain'
  )
  foreach ($root in $knownRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter $Name -File -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
    if ($candidate) { return $candidate }
  }
  return $null
}

function Build-FlashAlgorithm {
  param(
    [ValidateSet('stm32f407', 'stm32h723')]
    [string]$Algorithm,
    [ValidateSet('cortex-m4', 'cortex-m7')]
    [string]$Cpu
  )

  $armGcc = Find-ArmGnuTool 'arm-none-eabi-gcc.exe'
  $armObjcopy = Find-ArmGnuTool 'arm-none-eabi-objcopy.exe'
  if (-not $armGcc -or -not $armObjcopy) {
    throw "arm-none-eabi-gcc.exe and arm-none-eabi-objcopy.exe are required to build the $Algorithm CMSIS-DAP Flash Algorithm."
  }

  $sourceDir = Join-Path $repoRoot 'native/cmsis-dap-flash-algorithm'
  $buildDir = Join-Path $repoRoot "out/native/cmsis-dap-flash-algorithm-build"
  $objectFile = Join-Path $buildDir "${Algorithm}_flash_algorithm.o"
  $elfFile = Join-Path $buildDir "${Algorithm}_flash_algorithm.elf"
  $mapFile = Join-Path $buildDir "${Algorithm}_flash_algorithm.map"
  $outputFile = Join-Path $outputDir "orbit-$Algorithm-flash-algorithm.bin"
  New-Item -ItemType Directory -Force $buildDir | Out-Null
  New-Item -ItemType Directory -Force $outputDir | Out-Null

  $commonFlags = @(
    "-mcpu=$Cpu",
    '-mthumb',
    '-mfloat-abi=soft',
    '-ffreestanding',
    '-fno-builtin',
    '-fno-common',
    '-fno-unwind-tables',
    '-fno-asynchronous-unwind-tables',
    '-falign-functions=1',
    '-ffunction-sections',
    '-fdata-sections',
    '-Os',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-c',
    (Join-Path $sourceDir "${Algorithm}_flash_algorithm.c"),
    '-o',
    $objectFile
  )
  & $armGcc @commonFlags
  if ($LASTEXITCODE -ne 0) { throw "Flash Algorithm ($Algorithm) compilation failed with exit code $LASTEXITCODE" }

  $linkFlags = @(
    "-mcpu=$Cpu",
    '-mthumb',
    '-mfloat-abi=soft',
    '-nostdlib',
    '-Wl,--gc-sections',
    '-Wl,--build-id=none',
    "-Wl,-Map=$mapFile",
    "-Wl,-T,$(Join-Path $sourceDir "${Algorithm}_flash_algorithm.ld")",
    $objectFile,
    '-o',
    $elfFile
  )
  & $armGcc @linkFlags
  if ($LASTEXITCODE -ne 0) { throw "Flash Algorithm ($Algorithm) link failed with exit code $LASTEXITCODE" }

  & $armObjcopy '-O' 'binary' '-j' '.text' $elfFile $outputFile
  if ($LASTEXITCODE -ne 0) { throw "Flash Algorithm ($Algorithm) binary conversion failed with exit code $LASTEXITCODE" }
  Write-Host "CMSIS-DAP Flash Algorithm ($Algorithm): $outputFile"
}

$projects = @()
if ($Project -eq 'jlink' -or $Project -eq 'all') {
  $projects += @{
    Name = 'jlink-helper'
    SourceDir = Join-Path $repoRoot 'native/jlink-helper'
    ExeName = 'orbit-jlink-helper.exe'
    HasMockDll = $true
  }
}
if ($Project -eq 'cmsis-dap' -or $Project -eq 'all') {
  $projects += @{
    Name = 'cmsis-dap-helper'
    SourceDir = Join-Path $repoRoot 'native/cmsis-dap-helper'
    ExeName = 'orbit-cmsis-dap-helper.exe'
    HasMockDll = $false
  }
}

foreach ($entry in $projects) {
  Build-NativeProject -Name $entry.Name -SourceDir $entry.SourceDir -ExeName $entry.ExeName -HasMockDll $entry.HasMockDll
}

if ($Project -eq 'cmsis-dap' -or $Project -eq 'all') {
  Build-FlashAlgorithm -Algorithm 'stm32f407' -Cpu 'cortex-m4'
  Build-FlashAlgorithm -Algorithm 'stm32h723' -Cpu 'cortex-m7'
}
