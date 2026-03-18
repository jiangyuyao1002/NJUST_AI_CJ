/**
 * 统一工具实现 - 封装 tools.ts 和 toolExecutor 逻辑
 */
import * as vscode from 'vscode';
import * as nodePath from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { LLMAChatProvider } from '../../index';
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
  handleFunctionEdit,
  handleClassEdit,
  handleLineContainingEdit,
  handleReadFile
} from '../../tools';
import { SmartEditor, resolveFilePath, EditIntent } from '../../smartEditor';
import { mcpManager } from '../../../extension';
import { TIMEOUT } from '../../../constants';
import type { ITool, ToolDefinition, ToolExecutionContext } from '../types';

function createTool(
  definition: ToolDefinition,
  execute: (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<string>
): ITool {
  return { definition, execute };
}

export const fileTool = createTool(
  { name: 'FILE', description: '创建或更新文件' },
  async (params, ctx) => {
    const { path, content } = params as { path: string; content: string };
    const provider = ctx.provider as LLMAChatProvider;
    const result = await handleFileChange(path, content, true, provider.fileBackupMap, provider.view, {}, provider);
    if (result.editType === 'create') return `文件已创建: ${path}`;
    if (result.changesCount === 0) return `文件内容无变化，未做任何修改: ${path}`;
    if (result.editType === 'partial') return `文件已局部修改: ${path} (${result.changesCount} 处变更)`;
    return `文件已更新: ${path}`;
  }
);

const runCommand = async (
  params: { command: string; cwd?: string; _termId?: string },
  ctx: ToolExecutionContext
): Promise<string> => {
  const { command, cwd, _termId } = params;
  if (ctx.abortSignal?.aborted) throw new Error('命令执行已取消');
  const output = await execWithTimeout(
    command,
    { cwd: cwd || ctx.provider.workspaceRoot, env: process.env },
    TIMEOUT.COMMAND_SHORT,
    ctx.abortSignal
  );
  const mergedOutput = output.stdout + (output.stderr ? `\n${output.stderr}` : '');

  if (output.killed) {
    throw new Error('命令执行超时或已取消');
  }

  const exitCode = output.exitCode;
  const failed = exitCode !== null && exitCode !== 0;

  // 只在成功时立即发卡片；失��时由调用方（retry 结束后）发，避免重试产生多张卡片
  if (!failed) {
    ctx.provider.postMessageToWebview({
      type: 'addTerminalOutput',
      id: _termId ?? `term_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      command,
      output: mergedOutput,
      exitCode
    });
    return mergedOutput;
  }

  // 失败：把 termId、output、exitCode 附在 error 上，供 retry 结束后统一发卡片
  const err: any = new Error(mergedOutput || `命令执行失败，退出码 ${exitCode}`);
  err.termOutput = mergedOutput;
  err.termExitCode = exitCode;
  err.termId = _termId;
  throw err;
};

export const runTool = createTool(
  { name: 'RUN', description: '执行终端命令' },
  async (params, ctx) => runCommand(params as { command: string; cwd?: string }, ctx)
);

export const buildTool = createTool(
  { name: 'BUILD', description: '执行构建命令' },
  async (params, ctx) => runCommand(params as { command: string; cwd?: string }, ctx)
);

export const testTool = createTool(
  { name: 'TEST', description: '执行测试命令' },
  async (params, ctx) => runCommand(params as { command: string; cwd?: string }, ctx)
);

export const mkdirTool = createTool(
  { name: 'MKDIR', description: '创建目录' },
  async (params) => {
    const { path } = params as { path: string };
    await createDirectory(path);
    return `目录已创建: ${path}`;
  }
);

export const replaceTool = createTool(
  { name: 'REPLACE', description: '替换文件中的文本' },
  async (params, ctx) => {
    const { path, original, new: newText } = params as { path: string; original: string; new: string };
    await handleReplaceEdit(ctx.provider as LLMAChatProvider, path, original, newText, ctx.history, ctx.abortSignal);
    return `已替换文件中的内容: ${path}`;
  }
);

export const editFunctionTool = createTool(
  { name: 'EDIT_FUNCTION', description: '编辑函数' },
  async (params, ctx) => {
    const { path, functionName, content } = params as { path: string; functionName: string; content: string };
    await handleFunctionEdit(ctx.provider as LLMAChatProvider, path, functionName, content, ctx.history, ctx.abortSignal);
    return `已编辑函数 ${functionName}: ${path}`;
  }
);

export const editClassTool = createTool(
  { name: 'EDIT_CLASS', description: '编辑类' },
  async (params, ctx) => {
    const { path, className, content } = params as { path: string; className: string; content: string };
    await handleClassEdit(ctx.provider as LLMAChatProvider, path, className, content, ctx.history, ctx.abortSignal);
    return `已编辑类 ${className}: ${path}`;
  }
);

export const editLineContainingTool = createTool(
  { name: 'EDIT_LINE_CONTAINING', description: '替换包含特定文本的行' },
  async (params, ctx) => {
    const { path, textPattern, content } = params as { path: string; textPattern: string; content: string };
    await handleLineContainingEdit(ctx.provider as LLMAChatProvider, path, textPattern, content, ctx.history, ctx.abortSignal);
    return `已替换包含 "${textPattern}" 的行: ${path}`;
  }
);

export const editBlockTool = createTool(
  { name: 'EDIT_BLOCK', description: '按行范围编辑' },
  async (params, ctx) => {
    const { path, startLine, endLine, content } = params as { path: string; startLine: number; endLine: number; content: string };
    await handleEditBlock(ctx.provider as LLMAChatProvider, path, { startLine, endLine }, content, ctx.history, ctx.abortSignal);
    return `已编辑块 (行 ${startLine}-${endLine}): ${path}`;
  }
);

export const rangeEditTool = createTool(
  { name: 'RANGE_EDIT', description: '按字符范围编辑' },
  async (params, ctx) => {
    const { path, start, end, content } = params as { path: string; start: number; end: number; content: string };
    await handleRangeEdit(ctx.provider as LLMAChatProvider, path, { start, end }, content, ctx.history, ctx.abortSignal);
    return `已编辑范围 (行 ${start}-${end}): ${path}`;
  }
);

export const diffTool = createTool(
  { name: 'DIFF', description: '应用差异编辑' },
  async (params, ctx) => {
    const { path, content } = params as { path: string; content: string };
    await handleDiff(ctx.provider as LLMAChatProvider, path, content, ctx.history, ctx.abortSignal);
    return `已应用差异编辑: ${path}`;
  }
);

export const projectTool = createTool(
  { name: 'PROJECT', description: '应用项目模板' },
  async (params, ctx) => {
    const project = Array.isArray(params) ? { files: params } : params;
    await handleProjectTemplate(ctx.provider as LLMAChatProvider, project as Record<string, unknown>, ctx.history, ctx.abortSignal);
    return '项目模板已应用';
  }
);

export const multiFileTool = createTool(
  { name: 'MULTI_FILE', description: '多文件编辑' },
  async (params, ctx) => {
    const arr = Array.isArray(params) ? params : (params as { files?: unknown[] })?.files;
    if (!Array.isArray(arr)) throw new Error('MULTI_FILE 需要文件数组');
    await handleMultiFileEdit(ctx.provider as LLMAChatProvider, arr as Array<{ path: string; content: string }>, ctx.history, ctx.abortSignal);
    return `已编辑 ${arr.length} 个文件`;
  }
);

export const applyBatchTool = createTool(
  { name: 'APPLY_BATCH', description: '批量应用修改' },
  async (params, ctx) => {
    const arr = Array.isArray(params) ? params : (params as { files?: unknown[] })?.files;
    if (!Array.isArray(arr)) throw new Error('APPLY_BATCH 需要文件数组');
    await handleApplyBatch(ctx.provider as LLMAChatProvider, arr as Array<{ path: string; content: string }>, ctx.history, ctx.abortSignal);
    return `已批量应用 ${arr.length} 个修改`;
  }
);

export const mcpTool = createTool(
  { name: 'MCP', description: '调用 MCP 工具' },
  async (params, ctx) => {
    const { serverName, toolName, args = {} } = params as { serverName: string; toolName: string; args?: Record<string, unknown> };
    if (!mcpManager) throw new Error('MCP 管理器未初始化');
    try {
      const result = await mcpManager.callTool(serverName, toolName, args);
      const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      (ctx.provider as LLMAChatProvider).postMessageToWebview?.({
        type: 'addMcpToolCard',
        serverName,
        toolName,
        args,
        result: resultStr,
        status: 'success'
      });
      return resultStr;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      (ctx.provider as LLMAChatProvider).postMessageToWebview?.({
        type: 'addMcpToolCard',
        serverName,
        toolName,
        args,
        result: errMsg,
        status: 'error'
      });
      throw err;
    }
  }
);

export const readTool = createTool(
  { name: 'READ', description: '读取文件内容' },
  async (params) => {
    const { path } = params as { path: string };
    const content = await handleReadFile(path);
    if (content === null) throw new Error(`文件不存在或无法读取: ${path}`);
    return content;
  }
);

export const smartEditTool = createTool(
  { name: 'SMART_EDIT', description: '智能编辑' },
  async (params, ctx) => {
    const { path, content, intent } = params as { path: string; content: string; intent?: string };
    const targetUri = resolveFilePath(path);
    if (!targetUri) throw new Error(`无法解析路径: ${path}`);
    const provider = ctx.provider as LLMAChatProvider;

    // 备份原始内容
    const document = await vscode.workspace.openTextDocument(targetUri);
    const originalContent = document.getText();
    if (!provider.fileBackupMap.has(targetUri.fsPath)) {
      provider.fileBackupMap.set(targetUri.fsPath, originalContent);
    }

    const result = await SmartEditor.applySmartEdit(
      targetUri,
      content,
      provider.fileBackupMap,
      { intent: (intent || 'auto') as EditIntent }
    );
    if (!result.success) throw new Error(result.message);

    if (result.changesCount > 0) {
      const isCreate = result.editType === 'create';
      const diffBaseContent = result.originalContent ?? originalContent;
      const ext = nodePath.extname(targetUri.fsPath);
      const basename = nodePath.basename(targetUri.fsPath, ext);
      const tempFile = nodePath.join(os.tmpdir(), `${basename}_原文件${ext}`);
      fs.writeFileSync(tempFile, isCreate ? '' : diffBaseContent, 'utf-8');
      const title = isCreate
        ? `${nodePath.basename(targetUri.fsPath)} (新建文件预览)`
        : `${nodePath.basename(targetUri.fsPath)} (修改前 ↔ 修改后)`;
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempFile), targetUri, title);

      // 发小卡片等待确认
      const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const fileName = nodePath.basename(path);
      provider.postMessageToWebview({ type: 'agentPaused', reason: `等待确认: ${fileName}` });
      try {
        await new Promise<void>((resolve, reject) => {
          provider.pendingConfirmMap.set(pendingId, { resolve, reject });
          provider.postMessageToWebview({
            type: 'fileChangePreview',
            pendingId,
            filepath: path,
            fileName,
            isNew: isCreate
          });
        });
      } catch {
        // 取消 → 恢复
        const restoreEdit = new vscode.WorkspaceEdit();
        const doc2 = await vscode.workspace.openTextDocument(targetUri);
        restoreEdit.replace(targetUri, new vscode.Range(doc2.positionAt(0), doc2.positionAt(doc2.getText().length)), originalContent);
        await vscode.workspace.applyEdit(restoreEdit);
        await doc2.save();
        provider.postMessageToWebview({ type: 'agentResumed' });
        throw new Error(`用户取消了对 ${fileName} 的修改`);
      }
      provider.postMessageToWebview({ type: 'agentResumed' });
    }

    if (result.changesCount === 0) return `文件内容无变化，未做任何修改: ${path}`;
    return `智能编辑完成: ${path} (${result.editType}, ${result.changesCount} 处修改)`;
  }
);

export const searchReplaceTool = createTool(
  { name: 'SEARCH_REPLACE', description: '搜索替换' },
  async (params, ctx) => {
    const { path, search, replace, global } = params as { path: string; search: string; replace: string; global?: boolean };
    const targetUri = resolveFilePath(path);
    if (!targetUri) throw new Error(`无法解析路径: ${path}`);
    const document = await vscode.workspace.openTextDocument(targetUri);
    const provider = ctx.provider as LLMAChatProvider;
    const originalContent = document.getText();
    if (!provider.fileBackupMap.has(targetUri.fsPath)) {
      provider.fileBackupMap.set(targetUri.fsPath, originalContent);
    }
    const result = await SmartEditor.applySearchReplace(document, search, replace, { global });
    if (!result.success) throw new Error(result.message);

    // 打开 diff 视图
    try {
      const ext = nodePath.extname(targetUri.fsPath);
      const basename = nodePath.basename(targetUri.fsPath, ext);
      const tempFile = nodePath.join(os.tmpdir(), `${basename}_原文件${ext}`);
      fs.writeFileSync(tempFile, originalContent, 'utf-8');
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempFile), targetUri, `${nodePath.basename(targetUri.fsPath)} (修改前 ↔ 修改后)`);
    } catch {}

    // 发小卡片等待确认
    const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fileName = nodePath.basename(path);
    provider.postMessageToWebview({ type: 'agentPaused', reason: `等待确认: ${fileName}` });
    try {
      await new Promise<void>((resolve, reject) => {
        provider.pendingConfirmMap.set(pendingId, { resolve, reject });
        provider.postMessageToWebview({
          type: 'fileChangePreview',
          pendingId,
          filepath: path,
          fileName,
          isNew: false
        });
      });
    } catch {
      // 取消 → 恢复
      const doc2 = await vscode.workspace.openTextDocument(targetUri);
      const restoreEdit = new vscode.WorkspaceEdit();
      restoreEdit.replace(targetUri, new vscode.Range(doc2.positionAt(0), doc2.positionAt(doc2.getText().length)), originalContent);
      await vscode.workspace.applyEdit(restoreEdit);
      await doc2.save();
      provider.postMessageToWebview({ type: 'agentResumed' });
      throw new Error(`用户取消了对 ${fileName} 的修改`);
    }
    provider.postMessageToWebview({ type: 'agentResumed' });

    return `搜索替换完成: ${path} (${result.changesCount} 处替换)`;
  }
);

export const allTools: ITool[] = [
  fileTool,
  runTool,
  buildTool,
  testTool,
  mkdirTool,
  replaceTool,
  editFunctionTool,
  editClassTool,
  editLineContainingTool,
  editBlockTool,
  rangeEditTool,
  diffTool,
  projectTool,
  multiFileTool,
  applyBatchTool,
  mcpTool,
  readTool,
  smartEditTool,
  searchReplaceTool
];
