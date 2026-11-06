// Explicit inert component, not Herdr/Agenvo. Only its owning fixture can use
// this inherited IPC channel. It never accepts network or arbitrary commands.
const timer = setInterval(() => {}, 1000)
// Fixture containment only. NativeDriver/official children have no matching
// guarantee; this must not be cited as real orphan-process cleanup evidence.
process.on('disconnect', () => { clearInterval(timer); process.exit(0) })
process.on('message', message => {
  if (message.action === 'stop') { clearInterval(timer); process.exit(0) }
  if (message.action === 'crash') process.exit(7)
  if (message.action === 'auth_failure') process.send({ state: 'needs_attention', lastError: 'handshake_401' })
})
process.send({ state: 'online', lastError: '' })
