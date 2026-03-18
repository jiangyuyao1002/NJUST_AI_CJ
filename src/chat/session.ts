/**
 * 聊天会话管理模块
 * 
 * 负责聊天会话的持久化、加载和管理。
 * 提供会话的增删改查功能，支持会话历史记录。
 * 
 * 主要功能：
 * - 会话持久化：将会话保存到 JSON 文件
 * - 会话加载：从文件加载历史会话
 * - 会话管理：创建、删除、更新会话
 * - 备份恢复：自动备份和恢复机制
 * - 会话搜索：根据关键词搜索会话
 * 
 * @module chat/session
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatSession } from '../types';

/**
 * 聊天会话管理器类
 * 
 * 管理所有聊天会话的生命周期，包括：
 * - 会话的创建、更新、删除
 * - 会话的持久化存储
 * - 会话的加载和恢复
 * - 会话的搜索和过滤
 * 
 * @class ChatSessionManager
 */
export class ChatSessionManager {
  /**
   * 会话列表
   * 存储所有聊天会话对象
   */
  private sessions: ChatSession[] = [];
  
  /**
   * 会话文件路径
   * 存储会话数据的 JSON 文件路径
   */
  private sessionsFilePath: string;

  /**
   * 构造函数
   * 
   * @param _context - VS Code 扩展上下文
   */
  constructor(private readonly _context: vscode.ExtensionContext) {
    this.sessionsFilePath = this._getSessionsFilePath();
    this.loadSessionsFromFileSync();
  }

  /**
   * 获取会话文件路径
   * 
   * @returns 会话文件的完整路径
   */
  private _getSessionsFilePath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return path.join(workspaceFolders[0].uri.fsPath, '.llma', 'sessions.json');
    }
    return path.join(this._context.globalStorageUri.fsPath, 'sessions.json');
  }

  /**
   * 从文件同步加载会话
   * 
   * 尝试从会话文件加载历史会话，如果失败则尝试从备份恢复。
   * 使用同步方式确保在构造函数中完成加载。
   */
  private loadSessionsFromFileSync(): void {
    try {
      if (fs.existsSync(this.sessionsFilePath)) {
        const data = fs.readFileSync(this.sessionsFilePath, 'utf8');
        if (!data.trim()) {
          this.sessions = [];
          return;
        }
        this.sessions = JSON.parse(data);
      } else {
        this.sessions = [];
      }
    } catch (error) {
      console.error('加载会话文件失败:', error);
      const backupPath = this.sessionsFilePath + '.bak';
      if (fs.existsSync(backupPath)) {
        try {
          const backupData = fs.readFileSync(backupPath, 'utf8');
          if (backupData.trim()) {
            this.sessions = JSON.parse(backupData);
            console.log('已从备份文件恢复会话');
            return;
          }
        } catch (backupError) {
          console.error('读取备份文件也失败:', backupError);
        }
      }
      this.sessions = [];
      try {
        fs.renameSync(this.sessionsFilePath, this.sessionsFilePath + '.corrupted');
      } catch (renameError) {
        console.error('重命名损坏文件失败:', renameError);
      }
      vscode.window.showWarningMessage('会话历史文件损坏，已重置为空。原文件已重命名为 sessions.json.corrupted');
    }
  }

  private saveSessionsToFileSync(): void {
    try {
      const dir = path.dirname(this.sessionsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (this.sessions.length > 50) {
        this.sessions = this.sessions.slice(-50);
      }
      const tempFile = this.sessionsFilePath + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(this.sessions, null, 2), 'utf8');
      if (fs.existsSync(this.sessionsFilePath)) {
        fs.copyFileSync(this.sessionsFilePath, this.sessionsFilePath + '.bak');
      }
      fs.renameSync(tempFile, this.sessionsFilePath);
    } catch (error: any) {
      console.error('保存会话文件失败:', error);
      vscode.window.showErrorMessage(`保存会话历史失败: ${error.message}`);
    }
  }

  public async saveSession(sessionId: string, messages: any[]): Promise<void> {
    const existingIndex = this.sessions.findIndex(s => s.id === sessionId);
    const preview = messages[0]?.content?.substring(0, 50) || '空对话';
    const session: ChatSession = {
      id: sessionId,
      timestamp: Date.now(),
      messages: messages,
      preview
    };

    if (existingIndex >= 0) {
      this.sessions[existingIndex] = session;
    } else {
      this.sessions.push(session);
    }

    this.saveSessionsToFileSync();
  }

  public getSessions(): ChatSession[] {
    return this.sessions.slice().sort((a, b) => b.timestamp - a.timestamp);
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.sessions.find(s => s.id === sessionId);
  }

  public deleteSession(sessionId: string): boolean {
    const index = this.sessions.findIndex(s => s.id === sessionId);
    if (index < 0) { return false; }
    this.sessions.splice(index, 1);
    this.saveSessionsToFileSync();
    return true;
  }

  public clearAllSessions(): void {
    this.sessions = [];
    this.saveSessionsToFileSync();
  }
}