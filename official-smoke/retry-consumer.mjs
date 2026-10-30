// Test-only real CLI/consumer seam. No direct journal reader or clock override.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const [exe,config,state,delivery]=process.argv.slice(2)
assert.equal(process.argv.length,6)
// Use the verified candidate's consumer, not a second checkout implementation.
const {TransferLifecycle}=await import(pathToFileURL(path.join(path.dirname(path.dirname(exe)),'transfer-lifecycle.mjs')))
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!['HERDR_PLUGIN_CONFIG_DIR','HERDR_PLUGIN_STATE_DIR'].includes(k.toUpperCase())))
Object.assign(env,{HERDR_PLUGIN_CONFIG_DIR:config,HERDR_PLUGIN_STATE_DIR:state})
const run=promisify(execFile),calls=[]
const invoke=async action=>{
 calls.push(action)
 assert.equal(action,'lifecycle-summary','consumer must not advance before the original deadline')
 const result=await run(exe,['-action',action],{env,encoding:'utf8',timeout:10000,maxBuffer:16384,shell:false,windowsHide:true})
 assert.equal(result.stderr,'')
 return {status:0,stdout:result.stdout}
}
const consumer=new TransferLifecycle({driver:{invoke}})
consumer.start();await consumer.tick();consumer.hint('network');await consumer.tick();await consumer.tick()
const snapshot=consumer.snapshot()
assert.equal(snapshot.state,'waiting');assert.equal(snapshot.attention,null)
const files=await run(exe,['-action','receipt-binding','-delivery',delivery],{env,encoding:'utf8',timeout:10000,maxBuffer:16384,shell:false,windowsHide:true})
assert.equal(files.stderr,'')
const receipt=JSON.parse(files.stdout)
assert.equal(receipt.schema,'memoh.delivery.receipt-binding.v1');assert.equal(receipt.server_effects,'none')
await consumer.stop()
console.log(JSON.stringify({state:snapshot.state,next_due_at:snapshot.decision.next_due_at,advances:0,calls,receipt,platform:process.platform}))
