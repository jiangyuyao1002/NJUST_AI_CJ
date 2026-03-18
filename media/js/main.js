    // 辅助函数：将消息写入日志文件
    function logMessage(role, content) {
      vscode.postMessage({ type: 'appendToLog', role, content });
    }
    
    function init() {
      initMessageRenderer();
      updateModifyDecisionBar();
      setMode('chat');
      const savedState = vscode.getState();
      if (savedState) {
        if (savedState.attachedFiles) { attachedFiles = savedState.attachedFiles; renderFileChips(); }
        if (savedState.currentMode) setMode(savedState.currentMode);
        if (savedState.isWebSearchEnabled !== undefined) {
          isWebSearchEnabled = savedState.isWebSearchEnabled;
          webSearchToggleBtn.classList.toggle('active', isWebSearchEnabled);
        }
      }
      updateCustomSelectFromNative();
      vscode.postMessage({ type: 'getSettings' });
      bindEvents();
      bindCustomSelectEvents();
      initInputModeSelector();
      vscode.postMessage({ type: 'refreshContext' });
      updateAttachmentsBar();
      setupDragAndDrop();

      // 用 wheel 事件检测用户主动滚动意图，避免流式输出撑高内容时误判
      chatContainer.addEventListener('wheel', () => {
        if (isProgrammaticScroll) { return; }
        const threshold = 80;
        userHasScrolledUp = (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) > threshold;
      }, { passive: true });

      // scroll 事件仅用于检测用户滚回底部时恢复自动跟随
      chatContainer.addEventListener('scroll', () => {
        if (isProgrammaticScroll) { return; }
        const atBottom = (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) <= 80;
        if (atBottom) { userHasScrolledUp = false; }
      });

      // 文件路径点击打开编辑器（事件委托）
      chatContainer.addEventListener('click', function(e) {
        var fp = e.target.closest('.file-path');
        if (fp && fp.dataset.filepath) {
          var card = fp.closest('.file-action-card');
          if (card && card.dataset.filepath) {
            vscode.postMessage({ type: 'openFileInEditor', filepath: card.dataset.filepath });
          }
        }
        var img = e.target.closest('.content-block img[src^="data:image"]');
        if (img && img.src) showImageModal(img.src);
      });

      updateConnectionStatus(navigator.onLine ? 'online' : 'offline');
      window.addEventListener('online', function() { updateConnectionStatus('online'); });
      window.addEventListener('offline', function() { updateConnectionStatus('offline'); });
    }

    function updateConnectionStatus(state) {
      var el = document.getElementById('connection-status');
      if (!el) return;
      el.className = 'connection-status ' + state;
      el.title = state === 'online' ? '连接正常' : (state === 'offline' ? '网络已断开' : '连接异常');
      el.querySelector('.connection-status-text').textContent = state === 'online' ? '在线' : (state === 'offline' ? '离线' : '异常');
    }

    // 根据原生 select 的值更新自定义下拉显示
    function updateCustomSelectFromNative() {
      const selectedOption = modelSelect.options[modelSelect.selectedIndex];
      if (selectedOption) {
        const value = selectedOption.value;
        const text = selectedOption.text;
        selectedTextSpan.textContent = text;
        // 更新图标类（custom 使用 local-icon）
        const iconClass = value === 'custom' ? 'local-icon' : value + '-icon';
        selectedIconSpan.className = 'icon ' + iconClass;
        // 同时高亮对应的选项
        options.forEach(opt => {
          if (opt.dataset.value === value) {
            opt.classList.add('active');
          } else {
            opt.classList.remove('active');
          }
        });
      }
    }

    // 自定义下拉事件绑定
    function bindCustomSelectEvents() {
      // 点击显示框切换下拉列表
      selectedDisplay.addEventListener('click', function(e) {
        e.stopPropagation();
        const isHidden = selectItems.style.display === 'none';
        selectItems.style.display = isHidden ? 'block' : 'none';
      });

      // 点击选项
      options.forEach(opt => {
        opt.addEventListener('click', function(e) {
          e.stopPropagation();
          const value = this.dataset.value;
          const text = this.textContent.trim();
          // 更新原生 select 的值
          modelSelect.value = value;
          // 触发 change 事件，使原有监听器生效
          modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
          // 更新自定义显示
          selectedTextSpan.textContent = text;
          const iconClass = value === 'custom' ? 'local-icon' : value + '-icon';
          selectedIconSpan.className = 'icon ' + iconClass;
          // 隐藏下拉
          selectItems.style.display = 'none';
          // 高亮当前选项
          options.forEach(o => o.classList.remove('active'));
          this.classList.add('active');
        });
      });

      // 点击外部关闭下拉
      document.addEventListener('click', function() {
        selectItems.style.display = 'none';
      });

      // 阻止点击下拉内容时关闭（因为上面已经阻止冒泡）
      selectItems.addEventListener('click', function(e) {
        e.stopPropagation();
      });
    }

    function initInputModeSelector() {
      const inputModeDisplay = document.getElementById('input-mode-display');
      const inputModeItems = document.getElementById('input-mode-items');
      const modeOptions = document.querySelectorAll('#input-mode-items .mode-panel-option');
      if (!modeChatBtn || !modeAgentBtn || !inputModeDisplay || !inputModeItems || !modeOptions.length) return;

      const inputTextSpan = inputModeDisplay.querySelector('.selected-text');
      if (!inputTextSpan) return;

      function getActiveMode() {
        return modeAgentBtn.classList.contains('active') ? 'agent' : 'chat';
      }

      function syncInputModeLabel(mode) {
        inputTextSpan.textContent = mode === 'agent' ? '🤖 Agent 模式' : '💬 聊天模式';
      }

      syncInputModeLabel(getActiveMode());

      inputModeDisplay.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();

        if (selectItems) {
          selectItems.style.display = 'none';
        }

        const isHidden = inputModeItems.style.display === 'none';
        inputModeItems.style.display = isHidden ? 'block' : 'none';
      });

      modeOptions.forEach(option => {
        option.addEventListener('click', function(e) {
          e.stopPropagation();
          e.preventDefault();

          const mode = this.dataset.mode === 'agent' ? 'agent' : 'chat';
          syncInputModeLabel(mode);
          inputModeItems.style.display = 'none';

          // 始终通过统一的 setMode() 更新真实状态、占位符与持久化数据
          setMode(mode);
        });
      });

      document.addEventListener('click', function(e) {
        if (!inputModeDisplay.contains(e.target) && !inputModeItems.contains(e.target)) {
          inputModeItems.style.display = 'none';
        }
      });

      const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          if (mutation.attributeName === 'class') {
            syncInputModeLabel(getActiveMode());
          }
        });
      });

      observer.observe(modeChatBtn, { attributes: true });
      observer.observe(modeAgentBtn, { attributes: true });
    }
    
    function bindEvents() {
      modeChatBtn.addEventListener('click', () => setMode('chat'));
      modeAgentBtn.addEventListener('click', () => setMode('agent'));
      sendBtn.addEventListener('click', sendMessage);
      stopBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'stopGeneration' });
        isGenerating = false;
        updateButtonState();
        messageRenderer.endStream();
      });
      
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      });
      attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectContextFiles' }));
      webSearchToggleBtn.addEventListener('click', () => {
        isWebSearchEnabled = !isWebSearchEnabled;
        webSearchToggleBtn.classList.toggle('active', isWebSearchEnabled);
        saveState();
      });
      compileBtn.addEventListener('click', () => vscode.postMessage({ type: 'compileCurrentFile' }));
      refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshContext' }));
      keepChangesBtn.addEventListener('click', () => {
        keepChangesBtn.disabled = true;
        discardChangesBtn.disabled = true;
        vscode.postMessage({ type: 'keepAllChanges' });
      });
      discardChangesBtn.addEventListener('click', () => {
        keepChangesBtn.disabled = true;
        discardChangesBtn.disabled = true;
        vscode.postMessage({ type: 'discardAllChanges' });
      });
      
      settingsBtn.addEventListener('click', () => {
        const model = modelSelect.value;
        switchSettingsTab(model === 'local' ? 'local' : (model === 'custom' ? 'custom' : 'online'));
        vscode.postMessage({ type: 'getSettings' });
        settingsModal.style.display = 'flex';
      });
      closeSettingsBtn.addEventListener('click', () => settingsModal.style.display = 'none');
      saveSettingsBtn.addEventListener('click', saveSettings);
      document.querySelectorAll('.settings-tab').forEach(tab => tab.addEventListener('click', () => switchSettingsTab(tab.dataset.tab)));
      modelSelect.addEventListener('change', (e) => {
        const model = e.target.value;
        switchSettingsTab(model === 'local' ? 'local' : (model === 'custom' ? 'custom' : 'online'));
        // 同时更新自定义下拉显示
        updateCustomSelectFromNative();
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
      
      // 新对话按钮事件：先保存当前会话，再清空界面
      newChatBtn.addEventListener('click', () => {
        // 如果有历史消息，保存当前会话
        if (history.length > 0) {
          vscode.postMessage({ type: 'saveCurrentSession' });
        }
        // 清空当前会话
        history = [];
        modifiedFiles.clear();
        updateModifyDecisionBar();
        clearTaskProgress();
        chatContainer.innerHTML = '';
        addWelcomeMessage();
        persistHistory();
        saveState();
      });

      // 历史记录按钮事件
      historyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'getSessions' });
        historyModal.style.display = 'flex';
      });
      closeHistoryBtn.addEventListener('click', () => historyModal.style.display = 'none');
      refreshHistoryBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'getSessions' });
      });
      clearAllHistoryBtn?.addEventListener('click', () => {
        const footer = clearAllHistoryBtn.closest('.modal-footer');
        if (footer.querySelector('.history-confirm-bar')) { return; }
        const bar = document.createElement('div');
        bar.className = 'history-confirm-bar';
        bar.innerHTML = '<span>确认清空全部？</span><button class="confirm-yes">确认</button><button class="confirm-no">取消</button>';
        footer.appendChild(bar);
        bar.querySelector('.confirm-yes').addEventListener('click', () => {
          vscode.postMessage({ type: 'clearAllSessions' });
          bar.remove();
        });
        bar.querySelector('.confirm-no').addEventListener('click', () => bar.remove());
      });

      searchBtn.addEventListener('click', () => {
        searchInline.style.display = searchInline.style.display === 'none' ? 'flex' : 'none';
        if (searchInline.style.display === 'flex') chatSearchInput.focus();
      });
      searchCloseBtn.addEventListener('click', () => {
        searchInline.style.display = 'none';
        chatSearchInput.value = '';
        clearSearchHighlights();
      });
      chatSearchInput.addEventListener('input', () => applySearchHighlight(chatSearchInput.value));
      chatSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { searchInline.style.display = 'none'; chatSearchInput.value = ''; clearSearchHighlights(); }
      });

      var ctxMenu = document.getElementById('context-menu');
      var ctxMenuTarget = null;
      chatContainer.addEventListener('contextmenu', function(e) {
        var msg = e.target.closest('.message');
        var codeEl = e.target.closest('pre code, .code-block code');
        if (msg || codeEl) {
          e.preventDefault();
          ctxMenuTarget = codeEl ? { text: codeEl.textContent, type: 'code' } : { msg: msg, type: 'message' };
          ctxMenu.style.display = 'block';
          ctxMenu.style.left = e.clientX + 'px';
          ctxMenu.style.top = e.clientY + 'px';
        }
      });
      document.addEventListener('click', function() { ctxMenu.style.display = 'none'; ctxMenuTarget = null; });
      ctxMenu.querySelector('[data-action="quote"]').addEventListener('click', function() {
        if (!ctxMenuTarget) return;
        var text = ctxMenuTarget.type === 'code' ? ctxMenuTarget.text : (ctxMenuTarget.msg.dataset.plaintext || '');
        if (text) {
          input.value = '> ' + text.replace(/\n/g, '\n> ') + '\n\n' + (input.value || '');
          input.focus();
        }
        ctxMenu.style.display = 'none';
        ctxMenuTarget = null;
      });
    }

    function updateModifyDecisionBar() {
      if (!modifyDecisionBar) return;
      const visible = modifiedFiles.size > 0 && !isGenerating && !isAgentPaused;
      modifyDecisionBar.style.display = visible ? 'flex' : 'none';
      if (visible) modifyDecisionBar.classList.add('visible');
      else modifyDecisionBar.classList.remove('visible');
    }

    function clearSearchHighlights() {
      chatContainer.querySelectorAll('.search-highlight').forEach(function(el) {
        const parent = el.parentNode;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      });
    }

    function applySearchHighlight(query) {
      clearSearchHighlights();
      if (!query || query.length < 2) return;
      const re = new RegExp(escapeRegex(query), 'gi');
      chatContainer.querySelectorAll('.message .content-block, .message .reasoning-content').forEach(function(block) {
        highlightTextNodes(block, query, re);
      });
      var first = chatContainer.querySelector('.search-highlight');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function highlightTextNodes(node, query, regex) {
      if (node.nodeType === 3) {
        var text = node.textContent;
        var frag = document.createDocumentFragment();
        var lastIdx = 0;
        var m;
        regex.lastIndex = 0;
        while ((m = regex.exec(text)) !== null) {
          if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.substring(lastIdx, m.index)));
          var span = document.createElement('span');
          span.className = 'search-highlight';
          span.textContent = m[0];
          frag.appendChild(span);
          lastIdx = m.index + m[0].length;
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.substring(lastIdx)));
        if (frag.childNodes.length > 0) node.parentNode.replaceChild(frag, node);
        return;
      }
      if (node.nodeType === 1 && !/SCRIPT|STYLE/i.test(node.tagName)) {
        var child = node.firstChild;
        while (child) {
          var next = child.nextSibling;
          highlightTextNodes(child, query, regex);
          child = next;
        }
      }
    }

    // 拖拽功能设置
    function setupDragAndDrop() {
      if (!chatContainer || !dropOverlay) return;

      chatContainer.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.style.display = 'flex';
      });

      chatContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.style.display = 'flex';
      });

      chatContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.relatedTarget === null || !chatContainer.contains(e.relatedTarget)) {
          dropOverlay.style.display = 'none';
        }
      });

      chatContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.style.display = 'none';

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        // 限制文件大小（例如 10MB）
        const MAX_SIZE = 10 * 1024 * 1024; // 10MB
        const oversizedFiles = files.filter(f => f.size > MAX_SIZE);
        if (oversizedFiles.length > 0) {
          vscode.postMessage({
            type: 'addWarningResponse',
            text: `以下文件超过 10MB 限制，已被忽略：${oversizedFiles.map(f => f.name).join(', ')}`
          });
        }

        const validFiles = files.filter(f => f.size <= MAX_SIZE);
        if (validFiles.length === 0) return;

        // 逐个处理文件
        for (const file of validFiles) {
          await processDroppedFile(file);
        }

        renderFileChips();
        updateAttachmentsBar();
        saveState();
      });

      document.addEventListener('dragend', () => {
        dropOverlay.style.display = 'none';
      });
    }

    async function processDroppedFile(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        const fileType = file.type;
        const isImage = fileType.startsWith('image/');

        // 限制处理的文件类型（可自定义）
        const allowedTextTypes = [
          'text/plain', 'text/html', 'text/css', 'text/javascript',
          'application/json', 'application/xml', 'text/markdown',
          'application/typescript', 'application/x-python-code',
          'text/x-python', 'text/x-c', 'text/x-c++src', 'text/x-java',
          'text/x-php', 'text/x-ruby', 'text/x-go', 'text/x-rust'
        ];

        if (isImage) {
          reader.onload = (e) => {
            attachedFiles.push({
              name: file.name,
              content: e.target.result, // data URL
              isImage: true
            });
            resolve();
          };
          reader.readAsDataURL(file);
        } else if (allowedTextTypes.includes(fileType) || file.name.match(/\.(txt|md|js|ts|py|c|cpp|java|php|rb|go|rs|json|xml|css|html)$/i)) {
          reader.onload = (e) => {
            attachedFiles.push({
              name: file.name,
              content: e.target.result, // 文本内容
              isImage: false
            });
            resolve();
          };
          reader.readAsText(file, 'utf-8');
        } else {
          // 不支持的文件类型，忽略
          console.log(`忽略不支持的文件类型: ${file.name} (${fileType})`);
          resolve();
        }
      });
    }

    function addWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = `
          <h3>✨ NJUST_AI_Assistant 已就绪</h3>
          <ul>
            <li>🔄 <strong>聊天模式</strong>: 获取代码建议和解答，支持多种大模型</li>
            <li>🤖 <strong>Agent 模式</strong>: 直接创建、修改文件并编译代码</li>
            <li>⚡️ <strong>快捷键</strong>: Ctrl+Shift+B编译当前文件、Ctrl+Shift+A自动填写代码</li>
            <li>💡 <strong>提示</strong>: 📎添加上下文，🌐开启网络搜索，📜查看历史记录，或直接拖拽文件上传</li>
          </ul>
          <div class="feature-badges">
            <span class="badge">代码生成</span>
            <span class="badge">智能预测</span>
            <span class="badge">文件编译</span>
            <span class="badge">联网搜索</span>
            <span class="badge">流式输出</span>
          </div>
        `;
        chatContainer.appendChild(welcomeDiv);
    }
    
    function setMode(mode) {
      currentMode = mode;
      modeChatBtn.classList.remove('active');
      modeAgentBtn.classList.remove('active');
      (mode === 'chat' ? modeChatBtn : modeAgentBtn).classList.add('active');
      input.placeholder = mode === 'agent' ? "输入指令，例如：'创建 src/utils.ts'..." : "输入问题或代码请求... (Enter 发送)";
      const inputTextSpan = document.querySelector('#input-mode-display .selected-text');
      if (inputTextSpan) { inputTextSpan.textContent = mode === 'agent' ? '🤖 Agent 模式' : '💬 聊天模式'; }
      saveState();
    }
    
    // 持久化当前历史到扩展存储（用于重启恢复）
    function persistHistory() {
      const historyToSave = history
        .filter(function(msg) {
          return msg.role !== 'assistant' || hasRenderableAssistantMessage(msg.content);
        })
        .slice(-50);
      vscode.postMessage({ type: 'updateHistory', history: historyToSave });
    }
    
    function sendMessage() {
      const text = input.value.trim();
      if (!text || isGenerating) return;
      
      var lastAiMessage = chatContainer.querySelector('.message.ai-message:last-child');
      if (lastAiMessage) {
        lastAiMessage.dataset.finalized = 'true';
      }
      
      addMessage(text, 'user');
      logMessage('user', text);
      
      input.value = '';
      input.style.height = 'auto';
      
      isGenerating = true;
      updateButtonState();
      
      vscode.postMessage({
        type: 'sendMessage',
        text: text,
        history: history,
        model: modelSelect.value,
        mode: currentMode,
        files: attachedFiles, // 发送对象数组，包含 name, content, isImage
        useWebSearch: isWebSearchEnabled
      });
      history.push({ role: 'user', content: text });
      persistHistory();
      saveState();
    }

    // ========== 渲染逻辑 ==========
    
    function addMessage(text, type, isError = false) {
      if (type === 'ai' && !isError && !hasRenderableAssistantMessage(text)) {
        return;
      }
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + type + '-message';

      let plainText = text;
      if (type === 'ai') {
        plainText = stripDirectiveMarkers(text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart());
      }
      messageDiv.dataset.plaintext = plainText;

      // 构建消息主体 HTML
      let contentHtml = '';
      if (isError) {
        contentHtml = '<span>' + escapeHtml(text).replace(/\n/g, '<br>') + '</span>';
      } else if (type === 'ai') {
        // 提取思考过程
        let reasoning = '';
        const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
        let match;
        while ((match = thinkRegex.exec(text)) !== null) {
            reasoning += (reasoning ? '\n' : '') + match[1];
        }
        const cleanContent = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();

        let htmlStr = '';
        if (reasoning) {
            const tokenEst = estimateTokens(reasoning.trim());
            htmlStr += '<details class="reasoning-block">' +
                       '<summary>🤔 思考过程 <span class="reasoning-token-count">(约 ' + tokenEst + ' tokens)</span></summary>' +
                       '<div class="reasoning-content">' + escapeHtml(reasoning.trim()) + '</div>' +
                       '</details>';
        }
        htmlStr += '<div class="content-block">' + formatMessageContent(cleanContent, type, true) + '</div>';
        contentHtml = htmlStr;
      } else {
        contentHtml = formatMessageContent(text, type, true);
      }

      // 时间戳
      const timeHtml = '<div class="message-time">' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';

      // 操作按钮：复制、引用、编辑(用户)、重新生成(AI)、删除
      let actionsHtml = '<div class="message-actions">';
      actionsHtml += '<button class="message-action-btn" onclick="copyMessage(this)" title="复制">📋</button>';
      actionsHtml += '<button class="message-action-btn" onclick="quoteMessage(this)" title="引用到输入框">💬</button>';
      if (type === 'user') {
        actionsHtml += '<button class="message-action-btn" onclick="editMessage(this)" title="编辑并重新发送">✏️</button>';
      } else if (type === 'ai') {
        actionsHtml += '<button class="message-action-btn" onclick="regenerateMessage(this)" title="重新生成">🔄</button>';
      }
      actionsHtml += '<button class="message-action-btn danger" onclick="deleteMessage(this)" title="删除">🗑️</button>';
      actionsHtml += '</div>';

      messageDiv.innerHTML = `
          <div style="position:relative;">
              ${actionsHtml}
              ${contentHtml}
          </div>
          ${timeHtml}
      `;

      chatContainer.appendChild(messageDiv);
      syncMessageIndices();
      smartScroll();
    }

    function syncMessageIndices() {
      let idx = 0;
      chatContainer.querySelectorAll('.message.user-message, .message.ai-message').forEach(function(el) {
        el.dataset.historyIndex = String(idx++);
      });
    }

    window.deleteMessage = function(btn) {
      const msgDiv = btn.closest('.message');
      if (!msgDiv) return;
      const idx = parseInt(msgDiv.dataset.historyIndex, 10);
      const role = msgDiv.classList.contains('user-message') ? 'user' : 'assistant';
      if (role === 'user') {
        history.splice(idx, 2);
        msgDiv.remove();
        var next = msgDiv.nextElementSibling;
        while (next && !next.classList.contains('ai-message')) next = next.nextElementSibling;
        if (next) next.remove();
      } else {
        history.splice(idx, 1);
        msgDiv.remove();
      }
      syncMessageIndices();
      persistHistory();
    };

    window.quoteMessage = function(btn) {
      const msgDiv = btn.closest('.message');
      if (!msgDiv || !msgDiv.dataset.plaintext) return;
      const quoted = '> ' + msgDiv.dataset.plaintext.replace(/\n/g, '\n> ') + '\n\n';
      input.value = quoted + (input.value || '');
      input.focus();
    };

    window.editMessage = function(btn) {
      const msgDiv = btn.closest('.message');
      if (!msgDiv || !msgDiv.dataset.plaintext) return;
      const idx = parseInt(msgDiv.dataset.historyIndex, 10);
      if (isNaN(idx) || idx < 0) return;
      input.value = msgDiv.dataset.plaintext;
      input.focus();
      deleteMessage(btn);
    };

    window.regenerateMessage = function(btn) {
      const msgDiv = btn.closest('.message');
      if (!msgDiv) return;
      const idx = parseInt(msgDiv.dataset.historyIndex, 10);
      if (isNaN(idx) || idx < 0 || idx === 0) return;
      const lastUserContent = history[idx - 1] && history[idx - 1].role === 'user' ? history[idx - 1].content : '';
      if (!lastUserContent) return;
      history.splice(idx, 1);
      msgDiv.remove();
      syncMessageIndices();
      persistHistory();
      if (isGenerating) return;
      vscode.postMessage({
        type: 'sendMessage',
        text: lastUserContent,
        history: history.slice(0, idx - 1),
        model: modelSelect.value,
        mode: currentMode,
        files: attachedFiles,
        useWebSearch: isWebSearchEnabled
      });
      isGenerating = true;
      updateButtonState();
    };
    
    function addSystemMessage(text, important) {
        const lastChild = chatContainer.lastElementChild;

        if (important) {
          // 重要消息始终独立显示
          const sysDiv = document.createElement('div');
          sysDiv.className = 'system-message';
          sysDiv.textContent = text;
          chatContainer.appendChild(sysDiv);
          if (!userHasScrolledUp) { isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; }); }
          return;
        }

        // 如果上一个元素是 agent-steps-group，追加到其中
        if (lastChild && lastChild.classList.contains('agent-steps-group')) {
          const list = lastChild.querySelector('.steps-list');
          const item = document.createElement('div');
          item.className = 'step-item';
          item.textContent = text;
          list.appendChild(item);
          const count = list.children.length;
          lastChild.querySelector('.steps-summary-text').textContent = `Agent 执行步骤 (${count})`;
          if (!userHasScrolledUp) { isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; }); }
          return;
        }

        // 如果上一个元素是 ai-message 或 loading-indicator，创建新折叠组
        if (lastChild && (lastChild.classList.contains('ai-message') || lastChild.classList.contains('loading-indicator') || lastChild.classList.contains('system-message'))) {
          // 如果正好前一个是单独的 system-message，先把它移入新组
          let prevText = null;
          if (lastChild.classList.contains('system-message')) {
            prevText = lastChild.textContent;
            lastChild.remove();
          }

          const group = document.createElement('details');
          group.className = 'agent-steps-group';
          const summary = document.createElement('summary');
          summary.innerHTML = '<span class="steps-summary-text">Agent 执行步骤 (1)</span>';
          group.appendChild(summary);
          const list = document.createElement('div');
          list.className = 'steps-list';

          if (prevText) {
            const prevItem = document.createElement('div');
            prevItem.className = 'step-item';
            prevItem.textContent = prevText;
            list.appendChild(prevItem);
          }

          const item = document.createElement('div');
          item.className = 'step-item';
          item.textContent = text;
          list.appendChild(item);
          summary.querySelector('.steps-summary-text').textContent = `Agent 执行步骤 (${list.children.length})`;
          group.appendChild(list);
          chatContainer.appendChild(group);
          if (!userHasScrolledUp) { isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; }); }
          return;
        }

        // 默认情况：独立显示
        const sysDiv = document.createElement('div');
        sysDiv.className = 'system-message';
        sysDiv.textContent = text;
        chatContainer.appendChild(sysDiv);
        if (!userHasScrolledUp) { isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; }); }
    }

    function clearTaskProgress() {
        if (taskProgressEl && taskProgressEl.parentNode) {
            taskProgressEl.parentNode.removeChild(taskProgressEl);
        }
        taskProgressEl = null;
    }

    function updateTaskProgress(progress, currentStep, totalSteps) {
        if (!taskProgressEl || !chatContainer.contains(taskProgressEl)) {
            taskProgressEl = document.createElement('div');
            taskProgressEl.className = 'task-progress-bar';
            taskProgressEl.innerHTML = '<div class="task-progress-track"><div class="task-progress-fill"></div></div><span class="task-progress-text"></span>';
            chatContainer.appendChild(taskProgressEl);
        }
        const fill = taskProgressEl.querySelector('.task-progress-fill');
        const text = taskProgressEl.querySelector('.task-progress-text');
        if (fill) fill.style.width = (progress || 0) + '%';
        if (text) text.textContent = '步骤 ' + (currentStep || 0) + '/' + (totalSteps || 0);
        if (!userHasScrolledUp) { isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; }); }
    }

    // 将 ANSI 转义序列解析为 HTML（支持常见颜色）
    function parseAnsiToHtml(text) {
      if (!text) return '';
      const ansiColors = {
        30: '#3f4451', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef',
        35: '#c678dd', 36: '#56b6c2', 37: '#abb2bf',
        90: '#5c6370', 91: '#e06c75', 92: '#98c379', 93: '#e5c07b', 94: '#61afef',
        95: '#c678dd', 96: '#56b6c2', 97: '#abb2bf'
      };
      const bgColors = {
        40: '#3f4451', 41: '#e06c75', 42: '#98c379', 43: '#e5c07b', 44: '#61afef',
        45: '#c678dd', 46: '#56b6c2', 47: '#abb2bf'
      };
      let html = '';
      let i = 0;
      let fg = null, bg = null, bold = false;
      const flushStyle = () => {
        const parts = [];
        if (fg) parts.push('color:' + fg);
        if (bg) parts.push('background-color:' + bg);
        if (bold) parts.push('font-weight:bold');
        return parts.length ? ' style="' + parts.join(';') + '"' : '';
      };
      while (i < text.length) {
        if (text.charCodeAt(i) === 27 && text[i + 1] === '[') {
          let j = i + 2;
          const codes = [];
          while (j < text.length) {
            let num = '';
            while (j < text.length && text[j] >= '0' && text[j] <= '9') num += text[j++];
            if (num) {codes.push(parseInt(num, 10));}
            if (text[j] === ';') {j++;}
            else {break;}
          }
          if (text[j] === 'm') j++;
          for (const c of codes) {
            if (c === 0) { fg = null; bg = null; bold = false; }
            else if (c === 1) bold = true;
            else if (c === 22) {bold = false;}
            else if (c === 39) {fg = null;}
            else if (c === 49) {bg = null;}
            else if (ansiColors[c]) fg = ansiColors[c];
            else if (bgColors[c]) bg = bgColors[c];
          }
          i = j;
        } else {
          const next = text.indexOf('\x1b', i);
          const chunk = next >= 0 ? text.slice(i, next) : text.slice(i);
          const escaped = escapeHtml(chunk).replace(/\n/g, '<br>');
          if (escaped) html += '<span' + flushStyle() + '>' + escaped + '</span>';
          i = next >= 0 ? next : text.length;
        }
      }
      return html || escapeHtml(text).replace(/\n/g, '<br>');
    }

    function addMcpToolCard(serverName, toolName, args, result, status) {
        const card = document.createElement('div');
        card.className = 'mcp-tool-card ' + (status === 'error' ? 'mcp-error' : 'mcp-success');
        const argsStr = args && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '{}';
        const safeArgs = escapeHtml(argsStr);
        const safeResult = result ? escapeHtml(result) : '';
        const safeServer = escapeHtml(serverName || '');
        const safeTool = escapeHtml(toolName || '');
        card.innerHTML =
          '<div class="mcp-header">' +
            '<span class="mcp-icon">' + (status === 'error' ? '❌' : '✅') + '</span>' +
            '<span class="mcp-title">MCP 工具</span>' +
            '<span class="mcp-badge">' + safeServer + ' / ' + safeTool + '</span>' +
          '</div>' +
          '<details class="mcp-details"><summary>参数</summary><pre class="mcp-pre">' + safeArgs + '</pre></details>' +
          '<details class="mcp-details" open><summary>结果</summary><pre class="mcp-pre">' + safeResult + '</pre></details>';
        chatContainer.appendChild(card);
        smartScroll();
    }

    function addTerminalOutputCard(command, output, exitCode, id) {
        // 用 id 去重，避免重复渲染
        if (id && chatContainer.querySelector('.terminal-output-card[data-id="' + id + '"]')) {
          return;
        }

        const card = document.createElement('div');
        card.className = 'terminal-output-card';
        if (id) card.dataset.id = id;

        const isError = exitCode !== undefined && exitCode !== 0;
        const headerLabel = isError ? `终端 (exit: ${exitCode})` : '终端';

        let bodyHtml = '<span class="cmd-line">$ ' + escapeHtml(command) + '</span><br>';
        if (output && output.trim()) {
          const outputClass = isError ? 'cmd-error' : 'cmd-output';
          const parsedOutput = parseAnsiToHtml(output);
          bodyHtml += '<span class="' + outputClass + '">' + parsedOutput + '</span>';
        } else {
          bodyHtml += '<span class="cmd-output" style="opacity: 0.5; font-style: italic;">(无输出)</span>';
        }

        card.innerHTML =
          '<div class="terminal-header"><span class="terminal-icon">⬛</span> ' + headerLabel + '</div>' +
          '<div class="terminal-body">' + bodyHtml + '</div>';

        chatContainer.appendChild(card);
        smartScroll();
    }

    function addCompilationCard(success, message, filePath, executablePath, language) {
    const div = document.createElement('div');
    div.className = 'compilation-card ' + (success ? 'success' : 'error');
    
    // 检查消息是否已经包含编译状态
    let hasStatus = message.includes('编译成功') || message.includes('编译失败');
    
    // 构建HTML
    let html = '';
    
    // 只添加一次标题
    if (!hasStatus) {
        html += '<div class="comp-header">' + (success ? '✅ 编译成功' : '❌ 编译失败') + '</div>';
    }
    
    // 使用 Marked 解析编译输出
    let formattedMsg = "";
    try {
         if (!window.markedConfigured) { configureMarked(); }
         formattedMsg = marked.parse(message);
    } catch(e) {
         formattedMsg = escapeHtml(message).replace(/\n/g, '<br>');
    }
        
    // 移除消息中可能重复的状态信息
    formattedMsg = formattedMsg.replace(/❌ \*\*编译失败\*\*/g, '');
    formattedMsg = formattedMsg.replace(/✅ \*\*编译成功！\*\*/g, '');
    
    html += '<div class="comp-details">' + formattedMsg + '</div>';
        
        if (success) {
            html += '<div class="comp-actions">';
            // 注意：onclick 传参需要转义
            const safePath = executablePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const safeLang = language;
            html += '<button class="btn-run" onclick="window.runExecutable(\'' + safePath + '\', \'' + safeLang + '\')">▶️ 运行</button>';
            html += '<button class="btn-reveal" onclick="window.revealInExplorer(\'' + safePath + '\')">📂 打开所在文件夹</button>';
            html += '</div>';
        }
        
        div.innerHTML = html;
        chatContainer.appendChild(div);
        smartScroll();
    }
    
    // 配置 marked (关键修改：增强代码高亮与样式)
    function configureMarked() {
        if (window.marked && window.hljs) {
            const renderer = new marked.Renderer();
            
            // 增强代码块渲染和语言检测
            renderer.code = function(code, language) {
                // 语言别名映射表
                const aliasMap = {
                    'ts': 'typescript',
                    'js': 'javascript',
                    'py': 'python',
                    'cs': 'csharp',
                    'cpp': 'cpp',
                    'c++': 'cpp',
                    'vue': 'html',
                    'sh': 'bash',
                    'shell': 'bash'
                };

                let validLang = language ? language.toLowerCase() : '';
                // 应用别名
                if (aliasMap[validLang]) {
                    validLang = aliasMap[validLang];
                }

                // 尝试检测语言
                const hasLang = hljs.getLanguage(validLang);
                let highlighted;
                
                try {
                    if (hasLang) {
                        highlighted = hljs.highlight(code, { language: validLang }).value;
                    } else {
                        // 自动检测
                        highlighted = hljs.highlightAuto(code).value;
                    }
                } catch (e) {
                    highlighted = code; // 降级处理
                }

                const displayLang = hasLang ? validLang : (language || 'Code');
                const lines = code.split('\n');
                const lineCount = lines.length;
                const lineNums = lines.map(function(_, i) { return i + 1; }).join('\n');

                renderer.image = function(href, title, text) {
                  const escaped = escapeHtml(href);
                  const alt = text ? escapeHtml(text) : '';
                  return '<span class="img-enlarge-wrap" onclick="showImageModal(this.querySelector(\'img\')?.src)" title="点击放大">' +
                    '<img src="' + escaped + '" alt="' + alt + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy">' +
                    '</span>';
                };

                return '<div class="code-block">' +
                       '<div class="code-header">' +
                         '<div class="code-dots"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div>' +
                         '<span class="language-label">' + displayLang + '</span>' +
                         '<button class="copy-code-btn" onclick="copyCode(this)">📋 复制</button>' +
                       '</div>' +
                       '<div class="code-body">' +
                         '<div class="code-block-wrapper">' +
                           '<div class="code-line-numbers">' + escapeHtml(lineNums) + '</div>' +
                           '<pre><code class="hljs language-' + (hasLang ? validLang : 'plaintext') + '">' + highlighted + '</code></pre>' +
                         '</div>' +
                       '</div>' +
                       '</div>';
            };

            marked.setOptions({
                renderer: renderer,
                gfm: true,
                breaks: true,
                highlight: null
            });
            window.markedConfigured = true;
        }
    }
    
    // 复制代码功能
    window.copyCode = function(btn) {
        const codeBlock = btn.closest('.code-block');
        if (!codeBlock) return;
        const codeEl = codeBlock.querySelector('code');
        if (!codeEl) return;
        const code = codeEl.textContent;
        navigator.clipboard.writeText(code).then(() => {
            const originalText = btn.innerHTML;
            btn.innerHTML = '✅ 已复制';
            setTimeout(() => { btn.innerHTML = originalText; }, 2000);
        });
    }
    window.showImageModal = function(src) {
      if (!src || !src.startsWith('data:image')) return;
      const modal = document.getElementById('image-modal');
      const img = document.getElementById('image-modal-img');
      if (modal && img) { img.src = src; modal.classList.add('active'); }
    };
    window.hideImageModal = function() {
      const modal = document.getElementById('image-modal');
      const img = document.getElementById('image-modal-img');
      if (modal) modal.classList.remove('active');
      if (img) img.src = '';
    };

    window.openCodeInEditor = function(btn) {
        const block = btn.closest('.code-block');
        if (!block) return;
        const codeEl = block.querySelector('code');
        if (!codeEl) return;
        const code = codeEl.textContent;
        const langEl = block.querySelector('.language-label');
        const lang = langEl ? langEl.textContent.toLowerCase() : 'plaintext';
        vscode.postMessage({ type: 'openCodeInEditor', code: code, language: lang });
    }

    // 复制消息内容
    window.copyMessage = function(btn) {
        const msgDiv = btn.closest('.message');
        if (msgDiv) {
            const text = msgDiv.dataset.plaintext;
            if (text) {
                navigator.clipboard.writeText(text).then(() => {
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '✅';
                    setTimeout(() => { btn.innerHTML = originalText; }, 2000);
                }).catch(err => {
                    console.error('复制失败', err);
                });
            }
        }
    };

    // 清除 Agent 指令行，前端只显示思考过程和回答；终端命令/输出由 addTerminalOutput 单独展示
    function stripDirectiveMarkers(text) {
      let out = text
        // 移除 > RUN/BUILD/TEST: 行及其紧跟的 bash 代码块（终端输出已由 addTerminalOutput 展示，避免重复和解析错乱）
        .replace(/(^|\n)\s*> (?:RUN|BUILD|TEST): [^\n]+\s*\n\s*```bash\s*\n[\s\S]*?```\s*/g, '$1')
        // 移除可能残留的单独 > RUN/BUILD/TEST: 行
        .replace(/^> (?:RUN|BUILD|TEST): .*$/gm, '')
        // 其他指令行移除（> FILE: 由下方 formatMessageContent 单独处理为文件卡片）
        .replace(/^> (?:MKDIR|READ|MCP|APPLY_BATCH|CHECK_BATCH|PROJECT|MULTI_FILE|REPLACE|EDIT_FUNCTION|EDIT_CLASS|EDIT_LINE_CONTAINING|RANGE_EDIT|EDIT_BLOCK|DIFF|SMART_EDIT|SEARCH_REPLACE|BUILD|TEST): .*$/gm, '')
        .replace(/<ORIGINAL>[\s\S]*?<\/ORIGINAL>/g, '')
        .replace(/<NEW>[\s\S]*?<\/NEW>/g, '');
      return out.replace(/\n{3,}/g, '\n\n').trim();
    }

    function hasRenderableAssistantMessage(text) {
      const rawText = text || '';
      const reasoningMatches = rawText.match(/<think>[\s\S]*?(?:<\/think>|$)/gi) || [];
      const hasReasoning = reasoningMatches.some(function(block) {
        return block.replace(/<\/?think>/gi, '').trim().length > 0;
      });
      const cleanText = rawText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();

      // 检查是否有工具调用指令（在清理前检查，避免纯工具调用消息被过滤）
      const hasToolCalls = /^> (?:FILE|RUN|BUILD|TEST|MKDIR|READ|MCP|APPLY_BATCH|CHECK_BATCH|PROJECT|MULTI_FILE|REPLACE|EDIT_FUNCTION|EDIT_CLASS|EDIT_LINE_CONTAINING|RANGE_EDIT|EDIT_BLOCK|DIFF|SMART_EDIT|SEARCH_REPLACE): /m.test(cleanText);

      const visibleText = stripDirectiveMarkers(cleanText).trim();
      return Boolean(hasReasoning || visibleText || hasToolCalls);
    }

    function formatMessageContent(text, type, isFinal = true, skipFileMarkers = false) {
      if (type === 'user') {
        return escapeHtml(text).replace(/\n/g, '<br>');
      }

      if (!window.markedConfigured) {
        configureMarked();
      }

      let processedText = stripDirectiveMarkers(text);

      // 将 > FILE: 标记替换为占位符（除非跳过）
      if (!skipFileMarkers) {
        const fileRegex = /^> FILE: (.*)$/gm;
        processedText = processedText.replace(fileRegex, (match, path) => {
          return `\n\n<div class="__llma_file_marker__" data-path="${path.trim()}"></div>\n\n`;
        });
      }

      let html = "";
      try {
        html = marked.parse(processedText.trim());
      } catch (e) {
        console.error("Markdown parse error", e);
        return escapeHtml(text).replace(/\n/g, '<br>');
      }

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;

      // 注：流式时不再对代码块做逐行包裹，因 split('\n') 会破坏 hljs 语法高亮 HTML
      // （多行字符串、模板字面量内的换行会切断 <span> 标签导致渲染错乱）

      // 将占位符替换为等待写入的卡片（无按钮）
      const markers = tempDiv.querySelectorAll('div.__llma_file_marker__');
      const processedPaths = new Set();
      markers.forEach(marker => {
        const path = marker.dataset.path;
        const safePath = escapeHtml(path);

        // 避免重复处理相同路径的标记
        if (!processedPaths.has(path)) {
          processedPaths.add(path);
          marker.remove();
        } else {
          marker.remove();
        }
      });

      return tempDiv.innerHTML;
    }

    // === 新增：处理编辑块卡片 ===
    function addEditBlockCard(filepath, description, codeContent, editType) {
        const card = document.createElement('div');
        card.className = 'file-action-card';
        card.dataset.filepath = filepath;
        card.dataset.editType = editType;

        let descHtml = '';
        if (description.startLine !== undefined && description.endLine !== undefined) {
            descHtml = `行 ${description.startLine}-${description.endLine}`;
        } else if (description.start !== undefined && description.end !== undefined) {
            descHtml = `字符 ${description.start}-${description.end}`;
        }

        const safeCode = escapeHtml(codeContent);
        const safePath = escapeHtml(filepath);
        const descStr = escapeHtml(JSON.stringify(description));

        card.innerHTML = `
            <div class="file-header">
                <span class="file-icon">✏️</span>
                <span class="file-path">${safePath}</span>
                <span style="font-size:10px; margin-left:8px;">${descHtml}</span>
            </div>
            <pre style="max-height:200px; overflow:auto; margin:8px 0; padding:8px; background:#2d2d2d; border-radius:4px;"><code>${safeCode}</code></pre>
            <div class="action-buttons">
                <button class="btn-primary apply-edit-btn" data-filepath="${safePath}" data-description='${descStr}' data-code="${safeCode}">✅ 应用编辑</button>
            </div>
        `;
        chatContainer.appendChild(card);
        smartScroll();

        card.querySelector('.apply-edit-btn').addEventListener('click', (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = '应用中...';
            vscode.postMessage({
                type: 'applyEditBlock',
                filepath: btn.dataset.filepath,
                description: JSON.parse(btn.dataset.description),
                codeContent: btn.dataset.code
            });
        });
    }

    function renderDiffLines(diffContent) {
        var lines = diffContent.split('\n');
        var html = '';
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var cls = 'diff-line';
            if (line.indexOf('@@') === 0) cls += ' diff-hunk';
            else if (line.charAt(0) === '-' && line.substr(0, 3) !== '---') cls += ' diff-remove';
            else if (line.charAt(0) === '+' && line.substr(0, 3) !== '+++') cls += ' diff-add';
            html += '<div class="' + cls + '">' + escapeHtml(line) + '</div>';
        }
        return html;
    }

    function addDiffCard(filepath, diffContent) {
        const card = document.createElement('div');
        card.className = 'file-action-card';
        card.dataset.filepath = filepath;
        card.dataset.editType = 'diff';

        const safeDiff = escapeHtml(diffContent);
        const safePath = escapeHtml(filepath);
        const diffHtml = renderDiffLines(diffContent);

        card.innerHTML = `
            <div class="file-header">
                <span class="file-icon">🔄</span>
                <span class="file-path" data-filepath="${safePath}" title="点击在编辑器中打开">${safePath}</span>
                <span style="font-size:10px; margin-left:8px;">(diff)</span>
            </div>
            <div class="diff-view" style="max-height:280px; overflow:auto; margin:8px 0; padding:8px; background:#2d2d2d; border-radius:4px;">${diffHtml}</div>
            <div class="action-buttons">
                <button class="btn-primary apply-diff-btn" data-filepath="${safePath}" data-diff="${safeDiff}">✅ 应用 diff</button>
            </div>
        `;
        chatContainer.appendChild(card);
        smartScroll();

        card.querySelector('.apply-diff-btn').addEventListener('click', (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = '应用中...';
            vscode.postMessage({
                type: 'applyDiff',
                filepath: btn.dataset.filepath,
                diffContent: btn.dataset.diff
            });
        });
    }
    
    function updateButtonState() {
      if (isGenerating) {
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'flex';
        input.disabled = true;
      } else {
        sendBtn.style.display = 'flex';
        stopBtn.style.display = 'none';
        input.disabled = false;
        input.focus();
      }
    }
    
    function renderFileChips() {
      fileChips.innerHTML = '';
      attachedFiles.forEach((file, index) => {
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        chip.innerHTML = '<span>📄 ' + escapeHtml(file.name) + '</span><span class="remove-chip" data-index="' + index + '">×</span>';
        fileChips.appendChild(chip);
      });
      document.querySelectorAll('.remove-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          attachedFiles.splice(parseInt(btn.dataset.index), 1);
          renderFileChips();
          updateAttachmentsBar();
          saveState();
        });
      });
    }
    
    function updateAttachmentsBar() {
      attachmentsBar.style.display = attachedFiles.length > 0 ? 'flex' : 'none';
    }
    
    function switchSettingsTab(tabId) {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
      document.getElementById('online-settings').style.display = tabId === 'online' ? 'block' : 'none';
      document.getElementById('local-settings').style.display = tabId === 'local' ? 'block' : 'none';
      document.getElementById('custom-settings').style.display = tabId === 'custom' ? 'block' : 'none';
      document.getElementById('websearch-settings').style.display = tabId === 'websearch' ? 'block' : 'none';
      activeSettingsTab = tabId;
    }
    
    function saveSettings() {
      const settings = {};
      if (activeSettingsTab === 'online') {
        settings.deepseekModel = document.getElementById('model-deepseek').value;
        settings.qwenModel = document.getElementById('model-qwen').value;
        settings.zhipuModel = document.getElementById('model-zhipu').value;
        settings.deepseekApiKey = document.getElementById('key-deepseek').value;
        settings.qwenApiKey = document.getElementById('key-qwen').value;
        settings.doubaoApiKey = document.getElementById('key-doubao').value;
        settings.doubaoModel = document.getElementById('model-doubao').value;
        settings.zhipuApiKey = document.getElementById('key-zhipu').value;
        settings.openaiApiKey = document.getElementById('key-openai').value;
        settings.openaiModel = document.getElementById('model-openai').value;
        settings.kimiApiKey = document.getElementById('key-kimi').value;
        settings.kimiModel = document.getElementById('model-kimi').value;
        settings.huggingfaceApiKey = document.getElementById('key-huggingface').value;
        settings.huggingfaceModel = document.getElementById('model-huggingface').value;
        settings.huggingfaceSpaceApiKey = document.getElementById('key-huggingface-space').value;
        settings.huggingfaceSpaceBaseUrl = document.getElementById('base-huggingface-space').value;
        settings.huggingfaceSpaceModel = document.getElementById('model-huggingface-space').value;
      } else if (activeSettingsTab === 'local') {
        settings.localModelEnabled = document.getElementById('local-enabled').checked;
        settings.localModelBaseUrl = document.getElementById('local-base-url').value;
        settings.localModelName = document.getElementById('local-model-name').value;
        settings.localModelTimeout = parseInt(document.getElementById('local-timeout').value) || 120000;
      } else if (activeSettingsTab === 'custom') {
        settings.customModelApiBaseUrl = document.getElementById('custom-api-base-url').value;
        settings.customModelApiKey = document.getElementById('custom-api-key').value;
        settings.customModelModelName = document.getElementById('custom-model-name').value;
        settings.customModelChatEndpoint = document.getElementById('custom-chat-endpoint').value;
      } else if (activeSettingsTab === 'websearch') {
        settings.enableWebSearch = document.getElementById('websearch-enabled').checked;
        settings.serpApiKey = document.getElementById('serp-api-key').value;
      }
      vscode.postMessage({ type: 'saveSettings', settings: settings });
      document.getElementById('settings-modal').style.display = 'none';
    }
    
    function escapeHtml(text) {
      if (!text) return '';
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function smartScroll() {
      // 始终滚动到最底部，追踪最新生成内容
      isProgrammaticScroll = true;
      chatContainer.scrollTop = chatContainer.scrollHeight;
      requestAnimationFrame(() => { isProgrammaticScroll = false; });
    }

    function getFileNameFromPath(filepath) {
      if (!filepath) return '';
      const parts = String(filepath).split(/[\\/]/);
      return parts[parts.length - 1] || '';
    }

    function clearPendingFileConfirmNotices(filepath) {
      const fileName = getFileNameFromPath(filepath);
      if (!fileName) return;
      const noticeText = `文件 "${fileName}" 待确认`;

      chatContainer.querySelectorAll('.system-message').forEach(function(el) {
        if ((el.textContent || '').includes(noticeText)) {
          el.remove();
        }
      });

      chatContainer.querySelectorAll('.agent-steps-group').forEach(function(group) {
        group.querySelectorAll('.step-item').forEach(function(item) {
          if ((item.textContent || '').includes(noticeText)) {
            item.remove();
          }
        });

        const remainingItems = group.querySelectorAll('.step-item');
        if (remainingItems.length === 0) {
          group.remove();
          return;
        }

        const summaryText = group.querySelector('.steps-summary-text');
        if (summaryText) {
          summaryText.textContent = 'Agent 执行步骤 (' + remainingItems.length + ')';
        }
      });
    }

    function cleanupTransientChatArtifacts() {
      clearTaskProgress();

      chatContainer.querySelectorAll('.loading-indicator').forEach(function(el) {
        el.remove();
      });

      chatContainer.querySelectorAll('.streaming-cursor').forEach(function(el) {
        el.remove();
      });

      chatContainer.querySelectorAll('.content-block-streaming').forEach(function(el) {
        el.classList.remove('content-block-streaming');
      });

      chatContainer.querySelectorAll('.system-message').forEach(function(el) {
        if (!(el.textContent || '').trim()) {
          el.remove();
        }
      });

      chatContainer.querySelectorAll('.agent-steps-group').forEach(function(group) {
        const items = Array.from(group.querySelectorAll('.step-item')).filter(function(item) {
          return (item.textContent || '').trim().length > 0;
        });

        if (items.length === 0) {
          group.remove();
          return;
        }

        var onlyConfirmNotices = items.every(function(item) {
          return /待确认/.test(item.textContent || '');
        });
        if (onlyConfirmNotices) {
          group.remove();
          return;
        }

        const summaryText = group.querySelector('.steps-summary-text');
        if (summaryText) {
          summaryText.textContent = 'Agent 执行步骤 (' + items.length + ')';
        }
      });

      chatContainer.querySelectorAll('.message.ai-message').forEach(function(msg) {
        const plainText = (msg.dataset.plaintext || '').trim();
        const hasRenderableNode = msg.querySelector('.content-block, .reasoning-block, .file-action-card, .code-block, pre, table, ul, ol, blockquote, img');
        if (!plainText && !hasRenderableNode) {
          msg.remove();
        }
      });

      removeLineLikeArtifacts();
    }

    function removeLineLikeArtifacts() {
      if (!chatContainer || !chatContainer.children) return;
      const toRemove = [];
      // 卡片类型列表，这些元素不应该被清理函数移除
      const cardClasses = ['mcp-tool-card', 'terminal-output-card', 'compilation-card', 'file-preview-card', 'file-action-card'];
      
      for (let i = 0; i < chatContainer.children.length; i++) {
        const el = chatContainer.children[i];
        if (!el || !el.getBoundingClientRect) continue;
        const tag = (el.tagName || '').toLowerCase();
        const height = el.getBoundingClientRect().height;
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const borderTop = style ? parseFloat(style.borderTopWidth) || 0 : 0;
        const borderBottom = style ? parseFloat(style.borderBottomWidth) || 0 : 0;
        const hasBorder = borderTop > 0 || borderBottom > 0;
        const text = (el.innerText || el.textContent || '').trim();
        const isEmpty = text.length === 0;

        // 检查是否是卡片类型，如果是则跳过清理
        const isCard = cardClasses.some(function(className) {
          return el.classList.contains(className);
        });
        if (isCard) {
          continue;
        }

        if (tag === 'hr') {
          toRemove.push(el);
          continue;
        }
        if (isEmpty && height <= 14 && hasBorder) {
          toRemove.push(el);
          continue;
        }
        if (isEmpty && height <= 4) {
          toRemove.push(el);
        }
      }
      toRemove.forEach(function(el) {
        if (el.parentNode) el.remove();
      });

      chatContainer.querySelectorAll('.content-block hr, .message-content-container hr').forEach(function(hr) {
        hr.remove();
      });
      chatContainer.querySelectorAll('.content-block p').forEach(function(p) {
        if (!(p.innerText || p.textContent || '').trim() && !p.querySelector('img, code, strong, em')) {
          p.remove();
        }
      });

      chatContainer.querySelectorAll('.file-preview-card').forEach(function(card) {
        if (card.dataset.processing === 'true') {
          const hasContent = (card.innerText || card.textContent || '').trim().length > 10;
          if (!hasContent) {
            card.remove();
          }
        }
      });
    }

    // 估算 token 数量（用于思考过程显示）
    function estimateTokens(text) {
      if (!text) return 0;
      let score = 0;
      for (let i = 0; i < text.length; i++) {
        score += text.charCodeAt(i) > 127 ? 1.2 : 0.3;
      }
      return Math.max(1, Math.ceil(score));
    }

    // 补全不完整的代码块，防止 marked 渲染期间产生布局跳动
    function closeIncompleteCodeBlocks(text) {
      const opens = (text.match(/```/g) || []).length;
      if (opens % 2 !== 0) {
        return text + '\n```';
      }
      return text;
    }

    function saveState() {
      vscode.setState({ attachedFiles, currentMode, isWebSearchEnabled });
    }
    
    // 全局函数：供编译结果卡片调用
    window.runExecutable = function(path, language) {
        vscode.postMessage({ type: 'runExecutable', path: path, language: language });
    };

    window.revealInExplorer = function(path) {
        vscode.postMessage({ type: 'revealInExplorer', path: path });
    };

    window.confirmFileChange = function(pendingId, filepath, content) {
      vscode.postMessage({ type: 'confirmFileChange', pendingId, filepath, content });
      clearPendingFileConfirmNotices(filepath);
      cleanupTransientChatArtifacts();
      const card = document.querySelector('.file-preview-card[data-pending-id="' + pendingId + '"]');
      if (card) {
        card.dataset.processing = 'true';
        card.innerHTML = `
          <div class="file-header">
            <span class="file-icon">⏳</span>
            <span class="file-path">${escapeHtml(filepath)}</span>
          </div>
          <div style="padding: 8px; color: var(--text-primary);">正在应用更改...</div>
        `;
      }
    };

    window.cancelFileChange = function(pendingId, filepath) {
      vscode.postMessage({ type: 'cancelFileChange', pendingId, filepath });
      clearPendingFileConfirmNotices(filepath);
      const card = document.querySelector('.file-preview-card[data-pending-id="' + pendingId + '"]');
      if (card) {
        card.innerHTML = `
          <div class="file-header">
            <span class="file-icon">⏭️</span>
            <span class="file-path">${escapeHtml(filepath)}</span>
          </div>
          <div style="padding: 8px; color: var(--warning-color);">已取消</div>
        `;
      }
    };

    function addFilePreviewCard(pendingId, filepath, fileName, isNew, diff) {
      const card = document.createElement('div');
      card.className = 'file-preview-card';
      card.dataset.pendingId = pendingId;
      card.dataset.filepath = filepath;

      const statusText = isNew ? '新建文件' : '修改文件';
      const icon = isNew ? '📝' : '✏️';
      const diffHint = isNew ? '左侧为空，右侧为新文件内容' : '左侧为修改前，右侧为修改后';

      card.innerHTML = `
        <div class="file-header">
          <span class="file-icon">${icon}</span>
          <span class="file-path">[${statusText}] ${escapeHtml(fileName)}</span>
        </div>
        <div style="padding: 4px 8px 6px; font-size: 11px; opacity: 0.6;">${diffHint}</div>
        <div class="action-buttons">
          <button class="btn-success" onclick="confirmFileChange('${pendingId}', '${escapeHtml(filepath)}', '')">✅ 确认</button>
          <button class="btn-danger" onclick="cancelFileChange('${pendingId}', '${escapeHtml(filepath)}')">❌ 取消</button>
        </div>
      `;
      
      chatContainer.appendChild(card);
      isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; });
    }

    // 增强的 applyFileChange：收集所有后续代码块并拼接
    window.applyFileChange = function(btnElem, filePath) {
      const card = btnElem.closest('.file-action-card');
      let currentElem = card.nextElementSibling;
      let codeParts = [];
      
      // 遍历后续兄弟元素，收集所有代码块内容，直到遇到另一个文件卡片或没有更多元素
      while (currentElem) {
        // 如果遇到另一个文件卡片，停止（说明代码属于不同文件）
        if (currentElem.classList.contains('file-action-card')) {
          break;
        }
        
        // 检查是否是代码块（新结构 .code-block 或旧结构 PRE）
        if (currentElem.classList.contains('code-block')) {
          const codeNode = currentElem.querySelector('code');
          if (codeNode) {
            codeParts.push(codeNode.textContent);
          }
        } else if (currentElem.tagName === 'PRE') {
          const codeNode = currentElem.querySelector('code');
          if (codeNode) {
            codeParts.push(codeNode.textContent);
          }
        }
        // 忽略其他元素（如空白、段落等），继续向后查找
        
        currentElem = currentElem.nextElementSibling;
      }

      const codeContent = codeParts.join('\n'); // 拼接所有代码块内容

      if (!codeContent) {
         btnElem.textContent = '❌ 未找到代码块';
         setTimeout(() => { btnElem.textContent = '⚡️ 审查并应用'; }, 2000);
         return;
      }

      btnElem.textContent = '⏳ 应用中...';
      btnElem.disabled = true;

      vscode.postMessage({ type: 'applyFileChange', filepath: filePath, content: codeContent });
    };

    window.saveFile = function(btnElem, filePath) {
      btnElem.textContent = '⏳ 保存中...';
      btnElem.disabled = true;
      vscode.postMessage({ type: 'saveFile', filepath: filePath });
    };

    window.revertFile = function(btnElem, filePath) {
      btnElem.textContent = '⏳ 撤销中...';
      btnElem.disabled = true;
      vscode.postMessage({ type: 'revertFile', filepath: filePath });
    };
    
    // 增强的自动应用所有待处理的文件修改（支持多代码块拼接）
    function autoApplyFileChanges() {
      // 选择所有尚未包含 .action-buttons 且未被处理过的卡片
      const cards = document.querySelectorAll('div.file-action-card:not([data-processed])');
      
      cards.forEach(card => {
        const filePath = card.dataset.filepath;
        if (!filePath) return;

        // 标记防止重复处理
        if (card.dataset.processing === 'true') return;
        card.dataset.processing = 'true';
        card.dataset.processed = 'true'; // 标记为已处理

        // 显示“正在写入”状态
        card.innerHTML = `
          <div class="file-header">
            <span class="file-icon">📄</span>
            <span class="file-path">${escapeHtml(filePath)}</span>
            <span style="font-size: 11px; color: var(--info-color); margin-left: 8px;">⏳ 正在写入编辑器...</span>
          </div>
        `;

        // 查找卡片后的所有代码块并拼接
        let currentElem = card.nextElementSibling;
        let codeContent = '';
        
        while (currentElem && !currentElem.classList.contains('file-action-card')) {
          if (currentElem.classList.contains('code-block')) {
            const codeNode = currentElem.querySelector('code');
            if (codeNode) {
              codeContent += codeNode.textContent + '\n';
            }
          } else if (currentElem.tagName === 'PRE') {
            const codeNode = currentElem.querySelector('code');
            if (codeNode) {
              codeContent += codeNode.textContent + '\n';
            }
          }
          currentElem = currentElem.nextElementSibling;
        }

        if (!codeContent) {
          card.innerHTML = `
            <div class="file-header">
              <span class="file-icon">⚠️</span>
              <span class="file-path">${escapeHtml(filePath)}</span>
              <span style="color: var(--danger-color); margin-left: 8px;">未找到代码块</span>
            </div>
          `;
          return;
        }

        // 发送自动应用消息
        vscode.postMessage({
          type: 'applyFileChange',
          filepath: filePath,
          content: codeContent,
          auto: true
        });
      });
    }

    // ========== 消息接收核心处理 (支持流式) ==========
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'themeChanged':
          if (message.theme === 'light' || message.theme === 'dark') applyTheme(message.theme);
          break;
        case 'toggleChatAgentMode':
          setMode(currentMode === 'agent' ? 'chat' : 'agent');
          break;
        case 'addResponse':
          clearTaskProgress();
          if (hasRenderableAssistantMessage(message.text)) {
            addMessage(message.text, 'ai');
            const cleanHistoryText = message.text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trimStart();
            history.push({ role: 'assistant', content: cleanHistoryText });
            logMessage('assistant', cleanHistoryText);
            persistHistory();
          }
          isGenerating = false;
          updateButtonState();
          break;
          
        case 'addErrorResponse':
          addMessage(message.text, 'ai', true);
          isGenerating = false;
          updateButtonState();
          if (/连接|网络|API|超时|失败|错误|refused|timeout|network/i.test(message.text || '')) {
            updateConnectionStatus('error');
          }
          break;

        case 'addWarningResponse':
          addMessage(message.text, 'warning');
          // Only stop generating state if this is a terminal warning (not a search degradation)
          if (!isGenerating || !message.text?.includes('搜索失败')) {
            isGenerating = false;
            updateButtonState();
          }
          break;

        case 'addSystemMessage':
          addSystemMessage(message.text, message.important);
          break;

        case 'taskProgress':
          updateTaskProgress(message.progress, message.currentStep, message.totalSteps);
          break;

        case 'addTerminalOutput':
          addTerminalOutputCard(message.command, message.output, message.exitCode, message.id);
          break;

        case 'addMcpToolCard':
          addMcpToolCard(message.serverName, message.toolName, message.args, message.result, message.status);
          break;

        case 'compilationResult':
          addCompilationCard(message.success, message.message, message.filePath, message.executablePath, message.language);
          break;

        // 文件操作消息处理
        case 'agentPaused': {
          // agent 挂起等待用户确认，显示等待提示，强制禁用输入框和发送按钮
          isGenerating = true;
          isAgentPaused = true;
          updateModifyDecisionBar();
          updateButtonState();
          const pauseEl = document.getElementById('agent-pause-indicator');
          if (!pauseEl) {
            const el = document.createElement('div');
            el.id = 'agent-pause-indicator';
            el.className = 'system-message';
            el.textContent = `⏸️ ${message.reason || '等待用户确认...'}`;
            chatContainer.appendChild(el);
            if (!userHasScrolledUp) { isProgrammaticScroll = true; chatContainer.scrollTop = chatContainer.scrollHeight; requestAnimationFrame(() => { isProgrammaticScroll = false; }); }
          }
          break;
        }
        case 'agentResumed':
          // agent 恢复，移除等待提示（isGenerating 保持 true，由 streamEnd 恢复）
          isAgentPaused = false;
          document.getElementById('agent-pause-indicator')?.remove();
          break;

        case 'fileChangePreview':
          addFilePreviewCard(message.pendingId, message.filepath, message.fileName, message.isNew, message.diff);
          break;
        case 'fileChangeApplied':
          cleanupTransientChatArtifacts();
          if (message.filepath) {
            modifiedFiles.add(message.filepath);
            updateModifyDecisionBar();
          }
          Array.from(document.querySelectorAll('.file-preview-card[data-processing="true"]'))
            .filter(card => card.dataset.filepath === message.filepath)
            .forEach(card => card.remove());
          const safePathApplied = escapeHtml(message.filepath);
          const applyCards = document.querySelectorAll('div.file-action-card[data-filepath="' + safePathApplied + '"]');
          applyCards.forEach(targetCard => {
            let actionArea = targetCard.querySelector('.action-buttons');
            if (!actionArea) {
              actionArea = document.createElement('div');
              actionArea.className = 'action-buttons';
              targetCard.appendChild(actionArea);
            }
            if (message.auto) {
              actionArea.innerHTML = `
                <span style="font-size: 11px; margin-right: 8px; color: var(--success-color);">✅ 已写入编辑器（未保存）</span>
                <button class="btn-success" onclick="saveFile(this, '${safePathApplied}')">💾 保存</button>
                <button class="btn-danger" onclick="revertFile(this, '${safePathApplied}')">↩️ 撤销</button>
              `;
            } else {
              actionArea.innerHTML = `
                <span style="font-size: 11px; margin-right: 8px; color: var(--success-color);">✅ 已写入编辑器</span>
                <button class="btn-primary apply-btn" onclick="applyFileChange(this, '${safePathApplied}')">🔄 重新应用</button>
                <button class="btn-success" onclick="saveFile(this, '${safePathApplied}')">💾 保存</button>
                <button class="btn-danger" onclick="revertFile(this, '${safePathApplied}')">↩️ 撤销</button>
              `;
            }
            targetCard.removeAttribute('data-processing');
          });
          break;
          
        case 'fileChangeSaved':
          cleanupTransientChatArtifacts();
          if (message.filepath) {
            modifiedFiles.delete(message.filepath);
            updateModifyDecisionBar();
          }
          const safePathSaved = escapeHtml(message.filepath);
          const savedCards = document.querySelectorAll('div.file-action-card[data-filepath="' + safePathSaved + '"]');
          savedCards.forEach(targetCard => {
            const actionArea = targetCard.querySelector('.action-buttons');
            if (actionArea) {
                actionArea.innerHTML = '<span style="font-size: 11px; margin-right: 8px; color: var(--success-color);">✅ 文件已固化保存</span>' +
                                       '<button class="btn-primary apply-btn" onclick="applyFileChange(this, &quot;' + safePathSaved + '&quot;)">🔄 重新应用</button> ' +
                                       '<button class="btn-danger" onclick="revertFile(this, &quot;' + safePathSaved + '&quot;)">↩️ 撤销</button>';
            }
          });
          break;
          
        case 'fileChangeReverted':
          if (message.filepath) {
            modifiedFiles.delete(message.filepath);
            updateModifyDecisionBar();
          }
          const safePathReverted = escapeHtml(message.filepath);
          const revertedCards = document.querySelectorAll('div.file-action-card[data-filepath="' + safePathReverted + '"]');
          revertedCards.forEach(targetCard => {
            let actionArea = targetCard.querySelector('.action-buttons');
            if (!actionArea) {
              actionArea = document.createElement('div');
              actionArea.className = 'action-buttons';
              targetCard.appendChild(actionArea);
            }
            actionArea.innerHTML = `
              <span style="font-size: 11px; margin-right: 8px; color: var(--warning-color);">↩️ 已撤销更改</span>
              <button class="btn-primary apply-btn" onclick="applyFileChange(this, '${safePathReverted}')">⚡️ 重新应用</button>
            `;
          });
          break;

        case 'changesDecisionDone':
          cleanupTransientChatArtifacts();
          modifiedFiles.clear();
          updateModifyDecisionBar();
          keepChangesBtn.disabled = false;
          discardChangesBtn.disabled = false;
          break;

        case 'showUndoBar':
          // 已统一到 modifyDecisionBar，忽略此消息
          break;

        case 'fileChangeError':
          Array.from(document.querySelectorAll('.file-preview-card[data-processing="true"]'))
            .filter(card => card.dataset.filepath === message.filepath)
            .forEach(card => {
              const pendingId = card.dataset.pendingId || '';
              const filepath = card.dataset.filepath || message.filepath || '';
              card.removeAttribute('data-processing');
              card.innerHTML = `
                <div class="file-header">
                  <span class="file-icon">⚠️</span>
                  <span class="file-path">${escapeHtml(filepath)}</span>
                </div>
                <div style="padding: 8px; color: var(--danger-color);">应用失败，请重试或取消</div>
                <div class="action-buttons">
                  <button class="btn-success" onclick="confirmFileChange('${pendingId}', '${escapeHtml(filepath)}', '')">✅ 重试应用</button>
                  <button class="btn-danger" onclick="cancelFileChange('${pendingId}', '${escapeHtml(filepath)}')">❌ 取消</button>
                </div>
              `;
            });
          const safePathError = escapeHtml(message.filepath);
          const errorCards = document.querySelectorAll('div.file-action-card[data-filepath="' + safePathError + '"]');
          errorCards.forEach(targetCard => {
            const applyBtn = targetCard.querySelector('.apply-btn');
            if (applyBtn) {
               applyBtn.textContent = '⚡️ 重试应用';
               applyBtn.disabled = false;
            }
            targetCard.removeAttribute('data-processed');
            targetCard.removeAttribute('data-processing');
          });
          break;

        // === 新增：处理编辑块和 diff 消息 ===
        case 'addEditBlock':
          addEditBlockCard(message.filepath, message.description, message.codeContent, message.editType);
          break;
        case 'addDiff':
          addDiffCard(message.filepath, message.codeContent);
          break;

        case 'streamStart':
          isGenerating = true;
          updateButtonState();
          if (navigator.onLine) updateConnectionStatus('online');
          messageRenderer.startStream(message.silent);
          if (history.length === 0) { userHasScrolledUp = false; }
          break;
          
        case 'streamUpdate':
          messageRenderer.updateStream(message.content, message.reasoning);
          break;
          
        case 'streamEnd':
          const result = messageRenderer.endStream();

          if (result.shouldKeep) {
            history.push({ role: 'assistant', content: result.content });
            logMessage('assistant', result.content);
          }

          persistHistory();

          if (message.intermediate) {
            // 中间过程 streamEnd，仅用于渲染，不改变 isGenerating 状态
            smartScroll();
            break;
          }

          isGenerating = false;
          updateButtonState();

          setTimeout(function() {
            cleanupTransientChatArtifacts();
            autoApplyFileChanges();
            // 流结束后，如果有修改文件则显示最终确认栏
            if (modifiedFiles.size > 0) {
              updateModifyDecisionBar();
            }
            smartScroll();
          }, 150);
          break;
          
        case 'showSearchStatus':
          const statusDiv = document.createElement('div');
          statusDiv.id = 'temp-search-status';
          statusDiv.className = 'message ai-message';
          statusDiv.style.background = 'transparent';
          statusDiv.style.border = 'none';
          statusDiv.style.color = 'var(--info-color)';
          statusDiv.style.fontStyle = 'italic';
          statusDiv.textContent = message.text;
          chatContainer.appendChild(statusDiv);
          smartScroll();
          break;

        case 'hideSearchStatus': {
          const el = document.getElementById('temp-search-status');
          if (el) el.remove();
          break;
        }

        case 'updateContextInfo':
          document.getElementById('context-text').textContent = message.text;
          break;
          
        case 'filesSelected':
          message.files.forEach(file => { if (!attachedFiles.some(f => f.path === file.path)) attachedFiles.push(file); });
          renderFileChips();
          updateAttachmentsBar();
          saveState();
          break;
          
        case 'updateSettings':
          if (message.settings.deepseekModel !== undefined) document.getElementById('model-deepseek').value = message.settings.deepseekModel;
          if (message.settings.qwenModel !== undefined) document.getElementById('model-qwen').value = message.settings.qwenModel;
          if (message.settings.zhipuModel !== undefined) document.getElementById('model-zhipu').value = message.settings.zhipuModel;
          if (message.settings.deepseekApiKey) document.getElementById('key-deepseek').value = message.settings.deepseekApiKey;
          if (message.settings.qwenApiKey) document.getElementById('key-qwen').value = message.settings.qwenApiKey;
          if (message.settings.doubaoApiKey) document.getElementById('key-doubao').value = message.settings.doubaoApiKey;
          if (message.settings.doubaoModel) document.getElementById('model-doubao').value = message.settings.doubaoModel;
          if (message.settings.kimiApiKey) document.getElementById('key-kimi').value = message.settings.kimiApiKey;
          if (message.settings.kimiModel) document.getElementById('model-kimi').value = message.settings.kimiModel;
          if (message.settings.zhipuApiKey) document.getElementById('key-zhipu').value = message.settings.zhipuApiKey;
          if (message.settings.openaiApiKey) document.getElementById('key-openai').value = message.settings.openaiApiKey;
          if (message.settings.openaiModel) document.getElementById('model-openai').value = message.settings.openaiModel;
          if (message.settings.huggingfaceApiKey) document.getElementById('key-huggingface').value = message.settings.huggingfaceApiKey;
          if (message.settings.huggingfaceModel) document.getElementById('model-huggingface').value = message.settings.huggingfaceModel;
          if (message.settings.huggingfaceSpaceApiKey !== undefined) document.getElementById('key-huggingface-space').value = message.settings.huggingfaceSpaceApiKey;
          if (message.settings.huggingfaceSpaceBaseUrl !== undefined) document.getElementById('base-huggingface-space').value = message.settings.huggingfaceSpaceBaseUrl;
          if (message.settings.huggingfaceSpaceModel !== undefined) document.getElementById('model-huggingface-space').value = message.settings.huggingfaceSpaceModel;
          if (message.settings.localModelEnabled !== undefined) document.getElementById('local-enabled').checked = message.settings.localModelEnabled;
          if (message.settings.localModelBaseUrl) document.getElementById('local-base-url').value = message.settings.localModelBaseUrl;
          if (message.settings.localModelName) document.getElementById('local-model-name').value = message.settings.localModelName;
          if (message.settings.localModelTimeout) document.getElementById('local-timeout').value = message.settings.localModelTimeout;
          if (message.settings.customModelApiBaseUrl) document.getElementById('custom-api-base-url').value = message.settings.customModelApiBaseUrl;
          if (message.settings.customModelApiKey) document.getElementById('custom-api-key').value = message.settings.customModelApiKey;
          if (message.settings.customModelModelName) document.getElementById('custom-model-name').value = message.settings.customModelModelName;
          if (message.settings.customModelChatEndpoint) document.getElementById('custom-chat-endpoint').value = message.settings.customModelChatEndpoint;
          if (message.settings.enableWebSearch !== undefined) {
             document.getElementById('websearch-enabled').checked = message.settings.enableWebSearch;
             if (message.settings.enableWebSearch && !isWebSearchEnabled && !vscode.getState()?.hasOwnProperty('isWebSearchEnabled')) {
                isWebSearchEnabled = true;
                webSearchToggleBtn.classList.add('active');
             }
          }
          if (message.settings.serpApiKey) document.getElementById('serp-api-key').value = message.settings.serpApiKey;
          if (message.settings.chatTypingEffect !== undefined) {
            chatTypingEffect = message.settings.chatTypingEffect;
          }
          // 设置模型下拉框选中值
          if (message.settings.currentModel) {
            modelSelect.value = message.settings.currentModel;
            updateCustomSelectFromNative();
          }
          break;

        case 'initHistory':
          modifiedFiles.clear();
          updateModifyDecisionBar();
          const rawHistory = message.history || [];
          history = rawHistory.filter(function(msg) {
            return msg.role !== 'assistant' || hasRenderableAssistantMessage(msg.content);
          });
          if (history.length !== rawHistory.length) {
            setTimeout(function() { persistHistory(); }, 0);
          }
          clearTaskProgress();
          chatContainer.innerHTML = '';
          if (history.length === 0) {
            addWelcomeMessage();
          } else {
            var batchSize = 8;
            var idx = 0;
            function addNextBatch() {
              var end = Math.min(idx + batchSize, history.length);
              for (; idx < end; idx++) {
                var msg = history[idx];
                if (msg.role === 'user') addMessage(msg.content, 'user');
                else if (msg.role === 'assistant') addMessage(msg.content, 'ai');
              }
              if (idx < history.length) {
                requestAnimationFrame(addNextBatch);
              }
            }
            addNextBatch();
          }
          break;

        // 接收所有历史日志（原功能保留）
        case 'allLogs':
          // 可忽略或保留
          break;

        // === 新增：接收会话列表 ===
        case 'sessionsList':
          renderSessionsList(message.sessions);
          break;
      }
      
      if (message.type === 'streamStart' || message.type === 'addResponse') {
         const tempSearch = document.getElementById('temp-search-status');
         if (tempSearch) tempSearch.remove();
      }
    });

    // 渲染会话列表到历史模态框
    function renderSessionsList(sessions) {
      if (!sessions || sessions.length === 0) {
        historyModalBody.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary);">暂无历史会话</div>';
        return;
      }
      const sorted = sessions.sort((a, b) => b.timestamp - a.timestamp);
      let html = '';
      sorted.forEach(session => {
        const date = new Date(session.timestamp).toLocaleString();
        const preview = escapeHtml(session.preview.length > 60 ? session.preview.substring(0, 60) + '…' : session.preview);
        html += `
          <div class="history-item" data-session-id="${session.id}">
            <div class="history-item-content">
              <div class="preview">${preview}</div>
              <div class="time">${date}</div>
            </div>
            <button class="history-delete-btn" data-session-id="${session.id}" title="删除此会话">🗑</button>
          </div>
        `;
      });
      historyModalBody.innerHTML = html;

      document.querySelectorAll('.history-item-content').forEach(item => {
        item.addEventListener('click', function() {
          const sessionId = this.closest('.history-item').dataset.sessionId;
          chatContainer.innerHTML = '<div class="message-skeleton" style="margin:20px;"><div class="skeleton-line long"></div><div class="skeleton-line medium"></div><div class="skeleton-line short"></div><div class="skeleton-line long"></div><div class="skeleton-line medium"></div></div>';
          vscode.postMessage({ type: 'loadSession', sessionId });
          historyModal.style.display = 'none';
        });
      });

      document.querySelectorAll('.history-delete-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          const sessionId = this.dataset.sessionId;
          const item = this.closest('.history-item');
          // 已有确认条则直接执行
          if (item.querySelector('.history-confirm-bar')) {
            vscode.postMessage({ type: 'deleteSession', sessionId });
            return;
          }
          // 插入确认条
          const bar = document.createElement('div');
          bar.className = 'history-confirm-bar';
          bar.innerHTML = '<span>确认删除？</span><button class="confirm-yes">确认</button><button class="confirm-no">取消</button>';
          item.appendChild(bar);
          bar.querySelector('.confirm-yes').addEventListener('click', (e2) => {
            e2.stopPropagation();
            vscode.postMessage({ type: 'deleteSession', sessionId });
          });
          bar.querySelector('.confirm-no').addEventListener('click', (e2) => {
            e2.stopPropagation();
            bar.remove();
          });
        });
      });
    }
    init();