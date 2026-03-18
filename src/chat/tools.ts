/**
 * 聊天工具模块
 * 
 * 提供聊天系统中使用的各种工具函数，包括：
 * - 文件操作：读取、写入、创建文件和目录
 * - 编辑操作：多种代码编辑方式（替换、函数编辑、类编辑等）
 * - 命令执行：安全地执行 shell 命令
 * - 差异处理：生成和应用文件差异
 * - 用户确认：等待用户确认文件修改
 * 
 * 主要功能：
 * - 文件读取和写入
 * - 代码编辑（支持多种编辑模式）
 * - 命令执行（带超时和安全检查）
 * - 差异预览和确认
 * - 文件备份和恢复
 * 
 * @module chat/tools
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as dmp from 'diff-match-patch';
import { isCommandDangerous } from '../utils';
import { LLMAChatProvider } from './index';
import { EditDescription, ChatHistory } from '../types';
import { TIMEOUT } from '../constants';
import { SmartEditor, SmartEditResult, resolveFilePath } from './smartEditor';
import { revealEditLocation, calculateEditRange, openFileAtLocation } from './editLocator';
import { globalASTRegistry } from '../ast';

/**
 * 等待用户确认文件修改
 * 
 * 向 webview 发送差异预览，然后挂起等待用户确认或取消。
 * 使用 Promise 机制实现异步等待。
 * 
 * @param provider - 聊天提供者实例
 * @param pendingId - 待确认操作的唯一 ID
 * @param previewPayload - 包含预览信息的载荷对象
 * @returns Promise，用户确认后 resolve，取消后 reject
 * 
 * @example
 * ```typescript
 * await waitForUserConfirm(
 *   provider,
 *   'edit-123',
 *   { file: 'test.ts', diff: '...' }
 * );
 * ```
 */
export async function waitForUserConfirm(
  provider: LLMAChatProvider,
  pendingId: string,
  previewPayload: Record<string, unknown>
): Promise<void> {
  provider.postMessageToWebview({ ...previewPayload, type: 'fileChangePreview', pendingId });
  await new Promise<void>((resolve, reject) => {
    provider.pendingConfirmMap.set(pendingId, { resolve, reject });
  });
}

/**
 * 确认并应用文档编辑
 * 
 * 统一的"确认后写入"流程：
 * 1. 生成 diff 预览并等待用户确认
 * 2. 确认后应用 WorkspaceEdit 并保存
 * 3. 打开 diff 视图
 * 4. 发送 fileChangeApplied 消息
 * 
 * @param provider - 聊天提供者实例
 * @param targetUri - 目标文件的 URI
 * @param filepath - 目标文件的文件路径
 * @param document - VS Code 文本文档对象
 * @param originalContent - 原始文件内容
 * @param newContent - 新的文件内容
 * @param edit - VS Code 工作区编辑对象
 * @param editType - 编辑类型标识
 * @param history - 聊天历史
 * @param historyMsg - 历史消息
 * @returns Promise，编辑完成后 resolve
 */
async function confirmAndApplyDocEdit(
  provider: LLMAChatProvider,
  targetUri: vscode.Uri,
  filepath: string,
  document: vscode.TextDocument,
  originalContent: string,
  newContent: string,
  edit: vscode.WorkspaceEdit,
  editType: string,
  history: ChatHistory,
  historyMsg: string
): Promise<void> {
  const fileName = path.basename(filepath);
  const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const diffResult = generateDiffPreview(originalContent, newContent, filepath, false);

  // 先写入文件
  await vscode.workspace.applyEdit(edit);
  await document.save();

  // 打开 VSCode diff 视图
  try {
    await openDiffView(targetUri, originalContent);
  } catch (diffErr: any) {
    provider.postMessageToWebview({
      type: 'addWarningResponse',
      text: `打开前后对比失败: ${diffErr.message || String(diffErr)}`
    });
  }

  // 发送小卡片（不含全文），挂起等待用户确认
  try {
    await waitForUserConfirm(provider, pendingId, {
      filepath,
      fileName,
      isNew: false,
      diff: diffResult.diff,
      previewLines: diffResult.previewLines
    });
  } catch {
    // 用户取消 → 恢复原文件
    const restoreEdit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    restoreEdit.replace(targetUri, fullRange, originalContent);
    await vscode.workspace.applyEdit(restoreEdit);
    await document.save();
    provider.postMessageToWebview({ type: 'fileChangeApplied', filepath, auto: false, editType, cancelled: true });
    throw new Error(`用户取消了对 ${fileName} 的修改`);
  }

  provider.postMessageToWebview({ type: 'fileChangeApplied', filepath, auto: false, editType });
  pushInternalHistory(history, historyMsg, provider);
}

function pushInternalHistory(history: ChatHistory, content: string, provider?: LLMAChatProvider): void {
  history.push({
    role: 'system',
    content
  });
  if (provider) {
    provider.currentSessionHistory.push({
      role: 'system',
      content
    });
  }
}

async function openDiffView(targetUri: vscode.Uri, originalContent: string, isNew: boolean = false): Promise<void> {
  const ext = path.extname(targetUri.fsPath);
  const basename = path.basename(targetUri.fsPath, ext);
  const tempFile = path.join(os.tmpdir(), `${basename}_原文件${ext}`);
  fs.writeFileSync(tempFile, isNew ? '' : originalContent, 'utf-8');
  const title = isNew
    ? `${path.basename(targetUri.fsPath)} (新建文件预览)`
    : `${path.basename(targetUri.fsPath)} (修改前 ↔ 修改后)`;
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempFile), targetUri, title);
}

/**
 * 查找-替换编辑
 * @param provider ChatProvider
 * @param filepath 相对路径
 * @param original 要查找的原文本
 * @param newText 替换后的文本
 * @param history 历史记录
 * @param signal 取消信号
 * @param options 选项 { global?: boolean } 是否全局替换
 */
