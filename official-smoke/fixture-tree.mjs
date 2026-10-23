// Disposable CI containment probe. Not an official component or business task.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
child.once('spawn', () => writeFileSync(process.argv[2], 'owned-child-created'))
setInterval(() => {}, 1000)
