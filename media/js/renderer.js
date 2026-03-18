/**
 * 流式消息渲染器
 * 负责管理 AI 消息的流式输出，确保 WYSIWYG 和流畅性
 */

class StreamBuffer {
  constructor() {
    this.content = '';
    this.reasoning = '';
    this.reasoningChunks = [];
  }

  appendContent(text) {
    this.content += text;
  }

  appendReasoning(text) {
    this.reasoning += text;
    this.reasoningChunks.push({ text, time: Date.now() });
  }

  extractThinkTags(text) {
    const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
    let match;
    while ((match = thinkRegex.exec(text)) !== null) {
      this.appendReasoning(match[1]);
    }
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();
  }

  clear() {
    this.content = '';
    this.reasoning = '';
    this.reasoningChunks = [];
  }

  getState() {
    return {
      content: this.content,
      reasoning: this.reasoning,
      hasContent: this.content.trim().length > 0,
      hasReasoning: this.reasoning.trim().length > 0
    };
  }
}

class MessageContainer {
  constructor(chatContainer) {
    this.chatContainer = chatContainer;
    this.element = null;
    this.contentContainer = null;
    this.isFinalized = false;
  }

  create() {
    this.element = document.createElement('div');
    this.element.className = 'message ai-message';

    const timeHtml = '<div class="message-time">' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      '</div>';

    this.contentContainer = document.createElement('div');
    this.contentContainer.className = 'message-content-container';
    this.contentContainer.style.position = 'relative';

    this.element.appendChild(this.contentContainer);
    this.element.insertAdjacentHTML('beforeend', timeHtml);
    this.chatContainer.appendChild(this.element);

    return this;
  }

  finalize(plainText) {
    if (this.isFinalized) return;
    if (!this.element || !this.contentContainer) return;

    this.element.dataset.plaintext = plainText;
    this.element.dataset.finalized = 'true';
    this.isFinalized = true;

    // 移除流式标记
    this.element.querySelectorAll('.streaming-cursor').forEach(el => el.remove());
    this.element.querySelectorAll('.content-block-streaming').forEach(el => {
      el.classList.remove('content-block-streaming');
    });

    // 添加操作按钮
    if (!this.contentContainer.querySelector('.message-actions')) {
      const actionsHtml = `
        <div class="message-actions">
          <button class="message-action-btn" onclick="copyMessage(this)" title="复制">📋</button>
          <button class="message-action-btn" onclick="quoteMessage(this)" title="引用到输入框">💬</button>
          <button class="message-action-btn" onclick="regenerateMessage(this)" title="重新生成">🔄</button>
          <button class="message-action-btn danger" onclick="deleteMessage(this)" title="删除">🗑️</button>
        </div>
      `;
      this.contentContainer.insertAdjacentHTML('afterbegin', actionsHtml);
    }
  }

  shouldReuse() {
    return this.element && !this.isFinalized;
  }

  remove() {
    if (this.element && this.element.parentNode) {
      this.element.remove();
    }
    this.element = null;
    this.contentContainer = null;
  }
}

class ContentRenderer {
  constructor() {
    this.lastRenderedContent = '';
    this.lastRenderedReasoning = '';
  }

  renderReasoning(reasoning, isStreaming) {
    if (!reasoning || reasoning === this.lastRenderedReasoning) {
      return null;
    }

    this.lastRenderedReasoning = reasoning;
    const tokenEst = estimateTokens(reasoning.trim());
    const progressIndicator = isStreaming ? '<span class="reasoning-progress-dots"></span>' : '';

    return `
      <details class="reasoning-block" ${isStreaming ? 'open' : ''}>
        <summary class="reasoning-summary">
          🤔 思考过程
          <span class="reasoning-token-count">(约 ${tokenEst} tokens)</span>
          ${progressIndicator}
        </summary>
        <div class="reasoning-content">${escapeHtml(reasoning.trim())}</div>
      </details>
    `;
  }

