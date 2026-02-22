'use strict';

let insertMode = false;
let visualLineMode = false;
let visualLineAnchor = null;
let visualLineCursor = null;
let pendingKey = null;
let register = null;
let editorDoc = null;

const setInsertMode = (value) => {
  insertMode = value;
  if (editorDoc) {
    editorDoc.body.classList.toggle('vim-insert-mode', value);
  }
};

const setVisualLineMode = (value) => {
  visualLineMode = value;
  if (editorDoc) {
    editorDoc.body.classList.toggle('vim-visual-line-mode', value);
  }
};

const isWordChar = (ch) => /\w/.test(ch);
const isWhitespace = (ch) => /\s/.test(ch);

const moveCursor = (editorInfo, newLine, newChar) => {
  const pos = [newLine, newChar];
  editorInfo.ace_inCallStackIfNecessary('vim-move', () => {
    editorInfo.ace_performSelectionChange(pos, pos, false);
    editorInfo.ace_updateBrowserSelectionFromRep();
  });
};

const selectVisualLines = (editorInfo, rep, anchorLine, cursorLine) => {
  const lineCount = rep.lines.length();
  const topLine = Math.min(anchorLine, cursorLine);
  const bottomLine = Math.max(anchorLine, cursorLine);
  const selStart = [topLine, 0];
  const selEnd = bottomLine + 1 < lineCount
    ? [bottomLine + 1, 0]
    : [bottomLine, rep.lines.atIndex(bottomLine).text.length];
  editorInfo.ace_inCallStackIfNecessary('vim-V-select', () => {
    editorInfo.ace_performSelectionChange(selStart, selEnd, false);
    editorInfo.ace_updateBrowserSelectionFromRep();
  });
};

const handleVisualLineKey = (rep, editorInfo, key) => {
  const lineCount = rep.lines.length();

  if (key === 'j') {
    visualLineCursor = Math.min(lineCount - 1, visualLineCursor + 1);
    selectVisualLines(editorInfo, rep, visualLineAnchor, visualLineCursor);
    return true;
  }

  if (key === 'k') {
    visualLineCursor = Math.max(0, visualLineCursor - 1);
    selectVisualLines(editorInfo, rep, visualLineAnchor, visualLineCursor);
    return true;
  }

  if (key === 'G') {
    pendingKey = null;
    visualLineCursor = lineCount - 1;
    selectVisualLines(editorInfo, rep, visualLineAnchor, visualLineCursor);
    return true;
  }

  if (key === 'g') {
    if (pendingKey === 'g') {
      pendingKey = null;
      visualLineCursor = 0;
      selectVisualLines(editorInfo, rep, visualLineAnchor, visualLineCursor);
    } else {
      pendingKey = 'g';
    }
    return true;
  }

  if (key === 'y') {
    const topLine = Math.min(visualLineAnchor, visualLineCursor);
    const bottomLine = Math.max(visualLineAnchor, visualLineCursor);
    const lines = [];
    for (let i = topLine; i <= bottomLine; i++) {
      lines.push(rep.lines.atIndex(i).text);
    }
    register = lines;
    setVisualLineMode(false);
    moveCursor(editorInfo, topLine, 0);
    return true;
  }

  if (key === 'd') {
    const topLine = Math.min(visualLineAnchor, visualLineCursor);
    const bottomLine = Math.max(visualLineAnchor, visualLineCursor);
    const totalLines = rep.lines.length();
    const lines = [];
    for (let i = topLine; i <= bottomLine; i++) {
      lines.push(rep.lines.atIndex(i).text);
    }
    register = lines;
    editorInfo.ace_inCallStackIfNecessary('vim-V-d', () => {
      if (bottomLine === totalLines - 1 && topLine > 0) {
        const prevLineText = rep.lines.atIndex(topLine - 1).text;
        editorInfo.ace_performDocumentReplaceRange(
          [topLine - 1, prevLineText.length], [bottomLine, rep.lines.atIndex(bottomLine).text.length], ''
        );
        editorInfo.ace_performSelectionChange([topLine - 1, 0], [topLine - 1, 0], false);
      } else if (bottomLine < totalLines - 1) {
        editorInfo.ace_performDocumentReplaceRange([topLine, 0], [bottomLine + 1, 0], '');
        editorInfo.ace_performSelectionChange([topLine, 0], [topLine, 0], false);
      } else {
        const lastLineText = rep.lines.atIndex(bottomLine).text;
        editorInfo.ace_performDocumentReplaceRange([0, 0], [bottomLine, lastLineText.length], '');
        editorInfo.ace_performSelectionChange([0, 0], [0, 0], false);
      }
      editorInfo.ace_updateBrowserSelectionFromRep();
    });
    setVisualLineMode(false);
    return true;
  }

  pendingKey = null;
  return false;
};