export async function handleReplaceEdit(
    provider: LLMAChatProvider,
    filepath: string,
    original: string,
    newText: string,
    history: ChatHistory,
    signal?: AbortSignal,
    options: { global?: boolean } = { global: false }
): Promise<void> {
    const targetUri = resolveFilePath(filepath);
    if (!targetUri) {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `无法解析路径: ${filepath}` });
        return;
    }

    let document: vscode.TextDocument;
    let fileExists = true;
    try {
        document = await vscode.workspace.openTextDocument(targetUri);
    } catch {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `文件不存在: ${filepath}` });
        return;
    }

    const fullText = document.getText();
    const fullTextNorm = fullText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const hasCRLF = fullText.includes('\r\n');
    let newFullText = fullText;
    let found = false;

    if (options.global) {
        if (fullTextNorm.includes(original)) {
            newFullText = fullTextNorm.split(original).join(newText);
            found = true;
        }
    } else {
        const index = fullTextNorm.indexOf(original);
        if (index !== -1) {
            newFullText = fullTextNorm.substring(0, index) + newText + fullTextNorm.substring(index + original.length);
            found = true;
        }
    }

    if (!found) {
        const dmpInstance = new dmp.diff_match_patch();
        dmpInstance.Match_Threshold = 0.4;
        dmpInstance.Match_Distance = 2000;
        dmpInstance.Patch_DeleteThreshold = 0.4;
        // 从光标位置附近开始搜索，提高多处相同文本时的命中准确率
        const cursorPos = vscode.window.activeTextEditor?.selection.active;
        const searchStart = (cursorPos && document.uri.fsPath === targetUri.fsPath)
            ? document.offsetAt(cursorPos)
            : 0;
        const matchIdx = dmpInstance.match_main(fullTextNorm, original, searchStart);
        if (matchIdx !== -1) {
            newFullText = fullTextNorm.substring(0, matchIdx) + newText + fullTextNorm.substring(matchIdx + original.length);
            found = true;
        } else {
            const patches = dmpInstance.patch_make(original, newText);
            if (patches.length > 0) {
                const [patchedText, results] = dmpInstance.patch_apply(patches, fullTextNorm);
                if (!results.includes(false)) {
                    newFullText = patchedText;
                    found = true;
                }
            }
        }
    }

    if (!found) {
        const hint = suggestSimilarSnippet(fullTextNorm, original);
        provider.postMessageToWebview({ type: 'addWarningResponse', text: `未找到原文本。${hint}` });
        return;
    }

    const toWrite = hasCRLF ? newFullText.replace(/\n/g, '\r\n') : newFullText;

    provider.setBackup(targetUri.fsPath, fullText);

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(fullText.length));
    edit.replace(targetUri, fullRange, toWrite);

    await confirmAndApplyDocEdit(
        provider, targetUri, filepath, document,
        fullText, toWrite, edit, 'replace', history,
        `已应用替换编辑到 ${filepath}`
    );

    const newContentRange = calculateEditRange(original, newText, document);
    if (newContentRange) {
        revealEditLocation({ filepath: targetUri.fsPath, range: newContentRange }, { highlight: true, focus: true });
    }
}

function suggestSimilarSnippet(fullText: string, original: string): string {
    const lines = fullText.split('\n');
    const origLines = original.split('\n').map(l => l.trim()).filter(Boolean);
    const searchKey = (origLines[0] || original.trim()).substring(0, Math.min(40, (origLines[0] || original).length));
    const searchKeyNorm = searchKey.replace(/\s+/g, ' ');
    if (!searchKeyNorm || searchKeyNorm.length < 2) { return '请检查 <ORIGINAL> 内容是否与文件一致。'; }
    const candidates: string[] = [];
    for (let i = 0; i < lines.length && candidates.length < 3; i++) {
        const lineNorm = lines[i].replace(/\s+/g, ' ');
        if (lineNorm.includes(searchKeyNorm) || (searchKeyNorm.length >= 4 && lineNorm.includes(searchKeyNorm.substring(0, searchKeyNorm.length - 1)))) {
            const preview = lines[i].length > 60 ? lines[i].substring(0, 57) + '...' : lines[i];
            candidates.push(`第 ${i + 1} 行: ${preview}`);
        }
    }
    if (candidates.length === 0) { return '请检查 <ORIGINAL> 内容是否与文件一致（含缩进、换行）。'; }
    return `可能相似的行: ${candidates.join('; ')}`;
}

export function extractReplaceParts(response: string, markerIndex: number): { original: string; new: string } | null {
    const afterMarker = response.slice(markerIndex);
    // 支持灵活格式：标签后可选空白，内容可含换行
    const originalMatch = afterMarker.match(/<ORIGINAL>\s*([\s\S]*?)\s*<\/ORIGINAL>/);
    const newMatch = afterMarker.match(/<NEW>\s*([\s\S]*?)\s*<\/NEW>/);
    if (!originalMatch || !newMatch) { return null; }
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
    return { original: normalize(originalMatch[1]), new: normalize(newMatch[1]) };
}

