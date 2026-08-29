param(
  [string]$Package = 'com.sarafy.catalog',
  [switch]$MeasureStartup
)

$ErrorActionPreference = 'Stop'
$adb = (Get-Command adb -ErrorAction Stop).Source
$devices = @(& $adb devices | Select-String "`tdevice$")
if ($devices.Count -ne 1) {
  throw "Expected exactly one authorized Android device; found $($devices.Count)."
}

Write-Output '=== Package version ==='
& $adb shell dumpsys package $Package | Select-String 'versionCode=|versionName=|firstInstallTime=|lastUpdateTime='

if ($MeasureStartup) {
  Write-Output '=== Cold startup ==='
  & $adb shell am force-stop $Package
  & $adb shell am start -W "$Package/.MainActivity"
}

Write-Output '=== Memory ==='
& $adb shell dumpsys meminfo $Package

Write-Output '=== Graphics ==='
& $adb shell dumpsys gfxinfo $Package

Write-Output '=== Package info ==='
& $adb shell dumpsys package $Package
