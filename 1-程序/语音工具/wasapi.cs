// wasapi.cs —— WASAPI 环回录音（录"扬声器正在播放的声音"，即微信里对方说的话）
// 供 audioio.exe 调用：looprec <wav> <sec> [outDeviceName]
// 说明：默认使用系统默认播放设备做环回；输出统一重采样为 16kHz 单声道 16bit WAV。
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class Wasapi
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int flags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long def, out long min);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr h);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object svc);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devpos, out ulong qpcpos);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
        public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
    }

    const int eRender = 0, eConsole = 0, CLSCTX_ALL = 23;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    public static void LoopRecord(string wavPath, int seconds, string deviceName)
    {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice dev;
        int hr;
        if (deviceName == null || deviceName.Length == 0)
        {
            hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out dev);
            if (hr != 0) throw new Exception("GetDefaultAudioEndpoint 失败 hr=0x" + hr.ToString("X8"));
        }
        else
        {
            dev = FindDevice(enumerator, eRender, deviceName);
            if (dev == null) throw new Exception("找不到播放设备: " + deviceName);
        }

        object o;
        Guid g = IID_IAudioClient;
        hr = dev.Activate(ref g, CLSCTX_ALL, IntPtr.Zero, out o);
        if (hr != 0) throw new Exception("Activate(IAudioClient) 失败 hr=0x" + hr.ToString("X8"));
        IAudioClient client = (IAudioClient)o;

        IntPtr pfmt;
        hr = client.GetMixFormat(out pfmt);
        if (hr != 0) throw new Exception("GetMixFormat 失败 hr=0x" + hr.ToString("X8"));
        WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pfmt, typeof(WAVEFORMATEX));
        int srcRate = (int)fmt.nSamplesPerSec;
        int srcCh = fmt.nChannels;
        int srcBits = fmt.wBitsPerSample;
        bool isFloat = (fmt.wFormatTag == 3);
        if (fmt.wFormatTag == 0xFFFE)
        {
            // WAVEFORMATEXTENSIBLE：子格式前 2 字节若为 3 表示 IEEE float
            int sub = Marshal.ReadInt16(pfmt, 24);
            isFloat = (sub == 3);
        }

        hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, pfmt, IntPtr.Zero);
        if (hr != 0) throw new Exception("IAudioClient.Initialize(loopback) 失败 hr=0x" + hr.ToString("X8"));
        g = IID_IAudioCaptureClient;
        object oc;
        hr = client.GetService(ref g, out oc);
        if (hr != 0) throw new Exception("GetService(IAudioCaptureClient) 失败 hr=0x" + hr.ToString("X8"));
        IAudioCaptureClient cap = (IAudioCaptureClient)oc;

        hr = client.Start();
        if (hr != 0) throw new Exception("Start 失败 hr=0x" + hr.ToString("X8"));

        const int outRate = 16000;
        MemoryStream ms = new MemoryStream();
        byte[] src = new byte[0];
        double pos = 0;          // 源采样位置（用于线性重采样）
        double step = (double)srcRate / outRate;
        long totalFramesOut = 0;
        bool first = true;
        double carryFrac = 0;

        DateTime end = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < end)
        {
            uint packet;
            hr = cap.GetNextPacketSize(out packet);
            if (hr != 0) throw new Exception("GetNextPacketSize 失败 hr=0x" + hr.ToString("X8"));
            if (packet == 0) { Thread.Sleep(5); continue; }
            while (packet > 0)
            {
                IntPtr pdata; uint frames; uint flags; ulong a, b;
                hr = cap.GetBuffer(out pdata, out frames, out flags, out a, out b);
                if (hr != 0) throw new Exception("GetBuffer 失败 hr=0x" + hr.ToString("X8"));
                int bytesPerFrame = srcCh * srcBits / 8;
                int nbytes = (int)frames * bytesPerFrame;
                if (src.Length < nbytes) src = new byte[nbytes];
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(src, 0, nbytes);
                else Marshal.Copy(pdata, src, 0, nbytes);
                cap.ReleaseBuffer(frames);

                // 转成 float 单声道
                double[] mono = new double[frames];
                for (int i = 0; i < frames; i++)
                {
                    double sum = 0;
                    for (int c = 0; c < srcCh; c++)
                    {
                        int off = i * bytesPerFrame + c * (srcBits / 8);
                        if (isFloat) sum += BitConverter.ToSingle(src, off);
                        else if (srcBits == 16) sum += BitConverter.ToInt16(src, off) / 32768.0;
                        else sum += BitConverter.ToInt32(src, off) / 2147483648.0;
                    }
                    mono[i] = sum / srcCh;
                }
                // 线性重采样到 16k
                if (first) { pos = 0; first = false; }
                while (pos < mono.Length - 1)
                {
                    int i0 = (int)pos;
                    double frac = pos - i0;
                    double v = mono[i0] * (1 - frac) + mono[i0 + 1] * frac;
                    if (v > 1) v = 1; if (v < -1) v = -1;
                    short s = (short)Math.Round(v * 32767);
                    ms.WriteByte((byte)(s & 0xFF)); ms.WriteByte((byte)((s >> 8) & 0xFF));
                    totalFramesOut++;
                    pos += step;
                }
                pos -= mono.Length;
                hr = cap.GetNextPacketSize(out packet);
                if (hr != 0) throw new Exception("GetNextPacketSize 失败 hr=0x" + hr.ToString("X8"));
            }
        }
        client.Stop();
        byte[] data = ms.ToArray();
        WriteWav(wavPath, data, outRate, 1, 16);
        Console.WriteLine("环回录音完成: " + wavPath + "  源 " + srcRate + "Hz " + srcCh + "ch " + srcBits + "bit" + (isFloat ? " float" : " int") + " -> 16000Hz mono 16bit, " + (data.Length / 32000.0).ToString("F2") + " s");
    }

    public static string DefaultName(int dataFlow)
    {        IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice d;
        if (en.GetDefaultAudioEndpoint(dataFlow, eConsole, out d) != 0) return "(取不到)";
        IntPtr props;
        if (d.OpenPropertyStore(0, out props) != 0) return "(取不到)";
        IPropertyStore ps = (IPropertyStore)Marshal.GetObjectForIUnknown(props);
        PROPERTYKEY pk = new PROPERTYKEY();
        pk.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        pk.pid = 14;
        PROPVARIANT pv;
        if (ps.GetValue(ref pk, out pv) == 0 && pv.vt == 31) return Marshal.PtrToStringUni(pv.p);
        return "(取不到)";
    }

    // ---- 切换系统默认设备（未公开的 IPolicyConfig）----
    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class CPolicyConfigClient { }

    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr fmt);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int def, out IntPtr fmt);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr end, IntPtr mix);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int def, out long a, out long b);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, ref long p);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref PROPERTYKEY key, out PROPVARIANT v);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref PROPERTYKEY key, ref PROPVARIANT v);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }

    public static void SetDefault(int dataFlow, string namePart)
    {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice d = FindDevice(en, dataFlow, namePart);
        if (d == null) throw new Exception("找不到设备: " + namePart);
        string id;
        if (d.GetId(out id) != 0) throw new Exception("GetId 失败");
        IPolicyConfig pc = (IPolicyConfig)(new CPolicyConfigClient());
        for (int role = 0; role <= 2; role++)
        {
            int hr = pc.SetDefaultEndpoint(id, role);
            if (hr != 0) throw new Exception("SetDefaultEndpoint(role=" + role + ") 失败 hr=0x" + hr.ToString("X8"));
        }
        Console.WriteLine("已设为默认" + (dataFlow == 0 ? "播放" : "录音") + "设备: " + namePart + "  (id=" + id + ")");
    }

    static IMMDevice FindDevice(IMMDeviceEnumerator enumerator, int dataFlow, string namePart)
    {
        IntPtr col;
        int hr = enumerator.EnumAudioEndpoints(dataFlow, 1, out col); // 1 = DEVICE_STATE_ACTIVE
        if (hr != 0) return null;
        IMMDeviceCollection c = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(col);
        uint count;
        if (c.GetCount(out count) != 0) return null;
        for (uint i = 0; i < count; i++)
        {
            IMMDevice d;
            if (c.Item(i, out d) != 0) continue;
            IntPtr props;
            if (d.OpenPropertyStore(0, out props) != 0) continue;
            IPropertyStore ps = (IPropertyStore)Marshal.GetObjectForIUnknown(props);
            PROPERTYKEY pk = new PROPERTYKEY();
            pk.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
            pk.pid = 14; // PKEY_Device_FriendlyName
            PROPVARIANT pv;
            if (ps.GetValue(ref pk, out pv) == 0 && pv.vt == 31)
            {
                string nm = Marshal.PtrToStringUni(pv.p);
                if (nm != null && nm.IndexOf(namePart, StringComparison.OrdinalIgnoreCase) >= 0) return d;
            }
        }
        return null;
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        int GetCount(out uint count);
        int Item(uint index, out IMMDevice device);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    static void WriteWav(string path, byte[] data, int rate, int channels, int bits)
    {
        int blockAlign = channels * bits / 8;
        using (FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            bw.Write(Encoding.ASCII.GetBytes("RIFF")); bw.Write(36 + data.Length); bw.Write(Encoding.ASCII.GetBytes("WAVE"));
            bw.Write(Encoding.ASCII.GetBytes("fmt ")); bw.Write(16); bw.Write((short)1); bw.Write((short)channels);
            bw.Write(rate); bw.Write(rate * blockAlign); bw.Write((short)blockAlign); bw.Write((short)bits);
            bw.Write(Encoding.ASCII.GetBytes("data")); bw.Write(data.Length); bw.Write(data);
        }
    }
}
