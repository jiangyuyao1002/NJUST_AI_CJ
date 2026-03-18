/**
 * 消息处理模块
 * 
 * 负责处理用户消息和 AI 响应的核心逻辑，包括：
 * - 上下文收集：收集活动文件、可见编辑器、相关文件、诊断信息等
 * - 网络搜索：集成网络搜索功能获取实时信息
 * - 工具执行：协调各种工具的执行（文件操作、命令执行等）
 * - 任务规划：将复杂任务分解为可执行的步骤
 * - Agent 模式：支持 Agent 模式的工具处理和反思
 * - 多模态支持：处理文本和图像输入
 * 
 * 主要功能：
 * - 处理用户输入并构建 AI 上下文
 * - 调用 AI API 获取响应
 * - 解析和执行工具调用
 * - 管理任务执行流程
 * - 处理网络搜索结果
 * - 支持仓颉语言的特殊处理
 * 
 * @module chat/messageHandler
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getApiKey, isMultimodalModel } from '../config';
import { callChatAI } from '../api';
import { searchWeb, formatSearchResults } from '../webSearch';
import { getWorkspaceContext, getRelatedFilesContext, getDiagnosticsContext, isCommandDangerous } from '../utils';
import { AgentContextManager, createContextManager } from '../context';
import { 
    execWithTimeout, 
    createDirectory, 
    handleFileChange, 
    handleEditBlock, 
    handleRangeEdit, 
    handleDiff,
    handleProjectTemplate,
    handleMultiFileEdit,
    handleApplyBatch,
    handleReplaceEdit,
    extractReplaceParts,
    handleFunctionEdit,
    handleClassEdit,
    handleLineContainingEdit,
    extractJSONAfterMarker,
    handleReadFile
} from './tools';
import { runExecutable } from '../compilation';
import { LLMAChatProvider } from './index';
import { EditDescription, ChatHistory } from '../types';
import { mcpManager } from '../extension';
import { TaskPlanner, TaskPlanningContext, TaskExecutionContext } from '../task/taskPlanner';
import { TaskManager } from '../task/taskManager';
import { TaskExecutionResult, TaskPlan, TaskStep, TaskStatus } from '../task/taskTypes';
import { AgentToolProcessor, AgentToolConfig } from './agentToolProcessor';
import { resolveFilePath } from './smartEditor';
import { AI, CONTEXT, TIMEOUT } from '../constants';

/**
 * 推送内部反馈消息到历史记录
 * 
 * 将执行反馈添加到历史记录中，用于 AI 了解工具执行结果。
 * 
 * @param history - 聊天历史记录
 * @param content - 反馈内容
 * @param provider - 可选，聊天提供者实例
 */
function pushInternalFeedback(history: ChatHistory, content: string, provider?: LLMAChatProvider): void {
  history.push({
    role: 'user',
    content: `[执行反馈]\n${content}`
  });
  if (provider) {
    provider.currentSessionHistory.push({
      role: 'user',
      content: `[执行反馈]\n${content}`
    });
  }
}

/**
 * 推送可见的助手消息
 * 
 * 将 AI 助手的响应添加到历史记录并显示给用户。
 * 
 * @param provider - 聊天提供者实例
 * @param history - 聊天历史记录
 * @param content - 助手消息内容
 */
function pushVisibleAssistantMessage(
  provider: LLMAChatProvider,
  history: ChatHistory,
  content: string
): void {
  history.push({ role: 'assistant', content });
  provider.currentSessionHistory.push({ role: 'assistant', content });
}

/**
 * 从输出中提取已完成的步骤名称
 * 
 * 解析任务执行输出，提取标记为"完成"或"失败"的步骤名称。
 * 
 * @param output - 任务执行输出字符串
 * @param maxItems - 最多提取的步骤数量，默认为 3
 * @returns 步骤名称数组
 */
function extractCompletedStepNames(output: string, maxItems: number = 3): string[] {
  const names = new Set<string>();
  const regex = /\[([^\]]+)\]\s*(?:完成|失败)\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(output)) !== null && names.size < maxItems) {
    const name = match[1]?.trim();
    if (name) {
      names.add(name);
    }
  }

  return Array.from(names);
}

/**
 * 构建任务规划完成消息
 * 
 * 根据任务执行结果生成总结消息。
 * 
 * @param result - 任务执行结果
 * @returns 总结消息字符串
 */
function buildPlanningCompletionMessage(result: TaskExecutionResult): string {
  const stepNames = extractCompletedStepNames(result.output);
  const lines: string[] = [];

  if (result.success) {
    lines.push('已完成本次任务。');
  } else {
    lines.push(`任务已结束，但有 ${result.stepsFailed} 个步骤失败。`);
  }

  if (stepNames.length > 0) {
    lines.push(`关键步骤：${stepNames.join('、')}。`);
  }

  if (result.stepsExecuted > 0) {
    lines.push(
      result.stepsFailed > 0
        ? `共执行 ${result.stepsExecuted} 个步骤，失败 ${result.stepsFailed} 个。`
        : `共执行 ${result.stepsExecuted} 个步骤。`
    );
  }

  lines.push(
    result.success
      ? '相关文件变更、终端输出和过程卡片已在上方展示。'
      : '请结合上方错误、文件变更和终端输出继续调整。'
  );

  return lines.join('\n');
}

