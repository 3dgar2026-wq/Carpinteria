$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$stage = 'initialization'
$failureCode = $null
$tempPath = $null
$rng = $null
$generated = @{}

function Set-Failure([string]$code) {
  $script:failureCode = $code
  throw [InvalidOperationException]::new($code)
}

function Read-EnvValue([string]$content, [string]$name) {
  $pattern = '(?m)^[ \t]*(?:export[ \t]+)?' + [Regex]::Escape($name) + '[ \t]*=([^\r\n]*)'
  $matches = [Regex]::Matches($content, $pattern)
  if ($matches.Count -gt 1) { Set-Failure 'DUPLICATE_ENV_ASSIGNMENT' }
  if ($matches.Count -eq 0) { return $null }
  $value = $matches[0].Groups[1].Value.Trim()
  if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function New-HexKey {
  $bytes = New-Object byte[] 32
  try {
    $rng.GetBytes($bytes)
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Get-SafeFailureCode([Exception]$exception) {
  if ($script:failureCode) { return $script:failureCode }
  if ($exception -is [UnauthorizedAccessException]) { return 'ACCESS_DENIED' }
  if ($exception -is [IO.FileNotFoundException]) { return 'FILE_NOT_FOUND' }
  if ($exception -is [IO.DirectoryNotFoundException]) { return 'DIRECTORY_NOT_FOUND' }
  if ($exception -is [IO.IOException]) { return 'FILE_OPERATION_FAILED' }
  if ($exception -is [Text.DecoderFallbackException]) { return 'ENV_ENCODING_INVALID' }
  if ($exception -is [ArgumentException]) { return 'INVALID_PATH_OR_ARGUMENT' }
  if ($exception -is [PlatformNotSupportedException]) { return 'ATOMIC_REPLACE_UNSUPPORTED' }
  if ($exception -is [Management.Automation.CommandNotFoundException]) { return 'GIT_NOT_AVAILABLE' }
  return 'UNEXPECTED_LOCAL_ERROR'
}

try {
  $stage = 'validate_env_file'
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { Set-Failure 'ENV_FILE_MISSING' }
  $envItem = Get-Item -LiteralPath $envPath -Force
  if (($envItem.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { Set-Failure 'ENV_FILE_READ_ONLY' }

  $stage = 'validate_git_ignore'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Set-Failure 'GIT_NOT_AVAILABLE' }
  & git -C $projectRoot check-ignore --quiet -- .env 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Set-Failure 'ENV_FILE_NOT_GIT_IGNORED' }

  $stage = 'read_and_validate_env'
  $originalBytes = [IO.File]::ReadAllBytes($envPath)
  $hasUtf8Bom = $originalBytes.Length -ge 3 -and $originalBytes[0] -eq 0xEF -and $originalBytes[1] -eq 0xBB -and $originalBytes[2] -eq 0xBF
  $utf8Strict = [Text.UTF8Encoding]::new($hasUtf8Bom, $true)
  try { $content = $utf8Strict.GetString($originalBytes) }
  catch [Text.DecoderFallbackException] { Set-Failure 'ENV_ENCODING_INVALID' }
  if ($hasUtf8Bom) { $content = $content.Substring(1) }

  $keyNames = @('EMAIL_ENCRYPTION_KEY', 'EMAIL_LOOKUP_KEY', 'PASSWORD_RECOVERY_KEY')
  foreach ($name in ($keyNames + @('ADMIN_RATE_LIMIT_KEY'))) {
    $null = Read-EnvValue $content $name
  }
  foreach ($name in $keyNames) {
    $existing = Read-EnvValue $content $name
    if (-not [string]::IsNullOrEmpty($existing)) { Set-Failure 'REFUSING_TO_OVERWRITE_EXISTING_KEY' }
    $processValue = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [string]::IsNullOrEmpty($processValue)) { Set-Failure 'PROCESS_ENVIRONMENT_OVERRIDE_PRESENT' }
  }

  $rateLimitKey = Read-EnvValue $content 'ADMIN_RATE_LIMIT_KEY'
  $processRateLimitKey = [Environment]::GetEnvironmentVariable('ADMIN_RATE_LIMIT_KEY', 'Process')
  if ($processRateLimitKey -and $rateLimitKey -and $processRateLimitKey -cne $rateLimitKey) { Set-Failure 'PROCESS_ENVIRONMENT_OVERRIDE_PRESENT' }
  if ($processRateLimitKey -and -not $rateLimitKey) { Set-Failure 'PROCESS_ENVIRONMENT_OVERRIDE_PRESENT' }
  if ($rateLimitKey -and ($rateLimitKey -notmatch '^[a-fA-F0-9]{64,}$' -or $rateLimitKey.Length % 2 -ne 0)) {
    Set-Failure 'ADMIN_RATE_LIMIT_KEY_FORMAT_INVALID'
  }
  if (-not $rateLimitKey) { $keyNames += 'ADMIN_RATE_LIMIT_KEY' }

  $stage = 'validate_write_targets'
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $backupPath = $envPath + '.backup-' + $stamp + '-' + [Guid]::NewGuid().ToString('N')
  $tempPath = $envPath + '.tmp-' + [Guid]::NewGuid().ToString('N')
  if (Test-Path -LiteralPath $backupPath) { Set-Failure 'BACKUP_PATH_COLLISION' }
  if (Test-Path -LiteralPath $tempPath) { Set-Failure 'TEMP_PATH_COLLISION' }

  $stage = 'generate_keys_in_memory'
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  foreach ($name in $keyNames) {
    do { $candidate = New-HexKey }
    while (@($generated.Values) -contains $candidate -or ($rateLimitKey -and $candidate -ceq $rateLimitKey))
    $generated[$name] = $candidate
  }
  if (-not $rateLimitKey) {
    do { $candidate = New-HexKey }
    while (@($generated.Values) -contains $candidate)
    $generated['ADMIN_RATE_LIMIT_KEY'] = $candidate
  }

  $stage = 'prepare_candidate'
  $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  foreach ($name in $generated.Keys) {
    $line = $name + '=' + $generated[$name]
    $pattern = '(?m)^[ \t]*(?:export[ \t]+)?' + [Regex]::Escape($name) + '[ \t]*=[^\r\n]*'
    if ([Regex]::IsMatch($content, $pattern)) {
      $content = [Regex]::Replace($content, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $line }, 1)
    } else {
      if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += $newline }
      $content += $line + $newline
    }
  }
  foreach ($name in ($keyNames + @('ADMIN_RATE_LIMIT_KEY'))) {
    $candidateValue = Read-EnvValue $content $name
    if (-not $candidateValue -or $candidateValue -notmatch '^[a-fA-F0-9]{64}$') { Set-Failure 'CANDIDATE_VALIDATION_FAILED' }
  }
  $candidateBytes = $utf8Strict.GetBytes($content)
  if ($hasUtf8Bom) {
    $withBom = New-Object byte[] ($candidateBytes.Length + 3)
    $withBom[0] = 0xEF; $withBom[1] = 0xBB; $withBom[2] = 0xBF
    [Array]::Copy($candidateBytes, 0, $withBom, 3, $candidateBytes.Length)
    $candidateBytes = $withBom
  }

  $stage = 'write_and_verify_temporary_file'
  [IO.File]::WriteAllBytes($tempPath, $candidateBytes)
  $writtenBytes = [IO.File]::ReadAllBytes($tempPath)
  $sameLength = $candidateBytes.Length -eq $writtenBytes.Length
  if ($sameLength) {
    for ($i = 0; $i -lt $candidateBytes.Length; $i++) {
      if ($candidateBytes[$i] -ne $writtenBytes[$i]) { $sameLength = $false; break }
    }
  }
  if (-not $sameLength) { Set-Failure 'TEMPORARY_FILE_VERIFICATION_FAILED' }

  $stage = 'atomic_replace_and_backup'
  [IO.File]::Replace($tempPath, $envPath, $backupPath)
  $tempPath = $null
  [Console]::WriteLine('Claves generadas y guardadas en .env; los valores no se mostraron.')
} catch {
  $safeCode = Get-SafeFailureCode $_.Exception
  [Console]::Error.WriteLine(('No se completó la generación de claves. Etapa: {0}. Causa: {1}. No se mostraron valores secretos.' -f $stage, $safeCode))
  exit 1
} finally {
  if ($tempPath -and (Test-Path -LiteralPath $tempPath)) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
  if ($generated) { $generated.Clear() }
  if ($rng) { $rng.Dispose() }
}
