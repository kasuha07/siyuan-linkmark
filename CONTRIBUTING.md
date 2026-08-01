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

`make dev` starts or reuses the local SiYuan development container and then
starts the Vite watchers. The container exposes SiYuan only at
`http://127.0.0.1:6806`, persists its workspace in `dev/siyuan-workspace/`, and
mounts `dist/` as the Linkmark plugin directory. Use `make dev-stop` to stop
the container without removing its workspace data.

Do not commit `node_modules`, local caches, SiYuan workspace data, or API keys.

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

`make dev` 会启动或复用本地 SiYuan 开发容器，然后启动 Vite 监听构建。容器只在
`http://127.0.0.1:6806` 提供服务，工作区保存在 `dev/siyuan-workspace/`，并将
`dist/` 挂载为 Linkmark（链接印记）插件目录。使用 `make dev-stop` 可停止容器而不删除
工作区数据。

请不要提交 `node_modules`、本地缓存、思源工作空间数据或任何 API 密钥。

维护者发布版本时由 `.github/workflows/release.yml` 自动处理。请先确保
`package.json`、`package-lock.json` 和 `plugin.json` 中的版本一致，推送源码提交，
再推送 `vX.Y.Z` 标签。GitHub Actions 会构建并附加 `package.zip`，不要提前手动创建
同名 Release。
