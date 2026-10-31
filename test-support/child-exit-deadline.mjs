// Test-process deadline: settling the exit promise must also release its timer.
export async function childExitDeadline(exit, milliseconds, expired) {
  let timer
  try {
    return await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, milliseconds, expired) })])
  } finally {
    clearTimeout(timer)
  }
}
