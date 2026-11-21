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
// instead finds the next special character with one native scan (a global
// RegExp exec over a small character class, which V8 runs in native code) and
// copies each untouched run of a field with a single slice. Runs that contain
// a stray CR, a doubled quote or a CR inside quotes are joined from their
// slices only when such a character actually occurs, so the common clean
// field costs one scan and one slice and no per-character work at all. The
// field parsers are inlined into the record loop, so a field costs no call
// and no temporary result object either; only the rare junk tail after a
// closing quote goes through the shared parts-joining reader.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Next comma, LF or CR at or after lastIndex.
const RE_FIELD = /[,\n\r]/g;
// Next quote, LF or CR at or after lastIndex.
const RE_QUOTED = /["\n\r]/g;

/** csv-reader 1.0.0's answer for one case's input, computed faster. */
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

  // The record being read: the line it starts on and its index in rows.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field whose already-kept prefix is in `parts`, starting
  // at pos. Returns [value, ended, added] where added counts the characters
  // kept from the text itself (the prefix does not count), as the reference
  // counts them. Used for the two rare prefixed reads: the text after an
  // unterminated quote (prefix: the literal quote) and the junk after a
  // closing quote (prefix: the quoted value).
  function readUnquotedParts(parts) {
    let segStart = pos;
    let added = 0;
    for (;;) {
      RE_FIELD.lastIndex = pos;
      const m = RE_FIELD.exec(text);
      if (m === null) {
        added += len - segStart;
        pos = len;
        parts.push(text.slice(segStart, len));
        return [parts.join(''), END, added];
      }
      const i = m.index;
      const c = m[0];
      if (c === '\r' && text.charCodeAt(i + 1) !== 10) {
        // A lone CR outside quotes is dropped (stray_cr); the field goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        parts.push(text.slice(segStart, i));
        added += i - segStart;
        pos = i + 1;
        segStart = pos;
        continue;
      }
      added += i - segStart;
      parts.push(text.slice(segStart, i));
      if (c === ',') {
        pos = i + 1;
        return [parts.join(''), COMMA, added];
      }
      pos = i + (c === '\r' ? 2 : 1);
      line += 1;
      return [parts.join(''), LINE_BREAK, added];
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
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
        // A field that opens with a quote.
        quoted = true;
        const open = pos;
        const openLine = line;
        let segStart = pos + 1;
        pos = segStart;
        let parts = null;
        let closed = false;
        quotedScan: for (;;) {
          RE_QUOTED.lastIndex = pos;
          const m = RE_QUOTED.exec(text);
          if (m === null) break quotedScan;
          const i = m.index;
          const c = m[0];
          if (c === '"') {
            if (text.charCodeAt(i + 1) === 34) {
              // A doubled quote inside is one quote.
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, i), '"');
              pos = i + 2;
              segStart = pos;
              continue;
            }
            // The closing quote.
            closed = true;
            if (parts === null) {
              value = text.slice(segStart, i);
            } else {
              parts.push(text.slice(segStart, i));
              value = parts.join('');
            }
            pos = i + 1;
            break quotedScan;
          }
          if (c === '\r') {
            // CRLF and a lone CR inside quotes are each read as one LF.
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i), '\n');
            line += 1;
            pos = i + (text.charCodeAt(i + 1) === 10 ? 2 : 1);
            segStart = pos;
            continue;
          }
          // c === '\n': kept as it stands (it already is LF); only the line
          // count moves, the current run of the field is not broken.
          line += 1;
          pos = i + 1;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquotedParts(['"']);
          value = r[0];
          ended = r[1];
        } else if (pos >= len) {
          ended = END;
        } else {
          const n = text.charCodeAt(pos);
          if (n === 44) {
            pos += 1;
            ended = COMMA;
          } else if (n === 10) {
            pos += 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (n === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands.
            const junk = readUnquotedParts([value]);
            if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            value = junk[0];
            ended = junk[1];
          }
        }
      } else {
        // An unquoted field: one scan to its comma or line break, unless a
        // stray CR interrupts it.
        quoted = false;
        let segStart = pos;
        let parts = null;
        unquotedScan: for (;;) {
          RE_FIELD.lastIndex = pos;
          const m = RE_FIELD.exec(text);
          if (m === null) {
            pos = len;
            value = parts === null ? text.slice(segStart, len) : (parts.push(text.slice(segStart, len)), parts.join(''));
            ended = END;
            break unquotedScan;
          }
          const i = m.index;
          const c = m[0];
          if (c === '\r' && text.charCodeAt(i + 1) !== 10) {
            // A lone CR outside quotes is dropped (stray_cr).
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i));
            pos = i + 1;
            segStart = pos;
            continue;
          }
          value = parts === null ? text.slice(segStart, i) : (parts.push(text.slice(segStart, i)), parts.join(''));
          if (c === ',') {
            pos = i + 1;
            ended = COMMA;
          } else {
            pos = i + (c === '\r' ? 2 : 1);
            line += 1;
            ended = LINE_BREAK;
          }
          break unquotedScan;
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
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
