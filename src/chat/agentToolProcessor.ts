/**
 * Agent 工具处理器模块
 * 
 * 提供高级 Agent 模式的工具处理功能，包括：
 * - 自动修正：检测和修正工具调用错误
 * - 反思机制：评估工具执行结果并调整策略
 * - 任务完成检查：判断任务是否已完成
 * - 连续无操作检测：避免无限循环
 * - 迭代控制：控制 Agent 的最大迭代次数
 * - 模糊匹配：支持模糊的工具参数匹配
 * 
 * 主要功能：
 * - 智能 Agent 模式，自动规划和执行任务
 * - 支持多轮工具调用和反思
 * - 提供任务完成检测机制
 * - 支持自动错误修正和重试
 * - 提供详细的追踪和日志记录
 * 
 * @module chat/agentToolProcessor
 */

import * as vscode from 'vscode';
import { callChatAI } from '../api';
import { getApiKey } from '../config';
import { mcpManager } from '../extension';
import { ToolParser, ToolParseOptions } from './toolParser';
import { ToolExecutor, ToolExecutionContext } from './toolExecutor';
import { LLMAChatProvider } from './index';
import { getAgentSystemPrompt, getEnhancedAgentSystemPrompt } from './messageHandler';
import type { TaskPlan } from '../task/taskTypes';
import axios from 'axios';
import { TraceManager, createTraceEntry, logToolCall, logReflection, logCompletion, logError, logInfo, logWarning } from './trace';
import { AI } from '../constants';
import { ChatHistory } from '../types';

/**
 * Agent 工具配置接口
 * 
 * 定义 Agent 工具处理器的配置参数。
 * 
 * @interface AgentToolConfig
 */
export interface AgentToolConfig {
  /**
   * 最大迭代次数
   * 限制 Agent 的最大工具调用轮数
   */
  maxIterations?: number;
  
  /**
   * 是否允许范围编辑
   * 控制是否使用 RANGE_EDIT 工具
   */
  allowRangeEdit?: boolean;
  
  /**
   * 是否允许命令执行
   * 控制是否使用 RUN 工具执行命令
   */
  allowCommandExecution?: boolean;
  
  /**
   * 是否启用模糊匹配
   * 启用后可以模糊匹配工具参数
   */
  enableFuzzyMatching?: boolean;
  
  /**
   * 是否启用自动修正
   * 启用后自动检测和修正工具调用错误
   */
  enableAutoCorrection?: boolean;
  
  /**
   * 是否启用重试
   * 启用后失败的工具会自动重试
   */
  enableRetry?: boolean;
  
  /**
   * 最大重试次数
   * 单个工具的最大重试次数
   */
  maxRetries?: number;
  
  /**
   * 是否启用反思
   * 启用后 Agent 会评估执行结果并调整策略
   */
  enableReflection?: boolean;
  
  /**
   * 是否检查任务完成
   * 启用后会主动检查任务是否完成
   */
  taskCompletionCheck?: boolean;
  
  /**
   * 最大连续无操作次数
   * 防止无限循环，限制连续无操作的最大次数
   */
  maxConsecutiveNoOps?: number;
}

/**
 * Agent 工具处理器类
 * 
 * 提供高级 Agent 模式的工具处理功能。
 * 
 * @class AgentToolProcessor
 */
export class AgentToolProcessor {
  /**
   * 当前会话 ID
   * 用于追踪 Agent 会话
   */
  private static currentSessionId: string | null = null;
  
  /**
   * 默认配置
   * 定义 Agent 的默认行为参数
   */
  private static readonly DEFAULT_CONFIG: AgentToolConfig = {
    maxIterations: 15,
    allowRangeEdit: true,
    allowCommandExecution: false,
    enableFuzzyMatching: true,
    enableAutoCorrection: true,
    enableRetry: true,
    maxRetries: 2,
    enableReflection: false,
    taskCompletionCheck: true,
    maxConsecutiveNoOps: 1
  };

