# DeployNow setup for Windows: one command, a running DeployNow on Docker Desktop.
#
#   irm https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.ps1 | iex
#
# Installs Docker Desktop if it's missing (winget), asks a few questions (domain, port, admin
# email and password; Enter keeps the default), writes docker-compose.yml and .env to
# %USERPROFILE%\deploynow, starts DeployNow and waits until it answers. Run it again to
# upgrade: it keeps .env. On Linux and macOS use setup.sh.
#
# Without questions:
#   iex "& { $(irm https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.ps1) } -Yes -Email you@example.com"
#
# Options (each also works as an environment variable):
#   -Domain NAME     DEPLOYNOW_DOMAIN  serve on https://NAME with Let's Encrypt (DNS must point here)
#   -Port N          DEPLOYNOW_PORT    dashboard port                      (default 9444)
#   -Email ADDR      ADMIN_EMAIL       owner account                       (default admin@example.com)
#   -Password PW     ADMIN_PASSWORD    its password, 12+ characters        (default: generated)
#   -Require2fa      REQUIRE_2FA=true  make admins set up 2FA              (default: optional)
#   -Tag TAG         DEPLOYNOW_TAG     2.1.0, latest or edge               (default latest)
#   -Dir PATH        DEPLOYNOW_DIR     install folder                      (default %USERPROFILE%\deploynow)
#   -Url URL         DEPLOYNOW_URL     public URL when there's no domain   (default https://localhost:<port>)
#   -Yes                               don't ask, use the options and defaults
#   -NoStart         DEPLOYNOW_NO_START=1  write the files, don't start
#   -NoDocker        INSTALL_DOCKER=no     stop instead of installing Docker Desktop
param(
  [string]$Domain = $env:DEPLOYNOW_DOMAIN,
  [string]$Port = $env:DEPLOYNOW_PORT,
  [string]$Email = $env:ADMIN_EMAIL,
  [string]$Password = $env:ADMIN_PASSWORD,
  [switch]$Require2fa,
  [string]$Tag = $env:DEPLOYNOW_TAG,
  [string]$Dir = $env:DEPLOYNOW_DIR,
  [string]$Url = $env:DEPLOYNOW_URL,
  [switch]$Yes,
  [switch]$NoStart,
  [switch]$NoDocker
)

# Native commands report through exit codes; errors are handled where they happen
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far slower with the progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo = 'encorp-io/deploynow'
$Raw = "https://raw.githubusercontent.com/$Repo"

function Say([string]$m)  { Write-Host '==> ' -ForegroundColor Blue -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Host 'warning: ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
# throw, not exit: under `irm | iex` exit would close the PowerShell window. The catch at the
# end turns it into a quiet stop, since the message is already on screen.
function Die([string]$m)  { Write-Host 'error: ' -ForegroundColor Red -NoNewline; Write-Host $m; throw 'DeployNowSetupStopped' }

try {

$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
if ($env:REQUIRE_2FA -eq 'true') { $Require2fa = $true }
if ($env:DEPLOYNOW_YES) { $Yes = $true }
if ($env:DEPLOYNOW_NO_START -eq '1') { $NoStart = $true }
if ($env:INSTALL_DOCKER -eq 'no') { $NoDocker = $true }
if (-not $OnWindows) { Warn 'On Linux and macOS, setup.sh is the installer: curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh | sudo bash' }

$Interactive = (-not $Yes) -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

function Ask([string]$q, [string]$def) {
  if (-not $Interactive) { return $def }
  $prompt = if ($def) { "? $q [$def]" } else { "? $q" }
  $a = Read-Host $prompt
  if ([string]::IsNullOrEmpty($a)) { return $def }
  return $a.Trim()
}

function Read-Secret([string]$q) {
  $s = Read-Host $q -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Ask-Password {
  if (-not $Interactive) { return '' }
  while ($true) {
    $a = Read-Secret '? Admin password (12+ characters) [Enter = generate one]'
    if (-not $a) { return '' }
    if ($a.Length -lt 12) { Write-Host '  At least 12 characters, please.'; continue }
    if ($a.Contains("'")) { Write-Host "  Please leave out the ' character."; continue }
    $b = Read-Secret '  Repeat it'
    if ($a -ceq $b) { return $a }
    Write-Host "  They didn't match. Try again."
  }
}

function New-Secret([int]$bytes) {
  $buf = New-Object byte[] $bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buf); $rng.Dispose()
  return [Convert]::ToBase64String($buf)
}

function Test-Domain([string]$d) { ($d -cmatch '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$') -and ($d -notmatch '^[0-9.]+$') }
function Test-Email([string]$e)  { $e -match '^[^\s@]+@[^\s@]+\.[^\s@]+$' }
function Test-RealEmail([string]$e) { (Test-Email $e) -and ($e -notmatch '@example\.(com|org|net)$') }

function Test-PortBusy([int]$p) {
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
  }
  try {
    $l = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Any), $p
    $l.ExclusiveAddressUse = $true
    $l.Start(); $l.Stop(); return $false
  } catch { return $true }
}