export async function handleLineContainingEdit(
    provider: LLMAChatProvider,
    filepath: string,
    textPattern: string,
    newLineContent: string,
    history: ChatHistory,
    signal?: AbortSignal
): Promise<void> {
    const targetUri = resolveFilePath(filepath);
    if (!targetUri) {return;}

    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(targetUri);
    } catch {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `文件不存在: ${filepath}` });
        return;
    }

    const fullText = document.getText();
    const lines = fullText.split('\n');
    let foundIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(textPattern)) {
            foundIndex = i;
            break;
        }
    }

    if (foundIndex === -1) {
        provider.postMessageToWebview({ type: 'addWarningResponse', text: `未找到包含文本的行: ${textPattern}` });
        return;
    }

    // 备份
    provider.setBackup(targetUri.fsPath, fullText);

    const line = lines[foundIndex];
    const startPos = new vscode.Position(foundIndex, 0);
    const endPos = new vscode.Position(foundIndex, line.length);
    const range = new vscode.Range(startPos, endPos);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetUri, range, newLineContent);

    const newFullText = lines.map((l, i) => i === foundIndex ? newLineContent : l).join('\n');
    await confirmAndApplyDocEdit(
        provider, targetUri, filepath, document,
        fullText, newFullText, edit, 'line', history,
        `已替换包含 "${textPattern}" 的行在 ${filepath}`
    );
}
export async function handleClassEdit(
    provider: LLMAChatProvider,
    filepath: string,
    className: string,
    newContent: string,
    history: ChatHistory,
    signal?: AbortSignal
): Promise<void> {
    const targetUri = resolveFilePath(filepath);
    if (!targetUri) {return;}

    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(targetUri);
    } catch {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `文件不存在: ${filepath}` });
        return;
    }

    const fullText = document.getText();
    const language = document.languageId;

    let range: vscode.Range | undefined;

    // 优先用 AST 定位
    const classAnalyzer = globalASTRegistry.getAnalyzer(targetUri.fsPath);
    if (classAnalyzer) {
        try {
            const astResult = await classAnalyzer.analyze(fullText, targetUri.fsPath);
            const findNode = (nodes: any[]): any => {
                for (const n of nodes) {
                    if (n.type === 'class' && n.name === className) { return n; }
                    const found = findNode(n.children || []);
                    if (found) { return found; }
                }
                return null;
            };
            const node = findNode(astResult.nodes);
            if (node) {
                const startPos = new vscode.Position(node.startLine - 1, node.startColumn);
                const endPos = new vscode.Position(node.endLine - 1, document.lineAt(node.endLine - 1).text.length);
                range = new vscode.Range(startPos, endPos);
            }
        } catch { /* fallback to regex */ }
    }

    // AST 未找到时降级为正则
    if (!range) {
        const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let classRegex: RegExp;
        if (language === 'typescript' || language === 'javascript') {
            classRegex = new RegExp(`(class\\s+${escapedClassName}\\s*(?:extends\\s+[\\w.]+\\s*)?(?:implements\\s+[\\w.,\\s]+\\s*)?{[\\s\\S]*?})\\s*(?=\\n\\S|$)`, 'g');
        } else if (language === 'java') {
            classRegex = new RegExp(`(class\\s+${escapedClassName}\\s*(?:extends\\s+[\\w.]+\\s*)?(?:implements\\s+[\\w.,\\s]+\\s*)?{[\\s\\S]*?})\\s*(?=\\n\\S|$)`, 'g');
        } else if (language === 'python') {
            classRegex = new RegExp(`(class\\s+${escapedClassName}\\s*(?:\\([^)]*\\))?\\s*:[\\s\\S]*?)(?=\\n\\S|$)`, 'g');
        } else {
            provider.postMessageToWebview({ type: 'addErrorResponse', text: `不支持的语言: ${language}` });
            return;
        }
        const match = classRegex.exec(fullText);
        if (!match) {
            provider.postMessageToWebview({ type: 'addWarningResponse', text: `未找到类: ${className}` });
            return;
        }
        const originalClass = match[1];
        range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + originalClass.length));
    }

    provider.setBackup(targetUri.fsPath, fullText);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetUri, range, newContent);

    const rangeStart = document.offsetAt(range.start);
    const rangeEnd = document.offsetAt(range.end);
    const newFullText = fullText.substring(0, rangeStart) + newContent + fullText.substring(rangeEnd);
    await confirmAndApplyDocEdit(
        provider, targetUri, filepath, document,
        fullText, newFullText, edit, 'class', history,
        `已替换类 ${className} 在 ${filepath}`
    );

    revealEditLocation({ filepath: targetUri.fsPath, range }, { highlight: true, focus: true });
}

export async function handleFunctionEdit(
    provider: LLMAChatProvider,
    filepath: string,
    functionName: string,
    newContent: string,
    history: ChatHistory,
    signal?: AbortSignal
): Promise<void> {
    const targetUri = resolveFilePath(filepath);
    if (!targetUri) {return;}

    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(targetUri);
    } catch {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `文件不存在: ${filepath}` });
        return;
    }

    const fullText = document.getText();
    const language = document.languageId;

    let range: vscode.Range | undefined;

    // 优先用 AST 定位（更准确，支持嵌套括号/默认参数）
    const analyzer = globalASTRegistry.getAnalyzer(targetUri.fsPath);
    if (analyzer) {
        try {
            const astResult = await analyzer.analyze(fullText, targetUri.fsPath);
            const findNode = (nodes: any[]): any => {
                for (const n of nodes) {
                    if ((n.type === 'function' || n.type === 'method') && n.name === functionName) { return n; }
                    const found = findNode(n.children || []);
                    if (found) { return found; }
                }
                return null;
            };
            const node = findNode(astResult.nodes);
            if (node) {
                const startPos = new vscode.Position(node.startLine - 1, node.startColumn);
                const endPos = new vscode.Position(node.endLine - 1, document.lineAt(node.endLine - 1).text.length);
                range = new vscode.Range(startPos, endPos);
            }
        } catch { /* fallback to regex */ }
    }

    // AST 未找到时降级为正则
    if (!range) {
        const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let funcRegex: RegExp;
        if (language === 'typescript' || language === 'javascript') {
            funcRegex = new RegExp(
                `((?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\([^)]*\\)\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)|` +
                `(const\\s+${escapedName}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)|` +
                `(const\\s+${escapedName}\\s*=\\s*function\\s*\\([^)]*\\)\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)`,
                'g'
            );
        } else if (language === 'python') {
            funcRegex = new RegExp(`(def\\s+${escapedName}\\s*\\([^)]*\\)\\s*:[\\s\\S]*?)(?=\\n(?:\\s{0,4}\\S|\\s*$)|$)`, 'g');
        } else if (language === 'java' || language === 'c' || language === 'cpp') {
            funcRegex = new RegExp(`((?:(?:public|private|protected|static|virtual|inline|async)\\s+)*[\\w<>\\[\\]\\*\\s]+\\s+${escapedName}\\s*\\([^)]*\\)\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)`, 'g');
        } else {
            provider.postMessageToWebview({ type: 'addErrorResponse', text: `不支持的语言: ${language}` });
            return;
        }
        const match = funcRegex.exec(fullText);
        if (!match) {
            provider.postMessageToWebview({ type: 'addWarningResponse', text: `未找到函数: ${functionName}` });
            return;
        }
        const originalFunc = match[1] || match[2] || match[3];
        if (!originalFunc) {
            provider.postMessageToWebview({ type: 'addWarningResponse', text: `无法定位函数定义: ${functionName}` });
            return;
        }
        range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + originalFunc.length));
    }

    // 备份
    provider.setBackup(targetUri.fsPath, fullText);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetUri, range, newContent);

    const rangeStart = document.offsetAt(range.start);
    const rangeEnd = document.offsetAt(range.end);
    const newFullText = fullText.substring(0, rangeStart) + newContent + fullText.substring(rangeEnd);
    await confirmAndApplyDocEdit(
        provider, targetUri, filepath, document,
        fullText, newFullText, edit, 'function', history,
        `已替换函数 ${functionName} 在 ${filepath}`
    );

    revealEditLocation({ filepath: targetUri.fsPath, range }, { highlight: true, focus: true });
}

