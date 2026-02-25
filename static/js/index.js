"use strict";

const {
  clampLine,
  clampChar,
  getLineText,
  firstNonBlank,
  wordForward,
  wordBackward,
  wordEnd,
  charSearchPos,
  motionRange,
  charMotionRange,
  innerWordRange,
  innerQuoteRange,
  innerBracketRange,
  getVisualSelection,
  paragraphForward,
  paragraphBackward,
  getTextInRange,
} = require("./vim-core");

// --- State variables ---

let vimEnabled = localStorage.getItem("ep_vimEnabled") === "true";
let insertMode = false;
let visualMode = null;
let visualAnchor = null;
let visualCursor = null;
let pendingKey = null;
let pendingCount = null;
let countBuffer = "";
let register = null;
let marks = {};
let editorDoc = null;
let currentRep = null;
let desiredColumn = null;
let lastCharSearch = null;

const QUOTE_CHARS = new Set(['"', "'"]);
const BRACKET_CHARS = new Set(["(", ")", "{", "}", "[", "]"]);

const innerTextObjectRange = (key, lineText, char) => {
  if (key === "w") return innerWordRange(lineText, char);
  if (QUOTE_CHARS.has(key)) return innerQuoteRange(lineText, char, key);
  if (BRACKET_CHARS.has(key)) return innerBracketRange(lineText, char, key);
  return null;
};

// --- Count helpers ---

const consumeCount = () => {
  if (countBuffer !== "") {
    pendingCount = parseInt(countBuffer, 10);
    countBuffer = "";
  } else if (pendingKey === null) {
    pendingCount = null;
  }
};

const getCount = () => pendingCount || 1;

// --- Side-effectful helpers ---

const setRegister = (value) => {
  register = value;
  const text = Array.isArray(value) ? value.join("\n") + "\n" : value;
  navigator.clipboard.writeText(text).catch(() => {});
};

const moveCursor = (editorInfo, line, char) => {
  const pos = [line, char];
  editorInfo.ace_inCallStackIfNecessary("vim-move", () => {
    editorInfo.ace_performSelectionChange(pos, pos, false);
    editorInfo.ace_updateBrowserSelectionFromRep();
  });
};

const clearEmptyLineCursor = () => {
  if (!editorDoc) return;
  const old = editorDoc.querySelector(".vim-empty-line-cursor");
  if (old) old.classList.remove("vim-empty-line-cursor");
};

const moveBlockCursor = (editorInfo, line, char) => {
  clearEmptyLineCursor();
  const lineText = currentRep ? getLineText(currentRep, line) : "";
  if (lineText.length === 0 && editorDoc) {
    const lineDiv = editorDoc.body.querySelectorAll("div")[line];
    if (lineDiv) lineDiv.classList.add("vim-empty-line-cursor");
    selectRange(editorInfo, [line, 0], [line, 0]);
  } else {
    selectRange(editorInfo, [line, char], [line, char + 1]);
  }
};

const selectRange = (editorInfo, start, end) => {
  editorInfo.ace_inCallStackIfNecessary("vim-select", () => {
    editorInfo.ace_performSelectionChange(start, end, false);
    editorInfo.ace_updateBrowserSelectionFromRep();
  });
};

const replaceRange = (editorInfo, start, end, text) => {
  editorInfo.ace_inCallStackIfNecessary("vim-edit", () => {
    editorInfo.ace_performDocumentReplaceRange(start, end, text);
  });
};

const undo = (editorInfo) => {
  editorInfo.ace_doUndoRedo("undo");
};

// --- Mode management ---

const setInsertMode = (value) => {
  insertMode = value;
  if (value) clearEmptyLineCursor();
  if (editorDoc) {
    editorDoc.body.classList.toggle("vim-insert-mode", value);
  }
};

const setVisualMode = (value) => {
  visualMode = value;
  if (editorDoc) {
    editorDoc.body.classList.toggle("vim-visual-line-mode", value === "line");
    editorDoc.body.classList.toggle("vim-visual-char-mode", value === "char");
  }
};

// --- Visual mode helpers ---

