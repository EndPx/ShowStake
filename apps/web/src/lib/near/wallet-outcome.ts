/** Hash normalization only. A hash never establishes transaction success. */
export function walletOutcomeShape(raw:unknown):string {
  if(raw===null)return 'null';
  if(Array.isArray(raw))return `array (${raw.length} entries)`;
  if(typeof raw==='object')return `object fields: ${Object.keys(raw).filter(k=>/^[A-Za-z0-9_]+$/.test(k)).slice(0,12).join(', ')||'(none)'}`;
  return typeof raw;
}
export function walletOutcomeHash(raw:unknown):string|null {
  if(!raw||typeof raw!=='object')return null;
  const value=raw as Record<string,any>;
  const candidates=[value.transaction?.hash,value.transactionHash,value.final_execution_outcome?.transaction?.hash];
  const hashes=candidates.filter((v):v is string=>typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(v));
  return hashes.length&&hashes.every(h=>h===hashes[0])?hashes[0]!:null;
}
