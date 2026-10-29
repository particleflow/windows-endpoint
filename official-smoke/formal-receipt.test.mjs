import test from 'node:test'
import assert from 'node:assert/strict'
import {replaceReceiptChild,pinnedReceiptOverlay,receiptFixtureTest,receiptTestPlan} from './formal-receipt.mjs'

test('formal receipt overlay changes exactly the child launch, retaining every surrounding assertion',()=>{
  const old='cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestReceiptBindingCommandChild$") //nolint:gosec // This exact test executable, fixed helper only.'
  const before='assert exit0, empty stderr and exact original receipt\n',after='\nassert unchanged source, config, history and no additional requests'
  const source=before+old+after,output=replaceReceiptChild(source)
  assert.ok(output.startsWith(before));assert.ok(output.endsWith(after))
  const replacement=output.slice(before.length,-after.length)
  assert.ok(replacement.includes('os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", "receipt-binding", "-delivery", closed.DeliveryID()'))
  assert.equal(output.replace(replacement,old),source)
  for(const wrong of [old+'\n'+old,'unrecognized fixture'])assert.throws(()=>replaceReceiptChild(wrong),/anchor_changed/)
  assert.throws(()=>pinnedReceiptOverlay(Buffer.from(source)),/fixture_source_changed/)
})

test('formal receipt compiler invocation is bounded, offline and selects only the new fixture',()=>{
  const plan=receiptTestPlan({source:'C:/isolated source',overlay:'C:/test overlay.json',exe:'C:/verified candidate/transferqueue.exe',env:{EXISTING:'kept',GOSUMDB:'sum.golang.org'}})
  assert.deepEqual(plan.args,['test','-v','-mod=readonly','-overlay=C:/test overlay.json','./cmd/transferqueue','-run=^'+receiptFixtureTest+'$','-count=1','-timeout=90s'])
  assert.equal(plan.options.timeout,120000);assert.equal(plan.options.shell,false)
  assert.equal(plan.options.env.GOPROXY,'off');assert.equal(plan.options.env.GOTOOLCHAIN,'local')
  assert.equal(plan.options.env.GOSUMDB,'sum.golang.org')
  assert.equal(plan.options.env.ENDPOINT_RECEIPT_EXE,'C:/verified candidate/transferqueue.exe')
  assert.equal(plan.options.env.EXISTING,'kept')
  assert.equal(Object.keys(plan.options.env).some(k=>/CERT|TLS|TOKEN|CREDENTIAL/.test(k)),false)
})