  renderContent(content, isStreaming) {
    if (!content || content === this.lastRenderedContent) {
      return null;
    }

    this.lastRenderedContent = content;
    const safeContent = closeIncompleteCodeBlocks(stripDirectiveMarkers(content));
    const blockClass = isStreaming && chatTypingEffect ? ' content-block-streaming' : '';
    const cursorHtml = isStreaming && chatTypingEffect ? '<span class="streaming-cursor"></span>' : '';

    return {
      html: formatMessageContent(safeContent, 'ai', false) + cursorHtml,
      className: 'content-block' + blockClass
    };
  }

  reset() {
    this.lastRenderedContent = '';
    this.lastRenderedReasoning = '';
  }
}

class MessageRenderer {
  constructor(chatContainer) {
    this.chatContainer = chatContainer;
    this.buffer = new StreamBuffer();
    this.container = new MessageContainer(chatContainer);
    this.contentRenderer = new ContentRenderer();
    this.updateScheduled = false;
    this._fileCards = new Map(); // filepath -> card DOM节点（跨 render 复用）
  }

  startStream(silent = false) {
    this.buffer.clear();
    this.contentRenderer.reset();

    if (!silent) {
      // 检查是否可以复用最后一个消息容器
      const lastMessage = this.chatContainer.querySelector('.message.ai-message:last-child');
      if (lastMessage && lastMessage.dataset.finalized !== 'true') {
        this.container.element = lastMessage;
        this.container.contentContainer = lastMessage.querySelector('.message-content-container');
        this.container.isFinalized = false;
      } else {
        this.container.create();
      }
    }
  }

  updateStream(content, reasoning) {
    if (reasoning) {
      this.buffer.appendReasoning(reasoning);
    }
    if (content) {
      this.buffer.appendContent(content);
    }

    // 如果是静默流且有内容，转为可见
    if (!this.container.element && (content || reasoning)) {
      const lastMessage = this.chatContainer.querySelector('.message.ai-message:last-child');
      if (lastMessage && lastMessage.dataset.finalized !== 'true') {
        this.container.element = lastMessage;
        this.container.contentContainer = lastMessage.querySelector('.message-content-container');
        this.container.isFinalized = false;
      } else {
        this.container.create();
      }
    }

    if (!this.container.element) return;

    // 使用 requestAnimationFrame 批量更新
    if (!this.updateScheduled) {
      this.updateScheduled = true;
      requestAnimationFrame(() => {
        this.updateScheduled = false;
        this.render();
      });
    }
  }

  render() {
    if (!this.container.contentContainer) return;

    const state = this.buffer.getState();
    const oldReasoning = this.container.contentContainer.querySelector('.reasoning-block');
    const oldContent = this.container.contentContainer.querySelector('.content-block');

    // 渲染思考过程
    if (state.hasReasoning) {
      const reasoningHtml = this.contentRenderer.renderReasoning(state.reasoning, true);
      if (reasoningHtml) {
        if (oldReasoning) {
          const temp = document.createElement('div');
          temp.innerHTML = reasoningHtml;
          oldReasoning.replaceWith(temp.firstChild);
        } else {
          this.container.contentContainer.insertAdjacentHTML('beforeend', reasoningHtml);
        }
      }
    }

    // 渲染内容 - 优化：仅在内容变化时更新
    if (state.hasContent) {
      const contentData = this.contentRenderer.renderContent(state.content, true);
      if (contentData) {
        if (oldContent) {
          // 优化：直接更新 innerHTML 而非替换整个节点，减少重排
          if (oldContent.innerHTML !== contentData.html) {
            oldContent.className = contentData.className;
            oldContent.innerHTML = contentData.html;

            // 在 DOM 中复用已有卡片节点
            oldContent.querySelectorAll('.file-action-card').forEach(newCard => {
              const fp = newCard.dataset.filepath;
              const oldCard = this._fileCards.get(fp);
              if (oldCard && oldCard.parentNode) {
                newCard.replaceWith(oldCard);
              } else {
                this._fileCards.set(fp, newCard);
              }
            });
          }
        } else {
          const newContent = document.createElement('div');
          newContent.className = contentData.className;
          newContent.innerHTML = contentData.html;

          newContent.querySelectorAll('.file-action-card').forEach(newCard => {
            const fp = newCard.dataset.filepath;
            const oldCard = this._fileCards.get(fp);
            if (oldCard) {
              newCard.replaceWith(oldCard);
            } else {
              this._fileCards.set(fp, newCard);
            }
          });

          this.container.contentContainer.appendChild(newContent);
        }
      }
    }

    // 流式渲染：延迟到下一帧读取 scrollHeight，确保 DOM reflow 完成后再滚动
    if (typeof userHasScrolledUp !== 'undefined' && !userHasScrolledUp) {
      requestAnimationFrame(() => {
        isProgrammaticScroll = true;
        chatContainer.scrollTop = chatContainer.scrollHeight;
        isProgrammaticScroll = false;
      });
    }
  }

