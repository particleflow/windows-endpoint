// Windows CI only: the unchanged production EXE reads an owned synthetic queue.
// Test-only Go overlay changes launch lines, never a product/Agent source.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {verifyCandidate} from '../candidate.mjs'
import {catalog,digest,validateDirectory} from '../endpoint.mjs'
import {boundedRead} from '../session-diagnostics.mjs'
import {completedTests} from './producer-fixtures.mjs'

const hash=raw=>createHash('sha256').update(raw).digest('hex')
const need=(ok,code)=>{if(!ok)throw Error(code)}
// Memoh@a235cc2b cmd/transferqueue/cli_path_test.go, canonical LF bytes.
export const endpointFixtureSha256='4ac00f4ac2188bced673b4019d339f236da67e2b42378aad9d971e4c49780b00'
export const endpointFixtureTest='TestCLIPathPhysicalEndpointEXERestart'
const anchor='cmd := exec.CommandContext(t.Context(), bin, "-test.run=^TestCLIPathChild$") //nolint:gosec // Current test executable, fixed arguments; no shell.'
const replacement='cmd := exec.CommandContext(t.Context(), os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", action, "-delivery", id) //nolint:gosec // Verified production EXE; synthetic original task only.\n\t\t_ = bin'

export function replaceEndpointChild(source){
  need(typeof source==='string'&&source.split(anchor).length===2,'formal_endpoint_fixture_anchor_changed')
  return source.replace(anchor,()=>replacement)
}
export function fixtureSourceCopy(raw){
  need(Buffer.isBuffer(raw),'formal_endpoint_fixture_source_changed')
  const text=raw.toString('utf8'),canonical=text.replaceAll('\r\n','\n')
  need(raw.equals(Buffer.from(text))&&(text===canonical||text===canonical.replaceAll('\n','\r\n')),'formal_endpoint_fixture_source_changed')
  return {text,canonical,lineEndings:text===canonical?'LF':'CRLF'}
}
// Reuse the original finite CLI/lost-response fixture with its assertions.
// Only the test server, explicit sidecar route and real child launch differ.
// The production EXE has no TLS hook and no clock override: the fixture's own
// real-clock wait to the persisted retry deadline stays exactly as upstream
// rewrote it at this pin.
export function pinnedEndpointOverlay(raw){
  const copy=fixtureSourceCopy(raw)
  need(hash(copy.canonical)===endpointFixtureSha256,'formal_endpoint_fixture_source_changed')
  const text=replaceEndpointFixture(copy.canonical)
  return copy.lineEndings==='CRLF'?text.replaceAll('\n','\r\n'):text
}
export function replaceEndpointFixture(source){
  let text=source
  const replace=(before,after)=>{
    need(text.split(before).length===2,'formal_endpoint_fixture_anchor_changed')
    text=text.replace(before,()=>after)
  }
  replace('func TestCLIPathTLSRestartAndLostResponses(t *testing.T) {','func '+endpointFixtureTest+'(t *testing.T) {')
  replace('server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {','server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {')
  replace('settings, _ := json.Marshal(map[string]any{"version": 1, "origin": server.URL, "source_root": source})',
    'settings, _ := json.Marshal(map[string]any{"version": 1, "origin": "https://nas.fixture.invalid", "source_root": source})')
  replace('write(filepath.Join(config, "transfer.json"), settings)',
    'write(filepath.Join(config, "transfer.json"), settings)\n\tendpointRouting, _ := json.Marshal(map[string]any{"version": 2, "endpoint": map[string]string{"logical_origin": "https://nas.fixture.invalid", "physical_origin": server.URL}})\n\twrite(filepath.Join(config, "transfer-network.json"), endpointRouting)')
  replace('write(certPath, server.Certificate().Raw)','write(certPath, []byte("unused by production EXE"))')
  text=replaceEndpointChild(text)
  replace('t.Fatal("source changed")\n\t}\n}',
    't.Fatal("source changed")\n\t}\n\toriginalSettings, err := os.ReadFile(filepath.Join(config, "transfer.json"))\n\tif err != nil || !bytes.Equal(originalSettings, settings) { t.Fatal("logical origin or HostBinding bytes changed") }\n\tt.Log("formal_endpoint_original_bytes=7 create=1 complete=1 commit=1 resolve=1 fresh_process_per_command=true")\n}')
  return text
}
export function fixtureArguments(args){
  need(args.length===3&&args.every(p=>typeof p==='string'&&p.length>0),'formal_endpoint_arguments_invalid')
  return args.map(p=>path.resolve(p))
}
export function fixtureTestPlan({source,overlay,exe,env=process.env}){
  return {args:['test','-v','-mod=readonly','-overlay='+overlay,'./cmd/transferqueue','-run=^'+endpointFixtureTest+'$','-count=1','-timeout=90s'],
    options:{cwd:source,env:{...env,GOTOOLCHAIN:'local',GOPROXY:'off',ENDPOINT_RECEIPT_EXE:exe},
      shell:false,windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024**2}}
}

