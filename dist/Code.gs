/**
 * Gmail × Jev メールトリアージ ＋ メール→カレンダー自動登録（1ファイル版）
 *
 * このファイルは scripts/build.js が src/*.js から生成したもの。直接編集しない。
 * 貼り付け方：Apps Script エディタで既存のコードを全部消して、これを1ファイルに貼る。
 * appsscript.json は触らなくてよい（権限は Apps Script がコードから自動で判定する）。
 */
// ===== Config.js ======================================================

/**
 * 設定値。
 *
 * ① トリアージの値とスクリプトプロパティ名は、稼働中の既存スクリプト（gmail-triage-jev.gs）と
 * 同じにしてある。同じ Apps Script プロジェクトに入れ替えれば、開始日・日次カウント・ログシートを
 * そのまま引き継ぐ。
 *
 * スクリプトプロパティ
 *   TYPESAFE_API_KEY   Jev の API キー（必須）
 *   START_DATE         開始日 yyyy/MM/dd。setup() が入れる
 *   DAILY_COUNT        1日あたり上限のカウンタ（JSON）
 *   LOG_SHEET_ID       判定ログのスプレッドシート。setup() が作る
 *   INTERNAL_DOMAINS   社内ドメイン（カンマ区切り）。CONFIG.INTERNAL_DOMAINS より優先
 *   CAL_STAGE          カレンダー登録の段階 0〜5。既定 0（トリアージのみ）
 *   ANTHROPIC_API_KEY  ③ 抽出用（段階2以上で必須）
 *   CLAUDE_MODEL       ③ のモデル。既定 claude-opus-5-5
 *   NOTIFY_EMAIL       「通知のみ」を送るアドレス。未設定ならログのみ
 *
 * 閾値はすべて暫定値。ログシートの「自己判定」列を埋めて分布を見てから決める。
 */
const CONFIG = {
  // 何を拾うか（Gmail検索クエリ）。after: は開始日から自動で付ける
  TRIAGE_QUERY: 'is:unread -category:promotions -category:social',
  // 予定判定は既読でも拾う（予定の見落としを避ける。二重処理は _cal マーカーで防ぐ）
  CAL_QUERY: '-category:promotions -category:social -in:chats -in:drafts',

  MAX_PER_DAY: 100, // 溜まった未読を一気に舐めないための保険
  MAX_THREADS: 20, // 1回の実行で処理する最大スレッド数（Apps Script は6分で強制終了する）
  RUN_TIME_BUDGET_MS: 4.5 * 60 * 1000,

  // 自分の社内ドメイン（@は付けない）。スクリプトプロパティ INTERNAL_DOMAINS があればそちらを使う
  INTERNAL_DOMAINS: [],

  // 本文をどこまで送るか（文字数）。長文を全部送っても精度は上がらず金だけ増える
  BODY_LIMIT: 3000,

  // LOW（あとで）はラベルを付けない。ラベルが付いている＝見るべきもの
  LABELS: {
    HIGH: '01_即対応',
    MEDIUM: '02_今日中',
    PROCESSED: '_jev', // 二重処理を防ぐための内部用マーカー
    CAL_PROCESSED: '_cal', // 予定判定済み。トリアージだけ済んだ状態を区別する
  },

  THRESHOLD_HIGH: 65,
  THRESHOLD_MEDIUM: 35,

  // これ未満の確信度の判定は「不明」として弱く扱う
  MIN_CONFIDENCE: 0.5,

  LOG_SHEET_NAME: 'Jevメール判定ログ',
  CAL_LOG_SHEET_NAME: '予定登録ログ', // 同じスプレッドシートの別シート

  CAL: {
    PROVISIONAL_CALENDAR: 'Jev仮登録',
    MATCH_WINDOW_HOURS: 3, // ④ 候補時刻の前後何時間を照合するか
    DEFAULT_DURATION_MIN: 60, // 終了時刻が書かれていないときの長さ
    CANCEL_PREFIX: '【中止】',
    THRESHOLDS: {
      HAS_SCHEDULE: 0.8, // 高めにして取りこぼす方に倒す
      I_PARTICIPATE: 0.6,
      PERSONALLY_INVITED: 0.6, // メーリングリスト経由のときだけ使う
      SCHEDULE_TYPE_CONFIDENCE: 0.7, // 未満なら通知のみ
      SAME_EVENT: 0.5, // 以上なら新規登録しない（迷ったら止める）
      RELATION_CONFIDENCE: 0.7, // 未満なら更新・中止印を付けず通知のみ
    },
  },

  TRIGGER_MINUTES: 5,
  TZ_OFFSET_HOURS: 9, // 日付計算は日本時間固定（夏時間なし）
};

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

/**
 * カレンダー登録の段階（要件定義「実装順序と受け入れ条件」に対応）。
 */
const CAL_STAGE = {
  OFF: 0,
  JUDGE: 1, // ② 予定判定のみ記録
  EXTRACT: 2, // ②＋③ 抽出まで記録
  MATCH: 3, // ②〜⑤ 照合まで記録
  PROVISIONAL: 4, // 仮登録カレンダーへ書き込み
  MAIN: 5, // 本カレンダーへ書き込み
};

function prop_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function calStage_() {
  const n = Number(prop_('CAL_STAGE', '0'));
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n))) : 0;
}

function internalDomains_() {
  const p = prop_('INTERNAL_DOMAINS', '');
  const list = p ? p.split(',') : CONFIG.INTERNAL_DOMAINS;
  return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}


// ===== Jev.js =========================================================

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


// ===== Triage.js ======================================================

/**
 * ① メール重要度分類（トリアージ）。稼働中の既存スクリプトと同じ質問・採点。
 *
 * 重要な原則：
 *   ×「このメールは重要か」と1問で聞く
 *   ○ 事実ベースの小さな質問に割って、重み付けはコード側でやる
 *
 * Jevは日付の前後関係が苦手なので「期限が近いか」は絶対に聞かない。
 * 「期限が書かれているか」だけ聞いて、近さの計算はコードでやる。
 */

const TRIAGE_QUESTIONS = [
  // --- Noul（yes/noの確率 0〜1。confidenceフィールドは無く、数値自体が確信度）---
  {
    name: 'needs_reply',
    type: 'noul',
    instructions: 'このメールは受信者からの返信や回答を求めているか。',
    criteria: {
      true: '質問、依頼、確認、承認、日程調整など、受信者が何か返す必要がある',
      false: '一方的な通知、報告、共有のみで返信は不要',
    },
  },
  {
    name: 'has_deadline',
    type: 'noul',
    instructions: '本文に、対応の期限や締切を示す記述があるか。',
    criteria: {
      true: '日付、曜日、「今日中」「明日まで」「今週中」などの期限の表現がある',
      false: '期限に触れていない',
    },
  },
  {
    name: 'addressed_to_me',
    type: 'noul',
    instructions: '受信者本人が名指しで対応を求められているか。',
    criteria: {
      true: '宛名で指名されている、または明確に受信者の担当領域の依頼',
      false: '一斉送信、CC止まり、誰宛とも書かれていない',
    },
  },
  {
    name: 'involves_money',
    type: 'noul',
    instructions: '業務上の金銭や契約に関わる内容か。個人的な会費や立替は含めない。',
    criteria: {
      true: '取引先との請求、見積、契約条件、支払い期日など、業務上の金銭のやりとり',
      false: '金銭に触れていない、または懇親会の会費など私的な支払いのみ',
    },
  },
  {
    name: 'is_personal',
    type: 'noul',
    instructions: '業務ではなく、私的な案内や連絡か。',
    criteria: {
      true: '同窓会、懇親会、季節の挨拶、個人的な近況など、仕事の遂行に関係しない',
      false: '業務に関する連絡',
    },
  },
  {
    name: 'is_trouble',
    type: 'noul',
    instructions: '障害、クレーム、謝罪要求、トラブルの報告を含むか。',
    criteria: {
      true: '不具合、事故、苦情、抗議、謝罪の要求が書かれている',
      false: '平常のやりとり',
    },
  },
  {
    name: 'is_automated',
    type: 'noul',
    instructions: '機械が自動送信したメールか。',
    criteria: {
      true: 'システム通知、配信メール、広告、メールマガジン、自動応答',
      false: '人間が書いて送っている',
    },
  },

  // --- Score（criteria は配列。先頭がレベル0。各段階は「程度」ではなく「状況」で書く）---
  {
    name: 'urgency',
    type: 'score',
    instructions: '対応の緊急度を、書かれている状況から判断してください。',
    criteria: [
      '対応の必要がない、または読むだけでよい',
      '対応は要るが、来週以降でも問題ない',
      '数日以内に対応すればよい',
      '今日から明日のうちに対応が必要',
      '今すぐ対応しないと業務や取引に実害が出る',
    ],
  },

  // --- Choice（必ず「該当なし」の逃げ道を入れる）---
  {
    name: 'category',
    type: 'choice',
    instructions: 'このメールの主な性質を1つ選んでください。',
    criteria: {
      request: '依頼、質問、承認や判断の要求',
      scheduling: '日程調整、会議の設定や変更',
      contract: '契約、請求、見積、金銭に関するやりとり',
      trouble: '障害、クレーム、トラブルの報告',
      info: '情報共有、報告、議事録などの連絡',
      sales: '売り込み、営業メール、勧誘',
      notification: 'システム通知、配信、自動送信',
      other: '上記のいずれにも当てはまらない、または判断できない',
    },
  },
];