const handleNormalKey = (rep, editorInfo, key) => {
  const [line, char] = rep.selStart;
  const lineCount = rep.lines.length();
  const lineText = rep.lines.atIndex(line).text;

  if (pendingKey === 'r') {
    pendingKey = null;
    if (lineText.length > 0) {
      editorInfo.ace_inCallStackIfNecessary('vim-r', () => {
        editorInfo.ace_performDocumentReplaceRange([line, char], [line, char + 1], key);
        editorInfo.ace_performSelectionChange([line, char], [line, char], false);
        editorInfo.ace_updateBrowserSelectionFromRep();
      });
    }
    return true;
  }

  if (key === 'h') {
    moveCursor(editorInfo, line, Math.max(0, char - 1));
    return true;
  }

  if (key === 'l') {
    moveCursor(editorInfo, line, Math.min(lineText.length - 1, char + 1));
    return true;
  }

  if (key === 'k') {
    const newLine = Math.max(0, line - 1);
    const newLineText = rep.lines.atIndex(newLine).text;
    moveCursor(editorInfo, newLine, Math.min(char, Math.max(0, newLineText.length - 1)));
    return true;
  }

  if (key === 'j') {
    const newLine = Math.min(lineCount - 1, line + 1);
    const newLineText = rep.lines.atIndex(newLine).text;
    moveCursor(editorInfo, newLine, Math.min(char, Math.max(0, newLineText.length - 1)));
    return true;
  }

  if (key === '0') {
    moveCursor(editorInfo, line, 0);
    return true;
  }

  if (key === '$') {
    moveCursor(editorInfo, line, Math.max(0, lineText.length - 1));
    return true;
  }

  if (key === '^') {
    let firstNonBlank = 0;
    while (firstNonBlank < lineText.length && isWhitespace(lineText[firstNonBlank])) firstNonBlank++;
    moveCursor(editorInfo, line, firstNonBlank);
    return true;
  }

  if (key === 'x') {
    if (lineText.length > 0) {
      editorInfo.ace_inCallStackIfNecessary('vim-x', () => {
        editorInfo.ace_performDocumentReplaceRange([line, char], [line, char + 1], '');
        const newLineText = rep.lines.atIndex(line).text;
        editorInfo.ace_performSelectionChange([line, Math.min(char, Math.max(0, newLineText.length - 1))], [line, Math.min(char, Math.max(0, newLineText.length - 1))], false);
        editorInfo.ace_updateBrowserSelectionFromRep();
      });
    }
    return true;
  }

  if (key === 'w') {
    let pos = char;
    if (pos < lineText.length && isWordChar(lineText[pos])) {
      while (pos < lineText.length && isWordChar(lineText[pos])) pos++;
    } else if (pos < lineText.length && !isWhitespace(lineText[pos])) {
      while (pos < lineText.length && !isWordChar(lineText[pos]) && !isWhitespace(lineText[pos])) pos++;
    }
    while (pos < lineText.length && isWhitespace(lineText[pos])) pos++;
    moveCursor(editorInfo, line, Math.min(pos, lineText.length - 1));
    return true;
  }

  if (key === 'b') {
    let pos = char - 1;
    while (pos >= 0 && isWhitespace(lineText[pos])) pos--;
    if (pos >= 0 && isWordChar(lineText[pos])) {
      while (pos > 0 && isWordChar(lineText[pos - 1])) pos--;
    } else {
      while (pos > 0 && !isWordChar(lineText[pos - 1]) && !isWhitespace(lineText[pos - 1])) pos--;
    }
    moveCursor(editorInfo, line, Math.max(0, pos));
    return true;
  }

  if (key === 'o') {
    editorInfo.ace_inCallStackIfNecessary('vim-o', () => {
      editorInfo.ace_performDocumentReplaceRange([line, lineText.length], [line, lineText.length], '\n');
      editorInfo.ace_performSelectionChange([line + 1, 0], [line + 1, 0], false);
      editorInfo.ace_updateBrowserSelectionFromRep();
    });
    setInsertMode(true);
    return true;
  }

  if (key === 'O') {
    editorInfo.ace_inCallStackIfNecessary('vim-O', () => {
      editorInfo.ace_performDocumentReplaceRange([line, 0], [line, 0], '\n');
      editorInfo.ace_performSelectionChange([line, 0], [line, 0], false);
      editorInfo.ace_updateBrowserSelectionFromRep();
    });
    setInsertMode(true);
    return true;
  }

  if (key === 'u') {
    editorInfo.ace_doUndoRedo('undo');
    return true;
  }

  if (key === 'p') {
    if (register !== null) {
      const insertText = '\n' + register.join('\n');
      editorInfo.ace_inCallStackIfNecessary('vim-p', () => {
        editorInfo.ace_performDocumentReplaceRange([line, lineText.length], [line, lineText.length], insertText);
        editorInfo.ace_performSelectionChange([line + 1, 0], [line + 1, 0], false);
        editorInfo.ace_updateBrowserSelectionFromRep();
      });
    }
    return true;
  }

  if (key === 'P') {
    if (register !== null) {
      const insertText = register.join('\n') + '\n';
      editorInfo.ace_inCallStackIfNecessary('vim-P', () => {
        editorInfo.ace_performDocumentReplaceRange([line, 0], [line, 0], insertText);
        editorInfo.ace_performSelectionChange([line, 0], [line, 0], false);
        editorInfo.ace_updateBrowserSelectionFromRep();
      });
    }
    return true;
  }

  if (key === 'G') {
    const lastLine = lineCount - 1;
    moveCursor(editorInfo, lastLine, 0);
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

  if (key === 'd') {
    if (pendingKey === 'd') {
      pendingKey = null;
      editorInfo.ace_inCallStackIfNecessary('vim-dd', () => {
        const isLastLine = line === lineCount - 1;
        if (isLastLine && lineCount > 1) {
          const prevLineText = rep.lines.atIndex(line - 1).text;
          editorInfo.ace_performDocumentReplaceRange(
            [line - 1, prevLineText.length], [line, lineText.length], ''
          );
          moveCursor(editorInfo, line - 1, Math.min(char, Math.max(0, prevLineText.length - 1)));
        } else if (lineCount > 1) {
          editorInfo.ace_performDocumentReplaceRange([line, 0], [line + 1, 0], '');
          const newLineText = rep.lines.atIndex(line).text;
          moveCursor(editorInfo, line, Math.min(char, Math.max(0, newLineText.length - 1)));
        } else {
          editorInfo.ace_performDocumentReplaceRange([0, 0], [0, lineText.length], '');
          moveCursor(editorInfo, 0, 0);
        }
        editorInfo.ace_updateBrowserSelectionFromRep();
      });
    } else {
      pendingKey = 'd';
    }
    return true;
  }

  pendingKey = null;

  if (key === 'e') {
    let pos = char + 1;
    while (pos < lineText.length && isWhitespace(lineText[pos])) pos++;
    if (pos < lineText.length && isWordChar(lineText[pos])) {
      while (pos + 1 < lineText.length && isWordChar(lineText[pos + 1])) pos++;
    } else {
      while (pos + 1 < lineText.length && !isWordChar(lineText[pos + 1]) && !isWhitespace(lineText[pos + 1])) pos++;
    }
    moveCursor(editorInfo, line, Math.min(pos, lineText.length - 1));
    return true;
  }

  return false;
};

exports.aceEditorCSS = () => ['ep_vim/static/css/vim.css'];


exports.aceKeyEvent =(_hookName, {evt, rep, editorInfo}) => {
  if (evt.type !== 'keydown') return false;
  if (!editorDoc) {
    editorDoc = evt.target.ownerDocument;
    setInsertMode(insertMode);
  }

  if (visualLineMode && pendingKey !== null) {
    const handled = handleVisualLineKey(rep, editorInfo, evt.key);
    evt.preventDefault();
    return handled || true;
  }

  if (!insertMode && !visualLineMode && pendingKey !== null) {
    const handled = handleNormalKey(rep, editorInfo, evt.key);
    evt.preventDefault();
    return handled || true;
  }

  if (!insertMode && evt.key === 'i') {
    const [line, char] = rep.selStart;
    moveCursor(editorInfo, line, char);
    setVisualLineMode(false);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === 'a') {
    const [line, char] = rep.selStart;
    const lineText = rep.lines.atIndex(line).text;
    moveCursor(editorInfo, line, Math.min(char + 1, lineText.length));
    setVisualLineMode(false);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === 'A') {
    const [line] = rep.selStart;
    const lineText = rep.lines.atIndex(line).text;
    moveCursor(editorInfo, line, lineText.length);
    setVisualLineMode(false);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === 'I') {
    const [line] = rep.selStart;
    const lineText = rep.lines.atIndex(line).text;
    let firstNonBlank = 0;
    while (firstNonBlank < lineText.length && isWhitespace(lineText[firstNonBlank])) firstNonBlank++;
    moveCursor(editorInfo, line, firstNonBlank);
    setVisualLineMode(false);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (evt.key === 'Escape') {
    if (insertMode) setInsertMode(false);
    if (visualLineMode) {
      setVisualLineMode(false);
      const [line] = rep.selStart;
      moveCursor(editorInfo, line, 0);
    }
    evt.preventDefault();
    return true;
  }

  if (!insertMode && !visualLineMode && evt.key === 'V') {
    const [line] = rep.selStart;
    visualLineAnchor = line;
    visualLineCursor = line;
    setVisualLineMode(true);
    selectVisualLines(editorInfo, rep, visualLineAnchor, visualLineCursor);
    evt.preventDefault();
    return true;
  }

  if (visualLineMode) {
    const handled = handleVisualLineKey(rep, editorInfo, evt.key);
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