# .env is read by Docker Compose: UTF-8 without a byte order mark, LF line ends
$Utf8 = New-Object Text.UTF8Encoding $false
function Read-EnvLines([string]$f) { if (Test-Path $f) { @([IO.File]::ReadAllLines($f)) } else { @() } }
function Write-EnvLines([string]$f, [string[]]$lines) { [IO.File]::WriteAllText($f, (($lines -join "`n") + "`n"), $Utf8) }
function Get-EnvValue([string]$f, [string]$key) {
  foreach ($l in (Read-EnvLines $f)) { if ($l.StartsWith("$key=")) { return $l.Substring($key.Length + 1) } }
  return ''
}
function Set-EnvValue([string]$f, [string]$key, [string]$value) {
  $lines = @(Read-EnvLines $f | Where-Object { -not $_.StartsWith("$key=") }) + "$key=$value"
  Write-EnvLines $f $lines
}

# -- Docker --
function Test-DockerUp { & docker info *> $null; return ($LASTEXITCODE -eq 0) }

function Start-DockerDesktop {
  if (Test-DockerUp) { return $true }
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if ($OnWindows -and (Test-Path $exe)) { Say 'Starting Docker Desktop'; Start-Process $exe | Out-Null }
  for ($i = 0; $i -lt 90; $i++) { if (Test-DockerUp) { return $true }; Start-Sleep -Seconds 2 }
  return $false
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $bin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
  if ($OnWindows -and (Test-Path (Join-Path $bin 'docker.exe'))) { $env:Path = "$env:Path;$bin" }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  if ($NoDocker) { Die 'Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and run this again.' }
  if (-not $OnWindows -or -not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die 'Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, and run this again.'
  }
  Say 'Installing Docker Desktop with winget (Windows asks for permission)'
  & winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Die "Docker Desktop didn't install. Install it from https://www.docker.com/products/docker-desktop/ and run this again." }
  Write-Host ''
  Say 'Docker Desktop is installed. Start it from the Start menu, finish its first-run steps'
  Say '(it may ask to restart Windows for WSL 2), then run this same command again.'
  return
}
if (-not (Start-DockerDesktop)) { Die "Docker isn't running. Start Docker Desktop, wait until it says it's running, and run this again." }
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Die 'Docker Compose is missing. Update Docker Desktop and run this again.' }
$ostype = (& docker info --format '{{.OSType}}' 2>$null | Out-String).Trim()
if ($ostype -and $ostype -ne 'linux') { Die 'Docker Desktop runs Windows containers. Right-click its tray icon, choose "Switch to Linux containers...", and run this again.' }

# -- Questions --
if (-not $Dir) { $Dir = Join-Path $HOME 'deploynow' }
$EnvFile = Join-Path $Dir '.env'
$ComposeFile = Join-Path $Dir 'docker-compose.yml'
$Upgrade = Test-Path $EnvFile
$Generated = $false

