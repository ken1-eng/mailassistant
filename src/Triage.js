/**
 * ① メール重要度分類（トリアージ）。
 *
 * 「このメールは重要か」と一問で聞かず、事実ベースの小さな質問に割って
 * 重み付けはコード側に置く。社外判定と宛先人数はヘッダから分かるので Jev に聞かない。
 * 日付も Jev に扱わせない（「期限が書かれているか」だけを聞き、残り日数はコードで計算）。
 */

const TRIAGE_QUESTIONS = [
  {
    name: 'needs_reply',
    type: 'noul',
    question: 'このメールは受信者に返信や回答を求めているか',
  },
  {
    name: 'has_deadline',
    type: 'noul',
    question: 'このメールに対応の期限や締切の記述があるか',
  },
  {
    name: 'addressed_to_me',
    type: 'noul',
    question: '受信者本人が名指しで対応を求められているか（一斉送信の案内ではないか）',
  },
  {
    name: 'involves_money',
    type: 'noul',
    question: '業務上の金銭や契約に関わる内容か（私的な会費や割り勘は含まない）',
  },
  {
    name: 'is_trouble',
    type: 'noul',
    question: '障害、クレーム、謝罪要求を含むか',
  },
  {
    name: 'is_personal',
    type: 'noul',
    question: '業務ではなく私的な案内や連絡か（同期会、懇親会、個人的な誘いなど）',
  },
  {
    name: 'is_automated',
    type: 'noul',
    question: '人ではなく機械が自動送信したメールか（通知、配信、システムメール）',
  },
  {
    name: 'urgency',
    type: 'score',
    question: 'このメールへの対応はどのくらい急ぐか',
    // 各段階は「程度」ではなく「状況」で書く
    criteria: [
      '対応不要、または期限の目安がない',
      '1週間以上先までに対応すればよい',
      '今週中に対応が必要',
      '今日から明日のうちに対応が必要',
      '今すぐ対応しないと損害やトラブルになる',
    ],
  },
  {
    name: 'category',
    type: 'choice',
    question: 'このメールの種類はどれか',
    criteria: {
      request: '依頼：受信者に作業や対応を依頼している',
      scheduling: '日程調整：会議や面談の日時を決めようとしている',
      contract: '契約：見積、発注、契約、請求に関する連絡',
      trouble: 'トラブル：障害、クレーム、問題の報告',
      info: '情報共有：報告や共有で、対応は求めていない',
      sales: '営業：売り込み、宣伝、セミナー勧誘',
      notification: '通知：システムやサービスからの自動通知',
      other: 'その他：上のどれにも当てはまらない',
    },
  },
];

/**
 * 採点（0〜100点）。
 *
 * 緊急度は足し算ではなく掛け算。当初は40点満点の一項目にしていたが、
 * 緊急度ゼロのメールが他の加算で上位に来てしまった。
 * needs_reply は addressed_to_me で割り引く。一斉送信の案内でも出欠を求めれば
 * 返信は必要なので、足し算だと誰宛でもないメールが高得点になる。
 *
 * @param {Object} a parseJevAnswers_ の結果
 * @param {{deadlineDays: ?number, isExternal: boolean}} meta コード側で求めた値
 */
