import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

if (process.platform !== 'win32') process.exit(0)

const root = resolve(import.meta.dirname, '../../..')
const helperPath = resolve(root, 'dist-native/AIPIInterceptor.exe')
// 설치된 이전 버전의 helper가 실행 중이어도 테스트 이벤트를 가로채지 못하도록
// 운영 helper가 아직 모르는 전용 프로세스 이름을 사용한다.
const targetPath = resolve(root, 'dist-native/AIPIBypassTest.exe')

async function runScenario(mode, { blocked, trigger = mode, shortcut = 'ctrl-enter' }) {
  const helper = spawn(helperPath, ['--debug', `--bypass-shortcut=${shortcut}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  helper.stdout.setEncoding('utf8')
  helper.stderr.setEncoding('utf8')
  let captures = ''
  let helperErrors = ''
  helper.stdout.on('data', (chunk) => { captures += chunk })
  helper.stderr.on('data', (chunk) => { helperErrors += chunk })

  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Interceptor ready timeout')), 3000)
    helper.stderr.on('data', (chunk) => {
      if (String(chunk).includes('ready')) { clearTimeout(timeout); resolveReady() }
    })
    helper.on('exit', (code) => reject(new Error(`Interceptor exited before ready: ${code}`)))
  })

  const target = spawn(targetPath, [mode], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  let targetOutput = ''
  target.stdout.setEncoding('utf8')
  target.stdout.on('data', (chunk) => { targetOutput += chunk })
  const exitCode = await new Promise((resolveExit) => target.on('exit', resolveExit))
  await new Promise((resolveDrain) => setTimeout(resolveDrain, 250))
  helper.kill()

  const expectedOutput = blocked ? 'blocked' : 'submitted'
  const expectedExitCode = blocked ? 0 : 5
  if (exitCode !== expectedExitCode || !targetOutput.includes(expectedOutput)) {
    throw new Error(`${mode}: expected ${expectedOutput} (${exitCode}, ${targetOutput.trim()}; captures=${captures.trim()}; ${helperErrors.trim()})`)
  }
  const event = captures.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
    .find((value) => value.type === 'capture' && value.trigger === trigger)
  if (blocked && (!event || event.target !== 'test' || event.source !== '테스트 앱' || !/^\d+$/.test(event.window)
    || !event.prompt.includes(trigger === 'click' ? '클릭' : '엔터'))) {
    throw new Error(`${mode}: capture event missing (${captures.trim()}; ${helperErrors.trim()})`)
  }
  if (!blocked && event) throw new Error(`${mode}: unexpected capture (${captures.trim()})`)
}

await runScenario('enter', { blocked: true })
await runScenario('click', { blocked: true })
await runScenario('double-enter', { blocked: false, trigger: 'enter' })
await runScenario('double-click', { blocked: false, trigger: 'click' })
await runScenario('ctrl-enter', { blocked: false, trigger: 'enter' })
await runScenario('alt-enter', { blocked: false, trigger: 'enter', shortcut: 'alt-enter' })
console.log('Native interceptor integration: single intercept, double-send bypass, shortcut bypass PASS')