export async function handleUserMessage(
  provider: LLMAChatProvider,
  userText: string,
  history: ChatHistory,
  selectedModel: string,
  mode: 'chat' | 'agent',
  attachedFiles: { name: string; path?: string; content?: string; isImage?: boolean }[],
  useWebSearch: boolean
) {
  const view = provider.view;
  if (!view) { return; }

  if (!provider.currentSessionId) {
    provider.currentSessionId = uuidv4();
  }

  if (provider.abortController) {
    provider.abortController.abort();
  }
  provider.abortController = new AbortController();
  const signal = provider.abortController.signal;

  const editor = vscode.window.activeTextEditor;
  let contextPrompt = "";
  const maxContextLength = mode === 'agent' ? CONTEXT.AGENT_MAX_LENGTH : CONTEXT.CHAT_MAX_LENGTH;

  // === Active File ===
  if (editor) {
    const document = editor.document;
    const selection = editor.selection;
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const language = document.languageId;
    let codeContext = "";

    if (!selection.isEmpty) {
      codeContext = document.getText(selection);
    } else {
      const cursorLine = selection.active.line;
      const startLine = Math.max(0, cursorLine - 200);
      const endLine = Math.min(document.lineCount - 1, cursorLine + 50);
      const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character);
      codeContext = document.getText(range);
    }
    if (codeContext.length > maxContextLength) {
      codeContext = codeContext.substring(0, maxContextLength) + "\n... (truncated)";
    }
    contextPrompt += `\n\n=== Active File ===\n[${relativePath}] (line ${selection.active.line + 1}, ${language}, ${document.lineCount} lines total)\n\`\`\`${language}\n${codeContext}\n\`\`\`\n`;
  }

  // === Agent 模式附加上下文 ===
  if (mode === 'agent') {
    // Visible Editors（多标签感知）
    const visibleEditors = vscode.window.visibleTextEditors.filter(
      e => e !== editor && e.document.uri.scheme === 'file'
    );
    if (visibleEditors.length > 0) {
      contextPrompt += '\n\n=== Visible Editors ===\n';
      for (const ve of visibleEditors) {
        const relPath = vscode.workspace.asRelativePath(ve.document.uri);
        const lang = ve.document.languageId;
        const lineCount = ve.document.lineCount;
        const preview = ve.document.getText(new vscode.Range(0, 0, Math.min(30, lineCount), 0));
        const truncated = preview.length > 1500 ? preview.substring(0, 1500) + '\n...' : preview;
        contextPrompt += `\n[${relPath}] (${lang}, ${lineCount} lines)\n\`\`\`${lang}\n${truncated}\n\`\`\`\n`;
      }
    }

    // Open Files 列表
    const openDocs = vscode.workspace.textDocuments.filter(
      d => d.uri.scheme === 'file' && !d.isUntitled
    );
    if (openDocs.length > 0) {
      const openPaths = openDocs.map(d => vscode.workspace.asRelativePath(d.uri));
      contextPrompt += `\n\n=== Open Files ===\n${openPaths.join('\n')}\n`;
    }

    // Related Files（import 依赖分析）
    if (editor && editor.document.uri.scheme === 'file') {
      const relatedCtx = await getRelatedFilesContext(editor.document.uri.fsPath);
      if (relatedCtx) { contextPrompt += relatedCtx; }
    }

    // Diagnostics
    const diagCtx = getDiagnosticsContext();
    if (diagCtx) { contextPrompt += diagCtx; }

    // Workspace Structure
    const workspaceContext = await getWorkspaceContext();
    contextPrompt += workspaceContext;

    // === Enhanced Context: Code Graph & Symbol Index ===
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const contextManager = createContextManager(workspaceRoot);
        
        if (!contextManager.isReady()) {
          contextPrompt += '\n\n=== Code Index (Building...) ===\nIndexing workspace symbols...';
          contextManager.initialize().catch(err => {
            console.warn('Context manager initialization failed:', err);
          });
        }
        
        if (contextManager.isReady() && editor && editor.document.uri.scheme === 'file') {
          const activeFilePath = editor.document.uri.fsPath;
          const enhancedContext = await contextManager.getRelevantContext(
            activeFilePath,
            userText,
            6000
          );
          
          if (enhancedContext && enhancedContext.length > 50) {
            contextPrompt += '\n\n' + enhancedContext;
          }

          const projectContext = contextManager.getProjectContext();
          if (projectContext) {
            const stats = contextManager.getStats();
            contextPrompt += `\n\n=== Project Overview ===\n`;
            contextPrompt += `Language: ${projectContext.language}\n`;
            if (projectContext.framework) {
              contextPrompt += `Framework: ${projectContext.framework}\n`;
            }
            contextPrompt += `Indexed: ${stats.symbols} symbols in ${stats.files} files\n`;
            
            if (projectContext.entryPoints.length > 0) {
              contextPrompt += `Entry Points: ${projectContext.entryPoints.join(', ')}\n`;
            }
          }
          
          const astContext = await contextManager.getEnhancedContextWithAST(
            activeFilePath,
            userText,
            4000
          );
          if (astContext && astContext.length > 50) {
            contextPrompt += '\n\n' + astContext;
          }
        }
      }
    } catch (ctxError: any) {
      console.warn('Enhanced context failed:', ctxError.message);
    }
  }

  // 处理附加文件（包括图片和文本内容）
  if (attachedFiles && attachedFiles.length > 0) {
    provider.pendingImages = [];
    contextPrompt += `\n\n=== User Attached Files ===\n`;
    for (const file of attachedFiles) {
      const filePath = file.path;
      const fileContent = file.content;
      const isImage = file.isImage;
      const fileName = file.name;

      if (filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const isPathImage = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext);
        try {
          if (isPathImage) {
            const imageBuffer = await fs.promises.readFile(filePath);
            const base64 = imageBuffer.toString('base64');
            const mime = ext === '.png' ? 'image/png' :
                         ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                         ext === '.gif' ? 'image/gif' :
                         ext === '.bmp' ? 'image/bmp' :
                         ext === '.webp' ? 'image/webp' : 'image/*';
            provider.pendingImages.push({ base64, mime, name: fileName });
            contextPrompt += `\n[Image: ${vscode.workspace.asRelativePath(filePath)}] (image attached)\n`;
          } else {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const truncatedContent = content.length > 10000 ? content.substring(0, 10000) + "\n... (Truncated)" : content;
            contextPrompt += `\n[File: ${vscode.workspace.asRelativePath(filePath)}]\n\`\`\`\n${truncatedContent}\n\`\`\`\n`;
          }
        } catch (e) {
          contextPrompt += `\n[File: ${fileName}] (Error reading file)\n`;
        }
      } else if (fileContent) {
        if (isImage) {
          const matches = fileContent.match(/^data:(.+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const mime = matches[1];
            const base64 = matches[2];
            provider.pendingImages.push({ base64, mime, name: fileName });
            contextPrompt += `\n[Image: ${fileName}] (image attached)\n`;
          } else {
            contextPrompt += `\n[Image: ${fileName}] (invalid data URL)\n`;
          }
        } else {
          const truncatedContent = fileContent.length > 10000 ? fileContent.substring(0, 10000) + "\n... (Truncated)" : fileContent;
          contextPrompt += `\n[File: ${fileName}]\n\`\`\`\n${truncatedContent}\n\`\`\`\n`;
        }
      }
    }
  }

  const config = vscode.workspace.getConfiguration('llma');
  const model = selectedModel || config.get<string>('currentModel') || 'deepseek';
  let apiKey = getApiKey(config, model);

  if (model === 'huggingface-space' || model === 'custom') {
    if (apiKey === undefined || apiKey === null) {
      apiKey = '';
    }
  } else if (model !== 'local' && !apiKey) {
    view.webview.postMessage({ type: 'addErrorResponse', text: `⚠️ 请先配置 ${model} 的 API Key` });
    provider.abortController = null;
    return;
  }

  try {
    // ── 联网搜索 ──────────────────────────────────────────────
    let webSearchResults = '';
    let searchFailed = false;

    if (useWebSearch) {
      const serpApiKey = config.get<string>('serpApiKey') || '';
      const searchEngine = config.get<string>('webSearchEngine') || 'google';

      if (!serpApiKey) {
        view.webview.postMessage({ type: 'addErrorResponse', text: '⚠️ 无法进行网络搜索：请先在设置中配置 SerpApi API Key。' });
        provider.abortController = null;
        return;
      }

      view.webview.postMessage({ type: 'showSearchStatus', text: '🔍 正在搜索...' });
      try {
        const results = await searchWeb(userText, serpApiKey, searchEngine);
        webSearchResults = formatSearchResults(results);
      } catch (searchError: any) {
        searchFailed = true;
        view.webview.postMessage({ type: 'addWarningResponse', text: `⚠️ 搜索失败: ${searchError.message}` });
        // 搜索失败时降级为普通聊天，不中断
      } finally {
        view.webview.postMessage({ type: 'hideSearchStatus' });
      }
    }

    // ── System prompt ─────────────────────────────────────────
    const now = new Date();
    const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const chatSystemPrompt = `你是一个专业的 VS Code AI 编程助手。
【当前时间】${dateStr}
你的核心任务是解答用户的编程问题、解释代码、提供代码建议和重构方案。
所有的代码片段必须使用 Markdown 代码块包裹，并**务必指定编程语言**（例如 \`\`\`typescript 或 \`\`\`python）。
【代码规范】默认使用全英文编写代码（注释、字符串、变量名等），除非用户明确要求中文。
- **禁止在代码中使用任何特殊字符**：包括 emoji、符号表情、ASCII 艺术字符、特殊符号（★、☆、♥ 等）
- **禁止在代码中嵌入终端命令**：不要在代码字符串中包含 shell 命令或 bash 脚本片段
【重要】当前为聊天模式，禁止使用任何指令或工具（如 > REPLACE、> EDIT_BLOCK、> FILE、> RUN 等），仅以文本和代码块回答。`;

    let systemPrompt = '';
    if (mode === 'agent') {
      systemPrompt = getAgentSystemPrompt();
    } else if (useWebSearch && webSearchResults && !searchFailed) {
      systemPrompt = `你是一个具有联网检索能力的专业 VS Code 编程助手。
用户的问题附带了最新的网络搜索结果，请综合搜索结果与你的专业知识作答。
${chatSystemPrompt}`;
    } else {
      systemPrompt = chatSystemPrompt;
    }

    // ── 构建用户消息 ──────────────────────────────���───────────
    // 搜索结果统一追加到用户消息，避免与 system prompt 重复注入
    let enhancedUserText = userText;
    if (webSearchResults && !searchFailed) {
      enhancedUserText = `${userText}\n\n---\n[网络搜索结果]\n${webSearchResults}`;
    }

    let userContent: string | any[] = enhancedUserText + contextPrompt;

    if (provider.pendingImages && provider.pendingImages.length > 0) {
      const supportsMultimodal = isMultimodalModel(model, config);
      if (!supportsMultimodal) {
        view.webview.postMessage({
          type: 'addWarningResponse',
          text: `当前模型（${model}）不支持图片，图片将被忽略。`
        });
        provider.pendingImages = [];
      } else {
        const contentArray: any[] = [];
        const text = enhancedUserText + contextPrompt;
        if (text.trim()) {
          contentArray.push({ type: "text", text: text });
        }
        for (const img of provider.pendingImages) {
          contentArray.push({
            type: "image_url",
            image_url: { url: `data:${img.mime};base64,${img.base64}` }
          });
        }
        userContent = contentArray;
      }
      provider.pendingImages = undefined;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userContent }
    ];

    const temp = mode === 'agent' ? 0.1 : 0.7;
    view.webview.postMessage({ type: 'streamStart' });

    const agentMaxTokens = mode === 'agent' ? AI.AGENT_MAX_TOKENS : AI.CHAT_MAX_TOKENS;
    const finalContent = await callChatAI(model, apiKey, messages, config, agentMaxTokens, temp, signal, (contentDelta, reasoningDelta) => {
      view.webview.postMessage({
        type: 'streamUpdate',
        content: contentDelta,
        reasoning: reasoningDelta
      });
    });

    const cleanFinalContent = finalContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();
    pushVisibleAssistantMessage(provider, history, cleanFinalContent);

    // 在工具执行前先发送 streamEnd，让前端完成当前消息的渲染
    // intermediate: true 表示这是中间过程，agent 尚未真正结束
    view.webview.postMessage({ type: 'streamEnd', intermediate: true });

    if (mode !== 'agent' || signal.aborted) {
      // Chat 模式不执行任何工具，仅展示 AI 回复
    } else {
      const planningContext: TaskExecutionContext = {
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        openFiles: vscode.workspace.textDocuments
          .filter(d => d.uri.scheme === 'file' && !d.isUntitled)
          .map(d => vscode.workspace.asRelativePath(d.uri)),
        activeFile: editor ? vscode.workspace.asRelativePath(editor.document.uri) : undefined,
        language: editor?.document.languageId,
        diagnostics: (() => {
          const ctx = getDiagnosticsContext();
          return ctx ? ctx.trim().split('\n').filter(Boolean) : [];
        })(),
        provider,
        history,
        config
      };

      const { usedPlanning, plan } = await tryPlanAndExecute(
        provider,
        userText,
        planningContext,
        history,
        selectedModel,
        config,
        signal
      );

      if (!usedPlanning) {
        const agentConfig: AgentToolConfig = {
          maxIterations: config.get<number>('agent.maxToolIterations') || 15,
          allowRangeEdit: config.get<boolean>('agent.allowRangeEdit', true),
          allowCommandExecution: config.get<boolean>('agent.allowCommandExecution', false),
          enableFuzzyMatching: true,
          enableAutoCorrection: true,
          enableRetry: true,
          maxRetries: 2,
          enableReflection: config.get<boolean>('agent.enableReflection', false),
          taskCompletionCheck: config.get<boolean>('agent.taskCompletionCheck', true),
          maxConsecutiveNoOps: config.get<number>('agent.maxConsecutiveNoOps', 1)
        };

        await AgentToolProcessor.processAgentTools(
          provider,
          history,
          finalContent,
          selectedModel,
          config,
          signal,
          0,
          agentConfig,
          plan
        );
      }
    }

  } catch (error: any) {
    if (axios.isCancel(error) || error.name === 'CanceledError' || error.message === 'canceled') {
      view.webview.postMessage({ 
        type: 'addWarningResponse', 
        text: '⚠️ 已停止生成对话' 
      });
    } else {
      const errorMsg = `❌ 错误: ${error.message}`;
      if (model === 'local') {
        const baseUrl = config.get<string>('localModel.baseUrl') || 'http://localhost:11434/v1';
        view.webview.postMessage({
          type: 'addErrorResponse',
          text: `${errorMsg}\n\n本地模型连接失败，请检查服务地址: ${baseUrl}`
        });
      } else {
        view.webview.postMessage({ type: 'addErrorResponse', text: errorMsg });
      }
    }
  } finally {
    provider.abortController = null;
  }
}