/**
 * 採点（ここがコード側の仕事）。Jevは判断だけ返す。重み付け、日付計算、閾値はすべてこちら。
 *
 * @param {Object} a parseJevAnswers_ の結果
 * @param {{deadlineDays: ?number, isExternal: boolean}} meta コード側で求めた値
 * @return {{bucket: string, score: number, category: string, categoryConf: number}}
 */
function scoreTriage_(a, meta) {
  const noul = (k) => (typeof a[k] === 'number' ? a[k] : 0);
  const urgencyRaw = a.urgency && typeof a.urgency.score === 'number' ? a.urgency.score : 0;
  const urgencyConf = (a.urgency && a.urgency.confidence) || 0;
  const category = (a.category && a.category.choice) || 'other';
  const categoryConf = (a.category && a.category.confidence) || 0;
  // parts は採点の内訳。explainMail() で「なぜこの点数か」を見るために残す
  const parts = [];
  const result = (score) => ({
    bucket: bucketFor_(score),
    score: score,
    category: category,
    categoryConf: categoryConf,
    parts: parts,
  });
  const r = (v) => Math.round(v * 10) / 10;

  // 自動送信・営業は問答無用で落とす
  if (noul('is_automated') > 0.8) {
    parts.push(`即0点: 自動送信 is_automated=${r(noul('is_automated'))} > 0.8`);
    return result(0);
  }
  if (category === 'sales' && categoryConf > 0.7) {
    parts.push(`即0点: 営業 category=sales (${r(categoryConf)}) > 0.7`);
    return result(0);
  }

  let score = 0;

  // --- 重要度（誰の仕事か、何が懸かっているか）---
  // 「返信が要る」は「自分が対応すべきか」で割り引く。
  // 一斉送信の案内でも返信は要るので、足し算にすると効きすぎる。
  const ownership = 0.25 + 0.75 * noul('addressed_to_me');
  const reply = noul('needs_reply') * ownership * 35;
  score += reply;
  parts.push(`要返信 ${r(reply)}/35（needs_reply=${r(noul('needs_reply'))} × 名指し係数 ${r(ownership)}）`);
  score += noul('is_trouble') * 20;
  parts.push(`トラブル ${r(noul('is_trouble') * 20)}/20`);
  score += noul('involves_money') * 15;
  parts.push(`金銭 ${r(noul('involves_money') * 15)}/15`);

  // 期限の「近さ」はJevではなくコードで計算した値を使う。日付を特定できなければ加点しない
  let deadline = 0;
  if (noul('has_deadline') > 0.5 && meta.deadlineDays !== null && meta.deadlineDays !== undefined) {
    const days = meta.deadlineDays;
    if (days <= 1) deadline = 25;
    else if (days <= 3) deadline = 15;
    else if (days <= 7) deadline = 7;
    // 8日以上先は加点なし
  }
  score += deadline;
  parts.push(
    `期限 ${deadline}/25（has_deadline=${r(noul('has_deadline'))}, 残り日数=${
      meta.deadlineDays === null || meta.deadlineDays === undefined ? '特定できず' : meta.deadlineDays
    }）`
  );

  if (meta.isExternal) score += 5;
  parts.push(`社外 ${meta.isExternal ? 5 : 0}/5`);

  // --- 緊急度は係数として効かせる ---
  // 緊急度ゼロのメールは、他が何点でも上位に来てはいけない。
  const urgencyNorm = Math.min(urgencyRaw / 4, 1);
  const urgencyFactor = 0.25 + 0.75 * urgencyNorm * Math.max(urgencyConf, CONFIG.MIN_CONFIDENCE);
  parts.push(`小計 ${r(score)} × 緊急度係数 ${r(urgencyFactor * 100) / 100}（urgency=${r(urgencyRaw)}/4, 確信度=${r(urgencyConf)}）`);
  score *= urgencyFactor;

  // 私信は業務メールと同じ土俵に乗せない
  if (noul('is_personal') > 0) parts.push(`私信の割引 ×${r((1 - 0.6 * noul('is_personal')) * 100) / 100}`);
  score *= 1 - 0.6 * noul('is_personal');

  return result(Math.round(Math.min(score, 100)));
}

