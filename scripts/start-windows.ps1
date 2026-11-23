# Finds or downloads the portable Node.js, then hands over to launcher.mjs.
# Saved as UTF-8 with BOM and CRLF: Windows PowerShell 5.1 misreads Turkish text without the BOM.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppDir = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $AppDir '.runtime'
$NodeRoot = Join-Path $Runtime 'node'
$TmpDir = $null

function Stop-WithError([string]$Message) {
  if ($script:TmpDir -and [IO.Directory]::Exists($script:TmpDir)) {
    try { [IO.Directory]::Delete($script:TmpDir, $true) } catch { }
  }
  Write-Host ''
  Write-Host "Sorun: $Message" -ForegroundColor Red
  if (-not $env:MGS_NO_PAUSE) {
    Write-Host ''
    Write-Host 'Kapatmak için bir tuşa basın.'
    try { [void][Console]::ReadKey($true) } catch { [void](Read-Host) }
  }
  exit 3
}

function Get-Bytes([string]$Url) {
  for ($attempt = 1; ; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1800
      return ,$response.RawContentStream.ToArray()
    } catch {
      if ($attempt -ge 3) { throw }
      Start-Sleep -Seconds 3
    }
  }
}

# Defender or an indexer can briefly hold freshly extracted files.
function Move-WithRetry([string]$From, [string]$To) {
  for ($attempt = 1; ; $attempt++) {
    try {
      [IO.Directory]::Move($From, $To)
      return
    } catch {
      if ([IO.File]::Exists((Join-Path $To 'node.exe'))) { return }
      if ($attempt -ge 20) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Find-Node([string]$Major, [string]$Arch) {
  if (-not [IO.Directory]::Exists($NodeRoot)) { return $null }
  foreach ($dir in [IO.Directory]::GetDirectories($NodeRoot, "node-v$Major.*-win-$Arch")) {
    if ([IO.File]::Exists((Join-Path $dir 'node.exe'))) { return $dir }
  }
  return $null
}

# A developer checkout is never run from: no lock, no .runtime, no download.
$GitPath = Join-Path $AppDir '.git'
if ([IO.Directory]::Exists($GitPath) -or [IO.File]::Exists($GitPath)) {
  Stop-WithError 'Bu klasör bir geliştirici kopyası (git deposu). GitHub sayfasından ZIP olarak indirip ayrı bir klasöre açın.'
}

$Hint = 'Node.js hazırlanamadı. İnternet bağlantınızı kontrol edip yeniden açın.'
try {
  Set-Location -LiteralPath $AppDir

  switch ($env:MGS_ARCH) {
    'AMD64' { $Arch = 'x64' }
    'ARM64' { $Arch = 'arm64' }
    default { Stop-WithError 'Bu uygulama 32 bit Windows üzerinde çalışmaz.' }
  }

  # An update may need another Node.js major; launcher.mjs asks for it with MGS_NODE_MAJOR.
  if ($env:MGS_NODE_MAJOR) {
    $Major = [string][int]$env:MGS_NODE_MAJOR
  } else {
    $configText = [IO.File]::ReadAllText((Join-Path $AppDir 'app.config.json'), [Text.Encoding]::UTF8)
    $Major = [string][int](ConvertFrom-Json $configText).nodeMajor
  }

  $NodeDir = Find-Node $Major $Arch
  if (-not $NodeDir) {
    Write-Host 'Node.js indiriliyor (yalnızca ilk açılışta, birkaç dakika sürebilir)...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [void][IO.Directory]::CreateDirectory($NodeRoot)
    # Leftovers of an interrupted download; a recent folder may belong to another open window.
    foreach ($stale in [IO.Directory]::GetDirectories($Runtime, 't??????')) {
      if ([IO.Directory]::GetLastWriteTime($stale) -lt (Get-Date).AddHours(-2)) {
        try { [IO.Directory]::Delete($stale, $true) } catch { }
      }
    }
    # A short name: the Node.js archive has deep folders and Windows limits path length.
    $script:TmpDir = Join-Path $Runtime ('t' + [guid]::NewGuid().ToString('N').Substring(0, 6))
    [void][IO.Directory]::CreateDirectory($script:TmpDir)

    # Newest first. A regex, because PowerShell 5.1's JSON parser is slow on this large file.
    $indexText = [Text.Encoding]::UTF8.GetString((Get-Bytes 'https://nodejs.org/dist/index.json'))
    $Version = [regex]::Match($indexText, "`"version`"\s*:\s*`"(v$Major\.\d+\.\d+)`"").Groups[1].Value
    if (-not $Version) { Stop-WithError 'Node.js sürüm bilgisi alınamadı. İnternet bağlantınızı kontrol edip yeniden açın.' }

    $Name = "node-$Version-win-$Arch"
    $ZipPath = Join-Path $script:TmpDir "$Name.zip"
    [IO.File]::WriteAllBytes($ZipPath, (Get-Bytes "https://nodejs.org/dist/$Version/$Name.zip"))
    $sums = [Text.Encoding]::ASCII.GetString((Get-Bytes "https://nodejs.org/dist/$Version/SHASUMS256.txt"))

    $Expected = $null
    foreach ($line in ($sums -split "`r?`n")) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Count -eq 2 -and $parts[1] -eq "$Name.zip") { $Expected = $parts[0].ToLowerInvariant() }
    }
    $Actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $Expected -or $Expected -ne $Actual) {
      Stop-WithError 'İndirilen Node.js doğrulanamadı. İnternet bağlantınızı kontrol edip yeniden açın.'
    }

    Write-Host 'Node.js açılıyor...'
    $Hint = 'Node.js açılamadı. Diskte yer olduğundan ve uygulama klasörünün çok derinde olmadığından emin olup yeniden deneyin.'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $script:TmpDir)
    $Hint = 'Node.js yerleştirilemedi. Virüs koruması dosyaları kullanıyor olabilir; biraz bekleyip yeniden açın.'
    $NodeDir = Join-Path $NodeRoot $Name
    if (-not [IO.File]::Exists((Join-Path $NodeDir 'node.exe'))) {
      Move-WithRetry (Join-Path $script:TmpDir $Name) $NodeDir
    }
    try { [IO.Directory]::Delete($script:TmpDir, $true) } catch { }
    $script:TmpDir = $null
    Write-Host "Node.js hazır ($Version)."
  }
} catch {
  $detail = $_.Exception.Message
  try {
    [void][IO.Directory]::CreateDirectory($Runtime)
    [IO.File]::AppendAllText((Join-Path $Runtime 'launcher.log'), "[bootstrap] $detail`r`n")
  } catch { }
  Stop-WithError ($Hint + ' Teknik ayrıntılar .runtime\launcher.log dosyasında.')
}

