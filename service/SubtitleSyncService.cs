// Runs the Subtitle Sync addon as a Windows service.
//
// Node cannot answer the service control manager by itself, so this wrapper
// does it: it starts node on the built server, starts it again when it exits,
// and stops it with the service. Node and everything it starts (ffprobe) run
// inside a job object that is closed with the wrapper, so nothing outlives the
// service, not even when the wrapper itself crashes.
//
// Built by service/install.ps1 with the C# compiler that ships with Windows.
// To try it in a terminal: SubtitleSyncService.exe --console [--node <path>] [--dir <path>]

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace SubtitleSync
{
    public sealed class Wrapper : ServiceBase
    {
        public const string Name = "SubtitleSync";

        /// <summary>A server that ran this long before exiting is not failing at startup.</summary>
        static readonly TimeSpan HealthyRun = TimeSpan.FromMinutes(5);

        readonly string node;
        readonly string dir;
        readonly string logDir;
        readonly object gate = new object();
        readonly object logGate = new object();

        IntPtr job = IntPtr.Zero;
        Process child;
        DateTime childStarted;
        bool stopping;
        int failures;
        Timer restartTimer;

        public Wrapper(string node, string dir)
        {
            ServiceName = Name;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
            this.node = node;
            this.dir = dir;
            logDir = Path.Combine(dir, "logs");
        }

        protected override void OnStart(string[] args) { Begin(); }
        protected override void OnStop() { End(); }
        protected override void OnShutdown() { End(); }

        public void Begin()
        {
            Directory.CreateDirectory(logDir);
            job = CreateKillOnCloseJob();
            Log("starting: " + node + " in " + dir);
            Launch();
        }

        public void End()
        {
            Process running;
            lock (gate)
            {
                stopping = true;
                if (restartTimer != null) restartTimer.Dispose();
                running = child;
            }
            Log("stopping");

            // Closing the job ends node and every process it started.
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
                job = IntPtr.Zero;
            }
            // Only matters if node could not be put in the job.
            if (running != null)
            {
                try { if (!running.HasExited) running.Kill(); } catch { }
            }
        }

        void Launch()
        {
            lock (gate)
            {
                if (stopping) return;
                if (child != null) child.Dispose();
                child = null;

                var info = new ProcessStartInfo(node, "--env-file-if-exists=.env dist/src/index.js")
                {
                    WorkingDirectory = dir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                // The server keeps its own log. The service account may only write to logs\.
                info.EnvironmentVariables["LOG_FILE"] = Path.Combine(logDir, "subtitle-sync.log");

                var process = new Process { StartInfo = info, EnableRaisingEvents = true };
                // Standard output repeats the server's own log, but it must still be read,
                // or node blocks once the pipe fills up.
                process.OutputDataReceived += (sender, e) => { };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Log("node: " + e.Data); };
                process.Exited += OnChildExited;

                try
                {
                    process.Start();
                }
                catch (Exception error)
                {
                    Log("could not start node: " + error.Message);
                    process.Dispose();
                    ScheduleRestart();
                    return;
                }

                if (job != IntPtr.Zero && !AssignProcessToJobObject(job, process.Handle))
                {
                    Log("could not put node in the job object (error " + Marshal.GetLastWin32Error() +
                        "), so processes it starts may outlive the service");
                }

                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                child = process;
                childStarted = DateTime.UtcNow;
                Log("node started, pid " + process.Id);
            }
        }

        void OnChildExited(object sender, EventArgs e)
        {
            int code;
            try { code = ((Process)sender).ExitCode; } catch { code = -1; }

            lock (gate)
            {
                if (stopping) return;
                Log("node exited with code " + code);
                if (DateTime.UtcNow - childStarted > HealthyRun) failures = 0;
                ScheduleRestart();
            }
        }

        /// <summary>Waits longer after each failure in a row, so a server that cannot start does not spin.</summary>
        void ScheduleRestart()
        {
            lock (gate)
            {
                if (stopping) return;
                failures++;
                int delayMs = Math.Min(60000, 2000 * (1 << Math.Min(failures - 1, 5)));
                Log("starting node again in " + (delayMs / 1000) + "s");
                if (restartTimer != null) restartTimer.Dispose();
                restartTimer = new Timer(state => Launch(), null, delayMs, Timeout.Infinite);
            }
        }

        void Log(string message)
        {
            string line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " " + message + Environment.NewLine;
            lock (logGate)
            {
                try { File.AppendAllText(Path.Combine(logDir, "service.log"), line); } catch { }
                if (Environment.UserInteractive) Console.Write(line);
            }
        }

        IntPtr CreateKillOnCloseJob()
        {
            IntPtr handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                Log("could not create a job object (error " + Marshal.GetLastWin32Error() + ")");
                return IntPtr.Zero;
            }

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ref limits, size))
            {
                Log("could not configure the job object (error " + Marshal.GetLastWin32Error() + ")");
                CloseHandle(handle);
                return IntPtr.Zero;
            }
            return handle;
        }

        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);
    }

    static class Program
    {
        static int Main(string[] args)
        {
            // The wrapper lives in <project>\service\bin.
            string dir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
            string node = null;
            bool console = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--console") console = true;
                else if (args[i] == "--node" && i + 1 < args.Length) node = args[++i];
                else if (args[i] == "--dir" && i + 1 < args.Length) dir = Path.GetFullPath(args[++i]);
            }
            if (node == null) node = FindOnPath("node.exe") ?? "node.exe";

            var wrapper = new Wrapper(node, dir);
            if (!console)
            {
                ServiceBase.Run(wrapper);
                return 0;
            }

            var stopped = new ManualResetEvent(false);
            Console.CancelKeyPress += (sender, e) => { e.Cancel = true; stopped.Set(); };
            wrapper.Begin();
            if (Console.IsInputRedirected)
            {
                // No keyboard to wait on: run until Ctrl+C or until this process is ended.
                stopped.WaitOne();
            }
            else
            {
                Console.WriteLine("Running. Press Enter or Ctrl+C to stop.");
                ThreadPool.QueueUserWorkItem(state => { Console.ReadLine(); stopped.Set(); });
                stopped.WaitOne();
            }
            wrapper.End();
            return 0;
        }

        static string FindOnPath(string file)
        {
            foreach (string part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try
                {
                    string candidate = Path.Combine(part.Trim(), file);
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException)
                {
                    // A malformed PATH entry; skip it.
                }
            }
            return null;
        }
    }
}
