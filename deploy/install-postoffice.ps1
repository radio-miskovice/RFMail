#Requires -Version 5.1
<#
.SYNOPSIS
    Install the rfmail post office on Windows.

.DESCRIPTION
    The post office answers radio calls unattended, so on Windows it is registered as a
    task that runs at boot as SYSTEM and is restarted if it stops. There is no service
    wrapper to install: Task Scheduler is already there, and a station that needs NSSM
    installed first is a station that cannot be repaired offline.

    The application is copied to $Prefix; the database and its log live in $Data; the
    configuration is written once, with both keys generated, and never rewritten —
    replacing either key signs every administrator out or makes every stored post-office
    password unreadable.

    The console must already be built (`npm run build:postoffice`). This script never
    builds anything: a radio PC should not need a Node toolchain.

.PARAMETER Prefix
    Where the application is installed. Default: C:\Program Files\rfmail-postoffice

.PARAMETER Data
    Where the database and the log live. Default: C:\ProgramData\rfmail-postoffice

.PARAMETER Config
    The configuration file. Default: <Data>\postoffice.toml

.PARAMETER Listen
    The console's listener. Default: 127.0.0.1:8090 (loopback only).

.PARAMETER Source
    The tree to install from. Default: the checkout this script is in.

.PARAMETER NodePath
    node.exe to run. Default: whatever `node` is on PATH.

.PARAMETER NoService
    Install files and configuration and print how to run it; register nothing.

.PARAMETER OpenFirewall
    Add an inbound rule for the console port. Only meaningful with a non-loopback Listen.

.PARAMETER Uninstall
    Stop and remove the task. The configuration and the data are kept.

.PARAMETER PrintTask
    Print the PowerShell that registers the task, and exit.

.PARAMETER DryRun
    Say what would happen; change nothing.

.EXAMPLE
    .\install-postoffice.ps1 -Listen "0.0.0.0:8090" -OpenFirewall

.EXAMPLE
    .\install-postoffice.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Prefix = '',
    [string]$Data = '',
    [string]$Config = '',
    [string]$Listen = '127.0.0.1:8090',
    [string]$Source = '',
    [string]$NodePath = '',
    [switch]$NoService,
    [switch]$OpenFirewall,
    [switch]$Uninstall,
    [switch]$PrintTask,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'rfmail-postoffice'
$TaskDescription = 'rfmail post office: answers radio calls and holds mail'
$ShimName = 'run-postoffice.cmd'
$LogName = 'postoffice.log'

if ($Prefix -eq '') {
    if ($null -eq $env:ProgramFiles) { Fail 'pass -Prefix: ProgramFiles is not set on this machine' }
    $Prefix = Join-Path $env:ProgramFiles 'rfmail-postoffice'
}
if ($Data -eq '') {
    if ($null -eq $env:ProgramData) { Fail 'pass -Data: ProgramData is not set on this machine' }
    $Data = Join-Path $env:ProgramData 'rfmail-postoffice'
}
if ($Config -eq '') { $Config = Join-Path $Data 'postoffice.toml' }
if ($Source -eq '') { $Source = Split-Path -Parent $PSScriptRoot }
$Source = (Resolve-Path -LiteralPath $Source).Path

function Say([string]$text) { Write-Host $text }
function Fail([string]$text) { throw "install-postoffice: $text" }

function Get-NodeExe {
    if ($NodePath -ne '') {
        if (-not (Test-Path -LiteralPath $NodePath)) { Fail "node was not found at $NodePath" }
        return (Resolve-Path -LiteralPath $NodePath).Path
    }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $command) { Fail 'node is not on this PATH; install Node 22 or newer, or pass -NodePath' }
    return $command.Source
}

function Get-ConfigListenPort([string]$address) {
    $index = $address.LastIndexOf(':')
    if ($index -lt 0) { return 0 }
    $port = 0
    if ([int]::TryParse($address.Substring($index + 1), [ref]$port)) { return $port }
    return 0
}

