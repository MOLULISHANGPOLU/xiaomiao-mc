// audioio.cs —— 零依赖音频小工具（winmm/MME），用于 DSH 语音桥接
// 命令：
//   list                                              列出全部录音/播放设备（含索引）
//   play   <out> <wav>                                把 WAV 播到指定播放设备
//   record <in>  <wav> <sec>                          从指定录音设备录 sec 秒到 WAV（16k 单声道 16bit）
//   playrec <out> <in> <wavIn> <sec> <wavOut>         一边播 wavIn 到 out，一边从 in 录到 wavOut
//   rms    <wav>                                      输出 WAV 的 RMS / 峰值（dBFS）
// 设备参数可写索引数字，也可写名字的一部分（如 "CABLE Input"）
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class AudioIO
{
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WAVEOUTCAPS
    {
        public ushort wMid; public ushort wPid; public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
        public uint dwFormats; public ushort wChannels; public ushort wReserved1; public uint dwSupport;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WAVEINCAPS
    {
        public ushort wMid; public ushort wPid; public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
        public uint dwFormats; public ushort wChannels; public ushort wReserved1;
    }

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutGetNumDevs();
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutGetDevCaps(int id, ref WAVEOUTCAPS caps, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutOpen(out IntPtr hwo, int id, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutPrepareHeader(IntPtr hwo, ref WAVEHDR hdr, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutWrite(IntPtr hwo, ref WAVEHDR hdr, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutUnprepareHeader(IntPtr hwo, ref WAVEHDR hdr, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutClose(IntPtr hwo);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutReset(IntPtr hwo);

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInGetDevCaps(int id, ref WAVEINCAPS caps, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInOpen(out IntPtr hwi, int id, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInPrepareHeader(IntPtr hwi, ref WAVEHDR hdr, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInAddBuffer(IntPtr hwi, ref WAVEHDR hdr, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInStart(IntPtr hwi);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInStop(IntPtr hwi);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInUnprepareHeader(IntPtr hwi, ref WAVEHDR hdr, int size);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInClose(IntPtr hwi);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveInReset(IntPtr hwi);

    const uint CALLBACK_NULL = 0;
    const uint WHDR_DONE = 0x00000001;
    const ushort WAVE_FORMAT_PCM = 1;
    const int WAVEHDR_SIZE = 48;

    static string[] OutNames()
    {
        uint n = waveOutGetNumDevs();
        string[] a = new string[n];
        for (int i = 0; i < n; i++)
        {
            WAVEOUTCAPS c = new WAVEOUTCAPS();
            waveOutGetDevCaps(i, ref c, Marshal.SizeOf(typeof(WAVEOUTCAPS)));
            a[i] = c.szPname;
        }
        return a;
    }

    static string[] InNames()
    {
        uint n = waveInGetNumDevs();
        string[] a = new string[n];
        for (int i = 0; i < n; i++)
        {
            WAVEINCAPS c = new WAVEINCAPS();
            waveInGetDevCaps(i, ref c, Marshal.SizeOf(typeof(WAVEINCAPS)));
            a[i] = c.szPname;
        }
        return a;
    }

    static int ResolveOut(string s)
    {
        string[] names = OutNames();
        int idx;
        if (int.TryParse(s, out idx)) { if (idx >= 0 && idx < names.Length) return idx; throw new Exception("播放设备索引越界: " + s); }
        for (int i = 0; i < names.Length; i++) if (names[i].IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0) return i;
        throw new Exception("找不到播放设备: " + s);
    }

    static int ResolveIn(string s)
    {
        string[] names = InNames();
        int idx;
        if (int.TryParse(s, out idx)) { if (idx >= 0 && idx < names.Length) return idx; throw new Exception("录音设备索引越界: " + s); }
        for (int i = 0; i < names.Length; i++) if (names[i].IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0) return i;
        throw new Exception("找不到录音设备: " + s);
    }

    static WAVEFORMATEX Pcm16(int rate, int channels)
    {
        WAVEFORMATEX f = new WAVEFORMATEX();
        f.wFormatTag = WAVE_FORMAT_PCM;
        f.nChannels = (ushort)channels;
        f.nSamplesPerSec = (uint)rate;
        f.wBitsPerSample = 16;
        f.nBlockAlign = (ushort)(channels * 2);
        f.nAvgBytesPerSec = (uint)(rate * channels * 2);
        f.cbSize = 0;
        return f;
    }

    // ---------- WAV I/O ----------
    class WavData { public byte[] data; public int rate; public int channels; public int bits; }

    static WavData ReadWav(string path)
    {
        byte[] all = File.ReadAllBytes(path);
        if (all.Length < 44) throw new Exception("WAV 太小");
        if (Encoding.ASCII.GetString(all, 0, 4) != "RIFF" || Encoding.ASCII.GetString(all, 8, 4) != "WAVE") throw new Exception("不是 WAV 文件");
        WavData w = new WavData();
        int pos = 12;
        while (pos + 8 <= all.Length)
        {
            string id = Encoding.ASCII.GetString(all, pos, 4);
            int size = BitConverter.ToInt32(all, pos + 4);
            int body = pos + 8;
            if (id == "fmt ")
            {
                w.rate = BitConverter.ToInt32(all, body + 4);
                w.channels = BitConverter.ToInt16(all, body + 2);
                w.bits = BitConverter.ToInt16(all, body + 14);
            }
            else if (id == "data")
            {
                int n = Math.Min(size, all.Length - body);
                w.data = new byte[n];
                Array.Copy(all, body, w.data, 0, n);
            }
            pos = body + size + (size % 2);
        }
        if (w.data == null) throw new Exception("WAV 里没有 data 块");
        return w;
    }

    static void WriteWav(string path, byte[] data, int rate, int channels, int bits)
    {
        int blockAlign = channels * bits / 8;
        using (FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            bw.Write(Encoding.ASCII.GetBytes("RIFF"));
            bw.Write(36 + data.Length);
            bw.Write(Encoding.ASCII.GetBytes("WAVE"));
            bw.Write(Encoding.ASCII.GetBytes("fmt "));
            bw.Write(16);
            bw.Write((short)1);
            bw.Write((short)channels);
            bw.Write(rate);
            bw.Write(rate * blockAlign);
            bw.Write((short)blockAlign);
            bw.Write((short)bits);
            bw.Write(Encoding.ASCII.GetBytes("data"));
            bw.Write(data.Length);
            bw.Write(data);
        }
    }

    // ---------- 播放 ----------
    static void Play(string dev, string wavPath)
    {
        WavData w = ReadWav(wavPath);
        int idx = ResolveOut(dev);
        WAVEFORMATEX fmt = Pcm16(w.rate, w.channels);
        IntPtr hwo;
        uint r = waveOutOpen(out hwo, idx, ref fmt, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL);
        if (r != 0) throw new Exception("waveOutOpen 失败 code=" + r + " 设备=" + OutNames()[idx]);
        IntPtr buf = Marshal.AllocHGlobal(w.data.Length);
        Marshal.Copy(w.data, 0, buf, w.data.Length);
        WAVEHDR hdr = new WAVEHDR();
        hdr.lpData = buf;
        hdr.dwBufferLength = (uint)w.data.Length;
        if (waveOutPrepareHeader(hwo, ref hdr, WAVEHDR_SIZE) != 0) throw new Exception("waveOutPrepareHeader 失败");
        if (waveOutWrite(hwo, ref hdr, WAVEHDR_SIZE) != 0) throw new Exception("waveOutWrite 失败");
        int expectMs = (int)(1000.0 * w.data.Length / (w.rate * w.channels * 2));
        Thread.Sleep(expectMs + 700);
        waveOutUnprepareHeader(hwo, ref hdr, WAVEHDR_SIZE);
        waveOutClose(hwo);
        Marshal.FreeHGlobal(buf);
        Console.WriteLine("播放完成: " + wavPath + " -> " + OutNames()[idx] + " (" + expectMs + " ms)");
    }

    // ---------- 录音 ----------
    static void Record(string dev, string wavPath, int seconds)
    {
        int idx = ResolveIn(dev);
        int rate = 16000, channels = 1;
        WAVEFORMATEX fmt = Pcm16(rate, channels);
        IntPtr hwi;
        uint r = waveInOpen(out hwi, idx, ref fmt, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL);
        if (r != 0) throw new Exception("waveInOpen 失败 code=" + r + " 设备=" + InNames()[idx]);
        int bytes = rate * channels * 2 * seconds;
        IntPtr buf = Marshal.AllocHGlobal(bytes);
        WAVEHDR hdr = new WAVEHDR();
        hdr.lpData = buf;
        hdr.dwBufferLength = (uint)bytes;
        if (waveInPrepareHeader(hwi, ref hdr, WAVEHDR_SIZE) != 0) throw new Exception("waveInPrepareHeader 失败");
        if (waveInAddBuffer(hwi, ref hdr, WAVEHDR_SIZE) != 0) throw new Exception("waveInAddBuffer 失败");
        if (waveInStart(hwi) != 0) throw new Exception("waveInStart 失败");
        Thread.Sleep(seconds * 1000 + 200);
        waveInStop(hwi);
        waveInReset(hwi);
        waveInUnprepareHeader(hwi, ref hdr, WAVEHDR_SIZE);
        int got = (int)hdr.dwBytesRecorded;
        if (got <= 0 || got > bytes) got = bytes;
        byte[] data = new byte[got];
        Marshal.Copy(buf, data, 0, got);
        waveInClose(hwi);
        Marshal.FreeHGlobal(buf);
        WriteWav(wavPath, data, rate, channels, 16);
        Console.WriteLine("录音完成: " + InNames()[idx] + " -> " + wavPath + " (" + got + " B, " + (got / (rate * channels * 2.0)).ToString("F2") + " s)");
    }

    // ---------- 边播边录 ----------
    static void PlayRec(string outDev, string inDev, string wavIn, int seconds, string wavOut)
    {
        Thread t = new Thread(delegate() { try { Play(outDev, wavIn); } catch (Exception e) { Console.WriteLine("播放出错: " + e.Message); } });
        t.Start();
        Thread.Sleep(200);
        Record(inDev, wavOut, seconds);
        t.Join();
    }

    // ---------- 电平 ----------
    static void Rms(string wavPath)
    {
        WavData w = ReadWav(wavPath);
        int n = w.data.Length / 2;
        if (n == 0) { Console.WriteLine("空数据"); return; }
        double sum = 0; int peak = 0; int nonzero = 0;
        for (int i = 0; i < n; i++)
        {
            short s = BitConverter.ToInt16(w.data, i * 2);
            sum += (double)s * s;
            int a = Math.Abs((int)s);
            if (a > peak) peak = a;
            if (a > 32) nonzero++;
        }
        double rms = Math.Sqrt(sum / n);
        double rmsDb = 20 * Math.Log10((rms + 1e-9) / 32768.0);
        double peakDb = 20 * Math.Log10((peak + 1e-9) / 32768.0);
        Console.WriteLine("文件: " + wavPath);
        Console.WriteLine("采样: " + w.rate + " Hz  " + w.channels + " ch  " + w.bits + " bit  样本 " + n + "  时长 " + (n / (double)(w.rate * w.channels)).ToString("F2") + " s");
        Console.WriteLine("RMS " + rms.ToString("F1") + " (" + rmsDb.ToString("F1") + " dBFS)  峰值 " + peak + " (" + peakDb.ToString("F1") + " dBFS)  有声样本占比 " + (100.0 * nonzero / n).ToString("F1") + "%");
    }

    static void List()
    {
        string[] o = OutNames();
        string[] i = InNames();
        Console.WriteLine("播放设备 (" + o.Length + "):");
        for (int k = 0; k < o.Length; k++) Console.WriteLine("  [" + k + "] " + o[k]);
        Console.WriteLine("录音设备 (" + i.Length + "):");
        for (int k = 0; k < i.Length; k++) Console.WriteLine("  [" + k + "] " + i[k]);
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) { Console.WriteLine("用法: audioio <list|play|record|playrec|rms> ..."); return 2; }
            string cmd = args[0].ToLower();
            if (cmd == "list") { List(); return 0; }
            if (cmd == "play") { Play(args[1], args[2]); return 0; }
            if (cmd == "record") { Record(args[1], args[2], int.Parse(args[3])); return 0; }
            if (cmd == "playrec") { PlayRec(args[1], args[2], args[3], int.Parse(args[4]), args[5]); return 0; }
            if (cmd == "rms") { Rms(args[1]); return 0; }
            if (cmd == "looprec") { Wasapi.LoopRecord(args[1], int.Parse(args[2]), args.Length > 3 ? args[3] : ""); return 0; }
            if (cmd == "defaults") { Console.WriteLine("默认播放设备: " + Wasapi.DefaultName(0)); Console.WriteLine("默认录音设备: " + Wasapi.DefaultName(1)); return 0; }
            if (cmd == "setdefault") { Wasapi.SetDefault(args[1] == "render" ? 0 : 1, args[2]); return 0; }
            Console.WriteLine("未知命令: " + cmd);
            return 2;
        }
        catch (Exception e)
        {
            Console.WriteLine("错误: " + e.Message);
            return 1;
        }
    }
}