  endStream() {
    const state = this.buffer.getState();
    const fullContent = (state.hasReasoning ? `<think>${state.reasoning}</think>\n` : '') + state.content;

    // 检查是否应该保留消息
    if (!hasRenderableAssistantMessage(fullContent)) {
      this.container.remove();
      this.reset();
      return { shouldKeep: false, content: '' };
    }

    // 确保容器存在
    if (!this.container.element) {
      const lastMessage = this.chatContainer.querySelector('.message.ai-message:last-child');
      if (lastMessage && lastMessage.dataset.finalized !== 'true') {
        this.container.element = lastMessage;
        this.container.contentContainer = lastMessage.querySelector('.message-content-container');
        this.container.isFinalized = false;
      } else {
        this.container.create();
      }
    }

    // 最终渲染
    this.renderFinal(state);

    // 完成消息
    if (this.container.element) {
      const plainText = stripDirectiveMarkers(state.content);
      this.container.finalize(plainText);
      syncMessageIndices();
    }

    // 重置渲染器以准备下一条消息
    this.reset();

    return { shouldKeep: true, content: fullContent };
  }

  renderFinal(state) {
    if (!this.container.contentContainer) return;

    const oldReasoning = this.container.contentContainer.querySelector('.reasoning-block');
    const oldContent = this.container.contentContainer.querySelector('.content-block');

    // 最终思考过程（折叠）
    if (state.hasReasoning) {
      const reasoningHtml = this.contentRenderer.renderReasoning(state.reasoning, false);
      if (reasoningHtml) {
        if (oldReasoning) {
          const temp = document.createElement('div');
          temp.innerHTML = reasoningHtml;
          oldReasoning.replaceWith(temp.firstChild);
        } else {
          this.container.contentContainer.insertAdjacentHTML('beforeend', reasoningHtml);
        }
      }
    }

    // 最终内容：离屏构建，替换卡片节点后一次性插入
    if (state.hasContent) {
      const newContent = document.createElement('div');
      newContent.className = 'content-block';
      newContent.innerHTML = formatMessageContent(stripDirectiveMarkers(state.content), 'ai', true);

      // 离屏把新节点里的卡片替换为旧节点（保留已有状态如按钮）
      newContent.querySelectorAll('.file-action-card').forEach(newCard => {
        const fp = newCard.dataset.filepath;
        const oldCard = this._fileCards.get(fp);
        if (oldCard) {
          newCard.replaceWith(oldCard);
        }
      });

      if (oldContent) {
        oldContent.replaceWith(newContent);
      } else {
        this.container.contentContainer.appendChild(newContent);
      }
    }
  }

  reset() {
    this.container = new MessageContainer(this.chatContainer);
    this.buffer.clear();
    this.contentRenderer.reset();
    this._fileCards = new Map();
  }
}

// 全局渲染器实例
let messageRenderer = null;

function initMessageRenderer() {
  messageRenderer = new MessageRenderer(chatContainer);
}
