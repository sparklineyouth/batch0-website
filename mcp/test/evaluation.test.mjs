import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateFixture} from '../evaluations/verify.mjs';
test('ten synthetic assistant evaluation answers match paginated read-only tool results',async()=>{
  const cases=JSON.parse(await readFile(new URL('../evaluations/cases.json',import.meta.url),'utf8'));
  const result=await evaluateFixture();assert.equal(cases.length,10);assert.deepEqual(result.answers,cases.map(c=>c.answer));assert.ok(result.read_calls>20);
});
