
# NJUST_AI_Assistant

**NJUST_AI_Assistant** 是一个集成了 AI 代码预测、智能聊天、一键编译和运行的多功能编程助手，支持多种主流大语言模型，并可直接在 VS Code 中修改、创建文件。

---

## Features

### 🤖 多模型 AI 聊天
- 支持 **DeepSeek、通义千问、豆包、智普AI、Hugging Face、OpenAI、Kimi** 以及 **本地模型**（如 Ollama、LM Studio）。
- 内置 **聊天模式**（回答编程问题、解释代码）和 **Agent 模式**（自动生成/修改文件、提供编译运行指导、执行终端命令）。
- 流式输出响应，支持 **思考过程** 展示（模型返回 `<think>` 标签时自动折叠）。
- **多模态支持**：可上传图片与 AI 进行视觉对话（需模型支持）。

### 📄 智能上下文感知
- 自动将当前打开的编辑器内容（或选中代码）作为上下文附加到对话中。
- 可手动添加任意文件作为参考，帮助 AI 更好地理解项目。
- **代码图分析**：自动分析项目结构、符号索引、调用链关系。
- **AST 分析**：支持 TypeScript、Python、Java、Go、C++、仓颉等语言的语法树分析。

### 🌐 联网搜索（需配置 SerpApi）
- 在对话中开启联网搜索后，AI 可结合最新搜索结果回答问题。
- 搜索结果会自动格式化并作为上下文提供给模型。
- 支持多种搜索引擎：Google、Bing、百度、Yahoo、DuckDuckGo。

### ⚡️ 行内代码预测（Ghost Text）
- 在编码时自动触发 AI 补全，提供下一段代码的预测（需启用 `enableAutoCompletion`）。
- 支持延迟触发，避免频繁请求。
- **智能补全**：第二代补全系统具备项目级学习能力，理解代码模式、预测用户意图。
- **多语言支持**：支持 C/C++、Java、Python、JavaScript、TypeScript、Rust、Go、仓颉等语言。

### 🚀 一键编译与运行
- 支持 **C/C++、Java、Python、JavaScript、TypeScript、Rust、Go、仓颉** 等多种语言的编译/检查。
- 通过 `Ctrl+Shift+B` 快速编译当前文件，编译结果直接显示在聊天窗口中。
- 编译成功后，可点击按钮直接运行生成的可执行文件（在独立终端中）。
- **仓颉语言特殊支持**：自动检测 `cjpm.toml` 或 `cjc.json` 配置文件，支持包管理器编译。

### 🤖 Agent 模式：直接修改文件与执行命令
- **修改文件**：AI 可以输出带 `> FILE: path/to/file` 标记的代码块，扩展会识别并允许你 **一键应用、保存、撤销** 文件更改。新文件会自动创建，现有文件会备份以便回滚。
- **精确编辑工具**：
  - `> REPLACE`：小范围文本替换（最精确）
  - `> EDIT_FUNCTION`：修改整个函数
  - `> EDIT_CLASS`：修改整个类
  - `> EDIT_LINE_CONTAINING`：修改包含特定文本的行
  - `> EDIT_BLOCK` / `> RANGE_EDIT`：基于行号或字符范围的编辑
  - `> DIFF`：应用 diff 格式的修改
- **执行命令**：AI 可以使用 `> RUN: command` 标记请求执行终端命令（如运行测试、安装依赖等），执行结果会返回给 AI 继续推理。命令执行前可请求用户确认（可配置为自动允许）。
- **文件读取**：`> READ: path/to/file` 让 AI 在修改前查看文件内容。
- **批量操作**：`> APPLY_BATCH` 和 `> MULTI_FILE` 支持批量文件修改。
- **MCP 工具**：支持 Model Context Protocol，可连接外部 MCP 服务器扩展功能。

### 📝 任务规划与执行
- **智能任务规划**：复杂任务自动分解为可执行的步骤序列。
- **风险评估**：自动评估任务风险等级（低/中/高）。
- **依赖管理**：支持步骤间的依赖关系，自动拓扑排序。
- **进度追踪**：实时显示任务执行进度和状态。