function bucketFor_(score) {
  if (score >= CONFIG.THRESHOLD_HIGH) return 'HIGH';
  if (score >= CONFIG.THRESHOLD_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * 本文から期限らしき日付を拾って、受信日（日本時間）からの残日数を返す。
 * 見つからなければ null。ここをJevにやらせてはいけない。
 *
 * 年つき（2026/11/20）を先に試し、次に年なし（11月20日）を試す。
 * 逆にすると 2026/11/20 から 26/11 を拾って月=26になる。
 */
function daysUntilDeadline_(body, baseDate) {
  const text = String(body || '').slice(0, 2000);
  const p = jstParts_(baseDate);
  const base = Date.UTC(p.y, p.m - 1, p.d);

  if (/本日中|今日中|至急|大至急/.test(text)) return 0;
  if (/明日まで|翌営業日/.test(text)) return 1;
  if (/今週中|週内/.test(text)) return Math.max(5 - new Date(base).getUTCDay(), 0);

  let year = null;
  let month;
  let day;

  // 先に「年つき」を試す: 2026/11/20, 2026-11-20, 2026年11月20日
  let m = text.match(/(20\d{2})\s*[年\/\-\.]\s*(\d{1,2})\s*[月\/\-\.]\s*(\d{1,2})/);
  if (m) {
    year = parseInt(m[1], 10);
    month = parseInt(m[2], 10) - 1;
    day = parseInt(m[3], 10);
  } else {
    // 年なし: 11月20日, 11/20
    // 直前が数字でないことを確認して「2026/11」のような誤検出を避ける
    m = text.match(/(?:^|[^\d])(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*日?(?![\d])/);
    if (!m) return null;
    month = parseInt(m[1], 10) - 1;
    day = parseInt(m[2], 10);
  }

  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  let target = Date.UTC(year !== null ? year : p.y, month, day);
  if (year === null && target < base) {
    target = Date.UTC(p.y + 1, month, day); // 年跨ぎ
  }
  return Math.round((target - base) / 86400000);
}

/** 日本時間の年月日。 */
function jstParts_(date) {
  const t = new Date(date.getTime() + CONFIG.TZ_OFFSET_HOURS * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 実在しない日付（2/30、月=26 など）は null。 */
function dayNumberOf_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime() / 86400000;
}

/** 送信元が社外か。社内ドメインが未設定だと全部社外扱いになる。 */
function isExternalSender_(from, domains) {
  const m = String(from || '').match(/@([A-Za-z0-9.\-]+)/);
  if (!m) return true;
  const host = m[1].toLowerCase();
  return !domains.some((d) => host === d || host.endsWith('.' + d));
}

/** 最優先だけ別チャネルへ（Slack 等に飛ばすならここ）。まずはログだけ。 */
function notifyUrgent_(mail, result) {
  // const url = prop_('SLACK_WEBHOOK_URL');
  // if (!url) return;
  // UrlFetchApp.fetch(url, {
  //   method: 'post', contentType: 'application/json',
  //   payload: JSON.stringify({ text: '🔴 ' + mail.subject + '\n' + mail.from }),
  // });
  console.log(`🔴 要即対応: ${mail.subject}（${result.score}点）`);
}


// ===== Schedule.js ====================================================

/**
 * ② 予定を含むか（Jev）と ⑤ 同一判定（Jev）、⑥ 動作の決定。
 *
 * 層ごとに誤りの代償の向きが違う。
 *   ① トリアージ：拾う方に倒す
 *   ② 予定判定　：落とす方に倒す（誤登録はカレンダーを汚す）
 *   ⑤ 同一判定　：止める方に倒す（迷ったら登録しない。メールは残る）
 */

const SCHEDULE_QUESTIONS = [
  {
    name: 'has_schedule',
    type: 'noul',
    instructions: 'このメールは、日時の指定を伴う予定の連絡か。',
    criteria: {
      true: '会議、面談、訪問、打ち合わせ、イベントなどについて、日付や時刻が書かれている',
      false: '予定に触れていない、または日時の手がかりが一切ない',
    },
  },
  {
    name: 'i_participate',
    type: 'noul',
    instructions: '受信者本人がその予定に参加する立場か。',
    criteria: {
      true: '受信者が招待されている、出席を求められている、または受信者自身が設定した予定',
      false: '他人同士の予定の共有、参考として転送されただけ、全社向けの告知など',
    },
  },
  {
    // メーリングリスト経由のときだけ効かせる（scheduleGate_ 参照）。
    // 「参加予定の皆様へ」のような一斉連絡は i_participate では落としきれないため、事実に割って聞く
    name: 'personally_invited',
    type: 'noul',
    instructions: '受信者個人がこの予定への出席を求められている、または受信者が出席することが本文から分かるか。',
    criteria: {
      true: '受信者を名指しした招待や依頼、受信者の出席表明への返信、受信者の役割（司会・発表・担当など）が書かれている',
      false:
        '「参加予定の皆様へ」「委員各位」「関係者各位」など対象を限った一斉連絡で、受信者がその対象に含まれるか本文から分からない。または全員向けの告知',
    },
  },
  {
    name: 'schedule_type',
    type: 'choice',
    instructions: 'このメールは予定について何を伝えているか。1つ選んでください。',
    // 「予定ではない」という棄権の選択肢を必ず入れる
    criteria: {
      confirmed: '日時が決まった予定の案内や招待',
      proposal: '日時の候補を挙げて都合を聞いている、日程を調整しようとしている',
      change: '既に決まっていた予定の日時や場所の変更',
      cancel: '既に決まっていた予定の中止や延期（新しい日時は未定）',
      not_schedule: '予定の連絡ではない、または判断できない',
    },
  },
];

/** ⑤ の state は { existing_event, mail_event } の2つだけ。 */
function sameEventQuestions_() {
  return [
    {
      name: 'is_same_event',
      type: 'noul',
      instructions: 'existing_event と mail_event は同一の予定を指しているか。',
      criteria: {
        true: '相手、目的、会議名などから同じ予定だと分かる。時刻が多少ずれていても、件名が簡略でもよい',
        false: '時刻が重なっていても、相手や目的が違う別の予定',
      },
    },
    {
      name: 'relation',
      type: 'choice',
      instructions: 'mail_event は existing_event に対してどういう関係か。1つ選んでください。',
      criteria: {
        same: '同じ予定で、日時も変わっていない',
        rescheduled: '同じ予定の日時が変わった',
        cancelled: '同じ予定が中止になった',
        unrelated: '別の予定',
        cannot_tell: '判断できない',
      },
    },
  ];
}

/**
 * ② の結果から、③ 以降に進むかを決める。
 * @param {Object} a parseJevAnswers_ の結果
 * @param {{isMailingList: boolean}=} meta コード側で求めた値
 * @return {{proceed: boolean, notifyOnly: boolean, reason: string}}
 */
function scheduleGate_(a, meta) {
  meta = meta || {};
  const th = CONFIG.CAL.THRESHOLDS;
  const v = (k) => (a[k] === null || a[k] === undefined ? 0 : a[k]);
  const type = a.schedule_type || {};

  if (v('has_schedule') < th.HAS_SCHEDULE) return gate_(false, false, 'no_schedule');
  if (v('i_participate') < th.I_PARTICIPATE) return gate_(false, false, 'not_participant');
  // メーリングリストの一斉連絡は、個人として出席を求められていると分かるときだけ通す
  if (meta.isMailingList && v('personally_invited') < th.PERSONALLY_INVITED) {
    return gate_(false, false, 'ml_not_personal');
  }
  if (!type.choice || type.choice === 'not_schedule') return gate_(false, false, 'not_schedule');
  // 候補提示を登録すると日程調整の往復がすべてカレンダーに入って壊れる
  if (type.choice === 'proposal') return gate_(false, false, 'proposal');
  if ((type.confidence || 0) < th.SCHEDULE_TYPE_CONFIDENCE) return gate_(false, true, 'low_confidence_type');
  return gate_(true, false, type.choice);
}

/**
 * メーリングリスト経由のメールか。ヘッダから確実に分かるので Jev に聞かない。
 * @param {{listId: string, listPost: string, precedence: string}} headers
 */
function isMailingList_(headers, subject) {
  if (headers.listId || headers.listPost) return true;
  if (/^(list|bulk)$/i.test(String(headers.precedence || '').trim())) return true;
  // [ex-ac:12814] のような ML の通し番号付き件名
  return /^\s*(?:(?:re|fw|fwd)\s*[:：]\s*)*[\[【(（][^\]】)）\s]+[:：]\s*\d+[\]】)）]/i.test(String(subject || ''));
}

function gate_(proceed, notifyOnly, reason) {
  return { proceed: proceed, notifyOnly: notifyOnly, reason: reason };
}

/**
 * ⑥ 何をするかを決める（カレンダーには触れない純粋関数）。
 *
 * @param {string} scheduleType ② の schedule_type（confirmed / change / cancel）
 * @param {Array<{isSame: ?number, relation: ?{choice, confidence}}>} matches
 *        ④ で見つけた既存予定ごとの ⑤ の結果。0件なら空配列。
 * @return {{action: string, index: number, reason: string}}
 *        action は create / none / update / mark_cancelled / notify / skip。
 *        index は対象の既存予定（matches の添字）、無ければ -1。
 */
function decideCalendarAction_(scheduleType, matches) {
  const th = CONFIG.CAL.THRESHOLDS;

  if (!matches.length) {
    if (scheduleType === 'cancel') return act_('skip', -1, 'cancel_without_existing');
    return act_('create', -1, 'no_existing');
  }

  let best = -1;
  matches.forEach((m, i) => {
    const s = m.isSame === null || m.isSame === undefined ? 0 : m.isSame;
    if (s >= th.SAME_EVENT && (best < 0 || s > (matches[best].isSame || 0))) best = i;
  });

  if (best < 0) {
    const unsure = matches.some((m) => m.relation && m.relation.choice === 'cannot_tell');
    if (unsure) return act_('notify', -1, 'relation_cannot_tell');
    if (scheduleType === 'cancel') return act_('skip', -1, 'cancel_without_match');
    return act_('create', -1, 'all_unrelated');
  }

  const rel = matches[best].relation || {};
  if ((rel.confidence || 0) < th.RELATION_CONFIDENCE) return act_('notify', best, 'low_confidence_relation');
  switch (rel.choice) {
    case 'same':
      return act_('none', best, 'already_registered');
    case 'rescheduled':
      return act_('update', best, 'rescheduled');
    case 'cancelled':
      return act_('mark_cancelled', best, 'cancelled');
    default:
      // is_same_event は高いのに relation が無関係／判断不能：矛盾しているので止める
      return act_('notify', best, 'inconsistent_' + (rel.choice || 'none'));
  }
}

function act_(action, index, reason) {
  return { action: action, index: index, reason: reason };
}

/** ⑤ に渡す state。無関係な情報を詰めると精度が落ちるので必要な項目だけにする。 */
function sameEventState_(existing, extracted) {
  const ev = { title: existing.title, when: existing.when };
  if (existing.location) ev.location = existing.location;
  if (existing.description) ev.memo = existing.description.slice(0, 300);
  const mail = { title: extracted.title || '(不明)', when: extracted.when };
  if (extracted.location) mail.location = extracted.location;
  if (extracted.mailSubject) mail.mail_subject = extracted.mailSubject;
  return { existing_event: ev, mail_event: mail };
}


// ===== Extract.js =====================================================

/**
 * ③ 抽出（生成AI）。
 *
 * Jev は日付を順序ではなくテキストとして読むので、この層は生成AIでなければならない。
 * 「来週火曜14時から」をメールの受信日時を基準に実日時へ変換させる。
 * 抽出できない項目は推測させず null を返させる（埋めさせると誤登録の原因になる）。
 *
 * モデルはスクリプトプロパティ CLAUDE_MODEL で差し替えられる。
 */

const EXTRACT_DEFAULT_MODEL = 'claude-opus-5-5';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    start: { type: ['string', 'null'] },
    end: { type: ['string', 'null'] },
    all_day: { type: ['boolean', 'null'] },
    location: { type: ['string', 'null'] },
    attendees: { type: ['array', 'null'], items: { type: 'string' } },
    online_url: { type: ['string', 'null'] },
    previous_start: { type: ['string', 'null'] },
    confidence_note: { type: ['string', 'null'] },
  },
  required: [
    'title',
    'start',
    'end',
    'all_day',
    'location',
    'attendees',
    'online_url',
    'previous_start',
    'confidence_note',
  ],
  additionalProperties: false,
};

