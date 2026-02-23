'use strict';

// --- State variables ---

let vimEnabled = false;
let insertMode = false;
let visualMode = null;
let visualAnchor = null;
let visualCursor = null;
let pendingKey = null;
let pendingCount = null;
let countBuffer = '';
let register = null;
let marks = {};
let editorDoc = null;

// --- Utility helpers ---

const isWordChar = (ch) => /\w/.test(ch);
const isWhitespace = (ch) => /\s/.test(ch);

const clampLine = (line, rep) => Math.max(0, Math.min(line, rep.lines.length() - 1));

const clampChar = (char, lineText) => Math.max(0, Math.min(char, lineText.length - 1));

const getLineText = (rep, line) => rep.lines.atIndex(line).text;

const firstNonBlank = (lineText) => {
  let i = 0;
  while (i < lineText.length && isWhitespace(lineText[i])) i++;
  return i;
};

const findCharForward = (lineText, startChar, targetChar, count) => {
  let found = 0;
  for (let i = startChar + 1; i < lineText.length; i++) {
    if (lineText[i] === targetChar) {
      found++;
      if (found === count) return i;
    }
  }
  return -1;
};

const findCharBackward = (lineText, startChar, targetChar, count) => {
  let found = 0;
  for (let i = startChar - 1; i >= 0; i--) {
    if (lineText[i] === targetChar) {
      found++;
      if (found === count) return i;
    }
  }
  return -1;
};

const consumeCount = () => {
  if (pendingKey !== null) return;
  pendingCount = countBuffer === '' ? null : parseInt(countBuffer, 10);
  countBuffer = '';
};

const getCount = () => pendingCount || 1;

// --- Etherpad API wrappers ---

const moveCursor = (editorInfo, line, char) => {
  const pos = [line, char];
  editorInfo.ace_inCallStackIfNecessary('vim-move', () => {
    editorInfo.ace_performSelectionChange(pos, pos, false);
    editorInfo.ace_updateBrowserSelectionFromRep();
  });
};

const selectRange = (editorInfo, start, end) => {
  editorInfo.ace_inCallStackIfNecessary('vim-select', () => {
    editorInfo.ace_performSelectionChange(start, end, false);
    editorInfo.ace_updateBrowserSelectionFromRep();
  });
};

const replaceRange = (editorInfo, start, end, text) => {
  editorInfo.ace_inCallStackIfNecessary('vim-edit', () => {
    editorInfo.ace_performDocumentReplaceRange(start, end, text);
  });
};

const undo = (editorInfo) => {
  editorInfo.ace_doUndoRedo('undo');
};

// --- Mode management ---

const setInsertMode = (value) => {
  insertMode = value;
  if (editorDoc) {
    editorDoc.body.classList.toggle('vim-insert-mode', value);
  }
};

const setVisualMode = (value) => {
  visualMode = value;
  if (editorDoc) {
    editorDoc.body.classList.toggle('vim-visual-line-mode', value === 'line');
    editorDoc.body.classList.toggle('vim-visual-char-mode', value === 'char');
  }
};

// --- Visual mode helpers ---

const getVisualSelection = (rep) => {
  if (visualMode === 'line') {
    const topLine = Math.min(visualAnchor[0], visualCursor[0]);
    const bottomLine = Math.max(visualAnchor[0], visualCursor[0]);
    const lineCount = rep.lines.length();
    const start = [topLine, 0];
    const end = bottomLine + 1 < lineCount
      ? [bottomLine + 1, 0]
      : [bottomLine, getLineText(rep, bottomLine).length];
    return [start, end];
  }
  if (visualAnchor[0] < visualCursor[0] ||
      (visualAnchor[0] === visualCursor[0] && visualAnchor[1] <= visualCursor[1])) {
    return [visualAnchor, visualCursor];
  }
  return [visualCursor, visualAnchor];
};

const getTextInRange = (rep, start, end) => {
  if (start[0] === end[0]) {
    return getLineText(rep, start[0]).slice(start[1], end[1]);
  }
  const parts = [];
  parts.push(getLineText(rep, start[0]).slice(start[1]));
  for (let i = start[0] + 1; i < end[0]; i++) {
    parts.push(getLineText(rep, i));
  }
  parts.push(getLineText(rep, end[0]).slice(0, end[1]));
  return parts.join('\n');
};

