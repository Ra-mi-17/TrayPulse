// TrayPulse native helpers for Windows.
// Compiled at runtime by Windows PowerShell (Add-Type), so no build step / .NET SDK is required.
// - BtBattery: reads the Bluetooth battery level Windows exposes on device nodes (SetupAPI).
// - Audio:     Core Audio (MMDevice API) for default device switching, mic mute and per-app volume.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TrayPulse
{
    // ------------------------------------------------------------------
    // Bluetooth battery via SetupAPI device properties
    // ------------------------------------------------------------------
    public static class BtBattery
    {
        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVINFO_DATA { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }

        [StructLayout(LayoutKind.Sequential)]
        struct DEVPROPKEY { public Guid fmtid; public uint pid; public DEVPROPKEY(string g, uint p) { fmtid = new Guid(g); pid = p; } }

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SetupDiGetClassDevsW(IntPtr classGuid, string enumerator, IntPtr hwnd, uint flags);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref SP_DEVINFO_DATA data);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiGetDevicePropertyW(IntPtr set, ref SP_DEVINFO_DATA data, ref DEVPROPKEY key,
            out uint propType, byte[] buffer, uint bufferSize, out uint requiredSize, uint flags);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

        const uint DIGCF_PRESENT = 0x2, DIGCF_ALLCLASSES = 0x4;

        static DEVPROPKEY PKEY_Battery = new DEVPROPKEY("104EA319-6EE2-4701-BD47-8DDBF425BBE5", 2);
        static DEVPROPKEY PKEY_FriendlyName = new DEVPROPKEY("a45c254e-df1c-4efd-8020-67d146a850e0", 14);
        static DEVPROPKEY PKEY_DeviceDesc = new DEVPROPKEY("a45c254e-df1c-4efd-8020-67d146a850e0", 2);
        static DEVPROPKEY PKEY_ContainerId = new DEVPROPKEY("8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c", 2);
        static DEVPROPKEY PKEY_InstanceId = new DEVPROPKEY("78c34fc8-104a-4aca-9ea4-524d52996e57", 256);
        // DEVPKEY_Device_IsConnected-like flag used by the Bluetooth stack ("{83DA6326-...} 15").
        static DEVPROPKEY PKEY_Connected = new DEVPROPKEY("83da6326-97a6-4088-9453-a1923f573b29", 15);

        static readonly Guid ClassMouse = new Guid("4d36e96f-e325-11ce-bfc1-08002be10318");
        static readonly Guid ClassKeyboard = new Guid("4d36e96b-e325-11ce-bfc1-08002be10318");
        static readonly Guid ClassMedia = new Guid("4d36e96c-e325-11ce-bfc1-08002be10318");
        static readonly Guid ClassAudioEndpoint = new Guid("c166523c-fe0c-4a94-a586-f1a80cfbbf3e");
        static readonly Guid ClassXbox = new Guid("d61ca365-5af4-4486-998b-9db4734c6ca3");

        class Node { public string Id, Name, Container; public Guid Class; public int Battery = -1; public int Connected = -1; }

        static byte[] Prop(IntPtr set, ref SP_DEVINFO_DATA d, DEVPROPKEY key, out uint type)
        {
            uint req;
            byte[] buf = new byte[512];
            if (!SetupDiGetDevicePropertyW(set, ref d, ref key, out type, buf, (uint)buf.Length, out req, 0))
            {
                if (req > buf.Length)
                {
                    buf = new byte[req];
                    if (!SetupDiGetDevicePropertyW(set, ref d, ref key, out type, buf, (uint)buf.Length, out req, 0)) return null;
                }
                else return null;
            }
            Array.Resize(ref buf, (int)req);
            return buf;
        }

        static string PropString(IntPtr set, ref SP_DEVINFO_DATA d, DEVPROPKEY key)
        {
            uint t; byte[] b = Prop(set, ref d, key, out t);
            if (b == null || t != 0x12 /* DEVPROP_TYPE_STRING */) return null;
            return System.Text.Encoding.Unicode.GetString(b).TrimEnd('\0');
        }

        public static List<Dictionary<string, object>> Read()
        {
            var nodes = new List<Node>();
            IntPtr set = SetupDiGetClassDevsW(IntPtr.Zero, null, IntPtr.Zero, DIGCF_PRESENT | DIGCF_ALLCLASSES);
            if (set == IntPtr.Zero || set == new IntPtr(-1)) return new List<Dictionary<string, object>>();
            try
            {
                var d = new SP_DEVINFO_DATA();
                d.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                for (uint i = 0; SetupDiEnumDeviceInfo(set, i, ref d); i++)
                {
                    uint t;
                    byte[] cont = Prop(set, ref d, PKEY_ContainerId, out t);
                    if (cont == null || cont.Length != 16) continue;
                    var n = new Node();
                    n.Container = new Guid(cont).ToString();
                    n.Class = d.ClassGuid;
                    n.Id = PropString(set, ref d, PKEY_InstanceId) ?? "";
                    n.Name = PropString(set, ref d, PKEY_FriendlyName) ?? PropString(set, ref d, PKEY_DeviceDesc) ?? "";
                    byte[] bat = Prop(set, ref d, PKEY_Battery, out t);
                    if (bat != null && bat.Length >= 1 && t == 0x3 /* DEVPROP_TYPE_BYTE */) n.Battery = bat[0];
                    byte[] con = Prop(set, ref d, PKEY_Connected, out t);
                    if (con != null && con.Length >= 1 && t == 0x11 /* DEVPROP_TYPE_BOOLEAN */) n.Connected = con[0] != 0 ? 1 : 0;
                    nodes.Add(n);
                }
            }
            finally { SetupDiDestroyDeviceInfoList(set); }

            // Group nodes by physical device (container) and keep containers that report a battery level.
            var byContainer = new Dictionary<string, List<Node>>();
            foreach (var n in nodes)
            {
                List<Node> l;
                if (!byContainer.TryGetValue(n.Container, out l)) { l = new List<Node>(); byContainer[n.Container] = l; }
                l.Add(n);
            }

            var result = new List<Dictionary<string, object>>();
            foreach (var kv in byContainer)
            {
                int battery = -1; int connected = -1; string rootName = null; string anyName = null;
                bool mouse = false, keyboard = false, audio = false, gamepad = false, bt = false;
                foreach (var n in kv.Value)
                {
                    string id = n.Id.ToUpperInvariant();
                    if (id.StartsWith("BTHENUM\\") || id.StartsWith("BTHLE\\") || id.StartsWith("BTHLEDEVICE\\")) bt = true;
                    if (n.Battery >= 0 && n.Battery > battery) battery = n.Battery;
                    if (n.Connected == 1) connected = 1; else if (n.Connected == 0 && connected < 0) connected = 0;
                    if ((id.StartsWith("BTHENUM\\DEV_") || id.StartsWith("BTHLE\\DEV_")) && n.Name.Length > 0) rootName = n.Name;
                    if (n.Name.Length > 0 && (anyName == null || n.Name.Length < anyName.Length)) anyName = n.Name;
                    if (n.Class == ClassMouse) mouse = true;
                    else if (n.Class == ClassKeyboard) keyboard = true;
                    else if (n.Class == ClassAudioEndpoint || n.Class == ClassMedia) audio = true;
                    else if (n.Class == ClassXbox) gamepad = true;
                }
                if (battery < 0 || !bt) continue;
                var r = new Dictionary<string, object>();
                r["containerId"] = kv.Key;
                r["name"] = rootName ?? anyName ?? "Bluetooth device";
                r["level"] = battery;
                r["connected"] = connected; // -1 = unknown
                r["kind"] = gamepad ? "gamepad" : mouse ? "mouse" : keyboard ? "keyboard" : audio ? "headset" : "other";
                result.Add(r);
            }
            return result;
        }
    }

    // ------------------------------------------------------------------
    // Taskbar embedding: makes an app window a child of the taskbar (Shell_TrayWnd)
    // and keeps it right-aligned next to the notification area.
    // Windows 11 removed DeskBands, so this is the approach tools like TrafficMonitor use.
    // ------------------------------------------------------------------
    public static class Taskbar
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string name);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr v);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

        const int GWL_STYLE = -16;
        const long WS_CHILD = 0x40000000L, WS_POPUP = 0x80000000L, WS_CAPTION = 0x00C00000L, WS_THICKFRAME = 0x00040000L;
        const uint SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_NOZORDER = 0x4;
        static readonly IntPtr HWND_TOP = IntPtr.Zero;
        static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        static Dictionary<string, object> Fail(string reason)
        {
            var r = new Dictionary<string, object>(); r["ok"] = false; r["reason"] = reason; return r;
        }

        // hwnd: window to embed. width: desired width in physical pixels (0 = keep). gap: space before the tray area.
        public static Dictionary<string, object> Place(long hwnd, int width, int gap)
        {
            IntPtr prevCtx = SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
            try
            {
                IntPtr h = new IntPtr(hwnd);
                if (!IsWindow(h)) return Fail("no-window");
                IntPtr tb = FindWindowW("Shell_TrayWnd", null);
                if (tb == IntPtr.Zero) return Fail("no-taskbar");
                RECT tbr; GetWindowRect(tb, out tbr);
                int tbW = tbr.R - tbr.L, tbH = tbr.B - tbr.T;
                if (tbH > tbW) return Fail("vertical");

                bool attached = false;
                if (GetParent(h) != tb)
                {
                    long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
                    style = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
                    SetWindowLongPtr(h, GWL_STYLE, new IntPtr(style));
                    SetParent(h, tb);
                    attached = true;
                }

                // Right edge = left edge of the notification area (clock, tray icons).
                int right = tbW;
                IntPtr notify = FindWindowExW(tb, IntPtr.Zero, "TrayNotifyWnd", null);
                RECT nr;
                if (notify != IntPtr.Zero && GetWindowRect(notify, out nr) && nr.R > nr.L) right = nr.L - tbr.L;

                // Left limit = right edge of the task button area (left-aligned Windows 11 / Windows 10).
                int left = 0;
                IntPtr rebar = FindWindowExW(tb, IntPtr.Zero, "ReBarWindow32", null);
                RECT rr;
                if (rebar != IntPtr.Zero && GetWindowRect(rebar, out rr)) left = rr.R - tbr.L;

                RECT cur; GetWindowRect(h, out cur);
                int w = width > 0 ? width : cur.R - cur.L;
                int x = right - gap - w;
                SetWindowPos(h, HWND_TOP, x, 0, w, tbH, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                // Hand the physical-pixel rectangle to the mouse hook (its own thread can't reliably query it).
                RECT placed; GetWindowRect(h, out placed);
                TaskbarInput.SetRect(placed.L, placed.T, placed.R, placed.B);

                var res = new Dictionary<string, object>();
                res["ok"] = true;
                res["attached"] = attached;
                res["x"] = x; res["width"] = w; res["height"] = tbH;
                res["available"] = right - gap - left; // free width between task buttons and the tray
                res["dpi"] = (int)GetDpiForWindow(tb);
                return res;
            }
            finally { SetThreadDpiAwarenessContext(prevCtx); }
        }
    }

    // ------------------------------------------------------------------
    // Mouse input for the taskbar widget.
    // Chromium windows re-parented into another process's window no longer receive mouse input,
    // so a low-level mouse hook watches for clicks inside the widget's rectangle only, swallows them
    // and reports them as JSON events on stdout. Clicks anywhere else are passed through untouched.
    // ------------------------------------------------------------------
    public static class TaskbarInput
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookExW(int id, HookProc proc, IntPtr hMod, uint threadId);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);

        const int WH_MOUSE_LL = 14;
        const int WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205;

        static readonly HookProc proc = Hook; // keep the delegate alive
        static IntPtr hook = IntPtr.Zero;
        static long target;
        static System.Threading.Thread thread;
        static int rl, rt, rr, rb; // widget rectangle in physical pixels, updated by Taskbar.Place

        public static void SetRect(int l, int t, int r, int b) { rl = l; rt = t; rr = r; rb = b; }

        public static void Watch(long hwnd)
        {
            target = hwnd;
            if (hwnd == 0 || thread != null) return;
            thread = new System.Threading.Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        static void Run()
        {

            hook = SetWindowsHookExW(WH_MOUSE_LL, proc, GetModuleHandleW(null), 0);
            MSG m;
            while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) { }
            UnhookWindowsHookEx(hook);
        }

        static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam)
        {
            long t = target;
            if (code >= 0 && t != 0)
            {
                int msg = wParam.ToInt32();
                if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP || msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP)
                {
                    var s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    IntPtr h = new IntPtr(t);
                    RECT r; r.L = rl; r.T = rt; r.R = rr; r.B = rb;
                    if (r.R > r.L && IsWindowVisible(h) && s.pt.X >= r.L && s.pt.X < r.R && s.pt.Y >= r.T && s.pt.Y < r.B)
                    {
                        if (msg == WM_LBUTTONUP || msg == WM_RBUTTONUP)
                        {
                            string button = msg == WM_LBUTTONUP ? "left" : "right";
                            // Console.Out is synchronized, so this can't interleave with responses.
                            Console.Out.WriteLine("{\"event\":\"widget-click\",\"button\":\"" + button + "\",\"x\":" + (s.pt.X - r.L) +
                                ",\"y\":" + (s.pt.Y - r.T) + ",\"width\":" + (r.R - r.L) + ",\"height\":" + (r.B - r.T) + "}");
                            Console.Out.Flush();
                        }
                        return new IntPtr(1); // swallow: the click is handled by TrayPulse
                    }
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }
    }

    // ------------------------------------------------------------------
    // Core Audio COM interop
    // ------------------------------------------------------------------
    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
        [FieldOffset(16)] public IntPtr p2;
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(EDataFlow flow, uint stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        void RegisterEndpointNotificationCallback(IntPtr client);
        void UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out uint count);
        void Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        void OpenPropertyStore(int access, out IPropertyStore store);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PROPERTYKEY key);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        void Commit();
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify(IntPtr notify);
        void UnregisterControlChangeNotify(IntPtr notify);
        void GetChannelCount(out uint count);
        void SetMasterVolumeLevel(float db, ref Guid ctx);
        void SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        void GetMasterVolumeLevel(out float db);
        void GetMasterVolumeLevelScalar(out float level);
        void SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
        void SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
        void GetChannelVolumeLevel(uint ch, out float db);
        void GetChannelVolumeLevelScalar(uint ch, out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // Undocumented but long-stable interface used to change the default endpoint.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        void GetMixFormat(); void GetDeviceFormat(); void ResetDeviceFormat(); void SetDeviceFormat();
        void GetProcessingPeriod(); void SetProcessingPeriod(); void GetShareMode(); void SetShareMode();
        void GetPropertyValue(); void SetPropertyValue();
        void SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
        void SetEndpointVisibility();
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClient { }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        void GetAudioSessionControl(); void GetSimpleAudioVolume();
        void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        void GetCount(out int count);
        void GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        void GetState(out int state);
        void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetDisplayName(); void GetIconPath(); void SetIconPath(); void GetGroupingParam(); void SetGroupingParam();
        void RegisterAudioSessionNotification(); void UnregisterAudioSessionNotification();
        void GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        void SetMasterVolume(float level, ref Guid ctx);
        void GetMasterVolume(out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public static class Audio
    {
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);

        const int CLSCTX_ALL = 23;
        const uint DEVICE_STATE_ACTIVE = 1;
        static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        static Guid Ctx = Guid.Empty;

        static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); }

        static string FriendlyName(IMMDevice dev)
        {
            IPropertyStore store;
            dev.OpenPropertyStore(0, out store);
            var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
            PROPVARIANT pv;
            store.GetValue(ref key, out pv);
            string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.p) : null;
            PropVariantClear(ref pv);
            Marshal.ReleaseComObject(store);
            return name ?? "";
        }

        static string DefaultId(IMMDeviceEnumerator en, EDataFlow flow)
        {
            try { IMMDevice d; en.GetDefaultAudioEndpoint(flow, ERole.eMultimedia, out d); string id; d.GetId(out id); Marshal.ReleaseComObject(d); return id; }
            catch { return null; }
        }

        public static List<Dictionary<string, object>> ListDevices(int flow)
        {
            var list = new List<Dictionary<string, object>>();
            var en = Enumerator();
            string def = DefaultId(en, (EDataFlow)flow);
            IMMDeviceCollection col;
            en.EnumAudioEndpoints((EDataFlow)flow, DEVICE_STATE_ACTIVE, out col);
            uint count; col.GetCount(out count);
            for (uint i = 0; i < count; i++)
            {
                IMMDevice d; col.Item(i, out d);
                string id; d.GetId(out id);
                var r = new Dictionary<string, object>();
                r["id"] = id; r["name"] = FriendlyName(d); r["isDefault"] = id == def;
                list.Add(r);
                Marshal.ReleaseComObject(d);
            }
            Marshal.ReleaseComObject(col);
            Marshal.ReleaseComObject(en);
            return list;
        }

        public static void SetDefault(string id)
        {
            var pc = (IPolicyConfig)new PolicyConfigClient();
            pc.SetDefaultEndpoint(id, ERole.eConsole);
            pc.SetDefaultEndpoint(id, ERole.eMultimedia);
            pc.SetDefaultEndpoint(id, ERole.eCommunications);
            Marshal.ReleaseComObject(pc);
        }

        static IAudioEndpointVolume EndpointVolume(int flow, out string name)
        {
            var en = Enumerator();
            IMMDevice d;
            en.GetDefaultAudioEndpoint((EDataFlow)flow, ERole.eMultimedia, out d);
            name = FriendlyName(d);
            object o; Guid iid = IID_IAudioEndpointVolume;
            d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            Marshal.ReleaseComObject(d);
            Marshal.ReleaseComObject(en);
            return (IAudioEndpointVolume)o;
        }

        // flow 0 = output (speakers), 1 = input (microphone)
        public static Dictionary<string, object> GetEndpoint(int flow)
        {
            var r = new Dictionary<string, object>();
            try
            {
                string name; var v = EndpointVolume(flow, out name);
                float lvl; bool mute; v.GetMasterVolumeLevelScalar(out lvl); v.GetMute(out mute);
                Marshal.ReleaseComObject(v);
                r["available"] = true; r["name"] = name; r["volume"] = lvl; r["muted"] = mute;
            }
            catch { r["available"] = false; r["name"] = ""; r["volume"] = 0f; r["muted"] = false; }
            return r;
        }

        public static void SetEndpointVolume(int flow, float level)
        {
            string name; var v = EndpointVolume(flow, out name);
            v.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, level)), ref Ctx);
            Marshal.ReleaseComObject(v);
        }

        // mode: -1 toggle, 0 unmute, 1 mute. Returns the new mute state.
        public static bool SetEndpointMute(int flow, int mode)
        {
            string name; var v = EndpointVolume(flow, out name);
            bool cur; v.GetMute(out cur);
            bool next = mode < 0 ? !cur : mode == 1;
            v.SetMute(next, ref Ctx);
            Marshal.ReleaseComObject(v);
            return next;
        }

        delegate void SessionVisitor(IAudioSessionControl2 ctl, ISimpleAudioVolume vol, uint pid, bool system);

        static void ForEachSession(SessionVisitor visit)
        {
            var en = Enumerator();
            IMMDevice d;
            en.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out d);
            object o; Guid iid = IID_IAudioSessionManager2;
            d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            var mgr = (IAudioSessionManager2)o;
            IAudioSessionEnumerator sessions; mgr.GetSessionEnumerator(out sessions);
            int count; sessions.GetCount(out count);
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 ctl; sessions.GetSession(i, out ctl);
                try
                {
                    int state; ctl.GetState(out state);
                    if (state == 2) continue; // expired
                    uint pid; ctl.GetProcessId(out pid);
                    bool system = ctl.IsSystemSoundsSession() == 0;
                    visit(ctl, (ISimpleAudioVolume)ctl, pid, system);
                }
                catch { }
                finally { Marshal.ReleaseComObject(ctl); }
            }
            Marshal.ReleaseComObject(sessions);
            Marshal.ReleaseComObject(mgr);
            Marshal.ReleaseComObject(d);
            Marshal.ReleaseComObject(en);
        }

        static string ExePath(uint pid)
        {
            try { return Process.GetProcessById((int)pid).MainModule.FileName; } catch { return null; }
        }

        // Sessions of the same executable (e.g. multiple Chrome/Discord processes) are grouped.
        static string SessionKey(uint pid, bool system)
        {
            if (system) return "0";
            string p = ExePath(pid);
            return string.IsNullOrEmpty(p) ? "pid:" + pid : p.ToLowerInvariant();
        }

        // Sessions grouped by executable (key = lower-cased exe path, "0" = system sounds).
        public static List<Dictionary<string, object>> ListSessions()
        {
            var map = new Dictionary<string, Dictionary<string, object>>();
            var order = new List<string>();
            ForEachSession((ctl, vol, pid, system) =>
            {
                string key = SessionKey(pid, system);
                if (map.ContainsKey(key)) return;
                float lvl; bool mute; vol.GetMasterVolume(out lvl); vol.GetMute(out mute);
                string display = null, path = null;
                try { ctl.GetDisplayName(out display); } catch { }
                if (display != null && display.StartsWith("@")) display = null; // resource string, not useful
                if (!system)
                {
                    try
                    {
                        var p = Process.GetProcessById((int)pid);
                        try { path = p.MainModule.FileName; } catch { }
                        if (string.IsNullOrEmpty(display))
                        {
                            try { display = p.MainModule.FileVersionInfo.FileDescription; } catch { }
                            if (string.IsNullOrEmpty(display)) display = p.ProcessName;
                        }
                    }
                    catch { return; } // process gone
                }
                var r = new Dictionary<string, object>();
                r["key"] = key; r["pid"] = pid; r["system"] = system;
                r["name"] = display ?? ""; r["path"] = path ?? ""; r["volume"] = lvl; r["muted"] = mute;
                map[key] = r; order.Add(key);
            });
            var list = new List<Dictionary<string, object>>();
            foreach (var k in order) list.Add(map[k]);
            return list;
        }

        public static void SetSessionVolume(string key, float level)
        {
            level = Math.Max(0f, Math.Min(1f, level));
            ForEachSession((ctl, vol, pid, system) =>
            {
                if (SessionKey(pid, system) == key) vol.SetMasterVolume(level, ref Ctx);
            });
        }

        public static void SetSessionMute(string key, bool mute)
        {
            ForEachSession((ctl, vol, pid, system) =>
            {
                if (SessionKey(pid, system) == key) vol.SetMute(mute, ref Ctx);
            });
        }
    }
}
