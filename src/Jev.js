/**
 * Jev（TypeSafe System One）呼び出し。
 *
 * 質問は { name, type: 'noul' | 'score' | 'choice', question, criteria } で定義する。
 * criteria の書式は型ごとに違い、間違えると 422 が返る。
 *   Noul   : オブジェクト { "true": "…", "false": "…" }（省略可）
 *   Choice : オブジェクト { key: "説明", … }（最大255個）
 *   Score  : 配列 [ "…", "…" ]（2〜10段階、先頭がレベル0）
 *
 * エンドポイントとリクエストの外形はスクリプトプロパティ JEV_API_URL / JEV_API_KEY と
 * buildJevPayload_() に閉じ込めてある。既存トリアージスクリプトの呼び出し方と
 * 違う場合はここだけを直す。
 */

function validateJevQuestion_(q) {
  if (!q || !q.name || !q.question) throw new Error('Jev質問に name / question がない');
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
  questions.forEach(validateJevQuestion_);
  return {
    state: state,
    questions: questions.map((q) => {
      const out = { name: q.name, type: q.type, question: q.question };
      if (q.criteria !== undefined) out.criteria = q.criteria;
      return out;
    }),
  };
}

/**
 * レスポンスの answers を型ごとに正規化する。
 *   noul   → 0〜1 の数値
 *   score  → { score, confidence }（score は段階の加重平均なので小数）
 *   choice → { choice, confidence, probabilities }
 * 欠けている回答は null。呼び出し側で null を「判定なし」として扱う。
 */
function parseJevAnswers_(response, questions) {
  const answers = (response && response.answers) || {};
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

function jevAsk_(state, questions) {
  const url = prop_('JEV_API_URL');
  const key = prop_('JEV_API_KEY');
  if (!url || !key) throw new Error('スクリプトプロパティ JEV_API_URL / JEV_API_KEY が未設定');

  const payload = buildJevPayload_(state, questions);
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code === 200) return parseJevAnswers_(JSON.parse(res.getContentText()), questions);
    if (code !== 429 && code < 500) break; // 422 など書式エラーは再試行しても直らない
    Utilities.sleep(1000 * Math.pow(2, attempt));
  }
  throw new Error(`Jev ${res.getResponseCode()}: ${res.getContentText().slice(0, 500)}`);
}
