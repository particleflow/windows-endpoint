import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {replaceEndpointFixture,replaceEndpointChild,pinnedEndpointOverlay,fixtureSourceCopy,fixtureArguments,
  fixtureTestPlan,endpointFixtureTest} from './formal-endpoint.mjs'

test('endpoint overlay changes only the child launch, retaining every surrounding assertion',()=>{
  const old='cmd := exec.CommandContext(t.Context(), bin, "-test.run=^TestCLIPathChild$") //nolint:gosec // Current test executable, fixed arguments; no shell.'
  const before='assert exit0, empty stderr and exact original receipt\n',after='\nassert unchanged source, config, history and no additional requests'
  const source=before+old+after,output=replaceEndpointChild(source)
  assert.ok(output.startsWith(before));assert.ok(output.endsWith(after))
  const replacement=output.slice(before.length,-after.length)
  assert.ok(replacement.includes('os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", action, "-delivery", id'))
  assert.equal(output.replace(replacement,old),source)
  for(const wrong of [old+'\n'+old,'unrecognized fixture'])assert.throws(()=>replaceEndpointChild(wrong),/anchor_changed/)
})

test('endpoint fixture uses the formal EXE and explicit v2 route while retaining its original completion assertions',()=>{
  const source=[
    'func TestCLIPathTLSRestartAndLostResponses(t *testing.T) {',
    'server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {',
    'settings, _ := json.Marshal(map[string]any{"version": 1, "origin": server.URL, "source_root": source})',
    'write(filepath.Join(config, "transfer.json"), settings)',
    'write(certPath, server.Certificate().Raw)',
    'cmd := exec.CommandContext(t.Context(), bin, "-test.run=^TestCLIPathChild$") //nolint:gosec // Current test executable, fixed arguments; no shell.',
    'assert original task and delivery, stdout JSON and no credential leakage',
    'assert persisted waiting deadline, associated state and create/complete/commit/resolve exactly once',
    't.Fatal("source changed")\n\t}\n}',
  ].join('\n')
  const result=replaceEndpointFixture(source)
  assert.ok(result.includes('func '+endpointFixtureTest+'(t *testing.T)'))
  assert.ok(result.includes('httptest.NewServer('))
  assert.ok(result.includes('os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", action, "-delivery", id'))
  assert.ok(result.includes('"origin": "https://nas.fixture.invalid"'))
  assert.ok(result.includes('"physical_origin": server.URL'))
  assert.ok(result.includes('!bytes.Equal(originalSettings, settings)'))
  for(const line of source.split('\n').filter(line=>line.startsWith('assert ')))assert.ok(result.includes(line))
  assert.equal(result.includes('InsecureSkipVerify'),false)
  assert.equal(result.includes('server.Certificate()'),false)
  assert.throws(()=>replaceEndpointFixture(source+'\n'+source),/anchor_changed/)
  assert.throws(()=>pinnedEndpointOverlay(Buffer.from(source)),/endpoint_fixture_source_changed/)
})

test('endpoint compiler selection is finite and cannot select arbitrary test names or alter trust',()=>{
  const plan=fixtureTestPlan({source:'source',overlay:'overlay',exe:'verified.exe',env:{GOSUMDB:'sum.golang.org'}})
  assert.ok(plan.args.includes('-run=^'+endpointFixtureTest+'$'))
  assert.ok(plan.args.includes('-timeout=90s'))
  assert.equal(plan.options.timeout,120000);assert.equal(plan.options.shell,false)
  assert.deepEqual(plan.options.env,{GOSUMDB:'sum.golang.org',GOTOOLCHAIN:'local',GOPROXY:'off',ENDPOINT_RECEIPT_EXE:'verified.exe'})
  assert.equal(Object.keys(plan.options.env).some(key=>/CERT|TLS|TOKEN|CREDENTIAL/.test(key)),false)
})

test('endpoint invocation takes three paths and cannot smuggle a compiler expression',()=>{
  const args=['candidate with spaces','summary.json','producer-source']
  assert.deepEqual(fixtureArguments(args),args.map(p=>path.resolve(p)))
  for(const bad of [[],args.slice(1),[...args,'extra compiler expression']])assert.throws(()=>fixtureArguments(bad),/arguments_invalid/)
})

test('only normal Git LF or CRLF fixture copies are admitted and original working bytes are retained',()=>{
  for(const [text,eol] of [['first\nsecond\n','LF'],['first\r\nsecond\r\n','CRLF']]){
    const copy=fixtureSourceCopy(Buffer.from(text))
    assert.equal(copy.text,text);assert.equal(copy.canonical,'first\nsecond\n');assert.equal(copy.lineEndings,eol)
  }
  for(const bad of [Buffer.from('first\r\nsecond\n'),Buffer.from([0xff])])assert.throws(()=>fixtureSourceCopy(bad),/source_changed/)
})
