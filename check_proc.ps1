$ErrorActionPreference = 'SilentlyContinue'
$log = Get-ChildItem "$env:APPDATA\AionUi-Dev\logs" -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$out = @()
$out += "DEVLOG=$($log.FullName)"
$out += "DEVLOG_MTIME=$($log.LastWriteTime)"
$out += "NOW=$(Get-Date)"
$tail = Get-Content $log.FullName -Tail 60 | Where-Object { $_ -notmatch '\[aioncore\]' -and $_ -match 'AionUi|instance|ready|Bridge|registered|error|Error' }
$out += '--- recent non-aioncore dev log ---'
$out += ($tail | Select-Object -Last 25)
$out | Out-File -Encoding utf8 proc.txt
Write-Output 'WROTE'
