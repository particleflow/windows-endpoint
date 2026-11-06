param([Parameter(Mandatory=$true)][string]$FilesBase64)
$ErrorActionPreference = 'Stop'
$stage = 'argument'
try {
    $encoding = [Text.UTF8Encoding]::new($false,$true)
    $inputBytes = [Convert]::FromBase64String($FilesBase64)
    $json = $encoding.GetString($inputBytes)
    # PS5 can emit a JSON array as one pipeline object. Direct assignment keeps
    # its 22 string entries flat; @(... | ConvertFrom-Json) can wrap that array.
    $files = ConvertFrom-Json -InputObject $json
    if ($files -isnot [array] -or $files.Count -ne 22) { throw 'bounded_reference_inventory_required' }
    $result = @()
    foreach ($file in $files) {
        $stage = 'item'
        if ($file -isnot [string] -or -not [IO.Path]::IsPathRooted($file)) { throw 'absolute_reference_required' }
        $item = Get-Item -LiteralPath $file -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reference_link_refused' }
        $stage = 'descriptor'
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
    $stage = 'output'
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $inputDigest = [BitConverter]::ToString($hasher.ComputeHash($inputBytes)).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    @{ schema=1; requestSha256=$inputDigest; files=$result } | ConvertTo-Json -Depth 4 -Compress
} catch {
    [Console]::Error.WriteLine(('{"error":"producer_reference_security_unavailable","stage":"'+$stage+'"}'))
    exit 2
}
