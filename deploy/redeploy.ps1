# 重新打包并部署到服务器
param([string]$Remote = "vanmc")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tgz = Join-Path $env:TEMP "checkin-deploy.tgz"
Push-Location $root
tar --exclude=data --exclude=docs --exclude=android --exclude=__pycache__ -czf $tgz server web tests tools
Pop-Location
# 目标机器：用 ssh 配置里的别名（默认 vanmc），可用 -Host 覆盖
scp $tgz "${Remote}:/tmp/checkin-deploy.tgz"
ssh $Remote "tar -xzf /tmp/checkin-deploy.tgz -C /opt/class-checkin && systemctl restart class-checkin && sleep 2 && systemctl is-active class-checkin && tail -3 /opt/class-checkin/data/server.log"
Write-Host "部署完成（服务器：$Remote）" -ForegroundColor Green