// 执行命令并返回结果（支持超时和取消）
function resolveCwd(cwdOpt?: string | URL): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwdOpt) return workspaceRoot ?? process.cwd();
  try {
    const resolved = path.resolve(typeof cwdOpt === 'string' ? cwdOpt : cwdOpt.toString());
    return fs.existsSync(resolved) ? resolved : workspaceRoot ?? process.cwd();
  } catch {
    return workspaceRoot ?? process.cwd();
  }
}

/**
 * Execute a shell command with timeout and optional abort support.
 * - Checks for dangerous commands via `isCommandDangerous`.
 * - Resolves working directory safely.
 * - Allows configurable `maxBuffer` (default 50 MiB).
 * - Returns stdout, stderr, killed flag and exit code.
 */
export function execWithTimeout(
  command: string,
  options: cp.ExecOptions = {},
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{ stdout: string; stderr: string; killed: boolean; exitCode: number | null }> {
  // 1️⃣ 拦截危险命令
  if (isCommandDangerous(command)) {
    return Promise.reject(new Error('已拦截危险命令'));
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    const cwd = resolveCwd(options.cwd);

    const execOptions: cp.ExecOptions = {
      cwd,
      env,
      maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024, // 50 MiB 默认
      windowsHide: true,
      encoding: 'utf8'
    };

    const child = cp.exec(command, execOptions, (error, stdout, stderr) => {
      clearTimeout(timeoutTimer);
      const out = (stdout ?? '').toString().trimEnd();
      const err = (stderr ?? '').toString().trimEnd();
      const execError = error as cp.ExecException | null;
      const rawCode = execError?.code;
      const exitCode = typeof rawCode === 'number'
        ? rawCode
        : (typeof child.exitCode === 'number' ? child.exitCode : (child.killed ? null : 0));
      const killed = child.killed;
      resolve({ stdout: out, stderr: err, killed, exitCode });
    });

    const timeoutTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }
    }, timeoutMs);

    if (abortSignal) {
      const abortHandler = () => {
        if (!child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 1000);
        }
        clearTimeout(timeoutTimer);
      };
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('exit', () => {
      clearTimeout(timeoutTimer);
    });
  });
}



export function extractJSONAfterMarker(response: string, markerIndex: number): any | null {
  const afterMarker = response.slice(markerIndex);
  const lines = afterMarker.split('\n');
  let i = 1; // 跳过指令行
  while (i < lines.length && lines[i].trim() === '') { i++; }
  const remaining = lines.slice(i).join('\n');
  // 匹配 ```json 或 ``` 代码块
  const codeBlockRegex = /```(?:json)?\r?\n([\s\S]*?)```/;
  const match = codeBlockRegex.exec(remaining);
  if (!match) {return null;}
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export async function handleFileChange(
  filepath: string,
  content: string,
  auto: boolean,
  backupMap: Map<string, string | null>,
  view?: vscode.WebviewView,
  options: { intent?: 'modify' | 'rewrite' | 'refactor' | 'create' | 'auto', skipConfirm?: boolean } = {},
  provider?: LLMAChatProvider
): Promise<{ editType: string; changesCount: number }> {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) {
    throw new Error('请先打开一个工作区文件夹');
  }

  let originalContent = '';
  let isNewFile = false;
  try {
    if (fs.existsSync(targetUri.fsPath)) {
      originalContent = fs.readFileSync(targetUri.fsPath, 'utf-8');
    } else {
      isNewFile = true;
    }
  } catch (e) {
    isNewFile = true;
  }

  if (!isNewFile && !backupMap.has(targetUri.fsPath)) {
    backupMap.set(targetUri.fsPath, originalContent);
  }

  const fileName = path.basename(filepath);
  const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const diffResult = generateDiffPreview(originalContent, content, filepath, isNewFile);
  const config = vscode.workspace.getConfiguration('llma');
  const confirmMode = config.get<'always' | 'smart' | 'never'>('agent.fileChangeConfirmMode', 'smart');
  const smartConfirmMinChangedLines = config.get<number>('agent.smartConfirmMinChangedLines', 50);
  const smartConfirmMinCharDelta = config.get<number>('agent.smartConfirmMinCharDelta', 3000);

  let requireConfirm = false;
  if (auto) {
    if (options.skipConfirm === false) {
      requireConfirm = true;
    } else if (options.skipConfirm === true) {
      requireConfirm = false;
    } else if (confirmMode === 'never') {
      requireConfirm = false;
    } else if (confirmMode === 'always' || isNewFile) {
      // 新建文件始终需要确认
      requireConfirm = true;
    } else {
      const contentDelta = Math.abs(content.length - originalContent.length);
      requireConfirm =
        diffResult.previewLines >= smartConfirmMinChangedLines ||
        contentDelta >= smartConfirmMinCharDelta;
    }
  }

  if (auto && requireConfirm && provider) {
    // 先写入文件
    await applyFileChangeDirect(targetUri, filepath, content, backupMap, view, options);

    // 打开 VSCode diff 视图（新文件左侧用空内容）
    try {
      await openDiffView(targetUri, originalContent, isNewFile);
    } catch {}

    // 发送小卡片挂起等待用户确认
    provider.postMessageToWebview({ type: 'agentPaused', reason: `等待确认: ${fileName}` });
    try {
      await new Promise<void>((resolve, reject) => {
        provider.pendingConfirmMap.set(pendingId, { resolve, reject });
        view?.webview.postMessage({
          type: 'fileChangePreview',
          pendingId,
          filepath,
          fileName,
          isNew: isNewFile,
          diff: diffResult.diff,
          previewLines: diffResult.previewLines
        });
      });
    } catch {
      // 用户取消 → 恢复原文件
      await applyFileChangeDirect(targetUri, filepath, originalContent, backupMap, view, {});
      view?.webview.postMessage({ type: 'fileChangeApplied', filepath, auto: true, cancelled: true });
      provider.postMessageToWebview({ type: 'agentResumed' });
      throw new Error(`用户取消了对 ${fileName} 的修改`);
    }
    provider.postMessageToWebview({ type: 'agentResumed' });
    return { editType: isNewFile ? 'create' : 'confirm', changesCount: 0 };
  }

  return applyFileChangeDirect(targetUri, filepath, content, backupMap, view, options);
}

