param(
  [switch]$Remove
)

$rules = @(
  @{ Name = "Echo Core Control TCP 9443"; Protocol = "TCP"; Ports = "9443" },
  @{ Name = "Echo Core Signal TCP 7880"; Protocol = "TCP"; Ports = "7880" },
  @{ Name = "Echo Core RTC TCP 7881"; Protocol = "TCP"; Ports = "7881" },
  @{ Name = "Echo Core RTC UDP 50200-50299"; Protocol = "UDP"; Ports = "50200-50299" }
)

if ($Remove) {
  foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  }
  Write-Host "Echo Core firewall rules removed."
  exit 0
}

foreach ($r in $rules) {
  if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) { continue }
  New-NetFirewallRule -DisplayName $r.Name `
    -Direction Inbound -Action Allow -Protocol $r.Protocol -LocalPort $r.Ports -Profile Any | Out-Null
}

Write-Host "Echo Core firewall rules added."
