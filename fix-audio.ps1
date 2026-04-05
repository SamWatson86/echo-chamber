# Echo Chamber Audio Fix
# Fixes system default audio device if it got stuck on the wrong output.
# Right-click this file -> "Run with PowerShell"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AudioFix {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator {}

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClient {}

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid id, int clsCtx, IntPtr p, out IPropertyStore store);
        int OpenPropertyStore(int access, out IPropertyStore store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out int count);
        int GetAt(int index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT val);
    }

    [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig {
        void _1(); void _2(); void _3(); void _4(); void _5();
        void _6(); void _7(); void _8(); void _9(); void _10();
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT {
        public ushort vt;
        public ushort r1, r2, r3;
        public IntPtr data1;
        public IntPtr data2;
    }

    public static string[] GetOutputDevices(out string[] ids) {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDeviceCollection collection;
        enumerator.EnumAudioEndpoints(0, 1, out collection); // eRender, ACTIVE
        int count;
        collection.GetCount(out count);

        string[] names = new string[count];
        ids = new string[count];
        var nameKey = new PROPERTYKEY {
            fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
            pid = 2
        };

        for (int i = 0; i < count; i++) {
            IMMDevice device;
            collection.Item(i, out device);
            device.GetId(out ids[i]);
            IPropertyStore store;
            device.OpenPropertyStore(0, out store);
            PROPVARIANT val;
            store.GetValue(ref nameKey, out val);
            names[i] = Marshal.PtrToStringUni(val.data1);
        }
        return names;
    }

    public static string GetDefaultId() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 0, out device);
        string id;
        device.GetId(out id);
        return id;
    }

    public static bool SetDefault(string deviceId) {
        var config = (IPolicyConfig)(new PolicyConfigClient());
        int hr0 = config.SetDefaultEndpoint(deviceId, 0);
        int hr1 = config.SetDefaultEndpoint(deviceId, 1);
        int hr2 = config.SetDefaultEndpoint(deviceId, 2);
        return hr0 == 0 && hr1 == 0 && hr2 == 0;
    }
}
"@

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Echo Chamber - Audio Fix Tool" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Get current default
$currentId = [AudioFix]::GetDefaultId()

# List devices
$ids = @()
$names = [AudioFix]::GetOutputDevices([ref]$ids)

Write-Host "Your audio output devices:" -ForegroundColor Yellow
Write-Host ""
for ($i = 0; $i -lt $names.Length; $i++) {
    $marker = ""
    if ($ids[$i] -eq $currentId) {
        $marker = " <-- CURRENT DEFAULT"
    }
    Write-Host "  [$($i + 1)] $($names[$i])$marker" -ForegroundColor $(if ($ids[$i] -eq $currentId) { "Green" } else { "White" })
}

Write-Host ""
Write-Host "If your current default looks correct, just close this window." -ForegroundColor Gray
Write-Host ""
$choice = Read-Host "Enter the number of your speakers/headphones to fix (or press Enter to quit)"

if ([string]::IsNullOrWhiteSpace($choice)) {
    Write-Host "No changes made." -ForegroundColor Gray
    pause
    exit
}

$index = [int]$choice - 1
if ($index -lt 0 -or $index -ge $names.Length) {
    Write-Host "Invalid choice." -ForegroundColor Red
    pause
    exit
}

$selectedName = $names[$index]
$selectedId = $ids[$index]

Write-Host ""
Write-Host "Switching default to: $selectedName ..." -ForegroundColor Yellow

$success = [AudioFix]::SetDefault($selectedId)

if ($success) {
    Write-Host ""
    Write-Host "Done! Your audio should now play through: $selectedName" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "Something went wrong. Try changing it manually:" -ForegroundColor Red
    Write-Host "  Right-click speaker icon in taskbar -> Sound settings -> Change output device" -ForegroundColor Red
    Write-Host ""
}

pause
