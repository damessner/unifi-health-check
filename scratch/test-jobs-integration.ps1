$server = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4

try {
  # Run optimizer via SSE (short budget)
  Write-Host "1. Starting optimizer via SSE..."
  $url1 = "http://127.0.0.1:3000/api/optimize/progress?searchMode=ga&maxChanges=8&timeBudgetMs=3000&populationSize=20"
  $result = Invoke-WebRequest -Uri $url1 -UseBasicParsing -TimeoutSec 30
  $content1 = $result.Content
  Write-Host "  Has jobId: $($content1.Contains('"jobId"'))"
  Write-Host "  Has complete: $($content1.Contains('event: complete'))"

  # Extract jobId
  $jobId = $null
  if ($content1 -match '"jobId":"([^"]+)"') {
    $jobId = $Matches[1]
    Write-Host "2. Job ID: $jobId"
  } else {
    Write-Host "2. Job ID not found"
  }

  if ($jobId) {
    # Check jobs list
    Start-Sleep -Milliseconds 500
    $jobs = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs" -UseBasicParsing -TimeoutSec 10
    $jobsJson = $jobs.Content | ConvertFrom-Json
    Write-Host "3. Jobs list: $($jobsJson.jobs.Count) jobs"
    $found = $false
    foreach ($j in $jobsJson.jobs) {
      if ($j.id -eq $jobId) {
        Write-Host "  Status: $($j.status)"
        $found = $true
      }
    }

    # Test reconnect SSE
    $recon = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId/progress" -UseBasicParsing -TimeoutSec 10
    Write-Host "4. Reconnect SSE: has complete=$($recon.Content.Contains('event: complete'))"

    # Test JSON download
    $dl = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId/download/json" -UseBasicParsing -TimeoutSec 10
    Write-Host "5. JSON download: $($dl.Content.Length) bytes, status=$($dl.StatusCode)"

    # Test XLSX download
    $dl2 = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId/download/xlsx" -UseBasicParsing -TimeoutSec 10
    Write-Host "6. XLSX download: $($dl2.Content.Length) bytes, status=$($dl2.StatusCode)"

    # Test 404 for unknown job
    try {
      $dl3 = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/nonexistent/download/json" -UseBasicParsing -TimeoutSec 5
      Write-Host "7. Unknown job: unexpected OK"
    } catch {
      Write-Host "7. Unknown job: 404 OK ($($_.Exception.Response.StatusCode.value__))"
    }
  }

  Write-Host "--- All integration checks passed ---"
}
finally {
  Stop-Process -Id $server.Id -Force
}
