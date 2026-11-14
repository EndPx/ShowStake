"use client";
import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {ArrowRight,CheckCircle2,ExternalLink,LoaderCircle,RefreshCw,X} from 'lucide-react';
import {useWallet} from '@/components/wallet/wallet-context';
import {NETWORK,RPC_URL} from '@/lib/config';
import {formatUnits} from '@/lib/money';
import {sharedReleaseForNetwork} from '@/lib/near/multi-event';
import {prepareMultiCreate,type MultiCreateContext} from '@/lib/near/multi-create';
import {SHARED_CREATE_POLICY} from '@/lib/near/multi-wallet-policy';
import {signAndSendTransaction,walletRequestAvailable} from '@/lib/near/wallet';
import {signParams} from '@/lib/near/actions';
import {mainnetReceipt,publishMatches,finalFailedCreateReceipt,type MainnetAttempt} from '@/lib/near/mainnet-lifecycle';
import {withFactoryJournalLock} from '@/lib/near/factory-journal-lock';
import {sharedSnapshot} from '@/lib/near/shared-event';
import {oneWalletRequest} from '@/lib/wallet-login';
import {readCreateFunding,type CreateFunding} from '@/lib/near/create-funding';
import {inspectSavedCreate,savedCreateRules} from '@/lib/near/create-recovery';
import {shouldHydrateCreate} from '@/lib/near/create-recovery-ui';

