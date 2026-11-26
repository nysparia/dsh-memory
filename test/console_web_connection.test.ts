/**
 * console_web_connection.test.ts · #699 守卫：宿主鉴权服务**后到**时必须自愈
 *
 * 病灶（#699，imFelixYang 在 DSH 0.2.1-rc.3 实测）：`createConsoleHandler(...)` 在**挂载时**
 * 取一次 `ctx.get('connection')`，而 cordis 的 `Context.get(name, strict=true)` 在服务 fiber
 * 未就绪时返回 undefined；空值被闭包固化 ⇒ 此后每个请求都命中 503「宿主鉴权不可用」，
 * 宿主就绪也不自愈（连静态资源都 503）。
 *
 * 修法：第 4 参改为**取值函数**，handler 每次请求实时取（非函数则包成常量，向后兼容）。
 *
 * 钉住：
 *   A 连接此刻不存在 ⇒ 503，且文案是「尚未就绪」（可重试语义）
 *   B **连接随后就绪 ⇒ 同一 handler 立刻 200（自愈）** — 正是病灶点
 *   C 传值（旧调用方式）仍按常量处理（向后兼容）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore —— console_web.mjs 是 build_ui 铺出的产物（JS，无类型声明）；本测试面向其运行时行为
import { createConsoleHandler, installConsoleWeb } from '../lib/lib/console_web.mjs'

type FakeRes = { out: { status: number; body: string }; setHeader: (k: string, v: string) => void; writeHead: (c: number) => void; end: (c?: unknown) => void }

const ASSETS: Record<string, [string, string]> = {
  "/lingshu": ["<html>ok</html>", "text/html; charset=utf-8"],
}

function fakeRes(): FakeRes {
  const out = { status: 0, body: "" }
  return {
    out,
    setHeader() {},
    writeHead(code: number) { out.status = code },
    end(chunk?: unknown) { if (chunk) out.body += String(chunk) },
  }
}

const OK_ADMIT = { admit: () => ({ ok: true }) }

test("A 连接此刻不存在 ⇒ 503 且文案是「尚未就绪」（可重试语义）", async () => {
  let conn: unknown
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => conn)
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 503)
  assert.ok(res.out.body.includes("尚未就绪"), "文案应表达可重试：" + res.out.body)
})

test("B **连接随后就绪 ⇒ 同一 handler 立刻 200（自愈）**", async () => {
  let conn: unknown                // 挂载时确实拿不到（模拟 fiber 未就绪）
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => conn)
  const r1 = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, r1)
  assert.equal(r1.out.status, 503, "第一次请求应 503（尚未就绪）")
  conn = OK_ADMIT                 // ← 服务就绪（rc.3 上的真实时序）
  const r2 = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, r2)
  assert.equal(r2.out.status, 200, "服务就绪后必须自愈，不得恒 503（#699 病灶）")
  assert.equal(r2.out.body, "<html>ok</html>")
})

test("D 服务根本没注入 ⇒ reason=not_injected（第二层诊断）", async () => {
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => undefined,
    () => ({ ready: false, any: false }))
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 503)
  assert.ok(res.out.body.includes("not_injected"), "应区分「没注入」：" + res.out.body)
})

test("F 服务存在但不提供 admit ⇒ reason=not_admit（服务名撞车/版本不兼容的指纹）", async () => {
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => ({}))
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 503)
  assert.ok(res.out.body.includes("not_admit"), "应识别第三态：" + res.out.body)
})

test("G 探针异常 ⇒ reason=probe_failed（不默认退回 not_ready）", async () => {
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => undefined, () => { throw new Error("probe boom") })
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 503)
  assert.ok(res.out.body.includes("probe_failed"), "诊断失败必须可观测：" + res.out.body)
})

test("A′ 旧调用（4 参）503 的 reason 保守落 not_ready", async () => {
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => undefined)
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 503)
  assert.ok(res.out.body.includes("not_ready"), "缺省 probe 时不得误报：" + res.out.body)
})

test("E 已注册但未就绪 ⇒ reason=not_ready（可重试）", async () => {
  const h = (createConsoleHandler as any)({}, {}, ASSETS, () => undefined,
    () => ({ ready: false, any: true }))
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 503)
  assert.ok(res.out.body.includes("not_ready"), "应区分「未就绪」：" + res.out.body)
})

test("C 旧调用方式（直接传值）仍按常量处理——向后兼容", async () => {
  const h = (createConsoleHandler as any)({}, {}, ASSETS, OK_ADMIT)
  const res = fakeRes()
  await h({ url: "/lingshu", method: "GET", headers: {} }, res)
  assert.equal(res.out.status, 200, "传值时应立即可用（与旧版一致）")
})

/**
 * H 组 · DSH 0.2.3 的 `connection.authentication` 病灶（commit 71753fdf91）
 *
 * 病灶：HostConnectionService.admit() 内部读 `this.authentication`，cordis 的 traceable 代理
 * 把这次读取解析成「**调用方** ctx 上的 connection.authentication」⇒ 只 inject=['tools'] 的
 * 插件调用 admit() 即抛 `cannot get property "connection.authentication" without inject`，
 * /plugins/lingshu/* 全部 500，面板首屏即失败。
 *
 * 钉住：① 面板路由的 connection 必须取自**注入了 connection.authentication 的子作用域**；
 *      ② 老宿主没有 ctx.inject ⇒ 退回原 ctx，且仍然 fail-closed（不得静默放行）；
 *      ③ 依赖永不就绪（inject 回调不触发）⇒ 同样 fail-closed，不因为"注入了"就放行。
 */