### 🧠 高级 Agent 功能
- **反思机制**：AI 自我评估执行结果，动态调整策略。
- **任务完成检查**：自动判断任务是否已完成，避免过度执行。
- **自动修正**：检测和修正工具调用错误，支持模糊匹配。
- **无限循环防护**：限制最大迭代次数和连续无操作次数。

### ⚙️ 图形化设置界面
- 点击状态栏或工具栏齿轮图标可打开设置模态框，分页配置在线模型、本地模型、联网搜索等。
- 支持模型参数实时调整（temperature、maxTokens 等）。

---

## 快捷键

### 全局快捷键

| 快捷键 | 命令 | 描述 |
|--------|------|------|
| `Ctrl+Shift+A` / `Cmd+Shift+A` | LLMA: 生成完整代码 | 根据注释或选中代码生成完整代码 |
| `Alt+\` | LLMA: 手动触发 Ghost Text | 手动触发代码补全 |
| `Ctrl+Shift+B` / `Cmd+Shift+B` | LLMA: 编译当前文件 | 编译当前文件 |
| `Ctrl+Shift+Q` / `Cmd+Shift+Q` | LLMA: 切换聊天/Agent 模式 | 切换聊天模式和 Agent 模式 |

### 聊天界面快捷键

| 快捷键 | 描述 |
|--------|------|
| `Enter` | 发送消息（输入框聚焦时） |
| `Shift+Enter` | 换行（输入框聚焦时） |
| `Escape` | 关闭搜索框/设置面板 |

---

## Agent 模式工具指令详解

Agent 模式下，AI 可以使用以下工具指令直接操作你的项目：

### 文件操作工具

#### 1. `> FILE: <filepath>`
创建或覆盖文件。AI 会在指令后输出完整的文件内容。

**使用场景**：
- 创建新文件
- 大范围重写现有文件

**示例**：
```
> FILE: src/utils.ts
```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```
```

---

#### 2. `> READ: <filepath>`
读取文件内容，供 AI 了解当前文件状态。

**使用场景**：
- 修改前查看文件内容
- 了解项目结构

**示例**：
```
> READ: src/app.ts
```

---

#### 3. `> REPLACE: <filepath>`
精确替换文件中的指定文本。这是最精确的编辑方式。

**使用场景**：
- 小范围修改（1-10行）
- 精确替换特定代码片段

**格式**：
```
> REPLACE: src/app.ts
<ORIGINAL>
// 要替换的原文本（必须与文件中完全一致）
</ORIGINAL>
<NEW>
// 替换后的新文本
</NEW>
```

**示例**：
```
> REPLACE: src/utils.ts
<ORIGINAL>
export function add(a: number, b: number): number {
  return a + b;
}
</ORIGINAL>
<NEW>
export function add(a: number, b: number): number {
  console.log(`Adding ${a} and ${b}`);
  return a + b;
}
</NEW>
```

---

#### 4. `> EDIT_FUNCTION: <filepath> <functionName>`
修改文件中的整个函数。

**使用场景**：
- 修改整个函数实现
- 保持函数签名不变

**示例**：
```
> EDIT_FUNCTION: src/utils.ts add
```typescript
export function add(a: number, b: number): number {
  console.log(`Adding ${a} and ${b}`);
  return a + b;
}
```
```

---

#### 5. `> EDIT_CLASS: <filepath> <className>`
修改文件中的整个类。

**使用场景**：
- 修改整个类实现
- 重构类结构

**示例**：
```
> EDIT_CLASS: src/models/User.ts User
```typescript
export class User {
  id: string;
  name: string;
  email: string;
  
  constructor(data: Partial<User>) {
    Object.assign(this, data);
  }
}
```
```

---

#### 6. `> EDIT_LINE_CONTAINING: <filepath> <textPattern>`
修改包含特定文本的行。

**使用场景**：
- 修改特定配置行
- 更新导入语句

**示例**：
```
> EDIT_LINE_CONTAINING: package.json "version": "1.0.0"
```
"version": "1.1.0"
```

---

#### 7. `> EDIT_BLOCK: <filepath>`
基于行号范围编辑文件。