function generateDiffPreview(originalContent: string, newContent: string, filepath: string, isNewFile: boolean): { diff: string[], previewLines: number } {
  const dmpInstance = new dmp.diff_match_patch();
  const diff: string[] = [];
  let previewLines = 0;

  if (isNewFile) {
    const lines = newContent.split('\n');
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      diff.push(`+ ${lines[i]}`);
      previewLines++;
    }
    if (lines.length > 50) {
      diff.push(`... (+${lines.length - 50} 行)`);
    }
  } else {
    const diffs = dmpInstance.diff_main(originalContent, newContent);
    dmpInstance.diff_cleanupSemantic(diffs);
    for (const [op, text] of diffs) {
      const prefix = op === 1 ? '+' : op === -1 ? '-' : ' ';
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '' && i === lines.length - 1) continue;
        if (prefix !== ' ' && previewLines >= 50) continue;
        diff.push(`${prefix} ${lines[i]}`);
        if (prefix !== ' ') previewLines++;
      }
    }
    if (previewLines >= 50) {
      diff.push('... (差异过多，已截断)');
    }
  }

  return { diff, previewLines };
}


async function applyFileChangeDirect(
  targetUri: vscode.Uri,
  filepath: string,
  content: string,
  backupMap: Map<string, string | null>,
  view?: vscode.WebviewView,
  options: { intent?: 'modify' | 'rewrite' | 'refactor' | 'create' | 'auto' } = {}
): Promise<{ editType: string; changesCount: number }> {
  try {
    // 先读取当前文件内容，检查是否与新内容相同，避免重复应用
    // 从磁盘读取以确保获取最新内容，而不是编辑器缓冲区中的可能过时内容
    let currentContent = '';
    let fileExists = false;
    try {
      if (fs.existsSync(targetUri.fsPath)) {
        currentContent = fs.readFileSync(targetUri.fsPath, 'utf-8');
        fileExists = true;
      }
    } catch {
      // 文件不存在或无法读取，继续处理
    }
    
    // 如果当前文件内容与新内容完全相同，说明已经应用过了，直接返回
    // 比较前规范化换行符，避免因换行符差异导致误判
    const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (fileExists && normalizeNewlines(currentContent) === normalizeNewlines(content)) {
      view?.webview.postMessage({
        type: 'fileChangeApplied',
        filepath,
        isNew: false,
        auto: true,
        editType: 'full',
        changesCount: 0
      });
      return { editType: 'full', changesCount: 0 };
    }
    
    const originalContent = backupMap.get(targetUri.fsPath) ?? undefined;
    const config = vscode.workspace.getConfiguration('llma');
    const revealEditsAfterApply = config.get<boolean>('agent.revealEditsAfterApply', false);
    const result = await SmartEditor.applySmartEdit(targetUri, content, backupMap, {
      intent: options.intent || 'auto'
    });

    if (result.success && revealEditsAfterApply && result.editRanges && result.editRanges.length > 0) {
      // 仅定位首个编辑区，避免多次焦点跳转。
      const firstRange = result.editRanges[0];
      await revealEditLocation({
        filepath: targetUri.fsPath,
        range: firstRange
      }, { highlight: true, focus: true });
    } else if (result.success && revealEditsAfterApply && result.editType === 'create') {
      await revealEditLocation({
        filepath: targetUri.fsPath,
        line: 1
      }, { highlight: true, focus: true });
    }

    if (result.success && result.changesCount > 0) {
      const isCreate = result.editType === 'create';
      const diffBaseContent = result.originalContent ?? (originalContent ?? '');
      try {
        await openDiffView(targetUri, diffBaseContent, isCreate);
      } catch (diffErr: any) {
        view?.webview.postMessage({
          type: 'addWarningResponse',
          text: `打开前后对比失败: ${diffErr.message || String(diffErr)}`
        });
      }
    }

    view?.webview.postMessage({
      type: 'fileChangeApplied',
      filepath,
      isNew: result.editType === 'create',
      auto: true,
      editType: result.editType,
      changesCount: result.changesCount
    });

    try {
      await handleSaveFile(filepath, view);
    } catch (saveErr: any) {
      view?.webview.postMessage({ type: 'addWarningResponse', text: `自动保存失败: ${saveErr.message}` });
    }

    // 确认后自动关闭与当前文件相关的diff视图
    if (result.success && result.changesCount > 0) {
      try {
        await closeDiffViewsForFile(targetUri);
      } catch (closeErr: any) {
        console.warn(`关闭diff视图失败: ${closeErr.message}`);
      }
    }

    return { editType: result.editType, changesCount: result.changesCount };
  } catch (e: any) {
    throw new Error(`文件操作失败 (${filepath}): ${e.message}`);
  }
}

export async function handleSaveFile(filepath: string, view?: vscode.WebviewView) {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) { return; }
  try {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await doc.save();
    vscode.window.setStatusBarMessage(`已保存 ${path.basename(filepath)}`, 3000);
    view?.webview.postMessage({ type: 'fileChangeSaved', filepath });
  } catch (e: any) {
    vscode.window.showErrorMessage(`保存失败: ${e.message}`);
  }
}