// ========== 辅助函数：从标记后提取描述和代码块 ==========
function extractDescriptionAndCode(
  response: string,
  markerIndex: number,
  expectedKeys: string[]
): { description: EditDescription; codeContent: string } | null {
  const afterMarker = response.slice(markerIndex);
  const lines = afterMarker.split('\n');
  let i = 1; // 跳过标记行
  const desc: EditDescription = {};

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '---') {
      i++;
      break;
    }
    if (DIRECTIVE_BOUNDARY.test(lines[i])) { return null; }
    const colonPos = line.indexOf(':');
    if (colonPos > 0) {
      const key = line.substring(0, colonPos).trim();
      const value = line.substring(colonPos + 1).trim();
      if (expectedKeys.includes(key)) {
        (desc as any)[key] = parseInt(value, 10);
      }
    }
    i++;
  }

  while (i < lines.length && lines[i].trim() === '') {i++;}

  const contentLines: string[] = [];
  for (; i < lines.length; i++) {
    if (DIRECTIVE_BOUNDARY.test(lines[i])) { break; }
    contentLines.push(lines[i]);
  }
  const remaining = contentLines.join('\n');
  const codeBlockRegex = /```(?:\w*)\r?\n([\s\S]*?)```/;
  const match = codeBlockRegex.exec(remaining);
  if (!match) { return null; }
  return { description: desc, codeContent: match[1] };
}

