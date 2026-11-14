// Read-only/unsigned Rhea treasury candidate. Not provider acceptance.
// Code hashes are observed pins; the token issuer retains upgrade authority.
// ABI: https://github.com/NearDeFi/burrowland/blob/main/contract/src/actions.rs
// https://github.com/rhea-finance/burrow-sdk-python/blob/main/burrow/contract_handler.py
// https://github.com/rhea-finance/lending-sdk-golang/blob/main/common/lending/models.go (AccountAllPositions)
export const RHEA_MAINNET = Object.freeze({network:'mainnet',provider:'contract.main.burrow.near',codeHash:'6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa',tokenCodeHash:'DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q',usdc:'17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',decimals:6,extraDecimals:12});
const encodeJson=x=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(x))));
const decodeJson=x=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(x),c=>c.charCodeAt(0))));
const decodeBytes=x=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(x)));
const ZERO_HASH='11111111111111111111111111111111';
const inspectedSnapshots=new WeakSet();
const inspectedReceipts=new WeakSet();
const freezeDeep=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freezeDeep(x);Object.freeze(v);}return v;};
const atomic=(x)=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]*)$/.test(x)) throw Error('invalid atomic integer'); const n=BigInt(x); if(n>(1n<<128n)-1n) throw Error('atomic overflow'); return n;};
const object=(x)=>{if(!x||typeof x!=='object'||Array.isArray(x)) throw Error('invalid object');return x;};
const accountId=x=>{if(typeof x!=='string'||!/^(([a-z0-9]+[-_])*[a-z0-9]+)(\.(([a-z0-9]+[-_])*[a-z0-9]+))*$/.test(x)||x.length<2||x.length>64||x===RHEA_MAINNET.provider||x===RHEA_MAINNET.usdc) throw Error('invalid treasury account');return x;};
export function parseAsset(v){
 object(v); if(v.token_id!==RHEA_MAINNET.usdc) throw Error('wrong token'); const c=object(v.config);
 for(const [k,x] of Object.entries(c)) if(k.startsWith('can_')&&(!['can_deposit','can_withdraw','can_borrow','can_use_as_collateral'].includes(k)||typeof x!=='boolean')) throw Error('unknown capability');
 for(const k of ['can_deposit','can_withdraw','can_borrow','can_use_as_collateral']) if(typeof c[k]!=='boolean') throw Error('missing capability');
 if(c.extra_decimals!==12) throw Error('unexpected internal decimals');
 return {extraDecimals:12,canDeposit:c.can_deposit,canWithdraw:c.can_withdraw,suppliedShares:atomic(object(v.supplied).shares).toString(),suppliedBalance:atomic(v.supplied.balance).toString(),borrowedBalance:atomic(object(v.borrowed).balance).toString()};
}
export function parseAccountPosition(v,treasury){
 accountId(treasury); object(v); if(v.account_id!==treasury) throw Error('wrong account');
 for(const k of ['supplied','borrowed','collateral']) if(!Array.isArray(v[k])) throw Error('missing exposure');
 if(v.borrowed.length||v.collateral.length||v.supplied.length>1) throw Error('unsupported exposure');
 for(const k of ['positions','margin_positions','margin_debt']) if(v[k]!=null&&(!Array.isArray(v[k])||v[k].length)) throw Error('unsupported position');
 if(!v.supplied.length)return {shares:'0',internalBalance:'0',tokenAtomicsFloor:'0',internalRemainder:'0'};
 const a=object(v.supplied[0]);if(a.token_id!==RHEA_MAINNET.usdc)throw Error('wrong supplied token');const shares=atomic(a.shares),bal=atomic(a.balance);if((shares===0n)!==(bal===0n))throw Error('inconsistent shares');
 return {shares:shares.toString(),internalBalance:bal.toString(),tokenAtomicsFloor:(bal/1000000000000n).toString(),internalRemainder:(bal%1000000000000n).toString()};
}
// Current Rhea object shape. Exposure is never inferred from a position ID alone.
function isolatedPositionStatus(value,treasury,accountPosition,providerStorage){
 if(value===null&&accountPosition===null&&providerStorage===null)return 'ABSENT_ACCOUNT';
 try {
  const v=object(value);
  const allowed=['account_id','supplied','positions','farms','has_non_farmed_assets','booster_staking','booster_stakings','is_locked'];
  if(Object.keys(v).some(k=>!allowed.includes(k))||v.account_id!==treasury||!accountPosition||!providerStorage||!Array.isArray(v.supplied)||!Array.isArray(v.farms)||typeof v.has_non_farmed_assets!=='boolean'||typeof v.is_locked!=='boolean'||!Object.hasOwn(v,'booster_staking')||!Object.hasOwn(v,'booster_stakings'))return 'UNSUPPORTED_SHAPE';
  const supplied=parseAccountPosition({account_id:treasury,supplied:v.supplied,borrowed:[],collateral:[]},treasury);
  if(supplied.shares!==accountPosition.shares||supplied.internalBalance!==accountPosition.internalBalance)return 'UNSUPPORTED_SHAPE';
  const positions=object(v.positions),boosters=object(v.booster_stakings);
  let exposure=v.is_locked||v.booster_staking!==null||Object.keys(boosters).length>0;
  for(const [id,raw] of Object.entries(positions)){
   if(!id)return 'UNSUPPORTED_SHAPE';const p=object(raw);
   if(Object.keys(p).some(k=>!['collateral','borrowed','supplied'].includes(k))||!Array.isArray(p.collateral)||!Array.isArray(p.borrowed)||(Object.hasOwn(p,'supplied')&&!Array.isArray(p.supplied)))return 'UNSUPPORTED_SHAPE';
   if(p.collateral.length||p.borrowed.length||(p.supplied?.length??0))exposure=true;
  }
  return exposure?'NONEMPTY':'EMPTY';
 } catch {return 'UNSUPPORTED_SHAPE';}
}
// readRpc(method,params) returns the unwrapped JSON-RPC result or throws.
async function finalHead(readRpc){
 const block=await readRpc('block',{finality:'final'}),h=block?.header,hash=h?.hash,height=h?.height,stamp=h?.timestamp_nanosec;
 if(typeof hash!=='string'||!hash||!Number.isSafeInteger(height)||height<0||typeof stamp!=='string'||!/^\d+$/.test(stamp))throw Error('invalid final block');
 const blockTimestampMs=Number(BigInt(stamp)/1000000n);if(!Number.isSafeInteger(blockTimestampMs)||blockTimestampMs>Date.now()+5000||Date.now()-blockTimestampMs>60000)throw Error('stale final block');return {hash,height,blockTimestampMs};
}
async function canonicalHeader(readRpc,hash,head){
 if(typeof hash!=='string'||!hash)throw Error('invalid block hash');const header=(await readRpc('block',{block_id:hash}))?.header;
 if(header?.hash!==hash||!Number.isSafeInteger(header.height)||header.height<0||header.height>head.height||typeof header.timestamp_nanosec!=='string'||!/^\d+$/.test(header.timestamp_nanosec))throw Error('invalid historical block');
 const canonical=(await readRpc('block',{block_id:header.height}))?.header;if(canonical?.hash!==hash||canonical.height!==header.height)throw Error('noncanonical block');
 const blockTimestampMs=Number(BigInt(header.timestamp_nanosec)/1000000n);if(!Number.isSafeInteger(blockTimestampMs)||blockTimestampMs>head.blockTimestampMs)throw Error('invalid historical timestamp');return {hash,height:header.height,blockTimestampMs};
}
export async function inspectRhea(readRpc,treasury,options={}){
 accountId(treasury); if(typeof readRpc!=='function')throw Error('readRpc required');
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='atBlockHash'))throw Error('invalid inspection options');
 const head=await finalHead(readRpc),historical=options.atBlockHash!==undefined,selected=historical?await canonicalHeader(readRpc,options.atBlockHash,head):head;
 const {hash,height,blockTimestampMs}=selected;
 const q=async(account_id,request_type,extra={})=>{const r=await readRpc('query',{block_id:hash,request_type,account_id,...extra});if(r?.block_hash!==hash||r?.block_height!==height||Date.now()-head.blockTimestampMs>60000)throw Error('query block mismatch or stale');return r;};
 const call=async(id,method,args)=>{const r=await q(id,'call_function',{method_name:method,args_base64:encodeJson(args)});return decodeBytes(r.result);};
 const [provider,owner,tokenAccount,assetRaw,metadata,storageBounds,providerStorage,ftStorage,rawPosition,balance,allPositions,providerConfig,ftStorageBounds]=await Promise.all([
 q(RHEA_MAINNET.provider,'view_account'),q(treasury,'view_account'),q(RHEA_MAINNET.usdc,'view_account'),call(RHEA_MAINNET.provider,'get_asset',{token_id:RHEA_MAINNET.usdc}),call(RHEA_MAINNET.usdc,'ft_metadata',{}),call(RHEA_MAINNET.provider,'storage_balance_bounds',{}),call(RHEA_MAINNET.provider,'storage_balance_of',{account_id:treasury}),call(RHEA_MAINNET.usdc,'storage_balance_of',{account_id:treasury}),call(RHEA_MAINNET.provider,'get_account',{account_id:treasury}),call(RHEA_MAINNET.usdc,'ft_balance_of',{account_id:treasury}),call(RHEA_MAINNET.provider,'get_account_all_positions',{account_id:treasury}),call(RHEA_MAINNET.provider,'get_config',{}),call(RHEA_MAINNET.usdc,'storage_balance_bounds',{})]);
 const gates=[]; if(provider.code_hash!==RHEA_MAINNET.codeHash)gates.push('PROVIDER_CODE_CHANGED');if(owner.code_hash!==ZERO_HASH)gates.push('TREASURY_HAS_CODE');if(tokenAccount.code_hash!==RHEA_MAINNET.tokenCodeHash)gates.push('TOKEN_CODE_CHANGED');if(metadata.decimals!==6||metadata.symbol!=='USDC')gates.push('TOKEN_METADATA_MISMATCH');
 if(!providerConfig||providerConfig.contract_mode!=='Running')gates.push('PROVIDER_NOT_RUNNING');
 const asset=parseAsset(assetRaw); if(!asset.canDeposit||!asset.canWithdraw)gates.push('ASSET_DISABLED');
 let position=null;if(rawPosition===null)gates.push('PROVIDER_ACCOUNT_NOT_REGISTERED');else position=parseAccountPosition(rawPosition,treasury);
 if(!providerStorage)gates.push('PROVIDER_STORAGE_MISSING');else {atomic(providerStorage.total);atomic(providerStorage.available);}
 if(!ftStorage)gates.push('FT_STORAGE_MISSING');else {atomic(ftStorage.total);atomic(ftStorage.available);}
 atomic(storageBounds.min);if(storageBounds.max!==null)atomic(storageBounds.max);atomic(ftStorageBounds.min);if(ftStorageBounds.max!==null)atomic(ftStorageBounds.max);atomic(owner.amount);atomic(balance);
 const isolatedPositionsStatus=isolatedPositionStatus(allPositions,treasury,position,providerStorage);
 if(isolatedPositionsStatus!=='EMPTY')gates.push('ISOLATED_POSITIONS_UNREVIEWED');
 const snapshot=freezeDeep({status:gates.length?'BLOCKED':'READY_FOR_REVIEW',acceptance:'TECH_NOT_ACCEPTED',blockHash:hash,blockHeight:height,blockTimestampMs,historical,isolatedPositionsStatus,treasury,providerCodeHash:provider.code_hash,tokenCodeHash:tokenAccount.code_hash,treasuryCodeHash:owner.code_hash,metadata,asset,position,providerStorage,ftStorage,storageBounds,ftStorageBounds,providerConfig,nativeBalance:owner.amount,usdcBalance:balance,gates});inspectedSnapshots.add(snapshot);return snapshot;
}
export async function inspectFinalReceipt(readRpc,txHash,treasury){
 accountId(treasury);if(typeof readRpc!=='function'||typeof txHash!=='string'||!txHash)throw Error('receipt identity required');
 const head=await finalHead(readRpc),raw=await readRpc('EXPERIMENTAL_tx_status',[txHash,treasury]);
 const inner=raw?.final_execution_outcome??raw;if(raw!==inner&&raw.final_execution_status&&inner?.final_execution_status&&raw.final_execution_status!==inner.final_execution_status)throw Error('conflicting transaction finality');
 const transaction=raw===inner?raw:{...inner,final_execution_status:raw.final_execution_status??inner?.final_execution_status};
 graph(transaction,treasury,txHash);
 const hashes=[transaction.transaction_outcome?.block_hash,...transaction.receipts_outcome.map(x=>x.block_hash)];
 if(hashes.some(h=>typeof h!=='string'||!h))throw Error('receipt block missing');
 const headers=await Promise.all([...new Set(hashes)].map(h=>canonicalHeader(readRpc,h,head)));
 if(Date.now()-head.blockTimestampMs>60000)throw Error('stale final block');
 const proof=freezeDeep({transaction,txHash,treasury,blockHeights:headers.map(h=>h.height),finalBlockHash:head.hash,finalBlockHeight:head.height});inspectedReceipts.add(proof);return proof;
}
function positive(x){const n=atomic(x);if(!n)throw Error('zero amount');return n;}
export function supplyPlan(treasury,amount){accountId(treasury);positive(amount);return {signerId:treasury,receiverId:RHEA_MAINNET.usdc,methodName:'ft_transfer_call',args:{receiver_id:RHEA_MAINNET.provider,amount,msg:''},depositYocto:'1',unsigned:true};}
export function withdrawPlan(treasury,amount=null){accountId(treasury);let asset={token_id:RHEA_MAINNET.usdc};if(amount!==null){const n=positive(amount)*1000000000000n;if(n>(1n<<128n)-1n)throw Error('internal amount overflow');asset.max_amount=n.toString();}return {signerId:treasury,receiverId:RHEA_MAINNET.provider,methodName:'execute',args:{actions:[{Withdraw:asset}]},depositYocto:'1',unsigned:true};}
function methodAction(a){const x=object(a).FunctionCall; if(!x||typeof x.method_name!=='string'||typeof x.args!=='string')throw Error('invalid function action');let args;try{args=decodeJson(x.args);}catch{throw Error('invalid action arguments');}return {method:x.method_name,args,deposit:x.deposit};}
function graph(tx,treasury,expectedTxHash){
 object(tx); const t=object(tx.transaction);if(t.signer_id!==treasury||!Array.isArray(t.actions)||t.actions.length!==1)throw Error('wrong transaction');
 if(typeof expectedTxHash!=='string'||!expectedTxHash||t.hash!==expectedTxHash||tx.transaction_outcome?.id!==expectedTxHash||tx.final_execution_status!=='FINAL')throw Error('transaction hash or finality mismatch');
 if(!tx.status||typeof tx.status!=='object'||Object.keys(tx.status).length!==1||!Object.hasOwn(tx.status,'SuccessValue'))throw Error('not final success');
 if(!Array.isArray(tx.receipts)||!Array.isArray(tx.receipts_outcome))throw Error('receipt graph missing');
 const map=new Map();for(const r of tx.receipts){if(!r.receipt_id||map.has(r.receipt_id))throw Error('duplicate receipt');map.set(r.receipt_id,r);}
 const outcomes=new Map();for(const x of tx.receipts_outcome){if(!x.id||outcomes.has(x.id))throw Error('duplicate outcome');outcomes.set(x.id,x.outcome);}
 const root=object(tx.transaction_outcome).outcome;if(!root||root.executor_id!==treasury||!root.status||Object.keys(root.status).length!==1||!Object.hasOwn(root.status,'SuccessReceiptId')||!Array.isArray(root.receipt_ids)||!root.receipt_ids.includes(root.status.SuccessReceiptId))throw Error('root missing');
 const actionRoot=map.get(root.status.SuccessReceiptId);if(!actionRoot||actionRoot.predecessor_id!==treasury||actionRoot.receiver_id!==t.receiver_id||JSON.stringify(actionRoot.receipt?.Action?.actions)!==JSON.stringify(t.actions))throw Error('transaction action receipt mismatch');
 const seen=new Set(),pending=root.receipt_ids.map(id=>({id,parent:treasury}));
 while(pending.length){const {id,parent}=pending.pop();if(seen.has(id))throw Error('duplicate receipt path');seen.add(id);const r=map.get(id),o=outcomes.get(id);const actions=r?.receipt?.Action?.actions;const systemRefund=r?.predecessor_id==='system'&&r.receiver_id===treasury&&Array.isArray(actions)&&actions.length===1&&Object.keys(actions[0]).length===1&&Object.hasOwn(actions[0],'Transfer');if(!r||(!systemRefund&&r.predecessor_id!==parent)||!o||o.executor_id!==r.receiver_id||!o.status||Object.keys(o.status).length!==1||!(Object.hasOwn(o.status,'SuccessValue')||Object.hasOwn(o.status,'SuccessReceiptId'))||!Array.isArray(o.receipt_ids)||(systemRefund&&o.receipt_ids.length!==0)||(Object.hasOwn(o.status,'SuccessReceiptId')&&!o.receipt_ids.includes(o.status.SuccessReceiptId)))throw Error('receipt incomplete, failed or unlinked');pending.push(...o.receipt_ids.map(id=>({id,parent:r.receiver_id})));}
 if(seen.size!==map.size||seen.size!==outcomes.size)throw Error('unreachable receipt');return {t,receipts:[...map.values()]};
}
function beforeAfter(b,a,treasury){for(const s of [b,a]){object(s);if(!inspectedSnapshots.has(s)||s.status!=='READY_FOR_REVIEW'||s.acceptance!=='TECH_NOT_ACCEPTED'||s.treasury!==treasury||s.providerCodeHash!==RHEA_MAINNET.codeHash||s.tokenCodeHash!==RHEA_MAINNET.tokenCodeHash||s.treasuryCodeHash!==ZERO_HASH||s.metadata?.symbol!=='USDC'||s.metadata?.decimals!==6||!s.position||!Array.isArray(s.gates)||s.gates.length||!Number.isSafeInteger(s.blockHeight)||typeof s.blockHash!=='string'||!s.blockHash||!Number.isSafeInteger(s.blockTimestampMs))throw Error('untrusted snapshot');atomic(s.usdcBalance);atomic(s.position.shares);atomic(s.position.internalBalance);}if(b.blockHash===a.blockHash||a.blockHeight<=b.blockHeight||a.blockTimestampMs<b.blockTimestampMs)throw Error('snapshot blocks out of order');}
function receiptInterval(proof,transaction,before,after,treasury,expectedTxHash){if(!inspectedReceipts.has(proof)||proof.transaction!==transaction||proof.treasury!==treasury||proof.txHash!==expectedTxHash||proof.blockHeights.some(h=>h<=before.blockHeight||h>after.blockHeight))throw Error('receipt not canonically enclosed by snapshots');}
export function verifySupplyReceipt({transaction,receiptProof,before,after,treasury,amount,expectedTxHash}){
 accountId(treasury);const n=positive(amount);beforeAfter(before,after,treasury);receiptInterval(receiptProof,transaction,before,after,treasury,expectedTxHash);const {t,receipts}=graph(transaction,treasury,expectedTxHash);const a=methodAction(t.actions[0]);if(t.receiver_id!==RHEA_MAINNET.usdc||a.method!=='ft_transfer_call'||a.deposit!=='1'||a.args.receiver_id!==RHEA_MAINNET.provider||a.args.amount!==amount||a.args.msg!==''||Object.keys(a.args).some(k=>!['receiver_id','amount','msg'].includes(k)))throw Error('wrong supply call');let used;try{used=decodeJson(transaction.status.SuccessValue);}catch{throw Error('invalid supply result');}if(used!==amount)throw Error('supply refunded or ambiguous');
 const on=receipts.filter(r=>r.predecessor_id===RHEA_MAINNET.usdc&&r.receiver_id===RHEA_MAINNET.provider&&r.receipt?.Action?.actions?.some(x=>{try{const a=methodAction(x);return a.method==='ft_on_transfer'&&a.args.sender_id===treasury&&a.args.amount===amount&&a.args.msg===''&&Object.keys(a.args).length===3;}catch{return false;}}));
 if(on.length!==1||atomic(before.usdcBalance)-atomic(after.usdcBalance)!==n||atomic(after.position.shares)<=atomic(before.position.shares))throw Error('supply not reconciled');return {status:'RECEIPT_MATCH_CANDIDATE',amount};
}
export function verifyWithdrawReceipt({transaction,receiptProof,before,after,treasury,expectedTxHash}){
 accountId(treasury);beforeAfter(before,after,treasury);receiptInterval(receiptProof,transaction,before,after,treasury,expectedTxHash);const {t,receipts}=graph(transaction,treasury,expectedTxHash);const a=methodAction(t.actions[0]);const xs=a.args.actions;if(t.receiver_id!==RHEA_MAINNET.provider||a.method!=='execute'||a.deposit!=='1'||Object.keys(a.args).join()!=='actions'||!Array.isArray(xs)||xs.length!==1||Object.keys(xs[0]).join()!=='Withdraw')throw Error('wrong withdraw call');const w=object(xs[0].Withdraw);if(w.token_id!==RHEA_MAINNET.usdc||Object.keys(w).some(k=>!['token_id','amount','max_amount'].includes(k))||(w.amount!==undefined&&w.max_amount!==undefined))throw Error('wrong withdraw action');if(w.amount!==undefined)positive(w.amount);if(w.max_amount!==undefined)positive(w.max_amount);
 const transfers=[];for(const r of receipts){if(r.predecessor_id!==RHEA_MAINNET.provider||r.receiver_id!==RHEA_MAINNET.usdc)continue;for(const x of r.receipt?.Action?.actions??[]){const f=methodAction(x);if(f.method==='ft_transfer'){if(f.args.receiver_id!==treasury||f.deposit!=='1'||Object.keys(f.args).some(k=>!['receiver_id','amount','memo'].includes(k))||(f.args.memo!==undefined&&f.args.memo!==null&&typeof f.args.memo!=='string'))throw Error('wrong recipient or arguments');transfers.push(positive(f.args.amount));}}}
 if(transfers.length!==1||atomic(after.usdcBalance)-atomic(before.usdcBalance)!==transfers[0]||atomic(after.position.shares)>=atomic(before.position.shares)||(w.amount===undefined&&w.max_amount===undefined&&atomic(after.position.shares)!==0n)||(w.amount!==undefined&&transfers[0]*1000000000000n>atomic(w.amount))||(w.max_amount!==undefined&&transfers[0]*1000000000000n>atomic(w.max_amount)))throw Error('withdraw not reconciled');return {status:'RECEIPT_MATCH_CANDIDATE',amount:transfers[0].toString()};
}