export async function handleRevertFile(filepath: string, backupMap: Map<string, string | null>, view?: vscode.WebviewView) {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) { return; }
  try {
    const fsPath = targetUri.fsPath;
    if (backupMap.has(fsPath)) {
      const originalContent = backupMap.get(fsPath);
      const edit = new vscode.WorkspaceEdit();
      if (originalContent === null || originalContent === undefined) {
        edit.deleteFile(targetUri, { ignoreIfNotExists: true });
      } else {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(targetUri, fullRange, originalContent);
      }
      await vscode.workspace.applyEdit(edit);
      vscode.window.setStatusBarMessage(`已撤销 ${path.basename(filepath)}`, 3000);
      view?.webview.postMessage({ type: 'fileChangeReverted', filepath });
    } else {
      vscode.window.showWarningMessage('未找到历史备份');
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`撤销失败: ${e.message}`);
  }
}

async function closeAllDiffEditors(): Promise<number> {
  const diffTabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff) {
        diffTabs.push(tab);
      }
    }
  }
  if (diffTabs.length > 0) {
    await vscode.window.tabGroups.close(diffTabs, true);
  }
  return diffTabs.length;
}

/**
 * 关闭与指定文件相关的diff视图
 */
export async function closeDiffViewsForFile(targetUri: vscode.Uri): Promise<number> {
  const diffTabs: vscode.Tab[] = [];
  const targetFsPath = targetUri.fsPath;
  
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff) {
        const diffInput = tab.input as vscode.TabInputTextDiff;
        // 检查是否与目标文件相关（比较右侧文件路径）
        if (diffInput.modified.fsPath === targetFsPath) {
          diffTabs.push(tab);
        }
      }
    }
  }
  
  if (diffTabs.length > 0) {
    await vscode.window.tabGroups.close(diffTabs, true);
  }
  return diffTabs.length;
}

export async function handleKeepAllChanges(backupMap: Map<string, string | null>, view?: vscode.WebviewView) {
  const changedPaths = Array.from(backupMap.keys());
  if (changedPaths.length === 0) {
    const closedCount = await closeAllDiffEditors();
    view?.webview.postMessage({ type: 'addSystemMessage', text: `没有待处理的修改。已关闭 ${closedCount} 个对比标签页。`, important: true });
    view?.webview.postMessage({ type: 'changesDecisionDone', action: 'keep' });
    return;
  }

  let savedCount = 0;
  for (const fsPath of changedPaths) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      await doc.save();
      savedCount++;
    } catch {
      // 忽略单文件失败，继续处理剩余文件
    }
  }

  backupMap.clear();
  const closedCount = await closeAllDiffEditors();
  view?.webview.postMessage({
    type: 'addSystemMessage',
    text: `已保留 ${savedCount}/${changedPaths.length} 个文件修改，并关闭 ${closedCount} 个对比标签页。`,
    important: true
  });
  view?.webview.postMessage({ type: 'changesDecisionDone', action: 'keep' });
}

export async function handleDiscardAllChanges(backupMap: Map<string, string | null>, view?: vscode.WebviewView) {
  const entries = Array.from(backupMap.entries());
  if (entries.length === 0) {
    const closedCount = await closeAllDiffEditors();
    view?.webview.postMessage({ type: 'addSystemMessage', text: `没有待撤销的修改。已关闭 ${closedCount} 个对比标签页。`, important: true });
    view?.webview.postMessage({ type: 'changesDecisionDone', action: 'discard' });
    return;
  }

  let revertedCount = 0;
  for (const [fsPath, originalContent] of entries) {
    try {
      const targetUri = vscode.Uri.file(fsPath);
      const edit = new vscode.WorkspaceEdit();
      if (originalContent === null || originalContent === undefined) {
        edit.deleteFile(targetUri, { ignoreIfNotExists: true });
      } else {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(targetUri, fullRange, originalContent);
      }
      await vscode.workspace.applyEdit(edit);
      if (originalContent !== null && originalContent !== undefined) {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await doc.save();
      }
      revertedCount++;
    } catch {
      // 忽略单文件失败，继续处理剩余文件
    }
  }

  backupMap.clear();
  const closedCount = await closeAllDiffEditors();
  view?.webview.postMessage({
    type: 'addSystemMessage',
    text: `已撤销 ${revertedCount}/${entries.length} 个文件修改，并关闭 ${closedCount} 个对比标签页。`,
    important: true
  });
  view?.webview.postMessage({ type: 'changesDecisionDone', action: 'discard' });
}

export async function createDirectory(dirPath: string, view?: vscode.WebviewView): Promise<boolean> {
  const targetUri = resolveFilePath(dirPath);
  if (!targetUri) {
    const msg = `目录创建失败: 无法解析路径 ${dirPath}`;
    view?.webview.postMessage({ type: 'addErrorResponse', text: msg });
    return false;
  }
  try {
    await vscode.workspace.fs.createDirectory(targetUri);
    const msg = `目录创建成功: ${dirPath}`;
    view?.webview.postMessage({ type: 'addSystemMessage', text: msg });
    return true;
  } catch (err: any) {
    const msg = `目录创建失败: ${err.message}`;
    view?.webview.postMessage({ type: 'addErrorResponse', text: msg });
    return false;
  }
}

// ========== 新增：通用范围编辑函数 ==========
async function applyRangeEdit(
  provider: LLMAChatProvider,
  filepath: string,
  range: vscode.Range,
  newContent: string,
  history: ChatHistory,
  signal?: AbortSignal
): Promise<void> {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `无法解析路径: ${filepath}` });
    return;
  }

  let document: vscode.TextDocument;
  let fileExists = true;
  try {
    document = await vscode.workspace.openTextDocument(targetUri);
  } catch {
    fileExists = false;
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(targetUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(edit);
    document = await vscode.workspace.openTextDocument(targetUri);
  }

  const fullText = document.getText();

  // 备份（仅当文件存在且未备份）
  if (fileExists) { provider.setBackup(targetUri.fsPath, fullText); }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(targetUri, range, newContent);
  await vscode.workspace.applyEdit(edit);
  await document.save();

  revealEditLocation({
    filepath: targetUri.fsPath,
    range
  }, { highlight: true, focus: true });

  if (fileExists) {
    try {
      await openDiffView(targetUri, fullText);
    } catch (diffErr: any) {
      provider.postMessageToWebview({
        type: 'addWarningResponse',
        text: `打开前后对比失败: ${diffErr.message || String(diffErr)}`
      });
    }
  }

  provider.postMessageToWebview({
    type: 'fileChangeApplied',
    filepath,
    isNew: !fileExists,
    auto: false,
    editType: 'rangeEdit'
  });

  pushInternalHistory(history, `已应用范围编辑到 ${filepath}`, provider);
}