**格式**：
```
> EDIT_BLOCK: src/app.ts
startLine: 10
endLine: 20
---
```typescript
// 新的代码块内容
```
```

**使用场景**：
- 修改特定行范围
- 删除或插入代码块

---

#### 8. `> RANGE_EDIT: <filepath>`
基于字符位置范围编辑文件。

**格式**：
```
> RANGE_EDIT: src/app.ts
start: 100
end: 200
---
```typescript
// 新的代码内容
```
```

**使用场景**：
- 精确字符级编辑
- 替换特定字符串

---

#### 9. `> DIFF: <filepath>`
应用 diff 格式的修改。

**格式**：
```
> DIFF: src/app.ts
```diff
- 删除的行
+ 添加的行
```
```

**使用场景**：
- 复杂的代码重构
- 多行修改

---

#### 10. `> MKDIR: <dirpath>`
创建目录。

**示例**：
```
> MKDIR: src/components
```

---

### 批量操作工具

#### 11. `> MULTI_FILE:`
批量创建或修改多个文件。

**格式**：
```
> MULTI_FILE:
[
  {
    "path": "src/utils.ts",
    "content": "export const PI = 3.14159;"
  },
  {
    "path": "src/config.ts",
    "content": "export const API_URL = 'https://api.example.com';"
  }
]
```

**使用场景**：
- 创建项目脚手架
- 批量生成组件

---

#### 12. `> APPLY_BATCH:`
批量应用编辑操作。

**格式**：
```
> APPLY_BATCH:
[
  {
    "filepath": "src/app.ts",
    "original": "old code",
    "new": "new code"
  }
]
```

---

### 命令执行工具

#### 13. `> RUN: <command>`
执行终端命令。

**示例**：
```
> RUN: npm install
> RUN: npm run build
> RUN: python -m pytest
```

**安全提示**：
- 默认需要用户确认
- 可配置为自动允许（请谨慎开启）
- 危险命令会被拦截

---

### MCP 工具

#### 14. `> MCP: <serverName> <toolName> [JSON参数]`
调用 MCP 服务器提供的工具。

**示例**：
```
> MCP: filesystem read_file {"path": "/path/to/file"}
```

---

### 项目模板工具

#### 15. `> PROJECT:`
创建完整的项目结构。

**格式**：
```
> PROJECT:
{
  "name": "my-project",
  "template": "react-ts",
  "files": [
    {"path": "src/index.tsx", "content": "..."}
  ]
}
```

---

## 执行流程说明

### 1. 聊天模式执行流程

```
用户输入 → 上下文收集 → AI 生成回复 → 流式展示 → 结束
```

**上下文收集包括**：
- 当前活动文件内容
- 选中代码片段
- 用户附加的文件
- 联网搜索结果（如开启）

### 2. Agent 模式执行流程

```
用户输入 → 任务规划（可选）→ 上下文收集 → AI 生成回复
                                              ↓
用户确认 ← 展示结果 ← 执行工具 ← 解析工具指令
   ↓
继续对话 ← 返回执行反馈
```

**详细步骤**：

1. **任务规划**（复杂任务）：
   - 分析用户请求
   - 分解为可执行步骤
   - 评估风险等级
   - 建立步骤依赖关系

2. **上下文收集**：
   - 活动文件（200行上下文）
   - 可见编辑器内容
   - 打开文件列表
   - 相关文件（import 依赖）
   - 诊断信息（错误/警告）
   - 工作区结构
   - 符号索引和代码图
   - AST 分析结果

3. **AI 生成回复**：
   - 流式输出
   - 思考过程展示
   - 工具指令标记

4. **工具解析与执行**：
   - 解析工具指令
   - 验证参数
   - 执行工具
   - 收集执行结果

5. **自动迭代**（Agent 模式）：
   - 将执行结果反馈给 AI
   - AI 生成下一步操作
   - 重复直到任务完成
   - 反思机制评估进度
   - 任务完成检查

### 3. 代码补全执行流程

```
用户输入 → 延迟检测 → 准备上下文 → 调用 AI → 展示补全
```

**智能补全额外步骤**：
- 学习项目代码模式
- 分析项目上下文
- 预测用户意图
- 提供多选项补全

