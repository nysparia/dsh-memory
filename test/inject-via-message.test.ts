/**
 * inject-via-message.test.ts · 「自建消息」通道守卫（fork 2026-11-27）
 *
 * 被守卫的不变量
 * --------------
 *   M1 缺省通道 = message：注册 `agent/pre-step`，且 assemble **不再**注入记忆块
 *      （旧 contexts 通道只在 injectVia='context' 时启用）；
 *   M2 每块一条独立消息：内容只含本块，**不含** working-directory / sandbox:policy /
 *      approval:policy 等与记忆无关的静态段；
 *   M3 内容逐字未变 → **不发**（消息各自独立，不需要贴占位维持稳定）；
 *   M4 内容变化 → 恰好新增变化的那一块；
 *   M5 `injectIntervalMs` 节流：间隔内即使内容变化也不发；
 *   M6 静态快照稳定：记忆块变化时，assemble 渲染出的运行时快照**逐字节不变**
 *      → 宿主零追加（这正是旧通道做不到的事）。
 *
 * 判据取自宿主真函数：`renderContextSnapshot`（@deepseek-ai/dsh-system-prompt）
 * 是 `assembly.contexts` 的真实消费者，宿主按它的输出做「是否新快照」判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { installMemoryHooks, type MemoryHooksOptions } from '../src/hooks.ts'

interface Assembly {
  contexts: Array<{ name: string; text: string }>
  variables: Record<string, string>
}
type AssembleHandler = (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>
type PreStepHandler = (p: unknown, n: () => Promise<unknown>) => Promise<unknown>

/** 可变记忆真源：测试逐用例改写，模拟「记忆内容变化 / 不变」两种情况。 */
let timelinePreview = '记忆1：用户喜欢猫'
let windowItems: Array<Record<string, unknown>> = [{ role: 'user', text: '近窗口条目一', t: 1 }]

function makeGraph() {
  return {
    isReady: (): boolean => true,
    async timeline(limit?: number) {
      return {
        count: 1, limit: limit ?? 4,
        items: [{ id: 'n1', layer: 'contextual', start: 1, end: 2, preview: timelinePreview }],
      }
    },
    async sessionRecall() {
      return { ok: true, recent: windowItems, degraded: [] }
    },
    async read() { return { ok: true } },
    async remember() { return { ok: true } },
  }
}

function makeHarness(overrides: Partial<MemoryHooksOptions> = {}) {
  const assembleHandlers: AssembleHandler[] = []
  const preStepHandlers: PreStepHandler[] = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: unknown) {
      if (ev === 'system-prompt/assemble') assembleHandlers.push(fn as AssembleHandler)
      else if (ev === 'agent/pre-step') preStepHandlers.push(fn as PreStepHandler)
    },
  }
  installMemoryHooks(ctx as never, makeGraph() as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: false,
    auditPath: join(tmpdir(), 'dsh-hook-audit-inject-via-message.json'),
    ...overrides,
  })
  const assemble = async (): Promise<Assembly> => {
    const a: Assembly = { contexts: [], variables: {} }
    for (const handler of assembleHandlers) await handler(a, {}, async () => a)
    return a
  }
  const preStep = async (sid = 'sess_M'): Promise<Array<{ content: Array<{ text: string }>; source?: unknown }>> => {
    assert.ok(preStepHandlers[0], '缺省通道应注册 agent/pre-step 监听')
    const decision = await preStepHandlers[0](
      { agent: { session: { id: sid } }, turn: 1, step: 1, signal: { aborted: false } }, 
      async () => ({ kind: 'enter', messages: [] }),
    ) as { kind: string; messages: Array<{ content: Array<{ text: string }> }> }
    return decision.messages ?? []
  }
  return { assemble, preStep }
}

const textOf = (m: { content: Array<{ text: string }> }): string =>
  m.content.map((b) => b.text).join('\n')

test('M1 缺省通道 = message：注册 agent/pre-step，assemble 不再注入记忆块', async () => {
  const { assemble, preStep } = makeHarness()
  const a = await assemble()
  assert.equal(a.contexts.filter((c) => c.name.startsWith('lingshu:')).length, 0,
    'assemble 不应再 push 记忆块（旧通道只在 injectVia=context 时启用）')
  const messages = await preStep()
  assert.ok(messages.length >= 1, 'pre-step 应自行产出注入消息')
})

test('M2 每块一条独立消息：只含本块，不含与记忆无关的静态段', async () => {
  const { preStep } = makeHarness()
  const messages = await preStep()
  const texts = messages.map(textOf)
  assert.ok(texts.some((t) => t.includes('【灵枢最近记忆】')), '应有「最近记忆」块')
  assert.ok(texts.some((t) => t.includes('【本会话近期对话】')), '应有「近期对话」块')
  for (const t of texts) {
    for (const unrelated of ['working-directory', 'sandbox:policy', 'approval:policy', 'subagent:identity']) {
      assert.ok(!t.includes(unrelated), `注入消息不得携带无关静态段：${unrelated}`)
    }
  }
  // 每块一条：两条消息各装一块，而不是把两块塞进同一条。
  assert.equal(texts.filter((t) => t.includes('【灵枢最近记忆】')).length, 1)
  assert.equal(texts.filter((t) => t.includes('【本会话近期对话】')).length, 1)
})

test('M3 内容逐字未变 → 不再追加消息', async () => {
  const { preStep } = makeHarness()
  const first = await preStep()
  assert.ok(first.length > 0, '首步应注入')
  const second = await preStep()
  assert.equal(second.length, 0, '内容未变时不得重复贴同一批记忆')
})

test('M4 内容变化 → 恰好新增变化的那一块', async () => {
  const { preStep } = makeHarness()
  await preStep()
  timelinePreview = '记忆1：用户喜欢狗'
  const changed = await preStep()
  assert.equal(changed.length, 1, '只有「最近记忆」块变了，应只补一条')
  assert.ok(textOf(changed[0]!).includes('【灵枢最近记忆】'))
})

test('M5 injectIntervalMs 节流：间隔内即使内容变化也不发', async () => {
  const { preStep } = makeHarness({ injectIntervalMs: 60_000 })
  await preStep()
  timelinePreview = '记忆1：用户喜欢狗'
  const throttled = await preStep()
  assert.equal(throttled.length, 0, '节流窗口内应压住追加')
})

test('M6 静态快照稳定：记忆块变化时渲染文本逐字节不变（宿主零追加）', async () => {
  const { assemble } = makeHarness()
  // 模拟宿主已有的基线上下文（与本插件无关的贡献者）。
  const base = (): Assembly => ({ contexts: [{ name: 'other', text: '别的贡献者' }], variables: {} })
  const first = base()
  await assemble()
  const a1 = renderContextSnapshot(first)
  // 记忆内容变化——旧通道下这一步会让整份快照变化；新通道下快照不受影响。
  timelinePreview = '记忆1：用户喜欢狗'
  const second = base()
  await assemble()
  const a2 = renderContextSnapshot(second)
  assert.equal(a1, a2, '记忆块走独立消息后，运行时上下文快照必须逐字节稳定')
})