// 处理 EDIT_BLOCK（行范围）
export async function handleEditBlock(
  provider: LLMAChatProvider,
  filepath: string,
  desc: EditDescription,
  newContent: string,
  history: ChatHistory,
  signal?: AbortSignal
): Promise<void> {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `无法解析路径: ${filepath}` });
    return;
  }

  // 如果文件不存在，先创建空文件
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(targetUri);
  } catch {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(targetUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(edit);
    document = await vscode.workspace.openTextDocument(targetUri);
  }

  if (desc.startLine === undefined || desc.endLine === undefined) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `行范围编辑缺少 startLine/endLine` });
    return;
  }

  const startLine = Math.max(0, desc.startLine - 1);
  const endLine = Math.min(document.lineCount - 1, desc.endLine - 1);
  const startPos = new vscode.Position(startLine, 0);
  const endPos = new vscode.Position(endLine, document.lineAt(endLine).text.length);
  const range = new vscode.Range(startPos, endPos);

  await applyRangeEdit(provider, filepath, range, newContent, history, signal);
}

// 处理 RANGE_EDIT（字符范围）
export async function handleRangeEdit(
  provider: LLMAChatProvider,
  filepath: string,
  desc: EditDescription,
  newContent: string,
  history: ChatHistory,
  signal?: AbortSignal
): Promise<void> {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `无法解析路径: ${filepath}` });
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(targetUri);
  } catch {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(targetUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(edit);
    document = await vscode.workspace.openTextDocument(targetUri);
  }

  if (desc.start === undefined || desc.end === undefined) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `字符范围编辑缺少 start/end` });
    return;
  }

  const startPos = document.positionAt(desc.start);
  const endPos = document.positionAt(desc.end);
  const range = new vscode.Range(startPos, endPos);

  await applyRangeEdit(provider, filepath, range, newContent, history, signal);
}

// 处理 DIFF
export async function handleDiff(
  provider: LLMAChatProvider,
  filepath: string,
  diffContent: string,
  history: ChatHistory,
  signal?: AbortSignal
): Promise<void> {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `无法解析路径: ${filepath}` });
    return;
  }

  let oldContent = '';
  let fileExists = true;
  try {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    oldContent = doc.getText();
  } catch {
    fileExists = false;
  }

  const dmpInstance = new dmp.diff_match_patch();
  const patches = dmpInstance.patch_fromText(diffContent);
  if (!patches.length) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `无法解析 diff 内容` });
    return;
  }

  const [newContent, results] = dmpInstance.patch_apply(patches, oldContent);
  if (results.includes(false)) {
    provider.postMessageToWebview({ type: 'addWarningResponse', text: `部分 diff 未能成功应用` });
  }

  // 如果文件不存在，先创建
  if (!fileExists) {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(targetUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(edit);
  }

  // 备份
  if (fileExists) { provider.setBackup(targetUri.fsPath, oldContent); }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(targetUri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
  await doc.save();

  revealEditLocation({
    filepath: targetUri.fsPath,
    range: fullRange
  }, { highlight: true, focus: true });

  if (fileExists) {
    try {
      await openDiffView(targetUri, oldContent);
    } catch (diffErr: any) {
      provider.postMessageToWebview({
        type: 'addWarningResponse',
        text: `打开前后对比失败: ${diffErr.message || String(diffErr)}`
      });
    }
  }

  provider.postMessageToWebview({
    type: 'fileChangeApplied',
    filepath,
    isNew: !fileExists,
    auto: false,
    editType: 'diff'
  });

  pushInternalHistory(history, `已应用 diff 到 ${filepath}`, provider);
}

// ========== 新增：处理项目模板 ==========
export async function handleProjectTemplate(
  provider: LLMAChatProvider,
  project: any,
  history: ChatHistory,
  signal?: AbortSignal
): Promise<void> {
  // 期望 project 结构: { name?: string, files: Array<{path: string, content: string}>, initCommand?: string }
  if (!project.files || !Array.isArray(project.files)) {
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `项目模板缺少 files 数组` });
    return;
  }

  // 逐个创建文件
  for (const file of project.files) {
    if (signal?.aborted) {break;}
    const filePath = file.path;
    const content = file.content;
    if (!filePath || content === undefined) {continue;}

    // 复用 handleFileChange，auto 参数设为 true 表示自动应用
    await handleFileChange(filePath, content, true, provider.fileBackupMap, provider.view, { skipConfirm: true });
    // 可选延迟，避免文件系统压力
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  // 如果有初始化命令，执行
  if (project.initCommand && !signal?.aborted) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders?.[0]?.uri.fsPath;
    try {
      const result = await execWithTimeout(project.initCommand, { cwd }, TIMEOUT.PROJECT_INIT, signal);
      const output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
      provider.postMessageToWebview({ type: 'addTerminalOutput', command: project.initCommand, output, exitCode: result.exitCode });
      pushInternalHistory(history, `初始化命令执行结果:\n\`\`\`bash\n$ ${project.initCommand}\n${output}\n\`\`\``, provider);
      if (result.killed) {
        throw new Error('初始化命令执行超时或已取消');
      }
      if (result.exitCode !== null && result.exitCode !== 0) {
        throw new Error(`初始化命令退出码 ${result.exitCode}`);
      }
    } catch (err: any) {
      provider.postMessageToWebview({ type: 'addErrorResponse', text: `初始化命令失败: ${err.message}` });
      throw err;
    }
  }

}

