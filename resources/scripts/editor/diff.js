/**
 * Small line-level LCS diff so we can show a real unified diff in the
 * tool-call card after the model edits a block. Returns an array of
 * {type, text} segments where type is one of:
 *   'eq'  — line present in both
 *   'del' — line only in the "before"
 *   'add' — line only in the "after"
 *
 * Fine for our sizes (a handful of blocks, JSON attribute patches); O(n·m)
 * memory is bounded by what the model can fit in a tool call anyway.
 */

export function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const n = a.length;
  const m = b.length;

  // Build LCS-length table from the back so we can read off the diff forward.
  const dp = Array.from({length: n + 1}, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      if (ai === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({type: 'eq', text: a[i]});
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({type: 'del', text: a[i]});
      i++;
    } else {
      out.push({type: 'add', text: b[j]});
      j++;
    }
  }
  while (i < n) {
    out.push({type: 'del', text: a[i]});
    i++;
  }
  while (j < m) {
    out.push({type: 'add', text: b[j]});
    j++;
  }
  return out;
}

/**
 * Token-level diff for the inline highlight INSIDE a modified line — same
 * LCS as `diffLines` but the tokens are words + whitespace (so common
 * formatting stays uncoloured and only the actual replaced phrase lights up,
 * git-style). Punctuation that's part of a word stays attached because we
 * just split on whitespace boundaries; the diff inside the chat is short
 * enough that finer tokenisation isn't worth the noise.
 */
export function diffWords(before, after) {
  const tokenize = (s) => String(s ?? '').match(/\S+|\s+/g) || [];
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  const dp = Array.from({length: n + 1}, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      if (ai === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({type: 'eq', text: a[i]});
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({type: 'del', text: a[i]});
      i++;
    } else {
      out.push({type: 'add', text: b[j]});
      j++;
    }
  }
  while (i < n) {
    out.push({type: 'del', text: a[i]});
    i++;
  }
  while (j < m) {
    out.push({type: 'add', text: b[j]});
    j++;
  }
  return out;
}

/**
 * Pair adjacent del + add line segments into "modified line" hunks so the
 * viewer can render them with inline word-level highlighting (git's
 * --word-diff). When dels and adds come in unequal counts they pair in
 * order; the leftovers stay as plain del-only or add-only rows.
 */
export function pairModifiedLines(segments) {
  const out = [];
  for (let i = 0; i < segments.length; ) {
    const s = segments[i];
    if (s.type === 'del') {
      // Collect the run of dels, then the run of adds that follows.
      const dels = [];
      while (i < segments.length && segments[i].type === 'del') {
        dels.push(segments[i]);
        i++;
      }
      const adds = [];
      while (i < segments.length && segments[i].type === 'add') {
        adds.push(segments[i]);
        i++;
      }
      const paired = Math.min(dels.length, adds.length);
      for (let k = 0; k < paired; k++) {
        out.push({
          type: 'mod',
          del: dels[k].text,
          add: adds[k].text,
          words: diffWords(dels[k].text, adds[k].text),
        });
      }
      // Leftover dels (no matching add) and trailing adds (no matching del)
      // stay as solo lines so we don't lose them.
      for (let k = paired; k < dels.length; k++) out.push(dels[k]);
      for (let k = paired; k < adds.length; k++) out.push(adds[k]);
    } else {
      out.push(s);
      i++;
    }
  }
  return out;
}

/**
 * Trim long runs of unchanged context — anything more than `context` equal
 * lines between two changed regions collapses to a "…" placeholder so the
 * diff doesn't fill the chat with boilerplate. Preserves the first and last
 * `context` lines around each hunk.
 */
export function collapseUnchanged(segments, context = 2) {
  // Compute, for each eq segment, distance to nearest non-eq on each side.
  const out = [];
  const eqRun = [];

  const flushEqRun = (hasChangeAfter) => {
    if (!eqRun.length) return;
    const hasChangeBefore = out.length > 0;
    const head = hasChangeBefore ? eqRun.slice(0, context) : [];
    const tail = hasChangeAfter ? eqRun.slice(-context) : [];
    if (!hasChangeBefore && !hasChangeAfter) {
      // Pure-equal "diff" (no changes) — keep everything so the user
      // still sees the content.
      out.push(...eqRun);
    } else if (head.length + tail.length >= eqRun.length) {
      // Hunks are adjacent — just include the run as-is.
      out.push(...eqRun);
    } else {
      out.push(...head);
      const hidden = eqRun.length - head.length - tail.length;
      out.push({type: 'gap', text: `… ${hidden} unchanged line${hidden === 1 ? '' : 's'}`});
      out.push(...tail);
    }
    eqRun.length = 0;
  };

  for (const seg of segments) {
    if (seg.type === 'eq') {
      eqRun.push(seg);
    } else {
      flushEqRun(true);
      out.push(seg);
    }
  }
  flushEqRun(false);
  return out;
}
