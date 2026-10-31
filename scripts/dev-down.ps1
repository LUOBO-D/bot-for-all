# 本地一键停止：前后端开发服务 + MySQL（便携版）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev-down.ps1

$ErrorActionPreference = 'SilentlyContinue'

function Stop-Port($port, $label) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess
    Write-Host "停止 $label (端口 $port, PID $($c.OwningProcess), $($proc.ProcessName))..." -ForegroundColor Cyan
    Stop-Process -Id $c.OwningProcess -Force
  }
  if (-not $conns) { Write-Host "$label (端口 $port) 未在运行" -ForegroundColor Gray }
}

Stop-Port 5173 '前端'
Stop-Port 3000 '后端'

$mysqld = Get-Process mysqld
if ($mysqld) {
  Write-Host "停止 MySQL (PID $($mysqld.Id -join ','))..." -ForegroundColor Cyan
  $mysqld | Stop-Process -Force
} else {
  Write-Host "MySQL 未在运行" -ForegroundColor Gray
}

Write-Host "已全部停止。" -ForegroundColor Green
