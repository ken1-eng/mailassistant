const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();
// 2026-09-29（火）10:00 JST
const RECEIVED = new Date('2026-09-29T10:00:00+09:00');

function answers(over) {
  return Object.assign(
    {
      needs_reply: 0,
      has_deadline: 0,
      addressed_to_me: 0,
      involves_money: 0,
      is_trouble: 0,
      is_personal: 0,
      is_automated: 0,
      urgency: { score: 0, confidence: 1 },
      category: { choice: 'other', confidence: 0.9 },
    },
    over
  );
}
const META = { deadlineDays: null, isExternal: false };

test('daysUntilDeadline_: 年つきを先に試し 2026/11/20 から 26/11 を拾わない', () => {
  assert.equal(g.daysUntilDeadline_('締切は2026/11/20です', RECEIVED), 52);
  assert.equal(g.daysUntilDeadline_('締切は2026年11月20日です', RECEIVED), 52);
});

test('daysUntilDeadline_: 年なし・キーワード', () => {
  assert.equal(g.daysUntilDeadline_('10月1日までにご回答ください', RECEIVED), 2);
  assert.equal(g.daysUntilDeadline_('9/30締切', RECEIVED), 1);
  assert.equal(g.daysUntilDeadline_('本日中にお願いします', RECEIVED), 0);
  assert.equal(g.daysUntilDeadline_('明日までにください', RECEIVED), 1);
  assert.equal(g.daysUntilDeadline_('今週中にお願いします', RECEIVED), 3); // 火曜→金曜
  assert.equal(g.daysUntilDeadline_('期限の記載なし', RECEIVED), null);
});

test('daysUntilDeadline_: 年なしで受信日より前なら翌年', () => {
  assert.equal(g.daysUntilDeadline_('9/28', RECEIVED), 364);
  const dec = new Date('2026-12-20T10:00:00+09:00');
  assert.equal(g.daysUntilDeadline_('1/10締切', dec), 21);
});

test('daysUntilDeadline_: 日本時間の日付で数える（UTCでは前日の時刻でも）', () => {
  const earlyMorning = new Date('2026-09-29T01:00:00+09:00'); // UTC では 9/28
  assert.equal(g.daysUntilDeadline_('9/30締切', earlyMorning), 1);
});

test('scoreTriage_: 自動送信と営業は即0点', () => {
  const hot = { needs_reply: 1, addressed_to_me: 1, is_trouble: 1, urgency: { score: 4, confidence: 1 } };
  assert.equal(g.scoreTriage_(answers(Object.assign({}, hot, { is_automated: 0.9 })), META).score, 0);
  const sales = g.scoreTriage_(answers(Object.assign({}, hot, { category: { choice: 'sales', confidence: 0.8 } })), META);
  assert.equal(sales.score, 0);
  assert.equal(sales.bucket, 'LOW');
});

test('scoreTriage_: 全部満点なら100点', () => {
  const a = answers({
    needs_reply: 1,
    has_deadline: 1,
    addressed_to_me: 1,
    involves_money: 1,
    is_trouble: 1,
    urgency: { score: 4, confidence: 1 },
  });
  const r = g.scoreTriage_(a, { deadlineDays: 0, isExternal: true });
  assert.equal(r.score, 100);
  assert.equal(r.bucket, 'HIGH');
});

test('scoreTriage_: 期限の加点は has_deadline > 0.5 のときだけ（25 / 15 / 7 / 0）', () => {
  const base = { has_deadline: 1, urgency: { score: 4, confidence: 1 } };
  const pts = (days) => g.scoreTriage_(answers(base), { deadlineDays: days, isExternal: false }).score;
  assert.equal(pts(1), 25);
  assert.equal(pts(3), 15);
  assert.equal(pts(7), 7);
  assert.equal(pts(8), 0);
  assert.equal(g.scoreTriage_(answers({ has_deadline: 0.5, urgency: base.urgency }), { deadlineDays: 0 }).score, 0);
});

test('scoreTriage_: 緊急度ゼロは他が高くても上位に来ない（掛け算）', () => {
  const a = answers({ needs_reply: 1, addressed_to_me: 1, involves_money: 1, is_trouble: 1 });
  assert.equal(g.scoreTriage_(a, { deadlineDays: null, isExternal: true }).bucket, 'LOW');
});

test('scoreTriage_: 緊急度の確信度は最低 0.5 として効かせる', () => {
  const a = answers({ needs_reply: 1, addressed_to_me: 1, urgency: { score: 4, confidence: null } });
  // 35 × (0.25 + 0.75 × 1 × 0.5) = 21.875
  assert.equal(g.scoreTriage_(a, META).score, 22);
});

test('scoreTriage_: 誰宛でもない返信要求は割り引かれる', () => {
  const u = { score: 4, confidence: 1 };
  assert.equal(g.scoreTriage_(answers({ needs_reply: 1, addressed_to_me: 1, urgency: u }), META).score, 35);
  assert.equal(g.scoreTriage_(answers({ needs_reply: 1, addressed_to_me: 0, urgency: u }), META).score, 9);
});

test('scoreTriage_: 私信は6割引き', () => {
  const a = answers({ needs_reply: 1, addressed_to_me: 1, is_personal: 1, urgency: { score: 4, confidence: 1 } });
  assert.equal(g.scoreTriage_(a, META).score, 14);
});

test('bucketFor_: 65 / 35 の境界', () => {
  assert.equal(g.bucketFor_(65), 'HIGH');
  assert.equal(g.bucketFor_(64), 'MEDIUM');
  assert.equal(g.bucketFor_(35), 'MEDIUM');
  assert.equal(g.bucketFor_(34), 'LOW');
});

test('isExternalSender_: 社内ドメインとサブドメイン', () => {
  const d = ['example.co.jp'];
  assert.equal(g.isExternalSender_('山田 <yamada@example.co.jp>', d), false);
  assert.equal(g.isExternalSender_('a@mail.example.co.jp', d), false);
  assert.equal(g.isExternalSender_('a@other.com', d), true);
  assert.equal(g.isExternalSender_('a@example.co.jp', []), true); // 未設定なら全部社外
});