### 4. 编译执行流程

```
用户触发编译 → 检测语言 → 选择编译器 → 执行编译
                                                  ↓
运行可执行文件 ← 展示结果 ← 分析输出 ← 捕获输出
```

**编译占位符**：
- `{file}`：当前文件路径
- `{allFiles}`：同目录下所有相关源文件
- `{executable}`：输出可执行文件路径
- `{outputDir}`：输出目录
- `{fileName}`：文件名
- `{fileNameWithoutExt}`：不带扩展名的文件名
- `{fileDir}`：文件所在目录

---

## 技术栈分析

### 核心技术架构

#### 1. 前端界面（Webview）
- **技术**：原生 HTML5 + CSS3 + JavaScript
- **样式框架**：自定义 CSS 变量主题系统，支持深色/浅色模式
- **代码高亮**：Highlight.js（Atom One Dark 风格）
- **Markdown 渲染**：Marked.js
- **特性**：
  - 响应式设计，适配 VS Code 侧边栏
  - 流式输出打字机效果
  - 代码块语法高亮和一键复制
  - 文件变更卡片展示
  - 终端输出卡片展示

#### 2. 后端核心（TypeScript/Node.js）
- **运行环境**：VS Code Extension API
- **主要语言**：TypeScript 5.x
- **构建工具**：ESBuild（快速打包）
- **代码规范**：ESLint + TypeScript ESLint

#### 3. AI 模型集成层
- **API 客户端**：
  - OpenAI SDK（支持 OpenAI 兼容接口）
  - Axios（自定义 HTTP 客户端，支持流式响应）
- **支持的模型提供商**：
  - DeepSeek API
  - 通义千问（DashScope）
  - 豆包（火山引擎）
  - 智普AI（Zhipu）
  - Hugging Face（Router API + Space）
  - OpenAI
  - Kimi（月之暗面）
  - 本地模型（Ollama、LM Studio 等）
  - 自定义模型（可配置任意 OpenAI 兼容接口）

#### 4. 代码分析与上下文系统
- **AST 解析**：
  - Babel Parser（TypeScript/JavaScript）
  - 自定义分析器（Python、Java、Go、C++、仓颉）
- **符号索引**：工作区级符号提取和搜索
- **代码图构建**：调用链分析、依赖关系图
- **上下文管理器**：
  - 文件监听和增量更新
  - AST 缓存机制
  - 相关文件智能推荐

#### 5. 智能补全系统
- **第一代**：基础行内补全（LLMAInlineCompletionProvider）
- **第二代**：智能补全（SmartCompletionProvider）
  - 代码模式学习（PatternLearner）
  - 项目上下文感知
  - 意图预测
  - 补全分析和统计

#### 6. 工具执行系统
- **工具解析器**：解析 AI 输出的各种工具指令
- **工具执行器**：
  - 文件操作（创建、修改、读取）
  - 目录操作（创建）
  - 命令执行（带超时和安全检查）
  - MCP 工具调用
- **智能编辑器**：
  - 精确编辑定位
  - 模糊匹配算法
  - 自动修正机制

#### 7. 任务管理系统
- **任务规划器**：将复杂任务分解为可执行步骤
- **任务管理器**：协调步骤执行、依赖管理
- **执行追踪**：记录执行历史、支持调试

#### 8. 外部服务集成
- **联网搜索**：SerpApi（Google、Bing、百度等）
- **MCP 协议**：Model Context Protocol SDK
- **Git 集成**：Simple Git（可选）

### 项目结构

