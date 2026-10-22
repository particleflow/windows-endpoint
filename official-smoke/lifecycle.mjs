import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyToolchain } from '../endpoint.mjs'
import { EndpointLifecycle, NativeDriver, StateStore, acquireLeases, leaseKeys } from '../lifecycle.mjs'

assert.equal(process.platform, 'win32')
if (process.argv[2] === '--lease-child') {
  await acquireLeases([process.argv[3]], process.argv[4])
  process.stdout.write('leased\n')
} else {
  await verify(await fs.realpath(process.argv[2]))
}

async function verify(root) {
  const data = path.join(root, 'lifecycle-data')
  const config = { bundleRoot: root, sourceRoot: path.join(data, 'work'), herdrConfigRoot: path.join(data, 'config/herdr'), herdrStateRoot: path.join(data, 'state/herdr'), agenvoConfigDir: path.join(data, 'agenvo'), piConfigDir: path.join(data, 'pi'), session: 'lifecycle', deviceId: randomUUID() }
  const state = path.join(data, 'endpoint')
  for (const dir of [state, ...Object.values(config).filter(v => path.isAbsolute(v))]) await fs.mkdir(dir, { recursive: true })
  // Ephemeral synthetic TLS/registration fixture only. No system trust change,
  // TLS bypass, OAuth flow, existing configuration or real user credentials.
  const cert = path.join(data, 'fixture-cert.pem'), key = path.join(data, 'fixture-key.pem')
  let openssl
  for (const rel of ['git/usr/bin/openssl.exe', 'git/mingw64/bin/openssl.exe']) {
    try { await fs.access(path.join(root, rel)); openssl = path.join(root, rel); break } catch { /* next pinned artifact path */ }
  }
  assert.ok(openssl, 'Pinned Git fixture must include openssl')
  await fs.writeFile(path.join(data, 'empty-openssl.cnf'), '')
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, OPENSSL_CONF: path.join(data, 'empty-openssl.cnf') } })
  assert.equal(generated.status, 0, 'Ephemeral certificate generation failed')
  const { default: WebSocket } = await import(pathToFileURL(path.join(root, 'node_modules/ws/index.js')))
  const relay = https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol: 1, ownerConfigured: true })) })
  const sockets = new Set(), wss = new WebSocket.Server({ noServer: true })
  let rejectAuth = false, welcomes = 0
  relay.on('upgrade', (req, socket, head) => {
    if (rejectAuth) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws); ws.on('close', () => sockets.delete(ws))
      ws.on('message', raw => {
        if (raw.toString() === 'agenvo:ping') { ws.send('agenvo:pong'); return }
        const packet = JSON.parse(raw.toString())
        if (packet.type === 'hello') { welcomes++; ws.send(JSON.stringify({ v: 1, type: 'welcome' })) }
      })
    })
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const herdrFile = path.join(root, 'herdr/herdr.exe')
  const officialFiles = [path.join(config.herdrConfigRoot, 'config.toml'), path.join(config.agenvoConfigDir, 'config.json'), path.join(config.agenvoConfigDir, 'credentials.json')]
  await fs.writeFile(officialFiles[0], '[update]\nversion_check = false\nmanifest_check = false\n') // default interactive restoration retained
  await fs.writeFile(officialFiles[1], JSON.stringify({ schema: 1, relay: `https://127.0.0.1:${relay.address().port}`, deviceId: config.deviceId, name: 'isolated-ci', instances: [{ id: 'host', label: 'fixture', kind: 'herdr', binary: herdrFile, cwd: config.sourceRoot, configRoot: config.herdrConfigRoot }] }))
  await fs.writeFile(officialFiles[2], JSON.stringify({ secret: 'synthetic-test-only-'.repeat(4) }))
  const originals = await Promise.all(officialFiles.map(f => fs.readFile(f)))
  const driver = new NativeDriver(config, { inheritedEnvironment: { ...process.env, NODE_EXTRA_CA_CERTS: cert, PATH: 'unusable', NODE_PATH: 'unusable', NODE_OPTIONS: '--require=DO-NOT-LOAD', BASH_ENV: 'unusable', HERDR_SESSION: 'pollution', HERDR_SOCKET_PATH: 'pollution', AGENVO_CONFIG_DIR: 'pollution' }, qualify: async () => (await verifyToolchain(config, '2.51.0.windows.1')).every(c => c.state === 'passed') })
  const create = () => new EndpointLifecycle({ driver, store: new StateStore(state, config.deviceId), acquire: () => acquireLeases(leaseKeys(config), state), policy: { retryMs: 100 } })
  const lifecycle = create(), results = [], controller = new AbortController()
  let running, backgroundFailure
  const checked = name => {
    const result = { check: name, state: 'passed' }
    results.push(result)
    // Preserve completed evidence even if a later, independent boundary fails.
    process.stdout.write(`${JSON.stringify({ lifecycleCheck: result })}\n`)
  }
  async function until(predicate, message, timeout = 30000) {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (backgroundFailure) throw backgroundFailure; if (await predicate()) return; await delay(100) }
    throw new Error(`${message}: ${JSON.stringify(lifecycle.snapshot())}`)
  }
  // Observations do not drive recovery. Only the product's own run loop calls tick.
  async function observeUntil(predicate, message) { await until(() => !lifecycle.active && predicate(), message) }
  async function killOwned(component) {
    const child = driver.children.get(component)
    child.process.kill(); await child.done
  }
  try {
    await lifecycle.start()
    running = lifecycle.run(controller.signal).catch(error => { backgroundFailure = error })
    await observeUntil(() => lifecycle.snapshot().connection === 'online_snapshot', 'Official connector did not become online')
    assert.equal(lifecycle.snapshot().ready, false)
    checked('official_dependencies_ordered_start_with_clean_environment')
    await assert.rejects(create().start(), /endpoint_already_owned/)
    checked('second_coordinator_same_identity_rejected')

    const child = spawn(driver.node, [fileURLToPath(import.meta.url), '--lease-child', `${config.deviceId}:crash-lease`, state], { env: driver.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr.resume()
    await once(child.stdout, 'data')
    await assert.rejects(acquireLeases([`${config.deviceId}:crash-lease`], state), /endpoint_already_owned/)
    const exited = once(child, 'exit'); child.kill(); await exited
    const release = await acquireLeases([`${config.deviceId}:crash-lease`], state); await release()
    checked('windows_lifetime_lease_released_after_own_fixture_process_death')

    const pid = driver.children.get('connector').process.pid, previousWelcomes = welcomes
    for (const socket of sockets) socket.terminate()
    await observeUntil(() => welcomes > previousWelcomes && lifecycle.snapshot().connection === 'online_snapshot', 'Official network reconnect failed')
    assert.equal(driver.children.get('connector').process.pid, pid)
    assert.equal(lifecycle.state.restarts.length, 0)
    checked('network_reconnect_uses_official_connector_without_second_watchdog')

    await killOwned('connector')
    await observeUntil(() => driver.alive('connector') && lifecycle.snapshot().connection === 'online_snapshot', 'Connector process recovery failed')
    assert.notEqual(driver.children.get('connector').process.pid, pid)
    assert.equal(lifecycle.state.restarts.length, 1)
    checked('owned_connector_crash_recovers_via_official_stale_lock_action')

    // One ordinary shell command is a bounded side-effect fixture. This is not
    // an LLM/business/transfer acceptance test and does not fabricate Agent metadata.
    await fs.writeFile(path.join(config.sourceRoot, 'marker.cjs'), "require('node:fs').appendFileSync('executions.txt', 'once\\n')\n")
    const created = JSON.parse(driver.command(driver.herdr, ['--session', config.session, 'workspace', 'create', '--cwd', config.sourceRoot]))
    const pane = created.result.root_pane.pane_id
    driver.command(driver.herdr, ['--session', config.session, 'pane', 'run', pane, 'node marker.cjs'])
    await until(async () => { try { return await fs.readFile(path.join(config.sourceRoot, 'executions.txt'), 'utf8') === 'once\n' } catch { return false } }, 'Ordinary pane command failed')
    // Herdr 0.9.5 debounces session saves for FIVE seconds, then writes in the
    // background. A 1.5-second sleep killed the host before any durable snapshot
    // existed. Observe this isolated fixture's real snapshot; never fabricate it,
    // invoke graceful stop, or alter official restore settings to pass a crash test.
    const snapshotFile = path.join(config.herdrConfigRoot, 'sessions', config.session, 'session.json')
    const persistenceStarted = Date.now()
    await until(async () => {
      let snapshot
      try { snapshot = JSON.parse(await fs.readFile(snapshotFile, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
      assert.equal(snapshot.version, 3, 'Unexpected official persisted session schema')
      return snapshot.workspaces.some(workspace => workspace.id === created.result.workspace.workspace_id &&
        workspace.tabs.some(tab => Object.keys(tab.panes).length > 0))
    }, 'Official session snapshot did not persist the fixture workspace')
    process.stdout.write(`${JSON.stringify({ persistedFixtureObserved: true, elapsedMs: Date.now() - persistenceStarted })}\n`)
    await killOwned('herdr')
    await observeUntil(() => driver.alive('herdr') && lifecycle.state.restarts.length === 2 && lifecycle.snapshot().connection === 'online_snapshot', 'Herdr dependency recovery failed')
    await delay(2000)
    assert.equal(await fs.readFile(path.join(config.sourceRoot, 'executions.txt'), 'utf8'), 'once\n')
    const listed = JSON.parse(driver.command(driver.herdr, ['--session', config.session, 'pane', 'list']))
    assert.ok(listed.result.panes.length > 0, 'Persisted panes were not restored')
    assert.ok(listed.result.panes.some(restored => restored.pane_id === pane &&
      restored.workspace_id === created.result.workspace.workspace_id && !restored.restore_error),
    'The original fixture pane must restore without an error')
    checked('ordinary_pane_restored_without_replaying_shell_command')

    rejectAuth = true
    for (const socket of sockets) socket.terminate()
    await observeUntil(() => lifecycle.state.attention === 'connector_authentication_required', 'Authentication failure not classified')
    const authPid = driver.children.get('connector').process.pid
    await delay(1200)
    assert.equal(driver.children.get('connector').process.pid, authPid)
    assert.equal(lifecycle.state.restarts.length, 2)
    checked('real_401_requires_attention_without_process_restart')
    controller.abort(); await running
    if (backgroundFailure) throw backgroundFailure
    const stopped = lifecycle.snapshot()
    assert.equal(stopped.phase, 'stopped'); assert.equal(driver.hostStatus().running, false)
    assert.equal(driver.alive('connector'), false)
    for (let i = 0; i < officialFiles.length; i++) assert.deepEqual(await fs.readFile(officialFiles[i]), originals[i])
    checked('owned_components_stopped_and_official_config_credentials_preserved')
    await verifyOwnership(config, driver.env, checked)
    process.stdout.write(`${JSON.stringify({ lifecycleSmoke: results, transferAutomaticRecovery: false, agentBusinessReplay: 'not_tested', customOrOldAgentResume: 'unverified', lockedDesktop: 'not_tested', loggedOut: 'no_autostart', physicalPowerLoss: 'not_tested', gui: 'not_tested' }, null, 2)}\n`)
  } finally {
    controller.abort(); await running
    if (lifecycle.release) await lifecycle.stop()
    for (const c of driver.children.values()) if (!c.exited) c.process.kill()
    for (const socket of sockets) socket.terminate()
    wss.close(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve))
  }
}


async function verifyOwnership(config, env, checked) {
  const ownedConfig = { ...config, session: 'ownership' }
  const driver = new NativeDriver(ownedConfig, { inheritedEnvironment: env })
  const outsiderSession = 'outside-coordinator'
  let outsider, handoffCreated = false
  const status = session => JSON.parse(driver.command(driver.herdr, ['--session', session, 'status', 'server', '--json']))
  async function wait(predicate) {
    const end = Date.now() + 30000
    while (Date.now() < end) { if (await predicate()) return; await delay(100) }
    throw new Error('Ownership fixture readiness timeout')
  }
  try {
    await driver.start('herdr'); await driver.waitReady('herdr')
    const owned = driver.children.get('herdr'), marker = driver.marker
    outsider = spawn(driver.herdr, ['--session', outsiderSession, 'server'], { env: driver.env, cwd: config.sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    outsider.stdout.resume(); outsider.stderr.resume()
    await wait(() => status(outsiderSession).running)
    const outsiderMarker = path.join(config.herdrConfigRoot, 'sessions', outsiderSession, 'herdr.sock')
    const outsiderGeneration = await fs.readFile(outsiderMarker, 'utf8')
    // Exercise the actual Windows peer-PID query, not only a forged marker check.
    const helper = fileURLToPath(new URL('../owned-herdr.ps1', import.meta.url))
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    await assert.rejects(promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-MarkerPath', outsiderMarker, '-Generation', outsiderGeneration, '-OwnerProcessId', String(owned.process.pid), '-Action', 'server.stop'], { env: driver.env, timeout: 20000, maxBuffer: 16384 }), error => JSON.parse(error.stdout).error === 'herdr_owner_mismatch')
    assert.equal(status(outsiderSession).running, true)
    // Simulate a changed endpoint mapping while the original owned child is alive.
    driver.marker = outsiderMarker
    await assert.rejects(driver.stop('herdr'), /herdr_owner_mismatch/)
    assert.equal(status(outsiderSession).running, true)
    driver.marker = marker
    checked('foreign_endpoint_peer_rejected_without_stopping_either_server')

    driver.command(driver.herdr, ['--session', ownedConfig.session, 'workspace', 'create', '--cwd', config.sourceRoot])
    driver.command(driver.herdr, ['--session', ownedConfig.session, 'server', 'live-handoff', '--import-exe', driver.herdr, '--expected-version', '0.9.5'], 30000)
    handoffCreated = true
    await wait(() => owned.exited)
    await wait(() => status(ownedConfig.session).running)
    assert.notEqual(await fs.readFile(marker, 'utf8'), owned.generation)
    await driver.stop('herdr') // exited owned handle: must not send stop to its successor
    assert.equal(status(ownedConfig.session).running, true)
    await assert.rejects(driver.start('herdr'), /existing_herdr_requires_handoff/)
    assert.equal(status(ownedConfig.session).running, true)
    checked('official_live_handoff_successor_is_neither_adopted_restarted_nor_stopped')
  } finally {
    // Fixture-only cleanup of explicitly created isolated sessions. The product
    // driver above is deliberately forbidden from adopting the handoff successor.
    if (handoffCreated && status(ownedConfig.session).running) driver.command(driver.herdr, ['--session', ownedConfig.session, 'server', 'stop'], 20000)
    else if (driver.alive('herdr')) await driver.stop('herdr')
    if (outsider && outsider.exitCode === null) {
      const exited = once(outsider, 'exit')
      driver.command(driver.herdr, ['--session', outsiderSession, 'server', 'stop'], 20000)
      await exited
    }
  }
}
