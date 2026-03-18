/**
 * 状态与 DOM 引用
 * 集中管理所有 DOM 元素引用和全局状态变量
 */
const vscode = acquireVsCodeApi();

const chatContainer = document.getElementById('chat-container');
const input = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const attachBtn = document.getElementById('attach-btn');
const webSearchToggleBtn = document.getElementById('websearch-toggle-btn');
const modelSelect = document.getElementById('model-select');
const compileBtn = document.getElementById('compile-btn');
const refreshBtn = document.getElementById('refresh-context');
const settingsBtn = document.getElementById('settings-btn');
const closeSettingsBtn = document.getElementById('close-settings');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const modeChatBtn = document.getElementById('mode-chat');
const modeAgentBtn = document.getElementById('mode-agent');
const fileChips = document.getElementById('file-chips');
const attachmentsBar = document.getElementById('attachments-bar');
const newChatBtn = document.getElementById('new-chat-btn');
const searchBtn = document.getElementById('search-btn');
const searchInline = document.getElementById('search-inline');
const chatSearchInput = document.getElementById('chat-search-input');
const searchCloseBtn = document.getElementById('search-close-btn');
const historyBtn = document.getElementById('history-btn');
const historyModal = document.getElementById('history-modal');
const closeHistoryBtn = document.getElementById('close-history');
const historyModalBody = document.getElementById('history-modal-body');
const refreshHistoryBtn = document.getElementById('refresh-history-btn');
const clearAllHistoryBtn = document.getElementById('clear-all-history-btn');
const dropOverlay = document.getElementById('drop-overlay');
const keepChangesBtn = document.getElementById('keep-changes-btn');
const discardChangesBtn = document.getElementById('discard-changes-btn');
const modifyDecisionBar = document.querySelector('.modify-decision-bar');
const customSelect = document.getElementById('custom-model-select');
const selectedDisplay = document.getElementById('selected-model-display');
const selectedTextSpan = selectedDisplay ? selectedDisplay.querySelector('.selected-text') : null;
const selectedIconSpan = selectedDisplay ? selectedDisplay.querySelector('.selected-icon') : null;
const selectItems = document.getElementById('select-items');
const options = document.querySelectorAll('.select-option');

let history = [];
let currentMode = 'chat';
let attachedFiles = [];
let isGenerating = false;
let isAgentPaused = false;
let isWebSearchEnabled = false;
let activeSettingsTab = 'online';
let userHasScrolledUp = false;
let isProgrammaticScroll = false;
let chatTypingEffect = true;
let taskProgressEl = null;
const modifiedFiles = new Set();
