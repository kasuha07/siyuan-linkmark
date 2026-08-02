# Contributing

Please submit issues and improvement suggestions through
[siyuan-linkmark GitHub Issues](https://github.com/kasuha07/siyuan-linkmark/issues).
When reporting a problem, please include:

- SiYuan version and operating system;
- plugin version, network strategy, favicon provider, and fallback behavior;
- the complete public URL whose icon cannot be resolved;
- the complete `[siyuan-linkmark] Unable to cache` console error with private
  information removed.

Before submitting code, run:

```powershell
npm ci
make dev
npm run check
npm run build
```

`make dev` first creates a complete Linkmark development build, then starts or
reuses the local SiYuan development container and starts the Vite watchers. The
initial build ensures SiYuan discovers the plugin during its startup scan. The
container exposes SiYuan only at
`http://127.0.0.1:6806`, persists its workspace in `dev/siyuan-workspace/`, and
mounts `dist/` as the Linkmark plugin directory. Use `make dev-stop` to stop
the container without removing its workspace data.

When debugging asynchronous icon resolution, enable the default-off
**Resolution trace** switch in the development settings. Every In-flight task
then writes one sanitized JSON lifecycle record per event to the SiYuan kernel
log file, for example `dev/siyuan-workspace/temp/siyuan.log`, ending in a
terminal outcome or invalidation. After a rebuild, reload the plugin (or
restart the container) so SiYuan loads the updated `kernel.js`; the switch is
process-local and resets on every kernel reload. Follow the records with:

```powershell
Get-Content dev/siyuan-workspace/temp/siyuan.log -Wait | Select-String "resolution-trace"
```

The kernel log file is the source of truth for trace records. `docker logs`
only supplements it with process output, so a quiet container does not mean the
trace is missing.

Do not commit `node_modules`, local caches, SiYuan workspace data, or API keys.

Pull requests and pushes to `main` are checked automatically by
`.github/workflows/check.yml`, which runs `npm run check` and the build and
package validation.

Maintainer releases are automated by `.github/workflows/release.yml`. Keep the
versions in `package.json`, `package-lock.json`, and `plugin.json` aligned, push
the source commit, and then push a `vX.Y.Z` tag. GitHub Actions will build and
attach `package.zip`; do not manually create the same Release first.

---

# 参与贡献

请通过 [siyuan-linkmark GitHub Issues](https://github.com/kasuha07/siyuan-linkmark/issues)
提交问题和改进建议。报告问题时，请尽量附上：

- 思源版本和操作系统；
- 插件版本、网络策略、图标服务和失败后的兜底方式；
- 无法取得图标的完整公开链接；
- 完整的 `[siyuan-linkmark] Unable to cache` 控制台错误，注意移除隐私数据。

提交代码前请运行：

```powershell
npm ci
make dev
npm run check
npm run build
```

`make dev` 会先生成完整的链接印记开发构建，再启动或复用本地 SiYuan 开发容器并启动
Vite 监听构建。首次构建可确保思源在启动扫描时识别插件。容器只在
`http://127.0.0.1:6806` 提供服务，工作区保存在 `dev/siyuan-workspace/`，并将
`dist/` 挂载为 Linkmark（链接印记）插件目录。使用 `make dev-stop` 可停止容器而不删除
工作区数据。

调试异步图标解析时，请在开发版设置中开启默认关闭的“解析追踪”开关。此后每个
In-flight 任务都会把一条脱敏的 JSON 生命周期记录写入思源内核日志文件（例如
`dev/siyuan-workspace/temp/siyuan.log`），并以终态结果或失效记录结束。重新构建后请
重载插件（或重启容器），让思源加载新的 `kernel.js`；该开关是进程级状态，每次内核
重载都会重置。跟踪记录：

```powershell
Get-Content dev/siyuan-workspace/temp/siyuan.log -Wait | Select-String "resolution-trace"
```

内核日志文件才是追踪记录的来源。`docker logs` 只是进程输出的补充，容器没有输出并
不代表追踪记录缺失。

请不要提交 `node_modules`、本地缓存、思源工作空间数据或任何 API 密钥。

推送到 `main` 的提交及 Pull Request 会由 `.github/workflows/check.yml` 自动执行
`npm run check` 以及构建与发布包校验。

维护者发布版本时由 `.github/workflows/release.yml` 自动处理。请先确保
`package.json`、`package-lock.json` 和 `plugin.json` 中的版本一致，推送源码提交，
再推送 `vX.Y.Z` 标签。GitHub Actions 会构建并附加 `package.zip`，不要提前手动创建
同名 Release。
