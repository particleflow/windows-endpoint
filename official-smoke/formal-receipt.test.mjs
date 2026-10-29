import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {replaceReceiptChild,pinnedReceiptOverlay,receiptFixtureTest,receiptTestPlan,receiptSourceCopy,formalReceiptArguments} from './formal-receipt.mjs'

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

test('formal receipt invocation takes three paths and resolves the compiler through the existing tool PATH',()=>{
  const args=['candidate with spaces','summary.json','producer-source']
  assert.deepEqual(formalReceiptArguments(args),args.map(p=>path.resolve(p)))
  for(const bad of [[],args.slice(1),[...args,'extra compiler expression']])assert.throws(()=>formalReceiptArguments(bad),/arguments_invalid/)
})

test('only normal Git LF or CRLF fixture copies are admitted and original working bytes are retained',()=>{
  for(const [text,eol] of [['first\nsecond\n','LF'],['first\r\nsecond\r\n','CRLF']]){
    const copy=receiptSourceCopy(Buffer.from(text))
    assert.equal(copy.text,text);assert.equal(copy.canonical,'first\nsecond\n');assert.equal(copy.lineEndings,eol)
  }
  for(const bad of [Buffer.from('first\r\nsecond\n'),Buffer.from([0xff])])assert.throws(()=>receiptSourceCopy(bad),/source_changed/)
})