const updateVisualSelection = (editorInfo, rep) => {
  const [start, end] = getVisualSelection(
    visualMode,
    visualAnchor,
    visualCursor,
    rep,
  );
  selectRange(editorInfo, start, end);
};

// --- Visual mode key handler ---

const handleVisualKey = (rep, editorInfo, key) => {
  const curLine = visualCursor[0];
  const curChar = visualCursor[1];
  const lineText = getLineText(rep, curLine);

  if (key >= "1" && key <= "9") {
    countBuffer += key;
    return true;
  }
  if (key === "0" && countBuffer !== "") {
    countBuffer += key;
    return true;
  }

  consumeCount();
  const count = getCount();

  if (
    pendingKey === "f" ||
    pendingKey === "F" ||
    pendingKey === "t" ||
    pendingKey === "T"
  ) {
    const direction = pendingKey;
    pendingKey = null;
    lastCharSearch = { direction, target: key };
    const pos = charSearchPos(direction, lineText, curChar, key, count);
    if (pos !== -1) {
      desiredColumn = null;
      visualCursor = [curLine, pos];
      updateVisualSelection(editorInfo, rep);
    }
    return true;
  }

  if (pendingKey === "'" || pendingKey === "`") {
    const jumpType = pendingKey;
    pendingKey = null;
    if (key >= "a" && key <= "z" && marks[key]) {
      const [markLine, markChar] = marks[key];
      desiredColumn = null;
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

  if (key === "h") {
    desiredColumn = null;
    visualCursor = [curLine, Math.max(0, curChar - count)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "l") {
    desiredColumn = null;
    visualCursor = [curLine, clampChar(curChar + count, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "j") {
    if (desiredColumn === null) {
      desiredColumn = curChar;
    }
    const newLine = clampLine(curLine + count, rep);
    const newLineText = getLineText(rep, newLine);
    visualCursor = [newLine, clampChar(desiredColumn, newLineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "k") {
    if (desiredColumn === null) {
      desiredColumn = curChar;
    }
    const newLine = clampLine(curLine - count, rep);
    const newLineText = getLineText(rep, newLine);
    visualCursor = [newLine, clampChar(desiredColumn, newLineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "0") {
    desiredColumn = null;
    visualCursor = [curLine, 0];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "$") {
    desiredColumn = null;
    visualCursor = [curLine, clampChar(lineText.length - 1, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "^") {
    desiredColumn = null;
    visualCursor = [curLine, firstNonBlank(lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "w") {
    desiredColumn = null;
    let pos = curChar;
    for (let i = 0; i < count; i++) pos = wordForward(lineText, pos);
    visualCursor = [curLine, clampChar(pos, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "b") {
    desiredColumn = null;
    let pos = curChar;
    for (let i = 0; i < count; i++) pos = wordBackward(lineText, pos);
    visualCursor = [curLine, pos];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "e") {
    desiredColumn = null;
    let pos = curChar;
    for (let i = 0; i < count; i++) pos = wordEnd(lineText, pos);
    visualCursor = [curLine, clampChar(pos, lineText)];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === ";") {
    if (lastCharSearch) {
      const pos = charSearchPos(
        lastCharSearch.direction,
        lineText,
        curChar,
        lastCharSearch.target,
        count,
      );
      if (pos !== -1) {
        desiredColumn = null;
        visualCursor = [curLine, pos];
        updateVisualSelection(editorInfo, rep);
      }
    }
    return true;
  }

  if (key === ",") {
    if (lastCharSearch) {
      const opposite = { f: "F", F: "f", t: "T", T: "t" };
      const reverseDir = opposite[lastCharSearch.direction];
      const pos = charSearchPos(
        reverseDir,
        lineText,
        curChar,
        lastCharSearch.target,
        count,
      );
      if (pos !== -1) {
        desiredColumn = null;
        visualCursor = [curLine, pos];
        updateVisualSelection(editorInfo, rep);
      }
    }
    return true;
  }

  if (key === "}") {
    desiredColumn = null;
    const target = paragraphForward(rep, curLine, count);
    visualCursor = [target, 0];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "{") {
    desiredColumn = null;
    const target = paragraphBackward(rep, curLine, count);
    visualCursor = [target, 0];
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "G") {
    pendingKey = null;
    desiredColumn = null;
    if (pendingCount !== null) {
      visualCursor = [clampLine(pendingCount - 1, rep), curChar];
    } else {
      visualCursor = [rep.lines.length() - 1, curChar];
    }
    updateVisualSelection(editorInfo, rep);
    return true;
  }

  if (key === "g") {
    if (pendingKey === "g") {
      pendingKey = null;
      desiredColumn = null;
      visualCursor = [0, curChar];
      updateVisualSelection(editorInfo, rep);
    } else {
      pendingKey = "g";
    }
    return true;
  }

  if (key === "f" || key === "F" || key === "t" || key === "T") {
    pendingKey = key;
    return true;
  }

  if (key === "'" || key === "`") {
    pendingKey = key;
    return true;
  }

  if (key === "~") {
    const [start, end] = getVisualSelection(
      visualMode,
      visualAnchor,
      visualCursor,
      rep,
    );
    const text = getTextInRange(rep, start, end);
    let toggled = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      toggled += ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    }
    replaceRange(editorInfo, start, end, toggled);
    setVisualMode(null);
    moveBlockCursor(editorInfo, start[0], start[1]);
    return true;
  }

  if (key === "y") {
    const [start] = getVisualSelection(
      visualMode,
      visualAnchor,
      visualCursor,
      rep,
    );

    if (visualMode === "char") {
      const [, end] = getVisualSelection(
        visualMode,
        visualAnchor,
        visualCursor,
        rep,
      );
      setRegister(getTextInRange(rep, start, end));
      setVisualMode(null);
      moveBlockCursor(editorInfo, start[0], start[1]);
      return true;
    }

    const topLine = start[0];
    const bottomLine = Math.max(visualAnchor[0], visualCursor[0]);
    const lines = [];
    for (let i = topLine; i <= bottomLine; i++) {
      lines.push(getLineText(rep, i));
    }
    setRegister(lines);
    setVisualMode(null);
    moveBlockCursor(editorInfo, topLine, 0);
    return true;
  }

  if (key === "d" || key === "c") {
    const enterInsert = key === "c";
    const [start, end] = getVisualSelection(
      visualMode,
      visualAnchor,
      visualCursor,
      rep,
    );

    if (visualMode === "char") {
      setRegister(getTextInRange(rep, start, end));
      replaceRange(editorInfo, start, end, "");
      if (enterInsert) {
        moveCursor(editorInfo, start[0], start[1]);
        setVisualMode(null);
        setInsertMode(true);
      } else {
        setVisualMode(null);
        moveBlockCursor(editorInfo, start[0], start[1]);
      }
      return true;
    }

    const topLine = start[0];
    const bottomLine = Math.max(visualAnchor[0], visualCursor[0]);
    const totalLines = rep.lines.length();
    const lines = [];
    for (let i = topLine; i <= bottomLine; i++) {
      lines.push(getLineText(rep, i));
    }
    setRegister(lines);

    if (enterInsert) {
      for (let i = topLine; i <= bottomLine; i++) {
        const text = getLineText(rep, i);
        replaceRange(editorInfo, [topLine, 0], [topLine, text.length], "");
      }
      moveCursor(editorInfo, topLine, 0);
      setVisualMode(null);
      setInsertMode(true);
      return true;
    }

    if (bottomLine === totalLines - 1 && topLine > 0) {
      const prevLineLen = getLineText(rep, topLine - 1).length;
      replaceRange(
        editorInfo,
        [topLine - 1, prevLineLen],
        [bottomLine, getLineText(rep, bottomLine).length],
        "",
      );
      moveBlockCursor(editorInfo, topLine - 1, 0);
    } else if (bottomLine < totalLines - 1) {
      replaceRange(editorInfo, [topLine, 0], [bottomLine + 1, 0], "");
      moveBlockCursor(editorInfo, topLine, 0);
    } else {
      replaceRange(
        editorInfo,
        [0, 0],
        [bottomLine, getLineText(rep, bottomLine).length],
        "",
      );
      moveBlockCursor(editorInfo, 0, 0);
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

  if (key >= "1" && key <= "9") {
    countBuffer += key;
    return true;
  }
  if (key === "0" && countBuffer !== "") {
    countBuffer += key;
    return true;
  }

  consumeCount();
  const count = getCount();

  if (pendingKey === "r") {
    pendingKey = null;
    if (lineText.length > 0) {
      replaceRange(editorInfo, [line, char], [line, char + 1], key);
      moveBlockCursor(editorInfo, line, char);
    }
    return true;
  }

  if (
    pendingKey === "f" ||
    pendingKey === "F" ||
    pendingKey === "t" ||
    pendingKey === "T"
  ) {
    const direction = pendingKey;
    pendingKey = null;
    lastCharSearch = { direction, target: key };
    const pos = charSearchPos(direction, lineText, char, key, count);
    if (pos !== -1) {
      desiredColumn = null;
      moveBlockCursor(editorInfo, line, pos);
    }
    return true;
  }

  if (
    pendingKey === "df" ||
    pendingKey === "dF" ||
    pendingKey === "dt" ||
    pendingKey === "dT"
  ) {
    const motion = pendingKey[1];
    pendingKey = null;
    const searchDir = motion === "f" || motion === "t" ? motion : motion;
    const pos = charSearchPos(searchDir, lineText, char, key, count);
    if (pos !== -1) {
      const range = charMotionRange(motion, char, pos);
      if (range) {
        setRegister(lineText.slice(range.start, range.end));
        replaceRange(editorInfo, [line, range.start], [line, range.end], "");
        const newLineText = getLineText(rep, line);
        moveBlockCursor(editorInfo, line, clampChar(range.start, newLineText));
      }
    }
    return true;
  }

  if (pendingKey === "di") {
    pendingKey = null;
    const range = innerTextObjectRange(key, lineText, char);
    if (range) {
      setRegister(lineText.slice(range.start, range.end));
      replaceRange(editorInfo, [line, range.start], [line, range.end], "");
      const newLineText = getLineText(rep, line);
      moveBlockCursor(editorInfo, line, clampChar(range.start, newLineText));
    }
    return true;
  }

  if (pendingKey === "d") {
    pendingKey = null;

    if (key === "d") {
      const deleteCount = Math.min(count, lineCount - line);
      const lastDeleteLine = line + deleteCount - 1;
      const deletedLines = [];
      for (let i = line; i <= lastDeleteLine; i++) {
        deletedLines.push(getLineText(rep, i));
      }
      setRegister(deletedLines);
      if (lastDeleteLine === lineCount - 1 && line > 0) {
        const prevLineText = getLineText(rep, line - 1);
        replaceRange(
          editorInfo,
          [line - 1, prevLineText.length],
          [lastDeleteLine, getLineText(rep, lastDeleteLine).length],
          "",
        );
        moveBlockCursor(editorInfo, line - 1, clampChar(char, prevLineText));
      } else if (lineCount > deleteCount) {
        replaceRange(editorInfo, [line, 0], [lastDeleteLine + 1, 0], "");
        const newLineText = getLineText(rep, line);
        moveBlockCursor(editorInfo, line, clampChar(char, newLineText));
      } else {
        replaceRange(
          editorInfo,
          [0, 0],
          [lastDeleteLine, getLineText(rep, lastDeleteLine).length],
          "",
        );
        moveBlockCursor(editorInfo, 0, 0);
      }
      return true;
    }

    if (key === "i") {
      pendingKey = "di";
      return true;
    }

    if (key === "f" || key === "F" || key === "t" || key === "T") {
      pendingKey = "d" + key;
      return true;
    }

    const range = motionRange(key, char, lineText, count);
    if (range && range.end > range.start) {
      setRegister(lineText.slice(range.start, range.end));
      replaceRange(editorInfo, [line, range.start], [line, range.end], "");
      const newLineText = getLineText(rep, line);
      moveBlockCursor(editorInfo, line, clampChar(range.start, newLineText));
    }
    return true;
  }

  if (
    pendingKey === "yf" ||
    pendingKey === "yF" ||
    pendingKey === "yt" ||
    pendingKey === "yT"
  ) {
    const motion = pendingKey[1];
    pendingKey = null;
    const pos = charSearchPos(motion, lineText, char, key, count);
    if (pos !== -1) {
      const range = charMotionRange(motion, char, pos);
      if (range) {
        setRegister(lineText.slice(range.start, range.end));
      }
    }
    return true;
  }

  if (
    pendingKey === "cf" ||
    pendingKey === "cF" ||
    pendingKey === "ct" ||
    pendingKey === "cT"
  ) {
    const motion = pendingKey[1];
    pendingKey = null;
    const pos = charSearchPos(motion, lineText, char, key, count);
    if (pos !== -1) {
      const range = charMotionRange(motion, char, pos);
      if (range) {
        setRegister(lineText.slice(range.start, range.end));
        replaceRange(editorInfo, [line, range.start], [line, range.end], "");
        moveCursor(editorInfo, line, range.start);
        setInsertMode(true);
      }
    }
    return true;
  }

  if (pendingKey === "ci") {
    pendingKey = null;
    const range = innerTextObjectRange(key, lineText, char);
    if (range) {
      setRegister(lineText.slice(range.start, range.end));
      replaceRange(editorInfo, [line, range.start], [line, range.end], "");
      moveCursor(editorInfo, line, range.start);
      setInsertMode(true);
    }
    return true;
  }

  if (pendingKey === "c") {
    pendingKey = null;

    if (key === "c") {
      setRegister(lineText);
      replaceRange(editorInfo, [line, 0], [line, lineText.length], "");
      moveCursor(editorInfo, line, 0);
      setInsertMode(true);
      return true;
    }

    if (key === "i") {
      pendingKey = "ci";
      return true;
    }

    if (key === "f" || key === "F" || key === "t" || key === "T") {
      pendingKey = "c" + key;
      return true;
    }

    const range = motionRange(key, char, lineText, count);
    if (range && range.end > range.start) {
      setRegister(lineText.slice(range.start, range.end));
      replaceRange(editorInfo, [line, range.start], [line, range.end], "");
      moveCursor(editorInfo, line, range.start);
      setInsertMode(true);
    }
    return true;
  }

  if (pendingKey === "yi") {
    pendingKey = null;
    const range = innerTextObjectRange(key, lineText, char);
    if (range) {
      setRegister(lineText.slice(range.start, range.end));
    }
    return true;
  }

  if (pendingKey === "y") {
    pendingKey = null;

    if (key === "y") {
      const yankCount = Math.min(count, lineCount - line);
      const lastYankLine = line + yankCount - 1;
      const yankedLines = [];
      for (let i = line; i <= lastYankLine; i++) {
        yankedLines.push(getLineText(rep, i));
      }
      setRegister(yankedLines);
      return true;
    }

    if (key === "i") {
      pendingKey = "yi";
      return true;
    }

    if (key === "f" || key === "F" || key === "t" || key === "T") {
      pendingKey = "y" + key;
      return true;
    }

    const range = motionRange(key, char, lineText, count);
    if (range && range.end > range.start) {
      setRegister(lineText.slice(range.start, range.end));
    }
    return true;
  }

  if (pendingKey === "m") {
    pendingKey = null;
    if (key >= "a" && key <= "z") {
      marks[key] = [line, char];
    }
    return true;
  }

  if (pendingKey === "'" || pendingKey === "`") {
    const jumpType = pendingKey;
    pendingKey = null;
    if (key >= "a" && key <= "z" && marks[key]) {
      const [markLine, markChar] = marks[key];
      desiredColumn = null;
      if (jumpType === "'") {
        const targetLineText = getLineText(rep, markLine);
        moveBlockCursor(editorInfo, markLine, firstNonBlank(targetLineText));
      } else {
        moveBlockCursor(editorInfo, markLine, markChar);
      }
    }
    return true;
  }

  if (key === "h") {
    desiredColumn = null;
    moveBlockCursor(editorInfo, line, Math.max(0, char - count));
    return true;
  }

  if (key === "l") {
    desiredColumn = null;
    moveBlockCursor(editorInfo, line, clampChar(char + count, lineText));
    return true;
  }

  if (key === "k") {
    if (desiredColumn === null) {
      desiredColumn = char;
    }
    const newLine = clampLine(line - count, rep);
    const newLineText = getLineText(rep, newLine);
    moveBlockCursor(editorInfo, newLine, clampChar(desiredColumn, newLineText));
    return true;
  }

  if (key === "j") {
    if (desiredColumn === null) {
      desiredColumn = char;
    }
    const newLine = clampLine(line + count, rep);
    const newLineText = getLineText(rep, newLine);
    moveBlockCursor(editorInfo, newLine, clampChar(desiredColumn, newLineText));
    return true;
  }

  if (key === "0") {
    desiredColumn = null;
    moveBlockCursor(editorInfo, line, 0);
    return true;
  }

  if (key === "$") {
    desiredColumn = null;
    moveBlockCursor(editorInfo, line, clampChar(lineText.length - 1, lineText));
    return true;
  }

  if (key === "^") {
    desiredColumn = null;
    moveBlockCursor(editorInfo, line, firstNonBlank(lineText));
    return true;
  }

  if (key === "x") {
    if (lineText.length > 0) {
      const deleteCount = Math.min(count, lineText.length - char);
      replaceRange(editorInfo, [line, char], [line, char + deleteCount], "");
      const newLineText = getLineText(rep, line);
      moveBlockCursor(editorInfo, line, clampChar(char, newLineText));
    }
    return true;
  }

  if (key === "w") {
    desiredColumn = null;
    let pos = char;
    for (let i = 0; i < count; i++) pos = wordForward(lineText, pos);
    moveBlockCursor(editorInfo, line, clampChar(pos, lineText));
    return true;
  }

  if (key === "b") {
    desiredColumn = null;
    let pos = char;
    for (let i = 0; i < count; i++) pos = wordBackward(lineText, pos);
    moveBlockCursor(editorInfo, line, pos);
    return true;
  }

  if (key === "o") {
    replaceRange(
      editorInfo,
      [line, lineText.length],
      [line, lineText.length],
      "\n",
    );
    moveCursor(editorInfo, line + 1, 0);
    setInsertMode(true);
    return true;
  }

  if (key === "O") {
    replaceRange(editorInfo, [line, 0], [line, 0], "\n");
    moveCursor(editorInfo, line, 0);
    setInsertMode(true);
    return true;
  }

  if (key === "u") {
    undo(editorInfo);
    return true;
  }

  if (key === "p") {
    if (register !== null) {
      if (typeof register === "string") {
        const insertPos = Math.min(char + 1, lineText.length);
        const repeated = register.repeat(count);
        replaceRange(
          editorInfo,
          [line, insertPos],
          [line, insertPos],
          repeated,
        );
        moveBlockCursor(editorInfo, line, insertPos);
      } else {
        const block = register.join("\n");
        const parts = [];
        for (let i = 0; i < count; i++) parts.push(block);
        const insertText = "\n" + parts.join("\n");
        replaceRange(
          editorInfo,
          [line, lineText.length],
          [line, lineText.length],
          insertText,
        );
        moveBlockCursor(editorInfo, line + 1, 0);
      }
    }
    return true;
  }

  if (key === "P") {
    if (register !== null) {
      if (typeof register === "string") {
        const repeated = register.repeat(count);
        replaceRange(editorInfo, [line, char], [line, char], repeated);
        moveBlockCursor(editorInfo, line, char);
      } else {
        const block = register.join("\n");
        const parts = [];
        for (let i = 0; i < count; i++) parts.push(block);
        const insertText = parts.join("\n") + "\n";
        replaceRange(editorInfo, [line, 0], [line, 0], insertText);
        moveBlockCursor(editorInfo, line, 0);
      }
    }
    return true;
  }

  if (key === "G") {
    desiredColumn = null;
    if (pendingCount !== null) {
      moveBlockCursor(editorInfo, clampLine(pendingCount - 1, rep), 0);
    } else {
      moveBlockCursor(editorInfo, lineCount - 1, 0);
    }
    return true;
  }

  if (key === "g") {
    if (pendingKey === "g") {
      pendingKey = null;
      desiredColumn = null;
      moveBlockCursor(editorInfo, 0, 0);
    } else {
      pendingKey = "g";
    }
    return true;
  }

  if (key === "r") {
    if (lineText.length > 0) {
      pendingKey = "r";
    }
    return true;
  }

  if (key === "f" || key === "F" || key === "t" || key === "T") {
    pendingKey = key;
    return true;
  }

  if (key === "m") {
    pendingKey = "m";
    return true;
  }

  if (key === "'" || key === "`") {
    pendingKey = key;
    return true;
  }

  if (key === "d") {
    pendingKey = "d";
    return true;
  }

  if (key === "c") {
    pendingKey = "c";
    return true;
  }

  if (key === "y") {
    pendingKey = "y";
    return true;
  }

  if (key === "Y") {
    setRegister([lineText]);
    return true;
  }

  if (key === "J") {
    const joins = Math.min(count, lineCount - 1 - line);
    let cursorChar = lineText.length;
    for (let i = 0; i < joins; i++) {
      const curLineText = getLineText(rep, line);
      const nextLineText = getLineText(rep, line + 1);
      const trimmedNext = nextLineText.replace(/^\s+/, "");
      const separator = curLineText.length === 0 ? "" : " ";
      if (i === 0) cursorChar = curLineText.length;
      replaceRange(
        editorInfo,
        [line, curLineText.length],
        [line + 1, nextLineText.length],
        separator + trimmedNext,
      );
    }
    moveBlockCursor(editorInfo, line, cursorChar);
    return true;
  }

  if (key === "~") {
    if (lineText.length > 0) {
      const toggleCount = Math.min(count, lineText.length - char);
      const slice = lineText.slice(char, char + toggleCount);
      let toggled = "";
      for (let i = 0; i < slice.length; i++) {
        const ch = slice[i];
        toggled +=
          ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      }
      replaceRange(
        editorInfo,
        [line, char],
        [line, char + toggleCount],
        toggled,
      );
      const newChar = Math.min(char + toggleCount, lineText.length - 1);
      moveBlockCursor(editorInfo, line, newChar);
    }
    return true;
  }

  if (key === "D") {
    setRegister(lineText.slice(char));
    replaceRange(editorInfo, [line, char], [line, lineText.length], "");
    const newLineText = getLineText(rep, line);
    moveBlockCursor(editorInfo, line, clampChar(char, newLineText));
    return true;
  }

  if (key === "C") {
    setRegister(lineText.slice(char));
    replaceRange(editorInfo, [line, char], [line, lineText.length], "");
    moveCursor(editorInfo, line, char);
    setInsertMode(true);
    return true;
  }

  if (key === "s") {
    setRegister(lineText.slice(char, char + 1));
    replaceRange(
      editorInfo,
      [line, char],
      [line, Math.min(char + count, lineText.length)],
      "",
    );
    moveCursor(editorInfo, line, char);
    setInsertMode(true);
    return true;
  }

  if (key === "S") {
    setRegister(lineText);
    replaceRange(editorInfo, [line, 0], [line, lineText.length], "");
    moveCursor(editorInfo, line, 0);
    setInsertMode(true);
    return true;
  }

  if (key === ";") {
    if (lastCharSearch) {
      const pos = charSearchPos(
        lastCharSearch.direction,
        lineText,
        char,
        lastCharSearch.target,
        count,
      );
      if (pos !== -1) {
        desiredColumn = null;
        moveBlockCursor(editorInfo, line, pos);
      }
    }
    return true;
  }

  if (key === ",") {
    if (lastCharSearch) {
      const opposite = { f: "F", F: "f", t: "T", T: "t" };
      const reverseDir = opposite[lastCharSearch.direction];
      const pos = charSearchPos(
        reverseDir,
        lineText,
        char,
        lastCharSearch.target,
        count,
      );
      if (pos !== -1) {
        desiredColumn = null;
        moveBlockCursor(editorInfo, line, pos);
      }
    }
    return true;
  }

  if (key === "}") {
    desiredColumn = null;
    const target = paragraphForward(rep, line, count);
    moveBlockCursor(editorInfo, target, 0);
    return true;
  }

  if (key === "{") {
    desiredColumn = null;
    const target = paragraphBackward(rep, line, count);
    moveBlockCursor(editorInfo, target, 0);
    return true;
  }

  pendingKey = null;

  if (key === "e") {
    let pos = char;
    for (let i = 0; i < count; i++) pos = wordEnd(lineText, pos);
    moveBlockCursor(editorInfo, line, clampChar(pos, lineText));
    return true;
  }

  return false;
};

// --- Exports ---

exports.aceEditorCSS = () => ["ep_vim/static/css/vim.css"];

exports.postToolbarInit = (_hookName, _args) => {
  const btn = document.getElementById("vim-toggle-btn");
  if (!btn) return;
  btn.classList.toggle("vim-enabled", vimEnabled);
  btn.addEventListener("click", () => {
    vimEnabled = !vimEnabled;
    localStorage.setItem("ep_vimEnabled", vimEnabled ? "true" : "false");
    btn.classList.toggle("vim-enabled", vimEnabled);
  });
};

exports.postAceInit = (_hookName, { ace }) => {
  if (!vimEnabled) return;
  ace.callWithAce((aceTop) => {
    const rep = aceTop.ace_getRep();
    if (rep && rep.selStart) {
      currentRep = rep;
      selectRange(aceTop, rep.selStart, [rep.selStart[0], rep.selStart[1] + 1]);
    }
  });
};

exports.aceKeyEvent = (_hookName, { evt, rep, editorInfo }) => {
  if (!vimEnabled) return false;
  if (evt.type !== "keydown") return false;
  currentRep = rep;
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

  if (!insertMode && evt.key === "i") {
    const [line, char] = rep.selStart;
    desiredColumn = null;
    moveCursor(editorInfo, line, char);
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === "a") {
    const [line, char] = rep.selStart;
    const lineText = getLineText(rep, line);
    desiredColumn = null;
    moveCursor(editorInfo, line, Math.min(char + 1, lineText.length));
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === "A") {
    const [line] = rep.selStart;
    const lineText = getLineText(rep, line);
    desiredColumn = null;
    moveCursor(editorInfo, line, lineText.length);
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && evt.key === "I") {
    const [line] = rep.selStart;
    const lineText = getLineText(rep, line);
    desiredColumn = null;
    moveCursor(editorInfo, line, firstNonBlank(lineText));
    setVisualMode(null);
    setInsertMode(true);
    evt.preventDefault();
    return true;
  }

  if (evt.key === "Escape") {
    if (insertMode) {
      setInsertMode(false);
      const [line, char] = rep.selStart;
      moveBlockCursor(editorInfo, line, Math.max(0, char - 1));
    }
    if (visualMode !== null) {
      const [vLine, vChar] = visualCursor;
      setVisualMode(null);
      moveBlockCursor(editorInfo, vLine, vChar);
    }
    countBuffer = "";
    pendingKey = null;
    pendingCount = null;
    desiredColumn = null;
    evt.preventDefault();
    return true;
  }

  if (!insertMode && visualMode === null && evt.key === "V") {
    const [line] = rep.selStart;
    visualAnchor = [line, 0];
    visualCursor = [line, 0];
    setVisualMode("line");
    updateVisualSelection(editorInfo, rep);
    evt.preventDefault();
    return true;
  }

  if (!insertMode && visualMode === null && evt.key === "v") {
    const [line, char] = rep.selStart;
    visualAnchor = [line, char];
    visualCursor = [line, char];
    setVisualMode("char");
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
