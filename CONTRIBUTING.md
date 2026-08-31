# 贡献指南 / Contributing

欢迎贡献!dsh-photo-pet 是一个 DeepSeek Harness(DSH)Web 插件,仓库虽小,但请遵循下面的流程,让 `main` 保持稳定。

## 分支与合并规则

**`main` 受保护,不能直接推送。** 所有改动必须:

1. 从 `main` 检出新分支:`git checkout -b feat/your-change`
2. 在新分支上提交改动
3. 推送分支并创建 Pull Request(PR)
4. PR 需满足:
   - 至少 **1 人评审通过**
   - **CI 冒烟测试通过**(`.github/workflows/ci.yml`)
   - 分支与 `main` 保持同步(strict 模式)
5. 合并到 `main`(推荐 squash merge)

禁止:向 `main` 强推、删除 `main` 分支。

## 本地开发

```bash
# 冒烟测试(jsdom 无头环境,不需要真实 DSH 实例)
cd test
npm install
npm test
```

冒烟测试覆盖:挂载、悬停菜单、上传(含 AI 抠图回退路径)、命名、工作话语、设置卡片与总线交互。**改完浏览器端代码后请跑一遍冒烟测试再提 PR。**

## 目录速览

| 路径 | 说明 |
|---|---|
| `lib/index.js` | host 半区:设置命名空间、`/api/photo-pet/*` 路由、AI 抠图代理 |
| `lib/client.js` | client 半区:宠物渲染、动画、悬浮菜单、抠图编辑器、设置卡片 |
| `cordis.patch.yml` | bundle 补丁,把插件行插入 Web 插件花名册 |
| `test/smoke-test.mjs` | jsdom 冒烟测试(唯一的自动化验证) |

## 代码约定

- 浏览器半区不依赖构建步骤,保持"纯手写 factory bundle"形态(只 require react / react-dom)
- 设置字段同时出现在 host schema(`lib/index.js`)与 client 默认值(`lib/client.js`),新增字段要两处同步
- 中英文案分别在 `PHOTO_PET_CARD_LOCALE_ZH / EN` 与 `WORK_LINES` 等常量里维护
- 提交信息用英文,遵循 Conventional Commits(`feat:` / `fix:` / `ci:` / `docs:` …)