// 指令标记正则：匹配所有 > DIRECTIVE: 格式的行
const DIRECTIVE_BOUNDARY = /^> (?:FILE|RUN|MKDIR|REPLACE|EDIT_FUNCTION|EDIT_CLASS|EDIT_LINE_CONTAINING|APPLY_BATCH|CHECK_BATCH|MULTI_FILE|MCP|READ|PROJECT|DIFF|RANGE_EDIT|EDIT_BLOCK):\s/m;

// 截取当前标记到下一个指令标记之间的文本（防止跨指令提取代码块）
function getTextBetweenDirectives(response: string, markerIndex: number): string {
  const afterMarker = response.slice(markerIndex);
  const lines = afterMarker.split('\n');
  let i = 1; // 跳过当前标记行
  while (i < lines.length && lines[i].trim() === '') { i++; }
  const contentLines: string[] = [];
  for (; i < lines.length; i++) {
    if (DIRECTIVE_BOUNDARY.test(lines[i])) { break; }
    contentLines.push(lines[i]);
  }
  return contentLines.join('\n');
}

// 辅助函数：提取标记后的代码块（限定在下一个指令之前）
function extractCodeAfterMarker(response: string, markerIndex: number): string | null {
  const bounded = getTextBetweenDirectives(response, markerIndex);
  const codeBlockRegex = /```(?:\w*)\r?\n([\s\S]*?)```/;
  const match = codeBlockRegex.exec(bounded);
  return match ? match[1] : null;
}

// 提取缺失模块名称（用于依赖自动安装）
function extractMissingModule(stderr: string): string | null {
  // Node.js: Error: Cannot find module 'express'
  const nodeMatch = stderr.match(/Cannot find module '([^']+)'/);
  if (nodeMatch) {return nodeMatch[1];}
  // Python: ModuleNotFoundError: No module named 'requests'
  const pyMatch = stderr.match(/ModuleNotFoundError: No module named '([^']+)'/);
  if (pyMatch) {return pyMatch[1];}
  return null;
}

// ========== Agent 系统提示词 ==========
export function getAgentSystemPrompt(): string {
  return `你是一个高级 AI 代码 Agent，具备直接在 VS Code 编辑器中读取、修改、创建文件的能力。
你的任务是根据用户需求直接在编辑器中操作文件，**不要在聊天框中输出完整文件内容**。

【核心原则】
1. **修改现有文件时，只输出需要修改的部分，不要输出整个文件**
2. **新建文件时，才输出完整内容**
3. **先 READ 查看文件内容，再决定使用哪种编辑工具**

【输出分层】
- 以 \`[执行反馈]\`、\`[任务规划]\`、\`[自动诊断刷新]\` 开头的内容属于内部上下文，不是用户消息
- 这些内部上下文只用于帮助你继续执行，不要逐条复述，不要把它们改写成面向用户的长篇流水账
- 面向用户的最终回复只保留：结果、关键变更、必要的下一步
- 文件变更、终端输出、MCP 结果会由界面卡片单独展示，正文不要重复粘贴

【文件创建原则 - 必须严格遵守】
- **绝对禁止**创建用户未明确要求的任何文件
- **除非用户明确要求**，否则禁止创建以下类型的文件：
  - 测试文件（*.test.ts, *.spec.ts, test/*.js, tests/*.py 等）
  - 文档文件（README.md, CHANGELOG.md, docs/*.md 等）
  - 配置文件（.gitignore, .eslintrc, tsconfig.json, package.json 等）
  - 许可证文件（LICENSE, LICENSE.txt 等）
- 如果用户说"创建一个组件"或"实现一个功能"，**只创建**实现该功能的核心代码文件
- 只有当用户明确说出"创建测试"、"编写测试用例"、"添加 README"等指令时，才允许创建对应文件
- 如果用户需要测试文件，会在请求中明确说明（例如："创建组件并编写测试"）

【工具选择决策树】
**修改现有文件：**
1. 小范围修改（1-10行）→ \`> REPLACE\` （最精确）
2. 修改整个函数 → \`> EDIT_FUNCTION\`
3. 修改整个类 → \`> EDIT_CLASS\`
4. 修改特定行 → \`> EDIT_LINE_CONTAINING\`
5. 大范围重构/重写 → \`> FILE\`

**创建新文件：**
- 始终使用 \`> FILE\`

**关键规则：**
- ❌ 禁止对不存在的文件使用 REPLACE/EDIT_*
- ❌ 禁止对同一文件使用多个工具（会冲突）
- ✅ 修改前必须先 \`> READ\` 读取文件
- ✅ 小改动优先 REPLACE，大改动用 FILE

【读取文件】
\`> READ: path/to/file\` - 修改前必须先读取，了解当前内容

【精确编辑工具】修改文件时优先使用：
\`\`\`
> REPLACE: src/app.ts
<ORIGINAL>
// 要替换的原文本（必须与文件中完全一致）
</ORIGINAL>
<NEW>
// 替换后的新文本
</NEW>
\`\`\`

【函数/类编辑】
\`\`\`
> EDIT_FUNCTION: src/utils.ts myFunction
\`\`\`typescript
// 新的函数实现
\`\`\`

【新建文件】只有新建文件时才输出完整内容：
\`\`\`
> FILE: src/newfile.ts
\`\`\`typescript
// 完整文件内容
\`\`\`

【其他工具】
- 创建目录：\`> MKDIR: path/to/dir\`
- 执行命令：\`> RUN: command\`
- 批量修改：\`> APPLY_BATCH:\` + JSON 数组
- MCP 工具：\`> MCP: <serverName> <toolName> [JSON参数]\`

【代码规范】
- 默认使用全英文编写代码：注释、提示字符串、变量命名等均使用英文
- 除非用户明确要求中文或项目已有中文约定，否则保持英文
- **禁止在代码中使用任何特殊字符**：包括但不限于 emoji（😀、🎉 等）、符号表情（:)、:( 等）、ASCII 艺术字符、特殊符号（★、☆、♥、♦ 等）。代码中只允许使用编程语言本身的标准字符和常用符号（如 =、+、-、*、/、% 等数学运算符）
- **禁止在代码中嵌入终端命令**：不要在代码字符串中包含 shell 命令、bash 脚本片段、或任何需要通过终端执行的命令。如果需要执行命令，使用 \`> RUN: command\` 工具，而不是写在代码里

【仓颉语言支持】
- 仓颉文件扩展名为 \`.cj\`
- 编译命令：\`cjc <file.cj> -o <output>\` 或包管理器 \`cjpm build\`、\`cjpm run\`

【任务完成判断】
- **简单任务**（如修改一个变量、修正拼写错误、添加一行代码）：执行成功后立即结束，不要继续检查
- **复杂任务**（如创建新功能、重构代码、多文件修改）：需要确认所有步骤完成后再结束
- 如果任务已完成，明确说明"任务已完成"或"已完成"，不要继续执行工具
- 避免过度检查：一次成功的修改后，如果没有新的明确需求，应该结束任务

【重要提醒】
- 修改文件时，先 READ，再用 REPLACE/EDIT_FUNCTION 等工具
- 不要在聊天框输出完整文件，只输出修改的部分
- 保持代码缩进和格式与原文件一致`;
}

