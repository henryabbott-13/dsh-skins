# dsh-skins

给 **DeepSeek Harness**（dsh）用的壁纸与主题皮肤：右侧边栏面板把图片或视频铺到外壳上，
一套令牌层保证界面文字仍然可读，另附一个把"测量结果"变成完整皮肤的工具链。

> 社区项目，非官方。与 DeepSeek 无隶属或背书关系。

![一张程序化生成的示例皮肤](skins/demo/img_demo-ember_6b1f2c3d/assets/wallpaper.png)

## 能力

- **背景设置面板**（右侧边栏）：皮肤库网格、懒加载缩略图、一键应用、搜索与标签筛选、收藏、拖拽排序。
- **令牌而非样式表**：皮肤提供 `--dsw-*` 变量的 `{light,dark}` 成对取值，组件对比度由外壳自己保证，半透明表面下壁纸自然透出。
- **逐皮肤调参**：模糊、不透明度、遮罩、灰度/饱和度/对比度、色调分离（真·离散传输），以及轻微鼠标视差。
- **视频主题**：播放/暂停、静音、倍速、音频律动（只在视频皮肤下出现）。
- **自动化**：跟随系统深浅色、按时间段切换、按工作区绑定、定时轮播，只有一套优先级。
- **专注模式**：隐藏外壳只留壁纸；Windows 标题栏条被清空并进入全屏，只剩画面。
- **皮肤库管理**：`.zip` 导入/导出、带回收站的清理、批量选择、原子写入。
- **不改 dsh 官方文件**：插件只是 profile 的一行补丁，加它自己数据目录里的文件。

## 安装

**推荐：装 bundle** —— 在 **设置 → 插件** 安装 `@henryabbott-13/dsh-skins-bundle`，
重启 dsh，打开右侧边栏 → **背景设置**。

**手动**：在 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: ui-dsh-skins
      name: '@henryabbott-13/dsh-plugin-skins'
```

`dataDir`、`defaultSkin`、开发用 checkout 等完整说明见 [docs/install.md](docs/install.md)。

## 皮肤是用户内容

本仓库**不包含任何素材**。`skins/demo/` 里是三套**程序化生成**的示例皮肤（上图就是其中一张壁纸），
仅作格式演示：把它们复制进 `<dataDir>/output/skins/` 就能看到面板工作，然后用你有权使用的素材做自己的皮肤。

```bash
node tools/make-demo-skins.mjs          # 重新生成示例
dsh-skins check skins/demo              # 校验皮肤库
```

皮肤格式（id 规则、`skin.json`、`tokens.json`、作用域 CSS、素材回退）见 [docs/skin-format.md](docs/skin-format.md)。

## 兼容性

以 dsh **0.2.1**（Electron 桌面端）为目标。主题/令牌层走官方 `theme.overrideTokens` 契约；
外壳与专注模式的修复针对哈希类名，按**后缀**匹配，这也是 0.2.0 → 0.2.1 改名后仍然有效的原因。
细节、规则与内置诊断的读法见 [docs/compat.md](docs/compat.md)。

## 仓库结构

```
packages/
  plugin/     宿主半侧（路由/目录/上传/皮肤包）+ 浏览器半侧（面板）
  bundle/     npm bundle：一层按包名插入插件的补丁
  toolkit/    deriveDesign / buildTokens / themeCss + dsh-skins CLI
skins/demo/   三套程序化示例皮肤（无第三方素材）
tools/        bundle/清单校验、PNG 编码器、示例生成器
tests/        10 套沙箱套件（831 项）+ toolkit 与宿主配置契约
docs/         安装、皮肤格式、兼容性
```

## 开发

```bash
node packages/plugin/build.mjs     # 构建客户端 bundle
node tests/run.mjs                 # 10 套沙箱套件（不需要安装 dsh）
node tests/toolkit.mjs             # toolkit 契约
node tests/host-config.mjs         # dataDir / 默认皮肤 / 管线契约
node tools/verify-bundle.mjs       # 恰好一次注册，id 与包名一致
```

CI 在 Node 20 上跑同样的命令：套件用桩外壳，仓库里所有图片都由代码生成，
所以干净 clone 无需素材、无需 dsh 即可测试与构建。

## 许可

代码 **Apache-2.0**（[LICENSE](LICENSE)）；文档 **CC-BY-4.0**（[LICENSE-docs](LICENSE-docs)）。
第三方依赖按 package.json 声明、不内联；ffmpeg 只作为外部程序调用。
