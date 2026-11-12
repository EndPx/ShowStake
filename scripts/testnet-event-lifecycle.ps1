param([Parameter(Mandatory=$true)][string]$EscrowWasm,[Parameter(Mandatory=$true)][string]$MockEarnWasm,[string]$RunId=(Get-Date -Format 'MMddHHmmss'))
# Authorized TESTNET ONLY. Uses dedicated testnet keychain accounts, never secrets.
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
Set-Location $repo
$out=Join-Path $repo "docs/evidence/testnet-lifecycle-$RunId"
if(Test-Path $out){throw 'Run exists; inspect receipts before resuming, never replay funds blindly'}
New-Item -ItemType Directory -Path $out | Out-Null
$script:transactions=@()
$rpc='https://test.rpc.fastnear.com'
function Rpc($method,$params){
  $response=Invoke-RestMethod $rpc -Method Post -ContentType application/json -Body (@{jsonrpc='2.0';id='lifecycle';method=$method;params=$params}|ConvertTo-Json -Depth 20 -Compress)
  if($response.error){throw ($response.error|ConvertTo-Json -Depth 10 -Compress)}
  return $response.result
}
function View($contract,$method,$callArgs){
  $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($callArgs|ConvertTo-Json -Depth 10 -Compress)))
  $r=Rpc 'query' @{request_type='call_function';finality='final';account_id=$contract;method_name=$method;args_base64=$encoded}
  return ([Text.Encoding]::UTF8.GetString([byte[]]$r.result)|ConvertFrom-Json)
}
function Near($label,$arguments){
  $log=Join-Path $out "$label.log"
  $oldPreference=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  try { $lines=& pnpm dlx near-cli-rs@0.31.1 @arguments 2>&1; $exit=$LASTEXITCODE }
  finally { $ErrorActionPreference=$oldPreference }
  $text=$lines -join "`n"
  [IO.File]::WriteAllText($log,$text)
  if($exit -ne 0 -or $text -match 'ERROR Transaction failed'){throw "Transaction failed: $label; inspect $log"}
  $plain=$text -replace '\x1B\[[0-9;]*[A-Za-z]',''
  $match=[regex]::Match($plain,'Transaction ID:\s+([1-9A-HJ-NP-Za-km-z]+)')
  if(!$match.Success){throw "Missing transaction id: $label"}
  $hash=$match.Groups[1].Value
  $script:transactions+=@{step=$label;hash=$hash}
  $script:transactions|ConvertTo-Json -Depth 10|Set-Content (Join-Path $out 'transactions.json')
  Write-Output "$label $hash"
}
function Call($label,$contract,$method,$callArgs,$signer,$deposit='0 NEAR',$gas='300 Tgas'){
  $file=Join-Path $out "$label.args.json"
  [IO.File]::WriteAllText($file,($callArgs|ConvertTo-Json -Depth 15 -Compress))
  Near $label @('contract','call-function','as-transaction',$contract,$method,'file-args',$file,'prepaid-gas',$gas,'attached-deposit',$deposit,'sign-as',$signer,'network-config','testnet','sign-with-keychain','send')
}
function NewAccount($label,$id){
  # An existing account is not assumed ours. Refuse instead of overwriting.
  $response=Invoke-RestMethod $rpc -Method Post -ContentType application/json -Body (@{jsonrpc='2.0';id='exists';method='query';params=@{request_type='view_account';finality='final';account_id=$id}}|ConvertTo-Json -Depth 6)
  if(!$response.error -or $response.error.cause.name -ne 'UNKNOWN_ACCOUNT'){throw "Account not proven unused: $id"}
  Near $label @('account','create-account','sponsor-by-faucet-service',$id,'autogenerate-new-keypair','save-to-keychain','network-config','testnet','create')
}
function AssertEqual($actual,$expected,$label){if([string]$actual -cne [string]$expected){throw "$label expected=$expected actual=$actual"}}
function WaitChain($ms){
  while($true){$block=Rpc 'block' @{finality='final'};$now=[long]([decimal]$block.header.timestamp_nanosec/1000000);if($now -ge $ms){return};Start-Sleep -Seconds 5}
}
$ft='mockusdc.testnet'
$hostAccount='showstake-participant-endpx.testnet'
$users=@($hostAccount,'showstake-attendee-a-endpx.testnet','showstake-attendee-b-endpx.testnet','showstake-attendee-c-endpx.testnet','showstake-attendee-d-endpx.testnet')
$escrow="ss-e2e-$RunId.testnet"
$earn="ss-earn-$RunId.testnet"
$event='five-two-attendees'
@{classification='RUNNING';network='testnet';provider='TESTNET_MOCK_EARN';contract=$escrow;providerContract=$earn;ft=$ft;users=$users;escrowWasmHash=(Get-FileHash $EscrowWasm -Algorithm SHA256).Hash;mockWasmHash=(Get-FileHash $MockEarnWasm -Algorithm SHA256).Hash}|ConvertTo-Json -Depth 8|Set-Content (Join-Path $out 'run.json')
NewAccount 'create-escrow' $escrow
NewAccount 'create-provider' $earn
Near 'deploy-provider' @('contract','deploy',$earn,'use-file',(Resolve-Path $MockEarnWasm).Path,'without-init-call','network-config','testnet','sign-with-keychain','send')
Call 'init-provider' $earn 'new' @{token=$ft;controller=$hostAccount} $earn
Near 'deploy-escrow' @('contract','deploy',$escrow,'use-file',(Resolve-Path $EscrowWasm).Path,'without-init-call','network-config','testnet','sign-with-keychain','send')
Call 'init-escrow' $escrow 'new' @{organizer=$hostAccount;provider_account=$earn;canonical_ft=$ft;token_symbol='USDC';token_name='Mock USDC';token_decimals=6;provider_kind='MOCK_TESTNET'} $escrow
foreach($id in @($escrow,$earn)){
  $bounds=View $ft 'storage_balance_bounds' @{}
  Call "storage-$id" $ft 'storage_deposit' @{account_id=$id;registration_only=$true} $id "$($bounds.min) yoctoNEAR" '30 Tgas'
}
$block=Rpc 'block' @{finality='final'};$start=[long]([decimal]$block.header.timestamp_nanosec/1000000)
$rules=@{event_id=$event;title='Five participants, two attendees';location='ShowStake testnet';rules_text='Mock USDC. Testnet Mock Earn zero yield. Organizer-attested attendance. No voluntary withdrawal.';deposit='2000000';capacity=5;reg_open=$start-1000;reg_close=$start+240000;checkin_open=$start+240000;checkin_close=$start+420000;finalize_deadline=$start+86820000}
Call 'publish' $escrow 'create_event' @{rules=$rules} $hostAccount
$before=@()
foreach($i in 0..4){
  $id=$users[$i]
  if($i -gt 0){Call "fund-$i" $ft 'ft_transfer' @{receiver_id=$id;amount='2000000'} $hostAccount '1 yoctoNEAR' '30 Tgas'}
  $before+=@{account=$id;balance=[string](View $ft 'ft_balance_of' @{account_id=$id})}
  Call "deposit-$i" $ft 'ft_transfer_call' @{receiver_id=$escrow;amount='2000000';msg=(@{version=1;event_id=$event;commitment_id="five-$i"}|ConvertTo-Json -Compress)} $id '1 yoctoNEAR'
}
AssertEqual (View $ft 'ft_balance_of' @{account_id=$escrow}) '10000000' 'escrow principal'
AssertEqual (View $escrow 'get_event' @{}).active_registrations 5 'registrations'
WaitChain $rules.reg_close
Call 'close-registration' $escrow 'close_registration' @{} $hostAccount
Call 'supply' $escrow 'trigger_earn_supply' @{} $hostAccount
AssertEqual (View $escrow 'get_event' @{}).earn_state 'Supplied' 'final supply'
AssertEqual (View $earn 'get_position' @{account_id=$escrow}) '10000000' 'provider position'
AssertEqual (View $ft 'ft_balance_of' @{account_id=$escrow}) '0' 'supplied escrow'
foreach($i in @(1,3)){Call "attend-$i" $escrow 'mark_attendance' @{registration_id="$event-reg-$i";attended=$true} $hostAccount}
WaitChain $rules.checkin_close
Call 'finalize' $escrow 'finalize_attendance' @{} $hostAccount
Call 'redeem' $escrow 'trigger_earn_redeem' @{} $hostAccount
AssertEqual (View $escrow 'get_event' @{}).earn_state 'Redeemed' 'final redemption'
AssertEqual (View $earn 'get_position' @{account_id=$escrow}) '0' 'redeemed position'
AssertEqual (View $ft 'ft_balance_of' @{account_id=$escrow}) '10000000' 'returned principal'
Call 'settle' $escrow 'settle' @{} $hostAccount
$after=@()
foreach($i in 0..4){
  $r=View $escrow 'get_registration' @{registration_id="$event-reg-$i"}
  $expected=if($i -in @(1,3)){'5000000'}else{'0'}
  AssertEqual $r.claim_amount $expected "allocation-$i"
  if($i -in @(1,3)){Call "claim-$i" $escrow 'claim' @{registration_id="$event-reg-$i"} $users[$i] '1 yoctoNEAR';AssertEqual (View $escrow 'get_registration' @{registration_id="$event-reg-$i"}).claim 'Paid' "paid-$i"}
  $balance=[string](View $ft 'ft_balance_of' @{account_id=$users[$i]})
  $fundingOut=if($i -eq 0){8000000}else{0}
  $expectedBalance=([bigint]$before[$i].balance-2000000-$fundingOut+[bigint]$expected).ToString()
  AssertEqual $balance $expectedBalance "balance-$i"
  $after+=@{account=$users[$i];before=$before[$i].balance;after=$balance;allocation=$expected}
}
AssertEqual (View $ft 'ft_balance_of' @{account_id=$escrow}) '0' 'escrow after claims'
@{classification='PASS_TESTNET';provider='TESTNET_MOCK_EARN';rheaLive='NOT_RUN';contract=$escrow;providerContract=$earn;eventId=$event;balances=$after;receipts=$script:transactions}|ConvertTo-Json -Depth 15|Set-Content (Join-Path $out 'result.json')
Write-Output "PASS_TESTNET evidence=$out"