export async function verifyFormalEndpoint(candidate,summaryFile,source,go){
  need(process.platform==='win32'&&process.arch==='x64','formal_endpoint_windows_required')
  need(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted','formal_endpoint_disposable_ci_required')
  const summary=JSON.parse(await boundedRead(summaryFile,65536))
  const {manifest}=await verifyCandidate(candidate,summary.manifest_sha256)
  need(summary.source_commit===manifest.source_commit&&summary.producer_commit===manifest.producer_commit,'formal_endpoint_summary_mismatch')
  need(manifest.producer_commit==='8a1b30a69eed7b64f006e9e86c2ea73a1c15b64f'&&manifest.producer_commit===catalog.components.transfer.revision,'formal_endpoint_producer_mismatch')
  await validateDirectory(source)
  const run=promisify(execFile)
  const ref=await run('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',timeout:15000,windowsHide:true,shell:false})
  need(ref.stdout.trim()===manifest.producer_commit,'formal_endpoint_source_mismatch')
  const version=await run(go,['version'],{encoding:'utf8',timeout:15000,windowsHide:true,shell:false})
  need(version.stdout.trim()==='go version go1.25.7 windows/amd64','formal_endpoint_go_version_mismatch')
  const filename='cli_path_test.go',file=path.join(source,'cmd/transferqueue',filename)
  const original=await boundedRead(file,32768),modified=pinnedEndpointOverlay(Buffer.from(original))
  const exe=path.join(candidate,'transfer/transferqueue.exe'),member=manifest.files.find(f=>f.path==='transfer/transferqueue.exe')
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'endpoint-formal-')))
  try{
    const backing=path.join(temporary,filename),overlay=path.join(temporary,'overlay.json')
    await fs.writeFile(backing,modified,{flag:'wx'})
    await fs.writeFile(overlay,JSON.stringify({Replace:{[file]:backing}}),{flag:'wx'})
    const plan=fixtureTestPlan({source,overlay,exe})
    let result
    try{result=await run(go,plan.args,plan.options)}
    catch(error){
      // This exact fixture contains only synthetic data. Keep bounded compiler
      // and assertion diagnostics; never replace them with a bare exit code.
      if(typeof error.stdout==='string')process.stdout.write(error.stdout)
      if(typeof error.stderr==='string')process.stderr.write(error.stderr)
      throw error
    }
    process.stdout.write(result.stdout)
    need(result.stderr==='','formal_endpoint_stderr_unexpected')
    completedTests(result.stdout,[endpointFixtureTest])
    need(await boundedRead(file,32768)===original&&await digest(exe)===member.sha256,'formal_endpoint_inputs_changed')
    const evidence={formalEndpointRouting:'passed',sourceCommit:manifest.source_commit,producerCommit:manifest.producer_commit,
      manifestSha256:summary.manifest_sha256,executableSha256:member.sha256,originalFixtureSha256:endpointFixtureSha256,
      originalWorkingFileSha256:hash(original),fixtureLineEndings:fixtureSourceCopy(Buffer.from(original)).lineEndings,
      testOverlaySha256:hash(modified),test:endpointFixtureTest,tests:1,skipped:0,testedEntry:'production_exe',
      fixture:'original_cli_assertions_explicit_v2_http_real_clock',bytes:7,create:1,complete:1,commit:1,resolve:1,freshProcessPerCommand:true,logicalBindingPreserved:true,
      producerSourceModified:false,deliveryProven:false,systemTrustPositiveUpload:'unverified',releaseGateChanged:false}
    process.stdout.write(JSON.stringify(evidence)+'\n')
    return evidence
  }finally{await fs.rm(temporary,{recursive:true,force:true})}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await verifyFormalEndpoint(...fixtureArguments(process.argv.slice(2)),'go')}
  catch(error){process.stderr.write(JSON.stringify({formalEndpointRouting:'unverified',reason:/^(formal_endpoint|candidate)_[a-z_]+$/.test(error.message)?error.message:'formal_endpoint_execution_failed',exitCode:Number.isInteger(error.code)?error.code:null,argumentCount:process.argv.length-2,releaseGateChanged:false})+'\n');process.exitCode=1}
}
