## *预构建前端：离线启动编辑器

- **直接启动**：完整的 `dist/` 随 Git 交付。主机只需 Bash 和 Python 3 即可运行 `./start.sh`，无需 Node.js、npm 或联网构建。
- **缺失时重建**：入口或资源缺失时，脚本可复用现有工具构建；工具缺失则先运行 `npm ci --include=dev`。使用 `--offline` 安装依赖时，必须备齐目标平台的 npm 缓存。
- **下游交付**：打包或复制编辑器时保留整个 `dist/`；前端有改动时，运行 `npm run build` 并将产物与源码一并提交。

[English](release-notes-v0.2.2.en.md)