Write-Host ''
Write-Host 'DeployNow setup' -ForegroundColor White
if ($Upgrade) {
  Say "Found $EnvFile`: upgrading and keeping your settings"
} else {
  if ($Interactive) { Write-Host "Press Enter to keep a default.`n" -ForegroundColor DarkGray }

  while ($true) {
    $Domain = Ask 'Domain for DeployNow, e.g. deploy.example.com (Enter to use localhost)' $Domain
    $Domain = ($Domain -replace '^https?://', '' -replace '/.*$', '').ToLower()
    if (-not $Domain -or (Test-Domain $Domain)) { break }
    if (-not $Interactive) { Die "-Domain $Domain isn't a domain name such as deploy.example.com" }
    Write-Host "  That isn't a domain name such as deploy.example.com."; $Domain = ''
  }

  while ($true) {
    $Port = Ask 'Dashboard port' $(if ($Port) { $Port } else { '9444' })
    $n = 0
    if ([int]::TryParse($Port, [ref]$n) -and $n -ge 1 -and $n -le 65535 -and ($n -notin @(80, 443, 8444))) {
      if (Test-PortBusy $n) {
        if (-not $Interactive) { Die "Port $n is already in use. Pick another with -Port." }
        Write-Host "  Port $n is already in use. Pick another."; $Port = ''; continue
      }
      break
    }
    if (-not $Interactive) { Die '-Port must be a free port number other than 80, 443 and 8444' }
    Write-Host '  Use a port number other than 80, 443 and 8444 (those are for your apps and agents).'; $Port = ''
  }

  while ($true) {
    $def = if ($Email) { $Email } elseif ($Domain) { '' } else { 'admin@example.com' }
    $Email = Ask 'Admin email' $def
    if ($Domain -and -not (Test-RealEmail $Email)) {
      if (-not $Interactive) { Die "With -Domain, pass a real -Email: Let's Encrypt sends certificate notices to it." }
      Write-Host "  With a domain, use a real address: Let's Encrypt sends certificate notices to it."; $Email = ''; continue
    }
    if (Test-Email $Email) { break }
    if (-not $Interactive) { Die "-Email $Email isn't an email address" }
    Write-Host "  That isn't an email address."; $Email = ''
  }

  if (-not $Password) { $Password = Ask-Password }
  if (-not $Password) { $Password = ((New-Secret 24) -replace '[/+=]', '').Substring(0, 20); $Generated = $true }
  if ($Password.Length -lt 12) { Die 'The admin password must be at least 12 characters.' }
  if ($Password.Contains("'") -or $Password.Contains("`n")) { Die "The admin password can't contain ' or a line break." }

  if ($Domain) {
    foreach ($p in 80, 443) { if (Test-PortBusy $p) { Warn "Port $p is already in use. The domain needs ports 80 and 443 for Traefik; DeployNow stays reachable on port $Port meanwhile." } }
  }
}

# -- Files --
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path
$EnvFile = Join-Path $Dir '.env'
$ComposeFile = Join-Path $Dir 'docker-compose.yml'
function dc { & docker compose --project-directory $Dir -f $ComposeFile @args }

if (-not $Tag) { $Tag = Get-EnvValue $EnvFile 'DEPLOYNOW_TAG' }
if (-not $Tag) { $Tag = 'latest' }
function Get-LatestRelease {
  try {
    $r = Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Headers @{ Accept = 'application/vnd.github+json' } "https://api.github.com/repos/$Repo/releases/latest"
    if ($r.tag_name -match '^v\d+\.\d+\.\d+$') { return $r.tag_name }
  } catch {}
  return ''
}
switch -regex ($Tag) {
  '^edge$'   { $Ref = 'main'; break }
  '^latest$' { $Ref = Get-LatestRelease; if (-not $Ref) { Warn "Couldn't look up the newest release; using docker-compose.yml from main."; $Ref = 'main' }; break }
  '^v'       { $Ref = $Tag; break }
  default    { $Ref = "v$Tag" }
}
if ($Ref -notmatch '^(main|v[0-9A-Za-z.-]+)$') { Die "-Tag $Tag isn't a release such as 2.1.0, latest or edge" }

if (Test-Path $ComposeFile) {
  Say 'Keeping your docker-compose.yml'
} else {
  Say "Downloading docker-compose.yml ($Ref)"
  try { Invoke-WebRequest -UseBasicParsing "$Raw/$Ref/docker-compose.yml" -OutFile $ComposeFile }
  catch { Die "Couldn't download docker-compose.yml for $Ref" }
}

$cfg = dc config --quiet 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $cfg; Die "Docker Compose can't read $ComposeFile (the error is above)." }

if (-not $Upgrade) {
  if (-not $Url) { $Url = "https://localhost:$Port" }
  Say "Writing $EnvFile"
  $lines = @(
    '# DeployNow settings, written by setup.ps1. Back this file up: AUTH_SECRET encrypts',
    "# every stored secret, and without it a restored database can't be read.",
    "AUTH_SECRET=$(New-Secret 32)",
    "ADMIN_EMAIL=$Email",
    '# Only read on the first start: setup removes it once DeployNow is up',
    "ADMIN_PASSWORD='$Password'",
    "NEXTAUTH_URL=$Url",
    "DEPLOYNOW_PORT=$Port",
    '# Served through Traefik with a Let''s Encrypt certificate once DNS points here',
    "DEPLOYNOW_DOMAIN=$Domain",
    "ACME_EMAIL=$Email",
    '# true makes admins and owners set up 2FA or a passkey (also under Settings > Security and sign-in)',
    "REQUIRE_2FA=$(if ($Require2fa) { 'true' } else { 'false' })"
  )
  if ($Domain) { $lines += "TLS_HOSTNAME=$Domain" }
  Write-EnvLines $EnvFile $lines
  # Only you can read it: it holds AUTH_SECRET
  if ($OnWindows) { & icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):F" *> $null }
}
Set-EnvValue $EnvFile 'DEPLOYNOW_TAG' $Tag
$Port = Get-EnvValue $EnvFile 'DEPLOYNOW_PORT'; if (-not $Port) { $Port = '9444' }
$Domain = Get-EnvValue $EnvFile 'DEPLOYNOW_DOMAIN'

