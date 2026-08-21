# hermit-status

Hermit（小寄）各模块生效/监听状态的 **host 层**状态面板。

- 为什么 host 层：语音引擎是独立单例进程（`ws=127.0.0.1:8300` / `http=127.0.0.1:8301`），健康状态跨会话共享；且 DSH 的 client bundle 只由 profile 层（host loader entries）服务。
- host 半边：`/hermit/status` 路由，探测引擎 `8301 /healthz` 聚合模块态。
- client 半边：侧边栏「🦀 Hermit 状态」指示器（纯 DOM 注入，插在 SSH 入口之后、workspace 之前），每 3s 轮询。

安装：`dsh plugin --profile web add <hermit-status>`，或作为 monorepo 包 `link:` 进 profile 依赖并加入 `dsh.profile.bundles`。
