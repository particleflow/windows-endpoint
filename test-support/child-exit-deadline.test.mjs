import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('a settled foreground exit releases its deadline and lets the test process exit naturally', () => {
  const helper = new URL('./child-exit-deadline.mjs', import.meta.url).href
  for (const mode of ['exited', 'rejected', 'expired']) {
    const script = `
      import assert from 'node:assert/strict'
      import {childExitDeadline} from ${JSON.stringify(helper)}
      const mode = ${JSON.stringify(mode)}
      if (mode === 'exited') assert.equal(await childExitDeadline(Promise.resolve(0), 60000, 'deadline'), 0)
      if (mode === 'rejected') await assert.rejects(childExitDeadline(Promise.reject(Error('synthetic exit observation')), 60000, 'deadline'), /synthetic exit observation/)
      if (mode === 'expired') assert.equal(await childExitDeadline(new Promise(() => {}), 5, 'deadline'), 'deadline')
      assert.equal(process.getActiveResourcesInfo().includes('Timeout'), false)
      console.log(mode)
    `
    // A leaked 60-second deadline prevents natural exit and exceeds this bound;
    // no Windows, PowerShell, Agent, candidate build or field process is used.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 })
    assert.equal(result.error, undefined, `${mode}: child must exit without forced termination`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), mode)
  }
})
