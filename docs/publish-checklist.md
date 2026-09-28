# 发布清单 / Publish Checklist

给**执行发布的人**看的操作手册。按顺序做，每步都有验证。

> **发布前必读**：本清单**不包含**密钥轮换与账号操作 —— 那两项由你人工完成。
> 清单只覆盖"把已经准备好的包推出去"这一段。

---

## 零、发布前：两个占位符必须先替换

`package.json` 的 `repository.url` 与 `CHANGELOG.md` 的链接**已经填好**
（`https://github.com/nmqcbl-cloud/dsh-assay`）。剩下 **2 处**：

```bash
# 1. 查看还有哪些占位符没填
grep -rn "REPLACE_WITH" package.json LICENSE CHANGELOG.md README.md
```

| 文件 | 占位符 | 替换成 |
|---|---|---|
| `LICENSE` | `REPLACE_WITH_COPYRIGHT_HOLDER` | 你希望署名的名字（个人名或组织名） |

替换后确认清空：

```bash
grep -rn "REPLACE_WITH" package.json LICENSE CHANGELOG.md README.md   # 应无输出
```

> ⚠️ **两个名字是有意分开的**：npm 包名 = `dsh-migration-eval`，GitHub 仓库名 = `dsh-assay`。
> 改任何一个，都要同步改：`package.json` 的 `name` / `repository.url`、
> `cordis.patch.yml` 的 `name`、README 的安装命令、本清单的下文。

---

## 一、npm 包名（已定：`dsh-migration-eval`）

已核实（2026-09-29，直连 `registry.npmjs.org`）：

| 名字 | 状态 |
|---|---|
| `dsh-agent-eval` | ❌ 被占（`dmso`，2026-08-14） |
| `dsh-assay` | ❌ 被占（`dushaobindoudou`，2026-09-18，占位包） |
| **`dsh-migration-eval`** | ✅ **空着，本包采用** |

**发布前再确认一次**（名字可能被别人抢发）：

```bash
npm view dsh-migration-eval --registry=https://registry.npmjs.org 2>&1
# "404 Not Found" → 可以用，继续
# 返回了包信息   → 被占了，二选一：
#   ① 换别的名字
#   ② 加 scope：@<你的用户名>/dsh-migration-eval
```

> ⚠️ **必须加 `--registry=https://registry.npmjs.org`。** 本机 npm 默认 registry 是
> `registry.npmmirror.com`（淘宝镜像）—— 那是**只读镜像，不能发布**，查询结果也可能滞后。
> 发布前请显式确认一次：`npm config get registry`。

**若改用 scope（`@用户名/...`）**，`package.json` 必须补一行，否则发布失败或发成私有：

```json
"publishConfig": { "access": "public" }
```

同时 `name`、`README` 里的安装命令、`dsh plugin add` 的目标名都要同步改。

---

## 二、发布前本地验证（必做，不可跳过）

```bash
cd /Users/mac/dsh-agent-eval

# 1. 构建通过
pnpm build

# 2. 离线回归全绿（15 组 124 项断言）
pnpm test:offline

# 3. 打包内容正确 —— 这是最重要的一步
npm pack --dry-run
```

**第 3 步要确认的事**：

| 必须**包含** | 必须**排除** |
|---|---|
| `dist/`（编译产物） | `test/`（桩与离线测试） |
| `suites/`（**运行时读取**，缺了插件跑不起来） | `docs/`（开发文档，不发布） |
| `cordis.patch.yml`（dsh bundle 补丁） | `src/`（源码，用户不需要） |
| `package.json` / `README.md` / `LICENSE` / `CHANGELOG.md` | `node_modules/`、`*.log`、`.DS_Store` |

包体内容由 `package.json` 的 `files` 字段控制
（`["dist", "suites", "cordis.patch.yml", "CHANGELOG.md"]`），**没有使用 `.npmignore`**。