function New-RandomHex([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

function New-RandomBase64([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer)
}

# -- the task, in one place so it can be printed and reviewed -------------------
#
# A task rather than a service: node is not service-aware, so a "service" here would be
# a wrapper somebody has to install first — and a station on a hill cannot fetch one.

function Show-TaskRegistration {
    Say @"
# Registered as the task '$TaskName'
`$action = New-ScheduledTaskAction -Execute '$Prefix\$ShimName' -WorkingDirectory '$Prefix'
`$trigger = New-ScheduledTaskTrigger -AtStartup
`$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
`$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) ``
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowHardTerminate
Register-ScheduledTask -TaskName '$TaskName' -Description '$TaskDescription' ``
    -Action `$action -Trigger `$trigger -Principal `$principal -Settings `$settings -Force
"@
}

if ($PrintTask) {
    Show-TaskRegistration
    exit 0
}

# -- uninstall ----------------------------------------------------------------

if ($Uninstall) {
    Say "Removing the $TaskName task (configuration and data are kept)."
    if (-not $DryRun) {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Say '  task removed'
        } else {
            Say '  no task was registered'
        }
        $rule = Get-NetFirewallRule -DisplayName "rfmail post office console*" -ErrorAction SilentlyContinue
        if ($null -ne $rule) {
            $rule | Remove-NetFirewallRule
            Say '  firewall rule removed'
        }
    }
    Say "  data   $Data"
    Say "  config $Config"
    Say '  delete them by hand when you are sure you want them gone.'
    exit 0
}

# -- preflight ----------------------------------------------------------------

$NodeExe = Get-NodeExe
$SourceMain = Join-Path $Source 'apps\postoffice\src\main.ts'
$SourceConsole = Join-Path $Source 'apps\postoffice-web\build\index.html'

# A prefix inside the tree being copied (or the other way round) would copy the tree into
# itself. On a normal install this cannot happen — the source is the unpacked installer in
# %TEMP% and the prefix is Program Files — but the script is also run by hand.
$fullSource = [System.IO.Path]::GetFullPath($Source)
$fullPrefix = [System.IO.Path]::GetFullPath($Prefix)
$separator = [System.IO.Path]::DirectorySeparatorChar
if ($fullPrefix.StartsWith($fullSource + $separator) -or $fullSource.StartsWith($fullPrefix + $separator)) {
    Fail "the prefix ($Prefix) and the source ($Source) cannot contain one another"
}

if (-not (Test-Path -LiteralPath $SourceMain)) { Fail "$Source is not the rfmail tree" }
if (-not (Test-Path -LiteralPath $SourceConsole)) {
    Fail "the console is not built: run 'npm run build:postoffice' in $Source first"
}

$port = Get-ConfigListenPort $Listen
if ($port -le 0) { Fail "the listener needs host:port, got $Listen" }

Say 'rfmail post office'
Say "  source   $Source"
Say "  prefix   $Prefix"
Say "  data     $Data"
Say "  config   $Config"
Say "  listen   $Listen"
Say "  node     $NodeExe"
Say ''

# -- copying the tree ------------------------------------------------------------
#
# robocopy is the Windows tool for this and its exit codes 0..7 are success. The
# Copy-Item path exists so the same script can be exercised anywhere — a station is not
# where an installer gets debugged.

