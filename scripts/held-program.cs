// A packaging gate: inspect image-load debug events before the loader can
// initialize a DLL. The verified program and its pinned DLL stay locked by
// the caller. Other code may come only from Windows' platform directories.
using System;
using System.Collections;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class SpectraHeldProgram {
    [StructLayout(LayoutKind.Sequential)] struct Security {
        public int length; public IntPtr descriptor; public int inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize; public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread; public uint processId, threadId;
    }
    // DEBUG_EVENT on x64: three DWORDs, alignment padding, then its union.
    [StructLayout(LayoutKind.Explicit, Size = 176)] struct DebugEvent {
        [FieldOffset(0)] public uint code;
        [FieldOffset(4)] public uint processId;
        [FieldOffset(8)] public uint threadId;
        [FieldOffset(16)] public IntPtr file;
        [FieldOffset(16)] public uint exitOrExceptionCode;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(
        out IntPtr read, out IntPtr write, ref Security security, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(
        string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit,
        uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WaitForDebugEvent(out DebugEvent e, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ContinueDebugEvent(uint process, uint thread, uint status);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(
        IntPtr handle, StringBuilder path, uint size, uint flags);

    public sealed class Result {
        public int Code; public string Output, Errors;
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle) {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        handle = IntPtr.Zero;
    }
    static string FinalPath(IntPtr file) {
        if (file == IntPtr.Zero || file == new IntPtr(-1))
            throw new InvalidOperationException("Windows supplied no handle for a loaded image");
        StringBuilder path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(file, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        string value = path.ToString();
        if (value.StartsWith(@"\\?\UNC\")) return @"\\" + value.Substring(8);
        return value.StartsWith(@"\\?\") ? value.Substring(4) : value;
    }
    static bool Under(string file, string directory) {
        return file.StartsWith(directory.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }
    static void VerifyLoad(IntPtr file, uint eventCode, string executable, string directory) {
        string path = FinalPath(file);
        if (eventCode == 3) {
            if (!String.Equals(path, executable, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The loaded program is not the verified executable: " + path);
            return;
        }
        if (String.Equals(path, Path.Combine(directory, "gsdll64.dll"), StringComparison.OrdinalIgnoreCase)) return;
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (Under(path, Environment.SystemDirectory) || Under(path, Path.Combine(windows, "WinSxS"))) return;
        throw new InvalidOperationException("Refusing an unverified DLL before initialization: " + path);
    }
    public static Result Run(ProcessStartInfo start, string directory) {
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("The held-program gate requires x64 PowerShell");
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
        IntPtr errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, environment = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        StreamReader stdout = null, stderr = null;
        bool exited = false;
        try {
            Security security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = 1 };
            Check(CreatePipe(out outputRead, out outputWrite, ref security, 0));
            Check(CreatePipe(out errorRead, out errorWrite, ref security, 0));
            Check(CreatePipe(out inputRead, out inputWrite, ref security, 0));
            Check(SetHandleInformation(outputRead, 1, 0));
            Check(SetHandleInformation(errorRead, 1, 0));
            Check(SetHandleInformation(inputWrite, 1, 0));
            string[] names = new string[start.EnvironmentVariables.Count];
            start.EnvironmentVariables.Keys.CopyTo(names, 0);
            Array.Sort(names, StringComparer.OrdinalIgnoreCase);
            StringBuilder block = new StringBuilder();
            foreach (string name in names) block.Append(name).Append('=').Append(start.EnvironmentVariables[name]).Append('\0');
            block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            Startup startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), flags = 0x100,
                input = inputRead, output = outputWrite, error = errorWrite };
            StringBuilder command = new StringBuilder("\"" + start.FileName + "\" " + start.Arguments);
            // DEBUG_ONLY_THIS_PROCESS | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
            Check(CreateProcessW(start.FileName, command, IntPtr.Zero, IntPtr.Zero, true,
                0x2 | 0x400 | 0x08000000, environment, directory, ref startup, out process));
            Close(ref outputWrite); Close(ref errorWrite); Close(ref inputRead); Close(ref inputWrite);
            stdout = new StreamReader(new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read));
            outputRead = IntPtr.Zero;
            stderr = new StreamReader(new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read));
            errorRead = IntPtr.Zero;
            var output = stdout.ReadToEndAsync();
            var errors = stderr.ReadToEndAsync();
            Stopwatch watch = Stopwatch.StartNew();
            bool initialBreakpoint = true;
            int code = -1;
            while (!exited) {
                if (watch.Elapsed.TotalMinutes >= 5) throw new TimeoutException("Ghostscript gate timed out");
                DebugEvent e;
                if (!WaitForDebugEvent(out e, 1000)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 121) throw new Win32Exception(error);
                    if (watch.Elapsed.TotalMinutes >= 5) throw new TimeoutException("Ghostscript gate timed out");
                    continue;
                }
                uint continuation = 0x00010002; // DBG_CONTINUE
                if (e.code == 3 || e.code == 6) {
                    try { VerifyLoad(e.file, e.code, start.FileName, directory); }
                    catch {
                        TerminateProcess(process.process, 1);
                        ContinueDebugEvent(e.processId, e.threadId, continuation);
                        throw;
                    }
                    finally { CloseHandle(e.file); }
                } else if (e.code == 1) {
                    // Consume the loader's initial breakpoint only. Real program
                    // exceptions keep their normal first/second-chance behavior.
                    if (initialBreakpoint && e.exitOrExceptionCode == 0x80000003) initialBreakpoint = false;
                    else continuation = 0x80010001; // DBG_EXCEPTION_NOT_HANDLED
                } else if (e.code == 5) {
                    code = unchecked((int)e.exitOrExceptionCode);
                    exited = true;
                }
                Check(ContinueDebugEvent(e.processId, e.threadId, continuation));
            }
            return new Result { Code = code, Output = output.Result, Errors = errors.Result };
        } finally {
            if (process.process != IntPtr.Zero && !exited) {
                TerminateProcess(process.process, 1);
                // Drain debug events so termination completes before callers
                // release the verified file handles or remove probe files.
                DebugEvent e;
                while (WaitForDebugEvent(out e, 1000)) {
                    if (e.code == 3 || e.code == 6) CloseHandle(e.file);
                    ContinueDebugEvent(e.processId, e.threadId, 0x00010002);
                    if (e.code == 5) break;
                }
                WaitForSingleObject(process.process, 5000);
            }
            if (stdout != null) stdout.Dispose();
            if (stderr != null) stderr.Dispose();
            Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
            Close(ref inputRead); Close(ref inputWrite);
            Close(ref process.thread); Close(ref process.process);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