> ⚠️ **`CHANGELOG.md` 必须显式写进 `files`。** npm 只会自动加入 `package.json`、
> `README*`、`LICENSE*` 和 `main` 指向的文件 —— **`CHANGELOG.md` 不在自动列表里**。
> （实测：未写进 `files` 时，`npm pack --dry-run` 的 27 个文件里没有它。）

`package.json` 里的 `prepublishOnly: "pnpm build && pnpm test:offline"` 会在发布时**再跑一遍**
这两项，构建失败或测试不绿则**发布中断**。这是防呆，不是重复劳动。

> ⚠️ `prepublishOnly` 调用的是 `pnpm`。若你的 `npm publish` 环境里 PATH 上没有 pnpm，
> 改用 `pnpm publish`（见下一步），或把该脚本里的 `pnpm` 换成 `npm run`。

---

## 三、发布到 npm

```bash
# 1. 登录（一次性）
npm login          # 浏览器或 OTP 验证
npm whoami         # 确认登录成功

# 2. 干跑一次（不真正上传，但会跑 prepublishOnly）
npm publish --dry-run

# 3. 正式发布
pnpm publish       # 用 pnpm 保证 prepublishOnly 里的 pnpm 命令可用
# 或： npm publish
```

**发布后立刻回填 git tag**（`CHANGELOG.md` 末尾的链接指向 `v1.0.0`）：

```bash
git add -A
git commit -m "release: v1.0.0"
git tag -a v1.0.0 -m "v1.0.0 — 首个正式版本"
```

> **不要 `npm publish` 之后再改源码再重发同一版本号** —— npm 不允许覆盖已发布版本。
> 要改就升版本号。

---

## 四、创建 GitHub 仓库

仓库**必须在发布前建好**，因为 `package.json` 的 `repository.url` 要指向它。

```bash
cd /Users/mac/dsh-agent-eval

# 1. 本地首次提交（若还没提交过）
git init                      # 若尚未初始化
git add -A
git commit -m "chore: initial commit"

# 2. 建远程仓库并推送
#    方式 A：用 gh CLI（推荐，一条命令搞定建库+推送）
#    注意：仓库名是 dsh-assay，与 npm 包名 dsh-migration-eval 不同 —— 见第零节
gh repo create dsh-assay --public --source=. --remote=origin --push

#    方式 B：先在网页建空仓库，再手动接远程
git remote add origin git@github.com:nmqcbl-cloud/dsh-assay.git
git branch -M main
git push -u origin main

# 3. 推送 tag
git push origin v1.0.0
```

**确认 `.gitignore` 生效**（仓库里不应出现 `node_modules/`、`dist/`）：

```bash
git ls-files | grep -E "node_modules|^dist/" | head    # 应无输出
```

`.gitignore` 内容已就绪：`node_modules/`、`dist/`、`*.log`、`.DS_Store`。

**建议的仓库设置**：

- 描述：`双后端对比评测插件 —— 用「批内对比」回答模型迁移的接受门问题`
- Topics：`deepseek` `dsh` `agent` `evaluation` `migration` `harness`
- 不要在仓库里放任何 key（`.gitignore` 已挡 `*.log`，但你仍需自查一次）

---

## 五、DSH 插件渠道（**需用户自行确认**）

**已核实的情况（dsh v0.1.7-rc.2，2026-09-28）**：

- dsh **没有** `plugin publish` 这类官方提交命令。`dsh plugin` 是 **pnpm 的透传**：
  ```
  dsh plugin --profile <name> <pnpm-args...>
  ```
  也就是说，**安装渠道就是 npm 本身** —— 发布到 npm 之后，用户即可直接用：

  ```bash
  dsh plugin --profile <profile> add dsh-migration-eval
  ```

- 在已安装的 `@deepseek-ai/dsh-tools@0.2.0-rc.1` 与 dsh CLI 帮助文本中
  **未发现任何 marketplace / registry / 提交入口** 的引用。

- **结论：目前无需额外的"上架"步骤，发到 npm 就等于可用。**