# launcher.mjs uses this to fetch a Node.js major that a new version needs.
if ($env:MGS_BOOTSTRAP_ONLY) { exit 0 }

# Background removal needs Microsoft's Visual C++ runtime, which onnxruntime-node does not ship.
# Only a notice: nothing is downloaded or installed here, and the app opens whatever happens.
try {
  # A 32-bit PowerShell sees SysWOW64 as System32; Sysnative is the real one.
  $VcDir = Join-Path $env:SystemRoot $(if ([Environment]::Is64BitProcess) { 'System32' } else { 'Sysnative' })
  $VcDlls = @('MSVCP140.dll', 'VCRUNTIME140.dll')
  if ($Arch -eq 'x64') { $VcDlls += 'VCRUNTIME140_1.dll' }
  $VcMissing = @($VcDlls | Where-Object { -not [IO.File]::Exists((Join-Path $VcDir $_)) })
  if ($VcMissing.Count -gt 0 -and -not $env:MGS_NO_PAUSE) {
    $VcUrl = if ($Arch -eq 'arm64') { 'https://aka.ms/vs/17/release/vc_redist.arm64.exe' } else { 'https://aka.ms/vs/17/release/vc_redist.x64.exe' }
    Write-Host ''
    Write-Host "Arka plan silme için Microsoft'un ücretsiz Visual C++ bileşeni gerekiyor." -ForegroundColor Yellow
    Write-Host 'Kurulumu yönetici onayı isteyebilir. Kurduktan sonra uygulamayı kapatıp yeniden açın.'
    Write-Host "Bağlantı: $VcUrl"
    Write-Host ''
    Write-Host "Bağlantıyı tarayıcıda açmak için Enter'a, bileşen olmadan devam etmek için başka bir tuşa basın."
    Write-Host 'Tuşa basılmazsa uygulama 60 saniye sonra açılır; arka plan silme çalışmaz.'
    while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    $VcDeadline = (Get-Date).AddSeconds(60)
    while (-not [Console]::KeyAvailable -and (Get-Date) -lt $VcDeadline) { Start-Sleep -Milliseconds 200 }
    if ([Console]::KeyAvailable -and [Console]::ReadKey($true).Key -eq [ConsoleKey]::Enter) {
      Start-Process $VcUrl
    }
  }
} catch {
  # No console to read from, or no browser: the app still opens.
}

# From here on a message on stderr is normal output, not a reason to stop.
$ErrorActionPreference = 'Continue'
$env:PATH = "$NodeDir;$env:PATH"
& (Join-Path $NodeDir 'node.exe') (Join-Path $AppDir 'scripts\launcher.mjs')
exit $LASTEXITCODE
