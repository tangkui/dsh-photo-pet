# dsh-photo-pet — 照片宠物插件

中文 | [English](README.en.md)

> 把任意一张照片变成 DeepSeek Harness(DSH)Web GUI 里的浮动宠物。

上传你的照片,它就变成了住在浏览器角落的宠物:可以拖来拖去、可以 AI 一键抠图换干净背景、可以起名字、会悬停弹菜单,模型工作的时候还会冒泡说话。照片就是宠物本体——不加边框、不套模板,原样呈现。

插件采用官方 DSH 插件形态(cordis bundle:host 半区 + client 半区,一个包),不改 DSH 源码,通过 profile 机制挂载。

![宠物效果](docs/screenshot.png)

## 功能

| 功能 | 说明 |
|---|---|
| 照片即宠物 | 上传的照片原样作为宠物形象,宽度可调,高度按照片比例自动 |
| AI 自动抠图 | 上传照片后自动识别并抠出主体(去噪、去色边、自动裁剪);浏览器端加载开源模型,图片不出本机 |
| 智能修图 | 上传时自动去除照片四周的纯色边框 |
| 手动抠图编辑器 | 内置编辑器,橡皮擦/画笔手动修正,可重新自动抠图 |
| 拖拽移动 | 按住宠物拖动换位置,位置自动保存 |
| 命名 | 宠物有自己的名字,悬停名牌显示,可在设置中修改 |
| 工作话语 | 模型工作时宠物冒泡显示自定义话语(每行一句),轮换间隔可配置 |
| 悬浮菜单 | 悬停弹出圆形功能菜单,菜单项可单独开关,支持一键全显/全隐 |
| 状态动画 | 空闲摇摆、点击弹跳、工作时左右摇摆 + 抽烟气泡(烟圈特效) |
| 隐藏/召唤 | 一键隐藏,隐藏后悬停宠物位置出现召唤按钮 |
| 设置面板 | 左侧导航"我的宠物":启用、显示、名字、大小、位置、修图/抠图开关、话语与菜单配置,改名实时同步到菜单 |

## 工作原理

- **host 半区**(`lib/index.js`):注册 `photo-pet` 设置命名空间,提供 `/api/photo-pet/*` 路由(照片存取、活动状态轮询)与 AI 抠图代理(`/api/photo-pet/ai/*`,模型按需下载并缓存到 `~/.dsh/photo-pet/ai/<版本>/`)。
- **client 半区**(`lib/client.js`):浏览器端渲染宠物本体、动画、气泡、悬浮菜单与抠图编辑器;通过 `settings.section` 槽位把"我的宠物"注册为设置页一级导航。
- **安装形态**:profile 依赖 + `dsh.profile.bundles` 注册;插件的 `cordis.patch.yml`(`dsh.bundle.patch`)自动把插件行插入 Web 插件花名册。

## 安装

### 环境要求

- DeepSeek Harness(DSH)Web GUI,版本 `>= 0.1.1-rc.1`
- Node.js 18+(DSH 自带运行环境)

### 通过 npm 安装(发布后,最简单)

```bash
dsh plugin --profile web add dsh-photo-pet
```

DSH 会把插件装进 `web` profile 并自动注册 bundle;重启 Web 服务后刷新页面即可。

### 从 GitHub 安装

```bash
# 1. 克隆插件源码
git clone https://github.com/tangkui/dsh-photo-pet.git
cd dsh-photo-pet
npm install        # 安装 host 依赖
```

```bash
# 2. 把插件链接进 DSH profile
#    编辑 ~/.dsh/profiles/web/package.json:
```

```jsonc
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    // ...已有依赖
    "dsh-photo-pet": "link:/绝对路径/to/dsh-photo-pet"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...已有 bundle
        "dsh-photo-pet"
      ]
    }
  }
}
```

```bash
# 3. 重启 DSH Web(杀掉 3080 端口进程,DSH 会自动拉起)
kill $(lsof -ti :3080)

# 4. 验证:浏览器刷新页面
#    - 页面右下角出现宠物(首次为内置默认形象)
#    - 控制台无报错;插件 bundle 可访问:
curl -s http://127.0.0.1:3080/plugins/dsh-photo-pet/client.js
```

### 配置

左侧导航打开 **设置 → 我的宠物**:

- **启用宠物 / 显示宠物** —— 总开关与隐藏(隐藏后悬停可召唤)
- **宠物名字** —— 显示在名牌,同时左侧菜单名实时跟随
- **大小 / 距右边缘 / 距底部** —— 尺寸与位置
- **智能修图 / AI 自动抠图** —— 上传时的自动处理开关
- **工作状态下的话语 / 话语轮换间隔** —— 模型工作时的气泡文案与换句节奏
- **悬浮菜单显示项** —— 悬停菜单项开关,一键全显/全隐
- **快捷操作** —— 上传照片 / 智能抠图 / 恢复默认形象,与悬浮菜单同款功能

### 数据与缓存

- 宠物照片与配置:`~/.dsh/photo-pet/`
- AI 抠图模型缓存:`~/.dsh/photo-pet/ai/<版本>/`(首次抠图时自动下载,约 44MB,之后离线可用)

## 开发

```bash
# 冒烟测试(jsdom 无头环境,覆盖挂载/菜单/上传/AI 路径/工作话语/设置卡片)
# 注意:测试环境需要 Node.js >= 22.19(jsdom 30 的 undici 依赖要求)
cd test
npm install
npm test
```

GitHub Actions 会在每次 push / PR 时自动跑同一套冒烟测试(`.github/workflows/ci.yml`)。**main 分支受保护:所有改动必须通过其他分支发起 Pull Request,至少 1 人评审、CI 通过后才能合并。**

仓库结构:

```
dsh-photo-pet/
├── lib/index.js        # host 半区:路由 / 设置命名空间 / AI 代理
├── lib/client.js       # client 半区:宠物本体 / 动画 / 菜单 / 编辑器
├── cordis.patch.yml    # bundle 补丁:插件行插入 Web 插件花名册
├── test/               # jsdom 冒烟测试
├── package.json
└── README.md
```

## 协议

[MIT](LICENSE)

DeepSeek Harness 生态插件,与 [deepseek-ai/dsh](https://github.com/deepseek-ai/dsh) 同协议。
