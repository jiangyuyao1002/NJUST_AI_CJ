/**
 * 聊天提供者主模块
 * 
 * 这是聊天系统的核心模块，实现了 VS Code WebviewViewProvider 接口。
 * 负责管理聊天界面、会话、消息处理和工具执行。
 * 
 * 主要功能：
 * - Webview 管理：创建和更新聊天界面
 * - 会话管理：创建、加载、保存聊天会话
 * - 消息处理：处理用户消息和 AI 响应
 * - 工具执行：协调各种工具的执行（文件操作、命令执行等）
 * - 文件备份：管理文件编辑的备份和恢复
 * - 日志记录：记录所有聊天历史
 * - 多模态支持：处理文本和图像输入
 * 
 * @module chat/index
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getApiKey, isMultimodalModel } from '../config';
import { callChatAI } from '../api';
import { getWorkspaceContext, isCommandDangerous } from '../utils';
import { ChatSession } from '../types';
import { ChatSessionManager } from './session';
import { execWithTimeout, handleFileChange, handleSaveFile, handleRevertFile, createDirectory, handleEditBlock, handleRangeEdit, handleDiff, handleKeepAllChanges, handleDiscardAllChanges, closeDiffViewsForFile } from './tools';
import { generateChatHtml } from './webview';
import { handleUserMessage } from './messageHandler';
import { runExecutable } from '../compilation';
import * as cp from 'child_process';

/**
 * LLMA 聊天提供者类
 * 
 * 实现了 VS Code 的 WebviewViewProvider 接口，提供聊天功能。
 * 
 * 主要职责：
 * - 管理 Webview 视图的生命周期
 * - 处理用户输入和 AI 响应
 * - 协调工具执行和文件操作
 * - 管理会话状态和历史
 * - 处理多模态输入（文本+图像）
 * 
 * @class LLMAChatProvider
 * @implements vscode.WebviewViewProvider
 */
export class LLMAChatProvider implements vscode.WebviewViewProvider {
  /**
   * Webview 视图实例
   */
  private _view?: vscode.WebviewView;
  
  /**
   * 文件备份映射
   * 存储文件编辑前的原始内容，用于撤销操作
   * 公开属性，以便 tools 模块访问
   */
  public fileBackupMap = new Map<string, string | null>();
  
  /**
   * 待确认操作映射
   * 存储需要用户确认的操作（如文件覆盖）
   * 使用 Promise 来等待用户确认
   */
  public pendingConfirmMap = new Map<string, { resolve: () => void; reject: (reason?: any) => void }>();
  
  /**
   * 中止控制器
   * 用于取消正在进行的 AI 请求或工具执行
   */
  private _abortController: AbortController | null = null;
  
  /**
   * 当前子进程
   * 管理正在运行的命令或编译进程
   */
  private _currentChildProcess: cp.ChildProcess | null = null;
  
  /**
   * 日志文件路径
   * 存储聊天历史的 JSONL 文件路径
   */
  private _logFilePath: string;
  
  /**
   * 会话管理器
   * 负责会话的持久化和加载
   */
  private sessionManager: ChatSessionManager;
  
  /**
   * 当前会话 ID
   * 标识当前活跃的聊天会话
   */
  public currentSessionId: string | null = null;
  
  /**
   * 当前会话历史
   * 存储当前会话的所有消息
   */
  public currentSessionHistory: any[] = [];
  
  /**
   * 待读取的上下文
   * 存储需要读取的文件内容，用于构建 AI 上下文
   */
  public pendingReadContext: { role: string; content: string }[] = [];
  
  /**
   * 待处理的图像
   * 存储用户上传的图像，用于多模态输入
   */
  private _pendingImages?: { base64: string; mime: string; name: string }[];
  
  /**
   * 工具处理标志
   * 标记是否正在处理工具调用
   */
  public isProcessingTools: boolean = false;
  
  /**
   * 构造函数
   * 
   * @param _context - VS Code 扩展上下文
   */
  constructor(private readonly _context: vscode.ExtensionContext) {
    this._logFilePath = this._getLogFilePath();
    this.sessionManager = new ChatSessionManager(_context);
  }

