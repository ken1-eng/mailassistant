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
    question: 'このメールは日時の指定を伴う予定（会議、面談、訪問、イベントなど）の連絡か',
  },
  {
    name: 'i_participate',
    type: 'noul',
    question:
      '受信者本人がその予定に参加する立場か（他人同士の予定の共有や、参考として転送されただけのものは含まない）',
  },
  {
    name: 'schedule_type',
    type: 'choice',
    question: 'このメールの予定に関する連絡の種類はどれか',
    // 「予定ではない」という棄権の選択肢を必ず入れる
    criteria: {
      confirmed: '確定：日時が決まった予定の案内や招待',
      proposal: '候補提示：日時の候補を挙げて都合を聞いている、または日程を調整しようとしている',
      change: '変更連絡：既に決まっていた予定の日時や場所の変更',
      cancel: '中止連絡：既に決まっていた予定の中止や延期（新しい日時は未定）',
      not_schedule: '予定ではない：予定の連絡ではない、または判断できない',
    },
  },
];

function sameEventQuestions_() {
  return [
    {
      name: 'is_same_event',
      type: 'noul',
      question: '「既存の予定」と「メールの予定」は同一の予定を指しているか',
    },
    {
      name: 'relation',
      type: 'choice',
      question: '「メールの予定」は「既存の予定」に対してどういう関係か',
      criteria: {
        same: '同一：同じ予定で、日時も変わっていない',
        rescheduled: '同一だが日時変更：同じ予定の日時が変わった',
        cancelled: '同一だが中止：同じ予定が中止になった',
        unrelated: '無関係：別の予定',
        cannot_tell: '判断できない',
      },
    },
  ];
}

/**
 * ② の結果から、③ 以降に進むかを決める。
 * @return {{proceed: boolean, notifyOnly: boolean, reason: string}}
 */
function scheduleGate_(a) {
  const th = CONFIG.CAL.THRESHOLDS;
  const v = (k) => (a[k] === null || a[k] === undefined ? 0 : a[k]);
  const type = a.schedule_type || {};

  if (v('has_schedule') < th.HAS_SCHEDULE) return gate_(false, false, 'no_schedule');
  if (v('i_participate') < th.I_PARTICIPATE) return gate_(false, false, 'not_participant');
  if (!type.choice || type.choice === 'not_schedule') return gate_(false, false, 'not_schedule');
  // 候補提示を登録すると日程調整の往復がすべてカレンダーに入って壊れる
  if (type.choice === 'proposal') return gate_(false, false, 'proposal');
  if ((type.confidence || 0) < th.SCHEDULE_TYPE_CONFIDENCE) return gate_(false, true, 'low_confidence_type');
  return gate_(true, false, type.choice);
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
  const lines = [
    '【既存の予定】',
    '件名: ' + existing.title,
    '日時: ' + existing.when,
  ];
  if (existing.location) lines.push('場所: ' + existing.location);
  if (existing.description) lines.push('メモ: ' + existing.description.slice(0, 300));
  lines.push('', '【メールの予定】', '件名: ' + (extracted.title || '(不明)'), '日時: ' + extracted.when);
  if (extracted.location) lines.push('場所: ' + extracted.location);
  if (extracted.mailSubject) lines.push('メール件名: ' + extracted.mailSubject);
  return lines.join('\n');
}