export function getEnhancedAgentSystemPrompt(plan?: TaskPlan): string {
    const basePrompt = getAgentSystemPrompt();
    
    if (!plan || plan.steps.length === 0) {
        return basePrompt;
    }

    const planInfo = `
【任务规划】
当前任务已分解为 ${plan.steps.length} 个步骤：
${plan.steps.map((step, idx) => `${idx + 1}. ${step.name}: ${step.description} (${step.toolType})`).join('\n')}

请严格按照上述步骤执行任务。按需继续下一步；最终只向用户给出简洁总结，不要逐条复述内部执行日志。
`;
    return basePrompt + planInfo;
}

const DEFAULT_COMPLEX_INDICATORS = [
    '多个文件', '多个功能', '完整项目', '重构', '实现',
    '创建', '开发', '编写', '构建', '设计',
    '系统', '应用', '服务', '模块', '组件',
    'database', 'api', 'server', 'client'
];

function isComplexTask(userRequest: string, config?: vscode.WorkspaceConfiguration): boolean {
    const forcePlanning = config?.get<boolean>('agent.forceTaskPlanning') ?? false;
    if (forcePlanning) {
        return true;
    }
    const customKeywords = config?.get<string[]>('agent.complexTaskKeywords') ?? [];
    const indicators = customKeywords.length > 0 ? customKeywords : DEFAULT_COMPLEX_INDICATORS;
    const lowerRequest = userRequest.toLowerCase();
    return indicators.some(indicator => lowerRequest.includes(indicator.toLowerCase()));
}

async function tryPlanAndExecute(
    provider: LLMAChatProvider,
    userRequest: string,
    context: TaskExecutionContext,
    history: ChatHistory,
    selectedModel: string,
    config: vscode.WorkspaceConfiguration,
    signal: AbortSignal
): Promise<{ usedPlanning: boolean; plan?: TaskPlan }> {
    const enablePlanning = config.get<boolean>('agent.enableTaskPlanning') ?? true;
    
    if (!enablePlanning || !isComplexTask(userRequest, config)) {
        return { usedPlanning: false };
    }

    provider.postMessageToWebview({
        type: 'addSystemMessage',
        text: '🤔 检测到复杂任务，正在规划执行步骤...'
    });

    let plan: TaskPlan | undefined;
    try {
        const planner = TaskPlanner.getInstance();
        planner.setConfig(config);

        plan = await planner.planTask(userRequest, context, signal);

        let planSummary = `已生成 ${plan.steps.length} 个执行步骤，将按顺序处理。`;
        if (plan.riskAssessment.level !== 'low' && plan.riskAssessment.factors.length > 0) {
            planSummary += ` 风险提示：${plan.riskAssessment.factors.join('，')}。`;
        }

        provider.postMessageToWebview({ type: 'addSystemMessage', text: planSummary });
        pushInternalFeedback(history, `[任务规划]\n${planSummary}`, provider);

        const taskManager = TaskManager.getInstance();
        taskManager.setAbortSignal(signal);
        taskManager.setCallbacks({
          onStepStart: (step) => {
            provider.postMessageToWebview({
              type: 'addSystemMessage',
              text: `🔄 执行步骤 ${step.id}: ${step.name}`
            });
          },
          onStepComplete: (step) => {
            pushInternalFeedback(history, `步骤完成：${step.name}`, provider);
          },
          onStepError: (step, error) => {
            const errorMsg = `❌ 步骤 ${step.name} 失败: ${error}`;
            provider.postMessageToWebview({ type: 'addErrorResponse', text: errorMsg });
            pushInternalFeedback(history, errorMsg, provider);
          },
            onProgress: (progress, current, total) => {
                provider.postMessageToWebview({
                    type: 'taskProgress',
                    progress,
                    currentStep: current,
                    totalSteps: total
                });
            },
            onTaskComplete: (_result) => {}
        });

        const result = await taskManager.planAndExecute(userRequest, context, signal);
        const finalSummary = buildPlanningCompletionMessage(result);
        pushVisibleAssistantMessage(provider, history, finalSummary);
        provider.postMessageToWebview({ type: 'addResponse', text: finalSummary });

        return { usedPlanning: true };
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (signal.aborted) {
            provider.postMessageToWebview({ type: 'addWarningResponse', text: '任务规划已取消' });
            return { usedPlanning: false };
        }

        provider.postMessageToWebview({
            type: 'addWarningResponse',
            text: `任务规划失败，回退到普通模式: ${errMsg}`
        });

        return { usedPlanning: false, plan };
    }
}

// ========== 历史消息裁剪（智能分级，防止上下文膨胀） ==========
function trimHistory(history: ChatHistory, maxMessages: number = 40): ChatHistory {
  let trimmed = history;

  if (trimmed.length > maxMessages) {
    const keepRecent = Math.floor(maxMessages * 0.75);
    const keepEarly = 4;
    trimmed = [
      ...trimmed.slice(0, keepEarly),
      { role: 'user', content: `[... 省略了 ${trimmed.length - keepRecent - keepEarly} 条中间对话 ...]` },
      ...trimmed.slice(-keepRecent)
    ];
  }

  const PROTECT_RECENT = 6;
  const protectStart = Math.max(0, trimmed.length - PROTECT_RECENT);

  return trimmed.map((msg, idx) => {
    if (idx >= protectStart) { return msg; }
    if (typeof msg.content !== 'string') { return msg; }

    const content = msg.content;
    let limit: number;

    if (msg.role === 'user') {
      const isBulky = content.includes('文件内容') || content.includes('命令执行结果')
        || content.includes('```bash\n$') || content.includes('```json\n')
        || content.startsWith('[自动诊断刷新]')
        || content.startsWith('[执行反馈]');
      limit = isBulky ? 1500 : 3000;
    } else if (msg.role === 'assistant') {
      const hasCode = content.includes('```');
      limit = hasCode ? CONTEXT.WITH_CODE_LIMIT : CONTEXT.WITHOUT_CODE_LIMIT;
    } else {
      limit = 3000;
    }

    if (content.length > limit) {
      return { ...msg, content: content.substring(0, limit) + '\n... (内容已截断)' };
    }
    return msg;
  });
}