const INJECT_ERROR = 'cannot get property "connection.authentication" without inject'
const FAKE_MDCG = { isReady: () => true, bridge: { listTools: async () => [] } }

type Response = ReturnType<typeof fakeRes>

function fakeHost(opts: { baseAdmit: () => unknown; scopeAdmit?: () => unknown; inject?: boolean; injectFires?: boolean }) {
  const state = { injected: [] as string[][], baseCalls: 0 as number, scopeCalls: 0 as number }
  const routes: any[] = []
  const web = {
    register(route: any) { routes.push(route); return () => {} },
    tapIndex() { return () => {} },
  }
  const base = {
    logger: { info() {}, warn() {} },
    get(name: string) { return name === 'webServer' ? web : undefined },
  }
  const scope = {
    logger: base.logger,
    get(name: string) {
      if (name !== 'connection') return undefined
      return {
        admit: () => { state.scopeCalls += 1; return opts.scopeAdmit ? opts.scopeAdmit() : { peer: {} } },
      }
    },
  }
  const baseCtx: any = {
    ...base,
    get(name: string) {
      if (name === 'webServer') return web
      if (name === 'connection') return { admit: () => { state.baseCalls += 1; return opts.baseAdmit() } }
      return undefined
    },
  }
  if (opts.inject !== false) {
    baseCtx.inject = (deps: string[], cb: (s: any) => void) => {
      state.injected.push([...deps])
      if (opts.injectFires !== false) cb(scope)
      const disposeScope: any = () => { state.scopeCalls = -1 }
      disposeScope.kind = 'scope-disposer'
      return disposeScope
    }
  }
  return { ctx: baseCtx, state, routes }
}

const runPanel = async (res: Response, routes: any[]) => {
  const route = routes.find(r => r.path === '/plugins/lingshu')
  assert.ok(route, '应注册 /plugins/lingshu 前缀路由')
  await route.handler({ url: '/plugins/lingshu/meta', method: 'GET', headers: {} }, res)
}

test("H 面板取 connection 必须走已注入 connection.authentication 的子作用域（71753fdf91 病灶）", async () => {
  const { ctx, state, routes } = fakeHost({
    baseAdmit: () => { throw new Error(INJECT_ERROR) },
    scopeAdmit: () => ({ peer: {} }),
  })
  const disposers: any[] = []
  ;(installConsoleWeb as any)(ctx, {}, disposers, FAKE_MDCG)
  assert.deepEqual(state.injected[0], ['connection', 'connection.authentication'], '注入的服务名必须精确')
  assert.ok(disposers.some(d => d?.kind === 'scope-disposer'), '子作用域 disposer 必须交给 disposers，随插件卸载释放')

  const res = fakeRes()
  await runPanel(res, routes)
  assert.equal(res.out.status, 200, '请求不得再撞 without inject：' + res.out.body)
  assert.equal(state.baseCalls, 0, '不得再用未注入的 ctx 取 connection')
  assert.equal(state.scopeCalls, 1, '必须用注入作用域的 connection')
  assert.ok(res.out.body.includes('csrf'), 'meta 回执应含 csrf：' + res.out.body.slice(0, 120))
})

test("H′ 老宿主没有 ctx.inject ⇒ 退回原 ctx，且仍 fail-closed（不静默放行）", async () => {
  const { ctx, state, routes } = fakeHost({ inject: false, baseAdmit: () => { throw new Error(INJECT_ERROR) } })
  const disposers: any[] = []
  ;(installConsoleWeb as any)(ctx, {}, disposers, FAKE_MDCG)
  assert.deepEqual(state.injected, [], '老宿主上不得凭空注入')

  const res = fakeRes()
  await runPanel(res, routes)
  assert.equal(res.out.status, 500, '鉴权不可用必须拒，不得 200：' + res.out.body)
  assert.ok(res.out.body.includes('connection.authentication'), '错误原因应如实透出：' + res.out.body)
})

test("H″ 依赖永不就绪（inject 回调不触发）⇒ 同样 fail-closed，不因声明了注入就放行", async () => {
  const { ctx, state, routes } = fakeHost({ injectFires: false, baseAdmit: () => { throw new Error(INJECT_ERROR) } })
  ;(installConsoleWeb as any)(ctx, {}, [], FAKE_MDCG)
  const res = fakeRes()
  await runPanel(res, routes)
  assert.equal(res.out.status, 500, '回调没触发就仍是未注入上下文：' + res.out.body)
  assert.equal(state.scopeCalls, 0, '作用域未就绪时不得被当作可用')
})