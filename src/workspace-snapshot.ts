/**
 * 工作区快照。
 *
 * 为什么需要：`eval_run_dual` 先跑 baseline 再跑 candidate，**两次跑在同一个工作区上**。
 * 只在整趟跑完后拍一次快照，看到的是 candidate 的结果 —— "baseline 做对了没有"就只能
 * 靠步数推断。推断不是证据。所以要在 baseline 跑完、candidate 还没开始时再拍一次。
 *
 * 快照放在系统临时目录下（不是仓库里）：它们是**观测产物**，不是源码，
 * 不该进 git，也不该因为一次评测就把仓库撑大。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一份工作区快照的存放位置。 */
export interface WorkspaceSnapshots {
  /** baseline 跑完、candidate 未开始时的快照；工作区不存在时为 undefined。 */
  afterBaseline?: string
  /** candidate 跑完后的快照；工作区不存在时为 undefined。 */
  afterCandidate?: string
}

/**
 * 为一次评测分配快照根目录。
 *
 * 带时间戳，所以连跑多次不会互相覆盖 —— 波动测试正需要对比多次运行的产物。
 *
 * @param suite - 套件名（如 `multi-step/05-failure-report`），会做文件名转义。
 * @param at - 用于生成时间戳的时刻，默认当前时间。
 */
export function snapshotRoot(suite: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const safe = suite.replace(/[/\\]/g, '_').replace(/[^\w.-]/g, '')
  return join(tmpdir(), 'dsh-agent-eval-snapshots', `${safe}-${stamp}`)
}

/**
 * 把工作区整体复制一份到 `root/label`。
 *
 * @returns 快照路径；工作区不存在时返回 undefined（**不抛异常** —— 快照是观测的
 *   辅助手段，不该因为它缺失就让整趟评测失败）。
 */
export function snapshotWorkspace(
  workspace: string,
  root: string,
  label: string
): string | undefined {
  if (!existsSync(workspace)) return undefined
  const dest = join(root, label)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(workspace, dest, { recursive: true })
  return dest
}