// ========== 执行单条 RUN 命令 ==========
async function executeOneRunCommand(
  provider: LLMAChatProvider,
  command: string,
  config: vscode.WorkspaceConfiguration,
  abortSignal?: AbortSignal
): Promise<{ output: string; exitCode: number | null } | null> {
  if (isCommandDangerous(command)) {
    const confirm = await vscode.window.showWarningMessage(
      `检测到可能危险的命令：\n\n${command}\n\n确定要执行吗？`,
      { modal: true },
      '仍然执行', '取消'
    );
    if (confirm !== '仍然执行') {
      provider.postMessageToWebview({ type: 'addWarningResponse', text: `用户拒绝执行危险命令：${command}` });
      return null;
    }
  }

  const allowExecution = config.get<boolean>('agent.allowCommandExecution');
  if (!allowExecution) {
    const confirmed = await vscode.window.showWarningMessage(
      `AI 请求执行命令: ${command}\n是否允许？`,
      { modal: false },
      '允许一次', '允许并记住（修改配置）', '拒绝'
    );
    if (confirmed !== '允许一次' && confirmed !== '允许并记住（修改配置）') {
      provider.postMessageToWebview({ type: 'addWarningResponse', text: `用户拒绝了命令执行: ${command}` });
      return null;
    }
    if (confirmed === '允许并记住（修改配置）') {
      try {
        await config.update('agent.allowCommandExecution', true, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('已更新配置：允许 AI 自动执行终端命令。');
      } catch {}
    }
  }

  let cwd: string | undefined;
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    cwd = workspaceFolders[0].uri.fsPath;
  } else {
    const editor = vscode.window.activeTextEditor;
    cwd = editor ? path.dirname(editor.document.uri.fsPath) : process.cwd();
  }

  let output = '';
  let killed = false;
  let exitCode: number | null = 0;
  try {
    const result = await execWithTimeout(command, { cwd, env: process.env }, TIMEOUT.COMMAND_SHORT, abortSignal);
    killed = result.killed;
    exitCode = result.exitCode;
    output = result.stdout + (result.stderr ? '\n' + result.stderr : '');

    if (!killed && result.stderr) {
      const missingModule = extractMissingModule(result.stderr);
      if (missingModule) {
        const shouldInstall = await vscode.window.showInformationMessage(
          `检测到缺失模块 "${missingModule}"，是否自动安装？`, '安装', '忽略'
        );
        if (shouldInstall === '安装') {
          let installCmd: string;
          if (fs.existsSync(path.join(cwd || '', 'package.json'))) {
            installCmd = `npm install ${missingModule}`;
          } else if (fs.existsSync(path.join(cwd || '', 'requirements.txt'))) {
            installCmd = `pip install ${missingModule}`;
          } else {
            installCmd = `npm install ${missingModule}`;
          }
          const installResult = await execWithTimeout(installCmd, { cwd, env: process.env }, TIMEOUT.INSTALL, abortSignal);
          if (installResult.stderr && !installResult.stderr.includes('added')) {
            provider.postMessageToWebview({ type: 'addErrorResponse', text: `安装失败: ${installResult.stderr}` });
          } else {
            const retryResult = await execWithTimeout(command, { cwd, env: process.env }, TIMEOUT.COMMAND_SHORT, abortSignal);
            output = retryResult.stdout + (retryResult.stderr ? '\n' + retryResult.stderr : '');
            exitCode = retryResult.exitCode;
          }
        }
      }
    }
  } catch (err: any) {
    output = err.stdout || err.stderr || err.message;
    exitCode = typeof err.code === 'number' ? err.code : 1;
  }

  if (abortSignal?.aborted || killed) {
    return null;
  }

  if (output.length > 5000) {
    const truncatedOutput = output.substring(0, 5000) + '\n... (输出已截断)';
    try {
      const tmpDir = path.join(os.tmpdir(), 'llma-agent-logs');
      if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
      const tmpFile = path.join(tmpDir, `cmd_${Date.now()}_${Math.random().toString(36).substring(2)}.log`);
      await fs.promises.writeFile(tmpFile, output, 'utf8');
      output = truncatedOutput + `\n完整输出已保存至: ${tmpFile}`;
    } catch {
      output = truncatedOutput;
    }
  }

  return { output, exitCode };
}

/**
 * @deprecated 已由 AgentToolProcessor.processAgentTools 替代。主流程使用 AgentToolProcessor（含反思、任务完成检查、consecutiveNoOps）。
 * 此函数为历史遗留，仅自递归调用，无外部入口。
 */
async function processAgentTools(
  provider: LLMAChatProvider,
  history: ChatHistory,
  aiResponse: string,
  model: string,
  config: vscode.WorkspaceConfiguration,
  abortSignal?: AbortSignal,
  iteration: number = 0
): Promise<void> {
  const maxIterations = config.get<number>('agent.maxToolIterations') || 15;
  if (iteration >= maxIterations) {
    provider.postMessageToWebview({ type: 'addSystemMessage', text: `⚠️ 已达到最大工具调用次数 (${maxIterations})，停止自动调用。` });
    return;
  }

  const allowRangeEdit = config.get<boolean>('agent.allowRangeEdit', true);
  let hadActions = false;

  // === 处理 > MKDIR: 指令 ===
  const mkdirRegex = /^> MKDIR: (.*)$/gm;
  const mkdirMatches = Array.from(aiResponse.matchAll(mkdirRegex));
  for (const match of mkdirMatches) {
    const dirPath = match[1].trim();
    if (!dirPath) {continue;}
    const targetUri = resolveFilePath(dirPath);
    if (!targetUri) {
      const msg = `目录创建失败: 无法解析路径 ${dirPath}`;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
      provider.postMessageToWebview({ type: 'addErrorResponse', text: msg });
      continue;
    }
    try {
      await vscode.workspace.fs.createDirectory(targetUri);
      const msg = `目录创建成功: ${dirPath}`;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
    } catch (err: any) {
      const msg = `目录创建失败: ${err.message}`;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
      provider.postMessageToWebview({ type: 'addErrorResponse', text: msg });
    }
  }
  if (mkdirMatches.length > 0) { hadActions = true; }

  const replaceRegex = /^> REPLACE:\s*(.*)$/gm;
const replaceMatches = Array.from(aiResponse.matchAll(replaceRegex));
for (const match of replaceMatches) {
    const filepath = match[1].trim();
    const result = extractReplaceParts(aiResponse, match.index); // 自定义提取函数
    if (!result) {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `解析 REPLACE 失败: ${filepath}` });
        continue;
    }
    await handleReplaceEdit(provider, filepath, result.original, result.new, history, abortSignal);
}
if (replaceMatches.length > 0) { hadActions = true; }

// 处理 EDIT_FUNCTION 指令
const funcRegex = /^> EDIT_FUNCTION:\s*(.*)$/gm;
const funcMatches = Array.from(aiResponse.matchAll(funcRegex));
for (const match of funcMatches) {
    const rest = match[1].trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `EDIT_FUNCTION 格式错误，应为: > EDIT_FUNCTION: <filepath> <functionName>` });
      continue;
    }
    const filepath = parts[0];
    const functionName = parts[1];
    const newContent = extractCodeAfterMarker(aiResponse, match.index);
    if (!newContent) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `EDIT_FUNCTION 未找到代码块: ${filepath} ${functionName}` });
      continue;
    }
    await handleFunctionEdit(provider, filepath, functionName, newContent, history, abortSignal);
}
if (funcMatches.length > 0) { hadActions = true; }

