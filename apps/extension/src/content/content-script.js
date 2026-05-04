(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    autocompleteEnabled: true,
    spellcheckEnabled: true,
    suggestionLevel: "medium",
    checkLanguage: "ru",
    selectionTranslateProvider: "google-ru-vi",
    aiOutputLanguage: "vi",
    aiTask: "explain",
    theme: "electric-light",
    blockedHosts: [],
    allowedHosts: [],
    showTextPreviewInPopup: true,
    selectionActionsEnabled: true,
    personalDictionary: [],
    autocompleteSuggestionCount: 1,
    autocompleteFavoriteWords: []
  };

  const CYRILLIC_WORD_RE = /[\u0400-\u04ff-]/;
  const CYRILLIC_RE = /[\u0400-\u04ff]/;
  const TRANSLATABLE_TEXT_RE = /[A-Za-zÀ-ỹ\u0400-\u04ff]/;
  const VIETNAMESE_RE = /[À-ỹ]/;
  const TRANSLATION_PROVIDER_CONFIG = {
    "google-ru-vi": {
      languages: ["ru", "vi"],
      pairLabel: "Nga ↔ Việt"
    },
    "google-ru-en": {
      languages: ["ru", "en"],
      pairLabel: "Nga ↔ Anh"
    },
    "google-en-vi": {
      languages: ["en", "vi"],
      pairLabel: "Anh ↔ Việt"
    }
  };
  const LANGUAGE_LABELS = {
    en: "Anh",
    ru: "Nga",
    vi: "Việt"
  };
  const AI_OUTPUT_LANGUAGES = ["vi", "ru", "en"];
  const AI_TASKS = ["explain", "summarize", "rewrite"];
  const LOCAL_GRAMMAR_RULES_ENABLED = false;
  const EDITABLE_INPUT_TYPES = new Set([
    "email",
    "search",
    "tel",
    "text",
    "url"
  ]);

  let settings = { ...DEFAULT_SETTINGS };
  let activeEditor = null;
  let pendingTimer = null;
  let spellcheckTimer = null;
  let autocompleteBubble = null;
  let activeAutocomplete = null;
  let spellcheckBubble = null;
  let activeSpellIssue = null;
  let autocompleteControlCandidate = null;
  let autocompleteControlChordUsed = false;
  let selectionTranslateBubble = null;
  let activeTranslationText = "";
  let activeTranslationRequestId = 0;
  let activeSelectionAction = "translate";
  let activeTranslationPair = null;

  window.addEventListener("unhandledrejection", (event) => {
    if (isExpectedExtensionInvalidation(event.reason)) {
      event.preventDefault();
    }
  });

  window.addEventListener("error", (event) => {
    if (isExpectedExtensionInvalidation(event.error)) {
      event.preventDefault();
    }
  });

  init().catch(() => {
    // The extension may have been reloaded while an old content script was alive.
  });

  async function init() {
    if (!isRuntimeAvailable() || isExcludedDevelopmentHost(getCurrentHost())) {
      return;
    }

    settings = await loadSettings();

    if (!isRuntimeAvailable()) {
      return;
    }

    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("beforeinput", handleBeforeInput, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("selectionchange", handleSelectionChange, true);
    document.addEventListener("click", handleFallbackEditorActivity, true);
    document.addEventListener("keyup", handleFallbackEditorActivity, true);
    document.addEventListener("mouseup", handleFallbackEditorActivity, true);
    document.addEventListener("compositionend", handleFallbackEditorActivity, true);
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    window.addEventListener("scroll", hideSelectionTranslateBubbleIfPassive, true);
    window.addEventListener("resize", hideSelectionTranslateBubbleIfPassive, true);
    window.addEventListener("focus", () => scheduleActiveEditorBootstrap(80), true);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleActiveEditorBootstrap(120);
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      for (const [key, change] of Object.entries(changes)) {
        if (!(key in DEFAULT_SETTINGS)) {
          continue;
        }

        settings[key] = change.newValue;
      }

      updateAutocomplete();
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "RUSTYPE_SHOW_SELECTION_ACTION") {
        runSafely(() => showSelectionActionBubble(message.payload ?? {}));
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type !== "RUSTYPE_COLLECT_EDITOR_STATE") {
        return false;
      }

      try {
        const state = collectEditorState();
        sendResponse({ ok: true, state });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          state: createEmptyState()
        });
      }

      return false;
    });

    scheduleActiveEditorBootstrap(120);
    scheduleActiveEditorBootstrap(900);
  }

  function handleFocusIn(event) {
    if (isRusTypeUiTarget(event.target)) {
      return;
    }

    const editor = findEditableFromEvent(event);

    if (!editor) {
      scheduleActiveEditorBootstrap(0);
      return;
    }

    if (isSensitiveEditor(editor)) {
      activeEditor = null;
      hideAutocomplete();
      hideSpellcheckBubble();
      return;
    }

    activateEditor(editor, {
      stateDelay: 0,
      spellcheckDelay: 900
    });
  }

  function handleInput(event) {
    if (isRusTypeUiTarget(event.target)) {
      return;
    }

    hideSelectionTranslateBubbleIfPassive();

    const editor = findEditableFromEvent(event) ?? findActiveEditable();

    if (!editor || isSensitiveEditor(editor)) {
      return;
    }

    activateEditor(editor, {
      stateDelay: 160,
      spellcheckDelay: 700
    });
  }

  function handleBeforeInput(event) {
    if (isRusTypeUiTarget(event.target)) {
      return;
    }

    const editor = findEditableFromEvent(event);

    if (!editor || isSensitiveEditor(editor)) {
      return;
    }

    activeEditor = editor;
    window.setTimeout(() => {
      runSafely(() => {
        if (document.contains(editor)) {
          activateEditor(editor, {
            stateDelay: 160,
            spellcheckDelay: 760
          });
        }
      });
    }, 0);
  }

  function handleKeyDown(event) {
    if (autocompleteControlCandidate && event.key !== "Control") {
      autocompleteControlChordUsed = true;
    }

    if (event.key === "Escape") {
      hideAutocomplete();
      hideSelectionTranslateBubbleIfPassive();
      return;
    }

    if (!activeAutocomplete) {
      return;
    }

    if (!activeEditor || activeAutocomplete.editor !== activeEditor) {
      hideAutocomplete();
      return;
    }

    if (event.key === "Control" && !event.repeat) {
      autocompleteControlCandidate = activeAutocomplete;
      autocompleteControlChordUsed = false;
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveAutocompleteSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveAutocompleteSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      acceptAutocomplete();
      return;
    }

    if (event.key === "Tab") {
      if (activeAutocomplete.suggestions.length < 2) {
        hideAutocomplete();
        return;
      }

      event.preventDefault();
      moveAutocompleteSelection(event.shiftKey ? -1 : 1);
    }
  }

  function handleKeyUp(event) {
    if (event.key !== "Control") {
      return;
    }

    const shouldAddFavorite = Boolean(
      activeAutocomplete &&
      autocompleteControlCandidate === activeAutocomplete &&
      !autocompleteControlChordUsed
    );

    autocompleteControlCandidate = null;
    autocompleteControlChordUsed = false;

    if (shouldAddFavorite) {
      runSafely(addSelectedAutocompleteFavorite);
    }
  }

  function handleSelectionChange() {
    const editor = findActiveEditable();

    if (editor && !isSensitiveEditor(editor)) {
      activateEditor(editor, {
        stateDelay: 120,
        spellcheckDelay: 900
      });
      return;
    }

    scheduleSelectionStateUpdate(120);
    hideAutocomplete();
  }

  function handleFallbackEditorActivity(event) {
    if (isRusTypeUiTarget(event?.target)) {
      return;
    }

    const editor = findEditableFromEvent(event) ?? findActiveEditable();

    if (editor && !isSensitiveEditor(editor)) {
      activateEditor(editor, {
        stateDelay: 160,
        spellcheckDelay: 850
      });
      return;
    }

    scheduleSelectionStateUpdate(160);
  }

  function handleDocumentPointerDown(event) {
    if (isRusTypeUiTarget(event.target)) {
      return;
    }

    hideSelectionTranslateBubbleIfPassive();
  }

  function activateEditor(editor, options = {}) {
    if (!editor || !document.contains(editor) || isSensitiveEditor(editor)) {
      return false;
    }

    activeEditor = editor;
    scheduleEditorStateUpdate(options.stateDelay ?? 120);
    updateAutocomplete();

    if (options.spellcheck !== false) {
      scheduleSpellcheck(options.spellcheckDelay ?? 850);
    }

    return true;
  }

  function scheduleActiveEditorBootstrap(delayMs) {
    if (!isRuntimeAvailable()) {
      return;
    }

    window.setTimeout(() => {
      runSafely(bootstrapActiveEditor);
    }, delayMs);
  }

  function bootstrapActiveEditor() {
    const editor = findActiveEditable();

    if (!editor || isSensitiveEditor(editor)) {
      return;
    }

    activateEditor(editor, {
      stateDelay: 0,
      spellcheckDelay: 900
    });
  }

  function scheduleEditorStateUpdate(delayMs) {
    if (!isRuntimeAvailable()) {
      return;
    }

    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      runSafely(sendEditorState);
    }, delayMs);
  }

  function scheduleSelectionStateUpdate(delayMs) {
    if (!isRuntimeAvailable()) {
      return;
    }

    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      runSafely(sendSelectionState);
    }, delayMs);
  }

  function scheduleSpellcheck(delayMs) {
    if (!canRunSpellcheck()) {
      hideSpellcheckBubble();
      return;
    }

    clearTimeout(spellcheckTimer);
    spellcheckTimer = setTimeout(() => {
      runSafely(runSpellcheck);
    }, delayMs);
  }

  function sendEditorState() {
    const payload = collectEditorState();

    if (!payload || payload.editorType === "none") {
      return;
    }

    safeSendRuntimeMessage({
      type: "RUSTYPE_EDITOR_STATE_UPDATED",
      payload
    });
  }

  function updateAutocomplete() {
    if (!canShowAutocomplete()) {
      hideAutocomplete();
      return;
    }

    const snapshot = getEditorSnapshot(activeEditor);

    if (!snapshot || snapshot.selectionStart !== snapshot.selectionEnd) {
      hideAutocomplete();
      return;
    }

    const currentWord = extractCurrentWord(snapshot.text, snapshot.selectionStart);

    if (!currentWord.isRussianLike || currentWord.prefix.length < 2) {
      hideAutocomplete();
      return;
    }

    const suggestionCount = normalizeAutocompleteSuggestionCount(settings.autocompleteSuggestionCount);
    const suggestions = window.RusTypeAutocomplete?.suggest(currentWord.prefix, {
      limit: suggestionCount,
      minPrefixLength: 2,
      favoriteWords: settings.autocompleteFavoriteWords,
      extraWords: settings.personalDictionary
    }) ?? [];
    const suggestion = suggestions[0];

    if (!suggestion?.completion) {
      hideAutocomplete();
      return;
    }

    activeAutocomplete = {
      editor: activeEditor,
      snapshot,
      currentWord,
      suggestions,
      selectedIndex: 0,
      expanded: suggestions.length > 1,
      statusText: ""
    };

    renderAutocompleteBubble(activeEditor, currentWord);
  }

  function canShowAutocomplete() {
    const host = getCurrentHost();

    return Boolean(
      settings.enabled &&
      settings.autocompleteEnabled &&
      activeEditor &&
      document.contains(activeEditor) &&
      !isSensitiveEditor(activeEditor) &&
      !isGoogleDocsHost(host) &&
      isExtensionActiveForHost(host)
    );
  }

  function renderAutocompleteBubble(editor, currentWord) {
    const bubble = ensureAutocompleteBubble();
    const rect = getAutocompleteAnchorRect(editor);
    const suggestions = activeAutocomplete?.suggestions ?? [];
    const selectedIndex = clamp(activeAutocomplete?.selectedIndex ?? 0, 0, Math.max(0, suggestions.length - 1));
    const selectedSuggestion = suggestions[selectedIndex] ?? suggestions[0];

    bubble.querySelector("[data-rustype-prefix]").textContent = currentWord.prefix;
    bubble.querySelector("[data-rustype-completion]").textContent = selectedSuggestion?.completion ?? "";
    bubble.querySelector("[data-rustype-hint-text]").innerHTML = activeAutocomplete?.expanded
      ? "<kbd>Tab</kbd> đổi · <kbd>Enter</kbd> nhận · <kbd>Ctrl</kbd> ưu tiên"
      : "<kbd>Enter</kbd> nhận · <kbd>Ctrl</kbd> ưu tiên";
    bubble.querySelector("[data-rustype-status]").textContent = activeAutocomplete?.statusText ?? "";
    bubble.dataset.expanded = activeAutocomplete?.expanded ? "true" : "false";
    renderAutocompleteOptionList(bubble, suggestions, selectedIndex);
    bubble.style.display = "flex";
    bubble.hidden = false;
    positionFloatingBubble(bubble, rect, 6);
  }

  function getAutocompleteAnchorRect(editor) {
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      const caretRect = getTextControlCaretRect(editor);

      if (caretRect) {
        return caretRect;
      }
    }

    if (editor instanceof HTMLElement && isRichTextEditor(editor)) {
      const selection = window.getSelection();

      if (selection?.rangeCount && editor.contains(selection.anchorNode)) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();

        if (rect.width || rect.height) {
          return rect;
        }
      }
    }

    return editor.getBoundingClientRect();
  }

  function getSpellcheckAnchorRect(editor, issue) {
    const start = Math.max(0, issue.start ?? 0);
    const end = Math.max(start, start + (issue.length ?? issue.original?.length ?? 0));

    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      return getTextControlRangeRect(editor, start, end);
    }

    if (editor instanceof HTMLElement && isRichTextEditor(editor)) {
      const range = createContentEditableRange(editor, start, end);

      if (!range) {
        return null;
      }

      const rect = getFirstVisibleRangeRect(range);
      range.detach();
      return rect;
    }

    return null;
  }

  function getTextControlRangeRect(editor, start, end) {
    const editorRect = editor.getBoundingClientRect();
    const startRect = editor instanceof HTMLInputElement
      ? getInputCaretRect(editor, start, editorRect)
      : getTextareaCaretRect(editor, start, editorRect);

    if (!startRect) {
      return null;
    }

    const endRect = editor instanceof HTMLInputElement
      ? getInputCaretRect(editor, end, editorRect)
      : getTextareaCaretRect(editor, end, editorRect);

    if (!endRect || Math.abs(endRect.top - startRect.top) > startRect.height / 2) {
      return startRect;
    }

    return createVirtualRect(
      startRect.left,
      startRect.top,
      Math.max(1, endRect.left - startRect.left),
      startRect.height
    );
  }

  function getTextControlCaretRect(editor) {
    const cursorIndex = editor.selectionStart ?? editor.value.length;
    const rect = editor.getBoundingClientRect();

    if (editor instanceof HTMLInputElement) {
      return getInputCaretRect(editor, cursorIndex, rect);
    }

    return getTextareaCaretRect(editor, cursorIndex, rect);
  }

  function getInputCaretRect(editor, cursorIndex, rect) {
    const style = window.getComputedStyle(editor);
    const canvas = getTextMeasureCanvas();
    const context = canvas.getContext("2d");

    if (!context) {
      return null;
    }

    context.font = style.font;

    const textBeforeCaret = editor.value.slice(0, cursorIndex);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const scrollLeft = editor.scrollLeft || 0;
    const textWidth = context.measureText(textBeforeCaret).width;
    const lineHeight = getLineHeight(style, editor);
    const left = rect.left + borderLeft + paddingLeft + textWidth - scrollLeft;
    const top = rect.top + borderTop + ((rect.height - lineHeight) / 2);

    return createVirtualRect(left, top, 1, lineHeight);
  }

  function getTextareaCaretRect(editor, cursorIndex, rect) {
    const style = window.getComputedStyle(editor);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    const textBeforeCaret = editor.value.slice(0, cursorIndex);
    const textAfterCaret = editor.value.slice(cursorIndex) || ".";

    copyTextControlStyles(editor, mirror, style);

    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.top = "0";
    mirror.style.left = "-9999px";
    mirror.style.width = `${rect.width}px`;
    mirror.style.height = "auto";
    mirror.style.minHeight = `${rect.height}px`;
    mirror.style.overflow = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";

    marker.textContent = textAfterCaret[0] === "\n" ? "\u200b" : textAfterCaret[0];
    mirror.textContent = textBeforeCaret;
    mirror.append(marker);
    document.documentElement.append(mirror);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const left = rect.left + (markerRect.left - mirrorRect.left) - editor.scrollLeft;
    const top = rect.top + (markerRect.top - mirrorRect.top) - editor.scrollTop;
    const lineHeight = getLineHeight(style, editor);

    mirror.remove();

    return createVirtualRect(
      Math.max(rect.left + borderLeft, Math.min(left, rect.right - 8)),
      Math.max(rect.top + borderTop, Math.min(top, rect.bottom - lineHeight)),
      1,
      lineHeight
    );
  }

  function copyTextControlStyles(editor, mirror, style) {
    const properties = [
      "boxSizing",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "fontVariant",
      "letterSpacing",
      "textTransform",
      "textIndent",
      "lineHeight",
      "tabSize"
    ];

    for (const property of properties) {
      mirror.style[property] = style[property];
    }

    mirror.style.direction = style.direction;
    mirror.style.textAlign = style.textAlign;
  }

  function getLineHeight(style, element) {
    const parsed = parseFloat(style.lineHeight);

    if (Number.isFinite(parsed)) {
      return parsed;
    }

    const fontSize = parseFloat(style.fontSize) || 14;
    return Math.max(fontSize * 1.25, element instanceof HTMLInputElement ? element.clientHeight : fontSize);
  }

  function getTextMeasureCanvas() {
    if (!getTextMeasureCanvas.canvas) {
      getTextMeasureCanvas.canvas = document.createElement("canvas");
    }

    return getTextMeasureCanvas.canvas;
  }

  function createVirtualRect(left, top, width, height) {
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height
    };
  }

  function getFirstVisibleRangeRect(range) {
    const rects = Array.from(range.getClientRects());
    const rect = rects.find((item) => item.width || item.height) ?? range.getBoundingClientRect();

    if (!rect.width && !rect.height) {
      return null;
    }

    return rect;
  }

  function positionFloatingBubble(bubble, anchorRect, offsetY) {
    if (!anchorRect) {
      return;
    }

    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxBubbleHeight = Math.max(120, viewportHeight - margin * 2);

    bubble.style.maxHeight = `${maxBubbleHeight}px`;
    bubble.style.overflowY = "auto";

    const bubbleWidth = Math.min(
      bubble.offsetWidth || bubble.getBoundingClientRect().width || 320,
      Math.max(160, viewportWidth - margin * 2)
    );
    const bubbleHeight = Math.min(
      bubble.offsetHeight || bubble.getBoundingClientRect().height || 80,
      maxBubbleHeight
    );
    const viewportLeft = clamp(
      Number.isFinite(anchorRect.left) ? anchorRect.left : margin,
      margin,
      Math.max(margin, viewportWidth - bubbleWidth - margin)
    );
    const spaceBelow = viewportHeight - anchorRect.bottom - offsetY - margin;
    const spaceAbove = anchorRect.top - offsetY - margin;
    const shouldPlaceAbove = spaceBelow < bubbleHeight && spaceAbove > spaceBelow;
    const preferredTop = shouldPlaceAbove
      ? anchorRect.top - bubbleHeight - offsetY
      : anchorRect.bottom + offsetY;
    const viewportTop = clamp(
      preferredTop,
      margin,
      Math.max(margin, viewportHeight - bubbleHeight - margin)
    );
    const left = viewportLeft + window.scrollX;
    const top = viewportTop + window.scrollY;

    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
    bubble.dataset.placement = shouldPlaceAbove ? "top" : "bottom";
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeAutocompleteSuggestionCount(value) {
    const count = Number(value);
    return Number.isInteger(count) ? clamp(count, 1, 3) : 1;
  }

  function ensureAutocompleteBubble() {
    if (autocompleteBubble) {
      return autocompleteBubble;
    }

    autocompleteBubble = document.createElement("div");
    autocompleteBubble.id = "rustype-autocomplete-bubble";
    autocompleteBubble.hidden = true;
    autocompleteBubble.innerHTML = `
      <div class="rustype-autocomplete-head">
        <button class="rustype-autocomplete-primary" type="button" data-rustype-accept>
          <span data-rustype-prefix></span><span data-rustype-completion></span>
        </button>
      </div>
      <div class="rustype-autocomplete-options" data-rustype-options></div>
      <div class="rustype-autocomplete-hint">
        <span data-rustype-hint-text><kbd>Tab</kbd> đổi · <kbd>Enter</kbd> nhận · <kbd>Ctrl</kbd> ưu tiên</span>
        <span data-rustype-status></span>
      </div>
    `;
    autocompleteBubble.style.position = "absolute";
    autocompleteBubble.style.zIndex = "2147483647";
    autocompleteBubble.style.display = "none";
    autocompleteBubble.style.flexDirection = "column";
    autocompleteBubble.style.alignItems = "flex-start";
    autocompleteBubble.style.gap = "7px";
    autocompleteBubble.style.maxWidth = "min(340px, calc(100vw - 24px))";
    autocompleteBubble.style.padding = "10px 12px";
    autocompleteBubble.style.border = "1px solid #a9c3ff";
    autocompleteBubble.style.borderRadius = "12px";
    autocompleteBubble.style.background = "rgba(255, 255, 255, 0.96)";
    autocompleteBubble.style.color = "#081945";
    autocompleteBubble.style.font = "800 13px/1.25 'Inter', 'Noto Sans', 'Segoe UI', sans-serif";
    autocompleteBubble.style.boxShadow = "4px 4px 0 rgba(18, 87, 255, 0.14), 0 14px 26px rgba(18, 87, 255, 0.16)";
    autocompleteBubble.style.pointerEvents = "auto";
    autocompleteBubble.addEventListener("mousedown", handleAutocompleteBubbleMouseDown);

    const style = document.createElement("style");
    style.textContent = `
      #rustype-autocomplete-bubble .rustype-autocomplete-head {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
      }

      #rustype-autocomplete-bubble[data-expanded="true"] .rustype-autocomplete-head {
        display: none;
      }

      #rustype-autocomplete-bubble .rustype-autocomplete-primary {
        min-width: 0;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 14px;
        font: inherit;
        font-weight: 900;
        padding: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: left;
      }

      #rustype-autocomplete-bubble [data-rustype-completion] {
        color: #8aaeff;
      }

      #rustype-autocomplete-bubble .rustype-autocomplete-options {
        display: none;
        width: 100%;
        gap: 4px;
      }

      #rustype-autocomplete-bubble[data-expanded="true"] .rustype-autocomplete-options {
        display: grid;
      }

      #rustype-autocomplete-bubble .rustype-autocomplete-option {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        align-items: center;
        width: 100%;
        border: 1px solid #d4e0ff;
        border-radius: 8px;
        background: #f8fbff;
        color: #081945;
        cursor: pointer;
        font: 900 12px/1.15 "Inter", "Noto Sans", "Segoe UI", sans-serif;
        padding: 7px 8px;
        text-align: left;
      }

      #rustype-autocomplete-bubble .rustype-autocomplete-option.is-selected {
        border-color: #1257ff;
        background: #fff360;
        box-shadow: 2px 2px 0 rgba(18, 87, 255, 0.2);
      }

      #rustype-autocomplete-bubble .rustype-autocomplete-option small {
        color: #1257ff;
        font-size: 10px;
        font-weight: 900;
      }

      #rustype-autocomplete-bubble .rustype-autocomplete-hint {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        width: 100%;
        color: #1257ff;
        font-size: 11px;
        font-weight: 900;
      }

      #rustype-autocomplete-bubble [data-rustype-status] {
        color: #08723e;
        white-space: nowrap;
      }

      #rustype-autocomplete-bubble kbd {
        border: 1px solid #a9c3ff;
        border-radius: 5px;
        background: #f3f8ff;
        color: #081945;
        font: 900 10px/1 "Inter", "Noto Sans", "Segoe UI", sans-serif;
        padding: 4px 6px;
      }
    `;

    document.documentElement.append(style);
    document.documentElement.append(autocompleteBubble);

    return autocompleteBubble;
  }

  function handleAutocompleteBubbleMouseDown(event) {
    event.preventDefault();

    if (!activeAutocomplete) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const optionButton = target?.closest("[data-rustype-option-index]");

    if (optionButton) {
      activeAutocomplete.selectedIndex = Number(optionButton.dataset.rustypeOptionIndex) || 0;
      acceptAutocomplete();
      return;
    }

    if (target?.closest("[data-rustype-accept]")) {
      acceptAutocomplete();
    }
  }

  function renderAutocompleteOptionList(bubble, suggestions, selectedIndex) {
    const list = bubble.querySelector("[data-rustype-options]");

    if (!list) {
      return;
    }

    list.textContent = "";

    for (const [index, suggestion] of suggestions.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = `rustype-autocomplete-option${index === selectedIndex ? " is-selected" : ""}`;
      option.dataset.rustypeOptionIndex = String(index);

      const word = document.createElement("span");
      word.textContent = suggestion.fullWord;

      const source = document.createElement("small");
      source.textContent = getAutocompleteSourceLabel(suggestion.reason);

      option.append(word, source);
      list.append(option);
    }
  }

  function getAutocompleteSourceLabel(reason) {
    if (reason === "favorite-word") {
      return "Ưu tiên";
    }

    if (reason === "personal-dictionary") {
      return "Cá nhân";
    }

    return "";
  }

  function moveAutocompleteSelection(delta) {
    if (!activeAutocomplete || activeAutocomplete.suggestions.length < 2) {
      return;
    }

    const count = activeAutocomplete.suggestions.length;
    activeAutocomplete.selectedIndex = ((activeAutocomplete.selectedIndex ?? 0) + delta + count) % count;

    renderAutocompleteBubble(activeAutocomplete.editor, activeAutocomplete.currentWord);
  }

  function hideAutocomplete() {
    activeAutocomplete = null;
    autocompleteControlCandidate = null;
    autocompleteControlChordUsed = false;

    if (autocompleteBubble) {
      autocompleteBubble.style.display = "none";
      autocompleteBubble.hidden = true;
    }
  }

  function acceptAutocomplete(selectedIndex = activeAutocomplete?.selectedIndex ?? 0) {
    if (!activeAutocomplete) {
      return;
    }

    const { editor, currentWord } = activeAutocomplete;
    activeAutocomplete.selectedIndex = selectedIndex;
    const suggestion = getActiveAutocompleteSuggestion();

    if (!suggestion?.fullWord) {
      hideAutocomplete();
      return;
    }

    replaceEditorRange(editor, currentWord, suggestion.fullWord);

    hideAutocomplete();
    scheduleEditorStateUpdate(0);
    scheduleSpellcheck(900);
    updateAutocomplete();
  }

  function getActiveAutocompleteSuggestion() {
    if (!activeAutocomplete) {
      return null;
    }

    const suggestions = activeAutocomplete.suggestions ?? [];
    const selectedIndex = clamp(activeAutocomplete.selectedIndex ?? 0, 0, Math.max(0, suggestions.length - 1));

    return suggestions[selectedIndex] ?? suggestions[0] ?? null;
  }

  async function addSelectedAutocompleteFavorite() {
    const suggestion = getActiveAutocompleteSuggestion();
    const normalized = normalizeRussianWord(suggestion?.fullWord);

    if (!normalized) {
      return;
    }

    const nextFavoriteWords = normalizeWordList([
      ...(settings.autocompleteFavoriteWords ?? []),
      normalized
    ]);
    const alreadySaved = normalizeWordList(settings.autocompleteFavoriteWords ?? []).includes(normalized);

    settings.autocompleteFavoriteWords = nextFavoriteWords;

    await sendRuntimeMessage({
      type: "RUSTYPE_SAVE_SETTINGS",
      payload: {
        autocompleteFavoriteWords: nextFavoriteWords
      }
    });

    if (activeAutocomplete) {
      activeAutocomplete.statusText = alreadySaved ? "Đã có trong ưu tiên" : "Đã thêm ưu tiên";
      renderAutocompleteBubble(activeAutocomplete.editor, activeAutocomplete.currentWord);
    }
  }

  async function runSpellcheck() {
    if (!canRunSpellcheck()) {
      bootstrapActiveEditor();

      if (!canRunSpellcheck()) {
        hideSpellcheckBubble();
        return;
      }
    }

    const snapshot = getEditorSnapshot(activeEditor);

    if (!snapshot || !CYRILLIC_RE.test(snapshot.text)) {
      hideSpellcheckBubble();
      return;
    }

    const chunk = extractActiveSentence(snapshot.text, snapshot.selectionStart);
    const text = chunk.text || snapshot.text;

    if (!text || text.length < 3) {
      hideSpellcheckBubble();
      return;
    }

    const response = await sendRuntimeMessage({
      type: "RUSTYPE_SPELLCHECK_TEXT",
      payload: {
        text,
        source: {
          urlHost: getCurrentHost(),
          editorType: getEditorType(activeEditor)
        }
      }
    });

    const spellingIssues = response?.ok
      ? (response.result?.issues?.filter((issue) => !isPersonalDictionaryWord(issue.original)) ?? [])
      : [];
    const grammarIssues = LOCAL_GRAMMAR_RULES_ENABLED ? getGrammarIssues(text) : [];
    const issues = [...spellingIssues, ...grammarIssues]
      .sort((left, right) => (left.start ?? 0) - (right.start ?? 0));

    if (!issues.length) {
      hideSpellcheckBubble();
      return;
    }

    const issue = issues[0];
    const issueWithOffsets = {
      ...issue,
      start: (chunk.text ? chunk.start : 0) + issue.start
    };

    activeSpellIssue = {
      editor: activeEditor,
      issue: issueWithOffsets
    };

    renderSpellcheckBubble(activeEditor, issueWithOffsets);
  }

  function getGrammarIssues(text) {
    const grammar = window.RusTypeGrammarRules;

    if (!grammar || typeof grammar.analyzeText !== "function") {
      return [];
    }

    try {
      return grammar.analyzeText(text);
    } catch {
      return [];
    }
  }

  function canRunSpellcheck() {
    const host = getCurrentHost();

    return Boolean(
      settings.enabled &&
      settings.spellcheckEnabled &&
      activeEditor &&
      document.contains(activeEditor) &&
      !isSensitiveEditor(activeEditor) &&
      !isGoogleDocsHost(host) &&
      isExtensionActiveForHost(host)
    );
  }

  function renderSpellcheckBubble(editor, issue) {
    const suggestion = issue.suggestions?.[0] ?? "";

    if (!suggestion) {
      hideSpellcheckBubble();
      return;
    }

    const bubble = ensureSpellcheckBubble();
    const rect = getSpellcheckAnchorRect(editor, issue) ?? editor.getBoundingClientRect();

    const isGrammarIssue = issue.type === "grammar";

    bubble.querySelector("[data-rustype-title]").textContent = isGrammarIssue
      ? "Gợi ý ngữ pháp"
      : "Gợi ý sửa nhanh";
    bubble.querySelector("[data-rustype-error]").textContent = issue.original;
    bubble.querySelector("[data-rustype-fix]").textContent = suggestion;
    const note = bubble.querySelector("[data-rustype-note]");
    note.textContent = issue.message ?? "";
    note.hidden = !issue.message;
    bubble.querySelector("[data-rustype-add-dictionary]").hidden = isGrammarIssue;
    bubble.querySelector("[data-rustype-yandex-attribution]").hidden = !isYandexSpellerIssue(issue);
    bubble.style.display = "grid";
    bubble.hidden = false;
    positionFloatingBubble(bubble, rect, 8);
  }

  function isYandexSpellerIssue(issue) {
    return issue?.source === "yandex-speller" || issue?.id?.startsWith("yandex-");
  }

  function ensureSpellcheckBubble() {
    if (spellcheckBubble) {
      return spellcheckBubble;
    }

    spellcheckBubble = document.createElement("div");
    spellcheckBubble.id = "rustype-spellcheck-bubble";
    spellcheckBubble.hidden = true;
    spellcheckBubble.innerHTML = `
      <div class="rustype-spellcheck-title">
        <span aria-hidden="true">⚠</span>
        <strong data-rustype-title>Gợi ý sửa nhanh</strong>
        <span aria-hidden="true">✦</span>
      </div>
      <div class="rustype-spellcheck-pair">
        <span data-rustype-error></span>
        <span aria-hidden="true">→</span>
        <strong data-rustype-fix></strong>
      </div>
      <p data-rustype-note></p>
      <p class="rustype-spellcheck-attribution" data-rustype-yandex-attribution hidden>
        <a href="http://api.yandex.ru/speller/" target="_blank" rel="noopener noreferrer">Проверка правописания: Яндекс.Спеллер</a>
      </p>
      <div class="rustype-spellcheck-actions">
        <button type="button" data-rustype-accept>Sửa</button>
        <button type="button" data-rustype-dismiss>Bỏ qua</button>
        <button type="button" data-rustype-add-dictionary>+ Thêm vào từ điển</button>
      </div>
    `;
    spellcheckBubble.style.position = "absolute";
    spellcheckBubble.style.zIndex = "2147483647";
    spellcheckBubble.style.display = "none";
    spellcheckBubble.style.gap = "10px";
    spellcheckBubble.style.maxWidth = "min(380px, calc(100vw - 24px))";
    spellcheckBubble.style.padding = "14px 16px";
    spellcheckBubble.style.border = "1px solid #a9c3ff";
    spellcheckBubble.style.borderRadius = "12px";
    spellcheckBubble.style.background = "rgba(255, 255, 255, 0.98)";
    spellcheckBubble.style.color = "#081945";
    spellcheckBubble.style.font = "800 13px/1.45 'Inter', 'Noto Sans', 'Segoe UI', sans-serif";
    spellcheckBubble.style.boxShadow = "4px 4px 0 rgba(18, 87, 255, 0.14), 0 16px 30px rgba(18, 87, 255, 0.16)";

    const style = document.createElement("style");
    style.textContent = `
      #rustype-spellcheck-bubble .rustype-spellcheck-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: #081945;
        font-size: 12px;
        font-weight: 900;
      }

      #rustype-spellcheck-bubble [hidden] {
        display: none !important;
      }

      #rustype-spellcheck-bubble .rustype-spellcheck-pair {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 16px;
        font-weight: 900;
      }

      #rustype-spellcheck-bubble [data-rustype-error] {
        color: #df1f17;
        text-decoration: underline wavy #df1f17;
        text-underline-offset: 4px;
      }

      #rustype-spellcheck-bubble [data-rustype-fix] {
        color: #098b43;
      }

      #rustype-spellcheck-bubble [data-rustype-note] {
        margin: -2px 0 0;
        color: #617197;
        font-size: 12px;
        font-weight: 800;
      }

      #rustype-spellcheck-bubble .rustype-spellcheck-attribution {
        margin: -2px 0 0;
        color: #081945;
        font-size: 13px;
        font-weight: 800;
      }

      #rustype-spellcheck-bubble .rustype-spellcheck-attribution a {
        color: inherit;
        font-size: inherit;
        font-weight: inherit;
        text-decoration: underline;
      }

      #rustype-spellcheck-bubble .rustype-spellcheck-actions {
        display: grid;
        grid-template-columns: auto auto;
        gap: 8px;
      }

      #rustype-spellcheck-bubble button {
        border: 1px solid #a9c3ff;
        border-radius: 8px;
        background: #ffffff;
        color: #1257ff;
        cursor: pointer;
        font: 900 12px/1 "Inter", "Noto Sans", "Segoe UI", sans-serif;
        padding: 9px 11px;
      }

      #rustype-spellcheck-bubble [data-rustype-accept] {
        border-color: #1257ff;
        background: #1257ff;
        box-shadow: 2px 2px 0 #0639c6;
        color: #ffffff;
      }

      #rustype-spellcheck-bubble [data-rustype-add-dictionary] {
        grid-column: 1 / -1;
        justify-self: stretch;
      }
    `;

    spellcheckBubble
      .querySelector("[data-rustype-accept]")
      .addEventListener("click", acceptSpellcheckIssue);
    spellcheckBubble
      .querySelector("[data-rustype-dismiss]")
      .addEventListener("click", hideSpellcheckBubble);
    spellcheckBubble
      .querySelector("[data-rustype-add-dictionary]")
      .addEventListener("click", () => {
        runSafely(addActiveSpellIssueToDictionary);
      });
    spellcheckBubble.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });

    document.documentElement.append(style);
    document.documentElement.append(spellcheckBubble);

    return spellcheckBubble;
  }

  function acceptSpellcheckIssue() {
    if (!activeSpellIssue) {
      return;
    }

    const { editor, issue } = activeSpellIssue;
    const suggestion = issue.suggestions?.[0];

    if (!suggestion) {
      hideSpellcheckBubble();
      return;
    }

    const wordRange = {
      start: issue.start,
      end: issue.start + issue.length
    };

    replaceEditorRange(editor, wordRange, suggestion);

    hideSpellcheckBubble();
    scheduleEditorStateUpdate(0);
    scheduleSpellcheck(900);
  }

  function hideSpellcheckBubble() {
    activeSpellIssue = null;

    if (spellcheckBubble) {
      spellcheckBubble.style.display = "none";
      spellcheckBubble.hidden = true;
    }
  }

  function showSelectionActionBubble(payload) {
    if (!canShowSelectionTranslate()) {
      hideSelectionTranslateBubble();
      return;
    }

    const action = payload.action === "explain" ? "explain" : "translate";
    const payloadText = String(payload.text ?? "").trim();
    const editor = findActiveEditable();
    const selectionInfo = editor && document.contains(editor)
      ? getEditorSelectionInfo(editor)
      : getWindowSelectionInfo();
    const text = (payloadText || selectionInfo?.text || "").slice(0, 5000).trim();
    const translationPair = action === "explain"
      ? (resolveTranslationPair(text) ?? createAiSelectionPair(text))
      : resolveTranslationPair(text);

    if (!translationPair) {
      hideSelectionTranslateBubble();
      return;
    }

    const rect = selectionInfo?.rect ?? getSelectionFallbackRect(editor);

    activeTranslationText = text;
    activeSelectionAction = action;
    activeTranslationPair = translationPair;
    renderSelectionTranslateBubble({
      text,
      rect
    }, action, translationPair);

    if (action === "translate") {
      translateSelectedTextInline(text, {
        force: true,
        translationPair
      });
      return;
    }

    explainSelectedTextInline(text, { force: true });
  }

  function canShowSelectionTranslate() {
    const host = getCurrentHost();

    return Boolean(
      settings.enabled &&
      isExtensionActiveForHost(host)
    );
  }

  function resolveTranslationPair(text, providerIdOverride) {
    const value = String(text ?? "").trim();

    if (!value || !TRANSLATABLE_TEXT_RE.test(value)) {
      return null;
    }

    const storedProviderId = providerIdOverride ?? settings.selectionTranslateProvider ?? DEFAULT_SETTINGS.selectionTranslateProvider;
    const providerId = TRANSLATION_PROVIDER_CONFIG[storedProviderId]
      ? storedProviderId
      : DEFAULT_SETTINGS.selectionTranslateProvider;
    const provider = TRANSLATION_PROVIDER_CONFIG[providerId];

    if (!provider.languages.includes("ru") && CYRILLIC_RE.test(value)) {
      return null;
    }

    const [firstLanguage, secondLanguage] = provider.languages;
    const sourceLanguage = resolveSourceLanguageForPair(value, firstLanguage, secondLanguage);
    const targetLanguage = sourceLanguage === firstLanguage ? secondLanguage : firstLanguage;

    return {
      providerId,
      sourceLanguage,
      targetLanguage,
      sourceLabel: LANGUAGE_LABELS[sourceLanguage] ?? sourceLanguage,
      targetLabel: LANGUAGE_LABELS[targetLanguage] ?? targetLanguage,
      pairLabel: provider.pairLabel
    };
  }

  function resolveSourceLanguageForPair(text, firstLanguage, secondLanguage) {
    if (firstLanguage === "ru" || secondLanguage === "ru") {
      return CYRILLIC_RE.test(text)
        ? "ru"
        : (firstLanguage === "ru" ? secondLanguage : firstLanguage);
    }

    return VIETNAMESE_RE.test(text) ? "vi" : "en";
  }

  function resolveSourceLanguageForText(text) {
    if (CYRILLIC_RE.test(text)) {
      return "ru";
    }

    if (VIETNAMESE_RE.test(text)) {
      return "vi";
    }

    if (/[A-Za-z]/.test(text)) {
      return "en";
    }

    return "auto";
  }

  function createAiSelectionPair(text) {
    const sourceLanguage = resolveSourceLanguageForText(text);

    if (sourceLanguage === "auto") {
      return null;
    }

    return {
      providerId: settings.selectionTranslateProvider ?? DEFAULT_SETTINGS.selectionTranslateProvider,
      sourceLanguage,
      targetLanguage: DEFAULT_SETTINGS.aiOutputLanguage,
      sourceLabel: LANGUAGE_LABELS[sourceLanguage] ?? sourceLanguage,
      targetLabel: "AI",
      pairLabel: "AI"
    };
  }

  function resolveFallbackTranslationPair(text, sourceLanguage, targetLanguage) {
    if (!sourceLanguage || !targetLanguage || sourceLanguage === targetLanguage) {
      return null;
    }

    const providerEntry = Object.entries(TRANSLATION_PROVIDER_CONFIG)
      .find(([, provider]) => provider.languages.includes(sourceLanguage) && provider.languages.includes(targetLanguage));
    const providerId = providerEntry?.[0];

    return providerId ? resolveTranslationPair(text, providerId) : null;
  }

  function getEditorSelectionInfo(editor) {
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      const start = editor.selectionStart ?? 0;
      const end = editor.selectionEnd ?? 0;

      if (start === end) {
        return null;
      }

      return {
        text: editor.value.slice(start, end).trim(),
        rect: getTextControlRangeRect(editor, start, end)
      };
    }

    if (editor instanceof HTMLElement && isRichTextEditor(editor)) {
      return getWindowSelectionInfo(editor);
    }

    return null;
  }

  function getWindowSelectionInfo(scope = document.body) {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selectedText) {
      return null;
    }

    if (scope && !scope.contains(selection.anchorNode)) {
      return null;
    }

    const range = selection.getRangeAt(0);

    return {
      text: selectedText,
      rect: getFirstVisibleRangeRect(range)
    };
  }

  function renderSelectionTranslateBubble(selectionInfo, action, translationPair) {
    const bubble = ensureSelectionTranslateBubble();
    const preview = createTextPreview(selectionInfo.text);

    updateSelectionTranslateBubbleContent({
      action,
      preview,
      translationPair,
      loading: true
    });

    bubble.dataset.state = "loading";
    bubble.dataset.action = action;
    bubble.style.display = "grid";
    bubble.hidden = false;
    positionFloatingBubble(bubble, selectionInfo.rect, 8);
  }

  function updateSelectionTranslateBubbleContent({ action, preview, translationPair, loading }) {
    const bubble = ensureSelectionTranslateBubble();
    if (action === "explain") {
      initializeInlineAiControls();
    }

    const title = action === "explain"
      ? "Sử dụng AI"
      : `Dịch · ${translationPair.pairLabel}`;
    const resultLabel = action === "explain" ? getAiTaskDisplayName(getInlineAiTask()) : translationPair.targetLabel;
    const loadingText = action === "explain"
      ? "Đang chạy AI..."
      : "Đang dịch...";

    bubble.querySelector("[data-rustype-translate-title]").textContent = title;
    if (preview !== undefined) {
      bubble.querySelector("[data-rustype-translate-preview]").textContent = preview;
    }
    bubble.querySelector("[data-rustype-translate-result-label]").textContent = resultLabel;
    bubble.querySelector(".rustype-translate-pair").hidden = action === "explain";
    bubble.querySelector(".rustype-ai-controls").hidden = action !== "explain";
    if (loading) {
      bubble.querySelector("[data-rustype-translate-result]").textContent = loadingText;
      bubble.dataset.state = "loading";
    }
    bubble.querySelector("[data-rustype-translate-retry]").textContent =
      action === "explain" ? "Chạy AI lại" : "Dịch lại";
    bubble.querySelector("[data-rustype-translate-pair]").value = translationPair.providerId;
  }

  function ensureSelectionTranslateBubble() {
    if (selectionTranslateBubble) {
      return selectionTranslateBubble;
    }

    selectionTranslateBubble = document.createElement("div");
    selectionTranslateBubble.id = "rustype-selection-translate-bubble";
    selectionTranslateBubble.hidden = true;
    selectionTranslateBubble.innerHTML = `
      <div class="rustype-translate-header">
        <span data-rustype-translate-title>Dịch</span>
        <button type="button" data-rustype-translate-close aria-label="Đóng">×</button>
      </div>
      <label class="rustype-translate-pair">
        <span>Cặp dịch</span>
        <select data-rustype-translate-pair aria-label="Chọn cặp ngôn ngữ"></select>
      </label>
      <div class="rustype-ai-controls" hidden>
        <label class="rustype-ai-language">
          <span>AI trả lời bằng</span>
          <select data-rustype-ai-language aria-label="Chọn ngôn ngữ AI trả lời">
            <option value="vi">Tiếng Việt</option>
            <option value="ru">Tiếng Nga</option>
            <option value="en">Tiếng Anh</option>
          </select>
        </label>
        <fieldset class="rustype-ai-task">
          <legend>Tác vụ</legend>
          <label>
            <input type="radio" name="rustype-ai-task" value="explain" checked>
            <span>Giải thích</span>
          </label>
          <label>
            <input type="radio" name="rustype-ai-task" value="summarize">
            <span>Tóm tắt</span>
          </label>
          <label>
            <input type="radio" name="rustype-ai-task" value="rewrite">
            <span>Viết lại</span>
          </label>
        </fieldset>
      </div>
      <div class="rustype-translate-block">
        <span>Đoạn chọn</span>
        <p data-rustype-translate-preview></p>
      </div>
      <div class="rustype-translate-block rustype-translate-result">
        <span data-rustype-translate-result-label>Việt</span>
        <p data-rustype-translate-result>Đang dịch...</p>
      </div>
      <div class="rustype-translate-actions">
        <button type="button" data-rustype-translate-retry>Dịch lại</button>
      </div>
    `;
    selectionTranslateBubble.style.position = "absolute";
    selectionTranslateBubble.style.zIndex = "2147483647";
    selectionTranslateBubble.style.display = "none";
    selectionTranslateBubble.style.gap = "8px";
    selectionTranslateBubble.style.maxWidth = "min(360px, calc(100vw - 24px))";
    selectionTranslateBubble.style.padding = "12px";
    selectionTranslateBubble.style.border = "1px solid #a9c3ff";
    selectionTranslateBubble.style.borderRadius = "12px";
    selectionTranslateBubble.style.background = "rgba(255, 255, 255, 0.98)";
    selectionTranslateBubble.style.color = "#081945";
    selectionTranslateBubble.style.font = "800 12px/1.35 'Inter', 'Noto Sans', 'Segoe UI', sans-serif";
    selectionTranslateBubble.style.boxShadow = "4px 4px 0 rgba(18, 87, 255, 0.14), 0 14px 26px rgba(18, 87, 255, 0.16)";

    const style = document.createElement("style");
    style.textContent = `
      #rustype-selection-translate-bubble .rustype-translate-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: #1257ff;
        font-size: 12px;
        font-weight: 900;
      }

      #rustype-selection-translate-bubble [hidden] {
        display: none !important;
      }

      #rustype-selection-translate-bubble .rustype-translate-block {
        display: grid;
        gap: 4px;
        border: 1px solid #d7e4ff;
        border-radius: 9px;
        background: #f7fbff;
        padding: 8px 9px;
      }

      #rustype-selection-translate-bubble .rustype-translate-pair {
        display: grid;
        gap: 4px;
      }

      #rustype-selection-translate-bubble .rustype-ai-controls {
        display: grid;
        grid-template-columns: minmax(146px, 164px) minmax(0, 1fr);
        align-items: start;
        gap: 10px;
        border: 1px solid #d7e4ff;
        border-radius: 9px;
        background: #f7fbff;
        padding: 10px;
      }

      #rustype-selection-translate-bubble .rustype-ai-language {
        display: grid;
        gap: 6px;
        align-content: start;
        border: 1px solid #d7e4ff;
        border-radius: 10px;
        background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
        padding: 8px;
      }

      #rustype-selection-translate-bubble .rustype-ai-task {
        display: flex;
        flex-wrap: wrap;
        align-content: flex-start;
        gap: 6px;
        min-width: 0;
        margin: 0;
        border: 1px solid #d7e4ff;
        border-radius: 10px;
        background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
        padding: 8px;
      }

      #rustype-selection-translate-bubble .rustype-ai-task label {
        cursor: pointer;
      }

      #rustype-selection-translate-bubble .rustype-ai-task input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }

      #rustype-selection-translate-bubble .rustype-ai-task label span {
        display: inline-flex;
        min-height: 28px;
        align-items: center;
        border: 1px solid #a9c3ff;
        border-radius: 8px;
        background: #ffffff;
        color: #081945;
        font-size: 11px;
        padding: 5px 7px;
        text-transform: none;
      }

      #rustype-selection-translate-bubble .rustype-ai-task input:checked + span {
        border-color: #0639c6;
        background: #ffe36d;
        box-shadow: 2px 2px 0 #0639c6;
        color: #0639c6;
      }

      #rustype-selection-translate-bubble .rustype-translate-pair span,
      #rustype-selection-translate-bubble .rustype-ai-language span,
      #rustype-selection-translate-bubble .rustype-ai-task legend {
        color: #617197;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }

      #rustype-selection-translate-bubble .rustype-translate-pair select,
      #rustype-selection-translate-bubble .rustype-ai-language select {
        width: 100%;
        border: 1px solid #a9c3ff;
        border-radius: 9px;
        background:
          linear-gradient(45deg, transparent 50%, #4664a8 50%),
          linear-gradient(135deg, #4664a8 50%, transparent 50%),
          linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
        background-position:
          calc(100% - 18px) calc(50% - 2px),
          calc(100% - 12px) calc(50% - 2px),
          0 0;
        background-size:
          6px 6px,
          6px 6px,
          100% 100%;
        background-repeat: no-repeat;
        color: #081945;
        font: 900 12px/1.2 "Inter", "Noto Sans", "Segoe UI", sans-serif;
        min-height: 38px;
        padding: 8px 34px 8px 10px;
        appearance: none;
        align-self: start;
      }

      #rustype-selection-translate-bubble .rustype-translate-block span {
        color: #617197;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }

      #rustype-selection-translate-bubble .rustype-translate-block p {
        max-width: 320px;
        margin: 0;
        color: #24345f;
        font-size: 12px;
        font-weight: 800;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      #rustype-selection-translate-bubble .rustype-translate-result p {
        color: #081945;
        font-size: 13px;
      }

      #rustype-selection-translate-bubble[data-state="loading"] .rustype-translate-result p {
        color: #617197;
      }

      #rustype-selection-translate-bubble .rustype-translate-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #rustype-selection-translate-bubble button {
        border: 1px solid #a9c3ff;
        border-radius: 8px;
        background: #ffffff;
        color: #1257ff;
        cursor: pointer;
        font: 900 12px/1 "Inter", "Noto Sans", "Segoe UI", sans-serif;
        padding: 8px 10px;
      }

      #rustype-selection-translate-bubble [data-rustype-translate-retry] {
        border-color: #1257ff;
        background: #1257ff;
        box-shadow: 2px 2px 0 #0639c6;
        color: #ffffff;
      }

      #rustype-selection-translate-bubble [data-rustype-translate-close] {
        width: 30px;
        padding-inline: 0;
      }

      @media (max-width: 420px) {
        #rustype-selection-translate-bubble .rustype-ai-controls {
          grid-template-columns: 1fr;
        }
      }
    `;

    const pairSelect = selectionTranslateBubble.querySelector("[data-rustype-translate-pair]");
    for (const [providerId, provider] of Object.entries(TRANSLATION_PROVIDER_CONFIG)) {
      const option = document.createElement("option");
      option.value = providerId;
      option.textContent = provider.pairLabel;
      pairSelect.append(option);
    }

    pairSelect.addEventListener("change", handleSelectionTranslatePairChange);
    selectionTranslateBubble
      .querySelector("[data-rustype-ai-language]")
      .addEventListener("change", () => {
        if (activeSelectionAction === "explain") {
          explainSelectedTextInline(activeTranslationText, { force: true });
        }
      });
    selectionTranslateBubble.querySelectorAll("input[name='rustype-ai-task']").forEach((input) => {
      input.addEventListener("change", () => {
        if (activeSelectionAction === "explain") {
          explainSelectedTextInline(activeTranslationText, { force: true });
        }
      });
    });
    selectionTranslateBubble
      .querySelector("[data-rustype-translate-retry]")
      .addEventListener("click", () => {
        if (activeSelectionAction === "explain") {
          explainSelectedTextInline(activeTranslationText, { force: true });
          return;
        }

        translateSelectedTextInline(activeTranslationText, {
          force: true,
          translationPair: activeTranslationPair
        });
      });
    selectionTranslateBubble
      .querySelector("[data-rustype-translate-close]")
      .addEventListener("click", hideSelectionTranslateBubble);
    selectionTranslateBubble.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest("button,select,input,label")) {
        return;
      }

      event.preventDefault();
    });

    document.documentElement.append(style);
    document.documentElement.append(selectionTranslateBubble);

    return selectionTranslateBubble;
  }

  function getSelectionFallbackRect(editor) {
    if (editor && document.contains(editor)) {
      return editor.getBoundingClientRect();
    }

    return createVirtualRect(
      Math.max(8, window.innerWidth / 2 - 160),
      Math.max(8, window.innerHeight / 2 - 60),
      1,
      20
    );
  }

  function handleSelectionTranslatePairChange(event) {
    const providerId = event.currentTarget?.value;
    const provider = TRANSLATION_PROVIDER_CONFIG[providerId];

    if (!provider) {
      return;
    }

    settings.selectionTranslateProvider = providerId;
    sendRuntimeMessage({
      type: "RUSTYPE_SAVE_SETTINGS",
      payload: {
        selectionTranslateProvider: providerId
      }
    });

    const translationPair = resolveTranslationPair(activeTranslationText, providerId);

    if (!translationPair) {
      activeTranslationPair = null;
      renderUnsupportedTranslationPair(provider.pairLabel);
      return;
    }

    activeTranslationPair = translationPair;
    updateSelectionTranslateBubbleContent({
      action: activeSelectionAction,
      translationPair,
      loading: true
    });

    if (activeSelectionAction === "explain") {
      explainSelectedTextInline(activeTranslationText, { translationPair });
      return;
    }

    translateSelectedTextInline(activeTranslationText, { translationPair });
  }

  function renderUnsupportedTranslationPair(pairLabel) {
    const bubble = ensureSelectionTranslateBubble();
    const title = activeSelectionAction === "explain"
      ? "Sử dụng AI"
      : `Dịch · ${pairLabel}`;

    bubble.querySelector("[data-rustype-translate-title]").textContent = title;
    bubble.querySelector("[data-rustype-translate-result-label]").textContent = "Không hỗ trợ";
    bubble.querySelector("[data-rustype-translate-result]").textContent =
      `Cặp ${pairLabel} không phù hợp với đoạn đang chọn. Hãy chọn cặp có ngôn ngữ của đoạn này.`;
    bubble.querySelector("[data-rustype-translate-retry]").textContent =
      activeSelectionAction === "explain" ? "Chạy AI lại" : "Dịch lại";
    bubble.dataset.state = "error";
  }

  async function translateSelectedTextInline(text, options = {}) {
    const value = String(text ?? "").trim();
    const translationPair = options.translationPair ?? activeTranslationPair ?? resolveTranslationPair(value);

    if (!value || !translationPair) {
      hideSelectionTranslateBubble();
      return;
    }

    const requestId = ++activeTranslationRequestId;
    const bubble = ensureSelectionTranslateBubble();

    if (options.force) {
      bubble.querySelector("[data-rustype-translate-result]").textContent = "Đang dịch...";
      bubble.dataset.state = "loading";
    }

    const response = await sendRuntimeMessage({
      type: "RUSTYPE_TRANSLATE_SELECTION",
      payload: {
        text: value,
        sourceLanguage: translationPair.sourceLanguage,
        targetLanguage: translationPair.targetLanguage
      }
    });

    if (requestId !== activeTranslationRequestId || value !== activeTranslationText) {
      return;
    }

    if (!response?.ok || !response.result?.translatedText) {
      bubble.querySelector("[data-rustype-translate-result]").textContent =
        "Không dịch được lúc này. Hãy thử lại.";
      bubble.dataset.state = "error";
      return;
    }

    bubble.querySelector("[data-rustype-translate-result]").textContent = response.result.translatedText;
    bubble.dataset.state = "ready";
  }

  async function explainSelectedTextInline(text, options = {}) {
    const value = String(text ?? "").trim();
    const aiOutputLanguage = getInlineAiOutputLanguage();
    const aiTask = getInlineAiTask();
    const sourceLanguage = resolveSourceLanguageForText(value);

    if (!value || sourceLanguage === "auto") {
      hideSelectionTranslateBubble();
      return;
    }

    const requestId = ++activeTranslationRequestId;
    const bubble = ensureSelectionTranslateBubble();

    if (options.force) {
      bubble.querySelector("[data-rustype-translate-result]").textContent = "Đang chạy AI...";
      bubble.querySelector("[data-rustype-translate-title]").textContent = `Sử dụng AI · ${getAiTaskDisplayName(aiTask)}`;
      bubble.querySelector("[data-rustype-translate-result-label]").textContent = getAiTaskDisplayName(aiTask);
      bubble.dataset.state = "loading";
    }

    const aiExplanation = await sendRuntimeMessage({
      type: "RUSTYPE_EXPLAIN_SELECTION",
      payload: {
        text: value,
        sourceLanguage,
        targetLanguage: aiOutputLanguage,
        aiOutputLanguage,
        aiTask
      }
    });

    if (requestId !== activeTranslationRequestId || value !== activeTranslationText) {
      return;
    }

    if (aiExplanation?.ok && aiExplanation.result?.explanationText) {
      const taskLabel = getAiTaskDisplayName(aiExplanation.result.task);
      bubble.querySelector("[data-rustype-translate-title]").textContent = `Sử dụng AI · ${taskLabel}`;
      bubble.querySelector("[data-rustype-translate-result-label]").textContent = taskLabel;
      bubble.querySelector("[data-rustype-translate-result]").textContent =
        formatAiResultText(aiExplanation.result.explanationText);
      bubble.dataset.state = "ready";
      return;
    }

    if (aiTask !== "explain") {
      bubble.querySelector("[data-rustype-translate-result]").textContent =
        "Chưa thể chạy AI lúc này. Hãy kiểm tra API key hoặc provider.";
      bubble.dataset.state = "error";
      return;
    }

    const fallbackPair = resolveFallbackTranslationPair(value, sourceLanguage, aiOutputLanguage);

    if (!fallbackPair) {
      bubble.querySelector("[data-rustype-translate-result]").textContent =
        "Chưa thể chạy AI lúc này. Hãy kiểm tra API key hoặc provider.";
      bubble.dataset.state = "error";
      return;
    }

    const translation = await sendRuntimeMessage({
      type: "RUSTYPE_TRANSLATE_SELECTION",
      payload: {
        text: value,
        sourceLanguage: fallbackPair.sourceLanguage,
        targetLanguage: fallbackPair.targetLanguage
      }
    });

    if (requestId !== activeTranslationRequestId || value !== activeTranslationText) {
      return;
    }

    if (!translation?.ok || !translation.result?.translatedText) {
      bubble.querySelector("[data-rustype-translate-result]").textContent =
        "Chưa thể giải thích đoạn này. Phase sau sẽ dùng API key AI của bạn.";
      bubble.dataset.state = "error";
      return;
    }

    bubble.querySelector("[data-rustype-translate-result]").textContent =
      `Nghĩa chính (${fallbackPair.targetLabel}): ${translation.result.translatedText}\n\nMuốn giải thích sâu hơn, hãy bật AI và thêm API key trong Settings.`;
    bubble.dataset.state = "ready";
  }

  function initializeInlineAiControls() {
    const bubble = ensureSelectionTranslateBubble();
    const languageSelect = bubble.querySelector("[data-rustype-ai-language]");

    languageSelect.value = DEFAULT_SETTINGS.aiOutputLanguage;

    const currentTask = getInlineAiTask();
    const taskInput = bubble.querySelector(`input[name='rustype-ai-task'][value='${currentTask}']`)
      ?? bubble.querySelector(`input[name='rustype-ai-task'][value='${DEFAULT_SETTINGS.aiTask}']`);

    if (taskInput) {
      taskInput.checked = true;
    }
  }

  function getInlineAiOutputLanguage() {
    const value = ensureSelectionTranslateBubble().querySelector("[data-rustype-ai-language]")?.value;
    return AI_OUTPUT_LANGUAGES.includes(value) ? value : DEFAULT_SETTINGS.aiOutputLanguage;
  }

  function getInlineAiTask() {
    const value = ensureSelectionTranslateBubble().querySelector("input[name='rustype-ai-task']:checked")?.value;
    return AI_TASKS.includes(value) ? value : DEFAULT_SETTINGS.aiTask;
  }

  function getAiTaskDisplayName(task) {
    return {
      explain: "Giải thích",
      rewrite: "Viết lại",
      summarize: "Tóm tắt"
    }[task] ?? "AI";
  }

  function formatAiResultText(text) {
    return String(text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/```[\s\S]*?```/g, (match) => match.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""))
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}[-*+]\s+/gm, "- ")
      .replace(/^\s{0,3}(\d+)\.\s+/gm, "$1. ")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function hideSelectionTranslateBubbleIfPassive() {
    if (!selectionTranslateBubble || selectionTranslateBubble.hidden) {
      return;
    }

    if (activeSelectionAction === "explain") {
      return;
    }

    hideSelectionTranslateBubble();
  }

  function hideSelectionTranslateBubble() {
    activeTranslationText = "";
    activeSelectionAction = "translate";
    activeTranslationPair = null;
    activeTranslationRequestId += 1;

    if (selectionTranslateBubble) {
      selectionTranslateBubble.style.display = "none";
      selectionTranslateBubble.hidden = true;
    }
  }

  async function addActiveSpellIssueToDictionary() {
    const word = activeSpellIssue?.issue?.original;

    if (!word) {
      hideSpellcheckBubble();
      return;
    }

    const nextDictionary = Array.from(new Set([
      ...(settings.personalDictionary ?? []),
      word.toLocaleLowerCase("ru-RU")
    ]))
      .map((item) => item.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "ru"));

    settings.personalDictionary = nextDictionary;

    await sendRuntimeMessage({
      type: "RUSTYPE_SAVE_SETTINGS",
      payload: {
        personalDictionary: nextDictionary
      }
    });

    hideSpellcheckBubble();
    scheduleEditorStateUpdate(0);
  }

  function isPersonalDictionaryWord(word) {
    const normalized = normalizeRussianWord(word);

    if (!normalized) {
      return false;
    }

    return (settings.personalDictionary ?? []).some((item) => {
      return String(item).trim().toLocaleLowerCase("ru-RU") === normalized;
    });
  }

  function normalizeWordList(words) {
    return Array.from(new Set((words ?? []).map(normalizeRussianWord).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right, "ru"));
  }

  function normalizeRussianWord(word) {
    return String(word ?? "").trim().toLocaleLowerCase("ru-RU");
  }

  function replaceEditorRange(editor, textRange, replacement) {
    if (!editor || !document.contains(editor)) {
      return false;
    }

    if (replaceCodeMirror5Range(editor, textRange, replacement)) {
      return true;
    }

    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      replaceInputWord(editor, textRange, replacement);
      return true;
    }

    if (editor instanceof HTMLElement && isRichTextEditor(editor)) {
      return replaceContentEditableWord(editor, textRange, replacement);
    }

    return false;
  }

  function replaceInputWord(editor, currentWord, fullWord) {
    const before = editor.value.slice(0, currentWord.start);
    const after = editor.value.slice(currentWord.end);
    const nextValue = `${before}${fullWord}${after}`;

    focusEditor(editor);
    setNativeInputValue(editor, nextValue);

    const nextCursor = currentWord.start + fullWord.length;
    editor.setSelectionRange(nextCursor, nextCursor);
    dispatchReplacementInput(editor, fullWord);
  }

  function replaceContentEditableWord(editor, currentWord, fullWord) {
    if (replaceRichTextRange(editor, currentWord, fullWord)) {
      return true;
    }

    if (isKnownControlledEditor(editor)) {
      return false;
    }

    const snapshot = getEditorSnapshot(editor);
    if (!snapshot) {
      return false;
    }

    const nextText = `${snapshot.text.slice(0, currentWord.start)}${fullWord}${snapshot.text.slice(currentWord.end)}`;
    editor.textContent = nextText;
    setContentEditableCaret(editor, currentWord.start + fullWord.length);
    dispatchReplacementInput(editor, fullWord);
    return true;
  }

  function replaceRichTextRange(editor, currentWord, fullWord) {
    focusEditor(editor);

    const range = createContentEditableRange(editor, currentWord.start, currentWord.end);

    if (!range) {
      return false;
    }

    const selection = window.getSelection();

    if (!selection) {
      return false;
    }

    selection.removeAllRanges();
    selection.addRange(range);

    if (insertTextWithExecCommand(fullWord)) {
      dispatchReplacementInput(editor, fullWord);
      return true;
    }

    if (isKnownControlledEditor(editor)) {
      return false;
    }

    range.deleteContents();

    const textNode = document.createTextNode(fullWord);
    range.insertNode(textNode);

    const caret = document.createRange();
    caret.setStart(textNode, fullWord.length);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);

    dispatchReplacementInput(editor, fullWord);
    return true;
  }

  function insertTextWithExecCommand(text) {
    try {
      if (typeof document.execCommand !== "function") {
        return false;
      }

      return document.execCommand("insertText", false, text);
    } catch {
      return false;
    }
  }

  function replaceCodeMirror5Range(editor, textRange, replacement) {
    const codeMirror = findCodeMirror5Instance(editor);
    const doc = codeMirror?.getDoc?.();

    if (!doc?.posFromIndex || !doc?.replaceRange) {
      return false;
    }

    const from = doc.posFromIndex(textRange.start);
    const to = doc.posFromIndex(textRange.end);

    codeMirror.focus?.();
    doc.replaceRange(replacement, from, to, "+input");
    return true;
  }

  function findCodeMirror5Instance(editor) {
    if (!(editor instanceof Element)) {
      return null;
    }

    const wrapper = editor.closest(".CodeMirror");

    if (wrapper?.CodeMirror) {
      return wrapper.CodeMirror;
    }

    const parentWrapper = editor.parentElement?.closest(".CodeMirror");

    return parentWrapper?.CodeMirror ?? null;
  }

  function createContentEditableRange(root, start, end) {
    const startPosition = getTextPosition(root, start);
    const endPosition = getTextPosition(root, end);

    if (!startPosition || !endPosition) {
      return null;
    }

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    return range;
  }

  function getTextPosition(root, targetOffset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let node = walker.nextNode();

    while (node) {
      const textLength = node.textContent.length;
      const nextOffset = currentOffset + textLength;

      if (targetOffset <= nextOffset) {
        return {
          node,
          offset: Math.max(0, Math.min(textLength, targetOffset - currentOffset))
        };
      }

      currentOffset = nextOffset;
      node = walker.nextNode();
    }

    if (targetOffset === 0) {
      return {
        node: root,
        offset: 0
      };
    }

    return null;
  }

  function setNativeInputValue(editor, value) {
    const prototype = editor instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(editor, value);
      return;
    }

    editor.value = value;
  }

  function dispatchReplacementInput(editor, text) {
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: text
    }));
  }

  function focusEditor(editor) {
    try {
      editor.focus({ preventScroll: true });
    } catch {
      editor.focus?.();
    }
  }

  function isKnownControlledEditor(editor) {
    return Boolean(
      editor instanceof Element &&
      editor.closest(".cm-editor,.CodeMirror,.ProseMirror,[data-slate-editor='true'],[data-lexical-editor='true']")
    );
  }

  function setContentEditableCaret(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let node = walker.nextNode();

    while (node) {
      const nextOffset = currentOffset + node.textContent.length;

      if (offset <= nextOffset) {
        const range = document.createRange();
        range.setStart(node, Math.max(0, offset - currentOffset));
        range.collapse(true);

        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }

      currentOffset = nextOffset;
      node = walker.nextNode();
    }

    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function sendSelectionState() {
    const payload = collectSelectionState();

    if (!payload) {
      return;
    }

    safeSendRuntimeMessage({
      type: "RUSTYPE_EDITOR_STATE_UPDATED",
      payload
    });
  }

  function runSafely(callback) {
    try {
      if (!isRuntimeAvailable()) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        return;
      }

      const result = callback();

      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (!isExpectedExtensionInvalidation(error)) {
            console.debug("RusType content script ignored async callback error:", error);
          }
        });
      }
    } catch (error) {
      if (!isExpectedExtensionInvalidation(error)) {
        console.debug("RusType content script ignored callback error:", error);
      }
    }
  }

  function safeSendRuntimeMessage(message) {
    if (!isRuntimeAvailable()) {
      return;
    }

    try {
      chrome.runtime.sendMessage(message, () => {
        // Reading lastError prevents expected post-reload failures from surfacing.
        void chrome.runtime.lastError;
      });
    } catch (error) {
      if (!isExpectedExtensionInvalidation(error)) {
        throw error;
      }
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      if (!isRuntimeAvailable()) {
        resolve({ ok: false, error: "RUNTIME_UNAVAILABLE" });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message
            });
            return;
          }

          resolve(response ?? { ok: false, error: "EMPTY_RESPONSE" });
        });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  function isExpectedExtensionInvalidation(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.toLowerCase().includes("extension context invalidated");
  }

  function isRuntimeAvailable() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function isExcludedDevelopmentHost(hostname) {
    return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  }

  function collectEditorState() {
    const host = getCurrentHost();

    if (!isExtensionActiveForHost(host)) {
      return createEmptyState();
    }

    if (isGoogleDocsHost(host)) {
      return collectGoogleDocsState();
    }

    if (!activeEditor || !document.contains(activeEditor)) {
      activeEditor = findActiveEditable();
    }

    if (activeEditor && !isSensitiveEditor(activeEditor)) {
      const snapshot = getEditorSnapshot(activeEditor);

      if (snapshot) {
        return buildEditorPayload(activeEditor, snapshot);
      }
    }

    return collectSelectionState() ?? createEmptyState();
  }

  function collectSelectionState() {
    const host = getCurrentHost();

    if (!isExtensionActiveForHost(host)) {
      return null;
    }

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";

    if (!selectedText || !CYRILLIC_RE.test(selectedText)) {
      return null;
    }

    const currentWord = extractLastRussianWord(selectedText);
    const payload = {
      enabled: settings.enabled,
      host,
      editorType: "selection",
      isRussianLike: true,
      textLength: selectedText.length,
      selectionStart: 0,
      selectionEnd: selectedText.length,
      textPreview: createStoredTextPreview(selectedText),
      currentWord,
      activeSentence: {
        start: 0,
        length: selectedText.length,
        text: createStoredTextPreview(selectedText),
        isRussianLike: true
      },
      note: isGoogleDocsHost(host)
        ? "Google Docs selection fallback"
        : "Selection fallback"
    };

    return payload;
  }

  function collectGoogleDocsState() {
    const host = getCurrentHost();

    return {
      enabled: settings.enabled,
      host,
      editorType: "google-docs-dev",
      isRussianLike: false,
      textLength: 0,
      selectionStart: 0,
      selectionEnd: 0,
      textPreview: "",
      currentWord: null,
      activeSentence: null,
      note: "Google Docs đang được phát triển, hiện chưa hỗ trợ kiểm tra trực tiếp"
    };
  }

  function buildEditorPayload(editor, snapshot) {
    const currentWord = extractCurrentWord(snapshot.text, snapshot.selectionStart);
    const activeSentence = extractActiveSentence(snapshot.text, snapshot.selectionStart);
    const isRussianLike = CYRILLIC_RE.test(snapshot.text);

    return {
      enabled: settings.enabled,
      host: getCurrentHost(),
      editorType: getEditorType(editor),
      isRussianLike,
      textLength: snapshot.text.length,
      selectionStart: snapshot.selectionStart,
      selectionEnd: snapshot.selectionEnd,
      textPreview: createStoredTextPreview(snapshot.text),
      currentWord,
      activeSentence: {
        start: activeSentence.start,
        length: activeSentence.text.length,
        text: createStoredTextPreview(activeSentence.text),
        isRussianLike: CYRILLIC_RE.test(activeSentence.text)
      }
    };
  }

  function createEmptyState() {
    return {
      enabled: settings.enabled,
      host: getCurrentHost(),
      editorType: "none",
      isRussianLike: false,
      textLength: 0,
      selectionStart: 0,
      selectionEnd: 0,
      textPreview: "",
      currentWord: null,
      activeSentence: null
    };
  }

  function getCurrentHost() {
    if (location.hostname) {
      return location.hostname;
    }

    const ancestorOrigins = Array.from(location.ancestorOrigins ?? []);

    for (const origin of ancestorOrigins) {
      try {
        const url = new URL(origin);

        if (url.hostname) {
          return url.hostname;
        }
      } catch {
        // Ignore malformed browser-provided origins.
      }
    }

    return "";
  }

  function createTextPreview(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }

  function createStoredTextPreview(text) {
    return settings.showTextPreviewInPopup ? createTextPreview(text) : "";
  }

  async function loadSettings() {
    return new Promise((resolve) => {
      if (!isRuntimeAvailable()) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }

      try {
        chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
          if (chrome.runtime.lastError) {
            resolve({ ...DEFAULT_SETTINGS });
            return;
          }

          resolve({
            ...DEFAULT_SETTINGS,
            ...stored
          });
        });
      } catch {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  }

  function isExtensionActiveForHost(hostname) {
    const allowedHosts = normalizeHostList(settings.allowedHosts);
    const blockedHosts = normalizeHostList(settings.blockedHosts);

    if (!settings.enabled) {
      return false;
    }

    if (matchesHostList(hostname, blockedHosts)) {
      return false;
    }

    if (allowedHosts.length > 0 && !matchesHostList(hostname, allowedHosts)) {
      return false;
    }

    return true;
  }

  function matchesHostList(hostname, rules) {
    const host = normalizeHostname(hostname);
    return normalizeHostList(rules).some((rule) => host === rule || host.endsWith(`.${rule}`));
  }

  function normalizeHostList(rules) {
    const values = Array.isArray(rules) ? rules : [];
    return Array.from(new Set(values.map(normalizeHostname).filter(Boolean)));
  }

  function normalizeHostname(value) {
    const raw = String(value ?? "").trim().toLowerCase();

    if (!raw) {
      return "";
    }

    try {
      return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    } catch {
      return raw
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .split(":")[0]
        .trim();
    }
  }

  function isRusTypeUiTarget(target) {
    const element = target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;

    return Boolean(
      element?.closest("#rustype-autocomplete-bubble,#rustype-spellcheck-bubble,#rustype-selection-translate-bubble")
    );
  }

  function findEditableFromEvent(event) {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];

    for (const item of path) {
      const editor = findEditable(item);

      if (editor) {
        return editor;
      }
    }

    return findEditable(event?.target);
  }

  function findEditable(target) {
    const element = target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;

    if (!element) {
      return null;
    }

    let current = element;

    while (current && current !== document.documentElement) {
      if (isEditable(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function findActiveEditable() {
    const activeElementEditor = findEditable(document.activeElement);

    if (activeElementEditor) {
      return activeElementEditor;
    }

    const selection = window.getSelection();

    if (selection?.anchorNode) {
      return findEditable(selection.anchorNode);
    }

    return null;
  }

  function isEditable(element) {
    if (element instanceof HTMLTextAreaElement) {
      return !element.readOnly && !element.disabled;
    }

    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      return EDITABLE_INPUT_TYPES.has(type) && !element.readOnly && !element.disabled;
    }

    return element instanceof HTMLElement && isRichTextEditor(element);
  }

  function isRichTextEditor(element) {
    return Boolean(
      element instanceof HTMLElement &&
      (element.isContentEditable || element.getAttribute("contenteditable") === "plaintext-only")
    );
  }

  function isSensitiveEditor(element) {
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();

      if (type === "password" || type === "hidden") {
        return true;
      }

      const identity = `${element.name} ${element.id} ${element.autocomplete}`.toLowerCase();
      return /(password|passcode|token|secret|otp|2fa|mfa|credit-card|cc-number)/.test(identity);
    }

    return false;
  }

  function getEditorType(element) {
    if (element instanceof HTMLTextAreaElement) {
      return "textarea";
    }

    if (element instanceof HTMLInputElement) {
      return "input";
    }

    return "contenteditable";
  }

  function getEditorSnapshot(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return {
        text: element.value,
        selectionStart: element.selectionStart ?? element.value.length,
        selectionEnd: element.selectionEnd ?? element.value.length
      };
    }

    if (element instanceof HTMLElement && isRichTextEditor(element)) {
      const selection = window.getSelection();

      if (!selection || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) {
        return {
          text: getRichTextContent(element),
          selectionStart: getRichTextContent(element).length,
          selectionEnd: getRichTextContent(element).length
        };
      }

      const range = selection.getRangeAt(0);
      const selectionStart = getTextOffset(element, range.startContainer, range.startOffset);
      const selectionEnd = getTextOffset(element, range.endContainer, range.endOffset);

      return {
        text: getRichTextContent(element),
        selectionStart,
        selectionEnd
      };
    }

    return null;
  }

  function getTextOffset(root, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(root);

    try {
      range.setEnd(node, offset);
      return range.toString().length;
    } catch {
      return getRichTextContent(root).length;
    } finally {
      range.detach();
    }
  }

  function getRichTextContent(element) {
    return element.innerText ?? element.textContent ?? "";
  }

  function extractCurrentWord(text, cursorIndex) {
    let start = cursorIndex;
    let end = cursorIndex;

    while (start > 0 && CYRILLIC_WORD_RE.test(text[start - 1])) {
      start -= 1;
    }

    while (end < text.length && CYRILLIC_WORD_RE.test(text[end])) {
      end += 1;
    }

    const fullWord = text.slice(start, end);
    const prefix = text.slice(start, cursorIndex);

    return {
      start,
      end,
      prefix,
      fullWord,
      isRussianLike: CYRILLIC_RE.test(fullWord)
    };
  }

  function extractLastRussianWord(text) {
    const matches = text.match(/[\u0400-\u04ff-]+/g);
    const fullWord = matches?.at(-1) ?? "";
    const end = fullWord ? text.lastIndexOf(fullWord) + fullWord.length : 0;
    const start = fullWord ? end - fullWord.length : 0;

    return {
      start,
      end,
      prefix: fullWord,
      fullWord,
      isRussianLike: CYRILLIC_RE.test(fullWord)
    };
  }

  function extractActiveSentence(text, cursorIndex) {
    const leftBoundary = Math.max(
      text.lastIndexOf(".", cursorIndex - 1),
      text.lastIndexOf("!", cursorIndex - 1),
      text.lastIndexOf("?", cursorIndex - 1),
      text.lastIndexOf("\n", cursorIndex - 1)
    );

    const rightCandidates = [
      text.indexOf(".", cursorIndex),
      text.indexOf("!", cursorIndex),
      text.indexOf("?", cursorIndex),
      text.indexOf("\n", cursorIndex)
    ].filter((index) => index >= 0);

    const start = Math.max(0, leftBoundary + 1);
    const end = rightCandidates.length > 0 ? Math.min(...rightCandidates) + 1 : text.length;
    const rawText = text.slice(start, end);
    const leadingTrimLength = rawText.length - rawText.trimStart().length;

    return {
      start: start + leadingTrimLength,
      text: rawText.trim()
    };
  }

  function isGoogleDocsHost(hostname) {
    return hostname === "docs.google.com" || hostname.endsWith(".docs.google.com");
  }
})();
