// mfdecode.cs —— 用 Windows Media Foundation 把音频文件（MP3 等）解码成 WAV。
// 本机没有 ffmpeg，Edge 神经语音只肯给 MP3，所以自己解码。
// 用法: mfdecode.exe <输入音频> <输出wav>
// 说明: 输出采样率/声道/位深按解码器实际给出的格式写 WAV 头（默认盯着 24k 单声道 16bit，
//       也就是 Edge 的 audio-24khz-* 原生格式，不做重采样，避免依赖音频 DSP 组件）。
using System;
using System.IO;
using System.Runtime.InteropServices;

class Program
{
    const int MF_VERSION = 0x00020070;
    const int MF_SOURCE_READER_FIRST_AUDIO_STREAM = unchecked((int)0xFFFFFFFD);
    const int MF_SOURCE_READERF_ENDOFSTREAM = 0x2;

    [DllImport("mfplat.dll")]
    static extern int MFStartup(int version, int flags);
    [DllImport("mfplat.dll")]
    static extern int MFShutdown();
    [DllImport("mfplat.dll")]
    static extern int MFCreateMediaType(out IMFAttributes ppMFType);
    [DllImport("mfplat.dll")]
    static extern int MFCreateAttributes(out IMFAttributes ppMFAttributes, int cInitialSize);
    [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode)]
    static extern int MFCreateSourceReaderFromURL(string pwszURL, IMFAttributes pAttributes, out IMFSourceReader ppSourceReader);

    static readonly Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    static readonly Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    static readonly Guid MF_MT_AUDIO_NUM_CHANNELS = new Guid("37e48bf5-645e-4c5b-89de-ada9e29b696a");
    static readonly Guid MF_MT_AUDIO_SAMPLES_PER_SECOND = new Guid("5faeeae7-0290-4c31-9e8a-c534f68d9dba");
    static readonly Guid MF_MT_AUDIO_BITS_PER_SAMPLE = new Guid("f2deb57f-40fa-4764-aa33-ed4f2d1ff669");
    static readonly Guid MF_MT_AUDIO_BLOCK_ALIGNMENT = new Guid("322de230-9eeb-43bd-ab7a-ff412251541d");
    static readonly Guid MF_MT_AUDIO_AVG_BYTES_PER_SECOND = new Guid("1a9e6a7b-0e1a-4d3e-8a2b-4b1b1d3e5c6f");
    static readonly Guid MF_MT_ALL_SAMPLES_INDEPENDENT = new Guid("c9173739-5e56-461c-b713-46fb995cb95f");
    static readonly Guid MFMediaType_Audio = new Guid("73647561-0000-0010-8000-00AA00389B71");
    static readonly Guid MFAudioFormat_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
    static readonly Guid IMFAttributes_IID = new Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3");
    static readonly Guid IMFSample_IID = new Guid("C40A00F2-B93A-4FC8-AE4C-1F5C0E3B0B0A");
    // MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING = {16a16d76-2ebc-4848-b5a2-15e4d5e5f3d0}
    static readonly Guid MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING = new Guid("16a16d76-2ebc-4848-b5a2-15e4d5e5f3d0");

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int QueryInterfaceDelegate(IntPtr pUnk, ref Guid iid, out IntPtr ppv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ConvertToContiguousBufferDelegate(IntPtr pSample, out IntPtr ppBuffer);

    static IntPtr VtblSlot(IntPtr pComObject, int slot)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(pComObject);
        return Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size);
    }

    static int RawQueryInterface(IntPtr pUnk, Guid iid, out IntPtr ppv)
    {
        QueryInterfaceDelegate del = (QueryInterfaceDelegate)Marshal.GetDelegateForFunctionPointer(VtblSlot(pUnk, 0), typeof(QueryInterfaceDelegate));
        Guid g = iid;
        return del(pUnk, ref g, out ppv);
    }

    // IMFSample::ConvertToContiguousBuffer 是第 41 槽（3 个 IUnknown + 30 个 IMFAttributes + 前 8 个样例方法）
    static int SampleToBuffer(IntPtr pSample, out IntPtr ppBuffer)
    {
        ConvertToContiguousBufferDelegate del = (ConvertToContiguousBufferDelegate)Marshal.GetDelegateForFunctionPointer(VtblSlot(pSample, 41), typeof(ConvertToContiguousBufferDelegate));
        return del(pSample, out ppBuffer);
    }
    static int Main(string[] args)
    {
        Console.WriteLine("mfdecode 启动, 参数 " + args.Length + " 个");
        try
        {
            return Run(args);
        }
        catch (Exception e)
        {
            Console.WriteLine("异常: " + e.GetType().FullName + " / " + e.Message);
            return 1;
        }
    }

    static int Run(string[] args)
    {
        if (args.Length < 2)
        {
            Console.WriteLine("用法: mfdecode.exe <输入音频> <输出wav> [采样率] [声道]");
            return 2;
        }
        string input = args[0], output = args[1];
        int wantRate = args.Length > 2 ? int.Parse(args[2]) : 24000;
        int wantCh = args.Length > 3 ? int.Parse(args[3]) : 1;

        int hr = MFStartup(MF_VERSION, 0);
        if (hr != 0) { Console.WriteLine("MFStartup 失败 0x" + hr.ToString("X8")); return 1; }
        IMFAttributes attrs = null;
        IMFSourceReader reader = null;
        try
        {
            hr = MFCreateAttributes(out attrs, 1);
            if (hr == 0)
            {
                Guid gProc = MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING;
                attrs.SetUINT32(ref gProc, 1);
            }
            hr = MFCreateSourceReaderFromURL(input, attrs, out reader);
            if (hr != 0) { Console.WriteLine("打开失败 0x" + hr.ToString("X8")); return 1; }

            IMFAttributes pcm = null;
            hr = MFCreateMediaType(out pcm);
            if (hr != 0) { Console.WriteLine("MFCreateMediaType 失败 0x" + hr.ToString("X8")); return 1; }
            Guid gMajor = MF_MT_MAJOR_TYPE, vAudio = MFMediaType_Audio;
            pcm.SetGUID(ref gMajor, ref vAudio);
            Guid gSub = MF_MT_SUBTYPE, vPcm = MFAudioFormat_PCM;
            pcm.SetGUID(ref gSub, ref vPcm);
            Guid gCh = MF_MT_AUDIO_NUM_CHANNELS; pcm.SetUINT32(ref gCh, wantCh);
            Guid gRate = MF_MT_AUDIO_SAMPLES_PER_SECOND; pcm.SetUINT32(ref gRate, wantRate);
            Guid gBits = MF_MT_AUDIO_BITS_PER_SAMPLE; pcm.SetUINT32(ref gBits, 16);
            Guid gAlign = MF_MT_AUDIO_BLOCK_ALIGNMENT; pcm.SetUINT32(ref gAlign, wantCh * 2);
            Guid gAvg = MF_MT_AUDIO_AVG_BYTES_PER_SECOND; pcm.SetUINT32(ref gAvg, wantRate * wantCh * 2);
            Guid gInd = MF_MT_ALL_SAMPLES_INDEPENDENT; pcm.SetUINT32(ref gInd, 1);

            hr = reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, IntPtr.Zero, pcm);
            if (hr != 0) { Console.WriteLine("设置输出格式失败 0x" + hr.ToString("X8")); return 1; }
            Marshal.ReleaseComObject(pcm);

            // 回读实际格式，保证 WAV 头正确
            IMFAttributes actual = null;
            hr = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, out actual);
            int outRate = wantRate, outCh = wantCh, outBits = 16;
            if (hr == 0 && actual != null)
            {
                Guid a = MF_MT_AUDIO_SAMPLES_PER_SECOND; int v;
                if (actual.GetUINT32(ref a, out v) == 0) outRate = v;
                a = MF_MT_AUDIO_NUM_CHANNELS;
                if (actual.GetUINT32(ref a, out v) == 0) outCh = v;
                a = MF_MT_AUDIO_BITS_PER_SAMPLE;
                if (actual.GetUINT32(ref a, out v) == 0) outBits = v;
                Marshal.ReleaseComObject(actual);
            }

            MemoryStream pcmData = new MemoryStream();
            int readCount = 0;
            while (true)
            {
                int actualStream, flags; long ts; IntPtr pSample;
                hr = reader.ReadSample(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, out actualStream, out flags, out ts, out pSample);
                if (readCount < 2) Console.WriteLine("ReadSample hr=0x" + hr.ToString("X8") + " flags=" + flags + " ptr=" + pSample);
                readCount++;
                if (hr != 0) break;
                if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) break;
                if (pSample == IntPtr.Zero) continue;
                IntPtr pBuf;
                int convHr = SampleToBuffer(pSample, out pBuf);
                if (readCount <= 1)
                {
                    IntPtr pr, pr2; Guid ga = IMFAttributes_IID, gs = IMFSample_IID;
                    int qi1 = RawQueryInterface(pSample, ga, out pr); if (pr != IntPtr.Zero) Marshal.Release(pr);
                    int qi2 = RawQueryInterface(pSample, gs, out pr2); if (pr2 != IntPtr.Zero) Marshal.Release(pr2);
                    Console.WriteLine("首块诊断: QI(IMFAttributes)=0x" + qi1.ToString("X8") + " QI(IMFSample)=0x" + qi2.ToString("X8") + " ConvertToContiguousBuffer=0x" + convHr.ToString("X8"));
                }
                if (convHr == 0 && pBuf != IntPtr.Zero)
                {
                    IMFMediaBuffer buf = (IMFMediaBuffer)Marshal.GetObjectForIUnknown(pBuf);
                    IntPtr p; int maxLen, curLen;
                    if (buf.Lock(out p, out maxLen, out curLen) == 0)
                    {
                        if (curLen > 0)
                        {
                            byte[] tmp = new byte[curLen];
                            Marshal.Copy(p, tmp, 0, curLen);
                            pcmData.Write(tmp, 0, curLen);
                        }
                        buf.Unlock();
                    }
                    Marshal.ReleaseComObject(buf);
                    Marshal.Release(pBuf);
                }
                Marshal.Release(pSample);
            }

            byte[] data = pcmData.ToArray();
            int byteRate = outRate * outCh * (outBits / 8);
            using (FileStream fs = new FileStream(output, FileMode.Create, FileAccess.Write))
            using (BinaryWriter w = new BinaryWriter(fs))
            {
                int blockAlign = outCh * (outBits / 8);
                w.Write(new char[] { 'R', 'I', 'F', 'F' });
                w.Write(36 + data.Length);
                w.Write(new char[] { 'W', 'A', 'V', 'E' });
                w.Write(new char[] { 'f', 'm', 't', ' ' });
                w.Write(16);
                w.Write((short)1);
                w.Write((short)outCh);
                w.Write(outRate);
                w.Write(byteRate);
                w.Write((short)blockAlign);
                w.Write((short)outBits);
                w.Write(new char[] { 'd', 'a', 't', 'a' });
                w.Write(data.Length);
                w.Write(data);
            }
            double secs = data.Length / (double)byteRate;
            Console.WriteLine("OK " + output + " 采样=" + outRate + "Hz " + outCh + "ch " + outBits + "bit 时长=" + secs.ToString("0.00") + "s");
            return 0;
        }
        finally
        {
            if (reader != null) Marshal.ReleaseComObject(reader);
            if (attrs != null) Marshal.ReleaseComObject(attrs);
            MFShutdown();
        }
    }

    [ComImport, Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFAttributes
    {
        int GetItem(ref Guid guidKey, IntPtr pValue);
        int GetItemType(ref Guid guidKey, out int pType);
        int CompareItem(ref Guid guidKey, IntPtr pValue, out int pbResult);
        int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        int GetUINT32(ref Guid guidKey, out int punValue);
        int GetUINT64(ref Guid guidKey, out long punValue);
        int GetDouble(ref Guid guidKey, out double pfValue);
        int GetGUID(ref Guid guidKey, out Guid pguidValue);
        int GetStringLength(ref Guid guidKey, out int pcchLength);
        int GetString(ref Guid guidKey, IntPtr pwszValue, int cchBufSize, IntPtr pcchLength);
        int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, IntPtr pcbBlobSize);
        int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        int SetItem(ref Guid guidKey, IntPtr pValue);
        int DeleteItem(ref Guid guidKey);
        int DeleteAllItems();
        int SetUINT32(ref Guid guidKey, int unValue);
        int SetUINT64(ref Guid guidKey, long unValue);
        int SetDouble(ref Guid guidKey, double fValue);
        int SetGUID(ref Guid guidKey, ref Guid guidValue);
    }


    [ComImport, Guid("045FA593-8799-42B8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaBuffer
    {
        int Lock(out IntPtr ppbBuffer, out int pcbMaxLength, out int pcbCurrentLength);
        int Unlock();
        int GetCurrentLength(out int pcbCurrentLength);
        int SetCurrentLength(int cbCurrentLength);
        int GetMaxLength(out int pcbMaxLength);
    }

    [ComImport, Guid("C40A00F2-B93A-4FC8-AE4C-1F5C0E3B0B0A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSample : IMFAttributes
    {
        int GetSampleFlags(out int pdwSampleFlags);
        int SetSampleFlags(int dwSampleFlags);
        int GetSampleTime(out long phnsSampleTime);
        int SetSampleTime(long hnsSampleTime);
        int GetSampleDuration(out long phnsSampleDuration);
        int SetSampleDuration(long hnsSampleDuration);
        int GetBufferCount(out int pdwBufferCount);
        int GetBufferByIndex(int dwIndex, out IMFMediaBuffer ppBuffer);
        int ConvertToContiguousBuffer(out IMFMediaBuffer ppBuffer);
    }

    [ComImport, Guid("70AE66F2-C809-4E4F-8915-BDCB406B7993"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSourceReader
    {
        int GetStreamSelection(int dwStreamIndex, out int pfSelected);
        int SetStreamSelection(int dwStreamIndex, int fSelected);
        int GetNativeMediaType(int dwStreamIndex, int dwMediaTypeIndex, out IMFAttributes ppMediaType);
        int GetCurrentMediaType(int dwStreamIndex, out IMFAttributes ppMediaType);
        int SetCurrentMediaType(int dwStreamIndex, IntPtr pdwReserved, IMFAttributes pMediaType);
        int SetCurrentPosition(ref Guid guidTimeFormat, IntPtr varPosition);
        int ReadSample(int dwStreamIndex, int dwControlFlags, out int pdwActualStreamIndex, out int pdwStreamFlags, out long pllTimestamp, out IntPtr ppSample);
        int Flush(int dwStreamIndex);
        int GetServiceForStream(int dwStreamIndex, ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
        int GetPresentationAttribute(int dwStreamIndex, ref Guid guidAttribute, IntPtr pvarAttribute);
    }
}
