# Finite client for the unchanged official Herdr named-pipe API. No server,
# service, elevation, execution-policy change, or process termination by PID.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$MarkerPath,
    [Parameter(Mandatory = $true)][string]$Generation,
    [Parameter(Mandatory = $true)][uint32]$OwnerProcessId,
    [Parameter(Mandatory = $true)][ValidateSet('ping', 'server.stop')][string]$Action
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Runtime.InteropServices;
public static class MemohOwnedHerdr {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
    public static string Request(string marker, string generation, uint owner, string action) {
        if (action != "ping" && action != "server.stop") throw new Exception("herdr_request_rejected");
        if (!Path.IsPathRooted(marker) || generation.Length > 80 || File.ReadAllText(marker) != generation)
            throw new Exception("herdr_generation_changed");
        using (var pipe = new NamedPipeClientStream(".", marker, PipeDirection.InOut, PipeOptions.Asynchronous)) {
            pipe.Connect(5000);
            uint peer;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out peer))
                throw new Exception("herdr_ownership_unverified");
            if (peer != owner) throw new Exception("herdr_owner_mismatch");
            if (File.ReadAllText(marker) != generation) throw new Exception("herdr_generation_changed");
            // The verified peer and the action use the SAME connection. Reopening
            // via a session CLI after checking the marker would introduce a race.
            byte[] request = Encoding.UTF8.GetBytes("{\"id\":\"endpoint-owned\",\"method\":\"" + action + "\",\"params\":{}}\n");
            var write = pipe.WriteAsync(request, 0, request.Length);
            if (!write.Wait(5000)) throw new Exception("herdr_request_timeout");
            var deadline = DateTime.UtcNow.AddSeconds(5);
            using (var buffer = new MemoryStream()) {
                var chunk = new byte[1024];
                while (buffer.Length < 16384) {
                    int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (left <= 0) throw new Exception("herdr_request_timeout");
                    var read = pipe.ReadAsync(chunk, 0, chunk.Length);
                    if (!read.Wait(left)) throw new Exception("herdr_request_timeout");
                    int count = read.Result;
                    if (count == 0) throw new Exception("herdr_request_incomplete");
                    for (int i = 0; i < count; i++) {
                        if (chunk[i] == 10) return new UTF8Encoding(false, true).GetString(buffer.ToArray());
                        if (buffer.Length >= 16384) throw new Exception("herdr_request_oversized");
                        buffer.WriteByte(chunk[i]);
                    }
                }
            }
            throw new Exception("herdr_request_oversized");
        }
    }
}
'@
    $reply = [MemohOwnedHerdr]::Request($MarkerPath, $Generation, $OwnerProcessId, $Action)
    $parsed = $reply | ConvertFrom-Json
    if ($parsed.id -ne 'endpoint-owned' -or $null -ne $parsed.error -or $null -eq $parsed.result) { throw 'herdr_request_failed' }
    [Console]::Out.WriteLine($reply)
    exit 0
} catch {
    $reason = $_.Exception
    while ($null -ne $reason.InnerException) { $reason = $reason.InnerException }
    $code = $reason.Message
    if ($code -notmatch '^herdr_(owner_mismatch|generation_changed|ownership_unverified|request_(rejected|timeout|incomplete|oversized|failed))$') { $code = 'herdr_ownership_unverified' }
    [Console]::Out.WriteLine((@{error=$code} | ConvertTo-Json -Compress))
    exit 2
}
