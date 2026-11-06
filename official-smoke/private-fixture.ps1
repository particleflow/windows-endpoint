# Creates ONLY fresh isolated test objects with a private owner/DACL. No ACL
# repair, token changes, system trust changes, or access to an existing profile.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
# Stage/count-only diagnostics: never emit paths, document bodies or credentials.
function Trace-PrivateFixture([string]$stage, [string]$state, [int]$index = -1) {
  [Console]::Error.WriteLine((@{ privateFixtureStage=$stage; state=$state; index=$index } | ConvertTo-Json -Compress))
}
Trace-PrivateFixture 'compile' 'started'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class FreshPrivateFixture {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value, uint revision, out IntPtr result, out uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path, ref SA attributes);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, ref SA attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  static SA Attributes() {
    string sid = WindowsIdentity.GetCurrent().User.Value;
    IntPtr descriptor; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+sid+"D:P(A;OICI;FA;;;"+sid+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",1,out descriptor,out size)) throw new IOException("fixture descriptor failed");
    return new SA { length=Marshal.SizeOf(typeof(SA)), descriptor=descriptor, inherit=0 };
  }
  public static void Directory(string path) {
    SA sa=Attributes();
    try { if (!CreateDirectory(path,ref sa)) throw new IOException("fresh fixture directory failed: "+Marshal.GetLastWin32Error()); }
    finally { LocalFree(sa.descriptor); }
  }
  public static void File(string path, string content) {
    SA sa=Attributes();
    try {
      using (SafeFileHandle handle=CreateFile(path,0xC0000000,1,ref sa,1,0x80,IntPtr.Zero)) {
        if (handle.IsInvalid) throw new IOException("fresh fixture file failed");
        using (FileStream stream=new FileStream(handle,FileAccess.ReadWrite)) {
          byte[] bytes=System.Text.Encoding.UTF8.GetBytes(content); stream.Write(bytes,0,bytes.Length); stream.Flush(true);
        }
      }
    } finally { LocalFree(sa.descriptor); }
  }
}
'@
Trace-PrivateFixture 'compile' 'completed'
Trace-PrivateFixture 'read_input' 'started'
# Node writes UTF-8 without a BOM. Windows PowerShell 5.1 otherwise decodes
# this as the system ANSI code page, corrupting referenced Unicode paths.
$inputData = Get-Content -Raw -Encoding UTF8 -LiteralPath $InputFile | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($inputData.root).TrimEnd('\') + '\'
Trace-PrivateFixture 'read_input' 'completed'
$objectIndex = 0
foreach ($item in $inputData.items) {
    Trace-PrivateFixture 'create' 'started' $objectIndex
    $target = [IO.Path]::GetFullPath($item.path)
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $target)) { throw 'Fixture target not fresh or not contained' }
    if ($item.kind -eq 'directory') { [FreshPrivateFixture]::Directory($target) }
    elseif ($item.kind -eq 'file') { [FreshPrivateFixture]::File($target, $item.content) }
    else { throw 'Unknown fixture object' }
    Trace-PrivateFixture 'create' 'completed' $objectIndex
    $objectIndex++
}
