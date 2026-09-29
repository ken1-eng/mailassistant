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
