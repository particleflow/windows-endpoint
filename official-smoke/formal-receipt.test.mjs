import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {replaceReceiptChild,pinnedReceiptOverlay,receiptFixtureTest,receiptTestPlan,receiptSourceCopy,formalReceiptArguments,
  replaceEndpointFixture,pinnedEndpointOverlay,endpointFixtureTest} from './formal-receipt.mjs'
import {retryFixtures,retryPairOverlay} from './retry-pair-overlays.mjs'

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

test('endpoint fixture uses the formal EXE and explicit route while retaining its original completion assertions',()=>{
  const source=[
    'func TestCLIPathTLSRestartAndLostResponses(t *testing.T) {',
    'server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {',
    'settings, _ := json.Marshal(map[string]any{"version": 1, "origin": server.URL, "source_root": source})',
    'write(filepath.Join(config, "transfer.json"), settings)',
    'write(certPath, server.Certificate().Raw)',
    'cmd := exec.CommandContext(t.Context(), bin, "-test.run=^TestCLIPathChild$") //nolint:gosec // Current test executable, fixed arguments; no shell.',
    'assert original task and delivery, stdout JSON and no credential leakage',
    'now = deadline.Add(time.Millisecond)',
    'assert original waiting deadline, associated state and create/complete/commit/resolve exactly once',
    't.Fatal("source changed")\n\t}\n}',
  ].join('\n')
  const result=replaceEndpointFixture(source)
  assert.ok(result.includes('func '+endpointFixtureTest+'(t *testing.T)'))
  assert.ok(result.includes('httptest.NewServer('))
  assert.ok(result.includes('os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", action, "-delivery", id'))
  assert.ok(result.includes('"origin": "https://nas.fixture.invalid"'))
  assert.ok(result.includes('"physical_origin": server.URL'))
  assert.ok(result.includes('time.Sleep(wait)'))
  assert.ok(result.includes('wait > 10*time.Second'))
  assert.ok(result.includes('!bytes.Equal(originalSettings, settings)'))
  for(const line of source.split('\n').filter(line=>line.startsWith('assert ')))assert.ok(result.includes(line))
  assert.equal(result.includes('InsecureSkipVerify'),false)
  assert.equal(result.includes('server.Certificate()'),false)
  assert.throws(()=>replaceEndpointFixture(source+'\n'+source),/anchor_changed/)
  assert.throws(()=>pinnedEndpointOverlay(Buffer.from(source)),/endpoint_source_changed/)
})

test('formal endpoint compiler selection is finite and cannot select arbitrary test names or alter trust',()=>{
  const plan=receiptTestPlan({source:'source',overlay:'overlay',exe:'verified.exe',env:{GOSUMDB:'sum.golang.org'},test:endpointFixtureTest})
  assert.ok(plan.args.includes('-run=^'+endpointFixtureTest+'$'))
  assert.ok(plan.args.includes('-timeout=90s'))
  assert.equal(plan.options.timeout,120000)
  assert.deepEqual(plan.options.env,{GOSUMDB:'sum.golang.org',GOTOOLCHAIN:'local',GOPROXY:'off',ENDPOINT_RECEIPT_EXE:'verified.exe'})
  assert.throws(()=>receiptTestPlan({source:'source',overlay:'overlay',exe:'verified.exe',test:'arbitrary'}),/test_invalid/)
})

test('retry pair selects only the two pinned fixtures and refuses changed source before execution',()=>{
  for(const [mode,fixture]of Object.entries(retryFixtures)){
    assert.throws(()=>retryPairOverlay(Buffer.from('not the pinned producer fixture'),mode),/fixture_changed/)
    const plan=receiptTestPlan({source:'source',overlay:'test-overlay',exe:'verified',test:fixture.test,env:{GOSUMDB:'sum.golang.org'}})
    assert.ok(plan.args.includes('-run=^'+fixture.test+'$'))
    assert.equal(plan.options.timeout,120000);assert.ok(plan.args.includes('-timeout=90s'))
    assert.equal(plan.options.env.GOPROXY,'off');assert.equal(plan.options.env.GOSUMDB,'sum.golang.org')
    assert.equal(Object.keys(plan.options.env).some(key=>/CERT|TLS|TOKEN|CREDENTIAL/.test(key)),false)
  }
  assert.throws(()=>retryPairOverlay(Buffer.from(''), 'other'),/fixture_changed/)
})
