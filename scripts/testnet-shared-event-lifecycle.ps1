param(
 [Parameter(Mandatory=$true)][string]$SharedWasm,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$SharedSha256,
 [Parameter(Mandatory=$true)][string]$MockEarnWasm,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$MockEarnSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9]{1,20}$')][string]$RunId,
 [ValidateRange(240,3600)][int]$RegistrationSeconds=600,
 [ValidateRange(180,1800)][int]$CheckinSeconds=600
)
# TESTNET ONLY; every known/unknown transaction must be reconciled before retry.
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent;Set-Location $repo
foreach($pair in @(@($SharedWasm,$SharedSha256),@($MockEarnWasm,$MockEarnSha256))){if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ine $pair[1]){throw 'Reviewed Wasm hash mismatch'}}
$out=Join-Path $repo "docs/evidence/testnet-shared-$RunId";if(Test-Path -LiteralPath $out){throw 'Run already exists; inspect saved outcomes, never replay'};New-Item -ItemType Directory -Path $out|Out-Null
$rpc='https://test.rpc.fastnear.com';$ft='mockusdc.testnet';$provider="ss-shared-earn-$RunId.testnet";$shared="ss-shared-$RunId.testnet"
$users=@('showstake-participant-endpx.testnet','showstake-attendee-a-endpx.testnet','showstake-attendee-b-endpx.testnet','showstake-attendee-c-endpx.testnet','showstake-attendee-d-endpx.testnet');$owner=$users[0];$organizers=@($owner,$users[4]);$script:transactions=@();$ResumeFaucetOnly=$false;$ResumeProviderPublicKey=''

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
 $failed=@($tx.receipts_outcome|Where-Object {$_.outcome.status.PSObject.Properties['Failure']});if($expectedFailure){if($failed.Count -ne 1 -or $failed[0].outcome.executor_id -notin @($ft,$provider)){throw "Expected one token failure: $label $hash"}}elseif($failed.Count -gt 0){throw "Receipt failed: $label $hash"}
 Write-Host "$label $hash"
}
function Call($label,$id,$method,$payload,$signer,$deposit='0 yoctoNEAR',$gas='300 Tgas'){$file=Join-Path $out "$label.args.json";[IO.File]::WriteAllText($file,($payload|ConvertTo-Json -Depth 30 -Compress));Invoke-NearTransaction $label $signer $id @('contract','call-function','as-transaction',$id,$method,'file-args',$file,'prepaid-gas',$gas,'attached-deposit',$deposit,'sign-as',$signer,'network-config','testnet','sign-with-keychain','send') ($label -in @('failed-refund','rejected-provider-withdraw'))}
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

