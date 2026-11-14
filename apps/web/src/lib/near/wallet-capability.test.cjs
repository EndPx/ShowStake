const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { NearConnector } = require('@hot-labs/near-connect');

const source = readFileSync(join(__dirname, 'wallet.ts'), 'utf8');
assert.match(source, /features:\s*\{\s*signMessage:\s*true,\s*testnet:\s*NETWORK\s*===\s*"testnet"\s*\}/);
const available = Object.getOwnPropertyDescriptor(NearConnector.prototype, 'availableWallets').get;
const wallets = [
  {manifest:{id:'supports-message',features:{signMessage:true,testnet:true}}},
  {manifest:{id:'ethereum-wallets',features:{signMessage:false,testnet:true}}},
  {manifest:{id:'no-declared-capability',features:{testnet:true}}},
  {manifest:{id:'mainnet-only',features:{signMessage:true,testnet:false}}},
];
assert.deepEqual(available.call({wallets,features:{signMessage:true,testnet:false},network:'mainnet'}).map(x=>x.manifest.id), ['supports-message','mainnet-only']);
assert.deepEqual(available.call({wallets,features:{signMessage:true,testnet:true},network:'testnet'}).map(x=>x.manifest.id), ['supports-message']);
console.log('PASS_LOCAL installed SDK feature filtering and ShowStake connector configuration');
