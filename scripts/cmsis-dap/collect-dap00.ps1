[CmdletBinding()]
param(
    [string]$OutputPath
)

# DAP-00 safety boundary
# - This script is a host-side collector only. It uses Windows PnP/SetupAPI/HID APIs.
# - It does not load J-Link, OpenOCD, a GDB server, or any vendor command-line tool.
# - The CMSIS-DAP protocol operation is DAP_Info only.
# - It does not call DAP_Connect, SWJ_Pins, SWJ_Clock, reset, halt, run, step,
#   breakpoint, target memory/register access, flash, erase, or verify.
# - Unreadable values are emitted as the literal string UNVERIFIED; no value is guessed.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$statusConfirmed = -join ([char[]](0x5DF2, 0x786E, 0x8BA4))
$statusUnverified = -join ([char[]](0x672A, 0x9A8C, 0x8BC1))
$statusUnreadable = -join ([char[]](0x65E0, 0x6CD5, 0x8BFB, 0x53D6))
$statusPendingHardware = -join ([char[]](0x5F85, 0x786C, 0x4EF6, 0x786E, 0x8BA4))

$vid = 0xC251
$targetPid = 0xF001
$collectionTime = Get-Date

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $stamp = $collectionTime.ToString('yyyyMMdd-HHmmss')
    $OutputPath = Join-Path (Join-Path $PSScriptRoot '..\..\outputs\dap00') "collect-dap00-$stamp.json"
}

function Convert-ToSafeValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return 'UNVERIFIED'
    }

    if ($Value -is [Array]) {
        $items = @($Value | ForEach-Object { if ($null -eq $_) { 'UNVERIFIED' } else { $_.ToString() } })
        if ($items.Count -eq 0) {
            return 'UNVERIFIED'
        }
        return $items
    }

    $text = $Value.ToString()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return 'UNVERIFIED'
    }
    return $text
}