const updateVisualSelection = (editorInfo, rep) => {
  const [start, end] = getVisualSelection(rep);
  selectRange(editorInfo, start, end);
};

// --- Word motion helpers ---

const wordForward = (lineText, startChar) => {
  let pos = startChar;
  if (pos < lineText.length && isWordChar(lineText[pos])) {
    while (pos < lineText.length && isWordChar(lineText[pos])) pos++;
  } else if (pos < lineText.length && !isWhitespace(lineText[pos])) {
    while (pos < lineText.length && !isWordChar(lineText[pos]) && !isWhitespace(lineText[pos])) pos++;
  }
  while (pos < lineText.length && isWhitespace(lineText[pos])) pos++;
  return pos;
};

const wordBackward = (lineText, startChar) => {
  let pos = startChar - 1;
  while (pos >= 0 && isWhitespace(lineText[pos])) pos--;
  if (pos >= 0 && isWordChar(lineText[pos])) {
    while (pos > 0 && isWordChar(lineText[pos - 1])) pos--;
  } else {
    while (pos > 0 && !isWordChar(lineText[pos - 1]) && !isWhitespace(lineText[pos - 1])) pos--;
  }
  return Math.max(0, pos);
};

const wordEnd = (lineText, startChar) => {
  let pos = startChar + 1;
  while (pos < lineText.length && isWhitespace(lineText[pos])) pos++;
  if (pos < lineText.length && isWordChar(lineText[pos])) {
    while (pos + 1 < lineText.length && isWordChar(lineText[pos + 1])) pos++;
  } else {
    while (pos + 1 < lineText.length && !isWordChar(lineText[pos + 1]) && !isWhitespace(lineText[pos + 1])) pos++;
  }
  return pos;
};

// --- Visual mode key handler ---

