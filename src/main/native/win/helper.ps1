# TrayPulse Windows helper.
# Long-running process that speaks JSON lines over stdin/stdout:
#   request : {"id": 1, "cmd": "audio.listDevices", "args": {...}}
#   response: {"id": 1, "ok": true, "result": ...} / {"id": 1, "ok": false, "error": "..."}
# Must run in Windows PowerShell 5.1 (powershell.exe) because it uses WinRT projections.
param([string]$Mode = 'all')

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Compile the C# helpers in memory. (Caching a DLL on disk is avoided on purpose:
# Smart App Control / WDAC blocks loading unsigned DLLs written by the app.)
$src = Join-Path $PSScriptRoot 'TrayPulseNative.cs'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($src))

# ---------------------------------------------------------------- WinRT (BLE GATT Battery Service)
$script:winrtReady = $false
function Initialize-WinRT {
    if ($script:winrtReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    $null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    $script:winrtReady = $true
}

function Wait-Async($op, [Type]$type, [int]$timeoutMs = 4000) {
    $task = $script:asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait($timeoutMs)) { throw 'timeout' }
    return $task.Result
}

$BatteryService = [Guid]'0000180f-0000-1000-8000-00805f9b34fb'
$BatteryLevelChar = [Guid]'00002a19-0000-1000-8000-00805f9b34fb'

function Get-BleBatteries([bool]$uncached) {
    Initialize-WinRT
    $out = New-Object System.Collections.Generic.List[object]
    $selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true)
    $props = New-Object System.Collections.Generic.List[string]
    $props.Add('System.Devices.Aep.ContainerId')
    $infos = Wait-Async ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector, $props)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    $cacheMode = if ($uncached) { [Windows.Devices.Bluetooth.BluetoothCacheMode]::Uncached } else { [Windows.Devices.Bluetooth.BluetoothCacheMode]::Cached }
    foreach ($info in $infos) {
        $dev = $null
        try {
            $dev = Wait-Async ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($info.Id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
            if ($null -eq $dev) { continue }
            $connected = $dev.ConnectionStatus -eq [Windows.Devices.Bluetooth.BluetoothConnectionStatus]::Connected
            # Only wake the radio for devices that are actually connected.
            $mode = if ($connected) { $cacheMode } else { [Windows.Devices.Bluetooth.BluetoothCacheMode]::Cached }
            $svcRes = Wait-Async ($dev.GetGattServicesForUuidAsync($BatteryService, $mode)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])
            if ($svcRes.Status -ne 'Success' -or $svcRes.Services.Count -eq 0) { continue }
            $levels = @()
            foreach ($svc in $svcRes.Services) {
                $chRes = Wait-Async ($svc.GetCharacteristicsForUuidAsync($BatteryLevelChar, $mode)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
                foreach ($ch in $chRes.Characteristics) {
                    $read = Wait-Async ($ch.ReadValueAsync($mode)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadResult])
                    if ($read.Status -eq 'Success' -and $read.Value.Length -ge 1) {
                        $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($read.Value)
                        $levels += [int]$reader.ReadByte()
                    }
                }
                $svc.Dispose()
            }
            if ($levels.Count -eq 0) { continue }
            $container = $info.Properties['System.Devices.Aep.ContainerId']
            $item = @{
                containerId = if ($container) { $container.ToString() } else { $null }
                name        = $dev.Name
                address     = ('{0:X12}' -f $dev.BluetoothAddress)
                connected   = if ($connected) { 1 } else { 0 }
                level       = $levels[0]
                # Some devices (e.g. split keyboards, earbuds) expose several battery services.
                levels      = $levels
                appearance  = [int]$dev.Appearance.Category
            }
            $out.Add($item)
        } catch {
            # Device unreachable / access denied: skip silently.
        } finally {
            if ($dev) { $dev.Dispose() }
        }
    }
    return , $out
}

function Write-Response($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

Write-Response @{ id = 0; ok = $true; result = 'ready' }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim([char]0xFEFF, ' ', [char]9)
    if ($line -eq '') { continue }
    $req = $null
    try {
        $req = $line | ConvertFrom-Json
        $a = $req.args
        $res = $null
        switch ($req.cmd) {
            'ping' { $res = 'pong' }
            'battery.pnp' { $res = [TrayPulse.BtBattery]::Read() }
            'battery.ble' { $res = Get-BleBatteries ([bool]$a.uncached) }
            'audio.listDevices' { $res = [TrayPulse.Audio]::ListDevices([int]$a.flow) }
            'audio.setDefault' { [TrayPulse.Audio]::SetDefault([string]$a.id); $res = $true }
            'audio.getEndpoint' { $res = [TrayPulse.Audio]::GetEndpoint([int]$a.flow) }
            'audio.setEndpointVolume' { [TrayPulse.Audio]::SetEndpointVolume([int]$a.flow, [float]$a.volume); $res = $true }
            'audio.setEndpointMute' { $res = [TrayPulse.Audio]::SetEndpointMute([int]$a.flow, [int]$a.mode) }
            'audio.listSessions' { $res = [TrayPulse.Audio]::ListSessions() }
            'audio.setSessionVolume' { [TrayPulse.Audio]::SetSessionVolume([string]$a.key, [float]$a.volume); $res = $true }
            'audio.setSessionMute' { [TrayPulse.Audio]::SetSessionMute([string]$a.key, [bool]$a.muted); $res = $true }
            default { throw "unknown command: $($req.cmd)" }
        }
        Write-Response @{ id = $req.id; ok = $true; result = $res }
    } catch {
        $id = if ($req) { $req.id } else { -1 }
        Write-Response @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}

