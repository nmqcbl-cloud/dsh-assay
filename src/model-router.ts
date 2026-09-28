import { dump } from 'js-yaml'

/** 一个后端的配置，对应 suite YAML `backends.<baseline|candidate>` 一节。 */
export interface BackendConfig {
  /** 后端 id，同时用作 pi-ai 的 provider 路由名。 */
  id: string
  /** 路由端点。 */
  baseUrl: string
  /** 模型 id。 */
  model: string
  /**
   * **环境变量名，不是密钥本身。**
   * 密钥只在运行时通过该环境变量注入子进程，永远不写进 patch 文件。
   */
  apiKeyEnv: string
  /** 报告里显示的列名；省略时用 id。 */
  displayName?: string
}

export interface DualBackendConfig {
  baseline: BackendConfig
  candidate: BackendConfig
  runMode: 'sequential' | 'parallel'
}

/**
 * 生成驱动一个后端的 pi-ai patch YAML。
 *
 * ## 为什么是 patch 文件而不是环境变量
 *
 * 原实现走 `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 等变量，这条路在 dsh 上是
 * **静默失效**的：dsh 的 pi-ai anthropic provider 把 `baseURL` 写死成
 * `https://api.anthropic.com`，且不读任何 `ANTHROPIC_*_BASE_URL`；`ANTHROPIC_MODEL`
 * 更是全无引用。五个变量里只有 `ANTHROPIC_AUTH_TOKEN` 有作用，而它也只能给
 * 真正的 api.anthropic.com 鉴权。
 *
 * dsh 支持的机制是**声明式路由**（`@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 配置），
 * 其中 `apiKeyEnv` 是「变量名」而非密钥，所以密钥依然纯走环境变量，不落盘。
 *
 * 两个必填行：
 *   - `llm-pi-ai`：声明本后端的路由。该行在 dsh-base 里默认空挂载（零路由），
 *     这里整体替换其 `config`（patch 是整体替换，不是深合并）。
 *   - `agent-default-model`：headless 创建新 agent 时读它拿 `{provider, model}`，
 *     不设的话会落到 deepseek 原生默认值，patch 里的路由就不会被用上。
 *
 * @param cfg - 后端配置。
 * @returns 可直接写入 `--patch` 文件的 YAML 文本。
 */
export function buildPatchConfig(cfg: BackendConfig): string {
  const patch = [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [cfg.id]: {
            displayName: cfg.displayName ?? cfg.id,
            api: 'anthropic-messages',
            baseURL: cfg.baseUrl,
            // 变量名，不是密钥。真正的密钥在 spawn 时注入子进程环境。
            apiKeyEnv: cfg.apiKeyEnv,
            models: [{ id: cfg.model }],
          },
        },
      },
    },
    {
      id: 'agent-default-model',
      config: {
        provider: cfg.id,
        model: cfg.model,
      },
    },
  ]

  // lineWidth: -1 关掉折行：baseURL 被折断会让 patch 难读，也更难排查。
  return dump(patch, { lineWidth: -1 })
}
