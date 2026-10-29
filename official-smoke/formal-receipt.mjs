// Windows CI only: the unchanged production EXE reads an owned synthetic queue.
// Test-only Go overlay changes one launch line, never a product/Agent source.
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
export const receiptFixtureSha256='cc98c3684c507062006bc05f5603ad8c4601d7a8318909dab28a57389bebef53'
export const receiptFixtureTest='TestCLIPathReceiptBindingPositiveChildReadOnly'
const anchor='cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestReceiptBindingCommandChild$") //nolint:gosec // This exact test executable, fixed helper only.'
const replacement='cmd := exec.CommandContext(ctx, os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", "receipt-binding", "-delivery", closed.DeliveryID()) //nolint:gosec // Hash-verified production EXE, test-only overlay.'

export function replaceReceiptChild(source){
  need(typeof source==='string'&&source.split(anchor).length===2,'formal_receipt_fixture_anchor_changed')
  return source.replace(anchor,()=>replacement)
}
export function pinnedReceiptOverlay(raw){
  need(Buffer.isBuffer(raw)&&hash(raw)===receiptFixtureSha256,'formal_receipt_fixture_source_changed')
  return replaceReceiptChild(raw.toString('utf8'))
}
export function receiptTestPlan({source,overlay,exe,env=process.env}){
  return {args:['test','-v','-mod=readonly','-overlay='+overlay,'./cmd/transferqueue','-run=^'+receiptFixtureTest+'$','-count=1','-timeout=90s'],
    options:{cwd:source,env:{...env,GOTOOLCHAIN:'local',GOPROXY:'off',ENDPOINT_RECEIPT_EXE:exe},
      shell:false,windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024**2}}
}

export async function verifyFormalReceipt(candidate,summaryFile,source,go){
  need(process.platform==='win32'&&process.arch==='x64','formal_receipt_windows_required')
  need(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted','formal_receipt_disposable_ci_required')
  const summary=JSON.parse(await boundedRead(summaryFile,65536))
  const {manifest}=await verifyCandidate(candidate,summary.manifest_sha256)
  need(summary.source_commit===manifest.source_commit&&summary.producer_commit===manifest.producer_commit,'formal_receipt_summary_mismatch')
  need(manifest.producer_commit==='d25a7fcc4ad05ae43a5c42d3c7e79cfb99535d91'&&manifest.producer_commit===catalog.components.transfer.revision,'formal_receipt_producer_mismatch')
  await validateDirectory(source)
  const run=promisify(execFile)
  const ref=await run('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',timeout:15000,windowsHide:true,shell:false})
  need(ref.stdout.trim()===manifest.producer_commit,'formal_receipt_source_mismatch')
  const version=await run(go,['version'],{encoding:'utf8',timeout:15000,windowsHide:true,shell:false})
  need(version.stdout.trim()==='go version go1.25.7 windows/amd64','formal_receipt_go_version_mismatch')
  const file=path.join(source,'cmd/transferqueue/receipt_binding_positive_test.go')
  const original=await boundedRead(file,32768),modified=pinnedReceiptOverlay(Buffer.from(original))
  const exe=path.join(candidate,'transfer/transferqueue.exe'),member=manifest.files.find(f=>f.path==='transfer/transferqueue.exe')
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'endpoint-formal-receipt-')))
  try{
    const backing=path.join(temporary,'receipt_binding_positive_test.go'),overlay=path.join(temporary,'overlay.json')
    await fs.writeFile(backing,modified,{flag:'wx'})
    await fs.writeFile(overlay,JSON.stringify({Replace:{[file]:backing}}),{flag:'wx'})
    const plan=receiptTestPlan({source,overlay,exe})
    const result=await run(go,plan.args,plan.options)
    process.stdout.write(result.stdout)
    need(result.stderr==='','formal_receipt_stderr_unexpected')
    completedTests(result.stdout,[receiptFixtureTest])
    need(await boundedRead(file,32768)===original&&await digest(exe)===member.sha256,'formal_receipt_inputs_changed')
    const evidence={formalReceiptBinding:'passed',sourceCommit:manifest.source_commit,producerCommit:manifest.producer_commit,
      manifestSha256:summary.manifest_sha256,executableSha256:member.sha256,originalFixtureSha256:receiptFixtureSha256,
      testOverlaySha256:hash(modified),test:receiptFixtureTest,tests:1,skipped:0,testedEntry:'production_exe',
      fixture:'one_launch_line_overlay_original_assertions_retained',additionalFixtureRequests:0,
      producerSourceModified:false,deliveryProven:false,systemTrustPositiveUpload:'unverified',releaseGateChanged:false}
    process.stdout.write(JSON.stringify(evidence)+'\n')
    return evidence
  }finally{await fs.rm(temporary,{recursive:true,force:true})}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===6,'formal_receipt_arguments_invalid');await verifyFormalReceipt(...process.argv.slice(2).map(p=>path.resolve(p)))}
  catch(error){process.stderr.write(JSON.stringify({formalReceiptBinding:'unverified',reason:/^formal_receipt_[a-z_]+$/.test(error.message)?error.message:'formal_receipt_execution_failed',exitCode:error.code??null,releaseGateChanged:false})+'\n');process.exitCode=1}
}