if ($NoStart) {
  Say "Files written to $Dir. Start with: cd `"$Dir`"; docker compose up -d"
  if (Get-EnvValue $EnvFile 'ADMIN_PASSWORD') { Say 'After the first start, remove ADMIN_PASSWORD from .env and run docker compose up -d again.' }
  return
}

# -- Start --
Say "Pulling ghcr.io/$Repo`:$Tag"
$log = dc pull -q 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  if ($Tag -eq 'latest' -and $Ref -eq 'main' -and $log -match 'manifest unknown|manifest for \S+ not found|ghcr\.io/\S+: not found') {
    # Only when GitHub showed no release at all: a :latest image comes with the first release
    Warn "There's no stable release yet; using edge (built from main)."
    $Tag = 'edge'; Set-EnvValue $EnvFile 'DEPLOYNOW_TAG' 'edge'
    dc pull -q; if ($LASTEXITCODE -ne 0) { Die "Couldn't pull the image." }
  } else {
    Write-Host $log
    if ($log -match 'unauthorized|denied|authentication required') { Die "ghcr.io refused the download of ghcr.io/$Repo`:$Tag. If you use a private copy of the image, run docker login ghcr.io first." }
    Die "Couldn't pull ghcr.io/$Repo`:$Tag (the error is above)."
  }
}

# The image runs as a non-root user and reaches Docker through the socket's group, as the container sees it
$gid = (dc run --rm --no-deps -T --entrypoint stat deployer -c '%g' /var/run/docker.sock 2>$null | Out-String) -replace '[^0-9]', ''
if ($gid) { Set-EnvValue $EnvFile 'DOCKER_GID' $gid } else { Set-EnvValue $EnvFile 'DOCKER_GID' '0' }

dc up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { Die "DeployNow didn't start (the error is above)." }

function Wait-Healthy {
  $cid = (dc ps -q | Select-Object -First 1)
  $status = ''
  for ($i = 0; $i -lt 60; $i++) {
    $status = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $cid 2>$null | Out-String).Trim()
    if ($status -eq 'healthy') { return }
    if ($status -eq 'exited') { break }
    Start-Sleep -Seconds 2
  }
  dc logs --tail 40
  Die "DeployNow didn't become healthy (status: $(if ($status) { $status } else { 'unknown' })). The log is above; see https://github.com/$Repo/blob/main/docs/install.md#troubleshooting"
}

Say 'Waiting for DeployNow to start'
Wait-Healthy

# The owner account exists now. ADMIN_PASSWORD is only read on the first start, and left in
# .env the container would keep it in its environment, where docker inspect shows it.
if (Get-EnvValue $EnvFile 'ADMIN_PASSWORD') {
  Say 'Removing the first-start password from .env'
  Write-EnvLines $EnvFile @(Read-EnvLines $EnvFile | Where-Object { -not $_.StartsWith('ADMIN_PASSWORD=') -and -not $_.StartsWith('# Only read on the first start') })
  dc up -d --remove-orphans *> $null
  if ($LASTEXITCODE -ne 0) { dc up -d --remove-orphans }
  Wait-Healthy
}

Write-Host ''
Write-Host 'DeployNow is running' -ForegroundColor Green
Write-Host ''
if ($Domain) {
  Write-Host "    Open:      https://$Domain"
  Write-Host "               (the certificate arrives within a minute or two once $Domain points"
  Write-Host "               at this machine; until then use https://localhost:$Port)"
} else {
  Write-Host "    Open:      $(Get-EnvValue $EnvFile 'NEXTAUTH_URL')"
}
if (-not $Upgrade) {
  Write-Host "    Email:     $Email"
  if ($Generated) { Write-Host "    Password:  $Password" } else { Write-Host '    Password:  the one you typed' }
  Write-Host ''
  Write-Host "    Settings are in $EnvFile. Back it up: it holds AUTH_SECRET."
  if (-not $Domain) { Write-Host '    The certificate is self-signed; add a domain later under Settings > Domain.' }
  Write-Host '    Two-factor sign-in is optional; turn it on under Account.'
}
Write-Host ''
} catch {
  if ("$($_.Exception.Message)" -ne 'DeployNowSetupStopped') { throw }
}
