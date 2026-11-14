import {reviewedSharedYieldRelease,type MultiEventRelease} from './near/multi-event.ts';
export function earnEventMode(network:'mainnet'|'testnet',release:MultiEventRelease|null):'mainnet-shared'|'testnet-shared'|'mainnet-pending'|'unavailable' {
 if(reviewedSharedYieldRelease(release)&&release.network===network)return network==='mainnet'?'mainnet-shared':'testnet-shared';return network==='mainnet'?'mainnet-pending':'unavailable';
}