function scoreTriage_(a, meta) {
  const p = (k) => (a[k] === null || a[k] === undefined ? 0 : a[k]);

  if (p('is_automated') > 0.8) return 0;
  const cat = a.category || {};
  if (cat.choice === 'sales' && (cat.confidence || 0) > 0.7) return 0;

  const ownership = 0.25 + 0.75 * p('addressed_to_me');
  let score = 0;
  score += p('needs_reply') * ownership * 35;
  score += p('is_trouble') * 20;
  score += p('involves_money') * 15;
  score += deadlinePoints_(p('has_deadline'), meta.deadlineDays);
  score += meta.isExternal ? 5 : 0;

  const u = a.urgency || {};
  const urgency = u.score === null || u.score === undefined ? 0 : u.score;
  const conf = u.confidence === null || u.confidence === undefined ? 1 : u.confidence;
  const urgencyFactor = 0.25 + 0.75 * (urgency / 4) * Math.max(conf, 0.5);
  score *= urgencyFactor;

  score *= 1 - 0.6 * p('is_personal');

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 期限の近さ（最大25点）。日数はコードで計算したもの。 */
function deadlinePoints_(hasDeadline, days) {
  if (hasDeadline < 0.5 || days === null || days === undefined) return 0;
  let pts;
  if (days < -1) pts = 0; // 大きく過ぎた日付は参考情報とみなす
  else if (days <= 0) pts = 25;
  else if (days <= 1) pts = 20;
  else if (days <= 3) pts = 15;
  else if (days <= 7) pts = 10;
  else if (days <= 14) pts = 5;
  else pts = 0;
  return pts * hasDeadline;
}

function triageLabelFor_(score) {
  if (score >= CONFIG.TRIAGE.THRESHOLD_HIGH) return CONFIG.TRIAGE.LABEL_HIGH;
  if (score >= CONFIG.TRIAGE.THRESHOLD_MID) return CONFIG.TRIAGE.LABEL_MID;
  return null; // 34点以下は無印。ラベルが付いている＝見るべきもの
}

/**
 * 本文中の期限までの残り日数（日本時間の暦日ベース）。見つからなければ null。
 *
 * 年つき（2026/11/20）を先に探し、その部分を消してから年なし（11月20日）を探す。
 * 逆にすると 2026/11/20 から 26/11 を拾って月=26になる。
 * 複数あるときは、昨日以降で最も近い日付を採る。
 */
function daysUntilDeadline_(text, now) {
  if (!text) return null;
  const today = jstDayNumber_(now);
  const todayYear = jstParts_(now).y;
  const candidates = [];

  const withYear = /(?<!\d)(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})(?!\d)/g;
  let rest = text.replace(withYear, (m, y, mo, d) => {
    const dn = dayNumberOf_(Number(y), Number(mo), Number(d));
    if (dn !== null) candidates.push(dn - today);
    return ' ';
  });

  const noYear = /(?<![\d\/\-.])(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})(?![\d\/])/g;
  let m;
  while ((m = noYear.exec(rest)) !== null) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    let dn = dayNumberOf_(todayYear, mo, d);
    if (dn === null) continue;
    // 12月に届いた「1/10締切」は翌年とみなす
    if (dn - today < -60) dn = dayNumberOf_(todayYear + 1, mo, d);
    if (dn !== null) candidates.push(dn - today);
  }

  const upcoming = candidates.filter((x) => x >= -1).sort((x, y) => x - y);
  return upcoming.length ? upcoming[0] : null;
}

/** 日本時間の年月日。 */
function jstParts_(date) {
  const t = new Date(date.getTime() + CONFIG.TZ_OFFSET_HOURS * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function jstDayNumber_(date) {
  const p = jstParts_(date);
  return Date.UTC(p.y, p.m - 1, p.d) / 86400000;
}

/** 実在しない日付（2/30、月=26 など）は null。 */
function dayNumberOf_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime() / 86400000;
}

/** 送信元が社外か。INTERNAL_DOMAINS 未設定だと全部社外扱いになる。 */
function isExternalSender_(from, domains) {
  const m = String(from || '').match(/@([A-Za-z0-9.\-]+)/);
  if (!m) return true;
  const host = m[1].toLowerCase();
  return !domains.some((d) => host === d || host.endsWith('.' + d));
}

/**
 * 最優先メールの別チャネル通知（Slack 等）のフック。
 * 未実装。必要になったらここに Webhook 呼び出しを書く。
 */
function notifyUrgent_(mail, score) {
  console.log(`[urgent] ${score}点 ${mail.subject} <${mail.from}>`);
}