const EXTRACT_SYSTEM_PROMPT = [
  'あなたはメールから予定を1件だけ取り出し、JSONで返す抽出器です。',
  '',
  '- 相対的な日付（「来週火曜」「明後日」「今月末」）は、与えられた「メール受信日時」を基準に実際の日付へ変換してください。',
  '- 日時は日本時間のISO 8601（例: 2026-10-05T14:00:00+09:00）で返してください。終日の予定は日付のみ（例: 2026-10-05）にし、all_day を true にしてください。',
  '- メールに書かれていない項目は推測せず null にしてください。特に終了時刻が書かれていなければ end は null です。',
  '- 変更連絡のときは、新しい日時を start / end に、変更前の日時が書かれていれば previous_start に入れてください。',
  '- title はカレンダーの件名として短く（30字程度）。相手の会社名や会議の種類が分かるようにしてください。',
  '- 仮定や曖昧な点があれば confidence_note に日本語で短く書いてください。無ければ null。',
  '- 予定が複数あるときは、このメールが主に案内している1件を選び、その旨を confidence_note に書いてください。',
  '- 出力はJSONオブジェクトのみ。前置きやMarkdownのコードブロックは付けないでください。',
].join('\n');

/**
 * @param {{subject: string, from: string, body: string, date: Date}} mail
 * @return {{ok: boolean, data: ?Object, error: ?string}}
 */
function extractEvent_(mail) {
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, data: null, error: 'ANTHROPIC_API_KEY が未設定' };

  const payload = {
    model: prop_('CLAUDE_MODEL', EXTRACT_DEFAULT_MODEL),
    max_tokens: 4096,
    system: EXTRACT_SYSTEM_PROMPT,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: EXTRACT_SCHEMA },
    },
    fallbacks: 'default',
    messages: [{ role: 'user', content: extractUserContent_(mail) }],
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    return { ok: false, data: null, error: `Claude ${code}: ${res.getContentText().slice(0, 300)}` };
  }
  return parseExtractResponse_(JSON.parse(res.getContentText()));
}

function extractUserContent_(mail) {
  return [
    'メール受信日時: ' + formatJstWithWeekday_(mail.date),
    '差出人: ' + mail.from,
    '件名: ' + mail.subject,
    '',
    '本文:',
    mail.body,
  ].join('\n');
}

/** Messages API のレスポンスから抽出結果を取り出す。パースは必ず try-catch で囲む。 */
function parseExtractResponse_(response) {
  if (!response) return { ok: false, data: null, error: 'empty response' };
  if (response.stop_reason === 'refusal') return { ok: false, data: null, error: 'refusal' };
  if (response.stop_reason === 'max_tokens') return { ok: false, data: null, error: 'max_tokens' };

  const block = (response.content || []).find((b) => b.type === 'text');
  if (!block) return { ok: false, data: null, error: 'no text block' };

  let text = String(block.text).trim();
  // 構造化出力で来るはずだが、念のため前置きやコードブロックを剥がす
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) return { ok: false, data: null, error: 'no json' };

  try {
    return { ok: true, data: JSON.parse(text.slice(first, last + 1)), error: null };
  } catch (e) {
    return { ok: false, data: null, error: 'json parse: ' + e.message };
  }
}

/**
 * 抽出結果をカレンダー登録できる形に整える。
 * 終了時刻が無ければ開始の1時間後とし、仮定したことを note に残す。
 * @return {?{title, start: Date, end: Date, allDay: boolean, location, attendees, onlineUrl, previousStart: ?Date, note}}
 */
function normalizeExtraction_(ex, mailSubject) {
  if (!ex || !ex.start) return null;
  const notes = ex.confidence_note ? [ex.confidence_note] : [];
  const allDay = ex.all_day === true || /^\d{4}-\d{2}-\d{2}$/.test(ex.start);

  let start;
  let end;
  if (allDay) {
    start = parseJstDate_(ex.start.slice(0, 10));
    end = ex.end ? parseJstDate_(String(ex.end).slice(0, 10)) : null;
    if (!start) return null;
    if (!end || end < start) end = start;
    // 終日予定の end は「最終日」を表す（Calendar 側で翌日0時にする）
  } else {
    start = parseIsoDate_(ex.start);
    if (!start) return null;
    end = ex.end ? parseIsoDate_(ex.end) : null;
    if (!end || end <= start) {
      if (ex.end) notes.push('終了時刻が不正なため既定の長さにした');
      else if (!ex.confidence_note || !/終了/.test(ex.confidence_note)) notes.push('終了時刻の記載なし。1時間と仮定');
      end = new Date(start.getTime() + CONFIG.CAL.DEFAULT_DURATION_MIN * 60 * 1000);
    }
  }

  return {
    title: ex.title || mailSubject || '(件名なし)',
    start: start,
    end: end,
    allDay: allDay,
    location: ex.location || null,
    attendees: Array.isArray(ex.attendees) ? ex.attendees : [],
    onlineUrl: ex.online_url || null,
    previousStart: ex.previous_start ? parseIsoDate_(ex.previous_start) || parseJstDate_(ex.previous_start) : null,
    note: notes.join(' / ') || null,
  };
}

/** タイムゾーン付き ISO。タイムゾーンが無ければ日本時間とみなす。 */
function parseIsoDate_(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+\-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const tz = m[7] || '+09:00';
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz.length === 5 ? tz.slice(0, 3) + ':' + tz.slice(3) : tz}`);
  return isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD を日本時間のその日0時として返す。 */
function parseJstDate_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  if (dayNumberOf_(Number(m[1]), Number(m[2]), Number(m[3])) === null) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`);
}

