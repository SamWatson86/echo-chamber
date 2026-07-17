function Get-ViewerSnapshotManifest([string]$Directory) {
    if (!(Test-Path -LiteralPath $Directory -PathType Container)) {
        throw "Viewer directory does not exist: $Directory"
    }

    $root = (Resolve-Path -LiteralPath $Directory).Path.TrimEnd('\', '/')
    $files = Get-ChildItem -LiteralPath $root -File -Recurse -Force | Sort-Object FullName
    $manifest = foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/')
        if ($relative -ieq "index.html") {
            # Control rewrites cache stamps at startup. Normalize only those query
            # values so parity still catches every structural index.html change.
            $content = Get-Content -LiteralPath $file.FullName -Raw
            $normalized = [regex]::Replace($content, '([?&]v=)[^"''&\s>]+', '$1<stamp>')
            $normalized = $normalized -replace "`r`n", "`n"
            $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "")
            }
            finally {
                $sha.Dispose()
            }
        }
        else {
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }

        [pscustomobject]@{
            Path = $relative.Replace('\', '/')
            Hash = $hash
        }
    }

    return @($manifest)
}

function Assert-ViewerSnapshot([string]$SourceDirectory, [string]$CandidateDirectory) {
    $source = @(Get-ViewerSnapshotManifest -Directory $SourceDirectory)
    $candidate = @(Get-ViewerSnapshotManifest -Directory $CandidateDirectory)
    $sourceByPath = @{}
    $candidateByPath = @{}
    foreach ($entry in $source) { $sourceByPath[$entry.Path] = $entry.Hash }
    foreach ($entry in $candidate) { $candidateByPath[$entry.Path] = $entry.Hash }

    $problems = New-Object System.Collections.Generic.List[string]
    foreach ($path in $sourceByPath.Keys) {
        if (!$candidateByPath.ContainsKey($path)) {
            $problems.Add("missing: $path")
        }
        elseif ($candidateByPath[$path] -ne $sourceByPath[$path]) {
            $problems.Add("content mismatch: $path")
        }
    }
    foreach ($path in $candidateByPath.Keys) {
        if (!$sourceByPath.ContainsKey($path)) {
            $problems.Add("unexpected: $path")
        }
    }

    if ($problems.Count -gt 0) {
        $summary = ($problems | Select-Object -First 12) -join "; "
        throw "Viewer snapshot verification failed: $summary"
    }

    return [pscustomobject]@{
        FileCount = $source.Count
        SourceDirectory = (Resolve-Path -LiteralPath $SourceDirectory).Path
        CandidateDirectory = (Resolve-Path -LiteralPath $CandidateDirectory).Path
    }
}

function Assert-ViewerSource([string]$SourceDirectory) {
    # These are the minimum production shell, identity/auth, room, media, and Jam
    # assets. Requiring only the Jam files allowed a tiny partial directory to
    # replace the complete runtime while still passing hash parity against itself.
    $requiredFiles = @(
        "index.html",
        "app.js",
        "state.js",
        "settings.js",
        "urls.js",
        "debug.js",
        "identity.js",
        "auth.js",
        "connect.js",
        "room-status.js",
        "audio-routing.js",
        "media-controls.js",
        "participants.js",
        "chat.js",
        "soundboard.js",
        "jam-session-state.js",
        "jam.js",
        "style.css",
        "jam.css",
        "clubhouse-shell.css",
        "layout-policy.js",
        "ui-shell.js",
        "livekit-client.umd.js",
        # Loaded dynamically by rnnoise.js, so index.html reference scanning
        # cannot discover these release-critical assets.
        "rnnoise-processor.js",
        "rnnoise.wasm",
        "rnnoise_simd.wasm",
        # Loaded dynamically by style.css.
        "ultrainstinct.gif"
    )
    foreach ($required in $requiredFiles) {
        $path = Join-Path $SourceDirectory $required
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Viewer source is incomplete; missing $required in $SourceDirectory"
        }
    }

    # Also verify every local script/stylesheet/image referenced by index.html.
    # This catches future assets without requiring this guard to be updated first.
    $index = Get-Content -LiteralPath (Join-Path $SourceDirectory "index.html") -Raw
    $references = [regex]::Matches($index, '(?:src|href)\s*=\s*["'']([^"'']+)["'']')
    foreach ($match in $references) {
        $reference = $match.Groups[1].Value.Split('?', 2)[0].Split('#', 2)[0]
        if ([string]::IsNullOrWhiteSpace($reference) -or
            $reference.StartsWith("http://") -or
            $reference.StartsWith("https://") -or
            $reference.StartsWith("data:") -or
            $reference.StartsWith("//") -or
            $reference.StartsWith("#")) {
            continue
        }
        $localPath = Join-Path $SourceDirectory $reference.TrimStart('/', '\')
        if (!(Test-Path -LiteralPath $localPath -PathType Leaf)) {
            throw "Viewer source is incomplete; index.html references missing asset $reference"
        }
    }
}

