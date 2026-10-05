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