// 处理 EDIT_CLASS 指令
const classRegex = /^> EDIT_CLASS:\s*(.*)$/gm;
const classMatches = Array.from(aiResponse.matchAll(classRegex));
for (const match of classMatches) {
    const rest = match[1].trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `EDIT_CLASS 格式错误，应为: > EDIT_CLASS: <filepath> <className>` });
      continue;
    }
    const filepath = parts[0];
    const className = parts[1];
    const newContent = extractCodeAfterMarker(aiResponse, match.index);
    if (!newContent) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `EDIT_CLASS 未找到代码块: ${filepath} ${className}` });
      continue;
    }
    await handleClassEdit(provider, filepath, className, newContent, history, abortSignal);
}
if (classMatches.length > 0) { hadActions = true; }

// 处理 EDIT_LINE_CONTAINING 指令
const lineContainingRegex = /^> EDIT_LINE_CONTAINING:\s*(.*)$/gm;
const lineContainingMatches = Array.from(aiResponse.matchAll(lineContainingRegex));
for (const match of lineContainingMatches) {
    const rest = match[1].trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx <= 0) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `EDIT_LINE_CONTAINING 格式错误，应为: > EDIT_LINE_CONTAINING: <filepath> <textPattern>` });
      continue;
    }
    const filepath = rest.substring(0, spaceIdx).trim();
    let textPattern = rest.substring(spaceIdx + 1).trim();
    if (textPattern.startsWith('"') && textPattern.endsWith('"')) {
      textPattern = textPattern.slice(1, -1);
    }
    const newLineContent = extractCodeAfterMarker(aiResponse, match.index);
    if (!newLineContent) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `EDIT_LINE_CONTAINING 未找到代码块: ${filepath}` });
      continue;
    }
    await handleLineContainingEdit(provider, filepath, textPattern, newLineContent.trim(), history, abortSignal);
}
if (lineContainingMatches.length > 0) { hadActions = true; }

// 处理 APPLY_BATCH 指令
const batchRegex = /^> APPLY_BATCH:\s*(.*)$/gm;
const batchMatches = Array.from(aiResponse.matchAll(batchRegex));
for (const match of batchMatches) {
    const jsonStr = match[1].trim();
    let filesArray;
    if (jsonStr) {
      try { filesArray = JSON.parse(jsonStr); } catch { /* 同一行解析失败 */ }
    }
    if (!filesArray) {
      filesArray = extractJSONAfterMarker(aiResponse, match.index);
    }
    if (!filesArray || !Array.isArray(filesArray)) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `APPLY_BATCH 解析失败，未找到有效的 JSON 数组` });
      continue;
    }
    await handleApplyBatch(provider, filesArray, history, abortSignal);
}
if (batchMatches.length > 0) { hadActions = true; }

// 处理 CHECK_BATCH 指令
const checkBatchRegex = /^> CHECK_BATCH:\s*(.*)$/gm;

  // === 处理 > FILE: 指令 ===
  const fileRegex = /^> FILE: (.*)$/gm;
  const fileMatches = Array.from(aiResponse.matchAll(fileRegex));
  for (const match of fileMatches) {
    const filepath = match[1].trim();
    if (!filepath) { continue; }

    // 在当前指令和下一个指令之间查找代码块
    const codeContent = extractCodeAfterMarker(aiResponse, match.index);
    if (!codeContent) {
      const msg = `文件创建失败: 未找到代码块 ${filepath}`;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
      provider.postMessageToWebview({ type: 'addErrorResponse', text: msg });
      continue;
    }

    await handleFileChange(filepath, codeContent, true, provider.fileBackupMap, provider.view, { skipConfirm: false });
    const msg = `文件已更新: ${filepath}`;
    history.push({ role: 'user', content: msg });
    provider.currentSessionHistory.push({ role: 'user', content: msg });
  }
  if (fileMatches.length > 0) { hadActions = true; }

  // === 处理 > EDIT_BLOCK: 指令 ===
  const editBlockRegex = /^> EDIT_BLOCK: (.*)$/gm;
  const editMatches = Array.from(aiResponse.matchAll(editBlockRegex));
  for (const match of editMatches) {
    if (!allowRangeEdit) {
      provider.postMessageToWebview({ type: 'addWarningResponse', text: `范围编辑已被禁用，请在设置中启用。` });
      continue;
    }
    const filepath = match[1].trim();
    const result = extractDescriptionAndCode(aiResponse, match.index, ['startLine', 'endLine']);
    if (!result) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `解析 EDIT_BLOCK 失败: ${filepath}` });
      continue;
    }
    await handleEditBlock(provider, filepath, result.description, result.codeContent, history, abortSignal);
  }
  if (editMatches.length > 0 && allowRangeEdit) { hadActions = true; }

  // === 处理 > RANGE_EDIT: 指令 ===
  const rangeEditRegex = /^> RANGE_EDIT: (.*)$/gm;
  const rangeMatches = Array.from(aiResponse.matchAll(rangeEditRegex));
  for (const match of rangeMatches) {
    if (!allowRangeEdit) {
      provider.postMessageToWebview({ type: 'addWarningResponse', text: `范围编辑已被禁用，请在设置中启用。` });
      continue;
    }
    const filepath = match[1].trim();
    const result = extractDescriptionAndCode(aiResponse, match.index, ['start', 'end']);
    if (!result) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `解析 RANGE_EDIT 失败: ${filepath}` });
      continue;
    }
    await handleRangeEdit(provider, filepath, result.description, result.codeContent, history, abortSignal);
  }
  if (rangeMatches.length > 0 && allowRangeEdit) { hadActions = true; }

  // === 处理 > DIFF: 指令 ===
  const diffRegex = /^> DIFF: (.*)$/gm;
  const diffMatches = Array.from(aiResponse.matchAll(diffRegex));
  for (const match of diffMatches) {
    if (!allowRangeEdit) {
      provider.postMessageToWebview({ type: 'addWarningResponse', text: `范围编辑已被禁用，请在设置中启用。` });
      continue;
    }
    const filepath = match[1].trim();
    const diffContent = extractCodeAfterMarker(aiResponse, match.index);
    if (!diffContent) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `解析 DIFF 失败: ${filepath}` });
      continue;
    }
    await handleDiff(provider, filepath, diffContent, history, abortSignal);
  }
  if (diffMatches.length > 0 && allowRangeEdit) { hadActions = true; }

  // === 处理 > PROJECT: 指令 ===
  const projectRegex = /^> PROJECT:\s*(.*)$/gm;
  const projectMatches = Array.from(aiResponse.matchAll(projectRegex));
  for (const match of projectMatches) {
    const projectSpec = match[1].trim();
    let projectData: any;
    if (projectSpec) {
      try {
        projectData = JSON.parse(projectSpec);
      } catch {
        // 同一行解析失败，尝试从代码块提取
      }
    }
    if (!projectData) {
      projectData = extractJSONAfterMarker(aiResponse, match.index);
    }
    if (!projectData || typeof projectData !== 'object') {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `项目模板解析失败，未找到有效的 JSON` });
      continue;
    }
    await handleProjectTemplate(provider, projectData, history, abortSignal);
  }
  if (projectMatches.length > 0) { hadActions = true; }

  // === 处理 > MULTI_FILE: 指令 ===
