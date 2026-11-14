const fs = require('node:fs');
const expected = ['a5e5b34366070e54.ss-fac-c1113232934.testnet','961a277b21cf13ac.ss-fac-c1113232934.testnet'];
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!data || Object.keys(data).join() !== 'children' || !Array.isArray(data.children) || data.children.length !== 2) throw Error('invalid deployment input');
for (const [i, child] of data.children.entries()) {
  if (!child || Object.keys(child).sort().join() !== 'contract,startBlock' || child.contract !== expected[i] || !Number.isSafeInteger(child.startBlock) || child.startBlock <= 0) throw Error('exact child and verified positive creation block required');
}
if (process.argv[3]) {
  const index = Number(process.argv[3]) - 1, key = process.argv[4];
  if (![0,1].includes(index) || !['contract','startBlock'].includes(key)) throw Error('invalid query');
  process.stdout.write(String(data.children[index][key]));
}