  /**
   * 推送内部反馈消息
   * 
   * 将执行反馈添加到历史记录中。
   * 
   * @param history - 聊天历史记录
   * @param content - 反馈内容
   * @param provider - 可选，聊天提供者实例
   */
  private static pushInternalFeedback(history: ChatHistory, content: string, provider?: LLMAChatProvider): void {
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

  private static pushVisibleAssistantMessage(
    provider: LLMAChatProvider,
    history: ChatHistory,
    content: string
  ): void {
    history.push({ role: 'assistant', content });
    provider.currentSessionHistory.push({ role: 'assistant', content });
  }

  private static finishProcessing(provider: LLMAChatProvider): void {
    provider.isProcessingTools = false;
    if (provider.fileBackupMap.size > 0) {
      provider.postMessageToWebview({ type: 'showUndoBar' });
    }
  }

  static async processAgentTools(
    provider: LLMAChatProvider,
    history: ChatHistory,
    aiResponse: string,
    model: string,
    config: vscode.WorkspaceConfiguration,
    abortSignal?: AbortSignal,
    iteration: number = 0,
    customConfig?: AgentToolConfig,
    plan?: TaskPlan
  ): Promise<void> {
    // 标记开始处理工具
    provider.isProcessingTools = true;
    
    const resolvedConfig: AgentToolConfig = { ...this.DEFAULT_CONFIG, ...customConfig };
    const maxIterations = resolvedConfig.maxIterations ?? 15;
    const enableAutoCorrection = resolvedConfig.enableAutoCorrection ?? true;
    const enableRetry = resolvedConfig.enableRetry ?? true;
    const enableFuzzyMatching = resolvedConfig.enableFuzzyMatching ?? true;
    const enableReflection = resolvedConfig.enableReflection ?? true;
    const taskCompletionCheck = resolvedConfig.taskCompletionCheck ?? true;

    const traceManager = TraceManager.getInstance();
    if (iteration === 0) {
      this.currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }
    const sessionId = this.currentSessionId;

    if (!sessionId) {
      return;
    }

    if (iteration === 0) {
      const userRequest = this.extractUserRequest(history);
      traceManager.createSession(sessionId, userRequest, model, {
        maxIterations,
        enableAutoCorrection,
        enableRetry,
        enableFuzzyMatching,
        enableReflection,
        taskCompletionCheck
      });
      logInfo(sessionId, `会话开始: ${userRequest.substring(0, 100)}...`, { model, iteration }, iteration);
    }

    if (iteration >= maxIterations) {
      traceManager.updateSessionStatus(sessionId, 'completed');
      provider.postMessageToWebview({
        type: 'addSystemMessage',
        text: `⚠️ 已达到最大工具调用次数 (${maxIterations})，停止自动调用。`
      });
      // 标记结束处理工具
      this.finishProcessing(provider);
      provider.postMessageToWebview({ type: 'streamEnd' });
      return;
    }

    if (abortSignal?.aborted) {
      traceManager.updateSessionStatus(sessionId, 'aborted');
      // 标记结束处理工具
      this.finishProcessing(provider);
      provider.postMessageToWebview({ type: 'streamEnd' });
      return;
    }

    const context: ToolExecutionContext = {
      provider,
      history,
      config,
      abortSignal
    };

    const parseOptions: ToolParseOptions = {
      allowFlexibleFormat: true,
      suggestCorrections: true,
      normalizeWhitespace: true
    };

    if (enableFuzzyMatching) {
      parseOptions.fuzzyMatchThreshold = 0.6;
    }

    if (enableAutoCorrection) {
      await this.processWithAutoCorrection(
        provider,
        history,
        aiResponse,
        model,
        config,
        abortSignal,
        iteration,
        customConfig,
        plan
      );
    } else {
      await this.processWithRetry(provider, history, aiResponse, model, config, abortSignal, iteration, parseOptions, customConfig, plan);
    }
  }

  private static async processWithRetry(
    provider: LLMAChatProvider,
    history: ChatHistory,
    aiResponse: string,
    model: string,
    config: vscode.WorkspaceConfiguration,
    abortSignal?: AbortSignal,
    iteration: number = 0,
    parseOptions: ToolParseOptions = {},
    customConfig?: AgentToolConfig,
    plan?: TaskPlan
  ): Promise<void> {
    const context: ToolExecutionContext = {
      provider,
      history,
      config,
      abortSignal
    };

    const results = await ToolExecutor.executeTools(aiResponse, context, parseOptions);
    let hadActions = false;

    for (const result of results) {
      if (result.success) {
        hadActions = true;
        if (result.toolType === 'READ') {
          provider.pendingReadContext.push({ role: 'user', content: result.output ?? '' });
        }
        // 工具执行成功不显示反馈，保持输出简洁
      } else {
        const errorMsg = `❌ 工具 ${result.toolType} 执行失败: ${result.error}`;
        this.pushInternalFeedback(history, errorMsg, provider);
        
        if (result.suggestions && result.suggestions.length > 0) {
          const suggestionMsg = `💡 建议: ${result.suggestions.join(', ')}`;
          this.pushInternalFeedback(history, suggestionMsg, provider);
        }
      }
    }

    if (!hadActions || abortSignal?.aborted) {
      // 标记结束处理工具
      this.finishProcessing(provider);
      provider.postMessageToWebview({ type: 'streamEnd' });
      return;
    }

    await this.refineAndRetry(provider, history, model, config, abortSignal, iteration, customConfig, plan);
  }

  private static async processWithAutoCorrection(
    provider: LLMAChatProvider,
    history: ChatHistory,
    aiResponse: string,
    model: string,
    config: vscode.WorkspaceConfiguration,
    abortSignal?: AbortSignal,
    iteration: number = 0,
    customConfig?: AgentToolConfig,
    plan?: TaskPlan
  ): Promise<void> {
    const context: ToolExecutionContext = {
      provider,
      history,
      config,
      abortSignal
    };

    const parseOptions: ToolParseOptions = {
      allowFlexibleFormat: true,
      suggestCorrections: true,
      normalizeWhitespace: true,
      fuzzyMatchThreshold: 0.6
    };

    const results = await ToolExecutor.executeTools(aiResponse, context, parseOptions);
    let hadActions = false;
    let allErrors: string[] = [];

    for (const result of results) {
      if (result.success) {
        hadActions = true;
        if (result.toolType === 'READ') {
          provider.pendingReadContext.push({ role: 'user', content: result.output ?? '' });
        }
        // 工具执行成功不显示反馈，保持输出简洁
      } else {
        allErrors.push(result.error || '未知错误');
        
        if (result.suggestions && result.suggestions.length > 0) {
          const suggestionMsg = `💡 建议: ${result.suggestions.join(', ')}`;
          this.pushInternalFeedback(history, suggestionMsg, provider);
        }
      }
    }

    if (!hadActions || abortSignal?.aborted) {
      // 标记结束处理工具
      this.finishProcessing(provider);
      provider.postMessageToWebview({ type: 'streamEnd' });
      return;
    }

    if (allErrors.length > 0) {
      const correctionPrompt = this.generateCorrectionPrompt(allErrors);
      this.pushInternalFeedback(history, correctionPrompt, provider);

      const correctedResponse = await this.getCorrectedResponse(
        provider,
        model,
        config,
        history,
        abortSignal
      );

      if (correctedResponse) {
        await this.processWithAutoCorrection(
          provider,
          history,
          correctedResponse,
          model,
          config,
          abortSignal,
          iteration,
          customConfig,
          plan
        );
      }
    } else {
      await this.refineAndRetry(provider, history, model, config, abortSignal, iteration, customConfig, plan);
    }
  }

  private static async refineAndRetry(
    provider: LLMAChatProvider,
    history: ChatHistory,
    model: string,
    config: vscode.WorkspaceConfiguration,
    abortSignal?: AbortSignal,
    iteration: number = 0,
    customConfig?: AgentToolConfig,
    plan?: TaskPlan
  ): Promise<void> {
    const sessionId = this.currentSessionId;
    const resolvedConfig: AgentToolConfig = { ...this.DEFAULT_CONFIG, ...customConfig };
    const enableReflection = resolvedConfig.enableReflection ?? true;
    const taskCompletionCheck = resolvedConfig.taskCompletionCheck ?? true;
    const maxConsecutiveNoOps = resolvedConfig.maxConsecutiveNoOps ?? 3;

    if (sessionId) {
      logInfo(sessionId, `开始第 ${iteration + 1} 次迭代`, {}, iteration);
    }

    const toolCallPatterns = [
      /^\s*>\s*(FILE|RUN|MKDIR|REPLACE|EDIT_FUNCTION|EDIT_CLASS|EDIT_LINE_CONTAINING|EDIT_BLOCK|RANGE_EDIT|DIFF|PROJECT|MULTI_FILE|APPLY_BATCH|MCP|READ):/im
    ];
    const hasToolCalls = (content: string) => toolCallPatterns.some(pattern => pattern.test(content));

    // 从最近消息往前数，连续多少条 assistant 回复不含工具调用
    let consecutiveNoOps = 0;
    for (let i = history.length - 1; i >= 0 && consecutiveNoOps < maxConsecutiveNoOps; i--) {
      const msg = history[i];
      if (msg.role === 'assistant') {
        if (!hasToolCalls(msg.content)) {
          consecutiveNoOps++;
        } else {
          break; // 遇到有工具调用的就停止
        }
      }
    }

    // 连续多轮无工具调用 → 提前终止，避免过度执行
    if (consecutiveNoOps >= maxConsecutiveNoOps) {
      provider.postMessageToWebview({
        type: 'addSystemMessage',
        text: `⚠️ 连续 ${maxConsecutiveNoOps} 轮无工具调用，任务可能已完成或陷入僵局，停止迭代。`
      });
      // 标记结束处理工具
      this.finishProcessing(provider);
      provider.postMessageToWebview({ type: 'streamEnd' });
      return;
    }

    // 【反思前置】在调用 AI 之前先反思，避免过度执行
    // 优化：对于简单任务（迭代次数少），减少反思频率
    const shouldReflect = enableReflection && iteration > 0 && (iteration % 2 === 0 || iteration >= 5);
    if (shouldReflect) {
      const userRequest = this.extractUserRequest(history);
      const reflectionResult = await this.performReflection(
        provider,
        history,
        model,
        config,
        userRequest,
        abortSignal,
        iteration
      );
      if (!reflectionResult.shouldContinue) {
        // 标记结束处理工具
        this.finishProcessing(provider);
        provider.postMessageToWebview({ type: 'streamEnd' });
        return;
      }
    }

    if (taskCompletionCheck) {
      const completionResult = await this.checkTaskCompletion(provider, history, model, config, abortSignal);
      if (!completionResult.shouldContinue) {
        provider.postMessageToWebview({
          type: 'addSystemMessage',
          text: `✅ ${completionResult.feedback}`
        });
        // 标记结束处理工具
        this.finishProcessing(provider);
        provider.postMessageToWebview({ type: 'streamEnd' });
        return;
      }
    }

    const maxTokens = AI.AGENT_MAX_TOKENS;
    const temp = 0.1;

    const hasReadContext = (provider.pendingReadContext?.length ?? 0) > 0;
    if (!hasReadContext) {
      provider.postMessageToWebview({ type: 'streamStart' });
    } else {
      provider.postMessageToWebview({ type: 'streamStart', silent: true });
    }

    try {
      const apiKey = getApiKey(config, model);
      const conversation = [...history, ...(provider.pendingReadContext || [])];
      if (provider.pendingReadContext?.length) {
        provider.pendingReadContext = [];
      }
      const messagesForApi = plan && plan.steps.length > 0
        ? [{ role: 'system', content: getEnhancedAgentSystemPrompt(plan) }, ...conversation]
        : conversation;
      const newResponse = await callChatAI(
        model,
        apiKey,
        messagesForApi,
        config,
        maxTokens,
        temp,
        abortSignal,
        (contentDelta: string, reasoningDelta: string) => {
          provider.postMessageToWebview({
            type: 'streamUpdate',
            content: contentDelta,
            reasoning: reasoningDelta
          });
        }
      );

      const cleanResponse = newResponse.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();
      this.pushVisibleAssistantMessage(provider, history, cleanResponse);
      // 不发送 streamEnd，因为工具还在执行中
      // provider.postMessageToWebview({ type: 'streamEnd' });

      await this.processAgentTools(
        provider,
        history,
        newResponse,
        model,
        config,
        abortSignal,
        iteration + 1,
        customConfig,
        plan
      );
    } catch (error: any) {
      // 不发送 streamEnd，因为工具还在执行中
      // provider.postMessageToWebview({ type: 'streamEnd' });
      if (!axios.isCancel(error) && error.name !== 'CanceledError' && error.message !== 'canceled') {
        provider.postMessageToWebview({
          type: 'addErrorResponse',
          text: `工具调用错误: ${error.message}`
        });
      }
      // 标记结束处理工具
      this.finishProcessing(provider);
    }
  }

  private static async getCorrectedResponse(
    provider: LLMAChatProvider,
    model: string,
    config: vscode.WorkspaceConfiguration,
    history: ChatHistory,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const correctionSystemPrompt = `你是一个专业的错误修正专家。请根据以下错误信息，修正你的指令格式，确保符合以下要求：

1. 指令必须以 ">" 开头
2. 指令格式: > TOOL_TYPE: parameter
3. 代码块必须有语言标记
4. REPLACE 指令必须包含 <ORIGINAL> 和 <NEW> 标签
5. 所有参数必须完整且正确
6. 代码中的注释、字符串、变量名默认使用英文

请直接返回修正后的完整响应，不要包含任何解释性文字。`;

    const messages = [
      { role: 'system', content: correctionSystemPrompt },
      ...history.slice(-10)
    ];

    try {
      const apiKey = getApiKey(config, model);
      const response = await callChatAI(
        model,
        apiKey,
        messages,
        config,
        AI.AUXILIARY_MAX_TOKENS,
        0.3,
        abortSignal,
        undefined
      );

      return response;
    } catch (error: any) {
      provider.postMessageToWebview({
        type: 'addWarningResponse',
        text: `自动修正失败: ${error.message}`
      });
      return null;
    }
  }

  private static generateCorrectionPrompt(errors: string[]): string {
    const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
    
    return `【工具调用错误】
以下工具执行失败，请修正格式后重试：

${errorList}

请检查：
- 指令格式是否正确
- 参数是否完整
- 代码块是否包含语言标记
- REPLACE 指令的 <ORIGINAL> 和 <NEW> 标签是否闭合

请返回修正后的完整响应。`;
  }

  static createEnhancedSystemPrompt(): string {
    const basePrompt = getAgentSystemPrompt();
    
    const enhancement = `
【增强功能】
- 支持灵活的指令格式（允许空格、大小写变体）
- 自动检测并修正格式错误
- 工具执行失败时自动重试
- 模糊匹配函数名和类名
- 详细的错误建议和修复指导

【最佳实践】
1. 每次只执行一个主要操作
2. 修改前先 READ 查看当前内容
3. 使用 REPLACE 进行局部修改，避免全文件替换
4. 确保代码块有正确的语言标记
5. REPLACE 指令的 <ORIGINAL> 必须与文件内容完全一致
6. 代码注释、字符串、变量名默认使用英文`;

    return basePrompt + enhancement;
  }

  static async processAgentToolsWithValidation(
    provider: LLMAChatProvider,
    history: ChatHistory,
    aiResponse: string,
    model: string,
    config: vscode.WorkspaceConfiguration,
    abortSignal?: AbortSignal,
    iteration: number = 0,
    customConfig?: AgentToolConfig
  ): Promise<{ success: boolean; validationErrors: string[] }> {
    const resolvedConfig: AgentToolConfig = { ...this.DEFAULT_CONFIG, ...customConfig };
    const maxIterations = resolvedConfig.maxIterations ?? 15;

    if (iteration >= maxIterations) {
      provider.postMessageToWebview({
        type: 'addSystemMessage',
        text: `⚠️ 已达到最大工具调用次数 (${maxIterations})，停止自动调用。`
      });
      return { success: false, validationErrors: ['达到最大迭代次数'] };
    }

    if (abortSignal?.aborted) {
      return { success: false, validationErrors: ['操作已取消'] };
    }

    const context: ToolExecutionContext = {
      provider,
      history,
      config,
      abortSignal
    };

    const parseOptions: ToolParseOptions = {
      allowFlexibleFormat: true,
      suggestCorrections: true,
      normalizeWhitespace: true
    };

    const { results, validationErrors } = await ToolExecutor.validateAndExecute(
      aiResponse,
      context,
      parseOptions
    );

    let hadSuccess = false;

    for (const result of results) {
      if (result.success) {
        hadSuccess = true;
        if (result.toolType === 'READ') {
          provider.pendingReadContext.push({ role: 'user', content: result.output ?? '' });
        }
        // 工具执行成功不显示反馈，保持输出简洁
      } else {
        const errorMsg = `❌ 工具 ${result.toolType} 执行失败：${result.error}`;
        this.pushInternalFeedback(history, errorMsg, provider);
      }
    }

    if (validationErrors.length > 0) {
      const errorMsg = `【参数验证失败】\n${validationErrors.join('\n')}`;
      this.pushInternalFeedback(history, errorMsg, provider);
    }

    if (!hadSuccess || abortSignal?.aborted) {
      return { success: false, validationErrors };
    }

    await this.refineAndRetry(provider, history, model, config, abortSignal, iteration, customConfig);

    return { success: true, validationErrors };
  }

  private static hasToolCalls(content: string): boolean {
    const toolPatterns = [
      /^\s*>\s*(FILE|RUN|MKDIR|REPLACE|EDIT_FUNCTION|EDIT_CLASS|EDIT_LINE_CONTAINING|EDIT_BLOCK|RANGE_EDIT|DIFF|PROJECT|MULTI_FILE|APPLY_BATCH|MCP|READ):/im
    ];
    return toolPatterns.some(pattern => pattern.test(content));
  }

  private static isCompletionSignal(content: string): boolean {
    const completionPatterns = [
      /任务已完成|完成|结束|已解决|已经完成|all\s+done|completed?|finished|success/i,
      /没有其他|没有更多|无需再|不需要再|no\s+more|no\s+further|nothing\s+else/i,
      /已经满足|满足要求|符合要求|according\s+to|as\s+requested/i
    ];
    return completionPatterns.some(pattern => pattern.test(content));
  }

  private static analyzeTaskProgress(
    history: ChatHistory,
    userRequest: string
  ): { completed: boolean; progress: number; reasons: string[] } {
    const reasons: string[] = [];
    let toolCallCount = 0;
    let successCount = 0;
    let failureCount = 0;

    for (const msg of history) {
      if (msg.role === 'assistant' && this.hasToolCalls(msg.content)) {
        toolCallCount++;
      }
      if (msg.role !== 'assistant' || msg.content.startsWith('[执行反馈]')) {
        if (msg.content.includes('✅') || msg.content.includes('执行成功')) {
          successCount++;
        }
        if (msg.content.includes('❌') || msg.content.includes('执行失败')) {
          failureCount++;
        }
      }
    }

    if (successCount > 0 && failureCount === 0 && toolCallCount > 0) {
      reasons.push('所有工具调用均成功');
    }

    const lastAssistantMsg = history.filter(m => m.role === 'assistant').pop();
    if (lastAssistantMsg && this.isCompletionSignal(lastAssistantMsg.content)) {
      reasons.push('AI 明确表示任务完成');
    }

    // 最近回复无工具调用且已有成功执行 → 任务已完成，不需要继续
    if (lastAssistantMsg && !this.hasToolCalls(lastAssistantMsg.content) && successCount >= 1 && failureCount === 0) {
      reasons.push('最近回复无工具调用且已有成功执行');
    }

    const completed = reasons.length >= 1;
    const progress = toolCallCount === 0 ? 0 : Math.min(100, Math.round((successCount / toolCallCount) * 100));
    return { completed, progress, reasons };
  }

  private static async checkTaskCompletion(
    provider: LLMAChatProvider,
    history: ChatHistory,
    model: string,
    config: vscode.WorkspaceConfiguration,
    abortSignal?: AbortSignal
  ): Promise<{ completed: boolean; shouldContinue: boolean; feedback?: string }> {
    const taskAnalysis = this.analyzeTaskProgress(history, '');
    return {
      completed: taskAnalysis.completed,
      shouldContinue: !taskAnalysis.completed,
      feedback: taskAnalysis.completed
        ? `任务已完成: ${taskAnalysis.reasons.join('; ')}`
        : '继续执行'
    };
  }

  private static async performReflection(
    provider: LLMAChatProvider,
    history: ChatHistory,
    model: string,
    config: vscode.WorkspaceConfiguration,
    userRequest: string,
    abortSignal?: AbortSignal,
    iteration: number = 0
  ): Promise<{ shouldContinue: boolean; nextAction?: string }> {
    const reflectionPrompt = `你是一个自我反思专家。请分析你刚才的执行结果，判断是否需要继续或调整。

【用户原始请求】
${userRequest}

【最近执行历史】
${history.slice(-6).map(m => `${m.role}: ${m.content.substring(0, 300)}`).join('\n')}

请进行自我反思：
1. 刚才的执行是否成功解决了用户的问题？
2. 是否遗漏了某些关键步骤？
3. 是否有更好的实现方式？
4. 接下来应该做什么？

请返回以下格式：
REFLECTION: <你的反思分析>
NEXT_ACTION: <继续执行/调整策略/完成任务>
CONFIDENCE: <0-100的信心指数>`;

    try {
      const apiKey = getApiKey(config, model);
      const response = await callChatAI(
        model,
        apiKey,
        [{ role: 'system', content: reflectionPrompt }, { role: 'user', content: '请进行反思' }],
        config,
        3000,
        0.4,
        abortSignal
      );

      const nextActionMatch = response.match(/NEXT_ACTION:\s*(.+)/i);
      const nextAction = nextActionMatch ? nextActionMatch[1].trim().toLowerCase() : 'continue';

      const confidenceMatch = response.match(/CONFIDENCE:\s*(\d+)/i);
      const confidence = confidenceMatch ? parseInt(confidenceMatch[1], 10) : 50;

      if (nextAction.includes('完成') || nextAction.includes('结束') || confidence >= 90) {
        provider.postMessageToWebview({
          type: 'addSystemMessage',
          text: `🎯 反思结果: 任务似乎已完成 (信心指数: ${confidence}%)`
        });
        return { shouldContinue: false };
      }

      if (nextAction.includes('调整') || confidence < 50) {
        const adjustPrompt = `基于反思结果，请调整你的执行策略。刚才的反思指出需要改进的方向。请继续执行任务。`;
        this.pushInternalFeedback(history, adjustPrompt, provider);
        return { shouldContinue: true, nextAction: 'adjust' };
      }

      return { shouldContinue: true, nextAction: 'continue' };
    } catch (error) {
      return { shouldContinue: true, nextAction: 'continue' };
    }
  }

  private static extractUserRequest(history: ChatHistory): string {
    for (const msg of history) {
      if (
        msg.role === 'user' &&
        !msg.content.startsWith('[执行反馈]') &&
        !msg.content.startsWith('[任务规划]') &&
        !msg.content.startsWith('[自动诊断刷新]') &&
        !msg.content.includes('✅') &&
        !msg.content.includes('❌') &&
        !msg.content.includes('💡')
      ) {
        if (msg.content.length > 10 && msg.content.length < 500) {
          return msg.content;
        }
      }
    }
    return '';
  }
}