// ========== 新增：处理多文件编辑（原子操作） ==========
export async function handleMultiFileEdit(
  provider: LLMAChatProvider,
  files: Array<{path: string, content: string}>,
  history: ChatHistory,
  signal?: AbortSignal
): Promise<void> {
  // 备份所有即将修改的文件
  const backupMap = new Map<string, string | null>();

  // 先解析所有路径，并备份
  for (const f of files) {
    if (signal?.aborted) {return;}
    const targetUri = resolveFilePath(f.path);
    if (!targetUri) {continue;}
    try {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      backupMap.set(targetUri.fsPath, doc.getText());
    } catch {
      backupMap.set(targetUri.fsPath, null); // 文件不存在，备份为 null
    }
  }

  // 逐个应用修改
  try {
    for (const f of files) {
      if (signal?.aborted) {break;}
      // 使用 handleFileChange 但 auto 设为 false，避免自动保存，并传递备份 map 供内部使用（但 handleFileChange 使用的是 provider.fileBackupMap）
      // 为了不干扰全局备份，我们直接使用 handleFileChange，它会在内部创建备份到 provider.fileBackupMap。
      // 但回滚时需要独立的备份，所以我们需要在发生错误时使用 backupMap 进行回滚。
      await handleFileChange(f.path, f.content, false, provider.fileBackupMap, provider.view);
    }
    pushInternalHistory(history, `已应用多文件编辑 (${files.length} 个文件)`, provider);
  } catch (err: any) {
    // 发生错误，回滚所有已修改的文件
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `多文件编辑失败，正在回滚...` });
    for (const f of files) {
      if (signal?.aborted) {break;}
      const targetUri = resolveFilePath(f.path);
      if (!targetUri) {continue;}
      const original = backupMap.get(targetUri.fsPath);
      if (original === null) {
        // 文件原本不存在，删除它
        try { await vscode.workspace.fs.delete(targetUri); } catch {}
      } else if (original !== undefined) {
        // 恢复原内容
        const edit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(targetUri, fullRange, original);
        await vscode.workspace.applyEdit(edit);
      }
    }
    provider.postMessageToWebview({ type: 'addErrorResponse', text: `回滚完成。错误: ${err.message}` });
  }
}



/**
 * 原子性应用多文件修改（APPLY_BATCH）
 */
export async function handleApplyBatch(
    provider: LLMAChatProvider,
    files: Array<{ path: string; content: string }>,
    history: ChatHistory,
    signal?: AbortSignal
): Promise<void> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const backupMap = new Map<string, string | null>();

    const config = vscode.workspace.getConfiguration('llma');
const requireConfirm = config.get<boolean>('agent.promptForBatchEdit', true);
if (requireConfirm) {
    const confirm = await vscode.window.showWarningMessage(
        `即将原子性修改 ${files.length} 个文件，是否继续？`,
        { modal: false },
        '继续', '取消'
    );
    if (confirm !== '继续') {
        return;
    }
}

    // 准备编辑并备份
    for (const f of files) {
        if (signal?.aborted) {return;}
        const targetUri = resolveFilePath(f.path);
        if (!targetUri) {continue;}

        let oldContent = '';
        try {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            oldContent = doc.getText();
            backupMap.set(targetUri.fsPath, oldContent);
        } catch {
            backupMap.set(targetUri.fsPath, null); // 文件不存在
        }

        // 创建或替换整个文件
        if (backupMap.get(targetUri.fsPath) === null) {
            workspaceEdit.createFile(targetUri, { ignoreIfExists: true });
        }
        const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(Number.MAX_SAFE_INTEGER, 0));
        workspaceEdit.replace(targetUri, range, f.content);
    }

    // 应用编辑（原子操作）
    try {
        await vscode.workspace.applyEdit(workspaceEdit);
        // 成功，将备份存入全局备份映射（便于后续回滚），并显示 diff 对比
        for (const [fsPath, old] of backupMap) {
            provider.setBackup(fsPath, old);
            // 显示 diff 对比
            if (old !== null && old !== undefined) {
                const targetUri = vscode.Uri.file(fsPath);
                const ext = path.extname(fsPath);
                const basename = path.basename(fsPath, ext);
                const tempFile = path.join(os.tmpdir(), `${basename}_原文件${ext}`);
                fs.writeFileSync(tempFile, old, 'utf-8');
                const left = vscode.Uri.file(tempFile);
                const right = targetUri;
                await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(fsPath)} (修改前 ↔ 修改后)`);
            }
        }
        pushInternalHistory(history, `原子性应用多文件修改完成`, provider);
    } catch (err: any) {
        provider.postMessageToWebview({ type: 'addErrorResponse', text: `多文件编辑失败: ${err.message}` });
        // 无需手动回滚，因为 applyEdit 失败不会改变任何文件
    }
}

/**
 * 预览多文件修改的影响（CHECK_BATCH）
 * 返回每个文件的预计变更 diff，但不实际写入
 */
export async function handleCheckBatch(
    provider: LLMAChatProvider,
    files: Array<{ path: string; content: string }>,
    signal?: AbortSignal
): Promise<void> {
    const diffs: string[] = [];
    for (const f of files) {
        if (signal?.aborted) {return;}
        const targetUri = resolveFilePath(f.path);
        if (!targetUri) {continue;}

        let oldContent = '';
        try {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            oldContent = doc.getText();
        } catch {
            oldContent = ''; // 新文件
        }

        // 生成简单 diff（可使用 diff-match-patch）
        const dmpInstance = new dmp.diff_match_patch();
        const diff = dmpInstance.diff_main(oldContent, f.content);
        dmpInstance.diff_cleanupSemantic(diff);
        const diffHtml = dmpInstance.diff_prettyHtml(diff); // 或文本形式
        diffs.push(`### ${f.path}\n\`\`\`diff\n${diffHtml}\n\`\`\``);
    }

    provider.postMessageToWebview({
        type: 'addSystemMessage',
        text: `📋 批量修改预览：\n\n${diffs.join('\n\n')}`
    });
}

// 读取文件内容（供 Agent READ 指令使用）
export async function handleReadFile(filepath: string): Promise<string | null> {
  const targetUri = resolveFilePath(filepath);
  if (!targetUri) { return null; }
  try {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const content = doc.getText();
    const maxLen = 15000;
    if (content.length > maxLen) {
      return content.substring(0, maxLen) + `\n... (文件过长，已截断，共 ${content.length} 字符)`;
    }
    return content;
  } catch {
    return null;
  }
}