- ⚠️ **但 dsh 标注为 developer preview，官方可能随时推出插件市场。**
  发布前请自行到 DeepSeek Harness 官方仓库（GitHub `deepseek-ai/deepseek-harness`）
  的 README / Discussions 确认一次是否有新的提交渠道。若有，按其说明补充提交。

**用户安装后应看到**（可作为渠道可用性的验证）：

```
[dsh-migration-eval] registered "eval_run_dual" — listed=true
```

---

## 六、发布后验证

```bash
# 1. 包已上架、元数据正确
npm view dsh-migration-eval
npm view dsh-migration-eval version        # 1.0.0
npm view dsh-migration-eval keywords
npm view dsh-migration-eval license        # MIT
npm view dsh-migration-eval dist.tarball   # 可下载

# 2. 从 registry 装一次，确认内容完整（用一个干净目录，别污染本仓库）
mkdir -p /tmp/npm-smoke && cd /tmp/npm-smoke
npm pack dsh-migration-eval
tar tzf dsh-migration-eval-1.0.0.tgz | head -30
# 应看到 package/dist/、package/suites/、package/cordis.patch.yml、package/README.md

# 3. 装进 dsh profile（这一步会真正验证插件能跑）
dsh plugin --profile <一个干净的 profile> add dsh-migration-eval
dsh --profile <该 profile> --dump-config | grep dsh-migration-eval

# 4. 端到端：跑一次真实评测（需要 key）
eval "$(grep -E '^export ANTHROPIC_AUTH_TOKEN=' "$HOME/.zshrc")"
export DEEPSEEK_API_KEY="$ANTHROPIC_AUTH_TOKEN"
unset ANTHROPIC_AUTH_TOKEN
dsh --profile <该 profile> headless --json \
  "只调用 eval_run_dual，suite 填 multi-step/01-single-step，拿到结果后原样输出，不要做任何其他操作"
# 期望：报告顶部出现 🎯 迁移判定：➖ 不判定（01 是环境探针）
```

> `npx dsh-migration-eval --version` **不适用** —— 本包是 **dsh 插件**，没有 CLI 入口
> （`bin` 字段未定义）。它的"入口"是被 dsh 加载后注册工具。验证请用上面的方式。

**第 4 步是唯一能同时验证「npm 包完整」+「插件真能跑」的检查**，
因为 `suites/` 是运行时从包内读取的 —— 如果打包漏了 `suites/`，
前 3 步全过，第 4 步才会暴露。

---

## 七、发布后：key 的处置

发布完成、`git status` 干净、`git log` 有清晰提交之后，**当前这把 key 就可以作废了**。

轮换步骤（人工）：

1. 去 DeepSeek 控制台作废当前 key
2. 生成新 key
3. 改 `~/.zshrc` 里 `ANTHROPIC_AUTH_TOKEN` 那一行
4. `source ~/.zshrc`

> **作废后如果还要动代码，只需要重新拿一把 key** —— 不是"前功尽弃"。
> v1.0 的全部数据已入库，离线回归不需要 key。

---

## 八、发布当天的最短路径

```bash
# ① 占位符
grep -rn "REPLACE_WITH" package.json LICENSE CHANGELOG.md README.md   # 逐个替换后重跑至无输出

# ② 验证
pnpm build && pnpm test:offline && npm pack --dry-run

# ③ 建仓（仓库名 dsh-assay）
gh repo create dsh-assay --public --source=. --remote=origin --push
git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0

# ④ 发布
npm login && pnpm publish

# ⑤ 验证
npm view dsh-migration-eval version
```

---

## 附：不要做的事

- **不要**在 `package.json` 里加 `"private": true`（会拒绝发布）
- **不要**把 key 写进任何被提交或被打包的文件（`src/` 只读环境变量名，从不读值）
- **不要**发布未构建的包（`dist/` 必须在，`prepublishOnly` 会自动兜底）
- **不要**重发同一个版本号（npm 不允许覆盖）
- **不要**跳过第六节的第 4 步 —— 那是唯一能验出"`suites/` 漏打包"的检查
