const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();
const plain = (v) => JSON.parse(JSON.stringify(v));

function sched(over) {
  return Object.assign(
    { has_schedule: 0.95, i_participate: 0.9, schedule_type: { choice: 'confirmed', confidence: 0.9 } },
    over
  );
}

test('scheduleGate_: 確定で閾値を超えれば進む', () => {
  assert.deepEqual(plain(g.scheduleGate_(sched({}))), { proceed: true, notifyOnly: false, reason: 'confirmed' });
});

test('scheduleGate_: has_schedule は 0.8 未満で落とす', () => {
  assert.equal(g.scheduleGate_(sched({ has_schedule: 0.79 })).reason, 'no_schedule');
});

test('scheduleGate_: 参加しない予定・候補提示・予定ではない は落とす', () => {
  assert.equal(g.scheduleGate_(sched({ i_participate: 0.5 })).reason, 'not_participant');
  assert.equal(g.scheduleGate_(sched({ schedule_type: { choice: 'proposal', confidence: 0.99 } })).reason, 'proposal');
  assert.equal(
    g.scheduleGate_(sched({ schedule_type: { choice: 'not_schedule', confidence: 0.99 } })).reason,
    'not_schedule'
  );
});

test('scheduleGate_: 種類の確信度が低ければ通知のみ', () => {
  const r = g.scheduleGate_(sched({ schedule_type: { choice: 'confirmed', confidence: 0.6 } }));
  assert.equal(r.proceed, false);
  assert.equal(r.notifyOnly, true);
});

const rel = (choice, confidence) => ({ choice, confidence });

test('decideCalendarAction_: 既存予定なし → 新規（中止連絡なら何もしない）', () => {
  assert.equal(g.decideCalendarAction_('confirmed', []).action, 'create');
  assert.equal(g.decideCalendarAction_('cancel', []).action, 'skip');
});

test('decideCalendarAction_: 全部無関係 → 新規', () => {
  const m = [{ isSame: 0.1, relation: rel('unrelated', 0.9) }];
  assert.equal(g.decideCalendarAction_('confirmed', m).action, 'create');
});

test('decideCalendarAction_: 同一なら何もしない（0.5以上で登録中止）', () => {
  const m = [
    { isSame: 0.2, relation: rel('unrelated', 0.9) },
    { isSame: 0.5, relation: rel('same', 0.8) },
  ];
  assert.deepEqual(plain(g.decideCalendarAction_('confirmed', m)), {
    action: 'none',
    index: 1,
    reason: 'already_registered',
  });
});

test('decideCalendarAction_: 日時変更 → 更新、中止 → 中止印', () => {
  assert.equal(g.decideCalendarAction_('change', [{ isSame: 0.9, relation: rel('rescheduled', 0.9) }]).action, 'update');
  assert.equal(
    g.decideCalendarAction_('cancel', [{ isSame: 0.9, relation: rel('cancelled', 0.9) }]).action,
    'mark_cancelled'
  );
});

test('decideCalendarAction_: 最も同一らしい予定を選ぶ', () => {
  const m = [
    { isSame: 0.6, relation: rel('same', 0.9) },
    { isSame: 0.95, relation: rel('rescheduled', 0.9) },
  ];
  const d = g.decideCalendarAction_('change', m);
  assert.equal(d.index, 1);
  assert.equal(d.action, 'update');
});

test('decideCalendarAction_: 迷ったら止める（確信度不足・矛盾・判断不能）', () => {
  assert.equal(g.decideCalendarAction_('confirmed', [{ isSame: 0.9, relation: rel('same', 0.5) }]).action, 'notify');
  assert.equal(
    g.decideCalendarAction_('confirmed', [{ isSame: 0.9, relation: rel('unrelated', 0.9) }]).action,
    'notify'
  );
  assert.equal(
    g.decideCalendarAction_('confirmed', [{ isSame: 0.3, relation: rel('cannot_tell', 0.9) }]).action,
    'notify'
  );
});

