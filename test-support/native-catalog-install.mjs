import * as fs from 'node:fs/promises'
import path from 'node:path'
import { nativeInstalledFixture } from './installed-fixture.mjs'
import { programPackage } from './program-package.mjs'
import { programDeployment,programDeploymentMain } from '../program-deployment.mjs'
import { digest } from '../endpoint.mjs'

export async function nativeCatalogInstall(t,{piPackage=null,extensions=[],configurePackage=null}={}) {
  const f=await nativeInstalledFixture(t),root=path.join(f.base,'endpoint')
  if(piPackage){f.config.programs.piPackage=await fs.realpath(piPackage);f.config.programs.node=await fs.realpath(process.execPath)}
  await fs.mkdir(path.join(root,'config'),{recursive:true})
  const configurationRaw=JSON.stringify(f.config)
  await fs.writeFile(path.join(root,'config/endpoint.json'),configurationRaw)
  const pkg=await programPackage(path.join(f.base,'review package'),'native-catalog',{native:true})
  if(configurePackage){
    await configurePackage({pkg,f})
    const names=(await fs.readdir(pkg.directory,{recursive:true,withFileTypes:true})).filter(v=>v.isFile()).map(v=>path.relative(pkg.directory,path.join(v.parentPath,v.name)).split(path.sep).join('/')).filter(v=>v!=='candidate.json')
    pkg.manifest.files=[]
    for(const name of names){const file=path.join(pkg.directory,name);pkg.manifest.files.push({path:name,size:(await fs.stat(file)).size,sha256:await digest(file)})}
    await fs.writeFile(path.join(pkg.directory,'candidate.json'),JSON.stringify(pkg.manifest));pkg.hash=await digest(path.join(pkg.directory,'candidate.json'))
  }
  await programDeployment(root,{prepare:true})
  await programDeploymentMain(['install','--root',root,'--source',pkg.directory,'--manifest-sha256',pkg.hash])
  const manager=await programDeployment(root)
  const settingsRaw='\uFEFF'+JSON.stringify({extensions,packages:[],defaultProvider:'approved',defaultModel:'selected',custom:{keep:true}},null,3)+'\n'
  const modelsRaw='\uFEFF'+JSON.stringify({providers:{approved:{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'$UNSET_NATIVE_REFERENCE',models:[{id:'selected',contextWindow:4096,maxTokens:512,reasoning:false,input:['text']}],modelOverrides:{selected:{maxTokens:333}}}}})
  await fs.writeFile(path.join(f.config.piConfigDir,'settings.json'),settingsRaw)
  await fs.writeFile(path.join(f.config.piConfigDir,'models.json'),modelsRaw)
  return {...f,root,pkg,manager,configurationRaw,settingsRaw,modelsRaw}
}