const handleVisualKey = (rep, editorInfo, key) => {
  const curLine = visualCursor[0];
  const curChar = visualCursor[1];
  const lineText = getLineText(rep, curLine);

  if (key >= '1' && key <= '9') {
    countBuffer += key;
    return true;
  }
  if (key === '0' && countBuffer !== '') {
    countBuffer += key;
    return true;
  }

  consumeCount();
  const count = getCount();

  if (pendingKey === 'f' || pendingKey === 'F' || pendingKey === 't' || pendingKey === 'T') {
    const direction = pendingKey;
    pendingKey = null;
    let pos = -1;
    if (direction === 'f') {
      pos = findCharForward(lineText, curChar, key, count);
    } else if (direction === 'F') {
      pos = findCharBackward(lineText, curChar, key, count);
    } else if (direction === 't') {
      pos = findCharForward(lineText, curChar, key, count);
      if (pos !== -1) pos = pos - 1;
    } else if (direction === 'T') {
      pos = findCharBackward(lineText, curChar, key, count);
      if (pos !== -1) pos = pos + 1;
    }
    if (pos !== -1) {
      visualCursor = [curLine, pos];
      updateVisualSelection(editorInfo, rep);
    }
    return true;
  }

  if (pendingKey === "'" || pendingKey === '`') {
    const jumpType = pendingKey;
    pendingKey = null;
    if (key >= 'a' && key <= 'z' && marks[key]) {
      const [markLine, markChar] = marks[key];
      if (jumpType === "'") {
        const targetLineText = getLineText(rep, markLine);
        visualCursor = [markLine, firstNonBlank(targetLineText)];
      } else {
        visualCursor = [markLine, markChar];
      }
      updateVisualSelection(editorInfo, rep);
    }
    return true;
  }

  if (key === 'h') {
    visualCursor = [curLine, Math.max(0, curChar - count)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'l') {
    visualCursor = [curLine, clampChar(curChar + count, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'j') {
    visualCursor = [clampLine(curLine + count, rep), curChar];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'k') {
    visualCursor = [clampLine(curLine - count, rep), curChar];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === '0') {
    visualCursor = [curLine, 0];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === '$') {
    visualCursor = [curLine, clampChar(lineText.length - 1, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === '^') {
    visualCursor = [curLine, firstNonBlank(lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'w') {
    let pos = curChar;
    for (let i = 0; i < count; i++) pos = wordForward(lineText, pos);
    visualCursor = [curLine, clampChar(pos, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'b') {
    let pos = curChar;
    for (let i = 0; i < count; i++) pos = wordBackward(lineText, pos);
    visualCursor = [curLine, pos];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'e') {
    let pos = curChar;
    for (let i = 0; i < count; i++) pos = wordEnd(lineText, pos);
    visualCursor = [curLine, clampChar(pos, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'G') {
    pendingKey = null;
    if (pendingCount !== null) {
      visualCursor = [clampLine(pendingCount - 1, rep), curChar];
    } else {
      visualCursor = [rep.lines.length() - 1, curChar];
    }
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === 'g') {
    if (pendingKey === 'g') {
      pendingKey = null;
      visualCursor = [0, curChar];
      updateVisualSelection(editorInfo, rep);
    } else {
      pendingKey = 'g';
    }
    return true;
  }

  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    pendingKey = key;
    return true;
  }

  if (key === "'" || key === '`') {
    pendingKey = key;
    return true;
  }

  if (key === 'y') {
    const [start] = getVisualSelection(rep);

    if (visualMode === 'char') {
      const [, end] = getVisualSelection(rep);
      register = getTextInRange(rep, start, end);
      setVisualMode(null);
      moveCursor(editorInfo, start[0], start[1]);
      return true;
    }

    const topLine = start[0];
    const bottomLine = Math.max(visualAnchor[0], visualCursor[0]);
    const lines = [];
    for (let i = topLine; i <= bottomLine; i++) {
      lines.push(getLineText(rep, i));
    }
    register = lines;
    setVisualMode(null);
    moveCursor(editorInfo, topLine, 0);
    return true;
  }

  if (key === 'd' || key === 'c') {
    const enterInsert = key === 'c';
    const [start, end] = getVisualSelection(rep);

    if (visualMode === 'char') {
      register = getTextInRange(rep, start, end);
      replaceRange(editorInfo, start, end, '');
      moveCursor(editorInfo, start[0], start[1]);
      setVisualMode(null);
      if (enterInsert) setInsertMode(true);
      return true;
    }

    const topLine = start[0];
    const bottomLine = Math.max(visualAnchor[0], visualCursor[0]);
    const totalLines = rep.lines.length();
    const lines = [];
    for (let i = topLine; i <= bottomLine; i++) {
      lines.push(getLineText(rep, i));
    }
    register = lines;

    if (enterInsert) {
      for (let i = topLine; i <= bottomLine; i++) {
        const text = getLineText(rep, i);
        replaceRange(editorInfo, [topLine, 0], [topLine, text.length], '');
      }
      moveCursor(editorInfo, topLine, 0);
      setVisualMode(null);
      setInsertMode(true);
      return true;
    }

    if (bottomLine === totalLines - 1 && topLine > 0) {
      const prevLineLen = getLineText(rep, topLine - 1).length;
      replaceRange(editorInfo, [topLine - 1, prevLineLen], [bottomLine, getLineText(rep, bottomLine).length], '');
      moveCursor(editorInfo, topLine - 1, 0);
    } else if (bottomLine < totalLines - 1) {
      replaceRange(editorInfo, [topLine, 0], [bottomLine + 1, 0], '');
      moveCursor(editorInfo, topLine, 0);
    } else {
      replaceRange(editorInfo, [0, 0], [bottomLine, getLineText(rep, bottomLine).length], '');
      moveCursor(editorInfo, 0, 0);
    }

    setVisualMode(null);
    return true;
  }

  pendingKey = null;
  return false;
};

// --- Normal mode key handler ---

const handleNormalKey = (rep, editorInfo, key) => {
  const [line, char] = rep.selStart;
  const lineCount = rep.lines.length();
  const lineText = getLineText(rep, line);

  if (key >= '1' && key <= '9') {
    countBuffer += key;
    return true;
  }
  if (key === '0' && countBuffer !== '') {
    countBuffer += key;
    return true;
  }

  consumeCount();
  const count = getCount();

  if (pendingKey === 'r') {
    pendingKey = null;
    if (lineText.length > 0) {
      replaceRange(editorInfo, [line, char], [line, char + 1], key);
      moveCursor(editorInfo, line, char);
    }
    return true;
  }

  if (pendingKey === 'f' || pendingKey === 'F' || pendingKey === 't' || pendingKey === 'T') {
    const direction = pendingKey;
    pendingKey = null;
    let pos = -1;
    if (direction === 'f') {
      pos = findCharForward(lineText, char, key, count);
    } else if (direction === 'F') {
      pos = findCharBackward(lineText, char, key, count);
    } else if (direction === 't') {
      pos = findCharForward(lineText, char, key, count);
      if (pos !== -1) pos = pos - 1;
    } else if (direction === 'T') {
      pos = findCharBackward(lineText, char, key, count);
      if (pos !== -1) pos = pos + 1;
    }
    if (pos !== -1) moveCursor(editorInfo, line, pos);
    return true;
  }

  if (pendingKey === 'df' || pendingKey === 'dF' || pendingKey === 'dt' || pendingKey === 'dT') {
    const motion = pendingKey[1];
    pendingKey = null;
    let pos = -1;
    if (motion === 'f' || motion === 't') {
      pos = findCharForward(lineText, char, key, count);
    } else {
      pos = findCharBackward(lineText, char, key, count);
    }
    if (pos !== -1) {
      let delStart = char;
      let delEnd = char;
      if (motion === 'f') {
        delStart = char;
        delEnd = pos + 1;
      } else if (motion === 't') {
        delStart = char;
        delEnd = pos;
      } else if (motion === 'F') {
        delStart = pos;
        delEnd = char + 1;
      } else if (motion === 'T') {
        delStart = pos + 1;
        delEnd = char + 1;
      }
      if (delEnd > delStart) {
        register = lineText.slice(delStart, delEnd);
        replaceRange(editorInfo, [line, delStart], [line, delEnd], '');
        const newLineText = getLineText(rep, line);
        moveCursor(editorInfo, line, clampChar(delStart, newLineText));
      }
    }
    return true;
  }

  if (pendingKey === 'd') {
    pendingKey = null;

    if (key === 'd') {
      const deleteCount = Math.min(count, lineCount - line);
      const lastDeleteLine = line + deleteCount - 1;
      if (lastDeleteLine === lineCount - 1 && line > 0) {
        const prevLineText = getLineText(rep, line - 1);
        replaceRange(editorInfo, [line - 1, prevLineText.length], [lastDeleteLine, getLineText(rep, lastDeleteLine).length], '');
        moveCursor(editorInfo, line - 1, clampChar(char, prevLineText));
      } else if (lineCount > deleteCount) {
        replaceRange(editorInfo, [line, 0], [lastDeleteLine + 1, 0], '');
        const newLineText = getLineText(rep, line);
        moveCursor(editorInfo, line, clampChar(char, newLineText));
      } else {
        replaceRange(editorInfo, [0, 0], [lastDeleteLine, getLineText(rep, lastDeleteLine).length], '');
        moveCursor(editorInfo, 0, 0);
      }
      return true;
    }

    if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
      pendingKey = 'd' + key;
      return true;
    }

    let delStart = -1;
    let delEnd = -1;

    if (key === 'w') {
      let pos = char;
      for (let i = 0; i < count; i++) pos = wordForward(lineText, pos);
      delStart = char;
      delEnd = Math.min(pos, lineText.length);
    } else if (key === 'e') {
      let pos = char;
      for (let i = 0; i < count; i++) pos = wordEnd(lineText, pos);
      delStart = char;
      delEnd = Math.min(pos + 1, lineText.length);
    } else if (key === 'b') {
      let pos = char;
      for (let i = 0; i < count; i++) pos = wordBackward(lineText, pos);
      delStart = pos;
      delEnd = char;
    } else if (key === '$') {
      delStart = char;
      delEnd = lineText.length;
    } else if (key === '0') {
      delStart = 0;
      delEnd = char;
    } else if (key === '^') {
      const fnb = firstNonBlank(lineText);
      delStart = Math.min(char, fnb);
      delEnd = Math.max(char, fnb);
    } else if (key === 'h') {
      delStart = Math.max(0, char - count);
      delEnd = char;
    } else if (key === 'l') {
      delStart = char;
      delEnd = Math.min(char + count, lineText.length);
    }

    if (delEnd > delStart && delStart !== -1) {
      register = lineText.slice(delStart, delEnd);
      replaceRange(editorInfo, [line, delStart], [line, delEnd], '');
      const newLineText = getLineText(rep, line);
      moveCursor(editorInfo, line, clampChar(delStart, newLineText));
    }
    return true;
  }

  if (pendingKey === 'cf' || pendingKey === 'cF' || pendingKey === 'ct' || pendingKey === 'cT') {
    const motion = pendingKey[1];
    pendingKey = null;
    let pos = -1;
    if (motion === 'f' || motion === 't') {
      pos = findCharForward(lineText, char, key, count);
    } else {
      pos = findCharBackward(lineText, char, key, count);
    }
    if (pos !== -1) {
      let delStart = char;
      let delEnd = char;
      if (motion === 'f') {
        delStart = char;
        delEnd = pos + 1;
      } else if (motion === 't') {
        delStart = char;
        delEnd = pos;
      } else if (motion === 'F') {
        delStart = pos;
        delEnd = char + 1;
      } else if (motion === 'T') {
        delStart = pos + 1;
        delEnd = char + 1;
      }
      if (delEnd > delStart) {
        register = lineText.slice(delStart, delEnd);
        replaceRange(editorInfo, [line, delStart], [line, delEnd], '');
        moveCursor(editorInfo, line, delStart);
        setInsertMode(true);
      }
    }
    return true;
  }

  if (pendingKey === 'c') {
    pendingKey = null;

    if (key === 'c') {
      register = lineText;
      replaceRange(editorInfo, [line, 0], [line, lineText.length], '');
      moveCursor(editorInfo, line, 0);
      setInsertMode(true);
      return true;
    }

    if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
      pendingKey = 'c' + key;
      return true;
    }

    let delStart = -1;
    let delEnd = -1;

    if (key === 'w') {
      let pos = char;
      for (let i = 0; i < count; i++) pos = wordForward(lineText, pos);
      delStart = char;
      delEnd = Math.min(pos, lineText.length);
    } else if (key === 'e') {
      let pos = char;
      for (let i = 0; i < count; i++) pos = wordEnd(lineText, pos);
      delStart = char;
      delEnd = Math.min(pos + 1, lineText.length);
    } else if (key === 'b') {
      let pos = char;
      for (let i = 0; i < count; i++) pos = wordBackward(lineText, pos);
      delStart = pos;
      delEnd = char;
    } else if (key === '$') {
      delStart = char;
      delEnd = lineText.length;
    } else if (key === '0') {
      delStart = 0;
      delEnd = char;
    } else if (key === '^') {
      const fnb = firstNonBlank(lineText);
      delStart = Math.min(char, fnb);
      delEnd = Math.max(char, fnb);
    } else if (key === 'h') {
      delStart = Math.max(0, char - count);
      delEnd = char;
    } else if (key === 'l') {
      delStart = char;
      delEnd = Math.min(char + count, lineText.length);
    }

    if (delEnd > delStart && delStart !== -1) {
      register = lineText.slice(delStart, delEnd);
      replaceRange(editorInfo, [line, delStart], [line, delEnd], '');
      moveCursor(editorInfo, line, delStart);
      setInsertMode(true);
    }
    return true;
  }

  if (pendingKey === 'm') {
    pendingKey = null;
    if (key >= 'a' && key <= 'z') {
      marks[key] = [line, char];
    }
    return true;
  }

  if (pendingKey === "'" || pendingKey === '`') {
    const jumpType = pendingKey;
    pendingKey = null;
    if (key >= 'a' && key <= 'z' && marks[key]) {
      const [markLine, markChar] = marks[key];
      if (jumpType === "'") {
        const targetLineText = getLineText(rep, markLine);
        moveCursor(editorInfo, markLine, firstNonBlank(targetLineText));
      } else {
        moveCursor(editorInfo, markLine, markChar);
      }
    }
    return true;
  }

  if (key === 'h') {
    moveCursor(editorInfo, line, Math.max(0, char - count));
    return true;
  }

  if (key === 'l') {
    moveCursor(editorInfo, line, clampChar(char + count, lineText));
    return true;
  }

  if (key === 'k') {
    const newLine = clampLine(line - count, rep);
    const newLineText = getLineText(rep, newLine);
    moveCursor(editorInfo, newLine, clampChar(char, newLineText));
    return true;
  }

  if (key === 'j') {
    const newLine = clampLine(line + count, rep);
    const newLineText = getLineText(rep, newLine);
    moveCursor(editorInfo, newLine, clampChar(char, newLineText));
    return true;
  }

  if (key === '0') {
    moveCursor(editorInfo, line, 0);
    return true;
  }

  if (key === '$') {
    moveCursor(editorInfo, line, clampChar(lineText.length - 1, lineText));
    return true;
  }

  if (key === '^') {
    moveCursor(editorInfo, line, firstNonBlank(lineText));
    return true;
  }

  if (key === 'x') {
    if (lineText.length > 0) {
      const deleteCount = Math.min(count, lineText.length - char);
      replaceRange(editorInfo, [line, char], [line, char + deleteCount], '');
      const newLineText = getLineText(rep, line);
      moveCursor(editorInfo, line, clampChar(char, newLineText));
    }
    return true;
  }

  if (key === 'w') {
    let pos = char;
    for (let i = 0; i < count; i++) pos = wordForward(lineText, pos);
    moveCursor(editorInfo, line, clampChar(pos, lineText));
    return true;
  }

  if (key === 'b') {
    let pos = char;
    for (let i = 0; i < count; i++) pos = wordBackward(lineText, pos);
    moveCursor(editorInfo, line, pos);
    return true;
  }

  if (key === 'o') {
    replaceRange(editorInfo, [line, lineText.length], [line, lineText.length], '\n');
    moveCursor(editorInfo, line + 1, 0);
    setInsertMode(true);
    return true;
  }

  if (key === 'O') {
    replaceRange(editorInfo, [line, 0], [line, 0], '\n');
    moveCursor(editorInfo, line, 0);
    setInsertMode(true);
    return true;
  }

  if (key === 'u') {
    undo(editorInfo);
    return true;
  }

  if (key === 'p') {
    if (register !== null) {
      if (typeof register === 'string') {
        replaceRange(editorInfo, [line, char + 1], [line, char + 1], register);
        moveCursor(editorInfo, line, char + 1);
      } else {
        const insertText = '\n' + register.join('\n');
        replaceRange(editorInfo, [line, lineText.length], [line, lineText.length], insertText);
        moveCursor(editorInfo, line + 1, 0);
      }
    }
    return true;
  }

  if (key === 'P') {
    if (register !== null) {
      if (typeof register === 'string') {
        replaceRange(editorInfo, [line, char], [line, char], register);
        moveCursor(editorInfo, line, char);
      } else {
        const insertText = register.join('\n') + '\n';
        replaceRange(editorInfo, [line, 0], [line, 0], insertText);
        moveCursor(editorInfo, line, 0);
      }
    }
    return true;
  }

  if (key === 'G') {
    if (pendingCount !== null) {
      moveCursor(editorInfo, clampLine(pendingCount - 1, rep), 0);
    } else {
      moveCursor(editorInfo, lineCount - 1, 0);
    }
    return true;
  }

  if (key === 'g') {
    if (pendingKey === 'g') {
      pendingKey = null;
      moveCursor(editorInfo, 0, 0);
    } else {
      pendingKey = 'g';
    }
    return true;
  }

  if (key === 'r') {
    if (lineText.length > 0) {
      pendingKey = 'r';
    }
    return true;
  }

  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    pendingKey = key;
    return true;
  }

  if (key === 'm') {
    pendingKey = 'm';
    return true;
  }

  if (key === "'" || key === '`') {
    pendingKey = key;
    return true;
  }

  if (key === 'd') {
    pendingKey = 'd';
    return true;
  }

  if (key === 'c') {
    pendingKey = 'c';
    return true;
  }

  if (key === 'C') {
    register = lineText.slice(char);
    replaceRange(editorInfo, [line, char], [line, lineText.length], '');
    moveCursor(editorInfo, line, char);
    setInsertMode(true);
    return true;
  }

  if (key === 's') {
    register = lineText.slice(char, char + 1);
    replaceRange(editorInfo, [line, char], [line, Math.min(char + count, lineText.length)], '');
    moveCursor(editorInfo, line, char);
    setInsertMode(true);
    return true;
  }

  if (key === 'S') {
    register = lineText;
    replaceRange(editorInfo, [line, 0], [line, lineText.length], '');
    moveCursor(editorInfo, line, 0);
    setInsertMode(true);
    return true;
  }

  pendingKey = null;

  if (key === 'e') {
    let pos = char;
    for (let i = 0; i < count; i++) pos = wordEnd(lineText, pos);
    moveCursor(editorInfo, line, clampChar(pos, lineText));
    return true;
  }

  return false;
};

// --- Exports ---

exports.aceEditorCSS = () => ['ep_vim/static/css/vim.css'];

exports.postToolbarInit = (_hookName, _args) => {
  const btn = document.getElementById('vim-toggle-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    vimEnabled = !vimEnabled;
    btn.classList.toggle('vim-enabled', vimEnabled);
  });
};

exports.aceKeyEvent = (_hookName, {evt, rep, editorInfo}) => {
  if (!vimEnabled) return false;
  if (evt.type !== 'keydown') return false;
  if (!editorDoc) {
    editorDoc = evt.target.ownerDocument;
    setInsertMode(insertMode);
  }

  if (visualMode !== null && pendingKey !== null) {
    const handled = handleVisualKey(rep, editorInfo, evt.key);
    evt.preventDefault();
    return handled || true;
  }

  if (!insertMode && visualMode === null && pendingKey !== null) {
    const handled = handleNormalKey(rep, editorInfo, evt.key);
    evt.preventDefault();
    return handled || true;
  }

  if (!insertMode && evt.key === 'i') {
    const [line, char] = rep.selStart;
    moveCursor(editorInfo, line, char);
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === 'a') {
    const [line, char] = rep.selStart;
    const lineText = getLineText(rep, line);
    moveCursor(editorInfo, line, Math.min(char + 1, lineText.length));
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === 'A') {
    const [line] = rep.selStart;
    const lineText = getLineText(rep, line);
    moveCursor(editorInfo, line, lineText.length);
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === 'I') {
    const [line] = rep.selStart;
    const lineText = getLineText(rep, line);
    moveCursor(editorInfo, line, firstNonBlank(lineText));
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (evt.key === 'Escape') {
    if (insertMode) setInsertMode(false);
    if (visualMode !== null) {
      setVisualMode(null);
      const [line] = rep.selStart;
      moveCursor(editorInfo, line, 0);
    }
    countBuffer = '';
    pendingKey = null;
    pendingCount = null;
    evt.preventDefault();
    return true;
  }

  if (!insertMode && visualMode === null && evt.key === 'V') {
    const [line] = rep.selStart;
    visualAnchor = [line, 0];
    visualCursor = [line, 0];
    setVisualMode('line');
    updateVisualSelection(editorInfo, rep);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && visualMode === null && evt.key === 'v') {
    const [line, char] = rep.selStart;
    visualAnchor = [line, char];
    visualCursor = [line, char];
    setVisualMode('char');
    updateVisualSelection(editorInfo, rep);
    evt.preventDefault();
    return true;
  }

  if (visualMode !== null) {
    const handled = handleVisualKey(rep, editorInfo, evt.key);
    evt.preventDefault();
    return handled || true;
  }

  if (insertMode) {
    return false;
  }

  const handled = handleNormalKey(rep, editorInfo, evt.key);
  evt.preventDefault();
  return handled || true;
};