export function MultiCreate({rules,onInvalid,onPublished,onLockChange}:{rules:Record<string,unknown>|null;onInvalid?:()=>void;onPublished?:(id:string)=>void;onLockChange?:(locked:boolean)=>void}){
 const wallet=useWallet(),router=useRouter(),account=wallet.account?.accountId,release=sharedReleaseForNetwork(NETWORK);
 const [quote,setQuote]=useState<MultiCreateContext|null>(null),[funding,setFunding]=useState<CreateFunding|null>(null),[notice,setNotice]=useState(''),[walletNotice,setWalletNotice]=useState(''),[fundingDialog,setFundingDialog]=useState(false),[fundingError,setFundingError]=useState('');
 const [pending,setPending]=useState(false),[confirming,setConfirming]=useState(false),[hash,setHash]=useState(''),[hasAttempt,setHasAttempt]=useState(false),[savedAttempt,setSavedAttempt]=useState<MainnetAttempt|null>(null);
 const [intent,setIntent]=useState(false),[quoting,setQuoting]=useState(false),[recoveryChecked,setRecoveryChecked]=useState(false),[foundEvent,setFoundEvent]=useState(false),[editingRetry,setEditingRetry]=useState(false),[failedConfirmed,setFailedConfirmed]=useState(false);
 const effectiveRules=useMemo(()=>editingRetry&&savedAttempt&&rules?{...rules,event_id:savedAttempt.eventId}:rules,[rules,editingRetry,savedAttempt?.eventId]);
 const quoteFlight=useRef<Promise<void>|null>(null),verifyFlight=useRef<Promise<boolean>|null>(null),recoveryFlight=useRef<Promise<boolean>|null>(null),rulesRef=useRef(rules),publishing=useRef(false),trigger=useRef<HTMLElement|null>(null),dialog=useRef<HTMLDialogElement>(null),restorePending=useRef(false),dialogGeneration=useRef(0),previousAccount=useRef(account),intentAccount=useRef<string|null>(null),hydratedIndex=useRef<string|null>(null);rulesRef.current=effectiveRules;
 const quoteCurrent=!!quote&&!!rules&&quote.signer===account&&JSON.stringify(quote.rules)===JSON.stringify(effectiveRules);
 const insufficient=!!funding&&funding.account===account&&funding.shortfall!=='0';
 const index=release&&account?`showstake:multi-create-active:${release.network}:${release.contract}:${account}`:null;
 const journalKey=(eventId:string)=>`showstake:multi-create:${release!.network}:${release!.contract}:${account}:${eventId}`;
 const friendly=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,500);
 const closeFunding=()=>{dialogGeneration.current++;setFundingDialog(false);setFundingError('');};
 useEffect(()=>{setQuote(null);setFunding(null);setIntent(false);closeFunding();},[rules]);
 useEffect(()=>{setQuote(null);setFunding(null);closeFunding();if(previousAccount.current&&previousAccount.current!==account)setIntent(false);else if(!previousAccount.current&&account&&intent)intentAccount.current=account;previousAccount.current=account;},[account,wallet.sessionEpoch]);
 useEffect(()=>{if(!fundingDialog)return;const node=dialog.current;if(!node)return;node.showModal();return()=>{node.close();trigger.current?.focus();restorePending.current=document.activeElement!==trigger.current;};},[fundingDialog]);
 useEffect(()=>{if(!fundingDialog&&!quoting&&!confirming&&!pending&&restorePending.current){restorePending.current=false;if(document.activeElement===document.body)trigger.current?.focus();}},[fundingDialog,quoting,confirming,pending]);
 useEffect(()=>{onLockChange?.(pending||hasAttempt&&!editingRetry);},[pending,hasAttempt,editingRetry,onLockChange]);
 useEffect(()=>{
  if(!shouldHydrateCreate(editingRetry,hydratedIndex.current,index))return;
  if(hydratedIndex.current!==index)setWalletNotice('');hydratedIndex.current=index;
  setHash('');setHasAttempt(false);setSavedAttempt(null);setRecoveryChecked(false);setFoundEvent(false);setEditingRetry(false);setFailedConfirmed(false);
  if(!account||!release||!index)return;
  try {
   const activeKey=localStorage.getItem(index),key=activeKey??(rules?.event_id?journalKey(String(rules.event_id)):null);if(!key)return;
   const raw=localStorage.getItem(key);if(!raw){if(activeKey)throw Error();return;}
   const saved=JSON.parse(raw) as MainnetAttempt;savedCreateRules(saved,release,account);if(key!==journalKey(saved.eventId))throw Error();
   setSavedAttempt(saved);setHash(saved.hash??'');setHasAttempt(true);setNotice(saved.hash?'Checking the final transaction receipt...':'No transaction hash was returned. Checking your event and NEAR balance.');
  }catch{setHasAttempt(true);setNotice('This saved creation needs review before another event can be submitted.');}
 },[account,release,rules?.event_id]);
 async function quoteNow(){return oneWalletRequest(quoteFlight,async()=>{
  if(!effectiveRules||!account||hasAttempt&&!editingRetry)return;const epoch=wallet.getSessionEpoch(),expected=JSON.stringify(effectiveRules),generation=dialogGeneration.current;setQuoting(true);setFundingError('');
  try {const q=await prepareMultiCreate(release,account,effectiveRules,RPC_URL),f=await readCreateFunding(account,q.quote,RPC_URL);
   if(wallet.getSessionEpoch()!==epoch||JSON.stringify(rulesRef.current)!==expected)return;
   setQuote(q);setFunding(f);setIntent(false);if(generation===dialogGeneration.current)setFundingDialog(f.shortfall!=='0');setNotice(f.shortfall!=='0'?'Add native NEAR to your connected wallet for event storage and gas. USDC does not pay these costs.':'');
  }catch(error){if(wallet.getSessionEpoch()===epoch&&JSON.stringify(rulesRef.current)===expected){setIntent(false);setQuote(null);setNotice(friendly(error));setFundingError(friendly(error));}}finally{setQuoting(false);}
 });}
 useEffect(()=>{if(intent&&rules&&account&&(!intentAccount.current||intentAccount.current===account)&&wallet.proof&&!quoteCurrent&&(!hasAttempt||editingRetry))void quoteNow();},[intent,account,wallet.proof?.accountId,effectiveRules,hasAttempt,editingRetry]);
 async function begin(){if(!rules){onInvalid?.();return;}intentAccount.current=account??null;setIntent(true);if(!account)await wallet.connect();else if(!wallet.proof)await wallet.sign();else await quoteNow();}
 function archiveAndClear(attempt:MainnetAttempt){
  if(!index)return;const key=journalKey(attempt.eventId);if(localStorage.getItem(index)!==key)throw Error('Saved creation changed. Refresh before continuing.');
  const raw=localStorage.getItem(key);if(!raw||JSON.stringify(JSON.parse(raw))!==JSON.stringify(attempt))throw Error('Saved creation changed. Refresh before continuing.');
  const archive=`${key}:resolved:${crypto.randomUUID()}`;localStorage.setItem(archive,raw);if(localStorage.getItem(archive)!==raw)throw Error('Could not preserve the creation record.');
  localStorage.removeItem(key);localStorage.removeItem(index);
 }
 function openEvent(attempt:MainnetAttempt){archiveAndClear(attempt);setHasAttempt(false);onPublished?.(attempt.eventId);router.push(`/host/events/${encodeURIComponent(attempt.eventId)}?contract=${encodeURIComponent(release!.contract)}`);}
 async function checkRecovery(showFunding=false){return oneWalletRequest(recoveryFlight,async()=>{
  if(!savedAttempt||!account||!release||pending)return false;const epoch=wallet.getSessionEpoch(),generation=dialogGeneration.current;setConfirming(true);setFundingError('');
  try {const state=await inspectSavedCreate(savedAttempt,release,account,RPC_URL);if(wallet.getSessionEpoch()!==epoch)return false;
   setFoundEvent(state.found);setRecoveryChecked(true);
   if(state.found){if(showFunding)closeFunding();setNotice('Your matching event was found in final NEAR state. Open it below.');return true;}
   const action=savedAttempt.actions[0]!;if(action.type!=='FunctionCall')throw Error('Invalid saved action');
   const f=await readCreateFunding(account,action.params.deposit,RPC_URL);if(wallet.getSessionEpoch()!==epoch)return false;
   setFunding(f);if(showFunding&&generation===dialogGeneration.current)setFundingDialog(f.shortfall!=='0');setNotice(f.shortfall!=='0'?'Your event is not on NEAR yet. Add native NEAR to this wallet for storage and gas, then check the balance again.':'No event was found yet. If you dismissed the old wallet request, you can explicitly retry this same event.');
  }catch(error){if(wallet.getSessionEpoch()===epoch){setRecoveryChecked(false);setNotice(friendly(error));setFundingError(friendly(error));}}finally{setConfirming(false);}
  return false;
 });}
 useEffect(()=>{if(hasAttempt&&!editingRetry&&!hash&&!pending&&savedAttempt&&wallet.proof)void checkRecovery();},[hasAttempt,editingRetry,hash,pending,savedAttempt?.eventId,account,wallet.proof?.accountId]);
 async function publish(retry=false){
  if(!account||!wallet.proof||!release||publishing.current||(!retry&&hasAttempt)||retry&&(!savedAttempt||hash&&!failedConfirmed||foundEvent||!editingRetry))return;
  const original=retry?savedAttempt:null,creationRules=retry?effectiveRules:rules;
  if(!creationRules||!quote)return;
  publishing.current=true;setPending(true);const epoch=wallet.getSessionEpoch();
  try {await withFactoryJournalLock(navigator.locks,`shared-create:${release.network}:${release.contract}:${account}`,async()=>{
   const key=journalKey(String(creationRules.event_id));
   if(retry){const state=await inspectSavedCreate(original!,release,account,RPC_URL);if(state.found){if(wallet.getSessionEpoch()===epoch){setFoundEvent(true);setEditingRetry(false);setNotice('This event already exists. Open it below; do not submit again.');}return;}}
   const fresh=await prepareMultiCreate(release,account,creationRules,RPC_URL),f=await readCreateFunding(account,fresh.quote,RPC_URL);
   if(wallet.getSessionEpoch()!==epoch)throw Error('Your wallet changed. Review the event again.');setFunding(f);
   if(f.shortfall!=='0'){setFundingError('');setFundingDialog(true);throw Error('Add native NEAR for event storage and gas, then check your balance again. No wallet transaction was requested.');}
   const expectedQuote=quote.quote;
   if(fresh.quote!==expectedQuote||JSON.stringify(fresh.rules)!==JSON.stringify(quote.rules))throw Error('The storage reservation changed. Check a fresh quote before approving.');
   const action={type:'FunctionCall' as const,params:{methodName:'create_event',args:{rules:creationRules},gas:'300000000000000',deposit:fresh.quote}},params=signParams(release.network,account,release.contract,[action]);
   if(!walletRequestAvailable(params,undefined,undefined,undefined,fresh))throw Error('Publishing context expired. Check again. No transaction was requested.');
   if(retry){const previous=localStorage.getItem(key);if(!previous||JSON.stringify(JSON.parse(previous))!==JSON.stringify(original)||localStorage.getItem(index!)!==key)throw Error('Saved creation changed. Refresh before continuing.');const history=`${key}:retry-history:${crypto.randomUUID()}`;localStorage.setItem(history,previous);if(localStorage.getItem(history)!==previous)throw Error('Could not preserve the earlier attempt.');}
   else if(localStorage.getItem(key)||localStorage.getItem(index!))throw Error('A previous event is still being checked.');
   const attempt:MainnetAttempt={account,child:release.contract,eventId:String(creationRules.event_id),actions:[action],hash:null},encoded=JSON.stringify(attempt);
   localStorage.setItem(key,encoded);localStorage.setItem(index!,key);if(localStorage.getItem(key)!==encoded||localStorage.getItem(index!)!==key)throw Error('Could not safely save this creation. No transaction was requested.');
   setSavedAttempt(attempt);setHasAttempt(true);setRecoveryChecked(false);setEditingRetry(false);setFailedConfirmed(false);setHash('');
   setWalletNotice('');const result=await signAndSendTransaction(params,undefined,undefined,undefined,fresh);
   if(!result.ok){
    if(!retry&&result.submission==='not_requested'&&localStorage.getItem(key)===encoded&&localStorage.getItem(index!)===key){localStorage.removeItem(key);localStorage.removeItem(index!);if(wallet.getSessionEpoch()===epoch){setHasAttempt(false);setSavedAttempt(null);}}
    if(wallet.getSessionEpoch()===epoch)setWalletNotice(`${friendly(result.detail)} ${result.submission==='not_requested'?'No wallet transaction was requested.':'No final transaction is confirmed. Check event status before retrying.'}`);return;
   }
   if(wallet.getSessionEpoch()===epoch&&!result.value.transactionHash)setWalletNotice(`The wallet returned no transaction hash (${result.value.responseShape??'unknown response'}). The request remains saved for reconciliation.`);
   const updated={...attempt,hash:result.value.transactionHash};localStorage.setItem(key,JSON.stringify(updated));if(wallet.getSessionEpoch()!==epoch)return;
   setSavedAttempt(updated);setHash(updated.hash??'');setNotice(updated.hash?'Transaction submitted. Checking its final receipt...':'Your wallet returned no transaction hash. Check the event and wallet activity below.');
  });}catch(error){if(wallet.getSessionEpoch()===epoch)setNotice(friendly(error));}finally{publishing.current=false;setPending(false);}
 }
 async function reconcile(automatic=false):Promise<boolean>{return oneWalletRequest(verifyFlight,async()=>{
  if(!account||!release||!hash||!savedAttempt)return false;const epoch=wallet.getSessionEpoch();setConfirming(true);
  try {return await withFactoryJournalLock(navigator.locks,`shared-create:${release.network}:${release.contract}:${account}`,async()=>{
   const saved=localStorage.getItem(journalKey(savedAttempt.eventId));if(!saved)throw Error('Saved creation unavailable. Refresh to check the event.');const attempt=JSON.parse(saved) as MainnetAttempt;
   if(JSON.stringify(attempt)!==JSON.stringify(savedAttempt))throw Error('The saved creation changed. Refresh before continuing.');const attemptedRules=savedCreateRules(attempt,release,account);
   if(attempt.hash!==null&&attempt.hash!==hash)throw Error('Transaction hash does not match the saved creation.');
   const response=await fetch(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'multi-create',method:'EXPERIMENTAL_tx_status',params:[hash,account]})}),body=await response.json();
   if(finalFailedCreateReceipt(body.result,{...attempt,hash})){const state=await inspectSavedCreate(attempt,release,account,RPC_URL);if(wallet.getSessionEpoch()!==epoch)return false;setFoundEvent(state.found);setFailedConfirmed(true);setRecoveryChecked(true);setNotice(state.found?'Your matching event already exists. Open it below.':'The transaction failed. Edit your event and try again.');return true;}
   if(mainnetReceipt(body.result,{...attempt,hash})!=='success')throw Error('Final transaction success is not confirmed. Check wallet history and the receipt.');
   const view=await sharedSnapshot(release,attempt.eventId,RPC_URL);if(!publishMatches(view.event as any,attemptedRules,account,release.canonicalFt,release.policy))throw Error('Waiting for matching event details.');
   if(wallet.getSessionEpoch()!==epoch)return false;openEvent(attempt);return true;
  });}catch(error){if(wallet.getSessionEpoch()===epoch)setNotice(automatic?'Waiting for the final receipt. You can check it again below.':friendly(error));return false;}finally{setConfirming(false);}
 });}
 useEffect(()=>{if(!hasAttempt||editingRetry||failedConfirmed||!hash||pending||!savedAttempt||!wallet.proof)return;let active=true,timer:ReturnType<typeof setTimeout>|undefined,count=0;const poll=async()=>{if(!active)return;const done=await reconcile(true);if(active&&!done&&count++<15)timer=setTimeout(()=>void poll(),2000);};void poll();return()=>{active=false;if(timer)clearTimeout(timer);};},[hasAttempt,editingRetry,failedConfirmed,hash,pending,savedAttempt?.eventId,account,wallet.proof?.accountId,wallet.sessionEpoch]);
 return <section className="create-publish-panel" aria-label="Publish event">
  {((quoteCurrent&&quote)||hasAttempt)&&funding&&<div className="ss-create-funding" role={insufficient?'status':undefined}><dl><div><dt>Event storage reservation</dt><dd>{formatUnits(funding.storage,24,'NEAR')}</dd></div><div><dt>Gas budget, including buffer</dt><dd>{formatUnits(funding.gasBudget,24,'NEAR')}</dd></div><div><dt>Available in {account}</dt><dd>{formatUnits(funding.available,24,'NEAR')}</dd></div>{insufficient&&<div className="ss-funding-shortfall"><dt>Add at least</dt><dd>{formatUnits(funding.shortfall,24,'NEAR')}</dd></div>}</dl><p>{insufficient?'Fund the connected organizer wallet with native NEAR, then check again. USDC cannot pay storage or gas.':'Unused gas is returned; this budget is not the final fee. Event storage is reserved separately.'}</p></div>}
  {(!hasAttempt||editingRetry)&&<button type="button" className="button button--dark ss-full" disabled={!release||!SHARED_CREATE_POLICY.enabled||pending||quoting||wallet.status==='connecting'||wallet.status==='signing'} onClick={e=>{trigger.current=e.currentTarget;void(quoteCurrent&&!insufficient?publish(editingRetry):begin());}}>{pending?'Preparing wallet request':quoting?'Checking event and NEAR balance':wallet.status==='signing'?'Approve sign-in in your wallet':insufficient?'Check NEAR balance':quoteCurrent?editingRetry?'Approve retry':'Approve and publish':editingRetry?'Try again':'Create event'}{pending||quoting?<LoaderCircle size={17} className="ss-spin"/>:<ArrowRight size={17}/>}</button>}
  {hasAttempt&&!editingRetry&&<div className="ss-create-recovery"><div className="ss-transaction-progress">{confirming||pending?<LoaderCircle size={18} className="ss-spin"/>:<RefreshCw size={18}/>}<div><strong>{foundEvent?'Event found on NEAR':failedConfirmed?'Transaction failed':hash?'Checking transaction receipt':insufficient?'Native NEAR required':'Creation needs attention'}</strong><p>{failedConfirmed?'This transaction failed. Your draft is kept so you can edit and retry.':hash?'The event opens after its final receipt is verified.':'No transaction hash was returned. Your event details are kept for recovery.'}</p></div></div>
   {foundEvent&&savedAttempt?<button type="button" className="button button--dark ss-full" onClick={()=>{const epoch=wallet.getSessionEpoch();void checkRecovery().then(exists=>{if(exists&&wallet.getSessionEpoch()===epoch)openEvent(savedAttempt);}).catch(error=>setNotice(friendly(error)));}}>Open event<ArrowRight size={17}/></button>:<button type="button" className="button button--secondary ss-full" disabled={pending||confirming} onClick={e=>{trigger.current=e.currentTarget;void(hash?reconcile():checkRecovery(true));}}>{confirming?'Checking...':hash?'Check transaction receipt':'Check event and NEAR balance'}</button>}
   {(!hash||failedConfirmed)&&!foundEvent&&savedAttempt&&<button type="button" className="button button--dark ss-full" disabled={pending||confirming} onClick={()=>{setEditingRetry(true);setQuote(null);setFunding(null);setIntent(false);setNotice('Your draft is unlocked. Edit it, then try again. The same event ID will be used; no transaction is sent automatically.');}}>Edit & try again<ArrowRight size={17}/></button>}
  </div>}
  {editingRetry&&<p className="ss-muted">Editing your saved event. Publishing checks the event and balance again before opening your wallet.</p>}
  {notice&&<p className="create-feedback" role="status">{notice.replace(/^Error:\s*/,'')}</p>}
  {walletNotice&&<p className="create-feedback" role="status">Last wallet response: {walletNotice.replace(/^Error:\s*/,'')}</p>}
  {hasAttempt&&!editingRetry&&<details className="ss-recovery-details"><summary>Transaction details and recovery</summary><label>Transaction hash<input value={hash} onChange={e=>setHash(e.target.value)} autoComplete="off" spellCheck={false}/></label><button type="button" className="button button--secondary" disabled={!hash||confirming||pending} onClick={()=>void reconcile()}>Check confirmation<ExternalLink size={14}/></button></details>}
  {fundingDialog&&funding&&funding.account===account&&<dialog ref={dialog} className="ss-editor-dialog ss-funding-dialog" aria-labelledby="funding-dialog-title" onCancel={e=>{e.preventDefault();closeFunding();}}><div className="ss-dialog-content"><div className="ss-dialog-heading"><h2 id="funding-dialog-title">More NEAR needed</h2><button type="button" className="ss-icon-button" aria-label="Close" onClick={closeFunding}><X size={19}/></button></div><p className="ss-funding-explanation">Native NEAR pays for event storage and gas. USDC cannot pay these costs. The gas budget includes a buffer and is not the final fee.</p><div className="ss-create-funding"><dl><div><dt>Connected account</dt><dd className="ss-funding-account">{funding.account}</dd></div><div><dt>Event storage reservation</dt><dd>{formatUnits(funding.storage,24,'NEAR')}</dd></div><div><dt>Gas budget, including buffer</dt><dd>{formatUnits(funding.gasBudget,24,'NEAR')}</dd></div><div><dt>Available native NEAR</dt><dd>{formatUnits(funding.available,24,'NEAR')}</dd></div><div className="ss-funding-shortfall"><dt>Add at least</dt><dd>{formatUnits(funding.shortfall,24,'NEAR')}</dd></div></dl></div>{fundingError&&<p className="ss-form-error" role="alert">{fundingError}</p>}<div className="ss-funding-actions"><button type="button" className="button button--secondary ss-full" disabled={quoting||confirming} onClick={()=>void(hasAttempt&&!editingRetry?checkRecovery(true):quoteNow())}>{quoting||confirming?'Checking...':'Check balance again'}</button><button type="button" className="button button--dark ss-full" onClick={closeFunding}>Got it</button></div></div></dialog>}
 </section>;
}
