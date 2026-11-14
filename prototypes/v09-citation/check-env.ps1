$k = [Environment]::GetEnvironmentVariable('TEST_API_KEY','User')
if ($k) {
    Write-Output ("len=" + $k.Length)
} else {
    Write-Output "NOTSET"
}
