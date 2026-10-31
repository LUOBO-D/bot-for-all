# 本地一键启动：MySQL（便携版）+ 前后端开发服务 + 打开浏览器
# 用法：右键「使用 PowerShell 运行」，或在终端执行 powershell -ExecutionPolicy Bypass -File scripts\dev-up.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$MySqlHome = 'C:\dev\mysql-8.4.0-winx64'
$MySqlData = 'C:\dev\mysql-data'

function Test-Port($port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Port 3306)) {
  if (-not (Test-Path $MySqlHome)) {
    Write-Host "未找到 MySQL 便携版：$MySqlHome" -ForegroundColor Red
    Write-Host "请先按 DEMO 文档 §5 下载解压，或改用 Docker 路线。" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "启动 MySQL..." -ForegroundColor Cyan
  Start-Process -WindowStyle Hidden -FilePath "$MySqlHome\bin\mysqld.exe" `
    -ArgumentList "--basedir=$MySqlHome", "--datadir=$MySqlData", "--port=3306"
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Port 3306)) {
    if ((Get-Date) -gt $deadline) { Write-Host "MySQL 60 秒内未就绪" -ForegroundColor Red; exit 1 }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "MySQL 已就绪 (3306)" -ForegroundColor Green
} else {
  Write-Host "MySQL 已在运行 (3306)" -ForegroundColor Green
}

if (Test-Port 3000 -or Test-Port 5173) {
  Write-Host "后端(3000)或前端(5173)已在运行，跳过启动。" -ForegroundColor Yellow
} else {
  Write-Host "启动前后端开发服务..." -ForegroundColor Cyan
  Start-Process -WorkingDirectory $Root -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "pnpm dev"
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Port 3000)) {
    if ((Get-Date) -gt $deadline) { Write-Host "后端 90 秒内未就绪，请查看新开的窗口日志" -ForegroundColor Red; exit 1 }
    Start-Sleep -Milliseconds 800
  }
  Write-Host "后端已就绪 (3000)" -ForegroundColor Green
}

Write-Host ""
Write-Host "前端： http://localhost:5173" -ForegroundColor Green
Write-Host "后端： http://127.0.0.1:3000/api/health" -ForegroundColor Green
Write-Host "管理员账号：见 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD" -ForegroundColor Gray
Start-Process "http://localhost:5173"
