const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();

test('定義済みの質問はすべて書式チェックを通る（422 の予防）', () => {
  g.buildJevPayload_({}, g.TRIAGE_QUESTIONS);
  g.buildJevPayload_({}, g.SCHEDULE_QUESTIONS);
  g.buildJevPayload_({}, g.sameEventQuestions_());
  g.buildJevPayload_({}, g.TRIAGE_QUESTIONS.concat(g.SCHEDULE_QUESTIONS));
});

test('payload は既存スクリプトと同じ形（questions は質問名キーのオブジェクト）', () => {
  const p = JSON.parse(JSON.stringify(g.buildJevPayload_({ subject: 's' }, g.TRIAGE_QUESTIONS)));
  assert.equal(p.model, 'jev-latest');
  assert.deepEqual(p.state, { subject: 's' });
  assert.equal(Object.keys(p.questions).length, 9);
  assert.deepEqual(Object.keys(p.questions.needs_reply).sort(), ['criteria', 'instructions', 'type']);
  assert.ok(Array.isArray(p.questions.urgency.criteria));
  assert.equal(p.questions.category.criteria.other.length > 0, true);
});

test('質問名の重複は弾く', () => {
  assert.throws(() => g.buildJevPayload_({}, g.TRIAGE_QUESTIONS.concat(g.TRIAGE_QUESTIONS)), /重複/);
});

test('Score の criteria がオブジェクトだと弾く', () => {
  assert.throws(
    () => g.buildJevPayload_('s', [{ name: 'u', type: 'score', instructions: 'q', criteria: { a: 'x', b: 'y' } }]),
    /Score/
  );
});

test('Choice の criteria が配列だと弾く', () => {
  assert.throws(
    () => g.buildJevPayload_('s', [{ name: 'c', type: 'choice', instructions: 'q', criteria: ['a', 'b'] }]),
    /Choice/
  );
});

test('parseJevAnswers_: 型ごとに正規化し、欠けた回答は null', () => {
  const qs = [
    { name: 'n', type: 'noul', instructions: 'q' },
    { name: 's', type: 'score', instructions: 'q', criteria: ['a', 'b'] },
    { name: 'c', type: 'choice', instructions: 'q', criteria: { a: 'x', b: 'y' } },
    { name: 'missing', type: 'noul', instructions: 'q' },
  ];
  const r = g.parseJevAnswers_(
    {
      n: { noul: 0.83 },
      s: { score: 2.4, confidence: 0.7 },
      c: { choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
    },
    qs
  );
  assert.equal(r.n, 0.83);
  assert.equal(r.s.score, 2.4);
  assert.equal(r.s.confidence, 0.7);
  assert.equal(r.c.choice, 'b');
  assert.equal(r.missing, null);
});
