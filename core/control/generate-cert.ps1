param(
  [string]$OutDir = (Join-Path $PSScriptRoot "certs"),
  [string]$DnsName = "echo-core.local",
  [int]$Years = 5
)

if (!(Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$subject = "CN=$DnsName"
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest `
  ($subject, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)

$san = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
$san.AddDnsName($DnsName)
$san.AddDnsName("localhost")
if ($env:COMPUTERNAME) { $san.AddDnsName($env:COMPUTERNAME) }
$req.CertificateExtensions.Add($san.Build())

$notBefore = (Get-Date).AddDays(-1)
$notAfter = (Get-Date).AddYears($Years)
$cert = $req.CreateSelfSigned($notBefore, $notAfter)

$certBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$certPem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($certBytes, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"

$keyBytes = $null
$keyHeader = "PRIVATE KEY"
if ($rsa.PSObject.Methods.Name -contains "ExportPkcs8PrivateKey") {
  $keyBytes = $rsa.ExportPkcs8PrivateKey()
  $keyHeader = "PRIVATE KEY"
} else {
  $keyBytes = $rsa.ExportRSAPrivateKey()
  $keyHeader = "RSA PRIVATE KEY"
}
$keyPem = "-----BEGIN $keyHeader-----`n" + [Convert]::ToBase64String($keyBytes, 'InsertLineBreaks') + "`n-----END $keyHeader-----`n"

$certPath = Join-Path $OutDir "echo-core.pem"
$keyPath = Join-Path $OutDir "echo-core-key.pem"
Set-Content -Path $certPath -Value $certPem -Encoding ascii
Set-Content -Path $keyPath -Value $keyPem -Encoding ascii

Write-Host "Generated TLS cert at $certPath"
Write-Host "Generated TLS key at  $keyPath"
