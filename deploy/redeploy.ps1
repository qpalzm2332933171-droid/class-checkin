# 重新打包并部署到服务器
param([string]$Remote = "vanmc")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tgz = Join-Path $env:TEMP "checkin-deploy.tgz"

# 部署前先看服务器磁盘：2026-09-25 那次 26.5GB 日志把 28G 磁盘写到 100%，
# 拖了两天才被发现。这里 90% 就直接停手，别把最后一点空间也折腾没了。
$pctRaw = ssh $Remote "df --output=pcent / | tail -1"
$usage = [int](($pctRaw -join "") -replace "[^0-9]", "")
if ($usage -ge 90) {
    Write-Host "服务器磁盘已经用到 $usage%，先清理再部署" -ForegroundColor Red
    Write-Host "  看哪里大：du -x -d1 / | sort -rh | head" -ForegroundColor Yellow
    Write-Host "  日志：journalctl --disk-usage（上限 200M，归 journald 管）" -ForegroundColor Yellow
    exit 1
}
Write-Host "服务器磁盘占用 $usage%" -ForegroundColor DarkGray

Push-Location $root
tar --exclude=data --exclude=docs --exclude=android --exclude=__pycache__ -czf $tgz server web tests tools
Pop-Location
# 目标机器：用 ssh 配置里的别名（默认 vanmc），可用 -Remote 覆盖
scp $tgz "${Remote}:/tmp/checkin-deploy.tgz"
# 日志现在归 journald（SystemMaxUse=200M 封顶），不再写 data/server.log —— 那个文件
# 以前没有轮转，长到了 26.5GB。看日志：journalctl -u class-checkin -n 50
ssh $Remote "tar -xzf /tmp/checkin-deploy.tgz -C /opt/class-checkin && systemctl restart class-checkin && sleep 2 && systemctl is-active class-checkin && journalctl -u class-checkin -n 4 --no-pager"

# 部署后再确认一遍：磁盘没满、日志在 journal 里、服务活着
ssh $Remote "df --output=pcent / | tail -1"
Write-Host "部署完成（服务器：$Remote）" -ForegroundColor Green
# 结束
