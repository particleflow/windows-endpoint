param([Parameter(Mandatory=$true)][string]$FilesJson)
$ErrorActionPreference = 'Stop'
try {
    $files = @($FilesJson | ConvertFrom-Json)
    if ($files.Count -lt 1 -or $files.Count -gt 24) { throw 'bounded_reference_inventory_required' }
    $result = @()
    foreach ($file in $files) {
        if ($file -isnot [string] -or -not [IO.Path]::IsPathRooted($file)) { throw 'absolute_reference_required' }
        $item = Get-Item -LiteralPath $file -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reference_link_refused' }
        $acl = Get-Acl -LiteralPath $file
        # Exact owner/group/DACL/control representation, with ACE order and
        # inherited flags intact. No SACL privilege, ACL edit or trust grant.
        $bytes = $acl.GetSecurityDescriptorBinaryForm()
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
        finally { $hasher.Dispose() }
        $result += @{ ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
            groupSid=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value; descriptorSha256=$digest }
    }
    ConvertTo-Json -InputObject $result -Depth 3 -Compress
} catch {
    [Console]::Error.WriteLine('producer_reference_security_unavailable')
    exit 2
}
