/**
 * Jev（TypeSafe System One）呼び出し。
 *
 * 質問はコード内では配列 [{ name, type, instructions, criteria }] で持ち、
 * 送るときに質問名をキーにしたオブジェクトへ変換する（何問詰めても追加の待ち時間はほぼゼロ）。
 *
 * criteria の書式は型ごとに違い、間違えると 422 が返る。
 *   Noul   : オブジェクト { "true": "…", "false": "…" }（省略可）
 *   Choice : オブジェクト { key: "説明", … }（最大255個）
 *   Score  : 配列 [ "…", "…" ]（2〜10段階、先頭がレベル0）
 */

function validateJevQuestion_(q) {
  if (!q || !q.name || !q.instructions) throw new Error('Jev質問に name / instructions がない');
  const c = q.criteria;
  switch (q.type) {
    case 'noul':
      if (c !== undefined && (typeof c !== 'object' || Array.isArray(c))) {
        throw new Error(`${q.name}: Noul の criteria はオブジェクト`);
      }
      break;
    case 'score':
      if (!Array.isArray(c) || c.length < 2 || c.length > 10) {
        throw new Error(`${q.name}: Score の criteria は2〜10要素の配列`);
      }
      break;
    case 'choice': {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new Error(`${q.name}: Choice の criteria はオブジェクト`);
      }
      const n = Object.keys(c).length;
      if (n < 2 || n > 255) throw new Error(`${q.name}: Choice の選択肢は2〜255個`);
      break;
    }
    default:
      throw new Error(`${q.name}: 未知の型 ${q.type}`);
  }
}

function buildJevPayload_(state, questions) {
  const qs = {};
  questions.forEach((q) => {
    validateJevQuestion_(q);
    if (qs[q.name]) throw new Error(`質問名が重複: ${q.name}`);
    const out = { type: q.type, instructions: q.instructions };
    if (q.criteria !== undefined) out.criteria = q.criteria;
    qs[q.name] = out;
  });
  return { state: state, model: JEV_MODEL, questions: qs };
}

/**
 * レスポンスの answers を型ごとに正規化する。
 *   noul   → 0〜1 の数値（Noul に confidence は無く、数値自体が確信度）
 *   score  → { score, confidence }（score は段階の加重平均なので小数）
 *   choice → { choice, confidence, probabilities }
 * 欠けている回答は null。
 */
function parseJevAnswers_(answers, questions) {
  answers = answers || {};
  const out = {};
  questions.forEach((q) => {
    const a = answers[q.name];
    if (a === undefined || a === null) {
      out[q.name] = null;
      return;
    }
    if (q.type === 'noul') {
      out[q.name] = numOrNull_(typeof a === 'object' ? a.noul : a);
    } else if (q.type === 'score') {
      out[q.name] = {
        score: numOrNull_(typeof a === 'object' ? a.score : a),
        confidence: numOrNull_(a.confidence),
      };
    } else {
      out[q.name] = {
        choice: a.choice === undefined ? null : a.choice,
        confidence: numOrNull_(a.confidence),
        probabilities: a.probabilities || null,
      };
    }
  });
  return out;
}

function numOrNull_(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

/**
 * @param {string|Object} state 文字列でもオブジェクトでも渡せる
 * @param {Array} questions
 */
function jevAsk_(state, questions) {
  const apiKey = prop_('TYPESAFE_API_KEY');
  if (!apiKey) throw new Error('スクリプトプロパティ TYPESAFE_API_KEY が未設定です');

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(buildJevPayload_(state, questions)),
    muteHttpExceptions: true,
  };

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = UrlFetchApp.fetch(JEV_ENDPOINT, options);
    const code = res.getResponseCode();
    if (code === 200) return parseJevAnswers_(JSON.parse(res.getContentText()).answers, questions);
    if (code !== 429 && code !== 503) break; // 422 など書式エラーは再試行しても直らない
    Utilities.sleep(2000 * Math.pow(2, attempt));
  }
  throw new Error('Jev API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
}