function Get-PnpPropertySafe {
    param(
        [string]$InstanceId,
        [string]$KeyName
    )

    try {
        $property = Get-PnpDeviceProperty -InstanceId $InstanceId -KeyName $KeyName -ErrorAction Stop
        return Convert-ToSafeValue $property.Data
    } catch {
        return 'UNVERIFIED'
    }
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CmsisDap00Native
{
    private static readonly Guid HidGuid = new Guid("4d1e55b2-f16f-11cf-88cb-001111000030");
    private const uint DigcfPresent = 0x00000002;
    private const uint DigcfDeviceInterface = 0x00000010;
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int ErrorIoPending = 997;
    private const int HidpStatusSuccess = 0x00110000;

    [StructLayout(LayoutKind.Sequential)]
    private struct SpDeviceInterfaceData
    {
        public int CbSize;
        public Guid InterfaceClassGuid;
        public int Flags;
        public IntPtr Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HiddAttributes
    {
        public int Size;
        public ushort VendorId;
        public ushort ProductId;
        public ushort VersionNumber;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HidpCaps
    {
        public ushort Usage;
        public ushort UsagePage;
        public ushort InputReportByteLength;
        public ushort OutputReportByteLength;
        public ushort FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberLinkCollectionNodes;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberInputButtonCaps;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberInputValueCaps;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberInputDataIndices;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberOutputButtonCaps;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberOutputValueCaps;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberOutputDataIndices;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberFeatureButtonCaps;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberFeatureValueCaps;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] NumberFeatureDataIndices;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Overlapped
    {
        public IntPtr Internal;
        public IntPtr InternalHigh;
        public uint Offset;
        public uint OffsetHigh;
        public IntPtr Event;
    }

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_GetAttributes(IntPtr handle, ref HiddAttributes attributes);

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_GetManufacturerString(IntPtr handle, byte[] buffer, int bufferLength);

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_GetProductString(IntPtr handle, byte[] buffer, int bufferLength);

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_GetSerialNumberString(IntPtr handle, byte[] buffer, int bufferLength);

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_GetPreparsedData(IntPtr handle, out IntPtr preparsedData);

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_FreePreparsedData(IntPtr preparsedData);

    [DllImport("hid.dll")]
    private static extern int HidP_GetCaps(IntPtr preparsedData, out HidpCaps capabilities);

    [DllImport("hid.dll", SetLastError = true)]
    private static extern bool HidD_SetOutputReport(IntPtr handle, byte[] buffer, int bufferLength);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr hwndParent, uint flags);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiEnumDeviceInterfaces(IntPtr deviceInfoSet, IntPtr deviceInfoData, ref Guid interfaceClassGuid, uint memberIndex, ref SpDeviceInterfaceData interfaceData);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr deviceInfoSet, ref SpDeviceInterfaceData interfaceData, IntPtr detailData, int detailDataSize, out int requiredSize, IntPtr deviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateEvent(IntPtr securityAttributes, bool manualReset, bool initialState, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint bytesToRead, IntPtr bytesRead, ref Overlapped overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetOverlappedResult(SafeFileHandle handle, ref Overlapped overlapped, out uint bytesTransferred, bool wait);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CancelIoEx(SafeFileHandle handle, ref Overlapped overlapped);

    private static string ReadHidString(IntPtr handle, Func<IntPtr, byte[], int, bool> reader)
    {
        byte[] buffer = new byte[256];
        if (!reader(handle, buffer, buffer.Length))
            return "UNVERIFIED";
        string value = System.Text.Encoding.Unicode.GetString(buffer).TrimEnd('\0');
        return string.IsNullOrWhiteSpace(value) ? "UNVERIFIED" : value;
    }

    private static string ToHex(byte[] buffer, uint length)
    {
        int count = (int)Math.Min(length, (uint)buffer.Length);
        string value = "";
        for (int i = 0; i < count; i++)
        {
            if (i != 0) value += " ";
            value += buffer[i].ToString("X2");
        }
        return value;
    }

    private static object QueryInfo(SafeFileHandle handle, byte infoId, string name, int timeoutMs)
    {
        byte[] request = new byte[65];
        request[2] = infoId;
        bool outputOk = HidD_SetOutputReport(handle.DangerousGetHandle(), request, request.Length);
        int outputError = outputOk ? 0 : Marshal.GetLastWin32Error();
        byte[] response = new byte[65];
        uint bytesRead = 0;
        bool readOk = false;
        int readError = 0;
        uint waitResult = 0xffffffff;
        IntPtr eventHandle = CreateEvent(IntPtr.Zero, true, false, null);
        if (eventHandle == IntPtr.Zero)
        {
            readError = Marshal.GetLastWin32Error();
        }
        else
        {
            try
            {
                Overlapped overlapped = new Overlapped { Event = eventHandle };
                if (outputOk)
                {
                    readOk = ReadFile(handle, response, (uint)response.Length, IntPtr.Zero, ref overlapped);
                    int firstError = readOk ? 0 : Marshal.GetLastWin32Error();
                    if (!readOk && firstError == ErrorIoPending)
                    {
                        waitResult = WaitForSingleObject(eventHandle, (uint)timeoutMs);
                        if (waitResult == WaitObject0)
                        {
                            readOk = GetOverlappedResult(handle, ref overlapped, out bytesRead, false);
                            if (!readOk) readError = Marshal.GetLastWin32Error();
                        }
                        else
                        {
                            readError = waitResult == WaitTimeout ? 258 : Marshal.GetLastWin32Error();
                            CancelIoEx(handle, ref overlapped);
                        }
                    }
                    else if (readOk)
                    {
                        readOk = GetOverlappedResult(handle, ref overlapped, out bytesRead, false);
                        if (!readOk) readError = Marshal.GetLastWin32Error();
                    }
                    else
                    {
                        readError = firstError;
                    }
                }
            }
            finally
            {
                CloseHandle(eventHandle);
            }
        }

        string status = "\u65e0\u6cd5\u8bfb\u53d6";
        string value = "UNVERIFIED";
        int payloadLength = -1;
        if (readOk && bytesRead >= 3 && response[1] == 0)
        {
            payloadLength = response[2];
            if (payloadLength >= 0 && payloadLength <= bytesRead - 3 && payloadLength != 0xff)
            {
                if (payloadLength == 0)
                {
                    status = "\u672a\u9a8c\u8bc1";
                }
                else if (infoId == 0x0a && payloadLength == 1)
                {
                    value = "0x" + response[3].ToString("X2");
                    status = "\u5df2\u786e\u8ba4";
                }
                else if (infoId == 0x0e && payloadLength == 1)
                {
                    value = response[3].ToString();
                    status = "\u5df2\u786e\u8ba4";
                }
                else if (infoId == 0x0f && payloadLength == 2)
                {
                    value = (response[3] | (response[4] << 8)).ToString();
                    status = "\u5df2\u786e\u8ba4";
                }
                else
                {
                    value = System.Text.Encoding.ASCII.GetString(response, 3, payloadLength).TrimEnd('\0');
                    value = string.IsNullOrWhiteSpace(value) ? "UNVERIFIED" : value;
                    status = value == "UNVERIFIED" ? "\u672a\u9a8c\u8bc1" : "\u5df2\u786e\u8ba4";
                }
            }
        }

        return new
        {
            InfoId = "0x" + infoId.ToString("X2"),
            Name = name,
            Value = value,
            Status = status,
            OutputOk = outputOk,
            OutputError = outputError,
            ReadOk = readOk,
            ReadError = readError,
            WaitResult = waitResult,
            PayloadLength = payloadLength,
            RawResponse = ToHex(response, bytesRead)
        };
    }

    public static object[] Collect(ushort wantedVid, ushort wantedPid, int timeoutMs)
    {
        List<object> devices = new List<object>();
        Guid hidGuid = HidGuid;
        IntPtr deviceInfoSet = SetupDiGetClassDevs(ref hidGuid, IntPtr.Zero, IntPtr.Zero, DigcfPresent | DigcfDeviceInterface);
        if (deviceInfoSet == new IntPtr(-1))
            return devices.ToArray();

        try
        {
            for (uint index = 0; ; index++)
            {
                SpDeviceInterfaceData interfaceData = new SpDeviceInterfaceData { CbSize = Marshal.SizeOf(typeof(SpDeviceInterfaceData)) };
                hidGuid = HidGuid;
                if (!SetupDiEnumDeviceInterfaces(deviceInfoSet, IntPtr.Zero, ref hidGuid, index, ref interfaceData))
                {
                    if (Marshal.GetLastWin32Error() == 259) break;
                    continue;
                }

                int requiredSize;
                SetupDiGetDeviceInterfaceDetail(deviceInfoSet, ref interfaceData, IntPtr.Zero, 0, out requiredSize, IntPtr.Zero);
                IntPtr detail = Marshal.AllocHGlobal(requiredSize);
                try
                {
                    Marshal.Copy(new byte[requiredSize], 0, detail, requiredSize);
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 4);
                    if (!SetupDiGetDeviceInterfaceDetail(deviceInfoSet, ref interfaceData, detail, requiredSize, out requiredSize, IntPtr.Zero))
                        continue;

                    string path = Marshal.PtrToStringAnsi(IntPtr.Add(detail, 4));
                    if (path == null || path.IndexOf("VID_" + wantedVid.ToString("X4") + "&PID_" + wantedPid.ToString("X4"), StringComparison.OrdinalIgnoreCase) < 0)
                        continue;

                    using (SafeFileHandle handle = CreateFile(path, GenericRead, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, FileFlagOverlapped, IntPtr.Zero))
                    {
                        if (handle == null || handle.IsInvalid)
                        {
                            devices.Add(new { Status = "\u65e0\u6cd5\u8bfb\u53d6", DevicePath = path, Error = "UNVERIFIED" });
                            continue;
                        }

                        HiddAttributes attributes = new HiddAttributes { Size = Marshal.SizeOf(typeof(HiddAttributes)) };
                        if (!HidD_GetAttributes(handle.DangerousGetHandle(), ref attributes))
                        {
                            devices.Add(new { Status = "\u65e0\u6cd5\u8bfb\u53d6", DevicePath = path, Error = "UNVERIFIED" });
                            continue;
                        }

                        ushort inputLength = 0;
                        ushort outputLength = 0;
                        ushort featureLength = 0;
                        int capsStatus = 0;
                        IntPtr preparsedData;
                        if (HidD_GetPreparsedData(handle.DangerousGetHandle(), out preparsedData))
                        {
                            try
                            {
                                HidpCaps capabilities;
                                capsStatus = HidP_GetCaps(preparsedData, out capabilities);
                                if (capsStatus == HidpStatusSuccess)
                                {
                                    inputLength = capabilities.InputReportByteLength;
                                    outputLength = capabilities.OutputReportByteLength;
                                    featureLength = capabilities.FeatureReportByteLength;
                                }
                            }
                            finally
                            {
                                HidD_FreePreparsedData(preparsedData);
                            }
                        }

                        object[] info = new object[]
                        {
                            QueryInfo(handle, 0x01, "Vendor", timeoutMs),
                            QueryInfo(handle, 0x02, "Product", timeoutMs),
                            QueryInfo(handle, 0x03, "Serial", timeoutMs),
                            QueryInfo(handle, 0x04, "ProtocolVersion", timeoutMs),
                            QueryInfo(handle, 0x09, "FirmwareVersion", timeoutMs),
                            QueryInfo(handle, 0x0a, "Capabilities", timeoutMs),
                            QueryInfo(handle, 0x0e, "PacketCount", timeoutMs),
                            QueryInfo(handle, 0x0f, "PacketSize", timeoutMs)
                        };

                        devices.Add(new
                        {
                            Status = "\u5df2\u786e\u8ba4",
                            DevicePath = path,
                            Vid = attributes.VendorId.ToString("X4"),
                            Pid = attributes.ProductId.ToString("X4"),
                            HidVersionField = "0x" + attributes.VersionNumber.ToString("X4"),
                            Manufacturer = ReadHidString(handle.DangerousGetHandle(), HidD_GetManufacturerString),
                            Product = ReadHidString(handle.DangerousGetHandle(), HidD_GetProductString),
                            Serial = ReadHidString(handle.DangerousGetHandle(), HidD_GetSerialNumberString),
                            InputReportByteLength = inputLength == 0 ? "UNVERIFIED" : inputLength.ToString(),
                            OutputReportByteLength = outputLength == 0 ? "UNVERIFIED" : outputLength.ToString(),
                            FeatureReportByteLength = featureLength == 0 ? "UNVERIFIED" : featureLength.ToString(),
                            HidPCapsStatus = capsStatus == HidpStatusSuccess ? "\u5df2\u786E\u8BA4" : "\u65E0\u6CD5\u8BFB\u53D6",
                            CmsisDapInfo = info
                        });
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(detail);
                }
            }
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(deviceInfoSet);
        }

        return devices.ToArray();
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp

$pnpDevices = @(
    Get-PnpDevice -PresentOnly -ErrorAction Stop |
        Where-Object { $_.InstanceId -like 'USB\VID_C251&PID_F001*' }
)

$pnpRows = @(
    foreach ($device in $pnpDevices) {
        $service = Get-PnpPropertySafe $device.InstanceId 'DEVPKEY_Device_Service'
        $compatibleIds = Get-PnpPropertySafe $device.InstanceId 'DEVPKEY_Device_CompatibleIds'
        $interfaceKind = 'UNVERIFIED'
        if ($device.InstanceId -like '*&MI_00*') { $interfaceKind = 'CDC' }
        if ($device.InstanceId -like '*&MI_02*') { $interfaceKind = 'HID' }

        [pscustomobject]@{
            Status = if ($device.Status -eq 'OK') { $statusConfirmed } else { $statusUnverified }
            Interface = $interfaceKind
            Class = Convert-ToSafeValue $device.Class
            FriendlyName = Convert-ToSafeValue $device.FriendlyName
            InstanceId = Convert-ToSafeValue $device.InstanceId
            DeviceStatus = Convert-ToSafeValue $device.Status
            Problem = Convert-ToSafeValue $device.Problem
            Service = $service
            BusReportedDeviceDescription = Get-PnpPropertySafe $device.InstanceId 'DEVPKEY_Device_BusReportedDeviceDesc'
            Manufacturer = Get-PnpPropertySafe $device.InstanceId 'DEVPKEY_Device_Manufacturer'
            HardwareIds = Get-PnpPropertySafe $device.InstanceId 'DEVPKEY_Device_HardwareIds'
            CompatibleIds = $compatibleIds
        }
    }
)

$hidRows = @([CmsisDap00Native]::Collect($vid, $targetPid, 2000))
$hidPresent = @($pnpRows | Where-Object { $_.Interface -eq 'HID' -or $_.Service -eq 'HidUsb' })
$winUsbPresent = @($pnpRows | Where-Object { $_.Service -eq 'WinUSB' })
$transport = if ($hidPresent.Count -gt 0 -and $hidRows.Count -gt 0) { 'HID' } else { 'UNVERIFIED' }
$transportStatus = if ($transport -eq 'HID') { $statusConfirmed } else { $statusUnverified }
$winUsbValue = if ($winUsbPresent.Count -gt 0) { 'WinUSB' } else { 'UNVERIFIED' }
$winUsbStatus = if ($winUsbPresent.Count -gt 0) { $statusConfirmed } else { $statusUnverified }

$result = [pscustomobject]@{
    Schema = 'Orbit DAP-00 read-only collector v1'
    CollectionTime = $collectionTime.ToString('o')
    SafetyBoundary = @(
        'PnP enumeration only',
        'HID descriptor/string/report capability reads only',
        'CMSIS-DAP DAP_Info only',
        'No DAP_Connect, SWJ_Pins, SWJ_Clock, reset, halt, run, step, breakpoint, memory/register access, flash, erase, or verify'
    )
    DeviceIdentity = [pscustomobject]@{
        FormalSupportIdentifier = 'CMSIS-DAP_LU / VID_C251 / PID_F001 / CMSIS-DAP v1 HID'
        FormalSupportIdentifierStatus = "$statusConfirmed; not a board product model"
        Vid = 'C251'
        Pid = 'F001'
        DeviceDescription = 'CMSIS-DAP_LU'
        DeviceDescriptionStatus = "$statusConfirmed; not a board product model"
        FirmwareVersion = 'UNVERIFIED'
        FirmwareVersionStatus = $statusUnverified
        UsbRevision = 'UNVERIFIED'
        UsbRevisionStatus = "$statusUnverified; REV_0100 is not a firmware version"
    }
    Transport = [pscustomobject]@{
        SelectedObservedTransport = $transport
        SelectedObservedTransportStatus = $transportStatus
        Hid = $hidRows
        WinUsb = $winUsbValue
        WinUsbStatus = $winUsbStatus
        CmsisDapPacketSize = 'UNVERIFIED'
        CmsisDapPacketSizeStatus = "$statusUnverified; do not infer from HID report length"
        CmsisDapPacketCount = 'UNVERIFIED'
        CmsisDapPacketCountStatus = $statusUnverified
        Capabilities = 'UNVERIFIED'
        CapabilitiesStatus = $statusUnverified
    }
    WindowsPnp = [pscustomobject]@{
        RootOrInterfacePresent = if ($pnpRows.Count -gt 0) { $statusConfirmed } else { $statusUnverified }
        RootOrInterfacePresentStatus = if ($pnpRows.Count -gt 0) { $statusConfirmed } else { $statusUnverified }
        Devices = $pnpRows
    }
    Target = [pscustomobject]@{
        Mcu = 'STM32F407VET6'
        McuStatus = "$statusConfirmed; this script does not access the target"
        SwdConnection = 'UNVERIFIED'
        SwdConnectionStatus = "$statusUnverified; this script does not execute DAP_Connect"
        SwdClock = 'UNVERIFIED'
        SwdClockStatus = "$statusUnverified; this script does not execute SWJ_Clock"
        Power = 'UNVERIFIED'
        PowerStatus = $statusPendingHardware
        Nrst = 'UNVERIFIED'
        NrstStatus = $statusPendingHardware
    }
}

$json = $result | ConvertTo-Json -Depth 12
$outputParent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputParent)) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}
[System.IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Output $json
Write-Output "RESULT_PATH=$([System.IO.Path]::GetFullPath($OutputPath))"