function formatJstWithWeekday_(date) {
  const t = new Date(date.getTime() + CONFIG.TZ_OFFSET_HOURS * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const wd = '日月火水木金土'[t.getUTCDay()];
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00+09:00（${wd}曜日）`
  );
}

function formatJst_(date, allDay) {
  const s = formatJstWithWeekday_(date);
  return allDay ? s.slice(0, 10) + s.slice(-5) : s.slice(0, 16).replace('T', ' ') + s.slice(-5);
}


// ===== Calendar.js ====================================================

/**
 * ④ 照合（コード）と ⑥ 登録（コード）。
 *
 * 照合は CalendarApp.getEvents() を使うので、手入力の予定も他システムから入った予定も含まれる。
 * 本カレンダーと仮登録カレンダーの両方を見る。
 *
 * 書き込みの安全策:
 *   - 段階4では仮登録カレンダーにしか書かない。本カレンダーの予定は更新も中止印も付けない（通知のみ）
 *   - 中止連絡でも削除しない。件名に【中止】を付けて残す（削除は復旧できない）
 */

function mainCalendar_() {
  return CalendarApp.getDefaultCalendar();
}

function provisionalCalendar_(createIfMissing) {
  const name = CONFIG.CAL.PROVISIONAL_CALENDAR;
  const found = CalendarApp.getCalendarsByName(name);
  if (found.length) return found[0];
  if (!createIfMissing) return null;
  return CalendarApp.createCalendar(name, {
    summary: 'メールから自動登録した予定（検証用）。誤登録が多ければカレンダーごと削除してよい',
  });
}

/** 照合対象のカレンダー。[{calendar, isProvisional}] */
function matchCalendars_() {
  const list = [{ calendar: mainCalendar_(), isProvisional: false }];
  const prov = provisionalCalendar_(false);
  if (prov) list.push({ calendar: prov, isProvisional: true });
  return list;
}

/**
 * 抽出した日時の前後（既定3時間）にある既存予定を集める。
 * 変更連絡で変更前の日時が分かっていれば、その前後も見る。
 * @return {Array<{event: CalendarEvent, isProvisional: boolean}>}
 */
function findNearbyEvents_(ev, calendars) {
  const pad = CONFIG.CAL.MATCH_WINDOW_HOURS * 3600 * 1000;
  const windows = [];
  if (ev.allDay) {
    windows.push([ev.start.getTime() - pad, ev.end.getTime() + 86400000 + pad]);
  } else {
    windows.push([ev.start.getTime() - pad, ev.end.getTime() + pad]);
  }
  if (ev.previousStart) windows.push([ev.previousStart.getTime() - pad, ev.previousStart.getTime() + pad]);

  const seen = {};
  const out = [];
  calendars.forEach((c) => {
    windows.forEach((w) => {
      c.calendar.getEvents(new Date(w[0]), new Date(w[1])).forEach((e) => {
        const key = c.calendar.getId() + '|' + e.getId() + '|' + e.getStartTime().getTime();
        if (seen[key]) return;
        seen[key] = true;
        out.push({ event: e, isProvisional: c.isProvisional });
      });
    });
  });
  return out;
}

function describeEvent_(e) {
  const allDay = e.isAllDayEvent();
  const start = allDay ? e.getAllDayStartDate() : e.getStartTime();
  const end = allDay ? e.getAllDayEndDate() : e.getEndTime();
  return {
    title: e.getTitle(),
    when: allDay ? formatJst_(start, true) + ' 終日' : formatJst_(start, false) + ' 〜 ' + formatJst_(end, false),
    location: e.getLocation(),
    description: e.getDescription(),
  };
}

function describeExtracted_(ev, mailSubject) {
  return {
    title: ev.title,
    when: ev.allDay
      ? formatJst_(ev.start, true) + ' 終日'
      : formatJst_(ev.start, false) + ' 〜 ' + formatJst_(ev.end, false),
    location: ev.location,
    mailSubject: mailSubject,
  };
}

/**
 * ⑤ 既存予定1件ずつ同一判定する。stateに複数の予定を混ぜると判定がぼやける。
 * @return {Array<{isSame: ?number, relation: ?Object, described: Object}>}
 */
function judgeSameEvents_(found, ev, mail) {
  const extracted = describeExtracted_(ev, mail.subject);
  return found.map((f) => {
    const described = describeEvent_(f.event);
    const a = jevAsk_(sameEventState_(described, extracted), sameEventQuestions_());
    return { isSame: a.is_same_event, relation: a.relation, described: described };
  });
}

/**
 * ⑥ 決定した動作を実行する。
 * @return {{action: string, note: ?string}} 実際に行った動作（段階制限で通知に落ちた場合を含む）
 */
function applyCalendarAction_(decision, ev, mail, found, stage) {
  const target = decision.index >= 0 ? found[decision.index] : null;
  const writeCal =
    stage >= CAL_STAGE.MAIN ? mainCalendar_() : provisionalCalendar_(true);

  switch (decision.action) {
    case 'create': {
      const e = createEvent_(writeCal, ev, mail);
      return { action: 'create', note: stage >= CAL_STAGE.MAIN ? '本カレンダー' : '仮登録: ' + e.getId() };
    }
    case 'update':
    case 'mark_cancelled': {
      if (stage < CAL_STAGE.MAIN && !target.isProvisional) {
        notifyCalendar_(mail, ev, decision.action + '（本カレンダーの予定なので変更せず）');
        return { action: 'notify', note: '段階4では本カレンダーを変更しない' };
      }
      try {
        if (decision.action === 'update') updateEventTime_(target.event, ev, mail);
        else markCancelled_(target.event, mail);
        return { action: decision.action, note: null };
      } catch (e) {
        // 招待された予定など、自分が所有していない予定は変更できない
        notifyCalendar_(mail, ev, decision.action + ' に失敗: ' + e.message);
        return { action: 'notify', note: '変更失敗: ' + e.message };
      }
    }
    case 'notify':
      notifyCalendar_(mail, ev, decision.reason);
      return { action: 'notify', note: null };
    default:
      return { action: decision.action, note: null }; // none / skip
  }
}

function createEvent_(cal, ev, mail) {
  const options = { description: eventDescription_(ev, mail) };
  if (ev.location) options.location = ev.location;
  const e = ev.allDay
    ? cal.createAllDayEvent(ev.title, ev.start, new Date(ev.end.getTime() + 86400000), options)
    : cal.createEvent(ev.title, ev.start, ev.end, options);
  e.setTag('jev_message_id', mail.id);
  return e;
}

function updateEventTime_(e, ev, mail) {
  if (ev.allDay) e.setAllDayDates(ev.start, new Date(ev.end.getTime() + 86400000));
  else e.setTime(ev.start, ev.end);
  e.setDescription(
    (e.getDescription() || '') + `\n\n[Jev] ${formatJst_(new Date(), false)} 日時変更メールで更新: ${mailLink_(mail)}`
  );
}

function markCancelled_(e, mail) {
  const prefix = CONFIG.CAL.CANCEL_PREFIX;
  if (e.getTitle().indexOf(prefix) !== 0) e.setTitle(prefix + e.getTitle());
  e.setDescription((e.getDescription() || '') + `\n\n[Jev] 中止連絡: ${mailLink_(mail)}`);
}

function eventDescription_(ev, mail) {
  const lines = [];
  if (ev.onlineUrl) lines.push('オンライン: ' + ev.onlineUrl);
  if (ev.attendees.length) lines.push('参加者: ' + ev.attendees.join('、'));
  if (ev.note) lines.push('注記: ' + ev.note);
  lines.push('', '[Jev] メールから自動登録', '件名: ' + mail.subject, '差出人: ' + mail.from, mailLink_(mail));
  return lines.join('\n');
}

function mailLink_(mail) {
  return 'https://mail.google.com/mail/u/0/#all/' + mail.threadId;
}

/**
 * 登録も更新もしないときの通知。
 * スクリプトプロパティ NOTIFY_EMAIL があればそのアドレスへメールする。無ければログのみ。
 */
function notifyCalendar_(mail, ev, reason) {
  const when = ev ? describeExtracted_(ev, mail.subject).when : '(日時不明)';
  const body = [
    '予定の自動登録を見送りました。確認してください。',
    '',
    '理由: ' + reason,
    '件名: ' + mail.subject,
    '差出人: ' + mail.from,
    '抽出した日時: ' + when,
    mailLink_(mail),
  ].join('\n');
  console.log('[calendar notify] ' + body.replace(/\n/g, ' | '));
  const to = prop_('NOTIFY_EMAIL');
  if (to) GmailApp.sendEmail(to, '[Jev予定] 要確認: ' + mail.subject, body);
}


// ===== Log.js =========================================================

/**
 * 判定ログ（スプレッドシート）。全判定を残す。これが検証の土台になる。
 *
 * トリアージのログは既存スクリプトと同じスプレッドシート（LOG_SHEET_ID）の先頭シートに、
 * 同じ列で書く。予定登録のログは同じスプレッドシートの別シートに書く。
 *
 * 「自己判定」列を手で埋めていくと、自分の感覚とシステムの判定のズレがそのまま教師データになる。
 */

const LOG_HEADERS = [
  '受信日時', '送信者', '件名', 'スコア', '判定', '自己判定',
  '分類', '分類確信度', '緊急度', '緊急度確信度', '期限日数',
  '要返信', '名指し', '期限あり', '金銭', 'トラブル', '私信', '自動送信',
];

const CAL_LOG_HEADERS = [
  '記録日時',
  'モード',
  '受信日時',
  '送信者',
  '件名',
  'has_schedule',
  'i_participate',
  'schedule_type',
  '抽出した開始日時',
  '抽出した件名',
  '既存予定の件数',
  '照合した既存予定',
  'relation',
  '実行した動作',
  '理由',
  '補足',
  '自己判定',
  'messageId',
];

function logSpreadsheet_() {
  const id = prop_('LOG_SHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      /* 消されていたら作り直す */
    }
  }
  const ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
  const sheet = ss.getSheets()[0];
  sheet.appendRow(LOG_HEADERS);
  sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  setProp_('LOG_SHEET_ID', ss.getId());
  console.log('ログシートを作成しました: ' + ss.getUrl());
  return ss;
}

function getLogSheet_() {
  return logSpreadsheet_().getSheets()[0];
}

function getCalLogSheet_() {
  const ss = logSpreadsheet_();
  let sh = ss.getSheetByName(CONFIG.CAL_LOG_SHEET_NAME);
  if (!sh) {
    // 末尾に追加する。先頭シートはトリアージのログのまま
    sh = ss.insertSheet(CONFIG.CAL_LOG_SHEET_NAME, ss.getSheets().length);
    sh.appendRow(CAL_LOG_HEADERS);
    sh.getRange(1, 1, 1, CAL_LOG_HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function r2_(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : '';
}

function fmtChoice_(c) {
  if (!c || c.choice === null || c.choice === undefined) return '';
  return typeof c.confidence === 'number' ? `${c.choice} (${r2_(c.confidence)})` : c.choice;
}

function logToSheet_(mail, a, result) {
  getLogSheet_().appendRow([
    mail.date,
    mail.from,
    mail.subject,
    result.score,
    result.bucket,
    '', // 自己判定：ここは手で埋める
    result.category || '',
    r2_(result.categoryConf),
    r2_(a.urgency && a.urgency.score),
    r2_(a.urgency && a.urgency.confidence),
    result.deadlineDays === null || result.deadlineDays === undefined ? '' : result.deadlineDays,
    r2_(a.needs_reply),
    r2_(a.addressed_to_me),
    r2_(a.has_deadline),
    r2_(a.involves_money),
    r2_(a.is_trouble),
    r2_(a.is_personal),
    r2_(a.is_automated),
  ]);
}

function logCalendar_(mode, mail, a, row) {
  getCalLogSheet_().appendRow([
    new Date(),
    mode,
    mail.date,
    mail.from,
    mail.subject,
    r2_(a.has_schedule),
    r2_(a.i_participate),
    fmtChoice_(a.schedule_type),
    row.ev ? formatJst_(row.ev.start, row.ev.allDay) : '',
    row.ev ? row.ev.title : '',
    row.existingCount === null ? '' : row.existingCount,
    row.matched || '',
    row.relation || '',
    row.action,
    row.reason || '',
    row.note || '',
    '', // 自己判定：ここは手で埋める
    mail.id,
  ]);
}

/** ログシートのURLを表示する */
function showLogSheet() {
  const id = prop_('LOG_SHEET_ID');
  console.log(id ? SpreadsheetApp.openById(id).getUrl() : 'まだ作成されていません');
}


// ===== Main.js ========================================================

/**
 * Gmail × Jev メールトリアージ ＋ メール→カレンダー自動登録
 * ---------------------------------------------------------------
 *   setup()           初回に1回。ラベル・ログシート・開始日・5分おきトリガーを用意する
 *   triageInbox()     トリガーから呼ばれる本処理
 *   dryRun()          ラベルもマーカーも付けず、カレンダーにも書かず、採点と記録だけ行う
 *   previewCalendar() 直近7日のメールでカレンダー登録がどうなるかを見る（書き込みなし）
 *   explainMail()     EXPLAIN_QUERY に一致するメールが、なぜその判定になったかを見る
 *   stop()            自動実行を止める
 *   countTargets()    今の設定で何件が対象になるかを数えるだけ
 *   resetDailyCount() 1日あたり上限のカウントをリセットする
 *   rerunAll()        トリアージの判定をやり直す（_jev マーカーを外す）
 *   showLogSheet()    ログシートのURLを表示する
 *
 * 1通につき Jev へのリクエストは1回（① トリアージ9問＋② 予定判定3問をまとめる）。
 * 何問詰めても追加の待ち時間はほぼゼロなので、質問は惜しまない。
 *
 * 【ラベルの色】Apps Scriptからは色を設定できないので、Gmailの画面で手動で付ける。
 */

function setup() {
  ensureLabels_();
  getLogSheet_();
  if (calStage_() >= CAL_STAGE.JUDGE) getCalLogSheet_();
  if (calStage_() >= CAL_STAGE.PROVISIONAL) provisionalCalendar_(true);

  // 開始日を今日に固定する。これより前のメールは永久に対象外
  if (!prop_('START_DATE')) {
    const today = jstYmd_(new Date(), '/');
    setProp_('START_DATE', today);
    console.log(`開始日を ${today} に設定しました。これより前のメールは処理しません。`);
  } else {
    console.log(`開始日は ${prop_('START_DATE')} のままです。`);
  }

  // 既存トリガーを消してから登録（重複防止）
  deleteTriggers_();
  ScriptApp.newTrigger('triageInbox').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();

  console.log(`セットアップ完了。5分おきに triageInbox が動きます（カレンダー登録の段階: ${calStage_()}）。`);
}

/** 自動実行を止める。ラベルやログはそのまま残る */
function stop() {
  const n = deleteTriggers_();
  console.log(`トリガーを ${n} 件削除しました。判定は止まります。`);
}

function deleteTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'triageInbox') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}

function triageInbox() {
  run_(false);
}

/**
 * 閾値を決める前に、まずこれで手元の感覚と合っているか確かめる。
 * ラベルは付けず、ログに採点結果だけ出す。
 */
function dryRun() {
  run_(true);
}

/**
 * 今届いているメールで、カレンダー登録が「どうなるか」を見る。
 * CAL_STAGE に関係なく ④⑤ の照合まで行うが、カレンダー・ラベル・マーカーには一切書かない。
 * 対象は直近7日（処理済みかどうかは問わない）。日次上限にも数えない。
 * 結果は実行ログに一覧で出し、予定登録ログにもモード「preview」で残す。
 */
function previewCalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    const startedAt = Date.now();
    const ctx = { dry: true, stage: CAL_STAGE.MATCH, me: myAddresses_(), domains: internalDomains_() };
    const threads = GmailApp.search(CONFIG.CAL_QUERY + ' newer_than:7d', 0, CONFIG.MAX_THREADS);
    const lines = [];

    threads.forEach((thread) => {
      if (Date.now() - startedAt > CONFIG.RUN_TIME_BUDGET_MS) return;
      const msg = pickMessage_(thread, ctx.me);
      if (!msg) return;
      const mail = toMail_(msg, thread, ctx.domains);
      try {
        const answers = jevAsk_(buildState_(mail), SCHEDULE_QUESTIONS);
        const row = calendarOne_(mail, answers, ctx);
        logCalendar_('preview', mail, answers, row);
        lines.push({ row: row, text: previewLine_(mail, row) });
      } catch (e) {
        lines.push({ row: { action: 'error' }, text: `⚠️ エラー | ${mail.subject} | ${e.message}` });
      }
    });

    // 予定として扱われたものを上に
    const rank = (a) => (/^would:/.test(a) ? 0 : a === 'notify' || a === 'error' ? 1 : 2);
    lines.sort((x, y) => rank(x.row.action) - rank(y.row.action));
    console.log(`直近7日の ${lines.length} 通（カレンダーには書き込んでいません）`);
    lines.forEach((l) => console.log(l.text));
    if (Date.now() - startedAt > CONFIG.RUN_TIME_BUDGET_MS) console.log('時間切れのため途中まで');
  } finally {
    lock.releaseLock();
  }
}

const PREVIEW_ACTIONS = {
  'would:create': '📅 新規登録する',
  'would:none': '✅ 登録済みなので何もしない',
  'would:update': '🔁 既存予定の日時を更新する',
  'would:mark_cancelled': '🚫 既存予定に【中止】を付ける',
  'would:notify': '🔔 迷うので通知のみ',
  'would:skip': '― 何もしない',
  notify: '🔔 通知のみ',
  error: '⚠️ エラー',
  skip: '― 予定ではない',
};

const PREVIEW_REASONS = {
  no_schedule: '予定の連絡ではない',
  not_participant: '自分は参加者ではない',
  ml_not_personal: 'ML の一斉連絡で、自分が出席者か分からない',
  not_schedule: '予定ではない',
  proposal: '日程調整中（候補提示）',
  low_confidence_type: '予定の種類の判定が曖昧',
  no_datetime: '日時を抽出できなかった',
  no_existing: '近くに既存予定なし',
  all_unrelated: '近くの予定はすべて別件',
  already_registered: '同じ予定が既にある',
  rescheduled: '日時変更',
  cancelled: '中止',
  cancel_without_existing: '中止連絡だが対象の予定がない',
  cancel_without_match: '中止連絡だが対象の予定がない',
  relation_cannot_tell: '既存予定との関係が判断できない',
  low_confidence_relation: '既存予定との関係の判定が曖昧',
};

function previewLine_(mail, row) {
  const parts = [PREVIEW_ACTIONS[row.action] || row.action, mail.subject.slice(0, 40)];
  if (row.ev) parts.push(`${formatJst_(row.ev.start, row.ev.allDay)} ${row.ev.title}`);
  if (row.matched) parts.push('既存: ' + row.matched);
  parts.push(PREVIEW_REASONS[row.reason] || row.reason || '');
  if (row.note) parts.push(row.note);
  return parts.filter(Boolean).join(' | ');
}

/**
 * 1通のメールが「なぜラベルが付かなかったか」を調べる。
 * スクリプトプロパティ EXPLAIN_QUERY に Gmail の検索条件（例: subject:"Third Bridge"）を入れて実行する。
 * 1. 処理対象に入っていたか（開始日・プロモーション/ソーシャル・既読・マーカー）
 * 2. Jev にもう一度聞いて採点の内訳を出す（ラベルもログも書かない。Jev を1回呼ぶ）
 */
function explainMail() {
  const query = prop_('EXPLAIN_QUERY');
  if (!query) {
    console.log('スクリプトプロパティ EXPLAIN_QUERY に検索条件を入れてください（例: subject:"Third Bridge"）');
    return;
  }
  const threads = GmailApp.search(query, 0, 3);
  if (!threads.length) {
    console.log(`「${query}」に一致するメールがありません`);
    return;
  }
  const start = prop_('START_DATE');
  const me = myAddresses_();
  const domains = internalDomains_();

  threads.forEach((thread) => {
    const msg = pickMessage_(thread, me);
    if (!msg) return;
    const mail = toMail_(msg, thread, domains);
    const labels = thread.getLabels().map((l) => l.getName());
    console.log(`==== ${mail.subject}`);
    console.log(`差出人: ${mail.from} / 受信: ${formatJst_(mail.date, false)}`);
    console.log(`ラベル: ${labels.join(', ') || '(なし)'}`);

    // 1. 処理対象に入っていたか
    const inCategory = (cat) => GmailApp.search(`${query} category:${cat}`, 0, 50).some((t) => t.getId() === thread.getId());
    const reasons = [];
    if (start && jstYmd_(mail.date, '/') < start.replace(/-/g, '/')) reasons.push(`開始日 ${start} より前`);
    if (inCategory('promotions')) reasons.push('プロモーションタブ（検索条件 -category:promotions で除外）');
    if (inCategory('social')) reasons.push('ソーシャルタブ（検索条件 -category:social で除外）');
    if (labels.indexOf(CONFIG.LABELS.PROCESSED) < 0) {
      if (!thread.isUnread()) reasons.push('判定前に既読になった可能性（トリアージは未読のみ対象）');
      else reasons.push('まだ処理されていない（日次上限か、次回の実行待ち）');
    }
    console.log(
      labels.indexOf(CONFIG.LABELS.PROCESSED) >= 0
        ? '処理状況: 判定済み（_jev あり）。以下は再採点'
        : `処理状況: 判定されていない → ${reasons.join(' / ') || '原因不明'}`
    );
    if (reasons.length && labels.indexOf(CONFIG.LABELS.PROCESSED) >= 0) console.log('参考: ' + reasons.join(' / '));

    // 2. 採点の内訳（Jev の判定は毎回わずかに揺れるので、当時の値はログシートを見る）
    const a = jevAsk_(buildState_(mail), TRIAGE_QUESTIONS);
    const r = triageOne_(mail, a);
    console.log(`再採点: ${r.score}点 [${r.bucket}]（HIGH ≥ ${CONFIG.THRESHOLD_HIGH}, MEDIUM ≥ ${CONFIG.THRESHOLD_MEDIUM}）`);
    r.parts.forEach((p) => console.log('  ' + p));
    console.log(
      `  Jev: 名指し=${r2_(a.addressed_to_me)} 私信=${r2_(a.is_personal)} 自動送信=${r2_(a.is_automated)} 分類=${fmtChoice_(a.category)}`
    );
  });
}

function run_(dry) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return; // 前回の実行がまだ終わっていない
  try {
    runLocked_(dry);
  } finally {
    lock.releaseLock();
  }
}

function runLocked_(dry) {
  const startedAt = Date.now();
  const stage = calStage_();

  const budget = dry ? CONFIG.MAX_THREADS : remainingToday_();
  if (budget <= 0) {
    console.log(`本日の上限 ${CONFIG.MAX_PER_DAY} 件に達しています。処理をスキップします。`);
    return;
  }
  const limit = Math.min(CONFIG.MAX_THREADS, budget);
  const targets = findTargets_(stage, dry, limit);
  const ctx = { dry: dry, stage: stage, me: myAddresses_(), domains: internalDomains_(), ranking: [] };

  let done = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - startedAt > CONFIG.RUN_TIME_BUDGET_MS) {
      console.log('実行時間の上限に近づいたので残りは次回');
      break;
    }
    try {
      processThread_(targets[i], ctx);
      done++;
    } catch (e) {
      // マーカーを付けずに残すので次回また拾う
      console.error(`失敗: ${targets[i].thread.getFirstMessageSubject()} / ${e.message}`);
      failed++;
    }
  }

  if (dry) {
    // 点数順に並べる。絶対値ではなく「並び順」が自分の感覚と合うかを見る
    ctx.ranking.sort((x, y) => y.score - x.score);
    ctx.ranking.forEach((r) => console.log(`${r.score}点 [${r.bucket}] ${r.subject.slice(0, 50)}`));
    console.log('--- 詳細はログシートを見てください（showLogSheet で URL 表示）---');
    return;
  }

  // 失敗も数える。同じメールで失敗し続けても1日の上限で止まる
  consumeToday_(done + failed);
  console.log(`処理 ${done}件 / 失敗 ${failed}件（本日の残り ${remainingToday_()}件）`);
}

/**
 * 処理対象のスレッドを集める。
 * トリアージは未読のみ（既存どおり）。予定判定は既読でも対象にする。
 * 処理済みマーカーは検索クエリで除外する（検索後に飛ばすと、未読のまま残った処理済みスレッドが
 * 1回あたりの枠を埋め続けて新着が処理されなくなる）。
 */
function findTargets_(stage, dry, limit) {
  const after = ' after:' + startDate_(dry);
  const needCal = stage >= CAL_STAGE.JUDGE;
  const map = {};
  const add = (threads, key) =>
    threads.forEach((t) => {
      const id = t.getId();
      if (!map[id]) map[id] = { thread: t, needTriage: false, needCal: false };
      map[id][key] = true;
    });

  const triageMark = dry ? '' : ` -label:${CONFIG.LABELS.PROCESSED}`;
  const calMark = dry ? '' : ` -label:${CONFIG.LABELS.CAL_PROCESSED}`;
  add(GmailApp.search(CONFIG.TRIAGE_QUERY + after + triageMark, 0, limit), 'needTriage');
  if (needCal) add(GmailApp.search(CONFIG.CAL_QUERY + after + calMark, 0, limit), 'needCal');

  return Object.keys(map)
    .map((k) => map[k])
    .slice(0, limit);
}

function startDate_(dry) {
  const start = prop_('START_DATE');
  if (start) return start.replace(/-/g, '/');
  if (dry) return jstYmd_(new Date(Date.now() - 3 * 86400000), '/');
  throw new Error('開始日が未設定です。先に setup() を実行してください。');
}

/** 今の設定で何件が対象になるかを、処理せずに数えるだけ */
function countTargets() {
  const after = ' after:' + startDate_(false);
  const triage = GmailApp.search(CONFIG.TRIAGE_QUERY + after + ` -label:${CONFIG.LABELS.PROCESSED}`, 0, 500);
  console.log(`トリアージ対象: ${triage.length}件（500で打ち切り）`);
  if (calStage_() >= CAL_STAGE.JUDGE) {
    const cal = GmailApp.search(CONFIG.CAL_QUERY + after + ` -label:${CONFIG.LABELS.CAL_PROCESSED}`, 0, 500);
    console.log(`予定判定対象: ${cal.length}件（500で打ち切り）`);
  }
  console.log(`本日の残り処理枠: ${remainingToday_()}件`);
}

function processThread_(target, ctx) {
  const thread = target.thread;
  const msg = pickMessage_(thread, ctx.me);
  if (!msg) {
    // 自分が送ったメールだけのスレッドなど。判定対象がないので処理済みにする
    if (!ctx.dry) markDone_(thread, target);
    return;
  }

  const mail = toMail_(msg, thread, ctx.domains);
  const questions = []
    .concat(target.needTriage ? TRIAGE_QUESTIONS : [])
    .concat(target.needCal ? SCHEDULE_QUESTIONS : []);
  const answers = jevAsk_(buildState_(mail), questions);

  if (target.needTriage) {
    const r = triageOne_(mail, answers);
    if (!ctx.dry) {
      const labelName = CONFIG.LABELS[r.bucket]; // LOW はラベルを付けない
      if (labelName) thread.addLabel(label_(labelName));
      if (r.bucket === 'HIGH') notifyUrgent_(mail, r);
    }
    logToSheet_(mail, answers, r);
    ctx.ranking.push({ score: r.score, bucket: r.bucket, subject: mail.subject });
    console.log(`[${r.bucket}] ${mail.subject} (score ${r.score} / ${r.category})`);
  }

  if (target.needCal) {
    const row = calendarOne_(mail, answers, ctx);
    logCalendar_(ctx.dry ? 'dry-run' : '本番', mail, answers, row);
  }

  if (!ctx.dry) markDone_(thread, target);
}

function markDone_(thread, target) {
  if (target.needTriage) thread.addLabel(label_(CONFIG.LABELS.PROCESSED));
  if (target.needCal) thread.addLabel(label_(CONFIG.LABELS.CAL_PROCESSED));
}

function triageOne_(mail, a) {
  // 期限の日数は has_deadline が立ったときだけ計算する
  const deadlineDays = a.has_deadline > 0.5 ? daysUntilDeadline_(mail.fullBody, mail.date) : null;
  const r = scoreTriage_(a, { deadlineDays: deadlineDays, isExternal: mail.isExternal });
  r.deadlineDays = deadlineDays;
  return r;
}

/**
 * ②〜⑥。段階（CAL_STAGE）より先には進まない。dry-run と段階3以下では何も書き込まない。
 */
function calendarOne_(mail, a, ctx) {
  const row = { ev: null, existingCount: null, matched: null, relation: null, action: '', reason: '', note: '' };
  const writes = !ctx.dry && ctx.stage >= CAL_STAGE.PROVISIONAL;

  // ② 予定を含むか
  const gate = scheduleGate_(a, { isMailingList: mail.isMailingList });
  row.reason = gate.reason;
  if (mail.isMailingList) row.note = `ML personally_invited=${r2_(a.personally_invited)}`;
  if (!gate.proceed) {
    row.action = gate.notifyOnly ? 'notify' : 'skip';
    if (gate.notifyOnly && writes) notifyCalendar_(mail, null, gate.reason);
    return row;
  }
  if (ctx.stage < CAL_STAGE.EXTRACT) {
    row.action = 'judged';
    return row;
  }

  // ③ 抽出
  const ex = extractEvent_(mail);
  if (!ex.ok) {
    row.action = 'error';
    row.note = '抽出失敗: ' + ex.error;
    return row;
  }
  const ev = normalizeExtraction_(ex.data, mail.subject);
  if (!ev) {
    row.action = 'notify';
    row.reason = 'no_datetime';
    if (writes) notifyCalendar_(mail, null, '日時を抽出できなかった');
    return row;
  }
  row.ev = ev;
  row.note = [row.note, ev.note].filter(Boolean).join(' / ');
  if (ctx.stage < CAL_STAGE.MATCH) {
    row.action = 'extracted';
    return row;
  }

  // ④ 照合 → ⑤ 同一判定（0件なら Jev を呼ばない）
  const found = findNearbyEvents_(ev, matchCalendars_());
  row.existingCount = found.length;
  const matches = found.length ? judgeSameEvents_(found, ev, mail) : [];
  const decision = decideCalendarAction_(gate.reason, matches);
  row.reason = decision.reason;
  if (decision.index >= 0) {
    const m = matches[decision.index];
    row.matched = `${m.described.title} ${m.described.when}${found[decision.index].isProvisional ? '（仮登録）' : ''}`;
    row.relation = `${fmtChoice_(m.relation)} / same=${r2_(m.isSame)}`;
  } else if (matches.length) {
    row.matched = matches.map((m) => `${m.described.title}(${r2_(m.isSame)})`).join('; ');
  }

  // ⑥ 登録
  if (!writes) {
    row.action = 'would:' + decision.action;
    return row;
  }
  const done = applyCalendarAction_(decision, ev, mail, found, ctx.stage);
  row.action = done.action;
  if (done.note) row.note = [row.note, done.note].filter(Boolean).join(' / ');
  return row;
}

/** スレッドの中で判定する1通：自分以外が送った最新のメッセージ。 */
function pickMessage_(thread, me) {
  const msgs = thread.getMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (me.indexOf(emailOf_(msgs[i].getFrom())) < 0) return msgs[i];
  }
  return null;
}

function toMail_(msg, thread, domains) {
  const fullBody = msg.getPlainBody();
  return {
    id: msg.getId(),
    threadId: thread.getId(),
    subject: msg.getSubject(),
    from: msg.getFrom(),
    date: msg.getDate(),
    isExternal: isExternalSender_(msg.getFrom(), domains),
    isMailingList: isMailingList_(listHeaders_(msg), msg.getSubject()),
    toCount: (msg.getTo() + ',' + msg.getCc()).split(',').filter((s) => s.trim()).length,
    body: fullBody.slice(0, CONFIG.BODY_LIMIT),
    fullBody: fullBody,
  };
}

function listHeaders_(msg) {
  const h = (name) => {
    try {
      return msg.getHeader(name) || '';
    } catch (e) {
      return '';
    }
  };
  return { listId: h('List-Id'), listPost: h('List-Post'), precedence: h('Precedence') };
}

/** Jev に渡す state（既存スクリプトと同じ形）。社外判定と宛先人数はヘッダから分かるのでコード側で入れる */
function buildState_(mail) {
  return {
    subject: mail.subject,
    from: mail.from,
    is_external: mail.isExternal,
    to_count: mail.toCount,
    body: mail.body,
  };
}

function myAddresses_() {
  const list = [Session.getActiveUser().getEmail()].concat(GmailApp.getAliases());
  return list.filter(Boolean).map((s) => s.toLowerCase());
}

function emailOf_(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function ensureLabels_() {
  const out = {};
  Object.keys(CONFIG.LABELS).forEach((key) => {
    out[key] = label_(CONFIG.LABELS[key]);
  });
  return out;
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function jstYmd_(date, sep) {
  const p = jstParts_(date);
  const s = sep || '-';
  return `${p.y}${s}${String(p.m).padStart(2, '0')}${s}${String(p.d).padStart(2, '0')}`;
}

// ===== 処理量の制御（既存スクリプトと同じ DAILY_COUNT を使う）=====

/** 今日あと何件処理できるか */
function remainingToday_() {
  const raw = prop_('DAILY_COUNT');
  const rec = raw ? JSON.parse(raw) : null;
  const today = jstYmd_(new Date());
  const used = rec && rec.date === today ? rec.count : 0;
  return Math.max(CONFIG.MAX_PER_DAY - used, 0);
}

function consumeToday_(n) {
  if (n <= 0) return;
  const raw = prop_('DAILY_COUNT');
  const rec = raw ? JSON.parse(raw) : null;
  const today = jstYmd_(new Date());
  const used = rec && rec.date === today ? rec.count : 0;
  setProp_('DAILY_COUNT', JSON.stringify({ date: today, count: used + n }));
}

/** 上限をリセットする。今日もう少しだけ回したいとき用 */
function resetDailyCount() {
  PropertiesService.getScriptProperties().deleteProperty('DAILY_COUNT');
  console.log('本日のカウントをリセットしました');
}

// ===== やり直し・移行 ============================================

/**
 * トリアージの判定をやり直す。_jev マーカーと重要度ラベルを外すので、
 * 次の実行で同じメールがもう一度評価される。質問文や重みを変えたあとに使う。
 */
function rerunAll() {
  const mark = GmailApp.getUserLabelByName(CONFIG.LABELS.PROCESSED);
  if (!mark) {
    console.log('マーカーラベルがありません');
    return;
  }
  const levels = [CONFIG.LABELS.HIGH, CONFIG.LABELS.MEDIUM]
    .map((n) => GmailApp.getUserLabelByName(n))
    .filter(Boolean);
  const threads = mark.getThreads(0, 200);
  threads.forEach((t) => {
    t.removeLabel(mark);
    levels.forEach((l) => t.removeLabel(l));
  });
  console.log(`${threads.length} 件の判定をリセットしました`);
}

/**
 * 旧バージョンのラベルを削除する。ラベルを消してもメール本体には影響しない。
 * 名前を変えたあとに一度だけ実行する。
 */
function cleanupOldLabels() {
  ['_jev済', '01_要即対応', '03_あとで'].forEach((name) => {
    const l = GmailApp.getUserLabelByName(name);
    if (l) {
      l.deleteLabel();
      console.log('削除: ' + name);
    }
  });
  console.log('完了。次に rerunAll() ではなく triageInbox() を実行してください。');
}