const multiFileRegex = /^> MULTI_FILE:\s*(.*)$/gm;
const multiFileMatches = Array.from(aiResponse.matchAll(multiFileRegex));
for (const match of multiFileMatches) {
  const inlineSpec = match[1].trim();
  let filesArray;

  // 1. 尝试解析同一行内的 JSON
  if (inlineSpec) {
    try {
      filesArray = JSON.parse(inlineSpec);
    } catch {
      // 忽略，尝试从代码块提取
    }
  }

  // 2. 如果同一行内解析失败或没有内容，尝试从后续代码块提取
  if (!filesArray) {
    filesArray = extractJSONAfterMarker(aiResponse, match.index);
  }

  // 3. 验证解析结果
  if (!filesArray || !Array.isArray(filesArray)) {
    provider.postMessageToWebview({
      type: 'addErrorResponse',
      text: `MULTI_FILE 解析失败，未找到有效的 JSON 数组`
    });
    continue;
  }

  // 4. 调用处理函数
  await handleMultiFileEdit(provider, filesArray, history, abortSignal);
}
if (multiFileMatches.length > 0) { hadActions = true; }

  // === 处理 > MCP: 指令 ===
  const mcpRegex = /^> MCP: (.*)$/gm;
  const mcpMatches = Array.from(aiResponse.matchAll(mcpRegex));
  for (const match of mcpMatches) {
    const fullLine = match[1].trim(); // 格式: serverName toolName [jsonArgs]
    const parts = fullLine.match(/(\S+)\s+(\S+)(?:\s+(.+))?/); // 分解 serverName, toolName, 剩余参数
    if (!parts || parts.length < 3) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `MCP 指令格式错误，应为: > MCP: serverName toolName [jsonArgs]` });
      continue;
    }
    const serverName = parts[1];
    const toolName = parts[2];
    let args = {};
    if (parts[3]) {
      try {
        args = JSON.parse(parts[3]);
      } catch (e) {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `MCP 参数解析失败，应为 JSON 格式` });
        continue;
      }
    }

    try {
      if (!mcpManager) {
        throw new Error('MCP 管理器未初始化');
      }
      const result = await mcpManager.callTool(serverName, toolName, args);
      const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      const msg = `MCP 工具执行结果:\n\`\`\`json\n${resultStr}\n\`\`\``;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
      provider.postMessageToWebview({
        type: 'addMcpToolCard',
        serverName,
        toolName,
        args,
        result: resultStr,
        status: 'success'
      });
    } catch (err: any) {
      const errorMsg = `MCP 调用失败: ${err.message}`;
      provider.postMessageToWebview({ type: 'addErrorResponse', text: errorMsg });
      history.push({ role: 'user', content: errorMsg });
      provider.currentSessionHistory.push({ role: 'user', content: errorMsg });
      provider.postMessageToWebview({
        type: 'addMcpToolCard',
        serverName,
        toolName,
        args,
        result: err.message,
        status: 'error'
      });
    }
  }

  if (mcpMatches.length > 0) { hadActions = true; }

  // === 处理 > READ: 指令（静默读取，不输出到界面，仅将内容注入历史供 AI 使用）===
  const readRegex = /^> READ:\s*(.*)$/gm;
  const readMatches = Array.from(aiResponse.matchAll(readRegex));
  for (const match of readMatches) {
    const filepath = match[1].trim();
    if (!filepath) { continue; }
    const content = await handleReadFile(filepath);
    if (content !== null) {
      provider.pendingReadContext.push({ role: 'user', content });
    } else {
      const msg = `读取失败: 文件不存在或无法读取 ${filepath}`;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
      provider.postMessageToWebview({ type: 'addErrorResponse', text: msg });
    }
  }
  if (readMatches.length > 0) { hadActions = true; }

  // === 处理 > RUN: 指令（支持多条命令顺序执行）===
  const runRegex = /^> RUN: (.*)$/gm;
  const runMatches = Array.from(aiResponse.matchAll(runRegex));
  for (const match of runMatches) {
    if (abortSignal?.aborted) { break; }
    const command = match[1].trim();
    if (!command) { continue; }

    const result = await executeOneRunCommand(provider, command, config, abortSignal);
    if (result !== null) {
      hadActions = true;
      const resultMessage = `命令执行结果:\n\`\`\`bash\n$ ${command}\n${result.output}\n\`\`\``;
      history.push({ role: 'user', content: resultMessage });
      provider.currentSessionHistory.push({ role: 'user', content: resultMessage });
      provider.postMessageToWebview({
        type: 'addTerminalOutput',
        id: `term_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        command: command,
        output: result.output,
        exitCode: result.exitCode ?? 0
      });
    } else {
      const msg = `命令未执行或已取消: ${command}`;
      history.push({ role: 'user', content: msg });
      provider.currentSessionHistory.push({ role: 'user', content: msg });
    }
  }

  // === 如果没有任何操作被执行，直接返回 ===
  if (!hadActions || abortSignal?.aborted) { return; }

  // 刷新诊断：把本轮修改产生的新错误注入到历史中
  const freshDiag = getDiagnosticsContext();
  if (freshDiag) {
    const diagMsg = `[自动诊断刷新] 当前工作区最新错误/警告：${freshDiag}`;
    history.push({ role: 'user', content: diagMsg });
    provider.currentSessionHistory.push({ role: 'user', content: diagMsg });
  }

  const trimmedHistory = trimHistory(history);


  // 再次调用 AI（流式，使用统一系统提示 + 裁剪历史 + READ 静默上下文 + 提高 token）
  const hasReadCtx = provider.pendingReadContext.length > 0;
  provider.postMessageToWebview(hasReadCtx ? { type: 'streamStart', silent: true } : { type: 'streamStart' });
  try {
    const followUpPrompt = getAgentSystemPrompt();
    const readCtx = provider.pendingReadContext.splice(0, provider.pendingReadContext.length);
    const newResponse = await callChatAI(
      model,
      getApiKey(config, model),
      [{ role: 'system', content: followUpPrompt }, ...trimmedHistory, ...readCtx],
      config,
      AI.AGENT_MAX_TOKENS,
      0.1,
      abortSignal,
      (contentDelta, reasoningDelta) => {
        provider.postMessageToWebview({ type: 'streamUpdate', content: contentDelta, reasoning: reasoningDelta });
      }
    );
    const cleanResponse = newResponse.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();
    history.push({ role: 'assistant', content: cleanResponse });
    provider.currentSessionHistory.push({ role: 'assistant', content: cleanResponse });
    // 不发送 streamEnd，因为工具还在执行中
    // provider.postMessageToWebview({ type: 'streamEnd' });

    await processAgentTools(provider, history, newResponse, model, config, abortSignal, iteration + 1);
  } catch (error: any) {
    // 不发送 streamEnd，因为工具还在执行中
    // provider.postMessageToWebview({ type: 'streamEnd' });
    if (!axios.isCancel(error)) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `工具调用错误: ${error.message}` });
    }
  }
}