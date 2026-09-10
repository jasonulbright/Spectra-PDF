using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Test tooling only. The unnamed, non-inheritable job handle is the authority:
// no process-name search, PID recovery, or image-wide termination is permitted.
public static class OwnedProcess
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Inheritable(IntPtr handle) {
        IntPtr result; Check(DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), out result, 0, true, 2)); return result;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    public static int Run(string exe, string[] args, string ready) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobValue = IntPtr.Zero, handles = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        bool initialized = false; var process = new ProcessInfo();
        try {
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
            var limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>()));
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); initialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
            // JOB_LIST assigns membership during creation, with no suspended-but-unowned crash window.
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            IntPtr nul = CreateFile("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            Check(nul != new IntPtr(-1));
            try { input = Inheritable(nul); } finally { CloseHandle(nul); }
            output = Inheritable(GetStdHandle(-11)); error = Inheritable(GetStdHandle(-12));
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
            // Only stdio handles inherit, never the job handle or the supervisor's control pipe.
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx(); startup.Info.Size = (uint)Marshal.SizeOf<StartupEx>();
            startup.Info.Flags = 0x100; startup.Info.Input = input; startup.Info.Output = output; startup.Info.Error = error; startup.Attributes = attributes;
            var command = new StringBuilder(Quote(exe)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            Check(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out process));
            Console.Out.WriteLine(ready); Console.Out.Flush();
            // EOF includes the WDIO worker dying. The handle is also closed by Windows
            // if this supervisor is forcibly terminated, which kills orphaned descendants.
            Task<string> stop = Task.Run(() => Console.In.ReadLine());
            while (!stop.IsCompleted && WaitForSingleObject(process.Process, 100) == 258) { }
            bool requested = stop.IsCompleted;
            Check(TerminateJobObject(job, 1));
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (true) {
                Accounting accounting; Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
                if (accounting.Active == 0) break;
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("Owned E2E job did not become empty");
                Thread.Sleep(20);
            }
            if (requested) return 0;
            uint code; Check(GetExitCodeProcess(process.Process, out code));
            Console.Error.WriteLine("Owned E2E root exited before cleanup (exit " + code + ")");
            return 1;
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }
}
