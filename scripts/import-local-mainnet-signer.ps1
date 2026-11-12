# Local-only credential import; never signs or broadcasts a blockchain transaction.
# NEAR CLI 0.31.1 uses keyring-rs: username.service target, UTF-16LE JSON blob.
$ErrorActionPreference='Stop'
$store=Join-Path $env:LOCALAPPDATA 'ShowStake\mainnet-signer'
$public=Get-Content (Join-Path $store 'public.json') -Raw|ConvertFrom-Json
if($public.network -ne 'mainnet' -or $public.account_id -notmatch '^[0-9a-f]{64}$'){throw 'Invalid public metadata'}
if(-not ('ShowStakeCredentialStore' -as [type])){
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ShowStakeCredentialStore {
 static bool SameKeys(string a,string b){
  foreach(string key in new[]{"public_key","private_key"}){
   string pattern="\""+key+"\"\\s*:\\s*\"([A-Za-z0-9:]+)\"";
   var x=System.Text.RegularExpressions.Regex.Matches(a,pattern);var y=System.Text.RegularExpressions.Regex.Matches(b,pattern);
   if(x.Count!=1 || y.Count!=1 || x[0].Groups[1].Value!=y[0].Groups[1].Value)return false;
  }return true;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Credential {
  public uint Flags,Type;public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize;public IntPtr CredentialBlob;public uint Persist,AttributeCount;public IntPtr Attributes;public string TargetAlias,UserName;
 }
 [DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Write(ref Credential c,uint flags);
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Read(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static void SaveOrVerify(string target,string user,string json){
  IntPtr existing;
  if(Read(target,1,0,out existing)){try{var c=(Credential)Marshal.PtrToStructure(existing,typeof(Credential));var old=Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2);if(!SameKeys(old,json))throw new Exception("Existing credential differs; refusing overwrite");return;}finally{CredFree(existing);}}
  if(Marshal.GetLastWin32Error()!=1168)throw new Win32Exception(Marshal.GetLastWin32Error());
  var ptr=Marshal.StringToHGlobalUni(json);
  try{var c=new Credential{Type=1,TargetName=target,Comment="ShowStake mainnet local signer; imported without plaintext file",CredentialBlobSize=(uint)(json.Length*2),CredentialBlob=ptr,Persist=2,UserName=user};if(!Write(ref c,0))throw new Win32Exception(Marshal.GetLastWin32Error());}
  finally{for(int i=0;i<json.Length*2;i++)Marshal.WriteByte(ptr,i,0);Marshal.FreeHGlobal(ptr);}
  if(!Read(target,1,0,out existing))throw new Win32Exception(Marshal.GetLastWin32Error());
  try{var c=(Credential)Marshal.PtrToStructure(existing,typeof(Credential));if(Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2)!=json)throw new Exception("Credential readback mismatch");}finally{CredFree(existing);}
 }
}
'@
}
$deriver=Join-Path $store 'derive-cli-key.cjs'
@'
const c=require('node:crypto');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(b){let v=BigInt('0x'+b.toString('hex')),s='';while(v){s=alphabet[Number(v%58n)]+s;v/=58n;}for(const n of b){if(n!==0)break;s='1'+s;}return s;}
const seed=Buffer.from(input.trim(),'hex');if(seed.length!==32)throw Error('Invalid seed');
const key=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
const pub=c.createPublicKey(key);const bytes=pub.export({format:'der',type:'spki'}).subarray(-32);
const challenge=Buffer.from('ShowStake local signer integrity check, no blockchain transaction');if(!c.verify(null,challenge,pub,c.sign(null,challenge,key)))throw Error('Signing integrity failed');
process.stdout.write(JSON.stringify({account_id:bytes.toString('hex'),public_key:'ed25519:'+base58(bytes),private_key:'ed25519:'+base58(Buffer.concat([seed,bytes]))}));seed.fill(0);input='';
});
'@ | Set-Content $deriver
$secure=ConvertTo-SecureString ([IO.File]::ReadAllText((Join-Path $store 'seed.dpapi')))
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{
 $seed=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
 # Anonymous pipe to Node; never command-line arguments, terminal output, or a plaintext key file.
 $material=$seed | & node $deriver | ConvertFrom-Json
 $seed=$null
 if($LASTEXITCODE -ne 0 -or $material.account_id -ne $public.account_id){throw 'Derived public account mismatch'}
 $body=@{jsonrpc='2.0';id='key-match';method='query';params=@{request_type='view_access_key_list';finality='final';account_id=$public.account_id}}|ConvertTo-Json -Depth 6
 $rpc=Invoke-RestMethod https://rpc.mainnet.near.org -Method Post -ContentType application/json -Body $body -TimeoutSec 20
 $match=@($rpc.result.keys|Where-Object {$_.public_key -eq $material.public_key -and $_.access_key.permission -eq 'FullAccess'})
 if($rpc.error -or $match.Count -ne 1){throw 'Public key not authorized on mainnet; nothing imported'}
 $user="$($public.account_id):$($material.public_key)"
 $service="near-mainnet-$($public.account_id)"
 $json=@{public_key=$material.public_key;private_key=$material.private_key}|ConvertTo-Json -Compress
 [ShowStakeCredentialStore]::SaveOrVerify("$user.$service",$user,$json)
 Write-Output "PASS_LOCAL: credential stored and read back; public key matches mainnet FullAccess; no transaction signed/broadcast."
 Write-Output "Account: $($public.account_id)"
 Write-Output "Public key: $($material.public_key)"
}finally{
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
 $seed=$null;$json=$null;$material=$null;$secure.Dispose()
}
