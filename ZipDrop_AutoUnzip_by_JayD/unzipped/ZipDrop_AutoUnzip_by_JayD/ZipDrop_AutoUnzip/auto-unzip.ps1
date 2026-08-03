# Auto Unzip Watch Folder (Portable)
# Created by Jay.D

# Root folder = where this script lives (portable, not tied to C:)
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$WatchFolder  = Join-Path $Root "DROP_ZIPS_HERE"
$OutputFolder = Join-Path $Root "unzipped"
$DoneFolder   = Join-Path $Root "_done"
$ErrorFolder  = Join-Path $Root "_error"
$LogFile      = Join-Path $Root "auto-unzip.log"

New-Item -ItemType Directory -Force -Path $WatchFolder, $OutputFolder, $DoneFolder, $ErrorFolder | Out-Null

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Wait-ForFileReady($path) {
    for ($i=0; $i -lt 120; $i++) {
        try {
            $stream = [System.IO.File]::Open($path, 'Open', 'Read', 'None')
            $stream.Close()
            return $true
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Unique-Folder($path) {
    if (-not (Test-Path $path)) { return $path }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $candidate = "${path}_$stamp"
    $n = 1
    while (Test-Path $candidate) {
        $candidate = "${path}_$stamp`_$n"
        $n++
    }
    return $candidate
}

Log "Auto-unzip running."
Log "Root: $Root"
Log "Watching: $WatchFolder"
Log "Extracting to: $OutputFolder"
Log "Done zips: $DoneFolder"
Log "Error zips: $ErrorFolder"

while ($true) {
    $zips = Get-ChildItem -Path $WatchFolder -Filter "*.zip" -File -ErrorAction SilentlyContinue

    foreach ($zip in $zips) {
        $zipPath  = $zip.FullName
        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($zipPath)
        $dest     = Unique-Folder (Join-Path $OutputFolder $baseName)

        Log "Found zip: $($zip.Name)  ->  $dest"

        if (-not (Wait-ForFileReady $zipPath)) {
            Log "Timed out waiting for copy to finish: $($zip.Name)"
            continue
        }

        try {
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            Expand-Archive -LiteralPath $zipPath -DestinationPath $dest -Force

            Move-Item -LiteralPath $zipPath -Destination (Join-Path $DoneFolder $zip.Name) -Force
            Log "OK: Unzipped + moved to _done: $($zip.Name)"
        }
        catch {
            try {
                Move-Item -LiteralPath $zipPath -Destination (Join-Path $ErrorFolder $zip.Name) -Force
            } catch {}
            Log "FAIL: $($zip.Name)  Error: $($_.Exception.Message)"
        }
    }

    Start-Sleep -Seconds 2
}