  private _getLogFilePath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return path.join(workspaceFolders[0].uri.fsPath, '.llma', 'chat_history.jsonl');
    } else {
      return path.join(this._context.globalStorageUri.fsPath, 'chat_history.jsonl');
    }
  }

  private async appendToLogFile(role: string, content: string): Promise<void> {
    try {
      const dir = path.dirname(this._logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        role,
        content
      }) + '\n';
      await fs.promises.appendFile(this._logFilePath, entry, 'utf8');
    } catch (error) {
      console.error('写入日志文件失败:', error);
    }
  }

  private async readAllLogs(): Promise<any[]> {
    try {
      if (!fs.existsSync(this._logFilePath)) {
        return [];
      }
      const data = await fs.promises.readFile(this._logFilePath, 'utf8');
      const lines = data.split('\n').filter(line => line.trim() !== '');
      return lines.map(line => JSON.parse(line));
    } catch (error) {
      console.error('读取日志文件失败:', error);
      return [];
    }
  }

  public async saveCurrentSession(): Promise<void> {
    if (!this.currentSessionId) { return; }
    await this.sessionManager.saveSession(this.currentSessionId, this.currentSessionHistory);
    this.currentSessionHistory = [];
    this.currentSessionId = null;
  }

  public async loadSession(sessionId: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) { return; }
    await this.saveCurrentSession();
    this.currentSessionId = session.id;
    this.currentSessionHistory = session.messages.slice();
    if (this._view) {
      this._view.webview.postMessage({
        type: 'initHistory',
        history: session.messages
      });
    }
    await this._context.globalState.update('llma.chatHistory', session.messages);
  }

  public getSessions(): ChatSession[] {
    return this.sessionManager.getSessions();
  }

  public postMessageToWebview(message: any) {
    this._view?.webview.postMessage(message);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri]
    };
    const themeKind = vscode.window.activeColorTheme.kind;
    const initialTheme = (themeKind === vscode.ColorThemeKind.Light || themeKind === vscode.ColorThemeKind.HighContrastLight) ? 'light' : 'dark';
    webviewView.webview.html = generateChatHtml(webviewView.webview, this._context.extensionUri, initialTheme);

    const savedHistory = this._context.globalState.get<any[]>('llma.chatHistory') || [];
    this.currentSessionHistory = savedHistory.slice();
    webviewView.webview.postMessage({ type: 'initHistory', history: savedHistory });

    // 发送当前主题；主题变化 + 面板重新可见时都发送，实现立马切换
    const sendTheme = () => {
      const kind = vscode.window.activeColorTheme.kind;
      const theme = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
      this._view?.webview.postMessage({ type: 'themeChanged', theme });
    };
    sendTheme();
    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      // 延迟一帧再读主题并发送，避免事件触发时 API 尚未更新
      setTimeout(() => {
        sendTheme();
        setTimeout(sendTheme, 80);
      }, 0);
    });
    // 面板从隐藏恢复可见时重新同步主题（隐藏时收不到 postMessage）
    const visibilitySub = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) sendTheme();
    });
    webviewView.onDidDispose(() => {
      themeSub.dispose();
      visibilitySub.dispose();
    });

    vscode.window.onDidChangeTextEditorSelection(e => {
      if (this._view && e.textEditor === vscode.window.activeTextEditor) {
        this.updateContextStatus(e.textEditor);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'getTheme':
          sendTheme();
          break;
        case 'sendMessage':
          await handleUserMessage(this, data.text, data.history, data.model, data.mode, data.files, data.useWebSearch);
          break;
        case 'stopGeneration':
          if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
          }
          if (this._currentChildProcess) {
            this._currentChildProcess.kill();
            this._currentChildProcess = null;
          }
          break;
        case 'applyFileChange':
          // 手动点击”审查并应用”默认直写；自动批量应用走智能确认策略。
          const applyOptions = data.auto === true ? {} : { skipConfirm: true };
          await handleFileChange(
            data.filepath,
            data.content,
            data.auto === true,
            this.fileBackupMap,
            this._view,
            applyOptions,
            this
          );
          break;
        case 'confirmFileChange': {
          const pending = this.pendingConfirmMap.get(data.pendingId);
          if (pending) {
            this.pendingConfirmMap.delete(data.pendingId);
            pending.resolve();
          }
          // 确认后关闭对应文件的 diff 视图
          if (data.filepath) {
            const targetUri = vscode.Uri.file(data.filepath);
            closeDiffViewsForFile(targetUri).catch(() => {});
            // 通知前端追踪此文件，以便最终确认栏显示
            this._view?.webview.postMessage({ type: 'fileChangeApplied', filepath: data.filepath });
          }
          break;
        }
        case 'cancelFileChange': {
          const pending = this.pendingConfirmMap.get(data.pendingId);
          if (pending) {
            this.pendingConfirmMap.delete(data.pendingId);
            pending.reject(new Error(`用户取消了文件修改：${data.filepath}`));
          }
          this._view?.webview.postMessage({ type: 'addSystemMessage', text: `⏭️ 已取消文件修改：${data.filepath}`, important: true });
          break;
        }
        case 'saveFile':
          await handleSaveFile(data.filepath, this._view);
          break;
        case 'revertFile':
          await handleRevertFile(data.filepath, this.fileBackupMap, this._view);
          break;
        case 'keepAllChanges':
          await handleKeepAllChanges(this.fileBackupMap, this._view);
          break;
        case 'discardAllChanges':
          await handleDiscardAllChanges(this.fileBackupMap, this._view);
          break;
        // 新增：应用编辑块
        case 'applyEditBlock':
          // 根据 description 判断是行范围还是字符范围
          if (data.description.startLine !== undefined && data.description.endLine !== undefined) {
            await handleEditBlock(this, data.filepath, data.description, data.codeContent, this.currentSessionHistory, this._abortController?.signal);
          } else if (data.description.start !== undefined && data.description.end !== undefined) {
            await handleRangeEdit(this, data.filepath, data.description, data.codeContent, this.currentSessionHistory, this._abortController?.signal);
          }
          break;
        // 新增：应用 diff
        case 'applyDiff':
          await handleDiff(this, data.filepath, data.diffContent, this.currentSessionHistory, this._abortController?.signal);
          break;
        case 'compileCurrentFile':
          await vscode.commands.executeCommand('llma.compileCurrentFile');
          break;
        case 'runExecutable':
          await runExecutable(data.path, data.language);
          break;
        case 'revealInExplorer':
          if (data.path) { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(data.path)); }
          break;
        case 'refreshContext':
          if (vscode.window.activeTextEditor) { this.updateContextStatus(vscode.window.activeTextEditor); }
          break;
        case 'selectContextFiles':
          await this.handleSelectContextFiles();
          break;
        case 'getSettings':
          await this.sendSettingsToWebview();
          break;
        case 'saveSettings':
          await this.handleSaveSettings(data.settings);
          break;
        case 'updateHistory':
          const historyToSave = (data.history || []).slice(-50);
          this.currentSessionHistory = historyToSave;
          await this._context.globalState.update('llma.chatHistory', historyToSave);
          break;
        case 'appendToLog':
          await this.appendToLogFile(data.role, data.content);
          break;
        case 'getAllLogs':
          const logs = await this.readAllLogs();
          this._view?.webview.postMessage({ type: 'allLogs', logs });
          break;
        case 'saveCurrentSession':
          await this.saveCurrentSession();
          break;
        case 'getSessions':
          const sessions = this.getSessions();
          this._view?.webview.postMessage({ type: 'sessionsList', sessions });
          break;
        case 'loadSession':
          await this.loadSession(data.sessionId);
          break;
        case 'deleteSession': {
          this.sessionManager.deleteSession(data.sessionId);
          const updatedSessions = this.getSessions();
          this._view?.webview.postMessage({ type: 'sessionsList', sessions: updatedSessions });
          break;
        }
        case 'clearAllSessions': {
          this.sessionManager.clearAllSessions();
          this._view?.webview.postMessage({ type: 'sessionsList', sessions: [] });
          break;
        }
      }
    });
  }

  private updateContextStatus(editor: vscode.TextEditor) {
    const fileName = path.basename(editor.document.fileName);
    const lineCount = editor.selection.isEmpty ? 0 : editor.selection.end.line - editor.selection.start.line + 1;
    const contextInfo = editor.selection.isEmpty
      ? `当前编辑器: ${fileName}`
      : `选中代码: ${fileName} (${lineCount} 行)`;
    this._view?.webview.postMessage({ type: 'updateContextInfo', text: contextInfo });
  }

  private async handleSelectContextFiles() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '添加到上下文',
      title: '选择参考文件'
    });
    if (uris && uris.length > 0) {
      this._view?.webview.postMessage({
        type: 'filesSelected',
        files: uris.map(u => ({ name: path.basename(u.fsPath), path: u.fsPath }))
      });
    }
  }

  private async sendSettingsToWebview() {
    const config = vscode.workspace.getConfiguration('llma');
    this._view?.webview.postMessage({
      type: 'updateSettings',
      settings: {
        deepseekModel: config.get('deepseekModel') || '',
        deepseekApiKey: config.get('deepseekApiKey') || '',
        qwenModel: config.get('qwenModel') || '',
        qwenApiKey: config.get('qwenApiKey') || '',
        doubaoApiKey: config.get('doubaoApiKey') || '',
        doubaoModel: config.get('doubaoModel') || '',
        zhipuModel: config.get('zhipuModel') || '',
        zhipuApiKey: config.get('zhipuApiKey') || '',
        huggingfaceApiKey: config.get('huggingfaceApiKey') || '',
        huggingfaceModel: config.get('huggingfaceModel') || '',
        openaiApiKey: config.get('openaiApiKey') || '',
        openaiModel: config.get('openaiModel') || '',
        kimiApiKey: config.get('kimiApiKey') || '',
        kimiModel: config.get('kimiModel') || '',
        huggingfaceSpaceApiKey: config.get('huggingfaceSpaceApiKey') || '',
        huggingfaceSpaceBaseUrl: config.get('huggingfaceSpaceBaseUrl') || '',
        huggingfaceSpaceModel: config.get('huggingfaceSpaceModel') || '',
        localModelEnabled: config.get('localModel.enabled') || false,
        localModelBaseUrl: config.get('localModel.baseUrl') || 'http://localhost:11434/v1',
        localModelName: config.get('localModel.modelName') || 'llama3',
        localModelTimeout: config.get('localModel.timeout') || 120000,
        localModelSupportsMultimodal: config.get('localModel.supportsMultimodal') || false,
        customModelApiBaseUrl: config.get('customModel.apiBaseUrl') || 'http://127.0.0.1:8000',
        customModelApiKey: config.get('customModel.apiKey') || '',
        customModelModelName: config.get('customModel.modelName') || '',
        customModelChatEndpoint: config.get('customModel.chatEndpoint') || '/chat/completions',
        customModelSupportsMultimodal: config.get('customModel.supportsMultimodal') || false,
        enableWebSearch: config.get('enableWebSearch') || false,
        webSearchEngine: config.get('webSearchEngine') || 'google',
        serpApiKey: config.get('serpApiKey') || '',
        currentModel: config.get<string>('currentModel') || 'deepseek',
        // 新增配置（可选，用于前端显示）
        allowRangeEdit: config.get<boolean>('agent.allowRangeEdit', true),
        chatTypingEffect: config.get<boolean>('chat.typingEffect', true)
      }
    });
  }

  private async handleSaveSettings(settings: any) {
    const config = vscode.workspace.getConfiguration('llma');
    try {
      if (settings.deepseekModel !== undefined) { await config.update('deepseekModel', settings.deepseekModel, vscode.ConfigurationTarget.Global); }
      if (settings.qwenModel !== undefined) { await config.update('qwenModel', settings.qwenModel, vscode.ConfigurationTarget.Global); }
      if (settings.zhipuModel !== undefined) { await config.update('zhipuModel', settings.zhipuModel, vscode.ConfigurationTarget.Global); }
      if (settings.deepseekApiKey !== undefined) { await config.update('deepseekApiKey', settings.deepseekApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.qwenApiKey !== undefined) { await config.update('qwenApiKey', settings.qwenApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.doubaoApiKey !== undefined) { await config.update('doubaoApiKey', settings.doubaoApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.doubaoModel !== undefined) { await config.update('doubaoModel', settings.doubaoModel, vscode.ConfigurationTarget.Global); }
      if (settings.zhipuApiKey !== undefined) { await config.update('zhipuApiKey', settings.zhipuApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.huggingfaceApiKey !== undefined) { await config.update('huggingfaceApiKey', settings.huggingfaceApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.huggingfaceModel !== undefined) { await config.update('huggingfaceModel', settings.huggingfaceModel, vscode.ConfigurationTarget.Global); }
      if (settings.kimiApiKey !== undefined) { await config.update('kimiApiKey', settings.kimiApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.kimiModel !== undefined) { await config.update('kimiModel', settings.kimiModel, vscode.ConfigurationTarget.Global); }
      if (settings.huggingfaceSpaceApiKey !== undefined) { await config.update('huggingfaceSpaceApiKey', settings.huggingfaceSpaceApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.huggingfaceSpaceBaseUrl !== undefined) { await config.update('huggingfaceSpaceBaseUrl', settings.huggingfaceSpaceBaseUrl, vscode.ConfigurationTarget.Global); }
      if (settings.huggingfaceSpaceModel !== undefined) { await config.update('huggingfaceSpaceModel', settings.huggingfaceSpaceModel, vscode.ConfigurationTarget.Global); }
      if (settings.localModelEnabled !== undefined) { await config.update('localModel.enabled', settings.localModelEnabled, vscode.ConfigurationTarget.Global); }
      if (settings.localModelBaseUrl !== undefined) { await config.update('localModel.baseUrl', settings.localModelBaseUrl, vscode.ConfigurationTarget.Global); }
      if (settings.localModelName !== undefined) { await config.update('localModel.modelName', settings.localModelName, vscode.ConfigurationTarget.Global); }
      if (settings.localModelTimeout !== undefined) { await config.update('localModel.timeout', settings.localModelTimeout, vscode.ConfigurationTarget.Global); }
      if (settings.localModelSupportsMultimodal !== undefined) { await config.update('localModel.supportsMultimodal', settings.localModelSupportsMultimodal, vscode.ConfigurationTarget.Global); }
      if (settings.customModelApiBaseUrl !== undefined) { await config.update('customModel.apiBaseUrl', settings.customModelApiBaseUrl, vscode.ConfigurationTarget.Global); }
      if (settings.customModelApiKey !== undefined) { await config.update('customModel.apiKey', settings.customModelApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.customModelModelName !== undefined) { await config.update('customModel.modelName', settings.customModelModelName, vscode.ConfigurationTarget.Global); }
      if (settings.customModelChatEndpoint !== undefined) { await config.update('customModel.chatEndpoint', settings.customModelChatEndpoint, vscode.ConfigurationTarget.Global); }
      if (settings.customModelSupportsMultimodal !== undefined) { await config.update('customModel.supportsMultimodal', settings.customModelSupportsMultimodal, vscode.ConfigurationTarget.Global); }
      if (settings.enableWebSearch !== undefined) { await config.update('enableWebSearch', settings.enableWebSearch, vscode.ConfigurationTarget.Global); }
      if (settings.serpApiKey !== undefined) { await config.update('serpApiKey', settings.serpApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.openaiApiKey !== undefined) { await config.update('openaiApiKey', settings.openaiApiKey, vscode.ConfigurationTarget.Global); }
      if (settings.openaiModel !== undefined) { await config.update('openaiModel', settings.openaiModel, vscode.ConfigurationTarget.Global); }
      // 新增配置
      if (settings.allowRangeEdit !== undefined) { await config.update('agent.allowRangeEdit', settings.allowRangeEdit, vscode.ConfigurationTarget.Global); }

      vscode.window.showInformationMessage('配置已更新！');
      await this.sendSettingsToWebview();
    } catch (e: any) {
      vscode.window.showErrorMessage(`配置保存失败: ${e.message}`);
    }
  }

  // Getter for _abortController and _currentChildProcess for messageHandler
  public get abortController() { return this._abortController; }
  public set abortController(value: AbortController | null) { this._abortController = value; }
  public get currentChildProcess() { return this._currentChildProcess; }
  public set currentChildProcess(value: cp.ChildProcess | null) { this._currentChildProcess = value; }
  public get pendingImages() { return this._pendingImages; }
  public set pendingImages(value: { base64: string; mime: string; name: string }[] | undefined) { this._pendingImages = value; }
  public get view() { return this._view; }
  public get context() { return this._context; }
  public get workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : '';
  }
}