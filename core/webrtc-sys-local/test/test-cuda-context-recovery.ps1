param(
    [Parameter(Mandatory = $true)][string]$WebRtcDirectory,
    [string]$CudaDirectory = $env:CUDA_PATH,
    [string]$OutputDirectory = (Join-Path $env:TEMP 'echo-cuda-context-test'),
    [string]$CudaContextSource
)

$ErrorActionPreference = 'Stop'
$sdkDirectory = Split-Path $PSScriptRoot -Parent
if (!$CudaContextSource) { $CudaContextSource = Join-Path $sdkDirectory 'src\nvidia\cuda_context.cpp' }
if (!(Test-Path (Join-Path $WebRtcDirectory 'lib\webrtc.lib'))) {
    throw 'WebRtcDirectory must contain the Windows release libwebrtc headers and library.'
}
if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsDirectory = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$vsDirectory) { throw 'Visual Studio C++ build tools are required.' }
    $vcvars = Join-Path $vsDirectory 'VC\Auxiliary\Build\vcvars64.bat'
    & cmd.exe /d /c "call `"$vcvars`" >nul && set" | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
        }
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the C++ build environment.' }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$testExe = Join-Path $OutputDirectory 'cuda-context-recovery-test.exe'
$compilerArguments = @(
    '/nologo', '/std:c++20', '/EHsc', '/MT', '/DWEBRTC_WIN', '/DNOMINMAX',
    '/DWIN32_LEAN_AND_MEAN', '/DWEBRTC_LIBRARY_IMPL', '/DNDEBUG', '/DWIN32',
    "/I$WebRtcDirectory\include", "/I$WebRtcDirectory\include\third_party\abseil-cpp",
    "/I$CudaDirectory\include", "/I$sdkDirectory\src", "/I$sdkDirectory\src\nvidia",
    "/I$sdkDirectory\include", (Join-Path $PSScriptRoot 'cuda_context_recovery_test.cpp'),
    $CudaContextSource, "/Fe$testExe", '/link',
    "/LIBPATH:$WebRtcDirectory\lib", "/LIBPATH:$CudaDirectory\lib\x64",
    'webrtc.lib', 'cuda.lib', 'winmm.lib', 'ws2_32.lib', 'secur32.lib', 'crypt32.lib',
    'iphlpapi.lib', 'dmoguids.lib', 'msdmo.lib', 'wmcodecdspuuid.lib', 'strmiids.lib', 'ole32.lib'
)
Push-Location $OutputDirectory
try {
    & cl.exe @compilerArguments
    if ($LASTEXITCODE -ne 0) { throw "CUDA context test compilation failed ($LASTEXITCODE)." }
} finally {
    Pop-Location
}
& $testExe
if ($LASTEXITCODE -ne 0) { throw "CUDA context recovery test failed ($LASTEXITCODE)." }
