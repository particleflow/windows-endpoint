// One recorded old producer is a read-only reference witness, never an import,
// executable qualification, directory adoption or extension of the staging pin.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {validateDirectory,componentRoots,transferLocations} from './endpoint.mjs'
import {historicalProducer,profileForProducer} from './candidate.mjs'

export const externalProducerIdentity = Object.freeze({
  manifestSha256:'3ccaa153c386d8c4b6cda76c3201d39eebee0c6d747fda296ce7dc441491517a',
  sourceCommit:'41ddb9be845eae09a1ac49a7bde3e8a108e510b0',producerCommit:historicalProducer,
  executableSha256:'e34f3232f483380c4f141ecd0462ff1dc4a5cad26c0c12e1fb8781f5158bee01',executableSize:10254336,
})
const names=['README.md','herdr-plugin.toml','transfer.example.json','transferqueue-cli.test.exe','transferqueue.exe','transferqueue.test.exe','verify-fixtures.ps1','SHA256SUMS.json'].sort()
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const stages=new Set(['validation','paths','source_manifest','registered_manifest','source_subtree','registered_subtree','security_transport','security_decode','security_item','security_descriptor','security_output','security_envelope','generation','archive'])
const fail=(stage='validation')=>{throw Object.assign(Error('producer_upgrade_external_reference_unverified'),{code:'producer_upgrade_external_reference_unverified',evidenceStage:stages.has(stage)?stage:'validation'})}
const demand=ok=>{if(!ok)fail()}
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',')
const stamp=st=>['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].map(key=>String(st[key])).join(':')
const version=value=>typeof value==='string'&&value.length<=280&&/^-?\d+(?::-?\d+){6}$/.test(value)
const sid=value=>typeof value==='string'&&value.length<=184&&/^S-\d+(?:-\d+){1,15}$/.test(value)
const securityValid=value=>exact(value,['ownerSid','groupSid','descriptorSha256'])&&sid(value.ownerSid)&&sid(value.groupSid)&&hash(value.descriptorSha256)
const overlaps=(a,b)=>[path.relative(a,b),path.relative(b,a)].some(r=>r===''||!path.isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${path.sep}`))

async function readSecurity(files) {
  demand(process.platform==='win32'&&process.arch==='x64')
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'))
  const input=Buffer.from(JSON.stringify(files),'utf8')
  let stage='security_transport'
  try {
    const result=await promisify(execFile)(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./producer-reference.ps1',import.meta.url)),
      '-FilesBase64',input.toString('base64')],{env,shell:false,windowsHide:true,timeout:15000,maxBuffer:32768,encoding:'utf8'})
    stage='security_envelope'
    const values=JSON.parse(result.stdout.replace(/^\uFEFF/,''))
    demand(exact(values,['schema','requestSha256','files'])&&values.schema===1&&values.requestSha256===sha(input)&&Array.isArray(values.files)&&values.files.length===files.length&&values.files.every(securityValid))
    return values.files
  } catch(error) {
    try {
      const detail=JSON.parse(error.stderr)
      if(detail.error==='producer_reference_security_unavailable')stage=({argument:'security_decode',item:'security_item',descriptor:'security_descriptor',output:'security_output'})[detail.stage]||stage
    } catch {}
    fail(stage)
  }
}
async function fileEvidence(file,maximum,{size,sha256,retain=false}={}) {
  await validateDirectory(path.dirname(file))
  const st=await fs.lstat(file,{bigint:true}),generation=stamp(st)
  demand(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1n&&st.ino!==0n&&st.size<=BigInt(maximum)&&(size===undefined||st.size===BigInt(size)))
  const handle=await fs.open(file,'r'),hasher=createHash('sha256'),parts=[]
  let length=0
  try {
    demand(stamp(await handle.stat({bigint:true}))===generation)
    const buffer=Buffer.alloc(65536)
    while(length<=maximum) {
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,maximum+1-length),length)
      if(!bytesRead)break
      length+=bytesRead;demand(length<=maximum);hasher.update(buffer.subarray(0,bytesRead))
      if(retain)parts.push(Buffer.from(buffer.subarray(0,bytesRead)))
    }
    demand(stamp(await handle.stat({bigint:true}))===generation&&stamp(await fs.lstat(file,{bigint:true}))===generation)
    const digest=hasher.digest('hex');demand(sha256===undefined||digest===sha256)
    return {generation,size:length,sha256:digest,...(retain?{raw:Buffer.concat(parts).toString('utf8')}:{})}
  } finally {await handle.close()}
}
async function directoryEvidence(directory) {
  await validateDirectory(directory)
  const st=await fs.lstat(directory,{bigint:true});demand(st.isDirectory()&&!st.isSymbolicLink()&&st.ino!==0n)
  return {generation:stamp(st)}
}

// The injectable identity/security reader are source-only fixture dependencies.
// The product CLI always uses the frozen production instance below; no config,
// CLI path, owner display name or caller JSON can replace its provenance pins.
export function createProducerReferenceAdapter({identity=externalProducerIdentity,security=readSecurity}={}) {
  const pin=Object.freeze({...identity})
  function manifest(raw,selected) {
    demand(sha(raw)===pin.manifestSha256)
    const record=selected.packages.find(item=>item.hash===pin.manifestSha256)
    demand(record&&record.profile===profileForProducer(pin.producerCommit)&&selected.current!==pin.manifestSha256)
    const value=JSON.parse(raw)
    demand(value.schema===1&&value.kind==='portable-existing-installations-review'&&value.platform==='win32-x64'&&value.entry==='endpoint.mjs'&&
      value.source_repository==='particleflow/windows-endpoint'&&value.source_commit===pin.sourceCommit&&value.producer_repository==='particleflow/Memoh'&&
      value.producer_commit===pin.producerCommit&&value.state_profile==='endpoint-program-v1'&&Array.isArray(value.files)&&value.files.length<=256)
    const files=value.files.filter(file=>typeof file?.path==='string'&&file.path.startsWith('transfer/'))
    demand(files.length===names.length&&JSON.stringify(files.map(file=>file.path).sort())===JSON.stringify(names.map(name=>'transfer/'+name)))
    demand(files.every(file=>exact(file,['path','size','sha256'])&&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=128*1024**2&&hash(file.sha256)))
    const executable=files.find(file=>file.path==='transfer/transferqueue.exe')
    demand(executable.sha256===pin.executableSha256&&executable.size===pin.executableSize)
    return files
  }
  function roots(config,layout) {
    const root=config.transfer?.pluginRoot
    demand(typeof root==='string'&&path.isAbsolute(root)&&path.normalize(root)===root&&path.basename(root)==='transfer')
    demand(!overlaps(layout.packages,root))
    const locations=transferLocations(config)
    demand([...componentRoots(config),locations.config,locations.state,config.connector.enrollmentFile,layout.control,layout.config,layout.data,layout.logs]
      .every(data=>!overlaps(data,root)))
    return {root,parent:path.dirname(root),registered:path.join(layout.packages,pin.manifestSha256)}
  }
  function proof(raw,files) {
    const value=JSON.parse(raw),payload=files.filter(file=>file.path!=='transfer/SHA256SUMS.json')
    demand(value.source_commit===pin.producerCommit&&value.arch==='amd64'&&Array.isArray(value.files)&&value.files.length===payload.length&&
      new Set(value.files.map(file=>file.name)).size===payload.length&&value.files.every(file=>exact(file,['name','sha256'])&&
        payload.some(expected=>expected.path==='transfer/'+file.name&&expected.sha256===file.sha256)))
  }
  function objects(files) {
    return ['source','registered'].flatMap(side=>[
      {role:side+':parent',kind:'directory'},{role:side+':root',kind:'directory'},
      {role:side+':manifest',kind:'file',sha256:pin.manifestSha256},
      ...names.map(name=>({role:side+':'+name,kind:'file',...files.find(file=>file.path==='transfer/'+name)})),
    ])
  }
  function validate(witness,selected,config,layout) {
    demand(exact(witness,['kind','root','registeredManifestSha256','manifestRaw','proofRaw','objects'])&&witness.kind==='recorded-candidate-producer-v1'&&
      witness.registeredManifestSha256===pin.manifestSha256&&witness.root===roots(config,layout).root)
    const files=manifest(witness.manifestRaw,selected);proof(witness.proofRaw,files)
    demand(sha(witness.proofRaw)===files.find(file=>file.path==='transfer/SHA256SUMS.json').sha256)
    const expected=objects(files)
    demand(Array.isArray(witness.objects)&&witness.objects.length===expected.length)
    for(let i=0;i<expected.length;i++) {
      const a=witness.objects[i],b=expected[i]
      demand(exact(a,b.kind==='file'?['role','kind','generation','size','sha256','security']:['role','kind','generation','security'])&&
        a.role===b.role&&a.kind===b.kind&&version(a.generation)&&securityValid(a.security))
      if(b.kind==='file')demand(a.sha256===b.sha256&&Number.isSafeInteger(a.size)&&a.size>=0&&(b.size===undefined?a.size===Buffer.byteLength(witness.manifestRaw):a.size===b.size))
    }
    return witness
  }
  async function capture(selected,config,layout) {
    let stage='paths'
    try {
      const r=roots(config,layout),paths=[],rows=[]
      stage='source_manifest'
      const external=await fileEvidence(path.join(r.parent,'candidate.json'),262144,{sha256:pin.manifestSha256,retain:true})
      const files=manifest(external.raw,selected)
      for(const [side,parent,root]of [['source',r.parent,r.root],['registered',r.registered,path.join(r.registered,'transfer')]]) {
        stage=side==='source'?'source_subtree':'registered_subtree'
        for(const [role,file]of [[side+':parent',parent],[side+':root',root]]) {
          rows.push({role,kind:'directory',...await directoryEvidence(file)});paths.push(file)
        }
        stage=side==='source'?'source_manifest':'registered_manifest'
        const receipt=await fileEvidence(path.join(parent,'candidate.json'),262144,{sha256:pin.manifestSha256,retain:true})
        demand(receipt.raw===external.raw);rows.push({role:side+':manifest',kind:'file',generation:receipt.generation,size:receipt.size,sha256:receipt.sha256});paths.push(path.join(parent,'candidate.json'))
        stage=side==='source'?'source_subtree':'registered_subtree'
        demand(JSON.stringify((await fs.readdir(root)).sort())===JSON.stringify(names))
        for(const name of names) {
          const file=path.join(root,name),entry=files.find(item=>item.path==='transfer/'+name)
          const value=await fileEvidence(file,entry.size,{...entry,retain:name==='SHA256SUMS.json'})
          if(name==='SHA256SUMS.json')proof(value.raw,files)
          rows.push({role:side+':'+name,kind:'file',generation:value.generation,size:value.size,sha256:value.sha256});paths.push(file)
        }
      }
      stage='security_envelope'
      const acl=await security(paths);demand(Array.isArray(acl)&&acl.length===paths.length&&acl.every(securityValid))
      stage='generation'
      for(let i=0;i<rows.length;i++){
        rows[i].security={ownerSid:acl[i].ownerSid,groupSid:acl[i].groupSid,descriptorSha256:acl[i].descriptorSha256}
        demand(stamp(await fs.lstat(paths[i],{bigint:true}))===rows[i].generation)
      }
      const proofFile=await fileEvidence(path.join(r.root,'SHA256SUMS.json'),65536,{retain:true})
      const proofRow=rows.find(row=>row.role==='source:SHA256SUMS.json')
      demand(proofFile.sha256===proofRow.sha256&&proofFile.generation===proofRow.generation)
      const witness={kind:'recorded-candidate-producer-v1',root:r.root,registeredManifestSha256:pin.manifestSha256,manifestRaw:external.raw,proofRaw:proofFile.raw,objects:rows}
      stage='archive'
      validate(witness,selected,config,layout)
      return witness
    } catch(error) {fail(error?.evidenceStage&&error.evidenceStage!=='validation'?error.evidenceStage:stage)}
  }
  return Object.freeze({capture,validate,async assert(witness,selected,config,layout){
    validate(witness,selected,config,layout)
    demand(JSON.stringify(await capture(selected,config,layout))===JSON.stringify(witness))
  }})
}
export const producerReferenceAdapter=createProducerReferenceAdapter()
