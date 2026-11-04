using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class NativeSupervisor
{
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimitInformation {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateMutex(IntPtr security, bool initialOwner, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReleaseMutex(IntPtr handle);

    static void Check(bool result, string action) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), action); }
    static string LockName(string scope, string session) {
        byte[] hash = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(scope + "\n" + session));
        return "Local\\CCDesktop.Session." + BitConverter.ToString(hash).Replace("-", "");
    }
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static readonly object OutputLock = new object();
    static Stream stdout;
    static readonly Encoding Utf8 = new UTF8Encoding(false);

    static void Output(string type, string detail) {
        string json = "{\"type\":\"" + type + "\",\"detail\":\"" + detail.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}\n";
        byte[] bytes = Utf8.GetBytes(json);
        lock (OutputLock) {
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }

    static bool IsStop(byte[] line) {
        int end = line.Length;
        if (end > 0 && line[end - 1] == (byte)'\r') end--;
        return end == 4 && line[0] == (byte)'s' && line[1] == (byte)'t' && line[2] == (byte)'o' && line[3] == (byte)'p';
    }

    static void CopyRaw(Stream from, Stream to) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = from.Read(buffer, 0, buffer.Length)) > 0) {
            lock (OutputLock) {
                to.Write(buffer, 0, read);
                to.Flush();
            }
        }
    }

    static void Discard(Stream stream) {
        byte[] buffer = new byte[1024];
        while (stream.Read(buffer, 0, buffer.Length) > 0) { }
    }
    static int Main(string[] args) {
        if (args.Length < 3) return 64;
        IntPtr mutex = IntPtr.Zero, job = IntPtr.Zero, helperHandle = IntPtr.Zero;
        bool ownsMutex = false;
        stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();
        try {
            mutex = CreateMutex(IntPtr.Zero, false, LockName(args[0], args[1]));
            Check(mutex != IntPtr.Zero, "create session mutex");
            uint wait = WaitForSingleObject(mutex, 0);
            if (wait == 0x102) { Output("busy", "session occupied"); return 3; }
            if (wait != 0 && wait != 0x80) throw new Win32Exception(Marshal.GetLastWin32Error(), "acquire session mutex");
            ownsMutex = true;
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "create job object");
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, memory, false);
                Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, memory, (uint)size), "set job limits");
            } finally { Marshal.FreeHGlobal(memory); }
            // The helper only reads a protocol start command. It cannot spawn the PTY before the assignment succeeds.
            var start = new ProcessStartInfo(args[2]) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.StandardOutputEncoding = Utf8;
            start.StandardErrorEncoding = Utf8;
            for (int i = 3; i < args.Length; i++) start.ArgumentListCompat(args[i]);
            using (var helper = Process.Start(start)) {
                if (helper == null) throw new Exception("helper spawn failed");
                helperHandle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, helper.Id);
                Check(helperHandle != IntPtr.Zero, "open helper handle");
                Check(AssignProcessToJobObject(job, helperHandle), "assign helper to job");
                Output("ready", helper.Id.ToString());
                // Byte pipes, not Console.ReadLine/WriteLine. Those decode with the
                // ANSI/OEM code page and re-encode, which turns a UTF-8 user line such
                // as {"type":"user","message":"你是谁"} into bytes JSON.parse rejects
                // ("Bad control character... at position 31") on the second turn.
                Stream helperInput = helper.StandardInput.BaseStream;
                var inputThread = new Thread(() => {
                    try {
                        var pending = new MemoryStream();
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = stdin.Read(buffer, 0, buffer.Length)) > 0) {
                            for (int i = 0; i < read; i++) {
                                byte b = buffer[i];
                                if (b != (byte)'\n') {
                                    if (pending.Length > 1024 * 1024) { TerminateJobObject(job, 1); return; }
                                    pending.WriteByte(b);
                                    continue;
                                }
                                byte[] line = pending.ToArray();
                                pending.SetLength(0);
                                if (IsStop(line)) { TerminateJobObject(job, 1); return; }
                                if (line.Length > 0) helperInput.Write(line, 0, line.Length);
                                helperInput.WriteByte((byte)'\n');
                                helperInput.Flush();
                            }
                        }
                        TerminateJobObject(job, 1);
                    } catch (IOException) { TerminateJobObject(job, 1); }
                    catch (InvalidOperationException) { TerminateJobObject(job, 1); }
                });
                var outputThread = new Thread(() => {
                    try { CopyRaw(helper.StandardOutput.BaseStream, stdout); }
                    catch (IOException) { }
                });
                var errorThread = new Thread(() => {
                    try { Discard(helper.StandardError.BaseStream); }
                    catch (IOException) { }
                });
                inputThread.IsBackground = outputThread.IsBackground = errorThread.IsBackground = true;
                inputThread.Start(); outputThread.Start(); errorThread.Start();
                helper.WaitForExit();
                outputThread.Join(2000);
                Output("stopped", helper.ExitCode.ToString());
            }
            return 0;
        } catch (Exception ex) {
            Console.Error.WriteLine(ex.GetType().Name + ": " + ex.Message);
            return 1;
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (helperHandle != IntPtr.Zero) CloseHandle(helperHandle);
            if (ownsMutex) ReleaseMutex(mutex);
            if (mutex != IntPtr.Zero) CloseHandle(mutex);
        }
    }
}

internal static class ProcessStartCompat
{
    // .NET Framework's ProcessStartInfo has no ArgumentList.
    public static void ArgumentListCompat(this ProcessStartInfo start, string value) {
        start.Arguments += (start.Arguments.Length == 0 ? "" : " ") + "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