function Copy-Tree {
    param([string]$From, [string]$To)

    if (-not (Test-Path -LiteralPath $To)) { New-Item -ItemType Directory -Path $To | Out-Null }

    $robocopy = Get-Command robocopy -ErrorAction SilentlyContinue
    if ($null -ne $robocopy) {
        $arguments = @(
            $From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
            '/XD', '.git', '.svelte-kit',
            '/XF', '*.db', '*.db-wal', '*.db-shm'
        )
        & robocopy @arguments | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with exit code $LASTEXITCODE" }
        return
    }

    Get-ChildItem -LiteralPath $From -Force |
        Where-Object { $_.Name -ne '.git' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $To -Recurse -Force }
    Get-ChildItem -LiteralPath $To -Recurse -Force -Directory -Filter '.svelte-kit' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $To -Recurse -Force -File -Include '*.db', '*.db-wal', '*.db-shm' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Restore-WorkspaceLinks {
    param([string]$Root)

    # The workspace packages are TypeScript that Node runs directly, and Node refuses to
    # strip types for a file under node_modules. The link is what puts the real path
    # outside node_modules, so it is load-bearing: a copy here makes the station refuse to
    # start with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. A junction needs no
    # privilege on Windows; the same thing on Unix is a symbolic link.
    $scope = Join-Path $Root 'node_modules'
    $scope = Join-Path $scope '@rfmail'
    if (Test-Path -LiteralPath $scope) { Remove-Item -LiteralPath $scope -Recurse -Force }
    New-Item -ItemType Directory -Path $scope -Force | Out-Null

    $packages = Join-Path $Root 'packages'
    foreach ($package in Get-ChildItem -LiteralPath $packages -Directory) {
        $target = Join-Path $packages $package.Name
        $link = Join-Path $scope $package.Name
        if ($env:OS -eq 'Windows_NT') {
            New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        } else {
            New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
        }
    }
}

# -- the files ----------------------------------------------------------------

$shim = Join-Path $Prefix $ShimName
$log = Join-Path $Data $LogName

if ($DryRun) {
    Say "  would copy $Source to $Prefix"
} else {
    Copy-Tree -From $Source -To $Prefix
    Restore-WorkspaceLinks -Root $Prefix
    Say "  copied to $Prefix"
}

if (-not (Test-Path -LiteralPath $Data) -and -not $DryRun) {
    New-Item -ItemType Directory -Path $Data | Out-Null
}
$configDir = Split-Path -Parent $Config
if (-not (Test-Path -LiteralPath $configDir) -and -not $DryRun) {
    New-Item -ItemType Directory -Path $configDir | Out-Null
}

# -- the launcher ---------------------------------------------------------------
#
# Task Scheduler captures nothing, so the station writes its own log. A run-once shim is
# also what an operator can double-click when the console does not come up.

$shimText = @"
@echo off
rem rfmail post office: started at boot by Task Scheduler '$TaskName'.
rem Run it by hand to see why the station is not answering.
set "LOG=$log"
if exist "%LOG%" (
  for %%A in ("%LOG%") do if %%~zA GTR 5242880 move /y "%LOG%" "%LOG%.1" >nul
)
cd /d "$Prefix"
"$NodeExe" "$Prefix\apps\postoffice\src\main.ts" --config "$Config" >> "%LOG%" 2>&1
"@

if ($DryRun) {
    Say "  would write $shim"
} else {
    [System.IO.File]::WriteAllText($shim, ($shimText -replace "`r`n", "`n" -replace "`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    Say "  wrote $shim"
}

# -- the configuration --------------------------------------------------------
#
# Written once and never again: it holds the two generated keys.

if (Test-Path -LiteralPath $Config) {
    Say "  config already exists, left alone"
} elseif ($DryRun) {
    Say "  would write $Config (keys generated, SYSTEM and Administrators only)"
} else {
    $secret = New-RandomHex 32
    $storeKey = New-RandomBase64 32
    $template = @"
# rfmail post office configuration
#
# Secrets live in this file (SYSTEM and Administrators only). Mailboxes, administrators
# and the station's callsign live in the database.

[server]
listen = "$Listen"
# Session signing secret. Changing it signs every administrator out.
secret = "$secret"
# Key that seals the mailboxes' post-office passwords at rest. Changing it makes those
# passwords unreadable: set them again.
store_key = "$storeKey"
tls = "off"
cert = ""
key = ""
ui_dir = ""

[access]
# Who may reach the console. "very strict" is loopback only; "strict" also admits the
# CIDRs below. Enforced on every accepted connection.
mode = "very strict"
cidrs = []

[database]
driver = "sqlite"
path = "$($Data -replace '\\', '/')/postoffice.db"
"@
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Config, ($template -replace "`r`n", "`n" -replace "`n", "`r`n"), $utf8)
    # The file holds two keys: nobody but the service and the administrators may read it.
    if ($null -ne (Get-Command icacls -ErrorAction SilentlyContinue)) {
        & icacls $Config /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null
    }
    Say "  wrote $Config"
}

# -- the task -----------------------------------------------------------------

if ($NoService) {
    Say ''
    Say 'No task was registered. To run the station by hand:'
    Say "  $shim"
    exit 0
}

if ($DryRun) {
    Say "  would register the task '$TaskName' (run at boot as SYSTEM, restart on failure)"
} else {
    $action = New-ScheduledTaskAction -Execute (Join-Path $Prefix $ShimName) -WorkingDirectory $Prefix
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowHardTerminate
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    Register-ScheduledTask -TaskName $TaskName -Description $TaskDescription `
        -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Say "  registered the task '$TaskName'"
    Start-ScheduledTask -TaskName $TaskName
    Say '  started it'
}

# -- the firewall -------------------------------------------------------------

if ($OpenFirewall) {
    $display = "rfmail post office console ($port)"
    if ($DryRun) {
        Say "  would allow inbound TCP $port (Domain, Private)"
    } else {
        $existing = Get-NetFirewallRule -DisplayName $display -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
            New-NetFirewallRule -DisplayName $display -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $port -Profile Domain, Private | Out-Null
            Say "  allowed inbound TCP $port in the Domain and Private profiles"
        }
    }
}

Say ''
Say "The console is at http://$Listen — the first page names the station and its administrator."
Say "Log:       $log"
Say 'Reaching it from the LAN needs two changes in the configuration:'
Say '             listen = "0.0.0.0:8090"   and   [access] mode = "strict" with a CIDR.'
Say "Removing:  $PSCommandPath -Uninstall"