```text
src/
├── api.ts                 # AI API 调用核心
├── extension.ts           # 扩展入口
├── config.ts              # 配置管理
├── constants.ts           # 常量定义
├── types.ts               # 类型定义
├── utils.ts               # 工具函数
├── statusBar.ts           # 状态栏管理
├── inlineCompletionProvider.ts    # 行内补全
├── compilation.ts         # 编译系统
├── webSearch.ts           # 联网搜索
├── mcpClient.ts           # MCP 客户端
├── commands.ts            # 命令注册
├── ast/                   # AST 分析模块
│   ├── base.ts           # 基础分析器
│   ├── typescriptAnalyzer.ts
│   ├── pythonAnalyzer.ts
│   ├── javaAnalyzer.ts
│   ├── goAnalyzer.ts
│   ├── cppAnalyzer.ts
│   └── cangjieAnalyzer.ts
├── chat/                  # 聊天系统
│   ├── index.ts          # 聊天提供者
│   ├── messageHandler.ts # 消息处理
│   ├── webview.ts        # Webview 生成
│   ├── session.ts        # 会话管理
│   ├── tools.ts          # 工具实现
│   ├── toolParser.ts     # 工具解析
│   ├── toolExecutor.ts   # 工具执行
│   ├── agentToolProcessor.ts  # Agent 处理器
│   └── trace.ts          # 执行追踪
├── completion/            # 智能补全
│   ├── smartCompletionProvider.ts
│   └── patternLearner.ts
├── context/               # 上下文管理
│   ├── contextManager.ts
│   ├── symbolIndex.ts
│   └── codeGraph.ts
├── task/                  # 任务管理
│   ├── taskPlanner.ts
│   ├── taskManager.ts
│   └── taskTypes.ts
├── cangjie/               # 仓颉语言支持
├── git/                   # Git 集成
├── integration/           # 集成管理
└── langchain/             # LangChain 集成
```

### 依赖库

#### 核心依赖
- `openai`: OpenAI API 客户端
- `axios`: HTTP 客户端（支持流式响应）
- `@babel/parser`, `@babel/traverse`, `@babel/types`: AST 解析
- `diff-match-patch`: 文本差异匹配
- `uuid`: UUID 生成

#### 开发依赖
- `typescript`: TypeScript 编译器
- `esbuild`: 快速打包工具
- `eslint`: 代码检查
- `@types/vscode`: VS Code API 类型

#### 可选依赖
- `simple-git`: Git 操作
- `@modelcontextprotocol/sdk`: MCP 协议支持
- `langchain`, `@langchain/core`, `@langchain/openai`: LangChain 集成

---

## Requirements

