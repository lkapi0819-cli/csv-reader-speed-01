// Fast drop-in replacement for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
//
// Returns exactly {columns, rows, errors} that the reference reader returns for
// every input {text, header}, following the same broken-row policy:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled
//     ("" inside is one quote; each CRLF or lone CR inside is read as LF);
//     what follows the closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     padded (short_row) or cut (long_row) to the first record's width;
//   - each error is {code, line, row} in the order met, line the 1-based line
//     its record starts on, row its record's index in rows (null: the header).
//
// Speed: the reference builds every field character by character. This reader
// keeps one forward cursor per special character (comma, LF, CR, quote): each
// cursor holds the next index at which its character occurs, found with
// String.indexOf, and is refreshed only when the reading position passes it.
// The cursors only move forward, so every character class is scanned once in
// total, in native code, and the next special character of a field is the
// smallest cursor — no per-field search and no per-character work. Each
// untouched run of a field is copied with a single slice; runs interrupted by
// a stray CR, a doubled quote or a CR inside quotes are joined from their
// slices only when such a character actually occurs. A quoted field scans on
// local copies of the cursors and commits them only when it closes: if the
// quote never closes, the reading position rewinds to just after the opening
// quote and the shared cursors must still describe the text from there.

const COMMA = 0, LINE_BREAK = 1, END = 2;
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  let recordLine = 1;
  let recordRow = null;
  // Forward cursors: the next index >= the point each was refreshed at which
  // holds that character, or -1 when the rest of the text holds none. They
  // only move forward, so each character class is scanned once in total.
  let nComma = text.indexOf(',', pos);
  let nLF = text.indexOf('\n', pos);
  let nCR = text.indexOf('\r', pos);
  let nQuote = text.indexOf('"', pos);

  function readUnquotedParts(parts) {
    let segStart = pos;
    let added = 0;
    for (;;) {
      if (nComma !== -1 && nComma < pos) nComma = text.indexOf(',', pos);
      if (nLF !== -1 && nLF < pos) nLF = text.indexOf('\n', pos);
      if (nCR !== -1 && nCR < pos) nCR = text.indexOf('\r', pos);
      let i = len;
      if (nComma !== -1 && nComma < i) i = nComma;
      if (nLF !== -1 && nLF < i) i = nLF;
      if (nCR !== -1 && nCR < i) i = nCR;
      if (i === len) {
        added += len - segStart;
        pos = len;
        parts.push(text.slice(segStart, len));
        return [parts.join(''), END, added];
      }
      const c = text.charCodeAt(i);
      if (c === 13 && text.charCodeAt(i + 1) !== 10) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        parts.push(text.slice(segStart, i));
        added += i - segStart;
        pos = i + 1;
        segStart = pos;
        continue;
      }
      added += i - segStart;
      parts.push(text.slice(segStart, i));
      if (c === 44) { pos = i + 1; return [parts.join(''), COMMA, added]; }
      pos = i + (c === 13 ? 2 : 1);
      line += 1;
      return [parts.join(''), LINE_BREAK, added];
    }
  }

  for (;;) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = END;
    let quoted = false;
    do {
      let value;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let segStart = pos + 1;
        pos = segStart;
        let parts = null;
        let closed = false;
        // Local cursor copies: if the quote never closes, pos rewinds to
        // just after the opening quote and the shared cursors must still
        // describe the text from there, so the scan's own refreshed
        // cursors are only committed when the field actually closes.
        let qQuote = nQuote, qLF = nLF, qCR = nCR;
        quotedScan: for (;;) {
          if (qQuote !== -1 && qQuote < pos) qQuote = text.indexOf('"', pos);
          if (qLF !== -1 && qLF < pos) qLF = text.indexOf('\n', pos);
          if (qCR !== -1 && qCR < pos) qCR = text.indexOf('\r', pos);
          let i = len;
          if (qQuote !== -1 && qQuote < i) i = qQuote;
          if (qLF !== -1 && qLF < i) i = qLF;
          if (qCR !== -1 && qCR < i) i = qCR;
          if (i === len) break quotedScan;
          const c = text.charCodeAt(i);
          if (c === 34) {
            if (text.charCodeAt(i + 1) === 34) {
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, i), '"');
              pos = i + 2; segStart = pos;
              continue;
            }
            closed = true;
            nQuote = qQuote; nLF = qLF; nCR = qCR;
            if (parts === null) value = text.slice(segStart, i);
            else { parts.push(text.slice(segStart, i)); value = parts.join(''); }
            pos = i + 1;
            break quotedScan;
          }
          if (c === 13) {
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i), '\n');
            line += 1;
            pos = i + (text.charCodeAt(i + 1) === 10 ? 2 : 1);
            segStart = pos;
            continue;
          }
          line += 1;
          pos = i + 1;
        }
        if (!closed) {
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquotedParts(['"']);
          value = r[0]; ended = r[1];
        } else if (pos >= len) {
          ended = END;
        } else {
          const n = text.charCodeAt(pos);
          if (n === 44) { pos += 1; ended = COMMA; }
          else if (n === 10) { pos += 1; line += 1; ended = LINE_BREAK; }
          else if (n === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = LINE_BREAK; }
          else {
            const junk = readUnquotedParts([value]);
            if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            value = junk[0]; ended = junk[1];
          }
        }
      } else {
        quoted = false;
        let segStart = pos;
        let parts = null;
        unquotedScan: for (;;) {
          if (nComma !== -1 && nComma < pos) nComma = text.indexOf(',', pos);
          if (nLF !== -1 && nLF < pos) nLF = text.indexOf('\n', pos);
          if (nCR !== -1 && nCR < pos) nCR = text.indexOf('\r', pos);
          let i = len;
          if (nComma !== -1 && nComma < i) i = nComma;
          if (nLF !== -1 && nLF < i) i = nLF;
          if (nCR !== -1 && nCR < i) i = nCR;
          if (i === len) {
            pos = len;
            value = parts === null ? text.slice(segStart, len) : (parts.push(text.slice(segStart, len)), parts.join(''));
            ended = END;
            break unquotedScan;
          }
          const c = text.charCodeAt(i);
          if (c === 13 && text.charCodeAt(i + 1) !== 10) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i));
            pos = i + 1; segStart = pos;
            continue;
          }
          value = parts === null ? text.slice(segStart, i) : (parts.push(text.slice(segStart, i)), parts.join(''));
          if (c === 44) { pos = i + 1; ended = COMMA; }
          else { pos = i + (c === 13 ? 2 : 1); line += 1; ended = LINE_BREAK; }
          break unquotedScan;
        }
      }
      fields.push(value);
    } while (ended === COMMA);
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