$metadata=View $ft 'ft_metadata' @{};Equal $metadata.decimals 6 'token decimals';Equal $metadata.symbol 'USDC' 'token symbol'
NewFaucet $provider 'provider';DeployInit 'deploy-provider' $provider $MockEarnWasm @{token=$ft;controller=$owner}
NewFaucet $shared 'shared';DeployInit 'deploy-shared' $shared $SharedWasm @{canonical_ft=$ft;provider_account=$provider;provider_kind='MOCK_TESTNET';network='testnet';token_symbol='USDC';token_name='Mock USDC';token_decimals=6}
$identity=Rpc 'query' @{request_type='view_account';finality='final';account_id=$shared};$cfg=View $shared 'get_config' @{};Equal $cfg.policy_version 'showstake-native-usdc-shared-yield/2' 'policy';Equal $cfg.schema_version 2 'schema';Equal $cfg.provider_enabled $true 'provider enabled'
$bounds=View $ft 'storage_balance_bounds' @{};foreach($account in @($shared,$provider)+$users){if($null -eq (View $ft 'storage_balance_of' @{account_id=$account})){Call "storage-$account" $ft 'storage_deposit' @{account_id=$account;registration_only=$true} $owner "$($bounds.min) yoctoNEAR" '30 Tgas'}}
$block=Rpc 'block' @{finality='final'};$start=[long]([decimal]$block.header.timestamp_nanosec/1000000);$regClose=$start+[long]$RegistrationSeconds*1000;$end=$regClose+[long]$CheckinSeconds*1000
foreach($index in @(0,1)){$event=if($index -eq 0){'attendee'}else{'cancelled'};$rules=@{event_id=$event;title="Shared ShowStake $index";location='NEAR testnet';rules_text='One shared contract, independent per-event vault shares. Mock USDC and zero-yield MockEarn.';deposit='2000000';capacity=5;reg_open=$start-1000;reg_close=$regClose;checkin_open=$regClose;checkin_close=$end;finalize_deadline=$end+86400000};$quote=View $shared 'quote_create_event' @{rules=$rules;organizer=$organizers[$index]};Save "quote-$event.json" @{atomic=$quote;rules=$rules;organizer=$organizers[$index]};Call "create-$event" $shared 'create_event' @{rules=$rules} $organizers[$index] "$quote yoctoNEAR"}
$run=@{network='testnet';ft=$ft;provider=$provider;shared=$shared;sharedSha256=$SharedSha256;codeHash=$identity.code_hash;users=$users;organizers=$organizers;events=@('attendee','cancelled');regClose=$regClose;checkinClose=$end};Save 'run.json' $run
for($i=1;$i -lt 5;$i++){$balance=[bigint](View $ft 'ft_balance_of' @{account_id=$users[$i]});if($balance -lt 4000000){Call "fund-$i" $ft 'ft_transfer' @{receiver_id=$users[$i];amount=([bigint]4000000-$balance).ToString()} $owner '1 yoctoNEAR' '30 Tgas'}}
foreach($event in @('attendee','cancelled')){for($i=0;$i -lt 5;$i++){Call "deposit-$event-$i" $ft 'ft_transfer_call' @{receiver_id=$shared;amount='2000000';msg=(@{version=1;event_id=$event;commitment_id="shared-$event-$i"}|ConvertTo-Json -Compress)} $users[$i] '1 yoctoNEAR'}}
$a=@(View $shared 'list_event_registrations' @{event_id='attendee';from=0;limit=50});$b=@(View $shared 'list_event_registrations' @{event_id='cancelled';from=0;limit=50});if($a.Count -ne 5 -or $b.Count -ne 5){throw 'Expected five registrations per event'}
$before=@();foreach($account in $users){$before+=@([string](View $ft 'ft_balance_of' @{account_id=$account}))};Save 'before-claims.json' @{balances=$before;registrationsA=$a;registrationsB=$b}
WaitChain $regClose
foreach($event in @('attendee','cancelled')){Call "close-$event" $shared 'close_registration' @{event_id=$event} $owner;Call "supply-$event" $shared 'trigger_earn_supply' @{event_id=$event} $owner;Equal (View $shared 'get_event' @{event_id=$event}).earn_state 'Supplied' 'supplied state'}
Equal (View $provider 'get_position' @{account_id=$shared}) '20000000' 'two concurrent supplied events';Save 'both-supplied.json' @{vault=(View $shared 'get_vault' @{});a=(View $shared 'get_event' @{event_id='attendee'});b=(View $shared 'get_event' @{event_id='cancelled'})}
foreach($i in @(1,3)){Call "attend-$i" $shared 'mark_attendance' @{registration_id=$a[$i].registration_id;attended=$true} $organizers[0]}
Write-Host "Check-in window active until $end; contract $shared; pass QR and organizer browser verification can run now."
WaitChain $end
Call 'finalize-attendee' $shared 'finalize_attendance' @{event_id='attendee'} $organizers[0]
Call 'redeem-attendee' $shared 'trigger_earn_redeem' @{event_id='attendee'} $owner;Equal (View $shared 'get_event' @{event_id='attendee'}).earn_state 'Redeemed' 'A redeemed';Equal (View $provider 'get_position' @{account_id=$shared}) '10000000' 'B still supplied';Save 'a-redeemed-b-supplied.json' @{vault=(View $shared 'get_vault' @{});b=(View $shared 'get_event' @{event_id='cancelled'})}
Call 'settle-attendee' $shared 'settle' @{event_id='attendee'} $owner
foreach($i in @(1,3)){Equal (View $shared 'get_registration' @{registration_id=$a[$i].registration_id}).claim_amount '5000000' 'attendee payout';Call "claim-attendee-$i" $shared 'claim' @{registration_id=$a[$i].registration_id} $users[$i] '1 yoctoNEAR'}
Call 'cancel-b' $shared 'cancel_event' @{event_id='cancelled'} $organizers[1]
Equal (View $ft 'ft_balance_of' @{account_id=$shared}) '0' 'shared token balance before controlled receiver failure'
Call 'unregister-shared-receiver' $ft 'storage_unregister' @{force=$false} $shared '1 yoctoNEAR' '30 Tgas'
Call 'rejected-provider-withdraw' $shared 'trigger_earn_redeem' @{event_id='cancelled'} $owner
Equal (View $shared 'get_event' @{event_id='cancelled'}).earn_state 'Supplied' 'failed withdraw retryable';Equal (View $provider 'get_position' @{account_id=$shared}) '10000000' 'failed withdrawal preserved position';Save 'rejected-provider-state.json' @{vault=(View $shared 'get_vault' @{});b=(View $shared 'get_event' @{event_id='cancelled'})}
Call 'restore-shared-receiver' $ft 'storage_deposit' @{account_id=$shared;registration_only=$true} $owner "$($bounds.min) yoctoNEAR" '30 Tgas';Call 'redeem-cancelled' $shared 'trigger_earn_redeem' @{event_id='cancelled'} $owner
Equal (View $ft 'ft_balance_of' @{account_id=$users[2]}) '0' 'controlled retry wallet empty';Call 'unregister-retry-user' $ft 'storage_unregister' @{force=$false} $users[2] '1 yoctoNEAR' '30 Tgas'
Call 'failed-refund' $shared 'claim' @{registration_id=$b[2].registration_id} $users[2] '1 yoctoNEAR';$failed=View $shared 'get_registration' @{registration_id=$b[2].registration_id};Equal $failed.claim 'Claimable' 'failed payout restored';Equal $failed.claim_attempt 1 'failed payout attempt';Save 'failed-payout-state.json' $failed
Call 'restore-ft-storage' $ft 'storage_deposit' @{account_id=$users[2];registration_only=$true} $owner "$($bounds.min) yoctoNEAR" '30 Tgas'
for($i=0;$i -lt 5;$i++){Call "refund-$i" $shared 'claim' @{registration_id=$b[$i].registration_id} $users[$i] '1 yoctoNEAR'}
& node scripts/verify-testnet-shared-result.mjs $out;if($LASTEXITCODE -ne 0){throw 'Independent shared lifecycle verification failed'}