- **VS Code 1.80.0 或更高版本**
- **网络连接**（使用在线模型时需要）
- **API 密钥**：根据你选择的模型，需要申请对应的 API Key：
  - DeepSeek: [https://platform.deepseek.com/](https://platform.deepseek.com/)
  - 通义千问 (DashScope): [https://dashscope.aliyun.com/](https://dashscope.aliyun.com/)
  - 豆包 (火山引擎): [https://console.volcengine.com/ark/](https://console.volcengine.com/ark/)
  - 智普AI (Zhipu): [https://open.bigmodel.cn/](https://open.bigmodel.cn/)
  - Hugging Face: [https://huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
  - OpenAI: [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
  - Kimi: [https://platform.moonshot.cn/](https://platform.moonshot.cn/)
- **SerpApi 密钥**（如需联网搜索）: [https://serpapi.com/](https://serpapi.com/)
- **本地模型**（如需使用）：需要自行启动兼容 OpenAI API 的本地服务（如 Ollama、LM Studio），并配置 `localModel.baseUrl`。

---

## Extension Settings

此扩展通过 `contributes.configuration` 贡献了以下设置（可在 VS Code 设置中搜索 `llma` 进行配置）：

### 通用
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.enableAutoCompletion` | boolean | `true` | 启用实时代码预测 (Ghost Text/幽灵文本) |
| `llma.currentModel` | string | `"deepseek"` | 选择 AI 模型提供商，可选值：`deepseek`、`qwen`、`doubao`、`zhipu`、`local`、`huggingface`、`openai`、`kimi`、`huggingface-space`、`custom` |
| `llma.requestDelay` | number | `300` | 自动预测延迟（毫秒） |
| `llma.maxTokens` | number | `2000` | 生成的最大 Token 数 |

### 在线模型 API 密钥
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.deepseekApiKey` | string | `""` | DeepSeek API Key |
| `llma.deepseekModel` | string | `"deepseek-coder"` | DeepSeek 模型名称 |
| `llma.qwenApiKey` | string | `""` | 通义千问 API Key |
| `llma.qwenModel` | string | `"qwen-coder-turbo"` | 通义千问模型名称 |
| `llma.qwenBaseUrl` | string | `"https://dashscope.aliyuncs.com/compatible-mode/v1"` | 通义千问 Base URL |
| `llma.doubaoApiKey` | string | `""` | 豆包 API Key |
| `llma.doubaoModel` | string | `""` | 豆包 Endpoint ID (例如: ep-20240604...) |
| `llma.zhipuApiKey` | string | `""` | 智普AI API Key |
| `llma.zhipuModel` | string | `"glm-4"` | 智普AI 模型名称 |
| `llma.huggingfaceApiKey` | string | `""` | Hugging Face Access Token (HF_TOKEN) |
| `llma.huggingfaceModel` | string | `"Qwen/Qwen2.5-Coder-32B-Instruct"` | Hugging Face 模型 ID |
| `llma.openaiApiKey` | string | `""` | OpenAI API Key |
| `llma.openaiBaseUrl` | string | `"https://api.openai.com/v1"` | OpenAI Base URL (需包含 /v1) |
| `llma.openaiModel` | string | `"gpt-4-turbo-preview"` | OpenAI 模型名称，如 `gpt-4`、`gpt-3.5-turbo` |
| `llma.kimiApiKey` | string | `""` | Kimi API Key |
| `llma.kimiModel` | string | `"moonshot-v1-8k"` | Kimi 模型名称 (如 moonshot-v1-8k, moonshot-v1-128k) |
| `llma.huggingfaceSpaceBaseUrl` | string | `""` | Hugging Face Space Base URL |
| `llma.huggingfaceSpaceModel` | string | `""` | Hugging Face Space 模型名称 |

### 自定义模型
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.customModel.apiBaseUrl` | string | `"http://127.0.0.1:8000"` | 自定义模型 API 基础 URL |
| `llma.customModel.apiKey` | string | `""` | 自定义模型 API Key |
| `llma.customModel.modelName` | string | `""` | 自定义模型名称 |
| `llma.customModel.chatEndpoint` | string | `"/chat/completions"` | 聊天接口路径 |
| `llma.customModel.supportsMultimodal` | boolean | `false` | 是否支持多模态 |

### 本地模型
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.localModel.enabled` | boolean | `false` | 启用本地大模型 |
| `llma.localModel.baseUrl` | string | `"http://localhost:11434/v1"` | 本地模型 API 基础 URL (例如 Ollama: http://localhost:11434/v1) |
| `llma.localModel.modelName` | string | `"llama3"` | 本地模型名称 (例如: llama3, qwen2, codellama) |
| `llma.localModel.timeout` | number | `120000` | 本地模型请求超时时间 (毫秒) |
| `llma.localModel.supportsMultimodal` | boolean | `false` | 本地模型是否支持多模态 |

### 联网搜索
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.enableWebSearch` | boolean | `false` | 启用联网搜索功能 |
| `llma.webSearchEngine` | string | `"google"` | 选择 SerpAPI 使用的底层搜索引擎（google/bing/baidu/yahoo/duckduckgo） |
| `llma.serpApiKey` | string | `""` | SerpApi API Key (用于联网搜索) |

### 编译配置
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.compilation.compilers` | object | 见下方 | 编译命令配置，支持占位符 `{file}`、`{allFiles}`、`{executable}`、`{outputDir}`、`{fileName}`、`{fileNameWithoutExt}`、`{fileDir}` |
| `llma.compilation.defaultOutputDir` | string | `"build"` | 默认输出目录 |

默认编译命令对象：
```json
{
  "c": "gcc {allFiles} -o \"{executable}\"",
  "cpp": "g++ {allFiles} -o \"{executable}\"",
  "python": "python -m py_compile \"{file}\"",
  "javascript": "node --check \"{file}\"",
  "typescript": "tsc --noEmit \"{file}\"",
  "java": "javac -d \"{outputDir}\" \"{file}\"",
  "rust": "rustc \"{file}\" -o \"{executable}\"",
  "go": "go build -o \"{executable}\" \"{file}\"",
  "cangjie": "cjc \"{file}\" -o \"{executable}\""
}
```

### Python 相关
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.python.interpreterPath` | string | `""` | Python 解释器路径（留空则自动检测） |
| `llma.python.autoDetectVirtualEnv` | boolean | `true` | 自动检测并激活虚拟环境 |
| `llma.python.preferredCommand` | string | `"auto"` | 首选 Python 命令（auto/python/python3/py） |
| `llma.python.versionCheck` | boolean | `true` | 运行前检查 Python 版本 |

### Agent 模式相关
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.agent.allowCommandExecution` | boolean | `false` | 允许 AI 自动执行终端命令（若为 false，每次执行前会请求用户确认） |
| `llma.agent.maxToolIterations` | number | `15` | 单次对话中工具调用的最大迭代次数，防止无限循环 |
| `llma.agent.allowRangeEdit` | boolean | `true` | 允许 AI 进行范围编辑（EDIT_BLOCK、RANGE_EDIT、DIFF 等局部修改） |
| `llma.agent.fileChangeConfirmMode` | string | `"smart"` | 文件改动确认策略：always（每次确认）、smart（仅高风险改动确认）、never（直接应用） |
| `llma.agent.smartConfirmMinChangedLines` | number | `50` | smart 模式下触发确认的最小变更行数阈值 |
| `llma.agent.smartConfirmMinCharDelta` | number | `3000` | smart 模式下触发确认的最小字符变化阈值 |
| `llma.agent.enableReflection` | boolean | `true` | 启用 AI 反思机制，允许 AI 自我评估和优化回答 |
| `llma.agent.taskCompletionCheck` | boolean | `true` | 启用任务完成度检查，确保 AI 完成所有请求的任务 |
| `llma.agent.maxConsecutiveNoOps` | number | `3` | 允许的最大连续无操作次数，超过后停止自动调用 |
| `llma.agent.enableTaskPlanning` | boolean | `true` | 启用任务规划功能，复杂任务自动生成执行计划 |
| `llma.agent.forceTaskPlanning` | boolean | `false` | 强制对所有任务启用规划模式 |
| `llma.agent.complexTaskKeywords` | array | `["创建", "实现", "开发", "构建", "项目", "系统", "功能", "模块"]` | 触发任务规划的关键词列表 |

### MCP 配置
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.mcp.servers` | array | `[]` | MCP 服务器配置。每个服务器包含 name（唯一标识）、command（启动命令）、args（参数数组）、env（可选环境变量） |

### 聊天界面
| 设置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `llma.chat.typingEffect` | boolean | `true` | 启用流式输出的打字机效果（闪烁光标 + 内容渐入） |

---

## Known Issues

- 豆包模型需填写 Endpoint ID，而非普通模型名称。
- 联网搜索结果可能不准确，建议结合编程知识综合判断。
- Agent 模式下修改文件时，如果文件已被外部修改，可能会冲突（扩展会备份原始内容）。
- 命令执行功能默认需要用户确认，可修改配置以自动允许（请谨慎开启）。

---

## Release Notes

### 1.0.0

初始发布版本，包含以下核心功能：
- 多模型 AI 聊天（聊天模式 / Agent 模式）
- 自动行内代码预测（Ghost Text）
- 一键编译与运行（支持 C/C++、Java、Python、JS/TS、Rust、Go、仓颉等）
- Agent 模式下直接应用/保存/撤销文件更改，以及执行终端命令
- 联网搜索支持
- 图形化设置界面
- 任务规划与执行
- MCP 协议支持
- 多模态输入支持

---

## Following extension guidelines

确保你已阅读扩展指南并遵循创建扩展的最佳实践。

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

你可以使用 Visual Studio Code 编写 README。以下是一些有用的编辑器键盘快捷键：

* 拆分编辑器（macOS 上为 `Cmd+\`，Windows 和 Linux 上为 `Ctrl+\`）。
* 切换预览（macOS 上为 `Shift+Cmd+V`，Windows 和 Linux 上为 `Shift+Ctrl+V`）。
* 按 `Ctrl+Space`（Windows、Linux、macOS）查看 Markdown 片段列表。

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
