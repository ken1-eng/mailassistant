const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();
// 2026-09-29 10:00 JST
const NOW = new Date('2026-09-29T10:00:00+09:00');

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

test('daysUntilDeadline_: 年つきを先に処理し 2026/11/20 から 26/11 を拾わない', () => {
  assert.equal(g.daysUntilDeadline_('締切は2026/11/20です', NOW), 52);
  assert.equal(g.daysUntilDeadline_('締切は2026年11月20日です', NOW), 52);
});

test('daysUntilDeadline_: 年なし・複数日付・過去日付', () => {
  assert.equal(g.daysUntilDeadline_('10月1日までにご回答ください', NOW), 2);
  assert.equal(g.daysUntilDeadline_('9/30締切', NOW), 1);
  assert.equal(g.daysUntilDeadline_('9/1に送った件、10/3までに', NOW), 4);
  assert.equal(g.daysUntilDeadline_('昨日9/28が期限でした', NOW), -1);
  assert.equal(g.daysUntilDeadline_('期限の記載なし', NOW), null);
  assert.equal(g.daysUntilDeadline_('2/30 は存在しない', NOW), null);
});

test('daysUntilDeadline_: 12月の「1/10」は翌年', () => {
  const dec = new Date('2026-12-20T10:00:00+09:00');
  assert.equal(g.daysUntilDeadline_('1/10締切', dec), 21);
});

test('scoreTriage_: 自動送信と営業は即0点', () => {
  const meta = { deadlineDays: 0, isExternal: true };
  const hot = { needs_reply: 1, addressed_to_me: 1, is_trouble: 1, urgency: { score: 4, confidence: 1 } };
  assert.equal(g.scoreTriage_(answers(Object.assign({}, hot, { is_automated: 0.9 })), meta), 0);
  assert.equal(
    g.scoreTriage_(answers(Object.assign({}, hot, { category: { choice: 'sales', confidence: 0.8 } })), meta),
    0
  );
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
  assert.equal(g.scoreTriage_(a, { deadlineDays: 0, isExternal: true }), 100);
});

test('scoreTriage_: 緊急度ゼロは他が高くても上位に来ない（掛け算）', () => {
  const a = answers({ needs_reply: 1, addressed_to_me: 1, involves_money: 1, is_trouble: 1 });
  const s = g.scoreTriage_(a, { deadlineDays: null, isExternal: true });
  assert.ok(s < g.CONFIG.TRIAGE.THRESHOLD_MID, `score=${s}`);
});

test('scoreTriage_: 誰宛でもない返信要求は割り引かれる', () => {
  const meta = { deadlineDays: null, isExternal: false };
  const u = { score: 4, confidence: 1 };
  const mine = g.scoreTriage_(answers({ needs_reply: 1, addressed_to_me: 1, urgency: u }), meta);
  const broadcast = g.scoreTriage_(answers({ needs_reply: 1, addressed_to_me: 0, urgency: u }), meta);
  assert.equal(mine, 35);
  assert.equal(broadcast, 9);
});

test('scoreTriage_: 私信は6割引き', () => {
  const meta = { deadlineDays: null, isExternal: false };
  const base = { needs_reply: 1, addressed_to_me: 1, urgency: { score: 4, confidence: 1 } };
  assert.equal(g.scoreTriage_(answers(Object.assign({ is_personal: 1 }, base)), meta), 14);
});

test('triageLabelFor_: 65 / 35 の境界', () => {
  assert.equal(g.triageLabelFor_(65), '01_即対応');
  assert.equal(g.triageLabelFor_(64), '02_今日中');
  assert.equal(g.triageLabelFor_(35), '02_今日中');
  assert.equal(g.triageLabelFor_(34), null);
});

test('isExternalSender_: 社内ドメインとサブドメイン', () => {
  const d = ['example.co.jp'];
  assert.equal(g.isExternalSender_('山田 <yamada@example.co.jp>', d), false);
  assert.equal(g.isExternalSender_('a@mail.example.co.jp', d), false);
  assert.equal(g.isExternalSender_('a@other.com', d), true);
  assert.equal(g.isExternalSender_('a@example.co.jp', []), true); // 未設定なら全部社外
});
