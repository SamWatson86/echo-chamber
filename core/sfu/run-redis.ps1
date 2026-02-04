$existing = docker ps --filter "name=echo-redis" --format "{{.ID}}" 2>$null
if ($existing) {
  Write-Host "echo-redis already running ($existing)" -ForegroundColor Green
  exit 0
}
$stopped = docker ps -a --filter "name=echo-redis" --format "{{.ID}}" 2>$null
if ($stopped) {
  docker start echo-redis | Out-Null
  Write-Host "echo-redis started" -ForegroundColor Green
  exit 0
}

docker run --name echo-redis -p 6379:6379 -d redis:7-alpine | Out-Null
Write-Host "echo-redis started" -ForegroundColor Green