test('parseExtractResponse_: JSON を取り出す（コードブロック付きでも）', () => {
  const r = g.parseExtractResponse_({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '```json\n{"title":"A社定例","start":"2026-10-05T14:00:00+09:00"}\n```' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.title, 'A社定例');
});

test('parseExtractResponse_: 拒否・打ち切り・壊れたJSON', () => {
  assert.equal(g.parseExtractResponse_({ stop_reason: 'refusal', content: [] }).error, 'refusal');
  assert.equal(g.parseExtractResponse_({ stop_reason: 'max_tokens', content: [] }).error, 'max_tokens');
  const bad = g.parseExtractResponse_({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a": }' }] });
  assert.equal(bad.ok, false);
});

test('normalizeExtraction_: 終了時刻が無ければ1時間後にして注記を残す', () => {
  const ev = g.normalizeExtraction_(
    { title: 'A社定例MTG', start: '2026-10-05T14:00:00+09:00', end: null, all_day: false, confidence_note: null },
    '件名'
  );
  assert.equal(ev.start.toISOString(), '2026-10-05T05:00:00.000Z');
  assert.equal(ev.end.toISOString(), '2026-10-05T06:00:00.000Z');
  assert.match(ev.note, /1時間と仮定/);
});

test('normalizeExtraction_: 終日予定・開始なし・タイムゾーンなし', () => {
  const ev = g.normalizeExtraction_({ title: '研修', start: '2026-10-05', end: '2026-10-06', all_day: true }, 's');
  assert.equal(ev.allDay, true);
  assert.equal(ev.start.toISOString(), '2026-10-04T15:00:00.000Z');
  assert.equal(ev.end.toISOString(), '2026-10-05T15:00:00.000Z');

  assert.equal(g.normalizeExtraction_({ title: 'x', start: null }, 's'), null);

  const noTz = g.normalizeExtraction_({ title: 'x', start: '2026-10-05T09:30:00', end: '2026-10-05T10:00:00' }, 's');
  assert.equal(noTz.start.toISOString(), '2026-10-05T00:30:00.000Z');
  assert.equal(noTz.note, null);
});

test('formatJstWithWeekday_: 受信日時に曜日を付ける', () => {
  assert.equal(g.formatJstWithWeekday_(new Date('2026-09-29T01:00:00Z')), '2026-09-29T10:00:00+09:00（火曜日）');
});

test('isMailingList_: ヘッダと件名の通し番号で判定する', () => {
  const none = { listId: '', listPost: '', precedence: '' };
  assert.equal(g.isMailingList_({ listId: '<ex-ac.example.jp>', listPost: '', precedence: '' }, '案内'), true);
  assert.equal(g.isMailingList_({ listId: '', listPost: '', precedence: 'bulk' }, '案内'), true);
  assert.equal(g.isMailingList_(none, '[ex-ac:12814] 【exac全体オフ会準備】第2回準備会議について'), true);
  assert.equal(g.isMailingList_(none, 'Re: [ex-ac:12814] 第2回準備会議'), true);
  assert.equal(g.isMailingList_(none, '【重要なお知らせ】サービス改定'), false);
  assert.equal(g.isMailingList_(none, '[GitHub] Sudo email verification code'), false);
  assert.equal(g.isMailingList_(none, '打ち合わせのご案内'), false);
});

test('scheduleGate_: ML の一斉連絡は personally_invited が低ければ落とす', () => {
  const a = sched({ personally_invited: 0.3 });
  assert.equal(g.scheduleGate_(a, { isMailingList: true }).reason, 'ml_not_personal');
  // ML でなければ personally_invited は見ない
  assert.equal(g.scheduleGate_(a, { isMailingList: false }).proceed, true);
  assert.equal(g.scheduleGate_(a).proceed, true);
  // ML でも個人として招待されていれば通す
  assert.equal(g.scheduleGate_(sched({ personally_invited: 0.8 }), { isMailingList: true }).proceed, true);
});

test('scheduleGate_: 自分が出席を返していれば、候補提示や曖昧な種類でも確定として進む', () => {
  const meta = { hasMyReply: true };
  const low = sched({ i_accepted: 0.9, schedule_type: { choice: 'confirmed', confidence: 0.5 } });
  assert.deepEqual(plain(g.scheduleGate_(low, meta)), {
    proceed: true,
    notifyOnly: false,
    reason: 'confirmed',
    via: 'accepted',
  });
  const proposal = sched({ i_accepted: 0.9, schedule_type: { choice: 'proposal', confidence: 0.9 } });
  assert.equal(g.scheduleGate_(proposal, meta).reason, 'confirmed');
  // 自分の返信が無ければ i_accepted は見ない
  assert.equal(g.scheduleGate_(low, { hasMyReply: false }).reason, 'low_confidence_type');
  assert.equal(g.scheduleGate_(proposal).reason, 'proposal');
  // 出席表明が弱ければ従来どおり
  assert.equal(g.scheduleGate_(sched({ i_accepted: 0.5, schedule_type: { choice: 'proposal', confidence: 0.9 } }), meta).reason, 'proposal');
  // 予定でなければ出席表明があっても進まない
  assert.equal(g.scheduleGate_(sched({ has_schedule: 0.3, i_accepted: 0.9 }), meta).reason, 'no_schedule');
});

test('scheduleGate_: 出席表明があっても、確信できる変更・中止の連絡はそのまま', () => {
  const meta = { hasMyReply: true };
  const change = sched({ i_accepted: 0.9, schedule_type: { choice: 'change', confidence: 0.9 } });
  assert.equal(g.scheduleGate_(change, meta).reason, 'change');
  assert.equal(g.scheduleGate_(change, meta).via, undefined);
});

test('decideCalendarAction_: 同じ日の終日予定があれば、日時変更と判定されても登録済みとして扱う', () => {
  const m = [{ isSame: 0.9, relation: rel('rescheduled', 0.9), allDayCovers: true }];
  assert.deepEqual(plain(g.decideCalendarAction_('confirmed', m)), {
    action: 'none',
    index: 0,
    reason: 'already_registered_allday',
  });
  // 関係の確信度が低くても同じ
  assert.equal(
    g.decideCalendarAction_('confirmed', [{ isSame: 0.9, relation: rel('same', 0.5), allDayCovers: true }]).action,
    'none'
  );
  // 変更連絡なら従来どおり更新
  assert.equal(g.decideCalendarAction_('change', m).action, 'update');
  // 終日予定が別の日なら従来どおり
  assert.equal(
    g.decideCalendarAction_('confirmed', [{ isSame: 0.9, relation: rel('rescheduled', 0.9), allDayCovers: false }])
      .action,
    'update'
  );
});

test('allDayRangeCovers_: 終日予定の期間に時刻が入るか（終了日は排他的）', () => {
  const s = new Date('2026-10-06T00:00:00+09:00');
  const e = new Date('2026-10-08T00:00:00+09:00');
  assert.equal(g.allDayRangeCovers_(s, e, new Date('2026-10-06T18:30:00+09:00')), true);
  assert.equal(g.allDayRangeCovers_(s, e, new Date('2026-10-07T23:59:00+09:00')), true);
  assert.equal(g.allDayRangeCovers_(s, e, new Date('2026-10-08T00:00:00+09:00')), false);
  assert.equal(g.allDayRangeCovers_(s, e, new Date('2026-10-05T23:00:00+09:00')), false);
});

test('stripQuoted_: 返信本文から引用部分を除く', () => {
  const body = [
    '真田様',
    '',
    '12/11はもちろん、参加させていただきます。',
    '',
    '松葉',
    '',
    '2026年10月6日(火) 午前10:24 Maki Sanada <msanada@dcapital.jp>:',
    '',
    '> 松葉さま',
    '> ご都合はいかがでしょうか。',
  ].join('\n');
  assert.equal(g.stripQuoted_(body), '真田様\n\n12/11はもちろん、参加させていただきます。\n\n松葉');
  assert.equal(g.stripQuoted_('OK です\n\nOn Tue, Oct 6, 2026 at 10:24 AM Foo <a@b.c> wrote:\n> hi'), 'OK です');
  assert.equal(g.stripQuoted_('> 全部引用'), '');
});

test('buildState_: 予定判定のときだけ自分の返信を my_reply として渡す', () => {
  const mail = { subject: 's', from: 'f', isExternal: true, toCount: 1, body: 'b', myReply: '参加します' };
  assert.equal(g.buildState_(mail, true).my_reply, '参加します');
  assert.equal(g.buildState_(mail, false).my_reply, undefined);
  assert.equal(g.buildState_(Object.assign({}, mail, { myReply: null }), true).my_reply, undefined);
});
