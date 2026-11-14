# Amostra CPU e memoria dos processos node e postgres a cada ~2 s, ate o arquivo de parada existir.
# Uso: powershell -File tests/carga/monitor-windows.ps1 -Saida recursos.csv -Parar parar.txt
# CPU em "nucleos em uso" (1.0 = um nucleo inteiro). Contadores de desempenho do Windows (o tempo de CPU do
# Get-Process nao atualiza de forma confiavel para processos de outra sessao).
param([string]$Saida = 'recursos.csv', [string]$Parar = 'parar.txt')
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
"hora,cpu_maquina_pct,node_nucleos,node_mem_mb,pg_nucleos,pg_mem_mb,pg_procs,mem_livre_mb" | Out-File -Encoding utf8 $Saida
while (-not (Test-Path $Parar)) {
  $rows = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -like 'node*' -or $_.Name -like 'postgres*' }
  $node = $rows | Where-Object Name -like 'node*'
  $pg = $rows | Where-Object Name -like 'postgres*'
  $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
  $nc = (($node | Measure-Object PercentProcessorTime -Sum).Sum) / 100
  $nm = (($node | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB
  $pc = (($pg | Measure-Object PercentProcessorTime -Sum).Sum) / 100
  $pm = (($pg | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB
  "{0},{1},{2:F2},{3:F0},{4:F2},{5:F0},{6},{7}" -f (Get-Date -Format HH:mm:ss), $total, $nc, $nm, $pc, $pm, @($pg).Count, $free | Out-File -Append -Encoding utf8 $Saida
  Start-Sleep -Milliseconds 1500
}
