using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Disposable CI process containment, not product process supervision.
public sealed class OwnedFixtureJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minimum, maximum; public uint processLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user,kernel,periodUser,periodKernel;
    public uint faults,total,active,terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  IntPtr owned;
  public string Name { get; private set; }
  public OwnedFixtureJob() {
    Name="Local\\endpoint-ci-"+Guid.NewGuid().ToString("N");
    owned=CreateJobObject(IntPtr.Zero,Name);
    if(owned==IntPtr.Zero) throw new Win32Exception();
    Extended info=new Extended(); info.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
    if(!SetInformationJobObject(owned,9,ref info,(uint)Marshal.SizeOf(typeof(Extended)))) { CloseHandle(owned); owned=IntPtr.Zero; throw new Win32Exception(); }
  }
  public static void Join(string name) {
    IntPtr job=OpenJobObject(1,false,name); // ASSIGN_PROCESS only
    if(job==IntPtr.Zero) throw new Win32Exception();
    try { if(!AssignProcessToJobObject(job,GetCurrentProcess())) throw new Win32Exception(); }
    finally { CloseHandle(job); }
  }
  bool EmptyWithin(int milliseconds) {
    Stopwatch watch=Stopwatch.StartNew();
    do {
      Accounting info;
      if(!QueryInformationJobObject(owned,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception();
      if(info.active==0) return true;
      Thread.Sleep(50);
    } while(watch.ElapsedMilliseconds<milliseconds);
    return false;
  }
  // Called only after the exact child supervisor has exited. A forced cleanup
  // is reported to the harness as failure, even when all descendants are gone.
  public bool Finish() {
    bool forced=false;
    try {
      if(!EmptyWithin(1000)) {
        forced=true;
        if(!TerminateJobObject(owned,1) || !EmptyWithin(5000)) throw new Exception("Owned fixture tree termination unconfirmed");
      }
      return forced;
    } finally { Dispose(); }
  }
  public void Dispose() { if(owned!=IntPtr.Zero) { CloseHandle(owned); owned=IntPtr.Zero; } }
}
