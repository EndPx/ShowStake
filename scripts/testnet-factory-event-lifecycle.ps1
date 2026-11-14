param(
 [Parameter(Mandatory=$true)][string]$FactoryWasm,
 [Parameter(Mandatory=$true)][string]$FactorySha256,
 [Parameter(Mandatory=$true)][string]$LeafWasm,
 [Parameter(Mandatory=$true)][string]$LeafSha256,
 [Parameter(Mandatory=$true)][string]$LeafCodeHash,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9]{1,20}$')][string]$RunId,
 [ValidateRange(600,3600)][int]$RegistrationSeconds=600,
 [ValidateRange(120,1800)][int]$CheckinSeconds=120,
 [string]$MockEarnWasm='', [string]$MockEarnSha256='',
 [switch]$ResumeFaucetOnly, [string]$ResumeProviderPublicKey='',
 [string]$ExistingProviderAccount='', [string]$ExistingProviderCodeHash='', [string]$ExistingProviderInitHash=''
)
# TESTNET only; every transaction must finish before the next. Never resume a run.
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent; Set-Location $repo
foreach($v in @($FactorySha256,$LeafSha256)){if($v -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid reviewed SHA256'}}
foreach($pair in @(@($FactoryWasm,$FactorySha256),@($LeafWasm,$LeafSha256))){if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ine $pair[1]){throw 'Wasm SHA256 mismatch'}}
if([bool]$MockEarnWasm -ne [bool]$MockEarnSha256){throw 'Both MockEarn path and reviewed SHA256 are required'}
if($MockEarnWasm -and ($MockEarnSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $MockEarnWasm -Algorithm SHA256).Hash -ine $MockEarnSha256)){throw 'MockEarn SHA256 mismatch'}
$out=Join-Path $repo "docs/evidence/testnet-factory-$RunId";if(Test-Path -LiteralPath $out){if(!$ResumeFaucetOnly -or (Test-Path (Join-Path $out 'transactions.json')) -or @(Get-ChildItem -LiteralPath $out -Filter '*.args.json').Count -gt 0 -or $ResumeProviderPublicKey -notmatch '^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$'){throw 'Run exists; only a reviewed empty-account faucet phase may resume'}}else{if($ResumeFaucetOnly){throw 'Resume requires existing faucet evidence'};New-Item -ItemType Directory -Path $out | Out-Null}
$rpc='https://test.rpc.fastnear.com';$ft='mockusdc.testnet';$provider='ss-earn-opt1113021957.testnet';$factory="ss-fac-$RunId.testnet"
if($MockEarnWasm){$provider="ss-prov-$RunId.testnet"}
if($ExistingProviderAccount){if($MockEarnWasm -or !$ExistingProviderAccount.EndsWith('.testnet') -or $ExistingProviderCodeHash -notmatch '^[1-9A-HJ-NP-Za-km-z]{32,44}$' -or $ExistingProviderInitHash -notmatch '^[1-9A-HJ-NP-Za-km-z]{32,64}$'){throw 'Invalid existing testnet provider proof'};$provider=$ExistingProviderAccount}
$users=@('showstake-participant-endpx.testnet','showstake-attendee-a-endpx.testnet','showstake-attendee-b-endpx.testnet','showstake-attendee-c-endpx.testnet','showstake-attendee-d-endpx.testnet');$owner=$users[0];$script:transactions=@()
function Save($name,$data){[IO.File]::WriteAllText((Join-Path $out $name),($data|ConvertTo-Json -Depth 100))}
function Rpc($method,$parameters){
 $body=@{jsonrpc='2.0';id='testnet';method=$method;params=$parameters}|ConvertTo-Json -Depth 100 -Compress
 for($attempt=0;$attempt -lt 4;$attempt++){
  try{$r=Invoke-RestMethod $rpc -Method Post -TimeoutSec 20 -ContentType 'application/json' -Body $body;if($r.error){$message=$r.error|ConvertTo-Json -Depth 20 -Compress;if($message -match '429|rate.limit|temporar|timeout|unavailable' -and $attempt -lt 3){Start-Sleep -Seconds (1+$attempt*2);continue};throw $message};return $r.result}
  catch{if($_.Exception.Message -match '429|rate.limit|temporar|timed? ?out|unavailable|502|503|504' -and $attempt -lt 3){Start-Sleep -Seconds (1+$attempt*2);continue};throw}
 }
 throw 'RPC read retries exhausted'
}
function View($id,$method,$payload){$a=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Depth 20 -Compress)));$x=Rpc 'query' @{request_type='call_function';finality='final';account_id=$id;method_name=$method;args_base64=$a};return ([Text.Encoding]::UTF8.GetString([byte[]]$x.result)|ConvertFrom-Json)}
function Equal($actual,$expected,$label){if([string]$actual -cne [string]$expected){throw "$label mismatch"}}
function FinalTransaction($hash,$sender){
 for($poll=0;$poll -lt 30;$poll++){
  try{$tx=Rpc 'EXPERIMENTAL_tx_status' @($hash,$sender);if($tx.final_execution_status -eq 'FINAL'){return $tx}}catch{if($_.Exception.Message -notmatch 'UNKNOWN_TRANSACTION|does not exist|not found|not available yet'){throw}}
  Start-Sleep -Seconds 1
 }
 throw "Known transaction $hash is not final; preserve the attempt and never resend"
}
function Invoke-NearTransaction($label,$sender,$receiver,$cliArgs,$expectedFailure=$false){
 $old=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$lines=& near @cliArgs 2>&1;$exit=$LASTEXITCODE}finally{$ErrorActionPreference=$old}
 $plain=($lines -join "`n") -replace '\x1B\[[0-9;]*[A-Za-z]','';$m=[regex]::Match($plain,'Transaction ID:\s+([1-9A-HJ-NP-Za-km-z]+)')
 if(!$m.Success){throw "Transaction $label has unknown outcome; inspect chain manually and never resubmit"};$hash=$m.Groups[1].Value
 $script:transactions+=@{step=$label;hash=$hash;sender=$sender;receiver=$receiver};Save 'transactions.json' @($script:transactions)
 if($exit -ne 0 -and !$expectedFailure){throw "Transaction $label CLI failed; recorded hash $hash requires inspection"}
 $tx=FinalTransaction $hash $sender;if($tx.final_execution_status -ne 'FINAL' -or !$tx.status.PSObject.Properties['SuccessValue']){throw "Transaction $label not final success; inspect $hash"}
 Equal $tx.transaction.receiver_id $receiver "$label receiver";Equal $tx.transaction.signer_id $sender "$label sender"
 $failed=@($tx.receipts_outcome|Where-Object {$_.outcome.status.PSObject.Properties['Failure']});if($expectedFailure){if($failed.Count -ne 1 -or $failed[0].outcome.executor_id -ne $ft){throw "Expected one token failure: $label $hash"}}elseif($failed.Count -gt 0){throw "Receipt failed: $label $hash"}
 Write-Host "$label $hash"
}
function Call($label,$id,$method,$payload,$signer,$deposit='0 yoctoNEAR',$gas='300 Tgas'){$file=Join-Path $out "$label.args.json";[IO.File]::WriteAllText($file,($payload|ConvertTo-Json -Depth 30 -Compress));Invoke-NearTransaction $label $signer $id @('contract','call-function','as-transaction',$id,$method,'file-args',$file,'prepaid-gas',$gas,'attached-deposit',$deposit,'sign-as',$signer,'network-config','testnet','sign-with-keychain','send') ($label -eq 'failed-refund')}
function WaitChain($ms){do{$b=Rpc 'block' @{finality='final'};$now=[long]([decimal]$b.header.timestamp_nanosec/1000000);if($now -lt $ms){Start-Sleep -Seconds 5}}while($now -lt $ms)}
function NewFaucet($id,$label){
 $existing=$null
 try{$existing=Rpc 'query' @{request_type='view_account';finality='final';account_id=$id}}catch{if($_.Exception.Message -notmatch 'UNKNOWN_ACCOUNT|does not exist'){throw}}
 if($existing){
  if(!$ResumeFaucetOnly -or $id -ne $provider -or $label -ne 'provider' -or $existing.code_hash -ne '11111111111111111111111111111111'){throw 'Account already exists; no overwrite'}
  $keys=Rpc 'query' @{request_type='view_access_key_list';block_id=$existing.block_hash;account_id=$id}
  if(@($keys.keys).Count -ne 1 -or $keys.keys[0].public_key -cne $ResumeProviderPublicKey -or $keys.keys[0].access_key.permission -ne 'FullAccess'){throw 'Reviewed faucet key mismatch'}
  Save "$label.creation.json" @{account=$id;status='FINAL_ACCOUNT_OBSERVED';code_hash=$existing.code_hash;public_key=$ResumeProviderPublicKey;block_hash=$existing.block_hash;receipt='NOT_AVAILABLE';recovery='Reviewed read-only reconciliation of successful faucet call; no replay'}
  return
 }
 Save "$label.creation.json" @{account=$id;status='SUBMITTED_OUTCOME_UNKNOWN'}
 $old=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$lines=& near account create-account sponsor-by-faucet-service $id autogenerate-new-keypair save-to-keychain network-config testnet create 2>&1;$exit=$LASTEXITCODE}finally{$ErrorActionPreference=$old}
 $plain=($lines -join "`n") -replace '\x1B\[[0-9;]*[A-Za-z]','';$match=[regex]::Match($plain,'public key:\s+(ed25519:[1-9A-HJ-NP-Za-km-z]+)')
 if($exit -ne 0 -or !$match.Success){throw "Faucet creation outcome unknown for $id; never replay"}
 $key=$match.Groups[1].Value
 Save "$label.creation.json" @{account=$id;status='AWAITING_FINAL_ACCOUNT';expected_public_key=$key;receipt='NOT_AVAILABLE'}
 $account=$null
 for($poll=0;$poll -lt 30;$poll++){try{$account=Rpc 'query' @{request_type='view_account';finality='final';account_id=$id};break}catch{if($_.Exception.Message -notmatch 'UNKNOWN_ACCOUNT|does not exist'){throw};Start-Sleep -Seconds 1}}
 if(!$account){throw "Faucet finality unresolved for $id; do not replay"}
 $keys=Rpc 'query' @{request_type='view_access_key_list';block_id=$account.block_hash;account_id=$id}
 if($account.code_hash -ne '11111111111111111111111111111111' -or @($keys.keys).Count -ne 1 -or $keys.keys[0].public_key -ne $key -or $keys.keys[0].access_key.permission -ne 'FullAccess'){throw "Faucet account identity mismatch for $id; never replay"}
 Save "$label.creation.json" @{account=$id;status='FINAL_ACCOUNT_OBSERVED';code_hash=$account.code_hash;public_key=$key;block_hash=$account.block_hash;receipt='NOT_AVAILABLE'}
}
function DeployInit($label,$id,$wasm,$payload){
 $file=Join-Path $out "$label.args.json";[IO.File]::WriteAllText($file,($payload|ConvertTo-Json -Compress))
 Invoke-NearTransaction $label $id $id @('contract','deploy',$id,'use-file',(Resolve-Path $wasm).Path,'with-init-call','new','file-args',$file,'prepaid-gas','100 Tgas','attached-deposit','0 yoctoNEAR','network-config','testnet','sign-with-keychain','send')
}
if($MockEarnWasm){NewFaucet $provider 'provider';DeployInit 'deploy-init-provider' $provider $MockEarnWasm @{token=$ft;controller=$owner}}
else{
 $expectedProviderHash=if($ExistingProviderAccount){$ExistingProviderCodeHash}else{'Hf9fmsdAEJmp8LNhefkVSmB2aHLs11biK6SWvx7cpnqW'};$providerInitHash=if($ExistingProviderAccount){$ExistingProviderInitHash}else{'CerkwxWhUUmTAJYJgWcM1AKsUbLPe8JocqY5kuJwhsTL'};
 $account=Rpc 'query' @{request_type='view_account';finality='final';account_id=$provider};Equal $account.code_hash $expectedProviderHash 'provider code'
 $init=FinalTransaction $providerInitHash $provider;Equal $init.final_execution_status 'FINAL' 'provider init final';if(!$init.status.PSObject.Properties['SuccessValue']){throw 'provider initialization failed'};Equal $init.transaction.receiver_id $provider 'provider init target';$act=@($init.transaction.actions|Where-Object {$_.FunctionCall.method_name -eq 'new'})[0].FunctionCall;Equal $act.method_name 'new' 'provider init method';$decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($act.args))|ConvertFrom-Json;Equal $decoded.token $ft 'provider token';Equal $decoded.controller $owner 'provider controller'
}
$metadata=View $ft 'ft_metadata' @{};Equal $metadata.decimals 6 'token decimals';$null=View $provider 'get_position' @{account_id=$owner}
NewFaucet $factory 'factory'
DeployInit 'deploy-init-factory' $factory $FactoryWasm @{canonical_ft=$ft;network='testnet';policy_version='showstake-native-usdc-event/1';provider_account=$provider;provider_kind='MOCK_TESTNET'}
$cfg=View $factory 'get_config' @{};Equal $cfg.schema_version 3 'schema';Equal $cfg.factory_policy_identity 'showstake-factory-atomic-event/3' 'factory policy';Equal $cfg.atomic_event_initialization $true 'atomic init';Equal $cfg.leaf_code_sha256 $LeafSha256.ToLowerInvariant() 'leaf pin';Equal $cfg.provider_account $provider 'provider'
$block=Rpc 'block' @{finality='final'};$start=[long]([decimal]$block.header.timestamp_nanosec/1000000);$regClose=$start+[long]$RegistrationSeconds*1000;$checkinClose=$regClose+[long]$CheckinSeconds*1000;$events=@('settlement','refund');$children=@();$code=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $LeafWasm).Path))
for($j=1;$j -le 2;$j++){$rules=@{event_id=$events[$j-1];title="ShowStake $j";location='Testnet';rules_text='Mock USDC and zero-yield MockEarn';deposit='2000000';capacity=5;reg_open=$start-1000;reg_close=$regClose;checkin_open=$regClose;checkin_close=$checkinClose;finalize_deadline=$checkinClose+86400000};$q=View $factory 'quote_provision_event' @{organizer=$owner;request_nonce=$j;rules=$rules};Equal $q.leaf_code_sha256 $LeafSha256.ToLowerInvariant() 'quote leaf';Equal $q.canonical_ft $ft 'quote token';Equal $q.provider_account $provider 'quote provider';if(([bigint]$q.child_funding+[bigint]$q.registry_fee).ToString() -ne $q.total){throw 'quote sum mismatch'};Save "quote-$j.json" $q;Call "provision-$j" $factory 'provision_event' @{request_nonce=$j;rules=$rules;code=$code} $owner "$($q.total) yoctoNEAR";Remove-Item -LiteralPath (Join-Path $out "provision-$j.args.json");$r=View $factory 'get_request' @{organizer=$owner;request_nonce=$j};Equal $r.state 'Ready' 'request';Equal $r.child_id $q.child_id 'child';$children+=@($q.child_id)}
$baseline=@();foreach($u in $users){$baseline+=@([string](View $ft 'ft_balance_of' @{account_id=$u}))}
$run=@{network='testnet';ft=$ft;provider=$provider;factory=$factory;users=$users;children=$children;events=$events;leafSha256=$LeafSha256;leafCodeHash=$LeafCodeHash;factorySha256=$FactorySha256;baseline=$baseline};Save 'run.json' $run
$bounds=View $ft 'storage_balance_bounds' @{};foreach($id in @($provider)+$children+$users){if($null -eq (View $ft 'storage_balance_of' @{account_id=$id})){Call "storage-$id" $ft 'storage_deposit' @{account_id=$id;registration_only=$true} $owner "$($bounds.min) yoctoNEAR" '30 Tgas'}}
for($j=1;$j -le 2;$j++){for($i=0;$i -lt 5;$i++){if($i -gt 0){Call "fund-$j-$i" $ft 'ft_transfer' @{receiver_id=$users[$i];amount='2000000'} $owner '1 yoctoNEAR' '30 Tgas'};Call "deposit-$j-$i" $ft 'ft_transfer_call' @{receiver_id=$children[$j-1];amount='2000000';msg=(@{version=1;event_id=$events[$j-1];commitment_id="c-$j-$i"}|ConvertTo-Json -Compress)} $users[$i] '1 yoctoNEAR'}}
Call 'cancel' $children[1] 'cancel_event' @{event_id=$events[1]} $owner
Equal (View $ft 'ft_balance_of' @{account_id=$users[2]}) '0' 'retry participant token balance must be zero'
Call 'unregister-retry-user' $ft 'storage_unregister' @{force=$false} $users[2] '1 yoctoNEAR' '30 Tgas'
Call 'failed-refund' $children[1] 'claim' @{registration_id="$($events[1])-reg-2"} $users[2] '1 yoctoNEAR'
$failedReg=View $children[1] 'get_registration' @{registration_id="$($events[1])-reg-2"};Equal $failedReg.claim 'Claimable' 'failed claim restored';Equal $failedReg.claim_attempt 1 'failed attempt';Save 'failed-refund-state.json' $failedReg
Call 'reregister-retry-user' $ft 'storage_deposit' @{account_id=$users[2];registration_only=$true} $owner "$($bounds.min) yoctoNEAR" '30 Tgas'
for($i=0;$i -lt 5;$i++){Call "refund-$i" $children[1] 'claim' @{registration_id="$($events[1])-reg-$i"} $users[$i] '1 yoctoNEAR'}
WaitChain $regClose;Call 'close-registration' $children[0] 'close_registration' @{} $owner;Call 'supply' $children[0] 'trigger_earn_supply' @{} $owner;Equal (View $provider 'get_position' @{account_id=$children[0]}) '10000000' 'supplied';Equal (View $provider 'get_position' @{account_id=$children[1]}) '0' 'isolated'
foreach($i in @(1,3)){Call "attend-$i" $children[0] 'mark_attendance' @{registration_id="$($events[0])-reg-$i";attended=$true} $owner};WaitChain $checkinClose;Call 'finalize' $children[0] 'finalize_attendance' @{} $owner;Call 'redeem' $children[0] 'trigger_earn_redeem' @{} $owner;Call 'settle' $children[0] 'settle' @{} $owner;foreach($i in @(1,3)){Call "claim-$i" $children[0] 'claim' @{registration_id="$($events[0])-reg-$i"} $users[$i] '1 yoctoNEAR'}
& node scripts/verify-testnet-factory-result.mjs $out;if($LASTEXITCODE -ne 0){throw 'Independent verification failed'}