function Publish-ViewerRuntimeSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
        [switch]$AllowRunningControl
    )

    Assert-ViewerSource -SourceDirectory $SourceDirectory
    if (!$AllowRunningControl -and (Get-Process -Name "echo-core-control" -ErrorAction SilentlyContinue)) {
        throw "Stop EchoCoreHost/control before swapping the viewer runtime"
    }

    $source = (Resolve-Path -LiteralPath $SourceDirectory).Path.TrimEnd('\', '/')
    $runtime = [IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\', '/')
    if ($source -ieq $runtime) {
        throw "Viewer source and runtime directories must be different"
    }
    $sourcePrefix = $source + [IO.Path]::DirectorySeparatorChar
    $runtimePrefix = $runtime + [IO.Path]::DirectorySeparatorChar
    if ($runtime.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $source.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Viewer source and runtime directories must not contain one another"
    }

    $parent = Split-Path -Parent $runtime
    if (!(Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Viewer runtime parent does not exist: $parent"
    }
    if ((Test-Path -LiteralPath $runtime) -and
        !(Test-Path -LiteralPath $runtime -PathType Container)) {
        throw "Viewer runtime path exists but is not a directory: $runtime"
    }

    $leaf = Split-Path -Leaf $runtime
    $suffix = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    $stage = Join-Path $parent ($leaf + ".stage-" + $suffix)
    $backup = Join-Path $parent ($leaf + ".backup-" + $suffix)

    New-Item -ItemType Directory -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $stage -Recurse -Force
    Assert-ViewerSnapshot -SourceDirectory $source -CandidateDirectory $stage | Out-Null

    $hadRuntime = Test-Path -LiteralPath $runtime -PathType Container
    $priorRuntimeMoved = $false
    $stagePublished = $false
    try {
        if ($hadRuntime) {
            Move-Item -LiteralPath $runtime -Destination $backup
            $priorRuntimeMoved = $true
        }
        Move-Item -LiteralPath $stage -Destination $runtime
        $stagePublished = $true
        $verified = Assert-ViewerSnapshot -SourceDirectory $source -CandidateDirectory $runtime
    }
    catch {
        $publishError = $_
        try {
            # If the stage was already swapped into place, retain it for
            # diagnosis and restore the exact state that existed beforehand.
            # With no prior runtime, rollback means restoring absence.
            if ($stagePublished -and (Test-Path -LiteralPath $runtime)) {
                $failed = Join-Path $parent ($leaf + ".failed-" + $suffix)
                Move-Item -LiteralPath $runtime -Destination $failed
            }
            if ($priorRuntimeMoved) {
                if (!(Test-Path -LiteralPath $backup -PathType Container)) {
                    throw "prior viewer runtime backup is missing: $backup"
                }
                Move-Item -LiteralPath $backup -Destination $runtime
            }
        }
        catch {
            $rollbackException = [InvalidOperationException]::new(
                "Viewer snapshot publish failed ($publishError) and rollback failed: $_",
                $_.Exception
            )
            $rollbackException.Data["ViewerRollbackFailed"] = $true
            throw $rollbackException
        }
        throw $publishError
    }

    return [pscustomobject]@{
        RuntimeDirectory = $runtime
        BackupDirectory = $(if ($hadRuntime) { $backup } else { $null })
        HadRuntime = $hadRuntime
        FileCount = $verified.FileCount
    }
}
