import assert from 'node:assert/strict';import {walletOutcomeHash,walletOutcomeShape} from './wallet-outcome.ts';
const hash='5nL4htVAQREWW3e7UniPoE5n8bCbD9cJ72REMWjcqiZb';
assert.equal(walletOutcomeHash({transaction:{hash}}),hash);assert.equal(walletOutcomeHash({transactionHash:hash}),hash);assert.equal(walletOutcomeHash({final_execution_outcome:{transaction:{hash}}}),hash);assert.equal(walletOutcomeHash({transaction:{hash},transactionHash:'1'.repeat(44)}),null);assert.equal(walletOutcomeHash({transactionHash:'not a transaction'}),null);assert.equal(walletOutcomeHash(null),null);console.log('PASS_LOCAL wallet outcome hash normalization without success inference');

assert.equal(walletOutcomeShape(undefined),'undefined');assert.equal(walletOutcomeShape({transaction:{hash},secret:'never display this'}),'object fields: transaction, secret');assert.equal(walletOutcomeShape([{}]),'array (1 entries)');
